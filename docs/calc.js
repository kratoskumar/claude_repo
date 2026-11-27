// Pure calculation helpers: no DOM, no network. Used by the app and by tests.

export const OZ_G = 31.1034768; // grams in one troy ounce
export const HIST_START = '2024-03-02'; // first day of the free daily gold history feed

// Markets. Rates are quoted per "unit" (US: troy ounce, India: 10 g) of 24K gold.
export const MARKETS = {
  US: { cur: 'USD', unitG: OZ_G, unit: 'oz', tax: { incl: false, pct: 0 } },
  IN: { cur: 'INR', unitG: 10, unit: '10 g', tax: { incl: true, pct: 3 } }
};

// Purity = fraction of the 24K rate. India uses BIS hallmark fineness (22K = 916),
// the US uses karat / 24. Both markets price 24K as the base rate.
export const PURITIES = [
  { k: '24', IN: 1, US: 1 },
  { k: '22', IN: 0.916, US: 22 / 24 },
  { k: '18', IN: 0.75, US: 0.75 },
  { k: '14', IN: 0.585, US: 14 / 24 },
  { k: '10', IN: 10 / 24, US: 10 / 24 },
  { k: '9', IN: 0.375, US: 0.375 }
];

// Total Indian customs duty on gold (basic duty + AIDC), % by effective date.
export const DEFAULT_DUTY = [
  { from: '2000-01-01', pct: 15 },
  { from: '2024-07-24', pct: 6 },
  { from: '2026-05-13', pct: 15 }
];

export function purityFactor(market, k, customPct) {
  if (k === 'custom') {
    const p = Number(customPct);
    return p > 0 && p <= 100 ? p / 100 : NaN;
  }
  const row = PURITIES.find(p => p.k === k);
  return row ? row[market] : NaN;
}

export function dutyOn(date, schedule = DEFAULT_DUTY) {
  const rows = [...schedule].filter(r => r && r.from && Number.isFinite(r.pct)).sort((a, b) => (a.from < b.from ? -1 : 1));
  let pct = 0;
  for (const r of rows) if (r.from <= date) pct = r.pct;
  return pct;
}

// 24K market rate per gram in the market currency (USD for US, INR for India).
// India = international price x USD-INR x (1 + import duty). GST is not included.
export function marketRate24(market, usdOz, fx, dutyPct) {
  if (!(usdOz > 0)) return null;
  const usdG = usdOz / OZ_G;
  if (market === 'US') return usdG;
  if (!(fx > 0)) return null;
  return usdG * fx * (1 + (dutyPct || 0) / 100);
}

export function convert(amount, from, to, fx) {
  if (amount == null || !Number.isFinite(amount)) return null;
  if (from === to) return amount;
  if (!(fx > 0)) return null;
  return from === 'USD' ? amount * fx : amount / fx;
}

// Making charge from a final price. All amounts are in the price currency.
// Tax (GST / sales tax), when included in the price, applies to the whole bill.
export function making({ price, priceCur, weight, factor, rate24, rateCur, fx, taxIncl, taxPct, other }) {
  if (!(price > 0)) return { ok: false, err: 'price' };
  if (!(weight > 0)) return { ok: false, err: 'weight' };
  if (!(factor > 0 && factor <= 1)) return { ok: false, err: 'purity' };
  if (!(rate24 > 0)) return { ok: false, err: 'rate' };
  const r24 = convert(rate24, rateCur, priceCur, fx);
  if (r24 == null) return { ok: false, err: 'fx' };
  const t = taxIncl ? Number(taxPct) || 0 : 0;
  if (t < 0 || t > 50) return { ok: false, err: 'tax' };
  const preTax = price / (1 + t / 100);
  const oth = other > 0 ? other : 0;
  const itemRate = r24 * factor;
  const gold = weight * itemRate;
  const mk = preTax - oth - gold;
  return {
    ok: true,
    preTax,
    tax: price - preTax,
    other: oth,
    itemRate,
    gold,
    making: mk,
    pct: (mk / gold) * 100,
    pctPrice: (mk / preTax) * 100, // share of the price (before tax)
    perGram: mk / weight,
    pricePerGram: preTax / weight
  };
}

