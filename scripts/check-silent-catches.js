#!/usr/bin/env node
/**
 * check-silent-catches.js
 *
 * A RATCHET on `catch (_) {}` — an empty catch with no explanation.
 *
 * WHY A RATCHET AND NOT A BAN
 * ---------------------------
 * Most of the existing ones are correct. Haptics, analytics, clipboard,
 * listener teardown — all genuinely best-effort, and wrapping them in logging
 * would be noise. Rewriting 91 call sites to prove that would be a large risky
 * diff that buries real changes, for no behavioural gain.
 *
 * What is NOT fine is the number growing. A swallowed error is invisible by
 * construction: no log, no Sentry event, no failing test. The screen just
 * quietly does not update. That is the same failure mode as the switchTab
 * wrapper that silently stopped installing, and as the budget email citing a
 * statistic that could not exist — the app asserting something it cannot back.
 *
 * So: the count may fall, never rise. To add a new one, say why:
 *
 *     catch (_) { /* clipboard is unavailable in this WebView *\/ }
 *
 * A catch carrying a comment is not counted.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

/* Ceilings measured 2026-08-19. LOWER these when you clean some up — never raise. */
const CEILING = {
  'www/js/fc-app.js':   60,
  'www/js/fc-data.js':   5,
  'www/js/fc-auth.js':   7,
  'www/js/fc-core.js':   0,
  'www/js/fc-vault.js':  0,
  'www/index.html':     13,
  'backend/server.js':   6,
};

const BARE = /catch\s*\(\s*_?\w*\s*\)\s*\{\s*\}/g;

let failed = false, total = 0, improved = [];
for (const [rel, max] of Object.entries(CEILING)) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const n = (fs.readFileSync(p, 'utf8').match(BARE) || []).length;
  total += n;
  if (n > max) {
    console.error(`✗ ${rel}: ${n} undocumented empty catches (ceiling ${max})`);
    failed = true;
  } else if (n < max) {
    improved.push(`${rel}: ${n} (ceiling ${max})`);
  }
}

if (failed) {
  console.error('\n  A swallowed error is invisible: no log, no Sentry event, no failing test.');
  console.error('  If the new one is genuinely best-effort, say so inside the braces —');
  console.error('  a catch carrying a comment is not counted.');
  process.exit(1);
}

console.log(`silent-catch ratchet: ${total} undocumented empty catches`);
if (improved.length) {
  console.log('↓ improved since the ceiling was set — lower CEILING in this file:');
  improved.forEach(i => console.log(`    ${i}`));
}
console.log('✓ silent error handling has not grown.');
