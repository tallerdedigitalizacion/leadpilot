import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { PageSpeedScore } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.LEADS_TABLE_NAME!;

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

  let body: { strategy: 'mobile' | 'desktop' } & Partial<PageSpeedScore>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  if (!body.strategy || !['mobile', 'desktop'].includes(body.strategy)) {
    return respond(400, { error: 'strategy must be "mobile" or "desktop"' });
  }
  if (body.performance === undefined) {
    return respond(400, { error: 'performance is required' });
  }

  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!existing.Item) return respond(404, { error: 'Lead not found' });

  const score: PageSpeedScore = {
    performance:   body.performance,
    accessibility: body.accessibility ?? 0,
    seo:           body.seo ?? 0,
    bestPractices: body.bestPractices ?? 0,
    lcp:           body.lcp,
    tbt:           body.tbt,
    speedIndex:    body.speedIndex,
    fetchedAt:     Date.now(),
  };

  const field = body.strategy === 'mobile' ? 'pagespeedMobile' : 'pagespeedDesktop';

  const updated = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: `SET ${field} = :score`,
    ExpressionAttributeValues: { ':score': score },
    ReturnValues: 'ALL_NEW',
  }));

  return respond(200, updated.Attributes);
};
