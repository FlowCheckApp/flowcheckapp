#!/usr/bin/env node
/**
 * test-vault.js — unit tests for the proof-of-savings engine.
 *
 * fc-vault.js decides how much FlowCheck is allowed to charge someone. Every
 * test below is a way the Vault could inflate a savings number, which is the
 * same thing as overbilling a customer. The generous-rounding failures are
 * the important ones — a bug that credits too little costs the company money,
 * a bug that credits too much costs the company its only claim to being
 * different.
 *
 * No framework, same as test-core.js — runs anywhere Node runs, in
 * `npm run check`, before deploy.sh will let anything ship.
 */
'use strict';

const V = require('../www/js/fc-vault.js');

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
/* LOCAL date components — see the same note in test-core.js. A UTC-based
   helper makes "today" drift a day ahead each evening, which here would
   silently WEAKEN the no-future-credits assertion rather than break it. */
const iso = n => {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
       + '-' + String(d.getDate()).padStart(2, '0');
};
const ago = n => iso(-n);
const debit  = (amt, date, name, cat) => ({ amount: amt, isCredit: false, date, name, merchant_name: name, category: cat || 'Shopping' });
const credit = (amt, date, name) => ({ amount: amt, isCredit: true, date, name, merchant_name: name, category: 'Shopping' });
const sub = (name, amount, freq, lastDate) => ({ name, amount, freq, lastDate });

/* ═══════════════════════════════════════════════════════════════
   OBSERVED FEES — never invent a number
   ═══════════════════════════════════════════════════════════════ */
t('observedFee: no history means zero, not the industry average', () => {
  eq(V.observedFee([debit(12, ago(5), 'Coffee')], 'overdraft'), 0);
});
t('observedFee: uses the median of what this bank actually charged', () => {
  eq(V.observedFee([
    debit(35, ago(60), 'OVERDRAFT FEE'),
    debit(35, ago(30), 'OVERDRAFT FEE'),
    debit(29, ago(10), 'NSF FEE'),
  ], 'overdraft'), 35);
});
t('observedFee: ignores an implausible "fee" that is really a bill', () => {
  eq(V.observedFee([debit(450, ago(9), 'LATE FEE ASSESSMENT')], 'late'), 0);
});
t('observedFee: credits are not fees', () => {
  eq(V.observedFee([credit(35, ago(9), 'OVERDRAFT FEE REFUND')], 'overdraft'), 0);
});

/* ═══════════════════════════════════════════════════════════════
   SUBSCRIPTIONS — accrue monthly, never book the year up front
   ═══════════════════════════════════════════════════════════════ */
const FLAGGED = { [V.merchantKey('Netflix')]: ago(200) };

t('subscriptionsEnded: still billing on schedule earns nothing', () => {
  eq(V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(20))], FLAGGED, new Date()).length, 0);
});
t('subscriptionsEnded: one credit per skipped cycle, not twelve on day one', () => {
  // 75 quiet days on a 30-day cycle = 2 charges that never came.
  const e = V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], FLAGGED, new Date());
  eq(e.length, 2);
  near(e.reduce((s, x) => s + x.amount, 0), 31.98);
});
t('subscriptionsEnded: caps at one year even after five years quiet', () => {
  const e = V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(1800))], FLAGGED, new Date());
  eq(e.length, 12, 'should never pay out beyond the 12-cycle life');
});
t('subscriptionsEnded: never credits a cycle that has not happened yet', () => {
  const e = V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], FLAGGED, new Date());
  ok(e.every(x => x.date <= iso(0)), 'no future-dated credits');
});
t('subscriptionsEnded: a cancellation we never surfaced is not billable', () => {
  const e = V.subscriptionsEnded([sub('Hulu', 17.99, 'mo', ago(75))], FLAGGED, new Date());
  ok(e.length > 0, 'still recorded in the ledger');
  ok(e.every(x => x.billable === false), 'but never billed against');
});
t('subscriptionsEnded: flagged AFTER the last charge is not attributable', () => {
  const late = { [V.merchantKey('Netflix')]: ago(10) };   // we noticed after it died
  const e = V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], late, new Date());
  ok(e.every(x => x.billable === false));
});
t('subscriptionsEnded: ids are deterministic so re-running cannot double-count', () => {
  const a = V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], FLAGGED, new Date());
  const b = V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], FLAGGED, new Date());
  eq(a.map(x => x.id).join(), b.map(x => x.id).join());
});
t('subscriptionsEnded: 1.5 cycles is the floor for calling it dead', () => {
  eq(V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(40))], FLAGGED, new Date()).length, 0);
});
t('subscriptionsEnded: unknown cadence is not guessed at', () => {
  eq(V.subscriptionsEnded([sub('Netflix', 15.99, 'quarterly', ago(400))], FLAGGED, new Date()).length, 0);
});

