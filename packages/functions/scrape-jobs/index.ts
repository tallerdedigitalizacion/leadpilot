import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { v4 as uuidv4 } from 'uuid';
import type { ScrapeJob } from '../shared/types';
import { getCampaign } from '../shared/campaigns';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const lambdaClient = new LambdaClient({});
const TABLE = process.env.SCRAPE_JOBS_TABLE_NAME!;
const INGEST_API_KEY = process.env.INGEST_API_KEY!;
const SCRAPE_WORKER_FN = process.env.SCRAPE_WORKER_FUNCTION_NAME!;

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

  let body: { query?: string; city?: string; extractEmails?: boolean; provider?: string; campaignId?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  if (!body.query || !body.city) {
    return respond(400, { error: 'query and city are required' });
  }

  const jobId = uuidv4();
  const now = Date.now();
  const job: ScrapeJob = {
    jobId,
    status: 'PENDING',
    provider: body.provider === 'serpapi' ? 'serpapi'
      : body.provider === 'serpapi-web' ? 'serpapi-web'
      : 'gosom',
    // Un campaignId desconocido cae a la campaña por defecto en vez de dar 400: este
    // endpoint lo usa el botón manual del frontend, y un job con la campaña equivocada es
    // preferible a un scrape que no se llega a lanzar.
    campaignId: getCampaign(body.campaignId).campaignId,
    query: body.query,
    city: body.city,
    extractEmails: body.extractEmails ?? false,
    createdAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: job }));
  await lambdaClient.send(new InvokeCommand({
    FunctionName: SCRAPE_WORKER_FN,
    InvocationType: 'Event',
    Payload: JSON.stringify({ jobId }),
  }));

  return respond(202, { jobId });
};
