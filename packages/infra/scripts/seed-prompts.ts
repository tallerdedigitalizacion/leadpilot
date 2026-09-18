// Script de seed, corrida única y manual: npx ts-node scripts/seed-prompts.ts (desde
// packages/infra). Carga la versión "000001" + puntero ACTIVE de los 5 prompts de
// LeadPilot en leadpilot-prompts. Idempotente: si ya existe un ACTIVE para un promptId,
// lo saltea y loguea — usar --force para re-seedear a propósito.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

// La cuenta local por defecto apunta a eu-west-1 (SES) — el stack de LeadPilot en sí
// (DynamoDB incluido) vive en us-east-1, hay que forzarlo explícitamente.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const TABLE = process.argv.find((a) => a.startsWith('--table='))?.split('=')[1] ?? 'leadpilot-prompts';
const FORCE = process.argv.includes('--force');
// --campaign=es-sprint para sembrar una sola campaña sin tocar las demás.
const ONLY_CAMPAIGN = process.argv.find((a) => a.startsWith('--campaign='))?.split('=')[1];

interface PromptSeed {
  promptId: string;
  content: string;
  systemPrompt?: string;
}

const VISION_SYSTEM_PROMPT = `Eres un consultor senior de marketing digital y desarrollo web que audita sitios de pequeños y medianos negocios para un servicio de prospección B2B. NUNCA asumas que el negocio paga por publicidad (Google/Meta Ads u otra) — no hay forma fiable de saberlo. El ángulo del reporte debe conectar los problemas técnicos y visuales del sitio con su impacto real en el negocio: visitantes perdidos, conversión, profesionalidad percibida — no con gasto publicitario.

REGLAS DE EVIDENCIA (obligatorias):
- Cada afirmación debe estar anclada en un dato concreto de los inputs: cita la cifra exacta de PageSpeed o describe lo que ves literalmente en la captura.
- Nunca inventes funcionalidades, cifras o problemas que no puedas verificar con los datos entregados.
- Si un dato no está disponible, dilo explícitamente en vez de asumir o rellenar.
- Cero relleno genérico tipo "en la era digital de hoy..." o superlativos vacíos ("increíble", "espectacular").
- Tono consultivo y directo, como un experto que ya miró el sitio, no como una plantilla de marketing.
- Máximo 250 palabras combinando todos los campos de texto.

Responde ÚNICAMENTE con este JSON, sin texto antes ni después, sin backticks de markdown:
{
  "headline_pain": "",
  "visual_assessment": "",
  "performance_summary": { "mobile_score": 0, "desktop_score": 0, "core_web_vitals_issues": [] },
  "compliance_flag": "",
  "top_3_fixes": [],
  "closing_hook": ""
}`;

const VISION_USER_TEMPLATE = `Analiza el sitio web de {{businessName}}, categoría {{category}}, ubicado en {{city}}.

Datos PageSpeed Insights (móvil): {{pagespeedMobile}}
Datos PageSpeed Insights (escritorio): {{pagespeedDesktop}}
Detección de gestor de cookies: {{cookieDetected}} {{cookieTool}}`;

