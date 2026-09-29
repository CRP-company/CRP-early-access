// Admin dashboard Firebase config.
//
// The dashboard talks to the SAME Firebase project as the public site. A
// separate web app registration is recommended so you can enable App Check and
// restrict API keys independently of the public site.
//
//   Firebase console > Project settings > General > Your apps > Web app
//
// Firebase web configs are public by design. Access is controlled by
// firestore.rules and the `admin` custom claim, not by this file.

export const firebaseConfig = {
  apiKey: "REPLACE_ME_API_KEY",
  authDomain: "REPLACE_ME.firebaseapp.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};
