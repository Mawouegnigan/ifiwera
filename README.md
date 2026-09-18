# Support Excel (.xlsx/.xls) — Écran 1 (Import)

## Contenu de ce livrable

```
frontend/lib/fileParsers.ts              # remplace le fichier existant
frontend/ImportWorkspace.tsx             # remplace le fichier existant
frontend/lib/__tests__/fileParsers.test.ts   # nouveau
frontend/vitest.config.ts                # nouveau (le frontend n'avait pas encore de config de test)
```

À copier-coller aux mêmes emplacements dans `ifiwera/`.

## Ce qui change

- **`fileParsers.ts`** : ajout de `parseInvoicesExcel()` et
  `parseTransactionsExcel()`, basés sur **SheetJS** (`xlsx`). Ils lisent la
  première feuille du classeur, convertissent chaque cellule en texte
  (`cellToString`) puis réutilisent **exactement** la même logique de mapping
  de colonnes et de validation que le CSV (`buildInvoicesFromRows` /
  `buildTransactionsFromRows`, extraites du code existant sans changement de
  comportement pour le CSV).
  - Les cellules Date natives d'Excel sont lues comme de vrais objets `Date`
    (`cellDates: true`), donc converties en ISO directement — plus fiable
    que du texte à reparser.
  - Les cellules numériques restent des nombres → jamais d'ambiguïté avec la
    virgule décimale FR (qui ne concerne que le texte collé/exporté en CSV).
  - **Limite assumée, propre à Excel** : un téléphone saisi comme *nombre*
    dans le classeur perd son zéro initial (comportement d'Excel, pas du
    parseur). À signaler à vos utilisateurs si besoin — formater la colonne
    téléphone en "Texte" avant export évite le problème.
  - Le chargement de la librairie `xlsx` est fait en **import dynamique**
    (`await import('xlsx')`), donc seulement quand un fichier Excel est
    effectivement déposé — n'alourdit pas le chargement initial de l'écran.
  - `readWorkbookRows()` accepte un `File` (usage normal dans le composant)
    **ou** un `ArrayBuffer` directement, ce qui permet de tester le parseur
    sans DOM ni `File` (voir les tests).

- **`ImportWorkspace.tsx`** : les fichiers `.xlsx`/`.xls` ne tombent plus
  dans le message "non supporté" — ils sont traités comme les CSV/JSON
  (mêmes états `parsing` → `ready`/`error`, mêmes issues affichées). Seul le
  PDF (OCR, chantier suivant) reste marqué non supporté. Les textes d'aide de
  l'UI mentionnent maintenant "CSV, JSON, Excel (.xlsx)".

## Installation requise

Dans `frontend/` :

```
npm install xlsx
npm install -D vitest
```

(`xlsx` est une dépendance d'exécution — elle est chargée dans le navigateur ;
`vitest` n'existait pas encore côté frontend, seulement côté backend.)

## Lancer les tests

Depuis `frontend/` (environnement conda `ifiwera-node` activé) :

```
npx vitest run
```

19 tests : `detectExtension`, `guessSourceChannel`, CSV (factures et
transactions, y compris délimiteur `;` et virgule décimale FR), JSON, et
Excel — construit entièrement **en mémoire** via `XLSX.utils.aoa_to_sheet` +
`XLSX.write(..., { type: 'array' })`, donc aucun fichier `.xlsx` de test à
committer et aucune dépendance au DOM/`File` du navigateur (un test vérifie
quand même explicitement le chemin `File`, disponible nativement sous
Node 20+).

## Ce qui reste hors périmètre

- **OCR PDF** pour les factures — toujours non commencé (item 3 de la liste
  de priorités).
- Le classeur Excel n'est lu que sur sa **première feuille** — si vos
  exports utilisent plusieurs onglets, dites-le moi et j'ajoute un sélecteur
  de feuille dans l'UI.
