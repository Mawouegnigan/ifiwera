import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../passwordHash';

describe('hashPassword / verifyPassword', () => {
  it('produit un hash au format "sel:hash" en hexadécimal', async () => {
    const hash = await hashPassword('Sup3r$ecretPME!');
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });

  it('accepte le mot de passe correct', async () => {
    const hash = await hashPassword('Sup3r$ecretPME!');
    expect(await verifyPassword('Sup3r$ecretPME!', hash)).toBe(true);
  });

  it('rejette un mot de passe incorrect', async () => {
    const hash = await hashPassword('Sup3r$ecretPME!');
    expect(await verifyPassword('mauvais-mot-de-passe', hash)).toBe(false);
  });

  it('génère un sel différent à chaque appel (deux hash différents pour le même mot de passe)', async () => {
    const hash1 = await hashPassword('même-mot-de-passe');
    const hash2 = await hashPassword('même-mot-de-passe');
    expect(hash1).not.toBe(hash2);
    expect(await verifyPassword('même-mot-de-passe', hash1)).toBe(true);
    expect(await verifyPassword('même-mot-de-passe', hash2)).toBe(true);
  });

  it('rejette un format de hash corrompu ou incomplet sans lever d\'exception', async () => {
    expect(await verifyPassword('x', 'formatinvalide')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});
