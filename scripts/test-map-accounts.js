#!/usr/bin/env node
/**
 * test-map-accounts.js
 *
 * The account shape is now written from TWO places — /plaid/sync and
 * exchange-token — so it lives in one module and this pins it.
 *
 * The test that matters most is the liabilities one. The link path skips the
 * liabilities round trip for speed, and every account write is a merge. If
 * that path wrote interest_rate: null instead of omitting the field, then
 * re-linking a card would erase the APR the sync path had already
 * established, and the Debt screen's payoff date would quietly go back to a
 * dash. Omitted and null look nearly identical in code and are opposites in
 * Firestore.
 */
'use strict';

const { mapPlaidAccounts } = require('../backend/lib/map-accounts');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (err) { failed++; console.log('  ✗ ' + name + '\n    ' + err.message); }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error((msg || '') + ' expected ' + B + ', got ' + A);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

const plaidAcct = {
  account_id: 'acc_1',
  name: 'Everyday Checking',
  official_name: 'WF Everyday Checking',
  type: 'depository',
  subtype: 'checking',
  mask: '4821',
  balances: { current: 1240.55, available: 1180.10, limit: null, iso_currency_code: 'USD' },
};

t('maps the fields the app reads', () => {
  const [a] = mapPlaidAccounts([plaidAcct], { itemId: 'item_1', institution: 'Wells Fargo' });
  eq(a.id, 'acc_1');
  eq(a.balance_current, 1240.55);
  eq(a.balance_available, 1180.10);
  eq(a.type, 'depository');
  eq(a.subtype, 'checking');
  eq(a.mask, '4821');
  eq(a.item_id, 'item_1');
  eq(a.institution_name, 'Wells Fargo');
});

t('LINK path omits liability fields entirely', () => {
  const [a] = mapPlaidAccounts([plaidAcct], { itemId: 'i' });
  ok(!('interest_rate' in a),   'interest_rate must be absent, not null');
  ok(!('minimum_payment' in a), 'minimum_payment must be absent, not null');
});

t('SYNC path writes them, null when unknown', () => {
  const [a] = mapPlaidAccounts([plaidAcct], { itemId: 'i', liab: {} });
  ok('interest_rate' in a);
  eq(a.interest_rate, null);
  eq(a.minimum_payment, null);
});

t('SYNC path carries real APR and minimum through', () => {
  const [a] = mapPlaidAccounts([plaidAcct], {
    itemId: 'i',
    liab: { acc_1: { interest_rate: 24.99, minimum_payment: 35 } },
  });
  eq(a.interest_rate, 24.99);
  eq(a.minimum_payment, 35);
});

t('a real 0% APR survives — not coerced to null', () => {
  const [a] = mapPlaidAccounts([plaidAcct], {
    itemId: 'i', liab: { acc_1: { interest_rate: 0, minimum_payment: 0 } },
  });
  eq(a.interest_rate, 0);
  eq(a.minimum_payment, 0);
});

t('missing balance object does not throw', () => {
  const [a] = mapPlaidAccounts([{ account_id: 'x', name: 'N', type: 'depository' }], { itemId: 'i' });
  eq(a.balance_current, 0);
  eq(a.balance_available, null);
  eq(a.currency, 'USD');
});

t('a zero balance stays 0, never null', () => {
  const [a] = mapPlaidAccounts(
    [{ ...plaidAcct, balances: { current: 0, available: 0, iso_currency_code: 'USD' } }],
    { itemId: 'i' });
  eq(a.balance_current, 0);
  eq(a.balance_available, 0);
});

t('non-USD currency preserved', () => {
  const [a] = mapPlaidAccounts(
    [{ ...plaidAcct, balances: { current: 5, iso_currency_code: 'GBP' } }], { itemId: 'i' });
  eq(a.currency, 'GBP');
});

t('empty and null inputs are safe', () => {
  eq(mapPlaidAccounts([], { itemId: 'i' }).length, 0);
  eq(mapPlaidAccounts(null, { itemId: 'i' }).length, 0);
  eq(mapPlaidAccounts(undefined, {}).length, 0);
});

t('credit card shape maps its limit', () => {
  const [a] = mapPlaidAccounts([{
    account_id: 'cc', name: 'Sapphire', type: 'credit', subtype: 'credit card',
    balances: { current: 842.11, limit: 5000, available: 4157.89, iso_currency_code: 'USD' },
  }], { itemId: 'i', liab: {} });
  eq(a.type, 'credit');
  eq(a.balance_limit, 5000);
  eq(a.interest_rate, null);
});

t('both paths agree on every non-liability field', () => {
  const link = mapPlaidAccounts([plaidAcct], { itemId: 'i', institution: 'B' })[0];
  const sync = mapPlaidAccounts([plaidAcct], { itemId: 'i', institution: 'B', liab: {} })[0];
  for (const k of Object.keys(link)) eq(sync[k], link[k], 'field ' + k + ':');
});

console.log(`map-accounts: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('✓ one account shape, and the link path cannot erase a synced APR.');
