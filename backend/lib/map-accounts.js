/**
 * map-accounts.js
 *
 * ONE mapping from a Plaid account object to the Firestore account document.
 *
 * WHY THIS EXISTS
 * ---------------
 * Balances used to be written in exactly one place: /plaid/sync. Linking a
 * bank therefore looked like this —
 *
 *   1. exchange-token stores the item, calls accountsGet to read the account
 *      masks for referral de-duplication, throws the balances away, responds.
 *   2. the client kicks off /plaid/sync.
 *   3. /plaid/sync calls accountsGet AGAIN, and only then writes balances.
 *
 * The numbers the user is waiting for were in hand at step 1 and discarded.
 * Everything they saw until step 3 finished — behind liabilities lookups and
 * a paginated transaction sync — was an empty account list.
 *
 * Writing accounts from exchange-token means a second copy of the account
 * shape, and a second copy is how the account-classification bugs happened:
 * two vocabularies that disagreed about the same account. So the shape lives
 * here, both callers use it, and it is testable — server.js calls app.listen
 * on require, so nothing inside it can be unit tested at all.
 *
 * LIABILITIES ARE OPTIONAL, AND THE DIFFERENCE MATTERS
 * ----------------------------------------------------
 * The sync path fetches liabilities and writes interest_rate/minimum_payment,
 * using null — never 0 — when the institution does not supply them, because a
 * 0% APR and an unknown APR are different claims.
 *
 * The link path skips that round trip; speed is its whole reason for
 * existing. So when no liabilities argument is passed the two fields are
 * OMITTED rather than written as null. Every write is a merge, so omitting
 * leaves any existing value untouched, while writing null would erase a real
 * APR the sync path had already established.
 */
'use strict';

/**
 * @param {Array}  plaidAccounts       accounts array from plaid.accountsGet
 * @param {object} opts
 * @param {string} opts.itemId
 * @param {string} [opts.institution]
 * @param {object} [opts.liab]         keyed by account_id; omit to skip the fields
 * @returns {Array} Firestore-ready account docs
 */
function mapPlaidAccounts(plaidAccounts, opts) {
  const { itemId, institution, liab } = opts || {};
  const withLiab = liab !== undefined && liab !== null;

  return (plaidAccounts || []).map(a => {
    const balances = a.balances || {};
    const doc = {
      id:                a.account_id,
      name:              a.name,
      official_name:     a.official_name || null,
      type:              a.type,
      subtype:           a.subtype       || null,
      balance_current:   balances.current   ?? 0,
      balance_limit:     balances.limit     ?? null,
      balance_available: balances.available ?? null,
      currency:          balances.iso_currency_code || 'USD',
      mask:              a.mask || null,
      item_id:           itemId,
      institution_name:  institution || '',
    };
    if (withLiab) {
      const l = liab[a.account_id] || {};
      doc.interest_rate   = l.interest_rate   ?? null;
      doc.minimum_payment = l.minimum_payment ?? null;
    }
    return doc;
  });
}

module.exports = { mapPlaidAccounts };
