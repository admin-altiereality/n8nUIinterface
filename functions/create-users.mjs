/**
 * Creates email/password users in Firebase Auth, writes role docs to Firestore and sets the
 * `agentRole` custom claim that the agents API trusts (functions/src/index.ts resolveRole).
 *
 * Run (needs gcloud ADC with access to learnxr-evoneuralai):
 *   AUDIT=1 node functions/create-users.mjs          # list every account holding an agent role
 *   node functions/create-users.mjs                   # set claims for USERS below (existing accounts)
 *   BOOTSTRAP_PASSWORD='...' node functions/create-users.mjs   # also create missing accounts
 *
 * Staff must sign out and back in after their claim changes.
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

const AGENT_ROLES = ['superadmin', 'associate', 'builder', 'salesperson', 'whatsapp_manager'];

// The only accounts that get agent access. Add other staff here (e.g. builders) before running.
const USERS = [
  { email: 'admin@altiereality.com', name: 'Admin', role: 'superadmin' },
  { email: 'sales@altiereality.com', name: 'Sales Lead', role: 'salesperson' },
  { email: 'bda@altiereality.com', name: 'BDA Associate', role: 'associate' },
  { email: 'wamanager@altiereality.com', name: 'WhatsApp Manager', role: 'whatsapp_manager' },
  { email: 'evoneural.ai@gmail.com', name: 'Owner', role: 'superadmin' },
  { email: 'princisharma086@gmail.com', name: 'Princi Sharma', role: 'associate' },
];

const BOOTSTRAP_PASSWORD = process.env.BOOTSTRAP_PASSWORD?.trim();

function requirePassword() {
  if (!BOOTSTRAP_PASSWORD || BOOTSTRAP_PASSWORD.length < 12) {
    console.error('Set BOOTSTRAP_PASSWORD (min 12 chars) in the environment. Do not hardcode passwords.');
    process.exit(1);
  }
}

/** Lists accounts whose users doc or claim carries an agent role, flagging any not in USERS. */
async function audit() {
  const staff = new Set(USERS.map((u) => u.email.toLowerCase()));
  const snap = await db.collection('users').where('role', 'in', AGENT_ROLES).get();
  console.log(`users docs with an agent role: ${snap.size}\n`);
  for (const doc of snap.docs) {
    const data = doc.data();
    const user = await auth.getUser(doc.id).catch(() => null);
    const email = (user?.email || data.email || '').trim().toLowerCase();
    const flag = staff.has(email) ? 'staff' : 'NOT IN STAFF LIST - review';
    console.log(
      `${flag.padEnd(26)} ${email || '(no email)'}  uid=${doc.id}  doc.role=${data.role}` +
        `  claim.agentRole=${user?.customClaims?.agentRole ?? '-'}  disabled=${user?.disabled ?? '?'}`
    );
  }
}

async function main() {
  if (process.env.AUDIT === '1') return audit();

  for (const u of USERS) {
    let uid;
    try {
      const existing = await auth.getUserByEmail(u.email).catch(() => null);
      if (existing) {
        uid = existing.uid;
        console.log(`✔ User already exists: ${u.email} (${uid})`);
        // Optionally rotate password when FORCE_PASSWORD_RESET=1
        if (process.env.FORCE_PASSWORD_RESET === '1') {
          requirePassword();
          await auth.updateUser(uid, { password: BOOTSTRAP_PASSWORD });
          console.log(`  → Password rotated for ${u.email}`);
        }
      } else {
        if (!BOOTSTRAP_PASSWORD) {
          console.log(`- Skipped ${u.email}: no account yet (set BOOTSTRAP_PASSWORD to create it).`);
          continue;
        }
        requirePassword();
        const created = await auth.createUser({
          email: u.email,
          password: BOOTSTRAP_PASSWORD,
          displayName: u.name,
          emailVerified: true,
        });
        uid = created.uid;
        console.log(`✔ Created user: ${u.email} (${uid})`);

        // Only new accounts get a users doc; existing docs are product data and stay untouched.
        await db.collection('users').doc(uid).set({
          email: u.email,
          name: u.name,
          role: u.role,
          createdAt: new Date().toISOString(),
        }, { merge: true });
        console.log(`  → Role doc written: users/${uid} { role: "${u.role}" }`);
      }

      // setCustomUserClaims replaces all claims, so keep any the product already set.
      const { customClaims } = await auth.getUser(uid);
      await auth.setCustomUserClaims(uid, { ...(customClaims || {}), agentRole: u.role });
      console.log(`  → Custom claim set: agentRole="${u.role}"`);
    } catch (err) {
      console.error(`✖ Failed for ${u.email}:`, err.message);
    }
  }

  console.log('\nDone! Staff must sign out and back in to pick up their agentRole claim.');
}

main();
