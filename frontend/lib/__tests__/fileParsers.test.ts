import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  detectExtension,
  guessSourceChannel,
  parseInvoicesCsv,
  parseTransactionsCsv,
  parseInvoicesJson,
  parseTransactionsJson,
  parseInvoicesExcel,
  parseTransactionsExcel,
} from '../fileParsers';

// ----------------------------------------------------------------------------
// Helper : construit un classeur Excel en mémoire (aucun fichier sur disque,
// aucun DOM/File nécessaire) et le sérialise en ArrayBuffer, exactement comme
// readWorkbookRows() sait le consommer.
// ----------------------------------------------------------------------------
function buildXlsxArrayBuffer(rows: unknown[][]): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Feuille1');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

// ============================================================================
// detectExtension / guessSourceChannel
// ============================================================================
describe('detectExtension', () => {
  it.each([
    ['export.csv', 'csv'],
    ['export.CSV', 'csv'],
    ['notes.txt', 'csv'],
    ['data.json', 'json'],
    ['releve.xlsx', 'xlsx'],
    ['ancien.xls', 'xls'],
    ['facture.pdf', 'pdf'],
    ['inconnu.zip', 'other'],
    ['sans_extension', 'other'],
  ])('classe %s comme %s', (fileName, expected) => {
    expect(detectExtension(fileName)).toBe(expected);
  });
});

describe('guessSourceChannel', () => {
  it.each([
    ['export_MoMo_Checking_2026.csv', 'MTN_MOMO'],
    ['mtn_juillet.csv', 'MTN_MOMO'],
    ['moov_money_export.csv', 'MOOV_MONEY'],
    ['releve_UBA_aout.csv', 'BANK_UBA'],
    ['BOA_statement.xlsx', 'BANK_BOA'],
    ['ecobank-export.csv', 'BANK_ECOBANK'],
    ['especes_caisse.csv', 'CASH'],
  ])('détecte %s -> %s', (fileName, expected) => {
    expect(guessSourceChannel(fileName)).toBe(expected);
  });
});

// ============================================================================
// parseInvoicesCsv
// ============================================================================
describe('parseInvoicesCsv', () => {
  it('parse une facture valide avec délimiteur virgule', () => {
    const csv = 'numero_facture,nom_client,telephone_client,montant_ttc,date_emission\nINV-1,Client A,+22997000000,10000,01/03/2026';
    const result = parseInvoicesCsv(csv);
    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ invoice_uid: 'INV-1', customer_name: 'Client A', amount_ttc: 10000 });
    expect(result.rows[0].issued_at).toBe(new Date(Date.UTC(2026, 2, 1)).toISOString());
  });

  it('détecte le point-virgule et gère le montant en virgule décimale FR', () => {
    const csv = 'numero_facture;montant_ttc;date_emission\nINV-2;12500,50;01/03/2026';
    const result = parseInvoicesCsv(csv);
    expect(result.issues).toHaveLength(0);
    expect(result.rows[0].amount_ttc).toBe(12500.5);
  });

  it('rejette une ligne sans numéro de facture', () => {
    const csv = 'numero_facture,montant_ttc,date_emission\n,10000,01/03/2026';
    const result = parseInvoicesCsv(csv);
    expect(result.rows).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toMatch(/facture manquant/);
  });

  it('rejette une ligne avec un montant illisible', () => {
    const csv = 'numero_facture,montant_ttc,date_emission\nINV-3,abc,01/03/2026';
    const result = parseInvoicesCsv(csv);
    expect(result.rows).toHaveLength(0);
    expect(result.issues[0].reason).toMatch(/Montant TTC illisible/);
  });

  it('rejette une ligne avec une date illisible', () => {
    const csv = 'numero_facture,montant_ttc,date_emission\nINV-4,10000,pas-une-date';
    const result = parseInvoicesCsv(csv);
    expect(result.rows).toHaveLength(0);
    expect(result.issues[0].reason).toMatch(/illisible/);
  });

  it('retourne un résultat vide sur un fichier vide', () => {
    expect(parseInvoicesCsv('')).toEqual({ rows: [], issues: [], totalRowsInFile: 0 });
  });
});

// ============================================================================
// parseTransactionsCsv
// ============================================================================
describe('parseTransactionsCsv', () => {
  it('calcule net_amount = amount_received - fees quand absent', () => {
    const csv = 'reference,montant,frais,date\nREF-1,1000,20,01/03/2026';
    const result = parseTransactionsCsv(csv, 'MTN_MOMO');
    expect(result.issues).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({ amount_received: 1000, fees: 20, net_amount: 980, source_channel: 'MTN_MOMO' });
  });

  it("respecte net_amount explicite quand fourni", () => {
    const csv = 'reference,montant,frais,montant_net,date\nREF-2,1000,20,999,01/03/2026';
    const result = parseTransactionsCsv(csv, 'MOOV_MONEY');
    expect(result.rows[0].net_amount).toBe(999);
  });

  it('rejette une ligne sans référence opérateur', () => {
    const csv = 'reference,montant,date\n,1000,01/03/2026';
    const result = parseTransactionsCsv(csv, 'CASH');
    expect(result.rows).toHaveLength(0);
    expect(result.issues[0].reason).toMatch(/Référence opérateur manquante/);
  });
});

