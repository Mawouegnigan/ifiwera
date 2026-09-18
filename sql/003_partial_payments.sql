-- ============================================================================
-- IFIWERA — Migration 003 : Paiements partiels (Niveau 4 de matching)
-- ============================================================================

BEGIN;

ALTER TABLE dgi_invoices ADD COLUMN IF NOT EXISTS amount_paid_ttc INT NOT NULL DEFAULT 0;

-- Une facture peut désormais recevoir plusieurs paiements successifs.
-- On garde UNIQUE(transaction_id) : une transaction ne peut toujours être
-- utilisée que dans un seul match.
ALTER TABLE reconciliation_matches DROP CONSTRAINT IF EXISTS reconciliation_matches_invoice_id_key;

CREATE INDEX IF NOT EXISTS idx_matches_invoice_id ON reconciliation_matches (invoice_id);

COMMIT;