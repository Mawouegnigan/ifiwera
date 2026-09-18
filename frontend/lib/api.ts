// ----------------------------------------------------------------------------
// api.ts
//
// Petit wrapper autour de fetch() qui ajoute automatiquement le token Bearer
// à chaque appel vers le backend Ifiwera. Le token est conservé côté
// navigateur (localStorage) : c'est une application web classique, pas un
// composant exécuté dans un environnement sans stockage persistant.
// ----------------------------------------------------------------------------

const TOKEN_STORAGE_KEY = 'ifiwera_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

/**
 * Équivalent de fetch(), avec le header Authorization ajouté automatiquement
 * si un token est présent. En cas de 401 (session expirée ou invalide), le
 * token local est purgé — c'est à l'appelant de décider de la redirection
 * vers l'écran de connexion (pas de window.location forcé ici).
 */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    clearToken();
  }
  return res;
}
