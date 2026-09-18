// Invocado async por run-analysis (despachador). Hace todo el ciclo de vida de la tarea
// Fargate de captura de pantalla dentro de una sola invocación — sin Step Functions,
// mismo patrón que el resto del código (un Lambda que hace su trabajo y escribe a DDB).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ECSClient, RunTaskCommand, DescribeTasksCommand, StopTaskCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem, PageSpeedScore, TimelineEvent, WebAnalysis } from '../shared/types';
import { fetchPageSpeed } from '../shared/pagespeed';
import { getActivePrompt, promptKey, renderPrompt } from '../shared/prompt-store';
import { getCampaign } from '../shared/campaigns';
import { trackedCompletion } from '../shared/llm-client';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const ecs = new ECSClient({});
const ec2 = new EC2Client({});
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ssm = new SSMClient({});
const lambdaClient = new LambdaClient({});

const TABLE = process.env.LEADS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const CLUSTER_ARN = process.env.SCREENSHOT_CLUSTER_ARN!;
const TASK_DEF_ARN = process.env.SCREENSHOT_TASK_DEF_ARN!;
const CONTAINER_NAME = process.env.SCREENSHOT_CONTAINER_NAME!;
const SUBNET_IDS = (process.env.SCREENSHOT_SUBNET_IDS ?? '').split(',').filter(Boolean);
const SECURITY_GROUP_ID = process.env.SCREENSHOT_SECURITY_GROUP_ID!;

let anthropicClient: Anthropic | null = null;
async function getAnthropicClient(): Promise<Anthropic> {
  if (anthropicClient) return anthropicClient;
  const result = await ssm.send(new GetParameterCommand({ Name: process.env.ANTHROPIC_API_KEY_PARAM!, WithDecryption: true }));
  anthropicClient = new Anthropic({ apiKey: result.Parameter!.Value! });
  return anthropicClient;
}

let screenshotToken: string | null = null;
async function getScreenshotToken(): Promise<string> {
  if (screenshotToken) return screenshotToken;
  const result = await ssm.send(new GetParameterCommand({ Name: process.env.SCREENSHOT_TASK_TOKEN_PARAM!, WithDecryption: true }));
  screenshotToken = result.Parameter!.Value!;
  return screenshotToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScreenshotTask(): Promise<string> {
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
    throw new Error(`No se pudo iniciar la tarea de captura: ${JSON.stringify(result.failures)}`);
  }
  return taskArn;
}

