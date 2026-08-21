#!/usr/bin/env node
/**
 * check-demo-coherence.js
 *
 * Demo mode is what App Review evaluates the app on, and it is the one data
 * set nobody's real bank can correct.
 *
 * The net-worth history was generated with `drift = (60 - i) * 26`, where `i`
 * counts DOWN to today — so the drift grew as it approached the present and
 * was subtracted, and the "gently improving line" the comment described
 * actually fell $1,560 over sixty days and ended at −$491.68. The card above
 * the chart derives net worth from the account balances instead, so it read
 * $1,068.32 and "+$648.68 this month" while the chart directly beneath it
 * plotted the same quantity falling into the negative.
 *
 * Two different answers for one number, side by side, in a finance app.
 *
 * This evaluates the real generator out of the real source rather than
 * re-deriving it, so the arithmetic under test is the arithmetic that ships.
 *
 * Exit 0 = clean. Exit 1 = the demo contradicts itself again.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'www/js/fc-app.js');
const src = fs.readFileSync(SRC, 'utf8');

const failures = [];

/* ── 1. The demo account balances, straight out of the literal. ────────── */
const acctBlock = src.slice(src.indexOf('state.accounts = ['));
const accounts = [...acctBlock.slice(0, acctBlock.indexOf('];')).matchAll(
  /type:\s*'([a-z]+)'[\s\S]*?balance_current:\s*(-?[\d.]+)/g
)].map(m => ({ type: m[1], balance: parseFloat(m[2]) }));

if (accounts.length < 3) {
  failures.push(`only parsed ${accounts.length} demo accounts — the literal moved; update this check.`);
} else {
  /* Same split the app uses: depository is an asset, credit and loan are debt. */
  const assets = accounts.filter(a => a.type === 'depository').reduce((s, a) => s + a.balance, 0);
  const debts  = accounts.filter(a => a.type === 'credit' || a.type === 'loan').reduce((s, a) => s + a.balance, 0);
  const heroNetWorth = assets - debts;

  /* ── 2. Evaluate the shipped nwHistory generator. ───────────────────── */
  const start = src.indexOf('state.nwHistory = (() => {');
  const end   = src.indexOf('})();', start);
  if (start === -1 || end === -1) {
    failures.push('could not find the demo nwHistory generator — it moved; update this check.');
  } else {
    const body = src.slice(start + 'state.nwHistory = '.length, end + '})();'.length - 1);
    let history;
    try {
      history = new Function('_demoNow', 'return ' + body)(new Date());
    } catch (e) {
      failures.push('the demo nwHistory generator threw: ' + e.message);
    }

    if (history) {
      const keys = Object.keys(history).sort();
      const todayValue = history[keys[keys.length - 1]];
      const oldestValue = history[keys[0]];

      /* The chart's final point and the hero figure are the same quantity
         computed two ways. They must agree to the cent. */
      if (Math.abs(todayValue - heroNetWorth) >= 0.005) {
        failures.push(
          `the demo chart ends at $${todayValue.toFixed(2)} but the card derives ` +
          `$${heroNetWorth.toFixed(2)} from the account balances — ` +
          `a $${Math.abs(todayValue - heroNetWorth).toFixed(2)} disagreement about the same number.`
        );
      }

      /* The generator is meant to describe progress. A demo whose net worth
         falls to today undercuts the whole screen. */
      if (todayValue <= oldestValue) {
        failures.push(
          `the demo net worth FALLS across the window ($${oldestValue.toFixed(2)} → ` +
          `$${todayValue.toFixed(2)}). The drift term is inverted again — ` +
          `\`i\` counts down to today, so the drift must shrink as \`i\` shrinks.`
        );
      }
    }
  }
}

console.log('demo-coherence check: the chart and the headline agree');
if (failures.length) {
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('  ✓ demo net worth is one number, however it is computed.');
