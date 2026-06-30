import { useState } from 'react';
import { api } from '../api/client';
import type { LeadItem, PageSpeedScore } from '../types/lead';

type Tab = 'claude' | 'mobile' | 'desktop';

// ── Subcomponents ──────────────────────────────────────────────────────────────

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value >= 90 ? 'bg-green-500' : value >= 50 ? 'bg-yellow-400' : 'bg-red-500';
  const text  = value >= 90 ? 'text-green-600' : value >= 50 ? 'text-yellow-600' : 'text-red-600';
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-600 w-28 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div className={`h-2 rounded-full ${color} transition-all`} style={{ width: `${value}%` }} />
      </div>
      <span className={`text-sm font-semibold w-8 text-right ${text}`}>{value}</span>
    </div>
  );
}

function MetricCard({ label, value, unit, target, good }: {
  label: string; value: number | undefined; unit: string; target: string; good: boolean | null;
}) {
  const color = good === null ? 'text-gray-500' : good ? 'text-green-600' : 'text-red-500';
  return (
    <div className="bg-gray-50 rounded-lg p-3 text-center">
      <div className="text-xs text-gray-400 mb-1">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>
        {value !== undefined ? `${value}${unit}` : '—'}
      </div>
      <div className="text-xs text-gray-400 mt-0.5">target {target}</div>
    </div>
  );
}

function PageSpeedScores({ score }: { score: PageSpeedScore }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <MetricCard label="Performance"  value={score.performance}  unit="/100" target="≥90"    good={score.performance >= 90 ? true : score.performance >= 50 ? null : false} />
        <MetricCard label="LCP"          value={score.lcp}          unit="s"    target="<2.5s"  good={score.lcp    !== undefined ? score.lcp    < 2.5  : null} />
        <MetricCard label="TBT"          value={score.tbt}          unit="ms"   target="<200ms" good={score.tbt    !== undefined ? score.tbt    < 200  : null} />
        <MetricCard label="Speed Index"  value={score.speedIndex}   unit="s"    target="<3.4s"  good={score.speedIndex !== undefined ? score.speedIndex < 3.4 : null} />
      </div>
      <div className="space-y-2">
        <ScoreBar label="Performance"   value={score.performance} />
        <ScoreBar label="Accesibilidad" value={score.accessibility} />
        <ScoreBar label="SEO"           value={score.seo} />
        <ScoreBar label="Best Practices" value={score.bestPractices} />
      </div>
    </div>
  );
}

// ── Manual PageSpeed form ──────────────────────────────────────────────────────

const EMPTY_MANUAL = { performance: '', accessibility: '', seo: '', bestPractices: '', lcp: '', tbt: '', speedIndex: '' };

