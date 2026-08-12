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
/* LOCAL date components, never toISOString().
   fc-core parses "YYYY-MM-DD" as local midnight on purpose (a UTC parse makes
   a bill due today look overdue in US timezones). A fixture helper built on
   toISOString() is in UTC, so after ~7pm US Central its "today" is already
   tomorrow — six tests then fail, `npm run check` fails, and deploy.sh
   refuses to ship. The bug was in this helper, not in the code under test. */
const iso = n => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
       + '-' + String(d.getDate()).padStart(2, '0');
};
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

/* ── payday prediction ─────────────────────────────────────────────
   Fixed calendar dates and an injected `now`. Every bug guarded here is
   a date bug, and a relative helper would drift with whichever weekday
   the suite happened to run on — which is how several of them survived.
   All chosen dates are midweek unless the test is specifically about the
   weekend rule. */
const on  = (date, amt, name) => ({ amount: amt, isCredit: true, date,
                                    category: 'Income', name: name || 'ACME PAYROLL' });
const NOW = d => new Date(d + 'T12:00:00').getTime();
const dateOf = p => `${p.date.getFullYear()}-${String(p.date.getMonth() + 1).padStart(2, '0')}-${String(p.date.getDate()).padStart(2, '0')}`;

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
t('predictNextPayday: null on two paychecks — one gap proves nothing', () => {
  eq(C.predictNextPayday([pay(2000, 1), pay(2000, 15)]), null);
});
t('predictNextPayday: null on irregular gaps', () => {
  eq(C.predictNextPayday([pay(100, 1), pay(90, 3), pay(120, 9)]), null);
});

/* Payday TODAY must read 0, not a full cycle away. next was compared
   against Date.now() while deposit dates parse to local midnight, so from
   00:01 on payday the prediction skipped to the cheque after it. */
t('predictNextPayday: payday today is 0 days, not 14', () => {
  const p = C.predictNextPayday(
    [on('2026-07-01', 2000), on('2026-07-15', 2000), on('2026-07-29', 2000)],
    NOW('2026-08-12'));
  ok(p, 'expected a payday');
  eq(p.days, 0, 'days');
  eq(dateOf(p), '2026-08-12', 'date');
});
t('predictNextPayday: a cheque already banked today rolls to the next one', () => {
  const p = C.predictNextPayday(
    [on('2026-07-15', 2000), on('2026-07-29', 2000), on('2026-08-12', 2000)],
    NOW('2026-08-12'));
  ok(p, 'expected a payday');
  eq(p.days, 14, 'days');
  eq(dateOf(p), '2026-08-26', 'date');
});

/* Weekly earners used to get null, and the caller then invented a flat
   7-day horizon that happened to look plausible. */
t('predictNextPayday: detects weekly', () => {
  const p = C.predictNextPayday(
    [on('2026-07-22', 900), on('2026-07-29', 900), on('2026-08-05', 900)],
    NOW('2026-08-10'));
  ok(p, 'expected a payday');
  eq(p.cadence, 'weekly', 'cadence');
  eq(dateOf(p), '2026-08-12', 'date');
});

/* Semi-monthly gaps alternate 13-18d, so averaging them drifted off both
   dates: for an Aug 1 / Aug 15 payer this predicted Aug 16. */
t('predictNextPayday: semi-monthly snaps to the 15th, not last+15.2d', () => {
  const p = C.predictNextPayday([
    on('2026-06-15', 1800), on('2026-07-01', 1800),
    on('2026-07-15', 1800), on('2026-08-03', 1800),
  ], NOW('2026-08-10'));
  ok(p, 'expected a payday');
  eq(p.cadence, 'semimonthly', 'cadence');
  // The 15th is a Saturday — direct deposit lands the Friday before.
  eq(dateOf(p), '2026-08-14', 'date');
});

/* last + 30.4d turned the 1st into the 31st, then the 2nd. Stepping by
   calendar month holds the day, and clamps into shorter months. */
