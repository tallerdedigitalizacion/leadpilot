import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem } from './types';
import { signToken } from './tracking';
import { SIGNAL_BOX_FORMAT, emailFooterFormat } from './email-template';

// Extraído de followup-sequencer para poder reusarlo también desde simulate-followup
// (botón manual de prueba) sin duplicar el prompt.
export function buildLinks(lead: LeadItem, trackingBaseUrl: string, trackingSecret: string) {
  const token = signToken(lead.leadId, trackingSecret);
  const trackingUrl = `${trackingBaseUrl}/r/${lead.leadId}?t=${token}`;
  const unsubscribeUrl = `${trackingBaseUrl}/u/${lead.leadId}?t=${token}`;
  const bookingParams = new URLSearchParams({ 'metadata[leadId]': lead.leadId });
  if (lead.email) bookingParams.set('email', lead.email);
  const bookingUrl = `https://cal.com/taller-de-digitalizacion/30min?${bookingParams.toString()}`;
  return { trackingUrl, unsubscribeUrl, bookingUrl };
}

export async function generateFollowupEmail(
  client: Anthropic,
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

  const prompt = `Se te va a proporcionar el reporte del prospecto como archivo HTML. Ya se le envió un email inicial hace días con este mismo reporte y no ha respondido, hecho clic, ni reservado llamada.

${framing}

Genera un email de SEGUIMIENTO CORTO — la mitad de largo que un email inicial. El asunto en la primera línea como texto plano. El cuerpo en HTML puro con estilos inline, sin <style> ni clases.

Formato exacto:

Subject: [breve, deja claro que es un seguimiento, incluye el dominio]

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Hi,</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">[1-2 frases retomando el argumento del "Bottom line" del reporte, en el tono indicado arriba. No repitas el email inicial palabra por palabra.]</p>

<div style="margin:0 0 16px;">
[1-2 cajas como máximo, solo el/los problema(s) más importante(s), con este formato exacto por caja:
${SIGNAL_BOX_FORMAT}
]
</div>

${emailFooterFormat({ bookingUrl, canSpamAddress })}

REGLAS:
- Máximo 1-2 cajas de problema, el resto del contenido es texto normal
- No inventes datos que no estén en el reporte
- Sin introducción ni explicación. Solo el email listo para enviar
- Todo con estilos inline exactamente como en el formato

---
REPORTE HTML:
${reportHtml.slice(0, 30000)}`;

  const message = await client.messages.create({
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
