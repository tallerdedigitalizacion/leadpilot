import { useState, useEffect, useRef } from 'react';
import CopyButton from './CopyButton';
import { api } from '../api/client';
import type { LeadItem } from '../types/lead';

interface Props {
  lead: LeadItem;
  onLeadUpdate: (lead: LeadItem) => void;
}

function buildCalendarLink(lead: LeadItem): string {
  const followUpDate = new Date((lead.sentAt ?? Date.now()) + 7 * 24 * 60 * 60 * 1000);
  const nextDay = new Date(followUpDate.getTime() + 24 * 60 * 60 * 1000);
  const fmtDay = (d: Date) => d.toISOString().split('T')[0].replace(/-/g, '');
  const leadUrl = `${window.location.origin}/leads/${lead.leadId}`;
  const details = [
    `LeadPilot: ${leadUrl}`,
    lead.phone ? `Tel: ${lead.phone}` : '',
    lead.url ? `Web: ${lead.url}` : '',
  ].filter(Boolean).join('\n');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Seguimiento — ${lead.businessName}`,
    dates: `${fmtDay(followUpDate)}/${fmtDay(nextDay)}`,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export default function ResourcesPanel({ lead, onLeadUpdate }: Props) {
  const [emailSubject, setEmailSubject] = useState(lead.emailSubject ?? '');
  const [emailBody, setEmailBody]       = useState(lead.emailBody ?? '');
  const [linkedinPost, setLinkedinPost] = useState(lead.linkedinPost ?? '');
  const [sending, setSending]           = useState(false);
  const [sent, setSent]                 = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isGenerating = Boolean(lead.isGeneratingReport);
  const hasReport    = Boolean(lead.reportHtmlS3Key);
  const hasNotes     = Boolean(lead.myNotes?.trim());

  useEffect(() => {
    setEmailSubject(lead.emailSubject ?? '');
    setEmailBody(lead.emailBody ?? '');
    setLinkedinPost(lead.linkedinPost ?? '');
  }, [lead.emailSubject, lead.emailBody, lead.linkedinPost]);

  // Poll si se está generando el reporte
  useEffect(() => {
    if (!isGenerating) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      if (attempts > 40) {
        clearInterval(pollRef.current!);
        pollRef.current = null;
        setError('La generación tardó más de lo esperado. Refresca en un momento.');
        return;
      }
      try {
        const updated = await api.getLead(lead.leadId);
        if (updated.reportHtmlS3Key || !updated.isGeneratingReport) {
          clearInterval(pollRef.current!);
          pollRef.current = null;
          onLeadUpdate(updated);
        }
      } catch { /* reintento silencioso */ }
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [isGenerating, lead.leadId, onLeadUpdate]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const handleGenerateReport = async () => {
    setError(null);
    try {
      await api.triggerReport(lead.leadId);
      const updated = await api.getLead(lead.leadId);
      onLeadUpdate(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al iniciar la generación');
    }
  };

  const handleSendEmail = async () => {
    setSending(true);
    setError(null);
    try {
      const updated = await api.sendEmail(lead.leadId, emailSubject, emailBody);
      onLeadUpdate(updated);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error enviando email');
    } finally {
      setSending(false);
    }
  };

  const handleRegenEmail = async () => {
    setRegenLoading(true);
    setError(null);
    try {
      const updated = await api.regenEmail(lead.leadId);
      onLeadUpdate(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error regenerando email');
    } finally {
      setRegenLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
          {error}
        </div>
      )}

      {/* Generar / Regenerar reporte */}
      <div className="border rounded-lg p-4">
        {isGenerating ? (
          <div className="flex items-center gap-3">
            <div className="animate-spin w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full shrink-0" />
            <div>
              <p className="text-sm font-medium text-indigo-700">Generando reporte…</p>
              <p className="text-xs text-indigo-500 mt-0.5">
                Claude está analizando la web y generando el HTML. Tarda ~60–90 segundos.
              </p>
            </div>
          </div>
        ) : hasReport ? (
          <div className="flex items-center gap-3">
            <span className="text-green-600">✓</span>
            <span className="text-sm font-medium text-green-700">Reporte generado</span>
            {lead.reportUrl && (
              <a
                href={lead.reportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-indigo-600 hover:underline"
              >
                Ver reporte →
              </a>
            )}
            <button
              onClick={handleGenerateReport}
              className="ml-auto text-xs text-gray-400 hover:text-gray-600 border rounded px-2 py-1 hover:bg-gray-50"
            >
              ↻ Regenerar reporte
            </button>
          </div>
        ) : !hasNotes ? (
          <div className="bg-indigo-50 rounded p-3">
            <p className="text-sm font-medium text-indigo-700 mb-1">Añade tus notas primero</p>
            <p className="text-xs text-indigo-500">
              El reporte incluye tus observaciones. Escribe al menos una línea en "Mis notas" antes de generarlo.
            </p>
          </div>
        ) : (
          <div className="bg-indigo-50 rounded p-3">
            <p className="text-sm text-indigo-700 mb-3">
              Genera el reporte HTML, el email frío y el post de LinkedIn.
            </p>
            <button
              onClick={handleGenerateReport}
              className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded hover:bg-indigo-700"
            >
              Generar reporte
            </button>
          </div>
        )}
      </div>

      {/* Email */}
      {(hasReport || lead.emailSubject) && (
        <section className="border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Email frío</h3>
            <button
              onClick={handleRegenEmail}
              disabled={regenLoading}
              className="text-xs text-gray-400 hover:text-gray-600 border rounded px-2 py-1 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1"
            >
              {regenLoading && (
                <span className="inline-block w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
              )}
              {regenLoading ? 'Regenerando…' : '↻ Regenerar'}
            </button>
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Asunto</label>
            <input
              type="text"
              value={emailSubject}
              onChange={(e) => setEmailSubject(e.target.value)}
              className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Cuerpo (HTML)</label>
            <textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              rows={12}
              className="w-full border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <CopyButton text={`${emailSubject}\n\n${emailBody}`} label="Copiar email" />
            <CopyButton text={emailSubject} label="Copiar asunto" />
            <CopyButton text={emailBody}    label="Copiar cuerpo" />
            {lead.email && lead.status === 'ANALYZED' && (
              <button
                onClick={handleSendEmail}
                disabled={sending || sent}
                className="px-3 py-1.5 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light disabled:opacity-50 ml-auto"
              >
                {sending ? 'Enviando…' : sent ? '✓ Enviado' : `Enviar a ${lead.email}`}
              </button>
            )}
            {!lead.email && (
              <span className="text-xs text-gray-400 ml-auto">Sin email — envía desde Zoho</span>
            )}
          </div>
        </section>
      )}

      {/* Post LinkedIn */}
      {linkedinPost && (
        <section className="border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700">Post LinkedIn</h3>
            <button
              onClick={handleRegenEmail}
              disabled={regenLoading}
              className="text-xs text-gray-400 hover:text-gray-600 border rounded px-2 py-1 hover:bg-gray-50 disabled:opacity-50"
              title="Regenera también el email"
            >
              {regenLoading ? 'Regenerando…' : '↻ Regenerar'}
            </button>
          </div>
          <textarea
            value={linkedinPost}
            onChange={(e) => setLinkedinPost(e.target.value)}
            rows={10}
            className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <div className="flex items-center justify-between">
            <CopyButton text={linkedinPost} label="Copiar post" />
            <span className="text-xs text-gray-400">{linkedinPost.length} / 1200 chars</span>
          </div>
        </section>
      )}

      {/* Calendario + teléfono */}
      <section className="border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-700">Seguimiento</h3>
        <div className="flex items-center gap-3 flex-wrap">
          <a
            href={buildCalendarLink(lead)}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700"
          >
            Abrir en Google Calendar
          </a>
          {lead.phone && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700 font-mono">{lead.phone}</span>
              <CopyButton text={lead.phone} label="Copiar tel." />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
