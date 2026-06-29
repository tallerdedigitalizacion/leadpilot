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

function generateCalendarLink(lead: LeadItem): string {
  const followUpDate = new Date((lead.sentAt ?? Date.now()) + 7 * 24 * 60 * 60 * 1000);
  const formatDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const start = formatDate(followUpDate);
  const end = formatDate(new Date(followUpDate.getTime() + 30 * 60 * 1000));
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Seguimiento — ${lead.businessName}`,
    dates: `${start}/${end}`,
    details: `Llamada de seguimiento al email enviado.\n\nFicha del lead: leadId=${lead.leadId}\n\nTeléfono: ${lead.phone ?? 'no disponible'}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

async function generateReportHtml(client: Anthropic, lead: LeadItem): Promise<string> {
  const mobile = lead.pagespeedMobile;
  const desktop = lead.pagespeedDesktop;

  const prompt = `Genera un reporte profesional en HTML para enviar a un cliente potencial.

Datos del negocio:
- Nombre: ${lead.businessName}
- Web: ${lead.url}
- Ciudad: ${lead.city ?? 'EEUU'}

Scores PageSpeed:
- Mobile: Performance ${mobile?.performance ?? 'N/A'}/100, SEO ${mobile?.seo ?? 'N/A'}/100, Accesibilidad ${mobile?.accessibility ?? 'N/A'}/100
- Desktop: Performance ${desktop?.performance ?? 'N/A'}/100, SEO ${desktop?.seo ?? 'N/A'}/100

Análisis web:
${lead.aiWebAnalysis ?? 'No disponible'}

Notas personales del consultor:
${lead.myNotes ?? 'Sin notas adicionales'}

Genera un HTML completo y auto-contenido (CSS inline) con:
1. Cabecera con nombre del negocio y fecha
2. Resumen ejecutivo (2-3 frases, orientado al dueño del negocio, no técnico)
3. Tabla de scores visuales (barras de progreso en CSS)
4. Problemas identificados (con impacto en negocio, no jerga técnica)
5. Propuesta de valor: qué mejorarías tú y qué resultado esperaría
6. CTA: "Respondiendo a este email podemos agendar una llamada de 15 minutos sin compromiso"

Estilo: profesional pero cercano. Colores: azul oscuro (#1e3a5f) y blanco. Sin jerga técnica.
Devuelve SOLO el HTML, sin explicaciones.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  const block = message.content[0];
  return block.type === 'text' ? block.text : '';
}

async function generateEmailAndPost(
  client: Anthropic,
  lead: LeadItem,
  mainProblem: string
): Promise<{ subject: string; body: string; linkedinPost: string }> {
  const [emailResult, postResult] = await Promise.all([
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Escribe un email frío en inglés para el dueño de este negocio local.

Negocio: ${lead.businessName} (${lead.city ?? 'EEUU'})
Web actual: ${lead.url}
Problema principal detectado: ${mainProblem}

Reglas:
- Asunto: máximo 8 palabras, personalizado, no genérico
- Cuerpo: máximo 5 líneas
- Tono: directo, como si fuera de persona a persona, no de agencia
- Menciona UN problema específico que viste en su web (no dos, uno)
- CTA: que respondan si quieren ver el análisis completo adjunto
- No uses palabras como "leverage", "synergy", "solutions"
- Firma: Pablo — Web Consultant

Devuelve JSON con esta estructura exacta:
{"subject": "...", "body": "..."}`,
      }],
    }),
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Escribe un post de LinkedIn en español basado en este caso de análisis web.

Negocio analizado: ${lead.category ?? 'negocio local'} en ${lead.city ?? 'EEUU'} (no menciones el nombre real)
Problema principal: ${mainProblem}
Dato de PageSpeed mobile: ${lead.pagespeedMobile?.performance ?? 'N/A'}/100

Estructura:
- Línea de gancho (sin "¿Sabías que...?")
- 3-4 líneas con el hallazgo concreto
- Reflexión o aprendizaje para otros negocios
- 3-5 hashtags relevantes

Tono: experto pero accesible. Primera persona. Máximo 200 palabras.
Devuelve solo el texto del post, sin comillas ni explicaciones.`,
      }],
    }),
  ]);

  const emailBlock = emailResult.content[0];
  const emailText = emailBlock.type === 'text' ? emailBlock.text : '{}';
  let emailData = { subject: '', body: '' };
  try {
    emailData = JSON.parse(emailText);
  } catch {
    // Si Claude no devuelve JSON limpio, intenta extraer
    const match = emailText.match(/\{[\s\S]*\}/);
    if (match) emailData = JSON.parse(match[0]);
  }

  const postBlock = postResult.content[0];
  const linkedinPost = postBlock.type === 'text' ? postBlock.text : '';

  return { subject: emailData.subject, body: emailData.body, linkedinPost };
}

async function htmlToPdf(html: string): Promise<Buffer> {
  // Dynamic imports para evitar errores si el módulo no está disponible localmente
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
      margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

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
    return respond(400, { error: `Lead must be in ANALYZED status, current: ${lead.status}` });
  }

  const client = await getAnthropicClient();

  // Extraer problema principal del análisis para usarlo en email y post
  const mainProblem = lead.aiWebAnalysis
    ? lead.aiWebAnalysis.split('## Problemas críticos')[1]?.split('##')[0]?.trim().split('\n')[0]?.replace(/^[-*]\s*/, '') ?? 'Poor mobile performance'
    : 'Poor mobile performance and slow load times';

  const [reportHtml, emailAndPost] = await Promise.all([
    generateReportHtml(client, lead),
    generateEmailAndPost(client, lead, mainProblem),
  ]);

  const pdfBuffer = await htmlToPdf(reportHtml);

  const htmlKey = `reports/${leadId}/report.html`;
  const pdfKey = `reports/${leadId}/report.pdf`;

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
      ':emailSubject': emailAndPost.subject,
      ':emailBody': emailAndPost.body,
      ':linkedinPost': emailAndPost.linkedinPost,
      ':calendarLink': calendarLink,
      ':event': [timelineEvent],
    },
  }));

  return respond(200, {
    reportHtmlS3Key: htmlKey,
    reportPdfS3Key: pdfKey,
    emailSubject: emailAndPost.subject,
    calendarLink,
  });
};
