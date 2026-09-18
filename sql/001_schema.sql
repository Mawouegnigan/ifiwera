-- ============================================================================
-- IFIWERA - Schéma PostgreSQL
-- SaaS de rapprochement financier automatisé (MoMo / Moov / Banques / Cash)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. FACTURES CERTIFIÉES DGI / MeCEF
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dgi_invoices (
    id              SERIAL PRIMARY KEY,
    invoice_uid     VARCHAR(100) UNIQUE NOT NULL,      -- Numéro unique MeCEF / NIM
    customer_name   VARCHAR(150),
    customer_phone  VARCHAR(30),                       -- Clé de rapprochement essentielle
    amount_ttc      INT NOT NULL,                      -- En FCFA
    memo_reference  VARCHAR(150),                       -- Référence opérateur saisie manuellement (Niveau 2)
    issued_at       TIMESTAMP NOT NULL,
    status          VARCHAR(50) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'MATCHED', 'PARTIAL')),
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 2. TRANSACTIONS FINANCIÈRES (MTN MoMo, Moov, Banques, Cash)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS financial_transactions (
    id                  SERIAL PRIMARY KEY,
    reference_api_momo  VARCHAR(150) UNIQUE NOT NULL,   -- ID Transaction Opérateur (clé d'idempotence)
    source_channel      VARCHAR(50) NOT NULL
                            CHECK (source_channel IN ('MTN_MOMO','MOOV_MONEY','BANK_UBA','BANK_BOA','BANK_ECOBANK','CASH')),
    sender_phone        VARCHAR(30),
    sender_name         VARCHAR(150),
    amount_received     INT NOT NULL,                   -- Montant brut reçu
    fees                INT NOT NULL DEFAULT 0,          -- Frais de réseau déduits
    net_amount          INT NOT NULL,                    -- Montant net en caisse
    processed_at        TIMESTAMP NOT NULL,
    status              VARCHAR(50) NOT NULL DEFAULT 'UNMATCHED'
                            CHECK (status IN ('UNMATCHED','MATCHED','REJECTED')),
    created_at          TIMESTAMP NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 3. RAPPROCHEMENTS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_matches (
    id              SERIAL PRIMARY KEY,
    invoice_id      INT NOT NULL REFERENCES dgi_invoices(id),
    transaction_id  INT NOT NULL REFERENCES financial_transactions(id),
    match_score     INT NOT NULL CHECK (match_score BETWEEN 0 AND 100),
    matched_by      VARCHAR(50) NOT NULL
                        CHECK (matched_by IN ('AUTOMATIC_ALGORITHM','MANUAL_USER')),
    matched_at      TIMESTAMP NOT NULL DEFAULT now(),
    -- Empêche qu'une même transaction ou une même facture soit rapprochée deux fois
    UNIQUE (invoice_id),
    UNIQUE (transaction_id)
);

-- ----------------------------------------------------------------------------
-- 4. INDEX DE PERFORMANCE
-- Cible : requêtes de matching < 5s sur 5 000 lignes
-- ----------------------------------------------------------------------------

-- dgi_invoices : filtrage par statut + jointures sur téléphone / montant / mémo
CREATE INDEX IF NOT EXISTS idx_invoices_status          ON dgi_invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_customer_phone  ON dgi_invoices (customer_phone);
CREATE INDEX IF NOT EXISTS idx_invoices_amount_ttc      ON dgi_invoices (amount_ttc);
CREATE INDEX IF NOT EXISTS idx_invoices_memo_reference  ON dgi_invoices (memo_reference);
-- Index composite pour le Niveau 1 (phone + montant) sur les factures PENDING uniquement
CREATE INDEX IF NOT EXISTS idx_invoices_pending_match
    ON dgi_invoices (customer_phone, amount_ttc)
    WHERE status = 'PENDING';

-- financial_transactions : filtrage par statut + jointures
CREATE INDEX IF NOT EXISTS idx_transactions_status        ON financial_transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_sender_phone  ON financial_transactions (sender_phone);
CREATE INDEX IF NOT EXISTS idx_transactions_net_amount    ON financial_transactions (net_amount);
CREATE INDEX IF NOT EXISTS idx_transactions_processed_at  ON financial_transactions (processed_at);
CREATE INDEX IF NOT EXISTS idx_transactions_unmatched
    ON financial_transactions (sender_phone, net_amount)
    WHERE status = 'UNMATCHED';

-- reconciliation_matches
CREATE INDEX IF NOT EXISTS idx_matches_matched_by ON reconciliation_matches (matched_by);

COMMIT;
