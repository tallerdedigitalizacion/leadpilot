import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { LeadItem, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ses = new SESClient({ region: 'us-east-1' });
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
  if (!leadId) return respond(400, { error: 'leadId is required' });

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return respond(404, { error: 'Lead not found' });
  const lead = result.Item as LeadItem;

  if (lead.status !== 'ANALYZED') {
    return respond(400, { error: `Lead must be ANALYZED to send email, current: ${lead.status}` });
  }
  if (!lead.email) return respond(400, { error: 'Lead has no email address' });
  if (!lead.reportHtmlS3Key) return respond(400, { error: 'Report not generated yet — click "Generar reporte" first' });
  if (!lead.emailSubject || !lead.emailBody) return respond(400, { error: 'Email content not generated yet' });

  // Accept overrides from request body (user may have edited the subject/body in the UI)
  let reqBody: { emailSubject?: string; emailBody?: string } = {};
  try { reqBody = JSON.parse(event.body ?? '{}'); } catch { /* ignore */ }

  const subject = reqBody.emailSubject?.trim() || lead.emailSubject;
  const htmlBody = reqBody.emailBody?.trim() || lead.emailBody;

  await ses.send(new SendEmailCommand({
    Source: FROM_EMAIL,
    Destination: { ToAddresses: [lead.email] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body:    { Html: { Data: htmlBody, Charset: 'UTF-8' } },
    },
  }));

  const now = Date.now();
  const timelineEvent: TimelineEvent = { at: now, event: 'EMAIL_SENT', by: 'user' };

  const updated = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: 'SET #status = :status, sentAt = :sentAt, timeline = list_append(timeline, :event)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'SENT',
      ':sentAt': now,
      ':event': [timelineEvent],
    },
    ReturnValues: 'ALL_NEW',
  }));

  return respond(200, updated.Attributes);
};
