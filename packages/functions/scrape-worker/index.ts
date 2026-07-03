// Invocado async por scrape-jobs. Ciclo completo de la tarea Fargate del scraper de
// Google Maps (gosom/google-maps-scraper, imagen pública) dentro de una sola invocación —
// mismo patrón que analysis-worker (RunTask -> poll IP -> llamadas HTTP -> StopTask).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ECSClient, RunTaskCommand, DescribeTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { parse } from 'csv-parse/sync';
import type { ScrapeJob } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const ecs = new ECSClient({});
const ec2 = new EC2Client({});

const JOBS_TABLE = process.env.SCRAPE_JOBS_TABLE_NAME!;
const CLUSTER_ARN = process.env.SCRAPER_CLUSTER_ARN!;
const TASK_DEF_ARN = process.env.SCRAPER_TASK_DEF_ARN!;
const SUBNET_IDS = (process.env.SCRAPER_SUBNET_IDS ?? '').split(',').filter(Boolean);
const SECURITY_GROUP_ID = process.env.SCRAPER_SECURITY_GROUP_ID!;
const API_BASE_URL = process.env.API_BASE_URL!;
const INGEST_API_KEY = process.env.INGEST_API_KEY!;

// Piso duro de 3 minutos en el propio contenedor (runner/webrunner.go) — sin importar
// max_time, el job nunca termina antes de eso. Dejamos margen para arranque + pull + descarga
// dentro del timeout de 15 minutos del Lambda.
const JOB_MAX_TIME_SECONDS = 480;
const DEFAULT_DEPTH = 3;
const DEFAULT_LANG = 'en';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScraperTask(): Promise<string> {
  const result = await ecs.send(new RunTaskCommand({
    cluster: CLUSTER_ARN,
    taskDefinition: TASK_DEF_ARN,
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: SUBNET_IDS,
        securityGroups: [SECURITY_GROUP_ID],
        assignPublicIp: 'ENABLED',
      },
    },
  }));
  const taskArn = result.tasks?.[0]?.taskArn;
  if (!taskArn) {
    throw new Error(`No se pudo iniciar la tarea del scraper: ${JSON.stringify(result.failures)}`);
  }
  return taskArn;
}

async function waitForPublicIp(taskArn: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER_ARN, tasks: [taskArn] }));
    const task = result.tasks?.[0];
    if (task?.lastStatus === 'STOPPED') {
      throw new Error(`La tarea del scraper se detuvo antes de arrancar: ${task.stoppedReason}`);
    }
    if (task?.lastStatus === 'RUNNING') {
      const eniId = task.attachments
        ?.flatMap((a) => a.details ?? [])
        .find((d) => d.name === 'networkInterfaceId')?.value;
      if (eniId) {
        const eniResult = await ec2.send(new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] }));
        const publicIp = eniResult.NetworkInterfaces?.[0]?.Association?.PublicIp;
        if (publicIp) return publicIp;
      }
    }
    await sleep(3000);
  }
  throw new Error('Timeout esperando que la tarea del scraper llegue a RUNNING con IP pública');
}

async function stopScraperTask(taskArn: string): Promise<void> {
  try {
    await ecs.send(new StopTaskCommand({ cluster: CLUSTER_ARN, task: taskArn }));
  } catch (err) {
    console.error('scrape-worker: fallo al detener la tarea del scraper', err);
  }
}

async function waitForServerReady(publicIp: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${publicIp}:8080/api/v1/jobs`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch {
      // el servidor puede tardar unos segundos en aceptar conexiones tras RUNNING
    }
    await sleep(2000);
  }
  throw new Error('El servidor del scraper no respondió a tiempo');
}

async function createScrapeJob(publicIp: string, job: ScrapeJob): Promise<string> {
  const res = await fetch(`http://${publicIp}:8080/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `${job.query} in ${job.city}`,
      keywords: [`${job.query} in ${job.city}`],
      lang: DEFAULT_LANG,
      depth: DEFAULT_DEPTH,
      max_time: JOB_MAX_TIME_SECONDS,
      email: job.extractEmails,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`No se pudo crear el job en el scraper: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json() as { id: string };
  return data.id;
}

async function pollScrapeJob(publicIp: string, scraperJobId: string): Promise<'ok' | 'failed'> {
  // OJO: el campo real en la respuesta es "Status" (capitalizado) — confirmado con una
  // prueba en vivo, distinto de lo que documenta el spec/README ("status" en minúscula).
  const deadline = Date.now() + 11 * 60_000; // margen dentro del timeout de 15 min del Lambda
  while (Date.now() < deadline) {
    const res = await fetch(`http://${publicIp}:8080/api/v1/jobs/${scraperJobId}`, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json() as { Status: string };
      if (data.Status === 'ok' || data.Status === 'failed') return data.Status;
    }
    await sleep(15000);
  }
  throw new Error('Timeout esperando a que el job del scraper termine');
}

