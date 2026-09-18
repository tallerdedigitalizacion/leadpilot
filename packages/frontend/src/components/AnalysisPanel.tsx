import { useState, useEffect, useRef } from 'react';
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

// ── Manual PageSpeed raw text form ────────────────────────────────────────────

function RawTextForm({
  strategy,
  leadId,
  existingRaw,
  onSaved,
}: {
  strategy: 'mobile' | 'desktop';
  leadId: string;
  existingRaw?: string;
  onSaved: (lead: LeadItem) => void;
}) {
  const [open, setOpen]     = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [text, setText]     = useState(existingRaw ?? '');

  const handleSave = async () => {
    if (!text.trim()) { setError('El texto no puede estar vacío'); return; }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updatePagespeed(leadId, { strategy, rawText: text });
      onSaved(updated);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error guardando');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="text-xs text-gray-400 hover:text-gray-600 underline-offset-2 hover:underline"
      >
        {open ? 'Cerrar entrada manual' : existingRaw ? 'Editar datos manuales' : 'Introducir manualmente'}
      </button>

      {open && (
        <div className="mt-3 border rounded-lg p-3 bg-gray-50 space-y-3">
          <p className="text-xs text-gray-500">
            Abre <a href="https://pagespeed.web.dev/" target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">pagespeed.web.dev</a>, selecciona el análisis {strategy === 'mobile' ? 'Mobile' : 'Desktop'} y copia todo el contenido de la página aquí.
          </p>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            placeholder="Pega aquí el contenido completo de PageSpeed…"
            className="w-full border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-brand"
          />
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
    if (lead.webAnalysis) return 'claude';
    return 'mobile';
  });
  const [retrying, setRetrying]       = useState(false);
  const [retryQueued, setRetryQueued] = useState(false);
  const [retryMsg, setRetryMsg]       = useState<string | null>(null);
  const [retryError, setRetryError]   = useState<string | null>(null);
  const retryBaseRef = useRef<number | undefined>(undefined);

  const hasMobile   = Boolean(lead.pagespeedMobile || lead.pagespeedMobileRaw);
  const hasDesktop  = Boolean(lead.pagespeedDesktop || lead.pagespeedDesktopRaw);
  const hasAnalysis = Boolean(lead.webAnalysis);

  const handleRetry = async () => {
    setRetrying(true);
    setRetryError(null);
    setRetryMsg(null);
    retryBaseRef.current = lead.analyzedAt;
    try {
      await api.retryAnalysis(lead.leadId);
      setRetryQueued(true);
      setRetryMsg('Análisis iniciado — se actualizará en ~30–60 segundos');
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : 'Error');
    } finally {
      setRetrying(false);
    }
  };

  // Poll after retry until analyzedAt changes
  useEffect(() => {
    if (!retryQueued) return;
    const baseline = retryBaseRef.current;
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 24) {
        clearInterval(interval);
        setRetryQueued(false);
        setRetryMsg('Tarda más de lo esperado — refresca la página');
        return;
      }
      try {
        const updated = await api.getLead(lead.leadId);
        if (updated.analyzedAt !== baseline) {
          clearInterval(interval);
          setRetryQueued(false);
          setRetryMsg(null);
          onLeadUpdate?.(updated);
        }
      } catch { /* reintento silencioso */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [retryQueued, lead.leadId]); // eslint-disable-line react-hooks/exhaustive-deps

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
            disabled={retrying || retryQueued}
            className="px-2.5 py-1 text-xs text-gray-500 border rounded hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1.5"
            title="Reintentar análisis completo (PageSpeed + Claude)"
          >
            {(retrying || retryQueued) && (
              <span className="inline-block w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
            )}
            {retrying ? 'Iniciando…' : retryQueued ? 'Analizando…' : '↻ Reintentar análisis'}
          </button>
        </div>
      </div>

      {/* Retry in-progress message */}
      {retryMsg && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-sm text-blue-700">
          {retryMsg}
        </div>
      )}

      {/* Tab content */}
      {activeTab === 'mobile' && (
        <div>
          {lead.pagespeedMobile ? (
            <PageSpeedScores score={lead.pagespeedMobile} />
          ) : !lead.pagespeedMobileRaw ? (
            <p className="text-sm text-gray-400 italic">Sin datos de PageSpeed Mobile.</p>
          ) : null}
          {lead.pagespeedMobileRaw && (
            <pre className="mt-3 whitespace-pre-wrap text-sm text-gray-700 bg-gray-50 rounded-lg p-4 font-sans leading-relaxed">
              {lead.pagespeedMobileRaw}
            </pre>
          )}
          <RawTextForm
            strategy="mobile"
            leadId={lead.leadId}
            existingRaw={lead.pagespeedMobileRaw}
            onSaved={onLeadUpdate ?? (() => {})}
          />
        </div>
      )}

      {activeTab === 'desktop' && (
        <div>
          {lead.pagespeedDesktop ? (
            <PageSpeedScores score={lead.pagespeedDesktop} />
          ) : !lead.pagespeedDesktopRaw ? (
            <p className="text-sm text-gray-400 italic">Sin datos de PageSpeed Desktop.</p>
          ) : null}
          {lead.pagespeedDesktopRaw && (
            <pre className="mt-3 whitespace-pre-wrap text-sm text-gray-700 bg-gray-50 rounded-lg p-4 font-sans leading-relaxed">
              {lead.pagespeedDesktopRaw}
            </pre>
          )}
          <RawTextForm
            strategy="desktop"
            leadId={lead.leadId}
            existingRaw={lead.pagespeedDesktopRaw}
            onSaved={onLeadUpdate ?? (() => {})}
          />
        </div>
      )}

      {activeTab === 'claude' && (
        <div>
          {lead.webAnalysis ? (
            <div className="space-y-4">
              <div>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Captura analizada</div>
                {lead.screenshotS3Key && lead.screenshotUrl ? (
                  <a href={lead.screenshotUrl} target="_blank" rel="noreferrer" className="block border rounded-lg overflow-hidden">
                    <div className="max-h-[600px] overflow-y-auto bg-gray-50">
                      <img src={lead.screenshotUrl} alt="Captura de la web analizada" className="w-full block" />
                    </div>
                  </a>
                ) : (
                  <p className="text-sm text-gray-400 italic">Sin captura disponible.</p>
                )}
              </div>

              <div className="bg-red-50 border-l-2 border-red-400 rounded p-3">
                <div className="text-xs font-semibold text-red-500 uppercase tracking-wide mb-1">Dolor principal</div>
                <p className="text-sm text-gray-800">{lead.webAnalysis.headlinePain}</p>
              </div>

              <div>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Evaluación visual</div>
                <p className="text-sm text-gray-700 leading-relaxed">{lead.webAnalysis.visualAssessment}</p>
              </div>

              {lead.webAnalysis.performanceSummary.coreWebVitalsIssues.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Core Web Vitals</div>
                  <ul className="text-sm text-gray-700 list-disc list-inside space-y-0.5">
                    {lead.webAnalysis.performanceSummary.coreWebVitalsIssues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </div>
              )}

              {lead.webAnalysis.processHypothesis && (
                <div>
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Proceso manual detectado</div>
                  <p className="text-sm text-gray-800">{lead.webAnalysis.processHypothesis}</p>
                </div>
              )}

              {lead.webAnalysis.frictionSignals && lead.webAnalysis.frictionSignals.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Señales de fricción</div>
                  <ul className="text-sm text-gray-700 list-disc list-inside space-y-0.5">
                    {lead.webAnalysis.frictionSignals.map((signal, i) => (
                      <li key={i}>{signal}</li>
                    ))}
                  </ul>
                </div>
              )}

              {lead.webAnalysis.complianceFlag && (
                <div>
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Cumplimiento / cookies</div>
                  <p className="text-sm text-gray-700">{lead.webAnalysis.complianceFlag}</p>
                </div>
              )}

              {lead.webAnalysis.top3Fixes.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Top 3 fixes</div>
                  <ol className="text-sm text-gray-700 list-decimal list-inside space-y-0.5">
                    {lead.webAnalysis.top3Fixes.map((fix, i) => (
                      <li key={i}>{fix}</li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="bg-gray-50 rounded p-3">
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Gancho de cierre</div>
                <p className="text-sm text-gray-700 italic">{lead.webAnalysis.closingHook}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">Sin análisis de Claude todavía.</p>
          )}
        </div>
      )}
    </div>
  );
}
