#!/usr/bin/env node
/**
 * check-single-source.js
 *
 * Money rules get RE-IMPLEMENTED, not reused, and the copies drift silently.
 * This has happened three times in this codebase:
 *
 *   · three different budget-total formulas
 *   · two copies of the payday predictor
 *   · two spend/income classifiers backed by two category maps, which
 *     disagreed on 18 of 33 realistic inputs — and one disagreement counted
 *     a credit-card refund as a paycheck, feeding the payday date and
 *     safe-to-spend
 *
 * Each was found by reading, months apart. This makes the rule mechanical:
 * the classifiers and the category map live in fc-core and nowhere else.
 *
 * Exit 0 = clean. Exit 1 = a second implementation is back.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const CORE = 'www/js/fc-core.js';
/* Files that must DELEGATE rather than re-implement. */
const CONSUMERS = ['www/js/fc-app.js', 'www/js/fc-data.js', 'backend/public/js/app-web.js'];

const failures = [];

/* 1. The category map exists exactly once, and it lives in core. */
const mapOwners = [CORE, ...CONSUMERS].filter(rel => {
  const abs = path.join(ROOT, rel);
  return fs.existsSync(abs) && /PLAID_MAP\s*=\s*\{/.test(fs.readFileSync(abs, 'utf8'));
});
if (!mapOwners.includes(CORE)) {
  failures.push(`PLAID_MAP is gone from ${CORE} — the map must live in the shared core.`);
}
mapOwners.filter(f => f !== CORE).forEach(f => {
  failures.push(`${f} declares its own PLAID_MAP. There must be exactly one, in ${CORE}. `
    + `Two maps disagreed on 18 of 33 inputs and misread a card refund as income.`);
});

/* 2. Nobody re-implements the classifiers. A one-line delegate is fine;
      a function body with the skip/exclude logic in it is not. */
const REIMPL = [
  { rx: /function\s+_?isSpendTxn\s*\([^)]*\)\s*\{[\s\S]{0,400}?XFER_SKIP/, what: 'isSpendTxn' },
  { rx: /function\s+_?isIncomeTxn\s*\([^)]*\)\s*\{[\s\S]{0,400}?INCOME_HARD_EXCLUDE/, what: 'isIncomeTxn' },
];
for (const rel of CONSUMERS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  for (const { rx, what } of REIMPL) {
    if (rx.test(src)) {
      failures.push(`${rel} re-implements ${what}. Call FCCore.${what.replace(/^_/, '')} instead — `
        + `a thin alias is fine, a second body is not.`);
    }
  }
}

/* 3. The core still exports what everyone delegates to. */
const coreSrc = fs.readFileSync(path.join(ROOT, CORE), 'utf8');
/* The export object is the LAST module-level `return {` — matching the first
   one finds some inner function's return and reports a false failure. */
const lastReturn = coreSrc.lastIndexOf('\n  return {');
const exportBlock = lastReturn === -1 ? '' : coreSrc.slice(lastReturn);
['isSpendTxn', 'isIncomeTxn', 'normalizeCategory'].forEach(fn => {
  if (!new RegExp(`\\b${fn}\\b`).test(exportBlock)) {
    failures.push(`${CORE} no longer exports ${fn} — its consumers delegate to it.`);
  }
});

if (failures.length) {
  console.error(`Single-source check FAILED — ${failures.length} problem(s):\n`);
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error('');
  process.exit(1);
}

console.log(`single-source check: 1 category map, ${CONSUMERS.length} delegating consumers`);
console.log('✓ spend/income classification has exactly one implementation.');
