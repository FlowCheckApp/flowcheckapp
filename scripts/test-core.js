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

/* ═══════════════════════════════════════════════════════════════
   DEBT-FREE DATE
   A balance is a fact about the past. A date is a fact about the future the
   user can move — so it has to be right, and it has to refuse to answer
   rather than guess.
   ═══════════════════════════════════════════════════════════════ */
const debt = (name, balance, rate, minimum) => ({ name, balance, rate, minimum });
const JAN = new Date(2026, 0, 1);

t('debtFreePlan: no debt is a finished plan, not an error', () => {
  const p = C.debtFreePlan([], 0, 'avalanche', JAN);
  eq(p.ok, true); eq(p.months, 0); eq(p.reason, 'no_debt');
});
t('debtFreePlan: refuses to guess when a minimum is missing', () => {
  const p = C.debtFreePlan([debt('Visa', 1000, 22, 0)], 0, 'avalanche', JAN);
  eq(p.ok, false); eq(p.reason, 'missing_minimums'); eq(p.date, null);
});
t('debtFreePlan: says never when the payment cannot clear the interest', () => {
  // 22% on 5000 is ~91.67/mo of interest; paying 40 never gets there.
  const p = C.debtFreePlan([debt('Visa', 5000, 22, 40)], 0, 'avalanche', JAN);
  eq(p.ok, false); eq(p.reason, 'never_pays_off');
});
t('debtFreePlan: 0% debt is simple division', () => {
  const p = C.debtFreePlan([debt('Loan', 1200, 0, 100)], 0, 'avalanche', JAN);
  eq(p.ok, true); eq(p.months, 12);
});
t('debtFreePlan: matches an independent amortisation for a single debt', () => {
  // Independent reference: closed-form n = -ln(1 - rB/P) / ln(1+r)
  const B = 5000, apr = 22, P = 150;
  const r = apr / 100 / 12;
  const expected = Math.ceil(-Math.log(1 - (r * B) / P) / Math.log(1 + r));
  const p = C.debtFreePlan([debt('Visa', B, apr, P)], 0, 'avalanche', JAN);
  ok(Math.abs(p.months - expected) <= 1,
     `simulation ${p.months} vs closed form ${expected}`);
});
t('debtFreePlan: extra payment shortens the date', () => {
  const base  = C.debtFreePlan([debt('Visa', 5000, 22, 150)], 0,  'avalanche', JAN);
  const extra = C.debtFreePlan([debt('Visa', 5000, 22, 150)], 100,'avalanche', JAN);
  ok(extra.months < base.months, 'more money must not take longer');
  ok(extra.totalInterest < base.totalInterest, 'and must cost less interest');
});
t('debtFreePlan: a cleared debt rolls its minimum onto the next', () => {
  // Two debts. If the cascade works, total time beats paying them in
  // isolation with no rollover.
  const debts = [debt('Small', 500, 0, 100), debt('Big', 2000, 0, 100)];
  const p = C.debtFreePlan(debts, 0, 'snowball', JAN);
  // Without the cascade Big alone takes 20 months. With it, Small clears at
  // month 5 and hands over 100/mo, so Big finishes materially sooner.
  ok(p.months < 20, `expected the rollover to beat 20 months, got ${p.months}`);
  eq(p.cleared[0].name, 'Small', 'snowball clears the smallest first');
});
t('debtFreePlan: avalanche attacks the highest rate first', () => {
  const debts = [debt('Cheap', 1000, 3, 50), debt('Pricey', 1000, 28, 50)];
  const p = C.debtFreePlan(debts, 200, 'avalanche', JAN);
  eq(p.cleared[0].name, 'Pricey');
});
t('debtFreePlan: avalanche costs no more interest than snowball', () => {
  const mk = () => [debt('A', 3000, 26, 75), debt('B', 900, 6, 40)];
  const av = C.debtFreePlan(mk(), 150, 'avalanche', JAN);
  const sn = C.debtFreePlan(mk(), 150, 'snowball',  JAN);
  ok(av.totalInterest <= sn.totalInterest + 0.01,
     `avalanche ${av.totalInterest} should not exceed snowball ${sn.totalInterest}`);
});
t('debtFreePlan: the date lands the right number of months out', () => {
  const p = C.debtFreePlan([debt('Loan', 1200, 0, 100)], 0, 'avalanche', JAN);
  eq(p.date.getFullYear(), 2027);
  eq(p.date.getMonth(), 0, 'Jan 2026 + 12 months = Jan 2027');
});
t('debtFreePlan: does not mutate the caller\'s accounts', () => {
  const debts = [debt('Visa', 1000, 10, 100)];
  C.debtFreePlan(debts, 50, 'avalanche', JAN);
  eq(debts[0].balance, 1000, 'input must survive the simulation');
});


/* ── report ─────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════
   weightedApr — the "Avg Interest" tile
   The unweighted mean shipped, and on a real debt load (a small card at a
   card rate, a large loan at a loan rate) it nearly doubled the number.
   ═══════════════════════════════════════════════════════════════ */
