#!/usr/bin/env node
/**
 * test-vault.js — unit tests for the proof-of-savings engine.
 *
 * The Vault charges nothing — it is a tool included with the Pro subscription.
 * What fc-vault.js decides is what FlowCheck may CLAIM it saved someone, and
 * every test below is a way that claim could be inflated. A number nobody can
 * disprove is marketing; this screen invites the user to check each line
 * against their own bank statement, so a generous rounding here costs the
 * app the only thing that makes it worth connecting a bank account to.
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
t('subscriptionsEnded: a cancellation we never surfaced is not credited to us', () => {
  const e = V.subscriptionsEnded([sub('Hulu', 17.99, 'mo', ago(75))], FLAGGED, new Date());
  ok(e.length > 0, 'still recorded in the ledger');
  ok(e.every(x => x.attributed === false), 'but never counted as our win');
});
t('subscriptionsEnded: flagged AFTER the last charge is not attributable', () => {
  const late = { [V.merchantKey('Netflix')]: ago(10) };   // we noticed after it died
  const e = V.subscriptionsEnded([sub('Netflix', 15.99, 'mo', ago(75))], late, new Date());
  ok(e.every(x => x.attributed === false));
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
   THE RETURN — did the subscription pay for itself?
   ═══════════════════════════════════════════════════════════════
   The Vault charges nothing. subscriptionCost is a yardstick, not a fee,
   so what these tests protect is the honesty of the RETURN: that it never
   counts money FlowCheck did not cause, never runs away on one anomaly,
   and never quietly borrows a win from another month. */
const M = '2026-06';
const ev = (amount, attributed) => ({ id: 'x' + Math.random(), date: M + '-10', amount, attributed: attributed !== false });

t('statementFor: nothing proven is an empty month, and costs nothing extra', () => {
  const s = V.statementFor([], M);
  eq(s.proven, 0); eq(s.empty, true); eq(s.paidForItself, false);
});
t('statementFor: the Vault never produces a charge of any kind', () => {
  const s = V.statementFor([ev(400)], M);
  // Nothing in the statement may look like money taken from the user.
  for (const k of ['fee', 'youKeep', 'charge', 'billed', 'amountDue', 'takeRate']) {
    ok(s[k] === undefined, `statement must not expose a "${k}" — the Vault bills nothing`);
  }
});
t('statementFor: a month that clears the subscription says so', () => {
  const s = V.statementFor([ev(20)], M);
  eq(s.paidForItself, true);
  near(s.netBenefit, 20 - 9.99);
  near(s.multiple, 2.0);
});
t('statementFor: a month that does not clear it is not dressed up', () => {
  const s = V.statementFor([ev(4)], M);
  eq(s.paidForItself, false);
  near(s.netBenefit, 4 - 9.99);   // negative, and stays negative
  ok(s.netBenefit < 0, 'a short month must report a negative net, not zero');
});
t('statementFor: the return is never inflated above what was proven', () => {
  for (const amt of [1, 7.5, 40, 100, 1999]) {
    const s = V.statementFor([ev(amt)], M);
    near(s.proven, Math.min(amt, 2000), 0.01);
    near(s.netBenefit, s.proven - s.subscriptionCost, 0.01);
  }
});
t('statementFor: unattributed wins are shown but excluded from the return', () => {
  const s = V.statementFor([ev(40, false)], M);
  eq(s.proven, 0); eq(s.empty, true); near(s.ownWins, 40);
});
t('statementFor: a runaway month is capped before it can be claimed', () => {
  const s = V.statementFor([ev(400), ev(400), ev(400), ev(400), ev(400), ev(400)], M);
  eq(s.proven, 2000); eq(s.cappedAt, 2000);
});
t('statementFor: other months do not leak into this one', () => {
  const s = V.statementFor([{ id: 'a', date: '2026-05-10', amount: 400, attributed: true }], M);
  eq(s.proven, 0); eq(s.empty, true);
});

/* ═══════════════════════════════════════════════════════════════
   LIFETIME — proven against paid
   ═══════════════════════════════════════════════════════════════ */
t('vaultSummary: net benefit is everything proven minus everything paid', () => {
  const s = V.vaultSummary([
    { id: 'a', date: '2026-05-10', amount: 100, attributed: true },
    { id: 'b', date: '2026-06-10', amount: 20,  attributed: true },
  ]);
  eq(s.months, 2);
  near(s.proven, 120);
  near(s.subscriptionPaid, 19.98);
  near(s.netBenefit, 120 - 19.98);
});
t('vaultSummary: counts the months that actually paid for themselves', () => {
  const s = V.vaultSummary([
    { id: 'a', date: '2026-05-10', amount: 0,  attributed: true },
    { id: 'b', date: '2026-06-10', amount: 80, attributed: true },
  ]);
  eq(s.monthsPaidForThemselves, 1);
});
t('vaultSummary: a losing stretch reports a negative net, not a floor of zero', () => {
  const s = V.vaultSummary([
    { id: 'a', date: '2026-05-10', amount: 0, attributed: true },
    { id: 'b', date: '2026-06-10', amount: 8, attributed: true },
  ]);
  near(s.subscriptionPaid, 19.98);
  near(s.netBenefit, 8 - 19.98);
  ok(s.netBenefit < 0, 'two months and $8 proven is a bad deal — say so');
});
t('vaultSummary: empty ledger is a coherent zero, not a crash', () => {
  const s = V.vaultSummary([]);
  eq(s.months, 0); eq(s.proven, 0); eq(s.subscriptionPaid, 0); eq(s.netBenefit, 0);
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
t('detectEvents: no data at all yields an empty month, not a claim', () => {
  const e = V.detectEvents({});
  eq(e.length, 0);
  eq(V.statementFor(e, '2026-06').empty, true);
});
t('detectEvents: newest first', () => {
  const e = V.detectEvents({
    subscriptions: [sub('Netflix', 15.99, 'mo', ago(200))],
    flagged: FLAGGED,
  });
  for (let i = 1; i < e.length; i++) ok(e[i - 1].date >= e[i].date, 'ledger must read newest first');
});

/* ═══════════════════════════════════════════════════════════════
   THE VAULT CHARGES NOTHING — structural guard
   ═══════════════════════════════════════════════════════════════
   This began as a metered billing model and was deliberately changed: the
   Vault is a tool included with Pro. That decision is easy to erode one
   helper at a time, so it is asserted rather than remembered. */
t('engine exposes no billing surface at all', () => {
  const banned = ['takeRate', 'listPrice', 'fee', 'chargeFor', 'bill', 'debit'];
  for (const k of banned) ok(V[k] === undefined, `FCVault must not export "${k}"`);
  for (const k of ['takeRate', 'listPrice', 'fee']) {
    ok(V.TERMS[k] === undefined, `TERMS must not carry "${k}" — the Vault bills nothing`);
  }
  ok(typeof V.TERMS.subscriptionCost === 'number', 'subscriptionCost is the yardstick');
});
t('no detected event carries a billable flag', () => {
  const e = V.detectEvents({
    subscriptions: [sub('Netflix', 15.99, 'mo', ago(75))],
    flagged: FLAGGED, transactions: FEE_HISTORY, forecasts: [dodged],
  });
  ok(e.length > 0);
  ok(e.every(x => x.billable === undefined), 'events describe attribution, not billing');
  ok(e.every(x => typeof x.attributed === 'boolean'), 'every event states attribution');
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
