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

  /* ═══════════════════════════════════════════════════════════════
     INCOME PROFILE
     predictNextPayday() answers "when is the next paycheck" and returns
     null unless it finds a 12-16 or 25-37 day cadence. That silently
     excludes everyone whose income is irregular — gig drivers, servers
     living on tips, 1099 contractors, anyone with variable shifts — which
     is precisely the group with the most cash-flow anxiety and the least
     served by every competitor.

     For them the question is not "will I make it to payday", because there
     isn't one. It is "how long am I covered if I don't earn another
     dollar?" This builds the profile that lets the runway ask the right
     question for each person.
     ═══════════════════════════════════════════════════════════════ */

  function median(xs) {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  const CADENCES = [
    { name: 'weekly',      lo: 5,  hi: 9  },
    { name: 'biweekly',    lo: 12, hi: 16 },
    { name: 'semimonthly', lo: 14, hi: 17 },
    { name: 'monthly',     lo: 25, hi: 37 },
  ];

  /**
   * incomeProfile(transactions, windowDays)
   *  kind: 'regular' | 'irregular' | 'none'
   *  perDay/perWeek: robust estimate of what actually lands
   *  typicalLow/typicalHigh: weekly band (IQR-ish), for honest ranges
   *  confidence: 0..1 — how much history backs the estimate
   */
  function incomeProfile(transactions, windowDays) {
    const win = windowDays || 90;
    const cutoff = new Date(Date.now() - win * 86400000);
    const income = (transactions || [])
      .filter(t => isIncomeTxn(t) && t.date && parseDateLocal(t.date) >= cutoff)
      .map(t => ({ ts: parseDateLocal(t.date).getTime(), amount: Number(t.amount || 0), key: txnKey(t) }))
      .filter(t => t.amount > 0)
      .sort((a, b) => a.ts - b.ts);

    if (!income.length) {
      return { kind: 'none', cadence: null, nextPayday: null, perDay: 0, perWeek: 0,
               typicalLow: 0, typicalHigh: 0, sampleCount: 0, confidence: 0 };
    }

    /* Observed span: from the first deposit we can see, or the window,
       whichever is shorter. Dividing by the full window when we only have
       three weeks of history understates income badly. */
    const spanDays = Math.max(7, Math.min(win, Math.ceil((Date.now() - income[0].ts) / 86400000)));
    const total = income.reduce((s, t) => s + t.amount, 0);
    const perDay = total / spanDays;

    /* Weekly buckets give a band that survives one big or one missing week. */
    const weeks = {};
    income.forEach(t => {
      const wk = Math.floor((Date.now() - t.ts) / (7 * 86400000));
      weeks[wk] = (weeks[wk] || 0) + t.amount;
    });
    const weekTotals = Object.values(weeks);
    const perWeek = weekTotals.length ? median(weekTotals) : perDay * 7;
    const sorted = weekTotals.slice().sort((a, b) => a - b);
    const typicalLow  = sorted.length ? sorted[Math.floor(sorted.length * 0.25)] : perWeek;
    const typicalHigh = sorted.length ? sorted[Math.floor(sorted.length * 0.75)] : perWeek;

    // Regular cadence? Reuse the same grouping predictNextPayday uses.
    const payday = predictNextPayday(transactions);
    let cadence = null;
    if (payday) {
      const groups = {};
      income.forEach(t => { (groups[t.key] = groups[t.key] || []).push(t.ts); });
      for (const dates of Object.values(groups)) {
        if (dates.length < 2) continue;
        dates.sort((a, b) => a - b);
        const gaps = dates.slice(1).map((v, i) => (v - dates[i]) / 86400000);
        const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        const hit = CADENCES.find(c => avg >= c.lo && avg <= c.hi);
        if (hit) { cadence = hit.name; break; }
      }
    }

    const confidence = Math.max(0, Math.min(1, (income.length / 6) * (spanDays / win)));
    return {
      kind: payday ? 'regular' : 'irregular',
      cadence, nextPayday: payday,
      perDay, perWeek, typicalLow, typicalHigh,
      sampleCount: income.length,
      confidence: +confidence.toFixed(2),
    };
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

    /* How many days until the money runs out if nothing else comes in.
       For someone with a paycheck this is a footnote. For someone on
       irregular income it is the whole question — so the caller uses it
       instead of "days to payday". */
    let coveredDays = horizon;
    if (firstNegativeDay !== null) coveredDays = Math.max(0, firstNegativeDay - 1);
    else if (dailyBurn > 0) {
      const end = points[points.length - 1].balance;
      coveredDays = horizon + Math.floor(end / dailyBurn);
    } else if (points[points.length - 1].balance >= 0) {
      coveredDays = Infinity;
    }

    const income = incomeProfile(input.transactions);

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
      income,                                   // regular | irregular | none
      coveredDays,                              // days of runway with zero new income
      isIrregular: income.kind === 'irregular',
    };
  }

  /* ═══════════════════════════════════════════════════════════════
     FORECAST ACCURACY
     Every other money app reports the past, so it is never wrong — and
     never verifiably right. FlowCheck makes a prediction, which means it
     can be scored. Scoring it honestly is the strongest trust signal in
     this category, and it is what turns "do I believe this number?" into
     evidence instead of faith.

     snapshots: [{ date, predictedEnd, actualEnd }]
     ═══════════════════════════════════════════════════════════════ */
  function scoreForecast(snapshots) {
    /* Coerce ONLY real numbers. `+null` and `+''` are 0 and finite, so a
       naive Number.isFinite(+x) check scores a MISSING prediction as a
       $0 prediction — which would quietly poison the very statistic that
       is supposed to prove this app tells the truth. */
    const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v
                   : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v)) ? +v
                   : null;
    const rows = (snapshots || [])
      .map(s => s ? { ...s, _p: num(s.predictedEnd), _a: num(s.actualEnd) } : null)
      .filter(s => s && s._p !== null && s._a !== null);

    if (!rows.length) {
      return { count: 0, medianAbsError: null, withinFifty: 0, hitRate: null,
               averageBias: null, verdict: 'not enough history yet' };
    }

    const errors = rows.map(s => s._a - s._p);   // + = we under-promised
    const absErrors = errors.map(Math.abs);
    const within = rows.filter((_, i) => absErrors[i] <= 50).length;
    const bias = errors.reduce((s, e) => s + e, 0) / errors.length;
    const med = median(absErrors);

    /* Deliberately conservative wording. Claiming accuracy we cannot
       support on 2 data points would be exactly the kind of overclaim this
       product exists to avoid. */
    let verdict;
    if (rows.length < 3)      verdict = 'still learning your pattern';
    else if (med <= 25)       verdict = 'very accurate so far';
    else if (med <= 75)       verdict = 'close so far';
    else                      verdict = 'still calibrating';

    return {
      count: rows.length,
      medianAbsError: +med.toFixed(2),
      withinFifty: within,
      hitRate: +(within / rows.length).toFixed(2),
      averageBias: +bias.toFixed(2),   // negative = we over-promised, the dangerous direction
      verdict,
    };
  }

  /* ── Net worth ────────────────────────────────────────────────────
     Liability balances arrive from Plaid as positive numbers, so they are
     subtracted rather than summed. Matches FCData.calcNetWorth and the two
     inline copies in fc-app.js (~6760, ~8454). */
  const LIABILITY_TYPES = new Set(['credit', 'loan']);

  function netWorth(accounts) {
    const all = accounts || [];
    const assets = all
      .filter(a => !LIABILITY_TYPES.has(String(a.type || '').toLowerCase()))
      .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
    const liabilities = all
      .filter(a => LIABILITY_TYPES.has(String(a.type || '').toLowerCase()))
      .reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
    return { assets, liabilities, net: assets - liabilities };
  }

  /* ── Spending by category, last N days ───────────────────────────
     Transfers and loan/card payments are excluded via isSpendTxn — moving
     money between your own accounts is not spending, and counting it makes
     every total wrong. */
  function spendingByCategory(transactions, days) {
    const window = days || 30;
    const cutoff = new Date(Date.now() - window * 86400000);
    const totals = {};
    (transactions || []).forEach(t => {
      if (!isSpendTxn(t) || !t.date) return;
      if (parseDateLocal(t.date) < cutoff) return;
      const key = normalizeCategory(firstCategory(t)) || 'Other';
      totals[key] = (totals[key] || 0) + Number(t.amount || 0);
    });
    return Object.entries(totals)
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);
  }

  /* Total spend over a window — the same number spendingByCategory sums to. */
  function spendTotal(transactions, days) {
    return spendingByCategory(transactions, days).reduce((s, c) => s + c.amount, 0);
  }

  /* ── Forecast bookkeeping ─────────────────────────────────────────
     Pure decisions about WHAT to record and WHEN to settle. The caller
     owns the Firestore I/O; keeping the rules here means the phone and the
     web app can never disagree about what counts as a scored prediction. */

  function isoDay(d) {
    const x = new Date(d);
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0')
         + '-' + String(x.getDate()).padStart(2, '0');
  }

  /**
   * What prediction should be on file right now, if any.
   * Only records when there is a real target date to be judged against —
   * a forecast with no due date can never be scored, so writing one would
   * just inflate the denominator.
   */
  function forecastToRecord(runway) {
    if (!runway || !runway.hasPayday || !runway.payday) return null;
    const target = runway.payday.date;
    if (!target) return null;
    return {
      id: isoDay(target),
      target_date: isoDay(target),
      predicted_end: +Number(runway.endBalance).toFixed(2),
      predicted_on: isoDay(new Date()),
      horizon: runway.horizon,
      bill_count: runway.billCount,
    };
  }

  /**
   * Which stored forecasts are now due to be settled with what actually
   * happened. Settles the day AFTER the target so same-day transactions
   * have landed — settling on the morning of payday would score the
   * prediction against a balance the paycheck has not hit yet.
   */
  function forecastsToSettle(stored, today) {
    const now = today ? parseDateLocal(today) : new Date();
    now.setHours(0, 0, 0, 0);
    return (stored || []).filter(f => {
      if (!f || f.actual_end !== undefined && f.actual_end !== null) return false;
      if (!f.target_date) return false;
      const t = parseDateLocal(f.target_date); t.setHours(0, 0, 0, 0);
      return (now - t) / 86400000 >= 1;
    });
  }

  return {
    parseDateLocal, daysUntil, isoDay,
    forecastToRecord, forecastsToSettle,
    isSpendTxn, isIncomeTxn, normalizeCategory,
    spendableCash, predictNextPayday,
    buildSafeSpendProjection, buildRunwaySeries,
    netWorth, spendingByCategory, spendTotal,
    incomeProfile, scoreForecast, median,
  };
}));
