import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { TimelineEvent } from '../shared/types';
import { verifyToken } from '../shared/tracking';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const ssm = new SSMClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;

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

function htmlPage(message: string): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Unsubscribe</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#ECEAE6;padding:60px 16px;">
<div style="max-width:480px;margin:0 auto;background:#fff;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.10);">
<p style="font-size:14px;line-height:1.6;color:#1A1A1A;">${message}</p>
</div>
</body></html>`,
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  const token = event.queryStringParameters?.t;
  if (!leadId || !token) return htmlPage('This link is no longer valid.');

  const secret = await getTrackingSecret();
  if (!verifyToken(leadId, token, secret)) return htmlPage('This link is no longer valid.');

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return htmlPage('This link is no longer valid.');

  const now = Date.now();
  const event_: TimelineEvent = { at: now, event: 'UNSUBSCRIBED', by: 'system' };

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: 'SET unsubscribed = :true, unsubscribedAt = :now, timeline = list_append(timeline, :event)',
    ExpressionAttributeValues: { ':true': true, ':now': now, ':event': [event_] },
  }));

  return htmlPage("You've been unsubscribed. You won't receive any further emails from us.");
};
