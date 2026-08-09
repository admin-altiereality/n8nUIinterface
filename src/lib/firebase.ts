import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
  type User as FirebaseUser,
  type Auth,
} from 'firebase/auth';
import { getFirestore, doc, getDoc, type Firestore } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';

type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
};

// ─── Auth App (learnxr-evoneuralai) ───
let authApp: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let authDb: Firestore | null = null;

function getAuthConfigFromEnv(): FirebaseConfig | null {
  const apiKey = import.meta.env.VITE_AUTH_FIREBASE_API_KEY as string | undefined;
  const authDomain = import.meta.env.VITE_AUTH_FIREBASE_AUTH_DOMAIN as string | undefined;
  const projectId = import.meta.env.VITE_AUTH_FIREBASE_PROJECT_ID as string | undefined;
  const storageBucket = import.meta.env.VITE_AUTH_FIREBASE_STORAGE_BUCKET as string | undefined;
  const messagingSenderId = import.meta.env.VITE_AUTH_FIREBASE_MESSAGING_SENDER_ID as string | undefined;
  const appId = import.meta.env.VITE_AUTH_FIREBASE_APP_ID as string | undefined;
  const measurementId = import.meta.env.VITE_AUTH_FIREBASE_MEASUREMENT_ID as string | undefined;

  if (!apiKey || !authDomain || !projectId || !storageBucket || !messagingSenderId || !appId) {
    return null;
  }

  return { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId, measurementId };
}

function getOrCreateAuthApp(): FirebaseApp {
  if (authApp) return authApp;
  const cfg = getAuthConfigFromEnv();
  if (!cfg) throw new Error('Auth Firebase is not configured. Add VITE_AUTH_FIREBASE_* env vars.');

  // Check if an app with this name already exists (hot reload safety)
  const existing = getApps().find((a) => a.name === 'auth');
  authApp = existing || initializeApp(cfg, 'auth');
  return authApp;
}

export function getAuthInstance(): Auth {
  if (authInstance) return authInstance;
  authInstance = getAuth(getOrCreateAuthApp());
  return authInstance;
}

export function getAuthDb(): Firestore {
  if (authDb) return authDb;
  authDb = getFirestore(getOrCreateAuthApp());
  return authDb;
}

export function isAuthConfigured(): boolean {
  return Boolean(getAuthConfigFromEnv());
}

export { onAuthStateChanged, signInWithEmailAndPassword, signOut };
export type { FirebaseUser };

/**
 * Fetch the user's role from the `users` collection in the auth project's Firestore.
 * Falls back to 'associate' if no doc or no role field exists.
 */
export async function fetchUserRole(uid: string): Promise<string> {
  try {
    const db = getAuthDb();
    const userDoc = await getDoc(doc(db, 'users', uid));
    if (userDoc.exists()) {
      const data = userDoc.data();
      return data.role || data.userRole || 'associate';
    }
    return 'associate';
  } catch (e) {
    console.warn('Failed to fetch user role from Firestore, defaulting to associate:', e);
    return 'associate';
  }
}

/**
 * Fetch the user's display name from Firestore (fallback to Firebase Auth displayName).
 */
export async function fetchUserDisplayName(uid: string, fallback?: string): Promise<string> {
  try {
    const db = getAuthDb();
    const userDoc = await getDoc(doc(db, 'users', uid));
    if (userDoc.exists()) {
      const data = userDoc.data();
      return data.name || data.displayName || data.firstName || fallback || 'User';
    }
    return fallback || 'User';
  } catch {
    return fallback || 'User';
  }
}


// ─── Data App (lexrn1) — for Firestore runs/logs and Storage ───
let dataApp: FirebaseApp | null = null;
let dataDb: Firestore | null = null;
let dataAuthInstance: Auth | null = null;
let dataAuthBridgePromise: Promise<void> | null = null;

function getDataConfigFromEnv(): FirebaseConfig | null {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY as string | undefined;
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined;
  const storageBucket = import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined;
  const messagingSenderId = import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined;
  const appId = import.meta.env.VITE_FIREBASE_APP_ID as string | undefined;
  const measurementId = import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string | undefined;

  if (!apiKey || !authDomain || !projectId || !storageBucket || !messagingSenderId || !appId) {
    return null;
  }

  return { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId, measurementId };
}

export function isFirebaseConfigured(): boolean {
  return Boolean(getDataConfigFromEnv());
}

function getOrCreateDataApp(): FirebaseApp {
  if (dataApp) return dataApp;
  const cfg = getDataConfigFromEnv();
  if (!cfg) throw new Error('Data Firebase is not configured. Add VITE_FIREBASE_* env vars.');

  const existing = getApps().find((a) => a.name === 'data');
  dataApp = existing || initializeApp(cfg, 'data');
  return dataApp;
}

export function getDataAuth(): Auth {
  if (dataAuthInstance) return dataAuthInstance;
  dataAuthInstance = getAuth(getOrCreateDataApp());
  return dataAuthInstance;
}

export function getDb(): Firestore {
  if (dataDb) return dataDb;
  dataDb = getFirestore(getOrCreateDataApp());
  return dataDb;
}

function dataTokenUrl(): string {
  if (import.meta.env.PROD) return '/api/auth/data-token';

  const proxy = import.meta.env.VITE_API_PROXY_URL as string | undefined;
  if (proxy && !proxy.includes('localhost') && !proxy.includes('127.0.0.1')) {
    return `${proxy.replace(/\/$/, '')}/api/auth/data-token`;
  }

  const upload = (import.meta.env.VITE_UPLOAD_API_URL as string | undefined) || '';
  if (upload && !upload.includes('localhost') && !upload.includes('127.0.0.1')) {
    return `${upload.replace(/\/$/, '')}/api/auth/data-token`;
  }

  return '/api/auth/data-token';
}