// ============================================================================
// parseInvoicesJson / parseTransactionsJson
// ============================================================================
describe('parseInvoicesJson', () => {
  it('accepte un tableau brut', () => {
    const json = JSON.stringify([{ invoice_uid: 'INV-1', amount_ttc: 1000 }]);
    expect(parseInvoicesJson(json).rows).toHaveLength(1);
  });

  it('accepte { invoices: [...] }', () => {
    const json = JSON.stringify({ invoices: [{ invoice_uid: 'INV-1', amount_ttc: 1000 }] });
    expect(parseInvoicesJson(json).rows).toHaveLength(1);
  });

  it('rejette une forme JSON invalide', () => {
    expect(() => parseInvoicesJson(JSON.stringify({ foo: 'bar' }))).toThrow(/JSON attendu/);
  });
});

describe('parseTransactionsJson', () => {
  it('accepte { transactions: [...] }', () => {
    const json = JSON.stringify({ transactions: [{ reference_api_momo: 'REF-1' }] });
    expect(parseTransactionsJson(json).rows).toHaveLength(1);
  });

  it('rejette une forme JSON invalide', () => {
    expect(() => parseTransactionsJson('{}')).toThrow(/JSON attendu/);
  });
});

// ============================================================================
// parseInvoicesExcel / parseTransactionsExcel
// ============================================================================
describe('parseInvoicesExcel', () => {
  it('parse un classeur avec des cellules numériques et une cellule Date native', async () => {
    const buffer = buildXlsxArrayBuffer([
      ['numero_facture', 'nom_client', 'montant_ttc', 'date_emission'],
      ['INV-1', 'Client A', 10000, new Date(Date.UTC(2026, 2, 1))],
    ]);

    const result = await parseInvoicesExcel(buffer);

    expect(result.issues).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ invoice_uid: 'INV-1', customer_name: 'Client A', amount_ttc: 10000 });
    expect(result.rows[0].issued_at).toBe(new Date(Date.UTC(2026, 2, 1)).toISOString());
  });

  it('ignore les lignes entièrement vides et signale les lignes invalides', async () => {
    const buffer = buildXlsxArrayBuffer([
      ['numero_facture', 'montant_ttc', 'date_emission'],
      ['INV-1', 5000, new Date(Date.UTC(2026, 0, 15))],
      ['', '', ''],
      ['', 5000, new Date(Date.UTC(2026, 0, 16))], // sans numéro de facture
    ]);

    const result = await parseInvoicesExcel(buffer);

    expect(result.rows).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].reason).toMatch(/facture manquant/);
  });

  it("fonctionne aussi à partir d'un objet File (pas seulement un ArrayBuffer)", async () => {
    const buffer = buildXlsxArrayBuffer([
      ['numero_facture', 'montant_ttc', 'date_emission'],
      ['INV-9', 2500, new Date(Date.UTC(2026, 5, 1))],
    ]);
    const file = new File([buffer], 'factures.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const result = await parseInvoicesExcel(file);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].invoice_uid).toBe('INV-9');
  });
});

describe('parseTransactionsExcel', () => {
  it('parse un classeur et calcule net_amount à partir des colonnes numériques', async () => {
    const buffer = buildXlsxArrayBuffer([
      ['reference', 'telephone', 'montant', 'frais', 'date'],
      ['REF-1', '+22997000000', 1000, 20, new Date(Date.UTC(2026, 2, 1, 10, 0, 0))],
    ]);

    const result = await parseTransactionsExcel(buffer, 'MTN_MOMO');

    expect(result.issues).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({
      reference_api_momo: 'REF-1',
      amount_received: 1000,
      fees: 20,
      net_amount: 980,
      source_channel: 'MTN_MOMO',
    });
  });

  it('signale une ligne avec référence opérateur manquante', async () => {
    const buffer = buildXlsxArrayBuffer([
      ['reference', 'montant', 'date'],
      ['', 1000, new Date(Date.UTC(2026, 2, 1))],
    ]);

    const result = await parseTransactionsExcel(buffer, 'CASH');
    expect(result.rows).toHaveLength(0);
    expect(result.issues[0].reason).toMatch(/Référence opérateur manquante/);
  });
});

