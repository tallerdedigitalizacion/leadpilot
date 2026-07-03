import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const TABLE = process.env.LEADS_TABLE_NAME!;

export const handler = async (_: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const counts: Record<string, number> = {};
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: '#s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of result.Items ?? []) {
      const s = (item.status as string) ?? 'UNKNOWN';
      counts[s] = (counts[s] ?? 0) + 1;
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ counts }),
  };
};
