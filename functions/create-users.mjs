/**
 * Creates email/password users in Firebase Auth and writes role docs to Firestore.
 * Run with: BOOTSTRAP_PASSWORD='...' node functions/create-users.mjs
 *
 * SECURITY: Never commit real passwords. Rotate any passwords that were previously
 * hardcoded in this file if they were ever used in production.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'learnxr-evoneuralai';

initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() });

const auth = getAuth();
const db = getFirestore();

const BOOTSTRAP_PASSWORD = process.env.BOOTSTRAP_PASSWORD?.trim();
if (!BOOTSTRAP_PASSWORD || BOOTSTRAP_PASSWORD.length < 12) {
  console.error('Set BOOTSTRAP_PASSWORD (min 12 chars) in the environment. Do not hardcode passwords.');
  process.exit(1);
}

const USERS = [
  { email: 'admin@altiereality.com', name: 'Admin', role: 'superadmin' },
  { email: 'sales@altiereality.com', name: 'Sales Lead', role: 'salesperson' },
  { email: 'bda@altiereality.com', name: 'BDA Associate', role: 'associate' },
  { email: 'wamanager@altiereality.com', name: 'WhatsApp Manager', role: 'whatsapp_manager' },
];

async function main() {
  for (const u of USERS) {
    let uid;
    try {
      const existing = await auth.getUserByEmail(u.email).catch(() => null);
      if (existing) {
        uid = existing.uid;
        console.log(`✔ User already exists: ${u.email} (${uid})`);
        // Optionally rotate password when FORCE_PASSWORD_RESET=1
        if (process.env.FORCE_PASSWORD_RESET === '1') {
          await auth.updateUser(uid, { password: BOOTSTRAP_PASSWORD });
          console.log(`  → Password rotated for ${u.email}`);
        }
      } else {
        const created = await auth.createUser({
          email: u.email,
          password: BOOTSTRAP_PASSWORD,
          displayName: u.name,
          emailVerified: true,
        });
        uid = created.uid;
        console.log(`✔ Created user: ${u.email} (${uid})`);
      }

      await db.collection('users').doc(uid).set({
        email: u.email,
        name: u.name,
        role: u.role,
        createdAt: new Date().toISOString(),
      }, { merge: true });
      console.log(`  → Role doc written: users/${uid} { role: "${u.role}" }`);
    } catch (err) {
      console.error(`✖ Failed for ${u.email}:`, err.message);
    }
  }

  console.log('\nDone! Rotate BOOTSTRAP_PASSWORD after first login; do not reuse shared passwords.');
}

main();
