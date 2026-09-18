// ----------------------------------------------------------------------------
// fileParsers.ts
//
// Parseur CSV / JSON / Excel côté navigateur pour l'Écran 1 (Workspace
// d'Importation). Objectif : transformer les exports hétérogènes (DGI/MeCEF,
// MTN MoMo Checking, Moov Money, relevés UBA/BOA/Ecobank) vers le format
// normalisé attendu par les routes backend existantes :
//   POST /api/import/invoices     { invoices: NormalizedInvoice[] }
//   POST /api/import/transactions { transactions: NormalizedTransaction[] }
//
// Le mapping de colonnes est heuristique (basé sur des alias d'en-têtes
// courants en français/anglais). Il ne remplace pas un vrai parseur dédié à
// chaque opérateur/banque, mais couvre déjà les exports CSV/JSON/Excel
// courants sans attendre le backend.
//
// Excel (.xlsx/.xls) : lu via SheetJS (package "xlsx"), uniquement la
// première feuille du classeur. Les cellules sont converties en texte avant
// d'être passées dans le même pipeline de validation que le CSV, pour ne pas
// dupliquer la logique métier (voir buildInvoicesFromRows / buildTransactionsFromRows).
//
// Limitation assumée : l'OCR des PDF n'est PAS supporté ici. Les fichiers PDF
// sont détectés et signalés comme tels par l'appelant (ImportWorkspace.tsx)
// plutôt que de produire un résultat partiel ou silencieusement faux. Autre
// limitation Excel : un numéro de téléphone saisi comme nombre (plutôt que
// texte) dans le classeur perd son zéro initial — comportement d'Excel
// lui-même, pas du parseur ; formatez la colonne téléphone en "Texte" pour
// l'éviter.
// ----------------------------------------------------------------------------

export type SourceChannel =
  | 'MTN_MOMO'
  | 'MOOV_MONEY'
  | 'BANK_UBA'
  | 'BANK_BOA'
  | 'BANK_ECOBANK'
  | 'CASH';

export interface NormalizedInvoice {
  invoice_uid: string;
  customer_name: string | null;
  customer_phone: string | null;
  amount_ttc: number;
  memo_reference: string | null;
  issued_at: string; // ISO
}

export interface NormalizedTransaction {
  reference_api_momo: string;
  source_channel: SourceChannel;
  sender_phone: string | null;
  sender_name: string | null;
  amount_received: number;
  fees: number;
  net_amount: number;
  processed_at: string; // ISO
}

export interface ParseIssue {
  rowIndex: number; // 1-based, en-tête exclu
  reason: string;
}

export interface ParseResult<T> {
  rows: T[];
  issues: ParseIssue[];
  totalRowsInFile: number;
}

export type SupportedExtension = 'csv' | 'json' | 'xlsx' | 'xls';
export type UnsupportedExtension = 'pdf' | 'other';

export function detectExtension(fileName: string): SupportedExtension | UnsupportedExtension {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'csv' || ext === 'txt') return 'csv';
  if (ext === 'json') return 'json';
  if (ext === 'xlsx' || ext === 'xls') return ext;
  if (ext === 'pdf') return 'pdf';
  return 'other';
}

