// Run with: npm run test:rules (starts the Firestore emulator).
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, deleteDoc, collection, updateDoc, writeBatch, increment, getCountFromServer, query, where } from 'firebase/firestore';

const OWNER = 'owner-uid-123';
const source = readFileSync(new URL('../firebase/firestore.rules', import.meta.url), 'utf8');
if (source.split('PASTE-YOUR-UID-HERE').length !== 2) throw new Error('UID placeholder must appear exactly once');
const rules = source.replace('PASTE-YOUR-UID-HERE', OWNER);

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'demo-mc', firestore: { rules, host: '127.0.0.1', port: 8080 } });
});
after(async () => env && env.cleanup());
beforeEach(async () => env.clearFirestore());

const item = (over = {}) => ({
  name: '22K bangle', link: 'https://example.com/p', notes: '', market: 'IN', date: '2025-01-01',
  price: 75000, cur: 'INR', wt: 10, k: '22', pf: 0.916, other: 0, taxIncl: true, taxPct: 3,
  rate24: 6870.49, rateManual: false, fx: 84, duty: 6, gold: 62933.65, making: 9881.88, pct: 15.7,
  perGram: 988.19, preTax: 72815.53, thumb: 'data:image/webp;base64,AAAA', photo: true, ts: 1700000000000, upd: 1700000000000,
  ...over
});
const photo = n => 'data:image/webp;base64,' + 'A'.repeat(n);
const as = u => env.authenticatedContext(u).firestore();
const anon = () => env.unauthenticatedContext().firestore();
const admin = fn => env.withSecurityRulesDisabled(c => fn(c.firestore()));
const approve = u => admin(db => setDoc(doc(db, `members/${u}`), { name: u, email: `${u}@x.com`, ts: 1 }));
const meta = (u, data) => admin(db => setDoc(doc(db, `users/${u}`), { count: 0, ...data }));

// Adds an item the way the app does: item + count+1 (+ optional photo) in one batch.
function addItem(db, u, id, count, data = item(), ph) {
  const b = writeBatch(db);
  b.set(doc(db, `users/${u}/items/${id}`), data);
  b.update(doc(db, `users/${u}`), { count: count + 1, last: id });
  if (ph) b.set(doc(db, `users/${u}/photos/${id}`), { d: ph });
  return b.commit();
}
function removeItem(db, u, id, count) {
  const b = writeBatch(db);
  b.delete(doc(db, `users/${u}/items/${id}`));
  b.delete(doc(db, `users/${u}/photos/${id}`));
  b.update(doc(db, `users/${u}`), { count: count - 1, last: id });
  return b.commit();
}

test('signed-in stranger can only ask for access', async () => {
  const db = as('stranger');
  await assertSucceeds(setDoc(doc(db, 'requests/stranger'), { name: 'S', email: 's@x.com', ts: 1 }));
  await assertSucceeds(getDoc(doc(db, 'requests/stranger')));
  await assertSucceeds(getDoc(doc(db, 'members/stranger'))); // to learn it is not approved yet
  await assertFails(setDoc(doc(db, 'requests/other'), { name: 'S', email: 's@x.com', ts: 1 }));
  await assertFails(setDoc(doc(db, 'requests/stranger'), { name: 'S', email: 's@x.com', ts: 1, admin: true }));
  await assertFails(setDoc(doc(db, 'users/stranger'), { count: 0 }));
  await assertFails(setDoc(doc(db, 'members/stranger'), { name: 'S', email: 's@x.com', ts: 1 }));
  await assertFails(getDocs(collection(db, 'requests')));
  await assertFails(getDocs(collection(db, 'members')));
  await assertFails(getDoc(doc(db, 'config/app')));
  await assertFails(setDoc(doc(db, 'stats/2026-11-27'), { opens: 1 }));
  for (const d of [anon()]) {
    await assertFails(setDoc(doc(d, 'requests/x'), { name: 'S', email: 's', ts: 1 }));
    await assertFails(getDoc(doc(d, 'members/x')));
  }
});

test('owner approves, declines and sets limits; members cannot', async () => {
  await admin(db => setDoc(doc(db, 'requests/friend'), { name: 'F', email: 'f@x.com', ts: 1 }));
  const o = as(OWNER);
  await assertSucceeds(getDocs(collection(o, 'requests')));
  const b = writeBatch(o);
  b.set(doc(o, 'members/friend'), { name: 'F', email: 'f@x.com', ts: 2 });
  b.delete(doc(o, 'requests/friend'));
  await assertSucceeds(b.commit());
  await assertSucceeds(setDoc(doc(o, 'config/app'), { itemLimit: 100, maxMembers: 25 }));
  await assertFails(setDoc(doc(o, 'config/app'), { itemLimit: 0, maxMembers: 25 }));
  await assertFails(setDoc(doc(o, 'config/app'), { itemLimit: 100.5, maxMembers: 25 }));
  await assertFails(setDoc(doc(o, 'members/x'), { name: 'X', role: 'owner' }));
  const f = as('friend');
  await assertSucceeds(getDoc(doc(f, 'config/app')));
  await assertFails(setDoc(doc(f, 'config/app'), { itemLimit: 1000, maxMembers: 25 }));
  await assertFails(setDoc(doc(f, 'members/pal'), { name: 'P', email: 'p', ts: 1 }));
  await assertFails(setDoc(doc(f, 'requests/friend'), { name: 'F', email: 'f', ts: 1 })); // already a member
  await assertSucceeds(deleteDoc(doc(o, 'members/friend')));
  await assertFails(getDoc(doc(f, 'config/app'))); // removed members lose access
});

