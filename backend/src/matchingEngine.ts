import { PoolClient } from 'pg';
import { pool } from './db';
import { DgiInvoice, FinancialTransaction, MatchResult, MatchedBy } from './types';

// Fenêtre temporelle acceptée pour le Niveau 3 (± 24h)
const LEVEL_3_TIME_WINDOW_MS = 24 * 60 * 60 * 1000;
// Écart de frais MoMo toléré : 0% à 2% en dessous du montant facturé
const LEVEL_3_MIN_RATIO = 0.98;
const LEVEL_3_MAX_RATIO = 1.0;

/**
 * Verrouille et récupère toutes les transactions UNMATCHED d'un tenant donné.
 * FOR UPDATE SKIP LOCKED évite les collisions si plusieurs jobs
 * de réconciliation tournent en parallèle (idempotence d'exécution).
 */
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

async function fetchPendingInvoices(client: PoolClient, tenantId: number): Promise<DgiInvoice[]> {
  const { rows } = await client.query<DgiInvoice>(
    `SELECT * FROM dgi_invoices
     WHERE tenant_id = $1 AND status = 'PENDING'
     FOR UPDATE SKIP LOCKED`,
    [tenantId]
  );
  return rows;
}

/**
 * Applique les 3 niveaux de scoring décroissant à une transaction donnée,
 * contre l'ensemble des factures encore disponibles (PENDING, non déjà
 * réservées dans ce passage). Fonction pure : le scoping par tenant est déjà
 * fait en amont par fetchUnmatchedTransactions / fetchPendingInvoices, donc
 * availableInvoices ne contient jamais que des factures du même tenant.
 */
export function findBestMatch(
  tx: FinancialTransaction,
  availableInvoices: DgiInvoice[]
): { invoice: DgiInvoice; score: number; level: 1 | 2 | 3 } | null {
  if (!availableInvoices.length) return null;

  // --- Niveau 1 : Match Parfait (score 100) ---
  // Téléphone identique ET montant exact.
  const level1 = availableInvoices.find(
    (inv) =>
      inv.customer_phone &&
      tx.sender_phone &&
      normalizePhone(inv.customer_phone) === normalizePhone(tx.sender_phone) &&
      inv.amount_ttc === tx.net_amount
  );
  if (level1) return { invoice: level1, score: 100, level: 1 };

  // --- Niveau 2 : Match par ID / Référence (score 90) ---
  // La référence opérateur de la transaction est inscrite dans le mémo de la facture,
  // et le montant correspond.
  const level2 = availableInvoices.find(
    (inv) =>
      inv.memo_reference &&
      inv.memo_reference.trim() === tx.reference_api_momo.trim() &&
      inv.amount_ttc === tx.net_amount
  );
  if (level2) return { invoice: level2, score: 90, level: 2 };

  // --- Niveau 3 : Match Temporel et Financier Flou (score 75) ---
  // Téléphone identique, montant légèrement inférieur (frais MoMo 0-2%),
  // dans une fenêtre de ± 24h autour de l'émission de la facture.
  const level3Candidates = availableInvoices.filter((inv) => {
    if (!inv.customer_phone || !tx.sender_phone) return false;
    if (normalizePhone(inv.customer_phone) !== normalizePhone(tx.sender_phone)) return false;

    const ratio = tx.net_amount / inv.amount_ttc;
    const amountOk = ratio >= LEVEL_3_MIN_RATIO && ratio <= LEVEL_3_MAX_RATIO;
    if (!amountOk) return false;

    const txTime = new Date(tx.processed_at).getTime();
    const invTime = new Date(inv.issued_at).getTime();
    return Math.abs(txTime - invTime) <= LEVEL_3_TIME_WINDOW_MS;
  });

  if (level3Candidates.length) {
    // En cas de plusieurs candidats flous, on prend le plus proche en montant
    const best = level3Candidates.reduce((a, b) =>
      Math.abs(a.amount_ttc - tx.net_amount) <= Math.abs(b.amount_ttc - tx.net_amount) ? a : b
    );
    return { invoice: best, score: 75, level: 3 };
  }

  return null;
}

export function normalizePhone(phone: string): string {
  // Nettoie les espaces / préfixes internationaux pour comparer de façon robuste
  return phone.replace(/[\s.-]/g, '').replace(/^\+?229/, '');
}

async function persistMatch(
  client: PoolClient,
  tenantId: number,
  invoiceId: number,
  transactionId: number,
  score: number,
  matchedBy: MatchedBy
): Promise<void> {
  // ON CONFLICT DO NOTHING protège contre un double-insert si le moteur
  // est relancé sur les mêmes lignes (idempotence du matching).
  await client.query(
    `INSERT INTO reconciliation_matches (tenant_id, invoice_id, transaction_id, match_score, matched_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (invoice_id) DO NOTHING`,
    [tenantId, invoiceId, transactionId, score, matchedBy]
  );

  // Le filtre tenant_id ici est une défense en profondeur : les appelants
  // (runReconciliation, manualMatch) ont déjà vérifié l'appartenance au
  // tenant en amont, mais on ne fait jamais confiance à un seul point de contrôle.
  await client.query(
    `UPDATE financial_transactions SET status = 'MATCHED' WHERE id = $1 AND tenant_id = $2`,
    [transactionId, tenantId]
  );
  await client.query(
    `UPDATE dgi_invoices SET status = 'MATCHED' WHERE id = $1 AND tenant_id = $2`,
    [invoiceId, tenantId]
  );
}

/**
 * Lance une passe complète de réconciliation automatique pour UN tenant.
 * Toute l'opération est transactionnelle : en cas d'erreur, rien n'est appliqué,
 * ce qui permet de relancer le job sans risque de doublons (idempotence).
 */
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

      await persistMatch(client, tenantId, match.invoice.id, tx.id, match.score, 'AUTOMATIC_ALGORITHM');

      // Retire la facture désormais consommée du pool disponible pour cette passe
      invoicesPool = invoicesPool.filter((inv) => inv.id !== match.invoice.id);

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

/**
 * Rapprochement manuel effectué par le comptable depuis le Dashboard Anomalies.
 *
 * Vérifie explicitement que la facture ET la transaction appartiennent bien
 * au tenant courant et sont toujours en attente, AVANT toute écriture.
 * Sans ce garde-fou, un utilisateur authentifié pourrait forcer la liaison
 * d'une facture appartenant à une autre PME simplement en devinant son id.
 */
export async function manualMatch(tenantId: number, invoiceId: number, transactionId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const invoiceCheck = await client.query<{ status: string }>(
      `SELECT status FROM dgi_invoices WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId]
    );
    if (invoiceCheck.rowCount === 0 || invoiceCheck.rows[0].status !== 'PENDING') {
      throw new Error("Facture introuvable, n'appartenant pas à ce compte, ou déjà traitée.");
    }

    const transactionCheck = await client.query<{ status: string }>(
      `SELECT status FROM financial_transactions WHERE id = $1 AND tenant_id = $2`,
      [transactionId, tenantId]
    );
    if (transactionCheck.rowCount === 0 || transactionCheck.rows[0].status !== 'UNMATCHED') {
      throw new Error("Transaction introuvable, n'appartenant pas à ce compte, ou déjà traitée.");
    }

    await persistMatch(client, tenantId, invoiceId, transactionId, 100, 'MANUAL_USER');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
