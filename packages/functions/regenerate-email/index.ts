import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem } from '../shared/types';
import { signToken } from '../shared/tracking';
import { generateEmail, generateLinkedinPost } from '../shared/report-content';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ssm = new SSMClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const TRACKING_BASE_URL = process.env.TRACKING_BASE_URL ?? '';
const FRONTEND_URL = process.env.FRONTEND_URL ?? '';
const CAN_SPAM_ADDRESS = process.env.CAN_SPAM_ADDRESS ?? '[dirección física pendiente]';

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

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  if (!leadId) return respond(400, { error: 'leadId is required' });

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return respond(404, { error: 'Lead not found' });
  const lead = result.Item as LeadItem;

  if (!lead.reportHtmlS3Key) {
    return respond(400, { error: 'Genera el reporte primero antes de regenerar el email' });
  }

  // Fetch the current report HTML from S3
  const s3Result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: lead.reportHtmlS3Key }));
  const reportHtml = await s3Result.Body?.transformToString() ?? '';

  const client = await getAnthropicClient();

  const secret = await getTrackingSecret();
  const token = signToken(leadId, secret);
  const trackingUrl = `${TRACKING_BASE_URL}/r/${leadId}?t=${token}`;
  const unsubscribeUrl = `${FRONTEND_URL}/unsubscribe/${leadId}?t=${token}`;

  const bookingParams = new URLSearchParams({ 'metadata[leadId]': leadId });
  if (lead.email) bookingParams.set('email', lead.email);
  const bookingUrl = `https://cal.com/taller-de-digitalizacion/30min?${bookingParams.toString()}`;

  const [emailData, linkedinPost] = await Promise.all([
    generateEmail(client, leadId, reportHtml, trackingUrl, unsubscribeUrl, bookingUrl, CAN_SPAM_ADDRESS),
    generateLinkedinPost(client, leadId, reportHtml),
  ]);

  const updated = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: 'SET emailSubject = :subject, emailBody = :body, linkedinPost = :linkedin',
    ExpressionAttributeValues: {
      ':subject': emailData.subject,
      ':body': emailData.body,
      ':linkedin': linkedinPost,
    },
    ReturnValues: 'ALL_NEW',
  }));

  return respond(200, updated.Attributes);
};
