import React, { useCallback, useRef, useState } from 'react';
import {
  UploadCloud,
  FileText,
  FileSpreadsheet,
  X,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PlayCircle,
  ChevronRight,
} from 'lucide-react';
import {
  detectExtension,
  guessSourceChannel,
  parseInvoicesCsv,
  parseInvoicesJson,
  parseInvoicesExcel,
  parseTransactionsCsv,
  parseTransactionsJson,
  parseTransactionsExcel,
  parseTransactionsPdf,
  NormalizedInvoice,
  NormalizedTransaction,
  SourceChannel,
  ParseIssue,
} from './lib/fileParsers';
import { apiFetch } from './lib/api';
import { Link } from 'react-router-dom';

// ----------------------------------------------------------------------------
// Types locaux
// ----------------------------------------------------------------------------
type StagedKind = 'invoice' | 'transaction';
type StagedStatus = 'parsing' | 'ready' | 'unsupported' | 'error';

interface StagedFile {
  id: string;
  fileName: string;
  kind: StagedKind;
  status: StagedStatus;
  rowCount: number;
  issues: ParseIssue[];
  errorMessage?: string;
  channel?: SourceChannel; // transactions uniquement
  invoiceRows?: NormalizedInvoice[];
  transactionRows?: NormalizedTransaction[];
}

type Phase = 'staging' | 'importing' | 'imported' | 'reconciling' | 'done';

