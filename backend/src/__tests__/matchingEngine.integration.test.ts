import { describe, it, expect, vi, beforeEach } from 'vitest';

// ----------------------------------------------------------------------------
// Mock minimal du pool PostgreSQL, mis à jour pour le scoping multi-tenant.
//
// Reconnaît les requêtes émises par matchingEngine.ts : BEGIN/COMMIT/ROLLBACK,
// les deux SELECT ... FOR UPDATE SKIP LOCKED (scopés tenant_id), les gardes-fous
// de manualMatch (SELECT status ... WHERE id = $1 AND tenant_id = $2), l'INSERT
// ON CONFLICT DO NOTHING, et les deux UPDATE de statut (scopés tenant_id).
// ----------------------------------------------------------------------------
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

const mockClient = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    queryLog.push({ sql, params });
    const s = sql.trim();

    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
      return { rows: [], rowCount: 0 };
    }

    // Garde-fou manualMatch : SELECT status FROM dgi_invoices WHERE id = $1 AND tenant_id = $2
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

    if (s.includes('FROM dgi_invoices') && s.includes("status = 'PENDING'")) {
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

    if (s.includes("UPDATE dgi_invoices SET status = 'MATCHED'")) {
      const [id, tenantId] = params as [number, number];
      const inv = pendingInvoices.find((i) => i.id === id && i.tenant_id === tenantId);
      if (inv) {
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

// Conserve une trace des lignes déjà rapprochées, pour que le garde-fou de
// manualMatch puisse détecter "déjà traité" même après retrait du pool actif.
let matchedInvoicesRegistry: any[] = [];
let matchedTransactionsRegistry: any[] = [];

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
      { id: 1, tenant_id: TENANT_A, customer_phone: '97001122', amount_ttc: 5000, memo_reference: null, issued_at: '2026-01-10T09:00:00Z', status: 'PENDING' },
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
      // Même téléphone et même montant, mais tenant différent : ne doit jamais matcher.
      { id: 1, tenant_id: TENANT_B, customer_phone: '97001122', amount_ttc: 5000, memo_reference: null, issued_at: '2026-01-10T09:00:00Z', status: 'PENDING' },
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
      { id: 1, tenant_id: TENANT_A, customer_phone: '97001122', amount_ttc: 5000, memo_reference: null, issued_at: '2026-01-10T09:00:00Z', status: 'PENDING' },
    ];

    const results = await runReconciliation(TENANT_A);

    expect(results).toHaveLength(1);
    expect(results[0].transaction.id).toBe(100);
    expect(unmatchedTransactions.some((t) => t.id === 101)).toBe(true); // reste non rapprochée
  });

  it('effectue un ROLLBACK et propage l\'erreur si la persistance échoue', async () => {
    unmatchedTransactions = [
      { id: 100, tenant_id: TENANT_A, sender_phone: '97001122', net_amount: 5000, reference_api_momo: 'R1', processed_at: '2026-01-10T10:00:00Z', status: 'UNMATCHED' },
    ];
    pendingInvoices = [
      { id: 1, tenant_id: TENANT_A, customer_phone: '97001122', amount_ttc: 5000, memo_reference: null, issued_at: '2026-01-10T09:00:00Z', status: 'PENDING' },
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
    pendingInvoices = [{ id: 7, tenant_id: TENANT_A, status: 'PENDING' }];
    unmatchedTransactions = [{ id: 42, tenant_id: TENANT_A, status: 'UNMATCHED' }];

    await manualMatch(TENANT_A, 7, 42);

    const insertCall = queryLog.find((q) => q.sql.includes('INSERT INTO reconciliation_matches'));
    expect(insertCall?.params).toEqual([TENANT_A, 7, 42, 100, 'MANUAL_USER']);
  });

  it("refuse de lier une facture appartenant à un autre tenant", async () => {
    pendingInvoices = [{ id: 7, tenant_id: TENANT_B, status: 'PENDING' }]; // appartient à B
    unmatchedTransactions = [{ id: 42, tenant_id: TENANT_A, status: 'UNMATCHED' }];

    await expect(manualMatch(TENANT_A, 7, 42)).rejects.toThrow(/n'appartenant pas à ce compte/);

    const sqlSequence = queryLog.map((q) => q.sql.trim().split('\n')[0]);
    expect(sqlSequence).toContain('ROLLBACK');
    expect(queryLog.some((q) => q.sql.includes('INSERT INTO reconciliation_matches'))).toBe(false);
  });

  it('refuse de lier une facture déjà rapprochée', async () => {
    pendingInvoices = [{ id: 7, tenant_id: TENANT_A, status: 'MATCHED' }]; // déjà traitée

    await expect(manualMatch(TENANT_A, 7, 42)).rejects.toThrow(/déjà traitée|introuvable/);
  });

  it('effectue un ROLLBACK si la persistance échoue après les vérifications', async () => {
    pendingInvoices = [{ id: 7, tenant_id: TENANT_A, status: 'PENDING' }];
    unmatchedTransactions = [{ id: 42, tenant_id: TENANT_A, status: 'UNMATCHED' }];
    failOnInsert = true;

    await expect(manualMatch(TENANT_A, 7, 42)).rejects.toThrow('Erreur simulée');

    const sqlSequence = queryLog.map((q) => q.sql.trim().split('\n')[0]);
    expect(sqlSequence).toContain('ROLLBACK');
    expect(sqlSequence).not.toContain('COMMIT');
  });
});
