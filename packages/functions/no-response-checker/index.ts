import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { LeadItem, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.LEADS_TABLE_NAME!;
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

export const handler = async (): Promise<void> => {
  const now = Date.now();
  let cursor: Record<string, unknown> | undefined;
  let processed = 0;

  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'SENT' },
      ExclusiveStartKey: cursor,
    }));

    const overdue = (result.Items ?? []).filter((item) => {
      const lead = item as LeadItem;
      return lead.sentAt && (now - lead.sentAt) > FOURTEEN_DAYS_MS;
    });

    for (const item of overdue) {
      const timelineEvent: TimelineEvent = { at: now, event: 'NO_RESPONSE', by: 'system' };
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { leadId: item['leadId'] },
        UpdateExpression: 'SET #status = :status, timeline = list_append(timeline, :event)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': 'NO_RESPONSE',
          ':event': [timelineEvent],
        },
      }));
      processed++;
    }

    cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);

  console.log(`No-response checker: ${processed} leads marked as NO_RESPONSE`);
};
