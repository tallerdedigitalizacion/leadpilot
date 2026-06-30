import type { LeadItem } from '../types/lead';

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
  label: string;
  value: number | undefined;
  unit: string;
  target: string;
  good: boolean | null;
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

function PageSpeedStatus({ label, score }: {
  label: string;
  score: NonNullable<LeadItem['pagespeedMobile']>;
}) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{label}</h4>
      <div className="grid grid-cols-2 gap-2 mb-4">
        <MetricCard
          label="Performance"
          value={score.performance}
          unit="/100"
          target="≥90"
          good={score.performance >= 90 ? true : score.performance >= 50 ? null : false}
        />
        <MetricCard
          label="LCP"
          value={score.lcp}
          unit="s"
          target="<2.5s"
          good={score.lcp !== undefined ? score.lcp < 2.5 : null}
        />
        <MetricCard
          label="TBT"
          value={score.tbt}
          unit="ms"
          target="<200ms"
          good={score.tbt !== undefined ? score.tbt < 200 : null}
        />
        <MetricCard
          label="Speed Index"
          value={score.speedIndex}
          unit="s"
          target="<3.4s"
          good={score.speedIndex !== undefined ? score.speedIndex < 3.4 : null}
        />
      </div>
      <div className="space-y-2">
        <ScoreBar label="Performance" value={score.performance} />
        <ScoreBar label="Accesibilidad" value={score.accessibility} />
        <ScoreBar label="SEO" value={score.seo} />
        <ScoreBar label="Best Practices" value={score.bestPractices} />
      </div>
    </div>
  );
}

export default function AnalysisPanel({ lead }: { lead: LeadItem }) {
  const hasMobile  = Boolean(lead.pagespeedMobile);
  const hasDesktop = Boolean(lead.pagespeedDesktop);
  const hasAnalysis = Boolean(lead.aiWebAnalysis);

  return (
    <div className="space-y-6">
      {/* PageSpeed availability indicator */}
      <div className="flex gap-4 text-sm">
        <span className={`flex items-center gap-1.5 ${hasMobile ? 'text-green-600' : 'text-gray-400'}`}>
          <span>{hasMobile ? '✓' : '✗'}</span> PageSpeed Mobile
        </span>
        <span className={`flex items-center gap-1.5 ${hasDesktop ? 'text-green-600' : 'text-gray-400'}`}>
          <span>{hasDesktop ? '✓' : '✗'}</span> PageSpeed Desktop
        </span>
        <span className={`flex items-center gap-1.5 ${hasAnalysis ? 'text-green-600' : 'text-gray-400'}`}>
          <span>{hasAnalysis ? '✓' : '✗'}</span> Análisis Claude
        </span>
      </div>

      {lead.pagespeedMobile && (
        <PageSpeedStatus label="Mobile" score={lead.pagespeedMobile} />
      )}
      {lead.pagespeedDesktop && (
        <div className="pt-2 border-t">
          <PageSpeedStatus label="Desktop" score={lead.pagespeedDesktop} />
        </div>
      )}

      {lead.aiWebAnalysis && (
        <div>
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Análisis técnico</h4>
          <pre className="whitespace-pre-wrap text-sm text-gray-700 bg-gray-50 rounded-lg p-4 font-sans leading-relaxed">
            {lead.aiWebAnalysis}
          </pre>
        </div>
      )}

      {!hasMobile && !hasDesktop && !hasAnalysis && (
        <p className="text-sm text-gray-400 italic">Sin datos de análisis todavía.</p>
      )}
    </div>
  );
}
