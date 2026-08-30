#!/usr/bin/env node
'use strict';

const { scoreUser, rankBoard, validateHandle, MIN_HISTORY_DAYS, _internals } =
  require('../backend/lib/leaderboard');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}
function ok(value, message) {
  if (!value) throw new Error(message || 'expected truthy');
}
function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'mismatch'}: got ${actual}, expected ${expected}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-30T12:00:00Z');
const dayAgo = n => new Date(NOW - n * DAY).toISOString().slice(0, 10);

/** A spend on day `n` days ago. */
const spend = (n, amount, category = 'FOOD_AND_DRINK') =>
  ({ date: dayAgo(n), amount, isCredit: false, category, pending: false });
/** Money in on day `n` days ago. */
const earn = (n, amount, category = 'INCOME') =>
  ({ date: dayAgo(n), amount, isCredit: true, category, pending: false });

/** A year of steady living: paid monthly, spends `perDay` every day. */
function steadyYear(perDay, pay = 3000) {
  const txns = [];
  for (let d = 0; d < 365; d++) {
    txns.push(spend(d, perDay));
    if (d % 30 === 0) txns.push(earn(d, pay));
  }
  return txns;
}

// ── Eligibility ────────────────────────────────────────────────────────────

test('a user with no transactions is not scored zero, they are not scored', () => {
  const result = scoreUser([], NOW);
  eq(result.eligible, false);
  eq(result.reason, 'no_transactions');
});

test('a two-week-old account is told when it will be eligible', () => {
  const result = scoreUser([spend(3, 20), spend(10, 30)], NOW);
  eq(result.eligible, false);
  eq(result.reason, 'too_new');
  // The point of returning this: the UI can say "3 weeks to go" instead of
  // silently placing a brand-new user last in a race they never entered.
  eq(result.daysUntilEligible, MIN_HISTORY_DAYS - 10);
});

test('pending transactions never move a score', () => {
  const base = steadyYear(40);
  const withPending = base.concat([
    { date: dayAgo(1), amount: 99999, isCredit: false, category: 'FOOD_AND_DRINK', pending: true },
  ]);
  eq(scoreUser(withPending, NOW).score, scoreUser(base, NOW).score,
     'a pending charge changed the score');
});

// ── The core promise: the score is not a wealth ranking ────────────────────

test('income level does not decide the ranking', () => {
  // The whole design rests on this. A user earning $3k and one earning $30k,
  // both saving the same PROPORTION and both steady, must score the same.
  const modest = steadyYear(50, 3000);
  const wealthy = steadyYear(500, 30000);
  eq(scoreUser(modest, NOW).score, scoreUser(wealthy, NOW).score,
     'the richer user outranked an identically-behaved poorer one');
});

test('saving more of what you earn scores higher', () => {
  const saver = scoreUser(steadyYear(30, 3000), NOW).score;
  const spender = scoreUser(steadyYear(95, 3000), NOW).score;
  ok(saver > spender, `saver ${saver} did not beat spender ${spender}`);
});

// ── Momentum ───────────────────────────────────────────────────────────────

test('cutting spending this month beats holding it flat', () => {
  const flat = steadyYear(60);
  const improving = [];
  for (let d = 0; d < 365; d++) {
    improving.push(spend(d, d < 30 ? 30 : 60));
    if (d % 30 === 0) improving.push(earn(d, 3000));
  }
  const a = scoreUser(improving, NOW).score;
  const b = scoreUser(flat, NOW).score;
  ok(a > b, `improving ${a} did not beat flat ${b}`);
});

test('momentum is measured per day, not per window', () => {
  // The recent window is 30 days and the baseline is 90. Comparing totals
  // instead of daily averages would score an unchanged spender as a dramatic
  // improver, because 30 days of it is a third of 90 days of it.
  const flat = steadyYear(60);
  const result = _internals.momentum(
    flat.filter(t => t.date >= dayAgo(30)),
    flat.filter(t => t.date >= dayAgo(120) && t.date < dayAgo(30)),
  );
  ok(Math.abs(result - 0.5) < 0.02, `unchanged spending scored ${result}, expected ~0.5`);
});

// ── Internal transfers ─────────────────────────────────────────────────────

test('moving money to savings is not income and not spending', () => {
  const base = steadyYear(50);
  const withTransfers = base.concat([
    { date: dayAgo(5), amount: 1000, isCredit: false, category: 'TRANSFER_OUT', pending: false },
    { date: dayAgo(5), amount: 1000, isCredit: true, category: 'TRANSFER_IN', pending: false },
  ]);
  eq(scoreUser(withTransfers, NOW).score, scoreUser(base, NOW).score,
     'an internal transfer moved the score');
});

test('a credit-card payment is not spending', () => {
  const base = steadyYear(50);
  const withPayment = base.concat([
    { date: dayAgo(3), amount: 800, isCredit: false, category: 'LOAN_PAYMENTS', pending: false },
  ]);
  eq(scoreUser(withPayment, NOW).score, scoreUser(base, NOW).score,
     'paying the card off counted as spending it again');
});

// ── Consistency ────────────────────────────────────────────────────────────

test('one dramatic month does not beat steady habits', () => {
  // Same total spend both ways. A score built on totals alone would call
  // these equal; consistency is what separates them.
  const steady = steadyYear(60);
  const spiky = [];
  for (let d = 0; d < 365; d++) {
    spiky.push(spend(d, d % 28 < 21 ? 20 : 153.33));
    if (d % 30 === 0) spiky.push(earn(d, 3000));
  }
  const a = _internals.consistency(steady, NOW);
  const b = _internals.consistency(spiky, NOW);
  ok(a >= b, `steady ${a} scored below spiky ${b}`);
});

