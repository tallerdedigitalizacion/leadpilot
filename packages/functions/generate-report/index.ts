// Worker invoked asynchronously by trigger-report Lambda — not via API Gateway
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SESClient } from '@aws-sdk/client-ses';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem, TimelineEvent } from '../shared/types';
import { signToken } from '../shared/tracking';
import { sendLeadEmail } from '../shared/send-lead-email';
import { publishToLinkedin } from '../shared/buffer';
import { getActivePrompt, renderPrompt } from '../shared/prompt-store';
import { trackedCompletion } from '../shared/llm-client';
import { generateEmail, generateLinkedinPost } from '../shared/report-content';
import { buildBookingUrl, getCampaign } from '../shared/campaigns';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ssm = new SSMClient({});
const ses = new SESClient({ region: process.env.SES_REGION ?? 'us-east-1' });
const TABLE = process.env.LEADS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const TRACKING_BASE_URL = process.env.TRACKING_BASE_URL ?? '';
const FRONTEND_URL = process.env.FRONTEND_URL ?? '';
const CAN_SPAM_ADDRESS = process.env.CAN_SPAM_ADDRESS ?? '[dirección física pendiente]';
const FROM_EMAIL = process.env.SES_FROM_EMAIL!;

let anthropicClient: Anthropic | null = null;

async function getAnthropicClient(): Promise<Anthropic> {
  if (anthropicClient) return anthropicClient;
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.ANTHROPIC_API_KEY_PARAM!,
    WithDecryption: true,
  }));
  anthropicClient = new Anthropic({ apiKey: result.Parameter!.Value! });
  return anthropicClient;
}

let trackingSecret: string | null = null;

async function getTrackingSecret(): Promise<string> {
  if (trackingSecret) return trackingSecret;
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.TRACKING_SECRET_PARAM!,
    WithDecryption: true,
  }));
  trackingSecret = result.Parameter!.Value!;
  return trackingSecret;
}

