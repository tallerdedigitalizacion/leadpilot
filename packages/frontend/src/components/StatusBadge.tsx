import type { LeadStatus } from '../types/lead';

const CONFIG: Record<LeadStatus, { label: string; className: string }> = {
  REVIEWING:    { label: 'Revisando',     className: 'bg-yellow-100 text-yellow-800' },
  DISCARDED:    { label: 'Descartado',    className: 'bg-gray-100 text-gray-500' },
  ARCHIVED:     { label: 'Archivado',     className: 'bg-slate-100 text-slate-500' },
  QUALIFIED:    { label: 'Calificado',    className: 'bg-blue-100 text-blue-800' },
  ANALYZED:     { label: 'Analizado',     className: 'bg-indigo-100 text-indigo-800' },
  SENT:         { label: 'Enviado',       className: 'bg-purple-100 text-purple-800' },
  ENGAGED:      { label: 'Interesado',    className: 'bg-cyan-100 text-cyan-800' },
  BOOKED:       { label: 'Reunión agendada', className: 'bg-violet-100 text-violet-800' },
  FOLLOWUP_1:   { label: 'Seguimiento 1', className: 'bg-amber-100 text-amber-800' },
  FOLLOWUP_2:   { label: 'Seguimiento 2', className: 'bg-orange-100 text-orange-800' },
  CALLED:       { label: 'Llamado',       className: 'bg-teal-100 text-teal-800' },
  RESPONDED:    { label: 'Respondió',     className: 'bg-green-100 text-green-800' },
  NO_RESPONSE:  { label: 'Sin respuesta', className: 'bg-red-100 text-red-700' },
  CLOSED:       { label: 'Cerrado',       className: 'bg-emerald-100 text-emerald-800' },
};

export default function StatusBadge({ status }: { status: LeadStatus }) {
  const { label, className } = CONFIG[status];
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${className}`}>
      {label}
    </span>
  );
}