// ----------------------------------------------------------------------------
// Normalisation des en-têtes : minuscule, sans accent, séparateurs uniformisés
// ----------------------------------------------------------------------------
function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // retire les accents
    .trim()
    .toLowerCase()
    .replace(/[°'"]/g, '')
    .replace(/[\s\-]+/g, '_');
}

function findColumn(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.findIndex((h) => h === alias || h.includes(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

// ----------------------------------------------------------------------------
// Détection de délimiteur (virgule ou point-virgule — les exports béninois
// utilisent fréquemment le point-virgule à cause du séparateur décimal FR)
// ----------------------------------------------------------------------------
function detectDelimiter(sampleLine: string): ',' | ';' {
  const semicolons = (sampleLine.match(/;/g) || []).length;
  const commas = (sampleLine.match(/,/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

// Parseur CSV minimal supportant les champs entre guillemets (avec virgules/points-virgules internes)
function parseCsvLines(text: string, delimiter: ',' | ';'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      pushField();
    } else if (c === '\r') {
      // ignoré, géré par \n
    } else if (c === '\n') {
      pushRow();
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

// ----------------------------------------------------------------------------
// Nombres : accepte "12 500", "12,500.00", "12500,50" (virgule décimale FR)
// ----------------------------------------------------------------------------
function parseAmount(raw: string): number | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[^\d,.\-]/g, '');
  if (s === '') return null;
  // Si virgule ET point présents, le dernier séparateur rencontré est le décimal
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    // Une seule virgule -> décimale FR (ex: "12500,50"), plusieurs -> milliers
    const parts = s.split(',');
    s = parts.length === 2 && parts[1].length <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ----------------------------------------------------------------------------
// Dates : ISO, DD/MM/YYYY[ HH:mm[:ss]], DD-MM-YYYY
// ----------------------------------------------------------------------------
function parseDateToIso(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();

  // Déjà ISO ou parsable nativement
  const native = new Date(s);
  if (!isNaN(native.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    return native.toISOString();
  }

  const match = s.match(
    /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (match) {
    const [, dd, mm, yyyyRaw, hh = '0', min = '0', sec = '0'] = match;
    const yyyy = yyyyRaw.length === 2 ? Number(yyyyRaw) + 2000 : Number(yyyyRaw);
    const d = new Date(
      Date.UTC(yyyy, Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(sec))
    );
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}

// ----------------------------------------------------------------------------
// Détection du canal source à partir du nom de fichier (repris/éditable par
// l'utilisateur dans l'UI — voir ImportWorkspace.tsx)
// ----------------------------------------------------------------------------
export function guessSourceChannel(fileName: string): SourceChannel {
  const n = normalizeHeader(fileName);
  if (n.includes('momo') || n.includes('mtn')) return 'MTN_MOMO';
  if (n.includes('moov')) return 'MOOV_MONEY';
  if (n.includes('uba')) return 'BANK_UBA';
  if (n.includes('boa')) return 'BANK_BOA';
  if (n.includes('ecobank') || n.includes('eco_bank')) return 'BANK_ECOBANK';
  return 'CASH';
}

// ----------------------------------------------------------------------------
// Parsing des factures DGI / MeCEF
// ----------------------------------------------------------------------------
const INVOICE_ALIASES = {
  invoice_uid: ['invoice_uid', 'numero_facture', 'num_facture', 'reference_facture', 'facture', 'numero'],
  customer_name: ['customer_name', 'nom_client', 'client'],
  customer_phone: ['customer_phone', 'telephone_client', 'telephone', 'tel'],
  amount_ttc: ['amount_ttc', 'montant_ttc', 'montant', 'total_ttc'],
  memo_reference: ['memo_reference', 'memo', 'reference_memo', 'note'],
  issued_at: ['issued_at', 'date_emission', 'date_facture', 'date'],
};

// Logique de mapping/validation commune au CSV et à l'Excel : les deux
// finissent par produire un tableau de lignes (string[][], en-tête inclus en
// première position) avant d'atterrir ici.
function buildInvoicesFromRows(lines: string[][]): ParseResult<NormalizedInvoice> {
  if (lines.length === 0) return { rows: [], issues: [], totalRowsInFile: 0 };

  const headers = lines[0];
  const col = {
    invoice_uid: findColumn(headers, INVOICE_ALIASES.invoice_uid),
    customer_name: findColumn(headers, INVOICE_ALIASES.customer_name),
    customer_phone: findColumn(headers, INVOICE_ALIASES.customer_phone),
    amount_ttc: findColumn(headers, INVOICE_ALIASES.amount_ttc),
    memo_reference: findColumn(headers, INVOICE_ALIASES.memo_reference),
    issued_at: findColumn(headers, INVOICE_ALIASES.issued_at),
  };

  const rows: NormalizedInvoice[] = [];
  const issues: ParseIssue[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const invoice_uid = col.invoice_uid > -1 ? line[col.invoice_uid]?.trim() : '';
    const amount = col.amount_ttc > -1 ? parseAmount(line[col.amount_ttc]) : null;
    const issuedAtRaw = col.issued_at > -1 ? line[col.issued_at] : '';
    const issuedAt = parseDateToIso(issuedAtRaw ?? '');

    if (!invoice_uid) {
      issues.push({ rowIndex: i, reason: "Numéro de facture manquant ou colonne non reconnue" });
      continue;
    }
    if (amount === null) {
      issues.push({ rowIndex: i, reason: `Montant TTC illisible ("${line[col.amount_ttc] ?? ''}")` });
      continue;
    }
    if (!issuedAt) {
      issues.push({ rowIndex: i, reason: `Date d'émission illisible ("${issuedAtRaw ?? ''}")` });
      continue;
    }

    rows.push({
      invoice_uid,
      customer_name: col.customer_name > -1 ? line[col.customer_name]?.trim() || null : null,
      customer_phone: col.customer_phone > -1 ? line[col.customer_phone]?.trim() || null : null,
      amount_ttc: amount,
      memo_reference: col.memo_reference > -1 ? line[col.memo_reference]?.trim() || null : null,
      issued_at: issuedAt,
    });
  }

  return { rows, issues, totalRowsInFile: lines.length - 1 };
}

export function parseInvoicesCsv(text: string): ParseResult<NormalizedInvoice> {
  const delimiter = detectDelimiter(text.split('\n')[0] ?? '');
  const lines = parseCsvLines(text, delimiter);
  return buildInvoicesFromRows(lines);
}

// ----------------------------------------------------------------------------
// Parsing des relevés opérateurs / banques
// ----------------------------------------------------------------------------
const TRANSACTION_ALIASES = {
  reference_api_momo: ['reference_api_momo', 'reference', 'ref_transaction', 'transaction_id', 'numero_operation', 'id_transaction'],
  sender_phone: ['sender_phone', 'telephone_expediteur', 'numero', 'msisdn', 'telephone'],
  sender_name: ['sender_name', 'nom_expediteur', 'expediteur', 'nom'],
  amount_received: ['amount_received', 'montant_recu', 'montant', 'amount'],
  fees: ['fees', 'frais', 'commission'],
  net_amount: ['net_amount', 'montant_net'],
  processed_at: ['processed_at', 'date_operation', 'date_transaction', 'date'],
};

function buildTransactionsFromRows(
  lines: string[][],
  defaultChannel: SourceChannel
): ParseResult<NormalizedTransaction> {
  if (lines.length === 0) return { rows: [], issues: [], totalRowsInFile: 0 };

  const headers = lines[0];
  const col = {
    reference_api_momo: findColumn(headers, TRANSACTION_ALIASES.reference_api_momo),
    sender_phone: findColumn(headers, TRANSACTION_ALIASES.sender_phone),
    sender_name: findColumn(headers, TRANSACTION_ALIASES.sender_name),
    amount_received: findColumn(headers, TRANSACTION_ALIASES.amount_received),
    fees: findColumn(headers, TRANSACTION_ALIASES.fees),
    net_amount: findColumn(headers, TRANSACTION_ALIASES.net_amount),
    processed_at: findColumn(headers, TRANSACTION_ALIASES.processed_at),
  };

  const rows: NormalizedTransaction[] = [];
  const issues: ParseIssue[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const reference = col.reference_api_momo > -1 ? line[col.reference_api_momo]?.trim() : '';
    const amountReceived = col.amount_received > -1 ? parseAmount(line[col.amount_received]) : null;
    const processedAtRaw = col.processed_at > -1 ? line[col.processed_at] : '';
    const processedAt = parseDateToIso(processedAtRaw ?? '');

    if (!reference) {
      issues.push({ rowIndex: i, reason: 'Référence opérateur manquante ou colonne non reconnue' });
      continue;
    }
    if (amountReceived === null) {
      issues.push({ rowIndex: i, reason: `Montant reçu illisible ("${line[col.amount_received] ?? ''}")` });
      continue;
    }
    if (!processedAt) {
      issues.push({ rowIndex: i, reason: `Date d'opération illisible ("${processedAtRaw ?? ''}")` });
      continue;
    }

    const fees = col.fees > -1 ? parseAmount(line[col.fees]) ?? 0 : 0;
    const netAmount = col.net_amount > -1 ? parseAmount(line[col.net_amount]) ?? amountReceived - fees : amountReceived - fees;

    rows.push({
      reference_api_momo: reference,
      source_channel: defaultChannel,
      sender_phone: col.sender_phone > -1 ? line[col.sender_phone]?.trim() || null : null,
      sender_name: col.sender_name > -1 ? line[col.sender_name]?.trim() || null : null,
      amount_received: amountReceived,
      fees,
      net_amount: netAmount,
      processed_at: processedAt,
    });
  }

  return { rows, issues, totalRowsInFile: lines.length - 1 };
}

export function parseTransactionsCsv(
  text: string,
  defaultChannel: SourceChannel
): ParseResult<NormalizedTransaction> {
  const delimiter = detectDelimiter(text.split('\n')[0] ?? '');
  const lines = parseCsvLines(text, delimiter);
  return buildTransactionsFromRows(lines, defaultChannel);
}

// ----------------------------------------------------------------------------
// JSON déjà normalisé (compatibilité avec le format actuellement accepté
// tel quel par les routes backend)
// ----------------------------------------------------------------------------
export function parseInvoicesJson(text: string): ParseResult<NormalizedInvoice> {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : data.invoices;
  if (!Array.isArray(arr)) throw new Error('JSON attendu : un tableau ou { invoices: [...] }');
  return { rows: arr, issues: [], totalRowsInFile: arr.length };
}

export function parseTransactionsJson(text: string): ParseResult<NormalizedTransaction> {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : data.transactions;
  if (!Array.isArray(arr)) throw new Error('JSON attendu : un tableau ou { transactions: [...] }');
  return { rows: arr, issues: [], totalRowsInFile: arr.length };
}

// ----------------------------------------------------------------------------
// Excel (.xlsx / .xls) via SheetJS ("xlsx" — à installer : npm install xlsx)
//
// Import dynamique pour ne charger la librairie (assez volumineuse) que
// lorsqu'un fichier Excel est effectivement déposé, plutôt que d'alourdir
// systématiquement le bundle initial de l'écran d'import.
// ----------------------------------------------------------------------------

/**
 * Convertit une cellule SheetJS (déjà résolue en valeur "raw" : number, Date,
 * string, boolean, ou vide) en texte exploitable par le même pipeline de
 * validation que le CSV. Les dates deviennent des chaînes ISO (reconnues
 * telles quelles par parseDateToIso), les nombres restent des nombres décimaux
 * en notation point (donc jamais ambigus avec la virgule décimale FR).
 */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  return String(value).trim();
}

/**
 * Lit la première feuille d'un classeur Excel et la renvoie sous la même
 * forme (string[][], en-tête en première ligne) que parseCsvLines, pour
 * pouvoir réutiliser directement buildInvoicesFromRows / buildTransactionsFromRows.
 *
 * Accepte un File (venant d'un <input type="file"> ou d'un drop) ou
 * directement un ArrayBuffer (pratique pour les tests, qui construisent un
 * classeur en mémoire sans passer par le DOM).
 */
async function readWorkbookRows(input: File | ArrayBuffer): Promise<string[][]> {
  const XLSX = await import('xlsx');
  const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const data = new Uint8Array(buffer);

  // cellDates: true => les cellules formatées comme des dates sont exposées
  // comme des objets Date JS plutôt que comme des numéros de série Excel.
  const workbook = XLSX.read(data, { type: 'array', cellDates: true });

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];

  // header: 1 => tableau de tableaux brut (pas d'objets clé/valeur), pour
  // garder le contrôle du mapping de colonnes nous-mêmes, comme pour le CSV.
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' });

  return raw
    .map((row) => row.map(cellToString))
    .filter((row) => row.some((cell) => cell.trim().length > 0));
}

export async function parseInvoicesExcel(input: File | ArrayBuffer): Promise<ParseResult<NormalizedInvoice>> {
  const lines = await readWorkbookRows(input);
  return buildInvoicesFromRows(lines);
}

export async function parseTransactionsExcel(
  input: File | ArrayBuffer,
  defaultChannel: SourceChannel
): Promise<ParseResult<NormalizedTransaction>> {
  const lines = await readWorkbookRows(input);
  return buildTransactionsFromRows(lines, defaultChannel);
}
