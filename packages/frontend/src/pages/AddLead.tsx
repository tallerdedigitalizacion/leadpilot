import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';

interface FormState {
  businessName: string;
  url: string;
  city: string;
  category: string;
  phone: string;
  email: string;
}

const INITIAL: FormState = {
  businessName: '',
  url: '',
  city: '',
  category: '',
  phone: '',
  email: '',
};

export default function AddLead() {
  const navigate = useNavigate();
  const [form, setForm]     = useState<FormState>(INITIAL);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const set = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.businessName.trim() || !form.url.trim()) {
      setError('Nombre y URL son obligatorios');
      return;
    }

    setLoading(true);
    setError(null);

    const url = form.url
      .trim()
      .replace(/^https?:\/\//, '')  // strip protocol if pasted with it
      .replace(/\/$/, '');          // strip trailing slash

    try {
      const result = await api.addLead({
        businessName: form.businessName.trim(),
        url,
        city:     form.city.trim()     || undefined,
        category: form.category.trim() || undefined,
        phone:    form.phone.trim()    || undefined,
        email:    form.email.trim()    || undefined,
      });

      if (result.skipped > 0 && result.created === 0) {
        setError(`Ya existe un lead con la URL "${url}"`);
        setLoading(false);
        return;
      }

      const newId = result.ids[0];
      navigate(newId ? `/leads/${newId}` : '/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-5">
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Link to="/" className="hover:text-brand">← Volver</Link>
        <span>/</span>
        <span className="text-gray-800">Añadir lead</span>
      </div>

      <div className="bg-white border rounded-lg p-6">
        <h1 className="text-lg font-semibold text-gray-900 mb-5">Nuevo lead manual</h1>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-4">
            <Field label="Nombre del negocio *" value={form.businessName} onChange={set('businessName')} placeholder="Glass Well Service" />
            <Field
              label="URL del sitio web *"
              value={form.url}
              onChange={set('url')}
              placeholder="glasswellservice.com"
              hint="Sin https://, sin www. Ej: glasswellservice.com"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Ciudad" value={form.city} onChange={set('city')} placeholder="Dallas, TX" />
            <Field label="Sector / Categoría" value={form.category} onChange={set('category')} placeholder="Auto Glass Repair" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Teléfono" value={form.phone} onChange={set('phone')} placeholder="+1 555 123 4567" type="tel" />
            <Field label="Email" value={form.email} onChange={set('email')} placeholder="owner@business.com" type="email" />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2 bg-brand text-white text-sm font-medium rounded hover:bg-brand-light disabled:opacity-50"
            >
              {loading ? 'Guardando…' : 'Guardar lead'}
            </button>
            <Link
              to="/"
              className="px-4 py-2 text-sm text-gray-600 border rounded hover:bg-gray-50"
            >
              Cancelar
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  hint,
}: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-gray-600 mb-1 block">{label}</label>
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
      />
      {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}
