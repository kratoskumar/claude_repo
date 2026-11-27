// Cloud features (Firebase Auth + Firestore). Loaded only when needed, so the calculator stays light.
// Data layout: members/{uid} (approved people), requests/{uid}, config/app (limits),
// users/{uid} (item count + settings), users/{uid}/items/{id}, users/{uid}/photos/{id},
// stats/{day} and active/{day_uid} (usage numbers for the owner's dashboard).
import { FIREBASE, EMULATOR, OWNER_UID } from './config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
export const DEFAULT_LIMITS = { itemLimit: 100, maxMembers: 25 };
let ready = null;

export const configured = () => !!(FIREBASE && FIREBASE.apiKey && FIREBASE.projectId && FIREBASE.appId);
export const isOwner = u => !!(u && OWNER_UID && u.uid === OWNER_UID);

export function init() {
  if (!ready) {
    ready = (async () => {
      const [{ initializeApp }, A, F] = await Promise.all([
        import(SDK + 'firebase-app.js'),
        import(SDK + 'firebase-auth.js'),
        import(SDK + 'firebase-firestore.js')
      ]);
      const app = initializeApp(FIREBASE);
      const auth = A.initializeAuth(app, {
        persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence],
        popupRedirectResolver: A.browserPopupRedirectResolver
      });
      let db;
      try {
        // Offline cache: saved items open instantly and only changes are downloaded.
        db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
      } catch {
        db = F.getFirestore(app);
      }
      if (EMULATOR) {
        A.connectAuthEmulator(auth, EMULATOR.auth, { disableWarnings: true });
        F.connectFirestoreEmulator(db, EMULATOR.host, EMULATOR.port);
      }
      return { A, F, auth, db };
    })();
    ready.catch(() => { ready = null; }); // allow a retry after a network failure
  }
  return ready;
}

// ---------- sign-in ----------
export async function currentUser() {
  const { auth } = await init();
  await auth.authStateReady();
  return auth.currentUser;
}
export async function onUser(cb) {
  const { A, auth } = await init();
  return A.onAuthStateChanged(auth, cb);
}
export async function signInEmail(email, password) {
  const { A, auth } = await init();
  return A.signInWithEmailAndPassword(auth, email.trim(), password);
}
export async function signUpEmail(email, password, name) {
  const { A, auth } = await init();
  const cred = await A.createUserWithEmailAndPassword(auth, email.trim(), password);
  if (name) await A.updateProfile(cred.user, { displayName: name.trim().slice(0, 60) }).catch(() => {});
  return cred;
}
export async function resetPassword(email) {
  const { A, auth } = await init();
  return A.sendPasswordResetEmail(auth, email.trim());
}
// Google sign-in leaves the page and comes back (works inside home-screen apps too).
export async function signInGoogle() {
  const { A, auth } = await init();
  const p = new A.GoogleAuthProvider();
  p.setCustomParameters({ prompt: 'select_account' });
  return A.signInWithRedirect(auth, p);
}
export async function redirectResult() {
  const { A, auth } = await init();
  return A.getRedirectResult(auth);
}
// Signs out and wipes this device's offline copy of the saved items.
export async function signOut() {
  await flush().catch(() => {});
  const { A, F, auth, db } = await init();
  await A.signOut(auth);
  try {
    await F.terminate(db);
    await F.clearIndexedDbPersistence(db);
  } catch { /* nothing cached */ }
}

