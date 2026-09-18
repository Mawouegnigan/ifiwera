import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Link2, Phone, Calendar, ArrowRightLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import { apiFetch } from './lib/api';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
interface OrphanTransaction {
  id: number;
  reference_api_momo: string;
  source_channel: string;
  sender_phone: string | null;
  sender_name: string | null;
  net_amount: number;
  processed_at: string;
}

interface UnpaidInvoice {
  id: number;
  invoice_uid: string;
  customer_name: string | null;
  customer_phone: string | null;
  amount_ttc: number;
  issued_at: string;
}

interface Summary {
  matched_count: number;
  matched_percentage: number;
  matched_amount_fcfa: number;
  discrepancy_amount_fcfa: number;
  unmatched_transactions_count: number;
  unmatched_invoices_count: number;
}

const SOURCE_LABELS: Record<string, string> = {
  MTN_MOMO: 'MTN MoMo',
  MOOV_MONEY: 'Moov Money',
  BANK_UBA: 'UBA',
  BANK_BOA: 'BOA',
  BANK_ECOBANK: 'Ecobank',
  CASH: 'Espèces',
};

function formatFcfa(amount: number): string {
  return new Intl.NumberFormat('fr-FR').format(amount) + ' FCFA';
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso)
  );
}

// ----------------------------------------------------------------------------
// Composant principal
// ----------------------------------------------------------------------------
export default function AnomaliesDashboard() {
  const [transactions, setTransactions] = useState<OrphanTransaction[]>([]);
  const [invoices, setInvoices] = useState<UnpaidInvoice[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selectedTx, setSelectedTx] = useState<number | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [orphansRes, summaryRes] = await Promise.all([
        apiFetch('/api/reconciliation/orphans').then((r) => r.json()),
        apiFetch('/api/reconciliation/summary').then((r) => r.json()),
      ]);
      setTransactions(orphansRes.orphanTransactions ?? []);
      setInvoices(orphansRes.unpaidInvoices ?? []);
      setSummary(summaryRes);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const canLink = selectedTx !== null && selectedInvoice !== null;

  const selectedPair = useMemo(() => {
    const tx = transactions.find((t) => t.id === selectedTx);
    const inv = invoices.find((i) => i.id === selectedInvoice);
    return { tx, inv };
  }, [selectedTx, selectedInvoice, transactions, invoices]);

  async function handleManualLink() {
    if (!canLink) return;
    setLinking(true);
    try {
      const res = await apiFetch('/api/reconciliation/manual-match', {
        method: 'POST',
        body: JSON.stringify({ invoiceId: selectedInvoice, transactionId: selectedTx }),
      });
      if (!res.ok) throw new Error('Échec de la liaison');
      setTransactions((prev) => prev.filter((t) => t.id !== selectedTx));
      setInvoices((prev) => prev.filter((i) => i.id !== selectedInvoice));
      setSelectedTx(null);
      setSelectedInvoice(null);
      setToast('Ligne rapprochée manuellement.');
      setTimeout(() => setToast(null), 2500);
    } catch {
      setToast("La liaison a échoué. Réessayez.");
      setTimeout(() => setToast(null), 2500);
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#1A2422] text-[#E4E7E2] font-sans">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-[#F0EDE6]">Suspens de réconciliation</h1>
          <p className="text-sm text-[#9FB0A9] mt-1">
            Traitez manuellement les paiements et factures qui n'ont pas trouvé de correspondance automatique.
          </p>
        </header>

        {/* Résumé statistique */}
        <SummaryBar summary={summary} loading={loading} />

        {/* Zone de liaison sélectionnée */}
        {canLink && (
          <div className="mt-6 flex items-center justify-between gap-4 rounded-lg border border-[#C9A24B] bg-[#263531] px-5 py-4">
            <div className="flex items-center gap-4 text-sm">
              <span className="text-[#C9A24B] font-medium">Prêt à lier :</span>
              <span>{selectedPair.tx?.sender_name || selectedPair.tx?.sender_phone}</span>
              <ArrowRightLeft size={16} className="text-[#9FB0A9]" />
              <span>{selectedPair.inv?.customer_name || selectedPair.inv?.invoice_uid}</span>
            </div>
            <button
              onClick={handleManualLink}
              disabled={linking}
              className="inline-flex items-center gap-2 rounded-md bg-[#C9A24B] px-4 py-2 text-sm font-medium text-[#1A2422] hover:bg-[#DCB65E] disabled:opacity-50 transition-colors"
            >
              <Link2 size={16} />
              {linking ? 'Liaison en cours…' : 'Lier manuellement'}
            </button>
          </div>
        )}

        {/* Double colonne */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <Column
            title="Transactions orphelines"
            subtitle="Argent reçu, aucune facture associée"
            emptyLabel="Aucune transaction orpheline"
            count={transactions.length}
          >
            {transactions.map((tx) => (
              <TransactionCard
                key={tx.id}
                tx={tx}
                selected={selectedTx === tx.id}
                onSelect={() => setSelectedTx(selectedTx === tx.id ? null : tx.id)}
              />
            ))}
          </Column>

          <Column
            title="Factures impayées"
            subtitle="Facture émise, aucun paiement reçu"
            emptyLabel="Aucune facture impayée"
            count={invoices.length}
          >
            {invoices.map((inv) => (
              <InvoiceCard
                key={inv.id}
                inv={inv}
                selected={selectedInvoice === inv.id}
                onSelect={() => setSelectedInvoice(selectedInvoice === inv.id ? null : inv.id)}
              />
            ))}
          </Column>
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-[#263531] border border-[#3D5751] px-4 py-2 text-sm text-[#E4E7E2] shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sous-composants
// ----------------------------------------------------------------------------
function SummaryBar({ summary, loading }: { summary: Summary | null; loading: boolean }) {
  if (loading || !summary) {
    return <div className="h-20 rounded-lg bg-[#212C2A] animate-pulse" />;
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden border border-[#2E3F3C]">
      <Stat label="Lignes rapprochées" value={`${summary.matched_count}`} sub={`${summary.matched_percentage}%`} />
      <Stat label="Montant rapproché" value={formatFcfa(summary.matched_amount_fcfa)} />
      <Stat label="Transactions en suspens" value={`${summary.unmatched_transactions_count}`} tone="warn" />
      <Stat label="Factures en suspens" value={`${summary.unmatched_invoices_count}`} tone="warn" />
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' }) {
  return (
    <div className="bg-[#212C2A] px-5 py-4">
      <div className="text-xs text-[#9FB0A9]">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone === 'warn' ? 'text-[#C9A24B]' : 'text-[#F0EDE6]'}`}>
        {value} {sub && <span className="text-sm font-normal text-[#9FB0A9]">({sub})</span>}
      </div>
    </div>
  );
}

function Column({
  title,
  subtitle,
  emptyLabel,
  count,
  children,
}: {
  title: string;
  subtitle: string;
  emptyLabel: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[#2E3F3C] bg-[#202B29]">
      <div className="px-5 py-4 border-b border-[#2E3F3C] flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-[#F0EDE6]">{title}</h2>
          <p className="text-xs text-[#9FB0A9] mt-0.5">{subtitle}</p>
        </div>
        <span className="text-xs rounded-full bg-[#263531] px-2.5 py-1 text-[#9FB0A9]">{count}</span>
      </div>
      <div className="max-h-[60vh] overflow-y-auto divide-y divide-[#1E2E2B]">
        {count === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-[#6B7D77]">{emptyLabel}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function TransactionCard({
  tx,
  selected,
  onSelect,
}: {
  tx: OrphanTransaction;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-5 py-3.5 transition-colors ${
        selected ? 'bg-[#1F3A33] border-l-2 border-[#4FBF9F]' : 'hover:bg-[#182422] border-l-2 border-transparent'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[#F0EDE6]">{tx.sender_name || 'Émetteur inconnu'}</span>
        <span className="text-sm font-semibold text-[#4FBF9F]">{formatFcfa(tx.net_amount)}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-xs text-[#9FB0A9]">
        <span className="rounded bg-[#263531] px-1.5 py-0.5">{SOURCE_LABELS[tx.source_channel] || tx.source_channel}</span>
        {tx.sender_phone && (
          <span className="inline-flex items-center gap-1">
            <Phone size={12} /> {tx.sender_phone}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <Calendar size={12} /> {formatDate(tx.processed_at)}
        </span>
      </div>
      {selected && (
        <div className="mt-2 inline-flex items-center gap-1 text-xs text-[#4FBF9F]">
          <CheckCircle2 size={12} /> Sélectionnée
        </div>
      )}
    </button>
  );
}

function InvoiceCard({
  inv,
  selected,
  onSelect,
}: {
  inv: UnpaidInvoice;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-5 py-3.5 transition-colors ${
        selected ? 'bg-[#3A2F1F] border-l-2 border-[#C9A24B]' : 'hover:bg-[#221E18] border-l-2 border-transparent'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[#F0EDE6]">{inv.customer_name || inv.invoice_uid}</span>
        <span className="text-sm font-semibold text-[#C9A24B]">{formatFcfa(inv.amount_ttc)}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-xs text-[#9FB0A9]">
        <span className="rounded bg-[#263531] px-1.5 py-0.5">{inv.invoice_uid}</span>
        {inv.customer_phone && (
          <span className="inline-flex items-center gap-1">
            <Phone size={12} /> {inv.customer_phone}
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <Calendar size={12} /> {formatDate(inv.issued_at)}
        </span>
      </div>
      {selected && (
        <div className="mt-2 inline-flex items-center gap-1 text-xs text-[#C9A24B]">
          <AlertTriangle size={12} /> Sélectionnée
        </div>
      )}
    </button>
  );
}
