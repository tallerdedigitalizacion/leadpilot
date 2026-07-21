import { useEffect, useState, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import StatusBadge from '../components/StatusBadge';
import SponsoredBadge from '../components/SponsoredBadge';
import Timeline from '../components/Timeline';
import AnalysisPanel from '../components/AnalysisPanel';
import ResourcesPanel from '../components/ResourcesPanel';
import type { LeadItem } from '../types/lead';

const RESOURCES_STATUSES = new Set(['ANALYZED', 'SENT', 'ENGAGED', 'BOOKED', 'FOLLOWUP_1', 'FOLLOWUP_2']);
const ACTIVE_STATUSES    = new Set(['QUALIFIED', 'ANALYZED', 'SENT', 'ENGAGED', 'BOOKED', 'FOLLOWUP_1', 'FOLLOWUP_2']);

export default function LeadDetail() {
  const { leadId } = useParams<{ leadId: string }>();
  const navigate = useNavigate();
  const [lead, setLead]           = useState<LeadItem | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [myNotes, setMyNotes]       = useState('');
  const [notesSaved, setNotesSaved] = useState(false);
  const [newEmail, setNewEmail]     = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleAddEmail = async () => {
    if (!lead || !newEmail.trim()) return;
    const trimmed = newEmail.trim().toLowerCase();
    const current = lead.emails ?? [];
    if (current.includes(trimmed) || lead.email === trimmed) return;
    const updated = await api.updateEmails(lead.leadId, [...current, trimmed]);
    setLead(updated);
    setNewEmail('');
  };

  const handleRemoveEmail = async (email: string) => {
    if (!lead) return;
    const updated = await api.updateEmails(lead.leadId, (lead.emails ?? []).filter((e) => e !== email));
    setLead(updated);
  };

  useEffect(() => {
    if (!leadId) return;
    api.getLead(leadId)
      .then((l) => { setLead(l); setMyNotes(l.myNotes ?? ''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [leadId]);

  // Poll mientras el pipeline automático sigue trabajando: QUALIFIED (esperando análisis) o
  // ANALYZED sin reporte todavía (generate-report + auto-envío + LinkedIn corriendo en
  // segundo plano) — sin esto la página queda estática hasta que el usuario refresca a mano.
  const isAutoPipelineRunning = lead?.status === 'QUALIFIED' || (lead?.status === 'ANALYZED' && !lead?.reportHtmlS3Key);
  useEffect(() => {
    if (!isAutoPipelineRunning || !lead) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const updated = await api.getLead(lead.leadId);
        setLead(updated);
      } catch { /* silencio */ }
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [isAutoPipelineRunning, lead?.leadId]);

  const handleArchive = async () => {
    if (!lead) return;
    setActionLoading('archive');
    try {
      const updated = await api.updateStatus(lead.leadId, 'ARCHIVED');
      setLead(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async () => {
    if (!lead) return;
    if (!window.confirm(`¿Eliminar "${lead.businessName}" permanentemente? Esta acción no se puede deshacer.`)) return;
    setActionLoading('delete');
    try {
      await api.deleteLead(lead.leadId);
      navigate('/leads');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error eliminando el lead');
      setActionLoading(null);
    }
  };

  const handleSaveNotes = async () => {
    if (!lead) return;
    setActionLoading('notes');
    try {
      const updated = await api.updateNotes(lead.leadId, myNotes);
      setLead(updated);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error guardando notas');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="animate-spin w-6 h-6 border-2 border-brand border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !lead) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
        {error ?? 'Lead no encontrado'}
      </div>
    );
  }

  const canArchive = ACTIVE_STATUSES.has(lead.status);

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link to={`/leads?status=${lead.status}`} className="hover:text-brand">← Volver</Link>
        <span>/</span>
        <span className="text-gray-800">{lead.businessName}</span>
      </div>

      {/* Header */}
      <div className="bg-white border rounded-lg p-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{lead.businessName}</h1>
            <a
              href={`https://${lead.url}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand hover:underline text-sm"
            >
              {lead.url}
            </a>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {lead.sponsored && <SponsoredBadge />}
            <StatusBadge status={lead.status} />
            {canArchive && (
              <button
                onClick={handleArchive}
                disabled={actionLoading === 'archive'}
                className="px-2.5 py-1 text-xs text-gray-500 border rounded hover:bg-gray-50 hover:text-gray-700 disabled:opacity-50"
                title="Archivar este lead"
              >
                {actionLoading === 'archive' ? '…' : 'Archivar'}
              </button>
            )}
            <button
              onClick={handleDelete}
              disabled={actionLoading === 'delete'}
              className="px-2.5 py-1 text-xs text-red-500 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50"
              title="Eliminar este lead permanentemente"
            >
              {actionLoading === 'delete' ? '…' : 'Eliminar'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          {lead.city && (
            <div><span className="text-gray-400 text-xs block">Ciudad</span>{lead.city}</div>
          )}
          {lead.category && (
            <div><span className="text-gray-400 text-xs block">Sector</span>{lead.category}</div>
          )}
          {lead.phone && (
            <div><span className="text-gray-400 text-xs block">Teléfono</span>
              <span className="font-mono">{lead.phone}</span>
            </div>
          )}
        </div>

        {/* Emails section */}
        <div className="mt-3 pt-3 border-t">
          <span className="text-xs text-gray-400 block mb-2">Emails</span>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {lead.email && (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-100 rounded text-xs text-gray-700">
                {lead.email}
                <span className="text-gray-400 text-[10px] ml-0.5">principal</span>
              </span>
            )}
            {(lead.emails ?? []).map((e) => (
              <span key={e} className="inline-flex items-center gap-1 px-2.5 py-1 bg-indigo-50 rounded text-xs text-indigo-700">
                {e}
                <button
                  onClick={() => handleRemoveEmail(e)}
                  className="text-indigo-300 hover:text-indigo-600 ml-0.5 leading-none"
                  title="Eliminar"
                >
                  ×
                </button>
              </span>
            ))}
            {!lead.email && (lead.emails ?? []).length === 0 && (
              <span className="text-xs text-gray-400 italic">Sin emails</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddEmail()}
              placeholder="Añadir email…"
              className="border rounded px-2.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand w-56"
            />
            <button
              onClick={handleAddEmail}
              disabled={!newEmail.trim()}
              className="px-3 py-1 text-sm border rounded text-gray-600 hover:bg-gray-50 disabled:opacity-40"
            >
              + Añadir
            </button>
          </div>
        </div>
      </div>

      {/* Acciones manuales */}
      {lead.status === 'QUALIFIED' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3">
          <div className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full shrink-0" />
          <p className="text-sm text-blue-700">
            Análisis en curso — PageSpeed + Claude. Espera ~30–60 segundos…
          </p>
        </div>
      )}

      {(lead.status === 'SENT' || lead.status === 'ENGAGED' || lead.status === 'BOOKED' || lead.status === 'FOLLOWUP_1' || lead.status === 'FOLLOWUP_2') && (
        <div className="bg-white border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Seguimiento</h2>
          {lead.status === 'ENGAGED' && (
            <p className="text-xs text-cyan-700 bg-cyan-50 rounded px-2.5 py-1.5 mb-3">
              Hizo clic en el reporte{lead.clickCount ? ` (${lead.clickCount}x)` : ''} — aún no contestó por teléfono/email.
            </p>
          )}
          {(lead.status === 'FOLLOWUP_1' || lead.status === 'FOLLOWUP_2') && (
            <p className="text-xs text-amber-700 bg-amber-50 rounded px-2.5 py-1.5 mb-3">
              Secuencia automática de seguimiento — {lead.status === 'FOLLOWUP_1' ? 'primer' : 'segundo'} email enviado
              {lead.status === 'FOLLOWUP_1' && lead.followup1SentAt
                ? ` el ${new Date(lead.followup1SentAt).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}`
                : ''}
              {lead.status === 'FOLLOWUP_2' && lead.followup2SentAt
                ? ` el ${new Date(lead.followup2SentAt).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}`
                : ''}
              , aún sin respuesta.
            </p>
          )}
          {lead.bookingStartTime && (
            <p className="text-xs text-violet-700 bg-violet-50 rounded px-2.5 py-1.5 mb-3">
              Reunión agendada:{' '}
              {new Date(lead.bookingStartTime).toLocaleString('es-ES', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
              {lead.bookingCancelledAt && <span className="text-red-600 font-medium"> — cancelada</span>}
            </p>
          )}
        </div>
      )}

      {/* Mis notas — siempre editable en estados activos */}
      {ACTIVE_STATUSES.has(lead.status) && (
        <div className="bg-white border rounded-lg p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">Mis notas</h2>
          <p className="text-xs text-gray-400">
            Contexto, observaciones, ángulo de venta… Se incluye en el reporte generado por Claude.
          </p>
          <textarea
            value={myNotes}
            onChange={(e) => setMyNotes(e.target.value)}
            rows={4}
            placeholder="Ej: Sitio muy lento en móvil, probablemente WordPress sin optimizar. Están pagando Google Ads — buena oportunidad."
            className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <button
            onClick={handleSaveNotes}
            disabled={actionLoading === 'notes'}
            className={`px-3 py-1.5 text-sm rounded font-medium transition-colors ${
              notesSaved
                ? 'bg-green-100 text-green-700'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50'
            }`}
          >
            {actionLoading === 'notes' ? 'Guardando…' : notesSaved ? '¡Guardado!' : 'Guardar notas'}
          </button>
        </div>
      )}

      {/* Análisis técnico */}
      <div className="bg-white border rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Análisis técnico</h2>
        <AnalysisPanel lead={lead} onLeadUpdate={setLead} />
      </div>

      {/* Recursos (email, PDF, LinkedIn) */}
      {RESOURCES_STATUSES.has(lead.status) && (
        <div className="bg-white border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Recursos</h2>
          <ResourcesPanel lead={lead} onLeadUpdate={setLead} />
        </div>
      )}

      {/* Timeline */}
      <div className="bg-white border rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Historial</h2>
        <Timeline events={lead.timeline} />
      </div>
    </div>
  );
}
