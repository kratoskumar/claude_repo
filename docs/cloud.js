// Cloud saving (Firebase Auth + Firestore). Loaded only when saved items are needed,
// so the calculator itself stays small and fast.
import { FIREBASE, EMULATOR } from './config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
let ready = null;

export const configured = () => !!(FIREBASE && FIREBASE.apiKey && FIREBASE.projectId && FIREBASE.appId);

export function init() {
  if (!ready) {
    ready = (async () => {
      const [{ initializeApp }, A, F] = await Promise.all([
        import(SDK + 'firebase-app.js'),
        import(SDK + 'firebase-auth.js'),
        import(SDK + 'firebase-firestore.js')
      ]);
      const app = initializeApp(FIREBASE);
      // No popup/redirect resolver: email + password only, which avoids loading an extra iframe.
      const auth = A.initializeAuth(app, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence] });
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

export async function onUser(cb) {
  const { A, auth } = await init();
  return A.onAuthStateChanged(auth, cb);
}

// Resolves once the saved sign-in (if any) has been restored on this device.
export async function currentUser() {
  const { auth } = await init();
  await auth.authStateReady();
  return auth.currentUser;
}

export async function signIn(email, password) {
  const { A, auth } = await init();
  return A.signInWithEmailAndPassword(auth, email.trim(), password);
}

// Signs out and wipes this device's offline copy of the saved items.
export async function signOut() {
  const { A, F, auth, db } = await init();
  await A.signOut(auth);
  try {
    await F.terminate(db);
    await F.clearIndexedDbPersistence(db);
  } catch { /* nothing cached */ }
}

export async function watchItems(onData, onError) {
  const { F, db } = await init();
  const q = F.query(F.collection(db, 'items'), F.orderBy('ts', 'desc'));
  return F.onSnapshot(q, snap => onData(snap.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
}

// photo: string = set new photo, null = remove photo, undefined = keep as is.
// Updates merge, so fields left out (thumb/photo when the photo is unchanged) are kept.
// Returns the id at once plus a promise that settles when the server confirms.
export async function saveItem(id, data, photo) {
  const { F, db } = await init();
  const ref = id ? F.doc(db, 'items', id) : F.doc(F.collection(db, 'items'));
  const batch = F.writeBatch(db);
  batch.set(ref, data, { merge: !!id });
  if (typeof photo === 'string') batch.set(F.doc(db, 'photos', ref.id), { d: photo });
  else if (photo === null) batch.delete(F.doc(db, 'photos', ref.id));
  return { id: ref.id, done: batch.commit() };
}

export async function getPhoto(id) {
  const { F, db } = await init();
  const snap = await F.getDoc(F.doc(db, 'photos', id));
  return snap.exists() ? snap.data().d : null;
}

export async function deleteItem(id) {
  const { F, db } = await init();
  const batch = F.writeBatch(db);
  batch.delete(F.doc(db, 'items', id));
  batch.delete(F.doc(db, 'photos', id));
  return { done: batch.commit() };
}
