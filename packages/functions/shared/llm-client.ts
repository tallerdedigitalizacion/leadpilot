// Envoltorio de client.messages.create() que mide latencia y registra cada llamada en
// leadpilot-llm-logs. El log se escribe con await + try/catch (nunca fire-and-forget sin
// await: el runtime de Lambda puede congelar el contenedor apenas se resuelve la promesa
// del handler, perdiendo una escritura en vuelo) — pero un fallo de logging nunca hace
// fallar la llamada real a Claude, que ya se completó.
import Anthropic from '@anthropic-ai/sdk';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { computeCostUsd } from './llm-pricing';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const LOGS_TABLE = process.env.LLM_LOGS_TABLE_NAME!;

interface TrackedParams {
  promptId: string;
  promptVersion: number;
  leadId: string;
  model: string;
  max_tokens: number;
  system?: string;
  messages: Anthropic.MessageParam[];
}

export async function trackedCompletion(client: Anthropic, params: TrackedParams): Promise<Anthropic.Message> {
  const start = Date.now();
  const message = await client.messages.create({
    model: params.model,
    max_tokens: params.max_tokens,
    system: params.system,
    messages: params.messages,
  });
  const latencyMs = Date.now() - start;

  try {
    await ddb.send(new PutCommand({
      TableName: LOGS_TABLE,
      Item: {
        leadId: params.leadId,
        logId: `${Date.now()}#${randomUUID().slice(0, 8)}`,
        promptId: params.promptId,
        promptVersion: params.promptVersion,
        model: params.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        costUsd: computeCostUsd(params.model, message.usage.input_tokens, message.usage.output_tokens),
        latencyMs,
        at: Date.now(),
      },
    }));
  } catch (err) {
    console.error('llm-client: no se pudo escribir el log (la llamada a Claude sí se completó)', err);
  }

  return message;
}
