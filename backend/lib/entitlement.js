'use strict';

/**
 * One answer to "may this account use paid features right now".
 *
 * Every grant path in this codebase writes `pro_expires_at` — the RevenueCat
 * webhook computes it from `expiration_at_ms`, and `grantProMonths` in
 * referral.js carefully stacks referral months on top of any existing expiry.
 * Nothing read it. The gate tested the `is_pro` boolean alone, and the only
 * line in the whole backend that ever sets that boolean back to false is the
 * RevenueCat lapse handler.
 *
 * So the expiry date was decoration, and two things followed from that:
 *
 *   - A referral grant was permanent. RevenueCat has never heard of a user who
 *     redeemed a code without subscribing, so no lapse event was ever coming.
 *     One free month was Pro forever — and referral codes are minted on the
 *     client.
 *   - A lapse whose webhook never arrived was also permanent, in the customer's
 *     favour, silently.
 *
 * Read the date instead. A missing date still means "does not expire": every
 * current grant path sets one, so the only documents without it are legacy or
 * hand-edited, and those must not be locked out to close this.
 */

/** Webhooks are not a reliable clock. A renewal that is late must not lock out
 *  somebody who is paying, so entitlement outlives its stated expiry by this
 *  much. Grants are measured in months; three days cannot be farmed. */
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** Firestore hands back a Timestamp; older writes and tests hand back a string
 *  or a Date. Anything unparseable is treated as absent rather than as expired
 *  — see above: failing to read a date is not evidence that it has passed. */
function proExpiresAt(userData) {
  const raw = userData && userData.pro_expires_at;
  if (!raw) return null;
  const date = typeof raw.toDate === 'function' ? raw.toDate() : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Does this account hold a subscription that has not run out? Excludes
 *  grandfathering on purpose — the multi-bank gate asks specifically whether
 *  somebody is paying, and a grandfathered user keeps their one bank without
 *  earning the right to add more. */
function hasActivePro(userData = {}, now = Date.now()) {
  if (!(userData.is_pro || userData.pro)) return false;
  const expiry = proExpiresAt(userData);
  if (!expiry) return true;
  return expiry.getTime() + GRACE_MS > now;
}

/** May this account reach paid features? Grandfathered accounts always may:
 *  they had a bank connected before the subscription requirement shipped. */
function hasEntitlement(userData = {}, now = Date.now()) {
  return userData.grandfathered === true || hasActivePro(userData, now);
}

module.exports = { hasEntitlement, hasActivePro, proExpiresAt, GRACE_MS };
