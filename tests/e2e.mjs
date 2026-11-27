// End-to-end test in a real browser. Run with: npm run test:e2e (starts the Firebase emulator).
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, devices } from './pw.mjs';
import { start } from './serve.mjs';
import { createUser, loadRules, reset, adminList } from './emu.mjs';

const OUT = new URL('../test-output/', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });
const FIXTURE = new URL('./fixtures/rotated.jpg', import.meta.url).pathname;
const TODAY = new Date().toISOString().slice(0, 10); // browser and Node both run in UTC here
const browser = await chromium.launch();
let passed = 0, current = '';
const errors = [];
const servers = [];
const serve = async opts => { const x = await start(opts); servers.push(x.server); return x; };

async function step(name, fn) {
  current = name;
  await fn();
  passed++;
  console.log('ok -', name);
}
function check(cond, msg) { if (!cond) throw new Error(msg); }
async function waitText(p, sel, expected, timeout = 15000) {
  try {
    await p.waitForFunction(([s, e]) => { const el = document.querySelector(s); return !!el && el.textContent.includes(e); }, [sel, expected], { timeout });
  } catch {
    throw new Error(`${sel} never contained "${expected}" (has "${await p.textContent(sel).catch(() => '?')}")`);
  }
}
const visible = (p, sel) => p.isVisible(sel);
const clearToast = p => p.evaluate(() => { document.getElementById('toast').textContent = ''; });
async function until(fn, msg, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await fn()) return; await new Promise(r => setTimeout(r, 250)); }
  throw new Error('timed out: ' + msg);
}
function watch(p, label) {
  p.on('pageerror', e => errors.push(`${label} pageerror: ${e.message}`));
  p.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Expected noise: the deliberately failing requests in the offline/intruder/wrong-password steps.
    if (/Failed to load resource|ERR_INTERNET_DISCONNECTED|ERR_FAILED|permission-denied|PERMISSION_DENIED|Could not reach Cloud Firestore|INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS|status of 400/.test(t)) return;
    errors.push(`${label} console: ${t}`);
  });
}

// ---------- rate mocks (deterministic numbers) ----------
const MOCK = { gold: 2400, fx: 84, days: { '2024-07-24': { gold: 2408.76, fx: 83.71 } }, frank: 83.0, down: false };
async function mockRates(ctx) {
  const headers = { 'access-control-allow-origin': '*' };
  await ctx.route(/api\.gold-api\.com/, r => (MOCK.down ? r.abort() : r.fulfill({ json: { price: MOCK.gold, updatedAt: new Date().toISOString() }, headers })));
  await ctx.route(/currency-api/, r => {
    if (MOCK.down) return r.abort();
    const u = r.request().url();
    if (u.includes('latest')) return r.fulfill({ json: { date: TODAY, usd: { inr: MOCK.fx, xau: 1 / MOCK.gold } }, headers });
    const d = (u.match(/\d{4}-\d{2}-\d{2}/) || [])[0];
    const v = MOCK.days[d];
    return v ? r.fulfill({ json: { date: d, usd: { inr: v.fx, xau: 1 / v.gold } }, headers }) : r.fulfill({ status: 404, body: 'not found', headers });
  });
  await ctx.route(/api\.frankfurter\.dev/, r => (MOCK.down ? r.abort() : r.fulfill({ json: { date: (r.request().url().match(/\d{4}-\d{2}-\d{2}/) || [TODAY])[0], rates: { INR: MOCK.frank } }, headers })));
}

async function openSaveDlg(p) {
  await p.click('#saveBtn');
  await p.waitForSelector('#saveDlg[open]', { timeout: 15000 });
}

async function setIndiaItem(p) {
  await p.click('#marketSeg [data-v="IN"]');
  await p.click('#curSeg [data-v="INR"]');
  await p.fill('#price', '75,000');
  await p.fill('#wt', '10');
  await p.selectOption('#purity', '22');
  await p.fill('#other', '');
}

