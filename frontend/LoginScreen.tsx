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
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === 'register' && password !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas.');
      return;
    }

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
    <div className="min-h-screen bg-[#1A2422] text-[#E4E7E2] font-sans flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-[#F0EDE6]">Ifiwera</h1>
          <p className="text-sm text-[#9FB0A9] mt-1">Rapprochement financier automatisé</p>
        </div>

        <div className="rounded-lg border border-[#2E3F3C] bg-[#202B29] p-6">
          <div className="flex mb-6 rounded-md bg-[#1A2422] p-1 border border-[#2E3F3C]">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex-1 rounded py-2 text-sm font-medium transition-colors ${
                mode === 'login' ? 'bg-[#4FBF9F] text-[#1A2422]' : 'text-[#9FB0A9] hover:text-[#E4E7E2]'
              }`}
            >
              Connexion
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`flex-1 rounded py-2 text-sm font-medium transition-colors ${
                mode === 'register' ? 'bg-[#C9A24B] text-[#1A2422]' : 'text-[#9FB0A9] hover:text-[#E4E7E2]'
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
                <label htmlFor="companyName" className="block text-xs text-[#9FB0A9] mb-1.5">Nom de l'entreprise</label>
                <input
                  id="companyName"
                  type="text"
                  required
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Ma PME SARL"
                  className="w-full rounded-md bg-[#1A2422] border border-[#3D5751] px-3 py-2 text-sm text-[#E4E7E2] placeholder:text-[#6B7D77] focus:outline-none focus:border-[#4FBF9F]"
                />
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-xs text-[#9FB0A9] mb-1.5">Email</label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vous@entreprise.bj"
                className="w-full rounded-md bg-[#1A2422] border border-[#3D5751] px-3 py-2 text-sm text-[#E4E7E2] placeholder:text-[#6B7D77] focus:outline-none focus:border-[#4FBF9F]"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-xs text-[#9FB0A9] mb-1.5">Mot de passe</label>
              <input
                id="password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="8 caractères minimum"
                className="w-full rounded-md bg-[#1A2422] border border-[#3D5751] px-3 py-2 text-sm text-[#E4E7E2] placeholder:text-[#6B7D77] focus:outline-none focus:border-[#4FBF9F]"
              />
            </div>

            {mode === 'register' && (
              <div>
                <label htmlFor="confirmPassword" className="block text-xs text-[#9FB0A9] mb-1.5">Confirmer le mot de passe</label>
                <input
                  id="confirmPassword"
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Ressaisissez le mot de passe"
                  className="w-full rounded-md bg-[#1A2422] border border-[#3D5751] px-3 py-2 text-sm text-[#E4E7E2] placeholder:text-[#6B7D77] focus:outline-none focus:border-[#4FBF9F]"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-[#4FBF9F] px-4 py-2.5 text-sm font-medium text-[#1A2422] hover:bg-[#63D4B3] disabled:opacity-50 transition-colors"
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