const REPORT_HTML_TEMPLATE = `Se te van a proporcionar los datos del prospecto directamente en este mensaje.

Con los datos que recibes genera un archivo HTML con el reporte del prospecto siguiendo este diseño exacto:

ESTRUCTURA DEL HTML:
- Fondo blanco, fuente Arial, tamaño 13px, max-width 680px centrado
- Sin estilos externos, todo inline o en un bloque <style> en el <head>

SECCIONES EN ORDEN:

1. HEADER
   - Etiqueta pequeña: "Prospect Report · #{{id}}"
   - Nombre del negocio en 22px bold
   - Web y ciudad en gris debajo
   - Tags de colores: {{categoryTag}}
   - Badges a la derecha con los scores:
     Performance en rojo si <50, naranja si 50-89, verde si 90+
     SEO y Best Practices igual

2. PERFORMANCE SCORES
   Título de sección en mayúsculas pequeñas gris
   4 metric cards en grid 2x2 con fondo gris claro:
   - Performance: {{mPerformance}}/100
   - LCP: {{mLcp}} (target: <2.5s)
   - TBT: {{mTbt}} (target: <200ms)
   - Speed Index: {{mSpeedIndex}} (target: <3.4s)
   Cada card: label pequeño, valor grande en color (rojo/naranja/verde), subtítulo con el target

   Barras de progreso horizontales para:
   - Performance: {{mPerformance}}/100
   - Accessibility: {{mAccessibility}}/100
   - SEO: {{mSeo}}/100
   - Best Practices: {{mBestPractices}}/100
   (Desktop: Performance {{dPerformance}}, SEO {{dSeo}})
   Cada barra: label a la izquierda, valor a la derecha en color, barra de fondo gris con relleno en color proporcional al score

   {{mRawSection}}
   {{dRawSection}}

3. ISSUES IDENTIFIED
   Basándote en el análisis técnico siguiente, genera la lista de problemas:

   {{webAnalysisSerialized}}

   {{notesSection}}

   Cada problema con:
   - Punto de color (rojo = crítico, naranja = importante)
   - Título en bold
   - Descripción en gris
   - Estimación de impacto si aplica

4. BUSINESS SIGNALS
   Grid 2 columnas con señales del negocio extraídas del análisis:
   - Negocio: {{businessName}}
   - Ciudad: {{city}}
   - Categoría: {{categoryTag}}
   - Teléfono: {{phone}}
   - Web: {{url}}
   Incluye también lo que detectaste en el análisis (reseñas, redes sociales, años operando)

5. OPPORTUNITY FRAMING
   Caja con borde gris y fondo muy claro
   Título: "Bottom line"
   2-3 frases explicando por qué este negocio necesita ayuda y cuál es el coste real de no actuar.
   Basate en el "Dolor principal" (headlinePain) y los problemas más graves del análisis técnico —
   nunca asumas que el negocio paga por publicidad (no hay forma fiable de saberlo); habla del coste
   en visitantes, conversiones o profesionalidad percibida en su lugar.

6. CONTACT
   Email: {{email}} / Teléfono: {{phone}}

7. FOOTER
   Izquierda: "Prospect #{{id}} · Analysis date: {{date}}"
   Derecha: "Taller de Digitalización"

COLORES DE REFERENCIA:
- Rojo: #c0392b — para scores <50 y problemas críticos
- Naranja: #e67e22 — para scores 50-89 y problemas importantes
- Verde: #27ae60 — para scores 90+ y señales positivas
- Gris oscuro: #1a1a1a — texto principal
- Gris medio: #666 — texto secundario
- Gris claro: #f7f7f7 — fondos de cards

Devuelve SOLO el HTML completo y auto-contenido, sin explicaciones ni markdown.`;

const COLD_EMAIL_TEMPLATE = `Se te va a proporcionar el reporte del prospecto como archivo HTML.

Lo primero que tienes que hacer es localizar la sección "Bottom line" del reporte y leerla con atención — ahí está el argumento central que debe guiar todo el email.

Con esa información genera el email. El asunto en la primera línea como texto plano. El cuerpo del email en HTML puro (sin etiquetas <html>/<head>/<body>, solo el contenido, con estilos inline para que se vea igual en cualquier cliente de correo — no uses <style> ni clases CSS).

Formato exacto (respeta también los estilos inline tal cual):

Subject: [Extrae el problema más grave y concreto del Bottom line (o de los top3Fixes si el Bottom line es genérico) y conviértelo en una frase de impacto de menos de 10 palabras que incluya el dominio. NUNCA asumas que el negocio paga por publicidad — no hay forma fiable de saberlo, así que el ángulo debe ser el problema técnico/de negocio en sí, no el gasto en ads. Ejemplos: "Your site scores 47/100 on mobile — glasswellservice.com" / "3 in 4 mobile visitors bounce before it loads — glasswellservice.com" / "This 47/100 site is losing you customers — glasswellservice.com"]

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

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Worth 30 minutes? <a href="{{bookingUrl}}" style="color:#4338CA;">Book a free call here</a></p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Free 30-min call to find out exactly what's costing you visitors and conversions, and what to do about it.<br>
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
{{canSpamAddress}}<br>
<a href="__UNSUBSCRIBE_URL__" style="color:#999999;">Unsubscribe</a>
</p>

REGLAS:
- El subject y el primer párrafo argumental tienen que derivar directamente del Bottom line — no de los scores ni de los issues técnicos, y no van en caja aparte, van como párrafo normal
- Cada problema va en su propia caja con el formato exacto indicado, en lenguaje humano, nunca términos técnicos crudos
- No inventes datos que no estén en el reporte
- NUNCA asumas ni menciones que el negocio paga por publicidad (Google Ads u otra) — no hay forma fiable de saberlo. Habla del coste en visitantes, conversiones o profesionalidad percibida en su lugar
- Sin introducción ni explicación. Solo el email listo para copiar y enviar
- Todo con estilos inline exactamente como en el formato — nada de <style> ni clases, para que se vea igual al pegarlo en Zoho Mail o al enviarse por SES

---
REPORTE HTML:
{{reportHtml}}`;

