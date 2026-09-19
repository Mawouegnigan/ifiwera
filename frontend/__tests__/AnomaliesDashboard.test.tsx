import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AnomaliesDashboard from '../AnomaliesDashboard';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

const ORPHANS_PAYLOAD = {
  orphanTransactions: [
    {
      id: 10,
      reference_api_momo: 'TX-10',
      source_channel: 'MTN_MOMO',
      sender_phone: '+22997000000',
      sender_name: 'Client Alpha',
      net_amount: 15000,
      processed_at: '2026-09-01T10:00:00.000Z',
    },
  ],
  unpaidInvoices: [
    {
      id: 20,
      invoice_uid: 'F-020',
      customer_name: 'Client Beta',
      customer_phone: '+22997000000',
      amount_ttc: 15000,
      issued_at: '2026-08-30T10:00:00.000Z',
    },
  ],
};

const SUMMARY_PAYLOAD = {
  matched_count: 42,
  matched_percentage: 87,
  matched_amount_fcfa: 2_500_000,
  discrepancy_amount_fcfa: 50_000,
  unmatched_transactions_count: 1,
  unmatched_invoices_count: 1,
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function mockApiDefault() {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/api/reconciliation/orphans') return jsonResponse(200, ORPHANS_PAYLOAD);
    if (path === '/api/reconciliation/summary') return jsonResponse(200, SUMMARY_PAYLOAD);
    if (path === '/api/reconciliation/manual-match') return jsonResponse(200, {});
    throw new Error(`URL inattendue dans le test: ${path}`);
  });
}

describe('AnomaliesDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiDefault();
  });

  it('charge et affiche les transactions orphelines, factures impayées et le résumé', async () => {
    render(<AnomaliesDashboard />);

    expect(await screen.findByText('Client Alpha')).toBeInTheDocument();
    expect(screen.getByText('F-020')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => element?.tagName.toLowerCase() === 'span' && /87%/.test(element.textContent ?? ''))
    ).toBeInTheDocument();
  });

  it('sélectionner une transaction et une facture permet de les lier manuellement', async () => {
    const user = userEvent.setup();
    render(<AnomaliesDashboard />);

    await user.click(await screen.findByText('Client Alpha')); // carte transaction
    await user.click(screen.getByText('F-020')); // carte facture

    const linkButton = screen.getByRole('button', { name: /lier manuellement/i });
    expect(linkButton).toBeInTheDocument();
    await user.click(linkButton);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/reconciliation/manual-match',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ invoiceId: 20, transactionId: 10 }) })
      )
    );
    expect(await screen.findByText(/ligne rapprochée manuellement/i)).toBeInTheDocument();
    // Les éléments liés disparaissent des deux colonnes
    expect(screen.queryByText('F-020')).not.toBeInTheDocument();
  });

  it('affiche un message d\'échec si la liaison manuelle échoue côté serveur', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/reconciliation/orphans') return jsonResponse(200, ORPHANS_PAYLOAD);
      if (path === '/api/reconciliation/summary') return jsonResponse(200, SUMMARY_PAYLOAD);
      if (path === '/api/reconciliation/manual-match') return jsonResponse(500, { error: 'boom' });
      throw new Error(`URL inattendue dans le test: ${path}`);
    });
    render(<AnomaliesDashboard />);

    await user.click(await screen.findByText('Client Alpha'));
    await user.click(screen.getByText('F-020'));
    await user.click(screen.getByRole('button', { name: /lier manuellement/i }));

    expect(await screen.findByText(/la liaison a échoué/i)).toBeInTheDocument();
    // Rien n'a été retiré des colonnes puisque la liaison a échoué
    expect(screen.getByText('F-020')).toBeInTheDocument();
  });
});