/* ── A dead bank connection must not read as mass cancellation ──── */
t('subscriptionsEnded: no credit for cycles after the feed went quiet', () => {
  // Last charged 75 days ago on a 30-day cycle, so charges were due 45 and
  // 15 days ago. The feed stops 40 days ago: we saw the first one not
  // arrive, and were blind for the second.
  const e = V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], FLAGGED, new Date(), ago(40));
  eq(e.length, 1, 'only the cycle inside the observed window counts');
});
t('subscriptionsEnded: a feed that died before the first missed charge proves nothing', () => {
  eq(V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], FLAGGED, new Date(), ago(50)).length, 0);
});
t('subscriptionsEnded: a long-dead connection is never mass cancellation', () => {
  eq(V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], FLAGGED, new Date(), ago(70)).length, 0);
});
t('subscriptionsEnded: a live feed is unaffected by the guard', () => {
  eq(V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], FLAGGED, new Date(), ago(0)).length, 2);
});
t('detectEvents: infers the feed cutoff from the newest transaction', () => {
  // Newest transaction is 40 days old, so the more recent cycle is unobservable.
  const e = V.detectEvents({
    subscriptions: [sub('Netflix', 15.99, 'mo', ago(75))],
    flagged: FLAGGED,
    transactions: [debit(20, ago(40), 'Store')],
  }).filter(x => x.kind === 'subscription_ended');
  eq(e.length, 1);
});

/* ═══════════════════════════════════════════════════════════════
   OVERDRAFTS — no fee history, no credit, ever
   ═══════════════════════════════════════════════════════════════ */
const FEE_HISTORY = [debit(35, ago(300), 'OVERDRAFT FEE'), debit(35, ago(260), 'OVERDRAFT FEE')];
const dodged = { target_date: ago(5), predicted_on: ago(12), predicted_end: -40, actual_end: 120 };

t('overdraftsAvoided: nothing for a user who has never been charged one', () => {
  eq(V.overdraftsAvoided([dodged], [debit(9, ago(5), 'Coffee')]).length, 0);
});
t('overdraftsAvoided: worth half of this user\'s own fee', () => {
  const e = V.overdraftsAvoided([dodged], FEE_HISTORY);
  eq(e.length, 1);
  near(e[0].amount, 17.50, 0.01, 'a $35 fee, haircut 50% for unproven causation');
});
t('overdraftsAvoided: a forecast that never called for trouble earns nothing', () => {
  eq(V.overdraftsAvoided([{ ...dodged, predicted_end: 200 }], FEE_HISTORY).length, 0);
});
t('overdraftsAvoided: if they went negative anyway, we were just wrong', () => {
  eq(V.overdraftsAvoided([{ ...dodged, actual_end: -60 }], FEE_HISTORY).length, 0);
});
t('overdraftsAvoided: a fee inside the window disproves the claim', () => {
  const withFee = FEE_HISTORY.concat([debit(35, ago(6), 'OVERDRAFT FEE')]);
  eq(V.overdraftsAvoided([dodged], withFee).length, 0);
});
t('overdraftsAvoided: an unsettled forecast is not scored', () => {
  eq(V.overdraftsAvoided([{ ...dodged, actual_end: null }], FEE_HISTORY).length, 0);
});

/* ═══════════════════════════════════════════════════════════════
   UNDERSPEND — a coin flip is not an achievement
   ═══════════════════════════════════════════════════════════════ */
function monthly(spendByMonth) {
  const out = [];
  for (const [m, total] of Object.entries(spendByMonth)) out.push(debit(total, m + '-15', 'Store'));
  return out;
}