const LINKEDIN_POST_TEMPLATE = `Se te va a proporcionar el reporte del prospecto como archivo HTML.
Con esa información genera un post de LinkedIn con estas reglas:

TONO:
- Primera persona, directo, sin corporativo
- Como alguien que comparte lo que encontró, no como vendedor
- En inglés

ESTRUCTURA:
Primera línea (el hook — lo más importante):
Una frase que genere curiosidad o sorpresa basada en el problema más grave del análisis (headlinePain o
el peor score). Ejemplos del estilo:
"This [sector] business in [ciudad] scores 31/100 on mobile performance."
"A [sector] site in [ciudad] takes 8 seconds to load on mobile. Most visitors are gone by second 3."
No uses "I" como primera palabra — LinkedIn penaliza el alcance.
NUNCA asumas ni menciones que el negocio paga por publicidad — no hay forma fiable de saberlo.

Párrafo 2 — el contexto:
2-3 frases explicando qué significa ese dato para el negocio.
Sin jerga técnica. En términos de visitantes y clientes perdidos.

Párrafo 3 — lo que encontré:
3-4 bullets con los problemas principales del reporte.
En lenguaje humano, no técnico.
Cada bullet una línea.

Párrafo 4 — el punto:
2 frases sobre lo que esto le cuesta al negocio en términos reales (visitantes, conversiones, reputación).

Cierre:
Una pregunta o afirmación que invite a reflexionar sobre el problema encontrado, sin asumir cómo llega el
tráfico al sitio.

Hashtags al final — máximo 4:
Usa siempre: #WebPerformance #LocalBusiness #SmallBusiness
El cuarto hashtag debe reflejar la plataforma real del negocio según el reporte (por ejemplo: #Squarespace, #Wix, #WordPressSpeed). Si la plataforma no está identificada, usa #SiteSpeed.

REGLAS:
- No menciones el nombre del negocio ni datos que lo identifiquen
- No menciones tu servicio ni hagas pitch directo
- NUNCA asumas ni menciones que el negocio paga por publicidad (Google Ads u otra)
- Máximo 1200 caracteres en total
- Sin emojis excepto en los bullets donde puedes usar → o —
- Sin introducción ni explicación. Solo el post listo para copiar y publicar

---
REPORTE HTML:
{{reportHtml}}`;

const FOLLOWUP_EMAIL_TEMPLATE = `Se te va a proporcionar el reporte del prospecto como archivo HTML. Ya se le envió un email inicial hace días con este mismo reporte y no ha respondido, hecho clic, ni reservado llamada.

{{framing}}

Genera un email de SEGUIMIENTO CORTO — la mitad de largo que un email inicial. El asunto en la primera línea como texto plano. El cuerpo en HTML puro con estilos inline, sin <style> ni clases.

Formato exacto:

Subject: [breve, deja claro que es un seguimiento, incluye el dominio]

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Hi,</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">[1-2 frases retomando el argumento del "Bottom line" del reporte, en el tono indicado arriba. No repitas el email inicial palabra por palabra.]</p>

<div style="margin:0 0 16px;">
[1-2 cajas como máximo, solo el/los problema(s) más importante(s), con este formato exacto por caja:
{{signalBoxFormat}}
]
</div>

{{emailFooter}}

REGLAS:
- Máximo 1-2 cajas de problema, el resto del contenido es texto normal
- No inventes datos que no estén en el reporte
- Sin introducción ni explicación. Solo el email listo para enviar
- Todo con estilos inline exactamente como en el formato

---
REPORTE HTML:
{{reportHtml}}`;

