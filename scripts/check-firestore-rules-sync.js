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
 * It also checks the SUBCOLLECTIONS under users/{uid} — bills, goals, budgets
 * and the rest — each of which carries its own inline hasOnly() list. That was
 * a blind spot, and it cost exactly what the two failures above cost: the
 * add-bill form collects an `autopay` checkbox, `saveBill` sends it on every
 * update, `autopay` is in no allowlist, and so editing a bill has been silently
 * rejected in production. Adding a bill works, because createBill builds its own
 * object without it. Nothing anywhere said a word.
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

/** Field keys of the object literal starting at `from`, brace-matched.
 *
 * Handles both `key: value` and ES6 shorthand `{ name, amount }`. Shorthand
 * was invisible to the original `key\s*:` scan, which is how `autopay` stayed
 * hidden: the bill payload is written `{ name, amount, due_date, category,
 * frequency, autopay }` with no colons at all, so this reported the write as
 * having no fields and passed it. */
function objectKeys(src, from) {
  const start = src.indexOf('{', from);
  if (start === -1) return [];
  let depth = 0, end = start;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } }
  }
  const body = src.slice(start + 1, end).replace(/\/\/[^\n]*/g, '');

  const keys = [];
  let d = 0;
  const token = /[{}[\]()]|(\.\.\.)?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(:)?/g;
  let m;
  while ((m = token.exec(body)) !== null) {
    const [whole, spread, name, colon] = m;
    if ('{[('.includes(whole)) { d++; continue; }
    if ('}])'.includes(whole)) { d--; continue; }
    if (d !== 0 || !name || spread) continue;

    // `a.b` and `a(…)` are values, not keys.
    const before = body.slice(0, m.index).replace(/\s+$/, '');
    if (before.endsWith('.')) continue;
    const after = body.slice(m.index + whole.length).replace(/^\s+/, '');
    if (!colon && !(after.startsWith(',') || after.startsWith('}') || after === '')) continue;
    if (colon) { keys.push(name); continue; }

    /* Shorthand only counts where a key can appear: at the start of the body
       or straight after a comma. Otherwise `serverTimestamp` in a value
       position would read as a field name. */
    if (before === '' || before.endsWith(',')) keys.push(name);
  }
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

/* ── Subcollection writes ──────────────────────────────────────────────
   Each `match /<name>/{id}` under users/{uid} has its own hasOnly() list. */

/** The brace-matched body of the first `match <pattern>` at or after `from`. */
function matchBlock(src, pattern, from = 0) {
  const at = src.indexOf(pattern, from);
  if (at === -1) return null;
  /* Skip the `{uid}` / `{billId}` wildcard in the path. Taking the first `{`
     after the declaration lands on that instead of the block, which made every
     subcollection body read as the single word "billId" — so nothing had an
     allowlist and everything silently passed. */
  let start = at;
  for (;;) {
    start = src.indexOf('{', start);
    if (start === -1) return null;
    const wildcard = /^\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(src.slice(start));
    if (!wildcard) break;
    start += wildcard[0].length;
  }
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (!depth) return { body: src.slice(start + 1, i), start, end: i };
    }
  }
  return null;
}

const userBlock = matchBlock(rules, 'match /users/{uid}');
const subAllow = new Map();
if (userBlock) {
  const decl = /match\s+\/([a-z_]+)\/\{/g;
  let m;
  while ((m = decl.exec(userBlock.body)) !== null) {
    const block = matchBlock(userBlock.body, m[0], m.index);
    if (!block) continue;
    /* Union of every hasOnly() in the block. Permissive on purpose: create and
       update lists are near-identical here, and a union can only ever fail to
       flag something — never flag something wrongly. A field in NO list, which
       is the failure this exists for, is caught either way. */
    const fields = new Set();
    for (const list of block.body.matchAll(/hasOnly\(\s*\[([\s\S]*?)\]/g)) {
      for (const f of list[1].matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) fields.add(f[1]);
    }
    if (fields.size) subAllow.set(m[1], fields);
    decl.lastIndex = m.index + 1;
  }
}

/** Text of the first argument of a call whose `(` is at `open`. */
function firstArgument(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      depth--;
      if (!depth) return src.slice(open + 1, i).trim();
    } else if (ch === ',' && depth === 1) {
      return src.slice(open + 1, i).trim();
    }
  }
  return '';
}

/* Nearest PRECEDING `const <name> = {` in the same file.

   Nearest and same-file both matter. `const fields` is declared twice in
   fc-app — once account-shaped, once bill-shaped — and taking the first match
   anywhere reported the account fields as a bill write. A check that invents
   findings gets switched off, so this resolves precisely or not at all. */
function literalKeysNear(src, name, before) {
  /* Scoped to the function the reference sits in. Nearest-preceding alone
     reached across function boundaries: the transaction-override call passes a
     `fields` built by a ternary, which is not a plain literal, so the scan
     walked back into saveBill's unrelated `const fields` and reported bill
     fields as a transaction-override write. Out of scope now returns null, and
     null is reported as untraced rather than guessed at. */
  const scopeStart = (() => {
    const fns = [...src.slice(0, before).matchAll(/function\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/g)];
    return fns.length ? fns[fns.length - 1].index : 0;
  })();

  const decl = new RegExp(`const\\s+${name}\\s*=\\s*\\{`, 'g');
  let best = -1, m;
  while ((m = decl.exec(src)) !== null) {
    if (m.index >= before) break;
    if (m.index > scopeStart) best = m.index + m[0].length - 1;
  }
  return best === -1 ? null : objectKeys(src, best);
}

