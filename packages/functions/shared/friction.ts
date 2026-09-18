// Detección de fricción operativa en el HTML renderizado de la home de un lead: señales de
// que un proceso del negocio se lleva a mano. Es la evidencia sobre la que se apoya la
// oferta de la campaña es-sprint — "tu web pide que te llamen para reservar, y ese teléfono
// es una persona haciendo de agenda".
//
// Deliberadamente determinista y sin LLM, igual que la detección de cookies del
// screenshot-service: si un widget de reservas está o no está en el HTML es un hecho
// verificable, no algo que convenga dejar a criterio de un modelo que puede alucinarlo. El
// LLM recibe estas señales ya resueltas y se ocupa solo de interpretarlas.
//
// Ojo con el sentido de cada señal: encontrar un widget de reservas es una señal NEGATIVA
// para esta oferta (ese negocio ya automatizó justamente lo que le íbamos a vender).

export interface FrictionDetection {
  bookingTool?: string;
  chatTool?: string;
  hasWhatsapp: boolean;
  hasMailtoForm: boolean;
  phoneLinkCount: number;
  hasContactForm: boolean;
  // Resumen en lenguaje natural, que es lo que se le pasa al prompt.
  signals: string[];
}

// Se buscan como subcadena del HTML completo (src de scripts, iframes, enlaces). Cada
// entrada es [patrón, nombre para mostrar].
const BOOKING_TOOLS: Array<[string, string]> = [
  ['calendly.com', 'Calendly'],
  ['cal.com', 'Cal.com'],
  ['doctoralia.', 'Doctoralia'],
  ['booksy.com', 'Booksy'],
  ['acuityscheduling.com', 'Acuity'],
  ['simplybook.', 'SimplyBook'],
  ['timify.com', 'Timify'],
  ['reservio.com', 'Reservio'],
  ['setmore.com', 'Setmore'],
  ['youcanbook.me', 'YouCanBook.me'],
  ['agendapro.com', 'AgendaPro'],
  ['bookitit.com', 'Bookitit'],
  ['citasapp.', 'Citas'],
  ['squareup.com/appointments', 'Square Appointments'],
  ['mindbodyonline.com', 'Mindbody'],
  ['tuotempo.com', 'TuoTempo'],
];

const CHAT_TOOLS: Array<[string, string]> = [
  ['tidio.co', 'Tidio'],
  ['crisp.chat', 'Crisp'],
  ['intercom.io', 'Intercom'],
  ['intercomcdn.com', 'Intercom'],
  ['tawk.to', 'Tawk.to'],
  ['js.hs-scripts.com', 'HubSpot'],
  ['zopim.com', 'Zendesk Chat'],
  ['zdassets.com', 'Zendesk'],
  ['livechatinc.com', 'LiveChat'],
  ['smartsuppchat.com', 'Smartsupp'],
  ['chatra.io', 'Chatra'],
  ['drift.com', 'Drift'],
  ['landbot.io', 'Landbot'],
];

function findTool(haystack: string, table: Array<[string, string]>): string | undefined {
  for (const [needle, label] of table) {
    if (haystack.includes(needle)) return label;
  }
  return undefined;
}

export function detectFriction(html: string | undefined): FrictionDetection {
  // Sin HTML (el screenshot-service falló, o todavía corre una imagen vieja que no lo
  // devuelve) no se inventa nada: cero señales, y el prompt lo verá como "no disponible"
  // en vez de como "no hay fricción".
  if (!html) {
    return { hasWhatsapp: false, hasMailtoForm: false, phoneLinkCount: 0, hasContactForm: false, signals: [] };
  }

  const lower = html.toLowerCase();
  const bookingTool = findTool(lower, BOOKING_TOOLS);
  const chatTool = findTool(lower, CHAT_TOOLS);
  const hasWhatsapp = lower.includes('wa.me/') || lower.includes('api.whatsapp.com');
  const hasMailtoForm = /<form[^>]+action\s*=\s*["']?\s*mailto:/i.test(html);
  const phoneLinkCount = (lower.match(/href\s*=\s*["']tel:/g) ?? []).length;
  const hasContactForm = /<form[\s>]/i.test(html);

  const signals: string[] = [];

  if (bookingTool) {
    signals.push(`Ya tiene reserva de cita online (${bookingTool}) — este proceso ya está automatizado.`);
  } else {
    signals.push('No se detecta ningún sistema de reserva de cita online en la home.');
  }

  if (phoneLinkCount > 0 && !bookingTool) {
    signals.push(`El contacto pasa por teléfono: ${phoneLinkCount} enlace(s) tel: y ninguna alternativa de reserva automática.`);
  }

  if (hasWhatsapp) {
    signals.push('WhatsApp aparece como canal de contacto — atención 1:1 manual.');
  }

  if (hasMailtoForm) {
    signals.push('El formulario de contacto abre el cliente de correo (action mailto:) — no hay nada que procese el envío.');
  } else if (hasContactForm) {
    signals.push('Hay formulario de contacto propio; no se puede saber desde el HTML si alguien lo procesa a mano.');
  } else if (!bookingTool) {
    signals.push('No hay ni formulario de contacto ni reserva online: el único camino es llamar o escribir.');
  }

  if (chatTool) {
    signals.push(`Tiene chat en vivo (${chatTool}) — hay alguien atendiéndolo o un bot ya montado.`);
  }

  return { bookingTool, chatTool, hasWhatsapp, hasMailtoForm, phoneLinkCount, hasContactForm, signals };
}

// Versión legible del HTML para el prompt: fuera scripts, estilos y comentarios, las
// etiquetas a espacios y el espacio en blanco colapsado. No es para detectar nada (eso ya se
// hizo arriba sobre el HTML crudo, que es donde están los src de los widgets) — es para que
// el modelo pueda leer los textos de la página: "llámanos para pedir cita", horarios de
// atención telefónica, "solicita presupuesto sin compromiso".
export function extractPageText(html: string | undefined, maxChars = 12_000): string {
  if (!html) return '';
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}
