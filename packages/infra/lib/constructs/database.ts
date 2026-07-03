import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class Database extends Construct {
  public readonly table: dynamodb.Table;
  public readonly sendCountersTable: dynamodb.Table;
  public readonly scrapeJobsTable: dynamodb.Table;

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
  }
}
