// Una campaña es el paquete completo de "a quién le escribimos y desde dónde": el ICP
// (ciudades × verticales), el idioma y el locale de búsqueda, la identidad del remitente y
// los topes de envío. Permite correr dos ofertas distintas sobre el mismo pipeline sin que
// una pise a la otra.
//
// El COPY no vive acá a propósito — vive en leadpilot-prompts bajo claves
// `${campaignId}/${promptId}`, porque el mensaje es lo que hay que poder cambiar sin
// redeploy (ver shared/prompt-store.ts). El ICP y la identidad cambian poco, y se versionan
// mejor en git que en una tabla: si mañana el cron empieza a escribir a otro sector, eso
// tiene que quedar en el historial, no ser una edición silenciosa en DynamoDB.
import type { LeadItem, ScrapeProvider } from './types';

export interface CampaignConfig {
  campaignId: string;
  label: string;
  // Solo las activas entran en el sorteo del cron diario (auto-scrape-scheduler). Una
  // campaña inactiva sigue siendo válida para los leads que ya tiene: se les genera y
  // envía normalmente, simplemente no se captan leads nuevos.
  active: boolean;
  language: 'en' | 'es';
  // Sin pinear, manda el parámetro SSM /leadpilot/scrape-provider (el toggle global que
  // permite cambiar de scraper sin redeploy). Pinearlo es para campañas que solo funcionan
  // con un provider concreto.
  provider?: ScrapeProvider;
  locale: {
    gl: string;
    hl: string;
    googleDomain: string;
    // Se le añade a las ciudades que no son "Ciudad ST" de EEUU, porque el parámetro
    // location de SerpApi necesita el país para desambiguar (ver serpapi-location.ts).
    serpApiCountry?: string;
  };
  cities: string[];
  verticals: string[];
  fromEmail: string;
  bookingUrl: string;
  // Tope propio, además del global de /leadpilot/daily-send-cap. Sirve para estrenar una
  // campaña despacio sin frenar a las que ya están rodando.
  dailySendCap?: number;
}

// Los leads anteriores a la existencia de las campañas no tienen campaignId. Todos son de
// la campaña original, así que ese es el default en todas partes.
export const DEFAULT_CAMPAIGN_ID = 'us-webaudit';

const US_WEBAUDIT: CampaignConfig = {
  campaignId: 'us-webaudit',
  label: 'Auditoría web — EEUU',
  active: true,
  language: 'en',
  locale: { gl: 'us', hl: 'en', googleDomain: 'google.com' },
  fromEmail: 'info@tallerdedigitalizacion.com',
  bookingUrl: 'https://cal.com/taller-de-digitalizacion/30min',
  cities: [
    'Austin TX', 'San Antonio TX', 'Fort Worth TX', 'El Paso TX', 'Arlington TX',
    'Nashville TN', 'Memphis TN', 'Knoxville TN', 'Charlotte NC', 'Raleigh NC',
    'Durham NC', 'Greensboro NC', 'Jacksonville FL', 'Tampa FL', 'Orlando FL',
    'St. Petersburg FL', 'Hialeah FL', 'Scottsdale AZ', 'Mesa AZ', 'Tucson AZ',
    'Chandler AZ', 'Gilbert AZ', 'Louisville KY', 'Lexington KY', 'Indianapolis IN',
    'Fort Wayne IN', 'Columbus OH', 'Cleveland OH', 'Cincinnati OH', 'Toledo OH',
    'Las Vegas NV', 'Henderson NV', 'Reno NV', 'Portland OR', 'Eugene OR',
    'Albuquerque NM', 'Santa Fe NM', 'Omaha NE', 'Lincoln NE', 'Wichita KS',
    'Overland Park KS', 'Colorado Springs CO', 'Aurora CO', 'Virginia Beach VA',
    'Richmond VA', 'Newark NJ', 'Jersey City NJ', 'Bakersfield CA', 'Fresno CA',
    'Boise ID',
  ],
  verticals: [
    'plumbing', 'HVAC', 'roofing', 'landscaping', 'pest control', 'window repair',
    'garage door repair', 'pool service', 'electrician', 'dentist', 'orthodontist',
    'chiropractor', 'optometrist', 'veterinarian', 'auto repair', 'car detailing',
    'carpet cleaning', 'house cleaning', 'painting contractor', 'concrete contractor',
    'fencing contractor', 'tree service', 'irrigation', 'moving company',
    'storage facility', 'towing service', 'locksmith', 'security systems',
    'solar panels', 'water damage restoration', 'mold remediation',
    'fire damage restoration', 'foundation repair', 'drywall repair',
    'tile and flooring', 'kitchen remodeling', 'bathroom remodeling', 'handyman',
    'pressure washing', 'junk removal', 'personal injury lawyer', 'family lawyer',
    'tax preparation', 'accounting', 'insurance agency', 'real estate agency',
    'mortgage broker', 'physical therapy', 'hearing clinic', 'urgent care clinic',
    'med spa', 'restaurant', 'catering', 'food truck',
  ],
};

