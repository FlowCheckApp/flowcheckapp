'use strict';

/**
 * One Plaid transaction, as this app stores it.
 *
 * There were two of these, byte-identical, in the two places that write
 * transactions — the webhook sync and the manual sync. Both dropped the same
 * two fields, and adding one to either would have left the other behind, which
 * is how a user's data ends up depending on which code path last touched it.
 */

/** Logos come from Plaid's own CDN or not at all. */
function plaidHostedLogo(value) {
  if (typeof value !== 'string' || !value) return null;
  let parsed;
  try { parsed = new URL(value); } catch (_) { return null; }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  return (host === 'plaid.com' || host.endsWith('.plaid.com')) ? value : null;
}

/**
 * The best logo Plaid gave us for this transaction.
 *
 * `logo_url` is often null on transactions that nonetheless carry a fully
 * identified counterparty with a logo of its own — Plaid resolves the merchant
 * but only populates the top-level field some of the time. Reading the
 * counterparty as well is most of the difference between a screen of monograms
 * and a screen of recognisable brands, and costs nothing: it is the same CDN,
 * already allow-listed.
 */
function bestLogo(t) {
  const direct = plaidHostedLogo(t.logo_url);
  if (direct) return direct;
  const parties = Array.isArray(t.counterparties) ? t.counterparties : [];
  for (const party of parties) {
    const logo = plaidHostedLogo(party && party.logo_url);
    if (logo) return logo;
  }
  return null;
}

/**
 * The document written to `users/{uid}/transactions/{id}`.
 *
 * @param {object} t          a Plaid transaction
 * @param {Function} serverTS FieldValue.serverTimestamp
 */
function transactionDoc(t, serverTS) {
  return {
    id:               t.transaction_id,
    account_id:       t.account_id,
    name:             t.name,
    amount:           Math.abs(t.amount),
    isCredit:         t.amount < 0,
    date:             t.date,
    category:         t.personal_finance_category?.primary
                        ? [t.personal_finance_category.primary]
                        : (t.category || []),
    /* Kept alongside the primary rather than instead of it.
       GENERAL_SERVICES is a catch-all — postage, legal, childcare, storage and
       an explicit "other" bin all land in it — so a user's largest category can
       be a drawer they cannot act on. The detailed value is what separates
       "Services" from "Childcare", and it was being thrown away at the door. */
    category_detailed: t.personal_finance_category?.detailed || null,
    pending:          t.pending,
    merchant_name:    t.merchant_name    || null,
    logo_url:         bestLogo(t),
    payment_channel:  t.payment_channel  || null,
    updated_at:       serverTS(),
  };
}

module.exports = { transactionDoc, bestLogo, plaidHostedLogo };
