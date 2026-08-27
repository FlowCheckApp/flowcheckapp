#!/usr/bin/env node
'use strict';

const { normalizeGoal, normalizeContribution } = require('../backend/lib/goal-fields');

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

test('a valid goal normalises', () => {
  const { fields, error } = normalizeGoal({
    name: '  Emergency cushion ', target: '5000.004', current: 2840,
    target_date: '2027-02-01',
  });
  ok(!error, error);
  equal(fields, {
    name: 'Emergency cushion', target: 5000, current: 2840,
    target_date: '2027-02-01',
  });
});

test('a goal may start at zero saved', () => {
  const { fields, error } = normalizeGoal({
    name: 'New laptop', target: 1200, current: 0, target_date: null,
  });
  ok(!error, error);
  equal(fields.current, 0);
  equal(fields.target_date, null);
});

test('an empty name, a zero target and a negative balance are refused', () => {
  ok(normalizeGoal({ name: ' ', target: 100, current: 0, target_date: null }).error);
  ok(normalizeGoal({ name: 'x', target: 0, current: 0, target_date: null }).error);
  ok(normalizeGoal({ name: 'x', target: -5, current: 0, target_date: null }).error);
  /* A negative balance would draw a progress bar running backwards. */
  ok(normalizeGoal({ name: 'x', target: 100, current: -1, target_date: null }).error);
});

test('a target date must be a real day', () => {
  ok(normalizeGoal({ name: 'x', target: 1, current: 0, target_date: '2027-02-30' }).error);
  ok(normalizeGoal({ name: 'x', target: 1, current: 0, target_date: 'next spring' }).error);
  ok(!normalizeGoal({ name: 'x', target: 1, current: 0, target_date: '2028-02-29' }).error,
    'a leap day is a real day');
});

test('clearing a deadline differs from leaving it alone', () => {
  /* null means "no deadline"; omitting the key means "do not touch it". A
     partial update that conflated the two would silently wipe a date the user
     never mentioned. */
  const cleared = normalizeGoal({ target_date: null }, { partial: true });
  equal(cleared.fields, { target_date: null });

  const untouched = normalizeGoal({ current: 100 }, { partial: true });
  equal(untouched.fields, { current: 100 });
  ok(!('target_date' in untouched.fields), 'an unmentioned date must not be written');
});

test('an empty partial update is refused rather than writing nothing', () => {
  ok(normalizeGoal({}, { partial: true }).error);
});

test('no field outside the Firestore rules allowlist survives', () => {
  /* The rules for /goals use hasOnly() and, on an update, test the whole
     resulting document — so one stray field rejects every later write. That is
     what `autopay` did to bills, silently, in production. */
  const ALLOWED = new Set([
    'name', 'target', 'current', 'emoji',
    'target_date', 'created_at', 'updated_at',
  ]);
  const { fields } = normalizeGoal({
    name: 'Trip', target: 2000, current: 10, target_date: null,
    priority: 'high', uid: 'someone-else', progress: 0.5,
  });
  for (const key of Object.keys(fields)) {
    ok(ALLOWED.has(key), `${key} is not in the Firestore rules allowlist for goals`);
  }
  ok(!('uid' in fields), 'a client must not set uid');
});

test('a contribution is an amount, not a total', () => {
  equal(normalizeContribution({ amount: 25.005 }).amount, 25.01);
  /* Negative is allowed — taking money back out of a goal is a real thing. */
  equal(normalizeContribution({ amount: -40 }).amount, -40);
});

test('a contribution of nothing is refused', () => {
  ok(normalizeContribution({ amount: 0 }).error, 'zero moves nothing');
  ok(normalizeContribution({ amount: 'lots' }).error);
  ok(normalizeContribution({}).error);
  ok(normalizeContribution(null).error);
});

console.log(`goal-fields: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('✓ goals accept only what the rules allow, and contributions add rather than overwrite.');
