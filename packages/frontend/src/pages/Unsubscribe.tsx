import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';

type Status = 'loading' | 'ready' | 'confirming' | 'done' | 'error';

export default function Unsubscribe() {
  const { leadId } = useParams<{ leadId: string }>();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('t') ?? '';

  const [status, setStatus] = useState<Status>('loading');
  const [info, setInfo] = useState<{ businessName?: string; email?: string }>({});
  const [error, setError] = useState('This link is no longer valid.');

  useEffect(() => {
    if (!leadId || !token) { setStatus('error'); return; }
    api.getUnsubscribeInfo(leadId, token)
      .then((data) => { setInfo(data); setStatus('ready'); })
      .catch(() => setStatus('error'));
  }, [leadId, token]);

  const handleConfirm = async () => {
    if (!leadId) return;
    setStatus('confirming');
    try {
      await api.confirmUnsubscribe(leadId, token);
      setStatus('done');
    } catch {
      setError('Something went wrong. Please try again.');
      setStatus('error');
    }
  };

  const identity = info.email && info.businessName
    ? `${info.email} (${info.businessName})`
    : info.email || info.businessName || 'this address';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-white border rounded-lg p-8 shadow-sm text-center">
        {status === 'loading' && <p className="text-sm text-gray-500">Loading…</p>}
        {status === 'error' && <p className="text-sm text-gray-700">{error}</p>}
        {status === 'ready' && (
          <>
            <p className="text-sm text-gray-800 mb-5">
              This will unsubscribe <strong>{identity}</strong> from future emails.
            </p>
            <button
              onClick={handleConfirm}
              className="px-5 py-2 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light"
            >
              Confirm unsubscribe
            </button>
          </>
        )}
        {status === 'confirming' && <p className="text-sm text-gray-500">Processing…</p>}
        {status === 'done' && (
          <p className="text-sm text-gray-800">
            You've been unsubscribed. You won't receive any further emails from us.
          </p>
        )}
      </div>
    </div>
  );
}
