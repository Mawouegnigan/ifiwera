import { Request, Response, NextFunction } from 'express';
import { verifyToken } from './jwt';

/**
 * Exige un token Bearer valide. En cas de succès, attache
 * `req.auth = { userId, tenantId }` pour le reste de la requête — c'est ce
 * qui permet à toutes les routes en aval de scoper leurs requêtes SQL par
 * tenant sans jamais faire confiance à un identifiant fourni par le client.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentification requise.' });
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Session invalide ou expirée.' });
    return;
  }

  req.auth = payload;
  next();
}
