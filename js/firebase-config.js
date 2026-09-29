// Firebase config for the public early-access form.
//
//   Firebase console > Project settings > General > Your apps > Web app
//
// A Firebase web config is public by design and grants no access on its own:
// firestore.rules is what actually protects the data. Keeping it in its own
// file means you can point a local dev server at a scratch project without
// touching index.html.
//
// The console-inserted comments are stripped deliberately — this file is
// committed and served to every visitor.

export const firebaseConfig = {
  apiKey: "AIzaSyB_uiI4nlcyfgyq61ncJCMDodJPeE_OYIY",
  authDomain: "crp-cuby-display.firebaseapp.com",
  projectId: "crp-cuby-display",
  storageBucket: "crp-cuby-display.firebasestorage.app",
  messagingSenderId: "416256804230",
  appId: "1:416256804230:web:a8c7456914b14a4ecc9807",
  measurementId: "G-BYV1GSCM7M",
};

