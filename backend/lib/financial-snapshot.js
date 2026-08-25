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
    pending: document.pending === true,
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

function buildFinancialSnapshot(documents) {
  const input = documents || {};
  return {
    accounts: (input.accounts || []).map(sanitizeAccount),
    transactions: (input.transactions || []).map(sanitizeTransaction),
    bills: (input.bills || []).map(sanitizeBill),
    goals: (input.goals || []).map(sanitizeGoal),
  };
}

module.exports = {
  buildFinancialSnapshot,
  sanitizeAccount,
  sanitizeTransaction,
  sanitizeBill,
  sanitizeGoal,
};
