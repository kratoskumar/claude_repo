// Gold (USD per troy oz) and USD->INR rates from free, keyless sources.
// Historical days are immutable, so they are cached on the device forever (small).
import { HIST_START, addDays } from './calc.js';

export const config = { timeout: 8000 };

const FEED = [
  d => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${d}/v1/currencies/usd.min.json`,
  d => `https://${d}.currency-api.pages.dev/v1/currencies/usd.min.json`
];
const LATEST_FEED = [
  'https://latest.currency-api.pages.dev/v1/currencies/usd.min.json',
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json'
];
const LIVE_GOLD = 'https://api.gold-api.com/price/XAU';
const FRANK = d => `https://api.frankfurter.dev/v1/${d}?base=USD&symbols=INR`;
const LIVE_TTL = 10 * 60 * 1000;
const CACHE_KEY = 'mc:rates';
const LIVE_KEY = 'mc:live';
const MAX_CACHED_DAYS = 400;

export const goldOk = v => Number.isFinite(v) && v > 300 && v < 50000;
export const fxOk = v => Number.isFinite(v) && v > 30 && v < 500;

async function getJSON(url, fresh) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: fresh ? 'no-store' : 'default' });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage full or blocked: run without cache */ }
}

function parseFeed(j, fallbackDate) {
  if (!j || !j.usd) return null;
  return { gold: j.usd.xau > 0 ? 1 / j.usd.xau : NaN, fx: j.usd.inr, date: typeof j.date === 'string' ? j.date : fallbackDate };
}

async function feedDay(d) {
  for (const url of FEED) {
    const r = parseFeed(await getJSON(url(d)), d);
    if (r) return r;
  }
  return null;
}

async function frankfurter(d) {
  const j = await getJSON(FRANK(d), d === 'latest');
  const v = j && j.rates && j.rates.INR;
  return fxOk(v) ? { fx: v, date: j.date } : null;
}

// Rates for a past day. gold is null before HIST_START (manual entry needed).
async function historical(date) {
  const cache = load(CACHE_KEY) || {};
  const hit = cache[date];
  if (hit) return { gold: hit.g, fx: hit.f, gDate: hit.gd, fxDate: hit.fd, live: false, cached: true };

  let gold = null, fx = null, gDate = null, fxDate = null;
  if (date >= HIST_START) {
    // A few days are missing from the feed: fall back to the closest earlier day.
    for (let i = 0; i < 4; i++) {
      const d = addDays(date, -i);
      if (d < HIST_START) break;
      const r = await feedDay(d);
      if (r && goldOk(r.gold)) {
        gold = r.gold; gDate = d;
        if (fxOk(r.fx)) { fx = r.fx; fxDate = d; }
        break;
      }
    }
  }
  if (fx == null) {
    const f = await frankfurter(date);
    if (f) { fx = f.fx; fxDate = f.date; }
  }
  if (fx != null && (gold != null || date < HIST_START)) {
    cache[date] = { g: gold, f: fx, gd: gDate, fd: fxDate };
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_DAYS))) delete cache[k];
    save(CACHE_KEY, cache);
  }
  return { gold, fx, gDate, fxDate, live: false };
}

let mem = null;

// Current rates: live gold spot + latest daily FX. Falls back to the last saved result.
async function current(today) {
  if (mem && mem.today === today && Date.now() - mem.t < LIVE_TTL) return mem.r;

  const latest = async () => {
    for (const url of LATEST_FEED) {
      const r = parseFeed(await getJSON(url, true), today);
      if (r && (goldOk(r.gold) || fxOk(r.fx))) return r;
    }
    return null;
  };
  const [g, feed] = await Promise.all([getJSON(LIVE_GOLD, true), latest()]);

  let gold = null, gDate = null, gAt = null, fx = null, fxDate = null;
  if (g && goldOk(g.price)) { gold = g.price; gAt = g.updatedAt || null; gDate = today; }
  else if (feed && goldOk(feed.gold)) { gold = feed.gold; gDate = feed.date; }
  if (feed && fxOk(feed.fx)) { fx = feed.fx; fxDate = feed.date; }
  else {
    const f = await frankfurter('latest');
    if (f) { fx = f.fx; fxDate = f.date; }
  }

  const prev = load(LIVE_KEY);
  let r = { gold, fx, gDate, fxDate, gAt, live: true };
  if (gold != null && fx != null) {
    mem = { today, t: Date.now(), r };
    save(LIVE_KEY, { t: Date.now(), r });
  } else if (prev && prev.r) {
    // Offline or sources down: reuse the last known values, marked as stale.
    r = {
      gold: gold ?? prev.r.gold, gDate: gold != null ? gDate : prev.r.gDate, gAt: gold != null ? gAt : prev.r.gAt,
      fx: fx ?? prev.r.fx, fxDate: fx != null ? fxDate : prev.r.fxDate,
      live: true, stale: true, staleAt: prev.t
    };
  }
  return r;
}

export function getRates(date, today) {
  return date >= today ? current(today) : historical(date);
}

export function clearCache() {
  mem = null;
  try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(LIVE_KEY); } catch { /* ignore */ }
}
