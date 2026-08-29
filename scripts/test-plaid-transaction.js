#!/usr/bin/env node
'use strict';

const { transactionDoc, bestLogo, plaidHostedLogo } =
  require('../backend/lib/plaid-transaction');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}
function equal(actual, expected, message) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message || 'values differ'}: expected ${e}, got ${a}`);
}
function ok(v, m) { if (!v) throw new Error(m || 'expected truthy'); }

const TS = () => 'ts';

test('the detailed category is kept, not thrown away', () => {
  /* GENERAL_SERVICES is a catch-all — postage, legal, childcare, storage and
     an explicit "other" bin — so a user's largest category can be a drawer
     they cannot act on. The detailed value is the part that separates them. */
  const doc = transactionDoc({
    transaction_id: 't1', account_id: 'a', name: 'USPS', amount: 59, date: '2026-08-20',
    personal_finance_category: {
      primary: 'GENERAL_SERVICES',
      detailed: 'GENERAL_SERVICES_POSTAGE_AND_SHIPPING',
    },
  }, TS);
  equal(doc.category, ['GENERAL_SERVICES']);
  equal(doc.category_detailed, 'GENERAL_SERVICES_POSTAGE_AND_SHIPPING');
});

test('a missing detailed category is null, never undefined', () => {
  // Firestore rejects undefined; null is a value it can store.
  const doc = transactionDoc({ transaction_id: 't', amount: 1, date: 'd' }, TS);
  equal(doc.category_detailed, null);
});

test('a counterparty logo is used when the top-level one is missing', () => {
  /* Plaid resolves the merchant but only populates logo_url some of the time.
     Reading the counterparty is most of the difference between a screen of
     monograms and a screen of brands. */
  const doc = transactionDoc({
    transaction_id: 't', amount: 1, date: 'd',
    logo_url: null,
    counterparties: [{ name: 'Netflix', logo_url: 'https://plaid.com/logos/netflix.png' }],
  }, TS);
  equal(doc.logo_url, 'https://plaid.com/logos/netflix.png');
});

test('the top-level logo still wins when present', () => {
  const doc = transactionDoc({
    transaction_id: 't', amount: 1, date: 'd',
    logo_url: 'https://plaid.com/logos/a.png',
    counterparties: [{ logo_url: 'https://plaid.com/logos/b.png' }],
  }, TS);
  equal(doc.logo_url, 'https://plaid.com/logos/a.png');
});

test('logos are only ever loaded from Plaid', () => {
  // A counterparty logo is still third-party data; the allowlist applies to it
  // exactly as it does to the top-level field.
  ok(!plaidHostedLogo('https://evil.example.com/x.png'), 'foreign host refused');
  ok(!plaidHostedLogo('http://plaid.com/x.png'), 'plain http refused');
  ok(!plaidHostedLogo('https://plaid.com.evil.com/x.png'), 'suffix trick refused');
  ok(plaidHostedLogo('https://cdn.plaid.com/x.png'), 'plaid subdomain allowed');
  equal(bestLogo({ counterparties: [{ logo_url: 'https://evil.com/x.png' }] }), null);
});

test('amount is stored positive with the direction beside it', () => {
  const out = transactionDoc({ transaction_id: 't', amount: -42, date: 'd' }, TS);
  equal(out.amount, 42);
  equal(out.isCredit, true);
  const spend = transactionDoc({ transaction_id: 't', amount: 42, date: 'd' }, TS);
  equal(spend.isCredit, false);
});

test('a legacy transaction with no personal finance category keeps its own', () => {
  const doc = transactionDoc({
    transaction_id: 't', amount: 1, date: 'd', category: ['Food and Drink'],
  }, TS);
  equal(doc.category, ['Food and Drink']);
});

console.log(`plaid-transaction: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('✓ one transaction shape, detailed categories kept, logos only from Plaid.');
