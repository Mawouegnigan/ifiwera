import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { reconciliationRouter } from './routes/reconciliation';
import { authRouter } from './auth/routes';
import { requireAuth } from './auth/middleware';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // fichiers Excel/CSV convertis en JSON côté client

// Routes publiques (inscription / connexion)
app.use('/api/auth', authRouter);

// Toutes les routes métier exigent un token Bearer valide, qui détermine
// le tenant (req.auth.tenantId) pour lequel la requête est scopée.
app.use('/api', requireAuth, reconciliationRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Route non trouvée.' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Ifiwera backend démarré sur le port ${PORT}`);
});
