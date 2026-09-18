// EventBridge cron (rate 1 day) — reemplaza a no-response-checker. Empuja leads sin
// respuesta a través de FOLLOWUP_1 -> FOLLOWUP_2 -> ARCHIVED (sin respuesta tras el 2do
// seguimiento), enviando un email de seguimiento en los dos primeros saltos. Un click en
// el reporte saca al lead de esa cadena (track-click lo pasa a ENGAGED) — en vez de
// perder todo seguimiento, entra a la rama A de abajo: un único email personalizado
// referenciando un hallazgo concreto del reporte, 5 días después del click
// (engagedAt), guardado por `engagedFollowupSentAt`. Cualquier otra respuesta manual
// (booking/archivado) sigue sacando al lead de ambas ramas.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem, LeadStatus, TimelineEvent } from '../shared/types';
import { sendLeadEmail, getSharedDailyCap, getSentCountToday, incrementSentCountToday } from '../shared/send-lead-email';
import { buildLinks as buildFollowupLinks, generateFollowupEmail, pickEngagedFinding, generateEngagedFollowupEmail } from '../shared/followup-email';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ses = new SESClient({ region: process.env.SES_REGION ?? 'us-east-1' });
const ssm = new SSMClient({});

const TABLE = process.env.LEADS_TABLE_NAME!;
const COUNTERS_TABLE = process.env.SEND_COUNTERS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const FROM_EMAIL = process.env.SES_FROM_EMAIL!;
const TRACKING_BASE_URL = process.env.TRACKING_BASE_URL ?? '';
const FRONTEND_URL = process.env.FRONTEND_URL ?? '';
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
  { fromStatus: 'FOLLOWUP_2', toStatus: 'ARCHIVED', afterMs: 28 * DAY },
];

// Rama A del seguimiento condicional: leads que ya hicieron click en el reporte (por lo
// tanto ya están en ENGAGED — ver track-click) reciben un seguimiento personalizado en
// vez del genérico de arriba. Sin toStatus: el lead se queda en ENGAGED, solo se marca
// engagedFollowupSentAt para no reenviar.
const ENGAGED_FOLLOWUP_DELAY_MS = 5 * DAY;

function isEngagedFollowupCandidate(lead: LeadItem, now: number): boolean {
  return !!lead.clickCount && lead.clickCount > 0
    && !lead.engagedFollowupSentAt
    && !!lead.engagedAt && (now - lead.engagedAt) > ENGAGED_FOLLOWUP_DELAY_MS;
}

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
  return buildFollowupLinks(lead, TRACKING_BASE_URL, FRONTEND_URL, secret);
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

  // Rama A (leads ENGAGED, ya hicieron click) va primero — son los leads más calientes,
  // priorizan el freno diario por encima de los seguimientos genéricos y del backlog.
  const engagedCandidates = (await queryAllByStatus('ENGAGED')).filter((lead) => isEngagedFollowupCandidate(lead, now));

  for (const lead of engagedCandidates) {
    if (lead.unsubscribed) {
      const timelineEvent: TimelineEvent = { at: now, event: 'ENGAGED_FOLLOWUP_SKIPPED_UNSUBSCRIBED', by: 'system' };
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { leadId: lead.leadId },
        UpdateExpression: 'SET engagedFollowupSentAt = :now, timeline = list_append(timeline, :event)',
        ExpressionAttributeValues: { ':now': now, ':event': [timelineEvent] },
      }));
      continue;
    }

    if (sentToday >= dailyCap) {
      skippedByCapCount++;
      continue; // se recoge de nuevo mañana
    }

    if (!lead.reportHtmlS3Key) {
      console.error('followup-sequencer: lead engaged sin reporte, no se puede generar seguimiento', lead.leadId);
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
      const finding = pickEngagedFinding(lead);
      const emailData = await generateEngagedFollowupEmail(client, lead.leadId, reportHtml, finding, lead.businessName, trackingUrl, unsubscribeUrl, bookingUrl, CAN_SPAM_ADDRESS);
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

    const eventName = `ENGAGED_FOLLOWUP_${sendError ? 'SEND_FAILED' : 'SENT'}`;
    const timelineEvent: TimelineEvent = sendError
      ? { at: now2, event: eventName, by: 'system', note: sendError }
      : { at: now2, event: eventName, by: 'system', meta: { subject } };

    if (sendError) {
      // No se toca engagedFollowupSentAt — el cron de mañana reintenta solo
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { leadId: lead.leadId },
        UpdateExpression: 'SET timeline = list_append(timeline, :event)',
        ExpressionAttributeValues: { ':event': [timelineEvent] },
      }));
      console.error('followup-sequencer: engaged follow-up send failed', lead.leadId, sendError);
      continue;
    }

    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { leadId: lead.leadId },
        UpdateExpression: 'SET engagedFollowupSentAt = :now, emailSubject = :subject, emailBody = :body, timeline = list_append(timeline, :event)',
        ConditionExpression: '#status = :engaged',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':engaged': 'ENGAGED', ':now': now2, ':subject': subject, ':body': body, ':event': [timelineEvent] },
      }));
      await incrementSentCountToday(ddb, COUNTERS_TABLE);
      sentToday++;
      sent++;
      advanced++;
    } catch (err: any) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
      // El lead avanzó por otra vía (booking/archivado manual) justo entre la query y este
      // update — el email ya salió, pero no pisamos su estado real.
    }
  }

  // Después de rama A (arriba), los seguimientos genéricos de día 7/14/28 — tienen fecha
  // comprometida. El backlog de leads ANALYZED sin enviar (más abajo) no tiene deadline,
  // así que usa lo que sobra del freno diario. Antes el backlog iba antes que los
  // seguimientos y uno grande los dejaba pospuestos indefinidamente, aunque ya hubieran
  // cumplido su plazo.
  for (const threshold of THRESHOLDS) {
    const candidates = (await queryAllByStatus(threshold.fromStatus)).filter(
      (lead) => lead.sentAt && (now - lead.sentAt) > threshold.afterMs
    );

    for (const lead of candidates) {
      // Sin envío (umbral final -> ARCHIVED): solo transición, no consume el freno diario.
      if (!threshold.followupNumber) {
        const timelineEvent: TimelineEvent = { at: now, event: 'ARCHIVED_NO_RESPONSE', by: 'system' };
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
        const emailData = await generateFollowupEmail(client, lead.leadId, reportHtml, threshold.followupNumber, trackingUrl, unsubscribeUrl, bookingUrl, CAN_SPAM_ADDRESS);
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

  // Leads en ANALYZED cuyo auto-envío (desde generate-report) nunca salió porque el freno
  // diario ya estaba gastado en ese momento — sin esto se quedarían atascados para siempre.
  // Sin umbral de antigüedad, son elegibles desde ya. Corre después de los seguimientos para
  // no robarles cupo (ver comentario arriba).
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

  console.log(`followup-sequencer: ${advanced} leads avanzados, ${sent} emails enviados, ${skippedByCapCount} saltados por freno diario`);
};
