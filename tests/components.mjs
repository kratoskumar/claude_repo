// Browser checks for image.js and cloud.js (needs the emulator: see package.json test:components).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from './pw.mjs';
import { start } from './serve.mjs';
import { createUser, loadRules, reset } from './emu.mjs';

const rotated = await readFile(new URL('./fixtures/rotated.jpg', import.meta.url));
const { server, url } = await start({ emulator: true, overrides: { 'blank.html': '<!doctype html><meta charset="utf-8"><title>t</title>' } });
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

// ---------- cloud.js against the emulator ----------
await reset();
const uid = await createUser('family@example.com', 'correct-horse-9');
await createUser('intruder@example.com', 'intruder-pass-1');
await loadRules(uid);

const item = { name: 'Test ring', link: 'https://example.com/r', notes: '', market: 'IN', date: '2025-01-01', price: 75000, cur: 'INR', wt: 10, k: '22', pf: 0.916, other: 0, taxIncl: true, taxPct: 3, rate24: 6870.49, rateManual: false, fx: 84, duty: 6, gold: 62933.65, making: 9881.88, pct: 15.7, perGram: 988.19, preTax: 72815.53, thumb: 'data:image/webp;base64,AAAA', photo: true, ts: 1, upd: 1 };

const flow = await page.evaluate(async item => {
  const C = await import('./cloud.js');
  const out = { configured: C.configured() };
  try { await C.signIn('family@example.com', 'wrong-pass'); out.wrong = 'signed in?!'; } catch (e) { out.wrong = e.code; }
  const cred = await C.signIn('  family@example.com ', 'correct-horse-9');
  out.uid = cred.user.uid;
  let latest = null;
  const unsub = await C.watchItems(list => { latest = list; }, e => { out.watchErr = e.code; });
  const photo = 'data:image/webp;base64,' + 'QUJD'.repeat(1000);
  const s = await C.saveItem(null, item, photo);
  await s.done;
  out.id = s.id;
  await new Promise(r => setTimeout(r, 300));
  out.listAfterSave = latest.map(i => i.name);
  out.photoBack = (await C.getPhoto(s.id)) === photo;
  await (await C.saveItem(s.id, { ...item, name: 'Renamed', upd: 2 }, undefined)).done;
  out.photoKept = (await C.getPhoto(s.id)) === photo;
  await (await C.saveItem(s.id, { ...item, name: 'Renamed', photo: false, upd: 3 }, null)).done;
  out.photoRemoved = (await C.getPhoto(s.id)) === null;
  await new Promise(r => setTimeout(r, 300));
  out.listAfterEdit = latest.map(i => i.name);
  try { await (await C.saveItem(null, { ...item, name: '' }, undefined)).done; out.invalid = 'saved?!'; } catch (e) { out.invalid = e.code; }
  await (await C.deleteItem(s.id)).done;
  await new Promise(r => setTimeout(r, 300));
  out.listAfterDelete = latest.length;
  unsub();
  return out;
}, item);
assert.equal(flow.configured, true);
assert.ok(['auth/invalid-credential', 'auth/wrong-password'].includes(flow.wrong), flow.wrong);
assert.equal(flow.uid, uid);
assert.equal(flow.watchErr, undefined);
assert.deepEqual(flow.listAfterSave, ['Test ring']);
assert.ok(flow.photoBack && flow.photoKept && flow.photoRemoved, JSON.stringify(flow));
assert.deepEqual(flow.listAfterEdit, ['Renamed']);
assert.equal(flow.invalid, 'permission-denied');
assert.equal(flow.listAfterDelete, 0);
ok('owner: wrong password refused, sign in, save with photo, edit, keep/remove photo, invalid data refused, delete');

// A second account must not see anything, even with a valid login.
const page2 = await browser.newPage();
await page2.goto(url + 'blank.html');
const intr = await page2.evaluate(async () => {
  const C = await import('./cloud.js');
  await C.signIn('intruder@example.com', 'intruder-pass-1');
  const err = await new Promise(r => C.watchItems(() => r('got data'), e => r(e.code)));
  let write; try { await (await C.saveItem(null, { name: 'x' }, undefined)).done; write = 'ok'; } catch (e) { write = e.code; }
  return { err, write };
});
assert.deepEqual(intr, { err: 'permission-denied', write: 'permission-denied' });
ok('another account is denied reads and writes');

const so = await page.evaluate(async () => {
  const C = await import('./cloud.js');
  await C.signOut();
  const dbs = (await indexedDB.databases()).map(d => d.name).filter(n => n.startsWith('firestore/'));
  return dbs;
});
assert.deepEqual(so, []);
ok('sign out clears the offline copy on the device');

assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log(`\n${passed} component checks passed`);
