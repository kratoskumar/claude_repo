import * as C from './calc.js';
import { getRates, clearCache } from './rates.js';
import { CANONICAL_HOST, FORWARD_FROM } from './config.js';

// One address for everyone: the app's older addresses move to the main one.
if (CANONICAL_HOST && location.hostname !== CANONICAL_HOST && (FORWARD_FROM || []).includes(location.hostname)) {
  location.replace(`https://${CANONICAL_HOST}/${location.hash}`);
}

const VERSION = '1.1.4';
const $ = id => document.getElementById(id);
const today = () => C.localISO();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- device storage (per browser; never required to work) ----------
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / full */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

const DEFAULTS = {
  market: 'US', date: '', priceCur: 'USD', price: '', wt: '', k: '22', customPct: '', other: '',
  tax: { US: { incl: false, pct: '0' }, IN: { incl: true, pct: '3' } },
  manualRate: null, manualFx: null, editing: null
};

function loadState() {
  const s = JSON.parse(JSON.stringify(DEFAULTS));
  const saved = LS.get('mc:state', {}) || {};
  if (saved.market === 'US' || saved.market === 'IN') s.market = saved.market;
  if (saved.priceCur === 'USD' || saved.priceCur === 'INR') s.priceCur = saved.priceCur;
  for (const f of ['price', 'wt', 'customPct', 'other']) if (typeof saved[f] === 'string') s[f] = saved[f].slice(0, 40);
  if (C.PURITIES.some(p => p.k === saved.k) || saved.k === 'custom') s.k = saved.k;
  for (const m of ['US', 'IN']) {
    const t = saved.tax && saved.tax[m];
    if (t && typeof t.incl === 'boolean' && typeof t.pct === 'string') s.tax[m] = { incl: t.incl, pct: t.pct.slice(0, 10) };
  }
  // A saved past date (and any rate typed for it) is kept; "today" always means the current day.
  if (C.isISODate(saved.date) && saved.date < today() && saved.date >= C.yearsBack(today(), 3)) {
    s.date = saved.date;
    if (Number.isFinite(saved.manualRate)) s.manualRate = saved.manualRate;
    if (Number.isFinite(saved.manualFx)) s.manualFx = saved.manualFx;
  } else if (saved.savedOn === today()) {
    if (Number.isFinite(saved.manualRate)) s.manualRate = saved.manualRate;
    if (Number.isFinite(saved.manualFx)) s.manualFx = saved.manualFx;
  }
  const e = saved.editing;
  if (e && typeof e.id === 'string' && typeof e.name === 'string') {
    s.editing = { id: e.id, name: e.name, link: String(e.link || ''), notes: String(e.notes || ''), ts: Number(e.ts) || Date.now(), photo: !!e.photo };
  }
  return s;
}

function loadDuty() {
  const d = LS.get('mc:duty', null);
  return Array.isArray(d) && d.length && d.every(r => r && C.isISODate(r.from) && Number.isFinite(r.pct) && r.pct >= 0 && r.pct <= 100) ? d : C.DEFAULT_DUTY.map(r => ({ ...r }));
}

const S = loadState();
let duty = loadDuty();
let R = { loading: true, date: null }; // current rates
let saveTimer = 0;
const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(persistNow, 250); };
const persistNow = () => { clearTimeout(saveTimer); LS.set('mc:state', { ...S, savedOn: today() }); };
const curDate = () => S.date || today();

// ---------- formatting ----------
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDate = iso => (C.isISODate(iso) ? dateFmt.format(new Date(iso + 'T00:00:00Z')) : '');
const fmtTime = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const otherCur = c => (c === 'USD' ? 'INR' : 'USD');
const pctText = v => (Number.isFinite(v) ? `${v.toFixed(1)}%` : '—');
const purityLabel = (market, k, customPct) => {
  if (k === 'custom') return `Custom ${customPct}%`;
  const f = C.purityFactor(market, k);
  return k === '24' ? '24K' : `${k}K (${(f * 100).toFixed(f * 100 % 1 ? 1 : 0)}%)`;
};

// ---------- calculation from current inputs ----------
function compute() {
  const m = C.MARKETS[S.market];
  const d = curDate();
  const fxAuto = R.fx ?? null;
  const fx = S.manualFx ?? fxAuto;
  const dutyPct = S.market === 'IN' ? C.dutyOn(d, duty) : 0;
  const auto24 = R.loading ? null : C.marketRate24(S.market, R.gold, fx, dutyPct);
  const rate24 = S.manualRate ?? auto24;
  const factor = C.purityFactor(S.market, S.k, C.num(S.customPct, 'decimal'));
  const price = C.num(S.price);
  const wt = C.num(S.wt, 'decimal');
  const other = S.other.trim() ? C.num(S.other) : 0;
  const tax = S.tax[S.market];
  const taxPct = C.num(tax.pct, 'decimal');
  let res;
  if (Number.isNaN(other)) res = { ok: false, err: 'other' };
  else if (tax.incl && Number.isNaN(taxPct)) res = { ok: false, err: 'tax' };
  else res = C.making({ price, priceCur: S.priceCur, weight: wt, factor, rate24, rateCur: m.cur, fx, taxIncl: tax.incl, taxPct, other });
  return { m, d, fx, fxAuto, dutyPct, auto24, rate24, factor, price, wt, other, tax, taxPct, res };
}

// ---------- rendering ----------
const focused = el => document.activeElement === el;
const setVal = (el, v) => { if (!focused(el) && el.value !== v) el.value = v; };
const mark = (el, bad) => { el.classList.toggle('bad', bad); el.setAttribute('aria-invalid', bad ? 'true' : 'false'); };
const badNum = (text, comma) => text.trim() !== '' && Number.isNaN(C.num(text, comma));

function setPressed(seg, v) {
  for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === v));
}

function buildPurity() {
  const sel = $('purity');
  sel.textContent = '';
  for (const p of C.PURITIES) sel.append(new Option(purityLabel(S.market, p.k), p.k));
  sel.append(new Option('Custom…', 'custom'));
  sel.value = S.k;
}

function rateStatus(c) {
  const el = $('rateStatus');
  let text, err = false;
  const unit = c.m.unit;
  if (R.loading) text = 'Fetching gold rate…';
  else if (R.gold == null) {
    err = S.manualRate == null;
    text = c.d < C.HIST_START
      ? `Automatic gold rates start on ${fmtDate(C.HIST_START)}. Type the gold rate for ${fmtDate(c.d)} below.`
      : 'Could not fetch the gold rate (offline?). Type it below.';
  } else if (R.live) {
    text = R.stale
      ? `Offline. Using the last known spot price $${C.plain(R.gold, 2)}/oz from ${fmtDate(C.localISO(new Date(R.staleAt)))} ${fmtTime(R.staleAt)}.`
      : `Live spot price $${C.plain(R.gold, 2)}/oz${R.gAt ? ` · updated ${fmtTime(R.gAt)}` : ''}`;
  } else {
    text = `Gold on ${fmtDate(c.d)}: $${C.plain(R.gold, 2)}/oz` + (R.gDate && R.gDate !== c.d ? ` (no data that day; using ${fmtDate(R.gDate)})` : '');
  }
  if (S.manualRate != null && !R.loading) {
    err = false;
    text = `Using your typed rate${Number.isFinite(c.auto24) ? ` (market ${S.market === 'IN' ? 'estimate' : 'rate'}: ${C.money(c.auto24 * c.m.unitG, c.m.cur)}/${unit})` : ''}.`;
  }
  el.textContent = text;
  el.classList.toggle('err', err);
}

