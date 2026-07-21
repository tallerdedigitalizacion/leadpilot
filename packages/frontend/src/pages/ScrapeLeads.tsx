import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { ScrapeJob } from '../types/lead';

export default function ScrapeLeads() {
  const [query, setQuery] = useState('');
  const [city, setCity] = useState('');
  const [provider, setProvider] = useState<'gosom' | 'serpapi'>('gosom');
  const [extractEmails, setExtractEmails] = useState(false);
  const [job, setJob] = useState<ScrapeJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isRunning = job && (job.status === 'PENDING' || job.status === 'RUNNING');

  useEffect(() => {
    if (!job || !isRunning) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const updated = await api.getScrapeJob(job.jobId);
        setJob(updated);
      } catch { /* reintento silencioso */ }
    }, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.jobId, isRunning]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim() || !city.trim()) {
      setError('Búsqueda y ciudad son obligatorias');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { jobId } = await api.startScrapeJob({
        query: query.trim(),
        city: city.trim(),
        extractEmails,
        provider,
      });
      setJob({
        jobId,
        status: 'PENDING',
        provider,
        query: query.trim(),
        city: city.trim(),
        extractEmails,
        createdAt: Date.now(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al iniciar la búsqueda');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setJob(null);
    setQuery('');
    setCity('');
    setProvider('gosom');
    setExtractEmails(false);
    setError(null);
  };

  return (
    <div className="max-w-xl mx-auto space-y-5">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link to="/leads" className="hover:text-brand">← Volver</Link>
        <span>/</span>
        <span className="text-gray-800">Scraper de Google Maps</span>
      </div>

      <div className="bg-white border rounded-lg p-6">
        <h1 className="text-lg font-semibold text-gray-900 mb-1">Buscar leads en Google Maps</h1>
        <p className="text-sm text-gray-500 mb-5">
          Los resultados con sitio web se cargan solos — se auto-califican y siguen el pipeline
          automático (análisis, reporte, email) sin ningún paso manual.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm mb-4">
            {error}
          </div>
        )}

        {!job ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field
              label="Búsqueda *"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="auto glass repair"
              hint="Categoría o palabra clave del negocio a buscar"
            />
            <Field
              label="Ciudad *"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Dallas, TX"
            />
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">Proveedor</label>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as 'gosom' | 'serpapi')}
                className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              >
                <option value="gosom">Google Maps Scraper (propio)</option>
                <option value="serpapi">SerpApi (solo patrocinados)</option>
              </select>
            </div>
            <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-700">
              <input
                type="checkbox"
                checked={extractEmails}
                onChange={(e) => setExtractEmails(e.target.checked)}
                className="rounded"
              />
              Buscar también emails (más lento — visita cada sitio)
            </label>
            <div className="flex gap-3 pt-2">
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light disabled:opacity-50"
              >
                {submitting ? 'Iniciando…' : 'Buscar leads'}
              </button>
              <Link to="/leads" className="px-4 py-2 text-sm text-gray-600 border rounded hover:bg-gray-50">
                Cancelar
              </Link>
            </div>
          </form>
        ) : (
          <JobStatus job={job} onReset={handleReset} />
        )}
      </div>
    </div>
  );
}

function JobStatus({ job, onReset }: { job: ScrapeJob; onReset: () => void }) {
  if (job.status === 'PENDING' || job.status === 'RUNNING') {
    return (
      <div className="flex items-center gap-3 bg-indigo-50 rounded p-4">
        <div className="animate-spin w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full shrink-0" />
        <div>
          <p className="text-sm font-medium text-indigo-700">
            Buscando "{job.query}" en {job.city}…
          </p>
          <p className="text-xs text-indigo-500 mt-0.5">
            Puede tardar varios minutos. Esta página se actualiza sola.
          </p>
        </div>
      </div>
    );
  }

  if (job.status === 'FAILED') {
    return (
      <div className="space-y-4">
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
          La búsqueda falló{job.errorMessage ? `: ${job.errorMessage}` : ''}.
        </div>
        <button
          onClick={onReset}
          className="px-4 py-2 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light"
        >
          Nueva búsqueda
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded text-sm">
        <p className="font-medium">Búsqueda completada</p>
        <p className="mt-1">
          {job.resultCount ?? 0} resultados encontrados · {job.createdCount ?? 0} leads creados ·{' '}
          {job.skippedCount ?? 0} saltados (sin sitio web o duplicados)
        </p>
      </div>
      <div className="flex gap-3">
        <Link
          to="/leads?status=QUALIFIED"
          className="px-4 py-2 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light"
        >
          Ver leads calificados →
        </Link>
        <button
          onClick={onReset}
          className="px-4 py-2 text-sm text-gray-600 border rounded hover:bg-gray-50"
        >
          Nueva búsqueda
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-gray-600 mb-1 block">{label}</label>
      <input
        type="text"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
      />
      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}
