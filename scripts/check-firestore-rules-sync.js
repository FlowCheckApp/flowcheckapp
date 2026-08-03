#!/usr/bin/env node
/**
 * check-firestore-rules-sync.js
 *
 * RUN THIS BEFORE EVERY `firebase deploy --only firestore:rules`.
 *
 * firestore.rules gates users/{uid} writes with hasOnly() allowlists. If the
 * client writes ANY field missing from the matching allowlist, the whole write
 * is rejected — and because most call sites swallow the error (.catch(() => {}))
 * the failure is silent. This has bitten twice:
 *
 *   1. `pro: false` in the signup doc → users/{uid} create rejected → signup
 *      broken for every new user. Fixed at the email/password path but left
 *      live in the Google and Apple paths for weeks, because the original
 *      check only parsed `const doc = {`.
 *   2. welcome_seen / milestones_seen / feedback_banner_dismissed written by
 *      FCData.updateUserField() but absent from allowedUserUpdateFields().
 *
 * So this script checks EVERY create and update path, not just one.
 *
 * Exit 0 = safe to deploy. Exit 1 = deploying would break something.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const rules = read('firestore.rules');
const sources = {
  'www/js/fc-auth.js': read('www/js/fc-auth.js'),
  'www/js/fc-app.js':  read('www/js/fc-app.js'),
  'www/js/fc-data.js': read('www/js/fc-data.js'),
  'www/js/fc-push.js': read('www/js/fc-push.js'),
  'www/index.html':    read('www/index.html'),
};

/** Pull the quoted field names out of a rules allowlist helper. */
function allowlist(fnName) {
  const m = rules.match(new RegExp(`function\\s+${fnName}\\s*\\(\\)\\s*\\{([\\s\\S]*?)\\n\\s*\\}`));
  if (!m) throw new Error(`could not find ${fnName}() in firestore.rules`);
  // strip // comments so commented-out field names don't count as allowed
  const body = m[1].replace(/\/\/[^\n]*/g, '');
  return new Set([...body.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)].map(x => x[1]));
}

/** Field keys of the object literal starting at `from`, brace-matched. */
function objectKeys(src, from) {
  const start = src.indexOf('{', from);
  if (start === -1) return [];
  let depth = 0, end = start;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const body = src.slice(start + 1, end).replace(/\/\/[^\n]*/g, '');
  // top-level keys only: skip anything nested inside a deeper brace
  const keys = [];
  let d = 0;
  body.replace(/[{}]|([A-Za-z_][A-Za-z0-9_]*)\s*:/g, (tok, key, off) => {
    if (tok === '{') d++;
    else if (tok === '}') d--;
    else if (key && d === 0) keys.push(key);
    return tok;
  });
  return keys;
}

const createAllowed = allowlist('allowedUserCreateFields');
const updateAllowed = allowlist('allowedUserUpdateFields');

const problems = [];
const checked  = [];

/* ── Security invariants ────────────────────────────────────────────────
   Entitlement and identity fields must never become client-updatable. A
   client that can set these can grant itself Pro or steal referral credit.
   `pro` is tolerated at CREATE (pinned to false, see firestore.rules) but
   must never appear in the update list. */
const NEVER_CLIENT_UPDATABLE = [
  'pro', 'is_pro', 'plaid_linked', 'referral_code', 'referred_by_uid',
  'plaid_account_mask', 'plaid_institution',
];
for (const f of NEVER_CLIENT_UPDATABLE) {
  if (updateAllowed.has(f)) {
    problems.push(`SECURITY: '${f}' is in allowedUserUpdateFields() — a client could set it. Remove it.`);
  }
}
// `pro` at create is only safe while the value is pinned to false.
if (createAllowed.has('pro') && !/function\s+proFieldIsHarmless\s*\(\)/.test(rules)) {
  problems.push(`SECURITY: 'pro' is in allowedUserCreateFields() but proFieldIsHarmless() is gone — a client could create with pro:true.`);
}

for (const [file, src] of Object.entries(sources)) {
  // --- writes to users/{uid} via .set(...) or .update(...) -----------------
  const re = /(?:collection\(['"]users['"]\)\.doc\([^)]*\)|_db\.collection\(['"]users['"]\)\.doc\([^)]*\))\s*\.\s*(set|update)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const kind = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    const keys = objectKeys(src, m.index + m[0].length - 1);
    if (!keys.length) continue;                    // e.g. update({ [field]: value })
    const isMerge = /\{\s*merge\s*:\s*true\s*\}/.test(src.slice(m.index, m.index + 900));

    // Which allowlist governs the write:
    //   .update(...)          → always an existing doc  → update list
    //   .set(...) bare        → create
    //   .set(..., merge:true) → EITHER. Firestore routes a merge onto a
    //     missing doc to `allow create` and onto an existing doc to
    //     `allow update`, and our merge call sites are exactly the
    //     "doc was not found" fallbacks. So a merged field must satisfy both.
    let which, allowed;
    if (kind === 'update')      { which = 'update';        allowed = updateAllowed; }
    else if (!isMerge)          { which = 'create';        allowed = createAllowed; }
    else                        { which = 'create+update'; allowed = null; }

    // `uid` is exempt on the update side only: allowedUserUpdateFields() uses
    // diff().affectedKeys(), which reports only keys whose VALUE changed.
    // Re-writing uid with its own identical value is a no-op and never shows up.
    const IDENTITY = new Set(['uid']);

    const bad = allowed
      ? keys.filter(k => !allowed.has(k))
      : keys.filter(k => !createAllowed.has(k) || (!updateAllowed.has(k) && !IDENTITY.has(k)));

    checked.push(`${file}:${line} ${which} [${keys.join(', ')}]`);
    if (bad.length) problems.push(`${file}:${line}  ${which} write rejects: ${bad.join(', ')}`);
  }

  // --- single-field writes via FCData.updateUserField('name', …) -----------
  const uf = /updateUserField\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;
  while ((m = uf.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    // updateUserField() tries .update() first and falls back to set+merge on
    // not-found, so the field must be in BOTH allowlists.
    checked.push(`${file}:${line} create+update [${m[1]}]`);
    if (!updateAllowed.has(m[1])) {
      problems.push(`${file}:${line}  updateUserField('${m[1]}') rejected — not in allowedUserUpdateFields()`);
    }
    if (!createAllowed.has(m[1])) {
      problems.push(`${file}:${line}  updateUserField('${m[1]}') rejected on the not-found set+merge fallback — not in allowedUserCreateFields()`);
    }
  }
}

console.log(`create allowlist: ${createAllowed.size} fields`);
console.log(`update allowlist: ${updateAllowed.size} fields`);
console.log(`client write sites checked: ${checked.length}`);
checked.forEach(c => console.log('  · ' + c));

if (problems.length) {
  console.error('\n✗ DO NOT DEPLOY — these client writes would be rejected:\n');
  problems.forEach(p => console.error('  ' + p));
  console.error('\nFix the client field or add it to the allowlist in firestore.rules.\n');
  process.exit(1);
}

console.log('\n✓ every client write to users/{uid} is covered by the rules allowlists.');