function render() {
  const c = compute();
  const { m, res } = c;
  const unit = m.unit;
  setPressed($('marketSeg'), S.market);
  setPressed($('curSeg'), S.priceCur);
  const dateEl = $('date');
  dateEl.max = today();
  dateEl.min = C.yearsBack(today(), 3);
  if (dateEl.value !== c.d) dateEl.value = c.d; // always show the date actually used (after clamping)
  $('todayBtn').hidden = !S.date;

  // Rate inputs (24K and the selected purity), in the market's unit.
  rateStatus(c);
  const kLabel = S.k === 'custom' ? `Custom (${S.customPct || '?'}%)` : `${S.k}K`;
  $('r24Label').textContent = `24K rate (${m.cur === 'INR' ? '₹' : '$'}/${unit})`;
  $('rKLabel').textContent = `${kLabel} rate (${m.cur === 'INR' ? '₹' : '$'}/${unit})`;
  $('rKWrap').hidden = S.k === '24';
  const r24 = c.rate24, okRate = r24 > 0;
  const kRate = okRate && c.factor > 0 ? r24 * c.factor : NaN;
  setVal($('r24'), okRate ? C.plain(r24 * m.unitG, 2, m.cur) : (S.manualRate == null ? '' : $('r24').value));
  setVal($('rK'), Number.isFinite(kRate) ? C.plain(kRate * m.unitG, 2, m.cur) : (S.manualRate == null ? '' : $('rK').value));
  mark($('r24'), S.manualRate != null && !okRate && rateTypedIn === '24');
  mark($('rK'), S.manualRate != null && !okRate && rateTypedIn === 'k');
  $('rateSub').textContent = okRate
    ? `Per gram: 24K ${C.money(r24, m.cur)}` + (S.k !== '24' && Number.isFinite(kRate) ? ` · ${kLabel} ${C.money(kRate, m.cur)}` : '')
    : '';
  $('resetRate').hidden = S.manualRate == null;

  // FX
  setVal($('fx'), c.fx > 0 ? C.plain(c.fx, 4) : (S.manualFx == null ? '' : $('fx').value));
  mark($('fx'), S.manualFx != null && !(c.fx > 0));
  $('fxStatus').textContent = S.manualFx != null ? 'Your rate' : R.loading ? '' : R.fx ? (R.live ? `Latest (${fmtDate(R.fxDate)})` : `On ${fmtDate(R.fxDate)}`) : 'Unavailable: type it';
  $('resetFx').hidden = S.manualFx == null;

  const dn = $('dutyNote');
  dn.hidden = S.market !== 'IN';
  if (S.market === 'IN') {
    dn.textContent = `India rate estimate = international price × USD-INR + ${c.dutyPct}% import duty (on this date). GST is not included. Jewellers' board rates can differ by a few percent, so type your jeweller's rate above if you have it.`;
  }

  // Item inputs
  setVal($('price'), S.price);
  $('price').placeholder = S.priceCur === 'INR' ? 'e.g. 1,25,000' : 'e.g. 1,250';
  setVal($('wt'), S.wt);
  setVal($('customPct'), S.customPct);
  setVal($('other'), S.other);
  if ($('purity').value !== S.k) $('purity').value = S.k;
  $('customWrap').hidden = S.k !== 'custom';
  $('taxName').textContent = S.market === 'IN' ? 'GST' : 'sales tax';
  $('taxIncl').checked = c.tax.incl;
  setVal($('taxPct'), c.tax.pct);
  $('taxPct').disabled = !c.tax.incl;
  mark($('price'), badNum(S.price));
  mark($('wt'), badNum(S.wt, 'decimal'));
  mark($('customPct'), S.k === 'custom' && S.customPct.trim() !== '' && !(c.factor > 0));
  mark($('other'), badNum(S.other));
  mark($('taxPct'), c.tax.incl && (Number.isNaN(c.taxPct) || c.taxPct > 50));
  $('priceConv').textContent = c.price > 0 && c.fx > 0 ? `≈ ${C.money(C.convert(c.price, S.priceCur, otherCur(S.priceCur), c.fx), otherCur(S.priceCur))}` : '';

  // Result
  const warn = $('warn');
  const bd = $('breakdown');
  bd.textContent = '';
  if (res.ok) {
    const cur = S.priceCur, alt = otherCur(cur);
    $('mkAmt').textContent = C.money(res.making, cur);
    $('mkAlt').textContent = c.fx > 0 ? `≈ ${C.money(C.convert(res.making, cur, alt, c.fx), alt)}` : '';
    $('mkPct').textContent = pctText(res.pct);
    $('mkPg').textContent = C.money(res.perGram, cur);
    $('mkGold').textContent = C.money(res.gold, cur);
    $('mkPctBox').classList.remove('empty');
    $('mkPctPrice').textContent = pctText(res.pctPrice);
    $('mkPctPriceLabel').textContent = c.tax.incl ? `of price before ${S.market === 'IN' ? 'GST' : 'tax'}` : 'of price';
    $('mkPctPriceBox').classList.remove('empty');
    const rows = [[`Price${c.tax.incl ? '' : ' (before tax)'}`, C.money(c.price, cur)]];
    if (c.tax.incl) {
      rows.push([`− ${S.market === 'IN' ? 'GST' : 'Sales tax'} ${C.plain(c.taxPct, 3)}%`, C.money(res.tax, cur)]);
      rows.push(['Price before tax', C.money(res.preTax, cur)]);
    }
    if (res.other > 0) rows.push(['− Stones / other', C.money(res.other, cur)]);
    rows.push([`− Gold value (${C.plain(c.wt, 3)} g × ${C.money(res.itemRate, cur)}/g)`, C.money(res.gold, cur)]);
    rows.push(['= Making charge', C.money(res.making, cur), true]);
    rows.push(['Price per gram (before tax)', C.money(res.pricePerGram, cur)]);
    for (const [k, v, total] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      if (total) { dt.className = 'total'; dd.className = 'total'; }
      bd.append(dt, dd);
    }
    warn.hidden = !(res.making < 0);
    warn.textContent = 'The price is below the gold value. Check the weight, purity, tax setting or gold rate.';
  } else {
    $('mkAmt').textContent = '—';
    $('mkAlt').textContent = hint(res.err, c);
    $('mkPct').textContent = '—';
    $('mkPg').textContent = '—';
    $('mkGold').textContent = '—';
    $('mkPctBox').classList.add('empty');
    $('mkPctPrice').textContent = '—';
    $('mkPctPriceLabel').textContent = 'of price';
    $('mkPctPriceBox').classList.add('empty');
    const msg = problem(res.err, c);
    warn.hidden = !msg;
    warn.textContent = msg || '';
  }
  $('saveBtn').disabled = !res.ok;
  $('saveBtn').textContent = S.editing ? 'Save changes' : 'Save';
  $('editBanner').hidden = !S.editing;
  $('editName').textContent = S.editing ? `“${S.editing.name}”` : '';
}

