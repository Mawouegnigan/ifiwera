import { Client } from 'pg';

// globalSetup s'exécute UNE FOIS avant tous les fichiers de la suite, dans un
// contexte séparé des setupFiles : on redéfinit donc explicitement la
// connexion ici plutôt que de dépendre de env.setup.ts.
const HOST = process.env.PGHOST || 'localhost';
const PORT = Number(process.env.PGPORT) || 5432;
const USER = process.env.PGUSER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || 'postgres';
const DATABASE = 'ifiwera_test';

export default async function globalSetup() {
  const client = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: DATABASE });

  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      [
        `Impossible de se connecter à PostgreSQL (base "${DATABASE}" sur ${HOST}:${PORT}).`,
        'Vérifiez que le conteneur Docker tourne :  docker compose up -d',
        'Puis appliquez les migrations :             npm run db:migrate:test',
        `Détail technique : ${(err as Error).message}`,
      ].join('\n')
    );
  }

  try {
    const check = await client.query<{ t: string | null }>("SELECT to_regclass('public.tenants') AS t");
    if (!check.rows[0].t) {
      throw new Error(
        [
          `La base "${DATABASE}" existe mais les migrations n'ont pas été appliquées (table "tenants" introuvable).`,
          'Lancez :  npm run db:migrate:test',
        ].join('\n')
      );
    }
  } finally {
    await client.end();
  }
}
