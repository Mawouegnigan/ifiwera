import { defineConfig } from 'vitest/config';

// Config séparée du vitest.config.ts principal : cette suite tourne contre une
// VRAIE instance PostgreSQL (via docker-compose.yml à la racine du projet) et
// ne doit jamais s'exécuter avec `npm test` (qui doit rester rapide et ne
// dépendre d'aucune infra externe). On la lance explicitement avec
// `npm run test:db`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/real-db-tests/**/*.test.ts'],
    // Chargé avant chaque fichier de test : force PGDATABASE=ifiwera_test et
    // enregistre la fermeture du pool en fin de fichier (voir env.setup.ts).
    setupFiles: ['./src/real-db-tests/env.setup.ts'],
    // Exécuté une seule fois avant toute la suite : vérifie que Postgres est
    // joignable et que les migrations ont bien été appliquées, avec un
    // message d'erreur explicite sinon (voir globalSetup.ts).
    globalSetup: ['./src/real-db-tests/globalSetup.ts'],
    // Tous les fichiers de cette suite partagent la même base "ifiwera_test" :
    // les exécuter en parallèle provoquerait des interférences entre tests
    // (TRUNCATE d'un fichier pendant qu'un autre lit/écrit).
    fileParallelism: false,
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