const ENGAGED_FOLLOWUP_EMAIL_TEMPLATE = `Se te va a proporcionar el reporte del prospecto como archivo HTML. Ya se le envió un email inicial con este mismo reporte y esta vez SÍ entró a verlo (hizo clic en el link del reporte) — a diferencia de un seguimiento genérico, acá sabemos que ya lo revisó.

Genera un email de seguimiento CORTO, tono 1:1 y personal — como si le escribieras a alguien que sabés que ya vio tu trabajo, no un recordatorio genérico. Referenciá que ya revisó el informe de "{{businessName}}" y preguntá directamente sobre este hallazgo concreto (parafraseálo en una frase natural, no lo copies literal): {{headlineFinding}}.

El asunto en la primera línea como texto plano. El cuerpo en HTML puro con estilos inline, sin <style> ni clases.

Formato exacto:

Subject: [breve, personal, deja claro que sabés que vio el reporte]

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Hi,</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">[1-2 frases: notaste que revisó el reporte, preguntá sobre el hallazgo específico de arriba, ofrecé explicar el impacto en conversión/negocio si le sirve. Tono curioso, no de venta.]</p>

<div style="margin:0 0 16px;">
[exactamente 1 caja con este formato, retomando el mismo hallazgo:
{{signalBoxFormat}}
]
</div>

{{emailFooter}}

REGLAS:
- Exactamente 1 caja de problema — el hallazgo específico de arriba, no otro
- No inventes datos que no estén en el reporte o en el hallazgo dado
- Sin introducción ni explicación. Solo el email listo para enviar
- Todo con estilos inline exactamente como en el formato

---
REPORTE HTML:
{{reportHtml}}`;

// ---------------------------------------------------------------------------------------
// Campaña es-sprint. A diferencia de us-webaudit, estas plantillas llevan el pie y el
// formato de caja escritos dentro en vez de recibirlos por {{emailFooter}} /
// {{signalBoxFormat}}: esos helpers viven en shared/email-template.ts en inglés y con la
// oferta de auditoría. renderPrompt solo sustituye los placeholders que la plantilla trae,
// así que ignorarlos aquí no afecta a la otra campaña ni requiere tocar código.
// ---------------------------------------------------------------------------------------

const ES_VISION_SYSTEM_PROMPT = `Eres un consultor de automatización de procesos que audita las webs de pymes españolas para un servicio de prospección B2B. Tu trabajo NO es evaluar diseño ni velocidad: es detectar señales de que un proceso del negocio se lleva a mano.

QUÉ BUSCAS (en este orden de importancia):
1. Cómo pide el negocio que le contacten. "Llámanos para pedir cita", un teléfono como única llamada a la acción, un horario de atención telefónica publicado, WhatsApp como canal principal, un formulario que solo manda un correo. Todo eso significa que hay una persona haciendo de agenda.
2. Qué NO tiene. Sin reserva de cita online, sin presupuesto automático, sin área de cliente, sin confirmación automática.
3. Qué sí tiene ya resuelto. Si encuentras un sistema de reservas o un chat montado, dilo claramente: ese proceso ya está automatizado y no hay nada que vender ahí.

Se te dan tres fuentes: una captura de la home, las señales técnicas ya detectadas en el HTML (fiables, no las contradigas) y el texto de la página. Las señales técnicas mandan sobre tu impresión visual: si dicen que no hay sistema de reservas, no hay, aunque la captura muestre un botón que parezca uno.

REGLAS DE EVIDENCIA (obligatorias):
- Cada afirmación anclada en algo concreto: cita la frase literal de la web, la señal técnica o lo que se ve en la captura.
- Nunca inventes procesos, herramientas ni cifras que no puedas verificar con lo que te dan.
- Si un dato no está, dilo en vez de rellenar.
- Cero relleno de marketing ni superlativos vacíos.
- Español de España, tuteo, tono directo de alguien que ya miró la web.
- Máximo 250 palabras entre todos los campos de texto.

process_hypothesis es el corazón del análisis: una frase que nombre el proceso manual concreto que se podría automatizar y por qué se nota desde fuera. Si el negocio ya lo tiene automatizado, dilo ahí explícitamente.

Responde ÚNICAMENTE con este JSON, sin texto antes ni después, sin backticks de markdown:
{
  "headline_pain": "",
  "visual_assessment": "",
  "performance_summary": { "mobile_score": 0, "desktop_score": 0, "core_web_vitals_issues": [] },
  "compliance_flag": "",
  "top_3_fixes": [],
  "closing_hook": "",
  "friction_signals": [],
  "process_hypothesis": ""
}`;

