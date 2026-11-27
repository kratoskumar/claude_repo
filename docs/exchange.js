// Gold exchange tab: trade your gold (e.g. a 1 oz bar) at a jeweller toward new jewellery.
// Loaded only when the tab is first opened. app.js passes in what it shares (market, jewellers, ...).
import * as C from './calc.js';
import { getRates } from './rates.js';

const $ = id => document.getElementById(id);
const KEY = 'mc:xchg';
let ctx = null, R = { loading: true }, reqId = 0, builtFor = '', st = null, saveTimer = 0;
let rows = []; // jewellers being edited in the dialog

function loadState() {
  const d = { wt: '1', unit: 'oz', k: '24', paid: '', price: '', from: '', tax: { US: '', IN: '3' }, onBal: false, jw: '', rate: null, rateMk: '', rateOn: '' };
  const s = ctx.LS.get(KEY, {}) || {};
  for (const f of ['wt', 'paid', 'price', 'from', 'jw']) if (typeof s[f] === 'string') d[f] = s[f].slice(0, f === 'from' ? 120 : 40);
  if (s.unit === 'g' || s.unit === 'oz') d.unit = s.unit;
  if (C.PURITIES.some(p => p.k === s.k)) d.k = s.k;
  for (const m of ['US', 'IN']) if (s.tax && typeof s.tax[m] === 'string') d.tax[m] = s.tax[m].slice(0, 10);
  d.onBal = s.onBal === true;
  // A typed rate is kept only for the same market and day.
  if (Number.isFinite(s.rate) && s.rateOn === ctx.today() && (s.rateMk === 'US' || s.rateMk === 'IN')) { d.rate = s.rate; d.rateMk = s.rateMk; d.rateOn = s.rateOn; }
  return d;
}
const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => ctx.LS.set(KEY, st), 250); };

const signed = (v, cur) => (v > 0 ? '+' : '') + C.money(v, cur);
const mark = (el, bad) => { el.classList.toggle('bad', bad); el.setAttribute('aria-invalid', bad ? 'true' : 'false'); };
const badNum = (text, comma) => text.trim() !== '' && Number.isNaN(C.num(text, comma));
const setVal = (el, v) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
const setPressed = (seg, v) => { for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === v)); };
const takes = j => (j.d > 0 ? `takes ${C.plain(j.d, 2)}%` : j.d < 0 ? `adds ${C.plain(-j.d, 2)}%` : 'full value');

function jeweller() {
  const list = ctx.getJewellers();
  return list.find(j => j.n === st.jw) || list[0] || null;
}

function compute() {
  const market = ctx.getMarket();
  const m = C.MARKETS[market];
  const t = ctx.today();
  const dutyPct = market === 'IN' ? C.dutyOn(t, ctx.getDuty()) : 0;
  const auto24 = R.loading ? null : C.marketRate24(market, R.gold, R.fx, dutyPct);
  const manual = st.rate != null && st.rateMk === market && st.rateOn === t ? st.rate : null;
  const rate24 = manual ?? auto24;
  const wt = C.num(st.wt, 'decimal');
  const weightG = wt * (st.unit === 'oz' ? C.OZ_G : 1);
  const factor = C.purityFactor(market, st.k);
  const paid = st.paid.trim() ? C.num(st.paid) : 0;
  const price = st.price.trim() ? C.num(st.price) : 0;
  const taxText = st.tax[market];
  const taxPct = taxText.trim() ? C.num(taxText, 'decimal') : 0;
  const jw = jeweller();
  let res;
  if (Number.isNaN(paid)) res = { ok: false, err: 'paid' };
  else if (Number.isNaN(price)) res = { ok: false, err: 'price' };
  else if (Number.isNaN(taxPct)) res = { ok: false, err: 'tax' };
  else res = C.exchange({ weightG, factor, rate24, ded: jw ? jw.d : 0, paid, price, taxPct, taxOnBalance: st.onBal });
  return { market, m, dutyPct, auto24, manual, rate24, weightG, factor, paid, price, taxPct, jw, res };
}

function buildPurity(market) {
  const sel = $('xPurity');
  sel.textContent = '';
  for (const p of C.PURITIES) {
    const f = p[market];
    sel.append(new Option(p.k === '24' ? '24K fine' : `${p.k}K (${(f * 100).toFixed(f * 100 % 1 ? 1 : 0)}%)`, p.k));
  }
  sel.value = st.k;
  builtFor = market;
}

