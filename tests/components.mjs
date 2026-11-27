// Browser checks for image.js and cloud.js (needs the emulator: see package.json test:components).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './pw.mjs';
import { start } from './serve.mjs';
import { createUser, loadRules, reset, adminGet } from './emu.mjs';

const rotated = await readFile(new URL('./fixtures/rotated.jpg', import.meta.url));
await reset();
const ownerUid = await createUser('family@example.com', 'correct-horse-9');
await loadRules(ownerUid);
const { server, url } = await start({ emulator: true, ownerUid, overrides: { 'blank.html': '<!doctype html><meta charset="utf-8"><title>t</title>' } });
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.goto(url + 'blank.html');
let passed = 0;
const ok = name => { passed++; console.log('ok -', name); };

// ---------- image.js ----------
const big = await page.evaluate(async () => {
  const { compress } = await import('./image.js');
  const c = document.createElement('canvas'); c.width = 4000; c.height = 3000;
  const x = c.getContext('2d'); const img = x.createImageData(4000, 3000);
  for (let i = 0; i < img.data.length; i += 4) { img.data[i] = Math.random() * 255; img.data[i + 1] = (i / 4) % 255; img.data[i + 2] = 128; img.data[i + 3] = 255; }
  x.putImageData(img, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
  const t0 = performance.now();
  const out = await compress(new File([blob], 'big.jpg', { type: 'image/jpeg' }));
  const ms = performance.now() - t0;
  const dims = await new Promise(r => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = out.photo; });
  return { inBytes: blob.size, photoLen: out.photo.length, thumbLen: out.thumb.length, type: out.photo.slice(0, 15), dims, ms };
});
assert.ok(big.photoLen <= 400000 && big.thumbLen <= 30000, JSON.stringify(big));
assert.ok(Math.max(...big.dims) <= 1280);
assert.equal(big.type, 'data:image/webp');
ok(`large noisy 12MP photo ${(big.inBytes / 1e6).toFixed(1)} MB -> ${(big.photoLen / 1e3).toFixed(0)}k chars, ${big.dims.join('x')}, ${big.ms.toFixed(0)} ms`);

const rot = await page.evaluate(async b64 => {
  const { compress } = await import('./image.js');
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const out = await compress(new File([bytes], 'r.jpg', { type: 'image/jpeg' }));
  return await new Promise(r => {
    const i = new Image();
    i.onload = () => {
      const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
      const x = c.getContext('2d'); x.drawImage(i, 0, 0);
      const top = x.getImageData(c.width / 2, 5, 1, 1).data, bottom = x.getImageData(c.width / 2, c.height - 5, 1, 1).data;
      r({ w: i.naturalWidth, h: i.naturalHeight, top: [...top].slice(0, 3), bottom: [...bottom].slice(0, 3) });
    };
    i.src = out.photo;
  });
}, rotated.toString('base64'));
assert.equal(rot.w, 200); assert.equal(rot.h, 400);
assert.ok(rot.top[0] > 200 && rot.top[2] < 60, 'red on top after rotating 90 degrees clockwise: ' + JSON.stringify(rot));
assert.ok(rot.bottom[2] > 200 && rot.bottom[0] < 60, 'blue at bottom');
ok('phone photo with EXIF rotation is saved upright');

const errs = await page.evaluate(async () => {
  const { compress } = await import('./image.js');
  const r = [];
  for (const f of [new File(['hello'], 'a.txt', { type: 'text/plain' }), new File(['notajpeg'], 'b.jpg', { type: 'image/jpeg' })]) {
    try { await compress(f); r.push('no error'); } catch (e) { r.push(e.message); }
  }
  return r;
});
assert.deepEqual(errs, ['not-image', 'unsupported']);
ok('non-image and corrupt files are rejected with a clear error');

const jpeg = await page.evaluate(async () => {
  const orig = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (t, q) { return orig.call(this, t === 'image/webp' ? 'image/png' : t, q); };
  const { compress } = await import('./image.js?safari');
  const c = document.createElement('canvas'); c.width = 900; c.height = 600;
  const x = c.getContext('2d'); x.fillStyle = 'rgba(0,128,0,0.5)'; x.fillRect(0, 0, 900, 600);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const out = await compress(new File([blob], 'p.png', { type: 'image/png' }));
  HTMLCanvasElement.prototype.toDataURL = orig;
  return [out.photo.slice(0, 15), out.thumb.slice(0, 15)];
});
assert.deepEqual(jpeg, ['data:image/jpeg', 'data:image/jpeg']);
ok('browsers without WebP encoding (Safari) fall back to JPEG');

