// Owner-only dashboard: usage against the free limits, alerts, access requests, members, limits.
// Loaded only for the owner's account, so it adds nothing for anyone else.
import { init, pacificDay, DEFAULT_LIMITS } from './cloud.js';

export const FREE = { reads: 50000, writes: 20000, deletes: 20000, storageMB: 1024, egressMB: 10240 };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmtN = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const ago = t => {
  if (!t) return 'never';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
export const level = pct => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok');

export async function load() {
  const { F, db } = await init();
  const day = pacificDay();
  const g = p => F.getDoc(F.doc(db, ...p)).then(s => (s.exists() ? s.data() : null));
  const all = c => F.getDocs(F.collection(db, c)).then(s => s.docs.map(d => ({ id: d.id, ...d.data() })));
  const [status, stats, cfg, requests, members, users, activeToday] = await Promise.all([
    g(['monitor', 'status']), g(['stats', day]), g(['config', 'app']), all('requests'), all('members'), all('users'),
    F.getCountFromServer(F.query(F.collection(db, 'active'), F.where('d', '==', day))).then(r => r.data().count).catch(() => null)
  ]);
  return { day, status, stats: stats || {}, limits: { ...DEFAULT_LIMITS, ...(cfg || {}) }, requests, members, users, activeToday };
}

export async function approve(req) {
  const { F, db } = await init();
  const b = F.writeBatch(db);
  b.set(F.doc(db, 'members', req.id), { name: String(req.name || '').slice(0, 100), email: String(req.email || '').slice(0, 200), ts: Date.now() });
  b.delete(F.doc(db, 'requests', req.id));
  return b.commit();
}
export async function decline(id) {
  const { F, db } = await init();
  return F.deleteDoc(F.doc(db, 'requests', id));
}
export async function remove(id, purge) {
  const { F, db } = await init();
  const b = F.writeBatch(db);
  b.delete(F.doc(db, 'members', id));
  if (purge) b.set(F.doc(db, 'purge', id), { ts: Date.now() });
  return b.commit();
}
export async function saveLimits(limits) {
  const { F, db } = await init();
  return F.setDoc(F.doc(db, 'config', 'app'), { itemLimit: limits.itemLimit, maxMembers: limits.maxMembers });
}

// Usage numbers: exact figures from Google (via the hourly monitor job) when available,
// otherwise the app's own estimate for today.
export function usage(data) {
  const u = data.status && data.status.usage;
  const fresh = u && u.day === data.day && u.source === 'google';
  const s = data.stats;
  return {
    source: fresh ? 'exact numbers from Google, updated hourly' : 'estimated by the app, updated every few minutes',
    reads: fresh ? u.reads : s.reads || 0,
    writes: fresh ? u.writes : s.writes || 0,
    deletes: fresh ? u.deletes : s.deletes || 0,
    storageMB: u && Number.isFinite(u.storageMB) ? u.storageMB : null,
    egressMB: u && Number.isFinite(u.egressMonthMB) ? u.egressMonthMB : null
  };
}

// True when Google withholds its exact numbers because the project has no billing (free Spark plan).
// Also recognises the raw error text older alert-job runs stored, before the `google` field existed.
export function needsBilling(st) {
  return !!st && (st.google === 'needs-billing' || (!st.google && /billing/i.test(String(st.note || ''))));
}

function meter(label, value, limit, unit, note, missing = 'not available yet') {
  const box = el('div', 'meter');
  const pct = Number.isFinite(value) && limit ? Math.min(100, (value / limit) * 100) : null;
  const head = el('div', 'meter-head');
  head.append(el('span', null, label), el('b', null, pct == null ? missing : `${fmtN(value)} / ${fmtN(limit)}${unit ? ' ' + unit : ''} · ${pct.toFixed(0)}%`));
  const bar = el('div', 'bar');
  const fill = el('i', `fill ${pct == null ? '' : level(pct)}`);
  fill.style.width = `${pct || 0}%`;
  bar.append(fill);
  box.append(head, bar);
  if (note) box.append(el('p', 'sub', note));
  return box;
}

// ctx: { toast, refresh, ownerUid }
export function render(root, data, ctx) {
  root.textContent = '';
  const u = usage(data);
  const st = data.status;

  // Status and alerts
  const status = el('div', 'card');
  status.append(el('h2', null, 'Status'));
  const alerts = (st && st.alerts) || [];
  const stale = !st || !st.ts || Date.now() - st.ts > 3 * 3600 * 1000;
  const worst = alerts.some(a => a.level === 'crit') ? 'crit' : alerts.some(a => a.level === 'warn') || stale ? 'warn' : 'ok';
  const badge = el('p', `badge ${worst}`, worst === 'ok' ? 'All good' : worst === 'warn' ? 'Needs attention' : 'Action needed now');
  status.append(badge);
  if (stale) status.append(el('p', 'warn', st ? `The hourly alert job last ran ${ago(st.ts)}. Check GitHub → Actions → Monitor.` : 'The hourly alert job has not run yet (it needs the one-time GitHub setup).'));
  for (const a of alerts) status.append(el('p', `alert ${a.level}`, a.text));
  const billing = needsBilling(st);
  const note = billing ? "Using the app's own estimates (exact Google numbers need billing turned on)" : st && st.note;
  if (st && st.ts) status.append(el('p', 'sub', `Alert job last ran ${ago(st.ts)}${note ? ` · ${note}` : ''}`));

  // Usage
  const use = el('div', 'card');
  use.append(el('h2', null, 'Free plan usage'), el('p', 'sub', `Today (resets at midnight Pacific time) · ${u.source}`));
  use.append(
    meter('Database reads', u.reads, FREE.reads, '', 'Opening saved lists and photos.'),
    meter('Database writes', u.writes, FREE.writes, '', 'Saving, settings and usage numbers.'),
    meter('Database deletes', u.deletes, FREE.deletes, ''),
    u.storageMB == null && billing
      ? meter('Storage used', null, FREE.storageMB, 'MB', 'All saved items and photos. Google only shares this number when billing is turned on (Blaze plan).', 'needs billing to show')
      : meter('Storage used', u.storageMB, FREE.storageMB, 'MB', 'All saved items and photos (from Google, updated by the alert job).'),
    meter('Downloads this month', u.egressMB, FREE.egressMB, 'MB', 'Estimated from the app; the tightest free limit when people view many photos.')
  );

  // People
  const people = el('div', 'card');
  people.append(el('h2', null, 'People'));
  const now = Date.now();
  const activeNow = data.users.filter(x => x.seen && now - x.seen < 30 * 60 * 1000).length;
  const memberCount = data.members.filter(m => m.id !== ctx.ownerUid).length + 1;
  const kpis = el('div', 'kpis');
  for (const [v, l] of [[`${memberCount} / ${data.limits.maxMembers}`, 'people with access'], [fmtN(data.activeToday), 'active today'], [fmtN(activeNow), 'active in last 30 min'], [fmtN(data.requests.length), 'waiting for approval']]) {
    const k = el('div'); k.append(el('b', null, v), el('span', null, l)); kpis.append(k);
  }
  people.append(kpis);
  const s = data.stats;
  const errs = [['Failed saves', s.errSave], ['"Free limit reached" errors', s.errQuota], ['Gold-rate source failures', s.errRates], ['Other errors', s.errOther]];
  const errBox = el('dl', 'breakdown');
  for (const [k, v] of errs) { errBox.append(el('dt', null, k), el('dd', v ? 'bad-text' : null, fmtN(v || 0))); }
  people.append(el('h3', null, 'Problems today'), errBox);

  // Requests
  const req = el('div', 'card');
  req.append(el('h2', null, `Access requests (${data.requests.length})`));
  if (!data.requests.length) req.append(el('p', 'sub', 'No one is waiting.'));
  for (const r of [...data.requests].sort((a, b) => (a.ts || 0) - (b.ts || 0))) {
    const row = el('div', 'row-item');
    const who = el('div', 'grow'); who.append(el('b', null, r.name || '(no name)'), el('span', 'sub block', `${r.email || 'no email'} · asked ${ago(r.ts)}`));
    const yes = el('button', 'chip primary', 'Approve'); yes.type = 'button';
    const no = el('button', 'chip', 'Decline'); no.type = 'button';
    yes.addEventListener('click', async () => {
      if (memberCount >= data.limits.maxMembers) { ctx.toast(`The limit is ${data.limits.maxMembers} people. Raise it below or remove someone first.`, 5000); return; }
      yes.disabled = no.disabled = true;
      try { await approve(r); ctx.toast(`${r.name || r.email} approved`); ctx.refresh(); } catch (e) { ctx.toast(`Could not approve (${e.code || e.message})`, 5000); yes.disabled = no.disabled = false; }
    });
    no.addEventListener('click', async () => {
      yes.disabled = no.disabled = true;
      try { await decline(r.id); ctx.toast('Request declined'); ctx.refresh(); } catch (e) { ctx.toast(`Could not decline (${e.code || e.message})`, 5000); yes.disabled = no.disabled = false; }
    });
    row.append(who, yes, no);
    req.append(row);
  }

  // Members
  const mem = el('div', 'card');
  mem.append(el('h2', null, 'Members'));
  const byId = Object.fromEntries(data.users.map(x => [x.id, x]));
  const rows = [{ id: ctx.ownerUid, name: 'You (owner)', email: '' }, ...data.members.filter(m => m.id !== ctx.ownerUid)];
  for (const m of rows) {
    const meta = byId[m.id] || {};
    const row = el('div', 'row-item');
    const who = el('div', 'grow');
    who.append(el('b', null, m.name || m.email || m.id), el('span', 'sub block', `${m.email ? m.email + ' · ' : ''}${meta.count || 0} / ${data.limits.itemLimit} items · seen ${ago(meta.seen)}`));
    row.append(who);
    if (m.id !== ctx.ownerUid) {
      const rm = el('button', 'chip danger', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', async () => {
        if (!confirm(`Remove ${m.name || m.email}? They will lose access straight away.`)) return;
        const purge = confirm(`Also delete ${m.name || m.email}'s saved items and photos to free up storage?\n\nOK = delete their data (within an hour)\nCancel = keep it, in case you add them back`);
        rm.disabled = true;
        try { await remove(m.id, purge); ctx.toast('Removed'); ctx.refresh(); } catch (e) { ctx.toast(`Could not remove (${e.code || e.message})`, 5000); rm.disabled = false; }
      });
      row.append(rm);
    }
    mem.append(row);
  }

  // Limits
  const lim = el('div', 'card');
  lim.append(el('h2', null, 'Limits'), el('p', 'sub', 'Keeps the app inside the free plan. Defaults: 25 people, 100 saved items each.'));
  const grid = el('div', 'grid2');
  const mk = (label, value) => { const l = el('label', null, label); const i = el('input'); i.inputMode = 'numeric'; i.value = String(value); l.append(i); grid.append(l); return i; };
  const maxIn = mk('Max people', data.limits.maxMembers);
  const itemIn = mk('Items per person', data.limits.itemLimit);
  const save = el('button', 'btn primary', 'Save limits'); save.type = 'button';
  save.addEventListener('click', async () => {
    const maxMembers = parseInt(maxIn.value, 10), itemLimit = parseInt(itemIn.value, 10);
    if (!(maxMembers >= 1 && maxMembers <= 500 && itemLimit >= 1 && itemLimit <= 1000)) { ctx.toast('Use whole numbers: people 1–500, items 1–1000.', 5000); return; }
    save.disabled = true;
    try { await saveLimits({ maxMembers, itemLimit }); ctx.toast('Limits saved'); ctx.refresh(); } catch (e) { ctx.toast(`Could not save (${e.code || e.message})`, 5000); save.disabled = false; }
  });
  lim.append(grid, save);

  const refresh = el('button', 'btn', 'Refresh'); refresh.type = 'button';
  refresh.addEventListener('click', ctx.refresh);
  const foot = el('div', 'actions'); foot.append(refresh);
  root.append(status, use, people, req, mem, lim, foot);
}
