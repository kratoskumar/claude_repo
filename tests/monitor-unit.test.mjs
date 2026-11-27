import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, pacificMidnight, pacificDay, syncIssues, FREE } from '../scripts/monitor.mjs';

const base = {
  reads: 0, writes: 0, deletes: 0, storageMB: 10, egressMonthMB: 10, dayOfMonth: 10, daysInMonth: 30,
  members: 3, maxMembers: 25, itemLimit: 100, atLimit: 0, pending: 0, pendingNames: [], activeToday: 2, activeNow: 1,
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
  assert.deepEqual(keys({ pending: 2, pendingNames: ['Asha', 'Ravi'] }), ['info:requests']);
  assert.match(evaluate({ ...base, pending: 2, pendingNames: ['Asha', 'Ravi'] })[0].text, /Asha, Ravi/);
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
