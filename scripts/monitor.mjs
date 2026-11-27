// Hourly health check for the Making Charge Calculator (run by .github/workflows/monitor.yml).
// Reads usage (exact numbers from Google Cloud Monitoring when available, otherwise the app's own
// counters), compares it with the Firebase free-plan limits, saves a summary for the owner's
// dashboard, opens/updates/closes GitHub issues as alerts, deletes data of removed members on
// request, and keeps the schedule alive. Uses only Node's built-ins.
import { createSign } from 'node:crypto';

export const FREE = { reads: 50000, writes: 20000, deletes: 20000, storageMB: 1024, egressMB: 10240 };
const env = process.env;

// ---------- time (Firebase free quotas reset at midnight Pacific time) ----------
export const pacificDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);
export function pacificMidnight(day) {
  for (const off of ['-07:00', '-08:00']) {
    const t = new Date(`${day}T00:00:00${off}`);
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(t);
    if (pacificDay(t) === day && hour === '00') return t;
  }
  return new Date(`${day}T08:00:00Z`);
}
const addDay = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- Google auth (service account -> access token) ----------
async function googleToken(sa) {
  if (env.TOKEN_OVERRIDE) return env.TOKEN_OVERRIDE; // tests (emulator)
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/monitoring.read'
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Google sign-in for the monitor failed: ${j.error_description || j.error || r.status}`);
  return j.access_token;
}

// ---------- Firestore REST ----------
function decode(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
function encode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encode) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)])) } };
}

function firestore(project, token) {
  const root = `projects/${project}/databases/(default)/documents`;
  const base = `${env.FIRESTORE_URL || 'https://firestore.googleapis.com/v1'}/${root}`;
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    if (r.status === 404 && method === 'GET') return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Firestore ${method} ${path}: ${r.status} ${j.error ? j.error.message : ''}`);
    return j;
  };
  return {
    async get(path) { const j = await call('GET', `/${path}`); return j ? decode({ mapValue: { fields: j.fields || {} } }) : null; },
    async set(path, data) { await call('PATCH', `/${path}`, { fields: encode(data).mapValue.fields }); },
    async list(path) {
      const out = []; let page = '';
      do {
        const j = await call('GET', `/${path}?pageSize=300${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
        for (const d of (j && j.documents) || []) out.push({ ...decode({ mapValue: { fields: d.fields || {} } }), id: d.name.split('/').pop(), _path: d.name });
        page = j && j.nextPageToken;
      } while (page);
      return out;
    },
    async count(collectionId, where) {
      const structuredQuery = { from: [{ collectionId }] };
      if (where) structuredQuery.where = where;
      const j = await call('POST', ':runAggregationQuery', { structuredAggregationQuery: { structuredQuery, aggregations: [{ alias: 'n', count: {} }] } });
      return decode(j[0].result.aggregateFields.n);
    },
    async remove(names) { // up to 500 per commit
      for (let i = 0; i < names.length; i += 500) {
        await call('POST', ':commit', { writes: names.slice(i, i + 500).map(n => ({ delete: n })) });
      }
    },
    root
  };
}
const fieldIs = (field, op, value) => ({ fieldFilter: { field: { fieldPath: field }, op, value: encode(value) } });

// ---------- Cloud Monitoring (exact usage; optional) ----------
async function monitoring(project, token, day) {
  const base = `${env.MONITORING_URL || 'https://monitoring.googleapis.com/v3'}/projects/${project}/timeSeries`;
  const end = new Date();
  const start = pacificMidnight(day);
  const secs = Math.max(60, Math.ceil((end - start) / 1000));
  const q = async params => {
    const r = await fetch(`${base}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Monitoring ${r.status} ${j.error ? j.error.message : ''}`);
    return j.timeSeries || [];
  };
  const pointValue = p => Number(p.value.int64Value ?? p.value.doubleValue ?? 0);
  const sumSince = async metric => {
    const series = await q({
      filter: `metric.type="firestore.googleapis.com/${metric}"`,
      'interval.startTime': start.toISOString(), 'interval.endTime': end.toISOString(),
      'aggregation.alignmentPeriod': `${secs}s`, 'aggregation.perSeriesAligner': 'ALIGN_SUM', 'aggregation.crossSeriesReducer': 'REDUCE_SUM'
    });
    return series.reduce((n, s) => n + (s.points || []).reduce((a, p) => a + pointValue(p), 0), 0);
  };
  const [reads, writes, deletes, storage] = await Promise.all([
    sumSince('document/read_count'), sumSince('document/write_count'), sumSince('document/delete_count'),
    q({
      filter: 'metric.type="firestore.googleapis.com/storage/data_and_index_storage_bytes"',
      'interval.startTime': new Date(Date.now() - 26 * 3600 * 1000).toISOString(), 'interval.endTime': end.toISOString()
    }).then(series => series.reduce((n, s) => n + (s.points && s.points[0] ? pointValue(s.points[0]) : 0), 0)).catch(() => null)
  ]);
  return { reads, writes, deletes, storageMB: storage == null ? null : storage / 1048576 };
}

// ---------- alert rules ----------
const pct = (v, lim) => (lim ? (v / lim) * 100 : 0);
const lvl = p => (p >= 90 ? 'crit' : p >= 70 ? 'warn' : null);
const n = v => Math.round(v).toLocaleString('en-US');

export function evaluate(u) {
  const alerts = [];
  const add = (key, level, text) => level && alerts.push({ key, level, text });
  for (const [key, label] of [['reads', 'Database reads'], ['writes', 'Database writes'], ['deletes', 'Database deletes']]) {
    const p = pct(u[key], FREE[key]);
    add(key, lvl(p), `${label} today: ${n(u[key])} of ${n(FREE[key])} free (${p.toFixed(0)}%). Resets at midnight Pacific time; if it runs out, saved items stop loading until then.`);
  }
  if (u.storageMB != null) {
    const p = pct(u.storageMB, FREE.storageMB);
    add('storage', lvl(p), `Storage: ${u.storageMB.toFixed(0)} MB of ${FREE.storageMB} MB free (${p.toFixed(0)}%). Remove inactive members' data or lower the item limit.`);
  }
  const p = pct(u.egressMonthMB, FREE.egressMB);
  const proj = u.dayOfMonth ? (u.egressMonthMB / u.dayOfMonth) * u.daysInMonth : 0;
  add('egress', lvl(p) || (proj > FREE.egressMB ? 'warn' : null),
    `Downloads this month: about ${n(u.egressMonthMB)} MB of ${n(FREE.egressMB)} MB free (${p.toFixed(0)}%), on track for ${n(proj)} MB by month end.`);
  if (u.maxMembers && u.members >= Math.ceil(u.maxMembers * 0.9)) {
    add('members', 'warn', `${u.members} of ${u.maxMembers} member places are used. Raise the limit in Admin or remove inactive people.`);
  }
  if (u.pending > 0) add('requests', 'info', `${u.pending} ${u.pending === 1 ? 'person is' : 'people are'} waiting for approval: ${u.pendingNames.join(', ')}. Approve or decline them in the app's Admin tab.`);
  if (u.errQuota > 0) add('quota', 'crit', `The free daily limit was hit ${u.errQuota} time(s) today: saved items stop loading or saving until midnight Pacific time.`);
  if (u.errSave >= 5) add('saves', 'warn', `${u.errSave} saves failed today.`);
  if (u.errRates >= 20) add('rates', 'warn', `The gold-rate sources failed ${u.errRates} times today; people may need to type rates by hand.`);
  if (u.errOther >= 20) add('errors', 'warn', `${u.errOther} other app errors today.`);
  if (u.activeNow >= 15) add('busy', 'info', `${u.activeNow} people were active in the last 30 minutes. Watch today's reads.`);
  if (u.atLimit > 0) add('itemcap', 'info', `${u.atLimit} ${u.atLimit === 1 ? 'person has' : 'people have'} reached the saved-item limit (${u.itemLimit}).`);
  return alerts;
}

// ---------- GitHub issues as alerts (phone notification + email) ----------
function github() {
  const base = env.GITHUB_API || 'https://api.github.com';
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      body: body && JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`GitHub ${method} ${path}: ${r.status} ${j.message || ''}`);
    return j;
  };
  return call;
}
const ORDER = { info: 1, warn: 2, crit: 3 };
const TITLE = { info: 'Info', warn: 'Warning', crit: 'Urgent' };
const marker = key => `<!-- app-alert:${key} -->`;

