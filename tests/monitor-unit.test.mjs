import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, pacificMidnight, pacificDay, syncIssues, googleProblem, FREE, scrub, changes, pushMessage, push, ping,
  registeredDomain, certCheck, domainExpiry } from '../scripts/monitor.mjs';
import { makeCert, tlsServer } from './tls.mjs';

const base = {
  reads: 0, writes: 0, deletes: 0, storageMB: 10, egressMonthMB: 10, dayOfMonth: 10, daysInMonth: 30,
  members: 3, maxMembers: 25, itemLimit: 100, atLimit: 0, pending: 0, activeToday: 2, activeNow: 1,
  errQuota: 0, errSave: 0, errRates: 0, errOther: 0
};
const keys = u => evaluate({ ...base, ...u }).map(a => `${a.level}:${a.key}`);

test('quiet day raises nothing', () => assert.deepEqual(keys({}), []));

test('free-limit thresholds: 70% warning, 90% urgent', () => {
  assert.deepEqual(keys({ reads: FREE.reads * 0.69 }), []);
  assert.deepEqual(keys({ reads: FREE.reads * 0.7 }), ['warn:reads']);
  assert.deepEqual(keys({ reads: FREE.reads * 0.9 }), ['crit:reads']);
  assert.deepEqual(keys({ writes: 15000, deletes: 19000 }), ['warn:writes', 'crit:deletes']);
  assert.deepEqual(keys({ storageMB: 800 }), ['warn:storage']);
  assert.deepEqual(keys({ storageMB: null }), []);
});

test('downloads: warns on pace before the limit is reached', () => {
  assert.deepEqual(keys({ egressMonthMB: 4000, dayOfMonth: 10, daysInMonth: 30 }), ['warn:egress']); // on pace for 12 GB
  assert.deepEqual(keys({ egressMonthMB: 2000, dayOfMonth: 10, daysInMonth: 30 }), []);
  assert.deepEqual(keys({ egressMonthMB: 9500, dayOfMonth: 29, daysInMonth: 30 }), ['crit:egress']);
});

test('people, requests and error alerts', () => {
  assert.deepEqual(keys({ members: 23 }), ['warn:members']);
  assert.deepEqual(keys({ pending: 2 }), ['info:requests']);
  assert.match(evaluate({ ...base, pending: 2 })[0].text, /^2 people are waiting for approval\. Approve/);
  assert.deepEqual(keys({ errQuota: 1 }), ['crit:quota']);
  assert.deepEqual(keys({ errSave: 5, errRates: 20, errOther: 20 }), ['warn:saves', 'warn:rates', 'warn:errors']);
  assert.deepEqual(keys({ activeNow: 15, atLimit: 1 }), ['info:busy', 'info:itemcap']);
});

test('Pacific midnight is correct in summer and winter', () => {
  assert.equal(pacificMidnight('2026-07-01').toISOString(), '2026-07-01T07:00:00.000Z');
  assert.equal(pacificMidnight('2026-12-01').toISOString(), '2026-12-01T08:00:00.000Z');
  assert.equal(pacificMidnight('2026-03-08').toISOString(), '2026-03-08T08:00:00.000Z'); // DST starts later that day
  assert.equal(pacificMidnight('2026-11-01').toISOString(), '2026-11-01T07:00:00.000Z'); // DST ends later that day
  assert.equal(pacificDay(new Date('2026-11-27T07:59:00Z')), '2026-11-26');
  assert.equal(pacificDay(new Date('2026-11-27T08:00:00Z')), '2026-11-27');
});

