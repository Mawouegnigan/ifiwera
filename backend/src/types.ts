export type UserRole = 'OWNER' | 'MEMBER';

export interface Tenant {
  id: number;
  name: string;
  created_at: string;
}

export interface User {
  id: number;
  tenant_id: number;
  email: string;
  role: UserRole;
  created_at: string;
}

export type InvoiceStatus = 'PENDING' | 'MATCHED' | 'PARTIAL';
export type TransactionStatus = 'UNMATCHED' | 'MATCHED' | 'REJECTED';
export type SourceChannel = 'MTN_MOMO' | 'MOOV_MONEY' | 'BANK_UBA' | 'BANK_BOA' | 'BANK_ECOBANK' | 'CASH';
export type MatchedBy = 'AUTOMATIC_ALGORITHM' | 'MANUAL_USER';

export interface DgiInvoice {
  id: number;
  tenant_id: number;
  invoice_uid: string;
  customer_name: string | null;
  customer_phone: string | null;
  amount_ttc: number;
  amount_paid_ttc: number;
  memo_reference: string | null;
  issued_at: string; // ISO timestamp
  status: InvoiceStatus;
}

export interface FinancialTransaction {
  id: number;
  tenant_id: number;
  reference_api_momo: string;
  source_channel: SourceChannel;
  sender_phone: string | null;
  sender_name: string | null;
  amount_received: number;
  fees: number;
  net_amount: number;
  processed_at: string; // ISO timestamp
  status: TransactionStatus;
}

export interface ReconciliationMatch {
  id: number;
  tenant_id: number;
  invoice_id: number;
  transaction_id: number;
  match_score: number;
  matched_by: MatchedBy;
  matched_at: string;
}

export interface MatchResult {
  transaction: FinancialTransaction;
  invoice: DgiInvoice;
  score: number;
  level: 1 | 2 | 3 | 4;
}

export interface ReconciliationSummary {
  total_transactions: number;
  total_invoices: number;
  matched_count: number;
  matched_amount_fcfa: number;
  matched_percentage: number;
  unmatched_transactions_count: number;
  unmatched_invoices_count: number;
  discrepancy_amount_fcfa: number;
}

export interface LevelBreakdownRow {
  level: 1 | 2 | 3 | 4;
  score: number;
  count: number;
}

export interface ChannelBreakdownRow {
  channel: SourceChannel;
  matched_count: number;
  unmatched_count: number;
  matched_amount_fcfa: number;
}

export interface DailyMatchRow {
  day: string; // 'YYYY-MM-DD'
  matched_count: number;
  matched_amount_fcfa: number;
}

export interface ReconciliationAnalytics {
  levelBreakdown: LevelBreakdownRow[];
  channelBreakdown: ChannelBreakdownRow[];
  timeSeries: DailyMatchRow[];
  partialInvoices: {
    count: number;
    outstanding_fcfa: number;
  };
}