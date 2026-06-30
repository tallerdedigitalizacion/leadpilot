import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
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
  public readonly noResponseFn: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const { table, reportsBucket } = props;

    const anthropicKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'AnthropicKeyParam',
      { parameterName: '/leadpilot/anthropic-api-key' }
    );

    // PageSpeed API key — plain string (not secret), resolved at deploy time
    const pagespeedApiKey = ssm.StringParameter.valueForStringParameter(
      this, '/leadpilot/pagespeed-api-key'
    );

    const commonEnv = {
      LEADS_TABLE_NAME: table.tableName,
      REPORTS_BUCKET_NAME: reportsBucket.bucketName,
      SES_FROM_EMAIL: 'info@tallerdedigitalizacion.com',
      INGEST_API_KEY: props.ingestApiKey,
    };

    const fnEntry = (name: string) =>
      path.join(__dirname, '..', '..', '..', 'functions', name, 'index.ts');

    const commonProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: true,
      },
    };

    // ── ingest-leads ──────────────────────────────────────────────────────────
    const ingestFn = new nodejs.NodejsFunction(this, 'IngestLeads', {
      ...commonProps,
      functionName: 'leadpilot-ingest-leads',
      entry: fnEntry('ingest-leads'),
      handler: 'handler',
      environment: commonEnv,
    });
    table.grantReadWriteData(ingestFn);

    // ── list-leads ────────────────────────────────────────────────────────────
    const listFn = new nodejs.NodejsFunction(this, 'ListLeads', {
      ...commonProps,
      functionName: 'leadpilot-list-leads',
      entry: fnEntry('list-leads'),
      handler: 'handler',
      environment: commonEnv,
    });
    table.grantReadData(listFn);

    // ── get-lead ──────────────────────────────────────────────────────────────
    const getFn = new nodejs.NodejsFunction(this, 'GetLead', {
      ...commonProps,
      functionName: 'leadpilot-get-lead',
      entry: fnEntry('get-lead'),
      handler: 'handler',
      environment: commonEnv,
    });
    table.grantReadData(getFn);

    // ── run-analysis ──────────────────────────────────────────────────────────
    const analysisFn = new nodejs.NodejsFunction(this, 'RunAnalysis', {
      ...commonProps,
      functionName: 'leadpilot-run-analysis',
      entry: fnEntry('run-analysis'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        ...commonEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
        PAGESPEED_API_KEY: pagespeedApiKey,
      },
    });
    table.grantReadWriteData(analysisFn);
    anthropicKeyParam.grantRead(analysisFn);

    // ── update-lead-status ────────────────────────────────────────────────────
    const updateStatusFn = new nodejs.NodejsFunction(this, 'UpdateLeadStatus', {
      ...commonProps,
      functionName: 'leadpilot-update-lead-status',
      entry: fnEntry('update-lead-status'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        RUN_ANALYSIS_FUNCTION_NAME: analysisFn.functionName,
      },
    });
    table.grantReadWriteData(updateStatusFn);
    analysisFn.grantInvoke(updateStatusFn);

    // ── generate-report (worker — invocado async) ─────────────────────────────
    const reportFn = new nodejs.NodejsFunction(this, 'GenerateReport', {
      ...commonProps,
      functionName: 'leadpilot-generate-report',
      entry: fnEntry('generate-report'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: {
        ...commonEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
        FRONTEND_URL: props.frontendUrl ? `https://${props.frontendUrl}` : '',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        // @aws-sdk/s3-request-presigner is pure JS — nodeModules installs it
        // in the Lambda package separately from the esbuild bundle
        nodeModules: ['@aws-sdk/s3-request-presigner'],
        minify: true,
      },
    });
    table.grantReadWriteData(reportFn);
    reportsBucket.grantReadWrite(reportFn);
    anthropicKeyParam.grantRead(reportFn);

    // ── trigger-report (wrapper HTTP → invoca generate-report async) ──────────
    const triggerReportFn = new nodejs.NodejsFunction(this, 'TriggerReport', {
      ...commonProps,
      functionName: 'leadpilot-trigger-report',
      entry: fnEntry('trigger-report'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        GENERATE_REPORT_FUNCTION_NAME: reportFn.functionName,
      },
    });
    table.grantReadWriteData(triggerReportFn);
    reportFn.grantInvoke(triggerReportFn);

    // ── send-email ────────────────────────────────────────────────────────────
    const sendEmailFn = new nodejs.NodejsFunction(this, 'SendEmail', {
      ...commonProps,
      functionName: 'leadpilot-send-email',
      entry: fnEntry('send-email'),
      handler: 'handler',
      environment: commonEnv,
    });
    table.grantReadWriteData(sendEmailFn);
    reportsBucket.grantRead(sendEmailFn);
    sendEmailFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: ['*'],
      })
    );

    // ── trigger-analysis (async wrapper para reintentar análisis) ─────────────
    const triggerAnalysisFn = new nodejs.NodejsFunction(this, 'TriggerAnalysis', {
      ...commonProps,
      functionName: 'leadpilot-trigger-analysis',
      entry: fnEntry('trigger-analysis'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        RUN_ANALYSIS_FUNCTION_NAME: analysisFn.functionName,
      },
    });
    table.grantReadData(triggerAnalysisFn);
    analysisFn.grantInvoke(triggerAnalysisFn);

    // ── update-pagespeed (entrada manual de datos) ────────────────────────────
    const updatePagespeedFn = new nodejs.NodejsFunction(this, 'UpdatePagespeed', {
      ...commonProps,
      functionName: 'leadpilot-update-pagespeed',
      entry: fnEntry('update-pagespeed'),
      handler: 'handler',
      environment: commonEnv,
    });
    table.grantReadWriteData(updatePagespeedFn);

    // ── delete-lead ───────────────────────────────────────────────────────────
    const deleteFn = new nodejs.NodejsFunction(this, 'DeleteLead', {
      ...commonProps,
      functionName: 'leadpilot-delete-lead',
      entry: fnEntry('delete-lead'),
      handler: 'handler',
      environment: commonEnv,
    });
    table.grantReadWriteData(deleteFn);

    // ── regenerate-email (regenera email + linkedin desde el HTML del reporte) ─
    const regenerateEmailFn = new nodejs.NodejsFunction(this, 'RegenerateEmail', {
      ...commonProps,
      functionName: 'leadpilot-regenerate-email',
      entry: fnEntry('regenerate-email'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ...commonEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
      },
    });
    table.grantReadWriteData(regenerateEmailFn);
    reportsBucket.grantRead(regenerateEmailFn);
    anthropicKeyParam.grantRead(regenerateEmailFn);

    // ── no-response-checker ───────────────────────────────────────────────────
    this.noResponseFn = new nodejs.NodejsFunction(this, 'NoResponseChecker', {
      ...commonProps,
      functionName: 'leadpilot-no-response-checker',
      entry: fnEntry('no-response-checker'),
      handler: 'handler',
      environment: commonEnv,
    });
    table.grantReadWriteData(this.noResponseFn);

    // ── API Gateway ───────────────────────────────────────────────────────────
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'leadpilot-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['content-type', 'x-api-key'],
        maxAge: cdk.Duration.days(1),
      },
    });

    const r = (fn: lambda.IFunction) =>
      new integrations.HttpLambdaIntegration('Integration', fn);

    this.httpApi.addRoutes({ path: '/leads', methods: [apigwv2.HttpMethod.POST], integration: r(ingestFn) });
    this.httpApi.addRoutes({ path: '/leads', methods: [apigwv2.HttpMethod.GET], integration: r(listFn) });
    this.httpApi.addRoutes({ path: '/leads/{leadId}', methods: [apigwv2.HttpMethod.GET], integration: r(getFn) });
    this.httpApi.addRoutes({ path: '/leads/{leadId}/status', methods: [apigwv2.HttpMethod.PATCH], integration: r(updateStatusFn) });
    this.httpApi.addRoutes({ path: '/leads/{leadId}/analyze', methods: [apigwv2.HttpMethod.POST], integration: r(triggerAnalysisFn) });
    this.httpApi.addRoutes({ path: '/leads/{leadId}/pagespeed', methods: [apigwv2.HttpMethod.PATCH], integration: r(updatePagespeedFn) });
    this.httpApi.addRoutes({ path: '/leads/{leadId}/report', methods: [apigwv2.HttpMethod.POST], integration: r(triggerReportFn) });
    this.httpApi.addRoutes({ path: '/leads/{leadId}/send', methods: [apigwv2.HttpMethod.POST], integration: r(sendEmailFn) });
    this.httpApi.addRoutes({ path: '/leads/{leadId}', methods: [apigwv2.HttpMethod.DELETE], integration: r(deleteFn) });
    this.httpApi.addRoutes({ path: '/leads/{leadId}/regen-email', methods: [apigwv2.HttpMethod.POST], integration: r(regenerateEmailFn) });
  }
}
