import { formatMoney, formatRate, parseAmount, taxLabelKey, totalsByCurrency } from '../money';

describe('formatMoney', () => {
  it('IDR has no decimals (PlugSure minor unit = whole rupiah)', () => {
    expect(formatMoney(12345, 'IDR', 'en')).toBe('Rp 12,345');
    expect(formatMoney(12345, 'IDR', 'id')).toBe('Rp 12.345');
    expect(formatMoney(100000, 'IDR', 'id')).toBe('Rp 100.000');
    expect(formatMoney(0, 'IDR', 'en')).toBe('Rp 0');
  });
  it('MYR and SGD have two decimals from sen / cents', () => {
    expect(formatMoney(150, 'MYR', 'en')).toBe('RM 1.50');
    expect(formatMoney(2239, 'SGD', 'en')).toBe('S$ 22.39');
    expect(formatMoney(5, 'SGD', 'en')).toBe('S$ 0.05');
    expect(formatMoney(123456789, 'MYR', 'en')).toBe('RM 1,234,567.89');
  });
  it('uses Indonesian separators for every currency in id', () => {
    expect(formatMoney(123456, 'MYR', 'id')).toBe('RM 1.234,56');
    expect(formatMoney(8000, 'SGD', 'id')).toBe('S$ 80,00');
  });
  it('handles sign, symbol-less output and missing values', () => {
    expect(formatMoney(-2500, 'IDR', 'en')).toBe('-Rp 2,500');
    expect(formatMoney(2500, 'IDR', 'en', { signed: true })).toBe('+Rp 2,500');
    expect(formatMoney(150, 'MYR', 'en', { symbol: false })).toBe('1.50');
    expect(formatMoney(null, 'IDR')).toBe('—');
    expect(formatMoney(Number.NaN, 'IDR')).toBe('—');
  });
  it('treats an unknown currency as IDR (legacy rows have none)', () => {
    expect(formatMoney(1000, null, 'en')).toBe('Rp 1,000');
    expect(formatMoney(1000, 'EUR', 'en')).toBe('Rp 1,000');
  });
});

describe('formatRate', () => {
  it('IDR rates are whole rupiah, never decimals', () => {
    expect(formatRate(2466.78, 'IDR', 'id')).toBe('Rp 2.467');
    expect(formatRate(2300, 'IDR', 'en')).toBe('Rp 2,300');
    expect(formatRate(2467.5, 'IDR', 'en')).toBe('Rp 2,468');
    expect(formatRate(2466.4, 'IDR', 'en')).toBe('Rp 2,466');
  });
  it('MYR / SGD rates show 2–4 decimals', () => {
    expect(formatRate(1.2, 'MYR', 'en')).toBe('RM 1.20');
    expect(formatRate(0.455, 'MYR', 'en')).toBe('RM 0.455');
    expect(formatRate(0.65, 'SGD', 'id')).toBe('S$ 0,65');
    expect(formatRate(0.12345, 'SGD', 'en')).toBe('S$ 0.1235');
  });
  it('returns a dash for unknown', () => expect(formatRate(null, 'IDR')).toBe('—'));
});

describe('parseAmount', () => {
  it('parses typed amounts into minor units', () => {
    expect(parseAmount('150000', 'IDR')).toBe(150000);
    expect(parseAmount('150.000', 'IDR', 'id')).toBe(150000);
    expect(parseAmount('12.50', 'MYR', 'en')).toBe(1250);
    expect(parseAmount('12,5', 'SGD', 'id')).toBe(1250);
    expect(parseAmount('20', 'SGD')).toBe(2000);
  });
  it('rejects fractions finer than the currency and junk', () => {
    expect(parseAmount('1.005', 'MYR')).toBeNull();
    expect(parseAmount('12.5', 'IDR')).toBeNull();
    expect(parseAmount('abc', 'IDR')).toBeNull();
    expect(parseAmount('0', 'IDR')).toBeNull();
    expect(parseAmount('', 'IDR')).toBeNull();
  });
});

describe('totalsByCurrency', () => {
  it('never adds different currencies together', () => {
    const t = totalsByCurrency([
      { currency: 'IDR', totalMinor: 100000, energyKwh: 30 },
      { currency: 'SGD', totalMinor: 2239, energyKwh: 31.1 },
      { currency: 'IDR', totalMinor: 50000, energyKwh: 10.5 },
      { currency: 'MYR', totalMinor: null, energyKwh: 5 },
      { currency: 'XXX', totalMinor: 1, energyKwh: 1 },
    ]);
    expect(t).toEqual([
      { currency: 'IDR', totalMinor: 150000, kwh: 40.5, count: 2 },
      { currency: 'SGD', totalMinor: 2239, kwh: 31.1, count: 1 },
    ]);
  });
});

describe('taxLabelKey', () => {
  it('names the country tax', () => {
    expect(taxLabelKey('IDR', false)).toBe('price.tax.ppn.excl');
    expect(taxLabelKey('SGD', true)).toBe('price.tax.gst.incl');
    expect(taxLabelKey('MYR', true)).toBe('price.tax.sst.incl');
  });
});
