import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Request, Response } from 'express';
import { requireAuth } from '../middleware';
import { signToken } from '../jwt';

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-vitest-only';
});

function makeRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('requireAuth', () => {
  it("renvoie 401 si l'en-tête Authorization est absent", () => {
    const req = { headers: {} } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentification requise.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('renvoie 401 si le schéma n\'est pas "Bearer"', () => {
    const req = { headers: { authorization: 'Basic abc123' } } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('renvoie 401 si le token est invalide ou falsifié', () => {
    const req = { headers: { authorization: 'Bearer not-a-real-token' } } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Session invalide ou expirée.' });
    expect(next).not.toHaveBeenCalled();
  });

  it('attache req.auth = { userId, tenantId } et appelle next() avec un token valide', () => {
    const token = signToken({ userId: 7, tenantId: 3 });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(req.auth).toEqual(expect.objectContaining({ userId: 7, tenantId: 3 }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('retire les espaces superflus autour du token avant vérification (.trim())', () => {
    const token = signToken({ userId: 1, tenantId: 1 });
    // Le middleware fait `header.slice('Bearer '.length).trim()`, donc des
    // espaces additionnels après le préfixe "Bearer " ne doivent pas faire
    // échouer la vérification.
    const req = { headers: { authorization: `Bearer   ${token}  ` } } as Request;
    const res = makeRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth).toEqual(expect.objectContaining({ userId: 1, tenantId: 1 }));
    expect(res.status).not.toHaveBeenCalled();
  });
});
