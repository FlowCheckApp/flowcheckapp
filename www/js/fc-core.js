/**
 * FlowCheck — Core money math (SHARED)
 * ─────────────────────────────────────────────────────────────────
 * Pure functions. No DOM, no network, no globals, no `state`.
 *
 * WHY THIS FILE EXISTS
 * The web app at /app must show the SAME numbers as the phone. The only
 * honest way to guarantee that is one implementation, so this is it:
 * everything here is a direct extraction of the logic in fc-app.js
 * (_getSpendableCheckingCash, _predictNextPayday, _buildSafeSpendProjection,
 * _buildRunwaySeries), rewritten to take explicit inputs instead of reading
 * module state.
 *
 * fc-app.js still carries its own copy of this logic. Until it is migrated
 * to call FCCore, the two MUST agree — scripts/check-core-parity.js runs
 * both against shared fixtures and fails the build if they diverge.
 * If you change the math, change it here and re-run that check.
 *
 * Everything below is the answer to one question: "if I spend this, am I
 * going to be okay?" Get it wrong and the app lies to someone about money.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FCCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── Date helpers — local midnight, never UTC ─────────────────────
     "2026-05-19" parsed as UTC is the previous evening in US timezones,
     which makes a bill due today look overdue. */
  function parseDateLocal(dateStr) {
    if (dateStr instanceof Date) return new Date(dateStr);
    const s = String(dateStr || '');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return new Date(s);
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const due = parseDateLocal(dateStr); due.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (isNaN(due)) return null;
    return Math.round((due - today) / 86400000);
  }

  /* ── Transaction classification ───────────────────────────────── */
  const XFER_SKIP = new Set([
    'transfer', 'loan', 'loan payments', 'loan payment',
    'credit card payment', 'transfer in', 'transfer out',
  ]);
  const INCOME_HARD_EXCLUDE = new Set([
    'credit card', 'credit card payment', 'loan payment', 'loan payments',
    'transfer out', 'payment',
  ]);
  const PLAID_MAP = {
    FOOD_AND_DRINK: 'Food and Drink', GENERAL_MERCHANDISE: 'Shopping',
    GENERAL_SERVICES: 'Services', TRAVEL: 'Travel',
    TRANSPORTATION: 'Auto and Transport', ENTERTAINMENT: 'Entertainment',
    PERSONAL_CARE: 'Personal Care', MEDICAL: 'Healthcare',
    LOAN_PAYMENTS: 'Loan', RENT_AND_UTILITIES: 'Utilities',
    HOME_IMPROVEMENT: 'Home Improvement', INCOME: 'Income',
    TRANSFER_IN: 'Transfer', TRANSFER_OUT: 'Transfer',
  };
  function normalizeCategory(cat) {
    if (!cat) return 'Other';
    return PLAID_MAP[String(cat).toUpperCase()] || String(cat);
  }
  function firstCategory(t) {
    return (Array.isArray(t.category) ? t.category[0] : t.category) || '';
  }

  function isSpendTxn(t) {
    if (t.isCredit || !t.date) return false;
    const norm = normalizeCategory(firstCategory(t)).toLowerCase();
    return !XFER_SKIP.has(norm) && !norm.includes('transfer');
  }

  /* All credits count as income except explicit non-income categories.
     A whitelist silently drops paychecks, because Plaid frequently files
     direct deposits under "Transfer"/"TRANSFER_IN". */
  function isIncomeTxn(t) {
    if (!t.isCredit || !t.date) return false;
    const raw = String(firstCategory(t)).trim().toLowerCase();
    const norm = normalizeCategory(firstCategory(t)).toLowerCase();
    if (INCOME_HARD_EXCLUDE.has(raw) || INCOME_HARD_EXCLUDE.has(norm)) return false;
    if (norm.includes('credit card') || norm.includes('loan payment')) return false;
    return true;
  }

  function txnKey(t) {
    const name = t.customName || t.merchant_name || t.name || 'Transaction';
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18);
  }

  /* ── Spendable cash ───────────────────────────────────────────────
     Checking only. Savings/money-market/CD are excluded deliberately:
     money you have mentally earmarked is not money you can spend today. */
  function spendableCash(accounts) {
    const all = accounts || [];
    const checking = all.filter(a => {
      const type = String(a.type || '').toLowerCase();
      const subtype = String(a.subtype || '').toLowerCase();
      return type === 'depository' && !/savings|money market|cd/.test(subtype);
    });
    const source = checking.length ? checking : all.filter(a => a.type === 'depository');
    return source.reduce((sum, a) => sum + (a.balance_current || a.balance || 0), 0);
  }

  /* ── Payday prediction ────────────────────────────────────────────
     Group income by payer, look for a consistent bi-weekly (12-16d) or
     monthly (25-37d) cadence. Returns null when there is no clear
     pattern — the caller must fall back to a horizon, never invent a date. */
  function predictNextPayday(transactions) {
    const groups = {};
    (transactions || []).filter(isIncomeTxn).forEach(t => {
      if (!t.date || !t.amount) return;
      const key = txnKey(t);
      (groups[key] = groups[key] || []).push(parseDateLocal(t.date).getTime());
    });
    let best = null;
    Object.values(groups).forEach(dates => {
      if (dates.length < 2) return;
      dates.sort((a, b) => a - b);
      const gaps = dates.slice(1).map((v, i) => (v - dates[i]) / 86400000);
      const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      if (!((avg >= 12 && avg <= 16) || (avg >= 25 && avg <= 37))) return;
      let next = dates[dates.length - 1] + avg * 86400000;
      while (next < Date.now()) next += avg * 86400000;
      const days = Math.max(1, Math.ceil((next - Date.now()) / 86400000));
      if (days <= 31 && (!best || days < best.days)) best = { date: new Date(next), days };
    });
    return best;
  }

  /* ── Safe-to-spend projection ─────────────────────────────────────
     NOTE the horizon: `days` is min(14, paydayDays). `safe` answers "what
     can I spend in the near term", which is why it also holds back a
     reserve. It is NOT the same question as the runway endpoint. */
  function buildSafeSpendProjection(input) {
    const accounts = input.accounts || [];
    const transactions = input.transactions || [];
    const allBills = input.bills || [];

    const cash = Math.max(0, spendableCash(accounts));
    const payday = predictNextPayday(transactions);
    const days = Math.min(14, (payday && payday.days) || 7);

    const bills = allBills.filter(b => {
      if (b.status === 'paid') return false;
      const dueIn = daysUntil(b.due_date);
      return dueIn !== null && dueIn >= 0 && dueIn <= days;
    });
    const billsTotal = bills.reduce((s, b) => s + (b.amount || 0), 0);

    const cutoff = new Date(Date.now() - 30 * 86400000);
    const recentSpend = transactions
      .filter(t => isSpendTxn(t) && t.date && parseDateLocal(t.date) >= cutoff)
      .reduce((s, t) => s + (t.amount || 0), 0);
    const expectedEverydaySpend = (recentSpend / 30) * days;

    const reserve = Math.min(cash, Math.max(250, cash * 0.10));
    const safe = Math.max(0, cash - billsTotal - expectedEverydaySpend - reserve);

    return { cash, payday, days, bills, billsTotal, expectedEverydaySpend, reserve, safe };
  }

  /* ── The Runway ───────────────────────────────────────────────────
     One balance point per day from today to payday, dipping at each
     unpaid bill.

     Bills are sourced from the FULL bill list over the FULL horizon —
     NOT from projection.bills, which is capped at min(14, paydayDays).
     Reusing that capped list silently drops every bill past day 14 and
     overstates what you land on, which is the one number this exists to
     get right. */
  function buildRunwaySeries(input) {
    const p = buildSafeSpendProjection(input);
    const allBills = input.bills || [];

    const horizon = Math.max(1, Math.min(31, (p.payday && p.payday.days) || 14));
    const dailyBurn = p.expectedEverydaySpend / Math.max(1, p.days || horizon);

    const billsByDay = {};
    allBills.forEach(b => {
      if (b.status === 'paid') return;
      const d = daysUntil(b.due_date);
      if (d === null || d < 0 || d > horizon) return;
      (billsByDay[d] = billsByDay[d] || []).push(b);
    });

    let balance = p.cash;
    let lowest = { day: 0, balance: p.cash };
    let firstNegativeDay = null;
    const points = [];

    for (let day = 0; day <= horizon; day++) {
      const dayBills = billsByDay[day] || [];
      balance -= dayBills.reduce((s, b) => s + Number(b.amount || 0), 0);
      if (day > 0) balance -= dailyBurn;
      if (balance < lowest.balance) lowest = { day, balance };
      if (firstNegativeDay === null && balance < 0) firstNegativeDay = day;
      const date = new Date();
      date.setDate(date.getDate() + day);
      date.setHours(0, 0, 0, 0);
      points.push({ day, date, balance, bills: dayBills });
    }

    return {
      points, horizon, dailyBurn,
      startBalance: p.cash,
      endBalance: points[points.length - 1].balance,
      lowest, firstNegativeDay,
      goesNegative: firstNegativeDay !== null,
      payday: p.payday || null,
      hasPayday: !!p.payday,
      billCount: Object.values(billsByDay).reduce((n, a) => n + a.length, 0),
      safe: p.safe,
      projection: p,
    };
  }

  return {
    parseDateLocal, daysUntil,
    isSpendTxn, isIncomeTxn, normalizeCategory,
    spendableCash, predictNextPayday,
    buildSafeSpendProjection, buildRunwaySeries,
  };
}));
