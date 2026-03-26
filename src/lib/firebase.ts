import { getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously, type User } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
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

let firebaseApp: FirebaseApp | null = null;
let db: Firestore | null = null;
let signInPromise: Promise<User | null> | null = null;

function getFirebaseConfigFromEnv(): FirebaseConfig | null {
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

  return {
    apiKey,
    authDomain,
    projectId,
    storageBucket,
    messagingSenderId,
    appId,
    measurementId
  };
}

export function isFirebaseConfigured(): boolean {
  return Boolean(getFirebaseConfigFromEnv());
}

function getOrCreateFirebaseApp(): FirebaseApp {
  if (firebaseApp) return firebaseApp;

  const cfg = getFirebaseConfigFromEnv();
  if (!cfg) {
    throw new Error('Firebase is not configured. Add VITE_FIREBASE_* env vars.');
  }

  // Avoid re-initialization across hot reloads.
  firebaseApp = getApps().length ? getApps()[0] : initializeApp(cfg);
  return firebaseApp;
}

export function getDb(): Firestore {
  if (db) return db;
  db = getFirestore(getOrCreateFirebaseApp());
  return db;
}

export async function ensureSignedInAnonymously(): Promise<User | null> {
  if (!isFirebaseConfigured()) return null;

  if (signInPromise) return signInPromise;

  signInPromise = (async () => {
    const auth = getAuth(getOrCreateFirebaseApp());
    if (auth.currentUser) return auth.currentUser;
    try {
      const cred = await signInAnonymously(auth);
      return cred.user ?? null;
    } catch {
      return auth.currentUser ?? null;
    }
  })();

  return signInPromise;
}

export async function uploadTwilioMediaToStorage(file: File, opts?: { pathPrefix?: string }): Promise<{
  downloadUrl: string;
  storagePath: string;
}> {
  if (!isFirebaseConfigured()) {
    throw new Error('Firebase is not configured. Add VITE_FIREBASE_* env vars to enable media uploads.');
  }

  // Ensure auth exists (helps when Storage rules require authenticated users).
  const user = await ensureSignedInAnonymously();
  const app = getOrCreateFirebaseApp();
  const storage = getStorage(app);

  const prefix = opts?.pathPrefix || 'twilio-media';
  const uid = user?.uid || 'anon';
  const safeName = String(file.name || 'upload').replace(/[^\w.\-]+/g, '_');
  const storagePath = `${prefix}/${uid}/${Date.now()}-${safeName}`;

  const storageRef = ref(storage, storagePath);
  const metadata = file.type ? { contentType: file.type } : undefined;

  await uploadBytes(storageRef, file, metadata);
  const downloadUrl = await getDownloadURL(storageRef);

  return { downloadUrl, storagePath };
}

