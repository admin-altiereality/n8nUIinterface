import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, type User as FirebaseUser, type Auth } from 'firebase/auth';
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

export function getDb(): Firestore {
  if (dataDb) return dataDb;
  dataDb = getFirestore(getOrCreateDataApp());
  return dataDb;
}

/**
 * Get the current authenticated user's UID (from auth app).
 * Used by data operations that need a userId.
 */
export function getCurrentAuthUser(): FirebaseUser | null {
  const auth = getAuthInstance();
  return auth.currentUser;
}

export async function uploadTwilioMediaToStorage(file: File, opts?: { pathPrefix?: string }): Promise<{
  downloadUrl: string;
  storagePath: string;
}> {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured. Add VITE_FIREBASE_* env vars to enable media uploads.');
  }

  const authUser = getCurrentAuthUser();
  const app = getOrCreateDataApp();
  const storage = getStorage(app);

  const prefix = opts?.pathPrefix || 'twilio-media';
  const uid = authUser?.uid || 'anon';
  const safeName = String(file.name || 'upload').replace(/[^\w.-]+/g, '_');
  const storagePath = `${prefix}/${uid}/${Date.now()}-${safeName}`;

  const storageRef = ref(storage, storagePath);
  const metadata = file.type ? { contentType: file.type } : undefined;

  await uploadBytes(storageRef, file, metadata);
  const downloadUrl = await getDownloadURL(storageRef);

  return { downloadUrl, storagePath };
}
