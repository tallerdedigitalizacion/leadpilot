import { useEffect, useState, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import StatusBadge from '../components/StatusBadge';
import Timeline from '../components/Timeline';
import AnalysisPanel from '../components/AnalysisPanel';
import ResourcesPanel from '../components/ResourcesPanel';
import type { LeadItem } from '../types/lead';

const RESOURCES_STATUSES = new Set(['ANALYZED', 'SENT', 'CALLED', 'RESPONDED', 'NO_RESPONSE']);
const ACTIVE_STATUSES    = new Set(['REVIEWING', 'QUALIFIED', 'ANALYZED', 'SENT', 'CALLED', 'RESPONDED', 'NO_RESPONSE']);

export default function LeadDetail() {
  const { leadId } = useParams<{ leadId: string }>();
  const navigate = useNavigate();
  const [lead, setLead]           = useState<LeadItem | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [note, setNote]           = useState('');
  const [myNotes, setMyNotes]     = useState('');
  const [notesSaved, setNotesSaved] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!leadId) return;
    api.getLead(leadId)
      .then((l) => { setLead(l); setMyNotes(l.myNotes ?? ''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [leadId]);

  // Poll mientras el lead está en QUALIFIED (esperando análisis)
  useEffect(() => {
    if (lead?.status !== 'QUALIFIED') {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const updated = await api.getLead(lead.leadId);
        if (updated.status !== 'QUALIFIED') { setLead(updated); }
      } catch { /* silencio */ }
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [lead?.status, lead?.leadId]);

  const handleAction = async (action: string, status: LeadItem['status'], withNote = false) => {
    if (!lead) return;
    setActionLoading(action);
    try {
      const updated = await api.updateStatus(lead.leadId, status, withNote ? note : undefined);
      setLead(updated);
      setNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setActionLoading(null);
    }
  };

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
      navigate('/');
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
        <Link to={`/?status=${lead.status}`} className="hover:text-brand">← Volver</Link>
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

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
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
          {lead.email && (
            <div><span className="text-gray-400 text-xs block">Email</span>{lead.email}</div>
          )}
        </div>
      </div>

      {/* Acciones manuales */}
      {lead.status === 'REVIEWING' && (
        <div className="bg-white border rounded-lg p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">Calificar</h2>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Nota (opcional)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Motivo o contexto…"
              className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => handleAction('qualify', 'QUALIFIED', true)}
              disabled={actionLoading === 'qualify'}
              className="px-4 py-2 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light disabled:opacity-50"
            >
              {actionLoading === 'qualify' ? 'Calificando…' : 'Calificar'}
            </button>
            <button
              onClick={() => handleAction('discard', 'DISCARDED', true)}
              disabled={actionLoading === 'discard'}
              className="px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded hover:bg-gray-200 disabled:opacity-50"
            >
              {actionLoading === 'discard' ? '…' : 'Descartar'}
            </button>
          </div>
        </div>
      )}

      {lead.status === 'QUALIFIED' && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-center gap-3">
          <div className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full shrink-0" />
          <p className="text-sm text-blue-700">
            Análisis en curso — PageSpeed + Claude. Espera ~30–60 segundos…
          </p>
        </div>
      )}

      {lead.status === 'SENT' && (
        <div className="bg-white border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">Seguimiento</h2>
          <div className="flex gap-2">
            <button
              onClick={() => handleAction('called', 'CALLED')}
              disabled={actionLoading === 'called'}
              className="px-4 py-2 bg-teal-600 text-white text-sm font-medium rounded hover:bg-teal-700 disabled:opacity-50"
            >
              Registrar llamada
            </button>
            <button
              onClick={() => handleAction('responded', 'RESPONDED')}
              disabled={actionLoading === 'responded'}
              className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded hover:bg-green-700 disabled:opacity-50"
            >
              Respondió
            </button>
          </div>
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
      {(lead.status !== 'REVIEWING') && (
        <div className="bg-white border rounded-lg p-5">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Análisis técnico</h2>
          <AnalysisPanel lead={lead} />
        </div>
      )}

      {/* Recursos (email, PDF, LinkedIn, calendario) */}
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