function hint(err, c) {
  if (err === 'price' && !S.price.trim()) return 'Enter the item price';
  if (err === 'weight' && !S.wt.trim()) return 'Enter the gold weight';
  if (err === 'rate' && R.loading) return 'Waiting for the gold rate…';
  if (err === 'purity' && S.k === 'custom' && !S.customPct.trim()) return 'Enter the custom purity';
  return '';
}

function problem(err, c) {
  if (hint(err, c)) return '';
  return {
    price: 'The price is not a valid number.',
    weight: 'The weight is not a valid number.',
    purity: 'Custom purity must be between 0 and 100%.',
    rate: 'Enter the gold rate above.',
    fx: 'Enter the USD to INR rate above.',
    tax: 'Tax % must be a number between 0 and 50.',
    other: 'Stones / other charges is not a valid number.'
  }[err] || '';
}

// ---------- rates ----------
let reqId = 0;
async function loadRates() {
  const id = ++reqId;
  const d = curDate();
  if (R.date !== d) { R = { loading: true, date: d }; render(); }
  const r = await getRates(d, today());
  if (id !== reqId) return;
  R = { ...r, date: d, loading: false };
  render();
  if (cloudMod && ((R.gold == null && d >= C.HIST_START) || R.fx == null)) cloudMod.track('errRates', 1);
}

// ---------- input handlers ----------
function onField(id, key, after) {
  $(id).addEventListener('input', e => { S[key] = e.target.value; persist(); render(); after && after(); });
}
onField('price', 'price');
onField('wt', 'wt');
onField('customPct', 'customPct', prefsChanged);
onField('other', 'other');

$('purity').addEventListener('change', e => { S.k = e.target.value; persist(); render(); prefsChanged(); if (S.k === 'custom') $('customPct').focus(); });
$('taxIncl').addEventListener('change', e => { S.tax[S.market].incl = e.target.checked; persist(); render(); prefsChanged(); });
$('taxPct').addEventListener('input', e => { S.tax[S.market].pct = e.target.value; persist(); render(); prefsChanged(); });

$('marketSeg').addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v || v === S.market) return;
  S.market = v;
  S.manualRate = null; // a typed rate belongs to one market's currency/unit
  buildPurity();
  persist(); render(); prefsChanged();
});
$('curSeg').addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v || v === S.priceCur) return;
  S.priceCur = v; persist(); render(); prefsChanged();
});

function setDate(v) {
  const t = today(), min = C.yearsBack(t, 3);
  let d = C.isISODate(v) ? v : t;
  if (d > t) { d = t; toast('Future dates are not available. Showing today.'); }
  if (d < min) { d = min; toast('Rates go back 3 years. Showing the earliest date.'); }
  const next = d === t ? '' : d;
  if (next === S.date) { render(); return; }
  S.date = next;
  S.manualRate = null;
  S.manualFx = null;
  persist();
  loadRates();
}
$('date').addEventListener('change', e => setDate(e.target.value));
$('todayBtn').addEventListener('click', () => setDate(today()));

let rateTypedIn = null;
function rateInput(which) {
  return e => {
    rateTypedIn = which;
    const m = C.MARKETS[S.market];
    const text = e.target.value;
    const v = C.num(text);
    if (!text.trim()) S.manualRate = null;
    else if (v > 0) {
      const f = which === 'k' ? C.purityFactor(S.market, S.k, C.num(S.customPct, 'decimal')) : 1;
      S.manualRate = f > 0 ? v / m.unitG / f : NaN;
    } else S.manualRate = NaN;
    persist(); render();
  };
}
$('r24').addEventListener('input', rateInput('24'));
$('rK').addEventListener('input', rateInput('k'));
$('fx').addEventListener('input', e => {
  const text = e.target.value, v = C.num(text);
  S.manualFx = !text.trim() ? null : v > 0 ? v : NaN;
  persist(); render();
});
// Pre-filled rates: select on focus so typing replaces them; re-format when leaving the field.
for (const id of ['r24', 'rK', 'fx']) {
  $(id).addEventListener('focus', e => e.target.select());
  $(id).addEventListener('blur', () => render());
}
$('resetRate').addEventListener('click', () => { S.manualRate = null; persist(); render(); });
$('resetFx').addEventListener('click', () => { S.manualFx = null; persist(); render(); });

$('clearBtn').addEventListener('click', () => {
  S.price = ''; S.wt = ''; S.other = ''; S.manualRate = null; S.manualFx = null; S.editing = null;
  persist(); render();
  $('price').focus();
});
$('cancelEdit').addEventListener('click', () => { S.editing = null; persist(); render(); });

// ---------- toast ----------
let toastTimer = 0;
function toast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- views ----------
const viewFromHash = () => (location.hash === '#saved' ? 'saved' : location.hash === '#admin' ? 'admin' : 'calc');
let view = 'calc';
function setView(v, push = true) {
  if (v === 'admin' && !isOwnerUser()) v = cloudMod || !LS.get('mc:owner', 0) ? 'calc' : 'admin';
  view = v;
  $('calcView').hidden = v !== 'calc';
  $('savedView').hidden = v !== 'saved';
  $('adminView').hidden = v !== 'admin';
  $('tabCalc').setAttribute('aria-pressed', String(v === 'calc'));
  $('tabSaved').setAttribute('aria-pressed', String(v === 'saved'));
  $('tabAdmin').setAttribute('aria-pressed', String(v === 'admin'));
  const hash = v === 'calc' ? '' : '#' + v;
  if (push && location.hash !== hash) history.pushState(null, '', hash || location.pathname + location.search);
  if (v === 'saved') openSaved();
  if (v === 'admin') openAdmin();
}
$('tabCalc').addEventListener('click', () => setView('calc'));
$('tabSaved').addEventListener('click', () => setView('saved'));
$('tabAdmin').addEventListener('click', () => setView('admin'));
addEventListener('popstate', () => setView(viewFromHash(), false));

// ---------- cloud (lazy) ----------
// user: signed-in account; member: approved (true/false, null = checking); requested: access asked.
let cloudMod = null, cloudLoading = null, user = null, member = null, requested = null;
let meta = null, limits = null, items = null, itemsErr = null;
let unsubMember = null, unsubMeta = null, unsubItems = null, userToken = 0;
let notConfigured = false;
const isOwnerUser = () => !!(cloudMod && user && cloudMod.isOwner(user));

