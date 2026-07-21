import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createHmac, timingSafeEqual } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { LeadItem, LeadStatus, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const ssm = new SSMClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;

const BOOKABLE_FROM: LeadStatus[] = ['SENT', 'ENGAGED', 'FOLLOWUP_1', 'FOLLOWUP_2'];

let webhookSecret: string | null = null;

async function getWebhookSecret(): Promise<string> {
  if (webhookSecret) return webhookSecret;
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.CALCOM_WEBHOOK_SECRET_PARAM!,
    WithDecryption: true,
  }));
  webhookSecret = result.Parameter!.Value!;
  return webhookSecret;
}

function verifySignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function ok(): APIGatewayProxyResultV2 {
  // Siempre 200 — Cal.com deshabilita webhooks que fallan repetidamente
  return { statusCode: 200, body: '{}' };
}

// La forma exacta del payload varía por versión de la API de Cal.com — se probó en vivo
// contra una reserva real antes de dar esto por bueno. Se intentan las rutas más probables.
function extractLeadId(body: any): string | undefined {
  return body?.payload?.metadata?.leadId ?? body?.metadata?.leadId ?? body?.payload?.responses?.leadId?.value;
}

function extractAttendeeEmail(body: any): string | undefined {
  return body?.payload?.attendees?.[0]?.email ?? body?.payload?.organizer?.email;
}

function extractBookingUid(body: any): string | undefined {
  return body?.payload?.uid ?? body?.payload?.bookingUid ?? body?.uid;
}

function toMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// Respaldo si metadata[leadId] no llegó en el payload (hay reportes de bugs de Cal.com al
// respecto) — busca por el email del asistente, que sí se prefilla de forma estable.
async function findLeadIdByEmail(email: string): Promise<string | undefined> {
  const result = await ddb.send(new ScanCommand({
    TableName: TABLE,
    FilterExpression: 'email = :email OR contains(emails, :email)',
    ExpressionAttributeValues: { ':email': email.toLowerCase() },
  }));
  const leads = (result.Items ?? []) as LeadItem[];
  if (leads.length === 0) return undefined;
  leads.sort((a, b) => b.createdAt - a.createdAt);
  return leads[0].leadId;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');

  try {
    const secret = await getWebhookSecret();
    const signature = event.headers?.['x-cal-signature-256'] ?? event.headers?.['X-Cal-Signature-256'];
    if (!verifySignature(rawBody, signature, secret)) {
      console.error('calcom-webhook: invalid signature');
      return ok();
    }

    const body = JSON.parse(rawBody);
    console.log('calcom-webhook payload:', JSON.stringify(body));

    const triggerEvent = body?.triggerEvent;
    let leadId = extractLeadId(body);
    if (!leadId) {
      const attendeeEmail = extractAttendeeEmail(body);
      leadId = attendeeEmail ? await findLeadIdByEmail(attendeeEmail) : undefined;
      if (leadId) console.log('calcom-webhook: matched lead by attendee email fallback', leadId);
    }
    if (!leadId) {
      console.error('calcom-webhook: no leadId in payload (metadata or email match), triggerEvent=', triggerEvent);
      return ok();
    }

    const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
    if (!result.Item) {
      console.error('calcom-webhook: lead not found', leadId);
      return ok();
    }

    const now = Date.now();
    const bookingUid = extractBookingUid(body);

    // DynamoDB no acepta `undefined` en valores marshalled — solo se incluyen las claves
    // que realmente tienen dato (bookingUid/startTime/endTime pueden faltar en el payload).
    const meta: Record<string, unknown> = {};
    if (bookingUid !== undefined) meta.bookingUid = bookingUid;

    if (triggerEvent === 'BOOKING_CREATED') {
      const startTime = toMs(body?.payload?.startTime);
      const endTime = toMs(body?.payload?.endTime);
      if (startTime !== undefined) meta.startTime = startTime;

      const setParts = ['#status = :booked', 'timeline = list_append(timeline, :event)'];
      const attrValues: Record<string, unknown> = { ':booked': 'BOOKED' };
      BOOKABLE_FROM.forEach((status, i) => { attrValues[`:s${i}`] = status; });
      const conditionExpression = `#status IN (${BOOKABLE_FROM.map((_, i) => `:s${i}`).join(', ')})`;

      if (bookingUid !== undefined) { setParts.push('bookingUid = :uid'); attrValues[':uid'] = bookingUid; }
      if (startTime !== undefined) { setParts.push('bookingStartTime = :start'); attrValues[':start'] = startTime; }
      if (endTime !== undefined) { setParts.push('bookingEndTime = :end'); attrValues[':end'] = endTime; }

      const timelineEvent: TimelineEvent = { at: now, event: 'BOOKING_CREATED', by: 'system', meta };
      attrValues[':event'] = [timelineEvent];

      try {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { leadId },
          UpdateExpression: `SET ${setParts.join(', ')}`,
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: attrValues,
        }));
      } catch (err: any) {
        if (err?.name !== 'ConditionalCheckFailedException') throw err;
        console.log('calcom-webhook: lead not in a bookable status, skipping transition', leadId);
      }
    } else if (triggerEvent === 'BOOKING_CANCELLED') {
      const timelineEvent: TimelineEvent = { at: now, event: 'BOOKING_CANCELLED', by: 'system', meta };
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { leadId },
        UpdateExpression: 'SET bookingCancelledAt = :now, timeline = list_append(timeline, :event)',
        ExpressionAttributeValues: { ':now': now, ':event': [timelineEvent] },
      }));
    }

    return ok();
  } catch (err) {
    console.error('calcom-webhook failed:', err);
    return ok();
  }
};
