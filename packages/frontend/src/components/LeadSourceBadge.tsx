export default function LeadSourceBadge({ source }: { source: 'maps' | 'serp' }) {
  const label = source === 'serp' ? 'SERP' : 'Maps';
  const cls = source === 'serp' ? 'bg-sky-100 text-sky-700' : 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {label}
    </span>
  );
}