function cloud() {
  if (cloudMod) return Promise.resolve(cloudMod);
  if (!cloudLoading) {
    cloudLoading = (async () => {
      const m = await import('./cloud.js');
      if (!m.configured()) return null;
      await m.init();
      const u = await m.currentUser();
      cloudMod = m;
      onUserChange(u);
      await m.onUser(onUserChange);
      return m;
    })();
    cloudLoading.catch(() => { cloudLoading = null; });
  }
  return cloudLoading;
}

function stopUserWatches() {
  for (const un of [unsubMember, unsubMeta, unsubItems]) if (typeof un === 'function') un();
  unsubMember = unsubMeta = unsubItems = null;
}

function onUserChange(u) {
  if (u && user && u.uid === user.uid && member !== null) return; // same account, already set up
  stopUserWatches();
  const token = ++userToken;
  user = u || null; member = null; requested = null; meta = null; items = null; itemsErr = null;
  $('tabAdmin').hidden = !isOwnerUser();
  document.body.classList.toggle('owner', isOwnerUser());
  if (!user) {
    LS.del('mc:signed'); LS.del('mc:owner');
    cloudMod.enableReporting(false);
    if (view === 'admin') setView('calc');
    renderSaved();
    return;
  }
  LS.set('mc:signed', 1);
  if (isOwnerUser()) { LS.set('mc:owner', 1); checkOwnerAlerts(); }
  cloudMod.watchMembership(user, ok => {
    if (token !== userToken) return;
    const was = member;
    member = ok;
    if (ok) startMember(token);
    else {
      for (const un of [unsubMeta, unsubItems]) if (typeof un === 'function') un();
      unsubMeta = unsubItems = null; items = null; meta = null;
      cloudMod.enableReporting(false);
      cloudMod.getRequest(user.uid).then(r => { if (token === userToken) { requested = r; renderSaved(); } }).catch(() => {});
      if (was === true) toast('Your access to saved items was removed.', 5000);
    }
    renderSaved();
    afterMemberKnown();
  }, err => { if (token === userToken) { itemsErr = err; renderSaved(); } }).then(un => {
    if (token === userToken) unsubMember = un; else un();
  });
  renderSaved();
}

async function startMember(token) {
  if (unsubItems) return;
  unsubItems = 'pending';
  cloudMod.enableReporting(true);
  cloudMod.track('opens', 1);
  cloudMod.touch(user.uid);
  try {
    limits = await cloudMod.getLimits();
    const un1 = await cloudMod.watchMeta(user.uid, m => { meta = m; applyRemoteSettings(m.set); renderSaved(); }, onCloudError);
    const un2 = await cloudMod.watchItems(user.uid,
      list => { items = list; itemsErr = null; renderSaved(); },
      err => { itemsErr = err; renderSaved(); });
    if (token !== userToken) { un1(); un2(); return; }
    unsubMeta = un1; unsubItems = un2;
  } catch (e) {
    unsubItems = null; itemsErr = e; renderSaved();
  }
}
function onCloudError(e) { if (e && e.code === 'resource-exhausted') { itemsErr = e; renderSaved(); } }

function gate(msg, buttons = [], sub = '') {
  const g = $('savedGate');
  g.textContent = '';
  const p = document.createElement('p');
  p.textContent = msg;
  g.append(p);
  if (sub) { const s = document.createElement('p'); s.className = 'sub'; s.textContent = sub; g.append(s); }
  const row = document.createElement('div');
  row.className = 'gate-actions';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button'; el.className = `btn ${b.primary ? 'primary' : ''}`; el.textContent = b.label;
    el.addEventListener('click', b.onClick);
    row.append(el);
  }
  if (buttons.length) g.append(row);
  g.hidden = false;
  $('savedBody').hidden = true;
}

async function openSaved() {
  if (notConfigured) return renderSaved();
  if (!cloudMod) gate('Loading saved items…');
  try {
    const m = await cloud();
    if (!m) notConfigured = true;
  } catch {
    gate('Could not load cloud saving. Check the internet connection.', [{ label: 'Try again', primary: true, onClick: openSaved }]);
    return;
  }
  renderSaved();
}

const signOutBtn = { label: 'Sign out', onClick: () => doSignOut() };
function renderSaved() {
  const n = $('savedCount');
  n.hidden = !(member && items && items.length);
  n.textContent = items ? String(items.length) : '';
  if ($('savedView').hidden) return;
  if (notConfigured) return gate('Cloud saving is not set up yet. Follow the one-time Firebase steps in the README, then reload.');
  if (!cloudMod) return;
  if (!user) return gate('Sign in to save calculations with photos and links, and see them on all your devices.', [{ label: 'Sign in', primary: true, onClick: () => askSignIn() }]);
  const who = user.email || user.displayName || 'this account';
  if (member === null) return gate('Checking your access…');
  if (member === false) {
    if (requested === null) return gate('Checking your access…');
    if (requested) return gate('Your request has been sent.', [signOutBtn], `You can save items as soon as the owner approves ${who}. This page updates by itself.`);
    return gate(`You're signed in as ${who}.`, [{ label: 'Request access', primary: true, onClick: doRequest }, signOutBtn],
      'Saving is invite-only to keep this free app fast for everyone. The owner approves each person.');
  }
  if (itemsErr) {
    const code = itemsErr.code;
    return gate(code === 'resource-exhausted'
      ? 'The app has reached its free daily limit. Saved items will be back after midnight Pacific time. The calculator still works.'
      : code === 'permission-denied'
        ? 'Your access to saved items has been removed or is not set up yet.'
        : `Could not load saved items (${code || itemsErr.message}).`,
    [{ label: 'Try again', primary: true, onClick: () => { itemsErr = null; stopUserWatches(); member = null; onUserChange(user); } }]);
  }
  if (!items) return gate('Loading saved items…');
  $('savedGate').hidden = true;
  $('savedBody').hidden = false;
  const lim = limits ? limits.itemLimit : null;
  const used = meta ? meta.count : items.length;
  $('savedInfo').textContent = lim ? `${used} of ${lim} saved` + (used >= lim ? ' · limit reached: delete old items to save new ones' : '') : '';
  $('savedInfo').classList.toggle('bad-text', !!lim && used >= lim);
  const q = $('search').value.trim().toLowerCase();
  const shown = q ? items.filter(it => [it.name, it.notes, it.link].some(s => String(s || '').toLowerCase().includes(q))) : items;
  const ul = $('list');
  ul.textContent = '';
  for (const it of shown) ul.append(listRow(it));
  $('empty').hidden = shown.length > 0;
  $('empty').textContent = items.length ? 'Nothing matches your search.' : 'No saved items yet. Use Save on the calculator.';
}
$('search').addEventListener('input', renderSaved);

async function doRequest() {
  try {
    await cloudMod.requestAccess(user);
    requested = true;
    toast('Request sent');
  } catch (e) {
    toast(`Could not send the request (${e.code || e.message}).`, 5000);
  }
  renderSaved();
}

