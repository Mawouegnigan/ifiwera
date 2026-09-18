#!/usr/bin/env node
/**
 * Ifiwera — script de migration SQL.
 *
 * Applique sql/001_schema.sql puis sql/002_auth_multitenant.sql sur la base
 * cible. Crée la base cible si elle n'existe pas encore (utile pour la base
 * de test "ifiwera_test", qui n'est pas créée par Docker automatiquement).
 *
 * Usage (depuis le dossier backend/, dans Anaconda Prompt avec
 * `conda activate ifiwera-node`) :
 *
 *   node scripts/migrate.js                 -> migre "ifiwera" (base de dev)
 *   node scripts/migrate.js ifiwera_test     -> migre "ifiwera_test" (base de test)
 *
 * Les identifiants de connexion sont lus depuis les variables d'environnement
 * PGHOST / PGPORT / PGUSER / PGPASSWORD (mêmes noms que dans src/db.ts),
 * avec les mêmes valeurs par défaut que le docker-compose.yml fourni.
 *
 * IMPORTANT : les fichiers SQL utilisent des clauses idempotentes
 * (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS...) SAUF les
 * `ADD CONSTRAINT` dans 002_auth_multitenant.sql, qui échoueront si on relance
 * les migrations sur une base déjà migrée. C'est un comportement normal
 * d'outil de migration : on ne relance pas les mêmes migrations deux fois sur
 * la même base. Pour une base de test qu'on veut repartir de zéro, utiliser
 * `docker compose down -v` puis `docker compose up -d` avant de re-migrer.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const HOST = process.env.PGHOST || 'localhost';
const PORT = Number(process.env.PGPORT) || 5432;
const USER = process.env.PGUSER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || 'postgres';
const TARGET_DB = process.argv[2] || process.env.PGDATABASE || 'ifiwera';

// backend/scripts/migrate.js -> ../.. -> racine du projet -> /sql
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'sql');
const MIGRATION_FILES = ['001_schema.sql', '002_auth_multitenant.sql', '003_partial_payments.sql'];

async function ensureDatabaseExists() {
  const admin = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: 'postgres' });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TARGET_DB]);
    if (rows.length === 0) {
      console.log(`Base "${TARGET_DB}" absente, création...`);
      // Nom de base interpolé directement (CREATE DATABASE ne supporte pas les
      // paramètres liés) ; TARGET_DB vient d'un argument CLI contrôlé par le
      // développeur, pas d'une entrée utilisateur externe.
      await admin.query(`CREATE DATABASE "${TARGET_DB}"`);
    } else {
      console.log(`Base "${TARGET_DB}" déjà présente.`);
    }
  } finally {
    await admin.end();
  }
}

async function applyMigrations() {
  const client = new Client({ host: HOST, port: PORT, user: USER, password: PASSWORD, database: TARGET_DB });
  await client.connect();
  try {
    for (const file of MIGRATION_FILES) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Fichier de migration introuvable : ${fullPath}`);
      }
      const sql = fs.readFileSync(fullPath, 'utf8');
      console.log(`Application de ${file} sur "${TARGET_DB}"...`);
      await client.query(sql);
    }
  } finally {
    await client.end();
  }
}

(async () => {
  try {
    console.log(`Cible : ${USER}@${HOST}:${PORT}/${TARGET_DB}`);
    await ensureDatabaseExists();
    await applyMigrations();
    console.log(`✓ Migrations appliquées avec succès sur "${TARGET_DB}".`);
  } catch (err) {
    console.error('✗ Échec de la migration :', err.message);
    process.exit(1);
  }
})();
