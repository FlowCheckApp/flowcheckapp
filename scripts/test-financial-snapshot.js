#!/usr/bin/env node
'use strict';

const {
  buildFinancialSnapshot,
  sanitizeTransaction,
} = require('../backend/lib/financial-snapshot');

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

test('allowlists account fields and strips credentials', () => {
  const result = buildFinancialSnapshot({
    accounts: [{
      id: 'account_1', name: 'Checking', type: 'depository', subtype: 'checking',
      balance_current: 1250.25, balance_available: 1200, currency: 'USD',
      mask: '4821', institution_name: 'Sample Bank', access_token: 'must-not-leak',
      internal_note: 'must-not-leak',
    }],
  });
  equal(result.accounts[0], {
    id: 'account_1', name: 'Checking', official_name: null,
    type: 'depository', subtype: 'checking', balance_current: 1250.25,
    balance_available: 1200, currency: 'USD', mask: '4821',
    institution_name: 'Sample Bank',
    // Present but unknown for a depository account: Plaid describes rates for
    // credit, student and mortgage only.
    interest_rate: null, minimum_payment: null,
  });
  ok(!JSON.stringify(result).includes('must-not-leak'));
});

test('normalizes signed legacy transactions without changing direction', () => {
  const result = sanitizeTransaction({
    id: 'transaction_1', account_id: 'account_1', name: 'Payroll',
    amount: -850, date: '2026-08-21', category: ['INCOME'], pending: false,
  });
  equal(result.amount, 850);
  equal(result.is_credit, true);
  equal(result.date, '2026-08-21');
});

test('infers legacy income when isCredit is absent', () => {
  const result = sanitizeTransaction({
    id: 'transaction_2', name: 'Direct Deposit', amount: 900,
    date: '2026-08-07T00:00:00.000Z', category: 'PAYROLL',
  });
  equal(result.is_credit, true);
  equal(result.category, ['PAYROLL']);
  equal(result.date, '2026-08-07');
});

test('maps bills and goals without Firestore metadata', () => {
  const result = buildFinancialSnapshot({
    bills: [{ id: 'bill_1', name: 'Rent', amount: 950, due_date: '2026-09-01', created_at: 'private', status: 'pending' }],
    goals: [{ id: 'goal_1', name: 'Emergency', current: 500, target: 2000, target_date: '2027-01-01', owner: 'private' }],
  });
  equal(result.bills[0].due_date, '2026-09-01');
  equal(result.goals[0].target_date, '2027-01-01');
  ok(!JSON.stringify(result).includes('private'));
});

test('invalid numbers and dates fail closed to safe values', () => {
  const result = buildFinancialSnapshot({
    transactions: [{ id: 'x', amount: 'not-a-number', date: 'tomorrow' }],
    goals: [{ id: 'g', current: -10, target: Infinity }],
  });
  equal(result.transactions[0].amount, 0);
  equal(result.transactions[0].date, null);
  equal(result.goals[0].current, 0);
  equal(result.goals[0].target, 0);
});

test('merchant logos are kept only when Plaid hosts them', () => {
  const result = buildFinancialSnapshot({
    transactions: [
      { id: 'a', logo_url: 'https://plaid.com/logos/starbucks.png' },
      { id: 'b', logo_url: 'https://cdn.plaid.com/logos/caseys.png' },
    ],
  });
  equal(result.transactions[0].logo_url, 'https://plaid.com/logos/starbucks.png');
  equal(result.transactions[1].logo_url, 'https://cdn.plaid.com/logos/caseys.png');
});

test("a logo on the merchant's own host is dropped", () => {
  /* Loading it would tell that merchant this person exists and is looking at
     this purchase. Decoration is not worth a spending disclosure. */
  const result = buildFinancialSnapshot({
    transactions: [
      { id: 'a', logo_url: 'https://starbucks.com/logo.png' },
      { id: 'b', logo_url: 'https://plaid.com.evil.example/logo.png' },
      { id: 'c', logo_url: 'http://plaid.com/logo.png' },
      { id: 'd', logo_url: 'javascript:alert(1)' },
      { id: 'e', logo_url: 42 },
    ],
  });
  for (const txn of result.transactions) {
    equal(txn.logo_url, undefined);
  }
});

test('an unknown APR stays null and is never coerced to zero', () => {
  /* 0% and "we do not know" are different claims. Collapsing them would let a
     payoff date be computed from a rate nobody supplied. */
  const result = buildFinancialSnapshot({
    accounts: [
      { id: 'a', interest_rate: null, minimum_payment: null },
      { id: 'b', interest_rate: 0, minimum_payment: 0 },
      { id: 'c', interest_rate: 28.5, minimum_payment: 35 },
      { id: 'd' },
    ],
  });
  equal(result.accounts[0].interest_rate, null);
  equal(result.accounts[0].minimum_payment, null);
  equal(result.accounts[1].interest_rate, 0);
  equal(result.accounts[1].minimum_payment, 0);
  equal(result.accounts[2].interest_rate, 28.5);
  equal(result.accounts[2].minimum_payment, 35);
  equal(result.accounts[3].interest_rate, null);
});

console.log(`financial-snapshot: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('✓ native snapshot fields are allowlisted and credentials stay server-side.');
