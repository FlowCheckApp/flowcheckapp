#!/usr/bin/env node
/**
 * grandfather-existing-users.js
 *
 * One-time backfill. Sets `grandfathered: true` on every user who was already
 * using FlowCheck when the subscription requirement shipped, so that tightening
 * monetisation never locks somebody out of data they had already connected.
 *
 * Who qualifies: any account with a linked Plaid item, in either storage
 * layout — users/{uid}/plaid_items/* (current) or the legacy top-level
 * plaid_items/{uid}. Checking only the subcollection would miss the earliest
 * users, who are precisely the people this is meant to protect.
 *
 * `grandfathered` is server-only: it appears in neither Firestore rules
 * allowlist, and both use hasOnly(), so a client that tries to write it has the
 * whole update rejected. Same protection as is_pro.
 *
 * RUN IT ONCE, BEFORE the gate reaches users. Order matters — gate first and
 * existing users are locked out until this finishes.
 *
 *   node backend/scripts/grandfather-existing-users.js --dry-run   # report only
 *   node backend/scripts/grandfather-existing-users.js --apply     # write
 *
 * Needs the same GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT the
 * server uses. Dry run is the default; --apply is required to write anything.
 */
'use strict';

const admin = require('firebase-admin');

const APPLY = process.argv.includes('--apply');
if (!APPLY && !process.argv.includes('--dry-run')) {
  console.log('Neither --apply nor --dry-run given; defaulting to --dry-run.\n');
}

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  admin.initializeApp(
    raw ? { credential: admin.credential.cert(JSON.parse(raw)) } : undefined
  );
}
const db = admin.firestore();

(async () => {
  const users = await db.collection('users').get();
  let qualify = 0, already = 0, skipped = 0, written = 0;
  let batch = db.batch(), pending = 0;

  for (const doc of users.docs) {
    const data = doc.data() || {};
    if (data.grandfathered === true) { already++; continue; }

    // Current layout first — one read, and most users are here.
    const sub = await doc.ref.collection('plaid_items').limit(1).get();
    let linked = !sub.empty;
    // Legacy top-level doc — the early accounts this exists for.
    if (!linked) {
      linked = (await db.collection('plaid_items').doc(doc.id).get()).exists;
    }

    if (!linked) { skipped++; continue; }
    qualify++;

    if (APPLY) {
      batch.update(doc.ref, {
        grandfathered:    true,
        grandfathered_at: admin.firestore.FieldValue.serverTimestamp(),
      });
      pending++;
      if (pending === 400) {           // Firestore caps a batch at 500
        await batch.commit();
        written += pending;
        batch = db.batch();
        pending = 0;
      }
    }
  }

  if (APPLY && pending) { await batch.commit(); written += pending; }

  console.log(`users scanned      : ${users.size}`);
  console.log(`already grandfathered: ${already}`);
  console.log(`qualify (has a bank) : ${qualify}`);
  console.log(`no bank, skipped     : ${skipped}`);
  console.log(APPLY ? `WRITTEN            : ${written}` : '\nDRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
})().catch(err => {
  console.error('backfill failed:', err);
  process.exit(1);
});