t('weightedApr: weights by balance, not by count', () => {
  // The exact case that was wrong: unweighted this is 14.945%.
  const r = C.weightedApr([
    { balance: 723.55, rate: 22.99 },
    { balance: 14250,  rate: 6.9   },
  ]);
  eq(Math.round(r * 100) / 100, 7.68);
  if (r > 10) throw new Error(`weighted APR came back ${r} — that is the unweighted mean`);
});
t('weightedApr: a rate-less debt is excluded, not counted as 0%', () => {
  // Counting the unknown as 0% would give 11.495% and understate the cost.
  const r = C.weightedApr([
    { balance: 1000, rate: 22.99 },
    { balance: 1000, rate: 0     },
  ]);
  eq(Math.round(r * 100) / 100, 22.99);
});
t('weightedApr: a paid-off debt does not drag the average', () => {
  const r = C.weightedApr([
    { balance: 0,    rate: 29.99 },
    { balance: 5000, rate: 6     },
  ]);
  eq(r, 6);
});
t('weightedApr: nothing to average is 0, not NaN', () => {
  eq(C.weightedApr([]), 0);
  eq(C.weightedApr(null), 0);
  eq(C.weightedApr([{ balance: 500, rate: null }]), 0);
});

/* ═══════════════════════════════════════════════════════════════
   debtProgress — the dashboard's "paid down" tile
   The one number in the app whose whole job is to be encouraging, which
   is exactly why it must never be encouraging about nothing.
   ═══════════════════════════════════════════════════════════════ */
const H = (...pairs) => Object.fromEntries(pairs);

t('debtProgress: one snapshot is not a trend', () => {
  const p = C.debtProgress({ '2026-08-15': 5000 }, 5000);
  eq(p.ok, false); eq(p.paidDown, 0);
});
t('debtProgress: no history at all refuses rather than claiming zero', () => {
  eq(C.debtProgress({}, 5000).ok, false);
  eq(C.debtProgress(null, 5000).ok, false);
});
t('debtProgress: paid down is measured from the EARLIEST snapshot', () => {
  const p = C.debtProgress(H(['2026-06-01', 8000], ['2026-07-01', 7000], ['2026-08-01', 6500]), 6000);
  eq(p.ok, true); eq(p.paidDown, 2000); eq(p.from, '2026-06-01');
});
t('debtProgress: positive means debt went DOWN', () => {
  // Sign errors here would congratulate someone for borrowing more.
  const better = C.debtProgress(H(['2026-06-01', 8000], ['2026-08-01', 7000]), 7000);
  const worse  = C.debtProgress(H(['2026-06-01', 8000], ['2026-08-01', 9000]), 9000);
  if (better.paidDown <= 0) throw new Error('paying down should be positive');
  if (worse.paidDown  >= 0) throw new Error('borrowing more should be negative');
  eq(worse.paidDown, -1000);
});
t('debtProgress: the month figure uses a ~30-day-old point, not the earliest', () => {
  const p = C.debtProgress(
    H(['2026-05-01', 9000], ['2026-07-16', 6200], ['2026-08-15', 6000]), 6000);
  eq(p.paidDown, 3000);   // since May
  eq(p.month, 200);       // since mid-July, the newest point ≥30 days back
});
t('debtProgress: under 30 days of history still reports a real month figure', () => {
  const p = C.debtProgress(H(['2026-08-01', 5000], ['2026-08-15', 4800]), 4800);
  eq(p.ok, true); eq(p.month, 200); eq(p.days, 14);
});
t('debtProgress: a bad month coexists with all-time progress', () => {
  // The case the tile has to render honestly: up this month, down overall.
  const p = C.debtProgress(
    H(['2026-01-01', 12000], ['2026-07-10', 7000], ['2026-08-15', 7120]), 7120);
  eq(p.paidDown, 4880);
  eq(p.month, -120);
});
t('debtProgress: junk keys and non-numeric values are ignored, not counted', () => {
  const p = C.debtProgress(
    { 'updated_at': 1, 'not-a-date': 500, '2026-06-01': 8000, '2026-08-01': null }, 7000);
  eq(p.ok, true); eq(p.from, '2026-06-01'); eq(p.paidDown, 1000);
});

/* ═══════════════════════════════════════════════════════════════
   compareOffer — "is this refinance actually better?"
   The question the quote does not answer honestly on its own.
   ═══════════════════════════════════════════════════════════════ */
t('compareOffer: a genuinely better rate saves interest and lowers the payment', () => {
  const r = C.compareOffer({ balance: 31000, rate: 5.2, months: 60,
                             currentRate: 6.9, currentPayment: 620 });
  eq(r.ok, true);
  if (r.interestSaved <= 0) throw new Error('a lower rate must save interest');
  if (r.monthlyChange <= 0) throw new Error('same term at a lower rate must lower the payment');
});

t('compareOffer: a longer term can LOWER the payment and still cost more', () => {
  // The trap the whole function exists to expose.
  const r = C.compareOffer({ balance: 20000, rate: 7, months: 84,
                             currentRate: 6, currentPayment: 480 });
  if (r.monthlyChange <= 0) throw new Error('stretching the term should lower the payment');
  if (r.interestSaved >= 0) throw new Error('a worse rate over a longer term must cost MORE overall');
});

t('compareOffer: 0% for 18 months clears a card that fits inside the window', () => {
  const r = C.compareOffer({ balance: 3600, rate: 22.99, payment: 200,
                             introRate: 0, introMonths: 18,
                             currentRate: 22.99, currentPayment: 200 });
  eq(r.ok, true); eq(r.months, 18);
  near(r.totalInterest, 0, 0.01, 'a promo that clears in the window costs');
});

t('compareOffer: a 0% promo that does NOT clear is not free', () => {
  // $6,000 at $200/mo cannot clear in 12 months; the rest reverts to 22.99%.
  const r = C.compareOffer({ balance: 6000, rate: 22.99, payment: 200,
                             introRate: 0, introMonths: 12,
                             currentRate: 22.99, currentPayment: 200 });
  eq(r.ok, true);
  if (r.totalInterest <= 0) throw new Error('a balance surviving the promo must accrue interest');
  if (r.months <= 12) throw new Error('it cannot still finish inside the promo window');
});

