import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const ssm = new SSMClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;

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

// ── Short display ID from leadId ──────────────────────────────────────────────
function shortId(leadId: string): string {
  return leadId.replace(/-/g, '').slice(0, 6).toUpperCase();
}

// ── Calendar link ─────────────────────────────────────────────────────────────
function generateCalendarLink(lead: LeadItem): string {
  const followUpDate = new Date((lead.sentAt ?? Date.now()) + 7 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Seguimiento — ${lead.businessName}`,
    dates: `${fmt(followUpDate)}/${fmt(new Date(followUpDate.getTime() + 30 * 60 * 1000))}`,
    details: `Teléfono: ${lead.phone ?? 'no disponible'}\nLeadId: ${lead.leadId}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ── 1. HTML REPORT ────────────────────────────────────────────────────────────

async function generateReportHtml(client: Anthropic, lead: LeadItem): Promise<string> {
  const m = lead.pagespeedMobile;
  const d = lead.pagespeedDesktop;
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

3. ISSUES IDENTIFIED
   Basándote en el análisis técnico siguiente, genera la lista de problemas:

   ${lead.aiWebAnalysis ?? 'No disponible'}

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
  reportUrl: string
): Promise<{ subject: string; body: string }> {
  const prompt = `Se te va a proporcionar el reporte del prospecto como archivo HTML.

Lo primero que tienes que hacer es localizar la sección "Bottom line" del reporte y leerla con atención — ahí está el argumento central que debe guiar todo el email.

Con esa información genera el email con este formato exacto:

Subject: [Extrae el problema más concreto y llamativo del Bottom line y conviértelo en una frase de impacto de menos de 10 palabras que incluya el dominio. Ejemplo: "Your Google Ads are funding a 47/100 site — glasswellservice.com"]

Hi,

I came across [dominio] while researching [sector] businesses in [ciudad].

[Toma el argumento central del Bottom line y conviértelo en 2-3 frases en lenguaje de dueño de negocio. Sin jerga técnica. Debe sonar como alguien que encontró algo importante y quiere compartirlo, no como un vendedor. Este es el párrafo más importante del email — si no resuena aquí, nada de lo que sigue importa.]

Here's what I found specifically:
[3-4 problemas del reporte en viñetas, en lenguaje humano. Prioriza los que refuerzan el argumento del Bottom line. Ejemplo: "Your homepage takes 5 seconds to load on mobile — above the threshold where Google starts penalizing your Ad Quality Score" en lugar de "LCP de 4.2s"]

[Si tiene reseñas o historial notable: "None of this reflects on your reputation — [X stars] and [detalle] speaks for itself."] The issue is purely technical, and it's fixable.

---
I put together a full breakdown here: ${reportUrl}
---

Worth a few minutes? Book a call here...
https://calendly.com/tallerdedigitalizacion-info/free-15-min-website-speed-call

Free 15-min call to find out exactly what's slowing your site down and what it's costing you in ad spend.
No pitch, no commitment. If I don't see a clear problem I can fix, I'll tell you straight.

--
Pablo Leone
Web Infrastructure & WordPress Care
info@tallerdedigitalizacion.com

REGLAS:
- El subject y el primer párrafo tienen que derivar directamente del Bottom line — no de los scores ni de los issues técnicos
- Los problemas en viñetas en lenguaje humano, nunca términos técnicos crudos
- No inventes datos que no estén en el reporte
- Sin introducción ni explicación. Solo el email listo para copiar y enviar

---
REPORTE HTML:
${reportHtml.slice(0, 30000)}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  const text = block.type === 'text' ? block.text : '';

  // Extraer subject y body del texto generado
  const subjectMatch = text.match(/^Subject:\s*(.+)/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : '';
  const body = text.replace(/^Subject:.*\n?/, '').trim();

  return { subject, body };
}

// ── 3. LINKEDIN POST ──────────────────────────────────────────────────────────

async function generateLinkedinPost(
  client: Anthropic,
  reportHtml: string
): Promise<string> {
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

// ── PDF via Puppeteer ─────────────────────────────────────────────────────────

async function htmlToPdf(html: string): Promise<Buffer> {
  const chromium = await import('@sparticuz/chromium');
  const puppeteer = await import('puppeteer-core');

  const browser = await puppeteer.default.launch({
    args: chromium.default.args,
    defaultViewport: chromium.default.defaultViewport,
    executablePath: await chromium.default.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  if (!leadId) return respond(400, { error: 'leadId is required' });

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return respond(404, { error: 'Lead not found' });
  const lead = result.Item as LeadItem;

  if (!['ANALYZED', 'SENT', 'CALLED', 'RESPONDED', 'NO_RESPONSE'].includes(lead.status)) {
    return respond(400, { error: `Lead must be ANALYZED or later. Current: ${lead.status}` });
  }

  const client = await getAnthropicClient();

  // S3 keys
  const htmlKey = `reports/${leadId}/report.html`;
  const pdfKey = `reports/${leadId}/report.pdf`;

  // URL pública del PDF (para el email). Usamos una URL firmada de CloudFront o el endpoint de S3.
  // En MVP usamos la S3 key como referencia — se puede reemplazar por una URL firmada si hace falta.
  const reportUrl = `[URL_REPORTE]`; // se sustituye manualmente o con S3 presigned URL

  // Generar HTML del reporte
  const reportHtml = await generateReportHtml(client, lead);

  // Generar email y LinkedIn en paralelo (ambos usan el HTML del reporte)
  const [emailData, linkedinPost, pdfBuffer] = await Promise.all([
    generateEmail(client, reportHtml, reportUrl),
    generateLinkedinPost(client, reportHtml),
    htmlToPdf(reportHtml),
  ]);

  // Subir a S3
  await Promise.all([
    s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: htmlKey,
      Body: reportHtml,
      ContentType: 'text/html',
    })),
    s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: pdfKey,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
    })),
  ]);

  const now = Date.now();
  const calendarLink = generateCalendarLink(lead);
  const timelineEvent: TimelineEvent = { at: now, event: 'REPORT_GENERATED', by: 'system' };

  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: `SET
      reportHtmlS3Key = :htmlKey,
      reportPdfS3Key = :pdfKey,
      emailSubject = :emailSubject,
      emailBody = :emailBody,
      linkedinPost = :linkedinPost,
      calendarLink = :calendarLink,
      timeline = list_append(timeline, :event)`,
    ExpressionAttributeValues: {
      ':htmlKey': htmlKey,
      ':pdfKey': pdfKey,
      ':emailSubject': emailData.subject,
      ':emailBody': emailData.body,
      ':linkedinPost': linkedinPost,
      ':calendarLink': calendarLink,
      ':event': [timelineEvent],
    },
  }));

  return respond(200, {
    reportHtmlS3Key: htmlKey,
    reportPdfS3Key: pdfKey,
    emailSubject: emailData.subject,
    calendarLink,
  });
};
