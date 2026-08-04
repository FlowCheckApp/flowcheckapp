#!/usr/bin/env node
/**
 * test-core.js — unit tests for the shared money math.
 *
 * fc-core.js decides what number a person sees when they ask "can I spend
 * this?". Everything here is a case where getting it wrong tells someone
 * they can afford something they can't.
 *
 * No framework on purpose — this runs anywhere Node runs, in `npm run check`,
 * before deploy.sh will let anything ship.
 */
'use strict';

const C = require('../www/js/fc-core.js');

let passed = 0, failed = 0;
const fails = [];

function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; fails.push({ name, msg: e.message }); }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} expected ${expected}, got ${actual}`);
}
function near(actual, expected, tol, msg) {
  if (Math.abs(actual - expected) > (tol == null ? 0.01 : tol))
    throw new Error(`${msg || ''} expected ~${expected}, got ${actual}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }

/* ── helpers ─────────────────────────────────────────────────────── */
const iso = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const ago = n => iso(-n);
const chk = bal => ({ type: 'depository', subtype: 'checking', balance_current: bal });
const pay = (amt, daysAgo, name) => ({ amount: amt, isCredit: true, date: ago(daysAgo), category: 'Income', name: name || 'Payroll' });
const spend = (amt, daysAgo, cat) => ({ amount: amt, isCredit: false, date: ago(daysAgo), category: cat || 'Food and Drink', name: 'X' });
const bill = (name, amt, inDays, status) => ({ name, amount: amt, due_date: iso(inDays), status: status || 'upcoming' });

/* ── dates ───────────────────────────────────────────────────────── */
t('daysUntil: today is 0', () => eq(C.daysUntil(iso(0)), 0));
t('daysUntil: future positive', () => eq(C.daysUntil(iso(9)), 9));
t('daysUntil: past negative', () => eq(C.daysUntil(ago(3)), -3));
t('daysUntil: null for empty', () => eq(C.daysUntil(''), null));
t('parseDateLocal: local midnight, not UTC', () => {
  // A UTC parse makes a bill due today look overdue in US timezones.
  const d = C.parseDateLocal('2026-05-19');
  eq(d.getFullYear(), 2026); eq(d.getMonth(), 4); eq(d.getDate(), 19);
});

/* ── cash ────────────────────────────────────────────────────────── */
t('spendableCash: checking only, savings excluded', () => {
  eq(C.spendableCash([
    chk(1000),
    { type: 'depository', subtype: 'savings', balance_current: 5000 },
  ]), 1000);
});
t('spendableCash: falls back to all depository when no checking', () => {
  eq(C.spendableCash([{ type: 'depository', subtype: 'savings', balance_current: 800 }]), 800);
});
t('spendableCash: credit cards never count as spendable', () => {
  eq(C.spendableCash([chk(500), { type: 'credit', balance_current: 900 }]), 500);
});

/* ── net worth ───────────────────────────────────────────────────── */
t('netWorth: liabilities subtract (Plaid reports them positive)', () => {
  const n = C.netWorth([chk(3241.87),
    { type: 'depository', subtype: 'savings', balance_current: 12800 },
    { type: 'credit', balance_current: 723.55 }]);
  near(n.assets, 16041.87); near(n.liabilities, 723.55); near(n.net, 15318.32);
});
t('netWorth: an overpaid card never counts as an asset', () => {
  const n = C.netWorth([chk(100), { type: 'credit', balance_current: -50 }]);
  eq(n.liabilities, 0); near(n.net, 100);
});

/* ── transaction classification ──────────────────────────────────── */
t('isSpendTxn: excludes transfers', () => {
  eq(C.isSpendTxn({ isCredit: false, date: ago(1), category: 'Transfer' }), false);
});
t('isSpendTxn: excludes credit card payments', () => {
  eq(C.isSpendTxn({ isCredit: false, date: ago(1), category: 'credit card payment' }), false);
});
t('isIncomeTxn: a credit filed as TRANSFER_IN still counts', () => {
  // Plaid frequently files direct deposits as transfers; a whitelist drops paychecks.
  ok(C.isIncomeTxn({ isCredit: true, date: ago(1), category: 'TRANSFER_IN' }));
});
t('isIncomeTxn: excludes credit card payments', () => {
  eq(C.isIncomeTxn({ isCredit: true, date: ago(1), category: 'credit card payment' }), false);
});

/* ── payday prediction ───────────────────────────────────────────── */
t('predictNextPayday: detects biweekly', () => {
  const p = C.predictNextPayday([pay(2000, 1), pay(2000, 15), pay(2000, 29)]);
  ok(p, 'expected a payday'); ok(p.days >= 1 && p.days <= 16, 'days in range, got ' + p.days);
});
t('predictNextPayday: detects monthly', () => {
  const p = C.predictNextPayday([pay(4000, 2), pay(4000, 32), pay(4000, 62)]);
  ok(p, 'expected a payday'); ok(p.days <= 31);
});
t('predictNextPayday: null on a single paycheck', () => {
  eq(C.predictNextPayday([pay(2000, 3)]), null);
});
t('predictNextPayday: null on irregular gaps', () => {
  eq(C.predictNextPayday([pay(100, 1), pay(90, 3), pay(120, 9)]), null);
});