async function doSignOut() {
  if (!confirm('Sign out on this device? Saved items stay safe in the cloud.')) return;
  LS.del('mc:signed'); LS.del('mc:owner');
  try { await cloudMod.signOut(); } catch { /* still reload */ }
  persistNow();
  location.reload();
}

const isImg = s => typeof s === 'string' && /^data:image\/(webp|jpeg|png);base64,/.test(s);

function listRow(it) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  let thumb;
  if (isImg(it.thumb)) { thumb = document.createElement('img'); thumb.src = it.thumb; thumb.alt = ''; thumb.loading = 'lazy'; thumb.className = 'thumb'; }
  else { thumb = document.createElement('span'); thumb.className = 'thumb none'; thumb.textContent = it.k === 'custom' ? 'Au' : `${it.k}K`; }
  const main = document.createElement('span'); main.className = 'li-main';
  const nm = document.createElement('b'); nm.textContent = it.name;
  const sub = document.createElement('span'); sub.textContent = `${C.money(it.price, it.cur)} · ${C.plain(it.wt, 3)} g · ${it.k === 'custom' ? `${C.plain(it.pf * 100, 2)}%` : `${it.k}K`}`;
  const sub2 = document.createElement('span'); sub2.textContent = `${it.market === 'IN' ? 'India' : 'US'} rate · ${fmtDate(it.date)}`;
  main.append(nm, sub, sub2);
  const side = document.createElement('span'); side.className = 'li-side';
  const p = document.createElement('b'); p.textContent = pctText(it.pct);
  const a = document.createElement('span'); a.textContent = C.money(it.making, it.cur);
  side.append(p, a);
  b.append(thumb, main, side);
  b.addEventListener('click', () => openItem(it));
  li.append(b);
  return li;
}

// ---------- owner dashboard ----------
let adminMod = null, adminLoading = null;
// iPhone home-screen apps can leave the database connection asleep after being in the background,
// so loading gives up after a few seconds and offers "Try again", which also wakes the connection.
function openAdmin(retry = false) {
  if (adminLoading) return adminLoading;
  const root = $('adminBody');
  adminLoading = (async () => {
    if (!root.childElementCount || retry) root.textContent = 'Loading dashboard…';
    try {
      const m = await cloud();
      if (!m || !isOwnerUser()) { setView('calc'); return; }
      if (retry) await m.reconnect().catch(() => {});
      adminMod ||= await import('./admin.js');
      const data = await Promise.race([
        adminMod.load(),
        sleep(12000).then(() => { throw Object.assign(new Error('timeout'), { code: 'timeout' }); })
      ]);
      adminMod.render(root, data, { toast, refresh: () => openAdmin(), ownerUid: user.uid });
      setAdminDot(data.requests.length > 0 || ((data.status && data.status.alerts) || []).length > 0);
    } catch (e) {
      root.textContent = '';
      const p = document.createElement('p');
      p.className = 'card center';
      p.textContent = e.code === 'timeout'
        ? 'The dashboard is taking too long (the connection may still be waking up).'
        : `Could not load the dashboard (${e.code || e.message}).`;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn primary'; b.textContent = 'Try again';
      b.addEventListener('click', () => openAdmin(true));
      p.append(document.createElement('br'), b);
      root.append(p);
    }
  })().finally(() => { adminLoading = null; });
  return adminLoading;
}
function setAdminDot(on) { $('adminDot').hidden = !on; }
async function checkOwnerAlerts() {
  try {
    const s = await cloudMod.monitorStatus();
    const alerts = (s && s.alerts) || [];
    const pending = s && s.usage ? s.usage.pending || 0 : 0;
    setAdminDot(alerts.length > 0 || pending > 0);
    const key = 'mc:alertSeen';
    if (alerts.some(a => a.level === 'crit') && LS.get(key, '') !== C.localISO()) {
      LS.set(key, C.localISO());
      toast('Admin: an alert needs attention. Open the Admin tab.', 5000);
    }
  } catch { /* not critical */ }
}

// ---------- sign in ----------
const AUTH_MSG = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/invalid-login-credentials': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'Wrong email or password.',
  'auth/invalid-email': 'That email address does not look right.',
  'auth/missing-password': 'Enter the password.',
  'auth/missing-email': 'Enter your email address.',
  'auth/email-already-in-use': 'There is already an account with this email. Sign in instead (or use "Forgot password?").',
  'auth/weak-password': 'Use a password of at least 8 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': 'No internet connection. Try again when online.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/operation-not-allowed': 'This sign-in method is not switched on in Firebase (see README).',
  'auth/admin-restricted-operation': 'New accounts are switched off in Firebase. Turn on "Enable create (sign-up)" (see README).',
  'auth/unauthorized-domain': 'This web address is not allowed for sign-in yet (see README: Authorized domains).',
  'auth/popup-blocked': 'The browser blocked the sign-in window. Try again.',
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'The Firebase settings in config.js look wrong.',
  'auth/invalid-api-key': 'The Firebase settings in config.js look wrong.'
};
const authMsg = ex => AUTH_MSG[ex.code] || `Could not sign in (${ex.code || ex.message}).`;

let signResolve = null, signMode = 'in';
function setSignMode(mode) {
  signMode = mode;
  const up = mode === 'up';
  $('signTitle').textContent = up ? 'Create an account' : 'Sign in';
  $('nameWrap').hidden = !up;
  $('password').autocomplete = up ? 'new-password' : 'current-password';
  $('signBtn').textContent = up ? 'Create account' : 'Sign in';
  $('modeText').textContent = up ? 'Already have an account?' : 'New here?';
  $('modeBtn').textContent = up ? 'Sign in' : 'Create an account';
  $('forgotBtn').hidden = up;
  $('signErr').hidden = true;
}
async function askSignIn(intent = '') {
  let m;
  try { m = await cloud(); } catch { toast('Could not load sign-in. Check the internet connection.'); return false; }
  if (!m) { notConfigured = true; toast('Cloud saving is not set up yet (see README).'); return false; }
  if (user) return true;
  signIntent = intent;
  setSignMode('in');
  $('password').value = '';
  $('signDlg').showModal();
  return new Promise(res => { signResolve = res; });
}
let signIntent = '';
function endSignIn(ok) {
  const r = signResolve; signResolve = null;
  if ($('signDlg').open) $('signDlg').close();
  r && r(ok);
  runPendingUpdate();
}
$('modeBtn').addEventListener('click', () => setSignMode(signMode === 'up' ? 'in' : 'up'));
$('googleBtn').addEventListener('click', async () => {
  try {
    sessionStorage.setItem('mc:redirect', JSON.stringify({ view, intent: signIntent }));
  } catch { /* ignore */ }
  $('googleBtn').disabled = true;
  try {
    await cloudMod.signInGoogle(); // leaves the page; we come back signed in
  } catch (ex) {
    $('googleBtn').disabled = false;
    $('signErr').textContent = authMsg(ex);
    $('signErr').hidden = false;
  }
});
$('forgotBtn').addEventListener('click', async () => {
  const email = $('email').value.trim();
  const err = $('signErr');
  if (!email) { err.textContent = 'Type your email above first, then tap "Forgot password?".'; err.hidden = false; return; }
  try {
    await cloudMod.resetPassword(email);
    err.hidden = true;
    toast('If that email has an account, a reset link is on its way (check spam).', 5000);
  } catch (ex) { err.textContent = authMsg(ex); err.hidden = false; }
});
$('signForm').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('email').value, pw = $('password').value;
  const err = $('signErr');
  if (!email.trim() || !pw) { err.textContent = 'Enter the email and password.'; err.hidden = false; return; }
  if (signMode === 'up' && pw.length < 8) { err.textContent = 'Use a password of at least 8 characters.'; err.hidden = false; return; }
  $('signBtn').disabled = true;
  try {
    if (signMode === 'up') await cloudMod.signUpEmail(email, pw, $('suName').value);
    else await cloudMod.signInEmail(email, pw);
    endSignIn(true);
    toast(signMode === 'up' ? 'Account created' : 'Signed in');
  } catch (ex) {
    err.textContent = authMsg(ex);
    err.hidden = false;
  } finally {
    $('signBtn').disabled = false;
  }
});
$('signCancel').addEventListener('click', () => endSignIn(false));
$('signDlg').addEventListener('cancel', () => endSignIn(false));

