// Monitor job against the Firestore emulator, with fake Cloud Monitoring and GitHub servers.
// Run with: npm run test:monitor
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const FS = 'http://127.0.0.1:8080/v1/projects/demo-mc/databases/(default)/documents';
const H = { authorization: 'Bearer owner', 'content-type': 'application/json' };
const enc = v => (typeof v === 'string' ? { stringValue: v } : Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v });
const put = (path, data) => fetch(`${FS}/${path}`, { method: 'PATCH', headers: H, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)])) }) });
const get = async path => { const r = await fetch(`${FS}/${path}`, { headers: H }); return r.status === 404 ? null : r.json(); };

let mon, gh;
const ghIssues = [];
let googleReads = 46000;
before(async () => {
  await fetch('http://127.0.0.1:8080/emulator/v1/projects/demo-mc/databases/(default)/documents', { method: 'DELETE' });
  mon = http.createServer((req, res) => {
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
  await new Promise(r => setTimeout(r, 100));
  Object.assign(process.env, {
    PROJECT_ID: 'demo-mc', TOKEN_OVERRIDE: 'owner', FIRESTORE_URL: 'http://127.0.0.1:8080/v1',
    MONITORING_URL: `http://127.0.0.1:${mon.address().port}/v3`, GITHUB_API: `http://127.0.0.1:${gh.address().port}`,
    GITHUB_TOKEN: 't', REPO: 'o/r', OWNER_LOGIN: 'owner'
  });
});
after(() => { mon.close(); gh.close(); });

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

  // Next hour: reads back to normal, request handled -> those issues close; Google API down -> app estimates.
  googleReads = 100;
  await fetch(`${FS}/requests/r1`, { method: 'DELETE', headers: H });
  const out2 = await run();
  assert.deepEqual(out2.alerts.map(a => a.key).sort(), ['itemcap', 'quota']);
  assert.equal(ghIssues.filter(i => i.state === 'open').length, 2);

  process.env.MONITORING_URL = 'http://127.0.0.1:1/v3';
  const out3 = await run();
  assert.equal(out3.usage.source, 'app');
  assert.equal(out3.usage.reads, 100);
  const s3 = await get('monitor/status');
  assert.match(s3.fields.note.stringValue, /using the app's estimates/);
});

test('skips quietly when not set up', async () => {
  const saved = { ...process.env };
  delete process.env.TOKEN_OVERRIDE; delete process.env.SA; delete process.env.PROJECT_ID;
  const { run } = await import('../scripts/monitor.mjs');
  assert.deepEqual(await run(), { skipped: true });
  Object.assign(process.env, saved);
});