test('member: own space, add/edit/delete items with photos', async () => {
  await approve('a');
  const db = as('a');
  await assertSucceeds(setDoc(doc(db, 'users/a'), { count: 0, set: { market: 'IN', k: '22' }, seen: 5 }));
  await assertFails(setDoc(doc(db, 'users/b'), { count: 0 }));
  await assertSucceeds(addItem(db, 'a', 'i1', 0, item(), photo(1000)));
  await assertSucceeds(getDoc(doc(db, 'users/a/photos/i1')));
  await assertSucceeds(getDocs(collection(db, 'users/a/items')));
  await assertSucceeds(updateDoc(doc(db, 'users/a/items/i1'), { name: 'Renamed', upd: 2 }));
  await assertSucceeds(setDoc(doc(db, 'users/a/photos/i1'), { d: photo(2000) }));
  await assertSucceeds(updateDoc(doc(db, 'users/a'), { set: { market: 'US', duty: [{ from: '2000-01-01', pct: 15 }] }, seen: 9 }));
  await assertSucceeds(removeItem(db, 'a', 'i1', 1));
  const m = await getDoc(doc(db, 'users/a'));
  if (m.data().count !== 0) throw new Error('count should be 0');
});

test('settings: saved jewellers for the Exchange tab sync, up to 10', async () => {
  await approve('a');
  await meta('a');
  const db = as('a');
  const jw = n => Array.from({ length: n }, (_, i) => ({ n: `Jeweller ${i}`, d: 3 }));
  await assertSucceeds(updateDoc(doc(db, 'users/a'), { set: { market: 'US', jewellers: [{ n: 'Joy Alukkas', d: 3 }], t: 1 } }));
  await assertSucceeds(updateDoc(doc(db, 'users/a'), { set: { jewellers: jw(10), t: 2 } }));
  await assertSucceeds(updateDoc(doc(db, 'users/a'), { set: { jewellers: [], t: 3 } }));
  await assertFails(updateDoc(doc(db, 'users/a'), { set: { jewellers: jw(11), t: 4 } }));
  await assertFails(updateDoc(doc(db, 'users/a'), { set: { jewellers: 'Joy Alukkas 3%', t: 5 } }));
  await approve('b');
  await assertFails(updateDoc(doc(as('b'), 'users/a'), { set: { jewellers: jw(1), t: 6 } })); // not someone else's
});

test('item cap cannot be bypassed', async () => {
  await approve('a');
  await admin(db => setDoc(doc(db, 'config/app'), { itemLimit: 2, maxMembers: 25 }));
  await meta('a');
  const db = as('a');
  // item without count, count without item, wrong last id
  await assertFails(setDoc(doc(db, 'users/a/items/x'), item()));
  await assertFails(updateDoc(doc(db, 'users/a'), { count: 1, last: 'ghost' }));
  const b = writeBatch(db);
  b.set(doc(db, 'users/a/items/x'), item());
  b.update(doc(db, 'users/a'), { count: 1, last: 'other' });
  await assertFails(b.commit());
  await assertSucceeds(addItem(db, 'a', 'i1', 0));
  await assertSucceeds(addItem(db, 'a', 'i2', 1));
  await assertFails(addItem(db, 'a', 'i3', 2)); // over the limit of 2
  // lowering the count without deleting, or deleting without lowering it
  await assertFails(updateDoc(doc(db, 'users/a'), { count: 1, last: 'i1' }));
  await assertFails(deleteDoc(doc(db, 'users/a/items/i1')));
  await assertFails(updateDoc(doc(db, 'users/a'), { count: 0 }));
  await assertFails(updateDoc(doc(db, 'users/a'), { count: 5, last: 'i1' }));
  await assertSucceeds(removeItem(db, 'a', 'i1', 2));
  await assertSucceeds(addItem(db, 'a', 'i3', 1));
});

test('invalid data is rejected', async () => {
  await approve('a');
  await meta('a');
  const db = as('a');
  const bad = [item({ extra: 1 }), item({ name: '' }), item({ market: 'UK' }), item({ price: -1 }), item({ pf: 1.5 }),
    item({ date: 'today' }), item({ taxPct: 60 }), item({ thumb: 'x'.repeat(16001) }), item({ link: 'x'.repeat(2001) })];
  for (const d of bad) await assertFails(addItem(db, 'a', 'bad', 0, d));
  await assertSucceeds(addItem(db, 'a', 'ok', 0));
  await assertFails(setDoc(doc(db, 'users/a/photos/ok'), { d: photo(300000) }));
  await assertFails(setDoc(doc(db, 'users/a/photos/ok'), { d: 'data:image/svg+xml;base64,PHN2Zz4=' }));
  await assertFails(setDoc(doc(db, 'users/a/photos/nothing'), { d: photo(10) })); // no such item
  await assertFails(updateDoc(doc(db, 'users/a'), { set: { evil: 'x'.repeat(10) } }));
  await assertFails(updateDoc(doc(db, 'users/a'), { admin: true }));
});

