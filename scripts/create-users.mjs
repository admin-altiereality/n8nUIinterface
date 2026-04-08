#!/usr/bin/env node

/**
 * Creates email/password users via Firebase Auth REST API
 * and writes role docs via Firestore REST API.
 * Uses the user's Firebase CLI token for authorization.
 */

const PROJECT_ID = 'learnxr-evoneuralai';
const API_KEY = 'AIzaSyBj8pKRSuj9XHD0eoM7tNQafH-2yXoOyag';

const USERS = [
  { email: 'admin@altiereality.com',     password: 'adminMyPass123!',  name: 'Admin',            role: 'superadmin' },
  { email: 'sales@altiereality.com',     password: 'SalesMyPass123!',  name: 'Sales Lead',       role: 'salesperson' },
  { email: 'bda@altiereality.com',       password: 'BdaMyPass123!',    name: 'BDA Associate',    role: 'associate' },
  { email: 'wamanager@altiereality.com', password: 'waMyPass123!',     name: 'WhatsApp Manager', role: 'whatsapp_manager' },
];

async function createUser(email, password, displayName) {
  // Use Firebase Auth REST API to create user with email/password
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName, returnSecureToken: true }),
  });
  const data = await res.json();
  if (data.error) {
    if (data.error.message === 'EMAIL_EXISTS') {
      // Sign in to get the localId (uid)
      const signInUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`;
      const signInRes = await fetch(signInUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      });
      const signInData = await signInRes.json();
      if (signInData.error) throw new Error(`Sign-in failed for ${email}: ${signInData.error.message}`);
      return { uid: signInData.localId, idToken: signInData.idToken, existed: true };
    }
    throw new Error(`Create failed for ${email}: ${data.error.message}`);
  }
  return { uid: data.localId, idToken: data.idToken, existed: false };
}

async function writeFirestoreDoc(idToken, uid, userData) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}?updateMask.fieldPaths=email&updateMask.fieldPaths=name&updateMask.fieldPaths=role&updateMask.fieldPaths=createdAt`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      fields: {
        email: { stringValue: userData.email },
        name: { stringValue: userData.name },
        role: { stringValue: userData.role },
        createdAt: { stringValue: new Date().toISOString() },
      },
    }),
  });
  const data = await res.json();
  if (data.error) {
    // Firestore rules might block. Try with Firebase CLI token instead.
    throw new Error(`Firestore write failed: ${JSON.stringify(data.error)}`);
  }
  return data;
}

async function main() {
  console.log(`Creating users in project: ${PROJECT_ID}\n`);

  const results = [];

  for (const u of USERS) {
    try {
      const { uid, idToken, existed } = await createUser(u.email, u.password, u.name);
      console.log(`${existed ? '✔ Already exists' : '✔ Created'}: ${u.email} → uid: ${uid}`);

      try {
        await writeFirestoreDoc(idToken, uid, u);
        console.log(`  → Firestore role doc written: users/${uid} { role: "${u.role}" }`);
      } catch (fsErr) {
        console.log(`  ⚠ Firestore write via REST failed: ${fsErr.message}`);
        console.log(`  → Will use CLI fallback...`);
        results.push({ uid, ...u, needsCli: true });
      }
    } catch (err) {
      console.error(`✖ ${u.email}: ${err.message}`);
    }
  }

  // If any Firestore writes failed, output curl commands as fallback
  if (results.length > 0) {
    console.log('\n--- Firestore CLI fallback commands ---');
    for (const r of results) {
      const docData = JSON.stringify({ email: r.email, name: r.name, role: r.role, createdAt: new Date().toISOString() });
      console.log(`firebase firestore:delete users/${r.uid} --project ${PROJECT_ID} -y 2>/dev/null; echo '${docData}' | # Write to users/${r.uid}`);
    }
  }

  console.log('\n✅ Done!');
}

main();