// Campaña nueva: en vez de vender una auditoría web, vende el Sprint de Automatización —
// 3 semanas y precio cerrado para dejar UN proceso manual funcionando solo. El ICP son
// negocios cuya web delata que la agenda o los presupuestos se llevan a mano.
//
// Arranca inactiva a propósito: antes de encenderla hacen falta los prompts es-sprint/* en
// leadpilot-prompts (Fase 3) y el evento de 20 minutos en Cal.com, que todavía no existe.
const ES_SPRINT: CampaignConfig = {
  campaignId: 'es-sprint',
  label: 'Sprint de Automatización — España',
  active: false,
  language: 'es',
  // gosom está roto por el CDN de Playwright y nunca se probó fuera de EEUU; esta campaña
  // solo tiene sentido con SerpApi, así que se pinea en vez de seguir el toggle global.
  provider: 'serpapi',
  locale: { gl: 'es', hl: 'es', googleDomain: 'google.es', serpApiCountry: 'Spain' },
  fromEmail: 'info@tallerdedigitalizacion.com',
  // PROVISIONAL: apunta al evento en inglés, que es el único que existe hoy. Antes de poner
  // active: true hay que crear el evento en español en Cal.com y cambiarlo aquí — un email
  // en español que aterriza en una página en inglés titulada "website speed call" rompe la
  // promesa justo en el clic. (El slug /20min que había antes devolvía 404.)
  bookingUrl: 'https://cal.com/taller-de-digitalizacion/free-15-min-website-speed-call',
  dailySendCap: 5,
  cities: [
    'Madrid', 'Barcelona', 'Valencia', 'Sevilla', 'Zaragoza', 'Málaga', 'Murcia',
    'Palma', 'Las Palmas de Gran Canaria', 'Bilbao', 'Alicante', 'Córdoba',
    'Valladolid', 'Vigo', 'Gijón', 'Granada', 'A Coruña', 'Vitoria-Gasteiz',
    'Santa Cruz de Tenerife', 'Pamplona', 'Santander', 'San Sebastián', 'Salamanca',
    'Marbella', 'Tarragona', 'León', 'Burgos', 'Albacete', 'Castellón de la Plana',
    'Logroño',
  ],
  // Verticales elegidos por una razón concreta: en todos, la web suele pedir que llames
  // para reservar o pedir presupuesto, que es exactamente la fricción operativa que el
  // análisis de la Fase 2 va a buscar y que el sprint se ofrece a eliminar.
  verticals: [
    'clínica dental', 'clínica de fisioterapia', 'clínica veterinaria', 'centro de estética',
    'clínica de podología', 'centro médico', 'óptica', 'gestoría', 'asesoría fiscal',
    'asesoría laboral', 'correduría de seguros', 'administrador de fincas', 'autoescuela',
    'academia de idiomas', 'academia de refuerzo escolar', 'taller mecánico',
    'concesionario de coches', 'taller de chapa y pintura', 'inmobiliaria',
    'empresa de reformas', 'instalador de aire acondicionado', 'fontanería',
    'electricista', 'cerrajería', 'agencia de marketing', 'empresa de mudanzas',
    'clínica de nutrición', 'centro de psicología', 'peluquería y barbería',
    'empresa de catering',
  ],
};

export const CAMPAIGNS: Record<string, CampaignConfig> = {
  [US_WEBAUDIT.campaignId]: US_WEBAUDIT,
  [ES_SPRINT.campaignId]: ES_SPRINT,
};

// Nunca tira: un campaignId desconocido (dato viejo, typo en una llamada manual a la API)
// cae a la campaña original en vez de romper el pipeline a mitad de camino. Loguea para que
// quede rastro si pasa.
export function getCampaign(campaignId?: string): CampaignConfig {
  if (campaignId && CAMPAIGNS[campaignId]) return CAMPAIGNS[campaignId];
  if (campaignId) {
    console.error(`campaigns: campaignId "${campaignId}" desconocido — usando "${DEFAULT_CAMPAIGN_ID}"`);
  }
  return CAMPAIGNS[DEFAULT_CAMPAIGN_ID];
}

// El link de Cal.com sale de la campaña del lead. metadata[leadId] es el mecanismo por el
// que calcom-webhook reconoce de quién es la reserva; el email prellenado es el respaldo.
// Estaba duplicado en tres sitios (buildLinks, generate-report, regenerate-email) con la
// URL escrita a mano en cada uno.
export function buildBookingUrl(lead: Pick<LeadItem, 'leadId' | 'email' | 'campaignId'>): string {
  const params = new URLSearchParams({ 'metadata[leadId]': lead.leadId });
  if (lead.email) params.set('email', lead.email);
  return `${getCampaign(lead.campaignId).bookingUrl}?${params.toString()}`;
}

export function activeCampaigns(): CampaignConfig[] {
  return Object.values(CAMPAIGNS).filter((c) => c.active);
}
