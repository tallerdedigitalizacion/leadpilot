// EventBridge cron (rate 1 day) — alimenta el funnel solo, sin que Pablo tenga que abrir
// /scrape a mano. Por cada campaña activa (shared/campaigns.ts) elige al azar una ciudad y un
// vertical de SU ICP y dispara un scrape-job idéntico al que crearía el botón manual (mismo
// scrape-worker, misma tabla de seguimiento). Con -email activado siempre: sin email no hay
// forma de contactar al lead por el único canal 1:1 del funnel, así que no tiene sentido
// cargarlo sin eso.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { v4 as uuidv4 } from 'uuid';
import type { ScrapeJob, ScrapeProvider } from '../shared/types';
import { activeCampaigns } from '../shared/campaigns';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const lambdaClient = new LambdaClient({});
const ssm = new SSMClient({});
const TABLE = process.env.SCRAPE_JOBS_TABLE_NAME!;
const SCRAPE_WORKER_FN = process.env.SCRAPE_WORKER_FUNCTION_NAME!;
const SCRAPE_PROVIDER_PARAM = process.env.SCRAPE_PROVIDER_PARAM!;

// Se lee en cada corrida, sin cachear — así que volver a gosom (borrando o cambiando el
// parámetro) surte efecto al día siguiente sin redeploy. Default gosom: un parámetro
// ausente o con un valor raro nunca debe arrancar a gastar cupo pago por accidente.
async function getScrapeProvider(): Promise<ScrapeProvider> {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: SCRAPE_PROVIDER_PARAM }));
    return result.Parameter?.Value === 'serpapi' ? 'serpapi' : 'gosom';
  } catch {
    return 'gosom';
  }
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export const handler = async (): Promise<void> => {
  const campaigns = activeCampaigns();
  if (campaigns.length === 0) {
    console.log('auto-scrape-scheduler: ninguna campaña activa, no hay nada que hacer');
    return;
  }

  // Un job por campaña activa y por corrida. Cada campaña gasta su propia búsqueda de
  // SerpApi, así que activar una campaña nueva duplica el consumo de cuota — tenerlo en
  // cuenta antes de encender la tercera.
  const globalProvider = await getScrapeProvider();

  for (const campaign of campaigns) {
    const city = pickRandom(campaign.cities);
    const query = pickRandom(campaign.verticals);
    // La campaña puede pinear su provider; si no, manda el toggle global de SSM.
    const provider = campaign.provider ?? globalProvider;
    const jobId = uuidv4();
    const now = Date.now();

    const job: ScrapeJob = {
      jobId,
      status: 'PENDING',
      provider,
      campaignId: campaign.campaignId,
      query,
      city,
      extractEmails: true,
      createdAt: now,
    };

    await ddb.send(new PutCommand({ TableName: TABLE, Item: job }));
    await lambdaClient.send(new InvokeCommand({
      FunctionName: SCRAPE_WORKER_FN,
      InvocationType: 'Event',
      Payload: JSON.stringify({ jobId }),
    }));

    console.log(`auto-scrape-scheduler: job ${jobId} — "${query}" en "${city}" (campaña=${campaign.campaignId}, provider=${provider})`);
  }
};
