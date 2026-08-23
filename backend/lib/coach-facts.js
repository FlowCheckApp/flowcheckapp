/**
 * coach-facts.js — the outbound privacy boundary for POST /coach/ask.
 *
 * Everything that reaches Anthropic passes through this function and nothing
 * else does. It is a strict allowlist, not a sanitiser: fields are copied out
 * by name into a fresh object, so anything the client adds — now or in some
 * future version — is dropped rather than forwarded.
 *
 * Extracted from server.js and given its own tests because "what leaves the
 * device" is the one property here that a reviewer, an App Store reviewer, or
 * a privacy policy has to be able to rely on.
 *
 * NEVER add to this: transaction lists, account numbers or masks, per-account
 * balances, institution names, uid, email, or anything else that identifies a
 * person or reconstructs their ledger.
 */
'use strict';

function coachFacts(body) {
  const b = body && typeof body === 'object' ? body : {};
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n || 60) : '');
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const money = v => (typeof v === 'string' && /^[-+$−]?[\d,.]+$/.test(v) ? v.slice(0, 16) : null);

  const items = Array.isArray(b.agenda) ? b.agenda.slice(0, 6).map(it => ({
    what: str(it && it.title, 120),
    why:  str(it && it.because, 200),
  })) : [];

  return {
    safeToSpendToday:   money(b.safeToday),
    daysUntilPayday:    num(b.daysUntilPayday),
    billsDueBeforePay:  money(b.billsDue),
    billsCovered:       typeof b.billsCovered === 'boolean' ? b.billsCovered : null,
    shortfall:          money(b.shortfall),
    subscriptionsMonthly: money(b.subsMonthly),
    subscriptionCount:  num(b.subsCount),
    couldCutPerYear:    money(b.couldCut),
    totalDebt:          money(b.totalDebt),
    agenda:             items,
  };
}

module.exports = { coachFacts };
