// Botón manual de prueba — dispara el seguimiento 1 o 2 al instante para un lead puntual,
// sin esperar los 7/14 días reales ni consumir el freno diario (es una acción explícita de
// Pablo, no un envío automatizado en volumen). Reusa el mismo prompt/formato que el cron real
// de followup-sequencer vía shared/followup-email.ts, así el contenido que se prueba es
// idéntico al que saldría en producción.
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem, LeadStatus, TimelineEvent } from '../shared/types';
import { buildLinks, generateFollowupEmail, pickEngagedFinding, generateEngagedFollowupEmail } from '../shared/followup-email';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ses = new SESClient({ region: process.env.SES_REGION ?? 'us-east-1' });
const ssm = new SSMClient({});

const TABLE = process.env.LEADS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const FROM_EMAIL = process.env.SES_FROM_EMAIL!;
const TRACKING_BASE_URL = process.env.TRACKING_BASE_URL ?? '';
const FRONTEND_URL = process.env.FRONTEND_URL ?? '';
const CAN_SPAM_ADDRESS = process.env.CAN_SPAM_ADDRESS ?? '[dirección física pendiente]';

const FROM_STATUS: Record<1 | 2, LeadStatus> = { 1: 'SENT', 2: 'FOLLOWUP_1' };
const TO_STATUS: Record<1 | 2, LeadStatus> = { 1: 'FOLLOWUP_1', 2: 'FOLLOWUP_2' };

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  if (!leadId) return respond(400, { error: 'leadId is required' });

  let body: { followupNumber?: number; branch?: 'engaged' };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  if (body.branch === 'engaged') {
    return simulateEngagedFollowup(leadId);
  }

  if (body.followupNumber !== 1 && body.followupNumber !== 2) {
    return respond(400, { error: 'followupNumber must be 1 or 2, or branch must be "engaged"' });
  }
  const followupNumber = body.followupNumber;

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return respond(404, { error: 'Lead not found' });
  const lead = result.Item as LeadItem;

  const fromStatus = FROM_STATUS[followupNumber];
  if (lead.status !== fromStatus) {
    return respond(400, { error: `El lead debe estar en ${fromStatus} para simular el seguimiento ${followupNumber} (está en ${lead.status})` });
  }
  if (!lead.reportHtmlS3Key) return respond(400, { error: 'El lead no tiene reporte generado' });

  const toAddresses = [...new Set([...(lead.emails ?? []), ...(lead.email ? [lead.email] : [])])];
  if (toAddresses.length === 0) return respond(400, { error: 'El lead no tiene ningún email' });

  const [s3Result, anthropicParam, trackingSecretParam] = await Promise.all([
    s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: lead.reportHtmlS3Key })),
    ssm.send(new GetParameterCommand({ Name: process.env.ANTHROPIC_API_KEY_PARAM!, WithDecryption: true })),
    ssm.send(new GetParameterCommand({ Name: process.env.TRACKING_SECRET_PARAM!, WithDecryption: true })),
  ]);
  const reportHtml = await s3Result.Body?.transformToString() ?? '';
  const client = new Anthropic({ apiKey: anthropicParam.Parameter!.Value! });
  const { trackingUrl, unsubscribeUrl, bookingUrl } = buildLinks(lead, TRACKING_BASE_URL, FRONTEND_URL, trackingSecretParam.Parameter!.Value!);

  const emailData = await generateFollowupEmail(client, lead.leadId, reportHtml, followupNumber, trackingUrl, unsubscribeUrl, bookingUrl, CAN_SPAM_ADDRESS);

  const now = Date.now();
  try {
    await ses.send(new SendEmailCommand({
      Source: FROM_EMAIL,
      Destination: { ToAddresses: toAddresses, BccAddresses: [FROM_EMAIL] },
      Message: {
        Subject: { Data: emailData.subject, Charset: 'UTF-8' },
        Body: { Html: { Data: emailData.body, Charset: 'UTF-8' } },
      },
    }));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failEvent: TimelineEvent = { at: now, event: `FOLLOWUP_${followupNumber}_SEND_FAILED`, by: 'user', note: error, meta: { simulated: true } };
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: 'SET timeline = list_append(timeline, :event)',
      ExpressionAttributeValues: { ':event': [failEvent] },
    }));
    return respond(502, { error: `El envío falló: ${error}` });
  }

  const toStatus = TO_STATUS[followupNumber];
  const followupAtField = followupNumber === 1 ? 'followup1SentAt' : 'followup2SentAt';
  const sentEvent: TimelineEvent = { at: now, event: `FOLLOWUP_${followupNumber}_SENT`, by: 'user', meta: { subject: emailData.subject, simulated: true } };

  try {
    const updated = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: `SET #status = :to, ${followupAtField} = :now, emailSubject = :subject, emailBody = :body, timeline = list_append(timeline, :event)`,
      ConditionExpression: '#status = :from',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':to': toStatus, ':from': fromStatus, ':now': now,
        ':subject': emailData.subject, ':body': emailData.body, ':event': [sentEvent],
      },
      ReturnValues: 'ALL_NEW',
    }));
    return respond(200, updated.Attributes);
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      // El email ya salió — el estado cambió por otra vía justo en esta ventana, no lo pisamos.
      return respond(409, { error: 'El estado del lead cambió mientras se enviaba — el email salió igual, revisá el timeline' });
    }
    throw err;
  }
};

