import * as http from 'http';
import { timingSafeEqual } from 'crypto';
import { chromium } from 'playwright';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

// Claude rechaza imágenes con algún lado mayor a 8000px — páginas largas con
// fullPage:true lo superan fácil. Techo con margen de seguridad.
const MAX_IMAGE_DIMENSION = 7800;

const PORT = 8080;
const BEARER_TOKEN = process.env.BEARER_TOKEN ?? '';
const BUCKET = process.env.REPORTS_BUCKET_NAME!;
const s3 = new S3Client({});

// Heurística best-effort — cubre los gestores más comunes, no el 100% de los casos.
const COOKIE_BANNER_SELECTORS: Array<{ tool: string; selector: string }> = [
  { tool: 'OneTrust', selector: '#onetrust-accept-btn-handler' },
  { tool: 'Cookiebot', selector: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll' },
  { tool: 'Cookiebot', selector: '#CybotCookiebotDialogBodyButtonAccept' },
  { tool: 'CookieYes', selector: '.cky-btn-accept' },
  { tool: 'Iubenda', selector: '.iubenda-cs-accept-btn' },
];

function checkAuth(req: http.IncomingMessage): boolean {
  const header = req.headers['authorization'] ?? '';
  const expected = `Bearer ${BEARER_TOKEN}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function dismissCookieBanner(page: import('playwright').Page): Promise<{ cookieDetected: boolean; cookieTool?: string }> {
  for (const { tool, selector } of COOKIE_BANNER_SELECTORS) {
    try {
      const el = page.locator(selector).first();
      await el.waitFor({ state: 'visible', timeout: 1500 });
      await el.click({ timeout: 1500 });
      await page.waitForTimeout(300);
      return { cookieDetected: true, cookieTool: tool };
    } catch {
      // no encontrado o no clickeable — probar el siguiente
    }
  }
  return { cookieDetected: false };
}

async function resizeIfTooLarge(buffer: Buffer): Promise<Buffer> {
  const image = sharp(buffer);
  const { width, height } = await image.metadata();
  if (!width || !height || (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION)) {
    return buffer;
  }
  return image
    .resize({
      width: Math.min(width, MAX_IMAGE_DIMENSION),
      height: Math.min(height, MAX_IMAGE_DIMENSION),
      fit: 'inside',
    })
    .png()
    .toBuffer();
}

// El HTML renderizado (después de que corra el JS) viaja junto a la captura: los widgets de
// reserva y de chat se inyectan por script, así que un fetch plano del HTML original no los
// vería. Se recorta por arriba para no mandar respuestas enormes por HTTP — con esto alcanza
// de sobra para detectar los <script src> y los enlaces, que es lo que se busca.
const MAX_HTML_CHARS = 600_000;

async function takeScreenshot(url: string, leadId: string): Promise<{ s3Key: string; cookieDetected: boolean; cookieTool?: string; html?: string }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`https://${url}`, { waitUntil: 'load', timeout: 20000 });

    const { cookieDetected, cookieTool } = await dismissCookieBanner(page);

    // Se lee antes de la captura porque page.screenshot con fullPage hace scroll y algunos
    // sitios cargan cosas al hacerlo; queremos el DOM tal como lo ve quien entra.
    const html = await page.content().then((h) => h.slice(0, MAX_HTML_CHARS)).catch(() => undefined);

    const rawBuffer = await page.screenshot({ fullPage: true, type: 'png' });
    const buffer = await resizeIfTooLarge(rawBuffer);
    const s3Key = `screenshots/${leadId}/homepage.png`;
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
      Body: buffer,
      ContentType: 'image/png',
    }));

    return { s3Key, cookieDetected, cookieTool, html };
  } finally {
    await browser.close();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/screenshot') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  if (!checkAuth(req)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  try {
    const body = JSON.parse(await readBody(req)) as { url?: string; leadId?: string };
    if (!body.url || !body.leadId) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'url and leadId are required' }));
      return;
    }

    const result = await takeScreenshot(body.url, body.leadId);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('screenshot failed:', message);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, () => console.log(`screenshot-service listening on ${PORT}`));