/** The function enclosing `index`, and its parameter names. */
function enclosingFunction(src, index) {
  const before = src.slice(0, index);
  const m = [...before.matchAll(/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g)].pop();
  if (!m) return null;
  return { name: m[1], params: m[2].split(',').map(p => p.trim()).filter(Boolean) };
}

/** Top-level comma split of an argument list. */
function splitArgs(args) {
  const parts = []; let depth = 0, last = 0;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { parts.push(args.slice(last, i)); last = i + 1; }
  }
  parts.push(args.slice(last));
  return parts.map(p => p.trim());
}

/* Follow a spread that is a function parameter out to its callers and union
   the keys they pass. This is the hop that finds `autopay`: updateBill(id,
   fields) spreads a parameter, and the literal lives in fc-app's saveBill, in
   another file. Returns null when nothing could be resolved, so an untraceable
   spread is reported rather than assumed empty. */
function keysFromCallers(fnName, paramIndex) {
  const found = new Set();
  let resolved = false;
  for (const [, text] of Object.entries(sources)) {
    const call = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
    let c;
    while ((c = call.exec(text)) !== null) {
      // Skip the declaration itself.
      if (/function\s*$/.test(text.slice(Math.max(0, c.index - 12), c.index))) continue;
      const open = c.index + c[0].length - 1;
      let depth = 0, end = open;
      for (let i = open; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') { depth--; if (!depth) { end = i; break; } }
      }
      const arg = splitArgs(text.slice(open + 1, end))[paramIndex];
      if (!arg) continue;
      if (arg.startsWith('{')) {
        objectKeys(arg, 0).forEach(k => found.add(k));
        resolved = true;
      } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
        const lit = literalKeysNear(text, arg, c.index);
        if (lit) { lit.forEach(k => found.add(k)); resolved = true; }
      }
    }
  }
  return resolved ? found : null;
}

/** Every field name a write expression would put in the document. */
function writtenKeys(file, src, open, at) {
  const arg = firstArgument(src, open);
  const unresolved = [];
  const keys = new Set();

  let literal = arg;
  if (!arg.startsWith('{')) {
    // `.set(doc, { merge: true })` — the data is a variable, not a literal.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) return { keys, unresolved: [`${arg.slice(0, 24)}…`] };
    const lit = literalKeysNear(src, arg, at);
    if (!lit) return { keys, unresolved: [arg] };
    lit.forEach(k => keys.add(k));
    /* A doc built up by assignment (`doc.name = …`) rather than declared whole.
       Those additions are picked up below. */
    for (const assign of src.slice(0, at).matchAll(new RegExp(`\\b${arg}\\.([A-Za-z_][A-Za-z0-9_]*)\\s*=`, 'g'))) {
      keys.add(assign[1]);
    }
    return { keys, unresolved };
  }

  objectKeys(literal, 0).forEach(k => keys.add(k));
  for (const sp of literal.matchAll(/\.\.\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = sp[1];
    const fn = enclosingFunction(src, at);
    const paramIndex = fn ? fn.params.indexOf(name) : -1;
    if (paramIndex >= 0) {
      const viaCallers = keysFromCallers(fn.name, paramIndex);
      if (viaCallers) { viaCallers.forEach(k => keys.add(k)); continue; }
    } else {
      const lit = literalKeysNear(src, name, at);
      if (lit) { lit.forEach(k => keys.add(k)); continue; }
    }
    unresolved.push(name);
  }
  return { keys, unresolved };
}

const subChecked = [];
const subUnverified = [];
for (const [file, src] of Object.entries(sources)) {
  const write = /collection\(\s*'([a-z_]+)'\s*\)(?:\s*\.\s*doc\([^)]*\))?\s*\.\s*(add|set|update)\s*\(/g;
  let m;
  while ((m = write.exec(src)) !== null) {
    const [, name, kind] = m;
    const allowed = subAllow.get(name);
    if (!allowed) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const open = m.index + m[0].length - 1;
    const { keys, unresolved } = writtenKeys(file, src, open, m.index);

    unresolved.forEach(u =>
      subUnverified.push(`${file}:${line} ${name}.${kind} writes ${u}, which could not be traced`));
    if (!keys.size) continue;

    const bad = [...keys].filter(k => !allowed.has(k));
    subChecked.push(`${file}:${line} ${name}.${kind} [${[...keys].join(', ')}]`);
    if (bad.length) {
      problems.push(`${file}:${line}  ${name}.${kind}() rejects: ${bad.join(', ')} `
        + `— not in the hasOnly() list for /${name}. On an update Firestore tests the `
        + `WHOLE resulting document, so the entire write fails, silently.`);
    }
  }
}

console.log(`create allowlist: ${createAllowed.size} fields`);
console.log(`update allowlist: ${updateAllowed.size} fields`);
console.log(`client write sites checked: ${checked.length} on users/{uid}, `
  + `${subChecked.length} across ${subAllow.size} subcollections`);
checked.forEach(c => console.log('  · ' + c));
subChecked.forEach(c => console.log('  · ' + c));
if (subUnverified.length) {
  console.log('\n  untraced spreads (reported rather than assumed safe):');
  subUnverified.forEach(u => console.log('    ? ' + u));
}

if (problems.length) {
  console.error('\n✗ DO NOT DEPLOY — these client writes would be rejected:\n');
  problems.forEach(p => console.error('  ' + p));
  console.error('\nFix the client field or add it to the allowlist in firestore.rules.\n');
  process.exit(1);
}

console.log('\n✓ every client write to users/{uid} and its subcollections is covered.');
