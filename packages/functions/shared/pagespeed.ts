import type { PageSpeedScore } from './types';

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

export function formatPageSpeedRaw(score: PageSpeedScore, strategy: 'mobile' | 'desktop', url: string): string {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// La API de PageSpeed devuelve 500 "Lighthouse returned error: Something went wrong"
// con bastante frecuencia bajo carga (varios leads procesándose en paralelo comparten
// la misma cuota de la API key) — no es un fallo real del sitio, es transitorio.
// Reintentamos antes de darnos por vencidos.
async function fetchWithRetry(apiUrl: string, strategy: 'mobile' | 'desktop', attempts = 4): Promise<PageSpeedRawResponse> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(1000 * 2 ** (i - 1) + Math.random() * 500);
    const res = await fetch(apiUrl);
    if (res.ok) return await res.json() as PageSpeedRawResponse;
    lastError = new Error(`PageSpeed ${strategy} failed: ${res.status} ${await res.text().catch(() => '')}`);
    if (res.status < 500 && res.status !== 429) throw lastError; // error real del sitio/URL, reintentar no ayuda
  }
  throw lastError;
}

export async function fetchPageSpeed(url: string, strategy: 'mobile' | 'desktop'): Promise<{ score: PageSpeedScore; rawText: string }> {
  const key = process.env.PAGESPEED_API_KEY;
  // Without explicit category params the API only returns Performance — request all four
  const cats4 = 'category=performance&category=accessibility&category=seo&category=best-practices';
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://${url}&strategy=${strategy}&${cats4}${key ? `&key=${key}` : ''}`;
  const data = await fetchWithRetry(apiUrl, strategy);
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
