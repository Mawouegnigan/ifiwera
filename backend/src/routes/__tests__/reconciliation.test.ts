import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ----------------------------------------------------------------------------
// Mocks : on isole complètement le pool pg et le moteur de matching pour ne
// tester ici que la couche route (validation, codes HTTP, BEGIN/COMMIT/
// ROLLBACK, mapping de la réponse JSON). La logique de matching elle-même est
// déjà couverte par matchingEngine.unit.test.ts / .integration.test.ts.
// ----------------------------------------------------------------------------
vi.mock('../../db', () => ({
  pool: {
    connect: vi.fn(),
    query: vi.fn(),
  },
}));

vi.mock('../../matchingEngine', () => ({
  runReconciliation: vi.fn(),
  manualMatch: vi.fn(),
}));

import { pool } from '../../db';
import { runReconciliation, manualMatch } from '../../matchingEngine';
import { reconciliationRouter } from '../reconciliation';

const TEST_AUTH = { userId: 1, tenantId: 42 };

function buildApp(auth: { userId: number; tenantId: number } = TEST_AUTH) {
  const app = express();
  app.use(express.json());
  // Simule requireAuth (déjà testé séparément) : attache req.auth directement,
  // comme le ferait le middleware réel une fois le token vérifié.
  app.use((req: any, _res, next) => {
    req.auth = auth;
    next();
  });
  app.use('/api', reconciliationRouter);
  return app;
}

function makeMockClient() {
  return { query: vi.fn(), release: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// POST /api/import/invoices
// ============================================================================
describe('POST /api/import/invoices', () => {
  it('refuse un payload sans tableau "invoices" non vide', async () => {
    const res = await request(buildApp()).post('/api/import/invoices').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invoices/);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('refuse un tableau "invoices" vide', async () => {
    const res = await request(buildApp()).post('/api/import/invoices').send({ invoices: [] });
    expect(res.status).toBe(400);
  });

  it('insère les nouvelles factures et ignore les doublons (idempotence via ON CONFLICT)', async () => {
    const client = makeMockClient();
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1 }] }) // insertion réelle
      .mockResolvedValueOnce({ rowCount: 0, rows: [] }) // doublon (ON CONFLICT DO NOTHING)
      .mockResolvedValueOnce(undefined); // COMMIT
    (pool.connect as unknown as Mock).mockResolvedValue(client);

    const res = await request(buildApp())
      .post('/api/import/invoices')
      .send({
        invoices: [
          { invoice_uid: 'INV-1', amount_ttc: 1000, issued_at: '2026-01-01T10:00:00Z' },
          { invoice_uid: 'INV-1', amount_ttc: 1000, issued_at: '2026-01-01T10:00:00Z' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 1, skippedDuplicates: 1, total: 2 });
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('effectue un ROLLBACK et renvoie 500 si une insertion échoue', async () => {
    const client = makeMockClient();
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('duplicate key value')) // insertion échoue
      .mockResolvedValueOnce(undefined); // ROLLBACK
    (pool.connect as unknown as Mock).mockResolvedValue(client);

    const res = await request(buildApp())
      .post('/api/import/invoices')
      .send({ invoices: [{ invoice_uid: 'INV-1', amount_ttc: 1000, issued_at: '2026-01-01' }] });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/import des factures/);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// POST /api/import/transactions
// ============================================================================
describe('POST /api/import/transactions', () => {
  it('refuse un payload sans tableau "transactions" non vide', async () => {
    const res = await request(buildApp()).post('/api/import/transactions').send({ transactions: [] });
    expect(res.status).toBe(400);
  });

  it('calcule net_amount = amount_received - fees quand il n\'est pas fourni', async () => {
    const client = makeMockClient();
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 7 }] }) // insertion
      .mockResolvedValueOnce(undefined); // COMMIT
    (pool.connect as unknown as Mock).mockResolvedValue(client);

    const res = await request(buildApp())
      .post('/api/import/transactions')
      .send({
        transactions: [
          {
            reference_api_momo: 'REF-1',
            source_channel: 'MTN_MOMO',
            sender_phone: '+22997000000',
            sender_name: 'Client A',
            amount_received: 1000,
            fees: 20,
            processed_at: '2026-01-01T10:00:00Z',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 1, skippedDuplicates: 0, total: 1 });

    // Le 2e appel (index 1) est l'INSERT ; on vérifie que net_amount calculé (980) est bien transmis.
    const insertCallParams = client.query.mock.calls[1][1];
    expect(insertCallParams).toContain(980);
  });

  it('respecte net_amount explicite quand il est fourni', async () => {
    const client = makeMockClient();
    client.query
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 8 }] })
      .mockResolvedValueOnce(undefined);
    (pool.connect as unknown as Mock).mockResolvedValue(client);

    await request(buildApp())
      .post('/api/import/transactions')
      .send({
        transactions: [
          {
            reference_api_momo: 'REF-2',
            source_channel: 'MOOV_MONEY',
            amount_received: 1000,
            fees: 20,
            net_amount: 999,
            processed_at: '2026-01-01T10:00:00Z',
          },
        ],
      });

    const insertCallParams = client.query.mock.calls[1][1];
    expect(insertCallParams).toContain(999);
  });

  it('effectue un ROLLBACK et renvoie 500 en cas d\'erreur DB', async () => {
    const client = makeMockClient();
    client.query.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('connection lost'));
    (pool.connect as unknown as Mock).mockResolvedValue(client);

    const res = await request(buildApp())
      .post('/api/import/transactions')
      .send({ transactions: [{ reference_api_momo: 'REF-3', amount_received: 500, processed_at: '2026-01-01' }] });

    expect(res.status).toBe(500);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});