// ---------- cloud.js + admin.js against the emulator ----------
const item = { name: 'Test ring', link: 'https://example.com/r', notes: '', market: 'IN', date: '2025-01-01', price: 75000, cur: 'INR', wt: 10, k: '22', pf: 0.916, other: 0, taxIncl: true, taxPct: 3, rate24: 6870.49, rateManual: false, fx: 84, duty: 6, gold: 62933.65, making: 9881.88, pct: 15.7, perGram: 988.19, preTax: 72815.53, thumb: 'data:image/webp;base64,AAAA', photo: true, ts: 1, upd: 1 };
const newPage = async label => { const p = await browser.newPage(); p.on('pageerror', e => errors.push(`${label}: ${e.message}`)); await p.goto(url + 'blank.html'); return p; };

const flow = await page.evaluate(async item => {
  const C = await import('./cloud.js');
  const out = { configured: C.configured() };
  try { await C.signInEmail('family@example.com', 'wrong-pass'); out.wrong = 'signed in?!'; } catch (e) { out.wrong = e.code; }
  const cred = await C.signInEmail('  family@example.com ', 'correct-horse-9');
  const u = cred.user;
  out.isOwner = C.isOwner(u);
  out.member = await new Promise(r => C.watchMembership(u, r));
  let meta = null, latest = null;
  await C.watchMeta(u.uid, m => { meta = m; });
  await new Promise(r => setTimeout(r, 600));
  out.metaCreated = meta && meta.count === 0;
  await C.watchItems(u.uid, list => { latest = list; }, e => { out.watchErr = e.code; });
  const photo = 'data:image/webp;base64,' + 'QUJD'.repeat(1000);
  const s = await C.saveItem(u.uid, null, item, photo);
  await s.done;
  await new Promise(r => setTimeout(r, 400));
  out.listAfterSave = latest.map(i => i.name);
  out.countAfterSave = meta.count;
  out.photoBack = (await C.getPhoto(u.uid, s.id)) === photo;
  await (await C.saveItem(u.uid, s.id, { ...item, name: 'Renamed', upd: 2 }, undefined)).done;
  out.photoKept = (await C.getPhoto(u.uid, s.id)) === photo;
  await (await C.saveItem(u.uid, s.id, { ...item, name: 'Renamed', photo: false, thumb: '', upd: 3 }, null)).done;
  out.photoRemoved = (await C.getPhoto(u.uid, s.id)) === null;
  await new Promise(r => setTimeout(r, 300));
  out.listAfterEdit = latest.map(i => i.name);
  out.countAfterEdit = meta.count;
  try { await (await C.saveItem(u.uid, null, { ...item, name: '' }, undefined)).done; out.invalid = 'saved?!'; } catch (e) { out.invalid = e.code; }
  await (await C.deleteItem(u.uid, s.id)).done;
  await new Promise(r => setTimeout(r, 300));
  out.listAfterDelete = latest.length;
  out.countAfterDelete = meta.count;
  await C.saveSettings(u.uid, { market: 'IN', cur: 'INR', k: '22', customPct: '', tax: { US: { incl: false, pct: '0' }, IN: { incl: true, pct: '3' } }, duty: [{ from: '2000-01-01', pct: 15 }], t: 5 });
  await new Promise(r => setTimeout(r, 300));
  out.settings = meta.set && meta.set.market;
  // usage numbers reach stats/{day}
  C.enableReporting(true);
  C.track('opens', 1);
  await C.flush();
  out.day = C.pacificDay();
  return out;
}, item);
assert.equal(flow.configured, true);
assert.ok(['auth/invalid-credential', 'auth/wrong-password'].includes(flow.wrong), flow.wrong);
assert.equal(flow.isOwner, true);
assert.equal(flow.member, true);
assert.ok(flow.metaCreated, 'personal record created on first use');
assert.equal(flow.watchErr, undefined);
assert.deepEqual(flow.listAfterSave, ['Test ring']);
assert.equal(flow.countAfterSave, 1);
assert.ok(flow.photoBack && flow.photoKept && flow.photoRemoved, JSON.stringify(flow));
assert.deepEqual(flow.listAfterEdit, ['Renamed']);
assert.equal(flow.countAfterEdit, 1, 'editing does not change the count');
assert.equal(flow.invalid, 'permission-denied');
assert.equal(flow.listAfterDelete, 0);
assert.equal(flow.countAfterDelete, 0);
assert.equal(flow.settings, 'IN');
const stats = await adminGet(`stats/${flow.day}`);
assert.ok(stats && stats.fields.saves && +stats.fields.saves.integerValue >= 3 && +stats.fields.opens.integerValue === 1, 'usage counters ' + JSON.stringify(stats && stats.fields));
ok('owner: sign in, own space, save/edit/keep/remove photo, delete, item count, settings sync, usage counters');

