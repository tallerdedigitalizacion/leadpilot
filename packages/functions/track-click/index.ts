import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { LeadItem, TimelineEvent } from '../shared/types';
import { verifyToken } from '../shared/tracking';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ssm = new SSMClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;
const FRONTEND_URL = process.env.FRONTEND_URL ?? '';

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

function redirect(location: string): APIGatewayProxyResultV2 {
  return { statusCode: 302, headers: { Location: location } };
}

function notFoundPage(): APIGatewayProxyResultV2 {
  return {
    statusCode: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<p>This link is no longer valid.</p>',
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  const token = event.queryStringParameters?.t;
  if (!leadId || !token) return notFoundPage();

  const secret = await getTrackingSecret();
  if (!verifyToken(leadId, token, secret)) return notFoundPage();

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return notFoundPage();
  const lead = result.Item as LeadItem;

  const now = Date.now();
  const clickEvent: TimelineEvent = { at: now, event: 'LINK_CLICKED', by: 'system' };

  // Always record the click, regardless of current status — history survives past ENGAGED/CALLED/etc.
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: 'ADD clickCount :one SET lastClickedAt = :now, timeline = list_append(timeline, :event)',
    ExpressionAttributeValues: { ':one': 1, ':now': now, ':event': [clickEvent] },
  }));

  // Solo pasa a ENGAGED si el lead sigue "esperando respuesta" (SENT o en la secuencia de
  // seguimiento). Si ya avanzó (CALLED/RESPONDED/BOOKED/etc.), lo dejamos como está.
  const engagedEvent: TimelineEvent = { at: now, event: 'ENGAGED', by: 'system' };
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: 'SET #status = :engaged, engagedAt = :now, timeline = list_append(timeline, :event)',
      ConditionExpression: '#status IN (:sent, :f1, :f2)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':engaged': 'ENGAGED', ':sent': 'SENT', ':f1': 'FOLLOWUP_1', ':f2': 'FOLLOWUP_2',
        ':now': now, ':event': [engagedEvent],
      },
    }));
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  }

  if (!lead.reportHtmlS3Key) return redirect(FRONTEND_URL || 'https://tallerdedigitalizacion.com');

  const freshUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: process.env.REPORTS_BUCKET_NAME!, Key: lead.reportHtmlS3Key }),
    { expiresIn: 7 * 24 * 60 * 60 }
  );
  return redirect(freshUrl);
};