function buildJewellers() {
  const sel = $('xJw');
  const list = ctx.getJewellers();
  sel.textContent = '';
  if (!list.length) sel.append(new Option('No jeweller saved (full value)', ''));
  for (const j of list) sel.append(new Option(j.n, j.n));
  const jw = jeweller();
  sel.value = jw ? jw.n : '';
}

function rateStatus(c) {
  const el = $('xRateStatus');
  const sym = c.m.cur === 'INR' ? '₹' : '$';
  let text, err = false;
  if (R.loading) text = 'Fetching today\'s gold rate…';
  else if (R.gold == null) { text = 'Could not fetch the gold rate (offline?). Type it below.'; err = c.manual == null; }
  else if (R.stale) text = `Offline. Using the last known spot price $${C.plain(R.gold, 2)}/oz.`;
  else text = `Live spot price $${C.plain(R.gold, 2)}/oz`;
  if (c.market === 'IN' && R.gold != null && !R.loading) text += ` · India estimate includes ${c.dutyPct}% import duty, no GST`;
  if (c.manual != null && !R.loading) {
    err = false;
    text = `Using your typed rate${Number.isFinite(c.auto24) ? ` (market: ${C.money(c.auto24 * c.m.unitG, c.m.cur)}/${c.m.unit})` : ''}.`;
  }
  el.textContent = text;
  el.classList.toggle('err', err);
  $('xRateLabel').textContent = `24K rate today (${sym}/${c.m.unit})`;
}

function rowsTo(dl, list) {
  dl.textContent = '';
  for (const [k, v, total, strong] of list) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (strong) { const b = document.createElement('b'); b.textContent = v; dd.append(b); } else dd.textContent = v;
    if (total) { dt.className = 'total'; dd.className = 'total'; }
    dl.append(dt, dd);
  }
}

