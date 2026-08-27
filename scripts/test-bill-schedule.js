#!/usr/bin/env node
'use strict';

const {
  FREQUENCIES,
  nextDueDate,
  previousDueDate,
  isRecurring,
  normalizeBill,
} = require('../backend/lib/bill-schedule');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}
function equal(actual, expected, message) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message || 'values differ'}: expected ${e}, got ${a}`);
}
function ok(value, message) {
  if (!value) throw new Error(message || 'expected truthy');
}

/* ── The thing the whole feature exists for ─────────────────────────────── */

test('a monthly bill comes back next month', () => {
  equal(nextDueDate('2026-08-29', 'monthly'), '2026-09-29');
});

test('a monthly bill crosses the year boundary', () => {
  equal(nextDueDate('2026-12-15', 'monthly'), '2027-01-15');
});

test('quarterly and yearly advance by their own periods', () => {
  equal(nextDueDate('2026-01-10', 'quarterly'), '2026-04-10');
  equal(nextDueDate('2026-01-10', 'yearly'), '2027-01-10');
  equal(nextDueDate('2026-11-10', 'quarterly'), '2027-02-10');
});

test('weekly and biweekly advance by days, across months', () => {
  equal(nextDueDate('2026-08-29', 'weekly'), '2026-09-05');
  equal(nextDueDate('2026-08-29', 'biweekly'), '2026-09-12');
});

/* ── Dates that break naive implementations ─────────────────────────────── */

test('the 31st clamps into a 30-day month rather than overflowing', () => {
  /* Date.UTC(2026, 3, 31) for April rolls into May 1. A rent bill silently
     moving from the 31st to the 1st of the following month is a bill that
     shows up in the wrong month on every screen that groups by month. */
  equal(nextDueDate('2026-03-31', 'monthly'), '2026-04-30');
});

test('the 31st clamps into February, and February knows about leap years', () => {
  equal(nextDueDate('2026-01-31', 'monthly'), '2026-02-28');
  equal(nextDueDate('2028-01-31', 'monthly'), '2028-02-29');
});

test('yearly on a leap day lands on the 28th in a common year', () => {
  equal(nextDueDate('2028-02-29', 'yearly'), '2029-02-28');
});

test('no timezone slip — the day never moves on its own', () => {
  /* `new Date('2026-08-01')` is midnight UTC, which is July 31 anywhere in
     the Americas. An implementation that round-trips through a local Date
     loses a day here, and loses another every time the bill is paid. */
  equal(nextDueDate('2026-08-01', 'monthly'), '2026-09-01');
  equal(nextDueDate('2026-01-01', 'monthly'), '2026-02-01');
});

/* ── Refusals ───────────────────────────────────────────────────────────── */

test('a one-time bill has no next date', () => {
  equal(nextDueDate('2026-08-29', 'one-time'), null);
  equal(isRecurring('one-time'), false);
  equal(isRecurring('monthly'), true);
});

test('a malformed or impossible date returns null rather than a guess', () => {
  equal(nextDueDate('', 'monthly'), null);
  equal(nextDueDate('29/08/2026', 'monthly'), null);
  equal(nextDueDate('2026-02-30', 'monthly'), null, 'February has no 30th');
  equal(nextDueDate('2026-13-01', 'monthly'), null, 'there is no month 13');
  equal(nextDueDate('2026-08-29', 'fortnightly'), null, 'unknown cadence');
});

/* ── Undo ───────────────────────────────────────────────────────────────── */

test('undo walks a recurring bill back to where it was', () => {
  /* Paying moves the bill forward, so undoing has to move it back. Without
     this the bill sits a period in the future with nothing to show for it —
     an undo that leaves the data worse than not undoing. */
  for (const frequency of ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']) {
    const forward = nextDueDate('2026-08-12', frequency);
    equal(previousDueDate(forward, frequency), '2026-08-12', `${frequency} round trip`);
  }
});

test('undo of a one-time bill moves no date', () => {
  equal(previousDueDate('2026-08-12', 'one-time'), null);
});

test('undo crosses a year boundary backwards', () => {
  equal(previousDueDate('2027-01-15', 'monthly'), '2026-12-15');
  equal(previousDueDate('2026-02-10', 'quarterly'), '2025-11-10');
  equal(previousDueDate('2026-01-05', 'weekly'), '2025-12-29');
});

/* ── What a client may say ──────────────────────────────────────────────── */

test('a valid bill normalises', () => {
  const { fields, error } = normalizeBill({
    name: '  Rent  ', amount: '420.005', due_date: '2026-08-29',
    category: 'Housing', frequency: 'monthly',
  });
  ok(!error, error);
  equal(fields, {
    name: 'Rent', amount: 420.01, due_date: '2026-08-29',
    category: 'Housing', frequency: 'monthly',
  });
});

test('an empty name, a zero amount and a bad date are each refused', () => {
  ok(normalizeBill({ name: '   ', amount: 10, due_date: '2026-08-29', category: 'x', frequency: 'monthly' }).error);
  ok(normalizeBill({ name: 'Rent', amount: 0, due_date: '2026-08-29', category: 'x', frequency: 'monthly' }).error);
  ok(normalizeBill({ name: 'Rent', amount: -5, due_date: '2026-08-29', category: 'x', frequency: 'monthly' }).error);
  ok(normalizeBill({ name: 'Rent', amount: 10, due_date: 'soon', category: 'x', frequency: 'monthly' }).error);
  ok(normalizeBill({ name: 'Rent', amount: 10, due_date: '2026-08-29', category: 'x', frequency: 'often' }).error);
});

test('category falls back rather than failing, and is bounded', () => {
  const { fields } = normalizeBill({
    name: 'Rent', amount: 10, due_date: '2026-08-29', category: '   ', frequency: 'monthly',
  });
  equal(fields.category, 'Other');
  const long = normalizeBill({
    name: 'Rent', amount: 10, due_date: '2026-08-29', category: 'x'.repeat(200), frequency: 'monthly',
  });
  equal(long.fields.category.length, 40);
});

test('a partial update returns only what was sent', () => {
  const { fields, error } = normalizeBill({ amount: 450 }, { partial: true });
  ok(!error, error);
  equal(fields, { amount: 450 });
});

test('an empty partial update is refused rather than writing nothing', () => {
  ok(normalizeBill({}, { partial: true }).error);
});

test('no field outside the Firestore rules allowlist survives', () => {
  /* The rules for `bills` use hasOnly(), and on an update that tests the WHOLE
     resulting document. So a stray field is not ignored — it makes every later
     client write fail. This is exactly how `autopay` broke bill editing in the
     web app: the form sends it, the rules reject the write, nothing saves and
     nothing says so. */
  const ALLOWED = new Set([
    'name', 'amount', 'due_date', 'status',
    'category', 'type', 'icon', 'color', 'frequency',
    'paid_at', 'created_at', 'updated_at',
  ]);
  const { fields } = normalizeBill({
    name: 'Rent', amount: 10, due_date: '2026-08-29', category: 'Housing',
    frequency: 'monthly', autopay: true, notes: 'nope', uid: 'someone-else',
  });
  for (const key of Object.keys(fields)) {
    ok(ALLOWED.has(key), `${key} is not in the Firestore rules allowlist for bills`);
  }
  ok(!('autopay' in fields), 'autopay must not be written');
  ok(!('uid' in fields), 'a client must not set uid');
});

test('every advertised frequency is either recurring or explicitly one-time', () => {
  for (const frequency of FREQUENCIES) {
    const recurring = isRecurring(frequency);
    const next = nextDueDate('2026-08-10', frequency);
    equal(recurring, next !== null, `${frequency} disagrees with itself`);
  }
});

console.log(`bill-schedule: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('✓ a recurring bill comes back, and month ends do not move it.');