const ES_VISION_USER_TEMPLATE = `Analiza la web de {{businessName}}, del sector {{category}}, en {{city}}.

SEÑALES TÉCNICAS DETECTADAS EN EL HTML (fiables, tienen prioridad sobre tu impresión visual):
{{frictionSignals}}

TEXTO DE LA PÁGINA:
{{pageText}}

Datos PageSpeed Insights (móvil): {{pagespeedMobile}}
Datos PageSpeed Insights (escritorio): {{pagespeedDesktop}}
Gestor de cookies detectado: {{cookieDetected}} {{cookieTool}}

En friction_signals devuelve las señales que de verdad sostienen la hipótesis, reescritas en una frase corta y legible cada una (no copies la lista de arriba literal). En top_3_fixes prioriza automatizaciones concretas del proceso, no arreglos técnicos de la web.`;

const ES_REPORT_HTML_TEMPLATE = `Se te van a proporcionar los datos del prospecto directamente en este mensaje.

Genera un archivo HTML con un informe cuyo tema es DÓNDE SE LE VA EL TIEMPO al negocio, no lo lenta que va su web. Español de España, tuteo.

ESTRUCTURA DEL HTML:
- Fondo blanco, fuente Arial, 13px, max-width 680px centrado
- Todo inline o en un bloque <style> en el <head>, sin hojas externas

SECCIONES EN ORDEN:

1. CABECERA
   - Etiqueta pequeña: "Informe de procesos · #{{id}}"
   - Nombre del negocio en 22px bold
   - Web y ciudad en gris debajo
   - Fecha: {{date}}

2. EL PROCESO QUE HEMOS DETECTADO
   Título de sección en mayúsculas pequeñas gris.
   Un párrafo destacado, sobre fondo gris claro y con borde izquierdo naranja de 3px, con la hipótesis del proceso manual. Es la sección más importante del informe: si no dice nada concreto, el informe entero no sirve.

3. EN QUÉ SE NOTA
   Una lista de las señales encontradas, cada una como una fila con un "→" naranja delante. Cita lo que se ve en la web, no generalidades.

4. QUÉ SE PODRÍA AUTOMATIZAR
   Los fixes priorizados, numerados, cada uno con una frase de qué cambiaría en el día a día de quien hoy hace ese trabajo a mano. Estimaciones en horas solo si se pueden justificar con algo del informe; si no, nada.

5. DE PASO, LA WEB
   Sección secundaria y breve, claramente menos importante que las anteriores. Los scores de PageSpeed en cuatro tarjetas pequeñas en cuadrícula 2x2:
   - Rendimiento móvil: {{mPerformance}}/100
   - LCP: {{mLcp}} (objetivo: <2,5s)
   - Rendimiento escritorio: {{dPerformance}}/100
   - SEO: {{mSeo}}/100
   Verde si 90+, naranja si 50-89, rojo si <50.
   Una sola frase de cierre poniéndolo en contexto: es un dato de salud de la web, no el motivo del informe.

6. CONTACTO
   Teléfono {{phone}} y email {{email}} si existen.

7. PIE
   Izquierda: la fecha. Derecha: "Taller de Digitalización".

PALETA: rojo #c0392b, naranja #e67e22, verde #27ae60, texto #1a1a1a, grises suaves para fondos.

DATOS DEL PROSPECTO:
Negocio: {{businessName}} · Sector: {{category}} · Ciudad: {{city}}
Web: {{url}}
Teléfono: {{phone}} · Email: {{email}}
PageSpeed móvil: {{mPerformance}}/100, LCP {{mLcp}}, TBT {{mTbt}}, Speed Index {{mSpeedIndex}}, accesibilidad {{mAccessibility}}, SEO {{mSeo}}, buenas prácticas {{mBestPractices}}
PageSpeed escritorio: {{dPerformance}}/100, SEO {{dSeo}}
Análisis: {{webAnalysisSerialized}}
{{notesSection}}

Devuelve SOLO el HTML completo y autocontenido, sin explicaciones ni markdown.`;

