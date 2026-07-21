import { Link } from 'react-router-dom';
import StatusBadge from './StatusBadge';
import SponsoredBadge from './SponsoredBadge';
import type { LeadItem } from '../types/lead';

export default function LeadCard({ lead }: { lead: LeadItem }) {
  const mobilePerf = lead.pagespeedMobile?.performance;

  return (
    <Link
      to={`/leads/${lead.leadId}`}
      className="block bg-white border rounded-lg p-4 hover:shadow-md hover:border-brand/30 transition-all"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h2 className="font-semibold text-gray-900 truncate">{lead.businessName}</h2>
          <a
            href={`https://${lead.url}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sm text-brand hover:underline truncate block"
          >
            {lead.url}
          </a>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {lead.sponsored && <SponsoredBadge />}
          <StatusBadge status={lead.status} />
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
        {lead.city && <span>{lead.city}</span>}
        {lead.category && <span className="text-gray-400">· {lead.category}</span>}
        {mobilePerf !== undefined && (
          <span className={`font-medium ${
            mobilePerf >= 90 ? 'text-green-600' :
            mobilePerf >= 50 ? 'text-yellow-600' :
            'text-red-600'
          }`}>
            Mobile {mobilePerf}/100
          </span>
        )}
        <span className="ml-auto">
          {new Date(lead.createdAt).toLocaleDateString('es-ES')}
        </span>
      </div>
    </Link>
  );
}