t('underspendCredits: beating the average but not the low earns nothing', () => {
  // 1000 is below the 1100 median but above the 900 floor — that is noise.
  const txns = monthly({ '2026-01': 1200, '2026-02': 900, '2026-03': 1100, '2026-04': 1000 });
  eq(V.underspendCredits(txns, new Date('2026-05-10')).length, 0);
});
t('underspendCredits: a genuine new low earns half the gap to normal', () => {
  const txns = monthly({ '2026-01': 1200, '2026-02': 900, '2026-03': 1100, '2026-04': 700 });
  const e = V.underspendCredits(txns, new Date('2026-05-10'));
  eq(e.length, 1);
  near(e[0].amount, 200, 0.01, 'median 1100 − spent 700 = 400, halved');
});
t('underspendCredits: the month in progress is never scored', () => {
  const txns = monthly({ '2026-01': 1200, '2026-02': 900, '2026-03': 1100, '2026-04': 5 });
  eq(V.underspendCredits(txns, new Date('2026-04-20')).length, 0);
});
t('underspendCredits: fewer than three prior months is not enough to judge', () => {
  const txns = monthly({ '2026-02': 900, '2026-03': 1100, '2026-04': 100 });
  eq(V.underspendCredits(txns, new Date('2026-05-10')).length, 0);
});

/* ═══════════════════════════════════════════════════════════════
   REFUNDS — finding a double charge saves nothing; getting it back does
   ═══════════════════════════════════════════════════════════════ */
t('refundsRecovered: a duplicate with no refund is not a saving', () => {
  eq(V.refundsRecovered([
    debit(89.99, ago(30), 'Acme Store'),
    debit(89.99, ago(29), 'Acme Store'),
  ]).length, 0);
});
t('refundsRecovered: duplicate plus matching refund is the full amount', () => {
  const e = V.refundsRecovered([
    debit(89.99, ago(30), 'Acme Store'),
    debit(89.99, ago(29), 'Acme Store'),
    credit(89.99, ago(20), 'Acme Store'),
  ]);
  eq(e.length, 1);
  near(e[0].amount, 89.99);
  eq(e[0].confidence, 'observed', 'both sides on the statement — nothing inferred');
});
t('refundsRecovered: a refund 90 days later is not tied to the charge', () => {
  eq(V.refundsRecovered([
    debit(89.99, ago(120), 'Acme Store'),
    debit(89.99, ago(119), 'Acme Store'),
    credit(89.99, ago(20), 'Acme Store'),
  ]).length, 0);
});
t('refundsRecovered: two normal purchases a week apart are not a double charge', () => {
  eq(V.refundsRecovered([
    debit(89.99, ago(30), 'Acme Store'),
    debit(89.99, ago(23), 'Acme Store'),
    credit(89.99, ago(20), 'Acme Store'),
  ]).length, 0);
});
t('refundsRecovered: different merchants are not the same charge', () => {
  eq(V.refundsRecovered([
    debit(89.99, ago(30), 'Acme Store'),
    debit(89.99, ago(29), 'Other Store'),
    credit(89.99, ago(20), 'Acme Store'),
  ]).length, 0);
});

/* ═══════════════════════════════════════════════════════════════
   THE BILL — the line that decides what a customer is charged
   ═══════════════════════════════════════════════════════════════ */
const M = '2026-06';
const ev = (amount, billable) => ({ id: 'x' + Math.random(), date: M + '-10', amount, billable: billable !== false });

t('statementFor: nothing proven means the month is free', () => {
  const s = V.statementFor([], M);
  eq(s.fee, 0); eq(s.free, true);
});
t('statementFor: fee is a quarter of proven savings', () => {
  const s = V.statementFor([ev(20)], M);
  near(s.fee, 5.00); near(s.youKeep, 15.00); eq(s.free, false);
});
t('statementFor: fee is capped at list price no matter how big the win', () => {
  const s = V.statementFor([ev(4000)], M);
  near(s.fee, 9.99); eq(s.atCap, true);
});
t('statementFor: the user always keeps at least 75%', () => {
  for (const amt of [1, 7.5, 40, 39.96, 100, 1999]) {
    const s = V.statementFor([ev(amt)], M);
    ok(s.fee <= s.proven * 0.25 + 0.005, `fee ${s.fee} exceeded 25% of ${s.proven}`);
    ok(s.fee <= 9.99 + 0.005, `fee ${s.fee} exceeded list price`);
    near(s.proven, s.fee + s.youKeep, 0.01, 'proven must reconcile to fee + keep');
  }
});
t('statementFor: unattributed wins are shown but never billed against', () => {
  const s = V.statementFor([ev(40, false)], M);
  eq(s.fee, 0); eq(s.free, true); near(s.ownWins, 40);
});
t('statementFor: a runaway month is capped before it can be billed', () => {
  const s = V.statementFor([ev(400), ev(400), ev(400), ev(400), ev(400), ev(400)], M);
  eq(s.proven, 2000); eq(s.cappedAt, 2000);
});
t('statementFor: other months do not leak into this one', () => {
  const s = V.statementFor([{ id: 'a', date: '2026-05-10', amount: 400, billable: true }], M);
  eq(s.proven, 0); eq(s.free, true);
});
t('statementFor: a fee never exceeds what was actually proven', () => {
  const s = V.statementFor([ev(2)], M);
  ok(s.fee <= s.proven, 'billing more than we saved is the one unforgivable bug');
  near(s.fee, 0.50);
});

