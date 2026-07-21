// EventBridge cron (rate 1 day) — alimenta el funnel solo, sin que Pablo tenga que abrir
// /scrape a mano. Elige una ciudad y un rubro al azar de las listas que dio, y dispara un
// scrape-job exactamente igual al que crearía el botón manual (mismo scrape-worker, misma
// tabla de seguimiento). Con -email activado siempre: sin email no hay forma de contactar al
// lead por el único canal 1:1 del funnel, así que no tiene sentido cargarlo sin eso.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { v4 as uuidv4 } from 'uuid';
import type { ScrapeJob, ScrapeProvider } from '../shared/types';

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

// Listas provistas por Pablo — editar acá + redeploy si quiere cambiarlas.
const CITIES = [
  'Austin TX', 'San Antonio TX', 'Fort Worth TX', 'El Paso TX', 'Arlington TX',
  'Nashville TN', 'Memphis TN', 'Knoxville TN', 'Charlotte NC', 'Raleigh NC',
  'Durham NC', 'Greensboro NC', 'Jacksonville FL', 'Tampa FL', 'Orlando FL',
  'St. Petersburg FL', 'Hialeah FL', 'Scottsdale AZ', 'Mesa AZ', 'Tucson AZ',
  'Chandler AZ', 'Gilbert AZ', 'Louisville KY', 'Lexington KY', 'Indianapolis IN',
  'Fort Wayne IN', 'Columbus OH', 'Cleveland OH', 'Cincinnati OH', 'Toledo OH',
  'Las Vegas NV', 'Henderson NV', 'Reno NV', 'Portland OR', 'Eugene OR',
  'Albuquerque NM', 'Santa Fe NM', 'Omaha NE', 'Lincoln NE', 'Wichita KS',
  'Overland Park KS', 'Colorado Springs CO', 'Aurora CO', 'Virginia Beach VA',
  'Richmond VA', 'Newark NJ', 'Jersey City NJ', 'Bakersfield CA', 'Fresno CA',
  'Boise ID',
];

const SECTORS = [
  'plumbing', 'HVAC', 'roofing', 'landscaping', 'pest control', 'window repair',
  'garage door repair', 'pool service', 'electrician', 'dentist', 'orthodontist',
  'chiropractor', 'optometrist', 'veterinarian', 'auto repair', 'car detailing',
  'carpet cleaning', 'house cleaning', 'painting contractor', 'concrete contractor',
  'fencing contractor', 'tree service', 'irrigation', 'moving company',
  'storage facility', 'towing service', 'locksmith', 'security systems',
  'solar panels', 'water damage restoration', 'mold remediation',
  'fire damage restoration', 'foundation repair', 'drywall repair',
  'tile and flooring', 'kitchen remodeling', 'bathroom remodeling',
  'handyman', 'pressure washing', 'junk removal', 'personal injury lawyer',
  'family lawyer', 'tax preparation', 'accounting', 'insurance agency',
  'real estate agency', 'mortgage broker', 'physical therapy', 'hearing clinic',
  'urgent care clinic', 'med spa', 'restaurant', 'catering', 'food truck',
];

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export const handler = async (): Promise<void> => {
  const city = pickRandom(CITIES);
  const query = pickRandom(SECTORS);
  const provider = await getScrapeProvider();
  const jobId = uuidv4();
  const now = Date.now();

  const job: ScrapeJob = {
    jobId,
    status: 'PENDING',
    provider,
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

  console.log(`auto-scrape-scheduler: job ${jobId} — "${query}" en "${city}" (provider=${provider})`);
};
