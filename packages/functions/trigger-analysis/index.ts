import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
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

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  if (!leadId) return respond(400, { error: 'leadId is required' });

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return respond(404, { error: 'Lead not found' });

  const { status } = result.Item as { status: string };
  const ALLOWED = new Set(['QUALIFIED', 'ANALYZED', 'SENT', 'CALLED', 'RESPONDED', 'NO_RESPONSE']);
  if (!ALLOWED.has(status)) {
    return respond(400, { error: `Cannot retry analysis for status: ${status}` });
  }

  await lambdaClient.send(new InvokeCommand({
    FunctionName: RUN_ANALYSIS_FN,
    InvocationType: 'Event',
    Payload: JSON.stringify({ leadId }),
  }));

  return respond(202, { message: 'Analysis triggered', leadId });
};