const ES_COLD_EMAIL_TEMPLATE = `Se te va a proporcionar el informe de un prospecto como archivo HTML.

Lo primero: localiza en el informe la sección "El proceso que hemos detectado" y léela con atención. Ese proceso concreto es el argumento central de todo el email. Si el informe dice que el negocio YA tiene ese proceso automatizado, escribe igualmente el email pero apoyado en la segunda señal más fuerte que encuentres.

Escribe un email frío en español de España, tuteando, para el dueño del negocio. El asunto en la primera línea como texto plano. El cuerpo en HTML puro con estilos inline, sin <style> ni clases.

Formato exacto:

Subject: [El proceso manual detectado, en menos de 10 palabras, incluyendo el dominio. Ejemplo: "Las citas de clinicadental-ejemplo.es pasan por teléfono"]

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Hola,</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">[2 frases: que has mirado su web mientras revisabas negocios de su sector en su ciudad, y el proceso manual concreto que te ha llamado la atención. Nada de halagos ni de "espero que estés bien".]</p>

<div style="margin:0 0 16px;">
[1 o 2 cajas como máximo, una por señal, con este formato exacto por caja:
<div style="border-left:3px solid #E67E22;padding:8px 0 8px 12px;margin-bottom:10px;"><span style="color:#E67E22;font-weight:bold;">&rarr;</span> <span style="font-size:14px;line-height:1.6;color:#1A1A1A;">[la señal, citando lo que pone en su web]</span></div>
]
</div>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">[1 frase conectando esa señal con lo que le cuesta: horas de alguien, citas que se pierden fuera de horario, presupuestos que tardan. Sin cifras inventadas.]</p>

<p style="margin:0 0 20px;"><a href="__REPORT_URL__" style="display:inline-block;background:#1A1A1A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:4px;font-size:14px;">Ver el informe completo &rarr;</a></p>

<div style="border-top:1px solid #E5E5E5;padding-top:16px;margin-bottom:16px;">
<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:8px;"><strong>Lo que hago:</strong> cojo un proceso que hoy llevas a mano y lo dejo funcionando solo, en tu propia cuenta de AWS.</p>
<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:8px;">Tres semanas, precio cerrado desde 2.900 €, el código es tuyo. Si en la primera semana no encuentro un proceso que compense automatizar, lo cancelo y te devuelvo el anticipo.</p>
<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:0;"><a href="{{bookingUrl}}" style="color:#C0392B;">Hablamos 20 minutos</a> y sales de la llamada con el proceso identificado y una estimación, me contrates o no.</p>
</div>

<p style="font-size:13px;line-height:1.6;color:#666;margin-bottom:16px;">PD: este correo no lo he escrito yo. Un sistema que construí encontró tu web, la analizó y redactó esto sin que yo tocara nada. Eso es exactamente el tipo de cosa que monto.</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:4px;">Pablo Leone</p>
<p style="font-size:13px;line-height:1.5;color:#666;margin-bottom:16px;">Automatización de procesos<br>info@tallerdedigitalizacion.com</p>

<p style="font-size:11px;line-height:1.5;color:#999;border-top:1px solid #E5E5E5;padding-top:12px;">{{canSpamAddress}}<br><a href="__UNSUBSCRIBE_URL__" style="color:#999;">Darse de baja</a></p>

REGLAS:
- Máximo 2 cajas. El resto es texto normal.
- No inventes datos que no estén en el informe.
- Ni una palabra sobre publicidad, Google Ads ni presupuesto publicitario: no sabemos si invierte en eso.
- No hables de lo lenta que va su web como argumento principal. El argumento es el proceso manual.
- Sin introducción ni explicación tuya. Solo el email listo para enviar.
- Deja __REPORT_URL__ y __UNSUBSCRIBE_URL__ tal cual, se sustituyen después.

---
INFORME HTML:
{{reportHtml}}`;

const ES_LINKEDIN_POST_TEMPLATE = `Se te va a proporcionar el informe de un prospecto como archivo HTML.

Escribe un post de LinkedIn en español de España sobre lo que ese análisis encontró. El lector es un dueño de pyme o alguien que trabaja en una.

Gancho en la primera línea, concreto y sin signos de interrogación retóricos. Por ejemplo: "Analicé la web de una clínica dental en Valencia. Para pedir cita hay que llamar entre las 9 y las 14."

Estructura:
- Gancho de 1 o 2 líneas
- 1 o 2 líneas explicando por qué eso cuesta dinero de verdad, sin dramatizar
- Una lista corta de 2 a 4 hallazgos, cada uno empezando por "→"
- Un cierre de 1 o 2 líneas sobre el patrón, no sobre el negocio concreto

REGLAS:
- No nombres el negocio ni pongas su dominio. Sector y ciudad sí.
- No vendas nada, no menciones tus servicios, no pongas llamada a la acción.
- No inventes cifras.
- Máximo 1200 caracteres.
- Termina con estos hashtags: #Automatización #Pymes #Procesos
- Devuelve solo el texto del post, sin comillas ni explicaciones.

---
INFORME HTML:
{{reportHtml}}`;

