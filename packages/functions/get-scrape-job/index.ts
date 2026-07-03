import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const TABLE = process.env.SCRAPE_JOBS_TABLE_NAME!;

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const jobId = event.pathParameters?.jobId;
  if (!jobId) {
    return { statusCode: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'jobId is required' }) };
  }

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { jobId } }));
  if (!result.Item) {
    return { statusCode: 404, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'not found' }) };
  }

  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(result.Item) };
};
