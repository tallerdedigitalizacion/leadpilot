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
  const [sent, setSent]                 = useState(false);
  const [previewing, setPreviewing]     = useState(false);
  const [previewSent, setPreviewSent]   = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);
  const [markingLinkedin, setMarkingLinkedin] = useState(false);
  const [simulatingFollowup, setSimulatingFollowup] = useState<1 | 2 | 'engaged' | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isGenerating = Boolean(lead.isGeneratingReport);
  const hasReport    = Boolean(lead.reportHtmlS3Key);

  const allEmails = [...new Set([
    ...(lead.email ? [lead.email] : []),
    ...(lead.emails ?? []),
  ])];

  // Derived from the persisted timeline, not local state — survives refresh and reflects
  // the real outcome of the last SES call, not just "the button was clicked".
  const lastRealSend = [...lead.timeline]
    .filter((ev) => ev.event === 'EMAIL_SENT' || ev.event === 'EMAIL_SEND_FAILED')
    .sort((a, b) => b.at - a.at)[0];

  const lastLinkedinPublish = [...lead.timeline]
    .filter((ev) => ev.event === 'LINKEDIN_POST_PUBLISHED')
    .sort((a, b) => b.at - a.at)[0];

  useEffect(() => {
    setEmailSubject(lead.emailSubject ?? '');
    setEmailBody(lead.emailBody ?? '');
    setLinkedinPost(lead.linkedinPost ?? '');
  }, [lead.emailSubject, lead.emailBody, lead.linkedinPost]);

  // Pre-select all emails when they change
  useEffect(() => {
    setSelectedEmails(allEmails);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.email, (lead.emails ?? []).join(',')]);


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
    if (selectedEmails.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const res = await api.sendEmail(lead.leadId, emailSubject, emailBody, false, selectedEmails);
      if (res.lead) onLeadUpdate(res.lead);
      if (res.ok) {
        setSent(true);
      } else {
        setError(`El email NO se envió: ${res.error ?? 'error desconocido'}`);
      }
    } finally {
      setSending(false);
    }
  };

  const handlePreviewEmail = async () => {
    setPreviewing(true);
    setError(null);
    try {
      const res = await api.sendEmail(lead.leadId, emailSubject, emailBody, true);
      if (res.lead) onLeadUpdate(res.lead);
      if (res.ok) {
        setPreviewSent(true);
        setTimeout(() => setPreviewSent(false), 4000);
      } else {
        setError(`La prueba NO se envió: ${res.error ?? 'error desconocido'}`);
      }
    } finally {
      setPreviewing(false);
    }
  };

  const handleSimulateFollowup = async (followupNumber: 1 | 2 | 'engaged') => {
    setSimulatingFollowup(followupNumber);
    setError(null);
    try {
      const res = await api.simulateFollowup(lead.leadId, followupNumber);
      if (res.lead) onLeadUpdate(res.lead);
      if (!res.ok) setError(`No se pudo simular el seguimiento ${followupNumber}: ${res.error ?? 'error desconocido'}`);
    } finally {
      setSimulatingFollowup(null);
    }
  };

  const handleMarkLinkedinPublished = async () => {
    setMarkingLinkedin(true);
    setError(null);
    try {
      const updated = await api.markLinkedinPublished(lead.leadId);
      onLeadUpdate(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al marcar como publicado');
    } finally {
      setMarkingLinkedin(false);
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
          </div>
          <div className="pt-1 border-t space-y-3">
            {lastRealSend && (
              <div
                className={`text-xs px-2.5 py-1.5 rounded ${
                  lastRealSend.event === 'EMAIL_SENT'
                    ? 'bg-green-50 text-green-700'
                    : 'bg-red-50 text-red-700 font-medium'
                }`}
              >
                {lastRealSend.event === 'EMAIL_SENT' ? '✓ Enviado' : '✗ Último envío falló'} el{' '}
                {new Date(lastRealSend.at).toLocaleString('es-ES', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                })}
                {Array.isArray(lastRealSend.meta?.to) && ` a ${(lastRealSend.meta!.to as string[]).join(', ')}`}
                {lastRealSend.event === 'EMAIL_SEND_FAILED' && lastRealSend.note && ` — ${lastRealSend.note}`}
              </div>
            )}

            {/* Enviarme prueba */}
            <button
              onClick={handlePreviewEmail}
              disabled={previewing || previewSent}
              className="px-3 py-1.5 text-sm font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {previewing ? 'Enviando…' : previewSent ? '✓ Prueba enviada a ti' : 'Enviarme prueba'}
            </button>

            {/* Selector de emails */}
            {allEmails.length > 0 && lead.status === 'ANALYZED' && (
              <div>
                <p className="text-xs text-gray-400 mb-1.5">Enviar a:</p>
                <div className="space-y-1 mb-2">
                  {allEmails.map((e) => (
                    <label key={e} className="flex items-center gap-2 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={selectedEmails.includes(e)}
                        onChange={(ev) =>
                          setSelectedEmails((prev) =>
                            ev.target.checked ? [...prev, e] : prev.filter((x) => x !== e)
                          )
                        }
                        className="rounded"
                      />
                      <span className="text-gray-700">{e}</span>
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSendEmail}
                    disabled={sending || sent || selectedEmails.length === 0}
                    className="px-3 py-1.5 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light disabled:opacity-50"
                  >
                    {sending
                      ? 'Enviando…'
                      : sent
                      ? '✓ Enviado'
                      : selectedEmails.length === 1
                      ? `Enviar email a ${selectedEmails[0]}`
                      : `Enviar emails (${selectedEmails.length})`}
                  </button>
                  {allEmails.length > 1 && !sent && (
                    <button
                      onClick={() =>
                        setSelectedEmails(
                          selectedEmails.length === allEmails.length ? [] : allEmails
                        )
                      }
                      className="text-xs text-gray-400 hover:text-gray-600"
                    >
                      {selectedEmails.length === allEmails.length ? 'Deseleccionar todo' : 'Seleccionar todo'}
                    </button>
                  )}
                </div>
              </div>
            )}
            {allEmails.length === 0 && (
              <span className="text-xs text-gray-400">Sin emails — añade uno desde la ficha del lead</span>
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
          <div className="flex items-center gap-3 flex-wrap">
            <CopyButton text={linkedinPost} label="Copiar post" />
            <a
              href="https://www.linkedin.com/company/111909220/admin/page-posts/published/?share=true"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700"
            >
              Publicar en LinkedIn →
            </a>
            <button
              onClick={handleMarkLinkedinPublished}
              disabled={markingLinkedin}
              className="px-3 py-1.5 text-sm font-medium rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {markingLinkedin ? 'Marcando…' : 'Marcar como publicado'}
            </button>
            <span className="text-xs text-gray-400 ml-auto">{linkedinPost.length} / 1200 chars</span>
          </div>
          {lastLinkedinPublish && (
            <div className="text-xs px-2.5 py-1.5 rounded bg-green-50 text-green-700">
              ✓ Publicado ({lastLinkedinPublish.meta?.method === 'automatic' ? 'automático' : 'manual'}) el{' '}
              {new Date(lastLinkedinPublish.at).toLocaleString('es-ES', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
              })}
            </div>
          )}
        </section>
      )}

      {/* Simular seguimiento — prueba manual sin esperar 7/14 días reales */}
      {(lead.status === 'SENT' || lead.status === 'FOLLOWUP_1') && (
        <section className="border rounded-lg p-4 space-y-2 bg-amber-50 border-amber-200">
          <h3 className="text-sm font-semibold text-amber-800">Simular seguimiento (prueba)</h3>
          <p className="text-xs text-amber-700">
            Dispara el email de seguimiento correspondiente ahora mismo, sin esperar los días reales. No consume el freno diario.
          </p>
          <button
            onClick={() => handleSimulateFollowup(lead.status === 'SENT' ? 1 : 2)}
            disabled={simulatingFollowup !== null}
            className="px-3 py-1.5 bg-amber-600 text-white text-sm font-medium rounded hover:bg-amber-700 disabled:opacity-50"
          >
            {simulatingFollowup !== null
              ? 'Enviando…'
              : lead.status === 'SENT'
              ? 'Simular seguimiento 1 (día 7)'
              : 'Simular seguimiento 2 (día 14)'}
          </button>
        </section>
      )}

      {/* Simular seguimiento Rama A — lead ya hizo click en el reporte (ENGAGED) */}
      {lead.status === 'ENGAGED' && (
        <section className="border rounded-lg p-4 space-y-2 bg-amber-50 border-amber-200">
          <h3 className="text-sm font-semibold text-amber-800">Simular seguimiento personalizado (prueba)</h3>
          <p className="text-xs text-amber-700">
            Dispara ahora mismo el email de seguimiento post-click (referencia un hallazgo concreto del reporte), sin esperar los 5 días reales. No consume el freno diario.
          </p>
          <button
            onClick={() => handleSimulateFollowup('engaged')}
            disabled={simulatingFollowup !== null}
            className="px-3 py-1.5 bg-amber-600 text-white text-sm font-medium rounded hover:bg-amber-700 disabled:opacity-50"
          >
            {simulatingFollowup !== null ? 'Enviando…' : 'Simular seguimiento personalizado (post-click)'}
          </button>
        </section>
      )}

      {/* Teléfono */}
      {lead.phone && (
        <section className="border rounded-lg p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Seguimiento</h3>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-700 font-mono">{lead.phone}</span>
            <CopyButton text={lead.phone} label="Copiar tel." />
          </div>
        </section>
      )}
    </div>
  );
}
