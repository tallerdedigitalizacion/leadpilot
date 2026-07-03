import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

interface ScrapingProps {
  reportsBucket: s3.Bucket;
}

// Base compartida para tareas Fargate que necesitan un navegador headless (Playwright) —
// algo que no cabe en Lambda de forma razonable. VPC con subnet pública sin NAT Gateway
// (evita el costo fijo de ~$32-45/mes que no aporta nada aquí: las tareas ya necesitan
// salir a internet, y una IP pública en subnet pública lo resuelve gratis). Sin ALB —
// las tareas son on-demand/efímeras, no hace falta un endpoint estable.
export class Scraping extends Construct {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  public readonly screenshotRepo: ecr.Repository;
  public readonly screenshotTaskDef: ecs.FargateTaskDefinition;
  public readonly screenshotTaskSg: ec2.SecurityGroup;
  public readonly screenshotTaskTokenParam: ssm.IParameter;
  public readonly mapsScraperTaskDef: ecs.FargateTaskDefinition;
  public readonly mapsScraperTaskSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ScrapingProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'ScrapingVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    this.cluster = new ecs.Cluster(this, 'ScrapingCluster', {
      vpc: this.vpc,
      containerInsights: false,
    });

    this.screenshotRepo = new ecr.Repository(this, 'ScreenshotRepo', {
      repositoryName: 'leadpilot-screenshot',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // Secreto que el propio servicio de captura verifica en cada request — es la defensa
    // real, no el security group (el Lambda que llama no está en la VPC, así que el SG
    // tiene que aceptar tráfico de cualquier IP en el puerto). Pablo lo crea a mano en SSM.
    this.screenshotTaskTokenParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this, 'ScreenshotTaskTokenParam', { parameterName: '/leadpilot/screenshot-task-token' }
    );

    this.screenshotTaskSg = new ec2.SecurityGroup(this, 'ScreenshotTaskSg', {
      vpc: this.vpc,
      description: 'Screenshot service (Playwright) - short-lived task, protected by bearer token',
      allowAllOutbound: true,
    });
    this.screenshotTaskSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Screenshot service port - short-lived task + bearer token, residual risk accepted'
    );

    this.screenshotTaskDef = new ecs.FargateTaskDefinition(this, 'ScreenshotTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      // La imagen se construye nativamente en Macs Apple Silicon (arm64) — sin esto,
      // Fargate pide linux/amd64 por defecto y el pull falla (manifest sin ese arch).
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    this.screenshotTaskDef.addContainer('screenshot', {
      image: ecs.ContainerImage.fromEcrRepository(this.screenshotRepo, 'latest'),
      portMappings: [{ containerPort: 8080 }],
      environment: {
        REPORTS_BUCKET_NAME: props.reportsBucket.bucketName,
      },
      secrets: {
        BEARER_TOKEN: ecs.Secret.fromSsmParameter(this.screenshotTaskTokenParam),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'screenshot', logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK }),
    });

    props.reportsBucket.grantPut(this.screenshotTaskDef.taskRole, 'screenshots/*');

    // ── Scraper de Google Maps (gosom/google-maps-scraper, imagen pública pineada) ──
    // Imagen oficial de Docker Hub, solo linux/amd64 — sin runtimePlatform override
    // (Fargate usa X86_64 por defecto). Sin auth propia (no hay bearer token en esta
    // herramienta, a diferencia del servicio de captura) — mismo trade-off ya aceptado
    // en el screenshotTaskSg: SG abierto en el puerto, mitigado por la vida corta de la tarea.
    this.mapsScraperTaskSg = new ec2.SecurityGroup(this, 'MapsScraperTaskSg', {
      vpc: this.vpc,
      description: 'Google Maps scraper - short-lived task, no built-in auth, residual risk accepted',
      allowAllOutbound: true,
    });
    this.mapsScraperTaskSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(8080),
      'Maps scraper API port - short-lived task, residual risk accepted'
    );

    this.mapsScraperTaskDef = new ecs.FargateTaskDefinition(this, 'MapsScraperTaskDef', {
      cpu: 1024,
      memoryLimitMiB: 2048,
    });

    this.mapsScraperTaskDef.addContainer('scraper', {
      image: ecs.ContainerImage.fromRegistry('gosom/google-maps-scraper:v1.16.0'),
      portMappings: [{ containerPort: 8080 }],
      command: ['-data-folder', '/gmapsdata'],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'maps-scraper', logRetention: cdk.aws_logs.RetentionDays.ONE_WEEK }),
    });
  }
}