// ============================================================================
// POST /api/reconciliation/run
// ============================================================================
describe('POST /api/reconciliation/run', () => {
  it('lance la réconciliation pour le tenant courant et formate le résultat', async () => {
    (runReconciliation as unknown as Mock).mockResolvedValue([
      { transaction: { id: 11 }, invoice: { id: 21 }, score: 100, level: 1 },
      { transaction: { id: 12 }, invoice: { id: 22 }, score: 75, level: 3 },
    ]);

    const res = await request(buildApp()).post('/api/reconciliation/run').send();

    expect(runReconciliation).toHaveBeenCalledWith(TEST_AUTH.tenantId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      matched_count: 2,
      details: [
        { transaction_id: 11, invoice_id: 21, score: 100, level: 1 },
        { transaction_id: 12, invoice_id: 22, score: 75, level: 3 },
      ],
    });
  });

  it('renvoie 500 si le moteur de matching échoue', async () => {
    (runReconciliation as unknown as Mock).mockRejectedValue(new Error('lock timeout'));
    const res = await request(buildApp()).post('/api/reconciliation/run').send();
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/réconciliation automatique/);
  });
});

// ============================================================================
// POST /api/reconciliation/manual-match
// ============================================================================
describe('POST /api/reconciliation/manual-match', () => {
  it('refuse une requête sans invoiceId ou transactionId', async () => {
    const res = await request(buildApp()).post('/api/reconciliation/manual-match').send({ invoiceId: 1 });
    expect(res.status).toBe(400);
    expect(manualMatch).not.toHaveBeenCalled();
  });

  it('délègue au moteur avec le tenant courant et les ids convertis en nombre', async () => {
    (manualMatch as unknown as Mock).mockResolvedValue(undefined);

    const res = await request(buildApp())
      .post('/api/reconciliation/manual-match')
      .send({ invoiceId: '21', transactionId: '11' });

    expect(manualMatch).toHaveBeenCalledWith(TEST_AUTH.tenantId, 21, 11);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('renvoie 400 si manualMatch rejette (facture hors tenant ou déjà traitée)', async () => {
    (manualMatch as unknown as Mock).mockRejectedValue(
      new Error("Facture introuvable, n'appartenant pas à ce compte, ou déjà traitée.")
    );

    const res = await request(buildApp())
      .post('/api/reconciliation/manual-match')
      .send({ invoiceId: 999, transactionId: 1 });

    expect(res.status).toBe(400);
    expect(res.body.details).toMatch(/n'appartenant pas à ce compte/);
  });
});

// ============================================================================
// GET /api/reconciliation/summary
// ============================================================================
describe('GET /api/reconciliation/summary', () => {
  it('calcule et formate correctement le résumé statistique', async () => {
    (pool.query as unknown as Mock).mockResolvedValue({
      rows: [
        {
          total_transactions: '10',
          total_invoices: '8',
          matched_count: '5',
          matched_amount_fcfa: '150000',
          unmatched_transactions_count: '3',
          unmatched_invoices_count: '3',
          discrepancy_amount_fcfa: '42000',
        },
      ],
    });

    const res = await request(buildApp()).get('/api/reconciliation/summary');

    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [TEST_AUTH.tenantId]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total_transactions: 10,
      total_invoices: 8,
      matched_count: 5,
      matched_amount_fcfa: 150000,
      matched_percentage: 62.5,
      unmatched_transactions_count: 3,
      unmatched_invoices_count: 3,
      discrepancy_amount_fcfa: 42000,
    });
  });

  it('évite la division par zéro quand total_invoices vaut 0', async () => {
    (pool.query as unknown as Mock).mockResolvedValue({
      rows: [
        {
          total_transactions: '0',
          total_invoices: '0',
          matched_count: '0',
          matched_amount_fcfa: '0',
          unmatched_transactions_count: '0',
          unmatched_invoices_count: '0',
          discrepancy_amount_fcfa: '0',
        },
      ],
    });

    const res = await request(buildApp()).get('/api/reconciliation/summary');
    expect(res.status).toBe(200);
    expect(res.body.matched_percentage).toBe(0);
    expect(Number.isFinite(res.body.matched_percentage)).toBe(true);
  });

  it('renvoie 500 si la requête SQL échoue', async () => {
    (pool.query as unknown as Mock).mockRejectedValue(new Error('syntax error'));
    const res = await request(buildApp()).get('/api/reconciliation/summary');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/résumé/);
  });
});

// ============================================================================
// GET /api/reconciliation/orphans
// ============================================================================
describe('GET /api/reconciliation/orphans', () => {
  it('renvoie les transactions non rapprochées et les factures impayées, scopées au tenant', async () => {
    (pool.query as unknown as Mock)
      .mockResolvedValueOnce({ rows: [{ id: 1, status: 'UNMATCHED' }] }) // transactions
      .mockResolvedValueOnce({ rows: [{ id: 2, status: 'PENDING' }] }); // invoices

    const res = await request(buildApp()).get('/api/reconciliation/orphans');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orphanTransactions: [{ id: 1, status: 'UNMATCHED' }],
      unpaidInvoices: [{ id: 2, status: 'PENDING' }],
    });
    expect(pool.query).toHaveBeenNthCalledWith(1, expect.any(String), [TEST_AUTH.tenantId]);
    expect(pool.query).toHaveBeenNthCalledWith(2, expect.any(String), [TEST_AUTH.tenantId]);
  });

  it('renvoie 500 si une des deux requêtes échoue', async () => {
    (pool.query as unknown as Mock)
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('connection reset'));

    const res = await request(buildApp()).get('/api/reconciliation/orphans');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/anomalies/);
  });
});
