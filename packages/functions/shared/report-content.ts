// Generación de email frío + post de LinkedIn a partir del reporte HTML de un lead.
// Extraído de generate-report/index.ts — antes regenerate-email/index.ts tenía su propia
// copia literal de estas dos funciones, y esa duplicación causó un bug real (un fix de
// formato de link se aplicó a una copia y no a la otra). Vive en shared/ como funciones
// puras (todo por parámetro, nada de consts de módulo de un Lambda en particular) para
// que ambos Lambdas puedan importarla sin arrastrar el resto del código de uno al otro
// vía el bundling de esbuild.
import Anthropic from '@anthropic-ai/sdk';
import { getActivePrompt, promptKey, renderPrompt } from './prompt-store';
import { trackedCompletion } from './llm-client';

export async function generateEmail(
  client: Anthropic,
  leadId: string,
  campaignId: string,
  reportHtml: string,
  trackingUrl: string,
  unsubscribeUrl: string,
  bookingUrl: string,
  canSpamAddress: string,
): Promise<{ subject: string; body: string }> {
  const { content: template, version } = await getActivePrompt(campaignId, 'cold-email');
  const prompt = renderPrompt(template, {
    bookingUrl,
    canSpamAddress,
    reportHtml: reportHtml.slice(0, 30000),
  });

  const message = await trackedCompletion(client, {
    promptId: promptKey(campaignId, 'cold-email'),
    promptVersion: version,
    leadId,
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  const text = block.type === 'text' ? block.text : '';

  const subjectMatch = text.match(/^Subject:\s*(.+)/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : '';
  const rawBody = text.replace(/^Subject:.*\n?/, '').trim();
  // Sustitución post-generación — evita gastar tokens en que Claude reproduzca URLs largas
  const body = rawBody
    .replace(/__REPORT_URL__/g, trackingUrl)
    .replace(/__UNSUBSCRIBE_URL__/g, unsubscribeUrl);

  return { subject, body };
}

export async function generateLinkedinPost(client: Anthropic, leadId: string, campaignId: string, reportHtml: string): Promise<string> {
  const { content: template, version } = await getActivePrompt(campaignId, 'linkedin-post');
  const prompt = renderPrompt(template, { reportHtml: reportHtml.slice(0, 30000) });

  const message = await trackedCompletion(client, {
    promptId: promptKey(campaignId, 'linkedin-post'),
    promptVersion: version,
    leadId,
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  return block.type === 'text' ? block.text : '';
}
