// Monitor job against the Firestore emulator, with fake Cloud Monitoring, GitHub, ntfy, healthchecks.io
// and domain-registration servers, and a local HTTPS address for the certificate check.
// Run with: npm run test:monitor
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeCert, tlsServer } from './tls.mjs';

const FS = 'http://127.0.0.1:8080/v1/projects/demo-mc/databases/(default)/documents';
const H = { authorization: 'Bearer owner', 'content-type': 'application/json' };
const enc = v => (typeof v === 'string' ? { stringValue: v } : Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v });
const put = (path, data) => fetch(`${FS}/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) }) });
const get = async path => { const r = await fetch(`${FS}/${path}`, { headers: H }); return r.status === 404 ? null : r.json(); };

let mon, gh, ext, site;
const ghIssues = [];
const pushes = [];
const pings = [];
let domainExpires = Date.now() + 400 * 864e5;
const cert = makeCert(90);
let googleReads = 46000;
let googleBilling = false;
before(async () => {
  await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-mc/databases/(default)/documents', { method: 'DELETE' });
  mon = http.createServer((req, res) => {
    if (googleBilling) { res.statusCode = 403; return res.end(JSON.stringify({ error: { code: 403, message: 'This API method requires billing to be enabled. Please enable billing on project #1 by visiting https://console.developers.google.com/billing/enable?project=1 then retry.' } })); }
    const u = new URL(req.url, 'http://x');
    const f = u.searchParams.get('filter');
    const v = f.includes('read_count') ? googleReads : f.includes('write_count') ? 1200 : f.includes('delete_count') ? 30 : 5 * 1048576;
    res.end(JSON.stringify({ timeSeries: [{ points: [{ value: { int64Value: String(v) } }] }] }));
  }).listen(0);
  gh = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      const body = b ? JSON.parse(b) : null;
      if (req.method === 'GET' && req.url.startsWith('/repos/o/r/issues')) return res.end(JSON.stringify(ghIssues.filter(i => i.state === 'open')));
      if (req.method === 'GET' && req.url.startsWith('/repos/o/r/commits')) return res.end(JSON.stringify([{ commit: { committer: { date: new Date().toISOString() } } }]));
      if (req.method === 'POST' && req.url === '/repos/o/r/issues') { ghIssues.push({ number: ghIssues.length + 1, state: 'open', ...body }); return res.end('{}'); }
      const m = /issues\/(\d+)$/.exec(req.url);
      if (req.method === 'PATCH' && m) Object.assign(ghIssues[+m[1] - 1], body);
      res.end('{}');
    });
  }).listen(0);
  ext = http.createServer((req, res) => {
    let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
      if (req.url.startsWith('/rdap/domain/')) return res.end(JSON.stringify({ events: [{ eventAction: 'expiration', eventDate: new Date(domainExpires).toISOString() }] }));
      if (req.url.startsWith('/ntfy/')) pushes.push({ topic: req.url.slice(6), title: req.headers.title, priority: req.headers.priority, body: b });
      if (req.url.startsWith('/hc/')) pings.push({ path: req.url, body: b });
      res.end('{}');
    });
  }).listen(0);
  site = await tlsServer(cert);
  await new Promise(r => setTimeout(r, 100));
  const extUrl = `http://127.0.0.1:${ext.address().port}`;
  Object.assign(process.env, {
    NTFY_SERVER: `${extUrl}/ntfy`, NTFY_TOPIC: 'secret-topic', HEALTHCHECK_URL: `${extUrl}/hc/check-1`, RDAP_URL: `${extUrl}/rdap`,
    CHECK_HOST: 'localhost', CHECK_PORT: String(site.address().port), CHECK_CA: cert.cert, CHECK_DOMAIN: 'example.com', CHECK_RETRY_MS: '10',
    PROJECT_ID: 'demo-mc', TOKEN_OVERRIDE: 'owner', FIRESTORE_URL: 'http://127.0.0.1:8080/v1',
    MONITORING_URL: `http://127.0.0.1:${mon.address().port}/v3`, GITHUB_API: `http://127.0.0.1:${gh.address().port}`,
    GITHUB_TOKEN: 't', REPO: 'o/r', OWNER_LOGIN: 'owner'
  });
});
after(() => { mon.close(); gh.close(); ext.close(); site.close(); });

