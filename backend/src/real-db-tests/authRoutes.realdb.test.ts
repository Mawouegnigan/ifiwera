import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { pool } from '../db';
import { buildRealApp } from './appHelpers';
import { resetDatabase } from './dbHelpers';

// Le hachage scrypt et la signature JWT s'exécutent déjà "pour de vrai" dans
// les tests mockés (seul le pool pg est simulé). Cette suite ajoute ce que le
// mock ne peut pas garantir : la vraie contrainte UNIQUE sur users.email, et
// un aller-retour complet register -> login -> me contre PostgreSQL.

const app = buildRealApp();

beforeEach(async () => {
  await resetDatabase();
});

describe('Flux register / login / me — vraie base PostgreSQL', () => {
  it('crée un tenant + un utilisateur OWNER, puis permet de se reconnecter avec le même mot de passe', async () => {
    const register = await request(app).post('/api/auth/register').send({
      companyName: 'Boutique Réelle SARL',
      email: 'proprietaire@boutique-reelle.bj',
      password: 'motdepasse-solide',
    });

    expect(register.status).toBe(201);
    expect(register.body.token).toEqual(expect.any(String));
    expect(register.body.user.role).toBe('OWNER');

    const tenantRow = await pool.query('SELECT name FROM tenants WHERE id = $1', [register.body.tenant.id]);
    expect(tenantRow.rows[0].name).toBe('Boutique Réelle SARL');

    const login = await request(app).post('/api/auth/login').send({
      email: 'proprietaire@boutique-reelle.bj',
      password: 'motdepasse-solide',
    });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(register.body.user.id);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.tenant.id).toBe(register.body.tenant.id);
  });

  it("refuse la connexion avec un mauvais mot de passe (vrai scrypt, pas un mock)", async () => {
    await request(app).post('/api/auth/register').send({
      companyName: 'Boutique B',
      email: 'test-b@boutique.bj',
      password: 'bon-mot-de-passe',
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test-b@boutique.bj', password: 'mauvais-mot-de-passe' });

    expect(login.status).toBe(401);
  });

  it("empêche réellement deux comptes avec le même email (contrainte UNIQUE sur users.email)", async () => {
    const payload = { companyName: 'Boutique C', email: 'doublon@boutique.bj', password: 'motdepasse-1' };

    const first = await request(app).post('/api/auth/register').send(payload);
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/auth/register').send({ ...payload, companyName: 'Autre Boutique' });
    expect(second.status).toBe(409);

    // Le tenant du second essai ne doit pas avoir été créé malgré l'échec
    // (BEGIN/ROLLBACK réel autour de la vérification + l'insertion).
    const tenants = await pool.query('SELECT COUNT(*) FROM tenants');
    expect(Number(tenants.rows[0].count)).toBe(1);
  });

  it('refuse /api/auth/me sans token, et avec un token signé avec un mauvais secret', async () => {
    const noToken = await request(app).get('/api/auth/me');
    expect(noToken.status).toBe(401);

    const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOjEsInRlbmFudElkIjoxfQ.signature-invalide';
    const badToken = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${fakeToken}`);
    expect(badToken.status).toBe(401);
  });
});
