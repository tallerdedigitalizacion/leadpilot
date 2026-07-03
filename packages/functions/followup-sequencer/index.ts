// EventBridge cron (rate 1 day) — reemplaza a no-response-checker. Empuja leads sin
// respuesta a través de FOLLOWUP_1 -> FOLLOWUP_2 -> NO_RESPONSE, enviando un email de
// seguimiento en los dos primeros saltos. Cualquier clic/llamada/respuesta manual saca al
// lead de la query (deja de estar en el status que este cron consulta) y detiene la cadena.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem, LeadStatus, TimelineEvent } from '../shared/types';
import { sendLeadEmail, getSharedDailyCap, getSentCountToday, incrementSentCountToday } from '../shared/send-lead-email';
import { buildLinks as buildFollowupLinks, generateFollowupEmail } from '../shared/followup-email';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ses = new SESClient({ region: process.env.SES_REGION ?? 'us-east-1' });
const ssm = new SSMClient({});

const TABLE = process.env.LEADS_TABLE_NAME!;
const COUNTERS_TABLE = process.env.SEND_COUNTERS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const FROM_EMAIL = process.env.SES_FROM_EMAIL!;
const TRACKING_BASE_URL = process.env.TRACKING_BASE_URL ?? '';
const CAN_SPAM_ADDRESS = process.env.CAN_SPAM_ADDRESS ?? '[dirección física pendiente]';

const DAY = 24 * 60 * 60 * 1000;

const THRESHOLDS: Array<{
  fromStatus: LeadStatus;
  toStatus: LeadStatus;
  afterMs: number;
  followupNumber?: 1 | 2;
}> = [
  { fromStatus: 'SENT', toStatus: 'FOLLOWUP_1', afterMs: 7 * DAY, followupNumber: 1 },
  { fromStatus: 'FOLLOWUP_1', toStatus: 'FOLLOWUP_2', afterMs: 14 * DAY, followupNumber: 2 },
  { fromStatus: 'FOLLOWUP_2', toStatus: 'NO_RESPONSE', afterMs: 28 * DAY },
];

let anthropicClient: Anthropic | null = null;
async function getAnthropicClient(): Promise<Anthropic> {
  if (anthropicClient) return anthropicClient;
  const result = await ssm.send(new GetParameterCommand({ Name: process.env.ANTHROPIC_API_KEY_PARAM!, WithDecryption: true }));
  anthropicClient = new Anthropic({ apiKey: result.Parameter!.Value! });
  return anthropicClient;
}

let trackingSecret: string | null = null;
async function getTrackingSecret(): Promise<string> {
  if (trackingSecret) return trackingSecret;
  const result = await ssm.send(new GetParameterCommand({ Name: process.env.TRACKING_SECRET_PARAM!, WithDecryption: true }));
  trackingSecret = result.Parameter!.Value!;
  return trackingSecret;
}

async function buildLinks(lead: LeadItem) {
  const secret = await getTrackingSecret();
  return buildFollowupLinks(lead, TRACKING_BASE_URL, secret);
}

async function queryAllByStatus(status: LeadStatus): Promise<LeadItem[]> {
  const items: LeadItem[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': status },
      ExclusiveStartKey: cursor,
    }));
    items.push(...((result.Items ?? []) as LeadItem[]));
    cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  return items;
}