test('hourly run: usage summary, alerts as issues, purge of removed members', async () => {
  const { pacificDay, run } = await import('../scripts/monitor.mjs');
  const day = pacificDay();
  await put('config/app', { itemLimit: 2, maxMembers: 25 });
  await put('members/a', { name: 'Asha', email: 'a@x.com', ts: 1 });
  await put('requests/r1', { name: 'Ravi', email: 'r@x.com', ts: 1 });
  await put('users/a', { count: 2, seen: Date.now() });
  await put(`stats/${day}`, { reads: 100, kb: 2048, errQuota: 1 });
  await put(`active/${day}_a`, { d: day, u: 'a' });
  await put('purge/gone', { ts: 1 });
  await put('users/gone', { count: 2 });
  await put('users/gone/items/i1', { name: 'x' });
  await put('users/gone/items/i2', { name: 'y' });
  await put('users/gone/photos/i1', { d: 'data:image/webp;base64,AAAA' });

  const out = await run();
  assert.equal(out.usage.source, 'google');
  assert.equal(out.usage.reads, 46000);
  assert.equal(out.usage.members, 2); // Asha + owner
  assert.equal(out.usage.pending, 1);
  assert.equal(out.usage.activeToday, 1);
  assert.equal(out.usage.activeNow, 1);
  assert.equal(out.usage.atLimit, 1);
  assert.equal(out.usage.egressMonthMB, 2);
  assert.ok(Math.abs(out.usage.storageMB - 5) < 1e-9);
  assert.deepEqual(out.alerts.map(a => `${a.level}:${a.key}`).sort(), ['crit:quota', 'crit:reads', 'info:itemcap', 'info:requests']);
  assert.deepEqual(out.purged, ['gone']);
  assert.equal(await get('users/gone/items/i1'), null);
  assert.equal(await get('users/gone/photos/i1'), null);
  assert.equal(await get('users/gone'), null);
  assert.equal(await get('purge/gone'), null);
  assert.ok(await get('users/a'), 'other people untouched');

  const status = await get('monitor/status');
  assert.equal(status.fields.usage.mapValue.fields.reads.integerValue, '46000');
  assert.equal(status.fields.alerts.arrayValue.values.length, 4);
  assert.equal(ghIssues.filter(i => i.state === 'open').length, 4);
  assert.ok(!JSON.stringify(ghIssues).includes('Ravi'), 'no names in public issues');

  // Address checks ran and were saved; nothing to report while far from expiry.
  assert.ok(out.usage.site.certDays > 89 && out.usage.site.certDays <= 90);
  assert.ok(out.usage.site.domainDays > 399);
  // One phone push for the four new alerts, at the urgency of the worst; one success ping.
  assert.equal(pushes.length, 1);
  assert.deepEqual([pushes[0].topic, pushes[0].title, pushes[0].priority], ['secret-topic', 'MCC: 4 updates', '5']);
  assert.ok(!pushes[0].body.includes('Ravi'));
  assert.deepEqual(pings.map(p => p.path), ['/hc/check-1']);

  // Next hour: reads back to normal, request handled -> those issues close; Google API down -> app estimates.
  googleReads = 100;
  await fetch(`${FS}/requests/r1`, { method: 'DELETE', headers: H });
  const out2 = await run();
  assert.deepEqual(out2.alerts.map(a => a.key).sort(), ['itemcap', 'quota']);
  assert.equal(ghIssues.filter(i => i.state === 'open').length, 2);
  // Reads back to normal is news; a handled access request is not.
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].title, 'MCC back to normal: Database reads today');

  process.env.MONITORING_URL = 'http://127.0.0.1:1/v3';
  const out3 = await run();
  assert.equal(out3.usage.source, 'app');
  assert.equal(out3.usage.reads, 100);
  const s3 = await get('monitor/status');
  assert.match(s3.fields.note.stringValue, /using the app's estimates/);
  assert.equal(s3.fields.google.stringValue, 'error');

  // Free Spark plan: Google refuses for lack of billing -> app estimates, plain note, no alert about it.
  process.env.MONITORING_URL = `http://127.0.0.1:${mon.address().port}/v3`;
  googleBilling = true;
  const out4 = await run();
  assert.equal(out4.usage.source, 'app');
  assert.equal(out4.usage.storageMB, null);
  assert.deepEqual(out4.alerts.map(a => a.key).sort(), ['itemcap', 'quota']);
  const s4 = await get('monitor/status');
  assert.equal(s4.fields.google.stringValue, 'needs-billing');
  assert.equal(s4.fields.note.stringValue, "Using the app's own estimates (exact Google numbers need billing turned on)");

  googleBilling = false;
  await run();
  const s5 = await get('monitor/status');
  assert.equal(s5.fields.google.stringValue, 'ok');
  assert.equal(s5.fields.note.stringValue, '');
  assert.equal(pushes.length, 2, 'unchanged alerts stay quiet for hours');
  assert.equal(pings.length, 5, 'a ping every run');
});

test('domain about to lapse: alert, push and issue; GitHub failing does not silence the push', async () => {
  const { run } = await import('../scripts/monitor.mjs');
  domainExpires = Date.now() + 20.5 * 864e5;
  const ghApi = process.env.GITHUB_API;
  process.env.GITHUB_API = 'http://127.0.0.1:1';
  try {
    const before = pushes.length;
    const out = await run();
    assert.ok(out.alerts.some(a => a.key === 'domain' && a.level === 'warn'));
    assert.ok(out.actions.some(a => a.startsWith('GitHub issues failed')));
    assert.equal(pushes.length, before + 1);
    assert.equal(pushes.at(-1).title, 'MCC Warning: Domain expiring');
    assert.match(pushes.at(-1).body, /example\.com expires in 20 days/);
  } finally {
    process.env.GITHUB_API = ghApi;
    domainExpires = Date.now() + 400 * 864e5;
  }
});

test('monitor that cannot run: fail ping and a GitHub issue, then a failed job', async () => {
  const before = pings.length;
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/monitor.mjs'], { env: { ...process.env, FIRESTORE_URL: 'http://127.0.0.1:1/v1' }, stdio: 'ignore' });
    child.on('exit', resolve);
  });
  assert.equal(code, 1);
  assert.deepEqual(pings.slice(before).map(p => p.path), ['/hc/check-1/fail']);
  assert.match(pings.at(-1).body, /^The hourly monitor could not run: /);
  assert.ok(ghIssues.some(i => i.state === 'open' && /app-alert:monitor/.test(i.body)));
});

test('skips quietly when not set up', async () => {
  const saved = { ...process.env };
  delete process.env.TOKEN_OVERRIDE; delete process.env.SA; delete process.env.PROJECT_ID;
  const { run } = await import('../scripts/monitor.mjs');
  assert.deepEqual(await run(), { skipped: true });
  Object.assign(process.env, saved);
});
