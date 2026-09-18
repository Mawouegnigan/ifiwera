import { describe, it, expect } from 'vitest';
import { findBestMatch, normalizePhone } from '../matchingEngine';
import { DgiInvoice, FinancialTransaction } from '../types';

function makeInvoice(overrides: Partial<DgiInvoice>): DgiInvoice {
  return {
    id: 1,
    tenant_id: 1,
    invoice_uid: 'INV-0001',
    customer_name: null,
    customer_phone: null,
    amount_ttc: 0,
    amount_paid_ttc: 0,
    memo_reference: null,
    issued_at: '2026-01-10T09:00:00Z',
    status: 'PENDING',
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<FinancialTransaction>): FinancialTransaction {
  return {
    id: 100,
    tenant_id: 1,
    reference_api_momo: 'REF-0001',
    source_channel: 'MTN_MOMO',
    sender_phone: null,
    sender_name: null,
    amount_received: 0,
    fees: 0,
    net_amount: 0,
    processed_at: '2026-01-10T09:00:00Z',
    status: 'UNMATCHED',
    ...overrides,
  };
}

describe('normalizePhone', () => {
  it('retire les espaces, points et tirets', () => {
    expect(normalizePhone('97 11.22-33')).toBe('97112233');
  });

  it('retire le préfixe international +229', () => {
    expect(normalizePhone('+22997112233')).toBe(normalizePhone('97112233'));
  });

  it('ne modifie pas un numéro déjà propre', () => {
    expect(normalizePhone('97112233')).toBe('97112233');
  });
});

describe('findBestMatch — Niveau 1 (Match Parfait, score 100)', () => {
  it('matche quand le téléphone (formats différents) et le montant exact correspondent', () => {
    const tx = makeTransaction({ sender_phone: '+22997001122', net_amount: 5000 });
    const invoice = makeInvoice({ id: 1, customer_phone: '97 00 11 22', amount_ttc: 5000 });

    const result = findBestMatch(tx, [invoice]);

    expect(result).not.toBeNull();
    expect(result?.level).toBe(1);
    expect(result?.score).toBe(100);
    expect(result?.invoice.id).toBe(1);
  });

  it("un écart d'un franc bascule en Niveau 3 (flou) plutôt que d'être rejeté — l'écart est dans la tolérance des 2% prévue pour les frais MoMo", () => {
    const tx = makeTransaction({ sender_phone: '97001122', net_amount: 4999, processed_at: '2026-01-10T09:00:00Z' });
    const invoice = makeInvoice({ customer_phone: '97001122', amount_ttc: 5000, issued_at: '2026-01-10T09:00:00Z' });

    const result = findBestMatch(tx, [invoice]);

    expect(result?.level).not.toBe(1);
    expect(result?.level).toBe(3);
  });

  it('est prioritaire sur un match de Niveau 2 valide en parallèle', () => {
    const tx = makeTransaction({ reference_api_momo: 'REF-777', sender_phone: '97001122', net_amount: 3000 });
    const invoiceLevel2 = makeInvoice({ id: 10, customer_phone: null, amount_ttc: 3000, memo_reference: 'REF-777' });
    const invoiceLevel1 = makeInvoice({ id: 20, customer_phone: '97001122', amount_ttc: 3000 });

    const result = findBestMatch(tx, [invoiceLevel2, invoiceLevel1]);

    expect(result?.level).toBe(1);
    expect(result?.invoice.id).toBe(20);
  });
});

describe('findBestMatch — Niveau 2 (Match par ID/Référence, score 90)', () => {
  it('matche quand la référence opérateur est retrouvée dans le mémo, montant exact', () => {
    const tx = makeTransaction({ reference_api_momo: 'MOMO-9988', net_amount: 12000 });
    const invoice = makeInvoice({ memo_reference: 'MOMO-9988', amount_ttc: 12000 });

    const result = findBestMatch(tx, [invoice]);

    expect(result?.level).toBe(2);
    expect(result?.score).toBe(90);
  });

  it('ignore les espaces superflus autour de la référence', () => {
    const tx = makeTransaction({ reference_api_momo: '  MOMO-9988 ', net_amount: 12000 });
    const invoice = makeInvoice({ memo_reference: 'MOMO-9988', amount_ttc: 12000 });

    expect(findBestMatch(tx, [invoice])?.level).toBe(2);
  });

  it('ne matche pas si le montant diffère malgré une référence identique, ni les factures/transactions sans téléphone associé au Niveau 4', () => {
    const tx = makeTransaction({ reference_api_momo: 'MOMO-1', net_amount: 100 });
    const invoice = makeInvoice({ memo_reference: 'MOMO-1', amount_ttc: 200 });

    // Ni Niveau 2 (montant différent), ni Niveau 4 (aucun téléphone renseigné
    // d'un côté ou de l'autre — le Niveau 4 exige toujours un téléphone identique).
    expect(findBestMatch(tx, [invoice])).toBeNull();
  });
});

describe('findBestMatch — Niveau 3 (Match Temporel et Financier Flou, score 75)', () => {
  it('matche avec des frais MoMo de 1.5% et un écart de 3h', () => {
    const tx = makeTransaction({
      sender_phone: '97112233',
      net_amount: 9850,
      processed_at: '2026-01-10T12:00:00Z',
    });
    const invoice = makeInvoice({
      id: 40,
      customer_phone: '97112233',
      amount_ttc: 10000,
      issued_at: '2026-01-10T09:00:00Z',
    });

    const result = findBestMatch(tx, [invoice]);

    expect(result?.level).toBe(3);
    expect(result?.score).toBe(75);
    expect(result?.invoice.id).toBe(40);
  });

  it("un écart de montant supérieur à 2% (ratio < 0.98) bascule en Niveau 4 (paiement partiel), il n'est plus rejeté", () => {
    // Avant l'introduction du Niveau 4, ce cas était rejeté (null). Désormais,
    // un paiement à 97% du solde avec le même téléphone est un paiement
    // partiel légitime, pas une anomalie à écarter.
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 9700, processed_at: '2026-01-10T12:00:00Z' });
    const invoice = makeInvoice({ customer_phone: '97112233', amount_ttc: 10000, issued_at: '2026-01-10T09:00:00Z' });

    const result = findBestMatch(tx, [invoice]);

    expect(result?.level).toBe(4);
    expect(result?.score).toBe(50);
  });

  it('rejette un montant reçu supérieur à la facture (ratio > 1.0), y compris au Niveau 4', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 10050, processed_at: '2026-01-10T12:00:00Z' });
    const invoice = makeInvoice({ customer_phone: '97112233', amount_ttc: 10000, issued_at: '2026-01-10T09:00:00Z' });

    expect(findBestMatch(tx, [invoice])).toBeNull();
  });

  it('rejette un écart de temps supérieur à ±24h quand le ratio est proche de 1.0 (hors plage du Niveau 4)', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 9900, processed_at: '2026-01-12T12:00:00Z' });
    const invoice = makeInvoice({ customer_phone: '97112233', amount_ttc: 10000, issued_at: '2026-01-10T09:00:00Z' });

    // ratio 0.99 dépasse le plafond du Niveau 4 (0.98) : reste rejeté même
    // avec la fenêtre élargie à ±90 jours du Niveau 4.
    expect(findBestMatch(tx, [invoice])).toBeNull();
  });

  it('accepte la limite exacte de la fenêtre ±24h', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 9900, processed_at: '2026-01-11T09:00:00Z' });
    const invoice = makeInvoice({ customer_phone: '97112233', amount_ttc: 10000, issued_at: '2026-01-10T09:00:00Z' });

    expect(findBestMatch(tx, [invoice])?.level).toBe(3);
  });

  it('choisit le candidat le plus proche en montant quand plusieurs sont éligibles', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 9900, processed_at: '2026-01-10T12:00:00Z' });
    const invoices = [
      makeInvoice({ id: 50, customer_phone: '97112233', amount_ttc: 10100, issued_at: '2026-01-10T09:00:00Z' }),
      makeInvoice({ id: 51, customer_phone: '97112233', amount_ttc: 10000, issued_at: '2026-01-10T09:00:00Z' }),
      makeInvoice({ id: 52, customer_phone: '97112233', amount_ttc: 9920, issued_at: '2026-01-10T09:00:00Z' }),
    ];

    const result = findBestMatch(tx, invoices);

    expect(result?.level).toBe(3);
    expect(result?.invoice.id).toBe(52);
  });

  it('ignore les factures sans téléphone renseigné, y compris au Niveau 4', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 9900, processed_at: '2026-01-10T12:00:00Z' });
    const invoice = makeInvoice({ customer_phone: null, amount_ttc: 10000, issued_at: '2026-01-10T09:00:00Z' });

    expect(findBestMatch(tx, [invoice])).toBeNull();
  });
});

