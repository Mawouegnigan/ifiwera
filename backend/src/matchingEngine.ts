import { PoolClient } from 'pg';
import { pool } from './db';
import { DgiInvoice, FinancialTransaction, MatchResult, MatchedBy } from './types';

const LEVEL_3_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const LEVEL_3_MIN_RATIO = 0.98;
const LEVEL_3_MAX_RATIO = 1.0;

// Niveau 4 : paiement partiel — le montant reçu couvre entre 5% et 98%
// du solde RESTANT de la facture, dans une fenêtre de ±90 jours.
const LEVEL_4_TIME_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const LEVEL_4_MIN_RATIO = 0.05;
const LEVEL_4_MAX_RATIO = 0.98;

async function fetchUnmatchedTransactions(client: PoolClient, tenantId: number): Promise<FinancialTransaction[]> {
  const { rows } = await client.query<FinancialTransaction>(
    `SELECT * FROM financial_transactions
     WHERE tenant_id = $1 AND status = 'UNMATCHED'
     ORDER BY processed_at ASC
     FOR UPDATE SKIP LOCKED`,
    [tenantId]
  );
  return rows;
}

// Inclut désormais aussi les factures PARTIAL : elles restent éligibles
// au matching tant que leur solde restant n'est pas épuisé.
async function fetchPendingInvoices(client: PoolClient, tenantId: number): Promise<DgiInvoice[]> {
  const { rows } = await client.query<DgiInvoice>(
    `SELECT * FROM dgi_invoices
     WHERE tenant_id = $1 AND status IN ('PENDING', 'PARTIAL')
     FOR UPDATE SKIP LOCKED`,
    [tenantId]
  );
  return rows;
}

function remainingBalance(inv: DgiInvoice): number {
  return inv.amount_ttc - inv.amount_paid_ttc;
}

/**
 * Applique les 4 niveaux de scoring décroissant. Les niveaux 1 à 3 comparent
 * désormais le montant au SOLDE RESTANT de la facture (et non plus au montant
 * total), ce qui leur permet de continuer à fonctionner correctement sur une
 * facture déjà partiellement payée.
 */
export function findBestMatch(
  tx: FinancialTransaction,
  availableInvoices: DgiInvoice[]
): { invoice: DgiInvoice; score: number; level: 1 | 2 | 3 | 4 } | null {
  if (!availableInvoices.length) return null;

  // --- Niveau 1 : Match Parfait (score 100) ---
  const level1 = availableInvoices.find(
    (inv) =>
      inv.customer_phone &&
      tx.sender_phone &&
      normalizePhone(inv.customer_phone) === normalizePhone(tx.sender_phone) &&
      remainingBalance(inv) === tx.net_amount
  );
  if (level1) return { invoice: level1, score: 100, level: 1 };

  // --- Niveau 2 : Match par Référence (score 90) ---
  const level2 = availableInvoices.find(
    (inv) =>
      inv.memo_reference &&
      inv.memo_reference.trim() === tx.reference_api_momo.trim() &&
      remainingBalance(inv) === tx.net_amount
  );
  if (level2) return { invoice: level2, score: 90, level: 2 };

  // --- Niveau 3 : Match Temporel et Financier Flou (score 75) ---
  const level3Candidates = availableInvoices.filter((inv) => {
    if (!inv.customer_phone || !tx.sender_phone) return false;
    if (normalizePhone(inv.customer_phone) !== normalizePhone(tx.sender_phone)) return false;

    const remaining = remainingBalance(inv);
    if (remaining <= 0) return false;
    const ratio = tx.net_amount / remaining;
    if (ratio < LEVEL_3_MIN_RATIO || ratio > LEVEL_3_MAX_RATIO) return false;

    const txTime = new Date(tx.processed_at).getTime();
    const invTime = new Date(inv.issued_at).getTime();
    return Math.abs(txTime - invTime) <= LEVEL_3_TIME_WINDOW_MS;
  });

  if (level3Candidates.length) {
    const best = level3Candidates.reduce((a, b) =>
      Math.abs(remainingBalance(a) - tx.net_amount) <= Math.abs(remainingBalance(b) - tx.net_amount) ? a : b
    );
    return { invoice: best, score: 75, level: 3 };
  }

  // --- Niveau 4 : Paiement Partiel (score 50) ---
  // Téléphone identique exigé, comme aux Niveaux 1 et 3 : ce niveau assouplit
  // le montant et la fenêtre temporelle, mais ne doit jamais deviner
  // l'identité du payeur. Sans cette exigence, deux paiements et factures
  // sans lien réel mais de montant proche pourraient être rapprochés à tort.
  const level4Candidates = availableInvoices.filter((inv) => {
    if (!inv.customer_phone || !tx.sender_phone) return false;
    if (normalizePhone(inv.customer_phone) !== normalizePhone(tx.sender_phone)) return false;

    const remaining = remainingBalance(inv);
    if (remaining <= 0) return false;
    const ratio = tx.net_amount / remaining;
    if (ratio < LEVEL_4_MIN_RATIO || ratio > LEVEL_4_MAX_RATIO) return false;

    const txTime = new Date(tx.processed_at).getTime();
    const invTime = new Date(inv.issued_at).getTime();
    return Math.abs(txTime - invTime) <= LEVEL_4_TIME_WINDOW_MS;
  });

  if (level4Candidates.length) {
    const best = level4Candidates.reduce((a, b) =>
      Math.abs(remainingBalance(a) - tx.net_amount) <= Math.abs(remainingBalance(b) - tx.net_amount) ? a : b
    );
    return { invoice: best, score: 50, level: 4 };
  }

  return null;
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s.-]/g, '').replace(/^\+?229/, '');
}

