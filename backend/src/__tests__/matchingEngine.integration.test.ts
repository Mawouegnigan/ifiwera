import { describe, it, expect, vi, beforeEach } from 'vitest';

interface LoggedQuery {
  sql: string;
  params?: unknown[];
}

const TENANT_A = 1;
const TENANT_B = 2;

let unmatchedTransactions: any[] = [];
let pendingInvoices: any[] = [];
let queryLog: LoggedQuery[] = [];
let failOnInsert = false;

function byTenant(rows: any[], tenantId: number) {
  return rows.filter((r) => r.tenant_id === tenantId);
}

let matchedInvoicesRegistry: any[] = [];
let matchedTransactionsRegistry: any[] = [];

const mockClient = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    queryLog.push({ sql, params });
    const s = sql.trim();

    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
      return { rows: [], rowCount: 0 };
    }

    if (s.includes('SELECT status FROM dgi_invoices')) {
      const [id, tenantId] = params as [number, number];
      const invoice = pendingInvoices.find((i) => i.id === id && i.tenant_id === tenantId)
        ?? [...pendingInvoices, ...matchedInvoicesRegistry].find((i) => i.id === id && i.tenant_id === tenantId);
      return invoice ? { rows: [{ status: invoice.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (s.includes('SELECT status FROM financial_transactions')) {
      const [id, tenantId] = params as [number, number];
      const tx = unmatchedTransactions.find((t) => t.id === id && t.tenant_id === tenantId)
        ?? [...unmatchedTransactions, ...matchedTransactionsRegistry].find((t) => t.id === id && t.tenant_id === tenantId);
      return tx ? { rows: [{ status: tx.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (s.includes('FROM financial_transactions') && s.includes("status = 'UNMATCHED'")) {
      const [tenantId] = params as [number];
      return { rows: byTenant(unmatchedTransactions, tenantId), rowCount: unmatchedTransactions.length };
    }

    // fetchPendingInvoices utilise désormais status IN ('PENDING', 'PARTIAL') :
    // on reconnaît la requête à sa forme générale (dgi_invoices + FOR UPDATE
    // SKIP LOCKED), pas à la valeur exacte du statut.
    if (s.includes('FROM dgi_invoices') && s.includes('FOR UPDATE SKIP LOCKED')) {
      const [tenantId] = params as [number];
      return { rows: byTenant(pendingInvoices, tenantId), rowCount: pendingInvoices.length };
    }

    if (s.includes('INSERT INTO reconciliation_matches')) {
      if (failOnInsert) throw new Error('Erreur simulée : contrainte violée');
      return { rows: [], rowCount: 1 };
    }

    if (s.includes("UPDATE financial_transactions SET status = 'MATCHED'")) {
      const [id, tenantId] = params as [number, number];
      const tx = unmatchedTransactions.find((t) => t.id === id && t.tenant_id === tenantId);
      if (tx) {
        tx.status = 'MATCHED';
        matchedTransactionsRegistry.push(tx);
        unmatchedTransactions = unmatchedTransactions.filter((t) => t.id !== id);
      }
      return { rows: [], rowCount: tx ? 1 : 0 };
    }

    // Match automatique (persistAutomaticMatch) : amount_paid_ttc += net_amount,
    // statut MATCHED si le solde est soldé, sinon PARTIAL.
    if (s.includes('UPDATE dgi_invoices') && s.includes('amount_paid_ttc = amount_paid_ttc')) {
      const [netAmount, id, tenantId] = params as [number, number, number];
      const inv = pendingInvoices.find((i) => i.id === id && i.tenant_id === tenantId);
      if (inv) {
        inv.amount_paid_ttc = (inv.amount_paid_ttc ?? 0) + netAmount;
        if (inv.amount_paid_ttc >= inv.amount_ttc) {
          inv.status = 'MATCHED';
          matchedInvoicesRegistry.push(inv);
          pendingInvoices = pendingInvoices.filter((i) => i.id !== id);
        } else {
          inv.status = 'PARTIAL';
        }
      }
      return { rows: [], rowCount: inv ? 1 : 0 };
    }

    // Match manuel (persistManualMatch) : solde toujours soldé intégralement.
    if (s.includes('UPDATE dgi_invoices') && s.includes('amount_paid_ttc = amount_ttc')) {
      const [id, tenantId] = params as [number, number];
      const inv = pendingInvoices.find((i) => i.id === id && i.tenant_id === tenantId);
      if (inv) {
        inv.amount_paid_ttc = inv.amount_ttc;
        inv.status = 'MATCHED';
        matchedInvoicesRegistry.push(inv);
        pendingInvoices = pendingInvoices.filter((i) => i.id !== id);
      }
      return { rows: [], rowCount: inv ? 1 : 0 };
    }

    throw new Error(`Requête SQL non gérée par le mock : ${s}`);
  }),
  release: vi.fn(),
};

vi.mock('../db', () => ({
  pool: {
    connect: vi.fn(async () => mockClient),
  },
}));

const { runReconciliation, manualMatch } = await import('../matchingEngine');

function resetState() {
  unmatchedTransactions = [];
  pendingInvoices = [];
  matchedInvoicesRegistry = [];
  matchedTransactionsRegistry = [];
  queryLog = [];
  failOnInsert = false;
  vi.clearAllMocks();
}

beforeEach(() => {
  resetState();
});

describe('runReconciliation — comportement transactionnel et isolation par tenant', () => {
  it('lie une transaction à une facture du même tenant, met à jour les deux statuts, puis commit', async () => {
    unmatchedTransactions = [
      { id: 100, tenant_id: TENANT_A, sender_phone: '97001122', net_amount: 5000, reference_api_momo: 'R1', processed_at: '2026-01-10T10:00:00Z', status: 'UNMATCHED' },
    ];
    pendingInvoices = [
      { id: 1, tenant_id: TENANT_A, customer_phone: '97001122', amount_ttc: 5000, amount_paid_ttc: 0, memo_reference: null, issued_at: '2026-01-10T09:00:00Z', status: 'PENDING' },
    ];

    const results = await runReconciliation(TENANT_A);

    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(100);

    const sqlSequence = queryLog.map((q) => q.sql.trim().split('\n')[0]);
    expect(sqlSequence[0]).toBe('BEGIN');
    expect(sqlSequence[sqlSequence.length - 1]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalledOnce();
  });

  it("ignore les factures et transactions d'un autre tenant (isolation stricte)", async () => {
    unmatchedTransactions = [
      { id: 100, tenant_id: TENANT_A, sender_phone: '97001122', net_amount: 5000, reference_api_momo: 'R1', processed_at: '2026-01-10T10:00:00Z', status: 'UNMATCHED' },
    ];
    pendingInvoices = [
      { id: 1, tenant_id: TENANT_B, customer_phone: '97001122', amount_ttc: 5000, amount_paid_ttc: 0, memo_reference: null, issued_at: '2026-01-10T09:00:00Z', status: 'PENDING' },
    ];

    const results = await runReconciliation(TENANT_A);

    expect(results).toHaveLength(0);
  });

  it("n'utilise jamais deux fois la même facture au sein d'une même passe (idempotence intra-passe)", async () => {
    unmatchedTransactions = [
      { id: 100, tenant_id: TENANT_A, sender_phone: '97001122', net_amount: 5000, reference_api_momo: 'R1', processed_at: '2026-01-10T10:00:00Z', status: 'UNMATCHED' },
      { id: 101, tenant_id: TENANT_A, sender_phone: '97001122', net_amount: 5000, reference_api_momo: 'R2', processed_at: '2026-01-10T11:00:00Z', status: 'UNMATCHED' },
    ];
    pendingInvoices = [
      { id: 1, tenant_id: TENANT_A, customer_phone: '97001122', amount_ttc: 5000, amount_paid_ttc: 0, memo_reference: null, issued_at: '2026-01-10T09:00:00Z', status: 'PENDING' },
    ];

    const results = await runReconciliation(TENANT_A);

    expect(results).toHaveLength(1);
    expect(results[0].transaction.id).toBe(100);
    expect(unmatchedTransactions.some((t) => t.id === 101)).toBe(true);
  });

  it('effectue un ROLLBACK et propage l\'erreur si la persistance échoue', async () => {
    unmatchedTransactions = [
      { id: 100, tenant_id: TENANT_A, sender_phone: '97001122', net_amount: 5000, reference_api_momo: 'R1', processed_at: '2026-01-10T10:00:00Z', status: 'UNMATCHED' },
    ];
    pendingInvoices = [
      { id: 1, tenant_id: TENANT_A, customer_phone: '97001122', amount_ttc: 5000, amount_paid_ttc: 0, memo_reference: null, issued_at: '2026-01-10T09:00:00Z', status: 'PENDING' },
    ];
    failOnInsert = true;

    await expect(runReconciliation(TENANT_A)).rejects.toThrow('Erreur simulée');

    const sqlSequence = queryLog.map((q) => q.sql.trim().split('\n')[0]);
    expect(sqlSequence).toContain('ROLLBACK');
    expect(sqlSequence).not.toContain('COMMIT');
  });
});

describe('manualMatch — garde-fous multi-tenant', () => {
  it('lie une facture et une transaction du même tenant', async () => {
    pendingInvoices = [{ id: 7, tenant_id: TENANT_A, status: 'PENDING', amount_ttc: 5000, amount_paid_ttc: 0 }];
    unmatchedTransactions = [{ id: 42, tenant_id: TENANT_A, status: 'UNMATCHED' }];

    await manualMatch(TENANT_A, 7, 42);

    const insertCall = queryLog.find((q) => q.sql.includes('INSERT INTO reconciliation_matches'));
    // Le score (100) et matched_by ('MANUAL_USER') sont désormais écrits en
    // dur dans le SQL, plus dans les paramètres liés.
    expect(insertCall?.params).toEqual([TENANT_A, 7, 42]);
  });

  it("refuse de lier une facture appartenant à un autre tenant", async () => {
    pendingInvoices = [{ id: 7, tenant_id: TENANT_B, status: 'PENDING' }];
    unmatchedTransactions = [{ id: 42, tenant_id: TENANT_A, status: 'UNMATCHED' }];

    await expect(manualMatch(TENANT_A, 7, 42)).rejects.toThrow(/n'appartenant pas à ce compte/);

    const sqlSequence = queryLog.map((q) => q.sql.trim().split('\n')[0]);
    expect(sqlSequence).toContain('ROLLBACK');
    expect(queryLog.some((q) => q.sql.includes('INSERT INTO reconciliation_matches'))).toBe(false);
  });

  it('refuse de lier une facture déjà rapprochée', async () => {
    pendingInvoices = [{ id: 7, tenant_id: TENANT_A, status: 'MATCHED' }];

    await expect(manualMatch(TENANT_A, 7, 42)).rejects.toThrow(/déjà traitée|introuvable/);
  });

  it('effectue un ROLLBACK si la persistance échoue après les vérifications', async () => {
    pendingInvoices = [{ id: 7, tenant_id: TENANT_A, status: 'PENDING', amount_ttc: 5000, amount_paid_ttc: 0 }];
    unmatchedTransactions = [{ id: 42, tenant_id: TENANT_A, status: 'UNMATCHED' }];
    failOnInsert = true;

    await expect(manualMatch(TENANT_A, 7, 42)).rejects.toThrow('Erreur simulée');

    const sqlSequence = queryLog.map((q) => q.sql.trim().split('\n')[0]);
    expect(sqlSequence).toContain('ROLLBACK');
    expect(sqlSequence).not.toContain('COMMIT');
  });
});