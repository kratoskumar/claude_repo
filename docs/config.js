// Firebase web-app settings. These values are public by design (they only identify
// the project); data is protected by the security rules in firebase/firestore.rules.
// Paste the values from Firebase console > Project settings > Your apps > Web app.
export const FIREBASE = {
  apiKey: '',
  authDomain: '', // must be the hosting address, e.g. 'making-charge.web.app', for Google sign-in
  projectId: '',
  appId: ''
};

// The owner's User UID (Firebase console > Authentication > Users). Public: it only decides
// who sees the Admin tab; the security rules (filled from this value on deploy) enforce access.
export const OWNER_UID = '';

// Main address of the app. When set, copies opened elsewhere (the old GitHub Pages link or
// the firebaseapp.com address) move to it, so everyone uses one address and one login.
export const CANONICAL_HOST = '';

// Used only by the automated tests (local emulator). Leave as null.
export const EMULATOR = null;
