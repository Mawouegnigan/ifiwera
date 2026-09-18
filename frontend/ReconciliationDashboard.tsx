import React, { useEffect, useState, useCallback } from 'react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { apiFetch } from './lib/api';

// ----------------------------------------------------------------------------
// Types (miroir de ReconciliationAnalytics côté backend)
// ----------------------------------------------------------------------------
interface LevelBreakdownRow {
  level: 1 | 2 | 3 | 4;
  score: number;
  count: number;
}

interface ChannelBreakdownRow {
  channel: string;
  matched_count: number;
  unmatched_count: number;
  matched_amount_fcfa: number;
}

interface DailyMatchRow {
  day: string;
  matched_count: number;
  matched_amount_fcfa: number;
}

interface Analytics {
  levelBreakdown: LevelBreakdownRow[];
  channelBreakdown: ChannelBreakdownRow[];
  timeSeries: DailyMatchRow[];
  partialInvoices: { count: number; outstanding_fcfa: number };
}

interface Summary {
  matched_count: number;
  matched_percentage: number;
  matched_amount_fcfa: number;
  discrepancy_amount_fcfa: number;
  unmatched_transactions_count: number;
  unmatched_invoices_count: number;
}

// ----------------------------------------------------------------------------
// Constantes visuelles — mêmes tons que AnomaliesDashboard.tsx
// ----------------------------------------------------------------------------
const LEVEL_LABELS: Record<number, string> = {
  1: 'Niveau 1 — Exact',
  2: 'Niveau 2 — Référence',
  3: 'Niveau 3 — Flou',
  4: 'Niveau 4 — Partiel',
};

const LEVEL_COLORS: Record<number, string> = {
  1: '#4FBF9F',
  2: '#5B9BD5',
  3: '#C9A24B',
  4: '#D97757',
};

const SOURCE_LABELS: Record<string, string> = {
  MTN_MOMO: 'MTN MoMo',
  MOOV_MONEY: 'Moov Money',
  BANK_UBA: 'UBA',
  BANK_BOA: 'BOA',
  BANK_ECOBANK: 'Ecobank',
  CASH: 'Espèces',
};

const CHART_GRID = '#2E3F3C';
const CHART_TEXT = '#9FB0A9';

function formatFcfa(amount: number): string {
  return new Intl.NumberFormat('fr-FR').format(amount) + ' FCFA';
}

function formatDayShort(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(iso));
}

// ----------------------------------------------------------------------------
// Composant principal
// ----------------------------------------------------------------------------
export default function ReconciliationDashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, analyticsRes] = await Promise.all([
        apiFetch('/api/reconciliation/summary').then((r) => r.json()),
        apiFetch('/api/reconciliation/analytics').then((r) => r.json()),
      ]);
      setSummary(summaryRes);
      setAnalytics(analyticsRes);
    } catch {
      setError("Impossible de charger les statistiques de rapprochement.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#1A2422] p-8">
        <div className="max-w-6xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg bg-[#212C2A] animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !summary || !analytics) {
    return (
      <div className="min-h-screen bg-[#1A2422] text-[#E4E7E2] flex items-center justify-center">
        <p className="text-sm text-[#D97757]">{error || 'Aucune donnée disponible.'}</p>
      </div>
    );
  }

  const levelChartData = analytics.levelBreakdown.map((row) => ({
    name: LEVEL_LABELS[row.level] || `Score ${row.score}`,
    count: row.count,
    fill: LEVEL_COLORS[row.level] || '#9FB0A9',
  }));

  const channelChartData = analytics.channelBreakdown.map((row) => ({
    name: SOURCE_LABELS[row.channel] || row.channel,
    matché: row.matched_count,
    'en suspens': row.unmatched_count,
  }));

  const timeSeriesData = analytics.timeSeries.map((row) => ({
    day: formatDayShort(row.day),
    montant: row.matched_amount_fcfa,
    nombre: row.matched_count,
  }));

  return (
    <div className="min-h-screen bg-[#1A2422] text-[#E4E7E2] font-sans">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-[#F0EDE6]">Tableau de bord — Rapprochement</h1>
          <p className="text-sm text-[#9FB0A9] mt-1">
            Vue d'ensemble de la performance du moteur de matching automatique.
          </p>
        </header>

        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden border border-[#2E3F3C] mb-6">
          <Stat label="Taux de rapprochement" value={`${summary.matched_percentage}%`} />
          <Stat label="Montant rapproché" value={formatFcfa(summary.matched_amount_fcfa)} />
          <Stat
            label="Factures partielles"
            value={`${analytics.partialInvoices.count}`}
            sub={analytics.partialInvoices.count > 0 ? formatFcfa(analytics.partialInvoices.outstanding_fcfa) + ' restant' : undefined}
            tone="warn"
          />
          <Stat label="Écart total en suspens" value={formatFcfa(summary.discrepancy_amount_fcfa)} tone="warn" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
          {/* Répartition par niveau */}
          <Panel title="Répartition par niveau de matching" subtitle="Nombre de rapprochements par score de confiance">
            {levelChartData.length === 0 ? (
              <EmptyState label="Aucun rapprochement effectué pour l'instant" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={levelChartData} dataKey="count" nameKey="name" innerRadius={50} outerRadius={90} paddingAngle={2}>
                    {levelChartData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: '#212C2A', border: `1px solid ${CHART_GRID}`, borderRadius: 8, color: '#E4E7E2' }} />
                  <Legend wrapperStyle={{ fontSize: 12, color: CHART_TEXT }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Répartition par canal */}
          <Panel title="Répartition par canal de paiement" subtitle="Transactions rapprochées vs en suspens">
            {channelChartData.length === 0 ? (
              <EmptyState label="Aucune transaction importée" />
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={channelChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                  <XAxis dataKey="name" stroke={CHART_TEXT} fontSize={12} />
                  <YAxis stroke={CHART_TEXT} fontSize={12} />
                  <Tooltip contentStyle={{ background: '#212C2A', border: `1px solid ${CHART_GRID}`, borderRadius: 8, color: '#E4E7E2' }} />
                  <Legend wrapperStyle={{ fontSize: 12, color: CHART_TEXT }} />
                  <Bar dataKey="matché" stackId="a" fill="#4FBF9F" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="en suspens" stackId="a" fill="#C9A24B" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>
        </div>

        {/* Série temporelle */}
        <Panel title="Volume rapproché — 30 derniers jours" subtitle="Montant total matché par jour">
          {timeSeriesData.length === 0 ? (
            <EmptyState label="Aucun rapprochement sur les 30 derniers jours" />
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={timeSeriesData}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_GRID} />
                <XAxis dataKey="day" stroke={CHART_TEXT} fontSize={12} />
                <YAxis stroke={CHART_TEXT} fontSize={12} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                <Tooltip
                  contentStyle={{ background: '#212C2A', border: `1px solid ${CHART_GRID}`, borderRadius: 8, color: '#E4E7E2' }}
                  formatter={(value: number) => formatFcfa(value)}
                />
                <Line type="monotone" dataKey="montant" stroke="#4FBF9F" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Sous-composants
// ----------------------------------------------------------------------------
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

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[#2E3F3C] bg-[#202B29] px-5 py-4">
      <h2 className="text-sm font-semibold text-[#F0EDE6]">{title}</h2>
      <p className="text-xs text-[#9FB0A9] mt-0.5 mb-3">{subtitle}</p>
      {children}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return <div className="h-[260px] flex items-center justify-center text-sm text-[#6B7D77]">{label}</div>;
}