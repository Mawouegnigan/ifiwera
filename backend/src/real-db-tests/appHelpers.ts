import express from 'express';
import cors from 'cors';
import { reconciliationRouter } from '../routes/reconciliation';
import { authRouter } from '../auth/routes';
import { requireAuth } from '../auth/middleware';

/**
 * Reconstruit exactement le montage de src/index.ts, mais sans app.listen()
 * (supertest gère lui-même le serveur HTTP éphémère). Aucun mock de '../db' :
 * ces routes s'exécutent contre la vraie base "ifiwera_test".
 */
export function buildRealApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth, reconciliationRouter);
  app.use((_req, res) => {
    res.status(404).json({ error: 'Route non trouvée.' });
  });
  return app;
}