async function waitForPublicIp(taskArn: string): Promise<string> {
  // La imagen del screenshot-service creció (~730MB, con sharp) y a veces tarda más de
  // 60s en arrancar en frío en Fargate — margen ampliado para no matar la tarea a mitad
  // del pull de la imagen.
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await ecs.send(new DescribeTasksCommand({ cluster: CLUSTER_ARN, tasks: [taskArn] }));
    const task = result.tasks?.[0];
    if (task?.lastStatus === 'STOPPED') {
      throw new Error(`La tarea de captura se detuvo antes de arrancar: ${task.stoppedReason}`);
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
  throw new Error('Timeout esperando que la tarea de captura llegue a RUNNING con IP pública');
}

async function requestScreenshot(publicIp: string, url: string, leadId: string): Promise<{ s3Key: string; cookieDetected: boolean; cookieTool?: string }> {
  const token = await getScreenshotToken();
  const deadline = Date.now() + 65_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${publicIp}:8080/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ url, leadId }),
        signal: AbortSignal.timeout(60000), // sitios con fuentes/JS lentos pueden tardar más de 25s en cargar
      });
      if (!res.ok) throw new Error(`screenshot-service respondió ${res.status}: ${await res.text().catch(() => '')}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      await sleep(2000); // el contenedor puede tardar unos segundos en aceptar conexiones tras RUNNING
    }
  }
  throw new Error(`No se pudo contactar al servicio de captura: ${lastError}`);
}

async function stopScreenshotTask(taskArn: string): Promise<void> {
  try {
    await ecs.send(new StopTaskCommand({ cluster: CLUSTER_ARN, task: taskArn }));
  } catch (err) {
    console.error('analysis-worker: fallo al detener la tarea de captura', err);
  }
}

async function fetchScreenshotBase64(s3Key: string): Promise<string> {
  const result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: s3Key }));
  const bytes = await result.Body!.transformToByteArray();
  return Buffer.from(bytes).toString('base64');
}

async function runVisionAnalysis(
  client: Anthropic,
  lead: LeadItem,
  screenshotBase64: string,
  pagespeedMobile: PageSpeedScore | undefined,
  pagespeedDesktop: PageSpeedScore | undefined,
  cookieDetected: boolean,
  cookieTool: string | undefined,
): Promise<WebAnalysis | undefined> {
  const campaignId = getCampaign(lead.campaignId).campaignId;
  const { content: template, systemPrompt, version } = await getActivePrompt(campaignId, 'vision-analysis');
  const userText = renderPrompt(template, {
    businessName: lead.businessName,
    category: lead.category ?? 'no especificada',
    city: lead.city ?? 'no especificada',
    pagespeedMobile: JSON.stringify(pagespeedMobile ?? 'no disponible'),
    pagespeedDesktop: JSON.stringify(pagespeedDesktop ?? 'no disponible'),
    cookieDetected: String(cookieDetected),
    cookieTool: cookieTool ?? '',
  });

  const message = await trackedCompletion(client, {
    promptId: promptKey(campaignId, 'vision-analysis'),
    promptVersion: version,
    leadId: lead.leadId,
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 } },
        { type: 'text', text: userText },
      ],
    }],
  });

  const block = message.content[0];
  const raw = block.type === 'text' ? block.text : '{}';
  const stripped = raw.replace(/^```json\s*|```$/g, '').trim();

  try {
    const parsed = JSON.parse(stripped);
    return {
      headlinePain: parsed.headline_pain ?? '',
      visualAssessment: parsed.visual_assessment ?? '',
      performanceSummary: {
        mobileScore: parsed.performance_summary?.mobile_score ?? 0,
        desktopScore: parsed.performance_summary?.desktop_score ?? 0,
        coreWebVitalsIssues: parsed.performance_summary?.core_web_vitals_issues ?? [],
      },
      complianceFlag: parsed.compliance_flag ?? '',
      top3Fixes: parsed.top_3_fixes ?? [],
      closingHook: parsed.closing_hook ?? '',
    };
  } catch (err) {
    console.error('analysis-worker: no se pudo parsear el JSON de Claude', raw);
    return undefined;
  }
}

export const handler = async (event: { leadId: string }): Promise<void> => {
  const { leadId } = event;
  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) throw new Error(`Lead ${leadId} not found`);
  const lead = result.Item as LeadItem;

  let taskArn: string | undefined;
  let screenshotResult: { s3Key: string; cookieDetected: boolean; cookieTool?: string } | undefined;

  try {
    taskArn = await runScreenshotTask();
    const publicIp = await waitForPublicIp(taskArn);
    screenshotResult = await requestScreenshot(publicIp, lead.url, leadId);
  } catch (err) {
    console.error('analysis-worker: fallo en la captura de pantalla', err);
  } finally {
    if (taskArn) await stopScreenshotTask(taskArn);
  }

  const [mobileResult, desktopResult] = await Promise.allSettled([
    fetchPageSpeed(lead.url, 'mobile'),
    fetchPageSpeed(lead.url, 'desktop'),
  ]);

  let webAnalysis: WebAnalysis | undefined;
  if (screenshotResult) {
    try {
      const client = await getAnthropicClient();
      const screenshotBase64 = await fetchScreenshotBase64(screenshotResult.s3Key);
      webAnalysis = await runVisionAnalysis(
        client,
        lead,
        screenshotBase64,
        mobileResult.status === 'fulfilled' ? mobileResult.value.score : undefined,
        desktopResult.status === 'fulfilled' ? desktopResult.value.score : undefined,
        screenshotResult.cookieDetected,
        screenshotResult.cookieTool,
      );
    } catch (err) {
      console.error('analysis-worker: fallo el análisis con Claude', err);
    }
  }

  const now = Date.now();
  const timelineEvent: TimelineEvent = { at: now, event: 'ANALYZED', by: 'system' };
  const setParts = ['#status = :status', '#analyzedAt = :analyzedAt', 'timeline = list_append(timeline, :event)'];
  const values: Record<string, unknown> = { ':status': 'ANALYZED', ':analyzedAt': now, ':event': [timelineEvent] };

  if (mobileResult.status === 'fulfilled') {
    setParts.push('pagespeedMobile = :pagespeedMobile', 'pagespeedMobileRaw = :pagespeedMobileRaw');
    values[':pagespeedMobile'] = mobileResult.value.score;
    values[':pagespeedMobileRaw'] = mobileResult.value.rawText;
  } else {
    console.warn('PageSpeed mobile FAILED:', mobileResult.reason);
  }
  if (desktopResult.status === 'fulfilled') {
    setParts.push('pagespeedDesktop = :pagespeedDesktop', 'pagespeedDesktopRaw = :pagespeedDesktopRaw');
    values[':pagespeedDesktop'] = desktopResult.value.score;
    values[':pagespeedDesktopRaw'] = desktopResult.value.rawText;
  } else {
    console.warn('PageSpeed desktop FAILED:', desktopResult.reason);
  }
  if (webAnalysis) {
    setParts.push('webAnalysis = :webAnalysis');
    values[':webAnalysis'] = webAnalysis;
  }
  if (screenshotResult) {
    setParts.push('screenshotS3Key = :screenshotS3Key', 'cookieDetected = :cookieDetected');
    values[':screenshotS3Key'] = screenshotResult.s3Key;
    values[':cookieDetected'] = screenshotResult.cookieDetected;
    if (screenshotResult.cookieTool) {
      setParts.push('cookieTool = :cookieTool');
      values[':cookieTool'] = screenshotResult.cookieTool;
    }
  }

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: `SET ${setParts.join(', ')}`,
    ExpressionAttributeNames: { '#status': 'status', '#analyzedAt': 'analyzedAt' },
    ExpressionAttributeValues: values,
  }));

  await lambdaClient.send(new InvokeCommand({
    FunctionName: process.env.GENERATE_REPORT_FUNCTION_NAME!,
    InvocationType: 'Event',
    Payload: JSON.stringify({ leadId }),
  }));
};