export async function syncIssues(alerts, extra = {}) {
  const gh = github();
  const repo = env.REPO;
  const owner = env.OWNER_LOGIN;
  const open = await gh('GET', `/repos/${repo}/issues?state=open&labels=app-alert&per_page=100`);
  const byKey = {};
  for (const i of open) { const m = /<!-- app-alert:([\w-]+) -->/.exec(i.body || ''); if (m) byKey[m[1]] = i; }
  const body = a => `${marker(a.key)}\n<!-- level:${a.level} -->\n**${TITLE[a.level]}:** ${a.text}\n\n${owner ? `@${owner} ` : ''}This issue was opened by the hourly monitor and closes by itself when the problem clears. Details: open the app → Admin.\n\n---\n_Generated by the app's monitor (GitHub Actions)_`;
  const actions = [];
  for (const a of alerts) {
    const ex = byKey[a.key];
    if (!ex) {
      await gh('POST', `/repos/${repo}/issues`, { title: `${TITLE[a.level]}: ${a.text.split(':')[0]}`, body: body(a), labels: ['app-alert'] });
      actions.push(`opened ${a.key}`);
      continue;
    }
    const prev = (/<!-- level:(\w+) -->/.exec(ex.body || '') || [])[1] || 'info';
    if (ORDER[a.level] > ORDER[prev]) {
      await gh('POST', `/repos/${repo}/issues/${ex.number}/comments`, { body: `Now **${TITLE[a.level]}**: ${a.text}${owner ? `\n\n@${owner}` : ''}\n\n---\n_Generated by the app's monitor_` });
      await gh('PATCH', `/repos/${repo}/issues/${ex.number}`, { title: `${TITLE[a.level]}: ${a.text.split(':')[0]}`, body: body(a) });
      actions.push(`escalated ${a.key}`);
    } else if (ex.body !== body(a)) {
      await gh('PATCH', `/repos/${repo}/issues/${ex.number}`, { body: body(a) });
    }
  }
  const active = new Set(alerts.map(a => a.key));
  for (const [key, ex] of Object.entries(byKey)) {
    if (active.has(key) || (extra.keep && extra.keep.includes(key))) continue;
    await gh('POST', `/repos/${repo}/issues/${ex.number}/comments`, { body: 'Resolved: this is back to normal.\n\n---\n_Generated by the app\'s monitor_' });
    await gh('PATCH', `/repos/${repo}/issues/${ex.number}`, { state: 'closed', state_reason: 'completed' });
    actions.push(`closed ${key}`);
  }
  return actions;
}