// Coming back from Google sign-in.
let afterSignIn = null;
async function finishRedirect() {
  let info = null;
  try { info = JSON.parse(sessionStorage.getItem('mc:redirect')); sessionStorage.removeItem('mc:redirect'); } catch { /* ignore */ }
  if (!info) return;
  try {
    const m = await cloud();
    if (!m) return;
    await m.redirectResult();
    afterSignIn = info.intent || null;
    if (info.view && info.view !== 'calc') setView(info.view);
  } catch (ex) {
    toast(authMsg(ex), 6000);
  }
}
// Once we know whether a newly signed-in person is approved, continue what they were doing.
function afterMemberKnown() {
  if (afterSignIn !== 'save') return;
  afterSignIn = null;
  if (member) openSave();
  else { setView('saved'); toast('Ask for access first: the owner approves each person.', 5000); }
}

// ---------- settings that follow each person across devices ----------
let prefTimer = 0, pushedPrefs = false;
function prefs() {
  return { market: S.market, cur: S.priceCur, k: S.k, customPct: S.customPct, tax: S.tax, duty };
}
function prefsChanged() {
  LS.set('mc:prefT', Date.now());
  if (!member || !cloudMod || !user) return;
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => cloudMod.saveSettings(user.uid, { ...prefs(), t: LS.get('mc:prefT', Date.now()) }).catch(() => {}), 4000);
}
function applyRemoteSettings(set) {
  if (!set || !set.t) { if (!pushedPrefs) { pushedPrefs = true; prefsChanged(); } return; }
  if (set.t <= LS.get('mc:prefT', 0)) return;
  if (set.market === 'US' || set.market === 'IN') S.market = set.market;
  if (set.cur === 'USD' || set.cur === 'INR') S.priceCur = set.cur;
  if (C.PURITIES.some(p => p.k === set.k) || set.k === 'custom') S.k = set.k;
  if (typeof set.customPct === 'string') S.customPct = set.customPct;
  for (const mk of ['US', 'IN']) {
    const t = set.tax && set.tax[mk];
    if (t && typeof t.incl === 'boolean' && typeof t.pct === 'string') S.tax[mk] = { incl: t.incl, pct: t.pct.slice(0, 10) };
  }
  if (Array.isArray(set.duty) && set.duty.length && set.duty.every(r => r && C.isISODate(r.from) && Number.isFinite(r.pct))) {
    duty = set.duty.map(r => ({ from: r.from, pct: r.pct }));
    LS.set('mc:duty', duty);
  }
  LS.set('mc:prefT', set.t);
  S.manualRate = null;
  buildPurity(); persist(); render();
}

// ---------- save ----------
let pendingPhoto; // undefined = unchanged, null = removed, { photo, thumb } = new
let imageMod = null;

function existingItem(id) { return items && items.find(i => i.id === id); }

function showPreview(src) {
  const img = $('sPreview');
  if (src) { img.src = src; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
  $('sRemovePhoto').hidden = !src && !(pendingPhoto === undefined && S.editing && S.editing.photo);
}

function openSave() {
  const c = compute();
  if (!c.res.ok) return;
  const e = S.editing;
  $('saveTitle').textContent = e ? 'Save changes' : 'Save calculation';
  $('sName').value = e ? e.name : `${S.k === 'custom' ? `${S.customPct}%` : `${S.k}K`} · ${C.plain(c.wt, 3)} g`;
  $('sLink').value = e ? e.link : '';
  $('sNotes').value = e ? e.notes : '';
  $('sPhoto').value = '';
  pendingPhoto = undefined;
  const ex = e && existingItem(e.id);
  showPreview(ex && isImg(ex.thumb) ? ex.thumb : null);
  $('sPhotoMsg').textContent = e && e.photo && !(ex && ex.thumb) ? 'Current photo will be kept.' : 'Optional. Shrunk to a small size before saving.';
  $('sSave').textContent = e ? 'Save changes' : 'Save';
  $('sSaveNew').hidden = !e;
  $('sErr').hidden = true;
  $('saveDlg').showModal();
}
async function onSaveClick() {
  if (!compute().res.ok) return;
  let m;
  try { m = await cloud(); } catch { toast('Could not connect. Check the internet connection and try again.', 4000); return; }
  if (!m) { openSave(); return; } // explains that cloud saving is not set up
  if (!user && !(await askSignIn('save'))) return;
  const t0 = Date.now();
  while (member === null && Date.now() - t0 < 8000) await sleep(100);
  if (member) { openSave(); return; }
  setView('saved');
  if (member === false) toast('Ask for access first: the owner approves each person.', 5000);
}
$('saveBtn').addEventListener('click', onSaveClick);

$('sPhoto').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const msg = $('sPhotoMsg');
  msg.textContent = 'Preparing photo…';
  $('sSave').disabled = $('sSaveNew').disabled = true;
  try {
    imageMod ||= await import('./image.js');
    pendingPhoto = await imageMod.compress(file);
    showPreview(pendingPhoto.thumb);
    msg.textContent = `Photo ready (${Math.round(pendingPhoto.photo.length * 0.75 / 1024)} KB).`;
  } catch (ex) {
    msg.textContent = ex.message === 'not-image' ? 'That file is not a photo.' : 'This photo format is not supported here. Try a JPEG or PNG (or a screenshot).';
  } finally {
    $('sSave').disabled = $('sSaveNew').disabled = false;
    e.target.value = '';
  }
});
$('sRemovePhoto').addEventListener('click', () => {
  pendingPhoto = null;
  showPreview(null);
  $('sRemovePhoto').hidden = true;
  $('sPhotoMsg').textContent = 'Photo will be removed when you save.';
});