/* ── the runway ──────────────────────────────────────────────────── */
t('runway: endpoint = start - bills - burn*horizon', () => {
  const r = C.buildRunwaySeries({
    accounts: [chk(3000)],
    transactions: [pay(2000, 1), pay(2000, 15), spend(600, 5)],
    bills: [bill('Rent', 1000, 3)],
  });
  const billSum = r.points.reduce((s, p) => s + p.bills.reduce((a, b) => a + b.amount, 0), 0);
  near(r.startBalance - billSum - r.dailyBurn * r.horizon, r.endBalance, 0.01);
});
t('runway: balance never rises', () => {
  const r = C.buildRunwaySeries({
    accounts: [chk(2000)], transactions: [pay(1500, 2), pay(1500, 16), spend(300, 4)],
    bills: [bill('Rent', 800, 5), bill('Power', 90, 9)],
  });
  ok(r.points.every((p, i, a) => i === 0 || p.balance <= a[i - 1].balance + 0.01));
});
t('runway: counts bills PAST day 14 (the capped-window bug)', () => {
  // p.bills is capped at min(14, paydayDays). Sourcing from it drops later
  // bills and overstates the landing balance.
  const r = C.buildRunwaySeries({
    accounts: [chk(5000)],
    transactions: [pay(3000, 1), pay(3000, 31)],   // monthly -> long horizon
    bills: [bill('Late', 500, 20)],
  });
  ok(r.horizon >= 20, 'horizon should reach day 20, got ' + r.horizon);
  eq(r.billCount, 1, 'day-20 bill must be counted');
});
t('runway: paid bills are ignored', () => {
  const r = C.buildRunwaySeries({
    accounts: [chk(1000)], transactions: [pay(900, 1), pay(900, 15)],
    bills: [bill('Rent', 400, 3, 'paid')],
  });
  eq(r.billCount, 0);
});
t('runway: goes negative is detected with the right day', () => {
  const r = C.buildRunwaySeries({
    accounts: [chk(500)], transactions: [pay(1000, 1), pay(1000, 15)],
    bills: [bill('Rent', 900, 4)],
  });
  ok(r.goesNegative, 'should go negative');
  eq(r.firstNegativeDay, 4);
  ok(r.endBalance < 0, 'endpoint must stay negative, never clamped to 0');
});
t('runway: no payday -> 14-day horizon, hasPayday false', () => {
  const r = C.buildRunwaySeries({ accounts: [chk(900)], transactions: [], bills: [] });
  eq(r.hasPayday, false); eq(r.horizon, 14);
});
t('runway: survives completely empty input', () => {
  const r = C.buildRunwaySeries({ accounts: [], transactions: [], bills: [] });
  eq(r.startBalance, 0); ok(r.points.length > 0);
});

/* ── safe to spend ───────────────────────────────────────────────── */
t('safeToSpend: never negative', () => {
  const p = C.buildSafeSpendProjection({
    accounts: [chk(100)], transactions: [pay(500, 1), pay(500, 15)],
    bills: [bill('Rent', 900, 2)],
  });
  ok(p.safe >= 0, 'safe was ' + p.safe);
});
t('safeToSpend: holds back a reserve', () => {
  const p = C.buildSafeSpendProjection({
    accounts: [chk(5000)], transactions: [pay(2000, 1), pay(2000, 15)], bills: [],
  });
  ok(p.reserve >= 250, 'reserve floor is 250, got ' + p.reserve);
  ok(p.safe < p.cash, 'safe must be less than cash');
});

/* ── spending ────────────────────────────────────────────────────── */
t('spendingByCategory: sorted desc, transfers excluded', () => {
  const cats = C.spendingByCategory([
    spend(100, 2, 'Food and Drink'), spend(300, 3, 'Shopping'),
    spend(999, 4, 'Transfer'),
  ], 30);
  eq(cats[0].category, 'Shopping'); near(cats[0].amount, 300);
  ok(!cats.some(c => /transfer/i.test(c.category)), 'transfers must not appear');
});
t('spendingByCategory: respects the window', () => {
  eq(C.spendTotal([spend(500, 60)], 30), 0);
});