try {
  // ======================= A. Calculator (cloud not configured) =======================
  const { server: sA, url: uA } = await serve();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await mockRates(ctx);
  const p = await ctx.newPage();
  watch(p, 'A');
  const transfer = [];
  p.on('response', async r => { try { transfer.push([r.url(), (await r.body()).length]); } catch { /* redirects */ } });
  const t0 = Date.now();
  await p.goto(uA);

  await step('loads with live US rate and no errors', async () => {
    await waitText(p, '#rateStatus', 'Live spot price $2,400/oz');
    check(await p.getAttribute('#marketSeg [data-v="US"]', 'aria-pressed') === 'true', 'US default');
    check(await p.inputValue('#r24') === '2,400', 'r24 ' + await p.inputValue('#r24'));
    check(await p.inputValue('#rK') === '2,200', 'rK');
    check(await p.inputValue('#fx') === '84', 'fx');
    console.log(`   first load + rates: ${Date.now() - t0} ms, ${transfer.length} requests, ${(transfer.reduce((a, [, n]) => a + n, 0) / 1024).toFixed(1)} KB uncompressed`);
  });

  await step('US rate, USD price, 14K with stones', async () => {
    await p.fill('#price', '649');
    await p.fill('#wt', '5.2');
    await p.selectOption('#purity', '14');
    await p.fill('#other', '40');
    await waitText(p, '#mkAmt', '$374.94');
    check(await p.textContent('#mkPct') === '160.2%', 'pct ' + await p.textContent('#mkPct'));
    check(await p.textContent('#mkPctBox') === '160.2% of gold value', 'prominent % ' + await p.textContent('#mkPctBox'));
    check(await p.textContent('#mkPctPriceBox') === '57.8% of price', '% of price ' + await p.textContent('#mkPctPriceBox'));
    check(await p.textContent('#mkGold') === '$234.06', 'gold value tile ' + await p.textContent('#mkGold'));
    check(await p.textContent('#mkPg') === '$72.10', 'per gram ' + await p.textContent('#mkPg'));
    check((await p.textContent('#mkAlt')).includes('₹31,495'), 'alt ' + await p.textContent('#mkAlt'));
    check(!(await p.isDisabled('#saveBtn')), 'save enabled');
  });

  await step('India rate estimate (15% duty), INR price incl. 3% GST, 22K', async () => {
    await setIndiaItem(p);
    await waitText(p, '#mkAmt', '₹4,538');
    check(await p.textContent('#mkPct') === '6.6%', 'pct');
    check(await p.textContent('#mkPctPriceBox') === '6.2% of price before GST', '% of price ' + await p.textContent('#mkPctPriceBox'));
    check(await p.isChecked('#taxIncl'), 'GST included by default for India');
    check(await p.inputValue('#r24') === '74,538.29', 'r24 ' + await p.inputValue('#r24'));
    check((await p.textContent('#dutyNote')).includes('15% import duty'), 'duty note');
    check((await p.textContent('#breakdown')).includes('− GST 3%₹2,184'), 'breakdown ' + await p.textContent('#breakdown'));
  });

  await step('typing the jeweller\'s 22K rate, then changing purity', async () => {
    await p.fill('#rK', '65,000');
    await waitText(p, '#mkAmt', '₹7,816');
    check(await p.textContent('#mkPct') === '12.0%', 'pct');
    await waitText(p, '#rateStatus', 'Using your typed rate');
    check(await visible(p, '#resetRate'), 'reset shown');
    await p.selectOption('#purity', '18');
    await waitText(p, '#mkAmt', '₹19,595');
    check(await p.inputValue('#r24') === '70,960.7', 'r24 kept ' + await p.inputValue('#r24'));
    await p.click('#resetRate');
    await p.selectOption('#purity', '22');
    await waitText(p, '#mkAmt', '₹4,538');
  });

  await step('typing a USD-INR rate and resetting it', async () => {
    await p.fill('#fx', '90');
    await waitText(p, '#priceConv', '$833.33');
    check(await visible(p, '#resetFx'), 'reset fx shown');
    await p.click('#resetFx');
    await waitText(p, '#priceConv', '$892.86');
  });

  await step('historical date uses that day\'s gold, FX and 6% duty', async () => {
    await p.fill('#date', '2024-07-24');
    await waitText(p, '#rateStatus', 'Gold on 24 Jul 2024: $2,408.76/oz');
    await waitText(p, '#mkAmt', '₹9,870');
    check(await p.textContent('#mkPct') === '15.7%', 'pct');
    check((await p.textContent('#dutyNote')).includes('6% import duty'), 'duty 6%');
    check((await p.textContent('#fxStatus')).includes('24 Jul 2024'), 'fx date');
    check(await visible(p, '#todayBtn'), 'today button');
  });

  await step('day missing from the feed falls back to the previous day', async () => {
    await p.fill('#date', '2024-07-25');
    await waitText(p, '#rateStatus', 'using 24 Jul 2024');
  });

  await step('date before 2 Mar 2024 asks for a typed rate', async () => {
    await p.fill('#date', '2023-12-15');
    await waitText(p, '#rateStatus', 'Automatic gold rates start on 2 Mar 2024');
    check(await p.getAttribute('#rateStatus', 'class') === 'status err', 'error style');
    await waitText(p, '#warn', 'Enter the gold rate above.');
    check(await p.isDisabled('#saveBtn'), 'save disabled');
    await waitText(p, '#fxStatus', '15 Dec 2023');
    await p.fill('#r24', '62000');
    await waitText(p, '#mkAmt', '₹16,024');
  });

  await step('Today button returns to live rates and clears typed rate', async () => {
    await p.click('#todayBtn');
    await waitText(p, '#rateStatus', 'Live spot price');
    await waitText(p, '#mkAmt', '₹4,538');
    check(await p.inputValue('#date') === TODAY, 'date today');
  });

  await step('future and too-old dates are clamped', async () => {
    await clearToast(p);
    await p.fill('#date', '2099-01-01');
    await waitText(p, '#toast', 'Future dates are not available');
    check(await p.inputValue('#date') === TODAY, 'clamped to today');
    await p.fill('#date', '2020-01-01');
    await waitText(p, '#toast', 'Rates go back 3 years');
    const min = await p.getAttribute('#date', 'min');
    check(await p.inputValue('#date') === min, 'clamped to min ' + min);
    await p.click('#todayBtn');
    await waitText(p, '#mkAmt', '₹4,538');
  });

  await step('invalid numbers are flagged, never misread', async () => {
    await p.fill('#price', '12,5');
    await waitText(p, '#warn', 'The price is not a valid number.');
    check((await p.getAttribute('#price', 'class')).includes('bad'), 'price red');
    check(await p.isDisabled('#saveBtn'), 'save disabled');
    await p.fill('#price', '75,000');
    await p.fill('#wt', 'abc');
    await waitText(p, '#warn', 'The weight is not a valid number.');
    await p.fill('#wt', '10');
    await p.fill('#taxPct', '99');
    await waitText(p, '#warn', 'Tax % must be');
    await p.fill('#taxPct', '3');
    await p.fill('#price', '50,000');
    await waitText(p, '#warn', 'below the gold value');
    await p.fill('#price', '75,000');
    await waitText(p, '#mkAmt', '₹4,538');
    check(!(await visible(p, '#warn')), 'warning gone');
  });

  await step('inputs survive a reload', async () => {
    await p.waitForTimeout(400);
    await p.reload();
    await waitText(p, '#mkAmt', '₹4,538');
    check(await p.inputValue('#price') === '75,000', 'price kept');
    check(await p.getAttribute('#marketSeg [data-v="IN"]', 'aria-pressed') === 'true', 'market kept');
  });

  await step('save explains when cloud saving is not set up', async () => {
    await openSaveDlg(p);
    check(await p.inputValue('#sName') === '22K · 10 g', 'default name ' + await p.inputValue('#sName'));
    await p.click('#sSave');
    await waitText(p, '#sErr', 'Cloud saving is not set up yet');
    await p.click('#sCancel');
    await p.click('#tabSaved');
    await waitText(p, '#savedGate', 'Cloud saving is not set up yet');
    await p.click('#tabCalc');
  });

  await step('offline: last known rates are reused; with none, typing works', async () => {
    MOCK.down = true;
    const p2 = await ctx.newPage(); watch(p2, 'A2');
    await p2.goto(uA);
    await waitText(p2, '#rateStatus', 'Offline. Using the last known spot price $2,400/oz');
    await waitText(p2, '#mkAmt', '₹4,538');
    await p2.close();
    const fresh = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
    await mockRates(fresh);
    const p3 = await fresh.newPage(); watch(p3, 'A3');
    await p3.goto(uA);
    await waitText(p3, '#rateStatus', 'Could not fetch the gold rate');
    await p3.fill('#price', '300');
    await p3.fill('#wt', '5');
    await p3.fill('#r24', '2500');
    await waitText(p3, '#warn', 'below the gold value');
    await p3.fill('#price', '1500');
    await waitText(p3, '#mkAmt', '$1,131.61');
    await fresh.close();
    MOCK.down = false;
  });

  await step('phone screenshots (light, dark, small screen) without sideways scrolling', async () => {
    await p.screenshot({ path: OUT + 'phone-light.png', fullPage: true });
    const dark = await browser.newContext({ ...devices['iPhone 13'], colorScheme: 'dark', serviceWorkers: 'block' });
    await mockRates(dark);
    const pd = await dark.newPage(); watch(pd, 'dark');
    await pd.goto(uA);
    await pd.fill('#price', '649'); await pd.fill('#wt', '5.2');
    await waitText(pd, '#mkAmt', '$');
    await pd.screenshot({ path: OUT + 'phone-dark.png' });
    await dark.close();
    const se = await browser.newContext({ ...devices['iPhone SE'], serviceWorkers: 'block' });
    await mockRates(se);
    const ps = await se.newPage(); watch(ps, 'se');
    await ps.goto(uA);
    await waitText(ps, '#rateStatus', 'Live');
    const overflow = await ps.evaluate(() => [...document.querySelectorAll('body *')]
      .filter(el => el.getClientRects().length && el.closest('dialog, .visually-hidden') === null)
      .filter(el => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5)
      .map(el => el.id || el.className || el.tagName));
    check(overflow.length === 0, 'cut off on a small screen: ' + overflow.join(', '));
    check(await ps.evaluate(() => document.documentElement.clientWidth) === 320, 'small viewport');
    await ps.screenshot({ path: OUT + 'phone-small.png' });
    await se.close();
  });
  await ctx.close();
  sA.close();

  // ======================= B. Cloud saving (Firebase emulator) =======================
  await reset();
  const uid = await createUser('family@example.com', 'correct-horse-9');
  await loadRules(uid);
  const { server: sB, url: uB } = await serve({ emulator: true, ownerUid: uid });
  const items = () => adminList(`users/${uid}/items`);
  const photos = () => adminList(`users/${uid}/photos`);
  const ctxA = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await mockRates(ctxA);
  const a = await ctxA.newPage(); watch(a, 'B');
  a.on('dialog', d => d.accept());

  await step('owner: Saved asks to sign in; wrong password refused; right one works', async () => {
    await a.goto(uB + '#saved');
    await waitText(a, '#savedGate', 'Sign in to save calculations');
    check(!(await visible(a, '#tabAdmin')), 'no Admin tab before sign-in');
    await a.click('#savedGate button');
    check(await visible(a, '#googleBtn'), 'Google option shown');
    await a.fill('#email', 'family@example.com');
    await a.fill('#password', 'wrong-password');
    await a.click('#signBtn');
    await waitText(a, '#signErr', 'Wrong email or password.');
    await a.fill('#password', 'correct-horse-9');
    await a.click('#signBtn');
    await waitText(a, '#toast', 'Signed in');
    await waitText(a, '#empty', 'No saved items yet');
    await waitText(a, '#savedInfo', '0 of 100 saved');
    check(await visible(a, '#tabAdmin'), 'owner sees the Admin tab');
  });

  await step('save with product link, Hindi notes and phone photo', async () => {
    await a.click('#tabCalc');
    await setIndiaItem(a);
    await waitText(a, '#mkAmt', '₹4,538');
    await openSaveDlg(a);
    await a.fill('#sName', 'Gold bangle');
    await a.fill('#sLink', 'javascript:alert(1)');
    await a.click('#sSave');
    await waitText(a, '#sErr', 'product link does not look right');
    await a.fill('#sLink', 'www.example.com/bangle?id=7');
    await a.fill('#sNotes', 'नमस्ते — wedding set');
    await a.setInputFiles('#sPhoto', FIXTURE);
    await waitText(a, '#sPhotoMsg', 'Photo ready');
    await clearToast(a);
    await a.click('#sSave');
    await waitText(a, '#toast', 'Saved');
    check(!(await a.evaluate(() => document.getElementById('saveDlg').open)), 'dialog closed');
    const docs = await items();
    check(docs.length === 1, 'one item in cloud');
    const f = docs[0].fields;
    check(f.link.stringValue === 'https://www.example.com/bangle?id=7', 'link normalised');
    check(f.photo.booleanValue === true && f.thumb.stringValue.startsWith('data:image/webp') && f.thumb.stringValue.length <= 12000, 'small thumb saved');
    check(Math.round(f.making.doubleValue) === 4538, 'making saved');
    check((await photos()).length === 1, 'photo saved');
  });

  await step('saved list shows the item with thumbnail and making %', async () => {
    await a.click('#tabSaved');
    await waitText(a, '#list', 'Gold bangle');
    const row = await a.textContent('#list li');
    check(row.includes('6.6%') && row.includes('₹4,538') && row.includes('India rate'), 'row ' + row);
    check((await a.getAttribute('#list img', 'src')).startsWith('data:image/webp'), 'thumb');
    check(await a.textContent('#savedCount') === '1', 'badge');
    await waitText(a, '#savedInfo', '1 of 100 saved');
  });

  await step('item detail shows full photo, safe link and facts', async () => {
    await a.click('#list li button');
    await waitText(a, '#iName', 'Gold bangle');
    check(await a.getAttribute('#iLink', 'href') === 'https://www.example.com/bangle?id=7', 'href');
    check(await a.getAttribute('#iLink', 'rel') === 'noopener noreferrer' && await a.getAttribute('#iLink', 'target') === '_blank', 'rel/target');
    check(await a.textContent('#iNotes') === 'नमस्ते — wedding set', 'notes');
    const thumbSrc = await a.getAttribute('#list img', 'src');
    await until(async () => {
      const src = await a.getAttribute('#iPhoto', 'src') || '';
      return src.startsWith('data:image/webp') && src !== thumbSrc && src.length > thumbSrc.length && (await a.textContent('#iPhotoMsg')) === '';
    }, 'full photo replaces the thumbnail');
    const facts = await a.textContent('#iFacts');
    check(facts.includes('Import duty used15%') && facts.includes('22K (91.6%)'), 'facts ' + facts);
    check(facts.includes('Making % of price6.2% (before GST)'), 'detail % of price ' + facts);
  });

  await step('edit: open in calculator, change price, photo kept', async () => {
    await a.click('#iEdit');
    check(await visible(a, '#editBanner'), 'editing banner');
    await waitText(a, '#mkAmt', '₹4,538');
    await a.fill('#price', '80,000');
    await openSaveDlg(a);
    check(await a.inputValue('#sName') === 'Gold bangle', 'name prefilled');
    check(await visible(a, '#sPreview'), 'current photo preview');
    await clearToast(a);
    await a.click('#sSave');
    await waitText(a, '#toast', 'Changes saved');
    const docs = await items();
    check(docs.length === 1, 'still one item');
    const f = docs[0].fields;
    check((f.price.integerValue || f.price.doubleValue) == 80000, 'price updated');
    check(f.photo.booleanValue === true && f.thumb.stringValue.length > 100, 'thumb kept');
    check((await photos()).length === 1, 'photo kept');
  });

  await step('save as new copies the item with its photo; count follows', async () => {
    await a.click('#tabSaved');
    await a.click('#list li button');
    await a.click('#iEdit');
    await a.fill('#wt', '11');
    await openSaveDlg(a);
    await a.fill('#sName', 'Gold bangle (11 g)');
    await clearToast(a);
    await a.click('#sSaveNew');
    await waitText(a, '#toast', 'Saved');
    check((await items()).length === 2 && (await photos()).length === 2, 'copied with photo');
    await a.click('#tabSaved');
    await waitText(a, '#savedInfo', '2 of 100 saved');
  });

  await step('remove a photo while editing, then delete an item', async () => {
    await waitText(a, '#list', 'Gold bangle (11 g)');
    await a.click('#list li:first-child button');
    await waitText(a, '#iName', 'Gold bangle (11 g)');
    await a.click('#iEdit');
    await openSaveDlg(a);
    await a.click('#sRemovePhoto');
    await clearToast(a);
    await a.click('#sSave');
    await waitText(a, '#toast', 'Changes saved');
    check((await photos()).length === 1, 'photo deleted');
    await a.click('#tabSaved');
    const target = (await a.$$('#list li button'))[1];
    await target.click();
    await waitText(a, '#iName', 'Gold bangle');
    await clearToast(a);
    await a.click('#iDelete');
    await waitText(a, '#toast', 'Deleted');
    await until(async () => (await a.$$('#list li')).length === 1, 'list shrinks');
    check((await items()).length === 1 && (await photos()).length === 0, 'cloud cleaned up');
    await waitText(a, '#savedInfo', '1 of 100 saved');
  });

  const ctxW = await browser.newContext({ ...devices['Pixel 7'], serviceWorkers: 'block' });
  await mockRates(ctxW);
  const w = await ctxW.newPage(); watch(w, 'wife');
  await step('second phone (same account): items and settings sync live', async () => {
    await w.goto(uB + '#saved');
    await w.click('#savedGate button');
    await w.fill('#email', 'family@example.com');
    await w.fill('#password', 'correct-horse-9');
    await w.click('#signBtn');
    await waitText(w, '#list', 'Gold bangle (11 g)');
    await w.click('#tabCalc');
    // settings made on the first phone follow to the second one
    await a.click('#tabCalc');
    await a.click('#marketSeg [data-v="IN"]');
    await a.selectOption('#purity', '18');
    await until(async () => (await w.inputValue('#purity')) === '18' && (await w.getAttribute('#marketSeg [data-v="IN"]', 'aria-pressed')) === 'true', 'settings synced to the other phone', 20000);
    await a.selectOption('#purity', '22');
    await w.fill('#price', '649'); await w.fill('#wt', '5.2');
    await waitText(w, '#mkAmt', '₹');
    await openSaveDlg(w);
    await w.fill('#sName', 'Wife ring');
    await w.click('#sSave');
    await waitText(w, '#toast', 'Saved');
    await a.click('#tabSaved');
    await waitText(a, '#list', 'Wife ring');
  });

  await step('reload keeps the sign-in and shows items', async () => {
    await a.reload();
    await waitText(a, '#list', 'Wife ring');
    check(await a.textContent('#savedCount') === '2', 'badge 2');
  });

  await step('saving while offline syncs when back online', async () => {
    await a.click('#tabCalc');
    await setIndiaItem(a);
    await waitText(a, '#mkAmt', '₹');
    await ctxA.setOffline(true);
    await openSaveDlg(a);
    await a.fill('#sName', 'Offline item');
    await clearToast(a);
    await a.click('#sSave');
    await waitText(a, '#toast', 'Saved on this device', 20000);
    await a.click('#tabSaved');
    await waitText(a, '#list', 'Offline item');
    await ctxA.setOffline(false);
    await until(async () => (await items()).some(d => d.fields.name.stringValue === 'Offline item'), 'offline save reaches the cloud', 90000);
  });

  // A friend: Save while signed out -> Google sign-in -> request access -> owner approves.
  const ctxF = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await mockRates(ctxF);
  const fr = await ctxF.newPage(); watch(fr, 'friend');
  await step('friend: Save while signed out leads to Google sign-in, then a request for access', async () => {
    await fr.goto(uB);
    await fr.fill('#price', '649'); await fr.fill('#wt', '5.2');
    await waitText(fr, '#mkAmt', '$');
    await fr.click('#saveBtn');
    await waitText(fr, '#signTitle', 'Sign in');
    await fr.click('#googleBtn');
    await fr.waitForURL(/9099/, { timeout: 15000 });
    await fr.click('text=Add new account');
    await fr.fill('#email-input', 'asha@gmail.com');
    await fr.fill('#display-name-input', 'Asha');
    await fr.click('text=Sign in with Google.com');
    await fr.waitForURL(u => u.toString().startsWith(uB), { timeout: 15000 });
    await waitText(fr, '#toast', 'Ask for access first');
    await waitText(fr, '#savedGate', 'signed in as asha@gmail.com');
    check(await fr.inputValue('#price') === '649', 'calculation kept through sign-in');
    check(!(await visible(fr, '#tabAdmin')), 'friends never see Admin');
    await fr.click('text=Request access');
    await waitText(fr, '#savedGate', 'Your request has been sent');
  });

  await step('owner dashboard: usage, request approval, limits', async () => {
    await a.click('#tabAdmin');
    await waitText(a, '#adminBody', 'Access requests (1)');
    await waitText(a, '#adminBody', 'Asha');
    await waitText(a, '#adminBody', 'has not run yet');
    check((await a.textContent('#adminBody')).includes('Database reads'), 'usage meters');
    check(await visible(a, '#adminDot'), 'Admin tab shows a dot when something waits');
    await a.screenshot({ path: OUT + 'admin.png', fullPage: true });
    await clearToast(a);
    await a.click('#adminBody >> text=Approve');
    await waitText(a, '#toast', 'approved');
    await waitText(a, '#adminBody', 'Access requests (0)');
    await waitText(a, '#adminBody', 'asha@gmail.com');
  });

  await step('dashboard never hangs when the database connection stalls', async () => {
    await a.click('#tabCalc');
    let stall = true;
    await ctxA.route(/127\.0\.0\.1:8080/, r => { if (!stall) return r.continue(); /* never answer */ });
    await a.click('#tabAdmin');
    await a.waitForTimeout(16000);
    const text = await a.textContent('#adminBody');
    check(!/^Loading dashboard/.test(text.trim()), 'still loading after 16 s: ' + text.slice(0, 80));
    stall = false;
    await ctxA.unroute(/127\.0\.0\.1:8080/);
    if (await a.isVisible('#adminBody >> text=Try again')) await a.click('#adminBody >> text=Try again');
    await waitText(a, '#adminBody', 'Free plan usage', 30000);
  });

  await step('friend gets access without reloading, saves privately', async () => {
    await waitText(fr, '#savedInfo', '0 of 100 saved', 20000);
    await fr.click('#tabCalc');
    await openSaveDlg(fr);
    await fr.fill('#sName', 'Asha ring');
    await fr.click('#sSave');
    await waitText(fr, '#toast', 'Saved');
    const asha = (await adminList('members'))[0].name.split('/').pop();
    check((await adminList(`users/${asha}/items`)).length === 1, 'saved in her own space');
    await a.click('#tabSaved');
    await a.waitForTimeout(800);
    check(!(await a.textContent('#list')).includes('Asha ring'), 'owner does not see friends\' items');
  });

  await step('item limit set by the owner is explained to the friend', async () => {
    await a.click('#tabAdmin');
    await waitText(a, '#adminBody', 'Items per person');
    const inputs = await a.$$('#adminBody input');
    await inputs[1].fill('1');
    await a.click('#adminBody >> text=Save limits');
    await waitText(a, '#toast', 'Limits saved');
    await fr.reload();
    await fr.click('#tabCalc');
    await openSaveDlg(fr);
    await fr.fill('#sName', 'Second');
    await fr.click('#sSave');
    await waitText(fr, '#sErr', 'reached the limit of 1 saved items');
    await fr.click('#sCancel');
    await fr.click('#tabSaved');
    await waitText(fr, '#savedInfo', 'limit reached');
  });

  await step('someone new with email: create account, then request access', async () => {
    const ctxI = await browser.newContext({ serviceWorkers: 'block' });
    await mockRates(ctxI);
    const i = await ctxI.newPage(); watch(i, 'newcomer');
    await i.goto(uB + '#saved');
    await i.click('#savedGate button');
    await i.click('#modeBtn');
    await waitText(i, '#signTitle', 'Create an account');
    await i.fill('#suName', 'Ravi');
    await i.fill('#email', 'ravi@example.com');
    await i.fill('#password', 'short');
    await i.click('#signBtn');
    await waitText(i, '#signErr', 'at least 8 characters');
    await i.fill('#password', 'long-enough-1');
    await i.click('#signBtn');
    await waitText(i, '#toast', 'Account created');
    await waitText(i, '#savedGate', 'Request access');
    await ctxI.close();
  });

  await step('sign out clears this device only', async () => {
    await a.click('#settingsBtn');
    await waitText(a, '#acctInfo', 'Signed in as family@example.com (owner)');
    await Promise.all([a.waitForNavigation(), a.click('#signOutBtn')]);
    check(await a.getAttribute('#tabCalc', 'aria-pressed') === 'true', 'leaves the Admin view');
    await a.click('#tabSaved');
    await waitText(a, '#savedGate', 'Sign in to save calculations');
    check(!(await visible(a, '#tabAdmin')), 'Admin tab gone after sign-out');
    const dbs = await a.evaluate(async () => (await indexedDB.databases()).map(d => d.name).filter(n => n.startsWith('firestore/')));
    check(dbs.length === 0, 'offline copy wiped ' + dbs);
    await w.click('#tabSaved');
    await waitText(w, '#list', 'Offline item'); // the other phone is unaffected
  });
  await ctxA.close(); await ctxW.close(); await ctxF.close();
  sB.close();

  // ======================= C. Offline app + updates (service worker) =======================
  const ov = {};
  const { server: sC, url: uC } = await serve({ overrides: ov });
  const ctxS = await browser.newContext({ ...devices['Pixel 7'] });
  await mockRates(ctxS);
  const s = await ctxS.newPage(); watch(s, 'sw');
  let navs = 0;
  s.on('framenavigated', f => { if (f === s.mainFrame()) navs++; });

  await step('first visit installs offline support without reloading', async () => {
    await s.goto(uC);
    await s.evaluate(() => navigator.serviceWorker.ready);
    await s.waitForTimeout(500);
    check(navs === 1, 'no reload loop, navigations=' + navs);
    const keys = await s.evaluate(() => caches.keys());
    check(keys.some(k => k.startsWith('mc-')), 'cache ' + keys);
  });

  await step('opens and calculates with no internet', async () => {
    await s.reload();
    await waitText(s, '#rateStatus', 'Live');
    await ctxS.setOffline(true);
    MOCK.down = true; // routed mocks would otherwise still answer
    await s.reload();
    await waitText(s, '#rateStatus', 'Offline. Using the last known spot price $2,400/oz');
    await s.fill('#price', '649'); await s.fill('#wt', '5.2'); await s.selectOption('#purity', '14'); await s.fill('#other', '40');
    await waitText(s, '#mkAmt', '$374.94');
    check(await s.evaluate(() => !!navigator.serviceWorker.controller), 'served by the offline cache');
    await ctxS.setOffline(false);
    MOCK.down = false;
  });

  await step('new version is picked up automatically (inputs kept)', async () => {
    const swSrc = await readFile(new URL('../docs/sw.js', import.meta.url), 'utf8');
    const appSrc = await readFile(new URL('../docs/app.js', import.meta.url), 'utf8');
    const ver = src => (src.match(/const VERSION = '([^']+)'/) || [])[1];
    check(ver(swSrc) && ver(swSrc) === ver(appSrc), 'VERSION must match in sw.js and app.js');
    const v = ver(swSrc), next = v + '-next';
    ov['sw.js'] = swSrc.replace(`const VERSION = '${v}'`, `const VERSION = '${next}'`);
    ov['app.js'] = appSrc.replace(`const VERSION = '${v}'`, `const VERSION = '${next}'`);
    const before = navs;
    await s.reload();
    await until(async () => navs >= before + 2, 'automatic reload after update', 20000);
    await s.waitForLoadState();
    await s.click('#settingsBtn');
    await waitText(s, '#ver', next);
    await s.click('#setClose');
    check(await s.inputValue('#price') === '649', 'inputs kept across update');
    const keys = await s.evaluate(() => caches.keys());
    check(keys.includes('mc-' + next) && !keys.includes('mc-' + v), 'old cache removed ' + keys);
  });
  await ctxS.close();
  sC.close();

  // ======================= E. Old address forwards to the new one =======================
  {
    const { server: sE, url: uE } = await serve({ realConfig: true });
    const ctxE = await browser.newContext({ serviceWorkers: 'block' });
    await mockRates(ctxE);
    await ctxE.route('https://kratoskumar.github.io/claude_repo/**', async r => {
      const path = new URL(r.request().url()).pathname.replace('/claude_repo/', '');
      const res = await fetch(uE + path);
      r.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'text/html' }, body: Buffer.from(await res.arrayBuffer()) });
    });
    await ctxE.route('https://making-charge.web.app/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>new home</title>' }));
    const e = await ctxE.newPage();
    await step('old GitHub Pages link forwards to making-charge.web.app (keeping #saved)', async () => {
      await e.goto('https://kratoskumar.github.io/claude_repo/#saved');
      await e.waitForURL('https://making-charge.web.app/**', { timeout: 15000 });
      check(e.url() === 'https://making-charge.web.app/#saved', 'forwarded to ' + e.url());
    });
    await ctxE.close();
    sE.close();
  }

  // ======================= D. Real data sources through the real security policy =======================
  const { server: sD, url: uD } = await serve();
  const ctxR = await browser.newContext({ serviceWorkers: 'block' });
  const r = await ctxR.newPage(); watch(r, 'real');
  await step('real live and historical rates load under the security policy', async () => {
    await r.goto(uD);
    await waitText(r, '#rateStatus', 'Live spot price', 20000);
    check(Number((await r.inputValue('#fx')).replace(/,/g, '')) > 50, 'real fx');
    await r.fill('#date', '2024-07-24');
    await waitText(r, '#rateStatus', 'Gold on 24 Jul 2024: $2,408.76/oz', 20000);
  });
  await ctxR.close();
  sD.close();

  if (errors.length) throw new Error('Unexpected browser errors:\n' + errors.join('\n'));
  console.log(`\nAll ${passed} end-to-end steps passed.`);
} catch (e) {
  console.error(`\nFAILED at step "${current}": ${e.message}`);
  if (errors.length) console.error('Browser errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  for (const x of servers) x.close();
  process.exit(process.exitCode || 0);
}
