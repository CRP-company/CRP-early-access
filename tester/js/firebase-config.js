// Firebase config for the tester dashboard.
//
// Intentionally identical to admin/js/firebase-config.js and js/firebase-config.js:
// the tester dashboard, the admin dashboard and the CRP Focus app are all one
// Firebase project. That is the whole reason a tester's existing app password
// works here — a different project would mean a different user database and they
// would have to register twice.
//
// A Firebase web config is public by design and grants no access on its own:
// firestore.rules is what actually protects the data. Keeping it in its own file
// means a dev server can point at a scratch project without touching the markup.

export const firebaseConfig = {
  apiKey: "AIzaSyB_uiI4nlcyfgyq61ncJCMDodJPeE_OYIY",
  authDomain: "crp-cuby-display.firebaseapp.com",
  databaseURL: "https://crp-cuby-display-default-rtdb.firebaseio.com",
  projectId: "crp-cuby-display",
  storageBucket: "crp-cuby-display.firebasestorage.app",
  messagingSenderId: "416256804230",
  appId: "1:416256804230:web:a8c7456914b14a4ecc9807",
  measurementId: "G-BYV1GSCM7M",
};