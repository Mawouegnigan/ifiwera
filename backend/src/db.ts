import { Pool } from 'pg';

export const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'ifiwera',
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Évite qu'une erreur de connexion inattendue ne crashe tout le process
  // eslint-disable-next-line no-console
  console.error('[pg pool] erreur inattendue sur un client inactif', err);
});
