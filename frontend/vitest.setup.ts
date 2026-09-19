// ----------------------------------------------------------------------------
// vitest.setup.ts
//
// Chargé avant chaque fichier de test (voir vitest.config.ts). Deux choses :
// 1) Les matchers jest-dom (toBeInTheDocument, toHaveTextContent, etc.)
// 2) Un stub de ResizeObserver : jsdom ne l'implémente pas nativement, mais
//    Recharts <ResponsiveContainer> (utilisé par ReconciliationDashboard) en
//    a besoin pour calculer ses dimensions. Sans ce stub, ces tests
//    échoueraient avec "ResizeObserver is not defined".
// ----------------------------------------------------------------------------
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// RTL ne s'auto-nettoie PAS entre les tests sous Vitest tant que
// `test.globals: true` n'est pas activé (ce n'est pas notre cas ici,
// volontairement, pour ne pas polluer l'espace global). Sans cet appel
// explicite, chaque render() empile une nouvelle copie du composant dans
// le DOM au lieu de remplacer la précédente — d'où des requêtes
// (getByRole, findByText…) qui trouvent plusieurs éléments ou, pire,
// interceptent silencieusement une instance périmée d'un test précédent.
afterEach(() => {
  // vitest.setup.ts se charge pour TOUS les tests, y compris ceux de lib/
  // qui tournent en environnement 'node' (voir environmentMatchGlobs) et
  // n'ont donc pas de `document` — cleanup() y planterait sinon.
  if (typeof document !== 'undefined') {
    cleanup();
  }
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!('ResizeObserver' in globalThis)) {
  // @ts-expect-error - jsdom ne fournit pas ResizeObserver
  globalThis.ResizeObserver = ResizeObserverStub;
}

// Le File de jsdom (utilisé par les tests de composants, cf.
// environmentMatchGlobs dans vitest.config.ts) n'implémente pas correctement
// .text() ni .arrayBuffer() dans cette version — contrairement au File natif
// de Node utilisé par lib/. On les remplace systématiquement en environnement
// DOM (sans se fier à une détection typeof ... !== 'function', qui s'est
// révélée peu fiable : la méthode existe parfois, héritée de Blob.prototype,
// mais reste non fonctionnelle). On comble via FileReader, que jsdom supporte
// correctement.
if (typeof document !== 'undefined' && typeof File !== 'undefined') {
  File.prototype.text = function (this: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };

  File.prototype.arrayBuffer = function (this: File) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}