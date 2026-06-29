import { Routes, Route, NavLink } from 'react-router-dom';
import LeadList from './pages/LeadList';
import LeadDetail from './pages/LeadDetail';
import type { LeadStatus } from './types/lead';

const NAV_STATUSES: { label: string; status: LeadStatus }[] = [
  { label: 'Revisando', status: 'REVIEWING' },
  { label: 'Calificados', status: 'QUALIFIED' },
  { label: 'Analizados', status: 'ANALYZED' },
  { label: 'Enviados', status: 'SENT' },
  { label: 'Llamados', status: 'CALLED' },
  { label: 'Respondidos', status: 'RESPONDED' },
  { label: 'Sin respuesta', status: 'NO_RESPONSE' },
];

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-brand text-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <span className="text-xl font-bold tracking-tight">LeadPilot</span>
          <nav className="flex gap-1 flex-wrap">
            {NAV_STATUSES.map(({ label, status }) => (
              <NavLink
                key={status}
                to={`/?status=${status}`}
                className={({ isActive }) =>
                  `px-3 py-1 rounded text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-white text-brand'
                      : 'text-white/80 hover:bg-white/20'
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<LeadList />} />
          <Route path="/leads/:leadId" element={<LeadDetail />} />
        </Routes>
      </main>
    </div>
  );
}
