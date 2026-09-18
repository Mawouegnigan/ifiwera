import { describe, it, expect, beforeAll } from 'vitest';
import { signToken, verifyToken } from '../jwt';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-ne-pas-utiliser-en-prod';
});

describe('signToken / verifyToken', () => {
  it('vérifie correctement un token qu\'il vient de signer (round-trip)', () => {
    const token = signToken({ userId: 5, tenantId: 12 });
    const decoded = verifyToken(token);
    expect(decoded).toEqual({ userId: 5, tenantId: 12 });
  });

  it('produit un token à 3 parties séparées par des points', () => {
    const token = signToken({ userId: 1, tenantId: 1 });
    expect(token.split('.')).toHaveLength(3);
  });

  it('rejette un token dont la signature a été altérée', () => {
    const token = signToken({ userId: 1, tenantId: 1 });
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
    expect(verifyToken(tampered)).toBeNull();
  });

  it('rejette un token dont le payload a été modifié sans re-signer', () => {
    const token = signToken({ userId: 1, tenantId: 1 });
    const [header, payload, signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ userId: 999, tenantId: 999, iat: 0, exp: 9999999999 })).toString(
      'base64url'
    );
    expect(verifyToken(`${header}.${forgedPayload}.${signature}`)).toBeNull();
  });

  it('rejette un token expiré', () => {
    const expiredToken = signToken({ userId: 1, tenantId: 1 }, -10); // exp dans le passé
    expect(verifyToken(expiredToken)).toBeNull();
  });

  it('rejette un token malformé (pas 3 segments)', () => {
    expect(verifyToken('abc.def')).toBeNull();
    expect(verifyToken('')).toBeNull();
  });

  it('respecte un TTL personnalisé', () => {
    const token = signToken({ userId: 2, tenantId: 3 }, 60 * 60); // 1h
    expect(verifyToken(token)).toEqual({ userId: 2, tenantId: 3 });
  });
});