test('people cannot see each other\'s data; owner sees only counts', async () => {
  await approve('a'); await approve('b');
  await meta('a', { count: 1, last: 'i1' });
  await admin(async db => { await setDoc(doc(db, 'users/a/items/i1'), item()); await setDoc(doc(db, 'users/a/photos/i1'), { d: photo(10) }); });
  const b = as('b');
  await assertFails(getDoc(doc(b, 'users/a')));
  await assertFails(getDocs(collection(b, 'users/a/items')));
  await assertFails(getDoc(doc(b, 'users/a/photos/i1')));
  await assertFails(setDoc(doc(b, 'users/a/items/z'), item()));
  await assertFails(getDocs(collection(b, 'users')));
  const o = as(OWNER);
  await assertSucceeds(getDoc(doc(o, 'users/a')));
  await assertSucceeds(getDocs(collection(o, 'users')));
  await assertFails(getDocs(collection(o, 'users/a/items')));
  await assertFails(getDoc(doc(o, 'users/a/photos/i1')));
  for (const d of [anon(), as('stranger')]) {
    await assertFails(getDoc(doc(d, 'users/a')));
    await assertFails(getDocs(collection(d, 'users/a/items')));
  }
});

test('owner uses the app like any member without a member record', async () => {
  const o = as(OWNER);
  await assertSucceeds(setDoc(doc(o, `users/${OWNER}`), { count: 0 }));
  await assertSucceeds(addItem(o, OWNER, 'mine', 0, item(), photo(100)));
});

test('usage counters: members can only add; only owner reads', async () => {
  await approve('a');
  const db = as('a');
  await assertSucceeds(setDoc(doc(db, 'stats/2026-11-27'), { opens: increment(1), reads: increment(40), kb: increment(12) }, { merge: true }));
  await assertSucceeds(setDoc(doc(db, 'stats/2026-11-27'), { opens: increment(1), errQuota: increment(1) }, { merge: true }));
  await assertFails(setDoc(doc(db, 'stats/2026-11-27'), { opens: increment(-1) }, { merge: true }));
  await assertFails(setDoc(doc(db, 'stats/2026-11-27'), { opens: 0 }, { merge: true }));
  await assertFails(setDoc(doc(db, 'stats/2026-11-27'), { hack: increment(1) }, { merge: true }));
  await assertFails(setDoc(doc(db, 'stats/2026-11-27'), { reads: increment(50000) }, { merge: true }));
  await assertFails(setDoc(doc(db, 'stats/not-a-day'), { opens: increment(1) }, { merge: true }));
  await assertFails(getDoc(doc(db, 'stats/2026-11-27')));
  await assertFails(setDoc(doc(as('stranger'), 'stats/2026-11-27'), { opens: increment(1) }, { merge: true }));
  const o = as(OWNER);
  const s = await getDoc(doc(o, 'stats/2026-11-27'));
  if (s.data().opens !== 2 || s.data().reads !== 40) throw new Error('counters ' + JSON.stringify(s.data()));
});

test('daily active markers', async () => {
  await approve('a');
  const db = as('a');
  await assertSucceeds(setDoc(doc(db, 'active/2026-11-27_a'), { d: '2026-11-27', u: 'a' }));
  await assertFails(setDoc(doc(db, 'active/2026-11-27_b'), { d: '2026-11-27', u: 'b' }));
  await assertFails(setDoc(doc(db, 'active/2026-11-27_a'), { d: '2026-11-27', u: 'a' })); // no overwrite
  await assertFails(setDoc(doc(as('stranger'), 'active/2026-11-27_stranger'), { d: '2026-11-27', u: 'stranger' }));
  await assertFails(getDoc(doc(db, 'active/2026-11-27_a')));
  const n = await getCountFromServer(query(collection(as(OWNER), 'active'), where('d', '==', '2026-11-27')));
  if (n.data().count !== 1) throw new Error('count');
});

test('purge requests, monitor status and other paths', async () => {
  const o = as(OWNER);
  await assertSucceeds(setDoc(doc(o, 'purge/a'), { ts: 1 }));
  await assertFails(setDoc(doc(as('a'), 'purge/b'), { ts: 1 }));
  await admin(db => setDoc(doc(db, 'monitor/status'), { ok: true }));
  await assertSucceeds(getDoc(doc(o, 'monitor/status')));
  await assertFails(setDoc(doc(o, 'monitor/status'), { ok: false }));
  await approve('a');
  await assertFails(getDoc(doc(as('a'), 'monitor/status')));
  await assertFails(setDoc(doc(o, 'anything/x'), { a: 1 }));
  await assertFails(setDoc(doc(as('a'), 'items/x'), item())); // old single-user path is closed
});
