#!/usr/bin/env node
/**
 * check-email-consent.js
 *
 * Two things, and they pull in opposite directions.
 *
 * MARKETING MAIL MUST STOP WHEN SOMEBODY UNSUBSCRIBES. The preference used to
 * be checked at the call sites — `userData.email_alerts_enabled !== false`,
 * written out twelve times — and nine sends did not have it. The weekly recap,
 * the monthly recap, the whole four-part onboarding drip, a win-back nudge, the
 * year in review and an "almost set up" reminder all went to people who had
 * unsubscribed, each carrying a one-click unsubscribe header that did nothing.
 * The check now lives inside `_sendEmail`, so forgetting is no longer possible.
 *
 * SECURITY MAIL MUST NOT STOP. The moment that gate went in, a verification
 * code and a new-sign-in alert became suppressible by a marketing preference —
 * which would lock somebody out of their own account for having unsubscribed
 * from a newsletter. Those are marked `transactional: true`, and this asserts
 * they stay marked.
 *
 * Exit 0 = the gate is in place and the codes still get through.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const rel = 'backend/server.js';
const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
const failures = [];

/* ── 1. The gate itself ──────────────────────────────────────────────── */

const sendFn = /async function _sendEmail\([\s\S]*?\n\}/.exec(src);
if (!sendFn) {
  failures.push(`${rel} — _sendEmail is gone; nothing enforces consent.`);
} else {
  const body = sendFn[0];
  if (!/email_alerts_enabled\s*===\s*false/.test(body)) {
    failures.push(`${rel} — _sendEmail no longer checks email_alerts_enabled. `
      + `Without it every recap, nudge and drip goes to people who unsubscribed, `
      + `under a one-click unsubscribe header that does nothing.`);
  }
  if (!/transactional/.test(body)) {
    failures.push(`${rel} — _sendEmail no longer honours a transactional flag, `
      + `so a verification code can be suppressed by a marketing preference.`);
  }
  /* Fail closed. If the preference cannot be read we do not know whether they
     consented, and sending is the outcome that cannot be taken back. */
  const consentBlock = /if \(uid && !transactional\)[\s\S]*?\n  \}/.exec(body);
  if (!consentBlock || !/return false/.test(consentBlock[0])) {
    failures.push(`${rel} — the consent check no longer fails closed. A read `
      + `error must stop the send, not fall through to it.`);
  }
}

/* ── 2. Mail that must never be suppressed ───────────────────────────── */

/* Subjects a person cannot afford to miss for having unsubscribed. Each must
   pass `transactional: true`, which is checked by finding the flag inside the
   call that starts at the subject. */
const MUST_REACH = [
  ['is your FlowCheck verification code', 'without it they cannot sign in at all'],
  ['New sign-in to your FlowCheck account', 'a security alert is not marketing'],
  ['Your FlowCheck account has been deleted', 'confirms an erasure they asked for'],
  ['You are now FlowCheck Pro', 'a receipt for money they paid'],
];

const lines = src.split('\n');
for (const [subject, why] of MUST_REACH) {
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(subject) || !/_sendEmail\(/.test(lines.slice(i, i + 3).join(' '))) {
      continue;
    }
    found = true;
    // Walk to the end of this call and look for the flag.
    const chunk = lines.slice(i, i + 40).join('\n');
    const end = chunk.indexOf('});');
    const call = end === -1 ? chunk : chunk.slice(0, end + 3);
    if (!/transactional:\s*true/.test(call)) {
      failures.push(`${rel}:${i + 1} "${subject}" is not marked transactional — `
        + `${why}. An unsubscribed user would stop receiving it.`);
    }
  }
  if (!found) {
    failures.push(`${rel} — no send found for "${subject}". If it was renamed, `
      + `update MUST_REACH in scripts/check-email-consent.js so it stays covered.`);
  }
}

if (failures.length) {
  console.error(`✗ email consent — ${failures.length} problem(s):\n`);
  failures.forEach(f => console.error('  ' + f));
  console.error('');
  process.exit(1);
}

const marked = (src.match(/transactional:\s*true/g) || []).length;
console.log(`email consent: gate enforced in _sendEmail, fails closed, `
  + `${marked} transactional sends exempt`);
console.log('✓ marketing stops on unsubscribe; verification codes still arrive.');