/* ── income profile: the irregular-earner gap ────────────────────── */
t('incomeProfile: none when there is no income', () => {
  const p = C.incomeProfile([]);
  eq(p.kind, 'none'); eq(p.perWeek, 0);
});
t('incomeProfile: regular biweekly is detected', () => {
  const p = C.incomeProfile([pay(2000, 1), pay(2000, 15), pay(2000, 29)]);
  eq(p.kind, 'regular'); eq(p.cadence, 'biweekly'); ok(p.nextPayday);
});
t('incomeProfile: gig income is irregular, NOT none', () => {
  // Previously this person got hasPayday:false and a generic 14-day
  // horizon with no income understanding at all.
  const gig = [];
  for (let d = 1; d <= 60; d += 2) gig.push(pay(60 + (d % 5) * 20, d, 'Rideshare Payout'));
  const p = C.incomeProfile(gig);
  eq(p.kind, 'irregular');
  ok(p.perWeek > 0, 'must estimate weekly income, got ' + p.perWeek);
  ok(p.confidence > 0.5, 'plenty of history should be confident, got ' + p.confidence);
});
t('incomeProfile: band brackets the median', () => {
  const gig = [];
  for (let d = 1; d <= 56; d += 2) gig.push(pay(50 + (d % 7) * 30, d, 'Tips'));
  const p = C.incomeProfile(gig);
  ok(p.typicalLow <= p.perWeek && p.perWeek <= p.typicalHigh,
     `band ${p.typicalLow}..${p.typicalHigh} must contain ${p.perWeek}`);
});
t('incomeProfile: short history lowers confidence', () => {
  const few = C.incomeProfile([pay(100, 1), pay(120, 3)]);
  ok(few.confidence < 0.5, 'two recent deposits should be low confidence, got ' + few.confidence);
});
t('incomeProfile: does not divide by the full window on short history', () => {
  // Three weeks of history divided by 90 days would understate income ~4x.
  const p = C.incomeProfile([pay(700, 3), pay(700, 10), pay(700, 17)]);
  ok(p.perWeek > 400, 'perWeek should reflect real cadence, got ' + p.perWeek);
});

/* ── runway: irregular support ───────────────────────────────────── */
t('runway: flags irregular income', () => {
  const gig = [];
  for (let d = 1; d <= 60; d += 2) gig.push(pay(80, d, 'Rideshare'));
  const r = C.buildRunwaySeries({ accounts: [chk(900)], transactions: gig, bills: [] });
  eq(r.isIrregular, true);
  eq(r.income.kind, 'irregular');
});
t('runway: coveredDays says how long you last with zero new income', () => {
  const r = C.buildRunwaySeries({
    accounts: [chk(1000)], transactions: [spend(300, 5)], bills: [],
  });
  ok(Number.isFinite(r.coveredDays), 'should be finite when burning');
  ok(r.coveredDays > 0, 'got ' + r.coveredDays);
});
t('runway: coveredDays stops at the day before you go negative', () => {
  const r = C.buildRunwaySeries({
    accounts: [chk(500)], transactions: [pay(1000, 1), pay(1000, 15)],
    bills: [bill('Rent', 900, 4)],
  });
  eq(r.firstNegativeDay, 4);
  eq(r.coveredDays, 3);
});
t('runway: zero burn and no bills means never runs out', () => {
  const r = C.buildRunwaySeries({ accounts: [chk(500)], transactions: [], bills: [] });
  eq(r.coveredDays, Infinity);
});

/* ── forecast accuracy ───────────────────────────────────────────── */
t('scoreForecast: empty history is honest about it', () => {
  const s = C.scoreForecast([]);
  eq(s.count, 0); eq(s.medianAbsError, null);
});
t('scoreForecast: computes median error and hit rate', () => {
  const s = C.scoreForecast([
    { predictedEnd: 300, actualEnd: 320 },
    { predictedEnd: 400, actualEnd: 380 },
    { predictedEnd: 250, actualEnd: 250 },
  ]);
  eq(s.count, 3); eq(s.medianAbsError, 20); eq(s.withinFifty, 3); eq(s.hitRate, 1);
});
t('scoreForecast: bias sign shows the DANGEROUS direction', () => {
  // Negative bias = we predicted more than they actually had.
  const s = C.scoreForecast([
    { predictedEnd: 300, actualEnd: 200 },
    { predictedEnd: 300, actualEnd: 220 },
  ]);
  ok(s.averageBias < 0, 'over-promising must read negative, got ' + s.averageBias);
});
t('scoreForecast: will not claim accuracy on thin history', () => {
  const s = C.scoreForecast([{ predictedEnd: 100, actualEnd: 100 }]);
  eq(s.verdict, 'still learning your pattern');
});
t('scoreForecast: ignores malformed rows', () => {
  const s = C.scoreForecast([
    { predictedEnd: 100, actualEnd: 110 },
    { predictedEnd: null, actualEnd: 50 },
    { nonsense: true },
  ]);
  eq(s.count, 1);
});

/* ── report ─────────────────────────────────────────────────────── */
console.log(`fc-core: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('');
  fails.forEach(f => console.error(`  ✗ ${f.name}\n      ${f.msg}`));
  console.error('');
  process.exit(1);
}
console.log('✓ all core money-math tests pass.');