const ES_FOLLOWUP_EMAIL_TEMPLATE = `Se te va a proporcionar el informe de un prospecto como archivo HTML. Ya se le envió un email inicial hace días con este mismo informe y no ha respondido, ni ha hecho clic, ni ha reservado llamada.

{{framing}}

Escribe un email de SEGUIMIENTO CORTO en español de España, tuteando — la mitad de largo que el inicial. El asunto en la primera línea como texto plano. El cuerpo en HTML puro con estilos inline, sin <style> ni clases.

Formato exacto:

Subject: [breve, deja claro que es un seguimiento, incluye el dominio]

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Hola,</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">[1 o 2 frases retomando el proceso manual del informe, en el tono indicado arriba. No repitas el email inicial palabra por palabra.]</p>

<div style="margin:0 0 16px;">
[1 caja como máximo, la señal más fuerte, con este formato exacto:
<div style="border-left:3px solid #E67E22;padding:8px 0 8px 12px;margin-bottom:10px;"><span style="color:#E67E22;font-weight:bold;">&rarr;</span> <span style="font-size:14px;line-height:1.6;color:#1A1A1A;">[la señal]</span></div>
]
</div>

<p style="margin:0 0 20px;"><a href="__REPORT_URL__" style="display:inline-block;background:#1A1A1A;color:#fff;text-decoration:none;padding:10px 18px;border-radius:4px;font-size:14px;">Ver el informe completo &rarr;</a></p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Tres semanas, precio cerrado, el código es tuyo. <a href="{{bookingUrl}}" style="color:#C0392B;">Hablamos 20 minutos</a> si te encaja.</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:4px;">Pablo Leone</p>
<p style="font-size:13px;line-height:1.5;color:#666;margin-bottom:16px;">Automatización de procesos<br>info@tallerdedigitalizacion.com</p>

<p style="font-size:11px;line-height:1.5;color:#999;border-top:1px solid #E5E5E5;padding-top:12px;">{{canSpamAddress}}<br><a href="__UNSUBSCRIBE_URL__" style="color:#999;">Darse de baja</a></p>

REGLAS:
- 1 caja como máximo.
- No inventes datos que no estén en el informe.
- Ni una mención a publicidad o Google Ads.
- Sin introducción ni explicación. Solo el email listo para enviar.

---
INFORME HTML:
{{reportHtml}}`;

const ES_ENGAGED_FOLLOWUP_EMAIL_TEMPLATE = `Se te va a proporcionar el informe de un prospecto como archivo HTML. Ya se le envió un email inicial con este mismo informe y esta vez SÍ entró a verlo (hizo clic en el enlace) — a diferencia de un seguimiento genérico, aquí sabemos que lo ha revisado.

Escribe un email de seguimiento CORTO en español de España, tuteando, tono 1:1 y personal — como si le escribieras a alguien que sabes que ya ha visto tu trabajo, no un recordatorio automático. Menciona que ha echado un vistazo al informe de "{{businessName}}" y pregúntale directamente por este hallazgo concreto, parafraseado en una frase natural, sin copiarlo literal: {{headlineFinding}}.

El asunto en la primera línea como texto plano. El cuerpo en HTML puro con estilos inline, sin <style> ni clases.

Formato exacto:

Subject: [breve, personal, deja claro que sabes que ha visto el informe]

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">Hola,</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;">[1 o 2 frases: viste que abrió el informe, pregunta por el hallazgo concreto de arriba, ofrécete a contarle cómo se quitaría de encima ese proceso. Tono curioso, de conversación, no de venta.]</p>

<div style="margin:0 0 16px;">
[exactamente 1 caja, retomando ese mismo hallazgo:
<div style="border-left:3px solid #E67E22;padding:8px 0 8px 12px;margin-bottom:10px;"><span style="color:#E67E22;font-weight:bold;">&rarr;</span> <span style="font-size:14px;line-height:1.6;color:#1A1A1A;">[el hallazgo]</span></div>
]
</div>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:16px;"><a href="{{bookingUrl}}" style="color:#C0392B;">Veinte minutos</a> y te digo si tiene arreglo y cuánto costaría. Sin compromiso.</p>

<p style="font-size:14px;line-height:1.65;color:#1A1A1A;margin-bottom:4px;">Pablo Leone</p>
<p style="font-size:13px;line-height:1.5;color:#666;margin-bottom:16px;">Automatización de procesos<br>info@tallerdedigitalizacion.com</p>

<p style="font-size:11px;line-height:1.5;color:#999;border-top:1px solid #E5E5E5;padding-top:12px;">{{canSpamAddress}}<br><a href="__UNSUBSCRIBE_URL__" style="color:#999;">Darse de baja</a></p>

REGLAS:
- Exactamente 1 caja — el hallazgo de arriba, no otro.
- No inventes datos que no estén en el informe o en el hallazgo dado.
- Ni una mención a publicidad o Google Ads.
- Sin introducción ni explicación. Solo el email listo para enviar.

---
INFORME HTML:
{{reportHtml}}`;