async function downloadResults(publicIp: string, scraperJobId: string): Promise<Record<string, string>[]> {
  const res = await fetch(`http://${publicIp}:8080/api/v1/jobs/${scraperJobId}/download`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`No se pudo descargar el CSV del job: ${res.status}`);
  const csvText = await res.text();
  return parse(csvText, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
}

function stripProtocol(url: string): string {
  return url.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// complete_address trae un JSON estructurado con "city" real (confirmado con una prueba en
// vivo: {"borough","street","city","postal_code","state","country"}) — mucho más confiable
// que adivinar por el índice de una coma en el string plano de "address" (que pondría la
// provincia/estado en vez de la ciudad, ej. "Toledo" en vez de "Fuensalida").
function guessCity(address: string, completeAddress?: string): string | undefined {
  if (completeAddress) {
    try {
      const parsed = JSON.parse(completeAddress) as { city?: string };
      if (parsed.city) return parsed.city;
    } catch {
      // completeAddress no parseable — cae al heurístico de abajo
    }
  }
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0];
}

function firstEmail(raw: string): string | undefined {
  if (!raw) return undefined;
  let candidates: string[];
  try {
    const parsed = JSON.parse(raw);
    candidates = Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    candidates = raw.split(/[,;|]/);
  }
  return candidates.map((c) => c.trim()).find((c) => c.includes('@'));
}

interface ScrapedLead {
  businessName: string;
  url: string;
  phone?: string;
  email?: string;
  city?: string;
  category?: string;
}

function mapRows(rows: Record<string, string>[], extractEmails: boolean): ScrapedLead[] {
  const leads: ScrapedLead[] = [];
  for (const row of rows) {
    const website = row.website?.trim();
    if (!website) continue; // sin sitio no hay nada que analizar
    leads.push({
      businessName: row.title || website,
      url: stripProtocol(website),
      phone: row.phone?.trim() || undefined,
      category: row.category?.trim() || undefined,
      city: row.address ? guessCity(row.address, row.complete_address) : undefined,
      email: extractEmails ? firstEmail(row.emails) : undefined,
    });
  }
  return leads;
}

async function ingestLeads(leads: ScrapedLead[]): Promise<{ created: number; skipped: number }> {
  if (leads.length === 0) return { created: 0, skipped: 0 };
  const res = await fetch(`${API_BASE_URL}/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': INGEST_API_KEY },
    body: JSON.stringify({ leads }),
  });
  if (!res.ok) throw new Error(`ingest-leads respondió ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json() as { created: number; skipped: number };
  return data;
}

async function updateJob(jobId: string, patch: Partial<ScrapeJob>): Promise<void> {
  const setParts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    setParts.push(`#${key} = :${key}`);
    names[`#${key}`] = key;
    values[`:${key}`] = value;
  }
  await ddb.send(new UpdateCommand({
    TableName: JOBS_TABLE,
    Key: { jobId },
    UpdateExpression: `SET ${setParts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

export const handler = async (event: { jobId: string }): Promise<void> => {
  const { jobId } = event;
  const result = await ddb.send(new GetCommand({ TableName: JOBS_TABLE, Key: { jobId } }));
  if (!result.Item) throw new Error(`Scrape job ${jobId} not found`);
  const job = result.Item as ScrapeJob;

  await updateJob(jobId, { status: 'RUNNING' });

  let taskArn: string | undefined;
  try {
    taskArn = await runScraperTask();
    const publicIp = await waitForPublicIp(taskArn);
    await waitForServerReady(publicIp);
    const scraperJobId = await createScrapeJob(publicIp, job);
    const finalStatus = await pollScrapeJob(publicIp, scraperJobId);
    if (finalStatus === 'failed') {
      await updateJob(jobId, { status: 'FAILED', errorMessage: 'El scraper reportó el job como fallido', finishedAt: Date.now() });
      return;
    }

    const rows = await downloadResults(publicIp, scraperJobId);
    const leads = mapRows(rows, job.extractEmails);
    const { created, skipped } = await ingestLeads(leads);

    await updateJob(jobId, {
      status: 'DONE',
      resultCount: rows.length,
      createdCount: created,
      skippedCount: skipped + (rows.length - leads.length),
      finishedAt: Date.now(),
    });
  } catch (err) {
    console.error('scrape-worker: fallo en el job', err);
    await updateJob(jobId, {
      status: 'FAILED',
      errorMessage: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
    });
  } finally {
    if (taskArn) await stopScraperTask(taskArn);
  }
};
