/**
 * Allowlisted read models for the native financial snapshot API.
 *
 * Firestore documents can accumulate internal or provider-specific fields over
 * time. Returning a document with `{ ...data }` would silently turn every new
 * field into public API surface. These mappers deliberately copy only what the
 * native read-only experience needs and never include Plaid credentials.
 */
'use strict';

const INCOME_CATEGORIES = new Set([
  'income', 'payroll', 'wages', 'direct deposit', 'transfer in', 'deposit',
]);

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function optionalText(value) {
  return typeof value === 'string' && value.length ? value : null;
}

function number(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateString(value) {
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
  }
  if (value && typeof value.toDate === 'function') {
    const date = value.toDate();
    return date instanceof Date && !Number.isNaN(date.getTime())
      ? date.toISOString().slice(0, 10)
      : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

function categories(value) {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  return raw.filter(v => typeof v === 'string' && v.length).slice(0, 4);
}

function inferCredit(document, categoryList) {
  if (typeof document.isCredit === 'boolean') return document.isCredit;
  if (number(document.amount) < 0) return true;
  return categoryList.some(category => {
    const normalized = category.toLowerCase().replace(/_/g, ' ');
    return INCOME_CATEGORIES.has(normalized)
      || normalized.includes('payroll')
      || normalized.includes('income');
  });
}

/* Merchant logos, restricted to Plaid's own host.

   Plaid already holds the transaction, so fetching a logo from them discloses
   nothing new. A URL pointing at the merchant's own server is different:
   loading it would tell that merchant this person exists and is looking at this
   purchase, which is a spending disclosure the app must not make for the sake
   of decoration. The web app applies the same rule client-side; enforcing it
   here too means no client can opt out of it. */
function plaidLogoURL(value) {
  if (typeof value !== 'string' || !value) return undefined;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return undefined;
  }
  if (parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname.toLowerCase();
  return (host === 'plaid.com' || host.endsWith('.plaid.com')) ? value : undefined;
}

function sanitizeAccount(document) {
  return {
    id: text(document.id),
    name: text(document.name, 'Account'),
    official_name: optionalText(document.official_name),
    type: text(document.type, 'other'),
    subtype: optionalText(document.subtype),
    balance_current: number(document.balance_current ?? document.balance),
    balance_available: optionalNumber(document.balance_available),
    currency: text(document.currency, 'USD'),
    mask: optionalText(document.mask),
    institution_name: text(document.institution_name),
    /* From Plaid's Liabilities product, for credit, student and mortgage
       accounts. Auto loans never carry either — Plaid does not describe them —
       which is why the client has to offer a way to enter them by hand.

       optionalNumber keeps null distinct from 0 deliberately. A 0% APR and an
       unknown APR are different claims, and downstream the difference is a
       payoff date versus an honest refusal to guess one. */
    interest_rate: optionalNumber(document.interest_rate),
    minimum_payment: optionalNumber(document.minimum_payment),
  };
}

function sanitizeTransaction(document) {
  const transactionCategories = categories(document.category);
  return {
    id: text(document.id),
    account_id: text(document.account_id),
    name: text(document.name, 'Transaction'),
    merchant_name: optionalText(document.merchant_name),
    amount: Math.abs(number(document.amount)),
    is_credit: inferCredit(document, transactionCategories),
    date: dateString(document.date),
    category: transactionCategories,
    /* Forwarded so the app can say "Postage" where Plaid says
       GENERAL_SERVICES. The primary stays authoritative; this only refines it
       where the primary is a bucket. */
    category_detailed: optionalText(document.category_detailed),
    pending: document.pending === true,
    logo_url: plaidLogoURL(document.logo_url),
  };
}

function sanitizeBill(document) {
  return {
    id: text(document.id),
    name: text(document.name, 'Unnamed Bill'),
    amount: Math.abs(number(document.amount)),
    due_date: dateString(document.due_date),
    category: text(document.category, 'Other'),
    status: text(document.status, 'pending'),
    /* Both of these were dropped on the way out, which left the native app
       unable to tell a monthly bill from a one-off, or to say when one was
       last settled. The web app collected the frequency, stored it and printed
       it on the row — so the word "monthly" was already on screen while the
       only client that could act on it never received it. */
    frequency: text(document.frequency, 'monthly'),
    paid_at: dateString(document.paid_at),
  };
}

function sanitizeGoal(document) {
  return {
    id: text(document.id),
    name: text(document.name, 'Savings goal'),
    current: Math.max(0, number(document.current)),
    target: Math.max(0, number(document.target)),
    target_date: dateString(document.target_date),
  };
}

/** How many transactions the ledger screen receives in full. */
const LEDGER_SIZE = 500;

/* Everything older than the ledger window, carried in a compact shape.
 *
 * A yearly subscription needs two charges about 365 days apart, and both have
 * to be in the data for the app to see the gap. On an active account the newest
 * 500 transactions can be only a few months, so annual plans — often the
 * expensive ones — were undetectable no matter how good the detector was. The
 * limit was never the logic; it was the window.
 *
 * Sent separately rather than by simply enlarging the ledger: the screen shows
 * perhaps fifty rows, and shipping fifteen hundred full records to render them
 * costs the user bandwidth on every refresh. These carry only what recurrence
 * needs — who, how much, when — which is roughly a third of the size and never
 * reaches the ledger UI.
 */
function compactCharge(document) {
  const merchant = optionalText(document.merchant_name);
  return {
    merchant_name: merchant,
    name: text(document.name, 'Transaction'),
    amount: Math.abs(number(document.amount)),
    date: dateString(document.date),
    category: categories(document.category),
    is_credit: inferCredit(document, categories(document.category)),
  };
}

function buildFinancialSnapshot(documents) {
  const input = documents || {};
  const all = input.transactions || [];
  return {
    accounts: (input.accounts || []).map(sanitizeAccount),
    transactions: all.slice(0, LEDGER_SIZE).map(sanitizeTransaction),
    /* Older than the ledger window. The detector reads these; nothing renders
       them, so they carry no logo and no id. */
    recurrence_history: all.slice(LEDGER_SIZE).map(compactCharge),
    bills: (input.bills || []).map(sanitizeBill),
    goals: (input.goals || []).map(sanitizeGoal),
  };
}

module.exports = {
  buildFinancialSnapshot,
  compactCharge,
  LEDGER_SIZE,
  sanitizeAccount,
  sanitizeTransaction,
  sanitizeBill,
  sanitizeGoal,
};
