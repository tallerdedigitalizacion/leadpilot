import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';
import type { LeadItem } from '../shared/types';

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
  reportUrl: string,
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
[3-4 problemas del reporte como <li> en lenguaje humano. Prioriza los que refuerzan el argumento del Bottom line.]
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
- El subject y el primer párrafo tienen que derivar directamente del Bottom line
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

  const [emailData, linkedinPost] = await Promise.all([
    generateEmail(client, reportHtml, lead.reportUrl ?? ''),
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