test('consistency is a continuous measure, not effectively a coin flip', () => {
  // Guards the fault the first version had: counting weeks under the user's
  // own median returns ~0.5 for ANY user whose weeks are not identical,
  // because half of them fall below their own median by definition. It read
  // as a sensible measure and carried no ranking information whatsoever.
  const byWeek = mults => {
    const txns = [];
    for (let d = 0; d < 56; d++) txns.push(spend(d, 60 * mults[Math.floor(d / 7)]));
    return txns;
  };
  const flat = _internals.consistency(byWeek([1, 1, 1, 1, 1, 1, 1, 1]), NOW);
  const gentle = _internals.consistency(byWeek([1, 1.1, 0.95, 1.05, 0.9, 1, 1.08, 0.97]), NOW);
  const rough = _internals.consistency(byWeek([1, 1.3, 0.7, 1.2, 0.8, 1.25, 0.75, 1]), NOW);
  const wild = _internals.consistency(byWeek([1, 1.8, 0.2, 1.7, 0.3, 1.9, 0.25, 1]), NOW);

  ok(flat > gentle && gentle > rough && rough > wild,
     `not monotonic: ${flat}, ${gentle}, ${rough}, ${wild}`);
  // And the middle of the range must actually be occupied — a measure that
  // only ever returns 0 or 1 would pass the ordering check above.
  ok(gentle < 0.99 && rough > 0.5 && rough < 0.9,
     `values collapsed to the ends: gentle ${gentle}, rough ${rough}`);
});

// ── Missing components are unknown, not zero ───────────────────────────────

test('a user with no deposit in the window is not scored as saving nothing', () => {
  // Someone paid on the 1st, scored on the 5th of the next month, has no
  // income inside a 30-day window. Scoring that as a 0% savings rate would
  // rank them below someone who genuinely spent every dollar they earned.
  const noIncome = [];
  for (let d = 0; d < 200; d++) noIncome.push(spend(d, 40));
  const result = scoreUser(noIncome, NOW);
  ok(result.eligible, 'a user with spend history but no recent deposit fell off the board');
  eq(result.components.savings, null, 'an unknown savings rate was reported as a number');
});

test('a score is still produced from the components that exist', () => {
  const noIncome = [];
  for (let d = 0; d < 200; d++) noIncome.push(spend(d, 40));
  const result = scoreUser(noIncome, NOW);
  ok(result.score > 0 && result.score <= 1000, `score out of range: ${result.score}`);
});

// ── Ranking ────────────────────────────────────────────────────────────────

test('equal scores share a rank', () => {
  const board = rankBoard([
    { handle: 'ann', score: 900 },
    { handle: 'bob', score: 700 },
    { handle: 'cal', score: 700 },
    { handle: 'dee', score: 500 },
  ]);
  eq(board[0].rank, 1);
  eq(board[1].rank, 2);
  eq(board[2].rank, 2, 'a tie was broken invisibly');
  eq(board[3].rank, 4, 'the rank after a tie skipped wrong');
});

test('ranking does not mutate the caller array', () => {
  const input = [{ handle: 'b', score: 1 }, { handle: 'a', score: 9 }];
  rankBoard(input);
  eq(input[0].handle, 'b', 'rankBoard sorted the input in place');
});

test('the score never leaves 0..1000', () => {
  for (const perDay of [0, 1, 250, 5000]) {
    const result = scoreUser(steadyYear(perDay), NOW);
    if (!result.eligible) continue;
    ok(result.score >= 0 && result.score <= 1000, `score ${result.score} out of range`);
  }
});

test('a catastrophic month floors at zero rather than going negative', () => {
  const blowout = [];
  for (let d = 0; d < 200; d++) blowout.push(spend(d, 5000));
  blowout.push(earn(1, 100));
  const result = scoreUser(blowout, NOW);
  ok(result.score >= 0, `score went negative: ${result.score}`);
});

// ── Handles ────────────────────────────────────────────────────────────────

test('a handle is normalised to lowercase', () => {
  // Without this the uniqueness index is a lie: `Brandon` and `brandon` are
  // two documents, so two people end up on one board under one name.
  eq(validateHandle('  BrandonT  ').handle, 'brandont');
});

test('an email address is refused with a reason that explains itself', () => {
  const result = validateHandle('brandon@gmail.com');
  ok(result.error, 'an email was accepted as a handle');
  ok(/nickname/i.test(result.error), `unhelpful message: ${result.error}`);
});

test('handles are bounded at both ends', () => {
  ok(validateHandle('ab').error, 'a 2-character handle was accepted');
  ok(validateHandle('a'.repeat(19)).error, 'a 19-character handle was accepted');
  ok(!validateHandle('abc').error, 'a 3-character handle was refused');
  ok(!validateHandle('a'.repeat(18)).error, 'an 18-character handle was refused');
});

test('a handle cannot lead or trail with an underscore', () => {
  ok(validateHandle('_brandon').error);
  ok(validateHandle('brandon_').error);
  ok(!validateHandle('bran_don').error, 'an interior underscore was refused');
});

test('markup and control characters cannot reach a screen other users read', () => {
  // The board renders handles on everyone's device. The charset is the
  // defence — nothing downstream should be the first thing that escapes it.
  for (const bad of ['<script>', 'a<b', 'a"b', "a'b", 'a b', 'a\nb', 'a/b', '../x']) {
    ok(validateHandle(bad).error, `accepted a dangerous handle: ${JSON.stringify(bad)}`);
  }
});

test('a missing or non-string handle does not throw', () => {
  for (const bad of [undefined, null, 0, {}, []]) {
    ok(validateHandle(bad).error, `accepted ${JSON.stringify(bad)}`);
  }
});

console.log(`\nleaderboard: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