export function render() {
  if (!ctx || $('xchgView').hidden) return;
  const c = compute();
  const { m, res, jw } = c;
  const cur = m.cur;
  if (builtFor !== c.market) buildPurity(c.market);
  buildJewellers();
  setPressed($('xMarketSeg'), c.market);
  setPressed($('xUnitSeg'), st.unit);
  rateStatus(c);

  const okRate = c.rate24 > 0;
  setVal($('xRate'), okRate ? C.plain(c.rate24 * m.unitG, 2, cur) : (c.manual == null ? '' : $('xRate').value));
  mark($('xRate'), c.manual != null && !okRate);
  $('xResetRate').hidden = c.manual == null;
  setVal($('xWt'), st.wt);
  setVal($('xPaid'), st.paid);
  setVal($('xPrice'), st.price);
  setVal($('xTax'), st.tax[c.market]);
  if ($('xPurity').value !== st.k) $('xPurity').value = st.k;
  $('xTaxBal').checked = st.onBal;
  $('xTaxName').textContent = c.market === 'IN' ? 'GST' : 'Sales tax';
  $('xPrice').placeholder = cur === 'INR' ? 'e.g. 3,00,000' : 'e.g. 3,500';
  $('xPaid').placeholder = cur === 'INR' ? '₹ 0' : '$ 0';
  $('xFrom').textContent = st.from;
  mark($('xWt'), badNum(st.wt, 'decimal'));
  mark($('xPaid'), badNum(st.paid));
  mark($('xPrice'), badNum(st.price));
  mark($('xTax'), badNum(st.tax[c.market], 'decimal') || c.taxPct < 0 || c.taxPct > 50);
  $('xJwSub').textContent = !jw ? 'Add your jewellers and what they take off, then pick one here.'
    : jw.d > 0 ? `Takes ${C.plain(jw.d, 2)}% off the market value of your gold.`
      : jw.d < 0 ? `Pays ${C.plain(-jw.d, 2)}% above the market value of your gold.` : 'Gives the full market value of your gold.';

  const warn = $('xWarn');
  warn.hidden = true;
  const bd = [];
  $('xCompareWrap').hidden = true;
  if (!res.ok) {
    $('xHeadLabel').textContent = 'You pay';
    $('xAmt').textContent = '—';
    $('xCredit').textContent = '—';
    $('xTotal').textContent = '—';
    const hint = res.err === 'weight' && !st.wt.trim() ? 'Enter the weight of your gold'
      : res.err === 'rate' && R.loading ? 'Waiting for the gold rate…' : '';
    $('xAlt').textContent = hint;
    const msg = hint ? '' : {
      weight: 'The weight is not a valid number.', rate: 'Enter today\'s gold rate above.', paid: 'What you paid is not a valid number.',
      price: 'The jewellery price is not a valid number.', tax: 'Tax % must be a number between 0 and 50.', ded: 'Check the jeweller\'s %.'
    }[res.err] || '';
    warn.hidden = !msg; warn.textContent = msg;
    rowsTo($('xBreakdown'), []);
    return;
  }

  bd.push([`Gold value (${C.plain(c.weightG * c.factor, 3)} g fine × ${C.money(c.rate24, cur)}/g)`, C.money(res.value, cur)]);
  if (jw && jw.d) bd.push([`${jw.d > 0 ? '−' : '+'} ${jw.n} ${takes(jw)}`, C.money(Math.abs(res.deduction), cur)]);
  bd.push(['= Exchange credit', C.money(res.credit, cur), true]);
  $('xCredit').textContent = C.money(res.credit, cur);
  if (res.price != null) {
    const owe = res.balance < 0;
    $('xHeadLabel').textContent = owe ? 'Jeweller owes you' : 'You pay';
    $('xAmt').textContent = C.money(Math.abs(res.balance), cur);
    $('xAlt').textContent = `Your gold covers ${(res.covered * 100).toFixed(res.covered < 1 ? 1 : 0)}% of the bill`;
    $('xTotal').textContent = C.money(res.total, cur);
    bd.push(['Jewellery price', C.money(res.price, cur)]);
    if (res.tax > 0 || c.taxPct > 0) bd.push([`+ ${c.market === 'IN' ? 'GST' : 'Sales tax'} ${C.plain(c.taxPct, 3)}%${st.onBal ? ' (on balance)' : ''}`, C.money(res.tax, cur)]);
    bd.push(['− Exchange credit', C.money(res.credit, cur)]);
    bd.push([owe ? '= Jeweller owes you' : '= You pay', C.money(Math.abs(res.balance), cur), true]);
    if (owe) {
      warn.hidden = false;
      warn.textContent = 'Your gold is worth more than this jewellery. Ask whether the jeweller pays the difference in cash or as store credit.';
    }
  } else {
    $('xHeadLabel').textContent = 'Exchange credit';
    $('xAmt').textContent = C.money(res.credit, cur);
    $('xAlt').textContent = 'Enter the jewellery price to see what you pay';
    $('xTotal').textContent = '—';
  }
  if (res.gain != null) bd.push(['Gain over what you paid', `${signed(res.gain, cur)} (${res.gainPct > 0 ? '+' : ''}${res.gainPct.toFixed(1)}%)`]);
  rowsTo($('xBreakdown'), bd);

  const list = ctx.getJewellers();
  if (list.length > 1) {
    const cmp = list.map(j => ({ j, credit: res.value * (1 - j.d / 100) })).sort((a, b) => b.credit - a.credit);
    rowsTo($('xCompare'), cmp.map(({ j, credit }) => [`${j.n} (${takes(j)})`, C.money(credit, cur), false, j === jw]));
    $('xCompareWrap').hidden = false;
  }
}

async function loadRates() {
  const id = ++reqId;
  const t = ctx.today();
  if (R.loading === false && R.day !== t) { R = { loading: true }; render(); }
  const r = await getRates(t, t);
  if (id !== reqId) return;
  R = { ...r, loading: false, day: t };
  render();
}

// Called each time the tab is shown.
export function open() {
  render();
  loadRates();
}

// ---------- jeweller list (synced with the person's settings) ----------
function renderRows() {
  const box = $('jwRows');
  box.textContent = '';
  rows.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'jw-row';
    const l1 = document.createElement('label'); l1.textContent = 'Name';
    const n = document.createElement('input'); n.maxLength = 40; n.value = r.n; n.autocomplete = 'off';
    l1.append(n);
    const l2 = document.createElement('label'); l2.textContent = 'Takes %';
    // Normal keyboard: the phone number pad has no minus sign (for jewellers that pay above market).
    const p = document.createElement('input'); p.value = r.d; p.autocomplete = 'off';
    l2.append(p);
    const del = document.createElement('button'); del.type = 'button'; del.className = 'chip'; del.textContent = '✕';
    del.setAttribute('aria-label', `Remove ${r.n || 'this jeweller'}`);
    const update = () => {
      const old = r.n;
      r.n = n.value.trim();
      r.d = p.value;
      if (old && old === st.jw) st.jw = r.n;
      mark(n, !r.n);
      mark(p, !C.validJeweller({ n: 'x', d: parsePct(p.value) }));
      commit();
    };
    n.addEventListener('input', update);
    p.addEventListener('input', update);
    del.addEventListener('click', () => { rows.splice(i, 1); renderRows(); commit(); });
    row.append(l1, l2, del);
    box.append(row);
  });
  $('jwAdd').hidden = rows.length >= C.MAX_JEWELLERS;
}

