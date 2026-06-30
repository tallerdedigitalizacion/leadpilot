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

// ARCHIVED es alcanzable desde cualquier estado activo
const TERMINAL: LeadStatus[] = ['ARCHIVED', 'DISCARDED'];

const VALID_TRANSITIONS: Partial<Record<LeadStatus, LeadStatus[]>> = {
  REVIEWING:   ['QUALIFIED', 'DISCARDED', 'ARCHIVED'],
  QUALIFIED:   ['ARCHIVED'],
  ANALYZED:    ['SENT', 'ARCHIVED'],
  SENT:        ['CALLED', 'RESPONDED', 'ARCHIVED'],
  CALLED:      ['RESPONDED', 'ARCHIVED'],
  NO_RESPONSE: ['ARCHIVED'],
  RESPONDED:   ['ARCHIVED'],
};

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  if (!leadId) return respond(400, { error: 'leadId is required' });

  let body: { status?: LeadStatus; note?: string; myNotes?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!existing.Item) return respond(404, { error: 'Lead not found' });

  const current = existing.Item.status as LeadStatus;

  // ── Caso 1: solo actualizar myNotes (sin cambio de estado) ────────────────
  if (!body.status && body.myNotes !== undefined) {
    const updated = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: 'SET myNotes = :myNotes',
      ExpressionAttributeValues: { ':myNotes': body.myNotes },
      ReturnValues: 'ALL_NEW',
    }));
    return respond(200, updated.Attributes);
  }

  // ── Caso 2: transición de estado ──────────────────────────────────────────
  if (!body.status) {
    return respond(400, { error: 'Either status or myNotes required' });
  }

  if (TERMINAL.includes(current)) {
    return respond(400, { error: `Lead is already ${current}` });
  }

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
  if (body.myNotes !== undefined) extraFields.myNotes = body.myNotes;

  const setParts = [
    '#status = :status',
    'timeline = list_append(timeline, :event)',
    ...Object.keys(extraFields).map((k) => `#${k} = :${k}`),
  ];

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
    UpdateExpression: `SET ${setParts.join(', ')}`,
    ExpressionAttributeNames: attrNames,
    ExpressionAttributeValues: attrValues,
    ReturnValues: 'ALL_NEW',
  }));

  if (body.status === 'QUALIFIED') {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: RUN_ANALYSIS_FN,
      InvocationType: 'Event',
      Payload: JSON.stringify({ leadId }),
    }));
  }

  return respond(200, updated.Attributes);
};
