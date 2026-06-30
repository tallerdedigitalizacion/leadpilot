// Worker invoked asynchronously by trigger-report Lambda — not via API Gateway
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem, TimelineEvent } from '../shared/types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
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

Con esa información genera el email. El asunto en la primera línea como texto plano. El cuerpo del email en HTML puro (sin etiquetas <html>/<head>/<body>, solo el contenido — usa <p>, <ul>, <li>, <strong>, <a>, <hr>, <br>).

Formato exacto:

Subject: [Extrae el problema más concreto y llamativo del Bottom line y conviértelo en una frase de impacto de menos de 10 palabras que incluya el dominio. Ejemplo: "Your Google Ads are funding a 47/100 site — glasswellservice.com"]

<p>Hi,</p>

<p>I came across [dominio] while researching [sector] businesses in [ciudad].</p>

<p>[Toma el argumento central del Bottom line y conviértelo en 2-3 frases en lenguaje de dueño de negocio. Sin jerga técnica. Debe sonar como alguien que encontró algo importante y quiere compartirlo, no como un vendedor. Este es el párrafo más importante del email — si no resuena aquí, nada de lo que sigue importa.]</p>

<p>Here's what I found specifically:</p>
<ul>
[3-4 problemas del reporte como <li> en lenguaje humano. Prioriza los que refuerzan el argumento del Bottom line. Ejemplo: <li>Your homepage takes 5 seconds to load on mobile — above the threshold where Google starts penalizing your Ad Quality Score</li>]
</ul>

[Si tiene reseñas o historial notable: <p>None of this reflects on your reputation — [X stars] and [detalle] speaks for itself. The issue is purely technical, and it's fixable.</p>]

<hr>
<p>I put together a full breakdown here: <a href="${reportUrl}">Ver análisis completo &rarr;</a></p>
<hr>

<p>Worth 30 minutes? <a href="https://cal.com/taller-de-digitalizacion/30min">Book a free call here</a></p>

<p>Free 30-min call to find out exactly what's slowing your site down and what it's costing you in ad spend.<br>
No pitch, no commitment. If I don't see a clear problem I can fix, I'll tell you straight.</p>

<p>--<br>
Pablo Leone<br>
Web Infrastructure &amp; WordPress Care<br>
info@tallerdedigitalizacion.com</p>

REGLAS:
- El subject y el primer párrafo tienen que derivar directamente del Bottom line — no de los scores ni de los issues técnicos
- Los problemas en viñetas en lenguaje humano, nunca términos técnicos crudos
- No inventes datos que no estén en el reporte
- Sin introducción ni explicación. Solo el email listo para copiar y enviar
- El cuerpo debe ser HTML válido que se pueda pegar directamente en Zoho Mail en modo HTML

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

  const subjectMatch = text.match(/^Subject:\s*(.+)/m);
  const subject = subjectMatch ? subjectMatch[1].trim() : '';
  const body = text.replace(/^Subject:.*\n?/, '').trim();

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

    // Generar email y LinkedIn en paralelo
    const [emailData, linkedinPost] = await Promise.all([
      generateEmail(client, reportHtml, reportUrl),
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
