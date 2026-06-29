import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import type { LeadItem, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ses = new SESClient({ region: 'us-east-1' });
const TABLE = process.env.LEADS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const FROM_EMAIL = process.env.SES_FROM_EMAIL!;

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function buildRawEmail(params: {
  from: string;
  to: string;
  subject: string;
  body: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
}): string {
  const boundary = `boundary_${Date.now()}`;
  const pdfBase64 = params.pdfBuffer.toString('base64');

  return [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    params.body,
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${params.pdfFilename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${params.pdfFilename}"`,
    '',
    pdfBase64,
    '',
    `--${boundary}--`,
  ].join('\r\n');
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
  if (!lead.reportPdfS3Key) return respond(400, { error: 'Report PDF not generated yet — call /report first' });
  if (!lead.emailSubject || !lead.emailBody) return respond(400, { error: 'Email content not generated yet' });

  // Descarga el PDF de S3
  const s3Object = await s3.send(new GetObjectCommand({
    Bucket: BUCKET,
    Key: lead.reportPdfS3Key,
  }));
  const pdfBytes = await s3Object.Body!.transformToByteArray();
  const pdfBuffer = Buffer.from(pdfBytes);

  const rawEmail = buildRawEmail({
    from: FROM_EMAIL,
    to: lead.email,
    subject: lead.emailSubject,
    body: lead.emailBody,
    pdfBuffer,
    pdfFilename: `web-analysis-${lead.businessName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.pdf`,
  });

  await ses.send(new SendRawEmailCommand({
    RawMessage: { Data: Buffer.from(rawEmail) },
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