t('compareOffer: the transfer fee is counted, not waved away', () => {
  const free = C.compareOffer({ balance: 5000, rate: 0, payment: 300, introRate: 0, introMonths: 18,
                                currentRate: 20, currentPayment: 300 });
  const paid = C.compareOffer({ balance: 5000, rate: 0, payment: 300, introRate: 0, introMonths: 18,
                                fee: 150, currentRate: 20, currentPayment: 300 });
  near(paid.totalInterest - free.totalInterest, 150, 0.01, 'the fee should add');
  if (paid.interestSaved >= free.interestSaved) throw new Error('a fee must reduce the saving');
});

t('compareOffer: a fixed payment beats the term — transfer mode, not loan mode', () => {
  /* The bug this locks out: deriving the payment from the term meant a
     $6,000 transfer with a 12-month promo silently assumed $500/mo and
     "cleared" for free. A card has no required payment; the promo is a
     deadline, not a schedule. */
  const r = C.compareOffer({ balance: 6000, rate: 22.99, months: 12, payment: 200,
                             introRate: 0, introMonths: 12,
                             currentRate: 22.99, currentPayment: 200 });
  near(r.payment, 200, 0.01, 'the payment passed in should be the payment used —');
  if (r.months <= 12) throw new Error('$200/mo cannot clear $6,000 inside 12 months');
});

t('compareOffer: loan mode prices the term at the real rate, not the teaser', () => {
  /* Pricing the payment off a 0% teaser leaves a balance the real rate then
     has to carry, and the loan silently runs PAST its stated term — the
     arithmetic that makes a bad offer look survivable. Priced at the real
     rate, a teaser is a bonus instead: it finishes at or before term. */
  const r = C.compareOffer({ balance: 12000, rate: 12, months: 48,
                             introRate: 0, introMonths: 6,
                             currentRate: 18, currentPayment: 400 });
  eq(r.ok, true);
  if (r.months > 48) {
    throw new Error(`a loan must not outrun its own term — got ${r.months} of 48`);
  }
  if (r.months >= 48) {
    throw new Error('six months at 0% should finish it early, not exactly on time');
  }
});

t('compareOffer: refuses without a current payment rather than inventing one', () => {
  const r = C.compareOffer({ balance: 5000, rate: 5, months: 36, currentRate: 20 });
  eq(r.ok, false); eq(r.reason, 'need_current_payment');
});
t('compareOffer: refuses without a balance or a term', () => {
  eq(C.compareOffer({ rate: 5, months: 36, currentRate: 20, currentPayment: 200 }).reason,
     'need_balance_and_term');
  eq(C.compareOffer({ balance: 5000, rate: 5, currentRate: 20, currentPayment: 200 }).reason,
     'need_balance_and_term');
});

t('compareOffer: a current payment that never clears is reported as infinite, not as a win', () => {
  // $40/mo against 22% on $5,000 never pays off — the comparison must not
  // quietly treat "never" as a finite number it can beat by a little.
  const r = C.compareOffer({ balance: 5000, rate: 8, months: 60,
                             currentRate: 22, currentPayment: 40 });
  eq(r.ok, true);
  eq(r.currentMonths, Infinity);
  eq(r.interestSaved, Infinity);
});

t('compareOffer: 0% over a term is plain division, never a divide-by-zero', () => {
  const r = C.compareOffer({ balance: 1200, rate: 0, months: 12,
                             currentRate: 18, currentPayment: 150 });
  near(r.payment, 100, 0.01, 'payment on a 0% 12-month plan should be');
});

/* ═══════════════════════════════════════════════════════════════
   isoDay under a real US timezone.
   Run in a child process with TZ pinned: CI runs in UTC, where the bug
   this guards is invisible because local and UTC agree.
   ═══════════════════════════════════════════════════════════════ */
t('isoDay: an evening in US Central stays on the LOCAL day', () => {
  const { execFileSync } = require('child_process');
  const probe = `
    const C = require('${require('path').join(__dirname, '..', 'www/js/fc-core.js').replace(/\\/g, '/')}');
    const d = new Date(2026, 7, 15, 19, 30);        // 7:30pm local, Aug 15
    const local = C.isoDay(d);
    const utc   = d.toISOString().split('T')[0];
    console.log(JSON.stringify({ local, utc }));
  `;
  const out = execFileSync(process.execPath, ['-e', probe],
    { env: { ...process.env, TZ: 'America/Chicago' }, encoding: 'utf8' });
  const { local, utc } = JSON.parse(out);
  eq(local, '2026-08-15', 'isoDay must report the day the user is living in —');
  // If this stops differing the test has lost its teeth; say so loudly.
  if (utc === local) {
    throw new Error('toISOString() agreed with local — the TZ pin did not take, '
      + 'so this test is no longer proving anything');
  }
  eq(utc, '2026-08-16', 'and UTC should be a day ahead, which is the bug —');
});