// ---------- membership ----------
// cb(true) once the account is approved (the owner always is).
export async function watchMembership(user, cb, onError) {
  if (isOwner(user)) { cb(true); return () => {}; }
  const { F, db } = await init();
  return F.onSnapshot(F.doc(db, 'members', user.uid), s => { count(s); cb(s.exists()); }, onError);
}
export async function getRequest(uid) {
  const { F, db } = await init();
  return (await F.getDoc(F.doc(db, 'requests', uid))).exists();
}
export async function requestAccess(user) {
  const { F, db } = await init();
  return F.setDoc(F.doc(db, 'requests', user.uid), {
    name: (user.displayName || '').slice(0, 100), email: (user.email || '').slice(0, 200), ts: Date.now()
  });
}
export async function getLimits() {
  const { F, db } = await init();
  try {
    const s = await F.getDoc(F.doc(db, 'config', 'app'));
    count(s);
    return { ...DEFAULT_LIMITS, ...(s.exists() ? s.data() : {}) };
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

// users/{uid}: { count, last, set (settings), seen }. Created once, on first use.
export async function watchMeta(uid, cb, onError) {
  const { F, db } = await init();
  const ref = F.doc(db, 'users', uid);
  let created = false;
  return F.onSnapshot(ref, async s => {
    count(s);
    if (!s.exists() && !s.metadata.fromCache && !created) {
      created = true;
      F.setDoc(ref, { count: 0, set: {} }).catch(e => onError && onError(e));
      return;
    }
    if (s.exists()) cb(s.data());
  }, onError);
}
export async function saveSettings(uid, set) {
  const { F, db } = await init();
  track('writes', 1);
  return F.updateDoc(F.doc(db, 'users', uid), { set });
}
let seenAt = 0;
export async function touch(uid) {
  if (Date.now() - seenAt < 30 * 60 * 1000) return;
  seenAt = Date.now();
  const { F, db } = await init();
  track('writes', 1);
  F.updateDoc(F.doc(db, 'users', uid), { seen: Date.now() }).catch(() => {});
  const day = pacificDay();
  const key = `mc:active:${uid}`;
  let marked = null;
  try { marked = localStorage.getItem(key); } catch { /* ignore */ }
  if (marked !== day) {
    track('writes', 1);
    F.setDoc(F.doc(db, 'active', `${day}_${uid}`), { d: day, u: uid })
      .catch(() => {}) // already marked today from another device
      .finally(() => { try { localStorage.setItem(key, day); } catch { /* ignore */ } });
  }
}

// ---------- saved items ----------
export async function watchItems(uid, onData, onError) {
  const { F, db } = await init();
  const q = F.query(F.collection(db, 'users', uid, 'items'), F.orderBy('ts', 'desc'));
  return F.onSnapshot(q, snap => {
    if (!snap.metadata.fromCache) {
      const changed = snap.docChanges();
      track('reads', changed.length);
      track('kb', Math.ceil(changed.reduce((n, c) => n + approxSize(c.doc.data()), 0) / 1024));
    }
    onData(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  }, e => { report(e); onError && onError(e); });
}

// photo: string = set new photo, null = remove photo, undefined = keep as is.
// New items also add 1 to the person's item count in the same atomic write (the rules check this).
export async function saveItem(uid, id, data, photo) {
  const { F, db } = await init();
  const isNew = !id;
  const ref = isNew ? F.doc(F.collection(db, 'users', uid, 'items')) : F.doc(db, 'users', uid, 'items', id);
  const batch = F.writeBatch(db);
  batch.set(ref, data, { merge: !isNew });
  let ops = 1;
  if (isNew) { batch.update(F.doc(db, 'users', uid), { count: F.increment(1), last: ref.id }); ops++; }
  if (typeof photo === 'string') { batch.set(F.doc(db, 'users', uid, 'photos', ref.id), { d: photo }); ops++; }
  else if (photo === null) { batch.delete(F.doc(db, 'users', uid, 'photos', ref.id)); ops++; }
  const done = batch.commit();
  done.then(() => {
    track('writes', ops); track('saves', 1);
    if (typeof photo === 'string') track('photoKB', Math.ceil(photo.length * 0.75 / 1024));
  }, e => { report(e); track('errSave', 1); });
  return { id: ref.id, done };
}

export async function getPhoto(uid, id) {
  const { F, db } = await init();
  const snap = await F.getDoc(F.doc(db, 'users', uid, 'photos', id));
  if (!snap.metadata.fromCache) { track('reads', 1); if (snap.exists()) track('kb', Math.ceil(snap.data().d.length / 1024)); }
  return snap.exists() ? snap.data().d : null;
}

export async function deleteItem(uid, id) {
  const { F, db } = await init();
  const batch = F.writeBatch(db);
  batch.delete(F.doc(db, 'users', uid, 'items', id));
  batch.delete(F.doc(db, 'users', uid, 'photos', id));
  batch.update(F.doc(db, 'users', uid), { count: F.increment(-1), last: id });
  const done = batch.commit();
  done.then(() => { track('deletes', 2); track('writes', 1); }, e => report(e));
  return { done };
}

// Re-open the database connection (after an iPhone home-screen app wakes up).
export async function reconnect() {
  const { F, db } = await init();
  await F.disableNetwork(db);
  await F.enableNetwork(db);
}

// Owner only: the latest result of the hourly monitor job (1 read).
export async function monitorStatus() {
  const { F, db } = await init();
  const s = await F.getDoc(F.doc(db, 'monitor', 'status'));
  return s.exists() ? s.data() : null;
}

// ---------- usage numbers (for the owner's dashboard and alerts) ----------
// Counted on the device and added to stats/{day} at most every few minutes (one small write).
const FIELDS = ['opens', 'reads', 'writes', 'deletes', 'kb', 'saves', 'photoKB', 'errSave', 'errQuota', 'errRates', 'errOther'];
let pending = {};
let canReport = false;
let flushTimer = 0;

// Firebase's free daily quotas reset at midnight Pacific time, so days are counted in that zone.
export const pacificDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(d);

export function track(field, n = 1) {
  if (!FIELDS.includes(field) || !(n > 0)) return;
  pending[field] = Math.min(20000, (pending[field] || 0) + Math.round(n));
  if (canReport && !flushTimer) flushTimer = setTimeout(flush, 5 * 60 * 1000);
}
export function report(e) {
  const code = e && e.code;
  if (code === 'resource-exhausted') track('errQuota', 1);
  else if (code && code !== 'permission-denied' && code !== 'cancelled') track('errOther', 1);
}
export function enableReporting(on) {
  canReport = on;
  if (!on) pending = {};
  else if (Object.keys(pending).length && !flushTimer) flushTimer = setTimeout(flush, 30 * 1000);
}
export async function flush() {
  clearTimeout(flushTimer); flushTimer = 0;
  if (!canReport || !Object.keys(pending).length) return;
  const data = pending; pending = {};
  const { F, db } = await init();
  const inc = {};
  for (const [k, v] of Object.entries(data)) inc[k] = F.increment(v);
  try {
    await F.setDoc(F.doc(db, 'stats', pacificDay()), inc, { merge: true });
  } catch {
    // Keep the numbers for the next try.
    for (const [k, v] of Object.entries(data)) pending[k] = Math.min(20000, (pending[k] || 0) + v);
  }
}

function count(snap) {
  if (snap && !snap.metadata.fromCache) track('reads', 1);
}
function approxSize(data) {
  try { return JSON.stringify(data).length; } catch { return 1024; }
}
