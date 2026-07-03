import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { LeadItem, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const ses = new SESClient({ region: process.env.SES_REGION ?? 'us-east-1' });
const TABLE = process.env.LEADS_TABLE_NAME!;
const FROM_EMAIL = process.env.SES_FROM_EMAIL!;

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  if (!leadId) return respond(400, { ok: false, error: 'leadId is required' });

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return respond(404, { ok: false, error: 'Lead not found' });
  const lead = result.Item as LeadItem;

  if (lead.unsubscribed) return respond(400, { ok: false, error: 'Lead unsubscribed — no se puede enviar' });

  // Accept overrides from request body (user may have edited the subject/body in the UI)
  let reqBody: { emailSubject?: string; emailBody?: string; toSelf?: boolean; toAddresses?: string[] } = {};
  try { reqBody = JSON.parse(event.body ?? '{}'); } catch { /* ignore */ }

  const toSelf = reqBody.toSelf === true;

  // Combined address list: explicit toAddresses > emails[] > email (legacy)
  const combinedEmails = [...new Set([
    ...(Array.isArray(lead.emails) ? lead.emails : []),
    ...(lead.email ? [lead.email] : []),
  ])];
  const toAddresses = toSelf
    ? [FROM_EMAIL]
    : (Array.isArray(reqBody.toAddresses) && reqBody.toAddresses.length > 0
        ? reqBody.toAddresses
        : combinedEmails);

  if (!toSelf && lead.status !== 'ANALYZED') {
    return respond(400, { ok: false, error: `Lead must be ANALYZED to send email, current: ${lead.status}` });
  }
  if (!toSelf && toAddresses.length === 0) return respond(400, { ok: false, error: 'Lead has no email address' });
  if (!lead.reportHtmlS3Key) return respond(400, { ok: false, error: 'Report not generated yet — click "Generar reporte" first' });
  if (!lead.emailSubject || !lead.emailBody) return respond(400, { ok: false, error: 'Email content not generated yet' });

  const subject = reqBody.emailSubject?.trim() || lead.emailSubject;
  const htmlBody = reqBody.emailBody?.trim() || lead.emailBody;

  const now = Date.now();
  let messageId: string | undefined;
  let sendError: string | null = null;

  try {
    const sesResult = await ses.send(new SendEmailCommand({
      Source: FROM_EMAIL,
      Destination: {
        ToAddresses: toAddresses,
        BccAddresses: toSelf ? [] : [FROM_EMAIL],
      },
      Message: {
        Subject: { Data: toSelf ? `[PREVIEW] ${subject}` : subject, Charset: 'UTF-8' },
        Body:    { Html: { Data: htmlBody, Charset: 'UTF-8' } },
      },
    }));
    messageId = sesResult.MessageId;
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
  }

  // Always persist the outcome — a click on "send" is worthless if we can't prove it landed.
  const timelineEvent: TimelineEvent = sendError
    ? {
        at: now,
        event: toSelf ? 'EMAIL_PREVIEW_FAILED' : 'EMAIL_SEND_FAILED',
        by: 'user',
        note: sendError,
        meta: { to: toAddresses, subject },
      }
    : {
        at: now,
        event: toSelf ? 'EMAIL_PREVIEW_SENT' : 'EMAIL_SENT',
        by: 'user',
        meta: { to: toAddresses, subject, messageId },
      };

  const shouldFlipToSent = !sendError && !toSelf;
  const updateParams: UpdateCommandInput = shouldFlipToSent
    ? {
        TableName: TABLE,
        Key: { leadId },
        UpdateExpression: 'SET #status = :status, sentAt = :sentAt, timeline = list_append(timeline, :event)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':status': 'SENT', ':sentAt': now, ':event': [timelineEvent] },
        ReturnValues: 'ALL_NEW',
      }
    : {
        TableName: TABLE,
        Key: { leadId },
        UpdateExpression: 'SET timeline = list_append(timeline, :event)',
        ExpressionAttributeValues: { ':event': [timelineEvent] },
        ReturnValues: 'ALL_NEW',
      };

  const updated = await ddb.send(new UpdateCommand(updateParams));

  if (sendError) {
    return respond(502, { ok: false, error: sendError, lead: updated.Attributes });
  }
  if (toSelf) {
    return respond(200, { ok: true, preview: true, lead: updated.Attributes });
  }
  return respond(200, { ok: true, lead: updated.Attributes });
};