function ManualForm({
  strategy,
  leadId,
  existing,
  onSaved,
}: {
  strategy: 'mobile' | 'desktop';
  leadId: string;
  existing?: PageSpeedScore;
  onSaved: (lead: LeadItem) => void;
}) {
  const [open, setOpen]     = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [vals, setVals] = useState(existing ? {
    performance:   existing.performance.toString(),
    accessibility: existing.accessibility.toString(),
    seo:           existing.seo.toString(),
    bestPractices: existing.bestPractices.toString(),
    lcp:           existing.lcp?.toString()        ?? '',
    tbt:           existing.tbt?.toString()        ?? '',
    speedIndex:    existing.speedIndex?.toString() ?? '',
  } : { ...EMPTY_MANUAL });

  const num = (v: string) => v === '' ? undefined : Number(v);

  const handleSave = async () => {
    if (!vals.performance) { setError('Performance es obligatorio'); return; }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updatePagespeed(leadId, {
        strategy,
        performance:   Number(vals.performance),
        accessibility: num(vals.accessibility),
        seo:           num(vals.seo),
        bestPractices: num(vals.bestPractices),
        lcp:           num(vals.lcp),
        tbt:           num(vals.tbt),
        speedIndex:    num(vals.speedIndex),
      });
      onSaved(updated);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error guardando');
    } finally {
      setSaving(false);
    }
  };

  const f = (field: keyof typeof vals, label: string, placeholder: string) => (
    <div>
      <label className="text-xs text-gray-500 block mb-0.5">{label}</label>
      <input
        type="number"
        value={vals[field]}
        onChange={(e) => setVals(v => ({ ...v, [field]: e.target.value }))}
        placeholder={placeholder}
        className="w-full border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand"
      />
    </div>
  );

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs text-gray-400 hover:text-gray-600 underline-offset-2 hover:underline"
      >
        {open ? 'Cerrar entrada manual' : 'Introducir manualmente'}
      </button>

      {open && (
        <div className="mt-3 border rounded-lg p-3 bg-gray-50 space-y-3">
          <p className="text-xs text-gray-500">
            Abre <a href={`https://pagespeed.web.dev/`} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">pagespeed.web.dev</a> y copia los valores aquí.
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-2">
            {f('performance',   'Performance (0–100) *', '42')}
            {f('accessibility', 'Accessibility (0–100)',  '87')}
            {f('seo',           'SEO (0–100)',             '78')}
            {f('bestPractices', 'Best Practices (0–100)', '83')}
            {f('lcp',           'LCP (segundos)',          '4.2')}
            {f('tbt',           'TBT (ms)',                '350')}
            {f('speedIndex',    'Speed Index (seg)',       '5.1')}
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 bg-brand text-white text-xs font-medium rounded hover:bg-brand-light disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AnalysisPanel({
  lead,
  onLeadUpdate,
}: {
  lead: LeadItem;
  onLeadUpdate?: (l: LeadItem) => void;
}) {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    if (lead.pagespeedMobile) return 'mobile';
    if (lead.aiWebAnalysis) return 'claude';
    return 'mobile';
  });
  const [retrying, setRetrying]   = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const hasMobile   = Boolean(lead.pagespeedMobile);
  const hasDesktop  = Boolean(lead.pagespeedDesktop);
  const hasAnalysis = Boolean(lead.aiWebAnalysis);

  const handleRetry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await api.retryAnalysis(lead.leadId);
      // Análisis async — el usuario verá los datos actualizarse via polling normal del LeadDetail
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : 'Error');
    } finally {
      setRetrying(false);
    }
  };

  const tabs: { id: Tab; label: string; has: boolean }[] = [
    { id: 'mobile',  label: 'PageSpeed Mobile',   has: hasMobile },
    { id: 'desktop', label: 'PageSpeed Desktop',  has: hasDesktop },
    { id: 'claude',  label: 'Análisis Claude',    has: hasAnalysis },
  ];

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b">
        {tabs.map(({ id, label, has }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === id
                ? 'border-brand text-brand'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <span className={`mr-1.5 ${has ? 'text-green-500' : 'text-gray-300'}`}>
              {has ? '✓' : '✗'}
            </span>
            {label}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2 pb-1">
          {retryError && <span className="text-xs text-red-500">{retryError}</span>}
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="px-2.5 py-1 text-xs text-gray-500 border rounded hover:bg-gray-50 disabled:opacity-50"
            title="Reintentar análisis completo (PageSpeed + Claude)"
          >
            {retrying ? 'Reintentando…' : '↻ Reintentar análisis'}
          </button>
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'mobile' && (
        <div>
          {hasMobile ? (
            <PageSpeedScores score={lead.pagespeedMobile!} />
          ) : (
            <p className="text-sm text-gray-400 italic">Sin datos de PageSpeed Mobile.</p>
          )}
          <ManualForm
            strategy="mobile"
            leadId={lead.leadId}
            existing={lead.pagespeedMobile}
            onSaved={onLeadUpdate ?? (() => {})}
          />
        </div>
      )}

      {activeTab === 'desktop' && (
        <div>
          {hasDesktop ? (
            <PageSpeedScores score={lead.pagespeedDesktop!} />
          ) : (
            <p className="text-sm text-gray-400 italic">Sin datos de PageSpeed Desktop.</p>
          )}
          <ManualForm
            strategy="desktop"
            leadId={lead.leadId}
            existing={lead.pagespeedDesktop}
            onSaved={onLeadUpdate ?? (() => {})}
          />
        </div>
      )}

      {activeTab === 'claude' && (
        <div>
          {hasAnalysis ? (
            <pre className="whitespace-pre-wrap text-sm text-gray-700 bg-gray-50 rounded-lg p-4 font-sans leading-relaxed">
              {lead.aiWebAnalysis}
            </pre>
          ) : (
            <p className="text-sm text-gray-400 italic">Sin análisis de Claude todavía.</p>
          )}
        </div>
      )}
    </div>
  );
}
