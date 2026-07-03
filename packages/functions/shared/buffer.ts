import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { LeadItem, TimelineEvent } from './types';

export interface BufferDeps {
  ddb: DynamoDBDocumentClient;
  ssm: SSMClient;
  leadsTable: string;
  countersTable: string;
  bufferApiKeyParam: string;
  channelId: string;
  dailyCapParam: string;
}

export type LinkedinPublishOutcome =
  | { ok: true; postId: string }
  | { ok: false; reason: 'no-content' | 'cap-exhausted' | 'publish-error'; error?: string };

const MUTATION = `
mutation CreatePost($text: String!, $channelId: ChannelId!) {
  createPost(input: { text: $text, channelId: $channelId, schedulingType: automatic, mode: shareNow }) {
    __typename
    ... on PostActionSuccess { post { id } }
    ... on NotFoundError { message }
    ... on UnauthorizedError { message }
    ... on UnexpectedError { message }
    ... on RestProxyError { message }
    ... on LimitReachedError { message }
    ... on InvalidInputError { message }
  }
}`;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getLinkedinDailyCap(ssm: SSMClient, paramName: string): Promise<number> {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: paramName }));
    const parsed = parseInt(result.Parameter?.Value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  } catch {
    return 3; // sin parámetro configurado, freno conservador — es una página pública, no un email 1:1
  }
}

async function getLinkedinPostCountToday(ddb: DynamoDBDocumentClient, countersTable: string): Promise<number> {
  const result = await ddb.send(new GetCommand({ TableName: countersTable, Key: { date: todayKey() } }));
  return (result.Item?.linkedinPostCount as number) ?? 0;
}

async function incrementLinkedinPostCountToday(ddb: DynamoDBDocumentClient, countersTable: string): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: countersTable,
    Key: { date: todayKey() },
    UpdateExpression: 'ADD linkedinPostCount :one',
    ExpressionAttributeValues: { ':one': 1 },
  }));
}

let bufferApiKey: string | null = null;
async function getBufferApiKey(ssm: SSMClient, paramName: string): Promise<string> {
  if (bufferApiKey) return bufferApiKey;
  const result = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  bufferApiKey = result.Parameter!.Value!;
  return bufferApiKey;
}

// Publica el post de LinkedIn ya generado vía la API de Buffer (mode: shareNow — inmediato,
// no a la cola). Página pública, a diferencia del email 1:1 — freno diario propio y separado
// del cupo de envíos, para no inundar de posts a los seguidores de la página.
export async function publishToLinkedin(
  deps: BufferDeps,
  lead: LeadItem,
  opts: { checkCap: boolean }
): Promise<LinkedinPublishOutcome> {
  if (!lead.linkedinPost) return { ok: false, reason: 'no-content' };

  if (opts.checkCap) {
    const cap = await getLinkedinDailyCap(deps.ssm, deps.dailyCapParam);
    const postedToday = await getLinkedinPostCountToday(deps.ddb, deps.countersTable);
    if (postedToday >= cap) return { ok: false, reason: 'cap-exhausted' };
  }

  const now = Date.now();
  try {
    const apiKey = await getBufferApiKey(deps.ssm, deps.bufferApiKeyParam);
    const res = await fetch('https://api.buffer.com', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: MUTATION, variables: { text: lead.linkedinPost, channelId: deps.channelId } }),
    });
    const json = await res.json() as {
      errors?: Array<{ message: string }>;
      data?: { createPost?: { __typename: string; post?: { id: string }; message?: string } };
    };

    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
    const result = json.data?.createPost;
    if (result?.__typename !== 'PostActionSuccess' || !result.post) {
      throw new Error(result?.message ?? `Respuesta inesperada de Buffer: ${JSON.stringify(json)}`);
    }

    const postId = result.post.id;
    const successEvent: TimelineEvent = { at: now, event: 'LINKEDIN_POST_PUBLISHED', by: 'system', meta: { method: 'automatic', postId } };
    await deps.ddb.send(new UpdateCommand({
      TableName: deps.leadsTable,
      Key: { leadId: lead.leadId },
      UpdateExpression: 'SET timeline = list_append(timeline, :event)',
      ExpressionAttributeValues: { ':event': [successEvent] },
    }));
    if (opts.checkCap) await incrementLinkedinPostCountToday(deps.ddb, deps.countersTable);
    return { ok: true, postId };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failEvent: TimelineEvent = { at: now, event: 'LINKEDIN_POST_PUBLISH_FAILED', by: 'system', note: error };
    await deps.ddb.send(new UpdateCommand({
      TableName: deps.leadsTable,
      Key: { leadId: lead.leadId },
      UpdateExpression: 'SET timeline = list_append(timeline, :event)',
      ExpressionAttributeValues: { ':event': [failEvent] },
    }));
    return { ok: false, reason: 'publish-error', error };
  }
}
