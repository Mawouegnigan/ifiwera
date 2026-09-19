import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import ImportWorkspace from '../ImportWorkspace';
import { apiFetch } from '../lib/api';
import { detectExtension, guessSourceChannel, parseInvoicesCsv, parseTransactionsCsv } from '../lib/fileParsers';

// ----------------------------------------------------------------------------
// lib/fileParsers est mocké : ce fichier teste le comportement du composant
// (états, appels réseau, enchaînement des phases), pas la logique de parsing
// elle-même — déjà couverte en profondeur par lib/__tests__/fileParsers.test.ts.
// ----------------------------------------------------------------------------
vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('../lib/fileParsers', () => ({
  detectExtension: vi.fn(),
  guessSourceChannel: vi.fn(() => 'MTN_MOMO'),
  parseInvoicesCsv: vi.fn(),
  parseInvoicesJson: vi.fn(),
  parseInvoicesExcel: vi.fn(),
  parseTransactionsCsv: vi.fn(),
  parseTransactionsJson: vi.fn(),
  parseTransactionsExcel: vi.fn(),
  parseTransactionsPdf: vi.fn(),
}));

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// Les deux <input type="file"> cachés ne sont pas distinguables par leur nom
// accessible (même libellé de dépôt dans les deux zones) — on les récupère
// par ordre dans le DOM : factures d'abord, relevés ensuite (ordre du JSX).
function getFileInputs(container: HTMLElement) {
  const inputs = container.querySelectorAll('input[type="file"]');
  return { invoiceInput: inputs[0] as HTMLInputElement, transactionInput: inputs[1] as HTMLInputElement };
}

function renderWorkspace() {
  return render(
    <MemoryRouter>
      <ImportWorkspace />
    </MemoryRouter>
  );
}

describe('ImportWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('affiche les deux zones de dépôt et aucun bouton d\'import tant qu\'aucun fichier n\'est prêt', () => {
    renderWorkspace();

    expect(screen.getByText(/factures dgi \/ mecef/i)).toBeInTheDocument();
    expect(screen.getByText(/relevés opérateurs \/ banques/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /importer ces fichiers/i })).not.toBeInTheDocument();
  });

  it('parse un CSV de factures déposé et active le bouton Importer une fois prêt', async () => {
    const user = userEvent.setup();
    vi.mocked(detectExtension).mockReturnValue('csv');
    vi.mocked(parseInvoicesCsv).mockReturnValue({
      rows: [{ invoice_uid: 'F001' } as any],
      issues: [],
    });

    const { container } = renderWorkspace();
    const { invoiceInput } = getFileInputs(container);
    const file = new File(['invoice_uid\nF001'], 'factures.csv', { type: 'text/csv' });

    await user.upload(invoiceInput, file);

    expect(await screen.findByText(/1 ligne\(s\) prête\(s\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /importer ces fichiers/i })).toBeEnabled();
  });

  it('marque un PDF de facture comme non supporté sans tenter de le parser', async () => {
    const user = userEvent.setup();
    vi.mocked(detectExtension).mockReturnValue('pdf');

    const { container } = renderWorkspace();
    const { invoiceInput } = getFileInputs(container);
    const file = new File(['%PDF-1.4'], 'facture.pdf', { type: 'application/pdf' });

    await user.upload(invoiceInput, file);

    expect(await screen.findByText(/lecture pdf pour les factures pas encore disponible/i)).toBeInTheDocument();
    expect(parseInvoicesCsv).not.toHaveBeenCalled();
  });

  it("importe puis déclenche la réconciliation, jusqu'à afficher le nombre de correspondances", async () => {
    const user = userEvent.setup();
    vi.mocked(detectExtension).mockReturnValue('csv');
    vi.mocked(parseTransactionsCsv).mockReturnValue({
      rows: [{ reference_api_momo: 'TX1' } as any],
      issues: [],
    });
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/import/transactions') return jsonResponse(200, { inserted: 1, skippedDuplicates: 0 });
      if (path === '/api/reconciliation/run') return jsonResponse(200, { matched_count: 1 });
      throw new Error(`URL inattendue dans le test: ${path}`);
    });

    const { container } = renderWorkspace();
    const { transactionInput } = getFileInputs(container);
    const file = new File(['reference_api_momo\nTX1'], 'momo.csv', { type: 'text/csv' });
    await user.upload(transactionInput, file);

    await user.click(await screen.findByRole('button', { name: /importer ces fichiers/i }));
    expect(await screen.findByText(/import terminé/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /lancer la réconciliation automatique/i }));

    expect(await screen.findByText(/correspondance\(s\) trouvée\(s\) automatiquement/i)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith('/api/reconciliation/run', { method: 'POST' });
  });
});