// A friend signs in, asks for access, is approved live, and is held to the item limit.
const friendPage = await newPage('friend');
const f1 = await friendPage.evaluate(async () => {
  const C = await import('./cloud.js');
  const u = (await C.signUpEmail('friend@example.com', 'friend-pass-1', 'Asha')).user;
  window.__states = [];
  await C.watchMembership(u, ok => window.__states.push(ok));
  await new Promise(r => setTimeout(r, 400));
  const before = { isOwner: C.isOwner(u), name: u.displayName, states: [...window.__states], requested: await C.getRequest(u.uid) };
  let denied; try { await new Promise((res, rej) => C.watchItems(u.uid, res, rej)); denied = 'read ok?!'; } catch (e) { denied = e.code; }
  await C.requestAccess(u);
  return { ...before, denied, requestedAfter: await C.getRequest(u.uid), uid: u.uid };
});
assert.equal(f1.isOwner, false);
assert.equal(f1.name, 'Asha');
assert.deepEqual(f1.states, [false]);
assert.equal(f1.requested, false);
assert.equal(f1.denied, 'permission-denied');
assert.equal(f1.requestedAfter, true);
ok('new friend: signs up, cannot see anything, sends an access request');

const adminView = await page.evaluate(async () => {
  const A = await import('./admin.js');
  let d = await A.load();
  const before = { requests: d.requests.map(r => r.name), members: d.members.length, limits: d.limits };
  await A.saveLimits({ itemLimit: 1, maxMembers: 25 });
  await A.approve(d.requests[0]);
  d = await A.load();
  return { before, after: { requests: d.requests.length, members: d.members.map(m => m.name), limits: d.limits, activeToday: d.activeToday } };
});
assert.deepEqual(adminView.before, { requests: ['Asha'], members: 0, limits: { itemLimit: 100, maxMembers: 25 } });
assert.deepEqual(adminView.after.requests, 0);
assert.deepEqual(adminView.after.members, ['Asha']);
assert.equal(adminView.after.limits.itemLimit, 1);
ok('owner dashboard: sees the request, approves it, sets limits');

const f2 = await friendPage.evaluate(async () => {
  const C = await import('./cloud.js');
  await new Promise(r => setTimeout(r, 600));
  const u = await C.currentUser();
  const states = [...window.__states];
  let meta = null;
  await C.watchMeta(u.uid, m => { meta = m; });
  await new Promise(r => setTimeout(r, 600));
  const item = { name: 'Ring', market: 'US', date: '2025-01-01', price: 500, cur: 'USD', wt: 3, k: '14', pf: 0.5833, rate24: 80, gold: 140, making: 360, pct: 257, ts: 1, upd: 1 };
  await (await C.saveItem(u.uid, null, item, undefined)).done;
  let second; try { await (await C.saveItem(u.uid, null, item, undefined)).done; second = 'saved?!'; } catch (e) { second = e.code; }
  let peek; try { await new Promise((res, rej) => C.watchItems('someone-else', res, rej)); peek = 'read?!'; } catch (e) { peek = e.code; }
  return { states, count: meta.count, second, peek };
});
assert.deepEqual(f2.states, [false, true], 'approval arrives live');
assert.equal(f2.count, 1);
assert.equal(f2.second, 'permission-denied', 'item limit enforced by the database');
assert.equal(f2.peek, 'permission-denied');
ok('friend: approval arrives without reload, saves, item limit enforced, cannot read others');

const removed = await page.evaluate(async uid => { const A = await import('./admin.js'); await A.remove(uid, true); return (await A.load()).members.length; }, f1.uid);
assert.equal(removed, 0);
const f3 = await friendPage.evaluate(async () => { await new Promise(r => setTimeout(r, 600)); return window.__states.at(-1); });
assert.equal(f3, false);
assert.ok(await adminGet(`purge/${f1.uid}`), 'data removal queued for the monitor');
ok('owner removes the friend: access ends at once, data deletion queued');

const so = await page.evaluate(async () => {
  const C = await import('./cloud.js');
  await C.signOut();
  return (await indexedDB.databases()).map(d => d.name).filter(n => n.startsWith('firestore/'));
});
assert.deepEqual(so, []);
ok('sign out clears the offline copy on the device');

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log(`\n${passed} component checks passed`);
