#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LeadPilotStack } from '../lib/leadpilot-stack';

const app = new cdk.App();
new LeadPilotStack(app, 'LeadPilotStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
});
