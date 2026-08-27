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

/* 6. The native app's "money that is actually free" has one definition.
      Same failure, fourth instance. Today prints it as "Flexible", the Coach
      caps its debt advice with it and paces the save-more answer against it.
      Each computed its own, and the Coach's was wrong: it capped at
      month-to-date income minus spending, which counts money the month's
      unpaid bills already have a claim on. On the sample data that is $3,534
      against a real $587, so the Coach recommended putting $1,472 toward a
      card on a screen whose sibling tab said $587 was free.

      `FinancialSnapshot.flexibleCash` is now the only place the subtraction
      happens. This counts the expression, not the property, so a second copy
      is what fails — reading `flexibleCash` as often as you like is the point.

      Skipped when the nested native repository is not in this checkout. */
const NATIVE_ROOT = path.join(ROOT, 'FlowCheckSwiftUI/FlowCheckSwiftUI');
const FLEXIBLE_HOME = 'Core/Models/FinancialModels.swift';
if (fs.existsSync(path.join(NATIVE_ROOT, FLEXIBLE_HOME))) {
  /* cashAvailable minus bills minus reserve, however it is spelled and
     whatever it is subtracted through — `snapshot.`, `self.` or bare. */
  const SUBTRACTION =
    /cashAvailable\s*-\s*(?:\w+\.)?(?:upcomingBillsTotal|billsAmount)\s*-\s*(?:\w+\.)?(?:reserve|protectedAmount)/g;

  const swiftFiles = (function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && entry.name.endsWith('.swift') ? [full] : [];
    });
  })(NATIVE_ROOT);

  let copies = [];
  for (const file of swiftFiles) {
    const hits = (fs.readFileSync(file, 'utf8').match(SUBTRACTION) || []).length;
    if (hits > 0) copies.push({ rel: path.relative(ROOT, file), hits });
  }

  const total = copies.reduce((n, c) => n + c.hits, 0);
  const home = copies.find(c => c.rel.endsWith(FLEXIBLE_HOME));

  if (!home) {
    failures.push(`${FLEXIBLE_HOME} no longer computes flexible cash. `
      + `FinancialSnapshot.flexibleCash is the one definition Today and the Coach share.`);
  } else if (total > 1) {
    const others = copies.filter(c => c !== home).map(c => `${c.rel} (${c.hits})`);
    failures.push(`flexible cash is computed ${total} times — it must be computed once, `
      + `in ${FLEXIBLE_HOME}, and read as flexibleCash everywhere else. Extra copies: `
      + `${others.join(', ') || 'a second one inside ' + FLEXIBLE_HOME}. `
      + `Recomputed independently, the Coach once advised $1,472 on a day Today said $587.`);
  }

  /* And the Coach must still cap with it. Dropping the cap reintroduces advice
     that exceeds what the person has, which is the whole defect. */
  const coach = path.join(NATIVE_ROOT, 'Features/Coach/CoachEngine.swift');
  if (fs.existsSync(coach) && !/min\(\s*flexibleCash\s*,/.test(fs.readFileSync(coach, 'utf8'))) {
    failures.push('Features/Coach/CoachEngine.swift no longer caps its debt advice with '
      + 'flexibleCash. Uncapped, it recommends paying more than the person has.');
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
