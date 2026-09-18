import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { signToken } from '../auth/jwt';
import { buildRealApp } from './appHelpers';
import { resetDatabase, insertTenant, insertInvoice, insertTransaction } from './dbHelpers';
import { runReconciliation } from '../matchingEngine';

// GET /api/reconciliation/summary agrège plusieurs sous-requêtes SQL
// (COUNT, SUM, division). Le mock de reconciliation.test.ts renvoie des
// lignes construites à la main : cette suite vérifie que le SQL réel produit
// bien les bons agrégats sur des données réellement insérées et matchées.

const app = buildRealApp();

beforeEach(async () => {
  await resetDatabase();
});

function authHeader(tenantId: number) {
  return `Bearer ${signToken({ userId: 1, tenantId })}`;
}

describe('GET /api/reconciliation/summary — vraie base PostgreSQL', () => {
  it('calcule des agrégats corrects après une réconciliation automatique réelle', async () => {
    const tenant = await insertTenant();
    await insertInvoice(tenant.id, { customer_phone: '97001122', amount_ttc: 5000 }); // sera matchée
    await insertInvoice(tenant.id, { customer_phone: '90009999', amount_ttc: 3000 }); // restera PENDING
    await insertTransaction(tenant.id, { sender_phone: '97001122', net_amount: 5000 }); // matchera
    await insertTransaction(tenant.id, { sender_phone: '90001234', net_amount: 1500 }); // restera UNMATCHED

    await runReconciliation(tenant.id);

    const res = await request(app).get('/api/reconciliation/summary').set('Authorization', authHeader(tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.total_invoices).toBe(2);
    expect(res.body.total_transactions).toBe(2);
    expect(res.body.matched_count).toBe(1);
    expect(res.body.matched_amount_fcfa).toBe(5000);
    expect(res.body.unmatched_invoices_count).toBe(1);
    expect(res.body.unmatched_transactions_count).toBe(1);
    expect(res.body.discrepancy_amount_fcfa).toBe(1500 + 3000);
  });

  it("ne mélange jamais les agrégats de deux tenants différents", async () => {
    const tenantA = await insertTenant('A');
    const tenantB = await insertTenant('B');
    await insertInvoice(tenantA.id, { amount_ttc: 1000 });
    await insertInvoice(tenantB.id, { amount_ttc: 9999 });
    await insertInvoice(tenantB.id, { amount_ttc: 9999 });

    const resA = await request(app).get('/api/reconciliation/summary').set('Authorization', authHeader(tenantA.id));
    expect(resA.body.total_invoices).toBe(1);

    const resB = await request(app).get('/api/reconciliation/summary').set('Authorization', authHeader(tenantB.id));
    expect(resB.body.total_invoices).toBe(2);
  });
});

describe('GET /api/reconciliation/orphans — vraie base PostgreSQL', () => {
  it('retourne uniquement les transactions UNMATCHED et factures PENDING du tenant courant, triées', async () => {
    const tenant = await insertTenant();
    const older = await insertInvoice(tenant.id, { issued_at: '2026-01-01T00:00:00.000Z' });
    const newer = await insertInvoice(tenant.id, { issued_at: '2026-01-15T00:00:00.000Z' });
    await insertTransaction(tenant.id, { status: 'UNMATCHED' });

    const otherTenant = await insertTenant('Autre');
    await insertInvoice(otherTenant.id); // ne doit jamais apparaître

    const res = await request(app).get('/api/reconciliation/orphans').set('Authorization', authHeader(tenant.id));

    expect(res.status).toBe(200);
    expect(res.body.orphanTransactions).toHaveLength(1);
    expect(res.body.unpaidInvoices).toHaveLength(2);
    // Trié par issued_at DESC : la plus récente d'abord.
    expect(res.body.unpaidInvoices[0].id).toBe(newer.id);
    expect(res.body.unpaidInvoices[1].id).toBe(older.id);
  });
});
