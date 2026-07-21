// Segundo proveedor del scraper de Maps — SerpApi (motor google, no google_maps: los
// patrocinados de intención local viven en local_ads.ads del buscador general, el motor
// google_maps casi nunca los devuelve).
// local_ads.ads no trae website (son Local Services Ads de Google, un directorio propio —
// el negocio no necesita tener sitio para pagar por ese anuncio). Por eso el sitio se
// resuelve cruzando por nombre contra local_results.places, que sí trae "links.website".
// Filtro relajado a pedido de Pablo (2026-07-05): la intersección "patrocinado ∩ matchea
// con el top-3 orgánico ∩ el sitio expone email sin bloqueo anti-bot" resultó demasiado
// angosta para generar volumen — probado en vivo, la mayoría de corridas no producían
// ningún lead. Mientras Pablo está de vacaciones (2 semanas) y gosom sigue roto, se
// ingresan también los resultados orgánicos de local_results.places (sponsored queda sin
// marcar) para asegurar volumen de envíos. Revisar al volver: quizás gosom ya esté
// arreglado por los mantenedores de la librería, y ahí se puede volver a exigir solo
// patrocinados si se quiere ese filtro de calidad.
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { ScrapeJob } from '../shared/types';
import type { ScrapedLead, ProviderResult } from './types';

const ssm = new SSMClient({});
const SERPAPI_KEY_PARAM = process.env.SERPAPI_KEY_PARAM!;

const SERPAPI_FETCH_TIMEOUT_MS = 60_000; // SerpApi puede tardar ~30-47s en búsquedas reales (visto en producción)
const EMAIL_FETCH_TIMEOUT_MS = 5_000;

const US_STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// El parámetro location de SerpApi rechaza abreviaturas de 2 letras pegadas al nombre
// ("Fort Worth TX" y "Fort Worth, TX" ambas fallan con 400), pero sí acepta el nombre
// completo del estado ("Fort Worth, Texas"). El scheduler automático usa "Ciudad ST" para
// sus 50 ciudades — se expande aquí. Si no matchea (ciudad manual, extranjera, o ya en
// formato completo), se pasa tal cual.
function toSerpApiLocation(city: string): string {
  const match = city.trim().match(/^(.+?)\s+([A-Z]{2})$/);
  const stateName = match && US_STATE_NAMES[match[2]];
  return stateName ? `${match[1]}, ${stateName}, United States` : city;
}

let cachedApiKey: string | null = null;
async function getSerpApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const result = await ssm.send(new GetParameterCommand({ Name: SERPAPI_KEY_PARAM, WithDecryption: true }));
  cachedApiKey = result.Parameter!.Value!;
  return cachedApiKey;
}

interface SerpApiLocalAd {
  title?: string;
  phone?: string;
  type?: string;
}

interface SerpApiLocalPlace {
  title?: string;
  type?: string;
  phone?: string;
  links?: { website?: string };
}

interface SerpApiResponse {
  local_ads?: { ads?: SerpApiLocalAd[] };
  local_results?: { places?: SerpApiLocalPlace[] };
  error?: string; // SerpApi a veces devuelve 200 con {"error": "..."} en vez de un status no-2xx
}

function stripProtocol(url: string): string {
  return url.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

const NAME_STOPWORDS = new Set(['the', 'and', 'inc', 'llc', 'co', 'company', 'of', 'a', 'an']);

function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NAME_STOPWORDS.has(w));
}

// Heurística de coincidencia por solapamiento de palabras — el nombre en el anuncio ("Radiant
// Plumbing & Air Conditioning - Austin") casi nunca es idéntico al de local_results ("Radiant
// Plumbing, Air Conditioning, & Electrical"). Exige mayoría de solapamiento (>=0.5) y al menos
// 2 palabras en común para evitar falsos positivos entre negocios distintos del mismo rubro.
function findWebsiteByName(adTitle: string, places: SerpApiLocalPlace[]): string | undefined {
  const adTokens = nameTokens(adTitle);
  if (adTokens.length === 0) return undefined;
  let best: { website: string; score: number } | undefined;
  for (const place of places) {
    const website = place.links?.website?.trim();
    if (!website || !place.title) continue;
    const placeTokens = nameTokens(place.title);
    const common = adTokens.filter((t) => placeTokens.includes(t)).length;
    if (common < 2) continue;
    const score = common / Math.min(adTokens.length, placeTokens.length);
    if (score >= 0.5 && (!best || score > best.score)) best = { website, score };
  }
  return best?.website;
}

async function findEmailOnWebsite(website: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://${website}`, { signal: AbortSignal.timeout(EMAIL_FETCH_TIMEOUT_MS) });
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

function mapAd(ad: SerpApiLocalAd, places: SerpApiLocalPlace[]): ScrapedLead | undefined {
  if (!ad.title) return undefined;
  const website = findWebsiteByName(ad.title, places);
  if (!website) return undefined; // sin sitio no hay nada que analizar, mismo criterio que gosom
  return {
    businessName: ad.title,
    url: stripProtocol(website),
    phone: ad.phone?.trim() || undefined,
    category: ad.type?.trim() || undefined,
    city: undefined, // se completa después con job.city — ver runSerpApiScrape
    sponsored: true,
  };
}

function mapPlace(place: SerpApiLocalPlace): ScrapedLead | undefined {
  const website = place.links?.website?.trim();
  if (!website || !place.title) return undefined; // sin sitio no hay nada que analizar
  return {
    businessName: place.title,
    url: stripProtocol(website),
    phone: place.phone?.trim() || undefined,
    category: place.type?.trim() || undefined,
    city: undefined, // se completa después con job.city — ver runSerpApiScrape
    sponsored: undefined, // orgánico, no patrocinado
  };
}

export async function runSerpApiScrape(job: ScrapeJob): Promise<ProviderResult> {
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
  const data = await res.json() as SerpApiResponse;
  if (data.error) throw new Error(`SerpApi: ${data.error}`);

  const ads = data.local_ads?.ads ?? [];
  const places = data.local_results?.places ?? [];

  const sponsoredCandidates = ads.map((ad) => mapAd(ad, places)).filter((l): l is ScrapedLead => l !== undefined);
  const sponsoredUrls = new Set(sponsoredCandidates.map((l) => l.url));
  const organicCandidates = places
    .map(mapPlace)
    .filter((l): l is ScrapedLead => l !== undefined && !sponsoredUrls.has(l.url));

  const candidates = [...sponsoredCandidates, ...organicCandidates];

  const leads: ScrapedLead[] = [];
  for (const lead of candidates) {
    const email = job.extractEmails ? await findEmailOnWebsite(lead.url) : undefined;
    if (job.extractEmails && !email) continue; // mismo criterio que gosom: sin email, se descarta
    leads.push({ ...lead, city: job.city, email });
  }

  return { rows: candidates.length, leads };
}
