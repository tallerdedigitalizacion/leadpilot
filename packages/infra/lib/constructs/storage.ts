import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class Storage extends Construct {
  public readonly reportsBucket: s3.Bucket;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.reportsBucket = new s3.Bucket(this, 'ReportsBucket', {
      bucketName: `leadpilot-reports-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          // Elimina PDFs viejos para ahorrar costos
          expiration: cdk.Duration.days(90),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
  }
}