/* ═══════════════════════════════════════════════════════════════
   LIFETIME — the Vault balance is the user's money
   ═══════════════════════════════════════════════════════════════ */
t('vaultSummary: balance is everything proven minus everything billed', () => {
  const s = V.vaultSummary([
    { id: 'a', date: '2026-05-10', amount: 100, billable: true },
    { id: 'b', date: '2026-06-10', amount: 20,  billable: true },
  ]);
  eq(s.months, 2);
  near(s.proven, 120);
  near(s.feesBilled, 9.99 + 5.00);
  near(s.balance, 120 - 14.99);
});
t('vaultSummary: months that proved nothing are counted as free', () => {
  const s = V.vaultSummary([
    { id: 'a', date: '2026-05-10', amount: 0,  billable: true },
    { id: 'b', date: '2026-06-10', amount: 80, billable: true },
  ]);
  eq(s.freeMonths, 1);
});
t('vaultSummary: reports what a flat subscription would have cost instead', () => {
  const s = V.vaultSummary([
    { id: 'a', date: '2026-05-10', amount: 0, billable: true },
    { id: 'b', date: '2026-06-10', amount: 8, billable: true },
  ]);
  near(s.flatWouldBe, 19.98);
  near(s.saved, 19.98 - 2.00);
});
t('vaultSummary: empty ledger is a coherent zero, not a crash', () => {
  const s = V.vaultSummary([]);
  eq(s.months, 0); eq(s.proven, 0); eq(s.feesBilled, 0); eq(s.balance, 0);
});

/* ═══════════════════════════════════════════════════════════════
   DETECTION — idempotence is what keeps the ledger honest
   ═══════════════════════════════════════════════════════════════ */
t('detectEvents: running twice over the same data changes nothing', () => {
  const input = {
    subscriptions: [sub('Netflix', 15.99, 'mo', ago(75))],
    flagged: FLAGGED,
    transactions: FEE_HISTORY,
    forecasts: [dodged],
  };
  const a = V.detectEvents(input), b = V.detectEvents(input);
  eq(a.length, b.length);
  eq(a.map(x => x.id + x.amount).join('|'), b.map(x => x.id + x.amount).join('|'));
});
t('detectEvents: every credit carries evidence you can check', () => {
  const e = V.detectEvents({
    subscriptions: [sub('Netflix', 15.99, 'mo', ago(75))],
    flagged: FLAGGED, transactions: FEE_HISTORY, forecasts: [dodged],
  });
  ok(e.length > 0);
  ok(e.every(x => x.evidence && Object.keys(x.evidence).length > 0), 'a claim with no receipt is not a claim');
  ok(e.every(x => x.amount >= 0), 'no negative credits');
  ok(e.every(x => x.id && x.kind && x.date && x.title), 'every event must be renderable');
});
t('detectEvents: no data at all yields an empty, free month', () => {
  const e = V.detectEvents({});
  eq(e.length, 0);
  eq(V.statementFor(e, '2026-06').free, true);
});
t('detectEvents: newest first', () => {
  const e = V.detectEvents({
    subscriptions: [sub('Netflix', 15.99, 'mo', ago(200))],
    flagged: FLAGGED,
  });
  for (let i = 1; i < e.length; i++) ok(e[i - 1].date >= e[i].date, 'ledger must read newest first');
});

/* ── report ─────────────────────────────────────────────────────── */
console.log(`fc-vault: ${passed} passed, ${failed} failed`);
if (failed) {
  console.error('');
  fails.forEach(f => console.error(`  ✗ ${f.name}\n      ${f.msg}`));
  console.error('');
  process.exit(1);
}
console.log('✓ all proof-of-savings tests pass.');
