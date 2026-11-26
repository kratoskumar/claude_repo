// Run with: npm run test:rules (starts the Firestore emulator).
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, deleteDoc, collection, updateDoc } from 'firebase/firestore';

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

const owner = () => env.authenticatedContext(OWNER).firestore();
const other = () => env.authenticatedContext('someone-else').firestore();
const anon = () => env.unauthenticatedContext().firestore();

test('owner can create, read, list, update and delete items', async () => {
  const db = owner();
  await assertSucceeds(setDoc(doc(db, 'items/a'), item()));
  await assertSucceeds(getDoc(doc(db, 'items/a')));
  await assertSucceeds(getDocs(collection(db, 'items')));
  await assertSucceeds(updateDoc(doc(db, 'items/a'), { name: 'Renamed', upd: 1700000000001 }));
  await assertSucceeds(deleteDoc(doc(db, 'items/a')));
});

test('minimal item (optional fields omitted) and US/USD item are allowed', async () => {
  const min = item();
  for (const k of ['link', 'notes', 'other', 'taxIncl', 'taxPct', 'rateManual', 'fx', 'duty', 'perGram', 'preTax', 'thumb', 'photo']) delete min[k];
  await assertSucceeds(setDoc(doc(owner(), 'items/min'), min));
  await assertSucceeds(setDoc(doc(owner(), 'items/us'), item({ market: 'US', cur: 'USD', k: 'custom', pf: 0.6, fx: null, making: -5, pct: -1.2 })));
});

test('other accounts and signed-out visitors are denied everything', async () => {
  await env.withSecurityRulesDisabled(async c => {
    await setDoc(doc(c.firestore(), 'items/a'), item());
    await setDoc(doc(c.firestore(), 'photos/a'), { d: photo(100) });
  });
  for (const db of [other(), anon()]) {
    await assertFails(getDoc(doc(db, 'items/a')));
    await assertFails(getDocs(collection(db, 'items')));
    await assertFails(setDoc(doc(db, 'items/b'), item()));
    await assertFails(deleteDoc(doc(db, 'items/a')));
    await assertFails(getDoc(doc(db, 'photos/a')));
    await assertFails(setDoc(doc(db, 'photos/b'), { d: photo(100) }));
    await assertFails(deleteDoc(doc(db, 'photos/a')));
  }
});

test('invalid item data is rejected', async () => {
  const db = owner();
  const bad = [
    item({ extra: 1 }),
    item({ name: '' }),
    item({ name: 'x'.repeat(121) }),
    item({ market: 'UK' }),
    item({ cur: 'EUR' }),
    item({ price: 0 }),
    item({ price: -1 }),
    item({ price: '100' }),
    item({ wt: 0 }),
    item({ pf: 1.5 }),
    item({ date: 'yesterday' }),
    item({ taxPct: 60 }),
    item({ other: -1 }),
    item({ fx: 0 }),
    item({ link: 'x'.repeat(2001) }),
    item({ thumb: 'x'.repeat(40001) }),
    item({ photo: 'yes' })
  ];
  const noName = item(); delete noName.name;
  const noTs = item(); delete noTs.ts;
  for (const d of [...bad, noName, noTs]) await assertFails(setDoc(doc(db, 'items/x'), d));
});

test('photos: valid allowed; oversized, non-image or extra fields rejected', async () => {
  const db = owner();
  await assertSucceeds(setDoc(doc(db, 'photos/a'), { d: photo(600000) }));
  await assertSucceeds(setDoc(doc(db, 'photos/j'), { d: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }));
  await assertSucceeds(getDoc(doc(db, 'photos/a')));
  await assertFails(setDoc(doc(db, 'photos/b'), { d: photo(900000) }));
  await assertFails(setDoc(doc(db, 'photos/c'), { d: 'data:image/svg+xml;base64,PHN2Zz4=' }));
  await assertFails(setDoc(doc(db, 'photos/d'), { d: 'data:text/html;base64,PGI+' }));
  await assertFails(setDoc(doc(db, 'photos/e'), { d: photo(10), x: 1 }));
  await assertFails(setDoc(doc(db, 'photos/f'), { d: 'data:image/webp;base64,<script>' }));
  await assertSucceeds(deleteDoc(doc(db, 'photos/a')));
});

test('no other collections are reachable', async () => {
  await assertFails(setDoc(doc(owner(), 'settings/x'), { a: 1 }));
  await assertFails(getDoc(doc(owner(), 'users/x')));
});
