# Connexion PostgreSQL réelle — Guide d'intégration

Ce livrable ajoute une vraie base PostgreSQL (via Docker) au projet Ifiwera,
sans toucher aux 76 tests existants (qui continuent de tourner contre un pool
`pg` mocké, comme avant, via `npm test`). Une suite **séparée** de tests tourne
désormais contre une vraie instance PostgreSQL.

## 1. Où placer les fichiers

Décompresser l'archive à la racine du projet Ifiwera existant : les chemins
correspondent déjà à l'arborescence en place (`docker-compose.yml` à la
racine, tout le reste sous `backend/`). Les fichiers suivants sont **modifiés**
(ajouts uniquement, rien de retiré) :

- `backend/package.json` — 4 scripts ajoutés
- `backend/tsconfig.json` — nouveau dossier exclu de la compilation
- `backend/vitest.config.ts` — nouveau dossier exclu du rapport de couverture

Tout le reste est nouveau.

## 2. Démarrer PostgreSQL

Dans **Anaconda Prompt** (pas PowerShell), à la racine du projet :

```
docker compose up -d
```

Vérifier que le conteneur est bien démarré et sain :

```
docker compose ps
```

## 3. Appliquer les migrations

Toujours dans Anaconda Prompt, avec `conda activate ifiwera-node` actif,
depuis `backend/` :

```
conda activate ifiwera-node
cd backend
npm run db:migrate
npm run db:migrate:test
```

- `db:migrate` applique `sql/001_schema.sql` et `sql/002_auth_multitenant.sql`
  sur la base de développement `ifiwera`.
- `db:migrate:test` fait la même chose sur une base **séparée** `ifiwera_test`,
  créée automatiquement si elle n'existe pas — c'est celle qu'utilise la
  nouvelle suite de tests réels, jamais `ifiwera`.

Ces commandes sont idempotentes tant qu'on ne les relance pas sur une base
déjà migrée (voir le commentaire en tête de `scripts/migrate.js` : les
`ADD CONSTRAINT` de `002_auth_multitenant.sql` échoueraient sur une
deuxième exécution — comportement normal d'un outil de migration).

## 4. Lancer la nouvelle suite de tests réels

```
npm run test:db
```

Cette commande :
- vérifie d'abord que `ifiwera_test` est joignable et migrée (sinon message
  d'erreur explicite avec la commande à lancer) ;
- exécute les 4 fichiers de `backend/src/real-db-tests/` **séquentiellement**
  (pas en parallèle, puisqu'ils partagent la même base) ;
- vide les tables (`TRUNCATE ... RESTART IDENTITY CASCADE`) avant chaque test
  pour un état déterministe.

`npm test` (la suite existante, 76 tests mockés) continue de fonctionner
normalement, sans Docker, exactement comme avant.

## 5. Ce que cette suite vérifie que le mock ne pouvait pas garantir

| Fichier | Ce qu'il valide en conditions réelles |
|---|---|
| `matchingEngine.realdb.test.ts` | Contraintes `UNIQUE` réelles, vrai `BEGIN/COMMIT/ROLLBACK`, `FOR UPDATE SKIP LOCKED` sur plusieurs passes successives, isolation tenant au niveau SQL |
| `importIdempotency.realdb.test.ts` | `ON CONFLICT (tenant_id, invoice_uid)` / `(tenant_id, reference_api_momo)` `DO NOTHING` pour de vrai, et qu'une erreur en cours de lot déclenche un vrai `ROLLBACK` complet |
| `authRoutes.realdb.test.ts` | Contrainte `UNIQUE` réelle sur `users.email`, aller-retour complet register → login → me avec vrai scrypt et vrai JWT |
| `reconciliationQueries.realdb.test.ts` | Les agrégats SQL de `/reconciliation/summary` (COUNT, SUM, division) et le tri de `/reconciliation/orphans` sur des données réellement insérées |

## 6. Prochaine étape suggérée

Une fois cette suite verte, le socle PostgreSQL est validé de bout en bout
(auth, matching, import, requêtes agrégées). Les chantiers suivants (OCR PDF,
statut `PARTIAL`, Recharts, déploiement) peuvent s'appuyer dessus sans
craindre de mélanger bugs d'infrastructure et bugs de fonctionnalité.
