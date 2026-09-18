import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { hashPassword, verifyPassword } from './passwordHash';
import { signToken } from './jwt';
import { requireAuth } from './middleware';

export const authRouter = Router();

// ----------------------------------------------------------------------------
// POST /api/auth/register
// Crée un nouveau tenant (PME) et son premier utilisateur (rôle OWNER).
// ----------------------------------------------------------------------------
authRouter.post('/register', async (req: Request, res: Response) => {
  const { companyName, email, password } = req.body ?? {};

  if (!companyName || !email || !password) {
    return res.status(400).json({ error: 'companyName, email et password sont requis.' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if ((existing.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Un compte existe déjà avec cet email.' });
    }

    const tenantResult = await client.query<{ id: number; name: string }>(
      `INSERT INTO tenants (name) VALUES ($1) RETURNING id, name`,
      [companyName]
    );
    const tenant = tenantResult.rows[0];

    const passwordHash = await hashPassword(password);
    const userResult = await client.query<{ id: number; email: string; role: string }>(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'OWNER')
       RETURNING id, email, role`,
      [tenant.id, normalizedEmail, passwordHash]
    );
    const user = userResult.rows[0];

    await client.query('COMMIT');

    const token = signToken({ userId: user.id, tenantId: tenant.id });
    res.status(201).json({ token, tenant, user: { id: user.id, email: user.email, role: user.role } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: "Échec de la création du compte.", details: (err as Error).message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------------------
// POST /api/auth/login
// ----------------------------------------------------------------------------
authRouter.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email et password sont requis.' });
  }

  try {
    const result = await pool.query<{
      id: number;
      email: string;
      password_hash: string;
      role: string;
      tenant_id: number;
      tenant_name: string;
    }>(
      `SELECT u.id, u.email, u.password_hash, u.role, t.id AS tenant_id, t.name AS tenant_name
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [String(email).trim().toLowerCase()]
    );

    // Message volontairement identique dans les deux cas (email inconnu /
    // mot de passe incorrect) pour ne pas révéler si un email est enregistré.
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }

    const row = result.rows[0];
    const valid = await verifyPassword(password, row.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Identifiants invalides.' });
    }

    const token = signToken({ userId: row.id, tenantId: row.tenant_id });
    res.json({
      token,
      tenant: { id: row.tenant_id, name: row.tenant_name },
      user: { id: row.id, email: row.email, role: row.role },
    });
  } catch (err) {
    res.status(500).json({ error: 'Échec de la connexion.', details: (err as Error).message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/auth/me
// Renvoie le profil courant à partir du token — utile pour que le frontend
// restaure la session au chargement sans redemander les identifiants.
// ----------------------------------------------------------------------------
authRouter.get('/me', requireAuth, async (req: Request, res: Response) => {
  const { userId, tenantId } = req.auth!;

  try {
    const result = await pool.query<{ id: number; email: string; role: string; tenant_id: number; tenant_name: string }>(
      `SELECT u.id, u.email, u.role, t.id AS tenant_id, t.name AS tenant_name
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 AND t.id = $2`,
      [userId, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable.' });
    }

    const row = result.rows[0];
    res.json({
      user: { id: row.id, email: row.email, role: row.role },
      tenant: { id: row.tenant_id, name: row.tenant_name },
    });
  } catch (err) {
    res.status(500).json({ error: 'Échec de la récupération du profil.', details: (err as Error).message });
  }
});