function parsePct(s) {
  const t = String(s).trim();
  const neg = /^[-−–]/.test(t);
  const v = C.num(neg ? t.slice(1) : t, 'decimal');
  return neg ? -v : v;
}

function commit() {
  const list = rows.map(r => ({ n: String(r.n).trim(), d: parsePct(r.d) })).filter(C.validJeweller);
  const skipped = rows.length - list.length;
  $('jwErr').hidden = !skipped;
  $('jwErr').textContent = skipped ? 'Rows with no name, or a % outside −20 to 50, are not saved.' : '';
  persist();
  ctx.setJewellers(list);
  render();
}

// ---------- start ----------
export function init(c) {
  ctx = c;
  st = loadState();
  const on = (id, f, after) => $(id).addEventListener('input', e => { st[f] = e.target.value; after && after(); persist(); render(); });
  on('xWt', 'wt');
  on('xPaid', 'paid');
  on('xPrice', 'price', () => { st.from = ''; });
  $('xTax').addEventListener('input', e => { st.tax[ctx.getMarket()] = e.target.value; persist(); render(); });
  $('xTaxBal').addEventListener('change', e => { st.onBal = e.target.checked; persist(); render(); });
  $('xPurity').addEventListener('change', e => { st.k = e.target.value; persist(); render(); });
  $('xJw').addEventListener('change', e => { st.jw = e.target.value; persist(); render(); });
  $('xUnitSeg').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v || v === st.unit) return;
    // Keep the same amount of gold when switching units.
    const w = C.num(st.wt, 'decimal');
    if (w > 0) st.wt = C.plain(v === 'g' ? w * C.OZ_G : w / C.OZ_G, 4);
    st.unit = v; persist(); render();
  });
  $('xMarketSeg').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v;
    if (v && v !== ctx.getMarket()) { ctx.setMarket(v); render(); }
  });
  $('xRate').addEventListener('input', e => {
    const text = e.target.value, v = C.num(text), market = ctx.getMarket();
    st.rate = !text.trim() ? null : v > 0 ? v / C.MARKETS[market].unitG : NaN;
    st.rateMk = market; st.rateOn = ctx.today();
    persist(); render();
  });
  $('xRate').addEventListener('focus', e => e.target.select());
  $('xRate').addEventListener('blur', () => render());
  $('xResetRate').addEventListener('click', () => { st.rate = null; persist(); render(); });
  $('xUseCalc').addEventListener('click', () => {
    const it = ctx.calcItem();
    const cur = C.MARKETS[ctx.getMarket()].cur;
    const v = it && C.convert(it.preTax, it.cur, cur, it.fx || R.fx);
    if (!(v > 0)) { ctx.toast('Work out an item on the Calculator tab first.'); return; }
    st.price = C.plain(v, 2, cur).replace(/[^\d.,]/g, '');
    st.from = `From Calculator: ${it.label} · making ${it.pct.toFixed(1)}% of gold value.`;
    if (it.taxIncl) st.tax[ctx.getMarket()] = String(it.taxPct);
    persist(); render();
  });
  $('xJwEdit').addEventListener('click', () => {
    rows = ctx.getJewellers().map(j => ({ n: j.n, d: String(j.d) }));
    if (!rows.length) rows.push({ n: '', d: '0' });
    renderRows();
    $('jwErr').hidden = true;
    $('jwDlg').showModal();
  });
  $('jwAdd').addEventListener('click', () => {
    rows.push({ n: '', d: '0' });
    renderRows();
    const inputs = $('jwRows').querySelectorAll('.jw-row:last-child input');
    inputs[0] && inputs[0].focus();
  });
  $('jwClose').addEventListener('click', () => $('jwDlg').close());
  $('jwDlg').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $('jwDlg').addEventListener('close', () => { render(); ctx.onDialogClose(); });
}
