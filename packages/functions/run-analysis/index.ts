// Punto de entrada estable — update-lead-status, trigger-analysis e ingest-leads invocan
// esta función por nombre. El trabajo real (captura de pantalla + PageSpeed + Claude
// visión) vive en analysis-worker; esto solo hace el handoff async.
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({});

export const handler = async (event: { leadId: string }): Promise<void> => {
  await lambdaClient.send(new InvokeCommand({
    FunctionName: process.env.ANALYSIS_WORKER_FUNCTION_NAME!,
    InvocationType: 'Event',
    Payload: JSON.stringify({ leadId: event.leadId }),
  }));
};
