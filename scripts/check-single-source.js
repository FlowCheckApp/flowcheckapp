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

/* 4. Money formatting has two named functions, not a third inline one.

   The app grew three conventions with no rule about which went where:
   FCData.formatCurrency (always cents), FCData.formatSummary (whole
   dollars), and eight separate inline Math.round(x).toLocaleString('en-US')
   expressions. Home printed "$3,242 available" while Money printed
   "$3,241.87" for the same account, and Goals rendered twelve figures of
   which every single one ended in .00.

   The rule now: formatCurrency for ledgers — transaction rows, account
   balances, anything a user reconciles against their bank. formatSummary
   for everything else. A new inline expression is a third convention
   getting in, so this ratchets: the count may fall, never rise.

   Lower CEILING when it falls. Do not raise it. */
const INLINE_MONEY_CEILING = 8;
const appSrc = fs.readFileSync(path.join(ROOT, 'www/js/fc-app.js'), 'utf8');
const inlineMoney = [...appSrc.matchAll(/toLocaleString\('en-US'\)/g)].length;

if (inlineMoney > INLINE_MONEY_CEILING) {
  failures.push(
    `${inlineMoney} inline money-formatting expressions in fc-app.js (ceiling ${INLINE_MONEY_CEILING}). ` +
    `Use FCData.formatSummary for whole dollars or FCData.formatCurrency for cents — ` +
    `a third convention is how Home and Money came to disagree about the same balance.`
  );
}

/* 5. Both formatters still exist and are exported — the rule above is
      meaningless if the functions it points at are gone. */
const dataSrc = fs.readFileSync(path.join(ROOT, 'www/js/fc-data.js'), 'utf8');
['formatCurrency', 'formatSummary'].forEach(fn => {
  if (!new RegExp(`function ${fn}\\b`).test(dataSrc)) {
    failures.push(`www/js/fc-data.js no longer defines ${fn}.`);
  }
  if (!new RegExp(`^\\s*${fn},\\s*$`, 'm').test(dataSrc)) {
    failures.push(`www/js/fc-data.js no longer exports ${fn}.`);
  }
});

/* 6. The native app has ONE answer to "what can I spend".

      Same failure, now twice over. It first capped the Coach's advice at
      month-to-date income minus spending. Then it grew a `flexibleCash` that
      deducted EVERY unpaid bill from today's balance while the hero beside it
      deducted only the bills due before payday — so a real ledger printed
      "$1,280 safe to spend" next to "Flexible $4", and a What-If card derived
      from the second figure answered "could I spend $10 tonight? Not today".

      `safeToSpend` is the only figure now. This asserts the window rule is
      written once, that nothing has reintroduced a competing definition, and
      that the Coach still caps with the same number the home screen prints.

      Skipped when the nested native repository is not in this checkout. */
const NATIVE_ROOT = path.join(ROOT, 'FlowCheckSwiftUI/FlowCheckSwiftUI');
if (fs.existsSync(NATIVE_ROOT)) {
  const swiftFiles = (function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && entry.name.endsWith('.swift') ? [full] : [];
    });
  })(NATIVE_ROOT);

  const read = file => fs.readFileSync(file, 'utf8');

  /* A second "money free" figure, however it is spelled. `flexibleCash` is
     named because it existed; the subtraction is caught whatever it is called. */
  const RIVAL = /\bflexibleCash\b|cashAvailable\s*-\s*(?:\w+\.)?upcomingBillsTotal/;
  for (const file of swiftFiles) {
    if (RIVAL.test(read(file))) {
      failures.push(`${path.relative(ROOT, file)} reintroduces a second "money free" `
        + `figure alongside safeToSpend. One of them ends up in the hero and the `
        + `other in the column beside it, and they disagree.`);
    }
  }

  /* The payday window, written once. */
  const WINDOW = /dateComponents\(\[\.day\][\s\S]{0,80}projectionDays/;
  const windowFiles = swiftFiles.filter(f => WINDOW.test(read(f)));
  if (windowFiles.length > 1) {
    failures.push(`the payday-window rule appears in ${windowFiles.length} files `
      + `(${windowFiles.map(f => path.basename(f)).join(', ')}). It belongs in `
      + `BillWindow.due only — the calculator and the snapshot both need it, and `
      + `written twice they drift invisibly.`);
  }

  const models = path.join(NATIVE_ROOT, 'Core/Models/FinancialModels.swift');
  if (fs.existsSync(models) && !/enum BillWindow\b/.test(read(models))) {
    failures.push('Core/Models/FinancialModels.swift no longer defines BillWindow, '
      + 'the single definition of which bills today\'s cash must cover.');
  }

  const coach = path.join(NATIVE_ROOT, 'Features/Coach/CoachEngine.swift');
  if (fs.existsSync(coach) && !/min\(\s*safeToSpend\s*,/.test(read(coach))) {
    failures.push('Features/Coach/CoachEngine.swift no longer caps its debt advice '
      + 'with safeToSpend — the figure the home screen prints. Uncapped or capped '
      + 'against anything else, the Coach and Today disagree in public.');
  }
}

if (failures.length) {
  console.error(`Single-source check FAILED — ${failures.length} problem(s):\n`);
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error('');
  process.exit(1);
}

console.log(`single-source check: 1 category map, ${CONSUMERS.length} delegating consumers, `
  + `${inlineMoney}/${INLINE_MONEY_CEILING} inline money formats`);
if (inlineMoney < INLINE_MONEY_CEILING) {
  console.log(`↓ inline money formatting improved — lower INLINE_MONEY_CEILING to ${inlineMoney}.`);
}
console.log('✓ spend/income classification has exactly one implementation, and money has two formatters.');