describe('findBestMatch — Niveau 4 (Paiement Partiel, score 50)', () => {
  it('matche un paiement à 60% du solde avec le même téléphone, hors fenêtre ±24h mais dans ±90 jours', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 6000, processed_at: '2026-02-15T09:00:00Z' });
    const invoice = makeInvoice({ customer_phone: '97112233', amount_ttc: 10000, issued_at: '2026-01-10T09:00:00Z' });

    const result = findBestMatch(tx, [invoice]);

    expect(result?.level).toBe(4);
    expect(result?.score).toBe(50);
  });

  it('tient compte du solde déjà payé, pas du montant total de la facture', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 3000, processed_at: '2026-01-10T09:00:00Z' });
    // Solde restant réel : 10000 - 7000 = 3000 → match exact, donc Niveau 1.
    const invoice = makeInvoice({ customer_phone: '97112233', amount_ttc: 10000, amount_paid_ttc: 7000, issued_at: '2026-01-10T09:00:00Z' });

    const result = findBestMatch(tx, [invoice]);

    expect(result?.level).toBe(1);
    expect(result?.score).toBe(100);
  });

  it('rejette un paiement en dessous de 5% du solde restant', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 100, processed_at: '2026-01-10T09:00:00Z' });
    const invoice = makeInvoice({ customer_phone: '97112233', amount_ttc: 10000, issued_at: '2026-01-10T09:00:00Z' });

    expect(findBestMatch(tx, [invoice])).toBeNull();
  });

  it('rejette une fenêtre temporelle supérieure à ±90 jours', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 5000, processed_at: '2026-05-01T09:00:00Z' });
    const invoice = makeInvoice({ customer_phone: '97112233', amount_ttc: 10000, issued_at: '2026-01-10T09:00:00Z' });

    expect(findBestMatch(tx, [invoice])).toBeNull();
  });
});

describe('findBestMatch — cas limites', () => {
  it('retourne null si aucune facture disponible', () => {
    const tx = makeTransaction({ sender_phone: '97112233', net_amount: 5000 });
    expect(findBestMatch(tx, [])).toBeNull();
  });

  it('retourne null si rien ne correspond à aucun niveau', () => {
    const tx = makeTransaction({
      reference_api_momo: 'REF-X',
      sender_phone: '97000000',
      net_amount: 1000,
      processed_at: '2026-01-10T12:00:00Z',
    });
    const invoice = makeInvoice({
      customer_phone: '97999999',
      amount_ttc: 999999,
      memo_reference: 'AUTRE-REF',
      issued_at: '2020-01-01T00:00:00Z',
    });

    expect(findBestMatch(tx, [invoice])).toBeNull();
  });
});