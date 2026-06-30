import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { PageSpeedScore, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;

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

// ── PageSpeed ─────────────────────────────────────────────────────────────────

interface PageSpeedRawAudit {
  numericValue?: number;
  score?: number | null;
  displayValue?: string;
}

interface PageSpeedRawResponse {
  lighthouseResult: {
    categories: Record<string, { score: number }>;
    audits: Record<string, PageSpeedRawAudit>;
  };
}

function formatPageSpeedRaw(score: PageSpeedScore, strategy: 'mobile' | 'desktop', url: string): string {
  const grade = (v: number, good: number, mid: number) =>
    v >= good ? '✓ Good' : v >= mid ? '~ Needs Improvement' : '✗ Poor';
  const date = new Date().toISOString().split('T')[0];
  return [
    `=== PageSpeed Insights — ${strategy === 'mobile' ? 'Mobile' : 'Desktop'} ===`,
    `URL: https://${url}  |  Date: ${date}`,
    '',
    'SCORES',
    `  Performance:    ${score.performance}/100  ${grade(score.performance, 90, 50)}`,
    `  Accessibility:  ${score.accessibility}/100  ${grade(score.accessibility, 90, 50)}`,
    `  SEO:            ${score.seo}/100  ${grade(score.seo, 90, 50)}`,
    `  Best Practices: ${score.bestPractices}/100  ${grade(score.bestPractices, 90, 50)}`,
    '',
    'CORE WEB VITALS',
    `  LCP:         ${score.lcp !== undefined ? `${score.lcp}s  ${grade(-score.lcp, -2.5, -4)}  (target <2.5s)` : 'N/A'}`,
    `  TBT:         ${score.tbt !== undefined ? `${score.tbt}ms  ${grade(-score.tbt, -200, -600)}  (target <200ms)` : 'N/A'}`,
    `  Speed Index: ${score.speedIndex !== undefined ? `${score.speedIndex}s  ${grade(-score.speedIndex, -3.4, -5.8)}  (target <3.4s)` : 'N/A'}`,
  ].join('\n');
}

async function fetchPageSpeed(url: string, strategy: 'mobile' | 'desktop'): Promise<{ score: PageSpeedScore; rawText: string }> {
  const key = process.env.PAGESPEED_API_KEY;
  // Without explicit category params the API only returns Performance — request all four
  const cats4 = 'category=performance&category=accessibility&category=seo&category=best-practices';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${url}&strategy=${strategy}&${cats4}${key ? `&key=${key}` : ''}`;
  const res = await fetch(apiUrl);
  if (!res.ok) throw new Error(`PageSpeed ${strategy} failed: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json() as PageSpeedRawResponse;
  const categories = data.lighthouseResult.categories;
  const audits = data.lighthouseResult.audits;

  const score: PageSpeedScore = {
    performance:   Math.round(((categories['performance']?.score   ?? 0)) * 100),
    accessibility: Math.round(((categories['accessibility']?.score ?? 0)) * 100),
    seo:           Math.round(((categories['seo']?.score           ?? 0)) * 100),
    bestPractices: Math.round(((categories['best-practices']?.score ?? 0)) * 100),
    lcp: audits['largest-contentful-paint']?.numericValue
      ? Math.round((audits['largest-contentful-paint'].numericValue / 1000) * 10) / 10
      : undefined,
    tbt: audits['total-blocking-time']?.numericValue
      ? Math.round(audits['total-blocking-time'].numericValue)
      : undefined,
    speedIndex: audits['speed-index']?.numericValue
      ? Math.round((audits['speed-index'].numericValue / 1000) * 10) / 10
      : undefined,
    fetchedAt: Date.now(),
  };

  return { score, rawText: formatPageSpeedRaw(score, strategy, url) };
}

// ── Web crawl + analysis ──────────────────────────────────────────────────────

interface SiteData {
  html: string;
  headers: Record<string, string>;
  isHttps: boolean;
  wpAdminAccessible: boolean;
  finalUrl: string;
}

async function crawlSite(url: string): Promise<SiteData> {
  const httpsUrl = `https://${url}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let html = '';
  let headers: Record<string, string> = {};
  let finalUrl = httpsUrl;
  let wpAdminAccessible = false;

  try {
    const res = await fetch(httpsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadPilot/1.0)' },
    });
    html = await res.text();
    finalUrl = res.url;
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

    // Check wp-admin accessibility
    try {
      const wpRes = await fetch(`https://${url}/wp-admin`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadPilot/1.0)' },
      });
      // If it returns 200 or redirects to wp-login (not 403/404), it's accessible
      wpAdminAccessible = wpRes.status === 200 || wpRes.status === 302;
    } catch {
      wpAdminAccessible = false;
    }
  } finally {
    clearTimeout(timeout);
  }

  return {
    html: html.slice(0, 50000), // limit para no exceder tokens
    headers,
    isHttps: finalUrl.startsWith('https://'),
    wpAdminAccessible,
    finalUrl,
  };
}