// Las claves reales en DynamoDB son `${campaignId}/${promptId}` — cada campaña tiene su
// propio juego de prompts (ver shared/prompt-store.ts y shared/campaigns.ts). Estos seis son
// los de la campaña original; los de es-sprint se añaden cuando exista su copy.
const CAMPAIGN_PROMPTS: Record<string, PromptSeed[]> = {
  'us-webaudit': [
    { promptId: 'vision-analysis', content: VISION_USER_TEMPLATE, systemPrompt: VISION_SYSTEM_PROMPT },
    { promptId: 'report-html', content: REPORT_HTML_TEMPLATE },
    { promptId: 'cold-email', content: COLD_EMAIL_TEMPLATE },
    { promptId: 'linkedin-post', content: LINKEDIN_POST_TEMPLATE },
    { promptId: 'followup-email', content: FOLLOWUP_EMAIL_TEMPLATE },
    { promptId: 'engaged-followup-email', content: ENGAGED_FOLLOWUP_EMAIL_TEMPLATE },
  ],
  'es-sprint': [
    { promptId: 'vision-analysis', content: ES_VISION_USER_TEMPLATE, systemPrompt: ES_VISION_SYSTEM_PROMPT },
    { promptId: 'report-html', content: ES_REPORT_HTML_TEMPLATE },
    { promptId: 'cold-email', content: ES_COLD_EMAIL_TEMPLATE },
    { promptId: 'linkedin-post', content: ES_LINKEDIN_POST_TEMPLATE },
    { promptId: 'followup-email', content: ES_FOLLOWUP_EMAIL_TEMPLATE },
    { promptId: 'engaged-followup-email', content: ES_ENGAGED_FOLLOWUP_EMAIL_TEMPLATE },
  ],
};

async function seedPrompt(campaignId: string, seed: PromptSeed): Promise<void> {
  const key = `${campaignId}/${seed.promptId}`;
  if (!FORCE) {
    const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { promptId: key, version: 'ACTIVE' } }));
    if (existing.Item) {
      console.log(`skip: "${key}" ya tiene una versión ACTIVE (usar --force para re-seedear)`);
      return;
    }
  }

  const now = Date.now();
  const versionItem = {
    promptId: key,
    version: '000001',
    versionNumber: 1,
    content: seed.content,
    systemPrompt: seed.systemPrompt,
    createdAt: now,
    createdBy: 'seed-script',
    notes: 'Versión inicial — migrada desde el código hardcodeado',
  };
  const activeItem = {
    promptId: key,
    version: 'ACTIVE',
    activeVersion: 1,
    content: seed.content,
    systemPrompt: seed.systemPrompt,
    publishedAt: now,
  };

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: { TableName: TABLE, Item: versionItem, ConditionExpression: 'attribute_not_exists(promptId)' } },
      { Put: { TableName: TABLE, Item: activeItem } },
    ],
  }));
  console.log(`ok: "${key}" sembrado — versión 1, ACTIVE`);
}

async function main() {
  const entries = Object.entries(CAMPAIGN_PROMPTS).filter(([c]) => !ONLY_CAMPAIGN || c === ONLY_CAMPAIGN);
  if (ONLY_CAMPAIGN && entries.length === 0) {
    throw new Error(`no hay prompts definidos para la campaña "${ONLY_CAMPAIGN}"`);
  }
  const total = entries.reduce((n, [, seeds]) => n + seeds.length, 0);
  console.log(`Sembrando ${total} prompts en la tabla "${TABLE}"${FORCE ? ' (--force)' : ''}...`);
  for (const [campaignId, seeds] of entries) {
    for (const seed of seeds) {
      await seedPrompt(campaignId, seed);
    }
  }
  console.log('Listo.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
