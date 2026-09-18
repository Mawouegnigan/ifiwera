import { afterAll } from 'vitest';

// Exécuté avant le chargement de chaque fichier de test de cette suite
// (setupFiles vitest), donc AVANT que matchingEngine.ts / routes.ts /
// db.ts ne soient importés — le Pool pg de src/db.ts est construit à partir
// de ces variables d'environnement au moment de l'import.
//
// PGDATABASE est forcé sans condition : cette suite ne doit JAMAIS pouvoir
// s'exécuter par erreur contre la base de développement "ifiwera" (on y fait
// des TRUNCATE entre chaque test).
process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGPORT = process.env.PGPORT || '5432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'postgres';
process.env.PGDATABASE = 'ifiwera_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-vitest-only';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

// Chaque fichier de test a son propre graphe de modules (isolation vitest par
// défaut), donc son propre Pool pg importé depuis '../db' : on ferme ce pool
// à la fin de CE fichier, sans affecter les autres fichiers de la suite.
afterAll(async () => {
  const { pool } = await import('../db');
  await pool.end();
});
