import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { runReconciliation, manualMatch } from '../matchingEngine';
import { ReconciliationSummary, ReconciliationAnalytics } from '../types';

export const reconciliationRouter = Router();

// Toutes les routes de ce router sont montées derrière le middleware
// requireAuth (voir index.ts) : req.auth est donc garanti présent.

// ----------------------------------------------------------------------------
// POST /api/import/invoices
// Import idempotent des factures DGI/MeCEF, scopé au tenant courant.
// ----------------------------------------------------------------------------
reconciliationRouter.post('/import/invoices', async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const invoices = req.body?.invoices;
  if (!Array.isArray(invoices) || invoices.length === 0) {
    return res.status(400).json({ error: 'Le payload doit contenir un tableau "invoices" non vide.' });
  }

  const client = await pool.connect();
  let inserted = 0;
  let skippedDuplicates = 0;

  try {
    await client.query('BEGIN');

    for (const inv of invoices) {
      const result = await client.query(
        `INSERT INTO dgi_invoices
           (tenant_id, invoice_uid, customer_name, customer_phone, amount_ttc, memo_reference, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, invoice_uid) DO NOTHING
         RETURNING id`,
        [tenantId, inv.invoice_uid, inv.customer_name, inv.customer_phone, inv.amount_ttc, inv.memo_reference ?? null, inv.issued_at]
      );
      if (result.rowCount && result.rowCount > 0) inserted += 1;
      else skippedDuplicates += 1;
    }

    await client.query('COMMIT');
    res.json({ inserted, skippedDuplicates, total: invoices.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Échec de l\'import des factures.', details: (err as Error).message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------------------
// POST /api/import/transactions
// Import idempotent des relevés MoMo/Moov/Banque, scopé au tenant courant.
// La contrainte UNIQUE (tenant_id, reference_api_momo) garantit qu'un même
// fichier réimporté deux fois n'insère jamais deux fois la même ligne, sans
// empêcher deux PME différentes de recevoir la même référence opérateur.
// ----------------------------------------------------------------------------
reconciliationRouter.post('/import/transactions', async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const transactions = req.body?.transactions;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return res.status(400).json({ error: 'Le payload doit contenir un tableau "transactions" non vide.' });
  }

  const client = await pool.connect();
  let inserted = 0;
  let skippedDuplicates = 0;

  try {
    await client.query('BEGIN');

    for (const tx of transactions) {
      const netAmount = tx.net_amount ?? tx.amount_received - (tx.fees ?? 0);
      const result = await client.query(
        `INSERT INTO financial_transactions
           (tenant_id, reference_api_momo, source_channel, sender_phone, sender_name, amount_received, fees, net_amount, processed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, reference_api_momo) DO NOTHING
         RETURNING id`,
        [
          tenantId,
          tx.reference_api_momo,
          tx.source_channel,
          tx.sender_phone,
          tx.sender_name,
          tx.amount_received,
          tx.fees ?? 0,
          netAmount,
          tx.processed_at,
        ]
      );
      if (result.rowCount && result.rowCount > 0) inserted += 1;
      else skippedDuplicates += 1;
    }

    await client.query('COMMIT');
    res.json({ inserted, skippedDuplicates, total: transactions.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Échec de l\'import des transactions.', details: (err as Error).message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------------------------------
// POST /api/reconciliation/run
// Déclenche l'algorithme de matching à 3 niveaux pour le tenant courant
// uniquement (bouton "Lancer la Réconciliation Automatique").
// ----------------------------------------------------------------------------
reconciliationRouter.post('/reconciliation/run', async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  try {
    const results = await runReconciliation(tenantId);
    res.json({
      matched_count: results.length,
      details: results.map((r) => ({
        transaction_id: r.transaction.id,
        invoice_id: r.invoice.id,
        score: r.score,
        level: r.level,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Échec de la réconciliation automatique.', details: (err as Error).message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/reconciliation/manual-match
// Liaison manuelle depuis le Dashboard des Anomalies (clic gauche + droite).
// manualMatch() vérifie en interne que la facture et la transaction
// appartiennent bien au tenant courant.
// ----------------------------------------------------------------------------
reconciliationRouter.post('/reconciliation/manual-match', async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const { invoiceId, transactionId } = req.body ?? {};
  if (!invoiceId || !transactionId) {
    return res.status(400).json({ error: 'invoiceId et transactionId sont requis.' });
  }
  try {
    await manualMatch(tenantId, Number(invoiceId), Number(transactionId));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Échec de la liaison manuelle.', details: (err as Error).message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/reconciliation/summary
// Alimente le résumé statistique en haut du Dashboard, pour le tenant courant.
// ----------------------------------------------------------------------------
reconciliationRouter.get('/reconciliation/summary', async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  try {
    const { rows } = await pool.query(
      `
      SELECT
        (SELECT COUNT(*) FROM financial_transactions WHERE tenant_id = $1) AS total_transactions,
        (SELECT COUNT(*) FROM dgi_invoices WHERE tenant_id = $1) AS total_invoices,
        (SELECT COUNT(*) FROM reconciliation_matches WHERE tenant_id = $1) AS matched_count,
        (SELECT COALESCE(SUM(amount_ttc), 0) FROM dgi_invoices WHERE tenant_id = $1 AND status = 'MATCHED') AS matched_amount_fcfa,
        (SELECT COUNT(*) FROM financial_transactions WHERE tenant_id = $1 AND status = 'UNMATCHED') AS unmatched_transactions_count,
        (SELECT COUNT(*) FROM dgi_invoices WHERE tenant_id = $1 AND status = 'PENDING') AS unmatched_invoices_count,
        (SELECT COALESCE(SUM(amount_received), 0) FROM financial_transactions WHERE tenant_id = $1 AND status = 'UNMATCHED')
          + (SELECT COALESCE(SUM(amount_ttc), 0) FROM dgi_invoices WHERE tenant_id = $1 AND status = 'PENDING') AS discrepancy_amount_fcfa
    `,
      [tenantId]
    );

    const row = rows[0];
    const totalInvoices = Number(row.total_invoices) || 1; // évite division par zéro

    const summary: ReconciliationSummary = {
      total_transactions: Number(row.total_transactions),
      total_invoices: Number(row.total_invoices),
      matched_count: Number(row.matched_count),
      matched_amount_fcfa: Number(row.matched_amount_fcfa),
      matched_percentage: Math.round((Number(row.matched_count) / totalInvoices) * 1000) / 10,
      unmatched_transactions_count: Number(row.unmatched_transactions_count),
      unmatched_invoices_count: Number(row.unmatched_invoices_count),
      discrepancy_amount_fcfa: Number(row.discrepancy_amount_fcfa),
    };

    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: 'Échec du calcul du résumé.', details: (err as Error).message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/reconciliation/orphans
// Alimente les deux colonnes du Dashboard pour le tenant courant.
// ----------------------------------------------------------------------------
reconciliationRouter.get('/reconciliation/orphans', async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  try {
    const [transactions, invoices] = await Promise.all([
      pool.query(
        `SELECT * FROM financial_transactions WHERE tenant_id = $1 AND status = 'UNMATCHED' ORDER BY processed_at DESC`,
        [tenantId]
      ),
      pool.query(
        `SELECT * FROM dgi_invoices WHERE tenant_id = $1 AND status IN ('PENDING','PARTIAL') ORDER BY issued_at DESC`,
        [tenantId]
      ),
    ]);
    res.json({ orphanTransactions: transactions.rows, unpaidInvoices: invoices.rows });
  } catch (err) {
    res.status(500).json({ error: 'Échec du chargement des anomalies.', details: (err as Error).message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/reconciliation/analytics
// Alimente le Dashboard Recharts : répartition par niveau de matching,
// répartition par canal de paiement, série temporelle des 30 derniers jours,
// et l'encours des factures partiellement payées. Le tout scopé au tenant courant.
// ----------------------------------------------------------------------------
const LEVEL_BY_SCORE: Record<number, 1 | 2 | 3 | 4> = { 100: 1, 90: 2, 75: 3, 50: 4 };

reconciliationRouter.get('/reconciliation/analytics', async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  try {
    const [levelRes, channelRes, timeSeriesRes, partialRes] = await Promise.all([
      pool.query(
        `SELECT match_score, COUNT(*) AS count
         FROM reconciliation_matches
         WHERE tenant_id = $1
         GROUP BY match_score
         ORDER BY match_score DESC`,
        [tenantId]
      ),
      pool.query(
        `SELECT
           source_channel,
           COUNT(*) FILTER (WHERE status = 'MATCHED') AS matched_count,
           COUNT(*) FILTER (WHERE status = 'UNMATCHED') AS unmatched_count,
           COALESCE(SUM(net_amount) FILTER (WHERE status = 'MATCHED'), 0) AS matched_amount_fcfa
         FROM financial_transactions
         WHERE tenant_id = $1
         GROUP BY source_channel
         ORDER BY source_channel`,
        [tenantId]
      ),
      pool.query(
        `SELECT
           DATE(rm.matched_at) AS day,
           COUNT(*) AS matched_count,
           COALESCE(SUM(ft.net_amount), 0) AS matched_amount_fcfa
         FROM reconciliation_matches rm
         JOIN financial_transactions ft ON ft.id = rm.transaction_id
         WHERE rm.tenant_id = $1 AND rm.matched_at >= now() - interval '30 days'
         GROUP BY DATE(rm.matched_at)
         ORDER BY day ASC`,
        [tenantId]
      ),
      pool.query(
        `SELECT
           COUNT(*) AS count,
           COALESCE(SUM(amount_ttc - amount_paid_ttc), 0) AS outstanding_fcfa
         FROM dgi_invoices
         WHERE tenant_id = $1 AND status = 'PARTIAL'`,
        [tenantId]
      ),
    ]);

    const analytics: ReconciliationAnalytics = {
      levelBreakdown: levelRes.rows.map((r) => ({
        level: LEVEL_BY_SCORE[Number(r.match_score)] ?? 0,
        score: Number(r.match_score),
        count: Number(r.count),
      })),
      channelBreakdown: channelRes.rows.map((r) => ({
        channel: r.source_channel,
        matched_count: Number(r.matched_count),
        unmatched_count: Number(r.unmatched_count),
        matched_amount_fcfa: Number(r.matched_amount_fcfa),
      })),
      timeSeries: timeSeriesRes.rows.map((r) => ({
        day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day,
        matched_count: Number(r.matched_count),
        matched_amount_fcfa: Number(r.matched_amount_fcfa),
      })),
      partialInvoices: {
        count: Number(partialRes.rows[0].count),
        outstanding_fcfa: Number(partialRes.rows[0].outstanding_fcfa),
      },
    };

    res.json(analytics);
  } catch (err) {
    res.status(500).json({ error: 'Échec du calcul des statistiques.', details: (err as Error).message });
  }
});