/**
 * Creates email/password users in Firebase Auth and writes role docs to Firestore.
 * Run with: node scripts/create-users.mjs
 */
import { initializeApp, cert, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT_ID = 'learnxr-evoneuralai';

// Initialize with application default credentials (uses `firebase login` session)
initializeApp({ projectId: PROJECT_ID, credential: applicationDefault() });

const auth = getAuth();
const db = getFirestore();

const USERS = [
  { email: 'admin@altiereality.com',     password: 'adminMyPass123!',  name: 'Admin',            role: 'superadmin' },
  { email: 'sales@altiereality.com',     password: 'SalesMyPass123!',  name: 'Sales Lead',       role: 'salesperson' },
  { email: 'bda@altiereality.com',       password: 'BdaMyPass123!',    name: 'BDA Associate',    role: 'associate' },
  { email: 'wamanager@altiereality.com', password: 'waMyPass123!',     name: 'WhatsApp Manager', role: 'whatsapp_manager' },
];

async function main() {
  for (const u of USERS) {
    let uid;
    try {
      // Check if user already exists
      const existing = await auth.getUserByEmail(u.email).catch(() => null);
      if (existing) {
        uid = existing.uid;
        console.log(`✔ User already exists: ${u.email} (${uid})`);
      } else {
        const created = await auth.createUser({
          email: u.email,
          password: u.password,
          displayName: u.name,
          emailVerified: true,
        });
        uid = created.uid;
        console.log(`✔ Created user: ${u.email} (${uid})`);
      }

      // Write Firestore role doc
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

  console.log('\nDone! All users created and roles assigned.');
}

main();