function shortId(leadId: string): string {
  return leadId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

// ── 1. HTML REPORT ────────────────────────────────────────────────────────────

function serializeWebAnalysis(lead: LeadItem): string {
  const wa = lead.webAnalysis;
  if (!wa) return 'No disponible';
  // Las dos primeras líneas solo aparecen en la campaña es-sprint, que es la única cuyo
  // prompt de visión las produce. Van arriba del todo a propósito: son el argumento
  // central de su informe, y el modelo tiende a apoyarse en lo que lee primero.
  const friction = [
    wa.processHypothesis ? `Proceso manual detectado: ${wa.processHypothesis}` : undefined,
    wa.frictionSignals?.length ? `Señales de fricción: ${wa.frictionSignals.map((f, i) => `${i + 1}. ${f}`).join(' ')}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return [
    ...friction,
    `Dolor principal: ${wa.headlinePain}`,
    `Evaluación visual: ${wa.visualAssessment}`,
    `Core Web Vitals — problemas: ${wa.performanceSummary.coreWebVitalsIssues.join('; ') || 'ninguno detectado'}`,
    `Cumplimiento/cookies: ${wa.complianceFlag}`,
    `Top 3 fixes priorizados: ${wa.top3Fixes.map((f, i) => `${i + 1}. ${f}`).join(' ')}`,
    `Gancho de cierre: ${wa.closingHook}`,
  ].join('\n');
}

async function generateReportHtml(client: Anthropic, lead: LeadItem): Promise<string> {
  const m = lead.pagespeedMobile;
  const d = lead.pagespeedDesktop;
  const mRaw = lead.pagespeedMobileRaw;
  const dRaw = lead.pagespeedDesktopRaw;
  const id = shortId(lead.leadId);
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const { content: template, version } = await getActivePrompt(getCampaign(lead.campaignId).campaignId, 'report-html');
  const prompt = renderPrompt(template, {
    id,
    date,
    categoryTag: lead.category ? `${lead.category} (verde)` : '',
    category: lead.category ?? 'N/A',
    mPerformance: String(m?.performance ?? 'N/A'),
    mLcp: m?.lcp !== undefined ? `${m.lcp}s` : 'N/A',
    mTbt: m?.tbt !== undefined ? `${m.tbt}ms` : 'N/A',
    mSpeedIndex: m?.speedIndex !== undefined ? `${m.speedIndex}s` : 'N/A',
    mAccessibility: String(m?.accessibility ?? 'N/A'),
    mSeo: String(m?.seo ?? 'N/A'),
    mBestPractices: String(m?.bestPractices ?? 'N/A'),
    dPerformance: String(d?.performance ?? 'N/A'),
    dSeo: String(d?.seo ?? 'N/A'),
    mRawSection: mRaw ? `PageSpeed Mobile — datos completos pegados por el consultor:\n${mRaw}` : '',
    dRawSection: dRaw ? `PageSpeed Desktop — datos completos pegados por el consultor:\n${dRaw}` : '',
    webAnalysisSerialized: serializeWebAnalysis(lead),
    notesSection: lead.myNotes ? `Notas del consultor: ${lead.myNotes}` : '',
    businessName: lead.businessName,
    city: lead.city ?? 'N/A',
    phone: lead.phone ?? 'N/A',
    url: lead.url,
    email: lead.email ?? 'No disponible',
  });

  const message = await trackedCompletion(client, {
    promptId: 'report-html',
    promptVersion: version,
    leadId: lead.leadId,
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  return block.type === 'text' ? block.text : '';
}

// ── Handler (direct invocation, not HTTP) ─────────────────────────────────────

export const handler = async (event: { leadId: string }): Promise<void> => {
  const { leadId } = event;

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) throw new Error(`Lead ${leadId} not found`);
  const lead = result.Item as LeadItem;

  const client = await getAnthropicClient();
  const htmlKey = `reports/${leadId}/report.html`;

  try {
    // Generar HTML del reporte
    const reportHtml = await generateReportHtml(client, lead);

    // Subir HTML a S3
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: htmlKey,
      Body: reportHtml,
      ContentType: 'text/html',
    }));

    // Generar presigned URL (7 días)
    const reportUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: htmlKey }),
      { expiresIn: 7 * 24 * 60 * 60 }
    );

    // El link que va en el email apunta al redirect de tracking, no a la URL presigned cruda
    const secret = await getTrackingSecret();
    const token = signToken(leadId, secret);
    const trackingUrl = `${TRACKING_BASE_URL}/r/${leadId}?t=${token}`;
    const unsubscribeUrl = `${FRONTEND_URL}/unsubscribe/${leadId}?t=${token}`;

    // metadata[leadId] es el mecanismo primario para que el webhook de Cal.com identifique el
    // lead; el email prefilled es un respaldo (el prefill de email/nombre es una función estable
    // de Cal.com, a diferencia del metadata en query params que tiene reportes de bugs)
    const campaignId = getCampaign(lead.campaignId).campaignId;
    const bookingUrl = buildBookingUrl(lead);

    // Generar email y LinkedIn en paralelo
    const [emailData, linkedinPost] = await Promise.all([
      generateEmail(client, leadId, campaignId, reportHtml, trackingUrl, unsubscribeUrl, bookingUrl, CAN_SPAM_ADDRESS),
      generateLinkedinPost(client, leadId, campaignId, reportHtml),
    ]);

    const now = Date.now();
    const timelineEvent: TimelineEvent = { at: now, event: 'REPORT_GENERATED', by: 'system' };

    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: `SET
        reportHtmlS3Key = :htmlKey,
        reportUrl = :reportUrl,
        emailSubject = :emailSubject,
        emailBody = :emailBody,
        linkedinPost = :linkedinPost,
        isGeneratingReport = :false,
        timeline = list_append(timeline, :event)`,
      ExpressionAttributeValues: {
        ':htmlKey': htmlKey,
        ':reportUrl': reportUrl,
        ':emailSubject': emailData.subject,
        ':emailBody': emailData.body,
        ':linkedinPost': linkedinPost,
        ':false': false,
        ':event': [timelineEvent],
      },
    }));

    // El reporte y el email ya están listos — se intenta el envío automático de una vez,
    // sin esperar a que alguien apriete "Enviar" en la UI. Si el freno diario ya se gastó,
    // el lead se queda en ANALYZED y lo recoge el barrido de followup-sequencer más tarde.
    const outcome = await sendLeadEmail(
      { ddb, ses, ssm, leadsTable: TABLE, countersTable: process.env.SEND_COUNTERS_TABLE_NAME!, fromEmail: FROM_EMAIL, dailyCapParam: process.env.SHARED_DAILY_CAP_PARAM! },
      { ...lead, emailSubject: emailData.subject, emailBody: emailData.body },
      { checkCap: true },
    );
    if (!outcome.ok) {
      console.log(`generate-report: auto-envío pospuesto para ${leadId}: ${outcome.reason}`);
    }

    // Publicación en LinkedIn independiente del email — uno puede fallar sin bloquear al otro.
    const linkedinOutcome = await publishToLinkedin(
      { ddb, ssm, leadsTable: TABLE, countersTable: process.env.SEND_COUNTERS_TABLE_NAME!, bufferApiKeyParam: process.env.BUFFER_API_KEY_PARAM!, channelId: process.env.BUFFER_LINKEDIN_CHANNEL_ID!, dailyCapParam: process.env.LINKEDIN_DAILY_CAP_PARAM! },
      { ...lead, linkedinPost },
      { checkCap: true },
    );
    if (!linkedinOutcome.ok) {
      console.log(`generate-report: publicación en LinkedIn pospuesta/fallida para ${leadId}: ${linkedinOutcome.reason} ${linkedinOutcome.error ?? ''}`);
    }
  } catch (err) {
    console.error('generate-report failed:', err);
    // Always clear the generating flag so UI doesn't stay stuck
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: 'SET isGeneratingReport = :false',
      ExpressionAttributeValues: { ':false': false },
    })).catch(() => {});
    throw err;
  }
};
