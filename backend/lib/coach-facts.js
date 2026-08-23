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

/* Field types, declared once. Everything not named here is dropped. */
const MONEY = /^[-+$\u2212]?[\d,.]+$/;
const str   = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const num   = v => (Number.isFinite(Number(v)) ? Number(v) : null);
const bool  = v => (typeof v === 'boolean' ? v : null);
const money = v => (typeof v === 'string' && MONEY.test(v) ? v.slice(0, 16) : null);
const date  = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const list  = (v, cap, fn) => (Array.isArray(v) ? v.slice(0, cap).map(fn) : []);

function coachFacts(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return {
    /* Headline figures */
    safeToSpend:          money(b.safeToSpend),
    cashAvailable:        money(b.cashAvailable),
    daysToPayday:         num(b.daysToPayday),
    payday:               str(b.payday, 24),
    paydayExpected:       money(b.paydayExpected),
    netWorth:             money(b.netWorth),
    assets:               money(b.assets),
    debtTotal:            money(b.debtTotal),

    /* Bills */
    billsDueBeforePayday:  money(b.billsDueBeforePayday),
    billsCovered:          bool(b.billsCovered),
    shortBy:               money(b.shortBy),
    monthlyBillCommitment: money(b.monthlyBillCommitment),
    bills: list(b.bills, 12, x => ({
      n:    str(x && x.n, 40),
      amt:  money(x && x.amt),
      due:  date(x && x.due),
      auto: bool(x && x.auto),
      paid: bool(x && x.paid),
    })),

    /* Subscriptions */
    subsMonthly:     money(b.subsMonthly),
    subsYearly:      money(b.subsYearly),
    subs:            list(b.subs, 12, x => ({ n: str(x && x.n, 40), amt: money(x && x.amt), per: str(x && x.per, 4) })),
    subsStopped:     list(b.subsStopped, 6, x => str(x, 40)),
    couldCutPerYear: money(b.couldCutPerYear),
    cutCandidates:   list(b.cutCandidates, 5, x => ({
      n: str(x && x.n, 40), why: str(x && x.why, 16), yr: money(x && x.yr),
    })),

    /* Spending */
    spentThisMonth:  money(b.spentThisMonth),
    spentLastMonth:  money(b.spentLastMonth),
    incomeThisMonth: money(b.incomeThisMonth),
    spendByCategory: list(b.spendByCategory, 10, x => ({ cat: str(x && x.cat, 40), amt: money(x && x.amt) })),
    topMerchants:    list(b.topMerchants, 8, x => ({ n: str(x && x.n, 40), amt: money(x && x.amt) })),

    /* Debt and goals. APR and minimum are figures about an obligation, not
       identifiers — no account number, mask, or institution goes with them. */
    debts: list(b.debts, 8, x => ({
      n: str(x && x.n, 40), bal: money(x && x.bal), apr: num(x && x.apr), min: num(x && x.min),
    })),
    goals: list(b.goals, 5, x => ({
      n: str(x && x.n, 40), target: money(x && x.target), saved: money(x && x.saved),
    })),

    today: str(b.today, 40),
  };
}

module.exports = { coachFacts };