// Saved jewellers: name + % they take off the market value of gold traded in (negative = they pay above it).
export const DEFAULT_JEWELLERS = [{ n: 'Joy Alukkas', d: 3 }];
export const MAX_JEWELLERS = 10;
export const validJeweller = j => !!j && typeof j.n === 'string' && j.n.trim().length > 0 && j.n.length <= 40
  && Number.isFinite(j.d) && j.d >= -20 && j.d <= 50;

// Gold exchange: the market value of your gold, less the jeweller's deduction, is credited toward
// the jewellery. All amounts are in one currency; rate24 is the 24K market rate per gram.
// Tax is on the full jewellery price, or with taxOnBalance only on what is left after the credit.
export function exchange({ weightG, factor, rate24, ded, paid, price, taxPct, taxOnBalance }) {
  if (!(weightG > 0)) return { ok: false, err: 'weight' };
  if (!(factor > 0 && factor <= 1)) return { ok: false, err: 'purity' };
  if (!(rate24 > 0)) return { ok: false, err: 'rate' };
  const d = Number(ded) || 0;
  if (d < -20 || d > 50) return { ok: false, err: 'ded' };
  const value = weightG * factor * rate24;
  const deduction = (value * d) / 100;
  const credit = value - deduction;
  const r = { ok: true, value, deduction, credit, gain: null, gainPct: null, price: null };
  if (paid > 0) { r.gain = credit - paid; r.gainPct = (r.gain / paid) * 100; }
  if (price > 0) {
    const t = Number(taxPct) || 0;
    if (t < 0 || t > 50) return { ok: false, err: 'tax' };
    const tax = ((taxOnBalance ? Math.max(0, price - credit) : price) * t) / 100;
    r.price = price;
    r.tax = tax;
    r.total = price + tax;
    r.balance = r.total - credit; // below zero: the jeweller owes you the difference
    r.covered = Math.min(1, credit / r.total);
  }
  return r;
}

// Parse user-typed numbers: "1,25,000", "$1,234.50", "12.5 g".
// comma: 'group' treats commas as thousands separators (prices, rates);
// 'decimal' treats a lone comma as a decimal point (weights, percentages).
export function num(input, comma = 'group') {
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
  let s = String(input ?? '').trim().replace(/[\s₹$]/g, '').replace(/[a-z]+\.?$/i, '');
  if (comma === 'decimal' && !s.includes('.') && (s.match(/,/g) || []).length === 1) s = s.replace(',', '.');
  else if (s.includes(',')) {
    // Accept US (125,000) and Indian (1,25,000) grouping only; reject typos like "12,5".
    const [int, ...rest] = s.split('.');
    const g = int.split(',');
    const ok = /^\d{1,3}$/.test(g[0]) && /^\d{3}$/.test(g[g.length - 1]) && g.slice(1, -1).every(x => /^\d{2,3}$/.test(x));
    if (!ok) return NaN;
    s = [g.join(''), ...rest].join('.');
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return parseFloat(s);
}

const fmts = new Map();
function nf(locale, opts) {
  const key = locale + JSON.stringify(opts);
  if (!fmts.has(key)) fmts.set(key, new Intl.NumberFormat(locale, opts));
  return fmts.get(key);
}

export function money(v, cur, dec) {
  if (v == null || !Number.isFinite(v)) return '—';
  const d = dec ?? (cur === 'INR' && Math.abs(v) >= 1000 ? 0 : 2);
  return nf(cur === 'INR' ? 'en-IN' : 'en-US', { style: 'currency', currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
}

export function plain(v, dec = 2, cur = 'USD') {
  if (v == null || !Number.isFinite(v)) return '';
  return nf(cur === 'INR' ? 'en-IN' : 'en-US', { maximumFractionDigits: dec, useGrouping: true }).format(v);
}

export function localISO(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function yearsBack(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y - n, m - 1, d)).toISOString().slice(0, 10);
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function isISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
}

// Product links: allow only http(s); add https:// when the scheme is missing.
// Returns '' for empty input and null for an unusable link.
export function safeUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+\.[^:/]+:\d/.test(s)) return null;
    s = 'https://' + s;
  }
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') ? u.href : null;
  } catch {
    return null;
  }
}
