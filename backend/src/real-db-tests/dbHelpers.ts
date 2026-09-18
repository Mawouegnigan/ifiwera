import { pool } from '../db';
import { Tenant, DgiInvoice, FinancialTransaction, SourceChannel, InvoiceStatus, TransactionStatus } from '../types';

/**
 * Vide toutes les tables métier entre deux tests (ordre respectant les
 * contraintes de clé étrangère) et réinitialise les séquences SERIAL, pour
 * que chaque test parte d'un état déterministe (ids prévisibles à partir de 1).
 */
export async function resetDatabase(): Promise<void> {
  await pool.query(
    'TRUNCATE TABLE reconciliation_matches, financial_transactions, dgi_invoices, users, tenants RESTART IDENTITY CASCADE'
  );
}

let uidCounter = 0;
function uniqueSuffix(): string {
  uidCounter += 1;
  return `${Date.now()}-${uidCounter}`;
}

export async function insertTenant(name = 'Tenant Test'): Promise<Tenant> {
  const { rows } = await pool.query<Tenant>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at',
    [name]
  );
  return rows[0];
}

export async function insertUser(
  tenantId: number,
  overrides: { email?: string; passwordHash: string; role?: 'OWNER' | 'MEMBER' }
) {
  const email = overrides.email ?? `user-${uniqueSuffix()}@test.local`;
  const role = overrides.role ?? 'OWNER';
  const { rows } = await pool.query(
    `INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4)
     RETURNING id, tenant_id, email, role, created_at`,
    [tenantId, email, overrides.passwordHash, role]
  );
  return rows[0];
}

export async function insertInvoice(
  tenantId: number,
  overrides: Partial<Pick<DgiInvoice, 'invoice_uid' | 'customer_name' | 'customer_phone' | 'amount_ttc' | 'memo_reference' | 'issued_at' | 'status'>> = {}
): Promise<DgiInvoice> {
  const invoice_uid = overrides.invoice_uid ?? `INV-${uniqueSuffix()}`;
  const customer_name = overrides.customer_name ?? 'Client Test';
  const customer_phone = overrides.customer_phone ?? null;
  const amount_ttc = overrides.amount_ttc ?? 5000;
  const memo_reference = overrides.memo_reference ?? null;
  const issued_at = overrides.issued_at ?? new Date().toISOString();
  const status: InvoiceStatus = overrides.status ?? 'PENDING';

  const { rows } = await pool.query<DgiInvoice>(
    `INSERT INTO dgi_invoices (tenant_id, invoice_uid, customer_name, customer_phone, amount_ttc, memo_reference, issued_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [tenantId, invoice_uid, customer_name, customer_phone, amount_ttc, memo_reference, issued_at, status]
  );
  return rows[0];
}

export async function insertTransaction(
  tenantId: number,
  overrides: Partial<
    Pick<
      FinancialTransaction,
      'reference_api_momo' | 'source_channel' | 'sender_phone' | 'sender_name' | 'amount_received' | 'fees' | 'net_amount' | 'processed_at' | 'status'
    >
  > = {}
): Promise<FinancialTransaction> {
  const reference_api_momo = overrides.reference_api_momo ?? `REF-${uniqueSuffix()}`;
  const source_channel: SourceChannel = overrides.source_channel ?? 'MTN_MOMO';
  const sender_phone = overrides.sender_phone ?? null;
  const sender_name = overrides.sender_name ?? 'Expéditeur Test';
  const amount_received = overrides.amount_received ?? overrides.net_amount ?? 5000;
  const fees = overrides.fees ?? 0;
  const net_amount = overrides.net_amount ?? amount_received - fees;
  const processed_at = overrides.processed_at ?? new Date().toISOString();
  const status: TransactionStatus = overrides.status ?? 'UNMATCHED';

  const { rows } = await pool.query<FinancialTransaction>(
    `INSERT INTO financial_transactions
       (tenant_id, reference_api_momo, source_channel, sender_phone, sender_name, amount_received, fees, net_amount, processed_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [tenantId, reference_api_momo, source_channel, sender_phone, sender_name, amount_received, fees, net_amount, processed_at, status]
  );
  return rows[0];
}
