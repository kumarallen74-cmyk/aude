import en from '@/i18n/locales/en.json';
import id from '@/i18n/locales/id.json';
import { receiptLineLabel } from '../receiptLines';

const tOf = (dict: { receipt: { line: Record<string, string> } }) => (key: string) => dict.receipt.line[key.replace('receipt.line.', '')] ?? key;

describe('receiptLineLabel', () => {
  const t = tOf(en);
  it('names hosted receipt lines by kind (the backend sends kind + description, no label)', () => {
    expect(receiptLineLabel({ kind: 'energy', description: 'Energy', amountMinor: 4935 }, t)).toBe('Energy');
    expect(receiptLineLabel({ kind: 'session', description: 'Service fee (biaya layanan)', amountMinor: 21000 }, t)).toBe('Service fee');
    expect(receiptLineLabel({ kind: 'admin', amountMinor: 4000 }, t)).toBe('Admin fee');
    expect(receiptLineLabel({ kind: 'idle', amountMinor: 1000 }, tOf(id))).toBe('Biaya idle');
  });
  it('time-of-use energy, adjustments and the tariff cap', () => {
    expect(receiptLineLabel({ kind: 'energy', touBlock: 'WBP', amountMinor: 1 }, t)).toBe('Energy (peak hours)');
    expect(receiptLineLabel({ kind: 'energy', touBlock: 'LWBP', amountMinor: 1 }, t)).toBe('Energy (off-peak)');
    expect(receiptLineLabel({ kind: 'energy', touBlock: 'ANY', amountMinor: 1 }, t)).toBe('Energy');
    expect(receiptLineLabel({ kind: 'energy', adjustment: { source: 'v2x' }, amountMinor: -500 }, t)).toBe('Energy returned (credit)');
    expect(receiptLineLabel({ kind: 'discount', adjustment: { source: 'membership' }, description: 'Gold plan', amountMinor: -500 }, t)).toBe('Gold plan');
    expect(receiptLineLabel({ kind: 'cap', amountMinor: -200 }, t)).toBe('Tariff cap adjustment');
  });
  it('keeps a ready label (partner receipts) and never renders an empty label for an unknown kind', () => {
    expect(receiptLineLabel({ label: 'Energy 38.42 kWh', amountMinor: 1 }, t)).toBe('Energy 38.42 kWh');
    expect(receiptLineLabel({ kind: 'parking', description: 'Parking', amountMinor: 1 }, t)).toBe('Parking');
  });
});
