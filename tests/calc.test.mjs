import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../docs/calc.js';

const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('purity factors per market', () => {
  near(C.purityFactor('IN', '22'), 0.916, 1e-12);
  near(C.purityFactor('US', '22'), 22 / 24, 1e-12);
  near(C.purityFactor('IN', '14'), 0.585, 1e-12);
  near(C.purityFactor('US', '14'), 14 / 24, 1e-12);
  assert.equal(C.purityFactor('US', '24'), 1);
  near(C.purityFactor('US', 'custom', '91.6'), 0.916, 1e-12);
  assert.ok(Number.isNaN(C.purityFactor('US', 'custom', '0')));
  assert.ok(Number.isNaN(C.purityFactor('US', 'custom', '101')));
  assert.ok(Number.isNaN(C.purityFactor('US', 'custom', '')));
  assert.ok(Number.isNaN(C.purityFactor('US', '23')));
});

test('India import duty schedule boundaries', () => {
  assert.equal(C.dutyOn('2023-11-26'), 15);
  assert.equal(C.dutyOn('2024-07-23'), 15);
  assert.equal(C.dutyOn('2024-07-24'), 6);
  assert.equal(C.dutyOn('2026-05-12'), 6);
  assert.equal(C.dutyOn('2026-05-13'), 15);
  assert.equal(C.dutyOn('2026-11-26'), 15);
  // unsorted custom schedule, invalid rows ignored
  const s = [{ from: '2025-01-01', pct: 10 }, { from: '2000-01-01', pct: 5 }, { from: '', pct: 99 }, null];
  assert.equal(C.dutyOn('2024-12-31', s), 5);
  assert.equal(C.dutyOn('2025-01-01', s), 10);
  assert.equal(C.dutyOn('2024-01-01', []), 0);
});

test('market 24K rate per gram', () => {
  near(C.marketRate24('US', 2650, null, 0), 85.199478);
  near(C.marketRate24('IN', 2400, 84, 6), 6870.485939);
  assert.equal(C.marketRate24('IN', 2400, 0, 6), null);
  assert.equal(C.marketRate24('US', 0, 84, 6), null);
  assert.equal(C.marketRate24('US', NaN, 84, 6), null);
});

test('currency conversion', () => {
  assert.equal(C.convert(10, 'USD', 'INR', 84), 840);
  assert.equal(C.convert(840, 'INR', 'USD', 84), 10);
  assert.equal(C.convert(5, 'INR', 'INR', null), 5);
  assert.equal(C.convert(5, 'USD', 'INR', null), null);
  assert.equal(C.convert(NaN, 'USD', 'USD', 1), null);
});

test('A: India rate, INR price including 3% GST, 22K', () => {
  const r = C.making({ price: 75000, priceCur: 'INR', weight: 10, factor: 0.916, rate24: C.marketRate24('IN', 2400, 84, 6), rateCur: 'INR', fx: 84, taxIncl: true, taxPct: 3, other: 0 });
  assert.ok(r.ok);
  near(r.gold, 62933.651199);
  near(r.preTax, 72815.533981);
  near(r.tax, 75000 - 72815.533981);
  near(r.making, 9881.882782);
  near(r.pct, 15.702065);
  near(r.perGram, 988.188278);
  near(r.itemRate, 6293.365120);
});

test('B: US rate, USD price, 14K, stones subtracted, no tax', () => {
  const r = C.making({ price: 649, priceCur: 'USD', weight: 5.2, factor: 14 / 24, rate24: C.marketRate24('US', 2650), rateCur: 'USD', fx: 84, taxIncl: false, taxPct: 7, other: 40 });
  assert.ok(r.ok);
  near(r.gold, 258.438418);
  near(r.making, 350.561582);
  near(r.pct, 135.64608);
  assert.equal(r.tax, 0);
});

test('C: US rate, INR price, sales tax included', () => {
  const r = C.making({ price: 60000, priceCur: 'INR', weight: 8, factor: 22 / 24, rate24: C.marketRate24('US', 2400), rateCur: 'USD', fx: 83.5, taxIncl: true, taxPct: 6.625 });
  assert.ok(r.ok);
  near(r.gold, 47248.737157);
  near(r.preTax, 56271.981243);
  near(r.making, 9023.244085);
  near(r.pct, 19.097323);
});

test('D: India rate, USD price', () => {
  const r = C.making({ price: 1000, priceCur: 'USD', weight: 10, factor: 0.916, rate24: C.marketRate24('IN', 2400, 84, 15), rateCur: 'INR', fx: 84, taxIncl: false });
  assert.ok(r.ok);
  near(r.gold, 812.822314);
  near(r.making, 187.177686);
  near(r.pct, 23.028118);
});

