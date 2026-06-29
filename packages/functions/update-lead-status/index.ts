import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { LeadStatus, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;
const RUN_ANALYSIS_FN = process.env.RUN_ANALYSIS_FUNCTION_NAME!;

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const VALID_TRANSITIONS: Partial<Record<LeadStatus, LeadStatus[]>> = {
  REVIEWING: ['QUALIFIED', 'DISCARDED'],
  ANALYZED: ['SENT'],
  SENT: ['CALLED', 'RESPONDED'],
};

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  if (!leadId) return respond(400, { error: 'leadId is required' });

  let body: { status: LeadStatus; note?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!existing.Item) return respond(404, { error: 'Lead not found' });

  const current = existing.Item.status as LeadStatus;
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed || !allowed.includes(body.status)) {
    return respond(400, { error: `Cannot transition from ${current} to ${body.status}` });
  }

  const now = Date.now();
  const timelineEvent: TimelineEvent = {
    at: now,
    event: body.status,
    by: 'user',
    note: body.note,
  };

  const extraFields: Record<string, unknown> = {};
  if (body.status === 'QUALIFIED') extraFields.qualifiedAt = now;
  if (body.status === 'SENT') extraFields.sentAt = now;

  const updateExpr = [
    '#status = :status',
    'timeline = list_append(timeline, :event)',
    ...Object.keys(extraFields).map((k) => `#${k} = :${k}`),
  ].join(', ');

  const attrNames: Record<string, string> = {
    '#status': 'status',
    ...Object.fromEntries(Object.keys(extraFields).map((k) => [`#${k}`, k])),
  };
  const attrValues: Record<string, unknown> = {
    ':status': body.status,
    ':event': [timelineEvent],
    ...Object.fromEntries(Object.entries(extraFields).map(([k, v]) => [`:${k}`, v])),
  };

  const updated = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: `SET ${updateExpr}`,
    ExpressionAttributeNames: attrNames,
    ExpressionAttributeValues: attrValues,
    ReturnValues: 'ALL_NEW',
  }));

  // Al pasar a QUALIFIED, dispara análisis de forma asíncrona
  if (body.status === 'QUALIFIED') {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: RUN_ANALYSIS_FN,
      InvocationType: 'Event', // asíncrono — no espera respuesta
      Payload: JSON.stringify({ leadId }),
    }));
  }

  return respond(200, updated.Attributes);
};
