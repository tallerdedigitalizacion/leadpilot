import { useState, useEffect } from 'react';
import { api } from '../api/client';

const GOAL = 100;
const LS_KEY = 'leadpilot_challenge_start';

const PIPELINE = [
  { label: 'Revisando',     key: 'REVIEWING',   color: '#94a3b8' },
  { label: 'Calificados',   key: 'QUALIFIED',   color: '#eab308' },
  { label: 'Analizados',    key: 'ANALYZED',    color: '#3b82f6' },
  { label: 'Enviados',      key: 'SENT',        color: '#6366f1' },
  { label: 'Interesados',   key: 'ENGAGED',     color: '#06b6d4' },
  { label: 'Agendados',     key: 'BOOKED',      color: '#7c3aed' },
  { label: 'Seguimiento 1', key: 'FOLLOWUP_1',  color: '#f59e0b' },
  { label: 'Seguimiento 2', key: 'FOLLOWUP_2',  color: '#ea580c' },
  { label: 'Llamados',      key: 'CALLED',      color: '#0d9488' },
  { label: 'Respondidos',   key: 'RESPONDED',   color: '#22c55e' },
  { label: 'Sin respuesta', key: 'NO_RESPONSE', color: '#f97316' },
  { label: 'Cerrados',      key: 'CLOSED',      color: '#059669' },
];

