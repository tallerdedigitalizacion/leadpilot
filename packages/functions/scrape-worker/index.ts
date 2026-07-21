// Dispatcher entre proveedores del scraper de Maps (gosom en Fargate / SerpApi vía HTTP).
// El resto del ciclo (ingest + actualización del registro del job) es idéntico para ambos.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { ScrapeJob } from '../shared/types';
import type { ScrapedLead, ProviderResult } from './types';
import { runGosomScrape } from './gosom-provider';
import { runSerpApiScrape } from './serpapi-provider';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const JOBS_TABLE = process.env.SCRAPE_JOBS_TABLE_NAME!;
const API_BASE_URL = process.env.API_BASE_URL!;
const INGEST_API_KEY = process.env.INGEST_API_KEY!;

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

  try {
    const providerResult: ProviderResult = job.provider === 'serpapi'
      ? await runSerpApiScrape(job)
      : await runGosomScrape(job);

    const { created, skipped } = await ingestLeads(providerResult.leads);

    await updateJob(jobId, {
      status: 'DONE',
      resultCount: providerResult.rows,
      createdCount: created,
      skippedCount: skipped + (providerResult.rows - providerResult.leads.length),
      finishedAt: Date.now(),
    });
  } catch (err) {
    console.error('scrape-worker: fallo en el job', err);
    await updateJob(jobId, {
      status: 'FAILED',
      errorMessage: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
    });
  }
};
