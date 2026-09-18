import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { Database } from './constructs/database';
import { Storage } from './constructs/storage';
import { Api } from './constructs/api';
import { Frontend } from './constructs/frontend';
import { Scraping } from './constructs/scraping';

export class LeadPilotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const database = new Database(this, 'Database');
    const storage = new Storage(this, 'Storage');
    const frontend = new Frontend(this, 'Frontend');
    const scraping = new Scraping(this, 'Scraping', {
      reportsBucket: storage.reportsBucket,
    });

    const api = new Api(this, 'Api', {
      table: database.table,
      sendCountersTable: database.sendCountersTable,
      scrapeJobsTable: database.scrapeJobsTable,
      promptsTable: database.promptsTable,
      llmLogsTable: database.llmLogsTable,
      reportsBucket: storage.reportsBucket,
      ingestApiKey: process.env.INGEST_API_KEY ?? 'change-me-before-deploy',
      frontendUrl: frontend.distribution.domainName,
      canSpamAddress: process.env.CAN_SPAM_ADDRESS,
      scraping,
    });

    // EventBridge rule: corre la secuencia de seguimiento diariamente
    new events.Rule(this, 'FollowupSequencerRule', {
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [new targets.LambdaFunction(api.followupSequencerFn)],
      enabled: false, // Pausado 2026-08-02: sin conversión (0 reservas / 101 contactados) — ver TODO.md
    });

    // EventBridge rule: alimenta el funnel solo, una búsqueda ciudad+rubro al azar por día
    new events.Rule(this, 'AutoScrapeSchedulerRule', {
      schedule: events.Schedule.rate(cdk.Duration.days(1)),
      targets: [new targets.LambdaFunction(api.autoScrapeSchedulerFn)],
      enabled: false, // Pausado 2026-08-02: sin conversión (0 reservas / 101 contactados) — ver TODO.md
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.httpApi.apiEndpoint,
      description: 'API Gateway endpoint URL',
    });
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${frontend.distribution.domainName}`,
      description: 'Frontend CloudFront URL',
    });
    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: frontend.bucket.bucketName,
      description: 'S3 bucket for frontend assets',
    });
  }
}