function fmt(d: Date) {
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function Dashboard() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [startDate, setStartDate] = useState<string>(() =>
    localStorage.getItem(LS_KEY) ?? new Date().toISOString().split('T')[0]
  );
  const [editingDate, setEditingDate] = useState(false);
  const [tmpDate, setTmpDate] = useState(startDate);

  useEffect(() => {
    api.getStats()
      .then((s) => setCounts(s.counts))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const saveDate = () => {
    setStartDate(tmpDate);
    localStorage.setItem(LS_KEY, tmpDate);
    setEditingDate(false);
  };

  if (loading) return (
    <div className="flex items-center justify-center h-40">
      <div className="animate-spin w-6 h-6 border-2 border-brand border-t-transparent rounded-full" />
    </div>
  );

  if (error || !counts) return (
    <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
      {error ?? 'Error cargando estadísticas'}
    </div>
  );

  // ── Métricas clave ──────────────────────────────────────────────────────────
  const sentTotal   = (counts.SENT ?? 0) + (counts.ENGAGED ?? 0) + (counts.BOOKED ?? 0) + (counts.FOLLOWUP_1 ?? 0) + (counts.FOLLOWUP_2 ?? 0) + (counts.CALLED ?? 0) + (counts.RESPONDED ?? 0) + (counts.NO_RESPONSE ?? 0) + (counts.CLOSED ?? 0);
  const calledTotal = (counts.CALLED ?? 0) + (counts.RESPONDED ?? 0) + (counts.CLOSED ?? 0);
  const closedTotal = counts.CLOSED ?? 0;
  const activeTotal = Object.entries(counts)
    .filter(([s]) => s !== 'ARCHIVED' && s !== 'DISCARDED')
    .reduce((a, [, v]) => a + v, 0);

  const pct = Math.min(100, Math.round((sentTotal / GOAL) * 100));

  // ── Proyección ──────────────────────────────────────────────────────────────
  const start = new Date(startDate + 'T00:00:00');
  const daysElapsed = Math.max(0.5, (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24));
  const rate = sentTotal / daysElapsed;
  const remaining = GOAL - sentTotal;
  const daysToGoal = rate > 0 && remaining > 0 ? Math.ceil(remaining / rate) : null;
  const projectedDate = daysToGoal != null ? new Date(Date.now() + daysToGoal * 24 * 60 * 60 * 1000) : null;

  const convCall  = sentTotal > 0 ? Math.round((calledTotal / sentTotal) * 100) : 0;
  const convClose = sentTotal > 0 ? Math.round((closedTotal / sentTotal) * 100) : 0;

  // Barra pipeline: anchura relativa al mayor valor
  const maxCount = Math.max(...PIPELINE.map((r) => counts[r.key] ?? 0), 1);

  // Color de barra de progreso
  const barColor = pct >= 75 ? 'bg-emerald-500' : pct >= 25 ? 'bg-indigo-500' : 'bg-orange-500';

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* ── Título + fecha inicio ─────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Challenge: 100 Emails</h1>
            <p className="text-sm text-gray-400 mt-0.5">Prospección en US — negocios locales</p>
          </div>
          <div className="text-right text-sm">
            <span className="text-xs text-gray-400 block mb-0.5">Iniciado</span>
            {editingDate ? (
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  value={tmpDate}
                  onChange={(e) => setTmpDate(e.target.value)}
                  className="border rounded px-2 py-0.5 text-sm"
                />
                <button onClick={saveDate} className="text-xs text-indigo-600 hover:underline">OK</button>
                <button onClick={() => setEditingDate(false)} className="text-xs text-gray-400 hover:underline">✕</button>
              </div>
            ) : (
              <button
                onClick={() => { setTmpDate(startDate); setEditingDate(true); }}
                className="text-gray-700 hover:text-indigo-600 hover:underline"
              >
                {fmt(new Date(startDate + 'T00:00:00'))}
              </button>
            )}
          </div>
        </div>

        {/* Barra de progreso */}
        <div className="mt-5">
          <div className="flex items-end justify-between mb-1.5">
            <span className="text-3xl font-bold text-gray-900">{sentTotal}</span>
            <span className="text-sm text-gray-400">/ {GOAL} emails enviados</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-4 overflow-hidden">
            <div
              className={`h-4 rounded-full transition-all ${barColor}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between mt-1.5 text-xs">
            <span className="text-gray-500">{pct}% completado</span>
            {projectedDate && rate > 0 ? (
              <span className="text-gray-500">
                +{rate.toFixed(1)}/día → ~{fmt(projectedDate)}
              </span>
            ) : sentTotal >= GOAL ? (
              <span className="text-emerald-600 font-medium">¡Meta alcanzada!</span>
            ) : (
              <span className="text-gray-400">Registra más envíos para ver proyección</span>
            )}
          </div>
        </div>
      </div>

      {/* ── 4 métricas clave ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total leads', value: activeTotal, color: 'text-gray-700' },
          { label: 'Enviados',    value: sentTotal,   color: 'text-indigo-600' },
          { label: 'Llamados',    value: calledTotal, color: 'text-teal-600' },
          { label: 'Cerrados',    value: closedTotal, color: 'text-emerald-600' },
        ].map((m) => (
          <div key={m.label} className="bg-white border rounded-lg p-4 text-center">
            <div className={`text-3xl font-bold ${m.color}`}>{m.value}</div>
            <div className="text-xs text-gray-400 mt-1">{m.label}</div>
          </div>
        ))}
      </div>

      {/* ── Pipeline ─────────────────────────────────────────────────────────── */}
      <div className="bg-white border rounded-lg p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Pipeline</h2>
        <div className="space-y-2.5">
          {PIPELINE.map(({ label, key, color }) => {
            const n = counts[key] ?? 0;
            const w = Math.round((n / maxCount) * 100);
            return (
              <div key={key} className="flex items-center gap-3">
                <span className="text-xs text-gray-500 w-28 shrink-0">{label}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="h-2.5 rounded-full"
                    style={{ width: `${w}%`, backgroundColor: color }}
                  />
                </div>
                <span className="text-sm font-medium text-gray-700 w-6 text-right shrink-0">{n}</span>
              </div>
            );
          })}
        </div>

        {/* Tasas de conversión */}
        {sentTotal > 0 && (
          <div className="mt-5 pt-4 border-t grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-400 text-xs block mb-0.5">Tasa llamada</span>
              <span className="font-semibold text-gray-800">{convCall}%</span>
              <span className="text-gray-400 text-xs ml-1">({calledTotal}/{sentTotal})</span>
            </div>
            <div>
              <span className="text-gray-400 text-xs block mb-0.5">Tasa cierre</span>
              <span className="font-semibold text-gray-800">{convClose}%</span>
              <span className="text-gray-400 text-xs ml-1">({closedTotal}/{sentTotal})</span>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
