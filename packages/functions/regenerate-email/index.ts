import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem } from '../shared/types';
import { signToken } from '../shared/tracking';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ssm = new SSMClient({});
const TABLE = process.env.LEADS_TABLE_NAME!;
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const TRACKING_BASE_URL = process.env.TRACKING_BASE_URL ?? '';
const CAN_SPAM_ADDRESS = process.env.CAN_SPAM_ADDRESS ?? '[dirección física pendiente]';

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

function respond(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ── Email generation (same prompts as generate-report) ────────────────────────

async function generateEmail(
  client: Anthropic,
  reportHtml: string,
  trackingUrl: string,
  unsubscribeUrl: string,
  bookingUrl: string,
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
- El subject y el primer párrafo argumental tienen que derivar directamente del Bottom line, y no van en caja aparte, van como párrafo normal
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
  const body = rawBody
    .replace(/__REPORT_URL__/g, trackingUrl)
    .replace(/__UNSUBSCRIBE_URL__/g, unsubscribeUrl);
  return { subject, body };
}

async function generateLinkedinPost(client: Anthropic, reportHtml: string): Promise<string> {
  const prompt = `Se te va a proporcionar el reporte del prospecto como archivo HTML.
Con esa información genera un post de LinkedIn con estas reglas:

TONO:
- Primera persona, directo, sin corporativo
- Como alguien que comparte lo que encontró, no como vendedor
- En inglés

ESTRUCTURA:
Primera línea (el hook): Una frase que genere curiosidad o sorpresa basada en el dato más llamativo del análisis.
No uses "I" como primera palabra — LinkedIn penaliza el alcance.

Párrafo 2 — el contexto: 2-3 frases explicando qué significa ese dato para el negocio. Sin jerga técnica.

Párrafo 3 — lo que encontré: 3-4 bullets con los problemas principales. En lenguaje humano. Cada bullet una línea.

Párrafo 4 — el punto: 2 frases sobre lo que esto le cuesta al negocio en términos reales.

Cierre: Una pregunta o afirmación que invite a reflexionar.

Hashtags al final — máximo 4: Usa siempre #WebPerformance #LocalBusiness #GoogleAds y uno específico de la plataforma.

REGLAS:
- No menciones el nombre del negocio ni datos que lo identifiquen
- No menciones tu servicio ni hagas pitch directo
- Máximo 1200 caracteres en total
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

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const leadId = event.pathParameters?.leadId;
  if (!leadId) return respond(400, { error: 'leadId is required' });

  const result = await ddb.send(new GetCommand({ TableName: TABLE, Key: { leadId } }));
  if (!result.Item) return respond(404, { error: 'Lead not found' });
  const lead = result.Item as LeadItem;

  if (!lead.reportHtmlS3Key) {
    return respond(400, { error: 'Genera el reporte primero antes de regenerar el email' });
  }

  // Fetch the current report HTML from S3
  const s3Result = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: lead.reportHtmlS3Key }));
  const reportHtml = await s3Result.Body?.transformToString() ?? '';

  const client = await getAnthropicClient();

  const secret = await getTrackingSecret();
  const token = signToken(leadId, secret);
  const trackingUrl = `${TRACKING_BASE_URL}/r/${leadId}?t=${token}`;
  const unsubscribeUrl = `${TRACKING_BASE_URL}/u/${leadId}?t=${token}`;

  const bookingParams = new URLSearchParams({ 'metadata[leadId]': leadId });
  if (lead.email) bookingParams.set('email', lead.email);
  const bookingUrl = `https://cal.com/taller-de-digitalizacion/30min?${bookingParams.toString()}`;

  const [emailData, linkedinPost] = await Promise.all([
    generateEmail(client, reportHtml, trackingUrl, unsubscribeUrl, bookingUrl),
    generateLinkedinPost(client, reportHtml),
  ]);

  const updated = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { leadId },
    UpdateExpression: 'SET emailSubject = :subject, emailBody = :body, linkedinPost = :linkedin',
    ExpressionAttributeValues: {
      ':subject': emailData.subject,
      ':body': emailData.body,
      ':linkedin': linkedinPost,
    },
    ReturnValues: 'ALL_NEW',
  }));

  return respond(200, updated.Attributes);
};
