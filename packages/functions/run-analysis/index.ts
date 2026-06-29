import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { PageSpeedScore, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;

// Cargada fuera del handler para cachear entre invocaciones en caliente
let anthropicClient: Anthropic | null = null;

async function getAnthropicClient(): Promise<Anthropic> {
  if (anthropicClient) return anthropicClient;
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.ANTHROPIC_API_KEY_PARAM!,
    WithDecryption: true,
  }));
  anthropicClient = new Anthropic({ apiKey: result.Parameter!.Value! });
  return anthropicClient;
}

async function fetchPageSpeed(url: string, strategy: 'mobile' | 'desktop'): Promise<PageSpeedScore> {
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${url}&strategy=${strategy}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`PageSpeed ${strategy} failed: ${res.status}`);
  const data = await res.json() as { lighthouseResult: { categories: Record<string, { score: number }> } };
  const cats = data.lighthouseResult.categories;
  return {
    performance: Math.round((cats['performance']?.score ?? 0) * 100),
    accessibility: Math.round((cats['accessibility']?.score ?? 0) * 100),
    seo: Math.round((cats['seo']?.score ?? 0) * 100),
    bestPractices: Math.round((cats['best-practices']?.score ?? 0) * 100),
    fetchedAt: Date.now(),
  };
}

async function runWebAnalysis(
  client: Anthropic,
  businessName: string,
  url: string,
  category?: string
): Promise<string> {
  const prompt = `Eres un consultor de marketing digital especializado en negocios locales en EEUU.

Analiza la web de este negocio y dame un diagnóstico honesto en markdown.
Negocio: ${businessName}
URL: ${url}
Categoría: ${category ?? 'No especificada'}

Estructura tu respuesta en estas secciones:
## Primer impacto
(qué ve un cliente potencial en los primeros 5 segundos)

## Problemas críticos
(máximo 5, los que más afectan a conversiones)

## Oportunidades
(qué mejoraría más rápidamente los resultados)

## Veredicto
(1-2 frases directas: ¿merece la pena contactar? ¿qué ángulo usar?)

Sé directo y específico. No des consejos genéricos.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  return block.type === 'text' ? block.text : '';
}

export const handler = async (event: { leadId: string }): Promise<void> => {
  const { leadId } = event;
  const lead = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!lead.Item) throw new Error(`Lead ${leadId} not found`);

  const { businessName, url, category } = lead.Item as { businessName: string; url: string; category?: string };

  const [mobileResult, desktopResult, anthropicResult] = await Promise.allSettled([
    fetchPageSpeed(url, 'mobile'),
    fetchPageSpeed(url, 'desktop'),
    getAnthropicClient().then((client) => runWebAnalysis(client, businessName, url, category)),
  ]);

  const now = Date.now();
  const timelineEvent: TimelineEvent = { at: now, event: 'ANALYZED', by: 'system' };

  const updates: Record<string, unknown> = {
    '#status': 'ANALYZED',
    analyzedAt: now,
  };
  const values: Record<string, unknown> = {
    ':status': 'ANALYZED',
    ':analyzedAt': now,
    ':event': [timelineEvent],
  };

  if (mobileResult.status === 'fulfilled') {
    updates['pagespeedMobile'] = 'pagespeedMobile';
    values[':pagespeedMobile'] = mobileResult.value;
  }
  if (desktopResult.status === 'fulfilled') {
    updates['pagespeedDesktop'] = 'pagespeedDesktop';
    values[':pagespeedDesktop'] = desktopResult.value;
  }
  if (anthropicResult.status === 'fulfilled') {
    updates['aiWebAnalysis'] = 'aiWebAnalysis';
    values[':aiWebAnalysis'] = anthropicResult.value;
  }

  const setParts = [
    '#status = :status',
    '#analyzedAt = :analyzedAt',
    'timeline = list_append(timeline, :event)',
    ...(mobileResult.status === 'fulfilled' ? ['pagespeedMobile = :pagespeedMobile'] : []),
    ...(desktopResult.status === 'fulfilled' ? ['pagespeedDesktop = :pagespeedDesktop'] : []),
    ...(anthropicResult.status === 'fulfilled' ? ['aiWebAnalysis = :aiWebAnalysis'] : []),
  ];

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: `SET ${setParts.join(', ')}`,
    ExpressionAttributeNames: {
      '#status': 'status',
      '#analyzedAt': 'analyzedAt',
    },
    ExpressionAttributeValues: values,
  }));
};