const DATA_AUTH_BRIDGE_MAX_ATTEMPTS = 3;
const DATA_AUTH_BRIDGE_BASE_DELAY_MS = 400;

/** Once the bridge fails hard (401/403/404), skip further attempts until the next login. */
let dataAuthBridgeSkipped = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNonRetryableBridgeStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

/**
 * Ensure the data Firebase app has Auth so Firestore/Storage rules see request.auth.
 * Exchanges the Auth-project ID token for a lexrn1 custom token (same uid).
 *
 * Fails soft: on 401/404 (or exhausted retries) logs a warning and returns without throwing,
 * so login and auth-project access still work.
 */
export async function ensureDataAuthSession(authUser: FirebaseUser): Promise<void> {
  if (!isFirebaseConfigured()) return;
  if (dataAuthBridgeSkipped) return;

  const dataAuth = getDataAuth();
  if (dataAuth.currentUser?.uid === authUser.uid) return;

  if (dataAuthBridgePromise) {
    await dataAuthBridgePromise;
    return;
  }

  dataAuthBridgePromise = (async () => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= DATA_AUTH_BRIDGE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const idToken = await authUser.getIdToken(attempt > 1);
        const res = await fetch(dataTokenUrl(), {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const body = (await res.json().catch(() => ({}))) as { customToken?: string; message?: string };

        if (res.ok && body.customToken) {
          await signInWithCustomToken(dataAuth, body.customToken);
          return;
        }

        const message = body.message || `Data auth bridge failed (HTTP ${res.status}).`;
        lastError = new Error(message);

        if (isNonRetryableBridgeStatus(res.status)) {
          dataAuthBridgeSkipped = true;
          console.warn(
            `[auth-bridge] Skipping data Firebase session (HTTP ${res.status}). Continuing with auth-project session only.`,
            message,
          );
          return;
        }

        if (attempt < DATA_AUTH_BRIDGE_MAX_ATTEMPTS) {
          const delay = DATA_AUTH_BRIDGE_BASE_DELAY_MS * 2 ** (attempt - 1);
          console.warn(`[auth-bridge] Attempt ${attempt} failed (HTTP ${res.status}); retrying in ${delay}ms…`);
          await sleep(delay);
          continue;
        }
      } catch (err) {
        lastError = err;
        if (attempt < DATA_AUTH_BRIDGE_MAX_ATTEMPTS) {
          const delay = DATA_AUTH_BRIDGE_BASE_DELAY_MS * 2 ** (attempt - 1);
          console.warn(`[auth-bridge] Attempt ${attempt} threw; retrying in ${delay}ms…`, err);
          await sleep(delay);
          continue;
        }
      }
    }

    dataAuthBridgeSkipped = true;
    console.warn(
      '[auth-bridge] Could not establish data Firebase session after retries. Firestore/Storage may deny until the bridge is fixed.',
      lastError,
    );
  })();

  try {
    await dataAuthBridgePromise;
  } finally {
    dataAuthBridgePromise = null;
  }
}

/** Reset bridge skip flag (call on logout / new login). */
export function resetDataAuthBridge(): void {
  dataAuthBridgeSkipped = false;
  dataAuthBridgePromise = null;
}

export async function signOutDataAuth(): Promise<void> {
  if (!isFirebaseConfigured()) return;
  try {
    await signOut(getDataAuth());
  } catch {
    // ignore
  }
}

/**
 * Get a fresh ID token from the Auth Firebase app (for Cloud Function Authorization headers).
 */
export async function getAuthIdToken(forceRefresh = false): Promise<string | null> {
  if (!isAuthConfigured()) return null;
  const user = getAuthInstance().currentUser;
  if (!user) return null;
  return user.getIdToken(forceRefresh);
}

/**
 * Get the current authenticated user's UID (from auth app).
 * Used by data operations that need a userId.
 */
export function getCurrentAuthUser(): FirebaseUser | null {
  const auth = getAuthInstance();
  return auth.currentUser;
}

/** Prefer data-app Auth when present (matches Firestore/Storage request.auth). */
export function getCurrentDataUser(): FirebaseUser | null {
  if (!isFirebaseConfigured()) return null;
  return getDataAuth().currentUser;
}

export async function uploadTwilioMediaToStorage(file: File, opts?: { pathPrefix?: string }): Promise<{
  downloadUrl: string;
  storagePath: string;
}> {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured. Add VITE_FIREBASE_* env vars to enable media uploads.');
  }

  const authUser = getCurrentAuthUser();
  if (!authUser) {
    throw new Error('Please sign in again before uploading media.');
  }

  await ensureDataAuthSession(authUser);
  const dataUser = getCurrentDataUser();
  if (!dataUser) {
    throw new Error('Media upload is not authorized yet. Please refresh, sign in again, and retry.');
  }

  const app = getOrCreateDataApp();
  const storage = getStorage(app);

  const prefix = opts?.pathPrefix || 'twilio-media';
  const uid = dataUser.uid;
  const safeName = String(file.name || 'upload').replace(/[^\w.-]+/g, '_');
  const storagePath = `${prefix}/${uid}/${Date.now()}-${safeName}`;

  const storageRef = ref(storage, storagePath);
  const metadata = file.type ? { contentType: file.type } : undefined;

  await uploadBytes(storageRef, file, metadata);
  const downloadUrl = await getDownloadURL(storageRef);

  return { downloadUrl, storagePath };
}
