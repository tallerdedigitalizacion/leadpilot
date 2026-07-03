// Worker invoked asynchronously by trigger-report Lambda — not via API Gateway
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SESClient } from '@aws-sdk/client-ses';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem, TimelineEvent } from '../shared/types';
import { signToken } from '../shared/tracking';
import { sendLeadEmail } from '../shared/send-lead-email';
import { publishToLinkedin } from '../shared/buffer';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ssm = new SSMClient({});
const ses = new SESClient({ region: process.env.SES_REGION ?? 'us-east-1' });
const TABLE = process.env.LEADS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const TRACKING_BASE_URL = process.env.TRACKING_BASE_URL ?? '';
const CAN_SPAM_ADDRESS = process.env.CAN_SPAM_ADDRESS ?? '[dirección física pendiente]';
const FROM_EMAIL = process.env.SES_FROM_EMAIL!;

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

let trackingSecret: string | null = null;

async function getTrackingSecret(): Promise<string> {
  if (trackingSecret) return trackingSecret;
  const result = await ssm.send(new GetParameterCommand({
    Name: process.env.TRACKING_SECRET_PARAM!,
    WithDecryption: true,
  }));
  trackingSecret = result.Parameter!.Value!;
  return trackingSecret;
}

function shortId(leadId: string): string {
  return leadId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

function generateCalendarLink(lead: LeadItem): string {
  const followUpDate = new Date((lead.sentAt ?? Date.now()) + 7 * 24 * 60 * 60 * 1000);
  // All-day event: YYYYMMDD format, end = next day
  const fmtDay = (d: Date) => d.toISOString().split('T')[0].replace(/-/g, '');
  const endDate = new Date(followUpDate.getTime() + 24 * 60 * 60 * 1000);
  const frontendUrl = process.env.FRONTEND_URL ?? '';
  const details = [
    frontendUrl ? `LeadPilot: ${frontendUrl}/leads/${lead.leadId}` : '',
    lead.phone ? `Tel: ${lead.phone}` : '',
    lead.url ? `Web: ${lead.url}` : '',
  ].filter(Boolean).join('\n');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Seguimiento — ${lead.businessName}`,
    dates: `${fmtDay(followUpDate)}/${fmtDay(endDate)}`,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ── 1. HTML REPORT ────────────────────────────────────────────────────────────

function serializeWebAnalysis(lead: LeadItem): string {
  const wa = lead.webAnalysis;
  if (!wa) return 'No disponible';
  return [
    `Dolor principal: ${wa.headlinePain}`,
    `Evaluación visual: ${wa.visualAssessment}`,
    `Core Web Vitals — problemas: ${wa.performanceSummary.coreWebVitalsIssues.join('; ') || 'ninguno detectado'}`,
    `Cumplimiento/cookies: ${wa.complianceFlag}`,
    `Top 3 fixes priorizados: ${wa.top3Fixes.map((f, i) => `${i + 1}. ${f}`).join(' ')}`,
    `Gancho de cierre: ${wa.closingHook}`,
  ].join('\n');
}

async function generateReportHtml(client: Anthropic, lead: LeadItem): Promise<string> {
  const m = lead.pagespeedMobile;
  const d = lead.pagespeedDesktop;
  const mRaw = lead.pagespeedMobileRaw;
  const dRaw = lead.pagespeedDesktopRaw;
  const id = shortId(lead.leadId);
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const prompt = `Se te van a proporcionar los datos del prospecto directamente en este mensaje.

Con los datos que recibes genera un archivo HTML con el reporte del prospecto siguiendo este diseño exacto:

ESTRUCTURA DEL HTML:
- Fondo blanco, fuente Arial, tamaño 13px, max-width 680px centrado
- Sin estilos externos, todo inline o en un bloque <style> en el <head>

SECCIONES EN ORDEN:

1. HEADER
   - Etiqueta pequeña: "Prospect Report · #${id}"
   - Nombre del negocio en 22px bold
   - Web y ciudad en gris debajo
   - Tags de colores: ${lead.category ? `${lead.category} (verde)` : ''} / ${m?.performance !== undefined && m.performance > 0 ? 'Paying Google Ads (azul)' : ''}
   - Badges a la derecha con los scores:
     Performance en rojo si <50, naranja si 50-89, verde si 90+
     SEO y Best Practices igual

2. PERFORMANCE SCORES
   Título de sección en mayúsculas pequeñas gris
   4 metric cards en grid 2x2 con fondo gris claro:
   - Performance: ${m?.performance ?? 'N/A'}/100
   - LCP: ${m?.lcp !== undefined ? m.lcp + 's' : 'N/A'} (target: <2.5s)
   - TBT: ${m?.tbt !== undefined ? m.tbt + 'ms' : 'N/A'} (target: <200ms)
   - Speed Index: ${m?.speedIndex !== undefined ? m.speedIndex + 's' : 'N/A'} (target: <3.4s)
   Cada card: label pequeño, valor grande en color (rojo/naranja/verde), subtítulo con el target

   Barras de progreso horizontales para:
   - Performance: ${m?.performance ?? 'N/A'}/100
   - Accessibility: ${m?.accessibility ?? 'N/A'}/100
   - SEO: ${m?.seo ?? 'N/A'}/100
   - Best Practices: ${m?.bestPractices ?? 'N/A'}/100
   (Desktop: Performance ${d?.performance ?? 'N/A'}, SEO ${d?.seo ?? 'N/A'})
   Cada barra: label a la izquierda, valor a la derecha en color, barra de fondo gris con relleno en color proporcional al score

   ${mRaw ? `PageSpeed Mobile — datos completos pegados por el consultor:\n${mRaw}` : ''}
   ${dRaw ? `PageSpeed Desktop — datos completos pegados por el consultor:\n${dRaw}` : ''}

3. ISSUES IDENTIFIED
   Basándote en el análisis técnico siguiente, genera la lista de problemas:

   ${serializeWebAnalysis(lead)}

   ${lead.myNotes ? `Notas del consultor: ${lead.myNotes}` : ''}

   Cada problema con:
   - Punto de color (rojo = crítico, naranja = importante)
   - Título en bold
   - Descripción en gris
   - Estimación de impacto si aplica

4. BUSINESS SIGNALS
   Grid 2 columnas con señales del negocio extraídas del análisis:
   - Negocio: ${lead.businessName}
   - Ciudad: ${lead.city ?? 'N/A'}
   - Categoría: ${lead.category ?? 'N/A'}
   - Teléfono: ${lead.phone ?? 'N/A'}
   - Web: ${lead.url}
   Incluye también lo que detectaste en el análisis (reseñas, redes sociales, años operando)

5. OPPORTUNITY FRAMING
   Caja con borde gris y fondo muy claro
   Título: "Bottom line"
   2-3 frases explicando por qué este negocio necesita ayuda y cuál es el coste real de no actuar.
   Menciona explícitamente los anuncios y la velocidad del sitio.
   Basate en el "Dolor principal" del análisis técnico.

6. CONTACT
   Email: ${lead.email ?? 'No disponible'} / Teléfono: ${lead.phone ?? 'No disponible'}

7. FOOTER
   Izquierda: "Prospect #${id} · Analysis date: ${date}"
   Derecha: "Taller de Digitalización"

COLORES DE REFERENCIA:
- Rojo: #c0392b — para scores <50 y problemas críticos
- Naranja: #e67e22 — para scores 50-89 y problemas importantes
- Verde: #27ae60 — para scores 90+ y señales positivas
- Gris oscuro: #1a1a1a — texto principal
- Gris medio: #666 — texto secundario
- Gris claro: #f7f7f7 — fondos de cards

Devuelve SOLO el HTML completo y auto-contenido, sin explicaciones ni markdown.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  return block.type === 'text' ? block.text : '';
}

// ── 2. EMAIL ──────────────────────────────────────────────────────────────────

async function generateEmail(
  client: Anthropic,
  reportHtml: string,
  trackingUrl: string,
  unsubscribeUrl: string,
  bookingUrl: string
): Promise<{ subject: string; body: string }> {
  const prompt = `Se te va a proporcionar el reporte del prospecto como archivo HTML.

Lo primero que tienes que hacer es localizar la sección "Bottom line" del reporte y leerla con atención — ahí está el argumento central que debe guiar todo el email.

Con esa información genera el email. El asunto en la primera línea como texto plano. El cuerpo del email en HTML puro (sin etiquetas <html>/<head>/<body>, solo el contenido, con estilos inline para que se vea igual en cualquier cliente de correo — no uses <style> ni clases CSS).

Formato exacto (respeta también los estilos inline tal cual):

Subject: [Extrae el problema más concreto y llamativo del Bottom line y conviértelo en una frase de impacto de menos de 10 palabras que incluya el dominio. Ejemplo: "Your Google Ads are funding a 47/100 site — glasswellservice.com"]

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Hi,</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">I came across [dominio] while researching [sector] businesses in [ciudad].</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">[Toma el argumento central del Bottom line y conviértelo en 2-4 frases en lenguaje de dueño de negocio, terminando en el coste real para el negocio (dinero, leads, tiempo). Sin jerga técnica. Debe sonar como alguien que encontró algo importante y quiere compartirlo, no como un vendedor. Este es el párrafo más importante del email — si no resuena aquí, nada de lo que sigue importa. NO metas esto en una caja aparte, va como texto normal.]</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:10px;">Here's what I found specifically:</p>

<div style="margin:0 0 20px;">
[3-4 problemas del reporte, cada uno en su propia caja con este formato exacto — sin <ul>/<li>. Prioriza los que refuerzan el argumento del Bottom line. Frases completas en lenguaje humano, sin jerga técnica cruda:
<div style="display:flex;gap:12px;padding:11px 14px;background:#F8F8F7;border-left:2px solid #C0392B;margin-bottom:6px;">
<span style="color:#C0392B;font-size:13px;flex-shrink:0;line-height:1.65;">&rarr;</span>
<span style="font-size:13.5px;line-height:1.6;color:#1A1A1A;">[problema en frase completa]</span>
</div>
]
</div>

[Si tiene reseñas o historial notable: <p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">None of this reflects on your reputation — [X stars] and [detalle] speaks for itself. The issue is purely technical, and it's fixable.</p>]

<div style="text-align:center;margin:22px 0;">
<a href="__REPORT_URL__" style="display:inline-block;background:#1A1A1A;color:#ffffff;text-decoration:none;font-size:13.5px;font-weight:700;padding:11px 22px;border-radius:3px;">See full breakdown &rarr;</a>
<p style="font-size:12px;color:#999999;margin-top:10px;margin-bottom:0;">Full analysis with scores, priorities and screenshots</p>
</div>

<hr style="border:none;border-top:1px solid #EBEBEA;margin:22px 0;">

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Worth 30 minutes? <a href="${bookingUrl}" style="color:#4338CA;">Book a free call here</a></p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Free 30-min call to find out exactly what's slowing your site down and what it's costing you in ad spend.<br>
No pitch, no commitment. If I don't see a clear problem I can fix, I'll tell you straight.</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Or learn more about the <a href="https://tallerdedigitalizacion.com/en/web-audit/" style="color:#4338CA;">Web Audit service &rarr;</a></p>

<hr style="border:none;border-top:1px solid #EBEBEA;margin:22px 0;">

<div style="font-size:13px;color:#555555;line-height:1.8;">
&mdash;<br>
Pablo Leone<br>
Web Infrastructure &amp; WordPress Care<br>
<a href="https://tallerdedigitalizacion.com/en/web-audit/" style="color:#4338CA;text-decoration:none;">tallerdedigitalizacion.com/en/web-audit</a><br>
info@tallerdedigitalizacion.com
</div>

<p style="font-size:11px;color:#999999;margin-top:14px;">
${CAN_SPAM_ADDRESS}<br>
<a href="__UNSUBSCRIBE_URL__" style="color:#999999;">Unsubscribe</a>
</p>

REGLAS:
- El subject y el primer párrafo argumental tienen que derivar directamente del Bottom line — no de los scores ni de los issues técnicos, y no van en caja aparte, van como párrafo normal
- Cada problema va en su propia caja con el formato exacto indicado, en lenguaje humano, nunca términos técnicos crudos
- No inventes datos que no estén en el reporte
- Sin introducción ni explicación. Solo el email listo para copiar y enviar
- Todo con estilos inline exactamente como en el formato — nada de <style> ni clases, para que se vea igual al pegarlo en Zoho Mail o al enviarse por SES

---
REPORTE HTML:
${reportHtml.slice(0, 30000)}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  const text = block.type === 'text' ? block.text : '';

  const subjectMatch = text.match(/^Subject:\s*(.+)/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : '';
  const rawBody = text.replace(/^Subject:.*\n?/, '').trim();
  // Substitute placeholders after generation — avoids Claude wasting tokens reproducing long URLs
  const body = rawBody
    .replace(/__REPORT_URL__/g, trackingUrl)
    .replace(/__UNSUBSCRIBE_URL__/g, unsubscribeUrl);

  return { subject, body };
}

// ── 3. LINKEDIN POST ──────────────────────────────────────────────────────────

async function generateLinkedinPost(client: Anthropic, reportHtml: string): Promise<string> {
  const prompt = `Se te va a proporcionar el reporte del prospecto como archivo HTML.
Con esa información genera un post de LinkedIn con estas reglas:

TONO:
- Primera persona, directo, sin corporativo
- Como alguien que comparte lo que encontró, no como vendedor
- En inglés

ESTRUCTURA:
Primera línea (el hook — lo más importante):
Una frase que genere curiosidad o sorpresa basada en el dato más llamativo del análisis. Ejemplos del estilo:
"I analyzed a [sector] business in [ciudad] paying for Google Ads. Their site loads in [X] seconds."
"This [sector] in [ciudad] is paying for Google Ads and sending visitors to a [score]/100 performance site."
No uses "I" como primera palabra — LinkedIn penaliza el alcance.

Párrafo 2 — el contexto:
2-3 frases explicando qué significa ese dato para el negocio.
Sin jerga técnica. En términos de dinero y clientes perdidos.

Párrafo 3 — lo que encontré:
3-4 bullets con los problemas principales del reporte.
En lenguaje humano, no técnico.
Cada bullet una línea.

Párrafo 4 — el punto:
2 frases sobre lo que esto le cuesta al negocio en términos reales.
Conecta velocidad del sitio con coste de los anuncios.

Cierre:
Una pregunta o afirmación que invite a reflexionar.
Algo del estilo: "If you're paying for ads, your site speed is part of your ad budget."

Hashtags al final — máximo 4:
Usa siempre: #WebPerformance #LocalBusiness #GoogleAds
El cuarto hashtag debe reflejar la plataforma real del negocio según el reporte (por ejemplo: #Squarespace, #Wix, #WordPressSpeed). Si la plataforma no está identificada, usa #SiteSpeed.

REGLAS:
- No menciones el nombre del negocio ni datos que lo identifiquen
- No menciones tu servicio ni hagas pitch directo
- Máximo 1200 caracteres en total
- Sin emojis excepto en los bullets donde puedes usar → o —
- Sin introducción ni explicación. Solo el post listo para copiar y publicar

---
REPORTE HTML:
${reportHtml.slice(0, 30000)}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  return block.type === 'text' ? block.text : '';
}

// ── Handler (direct invocation, not HTTP) ─────────────────────────────────────

export const handler = async (event: { leadId: string }): Promise<void> => {
  const { leadId } = event;

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) throw new Error(`Lead ${leadId} not found`);
  const lead = result.Item as LeadItem;

  const client = await getAnthropicClient();
  const htmlKey = `reports/${leadId}/report.html`;

  try {
    // Generar HTML del reporte
    const reportHtml = await generateReportHtml(client, lead);

    // Subir HTML a S3
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: htmlKey,
      Body: reportHtml,
      ContentType: 'text/html',
    }));

    // Generar presigned URL (7 días)
    const reportUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: htmlKey }),
      { expiresIn: 7 * 24 * 60 * 60 }
    );

    // El link que va en el email apunta al redirect de tracking, no a la URL presigned cruda
    const secret = await getTrackingSecret();
    const token = signToken(leadId, secret);
    const trackingUrl = `${TRACKING_BASE_URL}/r/${leadId}?t=${token}`;
    const unsubscribeUrl = `${TRACKING_BASE_URL}/u/${leadId}?t=${token}`;

    // metadata[leadId] es el mecanismo primario para que el webhook de Cal.com identifique el
    // lead; el email prefilled es un respaldo (el prefill de email/nombre es una función estable
    // de Cal.com, a diferencia del metadata en query params que tiene reportes de bugs)
    const bookingParams = new URLSearchParams({ 'metadata[leadId]': leadId });
    if (lead.email) bookingParams.set('email', lead.email);
    const bookingUrl = `https://cal.com/taller-de-digitalizacion/30min?${bookingParams.toString()}`;

    // Generar email y LinkedIn en paralelo
    const [emailData, linkedinPost] = await Promise.all([
      generateEmail(client, reportHtml, trackingUrl, unsubscribeUrl, bookingUrl),
      generateLinkedinPost(client, reportHtml),
    ]);

    const now = Date.now();
    const calendarLink = generateCalendarLink(lead);
    const timelineEvent: TimelineEvent = { at: now, event: 'REPORT_GENERATED', by: 'system' };

    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: `SET
        reportHtmlS3Key = :htmlKey,
        reportUrl = :reportUrl,
        emailSubject = :emailSubject,
        emailBody = :emailBody,
        linkedinPost = :linkedinPost,
        calendarLink = :calendarLink,
        isGeneratingReport = :false,
        timeline = list_append(timeline, :event)`,
      ExpressionAttributeValues: {
        ':htmlKey': htmlKey,
        ':reportUrl': reportUrl,
        ':emailSubject': emailData.subject,
        ':emailBody': emailData.body,
        ':linkedinPost': linkedinPost,
        ':calendarLink': calendarLink,
        ':false': false,
        ':event': [timelineEvent],
      },
    }));

    // El reporte y el email ya están listos — se intenta el envío automático de una vez,
    // sin esperar a que alguien apriete "Enviar" en la UI. Si el freno diario ya se gastó,
    // el lead se queda en ANALYZED y lo recoge el barrido de followup-sequencer más tarde.
    const outcome = await sendLeadEmail(
      { ddb, ses, ssm, leadsTable: TABLE, countersTable: process.env.SEND_COUNTERS_TABLE_NAME!, fromEmail: FROM_EMAIL, dailyCapParam: process.env.SHARED_DAILY_CAP_PARAM! },
      { ...lead, emailSubject: emailData.subject, emailBody: emailData.body },
      { checkCap: true },
    );
    if (!outcome.ok) {
      console.log(`generate-report: auto-envío pospuesto para ${leadId}: ${outcome.reason}`);
    }

    // Publicación en LinkedIn independiente del email — uno puede fallar sin bloquear al otro.
    const linkedinOutcome = await publishToLinkedin(
      { ddb, ssm, leadsTable: TABLE, countersTable: process.env.SEND_COUNTERS_TABLE_NAME!, bufferApiKeyParam: process.env.BUFFER_API_KEY_PARAM!, channelId: process.env.BUFFER_LINKEDIN_CHANNEL_ID!, dailyCapParam: process.env.LINKEDIN_DAILY_CAP_PARAM! },
      { ...lead, linkedinPost },
      { checkCap: true },
    );
    if (!linkedinOutcome.ok) {
      console.log(`generate-report: publicación en LinkedIn pospuesta/fallida para ${leadId}: ${linkedinOutcome.reason} ${linkedinOutcome.error ?? ''}`);
    }
  } catch (err) {
    console.error('generate-report failed:', err);
    // Always clear the generating flag so UI doesn't stay stuck
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { leadId },
      UpdateExpression: 'SET isGeneratingReport = :false',
      ExpressionAttributeValues: { ':false': false },
    })).catch(() => {});
    throw err;
  }
};
