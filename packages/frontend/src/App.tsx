import { Routes, Route, NavLink, Link, useSearchParams } from 'react-router-dom';
import LeadList from './pages/LeadList';
import LeadDetail from './pages/LeadDetail';
import AddLead from './pages/AddLead';
import type { LeadStatus } from './types/lead';

const NAV_STATUSES: { label: string; status: LeadStatus }[] = [
  { label: 'Revisando',      status: 'REVIEWING' },
  { label: 'Calificados',    status: 'QUALIFIED' },
  { label: 'Analizados',     status: 'ANALYZED' },
  { label: 'Enviados',       status: 'SENT' },
  { label: 'Llamados',       status: 'CALLED' },
  { label: 'Respondidos',    status: 'RESPONDED' },
  { label: 'Sin respuesta',  status: 'NO_RESPONSE' },
  { label: 'Archivados',     status: 'ARCHIVED' },
];

function Nav() {
  const [params] = useSearchParams();
  const current = params.get('status');

  return (
    <nav className="flex items-center gap-1 flex-wrap">
      {NAV_STATUSES.map(({ label, status }) => (
        <NavLink
          key={status}
          to={`/?status=${status}`}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            current === status
              ? 'bg-white text-brand'
              : 'text-white/80 hover:bg-white/20'
          } ${status === 'ARCHIVED' ? 'opacity-60' : ''}`}
        >
          {label}
        </NavLink>
      ))}
      <Link
        to="/leads/new"
        className="ml-2 px-3 py-1 rounded text-sm font-semibold bg-white text-brand hover:bg-white/90 transition-colors"
        title="Añadir lead manualmente"
      >
        + Añadir
      </Link>
    </nav>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-brand text-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <span className="text-xl font-bold tracking-tight">LeadPilot</span>
          <Nav />
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<LeadList />} />
          <Route path="/leads/new" element={<AddLead />} />
          <Route path="/leads/:leadId" element={<LeadDetail />} />
        </Routes>
      </main>
    </div>
  );
}
