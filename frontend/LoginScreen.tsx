import React, { useState } from 'react';
import { Loader2, LogIn, UserPlus, AlertTriangle } from 'lucide-react';
import { apiFetch, setToken } from './lib/api';

type Mode = 'login' | 'register';

interface AuthSuccessPayload {
  token: string;
  tenant: { id: number; name: string };
  user: { id: number; email: string; role: string };
}

export default function LoginScreen({
  onAuthenticated,
}: {
  onAuthenticated: (payload: AuthSuccessPayload) => void;
}) {
  const [mode, setMode] = useState<Mode>('login');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body =
        mode === 'login' ? { email, password } : { companyName, email, password };

      const res = await apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Une erreur est survenue.");
        return;
      }

      setToken(data.token);
      onAuthenticated(data as AuthSuccessPayload);
    } catch {
      setError('Impossible de contacter le serveur. Réessayez.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0F1B1A] text-[#E9EDE9] font-sans flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-[#F4F1EA]">Ifiwera</h1>
          <p className="text-sm text-[#8FA39B] mt-1">Rapprochement financier automatisé</p>
        </div>

        <div className="rounded-lg border border-[#243532] bg-[#131E1C] p-6">
          <div className="flex mb-6 rounded-md bg-[#0F1B1A] p-1 border border-[#243532]">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex-1 rounded py-2 text-sm font-medium transition-colors ${
                mode === 'login' ? 'bg-[#4FBF9F] text-[#0F1B1A]' : 'text-[#8FA39B] hover:text-[#E9EDE9]'
              }`}
            >
              Connexion
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`flex-1 rounded py-2 text-sm font-medium transition-colors ${
                mode === 'register' ? 'bg-[#C9A24B] text-[#0F1B1A]' : 'text-[#8FA39B] hover:text-[#E9EDE9]'
              }`}
            >
              Créer un compte
            </button>
          </div>

          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-[#5C3A3A] bg-[#241616] px-3 py-2.5 text-xs text-[#E7B4B4]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'register' && (
              <div>
                <label className="block text-xs text-[#8FA39B] mb-1.5">Nom de l'entreprise</label>
                <input
                  type="text"
                  required
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Ma PME SARL"
                  className="w-full rounded-md bg-[#0F1B1A] border border-[#345048] px-3 py-2 text-sm text-[#E9EDE9] placeholder:text-[#5E736C] focus:outline-none focus:border-[#4FBF9F]"
                />
              </div>
            )}

            <div>
              <label className="block text-xs text-[#8FA39B] mb-1.5">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vous@entreprise.bj"
                className="w-full rounded-md bg-[#0F1B1A] border border-[#345048] px-3 py-2 text-sm text-[#E9EDE9] placeholder:text-[#5E736C] focus:outline-none focus:border-[#4FBF9F]"
              />
            </div>

            <div>
              <label className="block text-xs text-[#8FA39B] mb-1.5">Mot de passe</label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8 caractères minimum"
                className="w-full rounded-md bg-[#0F1B1A] border border-[#345048] px-3 py-2 text-sm text-[#E9EDE9] placeholder:text-[#5E736C] focus:outline-none focus:border-[#4FBF9F]"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-[#4FBF9F] px-4 py-2.5 text-sm font-medium text-[#0F1B1A] hover:bg-[#63D4B3] disabled:opacity-50 transition-colors"
            >
              {loading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : mode === 'login' ? (
                <LogIn size={16} />
              ) : (
                <UserPlus size={16} />
              )}
              {mode === 'login' ? 'Se connecter' : 'Créer mon compte'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