/**
 * Persiste un match automatique. Contrairement à l'ancienne version, ceci
 * n'écrase plus le statut de la facture à MATCHED inconditionnellement :
 * le solde payé est incrémenté du montant net reçu, et le statut ne passe
 * à MATCHED que si ce solde atteint ou dépasse le montant total de la facture
 * (sinon la facture reste, ou redevient, PARTIAL).
 */
async function persistAutomaticMatch(
  client: PoolClient,
  tenantId: number,
  invoiceId: number,
  transactionId: number,
  score: number,
  level: 1 | 2 | 3 | 4,
  netAmount: number
): Promise<void> {
  await client.query(
    `INSERT INTO reconciliation_matches (tenant_id, invoice_id, transaction_id, match_score, matched_by)
     VALUES ($1, $2, $3, $4, 'AUTOMATIC_ALGORITHM')
     ON CONFLICT (transaction_id) DO NOTHING`,
    [tenantId, invoiceId, transactionId, score]
  );

  await client.query(
    `UPDATE financial_transactions SET status = 'MATCHED' WHERE id = $1 AND tenant_id = $2`,
    [transactionId, tenantId]
  );

  if (level === 4) {
    // Niveau 4 : vrai paiement partiel intentionnel — le solde ne progresse
    // que du montant réellement reçu, la facture peut rester PARTIAL.
    await client.query(
      `UPDATE dgi_invoices
       SET amount_paid_ttc = amount_paid_ttc + $1,
           status = CASE WHEN amount_paid_ttc + $1 >= amount_ttc THEN 'MATCHED' ELSE 'PARTIAL' END
       WHERE id = $2 AND tenant_id = $3`,
      [netAmount, invoiceId, tenantId]
    );
  } else {
    // Niveaux 1/2/3 : la facture est considérée comme intégralement soldée.
    // Le Niveau 3 tolère justement un léger écart (frais MoMo 0-2%) qui n'est
    // pas un vrai reliquat dû — la facture ne doit jamais rester PARTIAL
    // pour ces quelques francs de frais réseau.
    await client.query(
      `UPDATE dgi_invoices SET amount_paid_ttc = amount_ttc, status = 'MATCHED' WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId]
    );
  }
}

/**
 * Liaison manuelle : un choix délibéré du comptable clôture toujours
 * intégralement la facture (score 100), quel que soit le montant réellement
 * transféré — c'est le comptable qui juge le dossier soldé, pas l'algorithme.
 */
async function persistManualMatch(
  client: PoolClient,
  tenantId: number,
  invoiceId: number,
  transactionId: number
): Promise<void> {
  await client.query(
    `INSERT INTO reconciliation_matches (tenant_id, invoice_id, transaction_id, match_score, matched_by)
     VALUES ($1, $2, $3, 100, 'MANUAL_USER')
     ON CONFLICT (transaction_id) DO NOTHING`,
    [tenantId, invoiceId, transactionId]
  );

  await client.query(
    `UPDATE financial_transactions SET status = 'MATCHED' WHERE id = $1 AND tenant_id = $2`,
    [transactionId, tenantId]
  );

  await client.query(
    `UPDATE dgi_invoices SET amount_paid_ttc = amount_ttc, status = 'MATCHED' WHERE id = $1 AND tenant_id = $2`,
    [invoiceId, tenantId]
  );
}

export async function runReconciliation(tenantId: number): Promise<MatchResult[]> {
  const client = await pool.connect();
  const results: MatchResult[] = [];

  try {
    await client.query('BEGIN');

    const transactions = await fetchUnmatchedTransactions(client, tenantId);
    let invoicesPool = await fetchPendingInvoices(client, tenantId);

    for (const tx of transactions) {
      const match = findBestMatch(tx, invoicesPool);
      if (!match) continue;

      await persistAutomaticMatch(client, tenantId, match.invoice.id, tx.id, match.score, match.level, tx.net_amount);

      if (match.level === 4) {
        const newPaid = match.invoice.amount_paid_ttc + tx.net_amount;
        if (newPaid >= match.invoice.amount_ttc) {
          // Facture soldée : elle sort du pool disponible pour cette passe
          invoicesPool = invoicesPool.filter((inv) => inv.id !== match.invoice.id);
        } else {
          // Facture toujours PARTIAL : elle reste disponible avec un solde réduit
          invoicesPool = invoicesPool.map((inv) =>
            inv.id === match.invoice.id ? { ...inv, amount_paid_ttc: newPaid } : inv
          );
        }
      } else {
        // Niveaux 1/2/3 : la facture est toujours intégralement soldée,
        // elle sort systématiquement du pool disponible.
        invoicesPool = invoicesPool.filter((inv) => inv.id !== match.invoice.id);
      }

      results.push({ transaction: tx, invoice: match.invoice, score: match.score, level: match.level });
    }

    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function manualMatch(tenantId: number, invoiceId: number, transactionId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const invoiceCheck = await client.query<{ status: string }>(
      `SELECT status FROM dgi_invoices WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId]
    );
    if (invoiceCheck.rowCount === 0 || !['PENDING', 'PARTIAL'].includes(invoiceCheck.rows[0].status)) {
      throw new Error("Facture introuvable, n'appartenant pas à ce compte, ou déjà traitée.");
    }

    const transactionCheck = await client.query<{ status: string }>(
      `SELECT status FROM financial_transactions WHERE id = $1 AND tenant_id = $2`,
      [transactionId, tenantId]
    );
    if (transactionCheck.rowCount === 0 || transactionCheck.rows[0].status !== 'UNMATCHED') {
      throw new Error("Transaction introuvable, n'appartenant pas à ce compte, ou déjà traitée.");
    }

    await persistManualMatch(client, tenantId, invoiceId, transactionId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}