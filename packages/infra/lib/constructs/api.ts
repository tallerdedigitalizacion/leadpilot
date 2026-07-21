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
import { Scraping } from './scraping';

interface ApiProps {
  table: dynamodb.Table;
  sendCountersTable: dynamodb.Table;
  scrapeJobsTable: dynamodb.Table;
  reportsBucket: s3.Bucket;
  ingestApiKey: string;
  frontendUrl?: string;
  canSpamAddress?: string;
  scraping: Scraping;
}

export class Api extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly followupSequencerFn: nodejs.NodejsFunction;
  public readonly autoScrapeSchedulerFn: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const { table, sendCountersTable, scrapeJobsTable, reportsBucket, scraping } = props;

    const anthropicKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'AnthropicKeyParam',
      { parameterName: '/leadpilot/anthropic-api-key' }
    );

    // PageSpeed API key — plain string (not secret), resolved at deploy time
    const pagespeedApiKey = ssm.StringParameter.valueForStringParameter(
      this, '/leadpilot/pagespeed-api-key'
    );

    // Secreto para firmar los links de tracking/unsubscribe (HMAC, no es un API key de terceros)
    const trackingSecretParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'TrackingSecretParam',
      { parameterName: '/leadpilot/tracking-secret' }
    );

    // Secreto configurado en el dashboard de Cal.com al crear la suscripción del webhook
    const calcomWebhookSecretParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'CalcomWebhookSecretParam',
      { parameterName: '/leadpilot/calcom-webhook-secret' }
    );

    // Solo para otorgar permiso de lectura — el Lambda lee el valor en tiempo de ejecución,
    // así Pablo puede subir el freno sin redeploy. Freno diario COMPARTIDO entre el
    // auto-envío inicial (generate-report) y los seguimientos (followup-sequencer).
    const sharedDailyCapParamRef = ssm.StringParameter.fromStringParameterName(
      this, 'SharedDailyCapParamRef', '/leadpilot/daily-send-cap'
    );

    // Freno diario propio de LinkedIn (página pública, no un email 1:1 — no comparte
    // presupuesto con el freno de envíos).
    const linkedinDailyCapParamRef = ssm.StringParameter.fromStringParameterName(
      this, 'LinkedinDailyCapParamRef', '/leadpilot/linkedin-daily-cap'
    );

    // API key personal de Buffer (Settings → API en buffer.com) — publica en la Company
    // Page de LinkedIn ya conectada, sin flujo de OAuth.
    const bufferApiKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this, 'BufferApiKeyParam', { parameterName: '/leadpilot/buffer-api-key' }
    );

    // API key personal de SerpApi (serpapi.com/manage-api-key) — motor google_maps, plan free.
    const serpApiKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this, 'SerpApiKeyParam', { parameterName: '/leadpilot/serpapi-key' }
    );

    // Selector de proveedor para el cron automático (gosom | serpapi) — String param (no
    // Secure) para poder cambiarlo sin redeploy. Sin setear, el scheduler usa 'gosom' por
    // default (ver auto-scrape-scheduler) para no arrancar a gastar cupo pago por accidente.
    const scrapeProviderParamRef = ssm.StringParameter.fromStringParameterName(
      this, 'ScrapeProviderParamRef', '/leadpilot/scrape-provider'
    );

    const commonEnv = {
      LEADS_TABLE_NAME: table.tableName,
      REPORTS_BUCKET_NAME: reportsBucket.bucketName,
      SES_FROM_EMAIL: 'info@tallerdedigitalizacion.com',
      SES_REGION: 'eu-west-1',
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

    // Construido antes que los Lambdas que necesitan su URL (generate-report, regenerate-email,
    // track-click, unsubscribe) — las rutas se añaden al final, pero el objeto ya existe aquí.
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: 'leadpilot-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['content-type', 'x-api-key'],
        maxAge: cdk.Duration.days(1),
      },
    });
    const trackingEnv = {
      TRACKING_BASE_URL: this.httpApi.apiEndpoint,
      TRACKING_SECRET_PARAM: '/leadpilot/tracking-secret',
      CAN_SPAM_ADDRESS: props.canSpamAddress ?? '',
    };

    // ── generate-report (worker — invocado async) ─────────────────────────────
    // Declarado temprano: analysis-worker necesita invocarlo, y ahora también envía
    // el email automáticamente al terminar (necesita SES + el freno diario compartido).
    const reportFn = new nodejs.NodejsFunction(this, 'GenerateReport', {
      ...commonProps,
      functionName: 'leadpilot-generate-report',
      entry: fnEntry('generate-report'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: {
        ...commonEnv,
        ...trackingEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
        FRONTEND_URL: props.frontendUrl ? `https://${props.frontendUrl}` : '',
        SEND_COUNTERS_TABLE_NAME: sendCountersTable.tableName,
        SHARED_DAILY_CAP_PARAM: '/leadpilot/daily-send-cap',
        BUFFER_API_KEY_PARAM: '/leadpilot/buffer-api-key',
        BUFFER_LINKEDIN_CHANNEL_ID: '6a4766f35ab6d2f1069c7945',
        LINKEDIN_DAILY_CAP_PARAM: '/leadpilot/linkedin-daily-cap',
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
    trackingSecretParam.grantRead(reportFn);
    sendCountersTable.grantReadWriteData(reportFn);
    sharedDailyCapParamRef.grantRead(reportFn);
    linkedinDailyCapParamRef.grantRead(reportFn);
    bufferApiKeyParam.grantRead(reportFn);
    reportFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: ['*'],
      })
    );

    // ── analysis-worker (ciclo completo: captura Fargate + PageSpeed + Claude visión) ─
    const analysisWorkerFn = new nodejs.NodejsFunction(this, 'AnalysisWorker', {
      ...commonProps,
      functionName: 'leadpilot-analysis-worker',
      entry: fnEntry('analysis-worker'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        ...commonEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
        PAGESPEED_API_KEY: pagespeedApiKey,
        GENERATE_REPORT_FUNCTION_NAME: reportFn.functionName,
        SCREENSHOT_TASK_TOKEN_PARAM: '/leadpilot/screenshot-task-token',
        SCREENSHOT_CLUSTER_ARN: scraping.cluster.clusterArn,
        SCREENSHOT_TASK_DEF_ARN: scraping.screenshotTaskDef.taskDefinitionArn,
        SCREENSHOT_CONTAINER_NAME: 'screenshot',
        SCREENSHOT_SUBNET_IDS: scraping.vpc.publicSubnets.map((s) => s.subnetId).join(','),
        SCREENSHOT_SECURITY_GROUP_ID: scraping.screenshotTaskSg.securityGroupId,
      },
    });
    table.grantReadWriteData(analysisWorkerFn);
    reportsBucket.grantRead(analysisWorkerFn);
    anthropicKeyParam.grantRead(analysisWorkerFn);
    scraping.screenshotTaskTokenParam.grantRead(analysisWorkerFn);
    reportFn.grantInvoke(analysisWorkerFn);
    scraping.screenshotTaskDef.grantRun(analysisWorkerFn);
    analysisWorkerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
        resources: ['*'],
      })
    );
    analysisWorkerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeNetworkInterfaces'],
        resources: ['*'],
      })
    );

    // ── run-analysis (punto de entrada estable — solo hace el handoff a analysis-worker) ─
    const analysisFn = new nodejs.NodejsFunction(this, 'RunAnalysis', {
      ...commonProps,
      functionName: 'leadpilot-run-analysis',
      entry: fnEntry('run-analysis'),
      handler: 'handler',
      environment: {
        ANALYSIS_WORKER_FUNCTION_NAME: analysisWorkerFn.functionName,
      },
    });
    analysisWorkerFn.grantInvoke(analysisFn);

    // ── ingest-leads (auto-califica y dispara el análisis por cada lead nuevo) ────
    const ingestFn = new nodejs.NodejsFunction(this, 'IngestLeads', {
      ...commonProps,
      functionName: 'leadpilot-ingest-leads',
      entry: fnEntry('ingest-leads'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        RUN_ANALYSIS_FUNCTION_NAME: analysisFn.functionName,
      },
    });
    table.grantReadWriteData(ingestFn);
    analysisFn.grantInvoke(ingestFn);

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
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['@aws-sdk/s3-request-presigner'],
        minify: true,
      },
    });
    table.grantReadData(getFn);
    reportsBucket.grantRead(getFn);

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
        ...trackingEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
      },
    });
    table.grantReadWriteData(regenerateEmailFn);
    reportsBucket.grantRead(regenerateEmailFn);
    anthropicKeyParam.grantRead(regenerateEmailFn);
    trackingSecretParam.grantRead(regenerateEmailFn);

    // ── get-stats ─────────────────────────────────────────────────────────────
    const getStatsFn = new nodejs.NodejsFunction(this, 'GetStats', {
      ...commonProps,
      functionName: 'leadpilot-get-stats',
      entry: fnEntry('get-stats'),
      handler: 'handler',
      environment: commonEnv,
    });
    table.grantReadData(getStatsFn);

    // ── followup-sequencer (cron diario: SENT→FOLLOWUP_1→FOLLOWUP_2→NO_RESPONSE +
    //    barrido de leads ANALIZADOS atascados por el freno diario) ─────────────
    this.followupSequencerFn = new nodejs.NodejsFunction(this, 'FollowupSequencer', {
      ...commonProps,
      functionName: 'leadpilot-followup-sequencer',
      entry: fnEntry('followup-sequencer'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        ...commonEnv,
        ...trackingEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
        SEND_COUNTERS_TABLE_NAME: sendCountersTable.tableName,
        SHARED_DAILY_CAP_PARAM: '/leadpilot/daily-send-cap',
      },
    });
    table.grantReadWriteData(this.followupSequencerFn);
    sendCountersTable.grantReadWriteData(this.followupSequencerFn);
    reportsBucket.grantRead(this.followupSequencerFn);
    anthropicKeyParam.grantRead(this.followupSequencerFn);
    trackingSecretParam.grantRead(this.followupSequencerFn);
    sharedDailyCapParamRef.grantRead(this.followupSequencerFn);
    this.followupSequencerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: ['*'],
      })
    );

    // ── simulate-followup (botón manual de prueba — dispara el seguimiento 1 o 2 al
    //    instante para un lead puntual, sin esperar 7/14 días reales ni tocar el freno diario) ─
    const simulateFollowupFn = new nodejs.NodejsFunction(this, 'SimulateFollowup', {
      ...commonProps,
      functionName: 'leadpilot-simulate-followup',
      entry: fnEntry('simulate-followup'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        ...commonEnv,
        ...trackingEnv,
        ANTHROPIC_API_KEY_PARAM: '/leadpilot/anthropic-api-key',
      },
    });
    table.grantReadWriteData(simulateFollowupFn);
    reportsBucket.grantRead(simulateFollowupFn);
    anthropicKeyParam.grantRead(simulateFollowupFn);
    trackingSecretParam.grantRead(simulateFollowupFn);
    simulateFollowupFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: ['*'],
      })
    );

    // ── track-click (redirect + click tracking, sin auth) ─────────────────────
    const trackClickFn = new nodejs.NodejsFunction(this, 'TrackClick', {
      ...commonProps,
      functionName: 'leadpilot-track-click',
      entry: fnEntry('track-click'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        ...trackingEnv,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        nodeModules: ['@aws-sdk/s3-request-presigner'],
        minify: true,
      },
    });
    table.grantReadWriteData(trackClickFn);
    reportsBucket.grantRead(trackClickFn);
    trackingSecretParam.grantRead(trackClickFn);

    // ── unsubscribe (sin auth) ─────────────────────────────────────────────────
    const unsubscribeFn = new nodejs.NodejsFunction(this, 'Unsubscribe', {
      ...commonProps,
      functionName: 'leadpilot-unsubscribe',
      entry: fnEntry('unsubscribe'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        ...trackingEnv,
      },
    });
    table.grantReadWriteData(unsubscribeFn);
    trackingSecretParam.grantRead(unsubscribeFn);

    // ── calcom-webhook (sin x-api-key, auth vía firma HMAC de Cal.com) ─────────
    const calcomWebhookFn = new nodejs.NodejsFunction(this, 'CalcomWebhook', {
      ...commonProps,
      functionName: 'leadpilot-calcom-webhook',
      entry: fnEntry('calcom-webhook'),
      handler: 'handler',
      environment: {
        ...commonEnv,
        CALCOM_WEBHOOK_SECRET_PARAM: '/leadpilot/calcom-webhook-secret',
      },
    });
    table.grantReadWriteData(calcomWebhookFn);
    calcomWebhookSecretParam.grantRead(calcomWebhookFn);

    // ── scrape-worker (ciclo completo: tarea Fargate del scraper de Maps + ingest-leads) ─
    const scrapeWorkerFn = new nodejs.NodejsFunction(this, 'ScrapeWorker', {
      ...commonProps,
      functionName: 'leadpilot-scrape-worker',
      entry: fnEntry('scrape-worker'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      environment: {
        SCRAPE_JOBS_TABLE_NAME: scrapeJobsTable.tableName,
        SCRAPER_CLUSTER_ARN: scraping.cluster.clusterArn,
        SCRAPER_TASK_DEF_ARN: scraping.mapsScraperTaskDef.taskDefinitionArn,
        SCRAPER_SUBNET_IDS: scraping.vpc.publicSubnets.map((s) => s.subnetId).join(','),
        SCRAPER_SECURITY_GROUP_ID: scraping.mapsScraperTaskSg.securityGroupId,
        API_BASE_URL: this.httpApi.apiEndpoint,
        INGEST_API_KEY: props.ingestApiKey,
        SERPAPI_KEY_PARAM: '/leadpilot/serpapi-key',
      },
    });
    scrapeJobsTable.grantReadWriteData(scrapeWorkerFn);
    scraping.mapsScraperTaskDef.grantRun(scrapeWorkerFn);
    serpApiKeyParam.grantRead(scrapeWorkerFn);
    scrapeWorkerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
        resources: ['*'],
      })
    );
    scrapeWorkerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeNetworkInterfaces'],
        resources: ['*'],
      })
    );

    // ── scrape-jobs (POST /scrape-jobs — crea el registro de seguimiento y dispara scrape-worker) ─
    const scrapeJobsFn = new nodejs.NodejsFunction(this, 'ScrapeJobs', {
      ...commonProps,
      functionName: 'leadpilot-scrape-jobs',
      entry: fnEntry('scrape-jobs'),
      handler: 'handler',
      environment: {
        SCRAPE_JOBS_TABLE_NAME: scrapeJobsTable.tableName,
        INGEST_API_KEY: props.ingestApiKey,
        SCRAPE_WORKER_FUNCTION_NAME: scrapeWorkerFn.functionName,
      },
    });
    scrapeJobsTable.grantReadWriteData(scrapeJobsFn);
    scrapeWorkerFn.grantInvoke(scrapeJobsFn);

    // ── auto-scrape-scheduler (cron diario — elige ciudad+rubro al azar y dispara un scrape,
    //    para que el funnel se siga alimentando solo sin que Pablo abra /scrape a mano) ─────
    this.autoScrapeSchedulerFn = new nodejs.NodejsFunction(this, 'AutoScrapeScheduler', {
      ...commonProps,
      functionName: 'leadpilot-auto-scrape-scheduler',
      entry: fnEntry('auto-scrape-scheduler'),
      handler: 'handler',
      environment: {
        SCRAPE_JOBS_TABLE_NAME: scrapeJobsTable.tableName,
        SCRAPE_WORKER_FUNCTION_NAME: scrapeWorkerFn.functionName,
        SCRAPE_PROVIDER_PARAM: '/leadpilot/scrape-provider',
      },
    });
    scrapeJobsTable.grantReadWriteData(this.autoScrapeSchedulerFn);
    scrapeProviderParamRef.grantRead(this.autoScrapeSchedulerFn);
    scrapeWorkerFn.grantInvoke(this.autoScrapeSchedulerFn);

    // ── get-scrape-job (GET /scrape-jobs/{jobId} — para el polling del frontend) ─────
    const getScrapeJobFn = new nodejs.NodejsFunction(this, 'GetScrapeJob', {
      ...commonProps,
      functionName: 'leadpilot-get-scrape-job',
      entry: fnEntry('get-scrape-job'),
      handler: 'handler',
      environment: {
        SCRAPE_JOBS_TABLE_NAME: scrapeJobsTable.tableName,
      },
    });
    scrapeJobsTable.grantReadData(getScrapeJobFn);

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
    this.httpApi.addRoutes({ path: '/leads/{leadId}/simulate-followup', methods: [apigwv2.HttpMethod.POST], integration: r(simulateFollowupFn) });
    this.httpApi.addRoutes({ path: '/stats', methods: [apigwv2.HttpMethod.GET], integration: r(getStatsFn) });
    this.httpApi.addRoutes({ path: '/r/{leadId}', methods: [apigwv2.HttpMethod.GET], integration: r(trackClickFn) });
    this.httpApi.addRoutes({ path: '/u/{leadId}', methods: [apigwv2.HttpMethod.GET], integration: r(unsubscribeFn) });
    this.httpApi.addRoutes({ path: '/webhooks/calcom', methods: [apigwv2.HttpMethod.POST], integration: r(calcomWebhookFn) });
    this.httpApi.addRoutes({ path: '/scrape-jobs', methods: [apigwv2.HttpMethod.POST], integration: r(scrapeJobsFn) });
    this.httpApi.addRoutes({ path: '/scrape-jobs/{jobId}', methods: [apigwv2.HttpMethod.GET], integration: r(getScrapeJobFn) });
  }
}
