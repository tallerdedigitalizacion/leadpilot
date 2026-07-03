import type { TimelineEvent } from '../types/lead';

const FAILED_EVENTS = new Set(['EMAIL_SEND_FAILED', 'EMAIL_PREVIEW_FAILED']);
const SENT_EVENTS   = new Set(['EMAIL_SENT', 'EMAIL_PREVIEW_SENT']);

export default function Timeline({ events }: { events: TimelineEvent[] }) {
  const sorted = [...events].sort((a, b) => b.at - a.at);

  return (
    <div className="space-y-2">
      {sorted.map((ev, i) => {
        const failed = FAILED_EVENTS.has(ev.event);
        const sent   = SENT_EVENTS.has(ev.event);
        const to = Array.isArray(ev.meta?.to) ? (ev.meta!.to as string[]) : undefined;

        return (
          <div
            key={i}
            className={`flex items-start gap-3 text-sm ${failed ? 'bg-red-50 -mx-2 px-2 py-1.5 rounded' : ''}`}
          >
            <span className="text-gray-400 whitespace-nowrap mt-0.5">
              {new Date(ev.at).toLocaleString('es-ES', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <div>
              <span
                className={`font-medium ${
                  failed ? 'text-red-700' : sent ? 'text-green-700' : ev.by === 'system' ? 'text-gray-500' : 'text-brand'
                }`}
              >
                {failed && '✗ '}
                {sent && '✓ '}
                {ev.event}
              </span>
              {to && to.length > 0 && (
                <p className={`mt-0.5 ${failed ? 'text-red-600' : 'text-gray-500'}`}>
                  a: {to.join(', ')}
                </p>
              )}
              {ev.note && <p className={`mt-0.5 ${failed ? 'text-red-600 font-medium' : 'text-gray-500'}`}>{ev.note}</p>}
            </div>
            <span className="ml-auto text-xs text-gray-400">{ev.by}</span>
          </div>
        );
      })}
    </div>
  );
}
