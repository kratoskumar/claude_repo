import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage for Node.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};

const R = await import('../docs/rates.js');
const { localISO } = await import('../docs/calc.js');
const realFetch = globalThis.fetch;
const today = localISO();

function countingFetch() {
  const calls = [];
  globalThis.fetch = (url, opts) => { calls.push(String(url)); return realFetch(url, opts); };
  return calls;
}

test('live: current rates are sane', async () => {
  R.clearCache();
  const r = await R.getRates(today, today);
  assert.ok(R.goldOk(r.gold), `gold ${r.gold}`);
  assert.ok(R.fxOk(r.fx), `fx ${r.fx}`);
  assert.equal(r.live, true);
  assert.ok(!r.stale);
});

test('live: historical day matches feed and is cached', async () => {
  R.clearCache();
  const calls = countingFetch();
  const r = await R.getRates('2024-07-24', today);
  assert.ok(Math.abs(r.gold - 2408.76) < 0.05, `gold ${r.gold}`);
  assert.ok(Math.abs(r.fx - 83.714) < 0.01, `fx ${r.fx}`);
  assert.equal(r.gDate, '2024-07-24');
  const n = calls.length;
  const again = await R.getRates('2024-07-24', today);
  assert.equal(calls.length, n, 'second lookup must come from cache');
  assert.equal(again.gold, r.gold);
  assert.ok(again.cached);
  globalThis.fetch = realFetch;
});

test('live: missing feed day falls back to previous day', async () => {
  R.clearCache();
  const r = await R.getRates('2025-12-10', today);
  assert.equal(r.gDate, '2025-12-09');
  assert.ok(R.goldOk(r.gold));
  assert.ok(R.fxOk(r.fx));
});

test('live: date before feed start has FX but no gold', async () => {
  R.clearCache();
  const r = await R.getRates('2023-12-15', today);
  assert.equal(r.gold, null);
  assert.ok(Math.abs(r.fx - 83.3) < 0.5, `fx ${r.fx}`);
  assert.equal(r.fxDate, '2023-12-15');
});

test('live: weekend date resolves', async () => {
  R.clearCache();
  const r = await R.getRates('2024-03-03', today);
  assert.ok(R.goldOk(r.gold));
  assert.ok(R.fxOk(r.fx));
});

test('offline: no throw, nulls without cache, stale values with cache', async () => {
  R.clearCache();
  globalThis.fetch = () => Promise.reject(new TypeError('offline'));
  const r1 = await R.getRates(today, today);
  assert.equal(r1.gold, null);
  assert.equal(r1.fx, null);
  const h = await R.getRates('2025-01-01', today);
  assert.equal(h.gold, null);
  globalThis.fetch = realFetch;

  const good = await R.getRates(today, today);
  assert.ok(R.goldOk(good.gold));
  // Simulate a later offline visit: memory cache gone, saved copy remains.
  const saved = store.get('mc:live');
  R.clearCache();
  store.set('mc:live', saved);
  globalThis.fetch = () => Promise.reject(new TypeError('offline'));
  const r2 = await R.getRates(today, today);
  assert.equal(r2.gold, good.gold);
  assert.equal(r2.fx, good.fx);
  assert.equal(r2.stale, true);
  globalThis.fetch = realFetch;
});

test('garbage responses are rejected', async () => {
  R.clearCache();
  globalThis.fetch = async url => {
    const u = String(url);
    if (u.includes('gold-api')) return new Response(JSON.stringify({ price: 0 }));
    if (u.includes('frankfurter')) return new Response(JSON.stringify({ rates: { INR: 'x' } }));
    return new Response(JSON.stringify({ date: today, usd: { xau: 0, inr: 0.5 } }));
  };
  const r = await R.getRates(today, today);
  assert.equal(r.gold, null);
  assert.equal(r.fx, null);
  const h = await R.getRates('2025-01-01', today);
  assert.equal(h.gold, null);
  assert.equal(h.fx, null);
  assert.equal(store.get('mc:rates'), undefined, 'incomplete results are not cached');
  globalThis.fetch = realFetch;
});

test('primary source down: falls back to secondary sources', async () => {
  R.clearCache();
  globalThis.fetch = (url, o) => (String(url).includes('jsdelivr') || String(url).includes('gold-api') ? Promise.reject(new Error('down')) : realFetch(url, o));
  const r = await R.getRates('2025-01-01', today);
  assert.ok(R.goldOk(r.gold), 'pages.dev mirror used');
  const c = await R.getRates(today, today);
  assert.ok(R.goldOk(c.gold), 'daily feed used when live gold is down');
  globalThis.fetch = realFetch;
});

test('hung request times out', async () => {
  R.clearCache();
  R.config.timeout = 300;
  globalThis.fetch = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const t0 = Date.now();
  const r = await R.getRates(today, today);
  assert.equal(r.gold, null);
  assert.ok(Date.now() - t0 < 3000, 'gave up quickly');
  R.config.timeout = 8000;
  globalThis.fetch = realFetch;
});
