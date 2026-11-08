import { initializeApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut as fbSignOut,
} from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { connectAuthEmulator } from 'firebase/auth';

const env = import.meta.env;
export const configured = Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID);

export const app = configured ? initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
}) : null;

export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;

// Local testing against the Firebase emulators (npm run emulate).
const EMULATOR = env.VITE_EMULATOR === '1';
if (EMULATOR && app) {
  connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, location.hostname, 8080);
  // Test hook: the auth emulator accepts an unsigned Google ID token.
  window.__testSignIn = async (sub, name) => {
    const { signInWithCredential } = await import('firebase/auth');
    const idToken = JSON.stringify({ sub, email: `${sub}@example.com`, email_verified: true, name });
    await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    keepToken({});
  };
}

// drive.file: we can only see and touch files this app created. Non-sensitive scope.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'hundred.driveToken';

function provider() {
  const p = new GoogleAuthProvider();
  p.addScope(DRIVE_SCOPE);
  if (auth?.currentUser?.email) p.setCustomParameters({ login_hint: auth.currentUser.email });
  return p;
}

function keepToken(result) {
  const cred = result && GoogleAuthProvider.credentialFromResult(result);
  if (!cred?.accessToken && !EMULATOR) return;
  // Google access tokens last an hour. Refresh a little early.
  const t = { token: cred?.accessToken || 'emulator-token', exp: Date.now() + 55 * 60 * 1000 };
  try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t)); } catch {}
}

/** The Drive token if we have a fresh one, without prompting. */
export function cachedDriveToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    if (t && t.exp > Date.now()) return t.token;
  } catch {}
  return null;
}

/**
 * Sign in (or refresh the Drive token). Must be called straight from a tap,
 * before any other await, or Safari blocks the popup.
 */
export async function signIn() {
  try {
    const result = await signInWithPopup(auth, provider());
    keepToken(result);
    return result.user;
  } catch (e) {
    if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
      sessionStorage.setItem('hundred.returnTo', location.hash);
      await signInWithRedirect(auth, provider());
      return null;
    }
    throw e;
  }
}

/** Get a Drive token, prompting only if needed. Call from a tap handler. */
export async function driveToken() {
  const t = cachedDriveToken();
  if (t) return t;
  await signIn();
  const fresh = cachedDriveToken();
  if (!fresh) throw new Error('Google did not grant Drive access. Tick the Drive box when signing in.');
  return fresh;
}

export function forgetDriveToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
}

export async function finishRedirect() {
  if (!auth) return;
  try {
    const r = await getRedirectResult(auth);
    if (r) {
      keepToken(r);
      const back = sessionStorage.getItem('hundred.returnTo');
      sessionStorage.removeItem('hundred.returnTo');
      if (back) location.hash = back;
    }
  } catch (e) { console.warn('redirect sign-in failed', e); }
}

export function onUser(cb) { return auth ? onAuthStateChanged(auth, cb) : cb(null); }
export async function signOut() { forgetDriveToken(); await fbSignOut(auth); }