// Rama A — dispara el seguimiento personalizado post-click al instante, sin esperar los
// 5 días reales desde engagedAt. A diferencia de la rama 1/2 de arriba, no cambia el
// status (el lead se queda en ENGAGED); solo marca engagedFollowupSentAt.
async function simulateEngagedFollowup(leadId: string): Promise<APIGatewayProxyResultV2> {
  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return respond(404, { error: 'Lead not found' });
  const lead = result.Item as LeadItem;

  if (lead.status !== 'ENGAGED') {
    return respond(400, { error: `El lead debe estar en ENGAGED para simular el seguimiento personalizado (está en ${lead.status})` });
  }
  if (!lead.reportHtmlS3Key) return respond(400, { error: 'El lead no tiene reporte generado' });

  const toAddresses = [...new Set([...(lead.emails ?? []), ...(lead.email ? [lead.email] : [])])];
  if (toAddresses.length === 0) return respond(400, { error: 'El lead no tiene ningún email' });

  const [s3Result, anthropicParam, trackingSecretParam] = await Promise.all([
    s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: lead.reportHtmlS3Key })),
    ssm.send(new GetParameterCommand({ Name: process.env.ANTHROPIC_API_KEY_PARAM!, WithDecryption: true })),
    ssm.send(new GetParameterCommand({ Name: process.env.TRACKING_SECRET_PARAM!, WithDecryption: true })),
  ]);
  const reportHtml = await s3Result.Body?.transformToString() ?? '';
  const client = new Anthropic({ apiKey: anthropicParam.Parameter!.Value! });
  const { trackingUrl, unsubscribeUrl, bookingUrl } = buildLinks(lead, TRACKING_BASE_URL, trackingSecretParam.Parameter!.Value!);

  const finding = pickEngagedFinding(lead);
  const emailData = await generateEngagedFollowupEmail(client, lead.leadId, reportHtml, finding, lead.businessName, trackingUrl, unsubscribeUrl, bookingUrl, CAN_SPAM_ADDRESS);

  const now = Date.now();
  try {
    await ses.send(new SendEmailCommand({
      Source: FROM_EMAIL,
      Destination: { ToAddresses: toAddresses, BccAddresses: [FROM_EMAIL] },
      Message: {
        Subject: { Data: emailData.subject, Charset: 'UTF-8' },
        Body: { Html: { Data: emailData.body, Charset: 'UTF-8' } },
      },
    }));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failEvent: TimelineEvent = { at: now, event: 'ENGAGED_FOLLOWUP_SEND_FAILED', by: 'user', note: error, meta: { simulated: true } };
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: 'SET timeline = list_append(timeline, :event)',
      ExpressionAttributeValues: { ':event': [failEvent] },
    }));
    return respond(502, { error: `El envío falló: ${error}` });
  }

  const sentEvent: TimelineEvent = { at: now, event: 'ENGAGED_FOLLOWUP_SENT', by: 'user', meta: { subject: emailData.subject, simulated: true } };
  try {
    const updated = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: 'SET engagedFollowupSentAt = :now, emailSubject = :subject, emailBody = :body, timeline = list_append(timeline, :event)',
      ConditionExpression: '#status = :engaged',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':engaged': 'ENGAGED', ':now': now,
        ':subject': emailData.subject, ':body': emailData.body, ':event': [sentEvent],
      },
      ReturnValues: 'ALL_NEW',
    }));
    return respond(200, updated.Attributes);
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return respond(409, { error: 'El estado del lead cambió mientras se enviaba — el email salió igual, revisá el timeline' });
    }
    throw err;
  }
}
