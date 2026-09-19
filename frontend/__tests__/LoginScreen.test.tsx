import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoginScreen from '../LoginScreen';
import { apiFetch, setToken } from '../lib/api';

// ----------------------------------------------------------------------------
// lib/api est mocké dans son ensemble : ces tests vérifient le comportement
// du composant (affichage, validation, appels), pas le vrai réseau ni
// localStorage — ça, c'est déjà couvert ailleurs si besoin.
// ----------------------------------------------------------------------------
vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(),
  setToken: vi.fn(),
}));

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('LoginScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("affiche le formulaire de connexion par défaut, sans les champs d'inscription", () => {
    render(<LoginScreen onAuthenticated={vi.fn()} />);

    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mot de passe/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/nom de l'entreprise/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /se connecter/i })).toBeInTheDocument();
  });

  it("bascule vers le mode inscription et affiche les champs supplémentaires", async () => {
    const user = userEvent.setup();
    render(<LoginScreen onAuthenticated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /créer un compte/i }));

    expect(screen.getByLabelText(/nom de l'entreprise/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirmer le mot de passe/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /créer mon compte/i })).toBeInTheDocument();
  });

  it('refuse la soumission en inscription si les mots de passe ne correspondent pas, sans appeler apiFetch', async () => {
    const user = userEvent.setup();
    render(<LoginScreen onAuthenticated={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: /créer un compte/i }));
    await user.type(screen.getByLabelText(/nom de l'entreprise/i), 'Ma PME SARL');
    await user.type(screen.getByLabelText(/^email$/i), 'test@entreprise.bj');
    await user.type(screen.getByLabelText(/^mot de passe$/i), 'motdepasse123');
    await user.type(screen.getByLabelText(/confirmer le mot de passe/i), 'autrechose123');
    await user.click(screen.getByRole('button', { name: /créer mon compte/i }));

    expect(await screen.findByText(/ne correspondent pas/i)).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('connecte avec succès : appelle apiFetch sur /api/auth/login, stocke le token, notifie le parent', async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    const payload = { token: 'jwt-abc', tenant: { id: 1, name: 'Ma PME' }, user: { id: 1, email: 'a@b.bj', role: 'OWNER' } };
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(200, payload));

    render(<LoginScreen onAuthenticated={onAuthenticated} />);
    await user.type(screen.getByLabelText(/^email$/i), 'a@b.bj');
    await user.type(screen.getByLabelText(/mot de passe/i), 'motdepasse123');
    await user.click(screen.getByRole('button', { name: /se connecter/i }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(payload));
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'a@b.bj', password: 'motdepasse123' }) })
    );
    expect(setToken).toHaveBeenCalledWith('jwt-abc');
  });

  it("affiche le message d'erreur renvoyé par le serveur en cas d'échec de connexion", async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(401, { error: 'Identifiants invalides.' }));

    render(<LoginScreen onAuthenticated={vi.fn()} />);
    await user.type(screen.getByLabelText(/^email$/i), 'a@b.bj');
    await user.type(screen.getByLabelText(/mot de passe/i), 'mauvaismotdepasse');
    await user.click(screen.getByRole('button', { name: /se connecter/i }));

    expect(await screen.findByText('Identifiants invalides.')).toBeInTheDocument();
    expect(setToken).not.toHaveBeenCalled();
  });

  it('affiche un message générique si le serveur est injoignable', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('network down'));

    render(<LoginScreen onAuthenticated={vi.fn()} />);
    await user.type(screen.getByLabelText(/^email$/i), 'a@b.bj');
    await user.type(screen.getByLabelText(/mot de passe/i), 'motdepasse123');
    await user.click(screen.getByRole('button', { name: /se connecter/i }));

    expect(await screen.findByText(/impossible de contacter le serveur/i)).toBeInTheDocument();
  });
});
