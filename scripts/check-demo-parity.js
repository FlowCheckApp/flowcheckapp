#!/usr/bin/env node
/**
 * check-demo-parity.js
 *
 * App Review cannot evaluate FlowCheck the way a customer would — they have no
 * US bank credentials to put through Plaid — so both apps recognise a reviewer
 * account that shows fabricated data and touches no real account. CLAUDE.md
 * names demo mode as how review happens.
 *
 * The list of reviewer addresses now exists twice: `_DEMO_EMAILS` in
 * www/js/fc-app.js, and `DemoAccount.emails` in the native app. Two copies of
 * one fact drift, and this one drifts silently in the worst possible direction:
 * change the address in one app and review passes there and fails in the other,
 * with the rejection arriving days later and naming neither file.
 *
 * The native repository is nested inside this one. When it is absent — a
 * web-only checkout — this check passes rather than failing on something the
 * developer cannot see.
 *
 * Exit 0 = the lists agree. Exit 1 = they have drifted.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const webRel = 'www/js/fc-app.js';
const nativeRel = 'FlowCheckSwiftUI/FlowCheckSwiftUI/App/AppRuntime.swift';
const nativePath = path.join(root, nativeRel);

if (!fs.existsSync(nativePath)) {
  console.log('demo parity: native app not present in this checkout — skipped');
  process.exit(0);
}

const failures = [];

/** Addresses inside a bracketed list literal, in source order. */
function addressesIn(text) {
  return [...text.matchAll(/'([^']+@[^']+)'|"([^"]+@[^"]+)"/g)]
    .map(m => (m[1] || m[2]).trim().toLowerCase());
}

function listLiteral(source, marker, pattern, file) {
  // Match the DECLARATION, not the first use. Searching for the bare name
  // found `if (!_DEMO_EMAILS.includes(...))` hundreds of lines earlier and
  // read the next unrelated bracket as the list — reporting it empty.
  const found = pattern.exec(source);
  if (!found) {
    failures.push(`${file} — \`${marker}\` not found. The reviewer account is `
      + `what lets App Review see the product; losing it fails review.`);
    return null;
  }
  const open = source.indexOf('[', found.index);
  const close = source.indexOf(']', open);
  if (open === -1 || close === -1) {
    failures.push(`${file} — \`${marker}\` is no longer a bracketed list; `
      + `this check can no longer read it.`);
    return null;
  }
  return addressesIn(source.slice(open, close + 1));
}

const web = listLiteral(
  fs.readFileSync(path.join(root, webRel), 'utf8'),
  'const _DEMO_EMAILS = [...]',
  /const\s+_DEMO_EMAILS\s*=\s*\[/,
  webRel
);
const native = listLiteral(
  fs.readFileSync(nativePath, 'utf8'),
  'DemoAccount.emails',
  /static\s+let\s+emails\s*:\s*Set<String>\s*=\s*\[/,
  nativeRel
);

if (web && native) {
  if (web.length === 0) {
    failures.push(`${webRel} — _DEMO_EMAILS is empty. App Review would have no `
      + `way into the app.`);
  }
  const onlyWeb = web.filter(e => !native.includes(e));
  const onlyNative = native.filter(e => !web.includes(e));

  for (const email of onlyWeb) {
    failures.push(`${email} is a demo account on the web but not in the native `
      + `app (${nativeRel}). A reviewer signing in there would hit the paywall.`);
  }
  for (const email of onlyNative) {
    failures.push(`${email} is a demo account in the native app but not on the `
      + `web (${webRel}). The two apps disagree about who a reviewer is.`);
  }
}

if (failures.length) {
  console.error('Demo parity check FAILED:\n');
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error(`\n${failures.length} problem(s).\n`);
  process.exit(1);
}

console.log(`demo parity: ${web.length} reviewer account(s), identical in both apps`);
console.log('✓ App Review sees the same thing whichever app it opens.');
