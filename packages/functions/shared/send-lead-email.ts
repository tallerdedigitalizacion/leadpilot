import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { LeadItem, LeadStatus, TimelineEvent } from './types';
import { getCampaign } from './campaigns';

export interface SendDeps {
  ddb: DynamoDBDocumentClient;
  ses: SESClient;
  ssm: SSMClient;
  leadsTable: string;
  countersTable: string;
  fromEmail: string;
  dailyCapParam: string;
}

export type SendOutcome =
  | { ok: true; messageId?: string }
  | { ok: false; reason: 'unsubscribed' | 'cap-exhausted' | 'no-recipients' | 'send-error'; error?: string };

export async function getSharedDailyCap(ssm: SSMClient, paramName: string): Promise<number> {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: paramName }));
    const parsed = parseInt(result.Parameter?.Value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  } catch {
    return 20; // sin parámetro configurado, freno conservador por defecto
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// El contador global (sentCount) y el de cada campaña (sentCount#<campaignId>) viven en la
// misma fila del día. Así una campaña nueva puede arrancar con su propio freno sin dejar de
// contar contra el tope global, que es el que protege la reputación del dominio en SES.
function campaignCounterAttr(campaignId: string): string {
  return `sentCount#${campaignId}`;
}

export async function getSentCountToday(
  ddb: DynamoDBDocumentClient,
  countersTable: string,
  campaignId?: string,
): Promise<number> {
  const result = await ddb.send(new GetCommand({ TableName: countersTable, Key: { date: todayKey() } }));
  const attr = campaignId ? campaignCounterAttr(campaignId) : 'sentCount';
  return (result.Item?.[attr] as number) ?? 0;
}

export async function incrementSentCountToday(
  ddb: DynamoDBDocumentClient,
  countersTable: string,
  campaignId?: string,
): Promise<void> {
  // Los dos contadores se incrementan en la misma operación atómica: si se hicieran en dos
  // llamadas, un fallo entre medias dejaría los totales desalineados para siempre.
  const names: Record<string, string> = { '#global': 'sentCount' };
  const parts = ['#global :one'];
  if (campaignId) {
    names['#campaign'] = campaignCounterAttr(campaignId);
    parts.push('#campaign :one');
  }
  await ddb.send(new UpdateCommand({
    TableName: countersTable,
    Key: { date: todayKey() },
    UpdateExpression: `ADD ${parts.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ':one': 1 },
  }));
}

// Envío automatizado de un lead que ya tiene emailSubject/emailBody listos — usado por el
// auto-envío de generate-report y por el barrido de leads atascados de followup-sequencer.
// Nunca confía a ciegas: siempre registra éxito o fallo en el timeline antes de devolver.
export async function sendLeadEmail(
  deps: SendDeps,
  lead: LeadItem,
  opts: { checkCap: boolean; expectedStatus?: LeadStatus }
): Promise<SendOutcome> {
  if (lead.unsubscribed) return { ok: false, reason: 'unsubscribed' };

  const campaign = getCampaign(lead.campaignId);

  if (opts.checkCap) {
    const cap = await getSharedDailyCap(deps.ssm, deps.dailyCapParam);
    const sentToday = await getSentCountToday(deps.ddb, deps.countersTable);
    if (sentToday >= cap) return { ok: false, reason: 'cap-exhausted' };

    if (campaign.dailySendCap !== undefined) {
      const sentForCampaign = await getSentCountToday(deps.ddb, deps.countersTable, campaign.campaignId);
      if (sentForCampaign >= campaign.dailySendCap) return { ok: false, reason: 'cap-exhausted' };
    }
  }

  const toAddresses = [...new Set([...(lead.emails ?? []), ...(lead.email ? [lead.email] : [])])];
  if (toAddresses.length === 0) return { ok: false, reason: 'no-recipients' };

  const now = Date.now();
  // deps.fromEmail (SES_FROM_EMAIL) queda como respaldo: la dirección tiene que estar
  // verificada en SES, y la de la campaña puede no estarlo si se añadió hace un momento.
  const fromEmail = campaign.fromEmail || deps.fromEmail;
  let messageId: string | undefined;
  try {
    const sesResult = await deps.ses.send(new SendEmailCommand({
      Source: fromEmail,
      Destination: { ToAddresses: toAddresses, BccAddresses: [fromEmail] },
      Message: {
        Subject: { Data: lead.emailSubject!, Charset: 'UTF-8' },
        Body: { Html: { Data: lead.emailBody!, Charset: 'UTF-8' } },
      },
    }));
    messageId = sesResult.MessageId;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const failEvent: TimelineEvent = { at: now, event: 'EMAIL_SEND_FAILED', by: 'system', note: error, meta: { to: toAddresses } };
    await deps.ddb.send(new UpdateCommand({
      TableName: deps.leadsTable,
      Key: { leadId: lead.leadId },
      UpdateExpression: 'SET timeline = list_append(timeline, :event)',
      ExpressionAttributeValues: { ':event': [failEvent] },
    }));
    return { ok: false, reason: 'send-error', error };
  }

  const sentEvent: TimelineEvent = { at: now, event: 'EMAIL_SENT', by: 'system', meta: { to: toAddresses, messageId } };
  const expected = opts.expectedStatus ?? 'ANALYZED';
  try {
    await deps.ddb.send(new UpdateCommand({
      TableName: deps.leadsTable,
      Key: { leadId: lead.leadId },
      UpdateExpression: 'SET #status = :status, sentAt = :sentAt, timeline = list_append(timeline, :event)',
      ConditionExpression: '#status = :expected',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':status': 'SENT', ':sentAt': now, ':event': [sentEvent], ':expected': expected },
    }));
  } catch (err: any) {
    // El email ya salió — si el estado cambió por otra vía justo en esta ventana (ej. un
    // envío manual concurrente), no pisamos ese estado, pero el envío en sí fue real.
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  }

  if (opts.checkCap) await incrementSentCountToday(deps.ddb, deps.countersTable, campaign.campaignId);
  return { ok: true, messageId };
}
