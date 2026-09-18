// Espejo manual de packages/functions/shared/campaigns.ts, que es la fuente de verdad —
// igual que types/lead.ts es espejo de shared/types.ts. Solo hace falta lo que la UI
// muestra; si se añade una campaña allí, añadirla aquí también.
//
// Un campaignId que el backend no conozca no rompe nada: scrape-jobs lo sustituye por la
// campaña por defecto en vez de devolver 400.
export const CAMPAIGNS = [
  { id: 'us-webaudit', label: 'Auditoría web — EEUU' },
  { id: 'es-sprint', label: 'Sprint de Automatización — España' },
] as const;

export type CampaignId = (typeof CAMPAIGNS)[number]['id'];
export const DEFAULT_CAMPAIGN_ID: CampaignId = 'us-webaudit';