export const handler = async (): Promise<void> => {
  const now = Date.now();
  const dailyCap = await getSharedDailyCap(ssm, process.env.SHARED_DAILY_CAP_PARAM!);
  let sentToday = await getSentCountToday(ddb, COUNTERS_TABLE);
  let advanced = 0;
  let sent = 0;
  let skippedByCapCount = 0;

  // Leads en ANALYZED cuyo auto-envío (desde generate-report) nunca salió porque el freno
  // diario ya estaba gastado en ese momento — sin esto se quedarían atascados para siempre.
  // Sin umbral de antigüedad, son elegibles desde ya.
  const stuckLeads = (await queryAllByStatus('ANALYZED')).filter(
    (lead) => lead.reportHtmlS3Key && lead.emailSubject && lead.emailBody
  );
  const sendDeps = {
    ddb, ses, ssm,
    leadsTable: TABLE,
    countersTable: COUNTERS_TABLE,
    fromEmail: FROM_EMAIL,
    dailyCapParam: process.env.SHARED_DAILY_CAP_PARAM!,
  };
  for (const lead of stuckLeads) {
    const outcome = await sendLeadEmail(sendDeps, lead, { checkCap: true });
    if (outcome.ok) {
      sentToday++; sent++; advanced++;
    } else if (outcome.reason === 'cap-exhausted') {
      skippedByCapCount++;
    }
    // unsubscribed/no-recipients/send-error: sendLeadEmail ya registró el motivo cuando aplica
    // (send-error), el lead se queda en ANALYZED y se reintenta en la próxima corrida.
  }

  for (const threshold of THRESHOLDS) {
    const candidates = (await queryAllByStatus(threshold.fromStatus)).filter(
      (lead) => lead.sentAt && (now - lead.sentAt) > threshold.afterMs
    );

    for (const lead of candidates) {
      // Sin envío (umbral final -> NO_RESPONSE): solo transición, no consume el freno diario.
      if (!threshold.followupNumber) {
        const timelineEvent: TimelineEvent = { at: now, event: 'NO_RESPONSE', by: 'system' };
        try {
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { leadId: lead.leadId },
            UpdateExpression: 'SET #status = :to, timeline = list_append(timeline, :event)',
            ConditionExpression: '#status = :from',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':to': threshold.toStatus, ':from': threshold.fromStatus, ':event': [timelineEvent] },
          }));
          advanced++;
        } catch (err: any) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
        }
        continue;
      }

      if (lead.unsubscribed) {
        // Se saltea el envío, pero avanza igual para no quedar consultado para siempre.
        const timelineEvent: TimelineEvent = { at: now, event: 'FOLLOWUP_SKIPPED_UNSUBSCRIBED', by: 'system' };
        try {
          await ddb.send(new UpdateCommand({
            TableName: TABLE,
            Key: { leadId: lead.leadId },
            UpdateExpression: 'SET #status = :to, timeline = list_append(timeline, :event)',
            ConditionExpression: '#status = :from',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: { ':to': threshold.toStatus, ':from': threshold.fromStatus, ':event': [timelineEvent] },
          }));
          advanced++;
        } catch (err: any) {
          if (err?.name !== 'ConditionalCheckFailedException') throw err;
        }
        continue;
      }

      if (sentToday >= dailyCap) {
        skippedByCapCount++;
        continue; // se recoge de nuevo mañana — sigue por encima del umbral de antigüedad
      }

      if (!lead.reportHtmlS3Key) {
        console.error('followup-sequencer: lead sin reporte, no se puede generar seguimiento', lead.leadId);
        continue;
      }

      const now2 = Date.now();
      let subject = '';
      let body = '';
      let sendError: string | null = null;

      try {
        const s3Result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: lead.reportHtmlS3Key }));
        const reportHtml = await s3Result.Body?.transformToString() ?? '';
        const client = await getAnthropicClient();
        const { trackingUrl, unsubscribeUrl, bookingUrl } = await buildLinks(lead);
        const emailData = await generateFollowupEmail(client, reportHtml, threshold.followupNumber, trackingUrl, unsubscribeUrl, bookingUrl, CAN_SPAM_ADDRESS);
        subject = emailData.subject;
        body = emailData.body;

        const toAddresses = [...new Set([...(lead.emails ?? []), ...(lead.email ? [lead.email] : [])])];
        if (toAddresses.length === 0) throw new Error('Lead has no email address');

        await ses.send(new SendEmailCommand({
          Source: FROM_EMAIL,
          Destination: { ToAddresses: toAddresses, BccAddresses: [FROM_EMAIL] },
          Message: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Html: { Data: body, Charset: 'UTF-8' } } },
        }));
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err);
      }

      const eventName = `FOLLOWUP_${threshold.followupNumber}_${sendError ? 'SEND_FAILED' : 'SENT'}`;
      const timelineEvent: TimelineEvent = sendError
        ? { at: now2, event: eventName, by: 'system', note: sendError }
        : { at: now2, event: eventName, by: 'system', meta: { subject } };

      if (sendError) {
        // No se toca el estado — el cron de mañana reintenta solo (sigue por encima del umbral)
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { leadId: lead.leadId },
          UpdateExpression: 'SET timeline = list_append(timeline, :event)',
          ExpressionAttributeValues: { ':event': [timelineEvent] },
        }));
        console.error('followup-sequencer: send failed', lead.leadId, sendError);
        continue;
      }

      const followupAtField = threshold.followupNumber === 1 ? 'followup1SentAt' : 'followup2SentAt';
      try {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { leadId: lead.leadId },
          UpdateExpression: `SET #status = :to, ${followupAtField} = :now, emailSubject = :subject, emailBody = :body, timeline = list_append(timeline, :event)`,
          ConditionExpression: '#status = :from',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':to': threshold.toStatus, ':from': threshold.fromStatus, ':now': now2,
            ':subject': subject, ':body': body, ':event': [timelineEvent],
          },
        }));
        await incrementSentCountToday(ddb, COUNTERS_TABLE);
        sentToday++;
        sent++;
        advanced++;
      } catch (err: any) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
        // El lead avanzó por otra vía (clic/llamada) justo entre la query y este update —
        // el email ya salió (SES no se puede "deshacer"), pero no pisamos su estado real.
      }
    }
  }

  console.log(`followup-sequencer: ${advanced} leads avanzados, ${sent} emails enviados, ${skippedByCapCount} saltados por freno diario`);
};
