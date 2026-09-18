import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class Database extends Construct {
  public readonly table: dynamodb.Table;
  public readonly sendCountersTable: dynamodb.Table;
  public readonly scrapeJobsTable: dynamodb.Table;
  public readonly promptsTable: dynamodb.Table;
  public readonly llmLogsTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.table = new dynamodb.Table(this, 'LeadsTable', {
      tableName: 'leadpilot-leads',
      partitionKey: { name: 'leadId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // GSI1: listar por status ordenado por createdAt
    this.table.addGlobalSecondaryIndex({
      indexName: 'status-createdAt-index',
      partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI para deduplicación por URL
    this.table.addGlobalSecondaryIndex({
      indexName: 'url-index',
      partitionKey: { name: 'url', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // Contador de envíos automatizados por día — separado de la tabla de leads para no
    // ensuciar el scan-por-status de get-stats con ítems que no son leads.
    this.sendCountersTable = new dynamodb.Table(this, 'SendCountersTable', {
      tableName: 'leadpilot-send-counters',
      partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Seguimiento de jobs del scraper de Google Maps — data operativa, no leads.
    this.scrapeJobsTable = new dynamodb.Table(this, 'ScrapeJobsTable', {
      tableName: 'leadpilot-scrape-jobs',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Prompts como datos: PK promptId, SK version. Versiones históricas usan SK numérica
    // con padding ("000001", "000002"...), y un ítem puntero con SK literal "ACTIVE" (el
    // único que se sobreescribe) desnormaliza el contenido activo para que leerlo sea un
    // solo GetItem. Contenido real editado a mano — mismo nivel de retención que los leads.
    this.promptsTable = new dynamodb.Table(this, 'PromptsTable', {
      tableName: 'leadpilot-prompts',
      partitionKey: { name: 'promptId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'version', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Log estructurado de cada llamada a Claude (prompt/versión, modelo, tokens, costo,
    // latencia) — telemetría operativa, no fuente de verdad de negocio.
    this.llmLogsTable = new dynamodb.Table(this, 'LlmLogsTable', {
      tableName: 'leadpilot-llm-logs',
      partitionKey: { name: 'leadId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'logId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.llmLogsTable.addGlobalSecondaryIndex({
      indexName: 'promptId-at-index',
      partitionKey: { name: 'promptId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'at', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
