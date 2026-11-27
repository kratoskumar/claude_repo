// Firebase web-app settings. These values are public by design (they only identify
// the project); data is protected by the security rules in firebase/firestore.rules.
// Paste the values from Firebase console > Project settings > Your apps > Web app.
export const FIREBASE = {
  apiKey: 'AIzaSyCDdWhPFuS24hsY7fYDrAzcZ43bxGl4EsM',
  authDomain: 'mcc.tarveengujral.com', // must equal CANONICAL_HOST: Google sign-in in home-screen apps needs it
  projectId: 'making-charge',
  appId: '1:1000391464579:web:cdcd80526fe33ac80dedb6'
};

// The owner's User UID (Firebase console > Authentication > Users). Public: it only decides
// who sees the Admin tab; the security rules (filled from this value on deploy) enforce access.
export const OWNER_UID = 'YDY4s5ADEHayvyCzu9fRrefLJ4A2';

// Main address of the app. Copies opened at any address in FORWARD_FROM move to it (keeping
// #saved / #admin), so everyone uses one address and one login.
// To go back to the Firebase address: set authDomain and CANONICAL_HOST to 'making-charge.web.app'
// and remove that address from FORWARD_FROM (see README, "Changing the app's address").
export const CANONICAL_HOST = 'mcc.tarveengujral.com';
export const FORWARD_FROM = ['making-charge.web.app', 'making-charge.firebaseapp.com', 'kratoskumar.github.io'];

// Used only by the automated tests (local emulator). Leave as null.
export const EMULATOR = null;