test('GitHub issues: open, keep quiet, escalate, close', async () => {
  const calls = [];
  let issues = [];
  let num = 1;
  process.env.REPO = 'o/r'; process.env.OWNER_LOGIN = 'owner'; process.env.GITHUB_TOKEN = 't'; process.env.GITHUB_API = 'https://gh.test';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const path = String(url).replace('https://gh.test', '');
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push(`${opts.method} ${path.split('?')[0]}`);
    if (opts.method === 'GET') return new Response(JSON.stringify(issues.filter(i => i.state === 'open')));
    if (opts.method === 'POST' && path.endsWith('/issues')) { const i = { number: num++, state: 'open', ...body }; issues.push(i); return new Response(JSON.stringify(i)); }
    const m = /issues\/(\d+)/.exec(path); const i = issues.find(x => x.number === +m[1]);
    if (opts.method === 'PATCH') Object.assign(i, body);
    return new Response('{}');
  };
  try {
    await syncIssues([{ key: 'reads', level: 'warn', text: 'Database reads today: 36,000' }]);
    assert.equal(issues.length, 1);
    assert.match(issues[0].body, /@owner/);
    assert.deepEqual(issues[0].labels, ['app-alert']);
    calls.length = 0;
    await syncIssues([{ key: 'reads', level: 'warn', text: 'Database reads today: 36,000' }]);
    assert.deepEqual(calls, ['GET /repos/o/r/issues'], 'unchanged alert makes no noise');
    await syncIssues([{ key: 'reads', level: 'warn', text: 'Database reads today: 37,000' }]);
    assert.ok(!calls.some(c => c.includes('comments')), 'number change updates silently');
    calls.length = 0;
    await syncIssues([{ key: 'reads', level: 'crit', text: 'Database reads today: 46,000' }]);
    assert.ok(calls.includes('POST /repos/o/r/issues/1/comments'), 'escalation notifies');
    assert.match(issues[0].title, /^Urgent/);
    await syncIssues([]);
    assert.equal(issues[0].state, 'closed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Google refusing for lack of billing gets a plain note; other failures keep their detail', () => {
  const billing = googleProblem('Monitoring 403 This API method requires billing to be enabled. Please enable billing on project #1 by visiting https://console.developers.google.com/billing/enable?project=1 then retry.');
  assert.equal(billing.state, 'needs-billing');
  assert.equal(billing.note, "Using the app's own estimates (exact Google numbers need billing turned on)");
  const other = googleProblem('Monitoring 403 Permission monitoring.timeSeries.list denied');
  assert.equal(other.state, 'error');
  assert.match(other.note, /Permission monitoring\.timeSeries\.list denied.*using the app's estimates/);
  assert.equal(googleProblem(undefined).state, 'error');
});

// Fake fetch that records each request and answers with the given status.
// Sets environment keys for one test and puts the old values back (the monitor keeps a reference to process.env).
function withEnv(vars) {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  const apply = v => { for (const [k, x] of Object.entries(v)) { if (x === undefined) delete process.env[k]; else process.env[k] = x; } };
  apply(vars);
  return () => apply(old);
}

function fakeFetch(status = 200, json = {}) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => { seen.push({ url: String(url), ...opts }); return new Response(JSON.stringify(json), { status }); };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

test('public repo: names, emails and user IDs are scrubbed from logs and alerts', () => {
  assert.equal(scrub('Firestore GET /users/YDY4s5ADEHayvyCzu9fRrefLJ4A2/items: 403'), 'Firestore GET /users/*/items: 403');
  assert.equal(scrub('members/abc requests/def purge/ghi active/2026-11-27_xyz'), 'members/* requests/* purge/* active/*');
  assert.equal(scrub('sent to asha.k+1@mail.example.co.in today'), 'sent to [email] today');
  assert.equal(scrub(undefined), '');
  assert.ok(!JSON.stringify(evaluate({ ...base, pending: 1 })).includes('@'));
});

test('address checks: certificate, domain and reachability alerts', () => {
  const now = Date.parse('2026-11-27T00:00:00Z');
  const site = x => ({ host: 'mcc.example.com', domain: 'example.com', ...x });
  const d = n => ({ certDays: n, certExpires: now + n * 864e5 });
  const dom = n => ({ domainDays: n, domainExpires: now + n * 864e5 });
  assert.deepEqual(keys({ site: site({ ...d(60), ...dom(200) }) }), []);
  assert.deepEqual(keys({ site: site(d(14)) }), ['warn:cert']);
  assert.deepEqual(keys({ site: site(d(5)) }), ['crit:cert']);
  assert.deepEqual(keys({ site: site(dom(30)) }), ['warn:domain']);
  assert.deepEqual(keys({ site: site(dom(7)) }), ['crit:domain']);
  assert.match(evaluate({ ...base, site: site(dom(20.6)) })[0].text, /^Domain expiring: example\.com expires in 20 days \(2026-12-17\)\. Renew it at GoDaddy/);
  assert.deepEqual(keys({ site: site({ certError: 'CERT_HAS_EXPIRED', ...dom(300) }) }), ['crit:cert']);
  assert.deepEqual(keys({ site: site({ unreachable: 'ECONNREFUSED' }) }), ['warn:site']);
  assert.deepEqual(keys({ site: null }), []);
  assert.deepEqual(keys({ site: site({ domainNote: 'registration lookup answered 503' }) }), [], 'a failed lookup is not an alert');
});

test('registered domain behind the app address', () => {
  assert.equal(registeredDomain('mcc.tarveengujral.com'), 'tarveengujral.com');
  assert.equal(registeredDomain('tarveengujral.com'), 'tarveengujral.com');
  assert.equal(registeredDomain('making-charge.web.app'), null);
  assert.equal(registeredDomain('making-charge.firebaseapp.com'), null);
  assert.equal(registeredDomain('kratoskumar.github.io'), null);
});

test('certificate check: reads expiry, spots untrusted certificates and silent addresses', async () => {
  const c = makeCert(10);
  const server = await tlsServer(c);
  const port = server.address().port;
  try {
    const ok = await certCheck('localhost', { port, ca: c.cert });
    assert.equal(ok.authorized, true);
    const days = (ok.expires - Date.now()) / 864e5;
    assert.ok(days > 9 && days <= 10, `about 10 days left, got ${days}`);
    const untrusted = await certCheck('localhost', { port });
    assert.equal(untrusted.authorized, false);
    assert.match(untrusted.error, /SELF_SIGNED/);
  } finally {
    server.close();
  }
  const gone = await certCheck('localhost', { port, timeout: 2000 });
  assert.ok(gone.unreachable);
});

test('domain expiry comes from the public registration lookup', async () => {
  const f = fakeFetch(200, { events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-03-01T10:00:00Z' }] });
  try {
    assert.equal(await domainExpiry('example.com'), Date.parse('2027-03-01T10:00:00Z'));
    assert.equal(f.seen[0].url, 'https://rdap.org/domain/example.com');
  } finally { f.restore(); }
  const bad = fakeFetch(404);
  try { await assert.rejects(domainExpiry('example.com'), /answered 404/); } finally { bad.restore(); }
});

test('phone push only on change: new, worse, and cleared warnings', () => {
  const r = { key: 'reads', level: 'warn', text: 'Database reads today: 36,000' };
  const q = { key: 'requests', level: 'info', text: '1 person is waiting for approval.' };
  assert.deepEqual(changes(null, [r]).map(c => `${c.kind}:${c.key}`), ['new:reads']);
  assert.deepEqual(changes([r], [{ ...r, text: 'Database reads today: 37,000' }]), [], 'same level stays quiet');
  assert.deepEqual(changes([r], [{ ...r, level: 'crit' }]).map(c => `${c.kind}:${c.key}`), ['worse:reads']);
  assert.deepEqual(changes([{ ...r, level: 'crit' }], [r]), [], 'getting better is not news until it clears');
  assert.deepEqual(changes([r, q], []).map(c => `${c.kind}:${c.key}`), ['resolved:reads'], 'cleared info alerts stay quiet');
});

test('push message: priority, title and wording', () => {
  const one = pushMessage([{ kind: 'new', key: 'reads', level: 'crit', text: 'Database reads today: 46,000 of 50,000' }], 'https://app.test/#admin');
  assert.deepEqual(one, { title: 'MCC Urgent: Database reads today', priority: 5, tags: 'rotating_light', body: 'Urgent: Database reads today: 46,000 of 50,000', click: 'https://app.test/#admin' });
  const many = pushMessage([
    { kind: 'worse', key: 'reads', level: 'warn', text: 'Database reads today: 36,000' },
    { kind: 'resolved', key: 'quota', level: 'crit', text: 'The free daily limit was hit 1 time(s) today' },
    { kind: 'new', key: 'site', level: 'warn', text: 'App unreachable: mcc.x did not answer → check' }
  ]);
  assert.equal(many.title, 'MCC: 3 updates');
  assert.equal(many.priority, 4);
  assert.match(many.body, /^Now Warning: Database reads today: 36,000\n\nBack to normal: The free daily limit was hit 1 time\(s\) today\.\n\nWarning: App unreachable/);
  const back = pushMessage([{ kind: 'resolved', key: 'reads', level: 'warn', text: 'Database reads today: 1' }]);
  assert.equal(back.title, 'MCC back to normal: Database reads today');
  assert.equal(back.priority, 2);
  const odd = pushMessage([{ kind: 'new', key: 'cert', level: 'crit', text: 'Certificate → problem: x' }]);
  assert.equal(odd.title, 'MCC Urgent: Certificate  problem', 'header-safe title');
});

test('push goes to the secret ntfy topic; nothing without a topic', async () => {
  const restore = withEnv({ NTFY_TOPIC: undefined, NTFY_SERVER: undefined, NTFY_TOKEN: undefined });
  const f = fakeFetch(200);
  try {
    assert.equal(await push([{ kind: 'new', key: 'reads', level: 'warn', text: 'a: b' }]), null);
    Object.assign(process.env, { NTFY_TOPIC: 'mcc-Secret_123', NTFY_SERVER: 'https://push.test/', NTFY_TOKEN: 'tk' });
    assert.equal(await push([], 'x'), null, 'no changes, no push');
    assert.equal(await push([{ kind: 'new', key: 'reads', level: 'warn', text: 'Database reads: 36,000' }], 'https://app.test/#admin'), 'pushed 1');
    const [req] = f.seen;
    assert.equal(req.url, 'https://push.test/mcc-Secret_123');
    assert.equal(req.method, 'POST');
    assert.deepEqual(req.headers, { title: 'MCC Warning: Database reads', priority: '4', tags: 'warning', click: 'https://app.test/#admin', authorization: 'Bearer tk' });
    assert.equal(req.body, 'Warning: Database reads: 36,000');
  } finally { f.restore(); restore(); }
  const restore2 = withEnv({ NTFY_TOPIC: 't' });
  const bad = fakeFetch(429);
  try {
    await assert.rejects(push([{ kind: 'new', key: 'a', level: 'info', text: 'x' }]), /answered 429/);
  } finally { bad.restore(); restore2(); }
});

test("dead-man's switch: success and fail pings, scrubbed", async () => {
  const restore = withEnv({ HEALTHCHECK_URL: undefined });
  const f = fakeFetch(200);
  try {
    assert.equal(await ping(true, 'x'), null);
    process.env.HEALTHCHECK_URL = 'https://hc.test/abc/';
    assert.equal(await ping(true, 'ok'), 'pinged');
    assert.equal(await ping(false, 'Firestore GET /users/u123/items: 500'), 'pinged fail');
    assert.equal(f.seen[0].url, 'https://hc.test/abc');
    assert.equal(f.seen[1].url, 'https://hc.test/abc/fail');
    assert.equal(f.seen[1].body, 'Firestore GET /users/*/items: 500');
  } finally { f.restore(); restore(); }
});