test('negative making when price is below gold value', () => {
  const r = C.making({ price: 100, priceCur: 'USD', weight: 10, factor: 1, rate24: 80, rateCur: 'USD', fx: 84 });
  assert.ok(r.ok);
  assert.ok(r.making < 0);
});

test('invalid inputs report which field', () => {
  const base = { price: 100, priceCur: 'USD', weight: 1, factor: 1, rate24: 80, rateCur: 'USD', fx: 84 };
  assert.equal(C.making({ ...base, price: 0 }).err, 'price');
  assert.equal(C.making({ ...base, price: NaN }).err, 'price');
  assert.equal(C.making({ ...base, weight: -1 }).err, 'weight');
  assert.equal(C.making({ ...base, factor: NaN }).err, 'purity');
  assert.equal(C.making({ ...base, factor: 1.2 }).err, 'purity');
  assert.equal(C.making({ ...base, rate24: null }).err, 'rate');
  assert.equal(C.making({ ...base, priceCur: 'INR', fx: null }).err, 'fx');
  assert.equal(C.making({ ...base, taxIncl: true, taxPct: 80 }).err, 'tax');
  assert.ok(C.making({ ...base, taxIncl: false, taxPct: 80 }).ok);
});

test('number parsing', () => {
  assert.equal(C.num('1,25,000'), 125000);
  assert.equal(C.num('₹ 1,25,000.50'), 125000.5);
  assert.equal(C.num('$1,234.56'), 1234.56);
  assert.equal(C.num(' 12.5 g'), 12.5);
  assert.equal(C.num('12.5gms', 'decimal'), 12.5);
  assert.equal(C.num('12,5', 'decimal'), 12.5);
  assert.equal(C.num('1,250.5', 'decimal'), 1250.5);
  assert.equal(C.num('12.'), 12);
  assert.equal(C.num('125,000'), 125000);
  assert.equal(C.num('12,34,56,789.5'), 123456789.5);
  assert.ok(Number.isNaN(C.num('12,5')));
  assert.ok(Number.isNaN(C.num('1,2345')));
  assert.ok(Number.isNaN(C.num(',125')));
  assert.equal(C.num('.5'), 0.5);
  assert.equal(C.num(7), 7);
  for (const bad of ['', ' ', 'abc', '1.2.3', '-5', '1e5', '12,5,3', null, undefined, '.', Infinity]) {
    assert.ok(Number.isNaN(C.num(bad)), `expected NaN for ${bad}`);
  }
  assert.ok(Number.isNaN(C.num('1,2,3', 'decimal')));
});

test('money formatting', () => {
  assert.equal(C.money(125000, 'INR'), '₹1,25,000');
  assert.equal(C.money(999.5, 'INR'), '₹999.50');
  assert.equal(C.money(1234.5, 'USD'), '$1,234.50');
  assert.equal(C.money(-50, 'USD'), '-$50.00');
  assert.equal(C.money(NaN, 'USD'), '—');
  assert.equal(C.money(null, 'INR'), '—');
  assert.equal(C.plain(125000.456, 2, 'INR'), '1,25,000.46');
  assert.equal(C.plain(2650.1, 2), '2,650.1');
  assert.equal(C.plain(NaN), '');
});

test('date helpers', () => {
  assert.equal(C.yearsBack('2026-11-26', 3), '2023-11-26');
  assert.equal(C.yearsBack('2028-02-29', 3), '2025-03-01');
  assert.equal(C.addDays('2024-03-01', 1), '2024-03-02');
  assert.equal(C.addDays('2024-01-01', -1), '2023-12-31');
  assert.ok(C.isISODate('2024-02-29'));
  assert.ok(!C.isISODate('2023-02-29'));
  assert.ok(!C.isISODate('2024-2-1'));
  assert.ok(!C.isISODate(''));
  assert.match(C.localISO(), /^\d{4}-\d{2}-\d{2}$/);
});

test('product link sanitising', () => {
  assert.equal(C.safeUrl('https://www.tanishq.co.in/p/123?x=1'), 'https://www.tanishq.co.in/p/123?x=1');
  assert.equal(C.safeUrl('www.example.com/ring'), 'https://www.example.com/ring');
  assert.equal(C.safeUrl('amazon.in/dp/B0X'), 'https://amazon.in/dp/B0X');
  assert.equal(C.safeUrl('shop.com:8443/x'), 'https://shop.com:8443/x');
  assert.equal(C.safeUrl('http://shop.com'), 'http://shop.com/');
  assert.equal(C.safeUrl(''), '');
  assert.equal(C.safeUrl('   '), '');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'mailto:a@b.com', 'ftp://x.com/a', 'http://localhost', 'not a url']) {
    assert.equal(C.safeUrl(bad), null, bad);
  }
});