// Scheduled workflows stop after 60 days without repository activity: commit a tiny file when needed.
async function heartbeat() {
  const gh = github();
  const repo = env.REPO;
  const [last] = await gh('GET', `/repos/${repo}/commits?per_page=1`);
  const age = (Date.now() - Date.parse(last.commit.committer.date)) / 86400000;
  if (age < 40) return null;
  const path = '.github/monitor-heartbeat.txt';
  let sha;
  try { sha = (await gh('GET', `/repos/${repo}/contents/${path}`)).sha; } catch { /* first time */ }
  await gh('PUT', `/repos/${repo}/contents/${path}`, {
    message: 'Keep the hourly monitor schedule active', sha,
    content: Buffer.from(`Last heartbeat: ${new Date().toISOString()}\n`).toString('base64')
  });
  return 'heartbeat committed';
}

// ---------- main ----------
export async function run() {
  const config = await import(new URL('../docs/config.js', import.meta.url));
  const project = env.PROJECT_ID || config.FIREBASE.projectId;
  if (!project || !(env.SA || env.TOKEN_OVERRIDE)) {
    console.log('Monitor is not set up yet (needs docs/config.js and the FIREBASE_SERVICE_ACCOUNT secret). Skipping.');
    return { skipped: true };
  }
  const token = await googleToken(env.SA ? JSON.parse(env.SA) : null);
  const db = firestore(project, token);
  const day = pacificDay();
  const yesterday = addDay(day, -1);
  const month = day.slice(0, 7);
  const now = Date.now();

  // Delete the data of removed members when the owner asked for it.
  const purged = [];
  for (const p of await db.list('purge')) {
    const items = await db.list(`users/${p.id}/items`);
    const photos = await db.list(`users/${p.id}/photos`);
    await db.remove([...items, ...photos].map(d => d._path).concat([`${db.root}/users/${p.id}`, `${db.root}/purge/${p.id}`]));
    purged.push(p.id);
  }

  const [prev, cfg, statsToday, statsYesterday, members, pendingList, activeToday, activeNow] = await Promise.all([
    db.get('monitor/status'), db.get('config/app'), db.get(`stats/${day}`), db.get(`stats/${yesterday}`),
    db.count('members'), db.list('requests'), db.count('active', fieldIs('d', 'EQUAL', day)),
    db.count('users', fieldIs('seen', 'GREATER_THAN', now - 30 * 60 * 1000))
  ]);
  const limits = { itemLimit: 100, maxMembers: 25, ...(cfg || {}) };
  const atLimit = await db.count('users', fieldIs('count', 'GREATER_THAN_OR_EQUAL', limits.itemLimit));
  const st = statsToday || {};

  // Downloads this month: the app reports them per day; keep a running list for the month.
  const kb = prev && prev.monthKB && prev.monthKB.month === month ? { ...prev.monthKB.days } : {};
  kb[day] = (statsToday && statsToday.kb) || 0;
  if (yesterday.startsWith(month)) kb[yesterday] = (statsYesterday && statsYesterday.kb) || kb[yesterday] || 0;
  const egressMonthMB = Object.values(kb).reduce((a, b) => a + b, 0) / 1024;

  let google = null, note = '';
  try { google = await monitoring(project, token, day); } catch (e) { note = `exact Google numbers unavailable (${String(e.message).slice(0, 120)}); using the app's estimates`; }

  const dim = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).getUTCDate();
  const u = {
    day, source: google ? 'google' : 'app',
    reads: google ? google.reads : st.reads || 0,
    writes: google ? google.writes : st.writes || 0,
    deletes: google ? google.deletes : st.deletes || 0,
    storageMB: google ? google.storageMB : null,
    egressMonthMB, dayOfMonth: +day.slice(8, 10), daysInMonth: dim,
    members: members + 1, maxMembers: limits.maxMembers, itemLimit: limits.itemLimit, atLimit,
    pending: pendingList.length, pendingNames: pendingList.map(r => r.name || r.email || 'someone').slice(0, 10),
    activeToday, activeNow,
    errQuota: st.errQuota || 0, errSave: st.errSave || 0, errRates: st.errRates || 0, errOther: st.errOther || 0
  };
  const alerts = evaluate(u);

  let actions = [];
  if (env.GITHUB_TOKEN && env.REPO) {
    actions = await syncIssues(alerts);
    const hb = await heartbeat().catch(e => `heartbeat failed: ${e.message}`);
    if (hb) actions.push(hb);
  }

  const { pendingNames, dayOfMonth, daysInMonth, ...usage } = u;
  await db.set('monitor/status', {
    ts: Date.now(), ok: !alerts.some(a => a.level !== 'info'), note, usage,
    alerts: alerts.map(({ key, level, text }) => ({ key, level, text })),
    monthKB: { month, days: kb }
  });
  console.log(JSON.stringify({ usage, note, alerts: alerts.map(a => `${a.level}:${a.key}`), purged, actions }, null, 1));
  return { usage, alerts, purged, actions };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  run().catch(async e => {
    console.error('Monitor failed:', e.message);
    // Tell the owner the monitor itself is broken (then fail the run).
    if (env.GITHUB_TOKEN && env.REPO) {
      await syncIssues([{ key: 'monitor', level: 'warn', text: `The hourly monitor could not run: ${String(e.message).slice(0, 300)}` }], { keep: ['reads', 'writes', 'deletes', 'storage', 'egress', 'members', 'requests', 'quota', 'saves', 'rates', 'errors', 'busy', 'itemcap'] }).catch(() => {});
    }
    process.exit(1);
  });
}
