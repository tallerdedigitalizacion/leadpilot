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

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  const token = event.queryStringParameters?.t;
  if (!leadId || !token) return json(400, { error: 'This link is incomplete.' });

  const secret = await getTrackingSecret();
  if (!verifyToken(leadId, token, secret)) return json(403, { error: 'This link is no longer valid.' });

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return json(404, { error: 'This link is no longer valid.' });

  const now = Date.now();
  const event_: TimelineEvent = { at: now, event: 'UNSUBSCRIBED', by: 'system' };

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: 'SET unsubscribed = :true, unsubscribedAt = :now, timeline = list_append(timeline, :event)',
    ExpressionAttributeValues: { ':true': true, ':now': now, ':event': [event_] },
  }));

  return json(200, { unsubscribed: true });
};
