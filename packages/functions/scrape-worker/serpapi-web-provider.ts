// Tercer proveedor del scraper — SerpApi motor google, pero a diferencia de
// serpapi-provider.ts (que lee local_ads/local_results, el "local pack" de negocios con
// presencia física) este lee ads: los resultados patrocinados de la búsqueda web plana.
// Pensado para verticales sin local físico (abogados boutique, agentes de seguros
// independientes, asesores financieros chicos) donde el negocio no aparece en el local
// pack de Maps pero sí en la búsqueda web normal.
//
// Solo se ingieren patrocinados (ads), no organic_results — probado en vivo (2026-07-26):
// una query genérica como "Insurance" trae en orgánico a las aseguradoras más grandes de
// EEUU (Allstate, State Farm, AIG) y sitios de reguladores estatales (.gov), no agentes
// independientes — exactamente el negocio grande/cerrado que este vertical busca evitar.
// Que paguen por el anuncio ya es una señal de que están tratando de captar clientes
// online, más alineado con la hipótesis del vertical que cualquier resultado orgánico.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { ScrapeJob } from '../shared/types';
import type { ScrapedLead, ProviderResult } from './types';
import { toSerpApiLocation } from './serpapi-location';

const ssm = new SSMClient({});
const SERPAPI_KEY_PARAM = process.env.SERPAPI_KEY_PARAM!;

const SERPAPI_FETCH_TIMEOUT_MS = 60_000;
const EMAIL_FETCH_TIMEOUT_MS = 5_000;
// Algunos sitios (WAF/Cloudflare) devuelven distinto contenido o bloquean requests sin
// User-Agent de navegador — probado en vivo, no cambia el resultado para la mayoría pero
// es más robusto que no mandar nada.
const FETCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

let cachedApiKey: string | null = null;
async function getSerpApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const result = await ssm.send(new GetParameterCommand({ Name: SERPAPI_KEY_PARAM, WithDecryption: true }));
  cachedApiKey = result.Parameter!.Value!;
  return cachedApiKey;
}

interface SerpApiAd {
  title?: string;
  link?: string;
}

interface SerpApiWebResponse {
  ads?: SerpApiAd[];
  error?: string; // SerpApi a veces devuelve 200 con {"error": "..."} en vez de un status no-2xx
}

// A diferencia de stripProtocol en serpapi-provider.ts, acá también se recorta "www." — sin
// esto el mismo negocio podría duplicar-ingresar si aparece tanto en Maps (sin www.) como
// en SERP (con www.), ya que el dedup de ingest-leads es exacto por string de url.
function stripProtocol(url: string): string {
  return url.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

// A diferencia de Maps (que solo devuelve negocios reales), una búsqueda web genérica trae
// de todo: hilos de Reddit, perfiles de redes sociales, wikis, directorios de terceros,
// blogs sobre el tema — probado en vivo con "boutique lawyer": 5 de 7 resultados eran esto,
// no negocios. Se filtran los dominios de contenido/directorio más comunes antes de gastar
// un fetch de email en ellos.
const BLOCKED_DOMAINS = [
  'reddit.com', 'wikipedia.org', 'instagram.com', 'facebook.com', 'linkedin.com',
  'youtube.com', 'twitter.com', 'x.com', 'quora.com', 'pinterest.com', 'tiktok.com',
  'medium.com', 'yelp.com', 'indeed.com', 'glassdoor.com', 'bbb.org', 'yellowpages.com',
  // directorios/agregadores específicos de los verticales del piloto (legal, seguros,
  // finanzas, hipotecas)
  'clutch.co', 'clio.com', 'avvo.com', 'findlaw.com', 'justia.com', 'upcounsel.com',
  'martindale.com', 'lawyers.com', 'nolo.com', 'thumbtack.com', 'angi.com',
  'superlawyers.com', 'solopracticeuniversity.com',
];

// .gov/.mil son organismos públicos, nunca un prospecto; .org suele ser una entidad grande
// (colegio profesional, ONG, regulador) — ninguno encaja con "negocio chico buscando
// clientes". Se descartan de raíz, no solo por dominio puntual como BLOCKED_DOMAINS.
const BLOCKED_TLDS = ['.gov', '.mil', '.org'];

function isBlockedDomain(url: string): boolean {
  const host = url.split('/')[0].toLowerCase();
  if (BLOCKED_TLDS.some((tld) => host.endsWith(tld))) return true;
  return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

async function findEmailOnWebsite(website: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://${website}`, {
      signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': FETCH_USER_AGENT },
    });
    if (!res.ok) return undefined;
    const html = await res.text();
    const mailtoMatch = html.match(/mailto:([^"'?\s]+)/i);
    if (mailtoMatch) return mailtoMatch[1];
    const genericMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return genericMatch?.[0];
  } catch {
    return undefined; // timeout, DNS, TLS, lo que sea — se trata como "no se encontró email"
  }
}

function mapAd(a: SerpApiAd): ScrapedLead | undefined {
  if (!a.title || !a.link) return undefined;
  const url = stripProtocol(a.link);
  if (isBlockedDomain(url)) return undefined;
  return { businessName: a.title, url, sponsored: true };
}

export async function runSerpApiWebScrape(job: ScrapeJob): Promise<ProviderResult> {
  const apiKey = await getSerpApiKey();
  const params = new URLSearchParams({
    engine: 'google',
    q: job.query,
    location: toSerpApiLocation(job.city),
    google_domain: 'google.com',
    gl: 'us',
    hl: 'en',
    api_key: apiKey,
  });
  const url = `https://serpapi.com/search?${params.toString()}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(SERPAPI_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`SerpApi respondió ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json() as SerpApiWebResponse;
  if (data.error) throw new Error(`SerpApi: ${data.error}`);

  const candidates = (data.ads ?? []).map(mapAd).filter((l): l is ScrapedLead => l !== undefined);

  const leads: ScrapedLead[] = [];
  for (const c of candidates) {
    const email = job.extractEmails ? await findEmailOnWebsite(c.url) : undefined;
    if (job.extractEmails && !email) continue; // mismo criterio que serpapi-provider.ts: sin email, se descarta
    leads.push({ ...c, city: job.city, email, vertical: job.query, leadSource: 'serp' });
  }

  return { rows: candidates.length, leads };
}
