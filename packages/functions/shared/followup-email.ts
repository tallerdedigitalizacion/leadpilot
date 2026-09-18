import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem } from './types';
import { signToken } from './tracking';
import { SIGNAL_BOX_FORMAT, emailFooterFormat } from './email-template';
import { getActivePrompt, renderPrompt } from './prompt-store';
import { trackedCompletion } from './llm-client';

// Extraído de followup-sequencer para poder reusarlo también desde simulate-followup
// (botón manual de prueba) sin duplicar el prompt.
export function buildLinks(lead: LeadItem, trackingBaseUrl: string, frontendUrl: string, trackingSecret: string) {
  const token = signToken(lead.leadId, trackingSecret);
  const trackingUrl = `${trackingBaseUrl}/r/${lead.leadId}?t=${token}`;
  const unsubscribeUrl = `${frontendUrl}/unsubscribe/${lead.leadId}?t=${token}`;
  const bookingParams = new URLSearchParams({ 'metadata[leadId]': lead.leadId });
  if (lead.email) bookingParams.set('email', lead.email);
  const bookingUrl = `https://cal.com/taller-de-digitalizacion/30min?${bookingParams.toString()}`;
  return { trackingUrl, unsubscribeUrl, bookingUrl };
}

export async function generateFollowupEmail(
  client: Anthropic,
  leadId: string,
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

  const { content: template, version } = await getActivePrompt('followup-email');
  const prompt = renderPrompt(template, {
    framing,
    signalBoxFormat: SIGNAL_BOX_FORMAT,
    emailFooter: emailFooterFormat({ bookingUrl, canSpamAddress }),
    reportHtml: reportHtml.slice(0, 30000),
  });

  const message = await trackedCompletion(client, {
    promptId: 'followup-email',
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