async function runWebAnalysis(
  client: Anthropic,
  url: string,
  site: SiteData
): Promise<string> {
  const securityContext = [
    `HTTPS: ${site.isHttps ? 'sí' : 'no'}`,
    `Cloudflare: ${site.headers['cf-ray'] || site.headers['server']?.includes('cloudflare') ? 'sí' : 'detectar en HTML'}`,
    `CSP header: ${site.headers['content-security-policy'] ? 'sí' : 'no'}`,
    `HSTS header: ${site.headers['strict-transport-security'] ? 'sí' : 'no'}`,
    `X-Frame-Options: ${site.headers['x-frame-options'] ?? 'no'}`,
    `wp-admin accesible: ${site.wpAdminAccessible ? 'sí' : 'no'}`,
  ].join('\n');

  const prompt = `Se te va a proporcionar la URL de una web de un negocio local en EEUU, su HTML y datos de cabeceras HTTP.

Analiza la web técnicamente usando el HTML proporcionado y devuelve el análisis en texto con este formato exacto:

Stack: [CMS detectado, plugins o tecnologías visibles]
Seguridad: [Cloudflare sí/no, HTTPS correcto sí/no, wp-admin accesible sí/no, headers CSP/HSTS sí/no]
SEO: [meta descriptions sí/no, título descriptivo sí/no, Google My Business vinculado sí/no]
Estructura: [número aproximado de páginas, formularios sí/no, imágenes optimizadas sí/no]
Señales de negocio: [reseñas y estrellas si aparecen, años operando, redes sociales activas]
Dolor principal: [2-3 frases sobre el problema más urgente para alguien que está pagando anuncios]

Nada más. Sin introducción, sin conclusión, sin explicaciones adicionales.
Solo el bloque de texto con esos 6 campos.

---
URL: ${url}

CABECERAS HTTP:
${securityContext}

HTML DE LA PÁGINA PRINCIPAL (primeros 50.000 caracteres):
${site.html}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  return block.type === 'text' ? block.text : '';
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event: { leadId: string }): Promise<void> => {
  const { leadId } = event;
  const lead = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!lead.Item) throw new Error(`Lead ${leadId} not found`);

  const { url } = lead.Item as { url: string };

  const [mobileResult, desktopResult, crawlResult] = await Promise.allSettled([
    fetchPageSpeed(url, 'mobile'),
    fetchPageSpeed(url, 'desktop'),
    crawlSite(url),
  ]);

  // Análisis Claude — necesitamos el HTML del crawl
  let analysisResult: PromiseSettledResult<string> = { status: 'rejected', reason: 'crawl failed' };
  if (crawlResult.status === 'fulfilled') {
    const client = await getAnthropicClient();
    analysisResult = await Promise.resolve(
      runWebAnalysis(client, url, crawlResult.value)
        .then((v) => ({ status: 'fulfilled' as const, value: v }))
        .catch((e) => ({ status: 'rejected' as const, reason: e }))
    ).then((r) => r);
  }

  const now = Date.now();
  const timelineEvent: TimelineEvent = { at: now, event: 'ANALYZED', by: 'system' };

  const values: Record<string, unknown> = {
    ':status': 'ANALYZED',
    ':analyzedAt': now,
    ':event': [timelineEvent],
  };

  const setParts = [
    '#status = :status',
    '#analyzedAt = :analyzedAt',
    'timeline = list_append(timeline, :event)',
  ];

  if (mobileResult.status === 'fulfilled') {
    const { score, rawText } = mobileResult.value;
    setParts.push('pagespeedMobile = :pagespeedMobile', 'pagespeedMobileRaw = :pagespeedMobileRaw');
    values[':pagespeedMobile'] = score;
    values[':pagespeedMobileRaw'] = rawText;
    console.log('PageSpeed mobile OK:', score.performance, score.accessibility, score.seo, score.bestPractices);
  } else {
    console.warn('PageSpeed mobile FAILED:', mobileResult.reason);
  }
  if (desktopResult.status === 'fulfilled') {
    const { score, rawText } = desktopResult.value;
    setParts.push('pagespeedDesktop = :pagespeedDesktop', 'pagespeedDesktopRaw = :pagespeedDesktopRaw');
    values[':pagespeedDesktop'] = score;
    values[':pagespeedDesktopRaw'] = rawText;
    console.log('PageSpeed desktop OK:', score.performance, score.accessibility, score.seo, score.bestPractices);
  } else {
    console.warn('PageSpeed desktop FAILED:', desktopResult.reason);
  }
  if (analysisResult.status === 'fulfilled') {
    setParts.push('aiWebAnalysis = :aiWebAnalysis');
    values[':aiWebAnalysis'] = analysisResult.value;
    console.log('Claude analysis OK');
  } else {
    console.warn('Claude analysis FAILED:', analysisResult.reason);
  }

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
