#!/usr/bin/env node
/**
 * check-legal-sync.js — the app and the website must say the same thing.
 *
 * The privacy policy and terms exist in more than one place: www/legal/ is
 * what the app shows in its in-app viewer, and backend/public/legal/ is what
 * Railway serves at getflowcheck.app — the URL on the App Store listing.
 *
 * They are separate files, so nothing stops one being edited and the other
 * forgotten. If that happens the app and the published policy state
 * different terms about the same user's data, which is the kind of
 * discrepancy that is discovered by a regulator rather than by us. They were
 * last committed two months apart when this check was written; the prose had
 * survived intact, but only by luck.
 *
 * Compares PROSE, not bytes. The two copies legitimately differ in styling —
 * the in-app one hides the site nav when framed — and byte equality would
 * fail constantly and be switched off within a week.
 *
 * Exit 0 = the words match. Exit 1 = they have drifted.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const PAIRS = [
  ['www/legal/privacy.html', 'backend/public/legal/privacy.html'],
  ['www/legal/terms.html',   'backend/public/legal/terms.html'],
  /* The bare-path copies Railway also serves. */
  ['backend/public/legal/privacy.html', 'backend/public/privacy.html'],
  ['backend/public/legal/terms.html',   'backend/public/terms.html'],
];

/* Visible words only: no <script>, no <style>, no comments, no tags. */
function prose(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

const failures = [];
let checked = 0;

for (const [a, b] of PAIRS) {
  const pa = prose(a), pb = prose(b);
  if (pa === null) { failures.push(`${a} is missing`); continue; }
  if (pb === null) { failures.push(`${b} is missing`); continue; }
  checked++;
  if (pa === pb) continue;

  /* Show the first sentence that differs — "they differ" is not actionable
     on a 3,000-word document. */
  const sa = pa.split(/(?<=[.!?])\s+/), sb = pb.split(/(?<=[.!?])\s+/);
  let where = 'length only';
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] !== sb[i]) {
      where = `first difference at sentence ${i + 1}:\n`
            + `        app:  ${(sa[i] || '(missing)').slice(0, 110)}\n`
            + `        site: ${(sb[i] || '(missing)').slice(0, 110)}`;
      break;
    }
  }
  failures.push(`${a}\n      and ${b}\n      have drifted — ${where}`);
}

/* A policy that describes a feature the app does not have, or omits one it
   does, is the other half of the same problem. Cheap to assert. */
const privacy = prose('www/legal/privacy.html') || '';
const REQUIRED = [
  [/on-device|on your device/i, 'on-device processing'],
  [/Plaid/i,                    'Plaid'],
  [/not a bank/i,               'the "not a bank" disclaimer'],
];
for (const [re, what] of REQUIRED) {
  if (!re.test(privacy)) failures.push(`the privacy policy no longer mentions ${what}`);
}

console.log(`legal-sync check: ${checked} document pair(s)`);
if (failures.length) {
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error('\n  The app shows www/legal/. The App Store listing points at the');
  console.error('  Railway copy in backend/public/. Both must say the same thing.');
  process.exit(1);
}
console.log('  ✓ the app and the published site state identical terms.');
