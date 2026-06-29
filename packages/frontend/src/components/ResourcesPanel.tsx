import { useState } from 'react';
import CopyButton from './CopyButton';
import { api } from '../api/client';
import type { LeadItem } from '../types/lead';

interface Props {
  lead: LeadItem;
  onLeadUpdate: (lead: LeadItem) => void;
}

export default function ResourcesPanel({ lead, onLeadUpdate }: Props) {
  const [emailSubject, setEmailSubject] = useState(lead.emailSubject ?? '');
  const [emailBody, setEmailBody] = useState(lead.emailBody ?? '');
  const [linkedinPost, setLinkedinPost] = useState(lead.linkedinPost ?? '');
  const [sending, setSending] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGenerateReport = async () => {
    setGeneratingReport(true);
    setError(null);
    try {
      await api.generateReport(lead.leadId);
      const updated = await api.getLead(lead.leadId);
      onLeadUpdate(updated);
      setEmailSubject(updated.emailSubject ?? '');
      setEmailBody(updated.emailBody ?? '');
      setLinkedinPost(updated.linkedinPost ?? '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error generando reporte');
    } finally {
      setGeneratingReport(false);
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

  const hasPdf = Boolean(lead.reportPdfS3Key);
  const canSend = lead.status === 'ANALYZED' && hasPdf && Boolean(lead.email);

  return (
    <div className="space-y-5">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
          {error}
        </div>
      )}

      {/* Generar reporte */}
      {!hasPdf && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
          <p className="text-sm text-indigo-700 mb-3">
            El reporte aún no se ha generado. Genera el HTML + PDF, el email y el post de LinkedIn.
          </p>
          <button
            onClick={handleGenerateReport}
            disabled={generatingReport}
            className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-wait"
          >
            {generatingReport ? 'Generando…' : 'Generar reporte'}
          </button>
        </div>
      )}

      {/* Email */}
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
            rows={6}
            className="w-full border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <CopyButton text={`${emailSubject}\n\n${emailBody}`} label="Copiar email" />
          {canSend && (
            <button
              onClick={handleSendEmail}
              disabled={sending}
              className="px-3 py-1.5 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light disabled:opacity-50 disabled:cursor-wait"
            >
              {sending ? 'Enviando…' : `Enviar a ${lead.email}`}
            </button>
          )}
          {!lead.email && (
            <span className="text-xs text-gray-400">Sin email — envía manualmente</span>
          )}
        </div>
      </section>

      {/* PDF */}
      {hasPdf && (
        <section className="border rounded-lg p-4 space-y-2">
          <h3 className="text-sm font-semibold text-gray-700">Reporte PDF</h3>
          <p className="text-xs text-gray-500">El PDF se adjunta automáticamente al enviar el email via SES.</p>
          <p className="text-xs text-gray-400 font-mono">{lead.reportPdfS3Key}</p>
        </section>
      )}

      {/* Post LinkedIn */}
      {linkedinPost && (
        <section className="border rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Post LinkedIn</h3>
          <textarea
            value={linkedinPost}
            onChange={(e) => setLinkedinPost(e.target.value)}
            rows={8}
            className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <CopyButton text={linkedinPost} label="Copiar post" />
        </section>
      )}

      {/* Evento calendario + teléfono */}
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