t('isoDay: month boundary in the evening does not roll early', () => {
  const { execFileSync } = require('child_process');
  const probe = `
    const C = require('${require('path').join(__dirname, '..', 'www/js/fc-core.js').replace(/\\/g, '/')}');
    const d = new Date(2026, 7, 31, 20, 0);         // 8pm on the 31st
    console.log(JSON.stringify({ month: C.isoDay(d).slice(0, 7) }));
  `;
  const out = execFileSync(process.execPath, ['-e', probe],
    { env: { ...process.env, TZ: 'America/Chicago' }, encoding: 'utf8' });
  // The credit-score key is isoDay(...).slice(0,7); UTC would say September.
  eq(JSON.parse(out).month, '2026-08');
});

/* ═══════════════════════════════════════════════════════════════
   Category normalisation — one map, one normaliser.
   There were two, disagreeing on 18 of 33 realistic inputs, and one of
   those disagreements read a card refund as a paycheck.
   ═══════════════════════════════════════════════════════════════ */
t('normalizeCategory: both Plaid spellings land on one label', () => {
  // Plaid ships the same category underscored or spaced depending on vintage.
  eq(C.normalizeCategory('TRANSFER_OUT'), 'Transfer');
  eq(C.normalizeCategory('Transfer Out'), 'Transfer');
  eq(C.normalizeCategory('LOAN_PAYMENTS'), 'Loan');
  eq(C.normalizeCategory('Loan Payments'), 'Loan');
});
t('normalizeCategory: unmapped categories are still presentable', () => {
  // This used to assert 'SOMETHING UNMAPPED' — uppercase in, uppercase out,
  // because \b\w has no lowercase first letter to raise. That was pinned
  // deliberately, but only to hold parity with what fc-data shipped while
  // the two category maps were being merged into this one. It was never the
  // wanted behaviour; the test's own name asks for "presentable".
  //
  // It matters now: the category budgets screen lists every category the
  // user spends in as its own row, so an unmapped Plaid value is on screen
  // in sentence-case company, shouting. normalizeCategory lowercases before
  // title-casing.
  eq(C.normalizeCategory('SOMETHING_UNMAPPED'), 'Something Unmapped');
  eq(C.normalizeCategory('something_unmapped'), 'Something Unmapped');
  eq(C.normalizeCategory(''), 'Other');
  eq(C.normalizeCategory(null), 'Other');
});
t('isIncomeTxn: a CREDIT_CARD credit is NOT a paycheck', () => {
  /* The live bug. A card refund or statement credit arrives as a CREDIT with
     category CREDIT_CARD. The underscore meant it matched neither the
     exclude-set nor includes('credit card'), so it counted as income — and
     predictNextPayday filters on exactly this, feeding the payday date, the
     expected amount and safe-to-spend. */
  eq(C.isIncomeTxn({ isCredit: true, date: '2026-08-15', category: ['CREDIT_CARD'] }), false);
  eq(C.isIncomeTxn({ isCredit: true, date: '2026-08-15', category: ['Credit Card'] }), false);
  eq(C.isIncomeTxn({ isCredit: true, date: '2026-08-15', category: ['LOAN_PAYMENTS'] }), false);
  // …but a real paycheck still is one.
  eq(C.isIncomeTxn({ isCredit: true, date: '2026-08-15', category: ['INCOME'] }), true);
  // …and so is a direct deposit Plaid files under Transfer In.
  eq(C.isIncomeTxn({ isCredit: true, date: '2026-08-15', category: ['TRANSFER_IN'] }), true);
});
t('predictNextPayday: a card refund does not become a paycheck', () => {
  const paydays = [
    { isCredit: true, date: '2026-06-15', amount: 2000, category: ['INCOME'] },
    { isCredit: true, date: '2026-06-30', amount: 2000, category: ['INCOME'] },
    { isCredit: true, date: '2026-07-15', amount: 2000, category: ['INCOME'] },
    { isCredit: true, date: '2026-07-31', amount: 2000, category: ['INCOME'] },
  ];
  const withRefund = paydays.concat(
    { isCredit: true, date: '2026-07-07', amount: 450, category: ['CREDIT_CARD'] });
  const a = C.predictNextPayday(paydays,    Date.parse('2026-08-01T12:00:00'));
  const b = C.predictNextPayday(withRefund, Date.parse('2026-08-01T12:00:00'));
  eq(b.amount, a.amount, 'a card refund must not change the expected paycheck —');
  eq(b.days,   a.days,   'nor the predicted date —');
});
t('isSpendTxn: transfers and debt payments are still excluded', () => {
  const d = '2026-08-15';
  eq(C.isSpendTxn({ isCredit: false, date: d, category: ['TRANSFER_OUT'] }), false);
  eq(C.isSpendTxn({ isCredit: false, date: d, category: ['Transfer Out'] }), false);
  eq(C.isSpendTxn({ isCredit: false, date: d, category: ['LOAN_PAYMENTS'] }), false);
  eq(C.isSpendTxn({ isCredit: false, date: d, category: ['GROCERIES'] }), true);
  eq(C.isSpendTxn({ isCredit: false, date: d, category: ['FOOD_AND_DRINK'] }), true);
});

/* ═══════════════════════════════════════════════════════════════
   merchantStats / merchantNote — the annotation must stay quiet.
   Every threshold here was chosen against real transactions; these
   pin the ones that must NOT fire as hard as the ones that must.
   ═══════════════════════════════════════════════════════════════ */
