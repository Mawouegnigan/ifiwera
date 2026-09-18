import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, beforeAll, type Mock } from 'vitest';

// On ne mocke QUE le pool pg : le hachage scrypt (passwordHash.ts) et la
// signature JWT (jwt.ts) sont exécutés réellement, comme dans
// passwordHash.test.ts / jwt.test.ts, pour vérifier le comportement de bout
// en bout de la couche route sans dupliquer un mock de crypto.
vi.mock('../../db', () => ({
  pool: {
    connect: vi.fn(),
    query: vi.fn(),
  },
}));

import { pool } from '../../db';
import { authRouter } from '../routes';
import { hashPassword } from '../passwordHash';
import { signToken } from '../jwt';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

function makeMockClient() {
  return { query: vi.fn(), release: vi.fn() };
}

beforeAll(() => {
  // requireAuth (via jwt.ts) exige JWT_SECRET en production uniquement ;
  // on le fixe explicitement pour que les tests soient déterministes quel
  // que soit NODE_ENV sur la machine qui les exécute.
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-vitest-only';
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// POST /api/auth/register
// ============================================================================
describe('POST /api/auth/register', () => {
  it('refuse une requête incomplète', async () => {
    const res = await request(buildApp()).post('/api/auth/register').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('refuse un mot de passe de moins de 8 caractères', async () => {
    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({ companyName: 'ACME', email: 'a@b.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 caractères/);
  });

  it('crée le tenant et le premier utilisateur (rôle OWNER), renvoie un token', async () => {
    const client = makeMockClient();
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // SELECT id FROM users : aucun email existant
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'ACME' }] }) // INSERT tenants RETURNING
      .mockResolvedValueOnce({ rows: [{ id: 9, email: 'a@b.com', role: 'OWNER' }] }) // INSERT users RETURNING
      .mockResolvedValueOnce(undefined); // COMMIT
    (pool.connect as unknown as Mock).mockResolvedValue(client);

    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({ companyName: 'ACME', email: 'A@B.com', password: 'securepass' });

    expect(res.status).toBe(201);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.tenant).toEqual({ id: 5, name: 'ACME' });
    expect(res.body.user).toEqual({ id: 9, email: 'a@b.com', role: 'OWNER' });
    // L'email est normalisé (trim + lowercase) avant la vérification d'unicité
    expect(client.query).toHaveBeenNthCalledWith(2, expect.any(String), ['a@b.com']);
    expect(client.query).toHaveBeenNthCalledWith(5, 'COMMIT');
  });

  it('renvoie 409 et ROLLBACK si un compte existe déjà avec cet email', async () => {
    const client = makeMockClient();
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 3 }] }) // email déjà pris
      .mockResolvedValueOnce(undefined); // ROLLBACK
    (pool.connect as unknown as Mock).mockResolvedValue(client);

    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({ companyName: 'ACME', email: 'a@b.com', password: 'securepass' });

    expect(res.status).toBe(409);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('renvoie 500 et ROLLBACK en cas d\'erreur inattendue', async () => {
    const client = makeMockClient();
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // pas de conflit
      .mockRejectedValueOnce(new Error('connection lost')) // INSERT tenants échoue
      .mockResolvedValueOnce(undefined); // ROLLBACK
    (pool.connect as unknown as Mock).mockResolvedValue(client);

    const res = await request(buildApp())
      .post('/api/auth/register')
      .send({ companyName: 'ACME', email: 'a@b.com', password: 'securepass' });

    expect(res.status).toBe(500);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// POST /api/auth/login
// ============================================================================
describe('POST /api/auth/login', () => {
  it('refuse une requête sans email ou password', async () => {
    const res = await request(buildApp()).post('/api/auth/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(400);
  });

  it('renvoie 401 (message générique) si l\'email est inconnu', async () => {
    (pool.query as unknown as Mock).mockResolvedValue({ rowCount: 0, rows: [] });

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'inconnu@b.com', password: 'whatever1' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Identifiants invalides.');
  });

  it('renvoie 401 (même message générique) si le mot de passe est incorrect', async () => {
    const realHash = await hashPassword('bon-mot-de-passe');
    (pool.query as unknown as Mock).mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          id: 1,
          email: 'a@b.com',
          password_hash: realHash,
          role: 'OWNER',
          tenant_id: 42,
          tenant_name: 'ACME',
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'a@b.com', password: 'mauvais-mot-de-passe' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Identifiants invalides.');
  });

  it('renvoie un token et le profil en cas de succès', async () => {
    const realHash = await hashPassword('bon-mot-de-passe');
    (pool.query as unknown as Mock).mockResolvedValue({
      rowCount: 1,
      rows: [
        {
          id: 1,
          email: 'a@b.com',
          password_hash: realHash,
          role: 'OWNER',
          tenant_id: 42,
          tenant_name: 'ACME',
        },
      ],
    });

    const res = await request(buildApp())
      .post('/api/auth/login')
      .send({ email: 'A@B.com', password: 'bon-mot-de-passe' });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.tenant).toEqual({ id: 42, name: 'ACME' });
    expect(res.body.user).toEqual({ id: 1, email: 'a@b.com', role: 'OWNER' });
  });

  it('renvoie 500 si la requête SQL échoue', async () => {
    (pool.query as unknown as Mock).mockRejectedValue(new Error('db down'));
    const res = await request(buildApp()).post('/api/auth/login').send({ email: 'a@b.com', password: 'whatever1' });
    expect(res.status).toBe(500);
  });
});

// ============================================================================
// GET /api/auth/me
// ============================================================================
describe('GET /api/auth/me', () => {
  it('renvoie 401 sans en-tête Authorization', async () => {
    const res = await request(buildApp()).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('renvoie 401 avec un token invalide', async () => {
    const res = await request(buildApp()).get('/api/auth/me').set('Authorization', 'Bearer token-invalide');
    expect(res.status).toBe(401);
  });

  it('renvoie le profil courant avec un token valide', async () => {
    const token = signToken({ userId: 1, tenantId: 42 });
    (pool.query as unknown as Mock).mockResolvedValue({
      rowCount: 1,
      rows: [{ id: 1, email: 'a@b.com', role: 'OWNER', tenant_id: 42, tenant_name: 'ACME' }],
    });

    const res = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: { id: 1, email: 'a@b.com', role: 'OWNER' },
      tenant: { id: 42, name: 'ACME' },
    });
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [1, 42]);
  });

  it('renvoie 404 si l\'utilisateur du token n\'existe plus', async () => {
    const token = signToken({ userId: 999, tenantId: 42 });
    (pool.query as unknown as Mock).mockResolvedValue({ rowCount: 0, rows: [] });

    const res = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('renvoie 500 si la requête SQL échoue', async () => {
    const token = signToken({ userId: 1, tenantId: 42 });
    (pool.query as unknown as Mock).mockRejectedValue(new Error('db down'));

    const res = await request(buildApp()).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
  });
});