const FS_MSG = {
  'permission-denied': 'Not allowed: your item limit may be reached, or your access was removed.',
  'unauthenticated': 'Please sign in again.',
  'resource-exhausted': 'The free Firebase daily limit was reached. Try again tomorrow.',
  'invalid-argument': 'Something in this item could not be saved (too large?).'
};

let saving = false;
$('saveForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (saving) return;
  const asNew = e.submitter && e.submitter.value === 'new';
  const err = $('sErr');
  const fail = m => { err.textContent = m; err.hidden = false; };
  err.hidden = true;
  const name = $('sName').value.trim();
  if (!name) return fail('Give it a name.');
  const link = C.safeUrl($('sLink').value);
  if (link === null || link.length > 2000) return fail('That product link does not look right. Paste the full link (https://…).');
  const notes = $('sNotes').value.trim().slice(0, 1000);
  const c = compute();
  if (!c.res.ok) return fail('The calculation is incomplete.');

  saving = true;
  $('sSave').disabled = $('sSaveNew').disabled = true;
  try {
    let m;
    try { m = await cloud(); } catch { return fail('Could not connect. Check the internet connection and try again.'); }
    if (!m) { notConfigured = true; return fail('Cloud saving is not set up yet. See the README for the one-time Firebase setup.'); }
    if (!(await askSignIn())) return;
    if (!member) return fail('Your account is not approved for saving yet. Open Saved to request access.');
    const editId = S.editing && !asNew ? S.editing.id : null;
    if (!editId && meta && limits && meta.count >= limits.itemLimit) {
      return fail(`You have reached the limit of ${limits.itemLimit} saved items. Delete some old ones to save new ones.`);
    }
    const data = {
      name: name.slice(0, 120), link, notes, market: S.market, date: c.d,
      price: c.price, cur: S.priceCur, wt: c.wt, k: S.k, pf: c.factor, other: c.res.other,
      taxIncl: c.tax.incl, taxPct: c.tax.incl ? c.taxPct : 0,
      rate24: c.rate24, rateManual: S.manualRate != null, fx: c.fx > 0 ? c.fx : null, duty: c.dutyPct,
      gold: c.res.gold, making: c.res.making, pct: c.res.pct, perGram: c.res.perGram, preTax: c.res.preTax,
      ts: editId ? S.editing.ts : Date.now(), upd: Date.now()
    };
    let photoArg;
    if (pendingPhoto) { photoArg = pendingPhoto.photo; data.thumb = pendingPhoto.thumb; data.photo = true; }
    else if (pendingPhoto === null) { photoArg = editId ? null : undefined; data.thumb = ''; data.photo = false; }
    else if (!editId && S.editing && S.editing.photo) {
      // "Save as new" from an item with a photo: copy the photo too.
      photoArg = (await cloudMod.getPhoto(user.uid, S.editing.id).catch(() => null)) || undefined;
      const ex = existingItem(S.editing.id);
      data.thumb = photoArg && ex && isImg(ex.thumb) ? ex.thumb : '';
      data.photo = !!photoArg;
    } else if (!editId) { data.thumb = ''; data.photo = false; }
    // When editing with the photo unchanged, thumb/photo are left out and kept by a merge.

    const { done } = await cloudMod.saveItem(user.uid, editId, data, photoArg);
    const r = await Promise.race([done.then(() => 'ok', x => x), sleep(6000).then(() => 'slow')]);
    if (r !== 'ok' && r !== 'slow') return fail(FS_MSG[r.code] || `Could not save (${r.code || r.message}).`);
    if (r === 'slow') {
      toast('Saved on this device. It will upload when the internet is back.', 4000);
      done.catch(x => toast(`Upload failed: ${FS_MSG[x.code] || x.code || x.message}`, 6000));
    } else toast(editId ? 'Changes saved' : 'Saved');
    S.editing = null;
    pendingPhoto = undefined;
    persist();
    $('saveDlg').close();
    render();
  } catch (ex) {
    fail(`Could not save (${ex.code || ex.message}).`);
  } finally {
    saving = false;
    $('sSave').disabled = $('sSaveNew').disabled = false;
  }
});
$('sCancel').addEventListener('click', () => $('saveDlg').close());

// ---------- item detail ----------
let openId = null;
function openItem(it) {
  openId = it.id;
  const dlg = $('itemDlg');
  $('iName').textContent = it.name;
  const a = $('iLink');
  const link = C.safeUrl(it.link);
  if (link) { a.href = link; a.textContent = `Open product page (${new URL(link).hostname})`; a.hidden = false; }
  else { a.removeAttribute('href'); a.hidden = true; }
  $('iNotes').textContent = it.notes || '';
  $('iNotes').hidden = !it.notes;
  const m = C.MARKETS[it.market] || C.MARKETS.US;
  const facts = [
    ['Making charge', `${C.money(it.making, it.cur)} (${pctText(it.pct)})`],
    ['Making % of price', it.preTax > 0 ? `${pctText((it.making / it.preTax) * 100)}${it.taxIncl ? ` (before ${it.market === 'IN' ? 'GST' : 'tax'})` : ''}` : '—'],
    ['Making per gram', C.money(it.perGram, it.cur)],
    ['Price', `${C.money(it.price, it.cur)}${it.taxIncl ? ` incl. ${it.market === 'IN' ? 'GST' : 'tax'} ${C.plain(it.taxPct, 3)}%` : ''}`],
    ['Gold', `${C.plain(it.wt, 3)} g · ${it.k === 'custom' ? `${C.plain(it.pf * 100, 2)}%` : purityLabel(it.market, it.k)}`],
    ['Gold value', C.money(it.gold, it.cur)]
  ];
  if (it.other > 0) facts.push(['Stones / other', C.money(it.other, it.cur)]);
  facts.push([`24K rate (${it.market === 'IN' ? 'India' : 'US'})`, `${C.money(it.rate24 * m.unitG, m.cur)}/${m.unit}${it.rateManual ? ' · typed' : ''}`]);
  if (it.market === 'IN' && !it.rateManual) facts.push(['Import duty used', `${it.duty}%`]);
  facts.push(['Rate date', fmtDate(it.date)]);
  if (it.fx) facts.push(['USD to INR', `₹${C.plain(it.fx, 4)}`]);
  facts.push(['Saved', new Date(it.upd || it.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })]);
  const dl = $('iFacts');
  dl.textContent = '';
  for (const [k, v] of facts) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  const img = $('iPhoto'), pm = $('iPhotoMsg');
  img.hidden = true; img.removeAttribute('src');
  $('iPhotoBox').hidden = !it.photo;
  if (it.photo) {
    if (isImg(it.thumb)) { img.src = it.thumb; img.hidden = false; }
    pm.textContent = 'Loading photo…';
    cloudMod.getPhoto(user.uid, it.id).then(d => {
      if (openId !== it.id) return;
      if (isImg(d)) { img.src = d; img.hidden = false; pm.textContent = ''; }
      else pm.textContent = 'Photo not found.';
    }).catch(() => { if (openId === it.id) pm.textContent = 'Photo unavailable offline.'; });
  }
  dlg.showModal();
}

