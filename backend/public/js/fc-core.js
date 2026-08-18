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
  /* 'loan' is here because LOAN_PAYMENTS normalises to 'Loan', which matched
     neither 'loan payment' nor 'loan payments' — so a CREDIT categorised
     LOAN_PAYMENTS (a disbursement, or a refunded payment) counted as income.
     Borrowed money is not a paycheck, and predictNextPayday would have
     treated it as one. Pre-existing; found while consolidating the two
     classifiers, fixed here because it is the same guard and the same bug. */
  const INCOME_HARD_EXCLUDE = new Set([
    'credit card', 'credit card payment', 'loan', 'loan payment',
    'loan payments', 'transfer out', 'payment',
  ]);
  /* THE category map. There used to be a second, richer one in fc-data
     (25 entries vs 14) plus a different normalisation, and the two disagreed
     on 18 of 33 realistic inputs.

     For the spend/skip decision they happened to agree, because XFER_SKIP
     lists both the mapped and unmapped spellings. Income was not so lucky:
     a Plaid `CREDIT_CARD` credit — a refund or statement credit — normalised
     here to the untouched 'CREDIT_CARD', which matched neither
     INCOME_HARD_EXCLUDE nor the `includes('credit card')` guard, because of
     the underscore. So it counted as INCOME. predictNextPayday filters on
     exactly this, and it feeds the payday date, the expected amount and the
     safe-to-spend projection: a card refund was being read as a paycheck.

     Fixed by making this the superset and the only implementation. */
  const PLAID_MAP = {
    FOOD_AND_DRINK: 'Food and Drink', GENERAL_MERCHANDISE: 'Shopping',
    GENERAL_SERVICES: 'Services', TRAVEL: 'Travel',
    TRANSPORTATION: 'Auto and Transport', ENTERTAINMENT: 'Entertainment',
    PERSONAL_CARE: 'Personal Care', MEDICAL: 'Healthcare',
    LOAN_PAYMENTS: 'Loan', RENT_AND_UTILITIES: 'Utilities',
    HOME_IMPROVEMENT: 'Home Improvement', INCOME: 'Income',
    TRANSFER_IN: 'Transfer', TRANSFER_OUT: 'Transfer',
    BANK_FEES: 'Bank Fees', GOVERNMENT_AND_NON_PROFIT: 'Government',
    EDUCATION: 'Education', AUTOMOTIVE: 'Auto and Transport',
    GROCERIES: 'Grocery', RESTAURANTS: 'Restaurants',
    COFFEE_SHOPS: 'Coffee Shop', GAS_STATIONS: 'Gas Stations',
    CREDIT_CARD: 'Credit Card', INVESTMENTS: 'Investments',
    OTHER: 'Other',
  };
  /* Plaid ships the same category in two spellings depending on which product
     and vintage it came from — 'TRANSFER_OUT' and 'Transfer Out'. Fold spaces
     to underscores BEFORE the lookup so both land on one label, and title-case
     anything unmapped so an unknown category is still presentable. */
  function normalizeCategory(cat) {
    if (!cat) return 'Other';
    const upper = String(cat).toUpperCase().replace(/ /g, '_');
    return PLAID_MAP[upper] || String(cat)
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
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

  /* ── Account classification — ONE definition ──────────────────────
     Two vocabularies reach us and they do not overlap:

       Plaid   type: depository | credit | loan | investment | brokerage | other
       Manual  type: savings | checking | investment | credit | loan
               (the Add Account sheet writes type === subtype)

     Before this existed every rollup rolled its own test, and most of them
     only understood Plaid's. The visible consequence: a manual checking
     account with $5,000 raised net worth by $5,000, showed under Savings,
     and was invisible to Safe to Spend, the Cash tile and the allocation
     bar — the totals on screen did not add up to the total at the top.

     Returns exactly one of: 'debt' | 'cash' | 'investment' | 'other'.
     Debt is tested FIRST so a manual 'credit' can never fall through to a
     cash test that matches on subtype. */

  const DEBT_TYPES    = new Set(['credit', 'loan']);
  const DEBT_SUBTYPES = new Set([
    'credit card', 'line of credit', 'mortgage', 'auto', 'student',
    'home equity', 'consumer', 'commercial', 'construction', 'overdraft',
  ]);
  const CASH_TYPES    = new Set(['depository', 'checking', 'savings']);
  const CASH_SUBTYPES = new Set([
    'checking', 'savings', 'money market', 'cd', 'cash management',
    'prepaid', 'paypal', 'hsa', 'ebt',
  ]);
  const INVEST_TYPES  = new Set(['investment', 'brokerage']);
  /* Balances you cannot spend today. Savings/CDs are excluded from
     spendable on purpose: money mentally earmarked is not money you can
     spend this afternoon. */
  const PARKED_SUBTYPES = /savings|money market|cd|hsa/;

  function accountClass(account) {
    const a = account || {};
    const type    = String(a.type    || '').toLowerCase();
    const subtype = String(a.subtype || '').toLowerCase();
    if (DEBT_TYPES.has(type)   || DEBT_SUBTYPES.has(subtype))   return 'debt';
    if (CASH_TYPES.has(type)   || CASH_SUBTYPES.has(subtype))   return 'cash';
    if (INVEST_TYPES.has(type) || subtype === 'brokerage'
        || /^(401|403|457|529)/.test(subtype) || /ira|roth|pension|mutual fund/.test(subtype)) {
      return 'investment';
    }
    return 'other';
  }

  const isDebtAccount  = a => accountClass(a) === 'debt';
  const isCashAccount  = a => accountClass(a) === 'cash';
  /** Assets = everything that is not a debt. `other` counts here: Plaid uses
   *  it for anything it cannot classify, and netWorth already treats it as an
   *  asset — excluding it from the rollups is what made those two disagree. */
  const isAssetAccount = a => accountClass(a) !== 'debt';

  /** Cash you could actually spend today — checking-like only. */
  function isSpendableAccount(a) {
    if (accountClass(a) !== 'cash') return false;
    const type    = String((a && a.type)    || '').toLowerCase();
    const subtype = String((a && a.subtype) || '').toLowerCase();
    // Manual accounts carry their kind in `type` (type === subtype), Plaid
    // carries it in `subtype`. Test both or manual savings reads as spendable.
    return !PARKED_SUBTYPES.test(subtype) && !PARKED_SUBTYPES.test(type);
  }

  const accountBalance = a => (a && (a.balance_current || a.balance)) || 0;

  /* ── Spendable cash ───────────────────────────────────────────────
     Checking only, falling back to all cash when nothing looks like a
     current account — otherwise somebody who banks entirely from a
     savings account sees a Safe to Spend of zero. */
  function spendableCash(accounts) {
    const all = (accounts || []).filter(isCashAccount);
    const checking = all.filter(isSpendableAccount);
    const source = checking.length ? checking : all;
    return source.reduce((sum, a) => sum + accountBalance(a), 0);
  }

  /* ── Payday prediction ────────────────────────────────────────────
     Answers "when does the next paycheque land". Returns null when there
     is no clear pattern — the caller must fall back to a horizon and never
     invent a date.

     Every rule below exists because the previous version was measured
     getting one of these wrong:

       · Paid today read as "14 days away". `next` was compared against
         Date.now() while deposit dates parse to local midnight, so from
         00:01 on payday the prediction skipped to the cheque after it.
       · Weekly earners got null — only 12-16d and 25-37d were recognised —
         and the caller then invented a flat 7-day horizon.
       · Semi-monthly (1st & 15th) was averaged to ~15.2d and drifted off
         both dates. For an Aug 1 / Aug 15 payer it predicted Aug 16.
       · Monthly drifted the same way: last + 30.4d turns the 1st into the
         31st, then the 2nd, then the 4th.
       · One missed cheque killed the prediction outright, because the MEAN
         gap left the window: [14,14,14,45] → 21.75 → null.
       · Gaps of [5, 25] have a mean of 15 and were reported, confidently,
         as biweekly. Nothing tested that the gaps agreed with each other.
       · A payroll that stopped 150 days ago still produced a date 4 days
         out, because the loop simply advanced until it passed today.
       · A $3/month interest credit was indistinguishable from a salary.

     Returns { date, days, cadence }. `days` is 0 on payday itself, so
     callers must use an explicit null test rather than `|| fallback`. */

  const _PAYDAY_MIN_AMOUNT = 100;   // below this it is a refund, not a wage
  const _FIXED_CADENCES = [
    { name: 'weekly',   step:  7, lo:  6, hi:  8,  tol: 2 },
    { name: 'biweekly', step: 14, lo: 12, hi: 16,  tol: 3 },
    { name: 'monthly',  step: 30, lo: 26, hi: 37,  tol: 6 },
  ];

  /** Payer key for cadence grouping. Digits are stripped rather than sliced
   *  around: payroll descriptors carry a changing reference or date
   *  ("ACME DIRECT DEP 0615" → "…0629"), which split one employer into two
   *  groups of one and made the cadence invisible. */
  function _payerKey(t) {
    const name = t.customName || t.merchant_name || t.name || 'Transaction';
    return String(name).toLowerCase().replace(/[^a-z]/g, '').slice(0, 20) || 'income';
  }

  function _startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; }

  /** Add whole months, clamping into shorter ones: paid on the 31st means
   *  the 30th in April, not the 1st of May. */
  function _addMonths(from, n, dom) {
    const d = new Date(from.getFullYear(), from.getMonth() + n, 1);
    const lastDom = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(dom, lastDom));
    return d;
  }

  /** Direct deposits settle on business days — a weekend payday lands the
   *  Friday before. Never shifts back past today. */
  function _toBusinessDay(date, todayMs) {
    const d = new Date(date);
    if (d.getDay() === 6) d.setDate(d.getDate() - 1);       // Sat → Fri
    else if (d.getDay() === 0) d.setDate(d.getDate() - 2);  // Sun → Fri
    return d.getTime() < todayMs ? new Date(date) : d;
  }

  /** Two fixed days of the month (1st & 15th, 15th & last), or null.
   *  Detected by clustering day-of-month, because semi-monthly gaps
   *  legitimately alternate (13/18, 14/17) and fail any gap-consistency
   *  test — which is why averaging them drifted off both dates. */
  function _semiMonthlyDoms(doms) {
    if (doms.length < 4) return null;   // two of each date is the minimum evidence
    const counts = new Map();
    doms.forEach(d => counts.set(d, (counts.get(d) || 0) + 1));
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, 2).map(e => e[0]);
    if (top.length < 2) return null;
    const spread = Math.abs(top[0] - top[1]);
    if (spread < 10 || spread > 20) return null;            // must be ~half a month apart

    /* Both clusters must hold at least two deposits. Any four scattered
       days-of-month contain *some* pair 10-20 apart, so a coverage ratio
       alone declared biweekly runs semi-monthly and then snapped them to
       invented dates — [17, 1, 15, 29] became "the 1st and the 15th".
       Requiring each date to have been seen twice is what makes this
       evidence of a schedule rather than an artefact of arithmetic. */
    const sizes = [0, 0];
    doms.forEach(d => {
      const i = Math.abs(d - top[0]) <= 3 ? 0 : Math.abs(d - top[1]) <= 3 ? 1 : -1;
      if (i >= 0) sizes[i]++;                               // ±3 absorbs the weekend shift
    });
    if (sizes[0] < 2 || sizes[1] < 2) return null;
    if ((sizes[0] + sizes[1]) / doms.length < 0.7) return null;
    return top.slice().sort((a, b) => a - b);
  }

  function _nextSemiMonthly(doms, todayMs) {
    const today = new Date(todayMs);
    const cands = [];
    for (let m = 0; m <= 2; m++) {
      doms.forEach(dom => cands.push(_addMonths(new Date(today.getFullYear(), today.getMonth(), 1), m, dom)));
    }
    cands.sort((a, b) => a - b);
    return cands.find(d => d.getTime() >= todayMs) || cands[cands.length - 1];
  }

  /** Cadence + next date for one payer's deposit dates, or null. */
  function _cadenceFor(dates, todayMs) {
    const last = dates[dates.length - 1];
    const gaps = dates.slice(1).map((v, i) => (v - dates[i]) / 86400000);
    if (!gaps.length) return null;
    const med  = median(gaps);
    const doms = dates.map(ms => new Date(ms).getDate());

    // Semi-monthly first: its gaps overlap the biweekly window, so testing
    // fixed cadences first would classify it as biweekly and drift.
    const semi = _semiMonthlyDoms(doms);
    if (semi && med >= 12 && med <= 18) {
      if ((todayMs - last) / 86400000 > 40) return null;    // schedule has stopped
      return { date: _toBusinessDay(_nextSemiMonthly(semi, todayMs), todayMs), cadence: 'semimonthly' };
    }

    for (const c of _FIXED_CADENCES) {
      if (med < c.lo || med > c.hi) continue;
      /* Gaps must agree with each other, not merely average into range.
         A gap of 2x or 3x the cadence still agrees: a missed deposit, a
         payroll correction or a hole in Plaid's history leaves the schedule
         intact and one cheque unseen. Counting that as disagreement threw
         away an otherwise perfect biweekly run on a single skipped week. */
      const agree = gaps.filter(g => {
        for (let k = 1; k <= 3; k++) if (Math.abs(g - med * k) <= c.tol) return true;
        return false;
      }).length;
      if (agree / gaps.length < 0.7) continue;
      // Two cadences of silence means the job ended or the account changed.
      if ((todayMs - last) / 86400000 > c.step * 2 + 5) continue;

      let next;
      if (c.name === 'monthly') {
        const dom = Math.round(median(doms));
        const from = new Date(last);
        let n = 1;
        next = _addMonths(from, n, dom);
        while (next.getTime() < todayMs && n < 4) next = _addMonths(from, ++n, dom);
      } else {
        next = new Date(last + c.step * 86400000);
        let guard = 0;
        while (next.getTime() < todayMs && guard++ < 8) {
          next = new Date(next.getTime() + c.step * 86400000);
        }
      }
      if (next.getTime() < todayMs) continue;
      return { date: _toBusinessDay(next, todayMs), cadence: c.name };
    }
    return null;
  }

  function predictNextPayday(transactions, nowMs) {
    const todayMs = _startOfDay(nowMs == null ? Date.now() : nowMs).getTime();

    const groups = {};
    (transactions || []).filter(isIncomeTxn).forEach(t => {
      if (!t.date || !t.amount) return;
      const d = parseDateLocal(t.date);
      if (isNaN(d.getTime())) return;
      d.setHours(0, 0, 0, 0);
      const key = _payerKey(t);
      (groups[key] = groups[key] || []).push({ ms: d.getTime(), amount: Math.abs(t.amount) });
    });

    let best = null;
    Object.values(groups).forEach(entries => {
      // A split direct deposit is one payday, not two — collapse same-day
      // credits from one payer before measuring gaps.
      const byDay = new Map();
      entries.forEach(e => byDay.set(e.ms, (byDay.get(e.ms) || 0) + e.amount));
      const dates = [...byDay.keys()].sort((a, b) => a - b);

      // Two dates is a single gap, which cannot show consistency. Requiring
      // three is what stops a coincidence from being reported as a schedule.
      if (dates.length < 3) return;
      const amount = median(dates.map(ms => byDay.get(ms)));
      if (amount < _PAYDAY_MIN_AMOUNT) return;

      const pred = _cadenceFor(dates, todayMs);
      // Prefer the biggest cheque, not the soonest credit: the salary is the
      // payday even when a smaller deposit lands before it.
      if (pred && (!best || amount > best.amount)) best = Object.assign({ amount }, pred);
    });

    if (!best) return null;
    const days = Math.round((_startOfDay(best.date.getTime()).getTime() - todayMs) / 86400000);
    /* `amount` is the median of this payer's actual paydays, and it used to
       be computed here and then dropped on the way out. Plan's paycheck
       screen needed exactly this number and, having no way to get it,
       reached for the most recent income transaction instead — which on a
       month containing a $67.80 refund reported a $67.80 paycheck and told
       the user they were $1,455.70 short. The median is already the right
       answer and already robust to that: return it. */
    return { date: best.date, days, cadence: best.cadence, amount: best.amount };
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

    /* Cadence comes straight off the prediction now. This used to be a
       second, independent mean-of-gaps loop that could disagree with the
       date it sat next to — and it carried every bug predictNextPayday was
       just fixed for (mean not median, no consistency test, semi-monthly
       overlapping biweekly). One measurement, one answer. */
    const payday = predictNextPayday(transactions);
    const cadence = payday ? payday.cadence : null;

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
    /* Math.max(1, …), not `|| 7`: payday.days is legitimately 0 on payday
       itself, and `0 || 7` silently turned "today" into a week-long spending
       horizon. The horizon is clamped; the prediction stays truthful. */
    const days = Math.min(14, payday ? Math.max(1, payday.days) : 7);

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

    // Same `|| 14` falsy trap as the projection horizon — days can be 0.
    const horizon = Math.max(1, Math.min(31, p.payday ? p.payday.days : 14));
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
    // Uses the same classifier as every rollup, so the tiles always add up to
    // the total. Previously this tested LIABILITY_TYPES directly, which meant
    // a manual debt whose kind was only in `subtype` counted as an asset.
    const assets = all
      .filter(isAssetAccount)
      .reduce((s, a) => s + accountBalance(a), 0);
    const liabilities = all
      .filter(isDebtAccount)
      .reduce((s, a) => s + Math.max(0, accountBalance(a)), 0);
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

  /* ═══════════════════════════════════════════════════════════════
     DEBT-FREE DATE
     ═══════════════════════════════════════════════════════════════
     The one number that turns a balance into a finish line. A balance is a
     fact about the past and cannot be acted on; a date is a fact about the
     future that the user can MOVE, and watching it move is the only reward
     loop that survives a bad month.

     Simulated month by month rather than solved in closed form, because the
     thing that actually makes payoff accelerate cannot be expressed as one
     equation: when a debt clears, its minimum payment does not disappear —
     it rolls onto the next debt. That cascade is most of the difference
     between "eleven years" and "four years", and a per-debt closed form
     misses it entirely.

     Refuses to answer rather than guess. If we do not know the minimum
     payments we cannot simulate, and a plausible invented date on the screen
     someone is using to decide how to live would be the worst number in the
     product. `reason` says why, so the UI can ask for what is missing.

     @param {Array} debts  [{ name, balance, rate (APR %), minimum }]
     @param {number} extraPerMonth  additional payment above the minimums
     @param {'avalanche'|'snowball'} strategy  which debt the extra attacks
     @param {Date} [from]  simulation start, for tests
     @returns {{
       ok: boolean, reason: string|null, months: number|null, date: Date|null,
       totalInterest: number, cleared: Array<{name, month}>
     }}
  */
  /* ── Weighted average APR ─────────────────────────────────────────
     Weighted by balance, because the unweighted mean is not an answer to
     any question a person has. A $723 card at 22.99% next to a $14,250 auto
     loan at 6.9% averages to 14.9% unweighted — nearly double what the debt
     actually costs — and that number was the headline on the Debt page.

     Debts with no rate on file are excluded rather than counted as 0%:
     folding an unknown in as zero drags the average down and understates
     the cost, which is the more dangerous direction to be wrong in.

     @param {Array} debts  [{ balance, rate (APR %) }]
     @returns {number} weighted APR, or 0 when nothing has a rate
  */
  /* ── Debt progress ────────────────────────────────────────────────
     What a person has actually paid off, measured from real recorded
     balances rather than from anything they had to tell us.

     Two numbers, because they answer different questions and one of them
     lies on its own:

       paidDown  — total reduction since the earliest snapshot we hold. This
                   is the encouraging one, and the one that keeps growing.
       month     — change over the last ~30 days. This is the honest one. It
                   can be negative, and it will be in any month with heavy
                   card spending, because a credit-card balance is not a
                   measure of borrowing — it is a measure of buying.

     Nothing here guesses. With fewer than two distinct days on file it
     returns ok:false and the UI says it started tracking today, rather than
     printing a $0 that reads as "you have made no progress".

     @param {Object<string,number>} history  {YYYY-MM-DD: total debt}
     @param {number} current  today's total debt
     @returns {{
       ok: boolean, paidDown: number, month: number|null,
       from: string|null, days: number
     }}  paidDown/month are POSITIVE when debt went down.
  */
  /* ── Compare a refinance / balance-transfer offer ─────────────────
     Someone has been quoted a rate somewhere and wants to know whether it
     is actually better. That question has a real answer, and it is not the
     one the quote usually leads with — "lower monthly payment" is trivially
     achievable by stretching the term, and it very often costs MORE in
     total. This returns both numbers so the cheaper-looking option cannot
     hide behind the smaller one.

     Amortisation, not an approximation: interest accrues monthly on the
     declining balance, exactly as debtFreePlan simulates it.

     Two shapes of offer, and conflating them is how a comparison lies:

       · A REFI LOAN (auto, personal, student) has a fixed term, and the
         payment falls out of it. Pass `months`.
       · A BALANCE TRANSFER has no term. You keep paying whatever you pay,
         and the promo is a deadline rather than a schedule. Pass `payment`
         — normally their current payment, which asks the useful question:
         same money out the door, how much sooner is this gone?

     `introRate` for `introMonths` then reverting to `rate` models the promo.
     A 0% offer that does not clear before the window closes is not free,
     and separating payment from term is what lets that show.

     @param {object} o
     @param {number} o.balance     amount being refinanced
     @param {number} o.rate        the NEW APR (%) after any intro period
     @param {number} o.months      the NEW term in months (loan mode)
     @param {number} o.payment     fixed monthly payment (transfer mode);
                                   when given it wins, and `months` becomes
                                   an outcome rather than an input
     @param {number} o.introRate   optional promotional APR (%)
     @param {number} o.introMonths optional length of that promo
     @param {number} o.fee         transfer/origination fee, dollars
     @param {number} o.currentRate today's APR (%)
     @param {number} o.currentPayment  what they pay per month today
     @returns {{
       ok: boolean, reason: string|null,
       payment: number, totalInterest: number, months: number,
       currentTotalInterest: number, currentMonths: number,
       interestSaved: number, monthlyChange: number, monthsSaved: number
     }}  saved/… are POSITIVE when the offer is better.
  */
  function compareOffer(o) {
    const EMPTY = {
      ok: false, reason: null, payment: 0, totalInterest: 0, months: 0,
      currentTotalInterest: 0, currentMonths: 0,
      interestSaved: 0, monthlyChange: 0, monthsSaved: 0,
    };
    const bal   = Math.max(0, Number(o?.balance) || 0);
    const term  = Math.round(Number(o?.months) || 0);
    const rate  = Math.max(0, Number(o?.rate) || 0);
    const fee   = Math.max(0, Number(o?.fee) || 0);
    const curRt = Math.max(0, Number(o?.currentRate) || 0);
    const curPm = Math.max(0, Number(o?.currentPayment) || 0);
    const fixedPm = Math.max(0, Number(o?.payment) || 0);
    if (bal <= 0 || (term <= 0 && fixedPm <= 0)) {
      return { ...EMPTY, reason: 'need_balance_and_term' };
    }
    if (curPm <= 0)            return { ...EMPTY, reason: 'need_current_payment' };

    const iRate  = (o?.introRate   === null || o?.introRate === undefined || o?.introRate === '')
      ? null : Math.max(0, Number(o.introRate) || 0);
    const iMonths = Math.max(0, Math.round(Number(o?.introMonths) || 0));

    /* The new loan. The fee is financed — that is how these are almost
       always sold, and rolling it in is what makes a "no cost" offer cost
       something. */
    const principal = bal + fee;
    /* Transfer mode fixes the payment; loan mode derives it from the term.
       In loan mode the schedule is built at the rate that actually applies
       for most of it — using a 0% teaser to set a payment that then has to
       carry a 22% balance is the arithmetic that makes bad offers look fine. */
    const payment = fixedPm > 0 ? fixedPm : _amortPayment(principal, rate, term);
    if (!isFinite(payment) || payment <= 0) return { ...EMPTY, reason: 'no_payment' };

    const HARD_CAP = 600;
    const limit = fixedPm > 0 ? HARD_CAP : term;
    let b = principal, newInterest = 0, m = 0;
    for (; m < limit && b > 0.005; m++) {
      const r = (iRate !== null && m < iMonths) ? iRate : rate;
      const i = b * (r / 100 / 12);
      newInterest += i;
      const next = b + i - payment;
      // Only a rate period can outrun the payment; say so instead of looping.
      if (next >= b && m >= iMonths) return { ...EMPTY, reason: 'never_pays_off' };
      b = Math.max(0, next);
    }
    /* A promo that expires with a balance still on it reverts to the real
       rate. Keep paying the same amount and count the months honestly rather
       than pretending the term held. */
    for (; m < HARD_CAP && b > 0.005; m++) {
      const i = b * (rate / 100 / 12);
      newInterest += i;
      const next = b + i - payment;
      if (next >= b) return { ...EMPTY, reason: 'never_pays_off' };
      b = Math.max(0, next);
    }

    // What today's debt costs if nothing changes and they keep paying curPm.
    let cb = bal, curInterest = 0, cm = 0;
    for (; cm < 600 && cb > 0.005; cm++) {
      const i = cb * (curRt / 100 / 12);
      curInterest += i;
      const next = cb + i - curPm;
      if (next >= cb) { curInterest = Infinity; cm = Infinity; break; }
      cb = Math.max(0, next);
    }

    const round = v => (isFinite(v) ? Math.round(v * 100) / 100 : v);
    return {
      ok: true, reason: null,
      payment:              round(payment),
      totalInterest:        round(newInterest + fee),
      months:               m,
      currentTotalInterest: round(curInterest),
      currentMonths:        cm,
      interestSaved:        round(curInterest - (newInterest + fee)),
      monthlyChange:        round(curPm - payment),
      monthsSaved:          isFinite(cm) ? cm - m : Infinity,
    };
  }

  /** Standard amortising payment. 0% is plain division, not a divide-by-zero. */
  function _amortPayment(principal, annualRate, months) {
    const r = (Number(annualRate) || 0) / 100 / 12;
    if (r <= 0) return principal / months;
    return (principal * r) / (1 - Math.pow(1 + r, -months));
  }

  function debtProgress(history, current) {
    const EMPTY = { ok: false, paidDown: 0, month: null, from: null, days: 0 };
    const days = Object.keys(history || {})
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Number(history[d])))
      .sort();
    if (!days.length || !Number.isFinite(Number(current))) return EMPTY;

    const now = Number(current);
    const first = days[0];
    /* One day of history is one data point, and one point is not a trend.
       Comparing today against a snapshot taken today is always exactly zero. */
    const latest = days[days.length - 1];
    if (days.length < 2 && Number(history[latest]) === now) return EMPTY;

    const span = Math.round(
      (Date.parse(latest + 'T00:00:00') - Date.parse(first + 'T00:00:00')) / 86400000);

    /* The ~30-day comparison point: the newest snapshot at least 30 days old.
       Falling back to the earliest means a three-week-old account still gets
       a real "this month" figure instead of nothing. */
    const cutoff = Date.parse(latest + 'T00:00:00') - 30 * 86400000;
    let monthRef = first;
    for (const d of days) {
      if (Date.parse(d + 'T00:00:00') <= cutoff) monthRef = d; else break;
    }

    return {
      ok: true,
      paidDown: Math.round((Number(history[first]) - now) * 100) / 100,
      month:    Math.round((Number(history[monthRef]) - now) * 100) / 100,
      from:     first,
      days:     Math.max(0, span),
    };
  }

  function weightedApr(debts) {
    let num = 0, den = 0;
    for (const d of (debts || [])) {
      const rate = Number(d?.rate) || 0;
      const bal  = Math.max(0, Number(d?.balance) || 0);
      if (rate <= 0 || bal <= 0) continue;
      num += rate * bal;
      den += bal;
    }
    return den > 0 ? num / den : 0;
  }

  function debtFreePlan(debts, extraPerMonth, strategy, from) {
    const start = from ? new Date(from) : new Date();
    const EMPTY = { ok: false, reason: null, months: null, date: null, totalInterest: 0, cleared: [] };

    const live = (debts || [])
      .map(d => ({
        name:    d.name || 'Debt',
        balance: Math.max(0, Number(d.balance) || 0),
        rate:    Math.max(0, Number(d.rate) || 0),
        minimum: Math.max(0, Number(d.minimum) || 0),
      }))
      .filter(d => d.balance > 0);

    if (!live.length)                       return { ...EMPTY, reason: 'no_debt', ok: true, months: 0 };
    if (live.some(d => d.minimum <= 0))     return { ...EMPTY, reason: 'missing_minimums' };

    /* Order the queue once. The extra always attacks position 0; everything
       else pays its minimum. Avalanche targets the highest rate (cheapest
       overall), snowball the smallest balance (fastest first win). */
    const queue = live.slice().sort((a, b) => strategy === 'snowball'
      ? a.balance - b.balance
      : (b.rate - a.rate) || (b.balance - a.balance));

    let extra = Math.max(0, Number(extraPerMonth) || 0);
    let totalInterest = 0;
    const cleared = [];
    const MAX_MONTHS = 600;                  // 50 years — past this it is "never"

    for (let m = 1; m <= MAX_MONTHS; m++) {
      // Interest first, on every balance still open.
      for (const d of queue) {
        if (d.balance <= 0) continue;
        const i = d.balance * (d.rate / 100 / 12);
        d.balance += i;
        totalInterest += i;
      }

      // Minimums on everything, then the extra onto the first open debt.
      let pool = extra;
      for (const d of queue) {
        if (d.balance <= 0) continue;
        const pay = Math.min(d.minimum, d.balance);
        d.balance -= pay;
      }
      for (const d of queue) {
        if (pool <= 0) break;
        if (d.balance <= 0) continue;
        const pay = Math.min(pool, d.balance);
        d.balance -= pay;
        pool -= pay;
      }

      // Anything cleared this month hands its minimum to the pool for good.
      for (const d of queue) {
        if (d.balance <= 0.005 && !d.done) {
          d.done = true;
          d.balance = 0;
          extra += d.minimum;                // the cascade
          cleared.push({ name: d.name, month: m });
        }
      }

      if (queue.every(d => d.balance <= 0.005)) {
        const date = new Date(start.getFullYear(), start.getMonth() + m, 1);
        return { ok: true, reason: null, months: m, date,
                 totalInterest: Math.round(totalInterest * 100) / 100, cleared };
      }
    }

    // Payments never overtake the interest.
    return { ...EMPTY, reason: 'never_pays_off' };
  }

  return {
    parseDateLocal, daysUntil, isoDay,
    forecastToRecord, forecastsToSettle,
    isSpendTxn, isIncomeTxn, normalizeCategory,
    spendableCash, predictNextPayday,
    accountClass, isDebtAccount, isCashAccount, isAssetAccount,
    isSpendableAccount, accountBalance,
    buildSafeSpendProjection, buildRunwaySeries,
    netWorth, spendingByCategory, spendTotal,
    incomeProfile, scoreForecast, median,
    debtFreePlan,
    weightedApr,
    debtProgress,
    compareOffer,
  };
}));
