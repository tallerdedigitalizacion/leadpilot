import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import LeadCard from '../components/LeadCard';
import { api } from '../api/client';
import type { LeadItem, LeadStatus } from '../types/lead';

export default function LeadList() {
  const [searchParams] = useSearchParams();
  const status = (searchParams.get('status') ?? 'ANALYZED') as LeadStatus;

  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLeads([]);
    setError(null);

    api.listLeads(status)
      .then((res) => {
        if (!cancelled) {
          setLeads(res.leads);
          setNextCursor(res.nextCursor);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [status]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const res = await api.listLeads(status, nextCursor);
    setLeads((prev) => [...prev, ...res.leads]);
    setNextCursor(res.nextCursor);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="animate-spin w-6 h-6 border-2 border-brand border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
        Error cargando leads: {error}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-lg font-semibold text-gray-800">
          {status} <span className="text-gray-400 font-normal text-base">({leads.length})</span>
        </h1>
      </div>

      {leads.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-10">No hay leads en este estado.</p>
      ) : (
        <div className="space-y-3">
          {leads.map((lead) => (
            <LeadCard key={lead.leadId} lead={lead} />
          ))}
        </div>
      )}

      {nextCursor && (
        <div className="mt-4 text-center">
          <button
            onClick={loadMore}
            className="px-4 py-2 text-sm text-brand border border-brand rounded hover:bg-brand hover:text-white transition-colors"
          >
            Cargar más
          </button>
        </div>
      )}
    </div>
  );
}
