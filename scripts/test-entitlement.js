#!/usr/bin/env node
'use strict';

const { hasEntitlement, hasActivePro, proExpiresAt, GRACE_MS } =
  require('../backend/lib/entitlement');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}
function ok(value, message) {
  if (!value) throw new Error(message || 'expected truthy');
}
function no(value, message) {
  if (value) throw new Error(message || 'expected falsy');
}

const NOW = Date.parse('2026-08-28T12:00:00Z');
const days = n => NOW + n * 24 * 60 * 60 * 1000;
/** Stands in for a Firestore Timestamp. */
const stamp = ms => ({ toDate: () => new Date(ms) });

test('a live subscription passes', () => {
  ok(hasEntitlement({ is_pro: true, pro_expires_at: stamp(days(20)) }, NOW));
});

test('a referral month that ran out no longer passes', () => {
  // The whole point. grantProMonths sets is_pro and an expiry; RevenueCat has
  // never heard of this user, so nothing will ever clear the boolean.
  no(hasEntitlement({ is_pro: true, pro_expires_at: stamp(days(-40)) }, NOW));
});

test('a lapse whose webhook never arrived no longer passes', () => {
  // The lapse handler is the only line in the backend that clears the boolean.
  // If it never runs, the expiry is the only evidence left.
  no(hasEntitlement({ is_pro: true, pro: true, pro_expires_at: stamp(days(-9)) }, NOW));
  no(hasEntitlement({ pro: true, pro_expires_at: stamp(days(-9)) }, NOW));
});

test('a late renewal does not lock out somebody who is paying', () => {
  // Expired yesterday, webhook not yet delivered.
  ok(hasEntitlement({ is_pro: true, pro_expires_at: stamp(days(-1)) }, NOW));
  // The grace window has a far edge.
  no(hasEntitlement({ is_pro: true, pro_expires_at: stamp(NOW - GRACE_MS - 1000) }, NOW));
});

test('a document with no expiry is not locked out', () => {
  // Every current grant path writes one, so these are legacy or hand-edited.
  ok(hasEntitlement({ is_pro: true }, NOW));
  ok(hasEntitlement({ pro: true, pro_expires_at: null }, NOW));
});

test('an unreadable expiry is treated as absent, never as expired', () => {
  ok(hasEntitlement({ is_pro: true, pro_expires_at: 'sometime' }, NOW));
  no(proExpiresAt({ pro_expires_at: 'sometime' }));
});

test('lifetime pro survives', () => {
  const forever = stamp(Date.parse('2099-01-01T00:00:00Z'));
  ok(hasEntitlement({ is_pro: true, pro_expires_at: forever }, NOW));
});

test('no entitlement at all fails', () => {
  no(hasEntitlement({}, NOW));
  no(hasEntitlement({ is_pro: false, pro_expires_at: stamp(days(30)) }, NOW),
     'an expiry alone does not grant anything');
});

test('grandfathered reaches paid features but is not a subscriber', () => {
  // requireEntitlement lets them in; the multi-bank gate must still say no.
  ok(hasEntitlement({ grandfathered: true }, NOW));
  no(hasActivePro({ grandfathered: true }, NOW),
     'grandfathering keeps one bank, it does not buy more');
});

test('plain strings and Date objects parse like Timestamps do', () => {
  ok(hasEntitlement({ is_pro: true, pro_expires_at: '2027-01-01' }, NOW));
  no(hasEntitlement({ is_pro: true, pro_expires_at: new Date(days(-30)) }, NOW));
});

console.log(`entitlement: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('✓ pro expiry is enforced, and a late renewal does not lock anyone out.');
