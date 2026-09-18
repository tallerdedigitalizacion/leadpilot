// Prompts como datos: el contenido editable de cada prompt vive en DynamoDB
// (leadpilot-prompts), no hardcodeado en el código — permite cambiar el ángulo/copy sin
// deploy. Caché con TTL corto (a diferencia del resto del repo, que cachea secretos para
// siempre por contenedor — acá el valor SÍ puede cambiar entre invocaciones si alguien
// edita el prompt, así que un caché eterno rompería el propósito de esta migración).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.PROMPTS_TABLE_NAME!;
const TTL_MS = Number(process.env.PROMPT_CACHE_TTL_MS ?? 300_000);

interface CachedPrompt {
  content: string;
  systemPrompt?: string;
  version: number;
  cachedAt: number;
}

const cache = new Map<string, CachedPrompt>();

export async function getActivePrompt(promptId: string): Promise<{ content: string; systemPrompt?: string; version: number }> {
  const hit = cache.get(promptId);
  if (hit && Date.now() - hit.cachedAt < TTL_MS) return hit;

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { promptId, version: 'ACTIVE' } }));
  if (!result.Item) throw new Error(`prompt-store: no se encontró versión ACTIVE para promptId "${promptId}"`);

  const entry: CachedPrompt = {
    content: result.Item.content,
    systemPrompt: result.Item.systemPrompt,
    version: result.Item.activeVersion,
    cachedAt: Date.now(),
  };
  cache.set(promptId, entry);
  return entry;
}

// Sustitución simple de {{placeholder}} — sin lógica condicional ni loops, eso queda en
// código. Si falta una variable, loguea el error y sustituye por '' en vez de tirar: sin
// test suite, un typo en un prompt editado a mano no debería tumbar el pipeline entero.
export function renderPrompt(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!(name in variables)) {
      console.error(`prompt-store: placeholder {{${name}}} sin resolver — revisar el template guardado`);
      return '';
    }
    return variables[name];
  });
}
