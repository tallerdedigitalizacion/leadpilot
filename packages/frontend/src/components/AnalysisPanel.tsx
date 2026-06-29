import ReactMarkdown from 'react-markdown';
import type { LeadItem } from '../types/lead';

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color =
    value >= 90 ? 'bg-green-500' :
    value >= 50 ? 'bg-yellow-400' :
    'bg-red-500';

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-600 w-28 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div
          className={`h-2 rounded-full ${color} transition-all`}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className={`text-sm font-semibold w-8 text-right ${
        value >= 90 ? 'text-green-600' : value >= 50 ? 'text-yellow-600' : 'text-red-600'
      }`}>
        {value}
      </span>
    </div>
  );
}

function DeviceScores({ label, score }: { label: string; score: NonNullable<LeadItem['pagespeedMobile']> }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{label}</h4>
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
  const hasScores = lead.pagespeedMobile || lead.pagespeedDesktop;

  return (
    <div className="space-y-6">
      {hasScores && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">PageSpeed Insights</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {lead.pagespeedMobile && (
              <DeviceScores label="Mobile" score={lead.pagespeedMobile} />
            )}
            {lead.pagespeedDesktop && (
              <DeviceScores label="Desktop" score={lead.pagespeedDesktop} />
            )}
          </div>
        </div>
      )}

      {lead.aiWebAnalysis && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Análisis de la web</h3>
          <div className="prose prose-sm max-w-none text-gray-700 bg-gray-50 rounded-lg p-4">
            <ReactMarkdown>{lead.aiWebAnalysis}</ReactMarkdown>
          </div>
        </div>
      )}

      {!hasScores && !lead.aiWebAnalysis && (
        <p className="text-sm text-gray-400 italic">Análisis pendiente…</p>
      )}
    </div>
  );
}
