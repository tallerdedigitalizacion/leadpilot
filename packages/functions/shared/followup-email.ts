import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem } from './types';
import { signToken } from './tracking';
import { SIGNAL_BOX_FORMAT, emailFooterFormat } from './email-template';
import { getActivePrompt, promptKey, renderPrompt } from './prompt-store';
import { trackedCompletion } from './llm-client';
import { buildBookingUrl } from './campaigns';

// Extraído de followup-sequencer para poder reusarlo también desde simulate-followup
// (botón manual de prueba) sin duplicar el prompt.
export function buildLinks(lead: LeadItem, trackingBaseUrl: string, frontendUrl: string, trackingSecret: string) {
  const token = signToken(lead.leadId, trackingSecret);
  const trackingUrl = `${trackingBaseUrl}/r/${lead.leadId}?t=${token}`;
  const unsubscribeUrl = `${frontendUrl}/unsubscribe/${lead.leadId}?t=${token}`;
  return { trackingUrl, unsubscribeUrl, bookingUrl: buildBookingUrl(lead) };
}

export async function generateFollowupEmail(
  client: Anthropic,
  leadId: string,
  campaignId: string,
  reportHtml: string,
  followupNumber: 1 | 2,
  trackingUrl: string,
  unsubscribeUrl: string,
  bookingUrl: string,
  canSpamAddress: string,
): Promise<{ subject: string; body: string }> {
  const framing = followupNumber === 1
    ? 'Es el PRIMER seguimiento (día 7 sin respuesta al email inicial). Tono: recordatorio breve y de bajo perfil, tipo "por si se te pasó por alto", sin presionar.'
    : 'Es el SEGUNDO y último seguimiento (día 14 sin respuesta). Tono: un poco más directo, reconoce que ya escribiste antes, sin sonar desesperado.';

  const { content: template, version } = await getActivePrompt(campaignId, 'followup-email');
  const prompt = renderPrompt(template, {
    framing,
    signalBoxFormat: SIGNAL_BOX_FORMAT,
    emailFooter: emailFooterFormat({ bookingUrl, canSpamAddress }),
    // Sueltos además del pie ya montado: las plantillas de es-sprint llevan su propio pie
    // escrito dentro (en español y con otra oferta) y necesitan las piezas por separado.
    bookingUrl,
    canSpamAddress,
    reportHtml: reportHtml.slice(0, 30000),
  });

  const message = await trackedCompletion(client, {
    promptId: promptKey(campaignId, 'followup-email'),
    promptVersion: version,
    leadId,
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  const text = block.type === 'text' ? block.text : '';
  const subjectMatch = text.match(/^Subject:\s*(.+)/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : '';
  const rawBody = text.replace(/^Subject:.*\n?/, '').trim();
  const body = rawBody
    .replace(/__REPORT_URL__/g, trackingUrl)
    .replace(/__UNSUBSCRIBE_URL__/g, unsubscribeUrl);
  return { subject, body };
}

// Rama A del seguimiento condicional: el lead ya hizo click en el reporte (está
// ENGAGED). En vez del recordatorio genérico de arriba, referencia un hallazgo concreto
// del análisis — prioriza datos numéricos (tiempo de carga) sobre texto genérico, para
// que el email no termine sonando a "¿viste mi email anterior?".
export function pickEngagedFinding(lead: LeadItem): string {
  const speedIndex = lead.pagespeedMobile?.speedIndex;
  if (speedIndex) return `un tiempo de carga de ${speedIndex.toFixed(1)}s en la versión mobile de la home`;

  const lcp = lead.pagespeedMobile?.lcp;
  if (lcp) return `un Largest Contentful Paint de ${lcp.toFixed(1)}s en mobile`;

  const cwvIssue = lead.webAnalysis?.performanceSummary.coreWebVitalsIssues[0];
  if (cwvIssue) return cwvIssue;

  const topFix = lead.webAnalysis?.top3Fixes[0];
  if (topFix) return topFix;

  return lead.webAnalysis?.headlinePain ?? 'el problema principal identificado en el reporte';
}

export async function generateEngagedFollowupEmail(
  client: Anthropic,
  leadId: string,
  campaignId: string,
  reportHtml: string,
  headlineFinding: string,
  businessName: string,
  trackingUrl: string,
  unsubscribeUrl: string,
  bookingUrl: string,
  canSpamAddress: string,
): Promise<{ subject: string; body: string }> {
  const { content: template, version } = await getActivePrompt(campaignId, 'engaged-followup-email');
  const prompt = renderPrompt(template, {
    businessName,
    headlineFinding,
    signalBoxFormat: SIGNAL_BOX_FORMAT,
    emailFooter: emailFooterFormat({ bookingUrl, canSpamAddress }),
    // Sueltos además del pie ya montado: las plantillas de es-sprint llevan su propio pie
    // escrito dentro (en español y con otra oferta) y necesitan las piezas por separado.
    bookingUrl,
    canSpamAddress,
    reportHtml: reportHtml.slice(0, 30000),
  });

  const message = await trackedCompletion(client, {
    promptId: promptKey(campaignId, 'engaged-followup-email'),
    promptVersion: version,
    leadId,
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  const text = block.type === 'text' ? block.text : '';
  const subjectMatch = text.match(/^Subject:\s*(.+)/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : '';
  const rawBody = text.replace(/^Subject:.*\n?/, '').trim();
  const body = rawBody
    .replace(/__REPORT_URL__/g, trackingUrl)
    .replace(/__UNSUBSCRIBE_URL__/g, unsubscribeUrl);
  return { subject, body };
}
