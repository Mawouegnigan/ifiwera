import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // lib/ reste en environnement 'node' (comportement d'origine, avant
    // l'ajout des tests de composants) : le File natif de Node y implémente
    // .arrayBuffer(), contrairement à celui de jsdom. Seuls les tests de
    // composants (racine + __tests__/) ont réellement besoin du DOM.
    environmentMatchGlobs: [['lib/**', 'node']],
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**'],
  },
});