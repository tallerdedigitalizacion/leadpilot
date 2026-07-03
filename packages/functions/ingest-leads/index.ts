import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { v4 as uuidv4 } from 'uuid';
import type { LeadItem, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const lambdaClient = new LambdaClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;
const INGEST_API_KEY = process.env.INGEST_API_KEY!;
const RUN_ANALYSIS_FN = process.env.RUN_ANALYSIS_FUNCTION_NAME!;

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const apiKey = event.headers['x-api-key'];
  if (apiKey !== INGEST_API_KEY) {
    return respond(403, { error: 'Forbidden' });
  }

  let body: { leads: Array<{ businessName: string; url: string; phone?: string; email?: string; city?: string; category?: string }> };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  if (!Array.isArray(body.leads) || body.leads.length === 0) {
    return respond(400, { error: 'leads array is required' });
  }

  let created = 0;
  let skipped = 0;
  const ids: string[] = [];

  for (const lead of body.leads) {
    if (!lead.businessName || !lead.url) {
      skipped++;
      continue;
    }

    // Deduplicar por URL
    const existing = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'url-index',
      KeyConditionExpression: '#url = :url',
      ExpressionAttributeNames: { '#url': 'url' },
      ExpressionAttributeValues: { ':url': lead.url },
      Limit: 1,
    }));

    if ((existing.Count ?? 0) > 0) {
      skipped++;
      continue;
    }

    const leadId = uuidv4();
    const now = Date.now();
    const ingestedEvent: TimelineEvent = { at: now, event: 'INGESTED', by: 'system' };
    const qualifiedEvent: TimelineEvent = { at: now, event: 'QUALIFIED', by: 'system' };
    const item: LeadItem = {
      leadId,
      status: 'QUALIFIED',
      qualifiedAt: now,
      businessName: lead.businessName,
      url: lead.url,
      phone: lead.phone,
      email: lead.email,
      city: lead.city,
      category: lead.category,
      createdAt: now,
      timeline: [ingestedEvent, qualifiedEvent],
    };

    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
    await lambdaClient.send(new InvokeCommand({
      FunctionName: RUN_ANALYSIS_FN,
      InvocationType: 'Event',
      Payload: JSON.stringify({ leadId }),
    }));
    ids.push(leadId);
    created++;
  }

  return respond(200, { created, skipped, ids });
};
