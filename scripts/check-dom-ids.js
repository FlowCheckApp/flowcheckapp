#!/usr/bin/env node
/**
 * check-dom-ids.js
 *
 * Every document.getElementById('x') must have a matching id="x" somewhere —
 * in index.html, or in a template literal that a renderer writes to innerHTML.
 *
 * This exists because the app has shipped this bug twice, and neither time did
 * anything fail:
 *
 *   1. The transaction edit sheet. openTransactionDetail() and
 *      saveTransactionEdit() look up txn-edit-name / txn-edit-category /
 *      txn-edit-amount / txn-edit-date / txn-edit-original. index.html defines
 *      txn-name-input / txn-cat-select / txn-orig-*. Every lookup returns null,
 *      so the sheet opens blank and Save always bails on "Enter a name".
 *      Editing a transaction is impossible and has been for a long time.
 *
 *   2. Home's count-up animations. _countup() was called with four ids the v8
 *      dashboard rebuild had deleted, so it hit `if (!el) return` every time
 *      and the numbers just appeared, while Money's still animated.
 *
 * Both are the same failure mode: a null lookup is silent. Nothing throws,
 * nothing logs, tests pass, and the feature is simply gone. A renderer that
 * guards with `if (!el) return` is indistinguishable from one that is wired up.
 *
 * KNOWN_ORPHANS is a ratchet, not an allowlist to grow. It holds the ids left
 * behind by the Home v8 rebuild, which are tracked separately for removal.
 * Adding to it should be rare and deliberate; deleting from it is the goal.
 *
 * Exit 0 = clean. Exit 1 = at least one lookup that can never resolve.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'www/index.html',
  'www/js/fc-app.js',
  'www/js/fc-auth.js',
  'www/js/fc-data.js',
  'www/js/fc-iap.js',
  'www/js/fc-push.js',
  'www/js/fc-vault.js',
];

/**
 * Ids still looked up by a renderer whose markup no longer exists. Every one
 * is null-safe — the enclosing code guards and returns — so the only cost is
 * wasted work. This is a RATCHET: it must only ever get shorter, and the check
 * fails if an entry goes stale, so a cleanup cannot silently leave it behind.
 *
 * The large Home v8 batch was removed in the cleanup that took fc-app.js from
 * 13,464 to 12,728 lines. What is left splits into:
 *   - legacy Home ids inside renderers that still do live work elsewhere
 *     (_renderHome, _renderSafeSpendCommand, _drawNetWorthSparkline, the
 *     greeting and notification-badge helpers)
 *   - the registration referral + password-strength ids, which belong to
 *     markup that is built conditionally
 *   - screen-app, read by the privacy sweep against a container that the
 *     current shell does not use
 */
const KNOWN_ORPHANS = new Set([
  // legacy Home surfaces still referenced from live renderers
  // (sparkline-line/-area/-dot/-dot-bg and hero-delta were removed here when
  //  _drawNetWorthSparkline was deleted — every id it read had been gone since
  //  the v8 Home rebuild, so the function guarded on the missing nodes and
  //  did nothing at all. The list only shrinks.)
  'home-user-avatar', 'home-accounts-list', 'home-txn-list', 'home-nw-amount',
  'home-greeting', 'home-acct-skeleton', 'home-txn-skeleton',
  'home-safe-horizon', 'home-runway-scale-high', 'home-runway-scale-mid',
  'home-runway-scale-low', 'home-runway-date-mid', 'home-runway-date-end',
  'home-next-bill-amount', 'hero-networth', 'hero-liabilities', 'home-bills-list',
  'bills-badge', 'fch-cashflow', 'home-month-spent', 'home-goal-card',
  'home-notif-badge', 'smart-insights-list-wrap', 'ins-health-tip', 'wealth-sparkline',
  // spending pulse, still read by _renderHome
  'dash-pulse-row', 'dash-pulse-fill', 'dash-pulse-spent', 'dash-pulse-income',
  'dash-pulse-days', 'dash-pulse-projected', 'dash-pulse-nobudget',
  'dash-pulse-income-label', 'dash-pulse-pct', 'dash-pulse-of-label',
  // credit score buttons, read by the live fetch/refresh handlers
  'credit-connect-btn', 'credit-refresh-btn',
  // registration extras built conditionally
  'reg-pw-strength-label', 'reg-referral-wrap', 'reg-referral-chevron', 'reg-referral-code',
  // privacy sweep container
  'screen-app',
]);

/* ── collect every id that exists anywhere ─────────────────────── */
const sources = FILES.map(rel => ({ rel, src: fs.readFileSync(path.join(ROOT, rel), 'utf8') }));
const all = sources.map(s => s.src).join('\n');

const defined = new Set();
// static markup and template literals: id="x" / id='x'
for (const m of all.matchAll(/\bid\s*=\s*(["'])([A-Za-z_][\w:-]*)\1/g)) defined.add(m[2]);
// escaped inside a JS string: id=\"x\"
for (const m of all.matchAll(/\bid\s*=\s*\\(["'])([A-Za-z_][\w:-]*)\\\1/g)) defined.add(m[2]);
// el.id = 'x'  /  setAttribute('id', 'x')
for (const m of all.matchAll(/\.id\s*=\s*(["'`])([A-Za-z_][\w:-]*)\1/g)) defined.add(m[2]);
for (const m of all.matchAll(/setAttribute\(\s*(["'])id\1\s*,\s*(["'])([A-Za-z_][\w:-]*)\2/g)) defined.add(m[3]);

/* ── collect every static lookup ───────────────────────────────── */
const lookups = new Map(); // id -> "file:line"
let scanned = 0;
for (const { rel, src } of sources) {
  for (const m of src.matchAll(/getElementById\(\s*(["'])([A-Za-z_][\w:-]*)\1\s*\)/g)) {
    scanned++;
    if (!lookups.has(m[2])) {
      lookups.set(m[2], `${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
}
// getElementById(someVariable) is unresolvable statically and is skipped.

const missing = [...lookups.entries()].filter(([id]) => !defined.has(id));
const newlyBroken = missing.filter(([id]) => !KNOWN_ORPHANS.has(id));
const staleEntries = [...KNOWN_ORPHANS].filter(id => defined.has(id) || !lookups.has(id));

console.log(
  `dom-id check: ${scanned} static getElementById calls, ${lookups.size} distinct ids, ` +
  `${defined.size} ids defined`
);

if (newlyBroken.length) {
  console.error(`\n✗ ${newlyBroken.length} getElementById target(s) that exist nowhere:\n`);
  for (const [id, where] of newlyBroken) console.error(`  #${id}\n      looked up at ${where}`);
  console.error(
    '\nThis lookup returns null forever, and null is silent — the feature will\n' +
    'simply not work while every test still passes. Either fix the id to match\n' +
    'the markup, or add the element. Only add to KNOWN_ORPHANS if the code is\n' +
    'genuinely dead and scheduled for removal.\n'
  );
  process.exit(1);
}

if (staleEntries.length) {
  console.error(`\n✗ ${staleEntries.length} stale KNOWN_ORPHANS entr(y/ies):\n`);
  for (const id of staleEntries) {
    console.error(`  #${id} — ${defined.has(id) ? 'now exists in markup' : 'no longer looked up'}`);
  }
  console.error('\nThe orphan list must only shrink. Delete these entries.\n');
  process.exit(1);
}

console.log(
  `✓ every getElementById resolves (${KNOWN_ORPHANS.size} known orphans still pending removal).`
);
