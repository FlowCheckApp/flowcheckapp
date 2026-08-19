#!/usr/bin/env node
/**
 * check-user-scoped-storage.js
 *
 * localStorage keys that hold PER-USER state must be scoped to a uid.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * Onboarding progress was saved under one shared key, 'fc_ob_progress', and
 * cleared only when onboarding COMPLETED — never on sign-out, and
 * _wipeUserState() (which clears twenty-odd pieces of per-account state) did
 * not know about it.
 *
 * So if someone abandoned onboarding partway and a different person signed up
 * on the same device, the newcomer resumed exactly where the previous person
 * stopped. Measured before the fix: a brand-new user landed on slide 4 of 6 at
 * 80% progress, having never seen the security slide, the goal question, the
 * personalisation step or the worked example — and the previous person's
 * selected goal was restored into _selectedGoal, so it rode along into the new
 * user's analytics.
 *
 * Nothing about that is visible in review: the save and load lines are two
 * symmetrical one-liners that look obviously correct on their own.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

/* Keys that carry per-user state. A bare read or write of one of these —
   without a uid in the key — is the bug. */
const PER_USER_KEYS = ['fc_ob_progress'];

const files = ['www/index.html', 'www/js/fc-app.js', 'www/js/fc-auth.js', 'www/js/fc-data.js'];
const problems = [];

for (const rel of files) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) continue;
  fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
    for (const key of PER_USER_KEYS) {
      // setItem/getItem with the bare key as a string literal
      const bare = new RegExp(`(setItem|getItem)\\(\\s*['"]${key}['"]`);
      if (bare.test(line)) {
        problems.push({
          file: rel, line: i + 1, key,
          text: line.trim().slice(0, 100),
          why: 'read/written without a uid — this value belongs to one account',
        });
      }
    }
  });
}

/* removeItem on the bare key is FINE and in fact required: the legacy
   un-namespaced key still exists on devices that onboarded before the fix,
   and it has to be cleaned up. Only reads and writes are the problem. */

if (problems.length) {
  console.error('✗ per-user state stored under a shared localStorage key:\n');
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  '${p.key}' ${p.why}`);
    console.error(`    ${p.text}`);
  }
  console.error('\n  Scope the key to the signed-in uid, or the next person to sign in');
  console.error('  on this device inherits the previous person\'s state.');
  process.exit(1);
}

console.log(`✓ user-scoped storage: ${PER_USER_KEYS.length} per-user key(s), none read or written unscoped`);