$('iClose').addEventListener('click', () => $('itemDlg').close());
$('itemDlg').addEventListener('close', () => { openId = null; runPendingUpdate(); });
$('iEdit').addEventListener('click', () => {
  const it = existingItem(openId);
  if (!it) return;
  S.market = it.market === 'IN' ? 'IN' : 'US';
  S.date = it.date === today() ? '' : it.date;
  S.priceCur = it.cur === 'INR' ? 'INR' : 'USD';
  S.price = String(it.price);
  S.wt = String(it.wt);
  S.k = it.k;
  S.customPct = it.k === 'custom' ? String(+(it.pf * 100).toFixed(4)) : S.customPct;
  S.other = it.other > 0 ? String(it.other) : '';
  S.tax[S.market] = { incl: !!it.taxIncl, pct: String(it.taxIncl ? it.taxPct : S.tax[S.market].pct) };
  S.manualRate = it.rate24; // keep the exact saved rate so the result matches
  S.manualFx = it.fx || null;
  S.editing = { id: it.id, name: it.name, link: it.link || '', notes: it.notes || '', ts: it.ts, photo: !!it.photo };
  persist();
  $('itemDlg').close();
  buildPurity();
  setView('calc');
  loadRates();
  render();
  scrollTo(0, 0);
});
$('iDelete').addEventListener('click', async () => {
  const it = existingItem(openId);
  if (!it || !confirm(`Delete “${it.name}”? This cannot be undone.`)) return;
  try {
    const { done } = await cloudMod.deleteItem(user.uid, it.id);
    const r = await Promise.race([done.then(() => 'ok', x => x), sleep(6000).then(() => 'slow')]);
    if (r !== 'ok' && r !== 'slow') { toast(FS_MSG[r.code] || `Could not delete (${r.code || r.message}).`, 5000); return; }
    if (S.editing && S.editing.id === it.id) { S.editing = null; persist(); render(); }
    $('itemDlg').close();
    toast(r === 'slow' ? 'Deleted on this device. It will sync when online.' : 'Deleted');
  } catch (ex) {
    toast(`Could not delete (${ex.code || ex.message}).`, 5000);
  }
});

// ---------- settings ----------
function renderDuty() {
  const box = $('dutyRows');
  box.textContent = '';
  duty.forEach((r, i) => {
    const row = document.createElement('div'); row.className = 'duty-row';
    const l1 = document.createElement('label'); l1.textContent = i === 0 ? 'Starting duty' : 'From';
    const d = document.createElement('input'); d.type = 'date'; d.value = r.from; d.disabled = i === 0;
    l1.append(d);
    const l2 = document.createElement('label'); l2.textContent = 'Duty %';
    const p = document.createElement('input'); p.inputMode = 'decimal'; p.value = String(r.pct);
    l2.append(p);
    const del = document.createElement('button'); del.type = 'button'; del.className = 'chip'; del.textContent = '✕'; del.hidden = i === 0;
    del.setAttribute('aria-label', `Remove the change from ${fmtDate(r.from)}`);
    const update = () => {
      const pct = C.num(p.value, 'decimal');
      const okP = pct >= 0 && pct <= 100, okD = i === 0 || C.isISODate(d.value);
      mark(p, !okP); mark(d, !okD);
      if (okP && okD) { duty[i] = { from: i === 0 ? r.from : d.value, pct }; saveDuty(false); }
    };
    d.addEventListener('change', () => { update(); renderDuty(); });
    p.addEventListener('input', update);
    del.addEventListener('click', () => { duty.splice(i, 1); saveDuty(true); });
    row.append(l1, l2, del);
    box.append(row);
  });
}
function saveDuty(rerender) {
  duty.sort((a, b) => (a.from < b.from ? -1 : 1));
  LS.set('mc:duty', duty);
  if (rerender) renderDuty();
  render();
  prefsChanged();
}
$('dutyAdd').addEventListener('click', () => { duty.push({ from: today(), pct: C.dutyOn(today(), duty) }); saveDuty(true); });
$('dutyReset').addEventListener('click', () => { duty = C.DEFAULT_DUTY.map(r => ({ ...r })); LS.del('mc:duty'); renderDuty(); render(); prefsChanged(); });

$('settingsBtn').addEventListener('click', () => {
  renderDuty();
  $('acctInfo').textContent = user
    ? `Signed in as ${user.email || user.displayName || 'your account'}${isOwnerUser() ? ' (owner)' : member ? '' : member === false ? ' (waiting for approval)' : ''}.`
    : notConfigured ? 'Cloud saving is not set up.' : 'Not signed in on this device.';
  $('signOutBtn').hidden = !user;
  $('ver').textContent = VERSION;
  $('setDlg').showModal();
});
$('setClose').addEventListener('click', () => $('setDlg').close());
$('setDlg').addEventListener('close', runPendingUpdate);
$('signOutBtn').addEventListener('click', doSignOut);
$('clearRates').addEventListener('click', () => { clearCache(); R = { loading: true, date: null }; loadRates(); toast('Saved gold rates cleared'); });
$('saveDlg').addEventListener('close', runPendingUpdate);

// Tap outside a dialog to close it (except while signing in or saving).
for (const id of ['itemDlg', 'setDlg', 'saveDlg']) {
  $(id).addEventListener('click', e => { if (e.target === e.currentTarget && !saving) e.currentTarget.close(); });
}

// ---------- app updates (service worker) ----------
let pendingUpdate = null;
const anyDialogOpen = () => [...document.querySelectorAll('dialog')].some(d => d.open);
function runPendingUpdate() {
  if (pendingUpdate && !anyDialogOpen()) { const go = pendingUpdate; pendingUpdate = null; go(); }
}
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = w => {
      if (!w || !hadController) return;
      pendingUpdate = () => w.postMessage('skipWaiting');
      runPendingUpdate();
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => { /* app works without offline support */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    persistNow();
    location.reload();
  });
}

// ---------- start ----------
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { persistNow(); if (cloudMod) cloudMod.flush().catch(() => {}); return; }
  if (!S.date) loadRates(); // refresh "today" (cached for 10 minutes)
  if (view === 'admin') openAdmin(); // fresh numbers when coming back to the app
});
addEventListener('pagehide', persistNow);

buildPurity();
render();
loadRates();
setView(viewFromHash(), false);
finishRedirect();
if (LS.get('mc:signed', 0) && view === 'calc') {
  // Signed in before: warm up cloud data in the background so Saved opens instantly.
  (window.requestIdleCallback || (f => setTimeout(f, 1500)))(() => cloud().catch(() => {}));
}