const SOURCE_LABELS: Record<SourceChannel, string> = {
  MTN_MOMO: 'MTN MoMo',
  MOOV_MONEY: 'Moov Money',
  BANK_UBA: 'UBA',
  BANK_BOA: 'BOA',
  BANK_ECOBANK: 'Ecobank',
  CASH: 'Espèces',
};

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ----------------------------------------------------------------------------
// Composant principal
// ----------------------------------------------------------------------------
export default function ImportWorkspace() {
  const [invoiceFiles, setInvoiceFiles] = useState<StagedFile[]>([]);
  const [transactionFiles, setTransactionFiles] = useState<StagedFile[]>([]);
  const [phase, setPhase] = useState<Phase>('staging');
  const [importSummary, setImportSummary] = useState<{
    invoicesInserted: number;
    invoicesSkipped: number;
    transactionsInserted: number;
    transactionsSkipped: number;
  } | null>(null);
  const [reconciliationSummary, setReconciliationSummary] = useState<{ matched_count: number } | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const invoiceInputRef = useRef<HTMLInputElement>(null);
  const transactionInputRef = useRef<HTMLInputElement>(null);

  // --------------------------------------------------------------------------
  // Ajout de fichiers (drag & drop ou sélecteur natif)
  // --------------------------------------------------------------------------
  const handleFiles = useCallback(async (fileList: FileList | File[], kind: StagedKind) => {
    const files = Array.from(fileList);

    for (const file of files) {
      const ext = detectExtension(file.name);
      const staged: StagedFile = {
        id: uid(),
        fileName: file.name,
        kind,
        status: 'parsing',
        rowCount: 0,
        issues: [],
        channel: kind === 'transaction' ? guessSourceChannel(file.name) : undefined,
      };

      const setList = kind === 'invoice' ? setInvoiceFiles : setTransactionFiles;
      setList((prev) => [...prev, staged]);

      // Les factures DGI/MeCEF en PDF ne sont pas encore supportées (format
      // certifié différent des relevés opérateurs). "other" couvre les
      // extensions inconnues.
      if ((ext === 'pdf' && kind === 'invoice') || ext === 'other') {
        setList((prev) =>
          prev.map((f) =>
            f.id === staged.id
              ? {
                  ...f,
                  status: 'unsupported',
                  errorMessage:
                    ext === 'pdf'
                      ? 'Lecture PDF pour les factures pas encore disponible — exportez en CSV si possible.'
                      : 'Format de fichier non reconnu — utilisez CSV, JSON ou Excel (.xlsx).',
                }
              : f
          )
        );
        continue;
      }

      try {
        if (kind === 'invoice') {
          const result =
            ext === 'json'
              ? parseInvoicesJson(await file.text())
              : ext === 'xlsx' || ext === 'xls'
              ? await parseInvoicesExcel(file)
              : parseInvoicesCsv(await file.text());

          setInvoiceFiles((prev) =>
            prev.map((f) =>
              f.id === staged.id
                ? { ...f, status: 'ready', rowCount: result.rows.length, issues: result.issues, invoiceRows: result.rows }
                : f
            )
          );
        } else {
          const channel = staged.channel ?? 'CASH';
          const result =
            ext === 'pdf'
              ? await parseTransactionsPdf(file, channel)
              : ext === 'json'
              ? parseTransactionsJson(await file.text())
              : ext === 'xlsx' || ext === 'xls'
              ? await parseTransactionsExcel(file, channel)
              : parseTransactionsCsv(await file.text(), channel);

          setTransactionFiles((prev) =>
            prev.map((f) =>
              f.id === staged.id
                ? {
                    ...f,
                    status: 'ready',
                    rowCount: result.rows.length,
                    issues: result.issues,
                    transactionRows: result.rows,
                  }
                : f
            )
          );
        }
      } catch (err) {
        setList((prev) =>
          prev.map((f) =>
            f.id === staged.id
              ? { ...f, status: 'error', errorMessage: (err as Error).message || 'Fichier illisible.' }
              : f
          )
        );
      }
    }
  }, []);

  function updateChannel(fileId: string, channel: SourceChannel) {
    setTransactionFiles((prev) =>
      prev.map((f) => {
        if (f.id !== fileId || !f.transactionRows) return f;
        return {
          ...f,
          channel,
          transactionRows: f.transactionRows.map((r) => ({ ...r, source_channel: channel })),
        };
      })
    );
  }

  function removeFile(fileId: string, kind: StagedKind) {
    const setList = kind === 'invoice' ? setInvoiceFiles : setTransactionFiles;
    setList((prev) => prev.filter((f) => f.id !== fileId));
  }

  // --------------------------------------------------------------------------
  // Import puis déclenchement de la réconciliation
  // --------------------------------------------------------------------------
  const readyInvoiceRows = invoiceFiles.filter((f) => f.status === 'ready').flatMap((f) => f.invoiceRows ?? []);
  const readyTransactionRows = transactionFiles
    .filter((f) => f.status === 'ready')
    .flatMap((f) => f.transactionRows ?? []);

  const canImport = phase === 'staging' && (readyInvoiceRows.length > 0 || readyTransactionRows.length > 0);

  async function handleImport() {
    setGlobalError(null);
    setPhase('importing');
    try {
      let invoicesInserted = 0;
      let invoicesSkipped = 0;
      let transactionsInserted = 0;
      let transactionsSkipped = 0;

      if (readyInvoiceRows.length > 0) {
        const res = await apiFetch('/api/import/invoices', {
          method: 'POST',
          body: JSON.stringify({ invoices: readyInvoiceRows }),
        });
        if (!res.ok) throw new Error("Échec de l'import des factures.");
        const data = await res.json();
        invoicesInserted = data.inserted;
        invoicesSkipped = data.skippedDuplicates;
      }

      if (readyTransactionRows.length > 0) {
        const res = await apiFetch('/api/import/transactions', {
          method: 'POST',
          body: JSON.stringify({ transactions: readyTransactionRows }),
        });
        if (!res.ok) throw new Error("Échec de l'import des transactions.");
        const data = await res.json();
        transactionsInserted = data.inserted;
        transactionsSkipped = data.skippedDuplicates;
      }

      setImportSummary({ invoicesInserted, invoicesSkipped, transactionsInserted, transactionsSkipped });
      setPhase('imported');
    } catch (err) {
      setGlobalError((err as Error).message);
      setPhase('staging');
    }
  }

  async function handleRunReconciliation() {
    setGlobalError(null);
    setPhase('reconciling');
    try {
      const res = await apiFetch('/api/reconciliation/run', { method: 'POST' });
      if (!res.ok) throw new Error('Échec de la réconciliation automatique.');
      const data = await res.json();
      setReconciliationSummary({ matched_count: data.matched_count });
      setPhase('done');
    } catch (err) {
      setGlobalError((err as Error).message);
      setPhase('imported');
    }
  }

  function handleStartOver() {
    setInvoiceFiles([]);
    setTransactionFiles([]);
    setImportSummary(null);
    setReconciliationSummary(null);
    setGlobalError(null);
    setPhase('staging');
  }

  return (
    <div className="min-h-screen bg-[#1A2422] text-[#E4E7E2] font-sans">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-[#F0EDE6]">Import des paiements et factures</h1>
          <p className="text-sm text-[#9FB0A9] mt-1">
            Déposez vos factures certifiées et vos relevés de paiement. Ifiwera se charge du rapprochement.
          </p>
        </header>

        {globalError && (
          <div className="mb-6 flex items-center gap-2 rounded-lg border border-[#5C3A3A] bg-[#241616] px-4 py-3 text-sm text-[#E7B4B4]">
            <AlertTriangle size={16} />
            {globalError}
          </div>
        )}

        {/* Deux zones de dépôt */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <DropZone
            accent="gold"
            title="Factures DGI / MeCEF"
            subtitle="Fichiers certifiés — CSV, JSON ou Excel déjà exporté"
            files={invoiceFiles}
            inputRef={invoiceInputRef}
            disabled={phase !== 'staging'}
            onFiles={(files) => handleFiles(files, 'invoice')}
            onRemove={(id) => removeFile(id, 'invoice')}
          />
          <DropZone
            accent="green"
            title="Relevés opérateurs / banques"
            subtitle="MTN MoMo, Moov Money, UBA, BOA, Ecobank — CSV, JSON ou Excel"
            files={transactionFiles}
            inputRef={transactionInputRef}
            disabled={phase !== 'staging'}
            onFiles={(files) => handleFiles(files, 'transaction')}
            onRemove={(id) => removeFile(id, 'transaction')}
            onChangeChannel={updateChannel}
          />
        </div>

        {/* Bilan de préparation */}
        {(invoiceFiles.length > 0 || transactionFiles.length > 0) && phase === 'staging' && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[#2E3F3C] bg-[#202B29] px-5 py-4">
            <div className="text-sm text-[#9FB0A9]">
              <span className="text-[#F0EDE6] font-medium">{readyInvoiceRows.length}</span> facture(s) et{' '}
              <span className="text-[#F0EDE6] font-medium">{readyTransactionRows.length}</span> transaction(s) prêtes à
              être importées.
            </div>
            <button
              onClick={handleImport}
              disabled={!canImport}
              className="inline-flex items-center gap-2 rounded-md bg-[#C9A24B] px-4 py-2 text-sm font-medium text-[#1A2422] hover:bg-[#DCB65E] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <UploadCloud size={16} />
              Importer ces fichiers
            </button>
          </div>
        )}

        {phase === 'importing' && (
          <div className="mt-6 flex items-center gap-3 rounded-lg border border-[#2E3F3C] bg-[#202B29] px-5 py-4 text-sm text-[#9FB0A9]">
            <Loader2 size={16} className="animate-spin text-[#C9A24B]" />
            Import en cours…
          </div>
        )}

        {/* Résumé d'import + bouton de réconciliation */}
        {(phase === 'imported' || phase === 'reconciling' || phase === 'done') && importSummary && (
          <div className="mt-6 rounded-lg border border-[#2E3F3C] bg-[#202B29] px-5 py-5">
            <div className="flex items-center gap-2 text-[#4FBF9F] text-sm font-medium mb-3">
              <CheckCircle2 size={16} />
              Import terminé
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm text-[#9FB0A9] mb-5">
              <div>
                <span className="text-[#F0EDE6] font-semibold">{importSummary.invoicesInserted}</span> facture(s)
                ajoutée(s)
                {importSummary.invoicesSkipped > 0 && (
                  <span className="block text-xs mt-0.5">{importSummary.invoicesSkipped} doublon(s) ignoré(s)</span>
                )}
              </div>
              <div>
                <span className="text-[#F0EDE6] font-semibold">{importSummary.transactionsInserted}</span>{' '}
                transaction(s) ajoutée(s)
                {importSummary.transactionsSkipped > 0 && (
                  <span className="block text-xs mt-0.5">{importSummary.transactionsSkipped} doublon(s) ignoré(s)</span>
                )}
              </div>
            </div>

            {phase !== 'done' ? (
              <button
                onClick={handleRunReconciliation}
                disabled={phase === 'reconciling'}
                className="inline-flex items-center gap-2 rounded-md bg-[#4FBF9F] px-4 py-2 text-sm font-medium text-[#1A2422] hover:bg-[#63D4B3] disabled:opacity-50 transition-colors"
              >
                {phase === 'reconciling' ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Réconciliation en cours…
                  </>
                ) : (
                  <>
                    <PlayCircle size={16} /> Lancer la réconciliation automatique
                  </>
                )}
              </button>
            ) : (
              reconciliationSummary && (
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-[#3D5751] bg-[#212C2A] px-4 py-3">
                  <div className="text-sm">
                    <span className="text-[#4FBF9F] font-semibold">{reconciliationSummary.matched_count}</span>{' '}
                    <span className="text-[#9FB0A9]">correspondance(s) trouvée(s) automatiquement.</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Link
                      to="/anomalies"
                      className="inline-flex items-center gap-1 text-sm text-[#C9A24B] hover:text-[#DCB65E] transition-colors"
                    >
                      Voir les suspens restants <ChevronRight size={14} />
                    </Link>
                    <button
                      onClick={handleStartOver}
                      className="text-sm text-[#9FB0A9] hover:text-[#E4E7E2] transition-colors"
                    >
                      Nouvel import
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Zone de dépôt
// ----------------------------------------------------------------------------
function DropZone({
  accent,
  title,
  subtitle,
  files,
  inputRef,
  disabled,
  onFiles,
  onRemove,
  onChangeChannel,
}: {
  accent: 'gold' | 'green';
  title: string;
  subtitle: string;
  files: StagedFile[];
  inputRef: React.RefObject<HTMLInputElement>;
  disabled: boolean;
  onFiles: (files: FileList) => void;
  onRemove: (id: string) => void;
  onChangeChannel?: (fileId: string, channel: SourceChannel) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const accentColor = accent === 'gold' ? '#C9A24B' : '#4FBF9F';

  return (
    <div className="rounded-lg border border-[#2E3F3C] bg-[#202B29] overflow-hidden">
      <div className="px-5 py-4 border-b border-[#2E3F3C]">
        <h2 className="text-sm font-semibold text-[#F0EDE6]">{title}</h2>
        <p className="text-xs text-[#9FB0A9] mt-0.5">{subtitle}</p>
      </div>

      <div className="p-5">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            if (!disabled) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!disabled && e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
          }}
          className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-8 text-center cursor-pointer transition-colors ${
            disabled
              ? 'opacity-40 cursor-not-allowed border-[#2E3F3C]'
              : dragging
              ? 'border-[--accent] bg-[#212C2A]'
              : 'border-[#3D5751] hover:border-[#4A6960] hover:bg-[#212C2A]'
          }`}
          style={{ ['--accent' as string]: accentColor }}
        >
          <UploadCloud size={22} style={{ color: dragging ? accentColor : '#9FB0A9' }} />
          <span className="text-sm text-[#E4E7E2]">Glissez-déposez vos fichiers ici</span>
          <span className="text-xs text-[#6B7D77]">ou cliquez pour parcourir — CSV, JSON, Excel (.xlsx)</span>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".csv,.json,.xlsx,.xls,.pdf,.txt"
            className="hidden"
            disabled={disabled}
            onChange={(e) => {
              if (e.target.files) onFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>

        {files.length > 0 && (
          <ul className="mt-4 space-y-2">
            {files.map((f) => (
              <FileRow key={f.id} file={f} disabled={disabled} onRemove={onRemove} onChangeChannel={onChangeChannel} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  disabled,
  onRemove,
  onChangeChannel,
}: {
  file: StagedFile;
  disabled: boolean;
  onRemove: (id: string) => void;
  onChangeChannel?: (fileId: string, channel: SourceChannel) => void;
}) {
  const Icon = file.fileName.endsWith('.json') ? FileText : FileSpreadsheet;

  return (
    <li className="rounded-md bg-[#212C2A] border border-[#2E3F3C] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={14} className="text-[#9FB0A9] shrink-0" />
          <span className="text-sm text-[#E4E7E2] truncate">{file.fileName}</span>
        </div>
        {!disabled && (
          <button onClick={() => onRemove(file.id)} className="text-[#6B7D77] hover:text-[#E4E7E2] shrink-0">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        {file.status === 'parsing' && (
          <span className="inline-flex items-center gap-1 text-[#9FB0A9]">
            <Loader2 size={12} className="animate-spin" /> Analyse…
          </span>
        )}
        {file.status === 'ready' && (
          <span className="inline-flex items-center gap-1 text-[#4FBF9F]">
            <CheckCircle2 size={12} /> {file.rowCount} ligne(s) prête(s)
          </span>
        )}
        {file.status === 'unsupported' && (
          <span className="inline-flex items-center gap-1 text-[#C9A24B]">
            <AlertTriangle size={12} /> {file.errorMessage}
          </span>
        )}
        {file.status === 'error' && (
          <span className="inline-flex items-center gap-1 text-[#E7B4B4]">
            <AlertTriangle size={12} /> {file.errorMessage}
          </span>
        )}
        {file.issues.length > 0 && (
          <span className="text-[#9FB0A9]">· {file.issues.length} ligne(s) ignorée(s)</span>
        )}
      </div>

      {file.kind === 'transaction' && file.status === 'ready' && onChangeChannel && (
        <div className="mt-2">
          <select
            value={file.channel}
            disabled={disabled}
            onChange={(e) => onChangeChannel(file.id, e.target.value as SourceChannel)}
            className="w-full rounded bg-[#263531] border border-[#3D5751] px-2 py-1.5 text-xs text-[#E4E7E2]"
          >
            {(Object.keys(SOURCE_LABELS) as SourceChannel[]).map((c) => (
              <option key={c} value={c}>
                {SOURCE_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
      )}
    </li>
  );
}
