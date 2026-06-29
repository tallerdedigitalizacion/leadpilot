import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import * as path from 'path';

interface ApiProps {
  table: dynamodb.Table;
  reportsBucket: s3.Bucket;
  ingestApiKey: string;
  frontendUrl?: string;
}

export class Api extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly noResponseFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const { table, reportsBucket } = props;

    const anthropicKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'AnthropicKeyParam',
      { parameterName: '/leadpilot/anthropic-api-key' }
    );

    const commonEnv = {
      LEADS_TABLE_NAME: table.tableName,
      REPORTS_BUCKET_NAME: reportsBucket.bucketName,
      SES_FROM_EMAIL: 'pablo@tallerdigitalizacion.com',
      INGEST_API_KEY: props.ingestApiKey,
    };

    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    } as const;

    const fnPath = (name: string) =>
      path.join(__dirname, '..', '..', '..', 'functions', name);

    // ── ingest-leads ──────────────────────────────────────────────────────────
    const ingestFn = new lambda.Function(this, 'IngestLeads', {
      ...commonLambdaProps,
      functionName: 'leadpilot-ingest-leads',
      code: lambda.Code.fromAsset(fnPath('ingest-leads')),
      handler: 'index.handler',
      environment: commonEnv,
    });
    table.grantReadWriteData(ingestFn);

    // ── list-leads ────────────────────────────────────────────────────────────
    const listFn = new lambda.Function(this, 'ListLeads', {
      ...commonLambdaProps,
      functionName: 'leadpilot-list-leads',
      code: lambda.Code.fromAsset(fnPath('list-leads')),
      handler: 'index.handler',
      environment: commonEnv,
    });
    table.grantReadData(listFn);

    // ── get-lead ──────────────────────────────────────────────────────────────
    const getFn = new lambda.Function(this, 'GetLead', {
      ...commonLambdaProps,
      functionName: 'leadpilot-get-lead',
      code: lambda.Code.fromAsset(fnPath('get-lead')),
      handler: 'index.handler',
      environment: commonEnv,
    });
    table.grantReadData(getFn);

    // ── run-analysis ──────────────────────────────────────────────────────────
    const analysisFn = new lambda.Function(this, 'RunAnalysis', {
      ...commonLambdaProps,
      functionName: 'leadpilot-run-analysis',
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      code: lambda.Code.fromAsset(fnPath('run-analysis')),
      handler: 'index.handler',
      environment: {
        ...commonEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
      },
    });
    table.grantReadWriteData(analysisFn);
    anthropicKeyParam.grantRead(analysisFn);

    // ── update-lead-status ────────────────────────────────────────────────────
    const updateStatusFn = new lambda.Function(this, 'UpdateLeadStatus', {
      ...commonLambdaProps,
      functionName: 'leadpilot-update-lead-status',
      code: lambda.Code.fromAsset(fnPath('update-lead-status')),
      handler: 'index.handler',
      environment: {
        ...commonEnv,
        RUN_ANALYSIS_FUNCTION_NAME: analysisFn.functionName,
      },
    });
    table.grantReadWriteData(updateStatusFn);
    analysisFn.grantInvoke(updateStatusFn);

    // ── generate-report ───────────────────────────────────────────────────────
    const reportFn = new lambda.Function(this, 'GenerateReport', {
      ...commonLambdaProps,
      functionName: 'leadpilot-generate-report',
      timeout: cdk.Duration.seconds(120),
      memorySize: 1536,
      code: lambda.Code.fromAsset(fnPath('generate-report')),
      handler: 'index.handler',
      environment: {
        ...commonEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
      },
    });
    table.grantReadWriteData(reportFn);
    reportsBucket.grantReadWrite(reportFn);
    anthropicKeyParam.grantRead(reportFn);

    // ── send-email ────────────────────────────────────────────────────────────
    const sendEmailFn = new lambda.Function(this, 'SendEmail', {
      ...commonLambdaProps,
      functionName: 'leadpilot-send-email',
      code: lambda.Code.fromAsset(fnPath('send-email')),
      handler: 'index.handler',
      environment: commonEnv,
    });
    table.grantReadWriteData(sendEmailFn);
    reportsBucket.grantRead(sendEmailFn);
    sendEmailFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendRawEmail'],
        resources: ['*'],
      })
    );

    // ── no-response-checker ───────────────────────────────────────────────────
    this.noResponseFn = new lambda.Function(this, 'NoResponseChecker', {
      ...commonLambdaProps,
      functionName: 'leadpilot-no-response-checker',
      code: lambda.Code.fromAsset(fnPath('no-response-checker')),
      handler: 'index.handler',
      environment: commonEnv,
    });
    table.grantReadWriteData(this.noResponseFn);

    // ── API Gateway ───────────────────────────────────────────────────────────
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'leadpilot-api',
      corsPreflight: {
        allowOrigins: [
          'http://localhost:5173',
          ...(props.frontendUrl ? [`https://${props.frontendUrl}`] : []),
        ],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['content-type', 'x-api-key'],
        maxAge: cdk.Duration.days(1),
      },
    });

    const r = (fn: lambda.Function) =>
      new integrations.HttpLambdaIntegration('Integration', fn);

    this.httpApi.addRoutes({
      path: '/leads',
      methods: [apigwv2.HttpMethod.POST],
      integration: r(ingestFn),
    });
    this.httpApi.addRoutes({
      path: '/leads',
      methods: [apigwv2.HttpMethod.GET],
      integration: r(listFn),
    });
    this.httpApi.addRoutes({
      path: '/leads/{leadId}',
      methods: [apigwv2.HttpMethod.GET],
      integration: r(getFn),
    });
    this.httpApi.addRoutes({
      path: '/leads/{leadId}/status',
      methods: [apigwv2.HttpMethod.PATCH],
      integration: r(updateStatusFn),
    });
    this.httpApi.addRoutes({
      path: '/leads/{leadId}/analyze',
      methods: [apigwv2.HttpMethod.POST],
      integration: r(analysisFn),
    });
    this.httpApi.addRoutes({
      path: '/leads/{leadId}/report',
      methods: [apigwv2.HttpMethod.POST],
      integration: r(reportFn),
    });
    this.httpApi.addRoutes({
      path: '/leads/{leadId}/send',
      methods: [apigwv2.HttpMethod.POST],
      integration: r(sendEmailFn),
    });
  }
}
