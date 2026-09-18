import { describe, it, expect, beforeEach } from 'vitest';
import { pool } from '../db';
import { runReconciliation, manualMatch } from '../matchingEngine';
import { resetDatabase, insertTenant, insertInvoice, insertTransaction } from './dbHelpers';

// Cette suite exécute runReconciliation/manualMatch pour de vrai contre
// PostgreSQL (via docker-compose.yml). Elle vérifie des propriétés que le
// mock de matchingEngine.integration.test.ts ne peut pas garantir : les
// vraies contraintes UNIQUE, le vrai comportement de BEGIN/COMMIT/ROLLBACK,
// et que FOR UPDATE SKIP LOCKED ne bloque jamais les passes suivantes.

beforeEach(async () => {
  await resetDatabase();
});

describe('runReconciliation — vraie base PostgreSQL', () => {
  it('lie une transaction à une facture (Niveau 1) et persiste réellement les statuts', async () => {
    const tenant = await insertTenant('ACME Réel');
    const invoice = await insertInvoice(tenant.id, { customer_phone: '97001122', amount_ttc: 5000 });
    const tx = await insertTransaction(tenant.id, { sender_phone: '97001122', net_amount: 5000 });

    const results = await runReconciliation(tenant.id);

    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(100);

    const invoiceRow = await pool.query('SELECT status FROM dgi_invoices WHERE id = $1', [invoice.id]);
    expect(invoiceRow.rows[0].status).toBe('MATCHED');

    const txRow = await pool.query('SELECT status FROM financial_transactions WHERE id = $1', [tx.id]);
    expect(txRow.rows[0].status).toBe('MATCHED');

    const matchRows = await pool.query('SELECT * FROM reconciliation_matches WHERE tenant_id = $1', [tenant.id]);
    expect(matchRows.rows).toHaveLength(1);
    expect(matchRows.rows[0].matched_by).toBe('AUTOMATIC_ALGORITHM');
  });

  it("fait respecter la contrainte d'unicité réelle (tenant_id, invoice_uid)", async () => {
    const tenant = await insertTenant();
    await insertInvoice(tenant.id, { invoice_uid: 'DUP-001' });

    await expect(insertInvoice(tenant.id, { invoice_uid: 'DUP-001' })).rejects.toThrow(/duplicate key/i);
  });

  it('isole réellement deux tenants au niveau SQL (pas seulement en mémoire comme le mock)', async () => {
    const tenantA = await insertTenant('A');
    const tenantB = await insertTenant('B');
    await insertInvoice(tenantB.id, { customer_phone: '90000000', amount_ttc: 1000 });
    await insertTransaction(tenantA.id, { sender_phone: '90000000', net_amount: 1000 });

    const results = await runReconciliation(tenantA.id);

    expect(results).toHaveLength(0);
    // La transaction du tenant A reste bien UNMATCHED : rien n'a été lié par erreur.
    const stillUnmatched = await pool.query(
      "SELECT COUNT(*) FROM financial_transactions WHERE tenant_id = $1 AND status = 'UNMATCHED'",
      [tenantA.id]
    );
    expect(Number(stillUnmatched.rows[0].count)).toBe(1);
  });

  it("n'utilise jamais deux fois la même facture au sein d'une même passe (idempotence intra-passe, en base réelle)", async () => {
    const tenant = await insertTenant();
    const invoice = await insertInvoice(tenant.id, { customer_phone: '97001122', amount_ttc: 5000 });
    const tx1 = await insertTransaction(tenant.id, { sender_phone: '97001122', net_amount: 5000 });
    const tx2 = await insertTransaction(tenant.id, { sender_phone: '97001122', net_amount: 5000 });

    const results = await runReconciliation(tenant.id);

    expect(results).toHaveLength(1);
    expect(results[0].invoice.id).toBe(invoice.id);
    // La seconde transaction reste non rapprochée, faute de facture disponible.
    const remaining = await pool.query('SELECT status FROM financial_transactions WHERE id = $1 OR id = $2 ORDER BY id', [
      tx1.id,
      tx2.id,
    ]);
    const statuses = remaining.rows.map((r) => r.status);
    expect(statuses.filter((s) => s === 'MATCHED')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'UNMATCHED')).toHaveLength(1);
  });

  it("libère bien la connexion après une passe et n'entrave pas la passe suivante (FOR UPDATE SKIP LOCKED)", async () => {
    const tenant = await insertTenant();
    await insertInvoice(tenant.id, { customer_phone: '90001111', amount_ttc: 2000 });
    await insertTransaction(tenant.id, { sender_phone: '90001111', net_amount: 2000 });

    const first = await runReconciliation(tenant.id);
    expect(first).toHaveLength(1);

    // Rien à matcher désormais ; une deuxième passe immédiate ne doit ni
    // planter ni rester bloquée sur un verrou non relâché.
    const second = await runReconciliation(tenant.id);
    expect(second).toHaveLength(0);
  });
});

describe('manualMatch — garde-fous multi-tenant, vraie base PostgreSQL', () => {
  it('lie manuellement une facture et une transaction du même tenant', async () => {
    const tenant = await insertTenant();
    const invoice = await insertInvoice(tenant.id);
    const tx = await insertTransaction(tenant.id);

    await manualMatch(tenant.id, invoice.id, tx.id);

    const invoiceRow = await pool.query('SELECT status FROM dgi_invoices WHERE id = $1', [invoice.id]);
    expect(invoiceRow.rows[0].status).toBe('MATCHED');
    const txRow = await pool.query('SELECT status FROM financial_transactions WHERE id = $1', [tx.id]);
    expect(txRow.rows[0].status).toBe('MATCHED');
  });

  it("refuse de lier une facture appartenant à un autre tenant", async () => {
    const tenantA = await insertTenant('A');
    const tenantB = await insertTenant('B');
    const invoice = await insertInvoice(tenantB.id);
    const tx = await insertTransaction(tenantA.id);

    await expect(manualMatch(tenantA.id, invoice.id, tx.id)).rejects.toThrow(/n'appartenant pas à ce compte/);

    // Rien n'a été modifié malgré la tentative.
    const invoiceRow = await pool.query('SELECT status FROM dgi_invoices WHERE id = $1', [invoice.id]);
    expect(invoiceRow.rows[0].status).toBe('PENDING');
  });

  it('refuse de lier deux fois la même facture (déjà MATCHED)', async () => {
    const tenant = await insertTenant();
    const invoice = await insertInvoice(tenant.id, { status: 'MATCHED' });
    const tx = await insertTransaction(tenant.id);

    await expect(manualMatch(tenant.id, invoice.id, tx.id)).rejects.toThrow(/déjà traitée|introuvable/);
  });
});
