import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { pool } from '../db';
import { signToken } from '../auth/jwt';
import { buildRealApp } from './appHelpers';
import { resetDatabase, insertTenant } from './dbHelpers';

// L'idempotence des imports repose sur ON CONFLICT (tenant_id, invoice_uid) /
// (tenant_id, reference_api_momo) DO NOTHING. Le mock de pg utilisé dans
// reconciliation.test.ts ne peut que SIMULER ce comportement (il ne connaît
// pas les contraintes UNIQUE réelles) : cette suite le vérifie pour de vrai.

const app = buildRealApp();

beforeEach(async () => {
  await resetDatabase();
});

async function authHeaderFor(tenantId: number) {
  const token = signToken({ userId: 1, tenantId });
  return `Bearer ${token}`;
}

describe('POST /api/import/invoices — idempotence réelle', () => {
  it('réimporter exactement le même lot ne crée aucun doublon en base', async () => {
    const tenant = await insertTenant();
    const auth = await authHeaderFor(tenant.id);
    const payload = {
      invoices: [
        {
          invoice_uid: 'FAC-2026-001',
          customer_name: 'Boutique Cotonou',
          customer_phone: '97001122',
          amount_ttc: 15000,
          memo_reference: null,
          issued_at: '2026-01-10T10:00:00.000Z',
        },
      ],
    };

    const first = await request(app).post('/api/import/invoices').set('Authorization', auth).send(payload);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ inserted: 1, skippedDuplicates: 0, total: 1 });

    const second = await request(app).post('/api/import/invoices').set('Authorization', auth).send(payload);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ inserted: 0, skippedDuplicates: 1, total: 1 });

    const count = await pool.query('SELECT COUNT(*) FROM dgi_invoices WHERE tenant_id = $1', [tenant.id]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('le même invoice_uid est autorisé pour deux tenants différents (unicité scopée par tenant)', async () => {
    const tenantA = await insertTenant('A');
    const tenantB = await insertTenant('B');
    const payload = {
      invoices: [
        {
          invoice_uid: 'FAC-PARTAGE-001',
          customer_name: 'Client',
          customer_phone: null,
          amount_ttc: 1000,
          memo_reference: null,
          issued_at: '2026-01-10T10:00:00.000Z',
        },
      ],
    };

    const resA = await request(app).post('/api/import/invoices').set('Authorization', await authHeaderFor(tenantA.id)).send(payload);
    const resB = await request(app).post('/api/import/invoices').set('Authorization', await authHeaderFor(tenantB.id)).send(payload);

    expect(resA.body.inserted).toBe(1);
    expect(resB.body.inserted).toBe(1);
  });
});

describe('POST /api/import/transactions — idempotence réelle', () => {
  it('réimporter le même relevé MoMo ne crée aucun doublon en base', async () => {
    const tenant = await insertTenant();
    const auth = await authHeaderFor(tenant.id);
    const payload = {
      transactions: [
        {
          reference_api_momo: 'MOMO-XYZ-789',
          source_channel: 'MTN_MOMO',
          sender_phone: '97001122',
          sender_name: 'Client Cotonou',
          amount_received: 15100,
          fees: 100,
          net_amount: 15000,
          processed_at: '2026-01-10T11:00:00.000Z',
        },
      ],
    };

    await request(app).post('/api/import/transactions').set('Authorization', auth).send(payload);
    const second = await request(app).post('/api/import/transactions').set('Authorization', auth).send(payload);

    expect(second.body).toEqual({ inserted: 0, skippedDuplicates: 1, total: 1 });
    const count = await pool.query('SELECT COUNT(*) FROM financial_transactions WHERE tenant_id = $1', [tenant.id]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  it('une erreur en cours de lot déclenche un vrai ROLLBACK (rien de partiel en base)', async () => {
    const tenant = await insertTenant();
    const auth = await authHeaderFor(tenant.id);
    // La deuxième ligne viole NOT NULL sur reference_api_momo : toute la
    // transaction SQL doit être annulée, y compris la première ligne valide.
    const payload = {
      transactions: [
        {
          reference_api_momo: 'MOMO-VALIDE-1',
          source_channel: 'MTN_MOMO',
          sender_phone: '97001122',
          sender_name: 'Client',
          amount_received: 1000,
          fees: 0,
          net_amount: 1000,
          processed_at: '2026-01-10T11:00:00.000Z',
        },
        {
          reference_api_momo: null,
          source_channel: 'MTN_MOMO',
          sender_phone: '97001133',
          sender_name: 'Autre Client',
          amount_received: 2000,
          fees: 0,
          net_amount: 2000,
          processed_at: '2026-01-10T12:00:00.000Z',
        },
      ],
    };

    const res = await request(app).post('/api/import/transactions').set('Authorization', auth).send(payload);
    expect(res.status).toBe(500);

    const count = await pool.query('SELECT COUNT(*) FROM financial_transactions WHERE tenant_id = $1', [tenant.id]);
    expect(Number(count.rows[0].count)).toBe(0);
  });
});
