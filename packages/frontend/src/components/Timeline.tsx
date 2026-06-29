import type { TimelineEvent } from '../types/lead';

export default function Timeline({ events }: { events: TimelineEvent[] }) {
  const sorted = [...events].sort((a, b) => b.at - a.at);

  return (
    <div className="space-y-2">
      {sorted.map((ev, i) => (
        <div key={i} className="flex items-start gap-3 text-sm">
          <span className="text-gray-400 whitespace-nowrap mt-0.5">
            {new Date(ev.at).toLocaleString('es-ES', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          <div>
            <span className={`font-medium ${ev.by === 'system' ? 'text-gray-500' : 'text-brand'}`}>
              {ev.event}
            </span>
            {ev.note && <p className="text-gray-500 mt-0.5">{ev.note}</p>}
          </div>
          <span className="ml-auto text-xs text-gray-400">{ev.by}</span>
        </div>
      ))}
    </div>
  );
}
