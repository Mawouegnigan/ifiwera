import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ReconciliationDashboard from '../ReconciliationDashboard';
import { apiFetch } from '../lib/api';

vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

const SUMMARY_PAYLOAD = {
  matched_count: 42,
  matched_percentage: 87,
  matched_amount_fcfa: 2_500_000,
  discrepancy_amount_fcfa: 50_000,
  unmatched_transactions_count: 2,
  unmatched_invoices_count: 3,
};

const EMPTY_ANALYTICS_PAYLOAD = {
  levelBreakdown: [],
  channelBreakdown: [],
  timeSeries: [],
  partialInvoices: { count: 0, outstanding_fcfa: 0 },
};

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('ReconciliationDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('affiche les KPIs et les états vides quand aucune donnée analytique n\'existe encore', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/reconciliation/summary') return jsonResponse(200, SUMMARY_PAYLOAD);
      if (path === '/api/reconciliation/analytics') return jsonResponse(200, EMPTY_ANALYTICS_PAYLOAD);
      throw new Error(`URL inattendue dans le test: ${path}`);
    });

    render(<ReconciliationDashboard />);

    expect(await screen.findByText('87%')).toBeInTheDocument();
    expect(screen.getAllByText(/aucun rapprochement/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/aucune transaction importée/i)).toBeInTheDocument();
  });

  it('affiche un message d\'erreur si le chargement des statistiques échoue', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('network down'));

    render(<ReconciliationDashboard />);

    expect(await screen.findByText(/impossible de charger les statistiques/i)).toBeInTheDocument();
  });

  it('affiche les factures partielles en suspens quand il y en a', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/reconciliation/summary') return jsonResponse(200, SUMMARY_PAYLOAD);
      if (path === '/api/reconciliation/analytics')
        return jsonResponse(200, { ...EMPTY_ANALYTICS_PAYLOAD, partialInvoices: { count: 2, outstanding_fcfa: 12_500 } });
      throw new Error(`URL inattendue dans le test: ${path}`);
    });

    render(<ReconciliationDashboard />);

    const label = await screen.findByText('Factures partielles');
    const statBlock = label.parentElement as HTMLElement;
    expect(statBlock).toHaveTextContent('2');
    expect(statBlock).toHaveTextContent(/12\s?500\s?FCFA restant/);
  });
});
