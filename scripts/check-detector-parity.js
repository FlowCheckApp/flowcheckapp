#!/usr/bin/env node
'use strict';

/**
 * The two subscription detectors must agree on their rules.
 *
 * There are two implementations — Swift for the native app, JavaScript for the
 * shipping web app — and they answer the same question about the same person's
 * money. They agree today only because both were changed in one sitting.
 * Nothing stopped the next edit landing in one of them.
 *
 * That matters more here than in most duplicated code, because the failure is
 * silent and asymmetric: a merchant listed as a subscription in one app and
 * absent from the other looks like a bug in whichever the person opened second,
 * and neither screen can tell it is the one that is wrong.
 *
 * This compares the RULES, not the code: the cadence bands, the evidence
 * thresholds, the tolerances, and the two lists. Style, naming and structure
 * are free to differ.
 *
 * Exit 0 = the rules match. Exit 1 = they have drifted.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const swiftPath = 'FlowCheckSwiftUI/FlowCheckSwiftUI/Core/Models/SubscriptionDetector.swift';
const webPath = 'www/js/fc-app.js';
const swift = fs.readFileSync(path.join(root, swiftPath), 'utf8');
const web = fs.readFileSync(path.join(root, webPath), 'utf8');

const failures = [];

function compare(what, a, b, note) {
  const left = JSON.stringify(a), right = JSON.stringify(b);
  if (left !== right) {
    failures.push(`${what} differs.\n      ${swiftPath}: ${left}\n      ${webPath}: ${right}\n      ${note}`);
  }
}

/* ── Cadence bands ───────────────────────────────────────────────────────
   A gap of N days means weekly, monthly, every two months or yearly. If the
   bands drift, one app calls a charge a subscription and the other does not. */
const swiftBands = [...swift.matchAll(/case (\d+)\.\.\.(\d+):\s*\.(\w+)/g)]
  .map(m => [m[3], Number(m[1]), Number(m[2])]);
const webBands = [
  ['weekly', ...(web.match(/isWeekly\s*=\s*typicalGap >= (\d+)\s*&& typicalGap <= (\d+)/) || []).slice(1).map(Number)],
  ['monthly', ...(web.match(/isMonthly\s*=\s*typicalGap >= (\d+)\s*&& typicalGap <= (\d+)/) || []).slice(1).map(Number)],
  ['everyTwoMonths', ...(web.match(/isBiMonthly\s*=\s*typicalGap >= (\d+)\s*&& typicalGap <= (\d+)/) || []).slice(1).map(Number)],
  ['yearly', ...(web.match(/isAnnual\s*=\s*typicalGap >= (\d+)\s*&& typicalGap <= (\d+)/) || []).slice(1).map(Number)],
];
compare(
  'The cadence bands',
  swiftBands.sort(), webBands.sort(),
  'A gap that is monthly in one app and nothing in the other hides the charge in exactly one place.'
);

/* ── Evidence tiers ──────────────────────────────────────────────────────
   The allow-list that hid real subscriptions was replaced by two tiers:
   a recognised merchant is believed on two charges, anything else needs three.
   Loosening one app to two would reintroduce false positives there alone. */
const swiftTier = swift.match(/charges\.count >= \(recognised \? (\d+) : (\d+)\)/);
const webTier = web.match(/entries\.length < \(recognised \? (\d+) : (\d+)\)/);
compare(
  'The evidence tiers (recognised vs unknown)',
  swiftTier && swiftTier.slice(1).map(Number),
  webTier && webTier.slice(1).map(Number),
  'One app would believe a merchant the other refuses.'
);

/* ── Amount tolerance ────────────────────────────────────────────────────
   How much a price may wobble before it stops looking like a subscription. */
const swiftTol = swift.match(/<=\s*\(recognised \? ([\d.]+) : ([\d.]+)\)/);
const webTol = web.match(/>\s*\(recognised \? ([\d.]+) : ([\d.]+)\)\)\s*continue/);
compare(
  'The amount tolerance',
  swiftTol && swiftTol.slice(1).map(Number),
  webTol && webTol.slice(1).map(Number),
  'A variable-spend merchant would be a subscription in one app only.'
);