t('predictNextPayday: monthly holds the day of month', () => {
  const p = C.predictNextPayday([
    on('2026-06-15', 4000), on('2026-07-15', 4000), on('2026-08-15', 4000),
  ], NOW('2026-08-20'));
  ok(p, 'expected a payday');
  eq(p.cadence, 'monthly', 'cadence');
  eq(dateOf(p), '2026-09-15', 'date');
});
t('predictNextPayday: monthly on the 31st clamps into a short month', () => {
  const p = C.predictNextPayday([
    on('2025-10-31', 4000), on('2025-11-30', 4000),
    on('2025-12-31', 4000), on('2026-01-31', 4000),
  ], NOW('2026-02-10'));
  ok(p, 'expected a payday');
  // February has no 31st; the 28th is a Saturday, so Friday the 27th.
  eq(dateOf(p), '2026-02-27', 'date');
});

/* A mean gap of [14,14,45] is 24.3 and fell out of every window, so one
   skipped deposit threw away an otherwise perfect biweekly run. */
t('predictNextPayday: survives a missed paycheck', () => {
  const p = C.predictNextPayday([
    on('2026-06-17', 2000), on('2026-07-01', 2000),
    on('2026-07-15', 2000), /* one missed */ on('2026-08-12', 2000),
  ], NOW('2026-08-20'));
  ok(p, 'expected a payday');
  eq(p.cadence, 'biweekly', 'cadence');
  eq(dateOf(p), '2026-08-26', 'date');
});

/* Gaps of 5 and 25 days average to exactly 15 and were reported as
   biweekly. Nothing tested that the gaps agreed with one another. */
t('predictNextPayday: null when gaps only average into range', () => {
  eq(C.predictNextPayday([
    on('2026-07-13', 1500), on('2026-07-18', 1500), on('2026-08-12', 1500),
  ], NOW('2026-08-13')), null);
});

/* A payroll that stopped months ago still produced a date days out,
   because the loop simply advanced until it passed today. */
t('predictNextPayday: null once the payroll has gone quiet', () => {
  eq(C.predictNextPayday([
    on('2026-02-04', 2000), on('2026-02-18', 2000), on('2026-03-04', 2000),
  ], NOW('2026-08-12')), null);
});

/* A $3 monthly interest credit is a perfect cadence and not a payday. */
t('predictNextPayday: ignores small recurring credits', () => {
  eq(C.predictNextPayday([
    on('2026-06-10', 3, 'INTEREST PAID'), on('2026-07-10', 3, 'INTEREST PAID'),
    on('2026-08-10', 3, 'INTEREST PAID'),
  ], NOW('2026-08-12')), null);
});

/* The salary is the payday even when a smaller credit lands sooner —
   picking the soonest group let a side deposit win. */
t('predictNextPayday: prefers the salary over a sooner small deposit', () => {
  const p = C.predictNextPayday([
    on('2026-06-17', 2400, 'ACME PAYROLL'), on('2026-07-01', 2400, 'ACME PAYROLL'),
    on('2026-07-15', 2400, 'ACME PAYROLL'), on('2026-07-29', 2400, 'ACME PAYROLL'),
    on('2026-06-20', 150, 'SIDE GIG'), on('2026-07-20', 150, 'SIDE GIG'),
    on('2026-08-20', 150, 'SIDE GIG'),
  ], NOW('2026-08-05'));
  ok(p, 'expected a payday');
  eq(dateOf(p), '2026-08-12', 'should be the payroll date, not the side gig');
});

/* Payroll descriptors carry a changing reference, which split one
   employer into three groups of one and hid the cadence entirely. */
t('predictNextPayday: groups a payer whose descriptor carries a ref number', () => {
  const p = C.predictNextPayday([
    on('2026-07-01', 2000, 'ACME CORP DIRECT DEP 0701'),
    on('2026-07-15', 2000, 'ACME CORP DIRECT DEP 0715'),
    on('2026-07-29', 2000, 'ACME CORP DIRECT DEP 0729'),
  ], NOW('2026-08-05'));
  ok(p, 'expected a payday');
  eq(dateOf(p), '2026-08-12', 'date');
});

