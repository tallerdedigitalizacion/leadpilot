import { useState, useEffect, useRef } from 'react';
import CopyButton from './CopyButton';
import { api } from '../api/client';
import type { LeadItem } from '../types/lead';

interface Props {
  lead: LeadItem;
  onLeadUpdate: (lead: LeadItem) => void;
}

export default function ResourcesPanel({ lead, onLeadUpdate }: Props) {
  const [emailSubject, setEmailSubject] = useState(lead.emailSubject ?? '');
  const [emailBody, setEmailBody]       = useState(lead.emailBody ?? '');
  const [linkedinPost, setLinkedinPost] = useState(lead.linkedinPost ?? '');
  const [sending, setSending]           = useState(false);
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

  // Poll si se está generando el reporte (flag en DynamoDB — visible en todos los tabs)
  useEffect(() => {
    if (!isGenerating || hasReport) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }

    let attempts = 0;
    pollRef.current = setInterval(async () => {
      attempts++;
      if (attempts > 40) { // 40 × 5s = 200s → timeout visual
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
  }, [isGenerating, hasReport, lead.leadId, onLeadUpdate]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const handleGenerateReport = async () => {
    setError(null);
    try {
      await api.triggerReport(lead.leadId);
      // El flag isGeneratingReport=true llega con el siguiente poll — refrescamos ya
      const updated = await api.getLead(lead.leadId);
      onLeadUpdate(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al iniciar la generación');
    }
  };

  const handleSendEmail = async () => {
    if (!lead.email) return;
    setSending(true);
    setError(null);
    try {
      const updated = await api.sendEmail(lead.leadId);
      onLeadUpdate(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error enviando email');
    } finally {
      setSending(false);
    }
  };

  const canSend = lead.status === 'ANALYZED' && hasReport && Boolean(lead.email);

  return (
    <div className="space-y-5">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
          {error}
        </div>
      )}

      {/* Generar reporte */}
      {!hasReport && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
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
          ) : !hasNotes ? (
            <div>
              <p className="text-sm font-medium text-indigo-700 mb-1">Añade tus notas primero</p>
              <p className="text-xs text-indigo-500">
                El reporte incluye tus observaciones. Escribe al menos una línea en "Mis notas" antes de generarlo.
              </p>
            </div>
          ) : (
            <>
              <p className="text-sm text-indigo-700 mb-3">
                Genera el reporte HTML, el email frío y el post de LinkedIn.
              </p>
              <button
                onClick={handleGenerateReport}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded hover:bg-indigo-700"
              >
                Generar reporte
              </button>
            </>
          )}
        </div>
      )}

      {hasReport && (
        <div className="flex items-center gap-3 bg-green-50 border border-green-200 rounded-lg px-4 py-2">
          <span className="text-green-600">✓</span>
          <span className="text-sm font-medium text-green-700">Reporte generado</span>
          {lead.reportUrl && (
            <a
              href={lead.reportUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-sm text-indigo-600 hover:underline"
            >
              Ver reporte →
            </a>
          )}
        </div>
      )}

      {/* Email */}
      {(hasReport || lead.emailSubject) && (
        <section className="border rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Email frío</h3>
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
            <label className="text-xs text-gray-500 mb-1 block">Cuerpo</label>
            <textarea
              value={emailBody}
              onChange={(e) => setEmailBody(e.target.value)}
              rows={10}
              className="w-full border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <CopyButton text={emailSubject} label="Copiar asunto" />
            <CopyButton text={emailBody}    label="Copiar cuerpo" />
            <CopyButton text={`${emailSubject}\n\n${emailBody}`} label="Copiar todo" />
            {canSend && (
              <button
                onClick={handleSendEmail}
                disabled={sending}
                className="px-3 py-1.5 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light disabled:opacity-50"
              >
                {sending ? 'Enviando…' : `Enviar a ${lead.email}`}
              </button>
            )}
            {!lead.email && (
              <span className="text-xs text-gray-400">Sin email — envía manualmente</span>
            )}
          </div>
        </section>
      )}

      {/* Post LinkedIn */}
      {linkedinPost && (
        <section className="border rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Post LinkedIn</h3>
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
          {lead.calendarLink ? (
            <a
              href={lead.calendarLink}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700"
            >
              Abrir en Google Calendar
            </a>
          ) : (
            <span className="text-xs text-gray-400">Calendar link disponible tras generar reporte</span>
          )}
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
