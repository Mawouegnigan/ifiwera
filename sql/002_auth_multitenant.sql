-- ============================================================================
-- IFIWERA — Migration 002 : Authentification & isolation multi-tenant
--
-- Contexte : plusieurs PME clientes partagent la même base applicative.
-- Sans cette migration, les données de toutes les PME étaient mélangées
-- dans les mêmes tables sans aucune séparation.
--
-- NOTE IMPORTANTE POUR UNE BASE DÉJÀ EN PRODUCTION :
-- Ce script suppose une base vide ou de développement. Si des lignes
-- existent déjà dans dgi_invoices / financial_transactions /
-- reconciliation_matches, il faut d'abord :
--   1. Créer un tenant "legacy" de secours,
--   2. Backfill tenant_id = <id du tenant legacy> sur les lignes existantes,
--   3. PUIS exécuter les ALTER ... SET NOT NULL et ajouter les contraintes
--      UNIQUE ci-dessous.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. TENANTS (une PME cliente = un tenant)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(150) NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 2. USERS (comptes utilisateurs, rattachés à un tenant)
-- L'email est unique globalement : on identifie l'utilisateur par email à la
-- connexion, indépendamment du tenant (un email = un compte, dans un tenant).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,  -- format "salt_hex:derivedkey_hex" (scrypt)
    role            VARCHAR(20) NOT NULL DEFAULT 'OWNER'
                        CHECK (role IN ('OWNER', 'MEMBER')),
    created_at      TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users (tenant_id);

-- ----------------------------------------------------------------------------
-- 3. SCOPING DES TABLES MÉTIER EXISTANTES
-- ----------------------------------------------------------------------------

-- dgi_invoices
ALTER TABLE dgi_invoices ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id);
-- Retire l'ancienne contrainte d'unicité globale (un même numéro de facture
-- pouvait légitimement exister chez deux PME différentes de toute façon).
ALTER TABLE dgi_invoices DROP CONSTRAINT IF EXISTS dgi_invoices_invoice_uid_key;
-- (Sur une base neuve, on peut directement passer la colonne en NOT NULL.
--  Sur une base existante : backfill d'abord, voir note en tête de fichier.)
ALTER TABLE dgi_invoices ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE dgi_invoices ADD CONSTRAINT dgi_invoices_tenant_invoice_uid_key UNIQUE (tenant_id, invoice_uid);

-- financial_transactions
ALTER TABLE financial_transactions ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id);
ALTER TABLE financial_transactions DROP CONSTRAINT IF EXISTS financial_transactions_reference_api_momo_key;
ALTER TABLE financial_transactions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE financial_transactions ADD CONSTRAINT financial_transactions_tenant_reference_key UNIQUE (tenant_id, reference_api_momo);

-- reconciliation_matches (dénormalisé : simplifie et accélère les requêtes
-- scoped par tenant sans jointure supplémentaire)
ALTER TABLE reconciliation_matches ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES tenants(id);
ALTER TABLE reconciliation_matches ALTER COLUMN tenant_id SET NOT NULL;

-- ----------------------------------------------------------------------------
-- 4. INDEX — remplace les index composites globaux par des versions
--    préfixées par tenant_id (l'isolation par tenant est désormais le premier
--    filtre de toute requête de matching).
-- ----------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_invoices_pending_match;
CREATE INDEX IF NOT EXISTS idx_invoices_tenant_pending_match
    ON dgi_invoices (tenant_id, customer_phone, amount_ttc)
    WHERE status = 'PENDING';

DROP INDEX IF EXISTS idx_transactions_unmatched;
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_unmatched
    ON financial_transactions (tenant_id, sender_phone, net_amount)
    WHERE status = 'UNMATCHED';

CREATE INDEX IF NOT EXISTS idx_invoices_tenant_id ON dgi_invoices (tenant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tenant_id ON financial_transactions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_matches_tenant_id ON reconciliation_matches (tenant_id);

COMMIT;