/* ── Gap regularity for unknown merchants ────────────────────────────────
   Every gap must look like the cadence, not merely average out to it. */
const swiftGap = swift.match(/typicalGap \* ([\d.]+)/);
const webGap = web.match(/typicalGap \* ([\d.]+)/);
compare(
  'The gap-regularity tolerance for unknown merchants',
  swiftGap && Number(swiftGap[1]),
  webGap && Number(webGap[1]),
  'Three irregular visits would be a subscription in one app only.'
);

/* ── The two lists ───────────────────────────────────────────────────────
   Neither is a gate any more, but the known list still decides which tier a
   merchant gets, so a name in one app and not the other changes the answer. */
/** One entry per alternative, with escaping normalised away. The two files
 *  spell the same pattern differently — "box\\.com" in Swift, box\.com in a
 *  JS regex literal — and that difference is not drift. */
function entries(list) {
  return [...new Set(
    list.map(x => x.toLowerCase().replace(/\\/g, '').trim()).filter(Boolean)
  )].sort();
}
const swiftKnown = entries(
  [...((swift.match(/knownPattern = \[([\s\S]*?)\]\.joined/) || [])[1] || '')
    .matchAll(/"([^"]+)"/g)].map(m => m[1])
);
const webKnown = entries(
  ((web.match(/_SUB_KNOWN_RE = \/\\b\(([\s\S]*?)\)\\b\/i/) || [])[1] || '').split('|')
);
const missingFromWeb = swiftKnown.filter(w => !webKnown.includes(w));
const missingFromSwift = webKnown.filter(w => !swiftKnown.includes(w));
if (missingFromWeb.length || missingFromSwift.length) {
  failures.push(
    `The known-merchant lists differ.\n`
    + (missingFromWeb.length ? `      only in Swift: ${missingFromWeb.join(', ')}\n` : '')
    + (missingFromSwift.length ? `      only in web:   ${missingFromSwift.join(', ')}\n` : '')
    + `      The list decides which evidence tier a merchant gets, so a name in one `
    + `app and not the other changes the answer for that merchant.`
  );
}

/* ── The median, not the mean ────────────────────────────────────────────
   One skipped month drags a mean out of the monthly band entirely. Both must
   use the median or a real subscription vanishes from one app after a refund. */
if (!/median\(gaps\)/.test(swift)) {
  failures.push(`${swiftPath} no longer takes the MEDIAN gap. A mean loses the cadence after one skipped month.`);
}
if (!/median\(gaps\)/.test(web)) {
  failures.push(`${webPath} no longer takes the MEDIAN gap. A mean loses the cadence after one skipped month.`);
}

/* ── The allow-list must stay gone ───────────────────────────────────────
   This is the fault that made real subscriptions invisible. */
/** Comments describe what was removed and why, so a check that reads prose
 *  reports the fix as the fault. This strips them first. */
function codeOnly(js) {
  return js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
if (/if\s*\(!isKnownMerchant\s*&&\s*!isSubCategory\)\s*continue/.test(codeOnly(web))) {
  failures.push(
    `${webPath} has reintroduced the allow-list gate. A merchant not on the ~90-name `
    + `list was discarded before its recurrence was ever examined — it could bill on `
    + `the same day for years and never appear.`
  );
}

if (failures.length) {
  console.error('Subscription detector parity FAILED:\n');
  failures.forEach(f => console.error('  ✗ ' + f + '\n'));
  console.error(`${failures.length} difference(s).\n`);
  process.exit(1);
}

console.log(`detector parity: ${swiftBands.length} cadence bands, `
  + `${swiftKnown.length} known merchants, evidence tiers and tolerances all match`);
console.log('✓ the Swift and JavaScript detectors answer the same question the same way.');