const _mDay = (n) => { const d = new Date(); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const _spend = (name, amount, i) => ({ transaction_id: name + i, name, amount,
  date: _mDay(i), category: ['GENERAL_MERCHANDISE'], isCredit: false });
const _mk = (name, amounts) => amounts.map((a, i) => _spend(name, a, i + 1));

t('merchantNote: a real outlier is called out', () => {
  // Casey's, from a real account: five ~$10 visits and one $40.10.
  const txns = _mk("Casey's", [9.37, 9.77, 10.00, 10.07, 10.77, 40.10]);
  const stats = C.merchantStats(txns);
  const big = txns.find(x => x.amount === 40.10);
  const note = C.merchantNote(stats, big);
  eq(note && note.kind, 'high');
  eq(/× your usual$/.test(note.text), true);
});
t('merchantNote: an ordinary visit is never called unusual', () => {
  // It may still say "6 times this period" — that is the frequency note
  // doing its job. What it must never do is call a typical visit an
  // outlier.
  const txns = _mk("Casey's", [9.37, 9.77, 10.00, 10.07, 10.77, 40.10]);
  const stats = C.merchantStats(txns);
  const normal = txns.find(x => x.amount === 10.07);
  const note = C.merchantNote(stats, normal);
  eq(note && note.kind, 'often');
});
t('merchantNote: small absolute swings never fire', () => {
  // Market L ranged $2.28-$6.85 on a real account. 3x of $2 is $6 and
  // nobody needs telling; the +$10 floor is what keeps this quiet.
  const txns = _mk('Market L', [2.28, 2.32, 3.75, 5.42, 5.82, 6.85]);
  const stats = C.merchantStats(txns);
  const top = txns.find(x => x.amount === 6.85);
  const note = C.merchantNote(stats, top);
  eq(note && note.kind !== 'high', true);   // may say "often", never "high"
});
t('merchantNote: frequency needs four visits, outlier needs three', () => {
  const two = C.merchantStats(_mk('Rare', [5, 500]));
  eq(C.merchantNote(two, _spend('Rare', 500, 9)), null);   // no history yet
  const four = C.merchantStats(_mk('Often', [10, 10, 10, 10]));
  const n = C.merchantNote(four, _spend('Often', 10, 9));
  eq(n && n.kind, 'often');
  eq(n.text, '4 times this period');
});
t('merchantNote: median, so the outlier cannot hide inside its own baseline', () => {
  // [10,10,10,25] is the case that separates the two: against the median
  // of 10 the $25 is 2.5x and fires; against the mean of 13.75 it is 1.8x
  // and would slip through.
  const txns = _mk('Shop', [10, 10, 10, 25]);
  const stats = C.merchantStats(txns);
  eq([...stats.values()][0].median, 10);
  eq(C.merchantNote(stats, _spend('Shop', 25, 9)).kind, 'high');
});
t('merchantNote: income and transfers are never annotated', () => {
  const stats = C.merchantStats(_mk('Payer', [100, 100, 100, 100]));
  const credit = { name: 'Payer', amount: 5000, date: _mDay(1), isCredit: true, category: ['INCOME'] };
  eq(C.merchantNote(stats, credit), null);
});

/* ═══════════════════════════════════════════════════════════════
   minPayment / debtRate — precedence between the bank and the user.
   Backwards precedence here means a stale hand-typed rate silently
   overriding a live one from the bank.
   ═══════════════════════════════════════════════════════════════ */
t('minPayment/debtRate: the bank wins when it knows', () => {
  const acct = { id: 'a1', minimum_payment: 35, interest_rate: 22.99 };
  const overlay = { a1: { minimum_payment: 999, interest_rate: 1 } };
  eq(C.minPayment(acct, overlay), 35);
  eq(C.debtRate(acct, overlay), 22.99);
});
t('minPayment/debtRate: the user fills a gap the bank left', () => {
  const acct = { id: 'auto1' };                    // an auto loan: Plaid says nothing
  const overlay = { auto1: { minimum_payment: 412, interest_rate: 6.9 } };
  eq(C.minPayment(acct, overlay), 412);
  eq(C.debtRate(acct, overlay), 6.9);
});
t('minPayment/debtRate: 0 is a real answer from the bank, not an absence', () => {
  // A 0% promo card. Falling through to the overlay here would replace a
  // true 0% with whatever the user typed months ago.
  const acct = { id: 'c1', interest_rate: 0, minimum_payment: 0 };
  const overlay = { c1: { interest_rate: 24.99, minimum_payment: 50 } };
  eq(C.debtRate(acct, overlay), 0);
  eq(C.minPayment(acct, overlay), 0);
});
/* A rate the bank cannot plausibly mean. Plaid's field is a PERCENTAGE
   (7.0 = 7%) but some institutions send the fraction (0.07 = 7%), and the app
   presented the result as fact — it drove avalanche ordering, the weighted
   average and the debt-free date. An incredible rate is treated as absent so
   the user is asked, rather than a number nobody believes being kept. */
t('debtRate: a rate between 0 and 0.5% is not believed', () => {
  const acct = { id: 'sl', interest_rate: 0.07 };       // SoFi, real case
  eq(C.debtRate(acct, { sl: { interest_rate: 7 } }), 7);  // the user's correction lands
  eq(C.debtRate(acct, {}), 0);                            // otherwise: ask, don't guess
});
t('debtRate: exactly 0 is a real promo rate and survives', () => {
  // The band is open at the bottom on purpose — 0% promos report exactly 0.
  eq(C.debtRate({ id: 'p', interest_rate: 0 }, { p: { interest_rate: 24.99 } }), 0);
});
t('debtRate: a credible low rate is still believed', () => {
  eq(C.debtRate({ id: 'm', interest_rate: 0.5 }, { m: { interest_rate: 9 } }), 0.5);
  eq(C.debtRate({ id: 'n', interest_rate: 2.9 }, { n: { interest_rate: 9 } }), 2.9);
});
t('minPayment/debtRate: unknown is 0, never a guess', () => {
  eq(C.minPayment({ id: 'x' }, {}), 0);
  eq(C.debtRate({ id: 'x' }, undefined), 0);
  eq(C.debtRate(null, null), 0);
});
t('accountKey: Plaid sends id, demo and legacy manual send account_id', () => {
  eq(C.accountKey({ id: 'plaid-1' }), 'plaid-1');
  eq(C.accountKey({ account_id: 'demo-cc' }), 'demo-cc');
  // Keying on the wrong one collapses every account onto '' — one shared overlay.
  eq(C.accountKey({}), '');
  eq(C.accountKey(null), '');
});

/* ═══════════════════════════════════════════════════════════════
   totalBudgetLimit — there were once three of these, disagreeing.
   ═══════════════════════════════════════════════════════════════ */
t('totalBudgetLimit: an explicit total wins over the category sum', () => {
  eq(C.totalBudgetLimit({ total: { limit: 2000 }, food: { limit: 400 } }), 2000);
});
t('totalBudgetLimit: with no total, categories sum — and total is not double-counted', () => {
  eq(C.totalBudgetLimit({ food: { limit: 400 }, gas: { limit: 150 } }), 550);
  eq(C.totalBudgetLimit({ total: { limit: 0 }, food: { limit: 400 } }), 400);
});
t('totalBudgetLimit: nothing budgeted is 0, not NaN', () => {
  eq(C.totalBudgetLimit({}), 0);
  eq(C.totalBudgetLimit(null), 0);
  eq(C.totalBudgetLimit({ food: {} }), 0);
});

/* ── Subscriptions ────────────────────────────────────────────────
   Every case here is one where the old code showed a number that was
   wrong, or dropped a subscription it should have surfaced. */

const DAY = 86400000;
/* Build entries ending `endDaysAgo` before `today`, spaced by cadence. */
function subOf(name, freq, amounts, endDaysAgo = 0, today = new Date('2026-08-23T12:00:00')) {
  const step = C.SUB_CYCLE_DAYS[freq] * DAY;
  const end  = today.getTime() - endDaysAgo * DAY;
  const entries = amounts.map((amount, i) => {
    const ts = end - (amounts.length - 1 - i) * step;
    return { amount, ts, date: C.isoDay(new Date(ts)) };
  });
  const sorted = [...amounts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    name, freq,
    amount: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    entries,
    lastDate: entries[entries.length - 1].date,
  };
}
const TODAY = new Date('2026-08-23T12:00:00');

t('subMonthly: every cadence normalises to a real monthly cost', () => {
  near(C.subMonthly({ amount: 22.99, freq: 'mo' }), 22.99, 0.01);
  near(C.subMonthly({ amount: 139,   freq: 'yr' }), 11.58, 0.02, 'annual');
  near(C.subMonthly({ amount: 9.99,  freq: 'wk' }), 43.44, 0.05, 'weekly');
  near(C.subMonthly({ amount: 20,    freq: '2mo' }), 10.0, 0.02, 'bi-monthly');
});

t('subMonthly: the mixed-cadence total that used to be more than double', () => {
  // The old code summed amounts regardless of cadence: $171.98/mo, $2,063.76/yr.
  const subs = [
    { amount: 22.99, freq: 'mo' },
    { amount: 139,   freq: 'yr' },
    { amount: 9.99,  freq: 'wk' },
  ];
  const monthly = subs.reduce((s, x) => s + C.subMonthly(x), 0);
  near(monthly, 78.01, 0.05);
  near(monthly * 12, 936.13, 0.5);
});

t('subMonthly: junk cadence and junk amount cost nothing, not NaN', () => {
  eq(C.subMonthly({ amount: 10, freq: 'fortnightly' }), 0);
  eq(C.subMonthly({ amount: -5, freq: 'mo' }), 0);
  eq(C.subMonthly(null), 0);
});

t('subStatus: a monthly charge 8 months silent is lapsed, not active', () => {
  eq(C.subStatus(subOf('Netflix', 'mo', [15.49, 15.49, 15.49], 240), TODAY), 'lapsed');
});

t('subStatus: ordinary billing drift is still active', () => {
  // 45 days out — a card reissue or a weekend, not a cancellation.
  eq(C.subStatus(subOf('Spotify', 'mo', [11.99, 11.99, 11.99], 45), TODAY), 'active');
});

t('subStatus: an annual sub is not lapsed just for being 3 months quiet', () => {
  eq(C.subStatus(subOf('Prime', 'yr', [139, 139], 90), TODAY), 'active');
});

t('subStatus: unknown when there is no date or no cadence to judge by', () => {
  eq(C.subStatus({ freq: 'mo' }, TODAY), 'unknown');
  eq(C.subStatus({ lastDate: '2026-08-01' }, TODAY), 'unknown');
});

t('subPriceChange: catches the doubling the variance gate used to delete', () => {
  // Disney+ 7.99 → 15.99 scored 33% variance and was dropped from the list
  // entirely — the subscription most worth flagging was the one that vanished.
  const p = C.subPriceChange(subOf('Disney+', 'mo',
    [7.99, 7.99, 7.99, 7.99, 7.99, 7.99, 15.99, 15.99, 15.99, 15.99, 15.99, 15.99]));
  ok(p.changed, 'should detect the change');
  near(p.from, 7.99);
  near(p.to, 15.99);
  eq(p.pct, 100);
});

t('subPriceChange: the prior price is the mode, not the mean', () => {
  // Dragged toward the new price, a mean makes a real hike look like noise.
  const p = C.subPriceChange(subOf('Netflix', 'mo',
    [15.49, 15.49, 22.99, 22.99, 22.99, 22.99, 22.99]));
  near(p.from, 15.49);
  near(p.to, 22.99);
  eq(p.pct, 48);
});

t('subPriceChange: a steady price is not a change', () => {
  eq(C.subPriceChange(subOf('Spotify', 'mo', [11.99, 11.99, 11.99, 11.99])).changed, false);
});

t('subPriceChange: too little history to judge says no, rather than guessing', () => {
  eq(C.subPriceChange(subOf('New', 'mo', [9.99, 12.99])).changed, false);
});

t('subPriceChange: a price DROP reports as negative, not as an increase', () => {
  const p = C.subPriceChange(subOf('Hulu', 'mo', [17.99, 17.99, 17.99, 12.99]));
  ok(p.changed);
  ok(p.pct < 0, 'a cut should be negative, got ' + p.pct);
});

t('subCategory: known services group, unknown ones stay ungrouped', () => {
  eq(C.subCategory('Spotify Premium'), 'music');
  eq(C.subCategory('Apple Music'), 'music');
  eq(C.subCategory('Netflix'), 'video');
  eq(C.subCategory('1Password'), 'password');
  eq(C.subCategory("Dave's Hot Chicken"), null);
});

t('subCutCandidates: overlapping services flag the pricier, keep the cheaper', () => {
  const subs = [
    subOf('Spotify',     'mo', [11.99, 11.99, 11.99]),
    subOf('Apple Music', 'mo', [10.99, 10.99, 10.99]),
  ];
  const { candidates } = C.subCutCandidates(subs, TODAY);
  eq(candidates.length, 1);
  eq(candidates[0].name, 'Spotify');
  eq(candidates[0].reason, 'duplicate');
  eq(candidates[0].detail.alsoPaying, 'Apple Music');
});

t('subCutCandidates: one subscription is never counted under two reasons', () => {
  // Lapsed AND a price hike AND a duplicate — it must still be one row, or
  // the "you could save" figure counts the same money three times.
  const subs = [
    subOf('Netflix', 'mo', [9.99, 9.99, 9.99, 19.99, 19.99], 300),
    subOf('Hulu',    'mo', [17.99, 17.99, 17.99]),
  ];
  const { candidates } = C.subCutCandidates(subs, TODAY);
  eq(candidates.filter(c => c.name === 'Netflix').length, 1);
  eq(candidates.find(c => c.name === 'Netflix').reason, 'lapsed');
});

t('subCutCandidates: the total equals the rounded rows on screen', () => {
  const subs = [
    subOf('Gone',    'mo', [10.40, 10.40, 10.40], 300),
    subOf('AlsoGone','mo', [5.40,  5.40,  5.40 ], 300),
  ];
  const r = C.subCutCandidates(subs, TODAY);
  const shown = r.candidates.reduce((s, c) => s + Math.round(c.yearly), 0);
  eq(r.totalYearly, shown, 'total must equal what the rows add to');
});

t('subCutCandidates: a small hike is noise, not a recommendation', () => {
  const subs = [subOf('Steady', 'mo', [10.00, 10.00, 10.00, 10.50])];
  eq(C.subCutCandidates(subs, TODAY).candidates.length, 0);
});

t('subSummary: lapsed subscriptions leave the active total', () => {
  const subs = [
    subOf('Live',   'mo', [10, 10, 10]),
    subOf('Dead',   'mo', [50, 50, 50], 300),
  ];
  const s = C.subSummary(subs, TODAY);
  eq(s.count, 1);
  near(s.monthly, 10, 0.05);
  eq(s.lapsed.length, 1);
});

t('subSummary: yearly is derived from the monthly figure it prints', () => {
  const subs = [subOf('A', 'mo', [10.40, 10.40, 10.40]), subOf('B', 'mo', [5.40, 5.40, 5.40])];
  const s = C.subSummary(subs, TODAY);
  // 10.40 + 5.40 = 15.80 → shown as $16 → 16 * 12 = 192, never 189.60.
  eq(s.yearly, 192);
});

t('subSummary: an empty list is zero everywhere, not NaN', () => {
  const s = C.subSummary([], TODAY);
  eq(s.count, 0); eq(s.monthly, 0); eq(s.yearly, 0);
  eq(s.cuts.totalYearly, 0);
});

/* ── Bills ────────────────────────────────────────────────────────
   frequency and autopay were both stored on every bill and read by
   nothing but a label and a badge. */

const B = (name, amount, dueDaysOut, extra) => Object.assign({
  name, amount, status: 'unpaid',
  due_date: C.isoDay(new Date(new Date('2026-08-23T12:00:00').getTime() + dueDaysOut * 86400000)),
}, extra || {});
const BNOW = new Date('2026-08-23T12:00:00');
const PAYDAY = new Date('2026-09-03T12:00:00');

t('billMonthly: an annual bill is not a monthly bill', () => {
  near(C.billMonthly({ amount: 139, frequency: 'annual' }), 11.58, 0.02);
  near(C.billMonthly({ amount: 60,  frequency: 'weekly' }), 260.9, 0.5);
  near(C.billMonthly({ amount: 120, frequency: 'monthly' }), 120);
});

t('billMonthly: a one-time bill is not a commitment', () => {
  eq(C.billMonthly({ amount: 500, frequency: 'one-time' }), 0);
});

t('billMonthly: an unknown or missing cadence falls back to monthly', () => {
  eq(C.billMonthly({ amount: 100 }), 100);
  eq(C.billMonthly({ amount: 100, frequency: 'fortnightly' }), 100);
  eq(C.billMonthly({ amount: 0, frequency: 'monthly' }), 0);
  eq(C.billMonthly(null), 0);
});

t('billsMonthlyTotal: the mixed-cadence total nothing used to compute', () => {
  const bills = [
    B('Rent', 1200, 3, { frequency: 'monthly' }),
    B('Prime', 139, 10, { frequency: 'annual' }),
    B('Cleaner', 60, 2, { frequency: 'weekly' }),
  ];
  // Naive sum: 1399. Real monthly commitment: 1200 + 11.58 + 260.89.
  near(C.billsMonthlyTotal(bills), 1472.47, 0.5);
});

t('billsDueBefore: paid bills and bills after payday are excluded', () => {
  const bills = [
    B('Rent', 1200, 3),
    B('Paid already', 80, 4, { status: 'paid' }),
    B('After payday', 90, 20),
  ];
  const due = C.billsDueBefore(bills, PAYDAY, BNOW);
  eq(due.length, 1);
  eq(due[0].name, 'Rent');
});

t('billsDueBefore: returns them in due order, not list order', () => {
  const due = C.billsDueBefore([B('Later', 10, 8), B('Sooner', 10, 1)], PAYDAY, BNOW);
  eq(due[0].name, 'Sooner');
});

t('billCoverage: comfortably covered reports the spare, not a shortfall', () => {
  const r = C.billCoverage({ bills: [B('Rent', 1200, 3)], payday: PAYDAY, cash: 1500, today: BNOW });
  eq(r.covered, true);
  eq(r.shortfall, 0);
  near(r.spare, 300);
  eq(r.breaking, null);
});

t('billCoverage: names the bill that breaks, in due order', () => {
  // $500 cash, $100 then $900. The $100 clears; the $900 is the one that
  // fails. Comparing totals alone could not say which.
  const r = C.billCoverage({
    bills: [B('Small', 100, 1), B('Big', 900, 5)],
    payday: PAYDAY, cash: 500, today: BNOW,
  });
  eq(r.covered, false);
  eq(r.breaking.name, 'Big');
  near(r.breaking.shortBy, 500);
  near(r.shortfall, 500);
});

t('billCoverage: autopay bills past the break are the overdraft risk', () => {
  const r = C.billCoverage({
    bills: [B('Rent', 900, 1), B('Gym', 60, 4, { autopay: true }), B('Manual', 40, 5)],
    payday: PAYDAY, cash: 900, today: BNOW,
  });
  eq(r.covered, false);
  eq(r.autopayAtRisk.length, 1);
  eq(r.autopayAtRisk[0].name, 'Gym', 'the manual bill can be delayed; autopay cannot');
});

t('billCoverage: no bills due is covered, not a division by nothing', () => {
  const r = C.billCoverage({ bills: [], payday: PAYDAY, cash: 100, today: BNOW });
  eq(r.count, 0); eq(r.covered, true); eq(r.total, 0); near(r.spare, 100);
});

t('billCoverage: with no payday known it still judges every unpaid bill', () => {
  const r = C.billCoverage({ bills: [B('Rent', 50, 2)], payday: null, cash: 10, today: BNOW });
  eq(r.count, 1);
  eq(r.covered, false);
});

t('billDrift: a stale amount is caught, with the real figure', () => {
  const txns = [
    { name: 'Electric Co', amount: 167, date: '2026-08-01' },
    { name: 'Electric Co', amount: 165, date: '2026-07-01' },
    { name: 'Electric Co', amount: 169, date: '2026-06-01' },
  ];
  const d = C.billDrift(B('Electric Co', 130, 5), txns);
  ok(d.drifted);
  near(d.actual, 167);
  eq(d.stated, 130);
  eq(d.pct, 28);
});

t('billDrift: normal utility wobble is not a finding', () => {
  const txns = [
    { name: 'Electric Co', amount: 132, date: '2026-08-01' },
    { name: 'Electric Co', amount: 129, date: '2026-07-01' },
  ];
  eq(C.billDrift(B('Electric Co', 130, 5), txns).drifted, false);
});

t('billDrift: one charge is not evidence, and credits never count', () => {
  eq(C.billDrift(B('Electric Co', 130, 5),
     [{ name: 'Electric Co', amount: 400, date: '2026-08-01' }]).drifted, false);
  eq(C.billDrift(B('Electric Co', 130, 5), [
     { name: 'Electric Co', amount: 400, date: '2026-08-01', isCredit: true },
     { name: 'Electric Co', amount: 400, date: '2026-07-01', isCredit: true },
  ]).drifted, false);
});

t('billDrift: a bill that got CHEAPER reports a negative, not a rise', () => {
  const txns = [
    { name: 'Insurance', amount: 90, date: '2026-08-01' },
    { name: 'Insurance', amount: 90, date: '2026-07-01' },
  ];
  const d = C.billDrift(B('Insurance', 130, 5), txns);
  ok(d.drifted);
  ok(d.pct < 0, 'expected a negative pct, got ' + d.pct);
});

console.log(`fc-core: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('');
  fails.forEach(f => console.error(`  ✗ ${f.name}\n      ${f.msg}`));
  console.error('');
  process.exit(1);
}
console.log('✓ all core money-math tests pass.');