/* A split direct deposit is one payday, not two — two same-day credits
   used to register as a zero-day gap. */
t('predictNextPayday: collapses a split deposit into one payday', () => {
  const p = C.predictNextPayday([
    on('2026-07-01', 1200), on('2026-07-01', 800),
    on('2026-07-15', 1200), on('2026-07-15', 800),
    on('2026-07-29', 1200), on('2026-07-29', 800),
  ], NOW('2026-08-05'));
  ok(p, 'expected a payday');
  eq(p.cadence, 'biweekly', 'cadence');
  eq(dateOf(p), '2026-08-12', 'date');
});

t('predictNextPayday: a weekend payday lands the Friday before', () => {
  const p = C.predictNextPayday([
    on('2026-06-20', 2000), on('2026-07-04', 2000), on('2026-07-18', 2000),
  ], NOW('2026-07-20'));
  ok(p, 'expected a payday');
  // Aug 1 is a Saturday.
  eq(dateOf(p), '2026-07-31', 'date');
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
    // Three deposits, not two: one gap cannot show a consistent cadence, so
    // predictNextPayday requires three before it will name a date.
    transactions: [pay(3000, 1), pay(3000, 31), pay(3000, 61)],  // monthly -> long horizon
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

/* ── forecast bookkeeping ────────────────────────────────────────── */
t('forecastToRecord: null without a real payday to be judged against', () => {
  const r = C.buildRunwaySeries({ accounts: [chk(500)], transactions: [], bills: [] });
  eq(r.hasPayday, false);
  eq(C.forecastToRecord(r), null);
});
t('forecastToRecord: id is the target date, so re-renders overwrite', () => {
  const r = C.buildRunwaySeries({
    accounts: [chk(2000)], transactions: [pay(1500, 1), pay(1500, 15), pay(1500, 29)], bills: [],
  });
  const f = C.forecastToRecord(r);
  ok(f, 'expected a forecast'); eq(f.id, f.target_date);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(f.id), 'id must be YYYY-MM-DD, got ' + f.id);
});
t('forecastToRecord: records the predicted endpoint to the cent', () => {
  const r = C.buildRunwaySeries({
    accounts: [chk(2000)], transactions: [pay(1500, 1), pay(1500, 15), pay(1500, 29)], bills: [bill('R', 300, 3)],
  });
  const f = C.forecastToRecord(r);
  near(f.predicted_end, +r.endBalance.toFixed(2), 0.01);
});
t('forecastsToSettle: not before the target date', () => {
  eq(C.forecastsToSettle([{ target_date: iso(3) }]).length, 0);
});
t('forecastsToSettle: not ON the day (the paycheck may not have landed)', () => {
  eq(C.forecastsToSettle([{ target_date: iso(0) }]).length, 0);
});
t('forecastsToSettle: yes the day after', () => {
  eq(C.forecastsToSettle([{ target_date: ago(1) }]).length, 1);
});
t('forecastsToSettle: skips ones already settled', () => {
  eq(C.forecastsToSettle([{ target_date: ago(5), actual_end: 120 }]).length, 0);
});
t('forecastsToSettle: a settled value of 0 still counts as settled', () => {
  // actual_end === 0 is falsy; a truthiness check would re-settle forever.
  eq(C.forecastsToSettle([{ target_date: ago(5), actual_end: 0 }]).length, 0);
});
t('isoDay: local date, no UTC drift', () => {
  eq(C.isoDay(new Date(2026, 0, 5)), '2026-01-05');
});

/* ── account classification ──────────────────────────────────────
   Two vocabularies reach these functions and they do not overlap:
   Plaid writes type 'depository'/'credit'/'loan'/'investment', the manual
   Add Account sheet writes 'checking'/'savings'/'credit'/'loan'/'investment'.
   Before one shared classifier existed, a manual checking account raised net
   worth while contributing nothing to cash, Safe to Spend or the allocation
   bar — the tiles did not add up to the total above them. */
const acct = (type, subtype, balance, manual) =>
  ({ type, subtype, balance_current: balance, manual: !!manual });

t('accountClass: Plaid shapes', () => {
  eq(C.accountClass(acct('depository', 'checking', 1)), 'cash');
  eq(C.accountClass(acct('depository', 'savings', 1)), 'cash');
  eq(C.accountClass(acct('credit', 'credit card', 1)), 'debt');
  eq(C.accountClass(acct('loan', 'mortgage', 1)), 'debt');
  eq(C.accountClass(acct('investment', 'brokerage', 1)), 'investment');
  eq(C.accountClass(acct('other', 'other', 1)), 'other');
});
t('accountClass: manual shapes (type === subtype)', () => {
  eq(C.accountClass(acct('checking', 'checking', 1, true)), 'cash');
  eq(C.accountClass(acct('savings', 'savings', 1, true)), 'cash');
  eq(C.accountClass(acct('credit', 'credit', 1, true)), 'debt');
  eq(C.accountClass(acct('loan', 'loan', 1, true)), 'debt');
  eq(C.accountClass(acct('investment', 'investment', 1, true)), 'investment');
});
t('accountClass: debt wins over a cash-looking subtype', () => {
  // A line of credit must never be counted as cash just because something
  // else about it matches — debt is tested first, on purpose.
  eq(C.accountClass(acct('credit', 'line of credit', 1)), 'debt');
});
t('isSpendableAccount: checking yes, parked money no', () => {
  eq(C.isSpendableAccount(acct('depository', 'checking', 1)), true);
  eq(C.isSpendableAccount(acct('checking', 'checking', 1, true)), true);
  eq(C.isSpendableAccount(acct('depository', 'savings', 1)), false);
  eq(C.isSpendableAccount(acct('savings', 'savings', 1, true)), false);
  eq(C.isSpendableAccount(acct('depository', 'cd', 1)), false);
  eq(C.isSpendableAccount(acct('credit', 'credit card', 1)), false);
});
t('spendableCash: counts manual checking alongside Plaid checking', () => {
  eq(C.spendableCash([
    acct('depository', 'checking', 2500),
    acct('checking', 'checking', 1500, true),
    acct('depository', 'savings', 8000),
  ]), 4000);
});
t('spendableCash: falls back to all cash when nothing is checking-like', () => {
  // Somebody who banks entirely from savings must not see zero.
  eq(C.spendableCash([acct('depository', 'savings', 900)]), 900);
});
t('netWorth: buckets reconcile with the total', () => {
  const portfolio = [
    acct('depository', 'checking', 2500),
    acct('depository', 'savings', 8000),
    acct('credit', 'credit card', 1200),
    acct('loan', 'auto', 9500),
    acct('investment', 'brokerage', 15000),
    acct('other', 'other', 300),
    acct('checking', 'checking', 1500, true),
    acct('savings', 'savings', 4000, true),
    acct('credit', 'credit', 800, true),
    acct('investment', 'investment', 2000, true),
  ];
  const bal = a => C.accountBalance(a);
  const cash  = portfolio.filter(C.isCashAccount).reduce((s, a) => s + bal(a), 0);
  const inv   = portfolio.filter(a => C.accountClass(a) === 'investment').reduce((s, a) => s + bal(a), 0);
  const other = portfolio.filter(a => C.accountClass(a) === 'other').reduce((s, a) => s + bal(a), 0);
  const nw = C.netWorth(portfolio);
  eq(cash, 16000, 'cash includes both manual cash accounts');
  eq(cash + inv + other, nw.assets, 'every asset lands in exactly one bucket');
  eq(nw.liabilities, 11500, 'manual debt counted');
  eq(nw.assets - nw.liabilities, nw.net, 'assets - liabilities = net');
});
t('netWorth: a debt never adds to the total', () => {
  eq(C.netWorth([acct('credit', 'credit card', 500)]).net, -500);
  eq(C.netWorth([acct('credit', 'credit', 500, true)]).net, -500);
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
