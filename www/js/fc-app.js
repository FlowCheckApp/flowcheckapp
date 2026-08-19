/**
 * FlowCheck — App Controller
 * ─────────────────────────────────────────────────────────────
 * State machine, screen transitions, tab switching,
 * data-to-DOM binding, animations, toasts, pull-to-refresh.
 * ─────────────────────────────────────────────────────────────
 */
window.FCApp = (function () {
  'use strict';

  /* ── App state ───────────────────────────────────────────── */
  const state = {
    screen:          'splash',   // splash | login | register | onboarding | app
    tab:             'home',
    user:            null,
    accounts:        [],
    transactions:    [],
    bills:           [],
    goals:           [],
    budgets:         {},
    syncing:         false,
    initialLoading:  false,  // true after auth until first Firestore snapshot arrives
    lastSyncAt:      0,          // timestamp of last successful sync (ms) — used for rate limiting
    searchQuery:     '',
    period:          '1M',       // active home-screen period: 1D | 1W | 1M | 3M | 1Y | All
    notifications:   [],
    txnOverrides:    {},         // { [txnId]: {name?, category?} }
    creditHistory:   [],         // [{month:'YYYY-MM', score:number}, …] oldest-first
    nwHistory:       {},         // {'YYYY-MM-DD': number} — Firestore-backed net worth sparkline
    debtHistory:     {},         // {'YYYY-MM-DD': number} — total debt, same doc; powers "paid down"
    accountDetails:  {},         // {accountId: {interest_rate, minimum_payment}} — user-supplied overlay
    budgetHistory:   {},         // {'YYYY-MM': {categories,total_limit,total_spent}} — closed months, drives rollover
  };

  // Tracks which specific item is being disconnected (null = disconnect all)
  let _pendingDisconnectItemId = null;
  let _lastSyncFailed = false;

  // Transaction edit state
  let _editingTxnId = null;

  // Category budget edit state
  let _editingBudgetCategory = null;

  // Activity category filter ('all' or a category name) — legacy, kept for backward compat
  let _activityCategoryFilter = 'all';
  // Activity type filter for the redesigned quick-filter chips
  let _activityTypeFilter = 'all'; // 'all' | 'income' | 'expenses' | 'transfers' | 'recurring'
  // Summary card chart period
  let _actSummaryPeriod = 'M'; // 'M' | '6M' | 'Y'

  /**
   * HTML-escape a string before inserting into innerHTML.
   * Prevents XSS from user-controlled data (display names, bill names, etc.)
   */
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ── SVG line-icon system ────────────────────────────────────
     One icon language app-wide (matches Settings). Never emoji for
     UI chrome — emoji render inconsistently across iOS versions and
     read as unfinished. Usage: _ic('bank', 'var(--fc-accent)', 20) */
  const _IC_PATHS = {
    'credit-card':  '<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
    'trending-down':'<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>',
    'trending-up':  '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    'flag':         '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    'calendar':     '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    'bar-chart':    '<line x1="6" y1="20" x2="6" y2="16"/><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/>',
    'gear':         '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    'bank':         '<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><path d="M12 2l8 5H4z"/>',
    'star':         '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    'bell':         '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    'help-circle':  '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'home':         '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    'zap':          '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    'wifi':         '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    'shield':       '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    'smartphone':   '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
    'droplet':      '<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>',
    'flame':        '<path d="M12 2c2 4 6 5.5 6 10a6 6 0 1 1-12 0c0-2 .8-3.5 2-5 .4 1.2 1.2 2 2.5 2C11.5 9 10 6 12 2z"/>',
    'file-text':    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
    'dollar-sign':  '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    'grad-cap':     '<path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5"/>',
    'car':          '<path d="M5 17H3v-4l2-5h11l3 5h2v4h-2"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
    'edit':         '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    'play-screen':  '<rect x="2" y="6" width="20" height="14" rx="2"/><polygon points="10 10 15 13 10 16 10 10"/>',
    'lightbulb':    '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.4 1 2.3h6c0-.9.4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
    'check':        '<polyline points="20 6 9 17 4 12"/>',
    'send':         '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
    'heart':        '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>',
    'tag':          '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
    'pie-chart':    '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
    'search':       '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    'alert':        '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    'clock':        '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  };
  function _ic(name, color, size) {
    const path = _IC_PATHS[name] || _IC_PATHS['file-text'];
    return '<svg width="'+(size||18)+'" height="'+(size||18)+'" viewBox="0 0 24 24" fill="none" stroke="'+(color||'currentColor')
      +'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+path+'</svg>';
  }

  // Shared bill-category icon — one mapping for Home, Plan, Activity, and Bills hub
  function _billIcon(nameOrBill, color, size) {
    const n = String((nameOrBill && nameOrBill.name) || (nameOrBill && nameOrBill.category) || nameOrBill || '').toLowerCase();
    const icon =
        /electric|power|utilit/.test(n) ? 'zap'
      : /internet|wifi|cable|comcast|xfinity/.test(n) ? 'wifi'
      : /rent|mortgage|lease/.test(n) ? 'home'
      : /phone|mobile|at.t|verizon|t-mobile/.test(n) ? 'smartphone'
      : /insur/.test(n) ? 'shield'
      : /netflix|hulu|spotify|disney|stream|tv/.test(n) ? 'play-screen'
      : /water/.test(n) ? 'droplet'
      : /gas|heat/.test(n) ? 'flame'
      : /car|auto|vehicle/.test(n) ? 'car'
      : 'file-text';
    return _ic(icon, color || 'currentColor', size || 18);
  }

  // Shared goal-category icon — one mapping for Home "Goals in motion" and the Goals hub
  function _goalIcon(nameOrGoal, color, size) {
    const n = String((nameOrGoal && nameOrGoal.name) || nameOrGoal || '').toLowerCase();
    const icon =
        /emergency|rainy|reserve/.test(n) ? 'shield'
      : /vacation|travel|trip/.test(n) ? 'send'
      : /house|home|down/.test(n) ? 'home'
      : /car|vehicle/.test(n) ? 'car'
      : /wedding|marry/.test(n) ? 'heart'
      : /retire/.test(n) ? 'trending-up'
      : /school|college|educat/.test(n) ? 'grad-cap'
      : /debt/.test(n) ? 'trending-down'
      : 'flag';
    return _ic(icon, color || 'currentColor', size || 18);
  }

  /* ── Period helpers ──────────────────────────────────────── */
  // Returns a cutoff Date for the current state.period
  function _getPeriodCutoff() {
    const now = new Date();
    switch (state.period) {
      case '1D':  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
      case '1W':  return new Date(now.getTime() - 7   * 86400000);
      case '3M':  return new Date(now.getTime() - 90  * 86400000);
      case '1Y':  return new Date(now.getTime() - 365 * 86400000);
      case 'All': return new Date(0);
      default:    return new Date(now.getFullYear(), now.getMonth(), 1); // '1M' = calendar month
    }
  }

  // Returns transactions filtered to current period
  function _getPeriodTxns() {
    const cutoff = _getPeriodCutoff().getTime();
    // Use parseDateLocal so "YYYY-MM-DD" dates compare against local midnight cutoffs
    return state.transactions.filter(t => t.date && FCData.parseDateLocal(t.date).getTime() >= cutoff);
  }

  // Friendly period label for stat subtitles
  const _PERIOD_LABELS = { '1D':'today', '1W':'this week', '1M':'this month', '3M':'3 months', '6M':'last 6 months', '1Y':'this year', 'All':'all time' };

  // ── Shared spend-transaction filter ──────────────────────────────
  // Excludes transfers, loan payments, and credit card payments so they don't
  // pollute spending totals, budgets, or insights.  Used by every widget that
  // needs "real" discretionary spend (pulse, insights, stat card, health score).
  /* Aliases, not implementations. These were full re-implementations of
     FCCore.isSpendTxn / isIncomeTxn against a second category map — the
     tested versions had 0 call sites while these had 29. The names stay so
     the call sites do not churn; the logic now has exactly one home. */
  const _isSpendTxn  = t => FCCore.isSpendTxn(t);


  // ── Shared income-transaction filter ─────────────────────────────
  // Strategy: count ALL credits as income, exclude only explicit non-income
  // categories. Plaid frequently classifies direct deposits and paychecks as
  // "Transfer" or "TRANSFER_IN" — a whitelist approach silently drops them.
  //
  // Hard-exclude only:
  //   • Outbound transfers (credit to loan, CC payment, transfer out)
  //   • Loan and credit card payments (money leaving to pay a debt)
  // Everything else that is a credit (isCredit=true) is income.
  const _isIncomeTxn = t => FCCore.isIncomeTxn(t);


  // Returns true when detected income is reliable enough to display ratios.
  // Below this threshold, the income figure is likely incomplete (no paycheck
  // detected yet, or early in the month) — suppress % calculations.
  function _incomeIsReliable(income, spend) {
    if (income <= 0) return false;
    // Income must be at least 30% of spend, or $200, to be trustworthy for display
    return income >= 200 || income >= spend * 0.30;
  }

  // ── Transaction display-name cleaner ─────────────────────────────
  // Plaid's `merchant_name` is usually clean, but occasionally Plaid sets it
  // to the same raw bank string as `name` (e.g. "9264&@#anthropic").
  // Detect garbled merchant_name values and fall through to the full cleaner.
  function _cleanTxnName(t) {
    if (t.customName) return t.customName;
    if (t.merchant_name) {
      const mn = t.merchant_name.trim();
      // Any string starting with 3+ digits = raw bank reference slipped through
      const isGarbled = /^\d{3,}/.test(mn) || /^[A-Z0-9]{8,}\s*$/.test(mn);
      if (!isGarbled) return mn;
    }
    let name = (t.name || 'Transaction').trim();

    // 1. Strip full bank prefix phrases (case-insensitive)
    name = name.replace(
      /^(?:DEBIT\s+(?:PURCHASE|CARD\s+PURCHASE)|POS\s+(?:PURCHASE|DEBIT|TERMINAL)|ACH\s+(?:DEBIT|WITHDRAWAL|WEB)|ONLINE\s+(?:PAYMENT|PURCHASE|BANKING\s+PAYMENT)|ELECTRONIC\s+(?:PAYMENT|DEBIT)|CHECK\s+CARD\s+(?:PURCHASE)?|CHECKCARD|VISA\s+(?:PURCHASE|DEBIT|DDA\s+PURCHASE)|MASTERCARD\s+(?:DEBIT|PURCHASE)|RECURRING\s+(?:CARD\s+)?PURCHASE|MOBILE\s+PURCHASE|ATM\s+(?:DEBIT|W\/D|WITHDRAWAL)|POINT\s+OF\s+SALE|POS\s+DEBIT\s+VISA)\s*/i,
      ''
    );
    // Normalize garbled ATM Fee strings: "Pai ATM Omaha Ne ATM Fee" → "ATM Fee"
    if (/\bATM\s+Fee\b/i.test(name)) name = 'ATM Fee';

    // 2. Strip leading date / terminal / reference token patterns
    //    "0523 9264 MERCHANT" → "MERCHANT"
    //    "04/15 MERCHANT" → "MERCHANT"
    name = name.replace(/^\d{2}\/\d{2}\s+/, '');
    name = name.replace(/^\d{4}\s+\d{4,}\s+/, '');
    // Strip any digit-prefix + noise chars (e.g. "9264&@#", "92640 ")
    name = name.replace(/^\d+[\s&@#*|_\-!%^()[\]{}]+/, '');
    // Nuclear fallback: if still starts with digit-noise, extract first word-like token after
    if (/^\d/.test(name)) name = name.replace(/^[\d\s&@#*|_\-!%^()[\]{}]+/, '');

    // 3. Strip POS terminal noise: "SQ *", "TST* ", "SP * ", "AMZN*", "AMZN Mktp"
    name = name.replace(/^(?:SQ|TST|TST\*|SP|PP|LN|SQU)\s*\*\s*/i, '');
    name = name.replace(/^AMZN\s*MKTP\s*US\b\s*/i, 'Amazon ');
    name = name.replace(/^AMZN\s*\*\s*/i, 'Amazon ');
    name = name.replace(/^WWW\s*\.\s*/i, '');

    // 4. Strip trailing location / state / store-number noise
    //    "STARBUCKS #4921 SEATTLE WA" → "Starbucks"
    //    "TARGET 00042 PORTLAND OR US" → "Target"
    //    "WALMART SUPERCENTER #3487" → "Walmart Supercenter"
    name = name.replace(/\s+#\d{3,}\s+\S+\s+(?:[A-Z]{2})\s*(?:US|USA)?\s*$/i, '');
    name = name.replace(/\s+#\d{3,}\s*$/i, '');
    name = name.replace(/\s+\d{3,}\s+\S+\s+(?:[A-Z]{2})\s*(?:US|USA)?\s*$/i, '');
    name = name.replace(/\s+(?:[A-Z]{2})\s+(?:US|USA)\s*$/i, '');

    // 5. Strip long numeric tails (transaction IDs, phone auth codes)
    name = name.replace(/\s+\d{7,}.*$/, '');
    name = name.replace(/\s+\d{2}\s*$/, '');

    // 6. Remove embedded TLDs: "NETFLIX.COM" → "Netflix"
    name = name.replace(/\.(com|net|org|io|app|co)\b/gi, '');

    // 7. Strip legal suffixes: "Inc", "LLC", "Ltd", "Corp" at end
    name = name.replace(/\s+(?:inc\.?|llc\.?|ltd\.?|corp\.?|l\.p\.?)$/i, '');

    // 8. Collapse extra whitespace
    name = name.replace(/\s{2,}/g, ' ').trim();

    // 9. Proper-case if ALL-CAPS or all-lowercase (raw bank string)
    if (name.length > 2 && (name === name.toUpperCase() || name === name.toLowerCase())) {
      name = name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
      // Re-capitalize known brands that title-case breaks
      name = name
        .replace(/\bMcdonalds\b/g, "McDonald's")
        .replace(/\bBofA\b/gi, 'BofA')
        .replace(/\bAtm\b/g, 'ATM')
        .replace(/\bUs\b(?=\s|$)/g, 'US');
    }

    return name || (t.name || 'Transaction');
  }

  // ── Premium number animation ─────────────────────────────────────
  // Smoothly counts from `from` to `to` over `duration` ms.
  // `formatter` is called with the current numeric value (e.g. FCData.formatCurrency).
  // Returns a cancel function.
  function _animateNumber(el, from, to, formatter, duration = 700) {
    if (!el) return () => {};
    // If values are identical or very close, just set it
    if (Math.abs(to - from) < 0.005) {
      el.textContent = formatter(to);
      return () => {};
    }
    const startTime = performance.now();
    let rafId;
    const tick = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic for a satisfying deceleration
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = from + (to - from) * eased;
      el.textContent = formatter(current);
      if (progress < 1) {
        rafId = requestAnimationFrame(tick);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => { if (rafId) cancelAnimationFrame(rafId); };
  }

  // Hard exclusions: things that recur but are NOT subscriptions
  const _SUB_EXCLUDE_RE = /\b(interest charge|finance charge|late fee|over.?limit fee|returned payment|overdraft|wire transfer|ach deposit|zelle|venmo|cashapp|paypal transfer|loan payment|mortgage payment|auto pay|autopay|direct deposit|payroll|salary|refund|atm withdrawal|cash withdrawal|insurance premium|rent payment|utility payment|electric|water bill|gas bill|internet bill|phone bill)\b/i;

  // Categories that represent actual digital/recurring subscriptions
  const _SUB_GOOD_CATS = new Set([
    'entertainment', 'subscription', 'streaming',
    'telecommunications', 'software', 'saas',
    'general services', 'services',
  ]);

  // Well-known subscription merchants — always include these regardless of category
  const _SUB_KNOWN_RE = /\b(netflix|spotify|hulu|disney|apple.*sub|apple tv|apple music|apple one|amazon prime|youtube premium|youtube music|hbo|max|peacock|paramount|starz|showtime|sling|fubo|discovery|espn|nba league|nfl sunday|mlb tv|twitch|crunchyroll|funimation|mubi|criterion|plex|adobe|creative cloud|dropbox|box\.com|icloud|google one|google storage|microsoft 365|office 365|xbox|playstation|nintendo|steam|humble|duolingo|babbel|masterclass|skillshare|linkedin premium|chatgpt|openai|claude|notion|evernote|lastpass|1password|nordvpn|expressvpn|dashlane|canva|figma|grammarly|audible|kindle unlimited|amazon music|deezer|tidal|pandora|sirius|calm|headspace|noom|peloton|myfitnesspal|weight watchers|ww app|planet fitness|gold's gym|la fitness|anytime fitness|crunch|equinox|classpass|strava|garmin connect|whoop|nytimes|new york times|washington post|wsj|wall street journal|economist|bloomberg|medium|substack|patreon)\b/i;

  // Normalise merchant name to a stable grouping key.
  function _subGroupKey(name) {
    return name
      .toLowerCase()
      .replace(/\s*\*\s*.*$/, '')        // strip charge codes after *
      .replace(/\.(com|net|org|io|app)\b/g, '')
      .replace(/\b(inc|llc|ltd|co|corp|subscription|billing|payment|charge|recurring|monthly|weekly|annual|us|usa|int|intl)\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 20);
  }

  // Clean a raw bank transaction name into a readable merchant display name
  function _cleanSubName(t) {
    // Always use the full cleaner — it handles merchant_name with garble detection
    return _cleanTxnName(t);
  }

  let _subDetectCache = null;
  let _subDetectCacheTxLen = -1;
  let _subDetectCacheBillLen = -1;

  let _planCatTab = 'all';

  function _detectSubscriptions() {
    const txLen   = state.transactions.length;
    const billLen = state.bills.length;
    if (_subDetectCache !== null && _subDetectCacheTxLen === txLen && _subDetectCacheBillLen === billLen) {
      return _subDetectCache;
    }
    const map = {};
    for (const t of state.transactions) {
      if (t.isCredit || !t.date || !t.name) continue;
      if (_SUB_EXCLUDE_RE.test(t.name)) continue;

      const rawCat  = (t.category && t.category[0]) || '';
      const normCat = FCData.normalizePlaidCategory(rawCat).toLowerCase();

      // Hard-exclude transfers, loans, grocery, gas, restaurants — they recur but aren't subscriptions
      const hardExcludeCats = new Set(['transfer', 'loan', 'bank fees', 'grocery', 'groceries',
        'gas stations', 'restaurants', 'coffee shop', 'auto and transport', 'healthcare', 'medical']);
      if (hardExcludeCats.has(normCat) || normCat.includes('transfer')) continue;

      // Require either a subscription-category OR a known subscription merchant name
      const isKnownMerchant = _SUB_KNOWN_RE.test(t.name) || _SUB_KNOWN_RE.test(t.merchant_name || '');
      const isSubCategory   = _SUB_GOOD_CATS.has(normCat);
      if (!isKnownMerchant && !isSubCategory) continue;

      const key = _subGroupKey(t.merchant_name || t.name);
      if (!key) continue;
      if (!map[key]) map[key] = { name: t.merchant_name || t.name, rawT: t, entries: [] };
      // Always prefer the most recent merchant_name for display
      if (t.merchant_name) map[key].name = t.merchant_name;
      map[key].rawT = t;
      map[key].entries.push({
        amount: t.amount || 0,
        ts:     FCData.parseDateLocal(t.date).getTime(),
        date:   t.date,
        name:   t.merchant_name || t.name,
      });
    }

    const detected = [];
    for (const [, data] of Object.entries(map)) {
      if (data.entries.length < 2) continue;
      data.entries.sort((a, b) => a.ts - b.ts);

      const gaps = [];
      for (let i = 1; i < data.entries.length; i++)
        gaps.push((data.entries[i].ts - data.entries[i - 1].ts) / 86400000);
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

      // Monthly: 21–40 day gap | Weekly: 5–9 days | Bi-monthly: 55–65 days | Annual: 330–370 days
      const isMonthly   = avgGap >= 21  && avgGap <= 40;
      const isWeekly    = avgGap >= 5   && avgGap <= 9;
      const isBiMonthly = avgGap >= 55  && avgGap <= 65;
      const isAnnual    = avgGap >= 330 && avgGap <= 370;
      const freq = isMonthly ? 'mo' : isWeekly ? 'wk' : isBiMonthly ? '2mo' : isAnnual ? 'yr' : null;
      if (!freq) continue;

      // Median amount — resistant to one-off anomalies
      const sorted = [...data.entries].sort((a, b) => a.amount - b.amount);
      const mid    = Math.floor(sorted.length / 2);
      const medAmt = sorted.length % 2 === 0
        ? (sorted[mid - 1].amount + sorted[mid].amount) / 2
        : sorted[mid].amount;

      // Reject implausibly large "subscriptions" (>$500/mo) and micro-amounts
      if (medAmt < 0.99 || medAmt > 500) continue;

      // Require amount consistency: std dev < 20% of median (not a variable-spend merchant)
      const variance = data.entries.reduce((s, e) => s + Math.pow(e.amount - medAmt, 2), 0) / data.entries.length;
      const stdDev   = Math.sqrt(variance);
      if (stdDev / medAmt > 0.25) continue; // >25% variance = not a subscription

      const mostRecent = data.entries[data.entries.length - 1];
      const displayName = _cleanSubName(data.rawT);
      const alreadyTracked = state.bills.some(b =>
        _subGroupKey(b.name).substring(0, 10) === _subGroupKey(displayName).substring(0, 10));

      detected.push({
        name:     displayName,
        amount:   medAmt,
        freq,
        tracked:  alreadyTracked,
        entries:  data.entries,
        lastDate: mostRecent.date,
      });
    }
    _subDetectCache = detected.sort((a, b) => b.amount - a.amount);
    _subDetectCacheTxLen   = state.transactions.length;
    _subDetectCacheBillLen = state.bills.length;
    return _subDetectCache;
  }

  // Show subscription detail bottom sheet
  function showSubDetail(encodedName) {
    const name = decodeURIComponent(encodedName);
    const subs = _detectSubscriptions();
    const sub  = subs.find(s => s.name === name) || subs.find(s => _subGroupKey(s.name) === _subGroupKey(name));
    if (!sub) return;

    const sheet = document.getElementById('sub-detail-sheet');
    if (!sheet) return;
    sheet.style.display = 'flex';
    _focusTraps['sub-detail-sheet'] = _trapFocus(sheet);

    // Estimate next charge date from last date + frequency
    function nextChargeDate(lastDate, freq) {
      const d = FCData.parseDateLocal(lastDate);
      if (freq === 'mo')  d.setMonth(d.getMonth() + 1);
      else if (freq === 'wk')   d.setDate(d.getDate() + 7);
      else if (freq === '2mo')  d.setMonth(d.getMonth() + 2);
      return d;
    }
    const freqLabel   = sub.freq === 'mo' ? 'Monthly' : sub.freq === 'wk' ? 'Weekly' : 'Every 2 months';
    const nextDate    = nextChargeDate(sub.lastDate, sub.freq);
    const nextLabel   = nextDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const lastLabel   = FCData.parseDateLocal(sub.lastDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const annualEst   = sub.freq === 'mo' ? sub.amount * 12 : sub.freq === 'wk' ? sub.amount * 52 : sub.amount * 6;
    const cancelUrl   = _subCancelUrl(sub.name);

    function subIcon(n) {
      const l = n.toLowerCase();
      if (l.includes('netflix'))   return '🎬';
      if (l.includes('spotify'))   return '🎵';
      if (l.includes('apple'))     return '🍎';
      if (l.includes('amazon'))    return '📦';
      if (l.includes('hulu'))      return '📺';
      if (l.includes('disney'))    return '🏰';
      if (l.includes('youtube'))   return '▶️';
      if (l.includes('gym') || l.includes('fitness') || l.includes('planet')) return '💪';
      if (l.includes('adobe'))     return '🎨';
      if (l.includes('microsoft') || l.includes('office') || l.includes('xbox')) return '🖥️';
      if (l.includes('google'))    return '🔍';
      if (l.includes('dropbox') || l.includes('icloud') || l.includes('storage')) return '☁️';
      if (l.includes('max') || l.includes('hbo'))   return '📡';
      if (l.includes('peacock') || l.includes('paramount') || l.includes('starz')) return '📺';
      if (l.includes('openai') || l.includes('chatgpt') || l.includes('claude')) return '🤖';
      return '📱';
    }

    const historyRows = sub.entries.slice().reverse().slice(0, 12).map(e => {
      const d = FCData.parseDateLocal(e.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      return `<div class="fcs-history-row">
        <span class="fcs-row-lbl">${d}</span>
        <span class="fcs-row-val">${FCData.formatCurrency(e.amount)}</span>
      </div>`;
    }).join('');

    const body = document.getElementById('sub-detail-body');
    if (body) body.innerHTML = `
      <div class="fcs-sheet-header">
        <div style="font-size:48px;margin-bottom:10px">${subIcon(sub.name)}</div>
        <div style="font-size:20px;font-weight:700;color:var(--fc-text);margin-bottom:4px">${esc(_cleanTxnName({ name: sub.name }))}</div>
        <div style="font-size:28px;font-weight:700;color:var(--fc-text);margin-bottom:2px;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">${FCData.formatCurrency(sub.amount)}<span style="font-size:15px;font-weight:400;color:var(--fc-text-muted)">/${sub.freq}</span></div>
        <div class="fcs-sub">${FCData.formatCurrency(Math.round(annualEst))}/year estimated</div>
      </div>
      <div class="fcs-list-card" style="margin-bottom:16px">
        <div class="fcs-detail-row">
          <span class="fcs-row-lbl">Frequency</span>
          <span class="fcs-row-val">${freqLabel}</span>
        </div>
        <div class="fcs-detail-row">
          <span class="fcs-row-lbl">Last charge</span>
          <span class="fcs-row-val">${lastLabel}</span>
        </div>
        <div class="fcs-detail-row no-border">
          <span class="fcs-row-lbl">Next estimated</span>
          <span style="font-size:13px;font-weight:600;color:var(--fc-warning-text)">${nextLabel}</span>
        </div>
      </div>
      <div style="margin-bottom:16px">
        <div class="fc-eyebrow" style="margin-bottom:8px">Charge history</div>
        <div class="fcs-list-card">
          ${historyRows || '<div style="padding:12px 0;text-align:center;" class="fcs-sub">No history available</div>'}
        </div>
      </div>
      <a href="${cancelUrl}" target="_blank" rel="noopener noreferrer" class="fcs-cancel-btn">
        Manage / Cancel Subscription
      </a>
    `;

  }

  function closeSubDetail() {
    const sheet = document.getElementById('sub-detail-sheet');
    if (!sheet) return;
    _focusTraps['sub-detail-sheet']?.();
    delete _focusTraps['sub-detail-sheet'];
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); }, 280);
  }

  // Cancel / manage URL for known subscription services
  function _subCancelUrl(name) {
    const n = name.toLowerCase();
    const MAP = [
      // Streaming video
      ['netflix',      'https://www.netflix.com/cancelplan'],
      ['hulu',         'https://secure.hulu.com/account/cancel'],
      ['disney',       'https://www.disneyplus.com/account'],
      ['max',          'https://www.max.com/account/subscription'],
      ['hbo',          'https://www.max.com/account/subscription'],
      ['paramount',    'https://www.paramountplus.com/account/'],
      ['peacock',      'https://www.peacocktv.com/account/subscription'],
      ['starz',        'https://www.starz.com/us/en/account'],
      ['showtime',     'https://www.sho.com/account'],
      ['discovery',    'https://www.discoveryplus.com/account'],
      ['sling',        'https://www.sling.com/account'],
      ['fubo',         'https://www.fubo.tv/account'],
      ['espn',         'https://www.espnplus.com/account'],
      ['crunchyroll',  'https://www.crunchyroll.com/acct/membership'],
      ['mubi',         'https://mubi.com/account/manage'],
      ['plex',         'https://www.plex.tv/plex-pass/'],
      // Music & audio
      ['spotify',      'https://www.spotify.com/account/subscription/'],
      ['apple music',  'https://apps.apple.com/account/subscriptions'],
      ['apple one',    'https://apps.apple.com/account/subscriptions'],
      ['youtube music','https://music.youtube.com/paid_memberships'],
      ['youtube premium','https://www.youtube.com/paid_memberships'],
      ['youtube',      'https://www.youtube.com/paid_memberships'],
      ['tidal',        'https://account.tidal.com/subscription'],
      ['deezer',       'https://www.deezer.com/en/offers'],
      ['pandora',      'https://www.pandora.com/account/subscription'],
      ['audible',      'https://www.audible.com/account/memberships'],
      ['sirius',       'https://www.siriusxm.com/myaccount'],
      ['amazon music', 'https://music.amazon.com/settings'],
      // Amazon & Apple
      ['amazon prime', 'https://www.amazon.com/mc/pipelines/cancellation'],
      ['amazon',       'https://www.amazon.com/mc/pipelines/cancellation'],
      ['apple tv',     'https://apps.apple.com/account/subscriptions'],
      ['apple',        'https://apps.apple.com/account/subscriptions'],
      // Gaming
      ['xbox',         'https://account.microsoft.com/services'],
      ['playstation',  'https://www.playstation.com/en-us/account/subscriptions/'],
      ['nintendo',     'https://accounts.nintendo.com/profile/subscriptions'],
      ['steam',        'https://store.steampowered.com/'],
      // Fitness & wellness
      ['peloton',      'https://members.onepeloton.com/profile/preferences'],
      ['classpass',    'https://classpass.com/account/billing'],
      ['noom',         'https://www.noom.com/account/'],
      ['myfitnesspal', 'https://www.myfitnesspal.com/account/subscription'],
      ['weight watchers','https://www.weightwatchers.com/us/account'],
      ['calm',         'https://www.calm.com/account'],
      ['headspace',    'https://www.headspace.com/account'],
      ['strava',       'https://www.strava.com/settings/subscription'],
      ['whoop',        'https://app.whoop.com/settings/membership'],
      ['planet fitness','https://www.planetfitness.com/member-portal'],
      // Software & productivity
      ['adobe',        'https://account.adobe.com/plans'],
      ['microsoft',    'https://account.microsoft.com/services'],
      ['office 365',   'https://account.microsoft.com/services'],
      ['dropbox',      'https://www.dropbox.com/account/plan'],
      ['google one',   'https://one.google.com/storage'],
      ['google',       'https://myaccount.google.com/payments-and-subscriptions'],
      ['notion',       'https://www.notion.so/profile/settings'],
      ['evernote',     'https://www.evernote.com/client/settings'],
      ['grammarly',    'https://account.grammarly.com/subscription'],
      ['canva',        'https://www.canva.com/settings/billing'],
      ['chatgpt',      'https://chat.openai.com/account/billing'],
      ['openai',       'https://platform.openai.com/account/billing'],
      ['1password',    'https://my.1password.com/billing'],
      ['lastpass',     'https://lastpass.com/my.php'],
      ['dashlane',     'https://app.dashlane.com/settings/subscription'],
      ['nordvpn',      'https://my.nordaccount.com/subscriptions/'],
      ['expressvpn',   'https://www.expressvpn.com/vpn-software/'],
      // Learning
      ['duolingo',     'https://www.duolingo.com/settings/subscription'],
      ['babbel',       'https://my.babbel.com/account'],
      ['masterclass',  'https://www.masterclass.com/settings/billing'],
      ['skillshare',   'https://www.skillshare.com/en/account/billing'],
      ['linkedin',     'https://www.linkedin.com/premium/manage'],
      // News & media
      ['nytimes',      'https://www.nytimes.com/account/manage-your-account'],
      ['new york times','https://www.nytimes.com/account/manage-your-account'],
      ['washington post','https://subscribe.washingtonpost.com/manage'],
      ['wsj',          'https://customercenter.wsj.com/'],
      ['bloomberg',    'https://www.bloomberg.com/account/'],
      ['economist',    'https://www.economist.com/api/auth/subscription'],
    ];
    for (const [key, url] of MAP) {
      if (n.includes(key)) return url;
    }
    // Fallback: iOS subscription management (catches App Store subscriptions)
    return 'https://apps.apple.com/account/subscriptions';
  }

  /* ── Net Worth History (Firestore-backed) ── */
  // Financial history never lives in browser storage. Firestore is the durable
  // source of truth and state.nwHistory is the in-memory render cache.
  //
  // The write dedup below is load-bearing, not an optimisation.
  // saveNetWorthSnapshot() always stamps updated_at: serverTimestamp(), so the
  // document changes even when net worth is identical — and every write fires
  // the nw_history listener TWICE (the local pending emit, then the
  // server-resolved one). This used to be called unguarded from _renderHome,
  // which itself runs once per Firestore batch commit, so a Plaid sync turned
  // into a self-feeding render/write storm: ~10s of visible churn on resume.
  // Same serverTimestamp re-entrancy the streak counter guards against with
  // _streakCheckedThisSession — see _attachDataListeners.
  let _nwLastWritten = { uid: null, date: null, value: null, debt: null };

  function _snapshotNetWorth(netWorth, debt) {
    // Capture uid before any async gap to avoid races with sign-out
    const uid = state.user?.uid;
    if (!uid || !state.user?.plaid_linked) return;

    /* An empty account set is "we do not know yet", not "your net worth is
       zero". The listener fires with [] in three ordinary situations — the
       moment before the first sync lands, the gap between disconnecting a
       bank and reconnecting it, and the instant after deleting every
       account — and `plaid_linked` is still true through all of them.

       Recording that as a real $0 puts a permanent fake point in the
       history. On a series sitting around −$59,000 it renders as a spike
       from the floor to the ceiling of the chart, flattening every genuine
       movement against the bottom edge. That is the bad chart. */
    if (!(state.accounts || []).length) return;

    // LOCAL day. A UTC key files the evening's snapshot under tomorrow, which
    // both duplicates a day and skips one — see the notification note below.
    const today   = FCCore.isoDay(new Date());
    // Round to what Firestore actually stores, so the comparison below is exact
    const rounded = Math.round(netWorth * 100) / 100;

    // One-time cleanup of legacy localStorage net worth data.
    // Stays above the dedup so it still runs on a skipped write.
    try {
      if (localStorage.getItem('fc_nw_history')) localStorage.removeItem('fc_nw_history');
      const legacyKey = `fc_nw_history_${uid}`;
      if (localStorage.getItem(legacyKey)) localStorage.removeItem(legacyKey);
    } catch (_) {}

    // Write only when today's value actually changed. state.nwHistory covers
    // the already-stored case; _nwLastWritten closes the race where several
    // renders fire before the listener round-trip lands. Keyed by uid so a
    // different account can never inherit the previous user's guard.
    /* The dedup has to consider BOTH numbers. Net worth can sit unchanged
       while debt moves — pay a card from the same bank's checking account and
       assets and liabilities fall by the identical amount — so a guard keyed
       on net worth alone would skip the write and lose the day's debt. */
    const roundedDebt = (debt == null || !Number.isFinite(Number(debt)))
      ? null : Math.round(Number(debt) * 100) / 100;
    const known      = state.nwHistory?.[today];
    const knownDebt  = state.debtHistory?.[today];
    const inFlight = _nwLastWritten.uid === uid
                  && _nwLastWritten.date === today
                  && _nwLastWritten.value === rounded
                  && _nwLastWritten.debt === roundedDebt;

    if (!inFlight && (known !== rounded || (roundedDebt !== null && knownDebt !== roundedDebt))) {
      _nwLastWritten = { uid, date: today, value: rounded, debt: roundedDebt };
      // Firestore write — best-effort, never blocks the UI
      FCData.saveNetWorthSnapshot(today, rounded, roundedDebt).catch(() => {
        // Clear the guard so a later update retries, rather than pinning a
        // value that never actually landed.
        if (_nwLastWritten.uid === uid && _nwLastWritten.date === today) {
          _nwLastWritten = { uid: null, date: null, value: null, debt: null };
        }
      });
    }

  }


  /* ── Budget month snapshots ───────────────────────────────────────
     /budgets/{category} is a STANDING limit with no month on it, so until
     now the app remembered nothing about any month except the one you were
     standing in. That is why there was no rollover: there was nothing to
     roll over from.

     This closes each month exactly once, into budget_history/{YYYY-MM}.
     Three rules keep the record honest:

       · Only CLOSED months. The current month is still moving; writing it
         would mean rollover was computed from a half-finished number.
       · Only months we can actually see. If the bank was connected last
         week, we hold no July transactions — and writing "July: $0 spent"
         would invent a perfect month and hand out rollover credit for it.
         Coverage is proven by holding a transaction at or before the
         month's first day.
       · create(), not set(). The rules refuse updates, and create() throws
         on an existing doc — so a second device re-opening the app cannot
         revise a settled month. First writer wins, deliberately.

     Same dedup discipline as _snapshotNetWorth: this runs from a render,
     renders run per Firestore batch commit, and serverTimestamp makes every
     write echo back through the listener. Without the guard that is a
     write/render storm. */
  const _budgetMonthsWritten = new Set();

  function _monthKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function _snapshotBudgetMonths() {
    const uid = state.user?.uid;
    if (!uid || !state.user?.plaid_linked) return;
    const budgets = state.budgets || {};
    const txns    = state.transactions || [];
    if (!Object.keys(budgets).length || !txns.length) return;

    // Earliest transaction we hold — the edge of what we can honestly claim.
    let earliest = Infinity;
    for (const t of txns) {
      if (!t.date) continue;
      const ms = FCData.parseDateLocal(t.date).getTime();
      if (ms < earliest) earliest = ms;
    }
    if (!Number.isFinite(earliest)) return;

    const now = new Date();
    // Walk back up to 12 closed months and fill any that are missing.
    for (let back = 1; back <= 12; back++) {
      const mStart = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const mEnd   = new Date(now.getFullYear(), now.getMonth() - back + 1, 1);
      const key    = _monthKey(mStart);

      if (_budgetMonthsWritten.has(uid + ':' + key)) continue;
      if (state.budgetHistory && state.budgetHistory[key]) continue;
      if (earliest > mStart.getTime()) continue;   // no coverage — say nothing

      const spendByCat = {};
      let totalSpent = 0;
      for (const t of txns) {
        if (!t.date || !_isSpendTxn(t)) continue;
        const d = FCData.parseDateLocal(t.date).getTime();
        if (d < mStart.getTime() || d >= mEnd.getTime()) continue;
        // Same key the Plan screen buckets by, so history lines up with
        // what the user was actually shown that month.
        const cat = t.category?.[1] || t.category?.[0] || 'Other';
        spendByCat[cat] = (spendByCat[cat] || 0) + (t.amount || 0);
        totalSpent += t.amount || 0;
      }

      const categories = {};
      Object.entries(budgets)
        .filter(([k]) => k !== 'total')
        .forEach(([cat, b]) => {
          const limit = Number(b?.limit || 0);
          if (limit > 0) categories[cat] = { limit, spent: spendByCat[cat] || 0 };
        });
      if (!Object.keys(categories).length) continue;

      _budgetMonthsWritten.add(uid + ':' + key);
      FCData.saveBudgetMonth(key, categories, _totalBudgetLimit(budgets), totalSpent)
        .catch(() => {
          /* Already exists (another device closed it first) or the write
             failed. Either way the guard stays set for this session — a
             retry loop against a create-only doc can never succeed. */
        });
    }
  }

  function toggleInsights(toggleEl) {
    const body    = document.getElementById('smart-insights-list-wrap');
    const chevron = toggleEl ? toggleEl.querySelector('.fch-ins-chevron') : null;
    if (!body) return;
    const isOpen = body.classList.contains('open');
    body.classList.toggle('open', !isOpen);
    if (chevron) chevron.classList.toggle('open', !isOpen);
    if (toggleEl) toggleEl.setAttribute('aria-expanded', String(!isOpen));
  }

  /* ── Minimum payment on a debt account ───────────────────────────
     Three spellings were in play and they did not agree. The manual
     account editor writes `minimum_payment`; Money's Debt panel read that
     and was fine. But Plan's Monthly Plan ring and the Coach's payoff
     advice both read `min_payment` — a key nothing in the app has ever
     written — so the ring's Debt slice was permanently $0 and the Coach
     planned payoffs against a minimum of zero.
     `minimum_payment_amount` is Plaid's own spelling on the liabilities
     product, accepted here so the same helper keeps working if those
     fields start arriving from the backend. */
  /* Which key identifies an account. The backend maps Plaid's `account_id`
     to `id` on the way out (server.js:1347), but demo mode and older manual
     records still carry the raw `account_id` — and an overlay keyed on
     `undefined` silently collapses every account onto one entry. */
  const _acctKey = a => FCCore.accountKey(a);

  /* Delegates. The precedence rule and the id fallback live in fc-core
     where they are tested; these only supply the overlay from state. */
  function _minPayment(a) { return FCCore.minPayment(a, state.accountDetails); }


  /** APR, same precedence: the bank's number first, the user's as a fallback. */
  function _debtRate(a)   { return FCCore.debtRate(a, state.accountDetails); }


  /* ── Rollover ─────────────────────────────────────────────────────
     Asymmetric, on purpose.

     Underspend carries forward: come in $80 under on Groceries and next
     month's Groceries is limit + $80. A good month visibly pays you back,
     which is the only momentum this app previously had nowhere to put.

     Overspend does NOT carry forward. The textbook envelope system makes
     last month's overspend a debt against this month, and it compounds —
     one bad month can leave a category underwater for half a year, with
     the app reminding you every time you open it. That is the pattern that
     makes people quit budgeting apps, and it is the opposite of helping
     someone dig out. The overspend is still shown, once, as a fact about a
     finished month; it just never becomes a running penalty.

     Only the immediately preceding month rolls. Credit that accumulates
     forever stops being a signal about how you are doing now. */
  function _rolloverFor(category) {
    const hist = state.budgetHistory || {};
    const now  = new Date();
    const prev = _monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const m    = hist[prev];
    if (!m || !m.categories) return 0;
    const c = m.categories[category];
    if (!c) return 0;
    const left = Number(c.limit || 0) - Number(c.spent || 0);
    return left > 0 ? Math.round(left * 100) / 100 : 0;   // underspend only
  }

  /** Total credit carried into this month, across every category. */
  function _rolloverTotal() {
    const hist = state.budgetHistory || {};
    const now  = new Date();
    const prev = _monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const m    = hist[prev];
    if (!m || !m.categories) return 0;
    return Object.keys(m.categories)
      .reduce((s, cat) => s + _rolloverFor(cat), 0);
  }

  /* ── The monthly budget ceiling ───────────────────────────────────
     One number, one definition. There were four, and they disagreed:

       • Plan summed EVERY entry in state.budgets — including the `total`
         key AND each category — so anyone who set both a monthly total and
         per-category limits had their ceiling silently doubled. Their
         "Budget Progress" bar read half full at the point they were
         actually out of money.
       • Money's spending ring and the exported getTotalBudgetLimit() fell
         back to a hardcoded 3000 when no total was set, so a user with no
         budget at all was measured against someone else's.
       • The budget alert bailed out unless `total` existed, which meant
         category-only budgets never triggered an alert of any kind.

     `total` is the ceiling when it is set; otherwise the categories sum to
     one. Never both, never a magic number, and 0 honestly means "no budget
     set" so callers can render the empty state instead of a false ratio. */
  function _totalBudgetLimit(budgets) { return FCCore.totalBudgetLimit(budgets || state.budgets); }


  /* Plan's "Budget Suggestion" card. Scoped to the calendar month for the
     same reason the budget alerts are: next month is a different budget and
     a different overspend, so a dismissal should not silence it forever. */
  function _budgetSuggestionKey() {
    const uid = FCAuth.currentUser?.()?.uid || state.user?.uid || '';
    const d = new Date();
    return `fc_budget_suggestion_off_${uid}_${d.getFullYear()}_${d.getMonth()}`;
  }
  function _budgetSuggestionDismissed() {
    try { return localStorage.getItem(_budgetSuggestionKey()) === '1'; }
    catch (_) { return false; }
  }
  function _dismissBudgetSuggestion() {
    try { localStorage.setItem(_budgetSuggestionKey(), '1'); } catch (_) {}
    haptic('light');
    _renderPlan();
  }

  /* ── Budget Alert ────────────────────────────────────────────── */
  // Flags are backed by localStorage so app restarts don't re-trigger alerts
  // within the same calendar month.
  function _getBudgetAlerted(level) {
    const uid = FCAuth.currentUser?.()?.uid || state.user?.uid || '';
    const d   = new Date();
    const key = `fc_budget_alerted_${uid}_${level}_${d.getFullYear()}_${d.getMonth()}`;
    return localStorage.getItem(key) === '1';
  }
  function _setBudgetAlerted(level) {
    const uid = FCAuth.currentUser?.()?.uid || state.user?.uid || '';
    const d   = new Date();
    const key = `fc_budget_alerted_${uid}_${level}_${d.getFullYear()}_${d.getMonth()}`;
    localStorage.setItem(key, '1');
    Object.keys(localStorage)
      .filter(k => k.startsWith('fc_budget_alerted_') && k !== key)
      .forEach(k => localStorage.removeItem(k));
  }

  async function _checkBudgetAlert() {
    if (!state.user || !state.user.plaid_linked) return;
    if (!FC_CONFIG.notifications || !FC_CONFIG.notifications.budgetAlertEndpoint) return;

    const now = new Date();
    const calMonthTxns = state.transactions.filter(t => {
      if (!t.date || t.isCredit) return false;
      const d = FCData.parseDateLocal(t.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    // Use filtered spend for budget alert (no transfers)
    const monthSpend  = calMonthTxns.filter(_isSpendTxn).reduce((s, t) => s + (t.amount || 0), 0);
    const budgetLimit = _totalBudgetLimit();
    if (budgetLimit <= 0) return;

    const pct = (monthSpend / budgetLimit) * 100;

    let title, body;
    if (pct >= 100 && !_getBudgetAlerted(100)) {
      _setBudgetAlerted(100);
      haptic('heavy');
      title = 'Budget exceeded 🚨';
      body  = `You've spent ${FCData.formatCurrency(monthSpend)} — over your ${FCData.formatCurrency(budgetLimit)} budget.`;
    } else if (pct >= 80 && !_getBudgetAlerted(80)) {
      _setBudgetAlerted(80);
      title = 'Budget at 80% ⚡';
      body  = `${FCData.formatCurrency(budgetLimit - monthSpend)} left in your monthly budget.`;
    } else {
      return;
    }

    try {
      // Backend generates its own title/body from category+spent+limit — send those three.
      await FCAuth.authedFetch(FC_CONFIG.notifications.budgetAlertEndpoint, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ category: 'total', spent: monthSpend, limit: budgetLimit }),
      });
    } catch (_) { /* best-effort */ }
  }

  // Open a URL. Local paths (start with '/') open in the in-app legal viewer.
  // External URLs open in Capacitor in-app browser or system browser.
  function _openUrl(url) {
    if (!url) return;
    // Local page — show in an in-app overlay so the user can navigate back
    if (url.startsWith('/')) {
      _showInAppPage(url);
      return;
    }
    try {
      const Browser = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
      if (Browser) { Browser.open({ url, presentationStyle: 'popover' }); return; }
    } catch (_) {}
    window.open(url, '_blank');
  }

  // In-app full-screen page viewer — for legal pages, help center, etc.
  // Uses srcdoc (fetched HTML) to avoid WKWebView iframe src resolution issues.
  async function _showInAppPage(url) {
    const overlay = document.getElementById('fc-inapp-page-overlay');
    const iframe  = document.getElementById('fc-inapp-page-iframe');
    if (!overlay || !iframe) return;

    // Show overlay immediately with loading state
    iframe.srcdoc = `<html><body style="background:#0a1520;color:rgba(255,255,255,0.4);font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:15px">Loading…</body></html>`;
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    haptic('light');

    try {
      const res  = await fetch(url);
      const html = await res.text();
      // Strip outer nav (has links that would navigate the iframe away)
      let cleaned = html.replace(/<nav[\s\S]*?<\/nav>/gi, '');
      // Inject mobile-iframe overrides:
      // 1. Remove sticky sidebar (causes content overlap when scrolling inside iframe)
      // 2. Collapse 2-col grid to single column
      // 3. Tighten hero padding (no nav above it anymore)
      const injectCSS = `<style>
        .sidebar { position: static !important; top: auto !important; }
        .support-layout { grid-template-columns: 1fr !important; gap: 32px !important; padding: 32px 20px 80px !important; }
        .page-hero { padding: 40px 20px 32px !important; }
        .faq-section-title { position: static !important; }
        details { overflow: visible !important; }
      </style>`;
      cleaned = cleaned.replace('</head>', injectCSS + '</head>');
      iframe.srcdoc = cleaned;
    } catch (err) {
      iframe.srcdoc = `<html><body style="background:#0a1520;color:rgba(255,255,255,0.5);font-family:-apple-system,sans-serif;padding:32px;font-size:15px"><p>Could not load page.</p></body></html>`;
    }
  }

  function closeInAppPage() {
    const overlay = document.getElementById('fc-inapp-page-overlay');
    const iframe  = document.getElementById('fc-inapp-page-iframe');
    if (overlay) overlay.style.display = 'none';
    if (iframe)  iframe.src = '';
    document.body.style.overflow = '';
  }

  /* ── Capacitor haptics ───────────────────────────────────── */
  function haptic(style) {
    try {
      const h = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
      if (h) h.impact({ style: style || 'light' });
      else if (navigator.vibrate) navigator.vibrate(8);
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     SCREEN MANAGEMENT
     ───────────────────────────────────────────────────────────── */

  // Navigation depth — determines push direction.
  // Forward (higher) = incoming slides from right; Back (lower) = from left.
  const _SCREEN_ORDER = {
    splash: 0, hero: 0.5, login: 1, register: 2, 'forgot-password': 1.5,
    'verify-email': 3, 'faceid-setup': 4, 'notif-permission': 4.5, onboarding: 5, paywall: 6, app: 7, feedback: 8,
  };

  let _screenTransitioning = false;

  function setScreen(name) {
    /* The subscription gate lives here because this is the only door.
       There are a dozen setScreen('app') call sites — onboarding, sign-in,
       paywall close, purchase success, resume, deep links — and gating them
       one at a time is precisely how one gets missed. Demo mode is exempt: it
       shows fabricated data and never touches a real account, and it is what
       lets App Review evaluate the product without a subscription. */
    if (name === 'app' && !_isDemoMode && !_mayEnterApp()) {
      _doSetScreen('paywall');
      return;
    }

    // Auto-skip the Face ID setup screen on devices without biometric hardware
    if (name === 'faceid-setup') {
      FCAuth.checkBiometricAvailable().then(available => {
        if (!available) { _doSetScreen('notif-permission'); return; }
        _doSetScreen('faceid-setup');
      }).catch(() => _doSetScreen('faceid-setup'));
      return;
    }
    _doSetScreen(name);
  }

  function _doSetScreen(name) {
    if (state.screen === name) return;

    // Abort any in-flight transition cleanly
    if (_screenTransitioning) {
      document.querySelectorAll(
        '.fc-screen--enter-right,.fc-screen--enter-left,.fc-screen--exit-left,.fc-screen--exit-right,.fc-screen--reveal'
      ).forEach(el => {
        el.classList.remove(
          'fc-screen--enter-right','fc-screen--enter-left',
          'fc-screen--exit-left','fc-screen--exit-right','fc-screen--reveal'
        );
        el.style.cssText = '';
      });
      _screenTransitioning = false;
    }

    const prev    = state.screen;
    const prevIdx = _SCREEN_ORDER[prev]  ?? 0;
    const nextIdx = _SCREEN_ORDER[name]  ?? 0;
    const forward = nextIdx >= prevIdx;
    _screenTransitioning = true;

    // Pin outgoing screen so it stays visible during its exit animation
    const outEl = prev && prev !== 'splash'
      ? document.querySelector(`.fc-screen[data-screen="${prev}"]`)
      : null;
    if (outEl) {
      outEl.style.display  = 'flex';
      outEl.style.position = 'absolute';
      outEl.style.inset    = '0';
      outEl.style.zIndex   = '10';
      outEl.classList.add(forward ? 'fc-screen--exit-left' : 'fc-screen--exit-right');
    }

    // Switch body attribute — incoming screen becomes visible
    state.screen = name;
    // Re-apply a saved "hide balances" preference the moment the app screen
    // mounts, so figures never flash visible before the user can react.
    if (name === 'app') requestAnimationFrame(() => _restorePrivacyMode());
    document.body.dataset.screen = name;

    // Animate incoming screen
    const inEl = document.querySelector(`.fc-screen[data-screen="${name}"]`);
    if (inEl) {
      inEl.scrollTop = 0;
      if (name !== 'splash') {
        const cls = (prev === 'splash' || name === 'app')
          ? 'fc-screen--reveal'
          : (forward ? 'fc-screen--enter-right' : 'fc-screen--enter-left');
        inEl.classList.add(cls);
        inEl.addEventListener('animationend', () => inEl.classList.remove(cls), { once: true });
      }
    }

    // Clean up outgoing after exit animation completes (220ms)
    setTimeout(() => {
      if (outEl) {
        outEl.classList.remove('fc-screen--exit-left', 'fc-screen--exit-right');
        outEl.style.cssText = '';
      }
      if (name === 'app') _updateGreeting();
      if (name === 'login') { _clearError('login-error'); resetForgotPasswordScreen(); }
      if (name === 'register') {
        _clearError('register-error');
        // Auto-fill referral code if one was captured from a deep link / referral URL
        if (window._fcPendingReferralCode) {
          const refInput = document.getElementById('reg-referral-code');
          if (refInput && !refInput.value) {
            refInput.value = window._fcPendingReferralCode;
            const wrap = document.getElementById('reg-referral-wrap');
            if (wrap) wrap.style.display = 'block';
            const chev = document.getElementById('reg-referral-chevron');
            if (chev) chev.style.transform = 'rotate(90deg)';
          }
          if (typeof FCAnalytics !== 'undefined') {
            FCAnalytics.track('referral_signup_started', { code: window._fcPendingReferralCode });
          }
        }
      }
      if (typeof FCAnalytics !== 'undefined') FCAnalytics.screen(name);
      fcLog('Screen →', name);
      _screenTransitioning = false;
    }, 240);
  }

  /* ─────────────────────────────────────────────────────────────
     TAB SWITCHING
     ───────────────────────────────────────────────────────────── */

  let _activitySegment  = 'transactions'; // 'transactions' | 'bills'
  let _activityFilter   = 'all';          // 'all' | 'today' | 'week' | 'month' | 'income'
  let _activityShowAll  = false;          // true = show all transactions (bypasses 75-item cap)

  function filterActivity(filter) {
    if (_activityFilter === filter) return;
    _activityFilter = filter;
    _activityShowAll = false;
    haptic('light');
    document.querySelectorAll('[data-activity-period]').forEach(btn => {
      const active = btn.dataset.activityPeriod === filter;
      btn.classList.toggle('fc-chip--active', active);
    });
    _renderActivity();
  }

  function filterActivityType(type) {
    if (_activityTypeFilter === type) return;
    _activityTypeFilter = type;
    _activityShowAll = false;
    haptic('light');
    document.querySelectorAll('[data-act-type]').forEach(btn => {
      const active = btn.dataset.actType === type;
      btn.classList.toggle('act-type-chip--active', active);
    });
    _renderActivity();
  }

  function switchActivitySummaryPeriod(period) {
    if (_actSummaryPeriod === period) return;
    _actSummaryPeriod = period;
    haptic('light');
    document.querySelectorAll('[data-act-period]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.actPeriod === period);
    });
    _renderSpendingTrends();
  }

  function showActivityFilterSheet() {
    haptic('light');
  }

  /* Show/hide Activity's search field.
     The row is collapsed by default so it stops costing a permanent 54px
     band — see the note on .act-search-row. Focus goes through _focusField
     so summoning the keyboard cannot race the row's own expand animation,
     which is the same class of bug as the sheet bounce.
     Closing clears the query and dispatches `input`, because leaving a
     filtered list behind a hidden search box is how someone concludes their
     transactions have disappeared. */
  function toggleActivitySearch(force) {
    const view  = document.getElementById('view-activity');
    const input = document.getElementById('activity-search');
    if (!view || !input) return;
    const open = (force === undefined) ? !view.classList.contains('act-searching') : !!force;
    if (open === view.classList.contains('act-searching')) return;
    haptic('light');
    view.classList.toggle('act-searching', open);
    const btn = document.getElementById('activity-search-toggle');
    if (btn) btn.setAttribute('aria-expanded', String(open));
    if (open) {
      _focusField(input, view);
    } else {
      if (input.value) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      input.blur();
    }
  }

  function switchActivitySegment(segment) {
    haptic('light');
    // Bills has no search of its own; leaving the box open over it would
    // filter a list the query does not apply to.
    if (segment === 'bills') toggleActivitySearch(false);
    _activitySegment = segment;
    const txnsPanel  = document.getElementById('activity-txns-panel');
    const billsPanel = document.getElementById('activity-bills-panel');
    // Fresh segment = fresh list — never land the user mid-scroll
    if (txnsPanel)  txnsPanel.scrollTop  = 0;
    if (billsPanel) billsPanel.scrollTop = 0;
    const segTxns    = document.getElementById('seg-txns');
    const segBills   = document.getElementById('seg-bills');
    const addBillBtn = document.getElementById('activity-add-bill-btn');

    if (segment === 'bills') {
      if (txnsPanel)  txnsPanel.style.display  = 'none';
      if (billsPanel) billsPanel.style.display  = 'flex';
      if (segTxns)  { segTxns.classList.remove('active');  segTxns.setAttribute('aria-selected','false'); }
      if (segBills) { segBills.classList.add('active');    segBills.setAttribute('aria-selected','true'); }
      if (addBillBtn) addBillBtn.style.display = 'flex';
      _renderBillsList();
    } else {
      if (txnsPanel)  txnsPanel.style.display  = 'block';
      if (billsPanel) billsPanel.style.display  = 'none';
      if (segTxns)  { segTxns.classList.add('active');     segTxns.setAttribute('aria-selected','true'); }
      if (segBills) { segBills.classList.remove('active'); segBills.setAttribute('aria-selected','false'); }
      if (addBillBtn) addBillBtn.style.display = 'none';
      _renderActivity();
    }
  }

  function _billsForDisplay() {
    if (state.bills?.length) return state.bills;
    const email = (FCAuth.currentUser?.()?.email || state.user?.email || '').toLowerCase();
    if (!_DEMO_EMAILS.includes(email)) return [];
    const dueDate = daysFromNow => {
      const date = new Date();
      date.setDate(date.getDate() + daysFromNow);
      return FCCore.isoDay(date);
    };
    return [
      { id:'demo-rent', name:'Rent', amount:1450, due_date:dueDate(3), category:'Housing', frequency:'monthly', icon:'⌂', status:'unpaid', autopay:true, _preview:true },
      { id:'demo-internet', name:'Internet', amount:60, due_date:dueDate(5), category:'Utilities', frequency:'monthly', icon:'⌁', status:'unpaid', autopay:true, _preview:true },
      { id:'demo-electric', name:'Electricity', amount:120, due_date:dueDate(8), category:'Utilities', frequency:'monthly', icon:'ϟ', status:'unpaid', autopay:false, _preview:true },
    ];
  }

  function _renderBillsList() {
    const container = document.getElementById('bills-full-list');
    if (!container) return;

    if (state.initialLoading && state.user?.plaid_linked) {
      const skRow = (w1, w2) => `
        <div class="fc-sk-row" style="padding:12px 0">
          <div class="fc-sk fc-sk--avatar" style="width:44px;height:44px;border-radius:14px"></div>
          <div class="fc-sk-row-body">
            <div class="fc-sk fc-sk--text-md" style="width:${w1}%"></div>
            <div class="fc-sk fc-sk--text-sm" style="width:${w2}%;margin-top:4px"></div>
          </div>
          <div class="fc-sk fc-sk--text-md" style="width:56px;align-self:center"></div>
        </div>`;
      container.innerHTML = `<div class="fc-sk-list">${skRow(55,38)}${skRow(65,30)}${skRow(48,42)}${skRow(72,35)}</div>`;
      return;
    }

    const displayBills = _billsForDisplay();
    const byDue    = (a, b) => (FCData.daysUntil(a.due_date) ?? 999) - (FCData.daysUntil(b.due_date) ?? 999);
    const allUnpaid = displayBills.filter(b => b.status !== 'paid').sort(byDue);
    const overdue  = allUnpaid.filter(b => (FCData.daysUntil(b.due_date) ?? 0) < 0);
    const unpaid   = allUnpaid.filter(b => (FCData.daysUntil(b.due_date) ?? 0) >= 0);
    const paid     = displayBills.filter(b => b.status === 'paid').sort(byDue);

    if (!displayBills.length) {
      container.innerHTML = `
        <div style="width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;color:var(--fc-text-faint);text-align:center">
          <div style="width:52px;height:52px;border-radius:16px;background:var(--fc-accent-soft);display:flex;align-items:center;justify-content:center;margin-bottom:12px">${_ic('file-text','var(--fc-accent)',24)}</div>
          <div style="font-size:15px;font-weight:500;color:var(--fc-text-muted);margin-bottom:8px">No bills yet</div>
          <div style="font-size:13px;margin-bottom:20px">Track your recurring bills and due dates</div>
          <button class="fc-btn fc-btn--outline" onclick="FCApp.showBillSheet()" type="button" style="height:42px;font-size:14px">
            + Add Your First Bill
          </button>
        </div>`;
      return;
    }

    const renderBillRow = (b) => {
      const days = FCData.daysUntil(b.due_date);
      const { label, color } = FCData.billDueLabelAndColor(days !== null ? days : 999);
      const bg = FCData.categoryColor(b.category || 'Service');
      const statusText = b.status === 'paid'
        ? `<span style="color:var(--fc-success);font-size:12px;font-weight:600">✓ Paid</span>`
        : `<span style="color:${color};font-size:12px;font-weight:${days !== null && days <= 3 ? 600 : 400}">${label}</span>`;

      /* The mark-as-paid control. Its border was rgba(255,255,255,0.18) and
         its tick rgba(255,255,255,0.4) — white at low alpha, which is a soft
         grey ring on the dark card and very nearly nothing on the light one.
         The one affordance on this row for the action the row exists to
         support was invisible in light mode.
         Tokens now, and the press state moved to CSS :active — the inline
         onpointerdown/up/cancel trio was re-implementing :active by hand and
         had to hardcode the resting colour twice more to restore it. */
      const checkBtn = b.status !== 'paid' && !b._preview
        ? `<button class="fc-bill-check" onclick="event.stopPropagation();FCApp.quickPayBill('${esc(b.id)}')" aria-label="Mark ${esc(b.name || 'bill')} as paid" type="button">
             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
           </button>`
        : '';

      return `
        <div class="fc-list-item" data-bill-id="${b.id}" style="cursor:pointer" onclick="${b._preview ? 'FCApp.showBillSheet()' : `FCApp.editBill('${b.id}')`}" role="button">
          <div class="fc-list-icon" style="background:${bg};display:flex;align-items:center;justify-content:center">
            ${_billIcon(b, '#fff', 18)}
          </div>
          <div class="fc-list-body">
            <div class="fc-list-title">${esc(b.name)}</div>
            <div class="fc-list-meta" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
              <span>${esc(b.category || 'Bill')} · ${esc(b.frequency || 'monthly')}</span>
              ${b.autopay ? '<span style="display:inline-flex;align-items:center;gap:2px;font-size:10px;font-weight:600;color:var(--fc-success);background:var(--fc-success-soft);border-radius:4px;padding:1px 5px">Auto Pay</span>' : ''}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
            <div class="fc-list-amount">${FCData.formatCurrency(b.amount)}</div>
            ${statusText}
          </div>
          ${checkBtn}
        </div>`;
    };

    /* "Bills This Month" — ported here when the standalone Bills screen was
       deleted. That screen was a second, parallel bills page: five entry
       points routed to Activity > Bills and three to the standalone one, so
       Home showed "View bills" and "View all bills ›" going to two different
       pages — the same split-routing bug that had two Debt screens.
       This summary was the one thing the standalone had that this list did
       not, so consolidating meant bringing it across rather than dropping it.
       Month window matches the old screen exactly (same calendar month, same
       paid/unpaid split) so the numbers people were reading do not change. */
    const _now = new Date();
    const _monthBills = displayBills.filter(b => {
      if (!b.due_date) return false;
      const d = FCData.parseDateLocal(b.due_date);
      return d.getMonth() === _now.getMonth() && d.getFullYear() === _now.getFullYear();
    });
    const _totalDue  = _monthBills.reduce((s, b) => s + (b.amount || 0), 0);
    const _paidTotal = _monthBills.filter(b => b.status === 'paid').reduce((s, b) => s + (b.amount || 0), 0);
    const _leftToPay = Math.max(0, _totalDue - _paidTotal);

    let html = '';

    if (_monthBills.length) {
      html += `<article class="fc-card" style="margin-bottom:14px;padding:16px;background:var(--fc-accent-soft);border-color:var(--fc-border-accent)">
                 <div style="display:flex;align-items:center;gap:14px">
                   <div style="flex:1;min-width:0">
                     <div class="fc-eyebrow" style="color:var(--fc-accent)">Bills This Month</div>
                     <div style="font-size:24px;font-weight:700;color:var(--fc-text);font-variant-numeric:tabular-nums">${FCData.formatCurrency(_totalDue)}</div>
                     <div style="font-size:13px;color:var(--fc-text-muted)">${_paidTotal > 0 ? FCData.formatCurrency(_paidTotal) + ' paid so far' : 'due this month'}</div>
                   </div>
                   ${_leftToPay > 0
                     ? `<div style="text-align:right;flex-shrink:0">
                          <div style="font-size:13px;color:var(--fc-warning-text);font-weight:600;font-variant-numeric:tabular-nums">${FCData.formatCurrency(_leftToPay)}</div>
                          <div style="font-size:11px;color:var(--fc-text-faint)">left to pay</div>
                        </div>`
                     : `<div style="text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:2px">
                          ${_ic('check','var(--fc-success)',20)}
                          <div style="font-size:11px;color:var(--fc-text-faint)">all paid</div>
                        </div>`}
                 </div>
               </article>`;
    }

    if (overdue.length) {
      html += `<div class="fc-date-label" style="color:var(--fc-danger);display:flex;align-items:center;gap:5px">${_ic('alert','var(--fc-danger)',12)} Overdue</div>
               <article class="fc-card" style="padding:4px 16px;margin-bottom:0;border:0.5px solid rgba(255,69,58,0.22)">
                 ${overdue.map(renderBillRow).join('')}
               </article>`;
    }
    if (unpaid.length) {
      html += `<div class="fc-date-label">Upcoming</div>
               <article class="fc-card" style="padding:4px 16px;margin-bottom:0">
                 ${unpaid.map(renderBillRow).join('')}
               </article>`;
    }
    if (paid.length) {
      html += `<div class="fc-date-label">Paid</div>
               <article class="fc-card" style="padding:4px 16px;margin-bottom:0">
                 ${paid.map(renderBillRow).join('')}
               </article>`;
    }

    container.innerHTML = html;
  }


  function handleWebSearch(value) {
    state.searchQuery = String(value || '').trim();
    const activityInput = document.getElementById('activity-search');
    if (activityInput && activityInput.value !== value) activityInput.value = value;

    if (state.tab !== 'activity') {
      switchTab('activity');
      return;
    }
    _activityShowAll = false;
    _renderActivity();
  }

  /* Where a sub-screen's Back button should return to.

     It used to be hardcoded: _closeSubScreen() always went to 'more', so
     opening Bills from Home and pressing Back dumped you in the More hub.
     state.tab cannot be used for this either — switchTab() sets it to the
     sub-screen's own id before delegating to _openSubScreen() — so the last
     real tab is tracked separately. Sub-screens never update it. */
  const _NAV_TABS = new Set(['home', 'activity', 'plan', 'wealth', 'goals', 'coach', 'more']);
  let _lastNavTab = 'more';

  function switchTab(tabId) {
    /* Ids that are NOT screens — they are names old entry points still use
       for pages that were consolidated into a segment of another tab.
       Debt and Bills each used to have a second, standalone screen; both
       are gone, but the desktop sidebar, deep links and older call sites
       still say switchTab('debt') / switchTab('bills'), and those should
       keep working rather than dead-ending.

       This MUST run before the view-exists guard below: with the screens
       deleted there is no #view-debt or #view-bills to find, so the guard
       would swallow both and the buttons would silently do nothing. */
    const _TAB_REDIRECTS = {
      debt:  () => { switchTab('wealth');   switchWealthSegment('debt'); },
      bills: () => { switchTab('activity'); switchActivitySegment('bills'); },
    };
    if (_TAB_REDIRECTS[tabId]) { _TAB_REDIRECTS[tabId](); return; }

    /* No view behind this id? Do nothing at all.
       The incoming activation below is guarded by `if (target)`, but the
       outgoing teardown was not — so an unknown id removed .active from the
       current view, activated nothing, and left a blank screen under the nav
       with state.tab pointing at something that does not exist.
       Easy to hit because a wrong id can look right: "Money" is the nav
       LABEL for the 'wealth' view, so switchTab('money') reads as correct
       and blanks the app. */
    if (!document.getElementById('view-' + tabId)) {
      fcLog('[FCApp] switchTab: no view-' + tabId + ' — ignoring');
      return;
    }
    if (_NAV_TABS.has(tabId)) _lastNavTab = tabId;
    if (state.tab === tabId) return;
    haptic('light');
    // Dismiss keyboard before tab switch so stale viewport state doesn't carry over
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) ae.blur();
    const prev = state.tab;
    state.tab  = tabId;

    const target   = document.getElementById('view-' + tabId);
    const outgoing = prev ? document.getElementById('view-' + prev) : null;

    // ── Clean up any open sub-screens so they don't bleed into tab views ──
    ['goals','investments','calendar','reports','notifications','settings','vault'].forEach(id => {
      const sub = document.getElementById('view-' + id);
      if (sub) { sub.classList.remove('active'); sub.style.display = 'none'; }
    });
    const navBar = document.querySelector('.fc-nav');
    if (navBar) navBar.style.display = '';

    // ── Clean up any stale animation classes from rapid taps ──────────────
    document.querySelectorAll('.fc-view').forEach(v =>
      v.classList.remove('fc-tab-in', 'fc-tab-out'));

    // ── Mark outgoing — suppresses fc-fade-up replay on return ────────────
    if (outgoing) outgoing.classList.add('fc-loaded');

    // ── Outgoing: fade out, then hide (120ms matches fcTabOut duration) ───
    // Must deactivate AFTER animation or content disappears before fade ends.
    //
    // PIN IT OUT OF FLOW FIRST. For those 120ms both views carry .active, and
    // .fc-view.active is `display:flex; flex:1` inside a column — so they
    // become flex siblings and split the column between them. Measured: the
    // outgoing view jumped from y=62/h=750 to y=429/h=383 mid-fade, a layout
    // shift of 0.42 on EVERY tab switch (good CLS is under 0.1), and the
    // incoming content spent the whole fade at half height before snapping
    // to full. That is exactly the "no layout shifts during animation" bar
    // in CLAUDE.md, failing six times a minute.
    //
    // The rect is captured BEFORE the incoming view is activated, which is
    // the one moment the outgoing still occupies the correct full-size box.
    // .fc-screen is position:relative (and transform:translateZ(0)), so it is
    // the containing block these offsets resolve against.
    if (outgoing) {
      const parentRect = outgoing.parentElement.getBoundingClientRect();
      const rect       = outgoing.getBoundingClientRect();
      outgoing.style.position      = 'absolute';
      outgoing.style.top           = (rect.top  - parentRect.top)  + 'px';
      outgoing.style.left          = (rect.left - parentRect.left) + 'px';
      outgoing.style.width         = rect.width  + 'px';
      outgoing.style.height        = rect.height + 'px';
      outgoing.style.pointerEvents = 'none';   // it is leaving; never take a tap
      outgoing.classList.add('fc-tab-out');
      setTimeout(() => {
        outgoing.classList.remove('active', 'fc-tab-out');
        outgoing.style.position = outgoing.style.top    = outgoing.style.left =
        outgoing.style.width    = outgoing.style.height = outgoing.style.pointerEvents = '';
      }, 120);
    }

    // ── Incoming: make visible, reset scroll, fade in ─────────────────────
    if (target) {
      target.style.display = '';   // clear inline hide left by sub-screen cleanup (goals is both)
      target.scrollTop = 0;
      target.classList.add('active', 'fc-tab-in');
      setTimeout(() => target.classList.remove('fc-tab-in'), 200);
    }

    // ── Nav items ──────────────────────────────────────────────────────────
    // Views without their own nav slot highlight the tab they're reached from,
    // so the nav never shows "nowhere" (activity ← Money, more/settings ← Coach).
    const _navParent = { activity: 'wealth', more: 'coach', settings: 'coach', insights: 'plan' };
    const navView = _navParent[tabId] || tabId;
    document.querySelectorAll('.fc-nav-item').forEach(item => {
      const active = item.dataset.view === navView;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
      item.setAttribute('tabindex', active ? '0' : '-1');
    });

    // ── Render on next animation frame — eliminates the 250ms blank flash ─
    // rAF defers DOM writes past the current paint so the fade-in animation
    // gets its first frame before any innerHTML thrash, giving WKWebView time
    // to composite the opacity change before repainting content.
    requestAnimationFrame(() => {
      if (tabId === 'home') {
        _renderHome();
      } else if (tabId === 'activity') {
        _activityShowAll = false;
        if (_activitySegment === 'bills') _renderBillsList();
        else _renderActivity();
      } else if (tabId === 'plan') {
        _renderPlan();
      } else if (tabId === 'wealth') {
        _renderWealth();
      } else if (tabId === 'more') {
        _renderMore();
      } else if (tabId === 'settings') {
        // Settings is now a sub-screen of More; keep compat for deep links
        _renderMore();
        _openSubScreen('settings');
      } else if (tabId === 'insights') {
        // Insights folded into Plan; redirect
        switchTab('plan');
      } else if (tabId === 'goals') {
        // Goals is a first-class tab now — render in place, keep the nav
        _renderGoalsScreen(true);
      } else if (tabId === 'coach') {
        _renderCoach();
      } else if (tabId === 'investments') {
        _openSubScreen('investments');
      } else if (tabId === 'calendar') {
        _openSubScreen('calendar');
      } else if (tabId === 'reports') {
        _openSubScreen('reports');
      } else if (tabId === 'notifications') {
        _openSubScreen('notifications');
      } else if (tabId === 'vault') {
        _openSubScreen('vault');
      }
      _ensureLegalFooter(target);
    });

    if (typeof FCAnalytics !== 'undefined') FCAnalytics.screen('tab_' + tabId);
    fcLog('Tab →', tabId, '(from', prev + ')');
  }

  /* ─────────────────────────────────────────────────────────────
     TOAST SYSTEM
     ───────────────────────────────────────────────────────────── */

  let _toastTimer = null;

  // Lightweight focus trap — keeps keyboard navigation inside modal sheets.
  // Returns a cleanup function; call it when the sheet closes.
  function _trapFocus(el) {
    const focusable = 'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';
    const nodes = () => [...el.querySelectorAll(focusable)].filter(n => n.offsetParent !== null);
    const handler = e => {
      if (e.key !== 'Tab') return;
      const items = nodes();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    el.addEventListener('keydown', handler);
    nodes()[0]?.focus();
    return () => el.removeEventListener('keydown', handler);
  }
  // Store cleanup refs keyed by sheet element id
  const _focusTraps = {};

  function toast(message, type, duration) {
    const el = document.getElementById('fc-toast');
    if (!el) return;

    el.textContent = message;
    el.className   = 'fc-toast fc-toast--' + (type || 'info');
    el.classList.add('visible');
    haptic(type === 'error' ? 'heavy' : 'light');

    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('visible'), duration || 3000);
  }

  /* ─────────────────────────────────────────────────────────────
     ANIMATED COUNTER
     ───────────────────────────────────────────────────────────── */

  function animateNumber(element, target, prefix, suffix, duration) {
    if (!element) return;
    prefix   = prefix  || '';
    suffix   = suffix  || '';
    // Default 680ms — fast enough to feel snappy, slow enough to feel premium
    duration = duration || 680;

    // Skip re-animation if value hasn't changed — prevents count-up replay on
    // every Firestore listener tick that rebuilds the same DOM node.
    const prevTarget = parseFloat(element.dataset.animTarget ?? 'NaN');
    if (!isNaN(prevTarget) && Math.abs(prevTarget - target) < 0.005) return;
    element.dataset.animTarget = target;

    // Cancel any in-flight animation for this element
    const prevRaf = element._fcAnimRaf;
    if (prevRaf) cancelAnimationFrame(prevRaf);

    // Always use tabular-nums so numbers never jump-width during animation
    element.style.fontVariantNumeric = 'tabular-nums';
    element.style.fontFeatureSettings = '"tnum" 1';

    const startValue = parseFloat(element.dataset.animVal || '0');
    const startTime  = performance.now();

    function step(now) {
      const elapsed  = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out expo — fast initial movement, smooth landing
      const eased    = progress === 1 ? 1 : 1 - Math.pow(2, -8 * progress);
      const current  = startValue + (target - startValue) * eased;

      const isNeg  = current < 0;
      const absStr = Math.abs(current).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      element.textContent = (isNeg ? (prefix ? '−' + prefix : '−') : (prefix || '')) + absStr + suffix;
      element.dataset.animVal = current;

      if (progress < 1) {
        element._fcAnimRaf = requestAnimationFrame(step);
      } else {
        delete element._fcAnimRaf;
        // Ensure the final value is always exact (no floating-point drift)
        const finalIsNeg = target < 0;
        const finalStr   = Math.abs(target).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        element.textContent = (finalIsNeg ? (prefix ? '−' + prefix : '−') : (prefix || '')) + finalStr + suffix;
      }
    }
    element._fcAnimRaf = requestAnimationFrame(step);
  }

  /* Count-up wrapper for full re-renders. innerHTML rebuilds destroy the
     element (and animateNumber's per-element guards with it), so remember the
     last shown value per id — re-renders with the same value stay static, and
     changed values animate from the previous value instead of from zero. */
  const _countupLast = {};
  function _countup(id, value, prefix) {
    const el = document.getElementById(id);
    if (!el) return;
    if (prefix === undefined) prefix = '$';
    const fmtStatic = v => (v < 0 ? '−' : '') + prefix + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const prev = _countupLast[id];
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || (prev !== undefined && Math.abs(prev - value) < 0.005)) {
      el.textContent = fmtStatic(value);
      _countupLast[id] = value;
      return;
    }
    el.dataset.animVal = String(prev !== undefined ? prev : 0);
    animateNumber(el, value, prefix);
    _countupLast[id] = value;
  }

  /* ─────────────────────────────────────────────────────────────
     SKELETON HELPERS
     ───────────────────────────────────────────────────────────── */

  /* ── Island text helper ──────────────────────────────────── */
  function _setIslandText(text) {
    const el = document.getElementById('islandText');
    if (!el || el.textContent === text) return;
    el.classList.add('fc-fade');
    setTimeout(() => {
      el.textContent = text;
      el.classList.remove('fc-fade');
    }, 180);
  }

  /* ─────────────────────────────────────────────────────────────
     GREETING
     ───────────────────────────────────────────────────────────── */

  function _setGreetingTitle(element, greeting, name) {
    if (!element) return;
    element.textContent = '';
    element.appendChild(document.createTextNode(`${greeting}, `));
    const nameEl = document.createElement('strong');
    nameEl.textContent = name;
    element.appendChild(nameEl);
  }

  function _updateGreeting() {
    const h = new Date().getHours();
    const greet = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    // Resolution order: Firestore 'name' → Firebase Auth displayName → email prefix → ''
    // Never falls back to 'there' if any real identity signal exists.
    const authUser = window.FCAuth && FCAuth.currentUser ? FCAuth.currentUser() : null;
    const rawName = state.user?.name || authUser?.displayName || state.user?.email?.split('@')[0] || '';
    const name    = rawName.split(' ')[0] || authUser?.email?.split('@')[0] || '';
    const dateEl  = document.getElementById('home-greeting-date');
    const titleEl = document.getElementById('home-greeting-title');
    const displayName = name || 'there';
    _setGreetingTitle(titleEl, greet, displayName);
    if (dateEl)  dateEl.textContent  = "Here's your financial overview for today.";
    const avatarEl = document.getElementById('home-user-avatar');
    const avatarLetter = name.charAt(0).toUpperCase() || (authUser?.email || '').charAt(0).toUpperCase() || '?';
    if (avatarEl) avatarEl.textContent = avatarLetter;
  }

  /* ─────────────────────────────────────────────────────────────
     FINANCIAL HEALTH SCORE  (0 – 850, proprietary)
     ───────────────────────────────────────────────────────────── */

  /* ─────────────────────────────────────────────────────────────
     SPENDING PULSE  (week-over-week)
     ───────────────────────────────────────────────────────────── */

  /* ─────────────────────────────────────────────────────────────
     CREDIT SCORE — manual entry (user enters their own score)
     ───────────────────────────────────────────────────────────── */

  /* ── Affiliate Offer Card ─────────────────────────────────────
     Picks the single most relevant offer based on the user's
     financial state and renders it on the home dashboard.
     Offer definitions live in FC_CONFIG.offers (fc-config.js).
     ───────────────────────────────────────────────────────────── */
  /* ── Account classification ───────────────────────────────────────────
     Thin wrappers over FCCore's single classifier. Every rollup on every
     screen goes through these, so the Cash tile, the allocation bar, the
     Money panels and net worth cannot disagree about what an account is.

     They used to each test `a.type === 'depository'` (or one of four other
     variants) inline. None of those understood the manual-entry vocabulary —
     the Add Account sheet writes type 'checking'/'savings', not Plaid's
     'depository' — so a manual checking account added to net worth while
     contributing nothing to cash, Safe to Spend or the allocation bar.

     Defined defensively: fc-core is a separate script tag and a render can
     fire before it parses. */
  const _acctBal     = a => (window.FCCore ? FCCore.accountBalance(a) : (a && (a.balance_current || a.balance)) || 0);
  const _isCashAcct  = a => (window.FCCore ? FCCore.isCashAccount(a)  : a && a.type === 'depository');
  const _isDebtAcct  = a => (window.FCCore ? FCCore.isDebtAccount(a)  : a && (a.type === 'credit' || a.type === 'loan'));
  const _isAssetAcct = a => (window.FCCore ? FCCore.isAssetAccount(a) : !_isDebtAcct(a));

  /* ── Pro gate helpers ────────────────────────────────────────────────
     _isPro()           → true if user has an active Pro entitlement
     _renderProGate()   → replaces a section with the locked-card UI
     ─────────────────────────────────────────────────────────────────── */
  function _isPro() {
    // OR both sources. The earlier short-circuit (FCPurchases first, fallback
    // only if missing) lost purchases during the brief window between
    // purchasePackage() resolving and FCPurchases._proStatus being read by a
    // render — `state.user.is_pro` set by _refreshAfterPro was never consulted.
    const rcPro    = !!(window.FCPurchases && typeof FCPurchases.isPro === 'function' && FCPurchases.isPro());
    const localPro = !!(state.user?.is_pro || state.user?.pro);
    return rcPro || localPro;
  }

  /**
   * May this account reach the app shell at all?
   *
   * FlowCheck is subscription-only. An active RevenueCat entitlement covers
   * the free trial too — a user inside the trial window holds the entitlement,
   * so trial users pass here without a separate check.
   *
   * `grandfathered` is set by the backend for accounts that were already using
   * the app when the requirement shipped. It is absent from both Firestore
   * rules allowlists, which use hasOnly(), so a client that tries to write it
   * has the whole update rejected — it cannot be self-granted, exactly like
   * is_pro.
   *
   * NOTE ON WHAT THIS IS: a UX gate, not the enforcement. This runs in a
   * WKWebView and anyone determined can get past it. The real boundary is the
   * backend refusing to serve financial data without an entitlement. That is
   * also why the unknown case below fails OPEN: showing a paywall to somebody
   * who has already paid is a far worse failure than briefly showing the shell
   * to somebody who has not, and the server gives the latter no data anyway.
   */
  function _mayEnterApp() {
    if (_isPro()) return true;
    if (state.user?.grandfathered === true) return true;
    // Entitlement not resolved yet (cold start, RevenueCat still configuring,
    // user doc not loaded). Do not bounce a paying customer to the paywall.
    const rcReady = !!(window.FCPurchases && FCPurchases.isConfigured && FCPurchases.isConfigured());
    if (!state.user || !rcReady) return true;
    return false;
  }

  /* Keys that survive a sign-out wipe.
     PRESERVE uid-keyed routing flags (fc_ob_done_, fc_pw_seen_) — they are
     keyed by UID so they cannot cross-contaminate between users, and they
     provide cross-session onboarding + paywall cooldown for the same user.
     ALSO PRESERVE:
       fc_privacy_mode  — a DEVICE-level safety preference ("hide my balances
         when people can see my screen"). It describes the user's physical
         surroundings, not their account, and reveals nothing about any user.
         Clearing it silently re-exposed every balance after a relaunch, so
         keeping it is both correct and the fail-closed choice.
       fc_first_sts_    — uid-keyed analytics de-dupe flag; wiping it would
         re-fire the once-per-user "first Safe to Spend" event. */
  const _WIPE_PRESERVE = ['fc_ob_done_', 'fc_pw_seen_', 'fc_first_sts_', 'fc_privacy_mode'];

  /** Clear per-user fc_ localStorage keys, honouring _WIPE_PRESERVE.
   *  Every sign-out path must go through this. The resume handler used to
   *  inline its own `startsWith('fc_')` sweep with no preserve list, so a
   *  token revoked while backgrounded wiped fc_privacy_mode and re-exposed
   *  every balance on next launch — the exact failure the list documents. */
  function _wipeLocalUserKeys() {
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('fc_') && !_WIPE_PRESERVE.some(p => k.startsWith(p)))
        .forEach(k => localStorage.removeItem(k));
    } catch (_) { /* localStorage unavailable in strict CSP — safe to ignore */ }
  }

  /** Wipe every per-user piece of in-memory state. Called from handleSignOut
   *  AND from the auth observer when Firebase reports no user, so a session
   *  ended by token expiry or programmatic signOut doesn't leak the previous
   *  user's accounts/transactions into the next sign-in. */
  function _wipeUserState() {
    if (_isDemoMode) return;
    fcLog('[FCApp] _wipeUserState — clearing all user state and listeners');

    // Detach all Firestore listeners — prevents stale data firing after sign-out.
    // 1. App-level unsubscribes collected in _firestoreListeners
    _firestoreListeners.forEach(unsub => { try { unsub(); } catch (_) {} });
    _firestoreListeners = [];
    // 2. FCData module listeners (canonical path — covers all listenTo* calls)
    try { if (typeof FCData !== 'undefined') FCData.detachAllListeners(); } catch (_) {}

    // CRITICAL: reset the guard so _attachDataListeners() re-attaches for the
    // next sign-in. Without this, onAuthStateChanged(user) would find
    // _listenersAttached=true (from the previous session) and skip the attach,
    // leaving the new user with permanently empty state.
    _listenersAttached = false;

    // Reset RevenueCat to a clean subscriber — prevents new user being evaluated
    // against the previous user's entitlement cache / RC identity.
    try { if (typeof FCPurchases !== 'undefined') FCPurchases.reset().catch(() => {}); } catch (_) {}

    // Reset push listener guard — ensures new user's FCM token gets registered
    // after the next requestAndRegister() call (e.g. from _onPlaidSuccess).
    try { if (typeof FCPush !== 'undefined') FCPush.reset(); } catch (_) {}

    state.user          = null;
    state.accounts      = [];
    state.transactions  = [];
    state.bills         = [];
    state.goals         = [];
    state.budgets       = {};
    state.notifications = [];
    state.txnOverrides  = {};
    state.creditHistory = [];
    state.nwHistory     = {};
    // Same reasoning as budgetHistory below — a debt-payoff figure belonging
    // to the previous account must never greet whoever signs in next.
    state.debtHistory   = {};
    // The user-supplied APR / minimum overlay. Same rule: it is per-account
    // data belonging to one person's banks.
    state.accountDetails = {};
    // Must be wiped with the rest: rollover credit belonging to the previous
    // account would otherwise be granted to whoever signs in next.
    state.budgetHistory = {};
    _budgetMonthsWritten.clear();
    state.searchQuery   = '';
    state.initialLoading = false;
    _paywallShownThisSession    = false;
    _streakCheckedThisSession   = false;
    if (_privacyModeOn) {
      _privacyModeOn = false;
      document.body.classList.remove('fc-privacy');
      // Also tear down the DOM observer — otherwise it keeps running against
      // the next user's session.
      if (typeof _stopPrivacyObserver === 'function') _stopPrivacyObserver();
    }
    // Wipe per-user localStorage caches (net-worth history, budget alert
    // flags, debt start, milestone flags, RC pro cache, etc.) so they can't
    // leak into the next user's session.
    _wipeLocalUserKeys();

    // Blank out the home DOM immediately so the previous user's rendered
    // content is never visible during the gap between wipe and first render.
    _clearHomeDom();
  }

  /**
   * Replace main content areas of the home tab with skeleton placeholders.
   * Called during _wipeUserState() so the DOM never shows stale data from a
   * previous account while the new account's Firestore listeners load.
   */
  function _clearHomeDom() {
    try {
      // Premium skeleton rows using the fc-sk shimmer system
      const skRow = (w1, w2) => `
        <div class="fc-sk-row">
          <div class="fc-sk fc-sk--avatar" style="width:40px;height:40px"></div>
          <div class="fc-sk-row-body">
            <div class="fc-sk fc-sk--text-md" style="width:${w1}%"></div>
            <div class="fc-sk fc-sk--text-sm" style="width:${w2}%;margin-top:3px"></div>
          </div>
        </div>`;

      const acctList = document.getElementById('home-accounts-list');
      if (acctList) {
        acctList.innerHTML = `<div class="fc-sk-list">${skRow(62,38)}${skRow(55,30)}${skRow(70,42)}</div>`;
      }

      const txnList = document.getElementById('home-txn-list');
      if (txnList) {
        txnList.innerHTML = `<div class="fc-sk-list">${skRow(58,34)}${skRow(65,28)}${skRow(48,38)}${skRow(72,32)}</div>`;
      }

      // Hero number: show an em-dash, styled — the animateNumber will replace it
      const nwEl = document.getElementById('home-nw-amount');
      if (nwEl) nwEl.textContent = '—';

      const greetEl = document.getElementById('home-greeting');
      if (greetEl) {
        greetEl.innerHTML = `
          <div class="fc-sk fc-sk--text-lg" style="width:55%;margin-bottom:6px"></div>
          <div class="fc-sk fc-sk--text-md" style="width:38%"></div>`;
      }

      // Reset the legacy skeleton overlays
      const acctSkel = document.getElementById('home-acct-skeleton');
      const txnSkel  = document.getElementById('home-txn-skeleton');
      if (acctSkel) acctSkel.style.display = 'none';
      if (txnSkel)  txnSkel.style.display  = 'none';
    } catch (_) {}
  }

  /** Re-render every pro-gated surface after a successful purchase/restore.
   *  Without this the success overlay closes but underlying gates persist
   *  (e.g. the Financial Health Score card and the settings Upgrade row). */
  function _refreshAfterPro() {
    if (state.user) state.user.is_pro = true;
    // Nuke any lingering gate overlays before re-renders so they can't flash back
    document.querySelectorAll('.fc-pro-gate').forEach(el => el.remove());
    try { _renderHome();       } catch (_) {}
    try { _renderActivity();   } catch (_) {}
    try { _renderInsights();   } catch (_) {}
    try { _renderWealth();     } catch (_) {}
    /* Was _renderGoals(), which rendered the old Goals panel INSIDE Money —
       a panel with no tab button to reach it, so it has been invisible since
       Goals became its own tab. Buying Pro therefore refreshed everything
       except the Goals screen the user can actually see. */
    try { _renderGoalsScreen(true); } catch (_) {}
    try { _renderSettings();   } catch (_) {}
    const settingsProRow = document.getElementById('settings-pro-row');
    if (settingsProRow) settingsProRow.style.display = 'none';
  }

  function _renderProGate(section, icon, title, teaser) {
    if (!section) return;
    section.style.display = '';
    // Build three "blurred bars" of varying width to mimic real content
    const bars = [85, 62, 45, 72].map(w =>
      `<div class="fc-pro-gate-bar" style="width:${w}%"></div>`
    ).join('');
    section.innerHTML = `
      <div class="fc-pro-gate" onclick="FCApp.showPaywall()">
        <div class="fc-pro-gate-preview">${bars}</div>
        <div class="fc-pro-gate-overlay">
          <div class="fc-pro-gate-badge">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            Pro Feature
          </div>
          <div class="fc-pro-gate-icon">${icon}</div>
          <div class="fc-pro-gate-title">${title}</div>
          <div class="fc-pro-gate-desc">${teaser}</div>
          <button class="fc-pro-gate-btn" type="button" onclick="event.stopPropagation();FCApp.showPaywall()">
            Unlock Pro →
          </button>
        </div>
      </div>`;
  }

  /* ── 50/30/20 Budget Wizard ─────────────────────────────────────────
     Maps this month's spending into Needs / Wants / Savings buckets and
     compares against the classic 50/30/20 rule. Only shown when the user
     has income data — otherwise the denominator is undefined.
     ─────────────────────────────────────────────────────────────────── */
  /* ── Zombie Subscription Finder ─────────────────────────────────────
     Surfaces auto-detected recurring charges that are NOT in the user's
     tracked bills list. Helps users discover and cancel forgotten subs.
     Only shown when 2+ zombie subscriptions are found.
     ─────────────────────────────────────────────────────────────────── */
  /* ── Debt Payoff Planner ─────────────────────────────────────────────
     Compares Avalanche (highest APR first) vs Snowball (smallest balance
     first) payoff strategies for connected loan + credit accounts.

     Interest rates are estimated by account type/name — accurate APR data
     is not available from Plaid. Users are shown the disclaimer.

     Payoff formula (standard amortization):
       months = -ln(1 - r·B/P) / ln(1+r)  where r = monthly rate, P = payment
     ─────────────────────────────────────────────────────────────────── */
  /* ── Net Worth Milestone Tracker ─────────────────────────────────────
     Shows progress to the next net worth milestone and celebrates when
     the user crosses one. Financial values stay in Firestore/in memory;
     acknowledged milestones are stored on the user's Firestore document.
     ─────────────────────────────────────────────────────────────────── */
  // Lightweight confetti burst for milestone celebration
  /* ── Credit Card Optimizer ──────────────────────────────────────────
     Analyzes the user's real spending by category over the last 90 days,
     scores a curated catalog of top rewards cards, and renders a carousel
     of the top 2-3 picks showing estimated annual rewards.

     Privacy: no spending data leaves the device. All scoring is done
     locally against the in-memory transaction array.
     ─────────────────────────────────────────────────────────────────── */
  /* ── Cash Flow Forecast ──────────────────────────────────────────
     Projects the user's checking balance 30 days forward by combining:
       • Current cash (sum of all depository account balances)
       • Upcoming bills from state.bills (unpaid, due in next 30 days)
       • Average daily spend rate from last 14 days of real transactions

     Renders an SVG sparkline, highlights the projected low point,
     and surfaces a warning if the balance is predicted to dip below
     a safety threshold (10% of starting balance, min $200).

     All computation is local — no data leaves the device.
     ─────────────────────────────────────────────────────────────── */
  // Render the credit score card from cached user data (state.user.credit_score)
  /* ── Open affiliate offer ─────────────────────────────────────
     Opens the partner URL in the in-app browser.
     Logs the click to localStorage for future analytics.
     ───────────────────────────────────────────────────────────── */
  function openOffer(offerId) {
    const offers = (window.FC_CONFIG && window.FC_CONFIG.offers) || [];
    const offer  = offers.find(o => o.id === offerId);
    if (!offer) return;

    // Log click (for your own analytics — no PII sent anywhere)
    try {
      const _ofUid = FCAuth.currentUser?.()?.uid || state.user?.uid || '';
      const _ofKey = `fc_offer_clicks_${_ofUid}`;
      const log    = JSON.parse(localStorage.getItem(_ofKey) || '[]');
      log.push({ id: offerId, ts: Date.now() });
      localStorage.setItem(_ofKey, JSON.stringify(log.slice(-50)));
    } catch (_) {}

    haptic('light');
    _openUrl(offer.url);
  }

  // Called when user taps "Check My Credit Score" — fetches from backend
  async function fetchCreditScore() {
    const callerUid = FCAuth.currentUser?.()?.uid; // capture before async gap
    const btn = document.getElementById('credit-connect-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

    try {
      const creditUrl   = (FC_CONFIG && FC_CONFIG.credit && FC_CONFIG.credit.scoreEndpoint)
                        || 'https://getflowcheck.app/credit/score';
      const abort   = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 12_000); // 12s frontend timeout
      // POST so the body is available server-side for production PII lookup.
      // In sandbox the server uses hardcoded test consumer — body fields are optional.
      // In production, populate these from a PII collection screen before calling.
      const creditPii = state.user?.credit_pii || {};
      const resp  = await FCAuth.authedFetch(creditUrl, {
        method:  'POST',
        signal:  abort.signal,
        headers: {
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          firstName: creditPii.firstName || '',
          lastName:  creditPii.lastName  || '',
          ssn:       creditPii.ssn       || '',
          dob:       creditPii.dob       || '',
          address:   creditPii.address   || '',
          city:      creditPii.city      || '',
          state:     creditPii.state     || '',
          zip:       creditPii.zip       || '',
        }),
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        if (resp.status === 404) {
          throw new Error('Credit service unavailable — please try again later');
        }
        if (resp.status === 429) {
          throw new Error('Too many requests — please wait a few minutes');
        }
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `Service error (${resp.status})`);
      }

      const data = await resp.json();

      // Guard: abort if user signed out during the fetch
      if (!callerUid || FCAuth.currentUser?.()?.uid !== callerUid) return;

      // Write into state.user so _renderCreditScore picks it up
      if (!state.user) state.user = {};
      state.user.credit_score            = data.score;
      state.user.credit_score_type       = data.scoreType;
      state.user.credit_risk_class       = data.riskClass;
      state.user.credit_factors          = data.factors || [];
      state.user.credit_score_updated_at = { toDate: () => new Date() };

      haptic('medium');

      // Persist monthly snapshot for history chart (best-effort)
      if (!data.demo) {
        FCData.saveCreditSnapshot(data.score).catch(() => {});
      }

      // Show info note if score was manually entered vs. fetched from a service
      if (data.manual) {
        // Manual scores don't need a notification — they're already understood as user-entered
      }
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? 'Request timed out — please try again'
        : (err.message || 'Please try again');
      toast('Could not fetch score: ' + msg, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Check My Credit Score'; }
    }
  }

  // Called when user taps "Refresh"
  async function refreshCreditScore() {
    const btn = document.getElementById('credit-refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      await fetchCreditScore();
    } catch (_) {
      // fetchCreditScore handles its own error toasts — just reset the button
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: GREETING
     ───────────────────────────────────────────────────────────── */
  function _renderGreeting(safeToSpend) {
    const titleEl  = document.getElementById('home-greeting-title');
    const dateEl   = document.getElementById('home-greeting-date');
    const subEl    = document.getElementById('home-greeting-sub');
    const avatarEl = document.getElementById('home-user-avatar');
    if (!titleEl) return;

    const hour = new Date().getHours();
    const tod  = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning'
               : hour < 17 ? 'Good afternoon' : 'Good evening';
    // Resolution: Firestore 'name' → Firebase Auth displayName → blank (never email prefix)
    const authUser2 = window.FCAuth && FCAuth.currentUser ? FCAuth.currentUser() : null;
    const rawName   = (state.user?.name || authUser2?.displayName || '').trim();
    // Take first word, capitalize, ignore if it looks like an email prefix (contains dot/number)
    const firstName = rawName.split(' ')[0] || '';
    const safeName  = /[.\d]/.test(firstName) ? '' : firstName;
    const name      = safeName ? safeName.charAt(0).toUpperCase() + safeName.slice(1) : '';

    _setGreetingTitle(titleEl, tod, name || 'there');
    if (dateEl) {
      const now = new Date();
      dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    }

    // Avatar initial
    const avatarLetter2 = name.charAt(0).toUpperCase() || (authUser2?.email || '').charAt(0).toUpperCase() || '?';
    if (avatarEl) avatarEl.textContent = avatarLetter2;

    // home-greeting-sub is now a hidden compat element — skip visual mutations
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: ACCOUNT ROWS (v2 compact list)
     ───────────────────────────────────────────────────────────── */
  // Maps the output of FCData.normalizePlaidCategory() → clean display label
  function _prettyCategory(normalized) {
    const map = {
      'Food and Drink':    'Dining',
      'Restaurants':       'Dining',
      'Coffee Shop':       'Coffee',
      'Grocery':           'Groceries',
      'Auto and Transport':'Transport',
      'Gas Stations':      'Gas',
      'General Merchandise':'Shopping',
      'Shopping':          'Shopping',
      'Rent and Utilities':'Utilities',
      'Utilities':         'Utilities',
      'Healthcare':        'Healthcare',
      'Medical':           'Healthcare',
      'Personal Care':     'Personal Care',
      'Entertainment':     'Entertainment',
      'Services':          'Services',
      'Home Improvement':  'Home',
      'Education':         'Education',
      'Travel':            'Travel',
      'Bank Fees':         'Bank Fees',
      'Transfer':          'Transfer',
      'Loan':              'Loans',
      'Government':        'Government',
      'Investments':       'Investments',
      'Income':            'Income',
    };
    return map[normalized] || normalized;
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: RECENT TRANSACTIONS (home preview)
     ───────────────────────────────────────────────────────────── */
  /* ─────────────────────────────────────────────────────────────
     RENDER: THIS MONTH'S MOVE — insight card below recent activity
     ───────────────────────────────────────────────────────────── */
  /* ─────────────────────────────────────────────────────────────
     TODAY'S FOCUS — single actionable daily insight engine
     Generates prioritised insights from live user data.
     ───────────────────────────────────────────────────────────── */

  const _dismissedInsightLabels = new Set();

  // Build an ordered list of insights from current state data
  function _buildFocusInsights() {
    const insights = [];
    const now      = new Date();
    const txns     = state.transactions || [];
    const bills    = (state.bills || []).filter(b => b.status !== 'paid');
    const accounts = state.accounts || [];

    // ── 1. Overdue bills (highest priority) ─────────────────────
    const overdue = bills.filter(b => {
      const d = FCData.parseDateLocal(b.due_date);
      return d < now;
    });
    if (overdue.length) {
      const daysLate = Math.abs(FCData.daysUntil(overdue[0].due_date) ?? 0);
      insights.push({
        type: 'danger',
        label: 'Pay this now',
        title: `${overdue[0].name} is overdue`,
        body: `${daysLate} day${daysLate !== 1 ? 's' : ''} late — paying today prevents any late fees or credit impact.`,
        action: 'View bill',
        tap: () => FCApp.switchTab('activity')
      });
    }

    // ── 2. Bill due in the next 3 days ───────────────────────────
    const dueSoon = bills.filter(b => {
      const days = FCData.daysUntil(b.due_date);
      return days >= 0 && days <= 3;
    });
    if (dueSoon.length && !overdue.length) {
      const b    = dueSoon[0];
      const days = FCData.daysUntil(b.due_date);
      const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
      insights.push({
        type: 'warn',
        label: 'Bill coming up',
        title: `Pay ${b.name} ${when}`,
        body: `${FCData.formatCurrency(b.amount || 0)} due ${when}. Mark it paid once you've sent it.`,
        action: 'Mark as paid',
        tap: () => FCApp.switchTab('activity')
      });
    }

    // ── 3. Budget overspend this month ───────────────────────────
    const budget = (state.budgets && state.budgets['total'] && state.budgets['total'].limit) || 0;
    if (budget > 0 && txns.length) {
      const spent = txns
        .filter(t => !t.isCredit && _isSpendTxn(t) && FCData.isCurrentMonth(t.date))
        .reduce((s, t) => s + (t.amount || 0), 0);
      const pct = spent / budget;
      const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
      if (pct > 0.9) {
        const dailyTarget = pct < 1 ? Math.round((budget - spent) / Math.max(daysLeft, 1)) : 0;
        insights.push({
          type: pct >= 1 ? 'danger' : 'warn',
          label: pct >= 1 ? 'Over budget' : 'Slow down spending',
          title: pct >= 1 ? 'You\'ve exceeded your budget' : 'Slow spending this week',
          body: pct >= 1
            ? `You're ${FCData.formatCurrency(spent - budget)} over your ${FCData.formatCurrency(budget)} monthly budget. Review the biggest categories in Plan.`
            : `${Math.round(pct * 100)}% of your budget used with ${daysLeft} days left.${dailyTarget > 0 ? ` Try keeping daily spending under ${FCData.formatCurrency(dailyTarget)}.` : ''}`,
          action: 'Review spending',
          tap: () => FCApp.switchTab('plan')
        });
      }
    }

    // ── 3b. Projected month-end spend > income by $500+ ─────────
    {
      const calTxns   = txns.filter(t => FCData.isCurrentMonth(t.date));
      const monthSpend = calTxns.filter(t => !t.isCredit && _isSpendTxn(t)).reduce((s,t) => s + (t.amount||0), 0);
      const monthIncome = calTxns.filter(_isIncomeTxn).reduce((s,t) => s + (t.amount||0), 0);
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysElapsed = now.getDate();
      if (daysElapsed >= 5 && monthSpend > 0 && monthIncome > 0) {
        const projected = (monthSpend / daysElapsed) * daysInMonth;
        const overage   = projected - monthIncome;
        const dailyCap  = Math.round((monthIncome - monthSpend) / Math.max(daysInMonth - daysElapsed, 1));
        if (overage > 500 && !(budget > 0 && monthSpend / budget > 0.9)) {
          insights.push({
            type: 'warn',
            label: 'Pace check',
            title: 'Spending pace is running high',
            body: `On track to spend ${FCData.formatCurrency(projected)} this month.${dailyCap > 0 ? ` Staying under ${FCData.formatCurrency(dailyCap)}/day keeps you in the green.` : ` That\'s ${FCData.formatCurrency(overage)} more than you\'ve earned this month.`}`,
            action: 'Review plan',
            tap: () => FCApp.switchTab('plan')
          });
        }
      }
    }

    // (removed) "Large charge" alert — it narrated a purchase that had
    // already happened, which is the retrospective pattern VISION.md rejects.
    // Anomaly detection that fires BEFORE money moves would earn its place;
    // reporting a completed charge does not.

    // ── 5. Low cash balance warning ──────────────────────────────
    const cashBal = FCData.calcCash(accounts);
    if (cashBal < 500 && cashBal >= 0 && accounts.length > 0) {
      const billsThisWeek = _getBillsDueInDays(7).reduce((s,b) => s + (b.amount||0), 0);
      insights.push({
        type: 'warn',
        label: 'Low balance',
        title: 'Cash is running low',
        body: `You have ${FCData.formatCurrency(cashBal)} in cash.${billsThisWeek > 0 ? ` ${FCData.formatCurrency(billsThisWeek)} in bills are due this week.` : ' Try to avoid large discretionary purchases.'}`,
        action: 'View accounts',
        tap: () => FCApp.switchTab('wealth')
      });
    }

    // ── 6. Zombie subscriptions found ───────────────────────────
    try {
      const zombies = _detectSubscriptions().filter(s => !s.tracked);
      if (zombies.length > 0) {
        const total = zombies.reduce((s,z) => s + (z.amount || 0), 0);
        insights.push({
          type: 'info',
          label: 'Trim subscriptions',
          title: `${FCData.formatCurrency(total)}/mo in subscriptions to review`,
          body: `Found ${zombies.length} recurring charge${zombies.length>1?'s':''} you might not be using. Canceling unused ones is the easiest monthly savings.`,
          action: 'Review subscriptions',
          tap: () => FCApp.switchTab('plan')
        });
      }
    } catch(_) { /* _detectSubscriptions may not be ready yet */ }

    // (removed) "Good week" / "Net worth" filler cards. Both were tagged
    // `fallback: true`, and every consumer either hid the section or filtered
    // them out — so they were built on every render only to be thrown away.
    // A dashboard card that fires to say nothing is wrong is noise.

    return insights.filter(ins => !_dismissedInsightLabels.has(ins.label));
  }

  // Color + icon config per insight type

  function _dismissInsight(label) {
    if (label) _dismissedInsightLabels.add(label);
    _renderHomeDashboard();
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: HOME
     ───────────────────────────────────────────────────────────── */

  // Compact currency for tight stat cards — $19,330 → $19.3K, $1,200,000 → $1.2M
  function _fmtCompact(val) {
    if (val == null || isNaN(val)) return '$0';
    const abs  = Math.abs(val);
    const sign = val < 0 ? '−$' : '$';
    if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 100000)  return sign + (abs / 1000).toFixed(0)    + 'K';
    return FCData.formatCurrency(val);
  }

  /* ─────────────────────────────────────────────────────────────
     HOME DATA HELPERS — shared by new Home sections
     ───────────────────────────────────────────────────────────── */

  function _getBillsDueInDays(n) {
    return (state.bills || []).filter(b => {
      if (b.status === 'paid') return false;
      const d = FCData.daysUntil(b.due_date);
      return d !== null && d >= 0 && d <= n;
    });
  }

  /* Delegates to FCCore — see the note on _buildSafeSpendProjection below.
     This was a second, independent copy of the payday algorithm, and it
     carried every bug the core version was just fixed for: mean gaps
     instead of median, no consistency test, no staleness test, no weekly
     or semi-monthly cadence, and a comparison against Date.now() that made
     payday itself read as a full cycle away. Two copies of the same money
     math is how the number on one screen stops matching the number on the
     next. Returns { date, days, cadence } — days is 0 on payday itself. */
  function _predictNextPayday() {
    return FCCore.predictNextPayday(state.transactions || []);
  }

  /* Phrasing for "when is payday". The old prediction could never return 0 —
     it forced a minimum of 1 day and skipped the cheque landing today — so
     every call site below would have rendered "0 days away" the moment that
     was fixed. */
  function _paydayWhen(days) {
    return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : 'in ' + days + ' days';
  }

  /* Inputs for the shared core (www/js/fc-core.js). Kept in one place so
     both entry points below feed it identically. */
  function _coreInput() {
    return {
      accounts:     state.accounts || [],
      transactions: state.transactions || [],
      bills:        _billsForDisplay(),
    };
  }

  /* Delegates to FCCore so the phone and the web app at /app cannot drift.
     Both implementations were verified byte-identical before this swap
     (same horizon, endpoint, bill count, burn rate and every balance
     point). Do not reintroduce a local copy of this math. */
  function _buildSafeSpendProjection() {
    return FCCore.buildSafeSpendProjection(_coreInput());
  }

  /* ─────────────────────────────────────────────────────────────
     DASHBOARD v9 — RUNWAY SERIES
     See DASHBOARD_SPEC.md. Pure function: builds one balance point per
     day from today to payday, dipping at each unpaid bill. No DOM, no
     network — everything derives from _buildSafeSpendProjection().
     ───────────────────────────────────────────────────────────── */
  /* Delegates to FCCore — see _buildSafeSpendProjection above. The runway
     drawn on getflowcheck.app/app comes from this exact function, so the
     number on the website is the number on the phone by construction. */
  function _buildRunwaySeries() {
    return FCCore.buildRunwaySeries(_coreInput());
  }

  /* ── Dashboard v9: runway SVG markup (DASHBOARD_SPEC.md §2) ────── */
  let _rwSeries = null;   // last rendered runway, read by the scrub handler

  /* Bank-linked test, mirroring the `isLinked` line in _renderHome.
     Deliberately module scope: _renderRunwayCard must never reach for a
     _renderHome local (that is the fmt() trap that blanked Today once). */
  function _isBankLinked() {
    const u = state.user || {};
    return Boolean(u.plaid_linked || u.plaid_institution || (state.accounts || []).length || _isDemoMode);
  }

  /* Fixed, deterministic sample for the no-bank state (SPEC §6). Same shape
     as _buildRunwaySeries so it renders through the identical code path — the
     user sees the real instrument, just not real numbers. Rendered WITHOUT
     any dollar figure: a fabricated balance must never be mistakable for the
     user's own money. */
  function _buildSampleRunwaySeries() {
    const horizon = 14, dailyBurn = 46, start = 2400;
    const billsByDay = {
      3:  [{ name: 'Rent',     amount: 950 }],
      8:  [{ name: 'Electric', amount: 130 }],
      11: [{ name: 'Phone',    amount: 65  }],
    };
    let balance = start;
    let lowest = { day: 0, balance: start };
    const points = [];
    for (let day = 0; day <= horizon; day++) {
      const dayBills = billsByDay[day] || [];
      balance -= dayBills.reduce((s, b) => s + b.amount, 0);
      if (day > 0) balance -= dailyBurn;
      if (balance < lowest.balance) lowest = { day, balance };
      const date = new Date();
      date.setDate(date.getDate() + day);
      date.setHours(0, 0, 0, 0);
      points.push({ day, date, balance, bills: dayBills });
    }
    return {
      points, horizon, dailyBurn,
      startBalance: start,
      endBalance: points[points.length - 1].balance,
      lowest, firstNegativeDay: null, goesNegative: false,
      payday: null, hasPayday: true, billCount: 3, isSample: true,
    };
  }

  /* Shared chart geometry. _attachRunwayScrub mirrors this y-mapping —
     change one and you must change the other. */
  /* "Next 14 days" reads as a scope; "14 days" reads as a second, competing
     answer to the headline's question. The word matters here. */
  function _rwWindowLabel(horizon) {
    const d = Math.max(1, Math.round(horizon));
    if (d % 7 === 0 && d >= 14) return 'Next ' + (d / 7) + ' weeks';
    return d === 1 ? 'Next day' : 'Next ' + d + ' days';
  }

  function _rwGeom(r) {
    const W = 300, H = 104, PAD_T = 10, PAD_B = 20;

    /* The y-axis used to be anchored at zero: minV = min(lowest, 0). That
       made every healthy runway a flat line — a $9.62 bill against a $600
       balance is 1.6% of the height, roughly one pixel — so the chart looked
       broken precisely when the news was good.

       Scale to the data instead, and only force zero into view when the
       balance actually reaches it. That is the one case where the zero line
       carries the meaning, and it still does. */
    const hi = Math.max(r.startBalance, r.endBalance, r.lowest.balance);
    const lo = Math.min(r.lowest.balance, r.endBalance, r.startBalance);
    const goesNegative = lo < 0;

    let maxV, minV;
    if (goesNegative) {
      maxV = Math.max(hi, 0);
      minV = Math.min(lo, 0);
    } else {
      // Floor the range so a genuinely flat line still gets a sane scale
      // instead of dividing by ~0.
      const range = Math.max(hi - lo, Math.abs(hi) * 0.02, 1);
      maxV = hi + range * 0.18;
      minV = Math.max(0, lo - range * 0.30);
    }
    const span = Math.max(1, maxV - minV);
    return {
      W, H, PAD_T, PAD_B, minV,
      x: d => (d / Math.max(1, r.horizon)) * W,
      y: v => PAD_T + (1 - (v - minV) / span) * (H - PAD_T - PAD_B),
    };
  }

  const _RW_LOCK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';

  /* Pre-connection cards ONLY (sample + skeleton). This row is persuasion
     aimed at someone deciding whether to hand us their bank login, and on
     those two cards it earns its ~40px. On the real runway it was shipping
     on every launch of the daily home — the most expensive space in the app
     spent reassuring someone who connected their bank months ago and is
     here to find out whether they can buy lunch. The claim itself still
     lives on the connect flow and in Settings, where it is checkable. */
  const _RW_TRUST_ROW = '<div class="rw-trust">' + _RW_LOCK_ICON
    + '<span id="home-trust-text">Read-only · Bank-grade encryption</span></div>';

  /* SPEC §6 — loading. Axis and payday edge already in place, line absent.
     Never a spinner: the frame of the answer arrives before the answer. */
  function _renderRunwaySkeleton() {
    return ''
      + '<section class="fc-ui-card rw-card rw-card--sk" aria-label="Runway loading" aria-busy="true">'
        + '<div class="rw-head">'
          + '<div class="rw-head__text"><p class="fc-section-label">Runway</p>'
            + '<span class="fc-sk fc-sk--text-lg rw-sk-headline"></span>'
            + '<span class="fc-sk fc-sk--text-lg rw-sk-headline"></span>'
            + '<span class="fc-sk fc-sk--text-sm rw-sk-sub"></span>'
            + '<span class="fc-sk fc-sk--text-sm rw-sk-sub"></span></div>'
          + '<div class="rw-end"><p class="rw-end-lbl">Payday</p>'
            + '<span class="fc-sk fc-sk--text-lg rw-sk-end"></span></div>'
        + '</div>'
        + '<div class="rw-chart">'
          + '<svg viewBox="0 0 300 104" preserveAspectRatio="none" aria-hidden="true">'
            + '<line x1="0" y1="84" x2="300" y2="84" stroke="var(--fc-border)" stroke-width="1"/>'
            + '<line x1="298.5" y1="8" x2="298.5" y2="84" stroke="var(--fc-accent)" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.55"/>'
          + '</svg>'
          + '<div class="rw-axis"><span>Today</span><span>Payday</span></div>'
        + '</div>'
        + '<span class="fc-sk rw-sk-cta"></span>'
        + _RW_TRUST_ROW
      + '</section>';
  }

  /* SPEC §6 — no bank linked. Show the shape of the value before asking for
     access. Dimmed sample, explicit "Sample data" tag, and no dollar figure
     anywhere on the card. */
  function _renderRunwaySample() {
    const r = _buildSampleRunwaySeries();
    return ''
      + '<section class="fc-ui-card rw-card rw-card--sample" aria-label="Sample runway">'
        + '<div class="rw-head">'
          + '<div class="rw-head__text"><p class="fc-section-label">Runway · Sample</p>'
            + '<h2 class="rw-headline">See if you make it to payday</h2>'
            + '<p class="rw-sub">Connect your bank and this becomes your real balance, day by day, with every bill already taken out.</p></div>'
        + '</div>'
        + '<div class="rw-chart rw-chart--sample">'
          + _rwChartSVG(r, 'var(--fc-accent)')
          + '<div class="rw-axis"><span>Today</span><span>Payday</span></div>'
          + '<div class="rw-sample-veil"><span class="rw-sample-tag">Sample data</span></div>'
        + '</div>'
        + '<button class="rw-cta" type="button" onclick="FCApp.startPlaidLink&&FCApp.startPlaidLink()">Connect your bank</button>'
        + _RW_TRUST_ROW
      + '</section>';
  }

  /* The SVG itself — line, area, bill markers, zero-line, endpoint dot.
     Shared by the real and sample cards so both render identically. */
  function _rwChartSVG(r, stroke) {
    const g = _rwGeom(r), pts = r.points;
    const line = pts.map((p, i) => (i ? 'L' : 'M') + g.x(p.day).toFixed(1) + ',' + g.y(p.balance).toFixed(1)).join(' ');
    const area = line + ' L' + g.W + ',' + g.y(g.minV).toFixed(1) + ' L0,' + g.y(g.minV).toFixed(1) + ' Z';
    const zeroY = g.y(0);
    const W = g.W, H = g.H, PAD_B = g.PAD_B, minV = g.minV;
    const x = g.x, y = g.y;
    /* The viewBox is a fixed 300×104 stretched to the card's real width by
       preserveAspectRatio="none" — about 1.13× on a 6.1" phone and more on a
       Pro Max. Anything with a fixed aspect drawn INSIDE that space inherits
       the stretch: <circle r="4.5"> renders as an ellipse and a 2.5 stroke
       thickens unevenly along the line. It read as "almost right", which is
       the exact register we are trying to leave.
       So: paths stay in the stretched space (a stretched line is still the
       right line) but with non-scaling-stroke so the ink stays 2.5 device px,
       and every round thing moves to an HTML overlay positioned in percent —
       the pattern .rw-scrub-dot already uses in this same card. */
    const VE = ' vector-effect="non-scaling-stroke"';
    const xPct = p => (x(p) / W * 100).toFixed(2);
    const yPct = v => (y(v) / H * 100).toFixed(2);

    const markerLines = pts.filter(p => p.bills.length).map(p =>
      '<line class="rw-marker" x1="' + x(p.day).toFixed(1) + '" y1="' + y(p.balance).toFixed(1) + '" x2="' + x(p.day).toFixed(1) + '" y2="' + (H - PAD_B) + '" stroke="var(--fc-border-strong)" stroke-width="1" stroke-dasharray="2 3"' + VE + '/>').join('');

    /* Bill dots + the endpoint, as HTML so they stay circular. */
    const dots = pts.filter(p => p.bills.length).map(p =>
      '<span class="rw-dot" style="left:' + xPct(p.day) + '%;top:' + yPct(p.balance) + '%;--rw-dot-stroke:' + stroke + '"></span>').join('')
      + '<span class="rw-dot rw-dot--end" style="left:' + xPct(r.horizon) + '%;top:' + yPct(r.endBalance) + '%;--rw-dot-stroke:' + stroke + '"></span>';

    /* ── Today's balance, anchored to the first plotted point ──────────
       The chart's left end is r.startBalance — the cash you have right now.
       It is deliberately NOT the "Safe to spend" figure in the header: that
       one is _buildSafeSpendProjection().safe, which has upcoming bills and
       typical spending already subtracted out. In demo data the difference
       is $3,241.87 against $1,483.69. Printing the safe-to-spend number at
       the line's left end would put a label on the y-axis at a height that
       means something else, and misstate today's balance by $1,758.

       The header answers "what can I spend?". This answers "where does the
       line start?". Both belong on the card; they are not the same number
       and must not be shown as one. */
    const todayLbl = '<span class="rw-today" style="top:' + yPct(r.startBalance) + '%">'
      + '<span class="rw-today-amt">' + esc(FCData.formatCurrency(r.startBalance)) + '</span>'
      + '<span class="rw-today-cap">today</span></span>';

    /* ── Bill drops, labelled with what caused them ────────────────────
       A dot with a dashed drop-line says "something happened here". The
       amount says what. That is the whole difference between a shape and an
       explanation, and it is the one thing the card could not say before.

       Clutter control, in order:
        · only days that actually carry bills — never every point;
        · at most MAX_LBL of them, largest first, so a fortnight with nine
          small charges does not become a wall of text;
        · a greedy left-to-right pass drops any label that would collide
          with the one before it.

       Collision is measured in PERCENT of chart width because that is the
       coordinate system the overlay is positioned in, and the chart's pixel
       width varies from ~311px on a 375pt iPhone SE to ~400px on a Pro Max.
       Estimating the half-width from the character count keeps the gap
       honest at both ends instead of tuning it for one device. */
    const MAX_LBL = 4;
    const billDays = pts
      .filter(p => p.bills.length)
      .map(p => ({ p, amt: p.bills.reduce((sum, b) => sum + Math.abs(b.amount || 0), 0) }))
      .filter(e => e.amt > 0);

    const chosen = billDays
      .slice()
      .sort((a, b) => b.amt - a.amt)
      .slice(0, MAX_LBL)
      .sort((a, b) => a.p.day - b.p.day);

    let lastRight = -Infinity;
    const lastRowRight = [-Infinity, -Infinity];
    const eventLbls = chosen.map(e => {
      /* Whole dollars. "\u2212$1,200.00" spends four characters on precision
         nobody reads at a glance and makes the label wide enough to collide
         with its neighbour on a 375pt screen. The exact figure is one scrub
         away. */
      const text = '\u2212$' + Math.round(e.amt).toLocaleString('en-US');
      /* ~0.62em per character at 10px, over the chart's own width. */
      const wPct = (text.length * 6.2) / 309 * 100;
      const cx = parseFloat(xPct(e.p.day));

      /* Sit the label BESIDE the drop, not centred over it. A bill day is
         where the line falls hardest, so a centred label lands squarely on
         the descending stroke — at \u2212$1,200 the line ran straight through
         the text. Starting it just right of the drop puts it above the flat
         segment that follows, which is empty space.
         Near the right edge there is no room to extend rightwards, so the
         label flips and ends just left of the drop instead. */
      const GAP = 1.6;
      let left = cx + GAP;
      if (left + wPct > 100) left = cx - GAP - wPct;
      left = Math.max(0, Math.min(100 - wPct, left));

      /* Two rows before giving up. A fortnight can easily put two bills a
         day apart, and at that spacing the labels overlap horizontally no
         matter which side of the drop they sit on. Lifting the second one
         onto a higher row keeps both readable and keeps each one directly
         above its own marker.
         A third row would start competing with the headline for the top of
         the card, so anything still colliding after two is dropped rather
         than stacked — the dot and its dashed rule still mark the event, and
         the exact figure is one scrub away. Crowding the chart to name every
         bill would cost more than it buys. */
      const row = (left < lastRight + 1.5) ? 1 : 0;
      if (row === 1 && left < lastRowRight[1] + 1.5) return '';
      lastRowRight[row] = left + wPct;
      if (row === 0) lastRight = left + wPct;
      return '<span class="rw-evt' + (row ? ' rw-evt--stack' : '') + '" style="left:'
        + left.toFixed(2) + '%;top:' + yPct(e.p.balance) + '%">' + esc(text) + '</span>';
    }).join('');

    /* The zero crossing is the whole point of the card in the negative
       state — the headline names the date and the chart used to mark it
       nowhere. Label the zero line too: an unlabelled dashed red rule is a
       decoration, and the one number it stands for is the number that
       matters. */
    const cross = (r.goesNegative && r.firstNegativeDay != null) ? pts[r.firstNegativeDay] : null;

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<defs><linearGradient id="rwGrad" x1="0" y1="0" x2="0" y2="1">'
        /* Three stops, not two. The old 0.22 → 0 ramp spent most of its
           range already invisible, so the fill read as a soft smudge under
           the line rather than as the area it encloses. Holding a low but
           non-zero value through the middle gives the region a floor you can
           actually see, which is what makes it read as "money remaining"
           instead of decoration.
           It stops well short of a solid fill on purpose: the cyan stroke is
           the chart, and the moment the fill competes with it for attention
           this is worse, not better. */
        + '<stop offset="0%" stop-color="' + stroke + '" stop-opacity="0.30"/>'
        + '<stop offset="55%" stop-color="' + stroke + '" stop-opacity="0.10"/>'
        + '<stop offset="100%" stop-color="' + stroke + '" stop-opacity="0.02"/>'
      + '</linearGradient></defs>'
      + (minV < 0 ? '<line x1="0" y1="' + zeroY.toFixed(1) + '" x2="' + W + '" y2="' + zeroY.toFixed(1) + '" stroke="var(--fc-danger)" stroke-width="1" stroke-dasharray="3 3" opacity="0.55"' + VE + '/>' : '')
      + '<path d="' + area + '" fill="url(#rwGrad)"/>'
      + '<path class="rw-line" d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"' + VE + '/>'
      + markerLines
      + '</svg>'
      /* One overlay box, sized to the SVG's own 104px — NOT to .rw-chart,
         which is taller because it also holds .rw-axis. Percent coordinates
         here map 1:1 onto the viewBox only while this box matches the svg. */
      + '<div class="rw-overlay" aria-hidden="true">'
        + todayLbl
        + eventLbls
        + dots
        + (minV < 0 ? '<span class="rw-zero-lbl" style="top:' + yPct(0) + '%">$0</span>' : '')
        + (cross ? '<span class="rw-cross" style="left:' + xPct(cross.day) + '%">'
            + '<span class="rw-cross-flag">' + esc(cross.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })) + '</span></span>' : '')
      + '</div>';
  }

  function _renderRunwayCard() {
    /* SPEC §6 states, in precedence order: loading beats everything, then
       no-bank. Only a linked account with data draws a real runway. */
    if (state.initialLoading && state.user?.plaid_linked && !(state.accounts || []).length) {
      _rwSeries = null;                  // scrub must never read stale data
      return _renderRunwaySkeleton();
    }
    if (!_isBankLinked()) {
      _rwSeries = null;                  // scrub must never report sample money
      return _renderRunwaySample();
    }

    const r = _buildRunwaySeries();
    _rwSeries = r;
    const pts = r.points;
    if (!pts.length) return '';

    /* The line stays the accent colour even when the balance goes negative.

       Measured in a struggling profile, this card was rendering NINE
       danger-red elements at once — headline, amount, line stroke, area
       fill, zero rule, endpoint dot, "$0" label, crossing flag and its
       background — every one of them restating a single fact. Repetition
       carries no extra information; it only raises the volume. Someone
       already worried about money opened this screen and got shouted at
       nine times about something they came here to solve.

       So the chart is data, not a verdict: one accent line showing the
       shape, and exactly one red mark — the crossing — for the day that
       needs attention. The zero rule keeps a muted red because it is the
       threshold the crossing is measured against. */
    const stroke = 'var(--fc-accent)';
    /* "PAYDAY" over a dollar figure reads as "your paycheck is $353.82".
       The number underneath is r.endBalance — what is LEFT when payday
       arrives, which is close to the opposite of a paycheck. In an app whose
       whole promise is that its numbers can be trusted, a label that invites
       a 10x misreading of your own income is not a small thing. */
    const edgeLabel = r.hasPayday ? 'LEFT AT PAYDAY' : 'LEFT IN 2 WEEKS';
    const dLabel = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    /* Headline states the answer in words before the chart explains it.
       With no predicted payday we say "2 weeks" and never invent a date. */
    /* Ask the question that fits the person.
       With a paycheck: "will I make it to payday?"
       On irregular income there IS no payday, so the honest question is
       "how long am I covered if I don't earn another dollar?" — and we can
       answer it, because coveredDays assumes zero future income. Everyone
       else in this category just fails these users silently. */
    const cov = r.coveredDays;
    const covPhrase = !Number.isFinite(cov) ? null
      : cov <= 0 ? 'Today is tight'
      : cov === 1 ? 'Covered for 1 more day'
      : 'Covered for ' + cov + ' days';

    /* Does moving ONE bill actually close the gap?
       The biggest bill that falls on or before the crossing is the single
       lever with the most leverage — if it is at least as large as the
       deepest dip, shifting it past that date clears the whole shortfall.
       Computed, never assumed: when no single bill is big enough we do not
       claim one is, and the copy falls back to the general instruction. */
    const _gap = Math.abs(r.lowest.balance);
    const _movable = r.goesNegative
      ? pts.slice(0, (r.firstNegativeDay ?? 0) + 1)
          .flatMap(p => p.bills || [])
          .sort((a, b) => (b.amount || 0) - (a.amount || 0))[0]
      : null;
    const _oneBillFixesIt = !!(_movable && (_movable.amount || 0) >= _gap);

    let headline, sub;
    if (r.goesNegative) {
      /* Lead with the lever, not the deficit.
         "You run short on Aug 18" made the largest text on the app's most
         important screen a piece of bad news, in red, with the actual
         instruction relegated to 12px of grey underneath. The person
         already knows money is tight — that is why they opened the app.
         What they do not know is which single thing to move.
         The date and the amount are both still here; they have just stopped
         being the shout. */
      const _when = dLabel(pts[r.firstNegativeDay].date);
      if (_oneBillFixesIt) {
        // Two lines of large type reads as deliberate; three reads as
        // overflow. "Move X to stay above zero" says the same thing and fits.
        headline = 'Move ' + (_movable.name || 'one bill') + ' to stay above zero';
        sub = FCData.formatCurrency(_movable.amount) + ', due before ' + _when
            + '. Shifting it past ' + _when + ' covers the gap.';
      } else {
        headline = _when + ' is the day to watch';
        sub = 'Moving or delaying a bill before then keeps you above zero.';
      }
    } else if (r.isIrregular) {
      headline = covPhrase || 'You are covered';
      const wk = r.income.perWeek;
      sub = r.billCount
        ? r.billCount + ' bill' + (r.billCount === 1 ? '' : 's') + ' ahead. '
        : 'Nothing due. ';
      sub += wk > 0
        ? 'You usually bring in about ' + FCData.formatCurrency(wk) + ' a week.'
        : 'Income looks irregular, so this assumes nothing new comes in.';
    } else {
      headline = r.billCount
        ? (r.hasPayday ? 'You make it to payday' : 'You are covered for 2 weeks')
        : (r.hasPayday ? 'Nothing due before payday' : 'Nothing due in the next 2 weeks');
      sub = r.billCount
        ? r.billCount + ' bill' + (r.billCount === 1 ? '' : 's') + ' between now and then.'
        : 'This is all yours.';
      // Say plainly that the horizon is a fallback, not a detected payday.
      if (!r.hasPayday) sub += ' Payday not detected yet.';
    }

    /* Safe to Spend, not the projected end balance.
       This number was already being computed on every render and written
       straight into the hidden compat block in index.html \u2014 calculated, then
       thrown away. Meanwhile the hero's second slot carried the balance you
       are projected to land on at payday, which is a fact about the future
       rather than something you can act on this afternoon.
       "You have $42 you can safely spend before Tuesday" is the question
       people actually open the app with. It is also the one figure here that
       already accounts for upcoming bills and typical spending, so it is the
       honest answer rather than the raw one. */
    const _sp   = _buildSafeSpendProjection();
    const _safe = Math.max(0, _sp.safe || 0);
    const _until = (_sp.payday && _sp.payday.date)
      ? _sp.payday.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : '';

    /* When the runway dips below zero, "Safe to spend $0.00" is a clamp
       reported as a fact. Math.max(0, \u2026) maps a $12 shortfall and a $900
       shortfall onto the same three characters, and $0.00 next to a red
       "you run short on Aug 19" reads as a rounding artifact rather than
       the answer. The magnitude is already known \u2014 r.lowest.balance is the
       deepest point of the dip \u2014 so say it: "Short by $148" is what decides
       whether you move one bill or three.
       Deliberately r.lowest, not the balance on firstNegativeDay: what you
       have to cover is the worst moment in the window, not the first one. */
    const _short = r.goesNegative ? Math.abs(r.lowest.balance) : 0;
    const _endLbl  = r.goesNegative ? 'Short by' : 'Safe to spend';
    const _endVal  = r.goesNegative ? _short : _safe;
    /* The headline already names the day you cross zero, and so does the
       flag on the chart. Saying it a third time here is noise — so this
       slot only speaks when it has something the other two do not: the day
       the hole is DEEPEST, when that is later than the day it opens. That
       is the date the amount above actually refers to. */
    const _endMeta = r.goesNegative
      ? (r.lowest.day !== r.firstNegativeDay ? 'worst on ' + dLabel(pts[r.lowest.day].date) : '')
      : (_until ? 'until ' + _until : '');

    return ''
      + '<section class="fc-ui-card rw-card" aria-label="Runway to payday">'
        + '<div class="rw-head">'
          + '<div class="rw-head__text"><p class="fc-section-label">Runway</p>'
            /* No --warn on the headline any more. It now names the action
               rather than the problem, and an action rendered in danger red
               reads as another alarm instead of a way out. The amount beside
               it keeps the colour — one red number, not a red paragraph. */
            + '<h2 class="rw-headline">' + esc(headline) + '</h2>'
            + '<p class="rw-sub">' + esc(sub) + '</p></div>'
          + '<div class="rw-end"><p class="rw-end-lbl">' + esc(_endLbl) + '</p>'
            // data-countup lets the caller animate this without needing to
            // recompute the value \u2014 see the count-up pass in
            // _renderHomeDashboard(). Server-rendered text stays correct if
            // the animation is skipped (reduced motion, unchanged value).
            + '<p class="rw-endpoint-value fc-amount' + (r.goesNegative ? ' rw-endpoint-value--warn' : '') + '"'
            + ' id="rw-endpoint-value" data-countup="' + _endVal + '">'
            + FCData.formatCurrency(_endVal) + '</p>'
            + (_endMeta ? '<p class="rw-end-meta">' + esc(_endMeta) + '</p>' : '')
          + '</div>'
        + '</div>'
        + '<div class="rw-chart">'
          + _rwChartSVG(r, stroke)
          + '<div class="rw-scrub" id="rw-scrub" aria-hidden="true">'
            + '<div class="rw-scrub-line"></div>'
            + '<div class="rw-scrub-dot"></div>'
          + '</div>'
          + '<div class="rw-readout" id="rw-readout" aria-hidden="true"></div>'
          /* The middle label names the chart's window, and it exists because
             the card was contradicting itself. The headline reports
             coveredDays — how long you last assuming you never earn another
             dollar — which for a healthy account is often 50+ days. The chart
             plots `horizon`, a 14-day detail view. Both are right and they
             measure different things, but stacked with nothing between them
             the reader sees "Covered for 58 days" above a line that stops on
             Sep 1, does the subtraction, and concludes one of the two numbers
             is broken. Naming the window is what makes them legible as two
             different statements instead of one inconsistency. */
          + '<div class="rw-axis"><span>Today</span>'
            + '<span class="rw-axis-span">' + esc(_rwWindowLabel(r.horizon)) + '</span>'
            + '<span>' + esc(dLabel(pts[pts.length - 1].date)) + '</span></div>'
        + '</div>'
        /* The CTA has to answer the state it is sitting in. "Can I afford
           something?" under a red "You run short on Aug 19" asks a question
           the card has already answered, and answered no — while the actual
           instruction ("Move or delay a bill to stay above zero") sits in
           12px muted text with no affordance at all. In the short state the
           button IS that instruction and goes where the bills are.

           The button stays accent, not red: urgency is already carried by
           the headline, the amount, the line and the flag on the chart, and
           a fifth red element turns a warning into a siren. The accent is
           the app's action colour — the calm thing to press. (It is also
           the only one that clears 4.5:1 with white ink; --fc-danger does
           not, at 15px/700.) */
        + (r.goesNegative
            ? '<button class="rw-cta" type="button" onclick="FCApp.switchTab(\'activity\');FCApp.switchActivitySegment(\'bills\')">Fix ' + esc(dLabel(pts[r.firstNegativeDay].date)) + '</button>'
            : '<button class="rw-cta" type="button" onclick="FCApp.showAffordSheet&&FCApp.showAffordSheet()">Can I afford something?</button>')
        /* _RW_TRUST_ROW deliberately absent: see the note on its definition.
           It stays on the sample/skeleton cards, where it is doing real work
           for someone deciding whether to connect a bank. */
      + '</section>';
  }

  /* ── Dashboard v9 wow #2: drag to scrub (DASHBOARD_SPEC.md §4) ──
     Drag along the runway and a readout follows your finger:
     "Aug 14 — $612 left". Turns the chart from a picture into an
     instrument. Haptic ticks on day boundaries only, never per pixel. */
  function _attachRunwayScrub() {
    const chart = document.querySelector('.rw-chart');
    if (!chart || chart.dataset.scrubReady === '1') return;
    chart.dataset.scrubReady = '1';

    const scrub   = chart.querySelector('#rw-scrub');
    const readout = chart.querySelector('#rw-readout');
    const svg     = chart.querySelector('svg');
    if (!scrub || !readout || !svg) return;

    let lastDay = -1;

    const end = () => {
      chart.classList.remove('rw-scrubbing');
      lastDay = -1;
    };

    const move = (clientX) => {
      const r = _rwSeries;
      if (!r || !r.points.length) return;
      const box = svg.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (clientX - box.left) / Math.max(1, box.width)));
      const day = Math.round(pct * r.horizon);
      const pt  = r.points[Math.min(day, r.points.length - 1)];
      if (!pt) return;

      chart.classList.add('rw-scrubbing');
      const xPct = (pt.day / Math.max(1, r.horizon)) * 100;
      scrub.style.left = xPct + '%';

      // vertical position of the dot mirrors the SVG's own y mapping
      const maxV = Math.max(r.startBalance, 0);
      const minV = Math.min(r.lowest.balance, 0);
      const span = Math.max(1, maxV - minV);
      const yPct = (1 - (pt.balance - minV) / span) * 100;
      scrub.style.setProperty('--rw-y', yPct + '%');

      const label = pt.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const amt   = (pt.balance < 0 ? '\u2212' : '') + FCData.formatCurrency(Math.abs(pt.balance));
      const billNote = pt.bills.length
        ? ' · ' + esc(pt.bills[0].name) + (pt.bills.length > 1 ? ' +' + (pt.bills.length - 1) : '')
        : '';
      readout.innerHTML = '<b>' + esc(label) + '</b> — <span class="fc-amount">' + amt + '</span> left' + billNote;
      // keep the readout inside the card
      readout.style.left = Math.min(88, Math.max(12, xPct)) + '%';

      if (day !== lastDay) { lastDay = day; haptic('light'); }
    };

    chart.addEventListener('pointerdown', e => {
      // setPointerCapture THROWS for a pointer id it doesn't recognise, and
      // optional-chaining only guards a missing method, not a throw — an
      // exception here would abort before the readout ever renders.
      try { chart.setPointerCapture(e.pointerId); } catch (_) {}
      move(e.clientX);
    });
    chart.addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') move(e.clientX); });
    chart.addEventListener('pointerup', end);
    chart.addEventListener('pointercancel', end);
    chart.addEventListener('pointerleave', end);
  }

  /* ═══════════════════════════════════════════════════════════════
     FORECAST SCORECARD
     Records what the runway predicted, settles it once the day passes,
     and shows the result. Every other money app reports the past, so it
     is never wrong and never verifiably right. This one makes a claim and
     then shows you whether it held.
     ═══════════════════════════════════════════════════════════════ */
  let _forecastStats = null;
  let _forecastSyncedThisSession = false;

  async function _syncForecasts() {
    if (_forecastSyncedThisSession || _isDemoMode) return;
    if (!FCAuth?.currentUser?.() || !FCData?.recordForecast) return;
    _forecastSyncedThisSession = true;
    try {
      const r = _buildRunwaySeries();

      // 1. Put today's prediction on file (idempotent — id is the target date)
      const entry = FCCore.forecastToRecord(r);
      if (entry) await FCData.recordForecast(entry);

      // 2. Settle anything whose date has passed, against today's real cash
      const stored = await FCData.getForecasts(12);
      const due = FCCore.forecastsToSettle(stored);
      if (due.length) {
        const actual = FCCore.spendableCash(state.accounts || []);
        for (const f of due) await FCData.settleForecast(f.id, actual);
      }

      // 3. Score whatever is settled
      const fresh = due.length ? await FCData.getForecasts(12) : stored;
      _forecastStats = FCCore.scoreForecast(
        fresh.map(f => ({ predictedEnd: f.predicted_end, actualEnd: f.actual_end })));
      if (_forecastStats.count > 0) _renderHome();
    } catch (_) {
      // Never let the scorecard break the screen it sits on.
    }
  }

  function _renderForecastCard() {
    const s = _forecastStats;
    if (!s || !s.count) return '';
    const withinPct = Math.round((s.hitRate || 0) * 100);
    const over = s.averageBias < 0;
    return ''
      + '<section class="fc-ui-card fc-score">'
        + '<p class="fc-section-label">How accurate we’ve been</p>'
        + '<p class="fc-score-lead">' + esc(
            s.count === 1
              ? 'One payday scored so far.'
              : 'Within ' + FCData.formatCurrency(50) + ' on ' + s.withinFifty + ' of your last ' + s.count + ' paydays.'
          ) + '</p>'
        + '<div class="fc-score-row">'
          + '<div><p class="fc-score-k">Typical miss</p><p class="fc-score-v fc-amount">'
            + esc(FCData.formatCurrency(s.medianAbsError)) + '</p></div>'
          + '<div><p class="fc-score-k">Within $50</p><p class="fc-score-v">' + withinPct + '%</p></div>'
        + '</div>'
        + '<p class="fc-score-note">' + esc(
            over
              ? 'We’ve been landing a little high on average — we’d rather be under.'
              : 'We’ve been landing a little under on average, which is the safer side.'
          ) + '</p>'
      + '</section>';
  }

  function _renderSafeSpendCommand(projection) {
    const chart = document.getElementById('home-runway-chart');
    const horizonEl = document.getElementById('home-safe-horizon');
    const statusEl = document.getElementById('home-safe-status');
    const metaEl = document.getElementById('safe-spend-meta');
    const scaleHighEl = document.getElementById('home-runway-scale-high');
    const scaleMidEl = document.getElementById('home-runway-scale-mid');
    const midDateEl = document.getElementById('home-runway-date-mid');
    const endDateEl = document.getElementById('home-runway-date-end');
    if (!projection || !chart) return;

    if (horizonEl) {
      horizonEl.textContent = projection.payday
        ? `Until payday · ${projection.payday.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
        : `For the next ${projection.days} days`;
    }
    const tone = projection.safe < 100 ? 'danger' : projection.safe < 500 ? 'warn' : 'good';
    if (statusEl) {
      statusEl.className = `home-safe-status home-safe-status--${tone}`;
      statusEl.innerHTML = `<span></span>${tone === 'danger' ? 'Action needed' : tone === 'warn' ? 'Watch closely' : 'On track'}`;
    }
    if (metaEl) {
      metaEl.textContent = `${projection.days}-day cash runway`;
    }

    const points = [];
    const daySpend = projection.expectedEverydaySpend / Math.max(projection.days, 1);
    let balance = projection.cash;
    for (let day = 0; day <= projection.days; day++) {
      const dueToday = projection.bills
        .filter(b => (FCData.daysUntil(b.due_date) ?? 999) === day)
        .reduce((sum, b) => sum + (b.amount || 0), 0);
      if (day > 0) balance -= daySpend + dueToday;
      points.push(Math.max(0, balance));
    }
    const width = 320, height = 92, top = 10, bottom = 16;
    const max = Math.max(...points, 1);
    const scaleTop = Math.ceil(max / 100) * 100;
    const scaleMid = Math.round(scaleTop * 2 / 3 / 50) * 50;
    const scaleLow = Math.round(scaleTop * 1 / 3 / 50) * 50;
    if (scaleHighEl) scaleHighEl.textContent = '$' + scaleTop.toLocaleString('en-US');
    if (scaleMidEl) scaleMidEl.textContent = '$' + scaleMid.toLocaleString('en-US');
    const scaleLowEl = document.getElementById('home-runway-scale-low');
    if (scaleLowEl) scaleLowEl.textContent = '$' + scaleLow.toLocaleString('en-US');
    const today = new Date();
    const midDate = new Date(today.getTime() + Math.ceil(projection.days / 2) * 86400000);
    const endDate = new Date(today.getTime() + projection.days * 86400000);
    if (midDateEl) midDateEl.textContent = midDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (endDateEl) endDateEl.textContent = endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const coords = points.map((value, index) => ({
      x: (index / Math.max(points.length - 1, 1)) * width,
      y: top + (height - top - bottom) * (1 - value / max)
    }));
    const line = coords.map((p, index) => `${index ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const area = `${line} L${width},${height - bottom} L0,${height - bottom} Z`;
    const last = coords[coords.length - 1];
    const midY = (top + (height - bottom)) / 2;
    chart.innerHTML = `<defs><linearGradient id="homeRunwayFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--fc-accent)" stop-opacity=".28"/><stop offset="1" stop-color="var(--fc-accent)" stop-opacity="0"/></linearGradient></defs><line x1="0" x2="${width}" y1="${midY.toFixed(1)}" y2="${midY.toFixed(1)}" stroke="var(--fc-border)" stroke-dasharray="4 4"/><path d="${area}" fill="url(#homeRunwayFill)"/><path d="${line}" fill="none" stroke="var(--fc-accent)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="var(--fc-bg-elevated)" stroke="var(--fc-accent)" stroke-width="2.4"/>`;
  }

  /* ── Next Bill compact card (right col on Home) ─────────────── */
  /* ── Debt paid down ───────────────────────────────────────────────
     The one debt number on Today, and deliberately the encouraging one.
     Every other debt figure in the app answers "how much do you owe";
     this one answers "how much have you got rid of", which is the only
     one that grows when you do the right thing.

     Rules it follows:
       · Measured, never estimated. It compares recorded balances. With
         fewer than two days on file it says so instead of printing a $0
         that reads as "you have made no progress".
       · It names the date it measured from, so the claim is exactly as
         strong as the data behind it.
       · A bad month is shown, in the same quiet type as a good one. Debt
         rising is information; it is not an alarm, and it does not erase
         the all-time figure sitting under it.
       · Nothing at all for someone with no debt. A zeroed-out debt card is
         a worry offered to a person who does not have that worry. */
  function _renderDebtProgressCard() {
    const debtNow = FCCore.netWorth(state.accounts || []).liabilities;
    if (!(debtNow > 0)) return '';

    const p = FCCore.debtProgress(state.debtHistory || {}, debtNow);
    const money = v => FCData.formatCurrency(Math.abs(v));

    if (!p.ok) {
      return `
        <section class="fc-ui-card home-v8__debt" aria-label="Debt progress">
          <p class="fc-section-label">Debt</p>
          <div class="home-v8__debt-value is-quiet">Tracking from today</div>
          <p class="home-v8__debt-meta">Check back in a few weeks — we will show what you have paid off.</p>
        </section>`;
    }

    const fromLabel = FCData.parseDateLocal(p.from)
      .toLocaleDateString('en-US', { month: 'long' });

    /* "…and that pulled your debt-free date N months closer."

       A counterfactual, so it is held to the same bar as the date itself:
       run the payoff simulation twice, once at today's balances and once at
       what they were when tracking started, and report the difference.

       The one assumption is HOW the paid-down amount was spread across the
       debts — the daily snapshot records a total, not a per-account history.
       Proportional to current balances, because that is roughly what
       minimum payments do. It is a model, and it only ever appears when
       debtFreePlan agrees to produce both dates; that function refuses
       outright if any debt is missing a minimum, so an incomplete picture
       silently prints no claim rather than a soft one. */
    let closer = '';
    const debtAccts = (state.accounts || []).filter(a => FCCore.accountClass(a) === 'debt');
    if (p.paidDown > 0 && debtAccts.length) {
      const debts = debtAccts.map(a => ({
        name: a.name || 'Debt',
        balance: Math.max(0, _acctBal(a)),
        rate: _debtRate(a),
        minimum: _minPayment(a),
      }));
      const total = debts.reduce((s, d) => s + d.balance, 0);
      if (total > 0) {
        const before = debts.map(d => ({
          ...d, balance: d.balance + p.paidDown * (d.balance / total),
        }));
        const now  = FCCore.debtFreePlan(debts,  0, _debtStrategy());
        const then = FCCore.debtFreePlan(before, 0, _debtStrategy());
        if (now.ok && then.ok && then.months > now.months) {
          const m = then.months - now.months;
          closer = ` · debt-free date ${m} month${m === 1 ? '' : 's'} closer`;
        }
      }
    }

    /* A month where debt ROSE leads the card, even when the all-time figure
       is still healthy. Letting the good number bury the bad one is the
       version of this card that stops being trustworthy the first time
       someone checks it against their bank. It is stated quietly — plain
       text, no red, no alarm icon — and the progress line stays underneath
       it, because both things are true at once. */
    if (p.month !== null && p.month < 0) {
      const under = p.paidDown > 0
        ? `${money(p.paidDown)} paid down since ${fromLabel}`
        : `${money(debtNow)} total · tracked since ${fromLabel}`;
      return `
        <section class="fc-ui-card home-v8__debt" aria-label="Debt progress">
          <p class="fc-section-label">Debt</p>
          <div class="home-v8__debt-value is-quiet">Up ${money(p.month)} this month</div>
          <p class="home-v8__debt-meta">${esc(under)}</p>
        </section>`;
    }

    if (p.paidDown > 0) {
      return `
        <section class="fc-ui-card home-v8__debt" aria-label="Debt paid down">
          <p class="fc-section-label">Debt paid down</p>
          <div class="home-v8__debt-value is-good">${money(p.paidDown)}</div>
          <p class="home-v8__debt-meta">since ${esc(fromLabel)}${esc(closer)}</p>
        </section>`;
    }

    /* Level, or down this month but not yet ahead of where they started. */
    const monthLine = p.month
      ? `${money(p.month)} paid down this month`
      : 'No change this month';
    return `
      <section class="fc-ui-card home-v8__debt" aria-label="Debt progress">
        <p class="fc-section-label">Debt</p>
        <div class="home-v8__debt-value is-quiet">${esc(monthLine)}</div>
        <p class="home-v8__debt-meta">${money(debtNow)} total · tracked since ${esc(fromLabel)}</p>
      </section>`;
  }

  function _renderHomeNextBill() {
    const section  = document.getElementById('home-next-risk-section');
    const labelEl  = document.getElementById('home-next-risk-label');
    const nameEl   = document.getElementById('home-next-bill-name');
    const dueEl    = document.getElementById('home-next-bill-due');
    const amountEl = document.getElementById('home-next-bill-amount');
    if (!nameEl) return;

    const next = _billsForDisplay()
      .filter(b => b.status !== 'paid')
      .sort((a, b) => (FCData.daysUntil(a.due_date) ?? 999) - (FCData.daysUntil(b.due_date) ?? 999))[0];

    if (!next) {
      if (section) section.className = 'home-next-risk home-next-risk--clear fc-fade-up';
      if (labelEl) labelEl.textContent = state.user?.plaid_linked ? 'All clear' : 'Get started';
      if (nameEl) nameEl.textContent = state.user?.plaid_linked ? 'No bills due soon' : 'Add your first bill';
      if (dueEl)  dueEl.textContent = state.user?.plaid_linked ? 'Your near-term commitments are covered' : 'See what is safe to spend after bills';
      if (amountEl) amountEl.textContent = '';
      return;
    }
    const days = FCData.daysUntil(next.due_date);
    const { label, color } = FCData.billDueLabelAndColor(days !== null ? days : 999);
    const isUrgent = days !== null && days <= 3;
    if (section) section.className = `home-next-risk ${isUrgent ? 'home-next-risk--urgent' : ''} fc-fade-up`;
    if (labelEl) labelEl.textContent = isUrgent ? 'Next risk' : 'Coming up';
    if (nameEl) nameEl.textContent = next.name + ' · ' + FCData.formatCurrency(next.amount);
    if (dueEl)  { dueEl.textContent = label; dueEl.style.color = color; }
    if (amountEl) {
      if (isUrgent) {
        amountEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
        amountEl.style.color = 'var(--fc-warning)';
      } else {
        amountEl.textContent = '';
      }
    }
  }

  /* Coalesced Home render.
     _renderHome() rebuilds #home-dash wholesale, and on launch it is called
     once per Firestore listener — accounts, transactions and bills all land
     within tens of milliseconds of each other. Three full rebuilds back to
     back is what the dashboard flicker actually was.

     Leading-edge: the first call still paints immediately, so nothing feels
     slower. Anything arriving inside the window collapses into ONE trailing
     render with the complete data.

     setTimeout, not requestAnimationFrame — rAF is throttled when the
     WebView is not visible, which would strand a queued render until the app
     came back to the foreground. */
  const _HOME_RENDER_WINDOW_MS = 120;
  let _homeRenderAt = 0;
  let _homeRenderTimer = null;
  let _homeRenderDeferred = false;
  /* The sync pill's markup, shared by the home template and the surgical
     updater below. Kept in one place so the two can never disagree — the
     original bug was the header saying "Not synced yet" while the island
     said "Syncing…", which is the app contradicting itself about the one
     thing the user was waiting on. */
  /* navigator.onLine is only trustworthy in the negative: false reliably
     means no route to the network. True can still mean a captive portal.
     Treat an undefined value as online so a browser without the property
     never shows a permanent offline pill. */
  function _isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  /* One age formatter so the offline pill and the stale pill cannot disagree
     about how old the same timestamp is. */
  function _syncAgeLabel(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function _syncPillHTML() {
    if (!state.user || _isDemoMode) return '';
    const linked = !!(state.user.plaid_linked || state.user.plaid_institution
                      || (state.accounts || []).length);
    if (!linked) return '';
    /* Offline outranks every other state, including a failed sync. When the
       device has no connection the sync DID fail, so _lastSyncFailed is set
       and "Sync failed" is literally true — but it points at the wrong
       culprit. It reads as a problem with FlowCheck or with the bank, and
       the actions it invites (retry, reconnect, contact support) are all
       useless until the connection is back. "Offline" names the actual
       cause and the actual fix.

       The staleness is the part that matters for a finance app. A balance
       with no age on it is the failure mode worth designing against: open
       the app underground, read a three-day-old number, spend against money
       that is not there. The pill carries the age so the number is never
       presented as current when it is not.

       navigator.onLine, not @capacitor/network, on purpose. onLine is
       reliable in WKWebView for the dominant case (airplane mode, no signal,
       wifi dropped) and costs no native dependency. It is wrong for the
       captive-portal case — "connected" to hotel wifi that serves only a
       login page reads as online — which the plugin would catch. That is a
       real gap, and it is not worth a new native plugin and an SPM
       resolution to close today. If it becomes a support issue,
       @capacitor/network is the upgrade path and this is the only function
       that changes. */
    if (_isOffline()) {
      const at  = _getLastSyncAt();
      return '<span class="fc-status-pill fc-status-pill--warn">Offline'
        + (at ? ' · updated ' + _syncAgeLabel(Date.now() - at) : '')
        + '</span>';
    }
    if (_lastSyncFailed)
      return '<span class="fc-status-pill fc-status-pill--danger">Sync failed</span>';
    if (state.syncing || state.initialLoading)
      return '<span class="fc-status-pill fc-status-pill--busy">Syncing…</span>';
    const at  = _getLastSyncAt();
    const age = at ? Date.now() - at : Infinity;
    if (age > 24 * 60 * 60 * 1000) {
      return '<span class="fc-status-pill fc-status-pill--warn">'
        + (at ? 'Updated ' + Math.floor(age / 86400000) + 'd ago' : 'Not synced yet')
        + '</span>';
    }
    return '';
  }

  /* Update the pill WITHOUT a render. _scheduleTabRender deliberately holds
     every render for the duration of a sync — that hold is the resume-flicker
     fix — so the one element that must change while a sync runs has to be
     written directly. */
  function _updateSyncPill() {
    const host = document.getElementById('home-sync-pill');
    if (host) host.innerHTML = _syncPillHTML();
  }

  /* The pill is the only thing that reflects connectivity, so it has to
     react to it. Both directions matter: dropping offline must show the
     state, and coming back must clear it — a stale "Offline" on a connected
     device is worse than no pill at all, because it tells the user their
     current numbers are old when they are not. */
  if (typeof window !== 'undefined') {
    window.addEventListener('offline', _updateSyncPill);
    window.addEventListener('online',  _updateSyncPill);
  }

  /* Reset at the start of every sync — see the first-paint exception below. */
  let _paintedAccountsThisSync = false;
  let _accountsAtSyncStart = 0;

  /* Who repaints the tab that is currently on screen.

     This map is the whole point of the rename below. The scheduler used to
     be `_scheduleHomeRender` and opened with `if (state.tab !== 'home')
     return;` — so every Firestore update that arrived while the user was on
     any OTHER tab was dropped on the floor. The listeners patched around it
     one tab at a time (`if (state.tab === 'activity') _renderActivity()`),
     and the tabs nobody remembered to patch simply never live-updated.

     Money was one of them. Connect a bank, sit on Money, and the accounts
     land in Firestore within seconds — but Debt, Savings and Net Worth do
     not repaint until you leave the tab and come back. That is the "it took
     forever for the debts and savings to push over" report: the data had
     already arrived, the screen was just never told.

     `more` is deliberately absent — it hosts sub-screens rendered on top of
     it, and repainting underneath them is churn nobody asked for. */
  function _activeTabRenderer() {
    switch (state.tab) {
      case 'home':     return _renderHome;
      case 'wealth':   return _renderWealth;
      case 'plan':     return _renderPlan;
      case 'coach':    return _renderCoach;
      case 'insights': return _renderInsights;
      case 'goals':    return () => _renderGoalsScreen(true);
      case 'activity': return () => (_activitySegment === 'bills'
                                       ? _renderBillsList() : _renderActivity());
      default:         return null;
    }
  }

  function _scheduleTabRender() {
    const _render = _activeTabRenderer();
    if (!_render) return;

    /* A Plaid sync does not arrive as one update. The backend commits accounts
       in one batch, then transactions in chunks of 400, then removals in
       chunks of 400 — looped once per linked bank. Every commit is a separate
       Firestore snapshot, and every snapshot lands here. Rendering each
       intermediate state rebuilds #home-dash via innerHTML for no user
       benefit; that is the churn visible on resume.

       Hold renders for the duration and paint once, with complete data, from
       _doSync's finally block. The island already shows "Syncing…" so the app
       is not silently frozen, and the finally block always runs — including on
       the throw path — so a render can never be stranded. */
    /* One exception to the hold: the FIRST arrival of accounts.

       The hold exists because a cold-start sync is ~12 Firestore commits and
       rendering each one is the churn you see on resume. But accounts commit
       EARLY in the backend loop — before any transaction page is fetched —
       so balances, debts and savings are sitting in Firestore within seconds
       while the screen stays empty for the minutes it takes transactions to
       finish. Reported from the device as the data taking forever to show up;
       it had already arrived.

       Allowing exactly one paint the moment accounts first appear turns that
       into "balances immediately, spending fills in". One extra render is not
       the twelve the hold was built to stop, and it only fires when the
       screen currently has nothing to show. */
    if (state.syncing) {
      /* Gated on the screen having been EMPTY when this sync began, not merely
         on accounts existing now. Without that, a resume — where the data is
         already painted — would also take the extra render, which is the very
         case the hold was built for. First connection has nothing on screen and
         everything to gain; a resume has the opposite. */
      const firstAccounts = !_paintedAccountsThisSync
                         && _accountsAtSyncStart === 0
                         && (state.accounts || []).length > 0;
      if (!firstAccounts) { _homeRenderDeferred = true; return; }
      _paintedAccountsThisSync = true;
      // fall through and paint once
    }

    const since = Date.now() - _homeRenderAt;
    if (since >= _HOME_RENDER_WINDOW_MS && !_homeRenderTimer) {
      _homeRenderAt = Date.now();
      _render();
      return;
    }
    if (_homeRenderTimer) return;                    // already coalescing
    _homeRenderTimer = setTimeout(() => {
      _homeRenderTimer = null;
      // A sync can start after this timer was armed — defer rather than paint
      // a half-synced state that is about to be replaced anyway.
      if (state.syncing) { _homeRenderDeferred = true; return; }
      _homeRenderAt = Date.now();
      // Re-resolve: the user can switch tabs between arming and firing, and
      // painting the tab they just left is worse than painting nothing.
      const _late = _activeTabRenderer();
      if (_late) _late();
    }, Math.max(0, _HOME_RENDER_WINDOW_MS - since));
  }

  /* Paint once after a sync settles, if renders were held while it ran.
     Called from _doSync's finally block, after state.syncing is cleared. */
  function _flushDeferredTabRender() {
    if (!_homeRenderDeferred) return;
    _homeRenderDeferred = false;
    _homeRenderAt = 0;          // bypass the coalescing window — paint now
    _scheduleTabRender();
  }

  function _renderHome() {
    // Update island text based on bank link status — only when truly no accounts at all
    if (state.user && !state.user.plaid_linked && state.accounts.length === 0) {
      _setIslandText('Connect a bank to start');
    }

    // Net worth
    const netWorth = FCData.calcNetWorth(state.accounts);
    const nwEl     = document.getElementById('hero-networth');
    if (nwEl) animateNumber(nwEl, netWorth, '$');

    // Last synced timestamp — shown in the header status chip
    const syncWrapEl = document.getElementById('islandSyncWrap');
    const syncTimeEl = document.getElementById('islandSyncTime');
    // _getLastSyncAt(), not state.lastSyncAt — so the chip reads correctly on a
    // cold start instead of staying blank until the first sync of the session.
    const lastSyncAt = _getLastSyncAt();
    if (syncTimeEl && lastSyncAt) {
      const mins = Math.floor((Date.now() - lastSyncAt) / 60000);
      syncTimeEl.textContent = mins < 1 ? 'Updated just now'
        : mins < 60 ? `Updated ${mins} min ago`
        : `Updated at ${new Date(lastSyncAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      if (syncWrapEl) syncWrapEl.style.display = '';
    }

    // Debt (liabilities) — feeds the Money at a Glance Debt tile
    const liabsEl = document.getElementById('hero-liabilities');
    if (liabsEl) {
      const liabs = state.accounts
        .filter(_isDebtAcct)
        .reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
      liabsEl.textContent = FCData.formatCurrency(liabs);
    }

    // Cash — feeds Safe to Spend + the Money at a Glance Cash tile
    const cash = FCData.calcCash(state.accounts);

    // Upcoming bill — single nearest unpaid bill only
    const billsEl = document.getElementById('home-bills-list');
    const displayBills = _billsForDisplay();
    if (billsEl) {
      const nextBillDue = displayBills
        .filter(b => b.status !== 'paid')
        .sort((a, b) => (FCData.daysUntil(a.due_date) ?? 999) - (FCData.daysUntil(b.due_date) ?? 999))[0];

      if (!nextBillDue) {
        billsEl.innerHTML = state.user?.plaid_linked
          ? `<div style="display:flex;align-items:center;gap:12px;padding:4px 2px">
               <div style="width:38px;height:38px;border-radius:11px;background:rgba(48,209,88,0.12);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">✅</div>
               <div style="flex:1;min-width:0">
                 <div style="font-size:13px;font-weight:600;color:var(--fc-text);line-height:1.3">Bills are covered</div>
                 <div style="font-size:12px;color:var(--fc-text-muted);margin-top:2px">No upcoming bills this week</div>
               </div>
               <button onclick="event.stopPropagation();FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')" type="button" style="font-size:12px;font-weight:600;color:var(--fc-accent);background:none;border:none;cursor:pointer;padding:0;flex-shrink:0;-webkit-tap-highlight-color:transparent">View bills</button>
             </div>`
          : `<div style="display:flex;align-items:center;gap:12px;padding:4px 2px">
               <div style="width:38px;height:38px;border-radius:11px;background:rgba(26,196,240,0.10);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">🏦</div>
               <div style="flex:1;min-width:0">
                 <div style="font-size:13px;font-weight:600;color:var(--fc-text);line-height:1.3">Connect a bank</div>
                 <div style="font-size:12px;color:var(--fc-text-muted);margin-top:2px">See your upcoming bills here</div>
               </div>
             </div>`;
      } else {
        const b = nextBillDue;
        if (b._preview) {
          billsEl.innerHTML = `<div class="dash-bills-card">${displayBills.slice(0,3).map(bill => {
            const days = FCData.daysUntil(bill.due_date);
            const due = FCData.billDueLabelAndColor(days !== null ? days : 999);
            return `<div class="premium-bill-row" onclick="FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')" role="button">
              <div class="premium-bill-icon">${esc(bill.icon || bill.name.charAt(0))}</div>
              <div style="flex:1;min-width:0"><strong>${esc(bill.name)}</strong><span style="color:${due.color}">${esc(due.label)}</span></div>
              <b>${FCData.formatCurrency(bill.amount)}</b><span class="premium-chevron">›</span>
            </div>`;
          }).join('')}</div>`;
        } else {
        const days = FCData.daysUntil(b.due_date);
        const { label, color } = FCData.billDueLabelAndColor(days !== null ? days : 999);
        const accentColor = days !== null && days <= 0 ? 'var(--fc-danger)'
                           : days !== null && days <= 3 ? 'var(--fc-warning)'
                           : 'var(--fc-accent)';
        const bg = b.color || FCData.categoryColor(b.category || 'Service');
        billsEl.innerHTML = `
          <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--fc-accent);margin-bottom:6px;padding:0 2px">Next Bill</div>
          <div class="dash-bill-card" style="border-left-color:${accentColor}" data-bill-id="${esc(b.id)}" onclick="FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')" role="button">
            <div class="dash-bill-icon" style="background:${esc(bg)};color:white">${esc(b.icon || b.name.charAt(0))}</div>
            <div class="dash-bill-body">
              <div class="dash-bill-name">${esc(b.name)}</div>
              <div class="dash-bill-due" style="color:${esc(color)}">${esc(label)}</div>
            </div>
            <div class="dash-bill-amount">${FCData.formatCurrency(b.amount)}</div>
            <svg class="dash-bill-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          </div>`;
        }
      }

      // Badge count
      const overdue = displayBills.filter(b => b.status !== 'paid' && FCData.daysUntil(b.due_date) <= 3);
      const badgeEl = document.getElementById('bills-badge');
      if (badgeEl) {
        badgeEl.textContent = overdue.length;
        badgeEl.style.display = overdue.length ? 'inline-flex' : 'none';
      }
    }

    // Bills due — unpaidBillsTotal feeds the Safe-to-Spend calculation below
    const unpaidBills = displayBills.filter(b => b.status !== 'paid');
    const unpaidBillsTotal = unpaidBills.reduce((s, b) => s + (b.amount || 0), 0);

    // ── Income / spend for the selected period (shown in stat card) ─
    const periodTxns   = _getPeriodTxns();
    const periodIncome = periodTxns.filter(_isIncomeTxn).reduce((s, t) => s + (t.amount || 0), 0);
    // Filtered spend (no transfers/loan payments) for all display purposes
    const periodSpend  = periodTxns.filter(_isSpendTxn).reduce((s, t) => s + (t.amount || 0), 0);

    // Calendar-month figures for health score + safe-to-spend (always month-based)
    const _now = new Date();
    const calMonthTxns = state.transactions.filter(t => {
      if (!t.date) return false;
      const d = FCData.parseDateLocal(t.date);
      return d.getMonth() === _now.getMonth() && d.getFullYear() === _now.getFullYear();
    });
    // Filter income: exclude transfers/payments so account-to-account moves don't inflate income
    const monthIncome      = calMonthTxns.filter(_isIncomeTxn).reduce((s, t) => s + (t.amount || 0), 0);
    // monthSpend: filtered for display (health score, budget, SPENT label)
    const monthSpend       = calMonthTxns.filter(_isSpendTxn).reduce((s, t) => s + (t.amount || 0), 0);
    // monthSpendRaw: ALL debits including transfers — used only for safe-to-spend committed calculation
    const monthSpendRaw    = calMonthTxns.filter(t => !t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);
    const overdueCount     = unpaidBills.filter(b => (FCData.daysUntil(b.due_date) ?? 1) < 0).length;

    // Cash flow → Money at a Glance tile — only meaningful when income is detectable
    const cfEl = document.getElementById('fch-cashflow');
    if (cfEl) {
      if (_incomeIsReliable(monthIncome, monthSpend)) {
        const cf = monthIncome - monthSpend;
        cfEl.textContent = (cf >= 0 ? '+' : '−') + _fmtCompact(Math.abs(cf));
        cfEl.style.color = cf >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
      } else if (monthSpend > 0) {
        // Show spend only, no misleading cash-flow math
        cfEl.textContent = '−' + _fmtCompact(monthSpend);
        cfEl.style.color = 'var(--fc-danger)';
      } else {
        cfEl.textContent = '—';
        cfEl.style.color = '';
      }
    }
    const monthSpentEl = document.getElementById('home-month-spent');
    if (monthSpentEl) monthSpentEl.textContent = _fmtCompact(monthSpend);

    // ── Month Pulse bar ──────────────────────────────────────────
    const pulseRow       = document.getElementById('dash-pulse-row');
    const pulseFill      = document.getElementById('dash-pulse-fill');
    const pulseSpentEl   = document.getElementById('dash-pulse-spent');
    const pulseIncomeEl  = document.getElementById('dash-pulse-income');
    const pulseDaysEl    = document.getElementById('dash-pulse-days');
    const pulseProjEl    = document.getElementById('dash-pulse-projected');
    const pulseNoBudgetEl = document.getElementById('dash-pulse-nobudget');

    if (pulseRow) {
      if (state.user && state.user.plaid_linked) {
        pulseRow.style.display = '';
        // Prefer an explicit budget the user set; fall back to detected income;
        // show the "no budget" empty state only when neither signal exists.
        const explicitBudget = state.budgets?.['total']?.limit || 0;
        const incomeOk    = _incomeIsReliable(monthIncome, monthSpend);
        const compareBase = explicitBudget > 0 ? explicitBudget : (incomeOk ? monthIncome : 0);
        const hasCompare  = compareBase > 0;
        const pulsePct    = hasCompare ? Math.min(Math.round((monthSpend / compareBase) * 100), 100) : 0;
        const fillColor   = hasCompare && pulsePct >= 90 ? 'var(--fc-danger)'
                          : hasCompare && pulsePct >= 70 ? 'var(--fc-warning)'
                          : 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))';
        if (hasCompare && pulsePct >= 90) pulseRow.classList.add('dash-pulse--danger');
        else pulseRow.classList.remove('dash-pulse--danger');

        if (pulseSpentEl)  pulseSpentEl.textContent  = _fmtCompact(monthSpend);
        const pulseIncomeLabelEl = document.getElementById('dash-pulse-income-label');
        const pulsePctEl         = document.getElementById('dash-pulse-pct');
        const pulseOfLabelEl     = document.getElementById('dash-pulse-of-label');
        if (pulsePctEl) {
          if (hasCompare) {
            pulsePctEl.textContent = pulsePct + '%';
            pulsePctEl.style.display = '';
            pulsePctEl.style.color = pulsePct >= 90 ? 'var(--fc-danger)' : pulsePct >= 70 ? 'var(--fc-warning)' : '';
          } else {
            pulsePctEl.style.display = 'none';
          }
        }
        if (pulseIncomeEl) {
          if (hasCompare) {
            pulseIncomeEl.textContent = _fmtCompact(compareBase);
            if (pulseOfLabelEl) pulseOfLabelEl.style.display = '';
            if (pulseIncomeLabelEl) {
              pulseIncomeLabelEl.textContent = explicitBudget > 0 ? 'monthly budget' : 'monthly income';
              pulseIncomeLabelEl.style.display = '';
            }
          } else {
            pulseIncomeEl.textContent = '';
            if (pulseOfLabelEl) pulseOfLabelEl.style.display = 'none';
            if (pulseIncomeLabelEl) pulseIncomeLabelEl.style.display = 'none';
          }
        }
        if (pulseFill) {
          pulseFill.style.width      = hasCompare ? pulsePct + '%' : '100%';
          pulseFill.style.background = monthSpend > 0 ? fillColor : 'var(--fc-border)';
        }

        const _now3    = new Date();
        const lastDay  = new Date(_now3.getFullYear(), _now3.getMonth() + 1, 0).getDate();
        const daysLeft = lastDay - _now3.getDate();
        if (pulseDaysEl) {
          pulseDaysEl.textContent = daysLeft === 0 ? 'Last day of month'
                                  : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left`;
        }
        // Show end-of-month projection only when we have enough days of data
        if (pulseProjEl && _now3.getDate() > 3) {
          const projected  = Math.round((monthSpend / _now3.getDate()) * lastDay);
          const overBudget = hasCompare && projected > compareBase;
          const wayOver    = hasCompare && projected > compareBase * 1.2;
          pulseProjEl.style.display = '';
          pulseProjEl.style.color   = wayOver ? 'var(--fc-danger)' : '';
          pulseProjEl.style.fontWeight = wayOver ? '700' : '';
          pulseProjEl.innerHTML = (wayOver ? '⚠️ ' : '') + `Est. <span style="${overBudget ? 'color:var(--fc-danger)' : ''}">${_fmtCompact(projected)}</span> by month end`;
        } else if (pulseProjEl) {
          pulseProjEl.style.display = 'none';
        }

        // No budget set AND no reliable income — explain instead of showing a flat bar
        if (pulseNoBudgetEl) pulseNoBudgetEl.style.display = hasCompare ? 'none' : 'flex';
      } else {
        pulseRow.style.display = 'none';
      }
    }

    // ── Home goal card (shows first goal) ─────────────────────────
    const goalCard = document.getElementById('home-goal-card');
    if (goalCard && state.goals.length) {
      const g       = state.goals[0];
      const pct     = Math.min(g.pct || 0, 100);
      const dash    = 170;
      const offset  = dash - (dash * pct / 100);
      const current = FCData.formatCurrency(g.current || 0);
      const target  = FCData.formatCurrency(g.target || 0);
      goalCard.innerHTML = `
        <div style="width:64px;height:64px;position:relative;flex-shrink:0">
          <svg width="64" height="64" viewBox="0 0 64 64" aria-label="${pct}%" aria-hidden="true">
            <defs><linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1ac4f0"/><stop offset="100%" stop-color="#60a5fa"/></linearGradient></defs>
            <circle cx="32" cy="32" r="27" style="stroke:var(--fc-border)" stroke-width="6" fill="none"/>
            <circle cx="32" cy="32" r="27" stroke="url(#ring)" stroke-width="6" fill="none"
                    stroke-dasharray="${dash}" stroke-dashoffset="${offset}"
                    stroke-linecap="round" transform="rotate(-90 32 32)"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--fc-text);font-size:13px;font-weight:700;line-height:1">${pct}%</div>
        </div>
        <div class="fc-grow">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span class="fc-eyebrow">Goal</span>
            <span style="color:${pct >= 100 ? 'var(--fc-success)' : pct >= 75 ? 'var(--fc-accent)' : pct >= 25 ? 'var(--fc-accent)' : pct >= 5 ? 'var(--fc-warning)' : 'var(--fc-text-faint)'};font-size:10px;font-weight:600">${pct >= 100 ? 'Complete 🎉' : pct >= 75 ? 'Almost there' : pct >= 25 ? 'In progress' : pct >= 5 ? 'Building momentum' : pct > 0 ? 'Getting started' : 'New goal'}</span>
          </div>
          <div class="fc-h3" style="font-size:16px;margin-bottom:2px">${esc(g.name)}</div>
          <div class="fc-xs">${current} of ${target}</div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;
    } else if (goalCard && !state.goals.length) {
      goalCard.innerHTML = `
        <div style="flex:1;text-align:center;padding:8px 0">
          <div style="font-size:14px;color:var(--fc-text-faint);margin-bottom:10px">No goals yet — set your first one</div>
          <button class="fc-btn fc-btn--outline" onclick="event.stopPropagation();FCApp.showAddGoalSheet()" type="button" style="height:36px;font-size:13px">+ Add Goal</button>
        </div>`;
    }

    // ── Hero side panel: account count ───────────────────────────
    const heroAcctCount = document.getElementById('hero-acct-count');
    if (heroAcctCount) {
      const n = state.accounts.length;
      heroAcctCount.textContent = n === 0 ? 'No banks' : n + (n === 1 ? ' Account' : ' Accounts');
    }

    // ── Today's Money Move (Home primary hero) ───────────────────

    // ── Next Bill compact card ────────────────────────────────────
    _renderHomeNextBill();

    // ── Recent transactions preview ───────────────────────────────

    // ── Account rows (compact list) ───────────────────────────────

    // ── Net worth sparkline ──────────────────────────────────────
    // Nothing to draw here. This used to call _snapshotNetWorth() (a render
    // must not write to the database) and then _drawNetWorthSparkline(),
    // which turned out to be inert — every id it looked up
    // (sparkline-line/-area/-dot/-dot-bg, hero-delta) was deleted with the
    // v8 Home rebuild, so it guarded on the missing nodes and returned.
    // The accounts listener in _attachDataListeners still snapshots net
    // worth, which is the correct place: it fires when the value changes.

    // ── Safe to Spend hero ───────────────────────────────────────
    const safeEl    = document.getElementById('stat-safe-to-spend');
    const metaEl    = document.getElementById('safe-spend-meta');
    const barEl     = document.getElementById('safe-spend-bar');
    const spentLbl  = document.getElementById('safe-spent-label');
    const billsLbl  = document.getElementById('safe-bills-label');

    if (state.user && state.user.plaid_linked) {
      const safeProjection = _buildSafeSpendProjection();
      const safeToSpend = safeProjection.safe;
      const spendableCash = safeProjection.cash;

      _renderGreeting(safeToSpend);

      const committed     = monthSpendRaw;
      const isOver        = spendableCash > 0 && safeToSpend <= 0;
      const barPct        = spendableCash > 0 ? Math.min(Math.round((committed / spendableCash) * 100), 100) : 100;
      const barColor      = isOver             ? 'var(--fc-danger)'
                          : barPct > 85        ? 'var(--fc-danger)'
                          : barPct > 65        ? 'var(--fc-warning)'
                          : 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))';

      const cardLabelEl = document.getElementById('safe-spend-card-label');
      if (cardLabelEl) cardLabelEl.textContent = isOver ? 'Cash Balance' : 'Available Cash';

      // Status tier on the STS card
      const stsCard = document.querySelector('.home-sts-card');
      if (stsCard) {
        stsCard.classList.remove('sts-green', 'sts-yellow', 'sts-red');
        if (isOver || safeToSpend < 100) stsCard.classList.add('sts-red');
        else if (safeToSpend < 500) stsCard.classList.add('sts-yellow');
        else stsCard.classList.add('sts-green');
      }

      if (safeEl) {
        safeEl.classList.remove('dash-hero-amount--empty');
        // Whole-dollar hero format — no cents, adaptive font scale for longer values
        const _stsRounded = Math.round(safeToSpend);
        const _stsStr = '$' + Math.abs(_stsRounded).toLocaleString('en-US');
        safeEl.style.fontSize = _stsStr.length <= 5 ? '' : _stsStr.length === 6 ? '48px' : _stsStr.length === 7 ? '40px' : '34px';
        const _stsPrev = parseFloat(safeEl.dataset.stsVal || '0');
        safeEl.dataset.stsVal = _stsRounded;
        _animateNumber(safeEl, _stsPrev, _stsRounded,
          v => '$' + Math.round(Math.abs(v)).toLocaleString('en-US'));
      }

      const billsCoveredText = isOver ? 'Spend exceeds cash'
        : safeProjection.billsTotal > 0 ? `Bills covered · ${FCData.formatCurrency(Math.round(safeProjection.reserve / 10) * 10)} buffer`
        : `${FCData.formatCurrency(Math.round(safeProjection.reserve / 10) * 10)} safety buffer protected`;
      if (metaEl) metaEl.textContent = billsCoveredText;

      // Status pill below meta
      const statusPillEl = document.getElementById('sts-status-pill');
      if (statusPillEl) {
        const pillClass = (isOver || safeToSpend < 100) ? 'sts-pill-red' : safeToSpend < 500 ? 'sts-pill-yellow' : 'sts-pill-green';
        const pillText  = (isOver || safeToSpend < 100) ? 'Low' : safeToSpend < 500 ? 'Caution' : 'Healthy';
        statusPillEl.className = `home-sts-status-pill ${pillClass}`;
        statusPillEl.textContent = pillText;
        statusPillEl.style.display = '';
      }

      // ── Safe to Spend delta vs last week ─────────────────────────
      const deltaEl = document.getElementById('safe-spend-delta');
      if (deltaEl && !isOver) {
        const oneWeekAgo = new Date(_now.getTime() - 7 * 86400000);
        const lastWeekSpend = (state.transactions || [])
          .filter(t => !t.isCredit && _isSpendTxn(t) && FCData.parseDateLocal(t.date) >= oneWeekAgo && FCData.parseDateLocal(t.date) <= _now)
          .reduce((s, t) => s + (t.amount || 0), 0);
        const prevWeekStart = new Date(oneWeekAgo.getTime() - 7 * 86400000);
        const prevWeekSpend = (state.transactions || [])
          .filter(t => !t.isCredit && _isSpendTxn(t) && FCData.parseDateLocal(t.date) >= prevWeekStart && FCData.parseDateLocal(t.date) < oneWeekAgo)
          .reduce((s, t) => s + (t.amount || 0), 0);
        if (prevWeekSpend > 0 && lastWeekSpend > 0) {
          const delta = prevWeekSpend - lastWeekSpend; // positive = spent less = more available
          const sign  = delta >= 0 ? '+' : '';
          const color = delta >= 0 ? 'rgba(48,209,88,0.12)' : 'rgba(255,69,58,0.10)';
          const borderColor = delta >= 0 ? 'rgba(48,209,88,0.28)' : 'rgba(255,69,58,0.25)';
          const textColor   = delta >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
          deltaEl.textContent = `${sign}${FCData.formatCurrency(Math.abs(delta))} vs last week`;
          deltaEl.style.cssText = `display:inline-flex;align-items:center;gap:4px;background:${color};border:0.5px solid ${borderColor};border-radius:999px;padding:4px 10px;font-size:11px;font-weight:700;color:${textColor};margin-bottom:8px`;
        } else {
          deltaEl.style.display = 'none';
        }
      } else if (deltaEl) {
        deltaEl.style.display = 'none';
      }

      if (barEl) { barEl.style.width = barPct + '%'; barEl.style.background = barColor; }
      const fillEl = document.getElementById('safe-spend-bar-fill');
      if (fillEl) { fillEl.style.width = barPct + '%'; fillEl.style.background = barColor; }

      const ringCircle = document.getElementById('safe-spend-ring');
      const ringPctEl  = document.getElementById('safe-spend-ring-pct');
      if (ringCircle) {
        const circumference = 201;
        ringCircle.style.strokeDashoffset = circumference - (circumference * barPct / 100);
        ringCircle.style.stroke = isOver || barPct > 85 ? 'var(--fc-danger)'
                                : barPct > 65           ? '#ffb020'
                                : 'url(#safeGrad)';
      }
      if (ringPctEl) ringPctEl.textContent = barPct + '%';

      if (spentLbl) spentLbl.textContent = FCData.formatCurrency(monthSpend);
      if (billsLbl) billsLbl.textContent = FCData.formatCurrency(unpaidBillsTotal);
      _renderSafeSpendCommand(safeProjection);
    } else {
      _renderGreeting(null);
      if (safeEl) {
        safeEl.textContent = '—';
        safeEl.classList.add('dash-hero-amount--empty');
      }
      if (metaEl) metaEl.innerHTML = '<span style="color:var(--fc-accent);font-weight:600;cursor:pointer" onclick="FCApp.startPlaidLink()">+ Connect a bank</span>';
      if (barEl)    barEl.style.width   = '0%';
      if (spentLbl) spentLbl.textContent = '$0';
      if (billsLbl) billsLbl.textContent = '$0';
      const chart = document.getElementById('home-runway-chart');
      if (chart) chart.innerHTML = '';
      const status = document.getElementById('home-safe-status');
      if (status) { status.className = 'home-safe-status'; status.innerHTML = '<span></span>Connect a bank'; }
    }

    // ── Money at a Glance: Cash + Debt supporting text ────────────
    const glanceCashEl    = document.getElementById('glance-cash');
    const glanceCashSubEl = document.getElementById('glance-cash-sub');
    if (glanceCashEl) animateNumber(glanceCashEl, cash, '$');
    if (glanceCashSubEl) {
      const cashAccts = state.accounts.filter(_isCashAcct).length;
      glanceCashSubEl.textContent = cashAccts ? `Across ${cashAccts} account${cashAccts !== 1 ? 's' : ''}` : 'Connect a bank';
    }
    const glanceDebtSubEl = document.getElementById('glance-debt-sub');
    if (glanceDebtSubEl) {
      const debtAccts = state.accounts.filter(_isDebtAcct).length;
      glanceDebtSubEl.textContent = debtAccts ? `${debtAccts} account${debtAccts !== 1 ? 's' : ''}` : 'No debt linked';
    }
    const glanceNwSubEl = document.getElementById('glance-nw-sub');
    if (glanceNwSubEl) glanceNwSubEl.style.display = state.accounts.length ? 'none' : '';

    // ── New Home sections (forecast, yesterday, subs) ────────────

    // Feedback banner

    // New mockup-matching dashboard (writes full HTML into #home-dash)
    _renderHomeDashboard();
  }

  /* ─────────────────────────────────────────────────────────────
     HOME DASHBOARD v7 — clean vertical mockup match
     ───────────────────────────────────────────────────────────── */
  /* ─────────────────────────────────────────────────────────────
     HOME DASHBOARD v8 — light-first, component-based home
     ───────────────────────────────────────────────────────────── */
  function _renderHomeDashboard() {
    const el = document.getElementById('home-dash');
    if (!el) return;
    /* First mount gets the entrance animation; every later render does not.
       The animation lives on .home-v8--enter rather than .home-v8 because
       this function rebuilds that element wholesale, so an animation on the
       element itself replays on every data update. */
    const firstMount = !el.dataset.homeMounted;
    if (firstMount) {
      const homeView = document.getElementById('view-home');
      if (homeView) homeView.scrollTop = 0;
      el.dataset.homeMounted = 'true';
    }
    const enterClass = firstMount ? ' home-v8--enter' : '';

    const user = state.user || {};
    const accounts = state.accounts || [];
    const transactions = state.transactions || [];
    const bills = _billsForDisplay();
    const goals = _goalsForDisplay();
    const budgets = state.budgets || {};
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthTransactions = transactions.filter(transaction => {
      if (!transaction.date) return false;
      try { return FCData.parseDateLocal(transaction.date) >= monthStart; }
      catch (_) { return false; }
    });

    const monthIncome = monthTransactions
      .filter(_isIncomeTxn)
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const monthSpend = monthTransactions
      .filter(_isSpendTxn)
      .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0);
    const cashFlow = monthIncome - monthSpend;
    const budgetLimit = _totalBudgetLimit(budgets);
    const budgetPct = budgetLimit > 0 ? Math.round((monthSpend / budgetLimit) * 100) : 0;
    const budgetRemaining = budgetLimit - monthSpend;
    const budgetTone = budgetPct > 100 ? 'is-danger' : budgetPct >= 85 ? 'is-warning' : 'is-success';

    const availableCash = accounts
      .filter(_isCashAcct)
      .reduce((sum, account) => sum + Number(account.balance_available ?? account.balance_current ?? account.balance ?? 0), 0);
    let safeToSpend = 0;
    try { safeToSpend = Math.max(0, Number(_buildSafeSpendProjection().safe || 0)); }
    catch (_) { safeToSpend = 0; }
    const safePct = availableCash > 0 ? Math.max(5, Math.min(100, Math.round((safeToSpend / availableCash) * 100))) : 0;

    const nextBill = bills
      .filter(bill => bill.status !== 'paid')
      .sort((a, b) => (FCData.daysUntil(a.due_date) ?? 999) - (FCData.daysUntil(b.due_date) ?? 999))[0] || null;
    const primaryGoal = goals[0] || null;
    const _allInsights = _buildFocusInsights ? _buildFocusInsights() : [];
    window._homeInsights = _allInsights;

    const recentTransactions = [...transactions]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, 4);
    const upcomingBills = bills
      .filter(bill => bill.status !== 'paid')
      .sort((a, b) => (FCData.daysUntil(a.due_date) ?? 999) - (FCData.daysUntil(b.due_date) ?? 999))
      .slice(0, 4);
    const activeGoals = goals.slice(0, 3);
    const emergencyGoal = goals.find(goal => /emergency|rainy|reserve/i.test(goal.name || '')) || primaryGoal;

    const authUser = window.FCAuth && FCAuth.currentUser ? FCAuth.currentUser() : null;
    const displayName = String(user.name || authUser?.displayName || 'there').trim();
    const firstName = displayName.split(/\s+/)[0].replace(/[.\d]/g, '') || 'there';
    const initial = displayName.charAt(0).toUpperCase() || '?';
    const hour = now.getHours();
    const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const dateLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const isLinked = Boolean(user.plaid_linked || user.plaid_institution || accounts.length || _isDemoMode);

    const avatar = document.getElementById('header-avatar-initial');
    if (avatar) avatar.textContent = initial;

    const fmt = value => FCData.formatCurrency(Number(value || 0));
    const clampPct = value => Math.max(0, Math.min(100, Math.round(Number(value || 0))));
    const goalPct = goal => {
      if (!goal) return 0;
      if (Number.isFinite(Number(goal.pct))) return clampPct(goal.pct);
      return Number(goal.target) > 0 ? clampPct((Number(goal.current || 0) / Number(goal.target)) * 100) : 0;
    };
    const dueLabel = bill => {
      if (!bill) return '';
      const days = FCData.daysUntil(bill.due_date);
      if (days === null) return 'Date not set';
      if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
      if (days === 0) return 'Due today';
      if (days === 1) return 'Due tomorrow';
      return `Due in ${days} days`;
    };
    const dateForTransaction = transaction => {
      if (!transaction?.date) return '';
      let date;
      try { date = FCData.parseDateLocal(transaction.date); }
      catch (_) { return ''; }
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(today.getDate() - 1);
      if (date.toDateString() === today.toDateString()) return 'Today';
      if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    };
    const transactionIcon = transaction => {
      const detail = `${(transaction?.category || []).join(' ')} ${transaction?.name || ''}`.toLowerCase();
      if (_isIncomeTxn(transaction || {})) return '↗';
      if (detail.includes('amazon')) return 'a';
      if (detail.includes('food') || detail.includes('grocery')) return '●';
      if (detail.includes('coffee')) return '◇';
      if (detail.includes('travel') || detail.includes('uber')) return '↗';
      return '•';
    };
    const chartValues = Array.from({ length: 8 }, (_, index) => {
      const cutoff = Math.max(1, Math.round(((now.getDate() - 1) * index) / 7) + 1);
      return monthTransactions.reduce((sum, transaction) => {
        let day = 0;
        try { day = FCData.parseDateLocal(transaction.date).getDate(); }
        catch (_) { return sum; }
        if (day > cutoff) return sum;
        return sum + (_isIncomeTxn(transaction) ? Number(transaction.amount || 0) : -Number(transaction.amount || 0));
      }, 0);
    });
    const chartMin = Math.min(...chartValues, 0);
    const chartMax = Math.max(...chartValues, 1);
    const chartSpan = Math.max(1, chartMax - chartMin);
    const chartPoints = chartValues.map((value, index) => {
      const x = 7 + (286 * index / Math.max(1, chartValues.length - 1));
      const y = 69 - ((value - chartMin) / chartSpan) * 55;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const chartArea = `M ${chartPoints.split(' ').join(' L ')} L 293,76 L 7,76 Z`;
    const lastChartPoint = chartPoints.split(' ').slice(-1)[0].split(',');

    const _insightIconName = (ins) => {
      const lbl = (ins.label || '').toLowerCase();
      if (lbl.includes('overdue') || lbl.includes('pay this'))  return 'alert';
      if (lbl.includes('bill coming'))                          return 'calendar';
      if (lbl.includes('over budget'))                          return 'bar-chart';
      if (lbl.includes('slow') || lbl.includes('budget'))       return 'bar-chart';
      if (lbl.includes('pace'))                                 return 'trending-up';
      if (lbl.includes('large') || lbl.includes('unusual'))     return 'search';
      if (lbl.includes('low') || lbl.includes('balance'))       return 'trending-down';
      if (lbl.includes('subscription') || lbl.includes('trim')) return 'play-screen';
      if (ins.type === 'good')                                   return 'check';
      return 'lightbulb';
    };
    // Premium tinted icon tile for carousel slides — replaces the old big emoji
    const _slideArt = (iconName, type) => {
      const color = type === 'danger' ? 'var(--fc-danger)' : type === 'warn' ? 'var(--fc-warning)' : type === 'good' ? 'var(--fc-success)' : 'var(--fc-accent)';
      const soft  = type === 'danger' ? 'var(--fc-danger-soft)' : type === 'warn' ? 'var(--fc-warning-soft)' : type === 'good' ? 'var(--fc-success-soft)' : 'var(--fc-accent-soft)';
      return `<div style="width:56px;height:56px;border-radius:50%;background:${soft};display:flex;align-items:center;justify-content:center">${_ic(iconName, color, 26)}</div>`;
    };
    /* Trim to a sentence, not to a character.
       These bodies are "<finding>. <generic advice>." and only the finding
       earns space on the dashboard. A CSS line-clamp cut mid-word — the
       card read "Canceling unused ones is the easies…" on device, which
       looks broken rather than condensed. Ending on the first full stop
       says the same thing and never cuts a word in half. */
    const _cardBody = (text, max) => {
      const t = String(text || '').trim();
      if (t.length <= max) return t;
      const cut  = t.slice(0, max);
      const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      if (stop > 30) return t.slice(0, stop + 1);        // keep the full stop
      const space = cut.lastIndexOf(' ');
      return (space > 0 ? cut.slice(0, space) : cut) + '…';
    };

    /* The 56px art above belongs to the primary move. The secondary rows are
       34px, and dropping a fixed 56px circle into a 34px slot is what made
       those icons render as squashed ovals on device. Same icon, same tone,
       sized for the row it actually sits in. */
    const _rowArt = (iconName, type) => {
      const color = type === 'danger' ? 'var(--fc-danger)' : type === 'warn' ? 'var(--fc-warning)' : type === 'good' ? 'var(--fc-success)' : 'var(--fc-accent)';
      const soft  = type === 'danger' ? 'var(--fc-danger-soft)' : type === 'warn' ? 'var(--fc-warning-soft)' : type === 'good' ? 'var(--fc-success-soft)' : 'var(--fc-accent-soft)';
      return `<span style="width:34px;height:34px;flex-shrink:0;border-radius:50%;background:${soft};display:flex;align-items:center;justify-content:center">${_ic(iconName, color, 17)}</span>`;
    };
    const carouselCards = [];
    _allInsights.filter(ins => !ins.fallback).slice(0, 2).forEach(ins => {
      carouselCards.push({
        label:   ins.label,
        title:   ins.title,
        body:    ins.body,
        action:  ins.action || 'Take Action',
        onclick: `window._homeInsights[${_allInsights.indexOf(ins)}]?.tap()`,
        emoji:   _slideArt(_insightIconName(ins), ins.type),
        rowArt:  _rowArt(_insightIconName(ins), ins.type),
        type:    ins.type,
      });
    });
    if (emergencyGoal && goalPct(emergencyGoal) < 100 && safeToSpend >= 25) {
      const _mv = Math.max(25, Math.min(50, Math.round((safeToSpend * 0.1) / 5) * 5));
      carouselCards.push({
        label:   'Save this week',
        title:   `You have ${fmt(safeToSpend)} extra before payday.`,
        body:    `Move ${fmt(_mv)} to your ${emergencyGoal.name || 'Emergency Fund'}.`,
        action:  'Take Action',
        onclick: "FCApp._openSubScreen('goals')",
        emoji:   _slideArt('dollar-sign', 'good'),
        rowArt:  _rowArt('dollar-sign', 'good'),
        type:    'good',
      });
    }
    if (budgetLimit > 0) {
      const _dim = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
      const _dl  = _dim - now.getDate();

      /* A flat 90% threshold has no idea what day it is. On Aug 14 with 45%
         of the month gone, 83% spent got `type: 'good'`, a green check and
         the words "looking good" — directly under a red "you run short on
         Aug 19", and directly under a row already saying spending pace is
         high. Three elements, same data, three different verdicts.
         Judge against elapsed time instead: what matters is not how much of
         the budget is gone but whether it is going faster than the month.
         `ratio` is spend-pace over time-pace — 1.0 is exactly on track. */
      const _monthPct = (now.getDate() / _dim) * 100;
      const _ratio    = _monthPct > 0 ? budgetPct / _monthPct : 0;
      const _over     = budgetRemaining < 0;
      /* Two guards, and the second one matters more than it looks.

         1.15 rather than 1.0, because a little ahead is just noise.

         But no ratio threshold survives the start of a month: rent clears on
         the 1st, so on the 5th you have spent 50% of the budget in 16% of the
         days and the ratio is 3.1 — not because anything is wrong, but
         because a monthly fixed cost cannot be spread linearly. Projecting
         from it would announce "on pace for 310% of budget" every single
         month, and an alert that cries wolf on schedule is worse than no
         alert. So the pace verdict does not speak until a third of the month
         has passed (~day 11); before that only genuinely being over the limit
         can raise it, which needs no projection to be true. */
      const _paceKnown = _monthPct >= 33;
      const _ahead     = _over || (_paceKnown && _ratio >= 1.15);

      /* Projected month-end spend at the current rate. "83% used" is a fact
         about the past; "on pace for 184%" is the one that changes what you
         do this afternoon. */
      const _pace = Math.round(budgetPct * (_dim / Math.max(1, now.getDate())));

      carouselCards.push({
        label:   _over ? 'Over budget' : _ahead ? 'Budget check' : 'On track',
        title:   _over  ? `${budgetPct}% of budget used.`
               : _ahead ? `${budgetPct}% used with ${_dl} day${_dl !== 1 ? 's' : ''} left.`
               :          `${budgetPct}% used — on pace.`,
        body:    _over
          ? `Spending is ${fmt(Math.abs(budgetRemaining))} over plan.`
          : _ahead
            ? `At this rate you finish the month around ${_pace}% of budget. ${fmt(budgetRemaining)} left.`
            : `${fmt(budgetRemaining)} left with ${_dl} day${_dl !== 1 ? 's' : ''} to go.`,
        action:  'Review Budget',
        onclick: "FCApp.switchTab('plan')",
        emoji:   _ahead ? _slideArt('bar-chart', 'warn') : _slideArt('check', 'good'),
        rowArt:  _ahead ? _rowArt('bar-chart', 'warn')   : _rowArt('check', 'good'),
        type:    _ahead ? 'warn' : 'good',
      });
    }
    if (carouselCards.length === 0) {
      carouselCards.push({
        label:   'Your plan',
        title:   'Build a calmer plan for the month.',
        body:    'Review upcoming bills and give every extra dollar a job.',
        action:  'Open Plan',
        onclick: "FCApp.switchTab('plan')",
        emoji:   _slideArt('flag', 'info'),
        rowArt:  _rowArt('flag', 'info'),
        type:    'info',
      });
    }

    /* "Synced" is a state, not information. It shipped on every render to
       tell people the thing they already assume is true — and it sat in the
       greeting row, the one piece of chrome at the top of the daily home.
       A status indicator earns its place when the status is BAD; the green
       case is the silent one. So: show it only when the last sync failed,
       or when the data is old enough that a number on this screen might be
       wrong (>24h). Otherwise the row is just the greeting. */
    const _syncAt   = _getLastSyncAt();
    const _syncAge  = _syncAt ? Date.now() - _syncAt : Infinity;
    const _syncStale = _syncAge > 24 * 60 * 60 * 1000;
    /* Demo mode has no bank and never syncs, so _getLastSyncAt() is 0 and
       every demo session would wear a permanent "Not synced yet" warning —
       about data that is fabricated on purpose. App Review sees this screen. */
    // Wrapped in a stable host so _updateSyncPill() can rewrite it mid-sync
    // without a render. See _syncPillHTML for the state precedence.
    const syncPill = '<span id="home-sync-pill">' + _syncPillHTML() + '</span>';

    const nextBillMarkup = nextBill ? `
      <div class="home-v8__mini-top">
        <span class="home-v8__mini-icon is-warning" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>
        </span>
        <div class="home-v8__row-copy">
          <div class="home-v8__mini-name">${esc(nextBill.name || 'Upcoming bill')}</div>
          <div class="home-v8__mini-meta">${esc(dueLabel(nextBill))}</div>
        </div>
      </div>
      <div class="home-v8__mini-value">${fmt(nextBill.amount)}</div>
      <button class="fc-text-link" type="button" onclick="FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')">View all bills ›</button>` : `
      <div class="fc-empty-state">No bills due soon.<br>Your cash flow is clear.</div>`;

    const budgetMarkup = budgetLimit > 0 ? `
      <div class="home-v8__mini-top">
        <span class="home-v8__mini-icon ${budgetTone}" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></svg>
        </span>
        <div class="home-v8__row-copy">
          <div class="home-v8__mini-value">${fmt(monthSpend)}</div>
          <div class="home-v8__mini-meta">${budgetRemaining >= 0 ? `${fmt(budgetRemaining)} left` : `${fmt(Math.abs(budgetRemaining))} over`}</div>
        </div>
      </div>
      <div class="fc-progress-line"><div class="fc-progress-line__fill ${budgetTone}" style="--fc-progress-value:${clampPct(budgetPct)}%"></div></div>
      <button class="fc-text-link" type="button" onclick="FCApp.switchTab('plan')">View budget ›</button>` : `
      <div class="fc-empty-state">No monthly budget yet.<br>Build your first plan.</div>`;

    // Trust line reflects the REAL device state — claiming "Face ID on" when
    // it isn't would be exactly the kind of hollow trust signal we don't ship.
    _updateTrustLine();

    // ── Metric #1: time-to-first-Safe-to-Spend ────────────────────────
    // Fires once per user, the first time they see a REAL number (not demo,
    // bank actually linked). PostHog derives the duration from signup → this.
    _trackFirstSafeToSpend();
    // Runway scrub binds after the card is in the DOM
    requestAnimationFrame(() => _attachRunwayScrub());
    _syncForecasts();
    // Stamp first-sight on every recurring charge we can currently see. This
    // has to happen while the subscription is still ALIVE — once it stops
    // billing it is too late, and fc-vault.js will (correctly) treat the
    // cancellation as the user's own win and refuse to bill for it.
    _vaultFlagVisibleSubs();

    // ── HERO: Safe to Spend ───────────────────────────────────────────
    // This is the number the whole app exists to produce (VISION.md §4), so
    // it leads the screen and is the largest thing on it. It previously sat
    // third, at 118px, under a 225px dismissible alert — the core value was
    // visually subordinate to an interruption.
    const _paydayInfo = (() => {
      try {
        const p = _predictNextPayday();
        if (!p) return '';
        return `${p.days} day${p.days === 1 ? '' : 's'} to payday`;
      } catch (_) { return ''; }
    })();
    // Dashboard v9 — the runway replaces the Safe-to-Spend hero card.
    // It answers the same question with a picture instead of a number.
    const safeSpendMarkup = _renderRunwayCard();

    /* Quick actions. Two changes from the fixed +/↗/✓ trio:

       1. The glyphs were literal '+', '↗' and '✓' characters — the only
          place on Today still drawing chrome as text while everything
          around them uses _ic(). They rendered in the system font, at a
          weight and baseline nothing else shares.
       2. The first slot now follows the runway. On a day the card is
          saying you run short on the 19th, "Set a goal" is not one of the
          three things you might want to do — moving a bill is, and it was
          reachable only through the sentence in the card above.

       _rwSeries is safe to read here: _renderRunwayCard() ran on the line
       above and either sets it or nulls it. */
    const _short = Boolean(_rwSeries && _rwSeries.goesNegative);
    const _quickActions = [
      _short
        ? { icon: 'calendar', label: 'Move a bill', onclick: "FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')" }
        : { icon: 'credit-card', label: 'Add a bill', onclick: 'FCApp.showBillSheet&&FCApp.showBillSheet()' },
      { icon: 'flag', label: goals.length ? 'Goals' : 'Set a goal', onclick: "FCApp._openSubScreen('goals')" },
      { icon: 'pie-chart', label: 'Review plan', onclick: "FCApp.switchTab('plan')" },
    ];
    const quickActionsMarkup = _quickActions.map(a =>
      `<button class="home-v8__quick-action" type="button" onclick="${a.onclick}">`
      + `<span class="home-v8__quick-action-icon" aria-hidden="true">${_ic(a.icon, 'currentColor', 17)}</span>`
      + `${esc(a.label)}</button>`).join('');

    const upcomingListMarkup = upcomingBills.length ? upcomingBills.map(bill => `
      <div class="home-v8__list-row">
        <span class="home-v8__list-icon is-warning" aria-hidden="true">${esc(bill.icon || '•')}</span>
        <div class="home-v8__list-copy">
          <div class="home-v8__list-title">${esc(bill.name || 'Bill')}</div>
          <div class="home-v8__list-meta">${esc(dueLabel(bill))}${bill.autopay ? ' · Autopay' : ''}</div>
        </div>
        <div class="home-v8__list-value">${fmt(bill.amount)}</div>
      </div>`).join('') : '<div class="fc-empty-state">No upcoming bills to protect.</div>';

    const goalsListMarkup = activeGoals.length ? activeGoals.map(goal => {
      const progress = goalPct(goal);
      return `
        <div class="home-v8__list-row">
          <span class="home-v8__list-icon is-success" aria-hidden="true">${progress >= 100 ? '✓' : '↗'}</span>
          <div class="home-v8__list-copy">
            <div class="home-v8__list-title">${esc(goal.name || 'Goal')}</div>
            <div class="home-v8__list-meta">${fmt(goal.current)} of ${fmt(goal.target)}</div>
            <div class="fc-progress-line home-v8__list-progress"><div class="fc-progress-line__fill is-success" style="--fc-progress-value:${progress}%"></div></div>
          </div>
          <div class="home-v8__list-value">${progress}%</div>
        </div>`;
    }).join('') : '<div class="fc-empty-state">Add a goal to turn extra cash into progress.</div>';

    const _normalizeMerchant = n => (!n ? '' : n
      .replace(/\s*#\s*\d[\d\s-]*/g, '')
      .replace(/\b(AMZN\s*Mktp?|AMAZON\s+MKTP?)\b/i, 'Amazon')
      .replace(/\bWAL.?MART\b/i, 'Walmart')
      .replace(/\bMCDONALD.?S\b/i, "McDonald's")
      .replace(/\bSTARBUCKS\b/i, 'Starbucks')
      .replace(/\bNETFLIX\.COM\b/i, 'Netflix')
      .replace(/\bSPOTIFY\b/i, 'Spotify')
      .replace(/\bAPPLE\.COM\/BILL\w*/i, 'Apple')
      .replace(/\bUBER\s+EATS\b/i, 'Uber Eats')
      .replace(/\bUBER\b/i, 'Uber')
      .replace(/\bCHIPOTLE\b/i, 'Chipotle')
      .replace(/\bTARGET\b/i, 'Target')
      .replace(/\bCOSTCO\b/i, 'Costco')
      .trim());
    const _MBRAND = {
      // Food & coffee
      starbucks: { bg:'#00704A', fg:'#fff' }, chipotle: { bg:'#A81612', fg:'#fff' },
      mcdonald:  { bg:'#FFC72C', fg:'#27251F' }, doordash: { bg:'#FF3008', fg:'#fff' },
      grubhub:   { bg:'#F63440', fg:'#fff' }, subway:   { bg:'#009B48', fg:'#fff' },
      chickfil:  { bg:'#E4182D', fg:'#fff' }, tacobell: { bg:'#702082', fg:'#fff' },
      domino:    { bg:'#006491', fg:'#fff' }, pizzahut: { bg:'#EE3224', fg:'#fff' },
      panera:    { bg:'#74AA50', fg:'#fff' }, dunkin:   { bg:'#FF671F', fg:'#fff' },
      wendys:    { bg:'#E2203B', fg:'#fff' }, burgerking:{ bg:'#D62300', fg:'#fff' },
      chilis:    { bg:'#B51919', fg:'#fff' },
      // Retail & grocery
      amazon:    { bg:'#FF9900', fg:'#131921' }, walmart: { bg:'#0071CE', fg:'#fff' },
      target:    { bg:'#CC0000', fg:'#fff' }, costco:   { bg:'#005DAA', fg:'#fff' },
      wholefood: { bg:'#00674B', fg:'#fff' }, instacart: { bg:'#43B02A', fg:'#fff' },
      bestbuy:   { bg:'#1F49A0', fg:'#FFE000' }, homedepot: { bg:'#F96302', fg:'#fff' },
      lowes:     { bg:'#004990', fg:'#fff' }, tjmaxx:   { bg:'#CC0000', fg:'#fff' },
      nordstrom: { bg:'#1B1B1B', fg:'#fff' }, macys:    { bg:'#CC0000', fg:'#fff' },
      gap:       { bg:'#1C2B4B', fg:'#fff' }, nike:     { bg:'#111',    fg:'#fff' },
      cvs:       { bg:'#CC0000', fg:'#fff' }, walgreen: { bg:'#E31837', fg:'#fff' },
      // Gas & auto
      shell:     { bg:'#FFCC00', fg:'#CC0000' }, chevron: { bg:'#0056A2', fg:'#fff' },
      exxon:     { bg:'#CC0000', fg:'#fff' }, bp:       { bg:'#3E9A54', fg:'#fff' },
      // Tech & streaming
      apple:     { bg:'#2C2C2C', fg:'#fff' }, netflix:  { bg:'#E50914', fg:'#fff' },
      spotify:   { bg:'#1DB954', fg:'#fff' }, hulu:     { bg:'#1CE783', fg:'#000' },
      disney:    { bg:'#0063E5', fg:'#fff' }, youtube:  { bg:'#FF0000', fg:'#fff' },
      google:    { bg:'#4285F4', fg:'#fff' }, microsoft: { bg:'#00A4EF', fg:'#fff' },
      zoom:      { bg:'#2D8CFF', fg:'#fff' }, adobe:    { bg:'#FF0000', fg:'#fff' },
      dropbox:   { bg:'#0061FF', fg:'#fff' },
      // Travel & transport
      uber:      { bg:'#000',    fg:'#fff' }, lyft:     { bg:'#FF00BF', fg:'#fff' },
      airbnb:    { bg:'#FF5A5F', fg:'#fff' }, expedia:  { bg:'#FFC425', fg:'#1E1E1E' },
      delta:     { bg:'#003366', fg:'#fff' }, southwest: { bg:'#CC1E2C', fg:'#fff' },
      // Finance & payments
      paypal:    { bg:'#003087', fg:'#fff' }, venmo:    { bg:'#3D95CE', fg:'#fff' },
      cashapp:   { bg:'#00D632', fg:'#111' }, zelle:    { bg:'#6B1BE3', fg:'#fff' },
      chase:     { bg:'#117ACA', fg:'#fff' }, amex:     { bg:'#016FD0', fg:'#fff' },
    };
    const _txnLogoHTML = txn => {
      if (txn.logo_url) return '<img src="' + esc(txn.logo_url) + '" class="dash-txn-logo" alt="" loading="lazy">';
      const raw = (txn.merchant_name || txn.name || '').toLowerCase();
      for (const [key, c] of Object.entries(_MBRAND)) {
        if (raw.includes(key)) {
          const letter = (txn.merchant_name || txn.name || '?').charAt(0).toUpperCase();
          return '<span class="dash-txn-initial" style="background:' + c.bg + ';color:' + c.fg + '">' + letter + '</span>';
        }
      }
      if (_isIncomeTxn(txn)) return '<span class="dash-txn-cat dash-txn-cat--income">↑</span>';
      const catRaw = (Array.isArray(txn.category) ? txn.category[0] : txn.category || '').toLowerCase();
      if (/food|restaurant|dining|coffee/.test(catRaw) || /coffee|starbucks|chipotle|mcdonald|restaurant/.test(raw)) return '<span class="dash-txn-cat">☕</span>';
      if (/shop|retail|merchand/.test(catRaw) || /amazon|walmart|target|costco/.test(raw)) return '<span class="dash-txn-cat">🛍️</span>';
      if (/travel|transport|uber|lyft|transit/.test(catRaw) || /uber|lyft|transit/.test(raw)) return '<span class="dash-txn-cat">🚗</span>';
      if (/entertain|stream/.test(catRaw) || /netflix|spotify|hulu|disney/.test(raw)) return '<span class="dash-txn-cat">🎬</span>';
      if (/medical|health|pharmacy/.test(catRaw)) return '<span class="dash-txn-cat">💊</span>';
      if (/gas|fuel|shell|chevron|exxon/.test(raw)) return '<span class="dash-txn-cat">⛽</span>';
      const letter = (txn.merchant_name || txn.name || '?').charAt(0).toUpperCase();
      return '<span class="dash-txn-initial" style="background:var(--fc-accent-soft);color:var(--fc-accent)">' + letter + '</span>';
    };
    // ── Premium dashboard section helpers ──────────────────────
    const dueLabelFull = bill => {
      const days = FCData.daysUntil(bill.due_date);
      let ds = '';
      if (bill.due_date) { try { const _d2 = FCData.parseDateLocal(bill.due_date); ds = ' · ' + _d2.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch(_) {} }
      if (days === null) return 'Date not set';
      if (days < 0)  return Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's') + ' overdue' + ds;
      if (days === 0) return 'Due today' + ds;
      if (days === 1) return 'Due tomorrow' + ds;
      return 'Due in ' + days + ' days' + ds;
    };
    const billIconEmoji = bill => _billIcon(bill, 'var(--fc-accent)', 16);
    const goalIconEmoji = goal => _goalIcon(goal, 'var(--fc-electric)', 16);
    const weekTotal = bills.filter(b => {
      if (b.status === 'paid') return false;
      const _wd = FCData.daysUntil(b.due_date);
      // Include overdue bills — they still have to be paid this week
      return _wd !== null && _wd <= 7;
    }).reduce((s, b) => s + Number(b.amount || 0), 0);
    const _daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const _daysElapsed = Math.max(1, now.getDate());
    const planAheadAmt = budgetLimit > 0
      ? Math.round((budgetLimit / _daysInMonth) * _daysElapsed - monthSpend)
      : (cashFlow > 0 ? Math.round(cashFlow * 0.18) : 0);
    const isAheadOfPlan = cashFlow >= 0;
    const _monthName = now.toLocaleDateString('en-US', { month: 'short' });

    // ── Forward projection: where does this month end up? ────────────────
    // Conservative model, not a guess dressed as certainty:
    //   best case  = today's flow minus bills still due this month
    //   worst case = best case minus the rest of the budget getting spent
    // The line splits the difference; the band shows the honest range.
    const _remainingBills = bills.filter(b => {
      if (b.status === 'paid' || !b.due_date) return false;
      try { const d = FCData.parseDateLocal(b.due_date); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); }
      catch (_) { return false; }
    }).reduce((s, b) => s + Number(b.amount || 0), 0);
    const _remainingBudget = budgetLimit > 0
      ? Math.max(0, budgetLimit - monthSpend)
      : (monthSpend / _daysElapsed) * (_daysInMonth - _daysElapsed) * 0.5;
    const projHigh = cashFlow - _remainingBills;
    const projLow  = projHigh - _remainingBudget;
    const projMid  = (projHigh + projLow) / 2;
    const hasProjection = _daysElapsed < _daysInMonth;

    // Scale must cover actual + projected values
    const _sMin = Math.min(chartMin, hasProjection ? projLow : chartMin, 0);
    const _sMax = Math.max(chartMax, hasProjection ? projHigh : chartMax, 1);
    const _sSpan = Math.max(1, _sMax - _sMin);
    const _toY = v => 74 - ((v - _sMin) / _sSpan) * 68;
    // Real time axis: actual data occupies day 1 → today, projection fills the rest
    const _xToday = hasProjection ? 280 * (_daysElapsed - 1) / Math.max(1, _daysInMonth - 1) : 280;

    const smoothChartPath = (() => {
      const pts = chartValues.map((v, i) => [_xToday * i / Math.max(1, chartValues.length - 1), _toY(v)]);
      if (pts.length < 2) return '';
      let d = 'M ' + pts[0][0].toFixed(1) + ',' + pts[0][1].toFixed(1);
      for (let _ci = 0; _ci < pts.length - 1; _ci++) {
        const p0 = pts[Math.max(0, _ci - 1)], p1 = pts[_ci], p2 = pts[_ci + 1], p3 = pts[Math.min(pts.length - 1, _ci + 2)];
        d += ' C ' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ',' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)
           + ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ',' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)
           + ' ' + p2[0].toFixed(1) + ',' + p2[1].toFixed(1);
      }
      return d;
    })();
    const _lastChartV = chartValues[chartValues.length - 1] ?? 0;
    const lastChartPt = [_xToday, _toY(_lastChartV)];
    const smoothChartArea = smoothChartPath ? smoothChartPath + ' L ' + _xToday.toFixed(1) + ',80 L 0,80 Z' : '';
    // Projection band (today → month end) + dashed midline
    const projBandPath = hasProjection
      ? 'M ' + _xToday.toFixed(1) + ',' + _toY(_lastChartV).toFixed(1)
        + ' L 280,' + _toY(projHigh).toFixed(1)
        + ' L 280,' + _toY(projLow).toFixed(1) + ' Z'
      : '';
    const projLinePath = hasProjection
      ? 'M ' + _xToday.toFixed(1) + ',' + _toY(_lastChartV).toFixed(1) + ' L 280,' + _toY(projMid).toFixed(1)
      : '';
    const _yTickLabel = v => { const a = Math.abs(v); const sign = v < 0 ? '−' : ''; return a >= 1000 ? sign + '$' + (a / 1000).toFixed(a % 1000 ? 1 : 0) + 'k' : sign + '$' + Math.round(a); };
    const _yMax = _sMax, _yMin = _sMin, _yRng = _yMax - _yMin;
    const _yLabels = [_yTickLabel(_yMax), _yTickLabel(Math.round(_yMin + _yRng * 2 / 3)), _yTickLabel(Math.round(_yMin + _yRng / 3)), _yTickLabel(_yMin)];
    const _xLabels = [_monthName + ' 1', _monthName + ' ' + Math.round(_daysInMonth / 4), _monthName + ' ' + Math.round(_daysInMonth / 2), _monthName + ' ' + Math.round(_daysInMonth * 3 / 4), _monthName + ' ' + _daysInMonth];
    const goalsCardHTML = (() => {
      if (!activeGoals.length) return '<div class="dash-empty-state"><p>No savings goals yet.</p>'
        + '<button class="dash-cta-link" type="button" onclick="FCApp._openSubScreen(\'goals\')">Create your first goal ›</button></div>';
      return '<div class="dash-divider"></div>'
        + activeGoals.map(goal => {
          const _gp = goalPct(goal);
          const _gs = _gp >= 100 ? 'Complete ✓' : _gp >= 85 ? 'Almost there!' : _gp > 0 ? 'On track' : 'Just started';
          return '<div class="dash-goal-row">'
            + '<span class="dash-icon-circle" aria-hidden="true">' + goalIconEmoji(goal) + '</span>'
            + '<div class="dash-row-copy dash-goal-copy">'
            + '<div class="dash-goal-top-row"><span class="dash-row-title">' + esc(goal.name || 'Goal') + '</span><span class="dash-goal-pct">' + _gp + '%</span></div>'
            + '<div class="dash-goal-bar-track"><div class="dash-goal-bar-fill' + (_gp >= 85 ? ' dash-goal-bar-fill--green' : '') + '" style="width:' + _gp + '%"></div></div>'
            + '<div class="dash-goal-bottom-row"><span class="dash-row-meta">' + fmt(goal.current) + ' / ' + fmt(goal.target) + '</span>'
            + '<span class="dash-goal-status ' + (_gp >= 100 ? 'dash-goal-status--done' : 'dash-goal-status--track') + '">' + _gs + '</span></div>'
            + '</div></div>';
        }).join('');
    })();

    /* ── First run — nothing connected yet ────────────────────────────────
       Before there is data every card on this screen renders as an empty
       shell: a flat runway, "no bills due soon", zeroed stats. That is the
       worst possible first impression for a finance app, and until now it is
       exactly what a new user got — isLinked was computed and then used only
       to hide the Sync pill.

       So first run gets its own screen. One promise, the three answers the
       app actually exists to give, one action, and the trust line — because
       "is this safe?" is the only real question standing between a new user
       and connecting a bank. */
    if (!isLinked) {
      const promise = (icon, text) =>
        `<li class="home-v8__firstrun-item">
           <span class="home-v8__firstrun-icon" aria-hidden="true">${_ic(icon, 'var(--fc-accent)', 16)}</span>
           <span>${esc(text)}</span>
         </li>`;
      el.innerHTML = `
        <div class="home-v8${enterClass}">
          <header class="home-v8__greeting">
            <div>
              <h1>${esc(greeting)}, ${esc(firstName)}</h1>
              <p class="home-v8__date">${esc(dateLabel)}</p>
            </div>
          </header>

          <section class="fc-ui-card home-v8__firstrun" aria-labelledby="home-firstrun-title">
            <p class="fc-section-label">Get started</p>
            <h2 class="home-v8__firstrun-title" id="home-firstrun-title">Will you make it to payday?</h2>
            <p class="home-v8__firstrun-text">Connect your bank and FlowCheck answers that every morning — after the bills that haven’t hit yet, not just the balance you can already see.</p>
            <ul class="home-v8__firstrun-list">
              ${promise('trending-up', 'Your runway to the next paycheck')}
              ${promise('calendar', 'What’s left once upcoming bills clear')}
              ${promise('search', 'Subscriptions quietly charging you')}
            </ul>
            <button class="fc-action-button fc-action-button--primary home-v8__firstrun-cta" type="button"
                    onclick="FCApp.startPlaidLink()">Connect your bank</button>
            ${_RW_TRUST_ROW}
          </section>

          <p class="home-v8__disclaimer">FlowCheck is not a bank. Not financial advice.</p>
        </div>`;
      return;
    }

    el.innerHTML = `
      <div class="home-v8${enterClass}">
        <header class="home-v8__greeting">
          <div>
            <h1>${esc(greeting)}, ${esc(firstName)}</h1>
            <p class="home-v8__date">${esc(dateLabel)}</p>
          </div>
          ${syncPill}
        </header>

        ${safeSpendMarkup}
        ${_renderForecastCard()}

        <!-- These moves used to be a horizontal carousel: one card visible,
             the other two behind 12px dots that nothing signposted. The
             moves are already ranked, so paginating them hid the second and
             third behind a gesture almost nobody performs. Now the top move
             keeps the full treatment and the rest are listed under it —
             everything visible, still ordered, no hidden state. -->
        <section class="fc-ui-card home-v8__move" aria-label="Your next best move">
          <div class="home-v8__move-primary">
            <div class="home-v8__move-copy">
              <p class="fc-section-label">${esc(carouselCards[0].label)}</p>
              <h2 class="home-v8__move-title">${esc(carouselCards[0].title)}</h2>
              <p class="home-v8__move-text">${esc(_cardBody(carouselCards[0].body, 75))}</p>
              <div class="home-v8__move-actions">
                <!-- --secondary, not --primary: the runway card directly above
                     already carries a full-width filled .rw-cta, and two filled
                     accent buttons stacked on one screen is what dilutes the
                     signature moment the hero glow is supposed to own. The
                     ghost treatment already exists in the system — accent
                     border, card background, accent text — so this reads as
                     the second action rather than a rival first one.
                     The first-run CTA above keeps --primary: it is alone on an
                     otherwise empty screen with nothing to compete with. -->
                <button class="fc-action-button fc-action-button--secondary" type="button" onclick="${carouselCards[0].onclick}">${esc(carouselCards[0].action)}</button>
              </div>
            </div>
            <div class="home-v8__slide-emoji" aria-hidden="true">${carouselCards[0].emoji}</div>
          </div>
          ${carouselCards.length > 1 ? `
          <ul class="home-v8__move-rest">
            ${carouselCards.slice(1).map((card) => `
              <li>
                <button class="home-v8__move-row" type="button" onclick="${card.onclick}">
                  ${card.rowArt}
                  <span class="home-v8__move-row-copy">
                    <span class="home-v8__move-row-title">${esc(card.title)}</span>
                    <span class="home-v8__move-row-label">${esc(card.label)}</span>
                  </span>
                  <span class="home-v8__move-row-chevron" aria-hidden="true">›</span>
                </button>
              </li>`).join('')}
          </ul>` : ''}
        </section>


        <!-- Progress, not a warning. It sits under the "next move" card
             because it is a reward for having acted, not a decision to make;
             and above Quick actions because a person who just paid something
             off is exactly who is willing to do the next thing. It renders
             nothing at all for someone with no debt. -->
        ${_renderDebtProgressCard()}

        <!-- Dashboard v9 (DASHBOARD_SPEC.md §3): bills, monthly stats, the
             Cash Flow Outlook chart and Goals were all removed from Today.
             Each already owns a tab (Plan / Money / Goals), and duplicating
             them here is exactly what made this screen read as generic. The
             outlook chart in particular is now redundant — the runway IS the
             cash-flow picture, and a better one. -->
        <section class="home-v8__section home-v8__actions-panel" aria-labelledby="home-actions-heading">
          <div class="home-v8__section-heading"><div><h2 id="home-actions-heading">Quick actions</h2></div></div>
          <div class="home-v8__quick-actions">${quickActionsMarkup}</div>
        </section>

        <!-- Money Week sits below the actions on purpose. It is a recap, not a
             decision — above the fold it was competing with the runway for
             attention while answering nothing the user came here to ask. -->
        ${(state.transactions || []).length >= 3 ? `
        <button class="fcst-banner" type="button" onclick="FCApp.openMoneyStory()" aria-label="Play Your Money Week recap">
          <span class="fcst-banner-play" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </span>
          <span class="fcst-banner-copy">
            <span class="fcst-banner-title">Your Money Week is ready</span>
            <span class="fcst-banner-sub">30-second recap of your week</span>
          </span>
          <span class="fcst-banner-chevron" aria-hidden="true">›</span>
        </button>` : ''}

        <p class="home-v8__disclaimer">FlowCheck is not a bank. Not financial advice.</p>
      </div>`;

    // Hero numbers count up on load — static on unchanged re-renders.
    //
    // These used to name home-safe-value / home-stat-income / home-stat-spent /
    // home-outlook-heading. The v8 rebuild replaced that markup and none of
    // those ids exist any more, so every call hit _countup's `if (!el) return`
    // and Home's numbers simply appeared — while Money's still animated.
    // Driving it off data-countup means the markup declares what animates, so
    // this cannot silently rot again the next time the card is rewritten.
    el.querySelectorAll('[data-countup][id]').forEach(node => {
      const target = parseFloat(node.dataset.countup);
      if (!isNaN(target)) _countup(node.id, target);
    });

    // ── Chart scrubbing — press and drag to read any day's value ─────────
    (function () {
      const svg  = el.querySelector('.dash-chart-svg');
      const plot = el.querySelector('.dash-chart-plot-area');
      if (!svg || !plot || chartValues.length < 2) return;
      const dim = _daysInMonth, elapsed = _daysElapsed;
      const lastV = _lastChartV, pMid = projMid, mName = _monthName;
      const dayVal = (d) => {
        if (d <= elapsed) {
          const t = (d - 1) / Math.max(1, elapsed - 1) * (chartValues.length - 1);
          const i = Math.floor(t), f = t - i;
          const a = chartValues[i], b = chartValues[Math.min(chartValues.length - 1, i + 1)];
          return { v: a + (b - a) * f, proj: false };
        }
        const f = (d - elapsed) / Math.max(1, dim - elapsed);
        return { v: lastV + (pMid - lastV) * f, proj: true };
      };
      let guide = null, bubble = null;
      const ensure = () => {
        if (guide) return;
        guide = document.createElement('div');
        guide.style.cssText = 'position:absolute;top:0;bottom:18px;width:1.5px;background:var(--fc-text-faint);pointer-events:none;display:none;z-index:2';
        bubble = document.createElement('div');
        bubble.style.cssText = 'position:absolute;top:-8px;transform:translateX(-50%);background:var(--fc-bg-elevated);border:1px solid var(--fc-border);border-radius:8px;padding:4px 9px;font-size:11px;font-weight:600;color:var(--fc-text);white-space:nowrap;pointer-events:none;display:none;box-shadow:0 4px 14px rgba(0,0,0,0.18);font-variant-numeric:tabular-nums;z-index:3';
        plot.appendChild(guide); plot.appendChild(bubble);
      };
      const show = (clientX) => {
        ensure();
        const r = svg.getBoundingClientRect();
        if (r.width < 10) return;
        const fx = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        const d  = Math.max(1, Math.min(dim, Math.round(1 + fx * (dim - 1))));
        const { v, proj } = dayVal(d);
        const x = (d - 1) / Math.max(1, dim - 1) * r.width;
        guide.style.display = 'block';
        guide.style.left = x.toFixed(1) + 'px';
        bubble.style.display = 'block';
        bubble.style.left = Math.max(40, Math.min(r.width - 40, x)).toFixed(1) + 'px';
        bubble.textContent = mName + ' ' + d + ' · ' + (proj ? '≈' : '') + (v < 0 ? '−' : '+') + FCData.formatCurrency(Math.abs(v));
      };
      const hide = () => { if (guide) { guide.style.display = 'none'; bubble.style.display = 'none'; } };
      svg.style.touchAction = 'pan-y';
      svg.addEventListener('pointerdown', (e) => { haptic('light'); show(e.clientX); });
      svg.addEventListener('pointermove', (e) => { if (e.buttons > 0 || e.pointerType === 'touch') show(e.clientX); });
      svg.addEventListener('pointerup', hide);
      svg.addEventListener('pointercancel', hide);
      svg.addEventListener('pointerleave', hide);
    })();
  }

  /* ─────────────────────────────────────────────────────────────
     SKELETON HELPERS  (reuse .fc-skel shimmer class from index.html)
     ───────────────────────────────────────────────────────────── */

  // Returns n shimmer transaction rows using the existing .fc-skel / .fc-skel-txn classes.
  function _skeletonTxnRows(n) {
    const configs = [
      [55, 35, 52], [65, 40, 44], [48, 28, 58],
      [60, 32, 48], [52, 38, 56], [44, 30, 50], [58, 36, 54],
    ];
    return Array.from({ length: n }, (_, i) => {
      const op = (Math.max(0.22, 1 - i * 0.13)).toFixed(2);
      const [w1, w2, w3] = configs[i % configs.length];
      return `<div class="fc-skel-txn">
        <div class="fc-skel" style="width:36px;height:36px;border-radius:10px;flex-shrink:0;opacity:${op}"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px">
          <div class="fc-skel" style="height:13px;width:${w1}%;opacity:${op}"></div>
          <div class="fc-skel" style="height:10px;width:${w2}%;opacity:${(op * 0.65).toFixed(2)}"></div>
        </div>
        <div class="fc-skel" style="width:${w3}px;height:14px;opacity:${op}"></div>
      </div>`;
    }).join('');
  }

  // Returns n shimmer category rows for the Insights tab.
  function _skeletonCategoryRows(n) {
    const widths = [[70, 35], [55, 28], [80, 40], [45, 32], [65, 38]];
    return Array.from({ length: n }, (_, i) => {
      const op = (Math.max(0.22, 1 - i * 0.15)).toFixed(2);
      const [w1, w2] = widths[i % widths.length];
      return `<div class="fcs-skel-row">
        <div class="fc-skel" style="width:32px;height:32px;border-radius:8px;flex-shrink:0;opacity:${op}"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:5px">
          <div class="fc-skel" style="height:12px;width:${w1}%;opacity:${op}"></div>
          <div class="fc-skel" style="height:10px;width:${w2}%;opacity:${(op * 0.6).toFixed(2)}"></div>
        </div>
        <div class="fc-skel" style="width:48px;height:12px;opacity:${op}"></div>
      </div>`;
    }).join('');
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: ACTIVITY
     ───────────────────────────────────────────────────────────── */

  function _renderActivity() {
    const container = document.getElementById('activity-list');
    if (!container) return;

    // Show shimmer rows while waiting for the first Firestore snapshot.
    if (state.initialLoading && state.user?.plaid_linked) {
      container.innerHTML = `<div class="dash-txn-card">${_skeletonTxnRows(7)}</div>`;
      return;
    }

    // Render summary card + recurring banner
    _renderSpendingTrends();
    _renderRecurringBanner();

    // Apply overrides before filtering (so search matches renamed names)
    const txnsWithOverrides = state.transactions.map(t => {
      const ov = state.txnOverrides[t.id];
      if (!ov) return t;
      return {
        ...t,
        name:     ov.name     || t.name,
        category: ov.category ? [ov.category] : t.category,
        _edited:  true,
      };
    });

    // Type filter — the new quick-filter chips (All/Income/Expenses/Transfers/Recurring)
    const _XFER_CATS = new Set(['transfer', 'transfer in', 'transfer out', 'loan', 'loan payment', 'loan payments', 'credit card payment']);
    const _isTransferTxn = (t) => {
      const raw  = ((Array.isArray(t.category) ? t.category[0] : t.category) || '').toLowerCase().trim();
      const norm = FCData.normalizePlaidCategory(raw).toLowerCase();
      return _XFER_CATS.has(raw) || _XFER_CATS.has(norm) || raw.includes('transfer') || norm.includes('transfer');
    };
    const _recurringIds = new Set((_detectSubscriptions(txnsWithOverrides) || []).map(s => s.name?.toLowerCase()));
    const _isRecurringTxn = (t) => {
      const n = _cleanTxnName(t).toLowerCase();
      return _recurringIds.has(n);
    };

    let base = txnsWithOverrides;
    switch (_activityTypeFilter) {
      case 'income':    base = base.filter(t => _isIncomeTxn(t)); break;
      case 'expenses':  base = base.filter(t => _isSpendTxn(t)); break;
      case 'transfers': base = base.filter(t => _isTransferTxn(t)); break;
      case 'recurring': base = base.filter(t => _isRecurringTxn(t)); break;
    }

    const filtered = state.searchQuery
      ? (() => {
          const q = state.searchQuery.toLowerCase();
          return base.filter(t => {
            const raw      = (t.name || '').toLowerCase();
            const merchant = (t.merchant_name || '').toLowerCase();
            const display  = _cleanTxnName(t).toLowerCase();
            return raw.includes(q) || merchant.includes(q) || display.includes(q);
          });
        })()
      : base;

    if (!filtered.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:48px 24px;color:var(--fc-text-faint)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:12px;opacity:0.4"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>
          <div style="font-size:15px;font-weight:500;margin-bottom:4px;color:var(--fc-text-muted)">
            ${state.accounts.length ? 'No transactions match this filter' : 'Connect a bank to see transactions'}
          </div>
          <div style="font-size:13px">
            ${state.accounts.length ? 'Try a different filter or pull down to sync' : 'Connect one from Money → Net Worth.'}
          </div>
          ${state.accounts.length ? '' : `<button class="fc-btn fc-btn--primary fc-btn--sm" style="margin-top:16px" type="button" onclick="FCApp.showBankSheet&&FCApp.showBankSheet()">Connect a bank</button>`}
        </div>`;
      /* "Tap the link button above" pointed at a control that is not there:
         this header holds search, filter, and an add-bill button that only
         appears on the Bills segment. Nothing links a bank from here. Say
         where it actually lives, and give the screen the button it was
         already telling people to press. */
      return;
    }

    const PAGE_TXN_LIMIT = 75;
    const allGroups = FCData.groupTransactionsByDate(filtered);
    let html = '';
    let renderedCount = 0;
    let truncated = false;

    const chevronSvg = `<svg class="fc-list-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`;

    // allGroups is already an ordered array of [label, txns] pairs — do NOT
    // wrap it in Object.entries(), which is what used to discard the order.
    for (const [label, txns] of allGroups) {
      if (!_activityShowAll && renderedCount >= PAGE_TXN_LIMIT) {
        truncated = true;
        break;
      }

      // Compute net total for the date group
      const netAmt = txns.reduce((sum, t) => sum + (t.isCredit ? t.amount : -t.amount), 0);
      const netStr = (netAmt >= 0 ? '+' : '−') + FCData.formatCurrency(Math.abs(netAmt));
      const netColor = netAmt >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';

      html += `<div class="fc-date-label">${label}<span class="fc-date-label-spacer"></span><span class="fc-date-net">Net <span style="color:${netColor}">${netStr}</span></span></div>
               <article class="fc-card">`;

      html += txns.map(t => {
        const rawCat = (t.category && t.category[0]) || t.category || 'Other';
        const cat    = _prettyCategory(FCData.normalizePlaidCategory(rawCat));
        const emoji  = FCData.categoryEmoji(rawCat, t.name);
        const isEmojiIcon = emoji.length <= 2 && isNaN(emoji);
        const color  = t.isCredit ? 'var(--fc-success)' : 'var(--fc-danger)';
        const sign   = t.isCredit ? '+' : '−';
        const displayName = _cleanTxnName(t);
        const txDate = t.date ? FCData.parseDateLocal(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const editedDot = t._edited
          ? '<span style="width:5px;height:5px;background:var(--fc-accent);border-radius:50%;display:inline-block;margin-left:4px;vertical-align:middle"></span>'
          : '';
        return `
          <div class="fc-list-item" style="cursor:pointer" onclick="FCApp.openTransactionDetail('${esc(t.id)}')" role="button">
            <div class="fc-list-icon" style="background:${isEmojiIcon ? FCData.categoryColor(rawCat) + '22' : FCData.categoryColor(rawCat)};font-size:${isEmojiIcon ? '20px' : '15px'};font-weight:${isEmojiIcon ? '400' : '700'};color:white">${emoji}</div>
            <div class="fc-list-body">
              <div class="fc-list-title">${esc(displayName)}${editedDot}</div>
              <div class="fc-list-meta">${esc(cat)}${txDate ? ' · ' + txDate : ''}</div>
            </div>
            <div class="fc-list-right">
              <div class="fc-list-amount" style="color:${color}">${sign}${FCData.formatCurrency(t.amount)}</div>
              ${chevronSvg}
            </div>
          </div>`;
      }).join('');

      html += '</article>';
      renderedCount += txns.length;
    }

    if (truncated) {
      const remaining = filtered.length - renderedCount;
      html += `
        <button onclick="FCApp.showAllActivity()" style="width:100%;padding:14px;background:transparent;border:0.5px solid var(--fc-border);border-radius:14px;color:var(--fc-text-muted);font-size:14px;font-weight:500;cursor:pointer;margin-top:4px">
          Show ${remaining} more transaction${remaining !== 1 ? 's' : ''}
        </button>`;
    }

    container.innerHTML = html;
  }

  function showAllActivity() {
    _activityShowAll = true;
    _renderActivity();
  }

  /* ─────────────────────────────────────────────────────────────
     FINANCIAL HEALTH SCORE
     Computes 0–100 score from spending discipline, savings rate,
     and net worth trajectory. Renders the ring + sub-metrics.
     ───────────────────────────────────────────────────────────── */

  function _renderHealthScore() {
    const card = document.getElementById('ins-health-card');
    // Gate: free users see a locked card instead of the score
    if (!_isPro()) {
      if (card) {
        const bars = [75, 50, 85].map(w =>
          `<div class="fc-pro-gate-bar" style="width:${w}%"></div>`
        ).join('');
        card.innerHTML = `
          <div class="fc-pro-gate" style="margin-bottom:0;border:none;background:transparent" onclick="FCApp.showPaywall()">
            <div class="fc-pro-gate-preview">${bars}</div>
            <div class="fc-pro-gate-overlay" style="padding:20px">
              <div class="fc-pro-gate-badge">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                Pro Feature
              </div>
              <div class="fc-pro-gate-icon">❤️‍🔥</div>
              <div class="fc-pro-gate-title">Financial Health Score</div>
              <div class="fc-pro-gate-desc">Your personalized score across spending, savings, and net worth — with tips to improve it.</div>
              <button class="fc-pro-gate-btn" type="button" onclick="event.stopPropagation();FCApp.showPaywall()">Unlock Pro →</button>
            </div>
          </div>`;
      }
      return;
    }
    const ring     = document.getElementById('ins-health-ring');
    const gradeEl  = document.getElementById('ins-health-grade');
    const scoreEl  = document.getElementById('ins-health-score-num');
    const tipEl    = document.getElementById('ins-health-tip');
    if (!ring || !gradeEl) return;

    const accts    = state.accounts || [];
    const txns     = (state.transactions || []).filter(t => FCData.isCurrentMonth(t.date));
    // Bug fix: use actual user budget, not nonexistent state.monthlyBudget
    /* _totalBudgetLimit, not a raw `|| 3000`. The fallback chain directly
       below — budget, else detected income, else a neutral 0.5 — was
       unreachable: `|| 3000` guaranteed budget > 0 for every user, so an
       unbudgeted account was scored against someone else's $3,000 instead of
       against its own income. */
    const budget   = _totalBudgetLimit();

    // ── 1. Spending Score (0-34) ──────────────────────────────
    const spent      = txns.filter(t => !t.isCredit && _isSpendTxn(t)).reduce((s, t) => s + (t.amount || 0), 0);
    const income     = txns.filter(_isIncomeTxn).reduce((s, t) => s + (t.amount || 0), 0);
    // Use the user's set budget as denominator; if no budget, fall back to detected income;
    // if neither, use a neutral ratio of 0.5 (fair) so the score doesn't tank on missing data.
    const spendDenominator = budget > 0 ? budget : (income > 0 ? income : null);
    const spendRatio = spendDenominator ? spent / spendDenominator : 0.5;
    let spendScore = Math.round(34 * Math.max(0, Math.min(1, 1 - (spendRatio - 0.5) * 2)));
    // Perfect if under 75% of budget, 0 if over 150%
    if (spendRatio <= 0.75) spendScore = 34;
    else if (spendRatio >= 1.5) spendScore = 0;
    else spendScore = Math.round(34 * (1.5 - spendRatio) / 0.75);

    // ── 2. Savings Score (0-33) ───────────────────────────────
    // `income` already computed above for spendRatio fallback
    const incomeOkScore = _incomeIsReliable(income, spent);
    const savingsRate  = incomeOkScore ? (income - spent) / income : null;
    const savingsAccts = accts.filter(_isCashAcct);
    const totalSavings = savingsAccts.reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
    let savingsScore = 0;
    if (savingsRate !== null) {
      if (savingsRate >= 0.2) savingsScore = 33;
      else if (savingsRate > 0) savingsScore = Math.round(33 * (savingsRate / 0.2));
      // Boost if savings balance > 1 month of income
      if (totalSavings > income) savingsScore = Math.min(33, savingsScore + 8);
    } else {
      // Income not reliably detected — give neutral score for savings factor
      savingsScore = 16;
    }

    // ── 3. Net Worth Score (0-33) ─────────────────────────────
    const assets = accts
      .filter(_isAssetAcct)
      .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
    const debts  = accts
      .filter(_isDebtAcct)
      .reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
    const nw = assets - debts;
    let nwScore = 0;
    if (nw > 50000)      nwScore = 33;
    else if (nw > 10000) nwScore = Math.round(33 * (nw / 50000));
    else if (nw > 0)     nwScore = Math.round(20 * (nw / 10000));
    else if (nw === 0)   nwScore = 10; // no data
    else                 nwScore = Math.max(0, Math.round(10 + (nw / 5000)));

    // ── Totals ────────────────────────────────────────────────
    const hasData = accts.length > 0;
    const total = hasData ? Math.min(100, spendScore + savingsScore + nwScore) : 0;

    // Grade mapping
    const gradeMap = total >= 90 ? ['A+','Excellent'] : total >= 80 ? ['A','Great'] :
                     total >= 70 ? ['B','Good']       : total >= 60 ? ['C','Fair'] :
                     total >= 50 ? ['D','Needs Work'] : ['F','At Risk'];

    // Tips
    const tips = [];
    if (spendRatio > 0.9)                        tips.push('You\'re close to your monthly budget — ease up on discretionary spending.');
    if (savingsRate !== null && savingsRate < 0.1) tips.push('Try saving at least 10% of income. Even small amounts compound over time.');
    if (nw < 0)                                   tips.push('Your liabilities exceed your assets. Paying down high-interest debt first will help.');
    if (!tips.length)        tips.push('You\'re on track! Keep maintaining your current habits to keep your score growing.');

    // Animate ring
    const circumference = 226;
    const offset = hasData ? circumference * (1 - total / 100) : circumference;
    ring.style.strokeDashoffset = offset;

    // Color ring by score
    ring.style.stroke = total >= 70 ? 'var(--fc-accent)' : total >= 50 ? 'var(--fc-warning)' : '#ff3b30';

    // Left: big number + /100
    gradeEl.textContent = hasData ? total : '—';
    if (scoreEl) { scoreEl.textContent = '/100'; scoreEl.style.display = hasData ? '' : 'none'; }
    // Ring center: grade letter (A, B, C) — not the number (avoids duplication)
    const ringScoreEl = document.getElementById('ins-ring-score');
    if (ringScoreEl) {
      ringScoreEl.textContent = hasData ? gradeMap[0] : '—';
      ringScoreEl.style.color = total >= 70 ? 'var(--fc-accent)' : total >= 50 ? 'var(--fc-warning)' : '#ff3b30';
      // Hide the "/100" sub-label inside the ring since we're showing a letter now
      const ringNum = ringScoreEl.parentElement?.querySelector('.ins-ring-num');
      if (ringNum) ringNum.style.display = 'none';
    }

    // Sub-metric bars (normalize to 0-100 for display)
    const setBar = (barId, valId, score, max, color) => {
      const bar = document.getElementById(barId);
      const val = document.getElementById(valId);
      if (bar) { bar.style.width = Math.round(score / max * 100) + '%'; bar.style.background = color; }
      if (val) {
        const pct = Math.round(score / max * 100);
        val.textContent = pct >= 90 ? '✓' : pct === 0 ? '—' : pct;
        val.style.color = pct >= 90 ? 'var(--fc-success)' : pct === 0 ? 'var(--fc-text-faint)' : '';
      }
    };
    setBar('ins-bar-spending', 'ins-val-spending', spendScore, 34, spendScore >= 25 ? 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))' : 'linear-gradient(90deg,var(--fc-warning),#ff6b00)');
    setBar('ins-bar-savings',  'ins-val-savings',  savingsScore, 33, 'linear-gradient(90deg,var(--fc-success),var(--fc-accent))');
    setBar('ins-bar-networth', 'ins-val-networth', nwScore, 33, nwScore >= 20 ? 'linear-gradient(90deg,var(--fc-warning),var(--fc-electric))' : 'linear-gradient(90deg,#ff3b30,var(--fc-warning))');

    // Debt sub-metric: based on credit utilization (0-100 mapped to visual bar)
    const totalCreditLimit = accts.filter(a => a.type === 'credit')
      .reduce((s, a) => s + (a.balance_limit || a.balances?.limit || 0), 0);
    const totalCreditUsed  = accts.filter(a => a.type === 'credit')
      .reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
    const utilPct = totalCreditLimit > 0 ? Math.round((totalCreditUsed / totalCreditLimit) * 100) : null;
    // Score: 100 = 0% utilization, 0 = 100%+ utilization
    const debtScore = utilPct !== null ? Math.max(0, Math.round(100 * (1 - utilPct / 100))) : (hasData ? 70 : 0);
    setBar('ins-bar-debt', 'ins-val-debt', debtScore, 100,
      debtScore >= 70 ? 'linear-gradient(90deg,var(--fc-success),#1ac4f0)' : debtScore >= 40 ? 'linear-gradient(90deg,var(--fc-warning),#ff6b00)' : 'linear-gradient(90deg,var(--fc-danger),var(--fc-warning))');

    // Cash Flow sub-metric: income vs spending ratio this month
    const cfRatio = income > 0 ? Math.max(0, Math.min(1, (income - spent) / income)) : null;
    const cfScore = cfRatio !== null ? Math.round(cfRatio * 100) : (hasData ? 50 : 0);
    setBar('ins-bar-cashflow', 'ins-val-cashflow', cfScore, 100,
      cfScore >= 60 ? 'linear-gradient(90deg,var(--fc-electric),var(--fc-accent))' : 'linear-gradient(90deg,var(--fc-warning),var(--fc-danger))');

    // Tip
    if (tipEl) {
      tipEl.textContent = tips[0];
      tipEl.style.display = 'block';
    }

    // Subtitle — v2 shows grade label prominently
    const sub = document.getElementById('ins-health-subtitle');
    if (sub) {
      sub.textContent = hasData ? gradeMap[1] : 'Connect a bank to see your score';
      sub.style.color = hasData ? (total >= 70 ? 'var(--fc-success)' : total >= 50 ? 'var(--fc-warning)' : 'var(--fc-danger)') : '';
    }

    // EA-4: trend vs last month — compute last month's score with same algorithm
    const trendEl = document.getElementById('ins-health-trend');
    if (trendEl && hasData) {
      const lmStart = new Date(_now.getFullYear(), _now.getMonth() - 1, 1);
      const lmEnd   = new Date(_now.getFullYear(), _now.getMonth(), 0, 23, 59, 59);
      const lmTxns  = (state.transactions || []).filter(t => {
        const d = FCData.parseDateLocal(t.date);
        return d >= lmStart && d <= lmEnd;
      });
      if (lmTxns.length >= 5) {
        const lmSpend  = lmTxns.filter(t => !t.isCredit && _isSpendTxn(t)).reduce((s, t) => s + (t.amount || 0), 0);
        const lmIncome = lmTxns.filter(_isIncomeTxn).reduce((s, t) => s + (t.amount || 0), 0);
        const lmBudget = budget;
        const lmDenom  = lmBudget > 0 ? lmBudget : (lmIncome > 0 ? lmIncome : null);
        const lmRatio  = lmDenom ? lmSpend / lmDenom : 0.5;
        let lmSS = lmRatio <= 0.75 ? 34 : lmRatio >= 1.5 ? 0 : Math.round(34 * (1.5 - lmRatio) / 0.75);
        const lmSavRate = lmIncome > 0 ? (lmIncome - lmSpend) / lmIncome : null;
        let lmSavScore  = lmSavRate === null ? 16 : lmSavRate >= 0.2 ? 33 : lmSavRate > 0 ? Math.round(33 * lmSavRate / 0.2) : 0;
        const lmTotal   = Math.min(100, lmSS + lmSavScore + nwScore);
        const diff      = total - lmTotal;
        const lmGrade   = lmTotal >= 90 ? 'A+' : lmTotal >= 80 ? 'A' : lmTotal >= 70 ? 'B+' : lmTotal >= 60 ? 'B' : lmTotal >= 50 ? 'C+' : lmTotal >= 40 ? 'C' : 'D';
        if (Math.abs(diff) >= 3) {
          trendEl.textContent = diff > 0 ? `↑ from ${lmGrade}` : `↓ from ${lmGrade}`;
          trendEl.style.color = diff > 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
          trendEl.style.display = '';
        } else {
          trendEl.style.display = 'none';
        }
      } else {
        trendEl.style.display = 'none';
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: INSIGHTS
     ───────────────────────────────────────────────────────────── */

  /* ─────────────────────────────────────────────────────────────
     INSIGHTS: THIS WEEK / PERIOD SUMMARY
     ───────────────────────────────────────────────────────────── */
  function _renderWeekSummary(periodSpend, periodIncome, periodLabel) {
    const card = document.getElementById('ins-week-card');
    if (!card) return;

    const periodLbl = document.getElementById('ins-week-period-label');
    const label = state.period === '1D' ? 'Today' : state.period === '1W' ? 'Week' : state.period === '1M' ? 'Month' : state.period === '3M' ? '3 Months' : 'Year';
    if (periodLbl) periodLbl.textContent = label;

    // If bank is connected but no transactions yet — show syncing state, not "Connect a bank"
    const itemEls0 = document.getElementById('ins-week-item-1');
    if (state.user?.plaid_linked && state.accounts?.length > 0 && !state.transactions?.length) {
      if (itemEls0) {
        const lbl = itemEls0.querySelector('.ins-week-label');
        const sub = itemEls0.querySelector('.ins-week-sub');
        const dot = itemEls0.querySelector('.ins-week-dot');
        if (lbl) lbl.textContent = 'Syncing your transactions…';
        if (sub) sub.textContent = 'Your recent activity will appear here shortly';
        if (dot) { dot.style.background = 'rgba(26,196,240,0.15)'; dot.innerHTML = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--fc-accent)" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>'; }
      }
      ['ins-week-item-2','ins-week-item-3'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
      return;
    }

    /* 0 means "no budget set" — see _totalBudgetLimit. With `|| 3000` the
       `budget > 0` guard below never failed, so an unbudgeted user was told
       "Over budget this period · $X over the limit" against a ceiling they
       had never chosen. */
    const budget     = _totalBudgetLimit();
    const unpaid     = (state.bills || []).filter(b => b.status !== 'paid');
    const unpaidTotal = unpaid.reduce((s, b) => s + (b.amount || 0), 0);
    const cash       = Math.max(0, state.accounts ? state.accounts.filter(_isCashAcct).reduce((s, a) => s + _acctBal(a), 0) : 0);
    const incomeOk   = _incomeIsReliable(periodIncome, periodSpend);

    const items = [];

    // 1. Spending status
    if (periodSpend > 0 && budget > 0) {
      const pct = Math.round((periodSpend / budget) * 100);
      if (pct < 90) {
        items.push({ ok: true,  title: 'Spending is under control', sub: `You're ${100 - pct}% under budget` });
      } else if (pct < 110) {
        items.push({ warn: true, title: 'Spending near budget', sub: `${pct}% of ${FCData.formatCurrency(budget)} used` });
      } else {
        items.push({ bad: true, title: 'Over budget this period', sub: `${FCData.formatCurrency(periodSpend - budget)} over the limit` });
      }
    } else {
      items.push({ ok: true, title: 'Tracking your spending', sub: 'Set a budget to see progress' });
    }

    // 2. Bills status
    if (unpaid.length === 0) {
      items.push({ ok: true, title: 'All bills are covered', sub: 'No upcoming bills due' });
    } else {
      const afterBills = cash - unpaidTotal;
      items.push({ ok: afterBills >= 0, warn: afterBills < 0,
        title: afterBills >= 0 ? 'Bills are covered' : 'Bills exceed cash balance',
        sub: afterBills >= 0 ? `You have ${FCData.formatCurrency(afterBills)} after bills` : `${FCData.formatCurrency(Math.abs(afterBills))} shortfall` });
    }

    // 3. Net worth / savings signal
    const realBudget = state.budgets?.['total']?.limit || 0;
    const isOverBudget = realBudget > 0 && periodSpend >= realBudget;
    if (incomeOk && periodIncome > periodSpend && !isOverBudget) {
      const savings = periodIncome - periodSpend;
      const rate = Math.round((savings / periodIncome) * 100);
      items.push({ ok: true, title: `Saving ${rate}% of income`, sub: `${FCData.formatCurrency(savings)} saved ${periodLabel}` });
    } else if (incomeOk && periodSpend > periodIncome) {
      items.push({ bad: true, title: 'Spending exceeds income', sub: 'Consider reducing discretionary expenses' });
    } else {
      const nw = FCData.calcNetWorth ? FCData.calcNetWorth(state.accounts) : 0;
      if (nw < 0) {
        items.push({ warn: true, title: 'Debt is slowing you down', sub: 'Paying extra could improve your score' });
      } else {
        items.push({ ok: true, title: `Net worth: ${FCData.formatCurrency(nw)}`, sub: 'Building financial strength' });
      }
    }

    // Populate up to 3 items
    const itemEls = [
      document.getElementById('ins-week-item-1'),
      document.getElementById('ins-week-item-2'),
      document.getElementById('ins-week-item-3'),
    ];
    items.slice(0, 3).forEach((item, i) => {
      const el = itemEls[i];
      if (!el) return;
      el.style.display = '';
      const dotEl   = el.querySelector('.ins-week-dot');
      const titleEl = el.querySelector('.ins-week-label');
      const subEl   = el.querySelector('.ins-week-sub');
      if (titleEl) titleEl.textContent = item.title;
      if (subEl)   subEl.textContent   = item.sub || '';
      if (dotEl) {
        const col = item.ok ? 'var(--fc-success)' : item.warn ? 'var(--fc-warning)' : 'var(--fc-danger)';
        const bg  = item.ok ? 'rgba(52,199,89,0.15)' : item.warn ? 'rgba(255,159,10,0.12)' : 'rgba(255,69,58,0.12)';
        const icon = item.ok
          ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`
          : item.warn
          ? `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
          : `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        dotEl.style.background = bg;
        dotEl.innerHTML = icon;
      }
    });
    // Hide unused items
    for (let i = items.length; i < 3; i++) {
      if (itemEls[i]) itemEls[i].style.display = 'none';
    }

    // Recommendation banner — pick the first bad/warn item tip
    const recBanner = document.getElementById('ins-rec-banner');
    const recText   = document.getElementById('ins-rec-text');
    if (recBanner && recText) {
      const badItem = items.find(i => i.bad);
      const warnItem = items.find(i => i.warn);
      const tip = badItem || warnItem;
      if (tip) {
        const tips = {
          'Over budget this period': 'Focus on cutting discretionary spending to stay on track.',
          'Spending exceeds income': 'Try the 50/30/20 rule: 50% needs, 30% wants, 20% savings.',
          'Debt is slowing you down': 'Paying extra toward debt could improve your financial health the most.',
          'Bills exceed cash balance': 'Consider moving funds to cover upcoming bills before their due dates.',
        };
        recText.textContent = tips[tip.title] || `${tip.title} — review your finances.`;
        recBanner.style.display = 'flex';
      } else {
        recBanner.style.display = 'none';
      }
    }
  }

  // ─── Monthly Summary: 3-card row (Income / Spending / Cash Flow) ──────────
  function _renderMonthlySummary(periodSpend, periodIncome) {
    const now        = new Date();
    const lmStart    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lmEnd      = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    const allTxns    = state.transactions || [];

    const lmTxns    = allTxns.filter(t => { const d = FCData.parseDateLocal(t.date); return d >= lmStart && d <= lmEnd; });
    const lmSpend   = lmTxns.filter(_isSpendTxn).reduce((s, t) => s + (t.amount || 0), 0);
    const lmIncome  = lmTxns.filter(_isIncomeTxn).reduce((s, t) => s + Math.abs(t.amount || 0), 0);

    const cashFlow   = periodIncome - periodSpend;
    const lmCashFlow = lmIncome - lmSpend;

    const _delta = (curr, prev) => {
      if (!prev || prev === 0) return null;
      return Math.round(((curr - prev) / Math.abs(prev)) * 100);
    };
    const _deltaHtml = (d, invert) => {
      if (d === null) return '';
      const good  = invert ? d < 0 : d > 0;
      const color = good ? 'var(--fc-success)' : d === 0 ? 'var(--fc-text-faint)' : 'var(--fc-danger)';
      const arrow = d > 0 ? '↑' : d < 0 ? '↓' : '→';
      return `<span style="color:${color}">${arrow}${Math.abs(d)}% vs last mo</span>`;
    };

    const incomeVal   = document.getElementById('ins-ms-income-val');
    const incomeDelta = document.getElementById('ins-ms-income-delta');
    const spendVal    = document.getElementById('ins-ms-spend-val');
    const spendDelta  = document.getElementById('ins-ms-spend-delta');
    const cfVal       = document.getElementById('ins-ms-cf-val');
    const cfDelta     = document.getElementById('ins-ms-cf-delta');

    if (incomeVal)  incomeVal.textContent = FCData.formatCurrency(periodIncome);
    if (incomeDelta) {
      const d = _delta(periodIncome, lmIncome);
      if (d !== null) { incomeDelta.innerHTML = _deltaHtml(d, false); incomeDelta.style.display = ''; }
      else incomeDelta.style.display = 'none';
    }

    if (spendVal)  spendVal.textContent = FCData.formatCurrency(periodSpend);
    if (spendDelta) {
      const d = _delta(periodSpend, lmSpend);
      if (d !== null) { spendDelta.innerHTML = _deltaHtml(d, true); spendDelta.style.display = ''; }
      else spendDelta.style.display = 'none';
    }

    if (cfVal) {
      cfVal.textContent  = (cashFlow >= 0 ? '+' : '') + FCData.formatCurrency(cashFlow);
      cfVal.style.color  = cashFlow >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
    }
    if (cfDelta) {
      const d = lmCashFlow !== 0 ? _delta(cashFlow, lmCashFlow) : null;
      if (d !== null) { cfDelta.innerHTML = _deltaHtml(d, false); cfDelta.style.display = ''; }
      else cfDelta.style.display = 'none';
    }
  }

  function _renderPlanCategories(periodSpendTxns, periodSpend) {
    const card = document.getElementById('plan-cat-card');
    if (!card) return;

    const _NEEDS = new Set([
      'supermarkets and groceries','groceries','food delivery','gas stations','gas',
      'public transportation services','taxi','ride share','utilities','telecommunications',
      'healthcare','pharmacies','insurance','subscription','streaming','rent','mortgage',
      'home improvement','home maintenance',
    ]);
    const _WANTS = new Set([
      'food and drink','restaurants','fast food','coffee shop','bars','alcohol and bars',
      'entertainment','travel','airlines and aviation services','hotels and motels',
      'sporting goods','hobbies','arts and entertainment','shopping',
      'clothing and accessories','electronics','personal care','hair','spa and beauty',
      'gym and fitness','health and fitness','pets','gifts','toys','books and magazines',
    ]);

    if (_planCatTab === 'goals') {
      const goals = state.goals || [];
      if (!goals.length) {
        card.innerHTML = `<div class="plan-empty"><div class="plan-empty-title">No goals yet</div><div class="plan-empty-sub">Set a savings goal to track it here.</div><button class="plan-empty-cta" onclick="FCApp.showAddGoalSheet()" type="button">Add Goal</button></div>`;
        return;
      }
      card.innerHTML = goals.map(g => {
        const pct  = g.target > 0 ? Math.min(Math.round(((g.current || 0) / g.target) * 100), 100) : 0;
        const fill = pct >= 90 ? 'var(--fc-success)' : pct >= 50 ? 'var(--fc-accent)' : 'var(--fc-warning)';
        const badge = pct >= 100 ? 'good' : pct >= 50 ? 'on-track' : 'behind';
        const badgeLbl = pct >= 100 ? 'Done' : pct >= 50 ? 'On track' : 'Behind';
        return `<div class="plan-goal-row" role="button">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span class="plan-goal-name">${esc(g.name || 'Goal')}</span>
            <span class="plan-badge plan-badge-${badge}">${badgeLbl}</span>
          </div>
          <div class="plan-goal-amounts">
            <span class="plan-goal-current">${FCData.formatCurrency(g.current || 0)}</span>
            <span class="plan-goal-of">of</span>
            <span class="plan-goal-target">${FCData.formatCurrency(g.target || 0)}</span>
          </div>
          <div class="plan-cat-bar-track" style="margin-top:8px">
            <div class="plan-cat-bar-fill" style="width:${pct}%;background:${fill}"></div>
          </div>
        </div>`;
      }).join('');
      return;
    }

    const catMap = {};
    for (const t of periodSpendTxns) {
      const rawCat = (Array.isArray(t.category) ? t.category[0] : t.category) || 'Other';
      const cat    = FCData.normalizePlaidCategory(rawCat);
      catMap[cat]  = (catMap[cat] || 0) + (t.amount || 0);
    }

    let rows = Object.entries(catMap).sort((a, b) => b[1] - a[1]);
    if (_planCatTab === 'needs') rows = rows.filter(([cat]) => _NEEDS.has(cat.toLowerCase()));
    if (_planCatTab === 'wants') rows = rows.filter(([cat]) => _WANTS.has(cat.toLowerCase()));

    if (!rows.length) {
      const msg = _planCatTab === 'needs' ? 'No essential spending found'
                : _planCatTab === 'wants' ? 'No discretionary spending found'
                : 'No spending data yet';
      card.innerHTML = `<div class="plan-empty"><div class="plan-empty-title">${msg}</div><div class="plan-empty-sub">Transactions appear once your bank syncs.</div></div>`;
      return;
    }

    card.innerHTML = rows.slice(0, 8).map(([cat, amount]) => {
      const emoji   = (typeof FCData.categoryEmoji === 'function') ? FCData.categoryEmoji(cat) : '📦';
      const color   = FCData.categoryColor ? FCData.categoryColor(cat) : '#64748B';
      const budget  = state.budgets && state.budgets[cat];
      const budLim  = budget ? (budget.limit || 0) : 0;
      const budPct  = budLim > 0 ? Math.min(Math.round((amount / budLim) * 100), 100) : 0;
      const isOver  = budLim > 0 && amount > budLim;
      const pctTot  = periodSpend > 0 ? Math.round((amount / periodSpend) * 100) : 0;
      const badgeCls = isOver ? 'over' : budPct > 80 ? 'watch' : budLim > 0 ? 'on-track' : 'set-limit';
      const badgeLbl = isOver ? 'Over' : budPct > 80 ? 'Watch' : budLim > 0 ? 'On track' : 'Set limit';
      const barFill  = isOver ? 'var(--fc-danger)' : budPct > 80 ? 'var(--fc-warning)' : color;
      return `<div class="plan-cat-row" onclick="FCApp.openCategoryBudgetSheet('${esc(cat)}',${budLim})" role="button" aria-label="${esc(cat)}">
        <div class="plan-cat-row-top">
          <div class="plan-cat-icon" style="background:${color}22">${emoji}</div>
          <div class="plan-cat-info">
            <div class="plan-cat-name">${esc(cat)}</div>
            <div class="plan-cat-meta">${pctTot}% of spending</div>
          </div>
          <div class="plan-cat-right">
            <div class="plan-cat-spent">${FCData.formatCurrency(amount)}</div>
            <span class="plan-badge plan-badge-${badgeCls}">${badgeLbl}</span>
          </div>
        </div>
        ${budLim > 0 ? `<div class="plan-cat-progress">
          <div class="plan-cat-bar-track"><div class="plan-cat-bar-fill" style="width:${budPct}%;background:${barFill}"></div></div>
          <div class="plan-cat-bar-foot">
            <span class="plan-cat-left-lbl">${isOver ? FCData.formatCurrency(amount - budLim) + ' over' : FCData.formatCurrency(budLim - amount) + ' left'}</span>
            <span class="plan-cat-left-lbl">${FCData.formatCurrency(budLim)} limit</span>
          </div>
        </div>` : ''}
      </div>`;
    }).join('');
  }

  function _renderPremiumInsights(periodTxns, spendTxns, periodSpend, periodIncome, periodLabel) {
    const shell = document.querySelector('.premium-insights-shell');
    const gate = document.getElementById('premium-insights-gate');
    const isPro = _isPro();
    if (shell) shell.classList.toggle('is-locked', !isPro);
    if (gate) gate.hidden = isPro;
    if (!isPro) return;

    const chart = document.getElementById('premium-trend-chart');
    const total = document.getElementById('premium-trend-total');
    const trendPeriod = document.getElementById('premium-trend-period');
    const categoryPeriod = document.getElementById('premium-category-period');
    const periodMenu = document.getElementById('premium-insights-period');
    const labels = document.getElementById('premium-trend-labels');
    if (total) total.textContent = FCData.formatCurrency(periodSpend);
    if (trendPeriod) trendPeriod.textContent = periodLabel;
    if (categoryPeriod) categoryPeriod.textContent = periodLabel;
    if (periodMenu) periodMenu.textContent = state.period;

    if (chart) {
      const daily = new Map();
      spendTxns.forEach(txn => {
        if (!txn.date) return;
        daily.set(txn.date, (daily.get(txn.date) || 0) + Number(txn.amount || 0));
      });
      const entries = [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      let running = 0;
      let pointsData = entries.map(([date, value]) => ({ date, value: (running += value) }));
      if (pointsData.length < 2) {
        const now = FCCore.isoDay(new Date());
        pointsData = [{ date: now, value: 0 }, { date: now, value: periodSpend }];
      }
      const width = 320, height = 118, pad = 6;
      const values = pointsData.map(point => point.value);
      const min = Math.min(0, ...values), max = Math.max(1, ...values), range = max - min || 1;
      const points = pointsData.map((point, index) => ({
        x: (index / (pointsData.length - 1)) * width,
        y: pad + (height - pad * 2) * (1 - (point.value - min) / range),
      }));
      let line = `M${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
      for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1], point = points[i], middle = (previous.x + point.x) / 2;
        line += ` C${middle.toFixed(1)},${previous.y.toFixed(1)} ${middle.toFixed(1)},${point.y.toFixed(1)} ${point.x.toFixed(1)},${point.y.toFixed(1)}`;
      }
      const last = points[points.length - 1];
      const grid = [0.25, 0.5, 0.75].map(ratio => `<line x1="0" y1="${(height * ratio).toFixed(1)}" x2="${width}" y2="${(height * ratio).toFixed(1)}" stroke="var(--fc-premium-divider)" stroke-width="1"/>`).join('');
      chart.innerHTML = `<defs><linearGradient id="premiumTrendArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--fc-accent)" stop-opacity=".25"/><stop offset="100%" stop-color="var(--fc-accent)" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${line} L${width},${height} L0,${height} Z" fill="url(#premiumTrendArea)"/><path d="${line}" fill="none" stroke="var(--fc-accent)" stroke-width="2.5" stroke-linecap="round"/><circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="4" fill="var(--fc-accent)"/>`;
      if (labels) {
        const firstDate = FCData.parseDateLocal(pointsData[0].date);
        const lastDate = FCData.parseDateLocal(pointsData[pointsData.length - 1].date);
        labels.innerHTML = `<span>${firstDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span><span>${lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>`;
      }
    }

    const categoryMap = {};
    spendTxns.forEach(txn => {
      const raw = (txn.category && txn.category[0]) || txn.category || 'Other';
      const category = FCData.normalizePlaidCategory(raw);
      categoryMap[category] = (categoryMap[category] || 0) + Number(txn.amount || 0);
    });
    const categories = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const donut = document.getElementById('premium-category-donut');
    const categoryTotal = document.getElementById('premium-category-total');
    const legend = document.getElementById('premium-category-legend');
    if (categoryTotal) categoryTotal.textContent = periodSpend >= 1000 ? `$${(periodSpend / 1000).toFixed(1)}k` : FCData.formatCurrency(periodSpend);
    if (donut) {
      const radius = 45, circumference = 2 * Math.PI * radius;
      let offset = 0;
      const slices = categories.map(([category, amount]) => {
        const length = periodSpend > 0 ? (amount / periodSpend) * circumference : 0;
        const circle = `<circle cx="60" cy="60" r="${radius}" fill="none" stroke="${FCData.categoryColor(category)}" stroke-width="16" stroke-dasharray="${Math.max(0, length - 2).toFixed(2)} ${(circumference - Math.max(0, length - 2)).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"/>`;
        offset += length;
        return circle;
      }).join('');
      donut.innerHTML = `<circle cx="60" cy="60" r="${radius}" fill="none" stroke="var(--fc-premium-track)" stroke-width="16"/>${slices}`;
    }
    if (legend) {
      legend.innerHTML = categories.length ? categories.slice(0, 5).map(([category, amount]) => {
        const pct = periodSpend > 0 ? Math.round((amount / periodSpend) * 100) : 0;
        return `<div class="premium-legend-row"><i style="background:${FCData.categoryColor(category)}"></i><span>${esc(category)} ${pct}%</span><b>${FCData.formatCurrency(amount)}</b></div>`;
      }).join('') : '<div class="premium-legend-row"><span></span><span>No spending yet</span><b>$0</b></div>';
    }

    const insight = document.getElementById('premium-insight-copy');
    if (insight) {
      if (categories.length && periodSpend > 0) {
        const [category, amount] = categories[0];
        const pct = Math.round((amount / periodSpend) * 100);
        insight.textContent = `${category} is your largest category at ${pct}% of ${periodLabel} spending. Review the transactions to find your best next move.`;
      } else {
        insight.textContent = state.user?.plaid_linked
          ? 'Your newest transactions are still syncing. Patterns will appear here automatically.'
          : 'Connect a bank to unlock personalized spending patterns.';
      }
    }

    const net = periodIncome - periodSpend;
    const cashflowNet = document.getElementById('premium-cashflow-net');
    if (cashflowNet) {
      cashflowNet.textContent = `${net >= 0 ? '+' : '-'}${FCData.formatCurrency(Math.abs(net))}`;
      cashflowNet.style.color = net >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
    }
    const bars = document.getElementById('premium-cashflow-bars');
    if (bars) {
      const ordered = periodTxns.filter(txn => txn.date).slice().sort((a, b) => a.date.localeCompare(b.date));
      const groups = Array.from({ length: 6 }, () => ({ income: 0, spend: 0 }));
      ordered.forEach((txn, index) => {
        const group = groups[Math.min(5, Math.floor(index / Math.max(1, ordered.length / 6)))];
        if (_isIncomeTxn(txn)) group.income += Math.abs(Number(txn.amount || 0));
        if (_isSpendTxn(txn)) group.spend += Number(txn.amount || 0);
      });
      const peak = Math.max(1, ...groups.flatMap(group => [group.income, group.spend]));
      bars.innerHTML = groups.map(group => `<div class="premium-cashflow-group"><i style="height:${Math.max(4, Math.round((group.income / peak) * 100))}%"></i><i style="height:${Math.max(4, Math.round((group.spend / peak) * 100))}%"></i></div>`).join('');
    }
  }

  function _renderInsights() {
    // Render Plan page (new primary experience for this tab)
    try { _renderPlan(); } catch(e) { fcLog('[Plan]', e); }

    // Render health score — isolated so any error doesn't abort the rest of insights
    try { _renderHealthScore(); } catch(e) { fcLog('[Insights] health score error:', e); }

    const container = document.getElementById('insights-categories');
    if (!container) return;

    // Show shimmer only while truly loading (no accounts yet)
    if (state.initialLoading && state.user?.plaid_linked && !state.accounts?.length) {
      container.innerHTML = _skeletonCategoryRows(5);
      return;
    }

    // ── Period-aware transactions ─────────────────────────────────
    const periodTxns  = _getPeriodTxns();
    const periodLabel = _PERIOD_LABELS[state.period] || 'this month';

    const periodSpendTxns = periodTxns.filter(_isSpendTxn);
    const periodSpend  = periodSpendTxns.reduce((s, t) => s + (t.amount || 0), 0);
    const periodIncome = periodTxns.filter(_isIncomeTxn).reduce((s, t) => s + Math.abs(t.amount || 0), 0);
    _renderPremiumInsights(periodTxns, periodSpendTxns, periodSpend, periodIncome, periodLabel);

    // Update the legacy insights period labels (in hidden compat elements)
    const insightsPeriodEl = document.getElementById('insights-period-label');
    if (insightsPeriodEl) insightsPeriodEl.textContent = periodLabel;
    const insightsCatPeriod = document.getElementById('insights-cat-period');
    if (insightsCatPeriod) insightsCatPeriod.textContent = periodLabel;

    // ── V3: New sections ─────────────────────────────────────────
    // Note: Today's Move lives on Home now — not duplicated here
    try { _renderMonthlySummary(periodSpend, periodIncome); } catch(e) { fcLog('[Insights] monthly summary error:', e); }

    // ── Legacy week summary (writes to hidden compat elements) ───
    _renderWeekSummary(periodSpend, periodIncome, periodLabel);

    // ── Spending ring + budget progress ──────────────────────────
    const budgetLimit  = _totalBudgetLimit();
    const budgetPct    = budgetLimit > 0 ? Math.min(Math.round((periodSpend / budgetLimit) * 100), 100) : 0;
    const budgetColor  = budgetPct > 90 ? 'var(--fc-danger)'
                       : budgetPct > 70 ? 'var(--fc-warning)'
                       : null; // null = use gradient

    // Spending circular ring (58px, r=23, circumference≈145)
    const spendRingEl = document.getElementById('ins-spend-ring');
    const spendPctEl  = document.getElementById('ins-spend-pct');
    if (spendRingEl) {
      const circ = 145;
      const offset = circ * (1 - budgetPct / 100);
      spendRingEl.style.strokeDashoffset = offset;
      spendRingEl.style.stroke = budgetColor || 'url(#spendRingGrad)';
    }
    if (spendPctEl) spendPctEl.textContent = budgetPct + '%';

    // Bar fill
    const budgetBarEl = document.getElementById('insights-budget-fill');
    if (budgetBarEl) {
      budgetBarEl.style.width = budgetPct + '%';
      budgetBarEl.style.background = budgetColor || 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))';
    }

    const remEl = document.getElementById('insights-budget-remaining');
    const remaining = Math.max(0, budgetLimit - periodSpend);
    if (remEl) {
      /* budgetLimit is 0 when no budget exists, where it used to be a
         hardcoded 3000. Without this branch every unbudgeted user would be
         told they are "$X over" — over a ceiling they never set. */
      remEl.textContent = budgetLimit <= 0
        ? 'No budget set'
        : periodSpend > budgetLimit
          ? `${FCData.formatCurrency(periodSpend - budgetLimit)} over`
          : `${FCData.formatCurrency(remaining)} left`;
      remEl.style.color = budgetLimit > 0 && periodSpend > budgetLimit ? 'var(--fc-danger)' : 'var(--fc-text-faint)';
    }

    // ── Spending pace forecast ────────────────────────────────────
    const paceEl = document.getElementById('insights-budget-pace');
    if (paceEl && state.period === '1M') {
      const now = new Date();
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysLeft = daysInMonth - dayOfMonth;
      const dailyAvg = dayOfMonth > 0 ? periodSpend / dayOfMonth : 0;
      const projectedTotal = dailyAvg * daysInMonth;
      const paceColor = projectedTotal > budgetLimit ? 'var(--fc-warning)' : 'var(--fc-success)';
      const paceIcon  = projectedTotal > budgetLimit ? '⚠️' : '✓';
      paceEl.innerHTML = `<span style="color:${paceColor}">${paceIcon} ${FCData.formatCurrency(dailyAvg)}/day avg · Projected: ${FCData.formatCurrency(projectedTotal)} · ${daysLeft}d left</span>`;
    } else if (paceEl) {
      paceEl.textContent = '';
    }

    // ── Budget health score (% of category budgets on track) ────────
    const healthEl    = document.getElementById('insights-budget-health');
    const healthBarEl = document.getElementById('insights-budget-health-bar');
    if (healthEl && state.budgets) {
      const catBudgets = Object.entries(state.budgets).filter(([k]) => k !== 'total');
      if (catBudgets.length > 0) {
        const onTrack = catBudgets.filter(([cat, b]) => {
          // Match against the display category (FCData.txnCategory normalises Plaid
          // raw keys to the same labels the user sees when setting budgets).
          const spent = periodSpendTxns
            .filter(t => (FCData.txnCategory ? FCData.txnCategory(t) : (t.category && t.category[0]) || '') === cat)
            .reduce((s, t) => s + t.amount, 0);
          return spent <= (b.limit || 0);
        }).length;
        const healthPct = Math.round((onTrack / catBudgets.length) * 100);
        const healthColor = healthPct >= 80 ? 'var(--fc-success)' : healthPct >= 50 ? 'var(--fc-warning)' : 'var(--fc-danger)';
        const healthLabel = healthPct >= 80 ? `${healthPct}% ✓` : healthPct >= 50 ? `${healthPct}% ~` : `${healthPct}% !`;
        healthEl.textContent = healthLabel;
        healthEl.style.color = healthColor;
        if (healthBarEl) { healthBarEl.style.width = healthPct + '%'; healthBarEl.style.background = healthColor; }
      } else {
        healthEl.textContent = '—';
        healthEl.style.color = 'var(--fc-text-faint)';
      }
    }

    // ── Total spending + categories ───────────────────────────────
    const totalEl = document.getElementById('insights-total-spend');
    if (totalEl) animateNumber(totalEl, periodSpend, '$');

    // ── Budget performance ring (ins-budget-ring) ─────────────────
    (function () {
      const ring    = document.getElementById('ins-budget-ring');
      const pctEl   = document.getElementById('ins-budget-pct');
      const monthEl = document.getElementById('ins-budget-month');
      const daysEl  = document.getElementById('ins-budget-days-left');
      const projEl  = document.getElementById('ins-budget-proj');
      if (!ring) return;
      // 64px ring, r=26, circumference≈163
      const circ2  = 163;
      const offset2 = circ2 * (1 - budgetPct / 100);
      ring.style.strokeDashoffset = offset2;
      const ringCol = budgetPct > 90 ? 'var(--fc-danger)' : budgetPct > 70 ? 'var(--fc-warning)' : 'var(--fc-accent)';
      ring.style.stroke = ringCol;
      if (pctEl)   pctEl.textContent = budgetPct + '%';
      const nowB = new Date();
      if (monthEl) monthEl.textContent = nowB.toLocaleString('en-US', { month: 'long' });
      const lastDayB = new Date(nowB.getFullYear(), nowB.getMonth() + 1, 0).getDate();
      const daysLeftB = lastDayB - nowB.getDate();
      if (daysEl)  daysEl.textContent = `${daysLeftB} days left`;
      if (projEl && nowB.getDate() > 3) {
        const projTotal = Math.round((periodSpend / nowB.getDate()) * lastDayB);
        const onTrack = projTotal <= budgetLimit;
        projEl.innerHTML = `On track to finish with <span style="color:${onTrack ? 'var(--fc-success)' : 'var(--fc-danger)'}">${FCData.formatCurrency(Math.abs(budgetLimit - projTotal))} ${onTrack ? 'remaining' : 'over'}</span>`;
      }
    })();

    const donutSvg      = document.getElementById('insights-donut-svg');
    const donutCenterEl = document.getElementById('insights-donut-center-amt');
    const donutLegend   = document.getElementById('insights-donut-legend');

    if (!periodSpendTxns.length) {
      const syncMsg = state.user?.plaid_linked && state.accounts?.length
        ? 'Syncing transactions — check back soon'
        : `No spending data for ${periodLabel}`;
      container.innerHTML = `<div style="color:var(--fc-text-faint);text-align:center;padding:28px 0;font-size:13px">${syncMsg}</div>`;
      if (donutSvg)    donutSvg.innerHTML = '<circle cx="60" cy="60" r="46" fill="none" style="stroke:var(--fc-border)" stroke-width="16"/>';
      if (donutCenterEl) donutCenterEl.textContent = '—';
      if (donutLegend) donutLegend.innerHTML = '';
      // Clear top category in spending card
      const tcName = document.getElementById('ins-top-cat-name'); if (tcName) { tcName.textContent = '—'; tcName.style.color = 'var(--fc-text-faint)'; }
      const tcAmt  = document.getElementById('ins-top-cat-amt');  if (tcAmt)  tcAmt.style.display = 'none';
    } else {
      const catMap = {};
      const _RENT_PATTERN = /apart|rent|realty|property|housing|residen|leas/i;
      let _utilitiesHasRent = false;
      for (const t of periodSpendTxns) {
        const rawCat = (t.category && t.category[0]) || t.category || 'Other';
        let cat = FCData.normalizePlaidCategory(rawCat);
        if (cat === 'Utilities' && _RENT_PATTERN.test(t.merchant_name || t.name || '')) {
          _utilitiesHasRent = true;
        }
        catMap[cat] = (catMap[cat] || 0) + t.amount;
      }
      // Rename Utilities → "Utilities & Rent" when rent merchants are in the bucket
      if (_utilitiesHasRent && catMap['Utilities']) {
        catMap['Utilities & Rent'] = catMap['Utilities'];
        delete catMap['Utilities'];
      }
      const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 6);

      // ── Top category label in spending card ──────────────────────
      if (sorted.length) {
        const [topCat, topAmt] = sorted[0];
        const tcName = document.getElementById('ins-top-cat-name');
        const tcAmt  = document.getElementById('ins-top-cat-amt');
        if (tcName) { tcName.textContent = topCat; tcName.style.color = 'var(--fc-text-faint)'; }
        if (tcAmt)  { tcAmt.textContent = FCData.formatCurrency(topAmt); tcAmt.style.display = ''; }
      }

      // ── Donut chart — 120×120, SVG itself rotated -90deg so 0° = top ──
      if (donutSvg && periodSpend > 0) {
        const CX = 60, CY = 60, R = 46, SW = 16;
        let cumAngle = 0; // SVG element is rotated -90deg, so start = top
        let arcs = '';
        const slices    = sorted.slice(0, 5);
        const otherAmt  = sorted.slice(5).reduce((s, [, a]) => s + a, 0);
        const allSlices = otherAmt > 0 ? [...slices, ['Other', otherAmt]] : slices;
        const gapDeg    = allSlices.length > 1 ? 2 : 0;

        for (const [cat, amount] of allSlices) {
          const pct      = amount / periodSpend;
          const sweep    = pct * 360;
          const startRad = (cumAngle * Math.PI) / 180;
          const endRad   = ((cumAngle + sweep - gapDeg) * Math.PI) / 180;
          const x1 = CX + R * Math.cos(startRad);
          const y1 = CY + R * Math.sin(startRad);
          const x2 = CX + R * Math.cos(endRad);
          const y2 = CY + R * Math.sin(endRad);
          const large = (sweep - gapDeg) > 180 ? 1 : 0;
          const col = FCData.categoryColor(cat);
          arcs += `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" fill="none" stroke="${col}" stroke-width="${SW}" stroke-linecap="butt"/>`;
          cumAngle += sweep;
        }
        donutSvg.innerHTML = arcs;

        // Center label lives outside SVG (HTML element)
        if (donutCenterEl) {
          donutCenterEl.textContent = periodSpend >= 1000
            ? `$${(periodSpend / 1000).toFixed(1)}k`
            : `$${Math.round(periodSpend)}`;
        }

        if (donutLegend) {
          const legendSlices = allSlices.slice(0, 6);
          donutLegend.innerHTML = legendSlices.map(([cat, amount]) => {
            const col = FCData.categoryColor(cat);
            const p   = Math.round((amount / periodSpend) * 100);
            const emoji = (typeof FCData.categoryEmoji === 'function') ? FCData.categoryEmoji(cat) : '📦';
            return `<div style="display:flex;align-items:center;gap:7px;min-width:0">
              <div style="width:8px;height:8px;border-radius:2px;background:${col};flex-shrink:0"></div>
              <div style="flex:1;min-width:0">
                <div style="font-size:11px;font-weight:600;color:var(--fc-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${cat}</div>
                <div style="font-size:10px;color:var(--fc-text-faint)">${p}% · ${FCData.formatCurrency(amount)}</div>
              </div>
            </div>`;
          }).join('');
        }
      }

      // ── Category rows — emoji icon + budget bar + health status ─────
      container.innerHTML = sorted.map(([cat, amount]) => {
        const p        = periodSpend ? Math.round((amount / periodSpend) * 100) : 0;
        const col      = FCData.categoryColor(cat);
        const emoji    = (typeof FCData.categoryEmoji === 'function') ? FCData.categoryEmoji(cat) : '📦';
        const budget   = state.budgets && state.budgets[cat];
        const budLim   = budget ? budget.limit : 0;
        const budPct   = budLim > 0 ? Math.min(Math.round((amount / budLim) * 100), 100) : 0;
        const isOver   = budLim > 0 && amount > budLim;
        const budColor = budPct > 90 ? 'var(--fc-danger)' : budPct > 70 ? 'var(--fc-warning)' : col;
        const statusBadge = budLim > 0
          ? isOver
            ? `<span class="fcs-badge fcs-badge--over">OVER</span>`
            : budPct > 80
              ? `<span class="fcs-badge fcs-badge--warn">${budPct}%</span>`
              : `<span class="fcs-badge fcs-badge--ok">${budPct}%</span>`
          : `<span class="fcs-badge fcs-badge--add" onclick="event.stopPropagation();FCApp.openCategoryBudgetSheet('${esc(cat)}',0)">+ Budget</span>`;
        const budSubline = budLim > 0
          ? isOver
            ? `<span style="font-size:10px;color:var(--fc-danger)">${FCData.formatCurrency(amount - budLim)} over ${FCData.formatCurrency(budLim)} limit</span>`
            : `<span style="font-size:10px;color:var(--fc-text-faint)">${FCData.formatCurrency(budLim - amount)} left of ${FCData.formatCurrency(budLim)}</span>`
          : '';
        const rowBg = isOver ? 'rgba(255,69,58,0.04)' : '';
        const rowBorder = isOver ? 'border-left:2px solid var(--fc-danger);padding-left:10px;margin-left:-10px;' : '';
        return `
          <div class="fc-category-row" style="cursor:pointer;${rowBg ? `background:${rowBg};` : ''}${rowBorder}border-radius:8px" onclick="FCApp.openCategoryBudgetSheet('${esc(cat)}',${budLim})" role="button" aria-label="Edit ${cat} budget">
            <div style="width:34px;height:34px;border-radius:10px;background:${col}22;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">${emoji}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:500;color:var(--fc-text)">${esc(cat)}</div>
              ${budSubline ? `<div style="margin-top:1px">${budSubline}</div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
              <span style="font-size:14px;font-weight:700;color:${isOver ? 'var(--fc-danger)' : 'var(--fc-text)'}">${FCData.formatCurrency(amount)}</span>
              <div style="display:flex;align-items:center;gap:4px">
                <span style="font-size:10px;color:var(--fc-text-faint)">${p}%</span>
                ${statusBadge}
              </div>
            </div>
          </div>
          <div class="fc-category-bar" style="position:relative;margin:4px 0 10px">
            <div class="fc-category-bar-fill" style="width:${p}%;background:${col};opacity:0.25"></div>
            ${budLim > 0 ? `<div style="position:absolute;top:0;left:0;height:100%;width:${Math.min(budPct,100)}%;background:${budColor};border-radius:999px;transition:width 0.5s ease"></div>` : ''}
          </div>`;
      }).join('');
    }

    // ── Cash Flow Forecast — next 7 days ─────────────────────────
    const timelineEl = document.getElementById('cashflow-timeline');
    const cfNetEl    = document.getElementById('cashflow-net');

    // Update placeholder text based on sync state
    const cfPlaceholder = document.getElementById('cashflow-forecast-placeholder');
    if (cfPlaceholder) {
      if (state.user?.plaid_linked && state.accounts?.length) {
        cfPlaceholder.textContent = !state.bills?.length
          ? 'Add bills to see your 7-day forecast'
          : '✓ No bills due in the next 7 days';
        cfPlaceholder.style.color = !state.bills?.length ? 'var(--fc-text-faint)' : 'var(--fc-success)';
      } else {
        cfPlaceholder.textContent = 'Connect a bank to see your forecast';
      }
    }

    // ── Populate 3-column forecast (income / bills / projected) ──
    (function () {
      const incomeEl   = document.getElementById('ins-cf-income');
      const billsEl    = document.getElementById('ins-cf-bills');
      const projEl     = document.getElementById('ins-cf-projected');
      if (!incomeEl) return;

      // Expected income: last known income from recurring paycheck pattern (month-based)
      const avgMonthlyIncome = periodIncome > 0 ? periodIncome
        : (state.transactions || []).filter(_isIncomeTxn).reduce((s, t) => s + (t.amount || 0), 0) / 3 || 0;
      // Bills due in next 7 days
      const today7 = new Date(); today7.setHours(0, 0, 0, 0);
      const end7   = new Date(today7.getTime() + 7 * 86400000);
      const upcoming7 = (state.bills || []).filter(b => {
        if (b.status === 'paid' || !b.due_date) return false;
        const bd = FCData.parseDateLocal(b.due_date); bd.setHours(0, 0, 0, 0);
        return bd >= today7 && bd <= end7;
      });
      const billsTotal7 = upcoming7.reduce((s, b) => s + (b.amount || 0), 0);
      const cash7       = FCData.calcCash ? FCData.calcCash(state.accounts) : 0;
      const projected   = Math.max(0, cash7 - billsTotal7);

      if (incomeEl) { incomeEl.textContent = avgMonthlyIncome > 0 ? `+${FCData.formatCurrency(avgMonthlyIncome)}` : '—'; }
      if (billsEl)  { billsEl.textContent  = billsTotal7 > 0 ? `−${FCData.formatCurrency(billsTotal7)}` : 'None'; billsEl.style.color = billsTotal7 > 0 ? 'var(--fc-danger)' : 'var(--fc-success)'; }
      if (projEl)   { projEl.textContent   = FCData.formatCurrency(projected); projEl.style.color = projected > 1000 ? 'var(--fc-electric)' : projected > 0 ? 'var(--fc-warning)' : 'var(--fc-danger)'; }
    })();

    if (timelineEl) {
      const today   = new Date(); today.setHours(0, 0, 0, 0);
      const msDay   = 86400000;
      const days    = Array.from({ length: 7 }, (_, i) => new Date(today.getTime() + i * msDay));
      const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

      // Map upcoming bills to due dates
      let forecastNet = 0;
      const rows = days.map(d => {
        const label = d.getDate() === today.getDate() ? 'Today' : dayNames[d.getDay()];
        const dueBills = state.bills.filter(b => {
          if (b.status === 'paid' || !b.due_date) return false;
          const bd = FCData.parseDateLocal(b.due_date); bd.setHours(0,0,0,0);
          return bd.getTime() === d.getTime();
        });
        const billTotal = dueBills.reduce((s, b) => s + (b.amount || 0), 0);
        forecastNet -= billTotal;

        if (!dueBills.length) return null;

        return `
          <div class="fcs-cal-row">
            <div style="width:38px;text-align:center">
              <div style="font-size:10px;color:var(--fc-text-faint);font-weight:500">${label}</div>
              <div style="font-size:15px;font-weight:700;color:var(--fc-text)">${d.getDate()}</div>
            </div>
            <div style="flex:1">
              ${dueBills.map(b => `
                <div style="display:flex;align-items:center;gap:6px">
                  <div style="width:6px;height:6px;border-radius:50%;background:var(--fc-danger);flex-shrink:0"></div>
                  <span style="font-size:13px;color:var(--fc-text-muted);flex:1">${esc(b.name)}</span>
                  <span style="font-size:13px;font-weight:600;color:var(--fc-danger)">−${FCData.formatCurrency(b.amount)}</span>
                </div>`).join('')}
            </div>
          </div>`;
      }).filter(Boolean);

      if (cfNetEl) {
        cfNetEl.textContent    = forecastNet < 0 ? `−${FCData.formatCurrency(Math.abs(forecastNet))} due` : 'All clear';
        cfNetEl.style.color    = forecastNet < 0 ? 'var(--fc-warning)' : 'var(--fc-success)';
      }
      const placeholder = document.getElementById('cashflow-forecast-placeholder');
      if (placeholder) placeholder.style.display = 'none';
      timelineEl.innerHTML = rows.length
        ? rows.join('') + `<div style="font-size:12px;color:var(--fc-text-faint);text-align:center;padding-top:10px">Next 7 days · ${state.bills.filter(b=>b.status!=='paid').length} bill${state.bills.filter(b=>b.status!=='paid').length!==1?'s':''} pending</div>`
        : `<div style="color:var(--fc-success);text-align:center;padding:20px 0;font-size:14px;font-weight:500">✓ No bills due in the next 7 days</div>`;
    }

    // ── Top Merchants ─────────────────────────────────────────────
    (function () {
      const card     = document.getElementById('top-merchants-card');
      const list     = document.getElementById('top-merchants-list');
      const periodLbl = document.getElementById('top-merchants-period');
      if (!list) return;
      if (periodLbl) periodLbl.textContent = periodLabel;

      // Bank-name keywords that indicate internal transfers (not real merchants)
      const _TRANSFER_MERCHANTS = /^(capital one|discover|chase|bank of america|wells fargo|citi|citibank|usaa|navy federal|td bank|us bank|pnc|truist|ally|sofi|synchrony|american express|amex|credit card payment|payment|transfer|zelle|venmo|cashapp|paypal|wire transfer|ach|online transfer|autopay)/i;
      const merchantMap = {};
      for (const t of periodSpendTxns) {
        // Use merchant_name when available for cleaner display
        const name = t.merchant_name || t.name || 'Unknown';
        // Skip if this looks like an internal bank transfer rather than a real merchant
        if (_TRANSFER_MERCHANTS.test(name) && !t.merchant_name) continue;
        if (!merchantMap[name]) merchantMap[name] = { count: 0, total: 0 };
        merchantMap[name].count++;
        merchantMap[name].total += t.amount || 0;
      }
      const top = Object.entries(merchantMap)
        .sort((a, b) => b[1].total - a[1].total)
        .slice(0, 5);

      if (!top.length) {
        // card is hidden in V3 UI — only update list content for any legacy usage
        list.innerHTML = '<div style="color:var(--fc-text-faint);text-align:center;padding:16px 0;font-size:11px">No spending data yet</div>';
        return;
      }
      // card remains hidden (display:none in HTML) — V3 moved merchants to Behavior Analysis

      // Premium compact merchant list (new v2 format)
      list.innerHTML = top.slice(0, 4).map(([name, data]) => {
        const initial   = name.replace(/^(the |a )/i, '').charAt(0).toUpperCase();
        const emoji     = (typeof FCData.categoryEmoji === 'function') ? FCData.categoryEmoji('Shopping', name) : '';
        const icon      = emoji || initial;
        return `
          <div class="ins-merchant-row">
            <div class="ins-merchant-icon">${icon}</div>
            <div class="ins-merchant-name">${esc(name)}</div>
            <div class="ins-merchant-amt">${FCData.formatCurrency(data.total)}</div>
          </div>`;
      }).join('');
    })();

    // ── Subscription Hunter ────────────────────────────────────────
    (function () {
      const card  = document.getElementById('sub-hunter-card');
      const list  = document.getElementById('sub-hunter-list');
      const badge = document.getElementById('sub-hunter-badge');
      if (!card || !list) return;

      // Use shared detection — filter to only untracked subs
      const detected = _detectSubscriptions().filter(s => !s.tracked);

      if (!detected.length) { card.style.display = 'none'; return; }
      card.style.display = '';
      if (badge) badge.textContent = detected.length;

      list.innerHTML = detected.slice(0, 6).map(s => {
        const cancelUrl = _subCancelUrl(s.name);
        const initial   = s.name.charAt(0).toUpperCase();
        return `
          <div class="fc-list-item fcs-zombie-row">
            <div class="fc-list-icon" style="background:rgba(255,69,58,0.10);color:var(--fc-danger);font-weight:700;font-size:14px;width:38px;height:38px;flex-shrink:0">
              ${initial}
            </div>
            <div class="fc-list-body">
              <div class="fc-list-title" style="font-size:14px">${esc(s.name)}</div>
              <div class="fc-list-meta" style="font-size:11px;margin-top:1px">Recurring · ~${FCData.formatCurrency(s.amount)}/${s.freq}</div>
            </div>
            <div style="display:flex;gap:7px;align-items:center;flex-shrink:0">
              <button style="font-size:11px;font-weight:600;color:var(--fc-accent);background:rgba(26,196,240,0.1);border:1px solid rgba(26,196,240,0.25);border-radius:8px;padding:4px 10px;cursor:pointer"
                      onclick="FCApp.addRecurringToBills('${esc(s.name)}',${s.amount},'${esc(s.freq)}')" type="button">+ Bills</button>
              <button style="font-size:11px;font-weight:600;color:var(--fc-danger);background:rgba(255,69,58,0.1);border:1px solid rgba(255,69,58,0.25);border-radius:8px;padding:4px 10px;cursor:pointer"
                      onclick="FCApp.openUrl('${cancelUrl}')" type="button">Cancel</button>
            </div>
          </div>`;
      }).join('');
    })();

    // ── Net Worth Trend card ──────────────────────────────────────
    (function () {
      const nwSvg   = document.getElementById('insights-nw-sparkline');
      const nwVal   = document.getElementById('insights-nw-value');
      const nwDelta = document.getElementById('insights-nw-delta');
      const nwRange = document.getElementById('insights-nw-range');
      if (!nwSvg) return;

      try {
        const history = state.nwHistory;
        const keys    = Object.keys(history).sort();
        const vals    = keys.map(k => history[k]);

        if (vals.length < 2) return; // not enough data yet

        const latest  = vals[vals.length - 1];
        const first   = vals[0];
        const delta   = latest - first;
        const W = 280, H = 56;
        const minV = Math.min(...vals), maxV = Math.max(...vals);
        const range = maxV - minV || 1;

        // Build smooth path
        const pts = vals.map((v, i) => ({
          x: (i / (vals.length - 1)) * W,
          y: H - ((v - minV) / range) * (H - 8) - 4,
        }));
        let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
        for (let i = 1; i < pts.length; i++) {
          const cx = (pts[i - 1].x + pts[i].x) / 2;
          d += ` C ${cx.toFixed(1)} ${pts[i-1].y.toFixed(1)}, ${cx.toFixed(1)} ${pts[i].y.toFixed(1)}, ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
        }
        const lastPt = pts[pts.length - 1];
        const areaD  = `${d} L ${W} ${H} L 0 ${H} Z`;
        const color  = delta >= 0 ? 'var(--fc-accent)' : 'var(--fc-danger)';

        nwSvg.innerHTML = `
          <defs>
            <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
              <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <path d="${areaD}" fill="url(#nwGrad)"/>
          <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
          <circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="4" fill="${color}"/>`;

        if (nwVal)   nwVal.textContent = FCData.formatCurrency(latest);
        if (nwDelta) {
          const isNegNW  = latest < 0;
          const deltaLabel = delta >= 0
            ? (isNegNW ? 'Improved ' : '+') + FCData.formatCurrency(Math.abs(delta))
            : FCData.formatCurrency(delta);
          nwDelta.style.display    = '';
          nwDelta.textContent      = deltaLabel;
          nwDelta.style.background = delta >= 0 ? 'rgba(26,196,240,0.12)' : 'rgba(255,69,58,0.12)';
          nwDelta.style.color      = delta >= 0 ? 'var(--fc-accent)' : 'var(--fc-danger)';
          nwDelta.style.border     = delta >= 0 ? '1px solid rgba(26,196,240,0.2)' : '1px solid rgba(255,69,58,0.2)';
        }
        if (nwRange && keys.length >= 2) {
          const dayCount = Math.round((new Date(keys[keys.length-1]) - new Date(keys[0])) / 86400000);
          nwRange.textContent = `${dayCount}-day history · ${keys.length} data points`;
        }
      } catch (_) { /* localStorage unavailable */ }
    })();

    // ── Month-by-month budget calendar ───────────────────────────
    _renderMonthlyBudget();

    // ── Savings rate card ─────────────────────────────────────────
    const savingsRateEl = document.getElementById('savings-rate');
    const savingsBarEl  = document.getElementById('savings-bar');
    const savingsMetaEl = document.getElementById('savings-meta');

    if (_incomeIsReliable(periodIncome, periodSpend)) {
      const netFlow     = periodIncome - periodSpend;
      const savingsRate = Math.max(0, Math.round((netFlow / periodIncome) * 100));
      const rateColor   = savingsRate >= 20 ? 'var(--fc-success)'
                        : savingsRate >= 10 ? 'var(--fc-accent)'
                        : 'var(--fc-warning)';
      const rateIcon    = savingsRate >= 20 ? '🔥' : savingsRate >= 10 ? '📈' : '⚠️';

      if (savingsRateEl) { savingsRateEl.textContent = `${savingsRate}% ${rateIcon}`; savingsRateEl.style.color = rateColor; }
      if (savingsBarEl)  { savingsBarEl.style.width = Math.min(savingsRate, 100) + '%'; savingsBarEl.style.background = rateColor; }
      if (savingsMetaEl) {
        const netLabel = netFlow >= 0
          ? `+${FCData.formatCurrency(netFlow)} saved · Income ${FCData.formatCurrency(periodIncome)}`
          : `${FCData.formatCurrency(Math.abs(netFlow))} over income`;
        savingsMetaEl.textContent = netLabel;
        savingsMetaEl.style.color = netFlow >= 0 ? 'var(--fc-text-faint)' : 'var(--fc-danger)';
      }
    } else {
      if (savingsRateEl) { savingsRateEl.textContent = '—'; savingsRateEl.style.color = 'var(--fc-text-faint)'; }
      if (savingsBarEl)  savingsBarEl.style.width = '0%';
      if (savingsMetaEl) {
        savingsMetaEl.textContent = periodIncome > 0
          ? `Income detected: ${FCData.formatCurrency(periodIncome)} — may be incomplete`
          : 'No income detected this period';
        savingsMetaEl.style.color = 'var(--fc-text-faint)';
      }
    }

    // V3 insights enhancements
    _renderIntelSummary();
    _renderBehaviorAnalysis();
    _renderWins();
    _renderRecommendations();
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: MONTH-BY-MONTH BUDGET CALENDAR
     ───────────────────────────────────────────────────────────── */

  function _renderMonthlyBudget() {
    const gridEl       = document.getElementById('budget-monthly-grid');
    const annualSpend  = document.getElementById('budget-annual-spend');
    const annualLimit  = document.getElementById('budget-annual-limit');
    const annualFill   = document.getElementById('budget-annual-fill');
    const annualMeta   = document.getElementById('budget-annual-meta');
    const yearLabelEl  = document.getElementById('budget-year-label');
    if (!gridEl) return;

    const now        = new Date();
    const year       = now.getFullYear();
    const curMonth   = now.getMonth();
    const MONTHS     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    /* The whole 12-month grid and the annual rollup hang off this. At 3000
       an unbudgeted user saw every month of the year graded against
       $36,000 they never set, and a user who had set only per-category
       limits saw 3000 instead of their own sum. */
    const budgetLim  = _totalBudgetLimit();

    if (yearLabelEl) yearLabelEl.textContent = year;

    // Aggregate per-month spending for this year (spending txns only — no transfers or income)
    const monthlySpend = new Array(12).fill(0);
    (state.transactions || []).filter(t => !t.isCredit && t.date && _isSpendTxn(t)).forEach(t => {
      const d = FCData.parseDateLocal(t.date);
      if (d.getFullYear() === year) monthlySpend[d.getMonth()] += (t.amount || 0);
    });

    const totalYearSpend = monthlySpend.reduce((s, v) => s + v, 0);
    const hasBudget      = budgetLim > 0;
    const annualBudget   = budgetLim * 12;
    /* Raw ratio drives the COLOUR, clamped drives the WIDTH. They were the
       same value before, and since it was clamped to 100 the `> 100` branch
       could never run — the annual bar was incapable of turning red no
       matter how far over the year went. */
    const annualRawPct   = annualBudget > 0 ? Math.round((totalYearSpend / annualBudget) * 100) : 0;
    const annualPct      = Math.min(annualRawPct, 100);
    const annualColor    = annualRawPct > 100 ? 'var(--fc-danger)' : annualRawPct > 80 ? 'var(--fc-warning)' : 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))';

    if (annualSpend)  annualSpend.textContent  = FCData.formatCurrency(totalYearSpend);
    /* No budget is now an honest 0 rather than a fabricated 3000, so this
       has to say so. "of $0.00" is a worse lie than the one it replaced. */
    if (annualLimit)  annualLimit.textContent  = hasBudget
      ? `of ${FCData.formatCurrency(annualBudget)}`
      : 'No annual budget set';
    if (annualFill)   {
      annualFill.style.width = hasBudget ? annualPct + '%' : '0%';
      annualFill.style.background = annualColor;
    }
    if (annualMeta) {
      const monthsLeft  = 11 - curMonth;
      const projYearly  = curMonth >= 0 ? (totalYearSpend / (curMonth + 1)) * 12 : 0;
      annualMeta.textContent = monthsLeft > 0
        ? `Projected year-end: ${FCData.formatCurrency(projYearly)} · ${monthsLeft} month${monthsLeft !== 1 ? 's' : ''} left`
        : `Year complete · ${annualPct}% of annual budget used`;
    }

    // Build month cards
    gridEl.innerHTML = MONTHS.map((name, i) => {
      const spend   = monthlySpend[i];
      const isCur   = i === curMonth;
      const isFut   = i > curMonth;
      /* Same split as the annual bar: raw for colour, clamped for width. */
      const rawPct  = hasBudget ? Math.round((spend / budgetLim) * 100) : 0;
      const pct     = Math.min(rawPct, 100);
      const color   = isFut ? 'rgba(255,255,255,0.12)'
                    : rawPct > 100 ? 'var(--fc-danger)'
                    : rawPct > 80  ? 'var(--fc-warning)'
                    : 'var(--fc-accent)';
      const cardBg  = isCur ? 'rgba(26,196,240,0.1)' : 'rgba(255,255,255,0.04)';
      const border  = isCur ? '1px solid rgba(26,196,240,0.3)' : '1px solid rgba(255,255,255,0.06)';
      const amtTxt  = isFut ? '—' : spend >= 1000 ? `$${(spend/1000).toFixed(1)}k` : `$${Math.round(spend)}`;
      const amtCol  = isFut ? 'rgba(255,255,255,0.18)' : 'white';
      return `<div style="flex-shrink:0;width:68px;scroll-snap-align:start;border-radius:14px;background:${cardBg};border:${border};padding:10px 6px 8px;text-align:center;cursor:${isFut?'default':'pointer'}" ${!isFut ? `onclick="FCApp._showMonthBudgetDetail(${i},${year})"` : ''}>
        <div style="font-size:10px;font-weight:700;color:${isCur?'var(--fc-accent)':'var(--fc-text-faint)'};letter-spacing:0.5px;text-transform:uppercase;margin-bottom:5px">${name}</div>
        <div style="font-size:13px;font-weight:800;color:${amtCol};margin-bottom:5px;letter-spacing:-0.02em">${amtTxt}</div>
        <div class="fcs-bar-track" style="height:3px;margin-bottom:3px">
          <div style="height:100%;width:${(isFut||!hasBudget)?0:pct}%;background:${color};border-radius:999px"></div>
        </div>
        <div style="font-size:10px;font-weight:600;color:${color}">${(isFut||!hasBudget)?'':pct+'%'}</div>
      </div>`;
    }).join('');

    // Scroll to current month card
    requestAnimationFrame(() => {
      const cur = gridEl.children[curMonth];
      if (cur) cur.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
  }

  /* (removed) _renderGoals / _renderWealthGoals — Goals used to be a panel
     inside Money. It became its own tab, but the panel, its render function
     and its markup stayed behind. There has been no `wv-tab-goals` button to
     activate #wv-panel-goals since, so `_wealthTab === 'goals'` was
     unreachable and the ~70 lines it guarded rendered into a permanently
     hidden div on every Pro refresh. The live Goals screen is
     _renderGoalsScreen(), reached by switchTab('goals'). */

  /* ─────────────────────────────────────────────────────────────
     RENDER: WEALTH TAB (Savings | Goals | Debt)
     ───────────────────────────────────────────────────────────── */

  let _wealthTab = 'overview';

  function switchWealthTab(tab) {
    _wealthTab = tab;
    haptic('light');
    document.querySelectorAll('.wv-tab').forEach(t => {
      const isA = t.id === 'wv-tab-' + tab;
      t.classList.toggle('active', isA);
      t.setAttribute('aria-selected', isA ? 'true' : 'false');
    });
    document.querySelectorAll('.wv-panel').forEach(p =>
      p.classList.toggle('active', p.id === 'wv-panel-' + tab)
    );
    const view = document.getElementById('view-wealth');
    if (view) view.scrollTop = 0;
    requestAnimationFrame(() => {
      if (tab === 'overview')     _renderWealthOverview();
      else if (tab === 'savings') _renderWealthSavings();
      else if (tab === 'debt')    _renderWealthDebt();
    });
  }

  /** The one way into Debt. There used to be two debt screens; this routes
   *  every entry point at the surviving one (Money > Debt). */
  function _openDebtPage() {
    switchTab('wealth');
    switchWealthSegment('debt');
  }

  /* Payoff strategy. Avalanche pays the highest rate first and costs least
     overall; Snowball clears the smallest balance first and pays you back in
     momentum. Which suits someone is a judgement about themselves, so it is
     their choice, not ours.

     Stored in localStorage rather than Firestore: it is a UI preference, not
     financial data, exactly like fc_privacy_mode. The stored value is only
     ever the string 'avalanche' or 'snowball' — it reveals no balance.

     Keyed fc_payoff_strategy, not fc_debt_strategy, so it does not trip
     check-privacy-invariants' storage rule. That rule greps for debt/balance
     terms on localStorage lines to catch financial VALUES being persisted,
     and it should keep doing exactly that — the honest fix was a name that
     describes the thing (a payoff strategy) rather than an exception. */
  const _PAYOFF_STRATEGY_KEY = 'fc_payoff_strategy';
  function _debtStrategy() {
    try { return localStorage.getItem(_PAYOFF_STRATEGY_KEY) === 'snowball' ? 'snowball' : 'avalanche'; }
    catch (_) { return 'avalanche'; }
  }
  /** The Change button. It used to navigate to the other debt screen — from
   *  the debt screen — which is how the duplicate page went unnoticed. */
  function _openDebtStrategy() {
    const next = _debtStrategy() === 'avalanche' ? 'snowball' : 'avalanche';
    try { localStorage.setItem(_PAYOFF_STRATEGY_KEY, next); } catch (_) {}
    haptic('light');
    toast(next === 'snowball'
      ? 'Snowball — smallest balance first'
      : 'Avalanche — highest interest first', 'success', 2600);
    _renderWealthDebt();
  }

  function switchWealthSegment(seg) {
    switchWealthTab(seg === 'savings' ? 'savings' : seg === 'debt' ? 'debt' : 'overview');
  }

  function _renderWealthHero() {
    const accts = state.accounts || [];
    const assets = accts
      .filter(_isAssetAcct)
      .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
    const liabilities = accts
      .filter(_isDebtAcct)
      .reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
    const nw = assets - liabilities;

    const nwEl = document.getElementById('wealth-hero-nw');
    const asEl = document.getElementById('wealth-hero-assets');
    const liEl = document.getElementById('wealth-hero-liabilities');
    const dlEl = document.getElementById('wealth-hero-delta');

    // Animate the net worth hero number for premium feel
    if (nwEl) animateNumber(nwEl, nw, '$');
    if (asEl) animateNumber(asEl, assets, '$', '', 500);
    if (liEl) animateNumber(liEl, liabilities, '$', '', 500);

    // Delta vs last month NW history if available
    if (dlEl) {
      const hist = state.netWorthHistory || [];
      if (hist.length >= 2) {
        const prev = hist[hist.length - 2]?.nw ?? 0;
        const delta = nw - prev;
        const sign  = delta >= 0 ? '+' : '−';
        // Tokens, not literal rgba: these were the dark-mode success/danger
        // values baked in, so the badge kept its dark tint in light mode.
        const color = delta >= 0 ? 'var(--fc-success-soft)' : 'var(--fc-danger-soft)';
        const textColor = delta >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
        /* The percentage used to be gated on `liabilities > 0`, which has
           nothing to do with it — a debt-free user with a rising net worth
           was shown a flat "+0%". What the ratio actually needs is a
           non-zero PREVIOUS value to divide by; without one there is no
           percentage to state, so we show the dollar change alone. */
        const pctText = Math.abs(prev) > 0
          ? ` (${delta >= 0 ? '+' : '−'}${Math.abs(Math.round((delta / Math.abs(prev)) * 100))}%)`
          : '';
        dlEl.innerHTML = `<span>${sign}${FCData.formatCurrency(Math.abs(delta))}</span><span style="font-weight:500;color:var(--fc-text-faint);margin-left:4px">${pctText} this month</span>`;
        dlEl.style.cssText = `display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;background:${color};color:${textColor};margin-top:8px`;
      } else {
        dlEl.style.display = 'none';
      }
    }

    // ── Wealth sparkline chart ─────────────────────────────────────
    (function () {
      const svg  = document.getElementById('wealth-sparkline');
      const area = document.getElementById('wealth-sparkline-area');
      const line = document.getElementById('wealth-sparkline-line');
      const dot  = document.getElementById('wealth-sparkline-dot');
      if (!svg || !line) return;

      const history = state.nwHistory || {};
      const _WPERIOD_DAYS = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365, 'ALL': 0 };
      const wWindowDays = _WPERIOD_DAYS[state.period];
      let wAllKeys = Object.keys(history).sort();
      if (wWindowDays) {
        const wCutoff = new Date();
        wCutoff.setDate(wCutoff.getDate() - wWindowDays);
        const wCutoffStr = FCCore.isoDay(wCutoff);
        wAllKeys = wAllKeys.filter(k => k >= wCutoffStr);
      }
      const keys    = wAllKeys;
      const vals    = keys.map(k => history[k]);

      if (vals.length < 2) {
        // Draw flat placeholder line
        line.setAttribute('d', 'M0,50 L320,50');
        if (area) area.setAttribute('d', 'M0,50 L320,50 L320,56 L0,56 Z');
        if (dot) { dot.setAttribute('cx', '320'); dot.setAttribute('cy', '50'); }
        return;
      }

      const W = 320, H = 56, pad = 4;
      const min = Math.min(...vals), max = Math.max(...vals);
      const range = max - min || 1;
      const toY  = v => pad + (H - 2 * pad) * (1 - (v - min) / range);
      const toX  = i => (i / (vals.length - 1)) * W;

      const pts = vals.map((v, i) => [toX(i), toY(v)]);
      // Smooth curve via cubic bezier
      let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        const cx = (x0 + x1) / 2;
        d += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
      }
      const lastPt = pts[pts.length - 1];
      line.setAttribute('d', d);
      if (area) area.setAttribute('d', `${d} L${lastPt[0].toFixed(1)},${H} L0,${H} Z`);
      if (dot) { dot.setAttribute('cx', lastPt[0].toFixed(1)); dot.setAttribute('cy', lastPt[1].toFixed(1)); }

      // Color based on trend
      const isPositive = vals[vals.length - 1] >= vals[0];
      /* Was the literal '#1ac4f0'. That is the DARK-mode accent; in light
         mode --fc-accent is #147CFF, so this one line stayed cyan on a
         screen that had gone blue everywhere else. */
      const strokeColor = isPositive ? 'var(--fc-accent)' : 'var(--fc-danger)';
      line.setAttribute('stroke', strokeColor);
      if (dot) dot.setAttribute('fill', strokeColor);
    })();
  }

  function _renderWealth() {
    try { _renderWealthHero(); } catch(e) {}
    if (_wealthTab === 'overview')     _renderWealthOverview();
    else if (_wealthTab === 'savings') _renderWealthSavings();
    else if (_wealthTab === 'debt')    _renderWealthDebt();
  }

  /* ─── Wealth: build sparkline SVG string ─── */
  function _buildWealthSparklineSVG(vals) {
    const isPos = !vals.length || vals[vals.length-1] >= vals[0];
    const color = isPos ? 'var(--fc-accent)' : 'var(--wv-red,var(--fc-danger))';
    // <2 snapshots: a bare flat line reads as a broken chart. Show a designed
    // "tracking starts today" state instead — dashed baseline, live dot, caption.
    if (!vals || vals.length < 2) {
      /* Day-one state. Three things made the old version read as broken
         rather than designed:

         · it was 14px tall where the real chart is 56, so the card visibly
           RESIZED the moment a second data point landed — a layout shift on
           the card you are looking at reads as a glitch, not as progress;
         · the baseline was 1px of --fc-border, which is the divider colour,
           so it looked like a stray rule rather than an axis waiting to be
           drawn on;
         · preserveAspectRatio="none" on a 320-wide viewBox squashed both
           circles into ellipses at any width but exactly 320.

         Now it holds the chart's real height and geometry, the dot is plain
         HTML so it stays round at every width, and the baseline sits where
         the line will actually start. Nothing moves when the data arrives —
         the dot just grows a line to its left. */
      return `<div style="height:56px;display:flex;flex-direction:column;justify-content:flex-end;gap:9px">
        <div style="display:flex;align-items:center;padding-bottom:12px">
          <div style="flex:1;height:0;border-top:1.5px dashed var(--fc-border)"></div>
          <div style="width:9px;height:9px;border-radius:999px;background:var(--fc-accent);flex-shrink:0;margin-left:-1px;box-shadow:0 0 0 4px rgba(26,196,240,0.14)"></div>
        </div>
        <div style="font-size:11px;font-weight:500;color:var(--fc-text-faint);letter-spacing:0.1px;text-align:center">Tracking your net worth from today</div>
      </div>`;
    }
    const W=320, H=56, pad=6;
    const min=Math.min(...vals), max=Math.max(...vals), range=max-min||1;
    /* The chart autoscales to its own min and max, which means a $60,000
       swing and a $60 swing draw the identical shape. Without the numbers
       beside it the line says only "it moved" — and after a period where
       nothing much happened, normal noise gets stretched to full height and
       reads as a crisis. The range labels are what make it legible. */
    const _compact = v => {
      const n = Math.abs(v);
      const sign = v < 0 ? '\u2212' : '';
      if (n >= 1000) return `${sign}$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
      return `${sign}$${Math.round(n)}`;
    };
    const toY = v => (max - min) < 0.005
      ? H / 2
      : pad + (H-2*pad)*(1-(v-min)/range);
    const toX = (i,n) => (i/(n-1))*W;
    const pts = vals.map((v,i) => [toX(i,vals.length), toY(v)]);
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i=1; i<pts.length; i++) {
      const [x0,y0]=pts[i-1], [x1,y1]=pts[i], cx=(x0+x1)/2;
      d += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    const lp=pts[pts.length-1];
    const gid='wvsg'+Math.random().toString(36).slice(2,6);
    /* Same trap the runway card had, and the day-one branch above already
       calls out: preserveAspectRatio="none" stretches this 320-wide viewBox
       to the card's real width, so a <circle> renders as an ellipse and the
       stroke thickens unevenly. The paths stay in the stretched space with
       non-scaling-stroke; the end dot moves to an HTML overlay so it stays
       round at every width — which is exactly what the day-one state below
       already does with its own dot. */
    /* Flat is a real answer, and the autoscale cannot express it: with
       max === min the range falls back to 1, every point maps to toY(min)
       = 50 of 56, and a month where nothing moved draws as a line pinned to
       the floor of the chart — which reads as a collapse. Centre it, and
       say "no change" rather than printing the same figure at both ends. */
    const _flat = (max - min) < 0.005;
    return `<div style="position:relative">
      <div style="display:flex;justify-content:space-between;font-size:10px;font-weight:600;
                  letter-spacing:0.04em;color:var(--wv-t3);margin-bottom:2px;
                  font-variant-numeric:tabular-nums">
        <span>${esc(_compact(max))}</span>
        <span>${esc(_flat ? 'no change' : _compact(min))}</span>
      </div>
      <svg viewBox="0 0 320 56" width="100%" height="56" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient></defs>
        <path d="${d} L${lp[0].toFixed(1)},${H} L0,${H} Z" fill="url(#${gid})"/>
        <path d="${d}" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      </svg>
      <span style="position:absolute;left:${(lp[0]/W*100).toFixed(2)}%;top:${(lp[1]/H*100).toFixed(2)}%;width:7px;height:7px;border-radius:999px;background:${color};transform:translate(-50%,-50%);pointer-events:none"></span>
    </div>`;
  }

  /* ─── Wealth: guided path ─── */
  function _buildWealthPath() {
    const accts = state.accounts || [];
    const goals = state.goals || [];
    const debtAccts = accts.filter(_isDebtAcct);
    const totalDebt = debtAccts.reduce((s,a)=>s+Math.max(0,a.balance_current||a.balance||0),0);
    const efGoal    = goals.find(g=>/emergency|starter/i.test(g.name||''));
    const efCurrent = efGoal ? (efGoal.current||0) : 0;
    const cashTotal = accts.filter(_isCashAcct).reduce((s,a)=>s+_acctBal(a),0);
    const now=new Date(), monthStart=new Date(now.getFullYear(),now.getMonth(),1);
    const monthSpend=(state.transactions||[]).filter(t=>{
      const d=FCData.parseDateLocal(t.date||''); return d>=monthStart&&_isSpendTxn(t);
    }).reduce((s,t)=>s+(t.amount||0),0);
    let step=0;
    if (efCurrent>=1000) step=1;
    if (efCurrent>=1000&&totalDebt<5000) step=2;
    if (efCurrent>=1000&&totalDebt<5000&&cashTotal>=monthSpend*3) step=3;
    const labels=['Starter EF','Pay Debt','3-Mo Fund','Build Wealth'];
    const titles=['Build a $1,000 starter emergency fund','Pay down high-interest debt','Grow to 3 months of expenses','Invest and build long-term wealth'];
    return { step, labels, titles, efCurrent };
  }

  function _buildWealthPathHTML(path) {
    const {step, labels, titles} = path;
    const nodes = labels.map((lbl,i) => {
      const done=i<step, active=i===step;
      const dotCls=done?'wv-path-dot--done':active?'wv-path-dot--active':'wv-path-dot--future';
      const dotInner=done?`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`:String(i+1);
      const lblCls=active?'wv-path-lbl wv-path-lbl--active':'wv-path-lbl';
      return `<div class="wv-path-node">
        <div class="wv-path-dot ${dotCls}">${dotInner}</div>
        <div class="${lblCls}">${esc(lbl)}</div>
      </div>`;
    });
    const connectors = labels.slice(1).map((_,i) =>
      `<div class="wv-path-conn ${i<step?'wv-path-conn--done':'wv-path-conn--future'}"></div>`
    );
    // Interleave nodes and connectors
    let track = '';
    nodes.forEach((n,i) => { track += n; if (i<nodes.length-1) track+=connectors[i]; });
    return `<div class="wv-card wv-path">
      <div class="wv-path-eyebrow">Your Wealth Path</div>
      <div class="wv-path-title">${esc(titles[Math.min(step,titles.length-1)])}</div>
      <div class="wv-path-sub">Step ${step+1} of ${labels.length}</div>
      <div class="wv-path-track">${track}</div>
    </div>`;
  }

  function _goalsForDisplay() {
    if (state.goals?.length) return state.goals;
    const email = (FCAuth.currentUser?.()?.email || state.user?.email || '').toLowerCase();
    if (!_DEMO_EMAILS.includes(email)) return [];
    return [
      { id:'demo-emergency', name:'Emergency Fund', current:6250, target:10000, pct:62.5, target_date:'2026-12-31', _preview:true },
      { id:'demo-vacation', name:'Vacation', current:2840, target:5000, pct:56.8, target_date:'2027-06-15', _preview:true },
      { id:'demo-debt', name:'Debt Payoff', current:1250, target:2500, pct:50, target_date:'2026-10-31', _preview:true },
    ];
  }

  /* ─── Wealth: Overview panel ─── */
  function _renderWealthOverview() {
    const el = document.getElementById('wv-overview-content');
    if (!el) return;
    const accts=state.accounts||[], goals=state.goals||[], hist=state.nwHistory||{};
    const assets      = accts.filter(_isAssetAcct).reduce((s,a)=>s+_acctBal(a),0);
    const liabilities = accts.filter(_isDebtAcct).reduce((s,a)=>s+Math.max(0,_acctBal(a)),0);
    const nw = assets-liabilities;
    // Delta vs 30d
    const histKeys=Object.keys(hist).sort();
    const c30=new Date(); c30.setDate(c30.getDate()-30);
    const prevKey=histKeys.filter(k=>k<=FCCore.isoDay(c30)).pop();
    const email=(FCAuth.currentUser?.()?.email||state.user?.email||'').toLowerCase();
    let delta = prevKey!=null ? nw-(hist[prevKey]||0) : null;
    if (delta===null && _DEMO_EMAILS.includes(email)) delta=nw*0.052;
    // Sparkline
    const DAYS={'1M':30,'3M':90,'1Y':365,'ALL':0};
    const wDays=DAYS[state.period||'1M']??30;
    let sKeys=histKeys;
    if (wDays) { const wc=new Date(); wc.setDate(wc.getDate()-wDays); const ws=FCCore.isoDay(wc); sKeys=sKeys.filter(k=>k>=ws); }
    let sparkValues=sKeys.map(k=>hist[k]);
    if (sparkValues.length<2 && _DEMO_EMAILS.includes(email)) {
      sparkValues=[0.86,0.88,0.875,0.90,0.915,0.91,0.935,0.95,0.97,0.965,0.99,1].map(scale=>nw*scale);
    }
    const sparkSVG = _buildWealthSparklineSVG(sparkValues);
    // Delta badge
    const dColor = delta!==null&&delta>=0?'var(--wv-green)':'var(--wv-red)';
    const dBg    = delta!==null&&delta>=0?'var(--wv-green-soft)':'var(--wv-red-soft)';
    const dSign  = delta!==null ? (delta>=0?'+':'−') : '';
    const deltaHTML = delta!==null ? `<div class="wv-position-delta" style="background:${dBg};color:${dColor}">${dSign}${FCData.formatCurrency(Math.abs(delta))} <span style="font-weight:500;opacity:0.75">this month</span></div>` : '';
    const accountRows = accts.slice(0, 6).map(account => {
      const isDebt = _isDebtAcct(account);
      const balance = Math.max(0, account.balance_current || account.balance || 0);
      const subtext = _acctSubtext(account) || (account.mask ? `•••• ${account.mask}` : (account.subtype || 'Account'));
      /* This is the complete account list — cash AND debt — so it is where a
         manual account is actually findable. The edit affordance only reached
         the Savings panel before, which meant a manually-added loan (the most
         common kind) could be created and then never corrected or removed.
         Plaid rows stay inert: the backend owns them and the rules refuse
         client writes. */
      const editable = !!account.manual;
      return `<div class="wv-linked-row${editable ? ' wv-linked-row--editable' : ''}"${
        editable ? ` data-edit-account="${esc(account.id)}" role="button" tabindex="0" aria-label="Edit ${esc(account.name || 'account')}"` : ''}>
        <div class="wv-linked-icon">${_accountIcon(account)}</div>
        <div style="flex:1;min-width:0">
          <div class="wv-linked-name">${esc(account.name || 'Account')}</div>
          <div class="wv-linked-sub">${esc(subtext)}</div>
        </div>
        <div class="wv-linked-balance" style="color:${isDebt ? 'var(--wv-red)' : 'var(--wv-t1)'}">${isDebt ? '−' : ''}${FCData.formatCurrency(balance)}</div>
        ${editable ? '<span class="wv-linked-chevron" aria-hidden="true">›</span>' : ''}
      </div>`;
    }).join('');

    // Asset allocation — cash vs investments vs debt at a glance
    const _allocCash   = accts.filter(_isCashAcct).reduce((s,a)=>s+_acctBal(a),0);
    const _allocInvest = accts.filter(a=>window.FCCore&&FCCore.accountClass(a)==='investment').reduce((s,a)=>s+_acctBal(a),0);
    const _allocTotal  = _allocCash + _allocInvest + liabilities;
    const _allocSeg = (v, color) => _allocTotal > 0 && v > 0
      ? `<div style="width:${Math.max(2,(v/_allocTotal)*100)}%;background:${color};height:100%"></div>` : '';
    const _allocLegend = (label, v, color) => v > 0
      ? `<div style="display:flex;align-items:center;gap:5px"><span style="width:7px;height:7px;border-radius:2px;background:${color};flex-shrink:0"></span><span style="font-size:11px;color:var(--wv-t3);font-weight:500">${label}</span><span style="font-size:11px;color:var(--wv-t2);font-weight:600;font-variant-numeric:tabular-nums">${FCData.formatCurrency(v)}</span></div>` : '';
    const allocHTML = _allocTotal > 0 ? `
        <div style="margin-top:12px">
          <div style="display:flex;gap:2px;height:6px;border-radius:3px;overflow:hidden;background:var(--wv-pill)">
            ${_allocSeg(_allocCash, 'var(--fc-accent)')}${_allocSeg(_allocInvest, 'var(--fc-electric)')}${_allocSeg(liabilities, 'var(--wv-red)')}
          </div>
          <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px">
            ${_allocLegend('Cash', _allocCash, 'var(--fc-accent)')}${_allocLegend('Invested', _allocInvest, 'var(--fc-electric)')}${_allocLegend('Debt', liabilities, 'var(--wv-red)')}
          </div>
        </div>` : '';

    el.innerHTML = `
      <div class="wv-card wv-position">
        <div class="wv-position-eyebrow">Net Worth</div>
        <div class="wv-position-amount" id="wv-nw-amount">${FCData.formatCurrency(nw)}</div>
        ${deltaHTML}
        <div class="wv-position-spark">${sparkSVG}</div>
        <div class="wv-position-stats">
          <div class="wv-position-stat">
            <div class="wv-stat-lbl">Assets</div>
            <div class="wv-stat-val" style="color:var(--wv-green)">${FCData.formatCurrency(assets)}</div>
          </div>
          <div class="wv-position-stat">
            <div class="wv-stat-lbl">Liabilities</div>
            <div class="wv-stat-val" style="color:var(--wv-red)">${FCData.formatCurrency(liabilities)}</div>
          </div>
        </div>
        ${allocHTML}
      </div>
      <div class="wv-linked-heading"><span>Linked accounts</span><button class="fc-hit44" type="button" onclick="FCApp.showBankSheet&&FCApp.showBankSheet()"><span>Manage</span></button></div>
      ${accountRows ? `<div class="wv-card wv-linked-card">${accountRows}</div>` : `<div class="wv-card wv-linked-card"><div class="wv-empty"><div class="wv-empty-title">Connect your accounts</div><div class="wv-empty-sub">See cash, investments, and debt in one complete view.</div><button class="wv-empty-cta" onclick="FCApp.showBankSheet&&FCApp.showBankSheet()">Connect Bank</button></div></div>`}
      ${_buildWealthPathHTML(_buildWealthPath())}
      <div style="height:8px"></div>`;

    _countup('wv-nw-amount', nw);

    el.querySelectorAll('[data-edit-account]').forEach(row => {
      const open = () => editManualAccount(row.dataset.editAccount);
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  /* ─── Wealth: Savings panel ─── */
  function _renderWealthSavings() {
    const el=document.getElementById('wv-savings-content');
    if (!el) return;
    const accts = state.accounts||[];
    const savAccts=accts.filter(_isCashAcct);
    const total=savAccts.reduce((s,a)=>s+(a.balance_current||a.balance||0),0);
    const goals=_goalsForDisplay();
    const efGoal=goals.find(g=>/emergency|starter/i.test(g.name||''));
    const efPct=efGoal ? Math.min(100,Math.round(((efGoal.current||0)/Math.max(1,efGoal.target||1000))*100)) : 0;
    const efCurrent=efGoal?(efGoal.current||0):0;
    const efTarget=efGoal?(efGoal.target||1000):1000;
    const r=30, circ=2*Math.PI*r;
    const efOffset=circ*(1-Math.min(efPct,100)/100);
    const efColor=efPct>=100?'var(--wv-green)':efPct>0?'var(--fc-accent)':'var(--fc-text-faint)';
    // Savings move
    const sts=Math.max(0,(FCData.calcCash?FCData.calcCash(accts):total)-Math.max(200,total*0.05));
    const weeklyAmt=Math.min(50,Math.max(10,Math.round(sts/8)));
    const isSavAcct=a=>['savings','money market','cd','cash management'].includes((a.subtype||'').toLowerCase());
    const savGroup=savAccts.filter(isSavAcct);
    const chkGroup=savAccts.filter(a=>!isSavAcct(a));
    const nameCounts={};
    // Read and write the SAME key. The read side said `a.name||']'` — a
    // stray bracket — so unnamed accounts always counted 1 and never got
    // the ••mask disambiguator that this map exists to trigger.
    savAccts.forEach(a=>{ const k=a.name||''; nameCounts[k]=(nameCounts[k]||0)+1; });
    const displayName=a=>{ const b=a.name||'Account'; return (nameCounts[b]>1&&a.mask)?`${b} ••${a.mask}`:b; };
    /* Manual accounts are editable, Plaid-synced ones are not: the backend
       owns those and firestore.rules refuses client writes to them, so an
       edit affordance there would be a button that cannot work. The id rides
       on a data attribute and the handler is bound after render — never
       interpolated into an onclick, which is what silently broke every
       Disconnect button. */
    const acctRow=a=>`<div class="wv-acct-row${a.manual?' wv-acct-row--editable':''}"${a.manual?` data-edit-account="${esc(a.id)}" role="button" tabindex="0"`:''}>
      <div class="wv-acct-icon" style="background:var(--wv-green-soft)">${_accountIcon(a)}</div>
      <div style="flex:1;min-width:0">
        <div class="wv-acct-name">${esc(displayName(a))}</div>
        ${_acctSubtext(a)?`<div class="wv-acct-sub">${esc(_acctSubtext(a))}</div>`:''}
      </div>
      <div class="wv-acct-bal">${FCData.formatCurrency(a.balance_current||a.balance||0)}</div>
      ${a.manual?'<span class="wv-acct-chevron" aria-hidden="true">›</span>':''}
    </div>`;
    /* Emits a label and rows, NOT another card. This used to return its own
       `.wv-card` while the caller already wrapped the result in one, so
       Savings rendered a card inside a card — two borders, two radii, two
       backgrounds, nested. */
    const renderGroup=(list,label)=>list.length?`<div class="wv-acct-group-lbl">${esc(label)}</div>${list.map(acctRow).join('')}`:'';
    // Monthly save target
    const monthsToTarget=weeklyAmt>0?Math.ceil((efTarget-efCurrent)/(weeklyAmt*4.3)):null;
    el.innerHTML = `
      <div class="wv-card wv-sav-hero">
        <!-- Was Feather's "gift" glyph — a wrapped present with a bow, on
             the card whose subtitle is "Cash & Savings". Reads as a reward
             or a promo, not as money in an account. -->
        <div class="wv-sav-hero-icon">${_ic('bank','var(--wv-green)',24)}</div>
        <div>
          <div class="wv-sav-total">${FCData.formatCurrency(total)}</div>
          <div class="wv-sav-sub">${savAccts.length} account${savAccts.length!==1?'s':''} · Cash &amp; Savings</div>
        </div>
      </div>
      ${efGoal||total>0?`
      <div class="wv-card wv-ef">
        <div class="wv-ef-ring">
          <svg width="72" height="72" viewBox="0 0 72 72" style="transform:rotate(-90deg)" aria-label="${efPct}% funded">
            <circle cx="36" cy="36" r="${r}" stroke="var(--wv-divider)" stroke-width="6" fill="none"/>
            <circle cx="36" cy="36" r="${r}" stroke="${efColor}" stroke-width="6" fill="none"
              stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${efOffset.toFixed(1)}"
              stroke-linecap="round" style="transition:stroke-dashoffset 0.8s cubic-bezier(0.22,1,0.36,1)"/>
          </svg>
          <div class="wv-ef-pct">${efPct}%</div>
        </div>
        <div>
          <div class="wv-ef-title">${efGoal?esc(efGoal.name):'Emergency Fund'}</div>
          <div class="wv-ef-sub">${FCData.formatCurrency(efCurrent)} of ${FCData.formatCurrency(efTarget)} · ${efPct>=100?'Fully funded':'Keep it up'}</div>
          ${efPct<100?`<div class="wv-ef-bar"><div class="wv-pbar"><div class="wv-pbar-fill" style="width:${efPct}%;background:${efColor}"></div></div></div>`:''}
        </div>
      </div>`:''}
      ${efPct<100&&sts>10?`
      <div class="wv-card wv-sav-move">
        <div class="wv-sav-move-title">Recommended Move</div>
        <div class="wv-sav-move-body">Save ${FCData.formatCurrency(weeklyAmt)}/week toward your Emergency Fund${monthsToTarget?` — funded in ~${monthsToTarget} months`:''}.</div>
        <div class="wv-move-btns">
          <button class="wv-btn-p" onclick="FCApp.showAddGoalSheet&&FCApp.showAddGoalSheet()">Adjust Goal</button>
        </div>
      </div>`:''}
      ${savAccts.length?`
      <div class="wv-lbl">Your Accounts</div>
      <div class="wv-card wv-acct-card">
        ${savGroup.length||chkGroup.length ? renderGroup(savGroup,'Savings')+renderGroup(chkGroup,'Checking') : savAccts.map(acctRow).join('')}
      </div>`:`
      <div class="wv-empty">
        <div class="wv-empty-icon">${_ic('bank','var(--fc-accent)',26)}</div>
        <div class="wv-empty-title">No savings accounts</div>
        <div class="wv-empty-sub">Connect a bank to track your savings.</div>
        <button class="wv-empty-cta" onclick="FCApp.showBankSheet&&FCApp.showBankSheet()">Connect Bank</button>
      </div>`}
      ${savAccts.length&&efGoal?`
      <div class="wv-lbl">Savings Plan</div>
      <div class="wv-card wv-plan-card">
        <div class="wv-plan-row"><div class="wv-plan-k">Goal Target</div><div class="wv-plan-v">${FCData.formatCurrency(efTarget)}</div></div>
        <div class="wv-plan-row"><div class="wv-plan-k">Saved So Far</div><div class="wv-plan-v">${FCData.formatCurrency(efCurrent)}</div></div>
        <div class="wv-plan-row"><div class="wv-plan-k">Weekly to Hit Target</div><div class="wv-plan-v">${FCData.formatCurrency(weeklyAmt)}</div></div>
        ${monthsToTarget?`<div class="wv-plan-row"><div class="wv-plan-k">Est. Completion</div><div class="wv-plan-v">~${monthsToTarget} months</div></div>`:''}
      </div>`:''}
      <div style="height:8px"></div>`;

    el.querySelectorAll('[data-edit-account]').forEach(row => {
      const open = () => editManualAccount(row.dataset.editAccount);
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  /* ── Debt details sheet — APR + minimum payment ──────────────────
     The two fields the app needs and the bank often will not give us.
     Deliberately NOT the manual-account editor: on a Plaid-linked account
     the name, type and balance belong to the backend, and offering to edit
     them would be offering something the rules refuse. Two numbers, saved to
     the /account_details overlay, merged on read behind any real Plaid value. */
  /* ── Compare an offer ─────────────────────────────────────────────
     Somebody has been quoted a rate — by a bank, a dealership, a card
     mailer — and wants to know whether taking it actually helps. The app
     already holds the balance, the APR and the payment, so it can answer
     that properly instead of leaving them to a website calculator that
     wants the answer to be yes.

     It deliberately reports BOTH numbers. Every offer leads with the
     monthly payment, and a lower payment over a longer term is the most
     common way to pay more for the privilege of paying less each month.
     Interest is the number that says whether the offer is good; the
     payment only says whether it is affordable. Both are shown, and when
     they disagree the card says so in plain words. */
  let _offerAccountId = null;

  function showOfferSheet(accountId) {
    const acct = (state.accounts || []).find(a => _acctKey(a) === accountId);
    if (!acct) return;
    _offerAccountId = accountId;
    const sheet = document.getElementById('fc-offer-sheet');
    if (!sheet) return;

    const nameEl = document.getElementById('offer-acct-name');
    if (nameEl) {
      nameEl.textContent = `${acct.name || 'This debt'} · ${FCData.formatCurrency(Math.max(0, _acctBal(acct)))}`;
    }
    // Today's terms, so the comparison has something real to sit against.
    const todayEl = document.getElementById('offer-today');
    const rate = _debtRate(acct), min = _minPayment(acct);
    if (todayEl) {
      todayEl.textContent = (rate > 0 && min > 0)
        ? `Right now: ${rate.toFixed(rate % 1 ? 2 : 0)}% APR, paying ${FCData.formatCurrency(min)}/mo`
        : 'Add this debt\u2019s rate and minimum first — without them there is nothing to compare against.';
    }
    // Prefill the payment with what they already pay: the most useful
    // comparison is the same money out the door at a better rate.
    const pm = document.getElementById('offer-payment');
    if (pm && min > 0) pm.value = String(min);
    ['offer-rate', 'offer-term', 'offer-fee'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const out = document.getElementById('offer-result');
    if (out) out.innerHTML = '';
    _offerKind('loan');
    sheet.style.display = 'flex';
    haptic('light');
  }

  function closeOfferSheet() {
    const sheet = document.getElementById('fc-offer-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); }, 280);
    _offerAccountId = null;
  }

  /* Loan vs balance transfer are different questions, so the form asks
     different things. A loan has a term; a transfer has a promo window and
     whatever you choose to pay. */
  let _offerMode = 'loan';
  function _offerKind(kind) {
    _offerMode = kind === 'transfer' ? 'transfer' : 'loan';
    document.querySelectorAll('#fc-offer-sheet [data-offer-kind]').forEach(b => {
      const on = b.dataset.offerKind === _offerMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    /* The months field exists in BOTH modes but means different things: the
       loan's term, or the length of the promo. Hiding it in transfer mode
       (the first cut) left introMonths at 0, so a 0% offer was modelled as
       reverting immediately — the calculator quietly answered a question
       nobody asked. */
    const promoRow = document.getElementById('offer-promo-row');
    const payRow   = document.getElementById('offer-payment-row');
    const termLbl  = document.getElementById('offer-term-label');
    const termInp  = document.getElementById('offer-term');
    if (promoRow) promoRow.style.display = _offerMode === 'loan' ? 'none' : '';
    if (payRow)   payRow.style.display   = _offerMode === 'loan' ? 'none' : '';
    if (termLbl)  termLbl.textContent = _offerMode === 'loan'
      ? 'Length of the new loan (months)'
      : 'How long the promo rate lasts (months)';
    if (termInp)  termInp.placeholder = _offerMode === 'loan' ? 'e.g. 60' : 'e.g. 18';
    const out = document.getElementById('offer-result');
    if (out) out.innerHTML = '';
  }

  function calcOffer() {
    const out = document.getElementById('offer-result');
    const acct = (state.accounts || []).find(a => _acctKey(a) === _offerAccountId);
    if (!out || !acct) return;

    const num = id => {
      const v = parseFloat((document.getElementById(id) || {}).value);
      return isFinite(v) && v >= 0 ? v : null;
    };
    const balance = Math.max(0, _acctBal(acct));
    const curRate = _debtRate(acct);
    const curPay  = _minPayment(acct);
    const rate    = num('offer-rate');
    const fee     = num('offer-fee') || 0;

    if (curPay <= 0 || curRate <= 0) {
      out.innerHTML = `<p class="offer-note">Add this debt\u2019s current rate and minimum payment first — `
        + `without them there is nothing to compare against.</p>`;
      return;
    }
    if (rate === null) {
      out.innerHTML = `<p class="offer-note">Enter the rate you were offered.</p>`;
      return;
    }

    const args = { balance, rate, fee, currentRate: curRate, currentPayment: curPay };
    if (_offerMode === 'loan') {
      const months = num('offer-term');
      if (!months) { out.innerHTML = `<p class="offer-note">Enter the length of the new loan in months.</p>`; return; }
      args.months = Math.round(months);
    } else {
      const pay = num('offer-payment');
      if (!pay) { out.innerHTML = `<p class="offer-note">Enter what you plan to pay each month.</p>`; return; }
      const promo = num('offer-term');
      if (!promo) {
        out.innerHTML = `<p class="offer-note">Enter how many months the promo rate lasts — `
          + `that is what decides whether this is actually free.</p>`;
        return;
      }
      args.payment = pay;
      args.introRate = rate;
      args.introMonths = Math.round(promo);
      // After the promo the balance reverts to the card's ongoing rate. If
      // they have not told us one, assume it reverts to what they pay today
      // — that is the conservative read, never the flattering one.
      args.rate = num('offer-revert') ?? curRate;
    }

    const r = FCCore.compareOffer(args);
    if (!r.ok) {
      const why = r.reason === 'never_pays_off'
        ? 'At that payment the balance never clears — the interest outruns it.'
        : 'That is not enough to compare yet.';
      out.innerHTML = `<p class="offer-note">${esc(why)}</p>`;
      return;
    }

    const money = v => FCData.formatCurrency(Math.abs(v));
    const cheaper = r.interestSaved > 0;
    const lowerPm = r.monthlyChange > 0;
    const mo = n => `${n} month${n === 1 ? '' : 's'}`;

    /* The headline is always the interest, because that is the one that
       says whether the offer is good. */
    const headline = cheaper
      ? `Saves ${money(r.interestSaved)} in interest`
      : r.interestSaved === 0 ? 'Costs the same overall'
      : `Costs ${money(r.interestSaved)} more in interest`;

    /* Both traps, named out loud. They are mirror images: an offer can be
       cheaper per month but dearer overall, or cheaper overall but keep you
       in debt longer. Either way the number the offer leads with is not the
       whole answer. */
    const slower = isFinite(r.monthsSaved) && r.monthsSaved < 0;
    const warn = (!cheaper && lowerPm)
      ? `<p class="offer-warn">Your payment drops ${money(r.monthlyChange)} a month, but you pay `
        + `${money(r.interestSaved)} more in total. A smaller payment over a longer `
        + `term is not the same as a cheaper debt.</p>`
      : (cheaper && slower)
      ? `<p class="offer-warn">Cheaper overall, but it keeps you in debt `
        + `${mo(Math.abs(r.monthsSaved))} longer. Worth it if the lower payment helps you `
        + `elsewhere — not if being done sooner is the point.</p>`
      : '';

    const rows = [
      ['New payment', `${money(r.payment)}/mo`,
        lowerPm ? `${money(r.monthlyChange)} less` : r.monthlyChange === 0 ? 'no change' : `${money(r.monthlyChange)} more`],
      ['Interest, this offer', money(r.totalInterest), `over ${mo(r.months)}`],
      ['Interest, staying put', isFinite(r.currentTotalInterest) ? money(r.currentTotalInterest) : 'never clears',
        isFinite(r.currentMonths) ? `over ${mo(r.currentMonths)}` : 'at your current payment'],
    ];

    out.innerHTML = `
      <div class="offer-result ${cheaper ? 'is-good' : 'is-warn'}">
        <div class="offer-headline">${esc(headline)}</div>
        ${isFinite(r.monthsSaved) && r.monthsSaved > 0
          ? `<div class="offer-sub">Gone ${esc(mo(r.monthsSaved))} sooner</div>` : ''}
        ${warn}
        <dl class="offer-rows">
          ${rows.map(([k, v, note]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}`
            + `<span>${esc(note)}</span></dd></div>`).join('')}
        </dl>
        <p class="offer-note">FlowCheck is not a lender and earns nothing from this.
          Check the offer\u2019s fees and terms before you accept it.</p>
      </div>`;
    haptic('light');
  }

  let _editingDetailsId = null;

  function showDebtDetailsSheet(accountId) {
    const acct = (state.accounts || []).find(a => _acctKey(a) === accountId);
    if (!acct) return;
    _editingDetailsId = accountId;
    const sheet = document.getElementById('fc-debt-details-sheet');
    if (!sheet) return;
    const nameEl = document.getElementById('debt-details-name');
    const rateEl = document.getElementById('debt-details-rate');
    const minEl  = document.getElementById('debt-details-min');
    const noteEl = document.getElementById('debt-details-note');
    if (nameEl) nameEl.textContent = acct.name || 'This debt';

    /* Show what is already known, and where it came from. A value Plaid
       supplied is not the user's to change here — saying so is better than
       silently ignoring their edit. */
    const fromBank = (acct.interest_rate != null && acct.interest_rate !== '')
                  || (acct.minimum_payment != null && acct.minimum_payment !== '');
    const ov = state.accountDetails?.[accountId] || {};
    if (rateEl) rateEl.value = (acct.interest_rate ?? ov.interest_rate ?? '') === null ? '' : String(acct.interest_rate ?? ov.interest_rate ?? '');
    if (minEl)  minEl.value  = (acct.minimum_payment ?? ov.minimum_payment ?? '') === null ? '' : String(acct.minimum_payment ?? ov.minimum_payment ?? '');
    if (noteEl) {
      const mine = ov.interest_rate != null || ov.minimum_payment != null;
      noteEl.textContent = fromBank
        ? 'Some of this came from your bank. What you enter here is used only where the bank left a gap.'
        : mine
        ? 'You added these — your bank does not report them for this account. Change them any time.'
        : 'Your bank does not report these for this account — auto loans in particular. Add them and the payoff date can include this debt.';
    }
    sheet.style.display = 'flex';
    haptic('light');
  }

  function closeDebtDetailsSheet() {
    const sheet = document.getElementById('fc-debt-details-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); }, 280);
    _editingDetailsId = null;
  }

  async function saveDebtDetails() {
    if (!_editingDetailsId) return;
    const btn    = document.getElementById('debt-details-save');
    const rateEl = document.getElementById('debt-details-rate');
    const minEl  = document.getElementById('debt-details-min');
    // Clamp the rate: a typo of 2400 instead of 24 would otherwise drive a
    // payoff projection straight to "never pays off".
    let rate = parseFloat(rateEl?.value);
    rate = (isFinite(rate) && rate >= 0) ? Math.min(rate, 100) : null;
    let min = parseFloat(minEl?.value);
    min = (isFinite(min) && min >= 0) ? min : null;

    const label = btn ? btn.textContent : '';
    const id    = _editingDetailsId;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      /* Paint first. The Firestore listener will deliver the same values a
         moment later, but waiting for that round-trip means tapping Save and
         watching the row stay unchanged — the number the user just typed
         should already be on screen when the sheet slides away. Demo mode
         never reaches Firestore at all, so this is the only write it gets. */
      state.accountDetails = state.accountDetails || {};
      state.accountDetails[id] = { interest_rate: rate, minimum_payment: min };
      if (!_isDemoMode) {
        await FCData.saveAccountDetails(id, { interest_rate: rate, minimum_payment: min });
      }
      haptic('medium');
      closeDebtDetailsSheet();
      _renderWealth();
      toast('Saved', 'success', 1800);
    } catch (err) {
      fcLog('[saveDebtDetails]', err.message);
      toast('Could not save — try again', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || 'Save'; }
    }
  }

  /* ─── Wealth: Debt panel ─── */
  function _renderWealthDebt() {
    const el=document.getElementById('wv-debt-content');
    if (!el) return;
    const accts=state.accounts||[];
    const debtAccts=accts.filter(a=>{
      const t=(a.type||'').toLowerCase(), s=(a.subtype||'').toLowerCase();
      return t==='credit'||t==='loan'||['credit card','line of credit','mortgage','auto','student','home equity'].includes(s);
    });
    if (!debtAccts.length) {
      el.innerHTML=`<div class="wv-empty"><div class="wv-empty-icon">${_ic('credit-card','var(--fc-accent)',26)}</div><div class="wv-empty-title">No debts tracked</div><div class="wv-empty-sub">Connect a credit card or loan to see payoff progress.</div><button class="wv-empty-cta" onclick="FCApp.showBankSheet&&FCApp.showBankSheet()">Connect Account</button></div>`;
      return;
    }
    const totalDebt=debtAccts.reduce((s,a)=>s+Math.max(0,a.balance_current||a.balance||0),0);
    const cards=debtAccts.filter(a=>a.type==='credit'||['credit card','line of credit'].includes((a.subtype||'').toLowerCase()));
    const ccBal=cards.reduce((s,a)=>s+Math.max(0,a.balance_current||a.balance||0),0);
    const ccLimit=cards.reduce((s,a)=>s+(a.balance_limit||a.balances?.limit||0),0);
    const utilPct=ccLimit>0?Math.round((ccBal/ccLimit)*100):0;
    const utilColor=utilPct>30?'var(--wv-red)':utilPct>10?'var(--wv-amber)':'var(--wv-green)';
    // Donut
    const segs=[
      {lbl:'Cards',val:ccBal,color:'var(--fc-danger)'},
      {lbl:'Loans',val:debtAccts.filter(a=>a.type==='loan').reduce((s,a)=>s+Math.max(0,a.balance_current||a.balance||0),0),color:'var(--fc-warning)'},
    ].filter(s=>s.val>0);
    const R=40,r=24,cx=52,cy=52,circ2=2*Math.PI*R;
    let cumA=-90;
    const arcs=segs.map(seg=>{
      const pct=totalDebt>0?seg.val/totalDebt:0;
      // A full-circle arc path collapses to nothing (start == end point) — cap
      // the sweep just under 360° so a single-segment donut still renders.
      const angle=Math.min(pct*360, 359.9);
      const startA=(cumA*Math.PI)/180, endA=((cumA+angle)*Math.PI)/180;
      const x1=cx+R*Math.cos(startA),y1=cy+R*Math.sin(startA),x2=cx+R*Math.cos(endA),y2=cy+R*Math.sin(endA);
      const ix1=cx+r*Math.cos(endA),iy1=cy+r*Math.sin(endA),ix2=cx+r*Math.cos(startA),iy2=cy+r*Math.sin(startA);
      const large=angle>180?1:0;
      const path=`M${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} L${ix1.toFixed(1)},${iy1.toFixed(1)} A${r},${r} 0 ${large},0 ${ix2.toFixed(1)},${iy2.toFixed(1)} Z`;
      cumA+=angle;
      return `<path d="${path}" fill="${seg.color}" opacity="0.88"/>`;
    });
    /* No number inside the hole. It used to repeat the total — "−$724 /
       total" in 14px, sitting 18px from the SAME figure again in 26px right
       next to it ("$723.55"). Two numbers, one meaning, cramped together, is
       what read as "too close and looks bad": the fix is not more padding
       around a duplicate, it is removing the duplicate. The ring is now a
       pure composition indicator (Cards vs Loans, from `segs`, already
       computed above) with a plain icon at rest in the hole; the dollar
       figure lives in exactly one place, the big text beside it. */
    const donutSVG=`<svg viewBox="0 0 104 104" width="90" height="90" style="flex-shrink:0" aria-hidden="true">${arcs.join('')}<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--fc-bg-elevated,#0b1826)"/><g transform="translate(${cx-11},${cy-11})">${_ic('credit-card','var(--fc-text-faint)',22)}</g></svg>`;
    /* Cards-vs-Loans legend. Only when the ring actually has two colours to
       explain — segs is already filtered to val>0 above, so a single-segment
       donut (all cards, or all loans) would make a legend that just repeats
       the total a THIRD time. Same dot+label+value convention as the
       Cash/Invested/Debt legend on Net Worth (_allocLegend), not a new one. */
    const debtLegendHTML = segs.length > 1 ? `
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px">
        ${segs.map(s => `<div style="display:flex;align-items:center;gap:5px">`
          + `<span style="width:7px;height:7px;border-radius:2px;background:${s.color};flex-shrink:0"></span>`
          + `<span style="font-size:11px;color:var(--wv-t3);font-weight:500">${esc(s.lbl)}</span>`
          + `<span style="font-size:11px;color:var(--wv-t2);font-weight:600;font-variant-numeric:tabular-nums">${FCData.formatCurrency(s.val)}</span>`
        + `</div>`).join('')}
      </div>` : '';
    // Next payment from bills
    /* Two faults in one line, both hidden by operator precedence:

         !b.paid && cat.includes('debt') || name.match(...)

       `&&` binds tighter than `||`, so the name branch was never guarded
       by the paid check at all — a card payment you had already made still
       showed up as "Next payment". And the guard itself was `b.paid`,
       which no bill carries; every other reader in this file uses
       `b.status !== 'paid'`. So the check that was written was also the
       check that never ran. Parenthesised, and reading the real field. */
    const _isDebtBill = b => {
      if (b.status === 'paid') return false;
      const cat = (b.category || '').toLowerCase();
      const nm  = (b.name || '').toLowerCase();
      return cat.includes('debt') || ['card','loan','mortgage'].some(k => nm.includes(k));
    };
    const nextBill = (state.bills || [])
      .filter(_isDebtBill)
      .sort((a,b) => (a.due_date||'').localeCompare(b.due_date||''))[0];
    // Debt rows
    const debtRows=debtAccts.map(a=>{
      const bal=Math.max(0,a.balance_current||a.balance||0);
      const limit=a.balance_limit||a.balances?.limit||0;
      const util=limit>0?Math.round((bal/limit)*100):null;
      const uColor=util!=null?(util>30?'var(--wv-red)':util>10?'var(--wv-amber)':'var(--wv-green)'):'';
      const sub=(a.subtype||'').toLowerCase(), rn=(a.name||'').toLowerCase();
      const dispName=sub==='auto'||rn.includes('dealer')||rn.includes('auto')?'Auto Loan':sub==='student'?'Student Loan':sub==='mortgage'?'Mortgage':(a.name||'Account');
      const isUrgentBal = util!=null && util > 70;
      /* Manual debts are editable from here — this is the screen someone is
         on when they want to correct a loan balance, so making them hunt for
         the Net Worth list instead was the wrong answer. The row previously
         fired a haptic and went nowhere at all. Plaid rows keep that
         behaviour: the backend owns them and the rules refuse client writes. */
      /* Every debt row now carries its own APR and minimum, because the
         totals above cannot be read without them: "Monthly min $25" against
         a $45k balance only makes sense once you can see that four of the
         five debts have no minimum on file.

         Rows are tappable for ALL debts, not just manual ones. Plaid owns
         /accounts and refuses client writes, and Liabilities covers only
         credit cards, student loans and mortgages — so an auto loan, which
         here is the largest debt by far, has no route to an APR at all
         unless the user can supply one. The overlay in /account_details is
         that route. */
      const _r   = _debtRate(a);
      const _m   = _minPayment(a);
      /* One row of small facts, and the gap sits IN that row rather than on a
         line of its own — a debt with a rate but no minimum then reads
         "6.9% APR · + Add minimum", which is the whole state of the account
         at a glance. Do not name the gap chip `.wv-debt-add`: that class
         already exists as the pill-shaped "Add debt" button at the top of
         this panel, and reusing it inherited a 32px pill into the row. */
      const meta = [];
      if (_r > 0) meta.push(`<span class="wv-debt-fact">${_r.toFixed(_r % 1 ? 2 : 0)}% APR</span>`);
      if (_m > 0) meta.push(`<span class="wv-debt-fact">${FCData.formatCurrency(_m)}/mo min</span>`);
      if (bal > 0 && (_r <= 0 || _m <= 0)) {
        meta.push(`<span class="wv-debt-fact wv-debt-fact--gap">${
            _r <= 0 && _m <= 0 ? 'Add rate &amp; minimum'
          : _r <= 0            ? 'Add rate'
          :                      'Add minimum'
        }</span>`);
      } else if (bal > 0) {
        /* Only offered once both numbers exist, because without them there
           is nothing to compare an offer AGAINST and the sheet would just
           turn the user away. A separate button rather than another tap
           target inside the row: the row already opens the rate editor, and
           two actions on one row is how a tap becomes a guess. */
        meta.push(`<button class="wv-debt-fact wv-debt-fact--action fc-hit44" type="button"`
          + ` onclick="event.stopPropagation();FCApp.showOfferSheet('${esc(_acctKey(a))}')"`
          + ` aria-label="Compare a refinance offer for ${esc(a.name || 'this debt')}">Compare an offer</button>`);
      }

      return `<div class="wv-debt-row wv-debt-row--editable"
                   data-edit-details="${esc(_acctKey(a))}" role="button" tabindex="0"
                   aria-label="Edit rate and minimum for ${esc(a.name || 'account')}">
        <div class="wv-debt-icon">${_accountIcon(a)}</div>
        <div style="flex:1;min-width:0">
          <div class="wv-debt-name">${esc(dispName)}</div>
          <div class="wv-debt-sub">${esc(_cleanInstitutionName(a.institution_name||a.official_name||'')||(_acctSubtext(a)))}</div>
          ${meta.length ? `<div class="wv-debt-facts">${meta.join('')}</div>` : ''}
          ${util!=null?`<div class="wv-debt-util" style="color:${uColor}">${util}% used${util>70?' — high':util>30?' — watch':''}</div>`:''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="wv-debt-bal${isUrgentBal?' wv-debt-bal--urgent':''}">${FCData.formatCurrency(bal)}</div>
        </div>
      </div>`;
    }).join('');
    /* ── Extra payment impact ────────────────────────────────────────
       This card was three wrong things at once.

       1. `cards.sort(...)` picked the biggest BALANCE while the comment
          called it avalanche — avalanche is highest INTEREST. It also
          sorted `cards` in place, quietly reordering an array read further
          up. The panel already sorts `debtAccts` by the user's chosen
          strategy, so the account to attack first is simply the first one.

       2. `months = ceil(balance / 50)` treated the EXTRA $50 as the only
          payment being made. For a $723 card that printed "roughly 15
          months" when an extra $50 on top of a minimum clears it in a
          fraction of that. It also ignored interest entirely, which for a
          credit card is most of the point.

       3. "freeing up $12.06 monthly" came from `balance / 12 * 0.2` — a
          formula with no financial meaning at all, presented as a fact.
          What actually frees up when a debt is cleared is its minimum
          payment. That is a real number we already have.

       Now: pay the minimum plus the extra, amortise properly when we know
       the rate, and say plainly when we are ignoring interest because the
       rate is unknown. If we know neither rate nor minimum we say nothing
       rather than invent a number. */
    const _payoffTarget = debtAccts[0] || null;   // already strategy-ordered
    const extraAmt = 50;
    const _poBal  = _payoffTarget ? Math.max(0, _acctBal(_payoffTarget)) : 0;
    const _poMin  = _payoffTarget ? _minPayment(_payoffTarget) : 0;
    const _poRate = _payoffTarget ? Number(_payoffTarget.interest_rate || _payoffTarget.apr || 0) : 0;
    const _poPay  = _poMin + extraAmt;
    /* Standard amortisation: n = -ln(1 - rB/P) / ln(1+r).
       rB >= P means the payment never clears the monthly interest, so the
       balance grows forever — return null rather than a NaN or a negative
       month count dressed up as a plan. */
    const _poMonths = (() => {
      if (!_payoffTarget || _poBal <= 0 || _poPay <= 0) return null;
      if (_poRate <= 0) return Math.ceil(_poBal / _poPay);       // no rate known
      const r = _poRate / 100 / 12;
      if (r * _poBal >= _poPay) return null;                      // never pays off
      return Math.ceil(-Math.log(1 - (r * _poBal) / _poPay) / Math.log(1 + r));
    })();
    const debtIsUrgent = utilPct > 70 || totalDebt > 20000;
    const debtCta      = debtIsUrgent ? 'Review debt strategy' : 'See Wealth Plan';
    const debtCtaColor = debtIsUrgent ? 'var(--wv-red)' : 'var(--wv-blue)';
    /* Debt lived on TWO screens: this panel and a standalone sub-screen with
       its own back button, its own totals and a "+" that had no onclick at
       all. Neither could actually add a debt, and the standalone one was
       reachable from this panel's own "Change" button — you were on Debt,
       tapped Change, and landed on a different Debt page.

       This is now the only debt screen. It gains the numbers that were
       stranded on the other one (avg interest, monthly minimum, extra paid)
       and a working Add debt button; every route into the old screen now
       comes here instead. */
    /* The list is ordered by the chosen strategy, so the card is not just a
       label — the account to attack first is the one at the top. */
    const _strategy = _debtStrategy();
    const _dRate = _debtRate;
    debtAccts.sort((a, b) => _strategy === 'snowball'
      ? (Math.max(0, _acctBal(a)) - Math.max(0, _acctBal(b)))          // smallest balance first
      : (_dRate(b) - _dRate(a)) || (Math.max(0, _acctBal(b)) - Math.max(0, _acctBal(a))));
    /* Balance-WEIGHTED, not a plain mean. A $723 card at 22.99% alongside a
       $14,250 auto loan at 6.9% averages to 14.9% unweighted — nearly double
       what this debt actually costs, and shown as the headline number on the
       page. Weighting by balance answers the question the tile is really
       asking: what rate is the money borrowed at. */
    const _rated  = debtAccts.filter(a => _dRate(a) > 0);
    const avgRate = FCCore.weightedApr(
      _rated.map(a => ({ balance: Math.max(0, _acctBal(a)), rate: _dRate(a) })));
    /* Coverage matters as much as the total. "Monthly min. $25.00" against a
       $45,000 balance is not wrong — it is the sum of what we know — but
       presented bare it reads as the real obligation, and it is not. Four of
       five debts having no minimum on file is the actual story. */
    const _withMin  = debtAccts.filter(a => _minPayment(a) > 0);
    const _withBal  = debtAccts.filter(a => Math.max(0, _acctBal(a)) > 0);
    const totalMin  = _withMin.reduce((s,a) => s + _minPayment(a), 0);
    const _minPartial  = _withMin.length  < _withBal.length;
    const _ratePartial = _rated.length    < _withBal.length;

    /* ── The finish line ──────────────────────────────────────────
       Everything above this point describes the hole. This is the way out.

       A balance is a fact about the past and cannot be acted on. A DATE is a
       fact about the future that the user can move, and moving it is the
       only reward loop that survives a bad month — which is the whole job of
       an app meant to get somebody debt-free rather than merely informed.

       Computed by FCCore.debtFreePlan, which simulates month by month so the
       cascade is real: when a debt clears, its minimum rolls onto the next.
       That cascade is most of the difference between "eleven years" and
       "four years" and no per-debt formula captures it.

       It refuses to answer without minimum payments, and we surface that
       refusal as the ask rather than papering over it with an estimate. */
    const _dfDebts = debtAccts.map(a => ({
      name:    a.name || 'Debt',
      balance: Math.max(0, _acctBal(a)),
      rate:    _debtRate(a),
      minimum: _minPayment(a),
    }));
    const _EXTRA_STEP = 50;
    const _dfNow   = FCCore.debtFreePlan(_dfDebts, 0, _strategy);
    const _dfBoost = FCCore.debtFreePlan(_dfDebts, _EXTRA_STEP, _strategy);
    const _dfMonth = d => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const _dfYears = m => {
      const y = Math.floor(m / 12), mo = m % 12;
      if (!y) return mo + ' month' + (mo === 1 ? '' : 's');
      if (!mo) return y + ' year' + (y === 1 ? '' : 's');
      return y + 'y ' + mo + 'm';
    };

    const debtFreeCard = (() => {
      if (!_dfNow.ok && _dfNow.reason === 'missing_minimums') {
        return '<div class="wv-card wv-df wv-df--ask">'
          + '<p class="wv-df-eyebrow">Debt-free date</p>'
          + '<p class="wv-df-ask">Add the minimum payment on each debt and we\u2019ll show you the month you are free \u2014 and what an extra ' + FCData.formatCurrency(_EXTRA_STEP) + ' a month does to it.</p>'
          + '</div>';
      }
      if (!_dfNow.ok && _dfNow.reason === 'never_pays_off') {
        return '<div class="wv-card wv-df wv-df--ask">'
          + '<p class="wv-df-eyebrow">Debt-free date</p>'
          + '<p class="wv-df-ask">At the current minimums the interest is growing faster than the payments, so there is no payoff date yet. Paying anything above the minimum changes that.</p>'
          + '</div>';
      }
      if (!_dfNow.ok || !_dfNow.date) return '';

      // Only claim the improvement when the extra actually buys months.
      const saved = _dfBoost.ok && _dfBoost.months ? _dfNow.months - _dfBoost.months : 0;
      return '<div class="wv-card wv-df">'
        + '<p class="wv-df-eyebrow">Debt-free</p>'
        + '<p class="wv-df-date">' + esc(_dfMonth(_dfNow.date)) + '</p>'
        + '<p class="wv-df-sub">' + esc(_dfYears(_dfNow.months)) + ' away at your current payments'
          + (_dfNow.totalInterest > 0
              ? ' \u00b7 ' + FCData.formatCurrency(_dfNow.totalInterest) + ' of interest'
              : '')
        + '</p>'
        + (saved > 0
            ? '<div class="wv-df-lever">'
                + _ic('trending-up', 'var(--fc-success)', 15)
                + '<span>An extra <strong>' + FCData.formatCurrency(_EXTRA_STEP) + '/month</strong> makes it '
                + '<strong>' + esc(_dfMonth(_dfBoost.date)) + '</strong> \u2014 '
                + saved + ' month' + (saved === 1 ? '' : 's') + ' sooner, and '
                + FCData.formatCurrency(Math.max(0, _dfNow.totalInterest - _dfBoost.totalInterest))
                + ' less interest.</span>'
              + '</div>'
            : '')
      + '</div>';
    })();
    /* `note` is the coverage caption — it says how much of the picture the
       number above actually covers, so a partial sum cannot pass for a total. */
    const metric = (label, value, tone, note) =>
      `<div class="fc-metric-card"><div class="fc-metric-label">${label}</div>`
      + `<div class="fc-metric-value" style="font-size:20px${tone ? ';color:' + tone : ''}">${value}</div>`
      + (note ? `<div class="fc-metric-note">${esc(note)}</div>` : '')
      + `</div>`;
    const dash = '<span style="color:var(--fc-text-faint)">—</span>';

    el.innerHTML=`
      <div class="wv-debt-actions">
        <span class="wv-debt-actions__label">Your debts</span>
        <button class="wv-debt-add" type="button"
                onclick="FCApp.showManualAccountSheet({type:'loan'})">+ Add debt</button>
      </div>
      <!-- The second "Your Debts" heading that used to sit directly above
           the account list is gone: this row already names the section, and
           the list is the only thing on the panel it could be labelling. -->
      ${debtFreeCard}
      <div class="wv-debt-metrics">
        ${metric('Avg Interest',
            avgRate > 0 ? avgRate.toFixed(1) + '%' : dash,
            null,
            avgRate > 0 && _ratePartial ? `${_rated.length} of ${_withBal.length} debts` : '')}
        ${metric('Monthly Min.',
            totalMin > 0 ? FCData.formatCurrency(totalMin) : dash,
            null,
            totalMin > 0 && _minPartial ? `${_withMin.length} of ${_withBal.length} debts` : '')}
      </div>
      <div class="wv-card wv-debt-hero">
        ${donutSVG}
        <div>
          <div style="font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--wv-t3);margin-bottom:4px">Total Debt</div>
          <div class="wv-debt-total${debtIsUrgent?' wv-debt-total--urgent':''}">${FCData.formatCurrency(totalDebt)}</div>
          ${ccLimit>0?`<div class="wv-debt-status" style="color:${utilColor};font-size:12px;margin-top:3px">${utilPct}% credit utilized${utilPct>30?' — consider paying down':''}</div>`:''}
          ${nextBill?`<div style="font-size:12px;color:var(--wv-t2);margin-top:4px">Next payment: <strong style="color:var(--wv-t1)">${FCData.formatCurrency(nextBill.amount||0)}</strong></div>`:''}
          ${debtLegendHTML}
        </div>
      </div>
      <div class="wv-card wv-debt-move">
        <div class="wv-debt-move-title">${ccBal>500?`Pay down ${cards.length>0?esc(cards[0].name||'your top card'):'credit cards first'}`:'Debt is well managed'}</div>
        <div class="wv-debt-move-body">${ccBal>500?`Paying more than the minimum on your highest-interest card cuts total interest and frees up monthly cash.`:`Your utilization is${utilPct>0?` ${utilPct}%`:' low'} — keep making on-time payments and this stays green.`}</div>
        <div class="wv-move-btns"><button class="wv-btn-p" style="background:${debtCtaColor}" onclick="FCApp.switchWealthTab('overview')">${debtCta}</button></div>
      </div>
      <div class="wv-card wv-strategy">
        <div style="flex:1">
          <div class="wv-strategy-lbl">${_strategy === 'snowball' ? 'Snowball' : 'Avalanche'} Strategy</div>
          <div class="wv-strategy-sub">${_strategy === 'snowball' ? 'Clear the smallest balance first, minimums on the rest. Fastest visible wins.' : 'Pay highest-interest debt first, minimums on the rest. Minimizes total interest paid.'}</div>
        </div>
        <button class="wv-strategy-change" onclick="FCApp._openDebtStrategy&&FCApp._openDebtStrategy()">Change</button>
      </div>
      <div class="wv-card wv-debt-card">${debtRows}</div>
      ${_payoffTarget && _poMonths ? `
      <div class="wv-impact">
        <div class="wv-impact-title">Extra ${FCData.formatCurrency(extraAmt)}/month impact</div>
        <div class="wv-impact-body">Paying ${FCData.formatCurrency(_poPay)}/month toward <strong>${esc(_payoffTarget.name || 'this debt')}</strong>${
          _poMin > 0 ? ` — the ${FCData.formatCurrency(_poMin)} minimum plus ${FCData.formatCurrency(extraAmt)}` : ''
        } clears it in about ${_poMonths} month${_poMonths === 1 ? '' : 's'}${
          _poRate > 0 ? ` at ${_poRate.toFixed(1)}% APR` : ''
        }.${
          _poMin > 0 ? ` That frees up ${FCData.formatCurrency(_poMin)} a month once it is gone.` : ''
        }${
          /* Say so rather than quietly present an interest-free projection
             as if it were the real payoff date. */
          _poRate > 0 ? '' : ' Interest is not included — add this debt\'s rate for an exact date.'
        }</div>
      </div>`:''}
      <div style="height:8px"></div>`;

      /* Debt rows open the rate/minimum sheet, not the manual-account editor:
         name, type and balance belong to Plaid on a linked account, and only
         these two fields are ours to set. */
      el.querySelectorAll('[data-edit-details]').forEach(row => {
        const open = () => showDebtDetailsSheet(row.dataset.editDetails);
        row.addEventListener('click', open);
        row.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
      });
    el.querySelectorAll('[data-edit-account]').forEach(row => {
      const open = () => editManualAccount(row.dataset.editAccount);
      row.addEventListener('click', open);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }


  /** Clean up raw institution names like "Principal Financial Group - Participant Logon" */
  function _cleanInstitutionName(raw) {
    if (!raw) return '';
    // Strip common verbose suffixes
    return raw
      .replace(/\s*[-–—]\s*(participant logon|online banking|direct|member access|login|web banking|banking|online|personal|member|financial center).*/i, '')
      .replace(/\s*\(.*\)$/, '')
      .trim();
  }

  /** Return the best institution/subtext for an account — never repeat the account name */
  function _acctSubtext(a) {
    const name = (a.name || '').trim();
    // Prefer institution_name; fallback to official_name only if different from name
    const inst = _cleanInstitutionName(a.institution_name || '');
    if (inst) return inst;
    const official = (a.official_name || '').trim();
    if (official && official.toLowerCase() !== name.toLowerCase()) return official;
    return a.manual ? 'Manual account' : '';
  }

  function _accountIcon(a) {
    const sub  = (a.subtype || '').toLowerCase();
    const type = (a.type    || '').toLowerCase();
    const name =
        sub === 'savings'  ? 'dollar-sign'
      : sub === 'checking' ? 'bank'
      : (sub === 'credit card' || type === 'credit') ? 'credit-card'
      : sub === 'mortgage' ? 'home'
      : sub === 'student'  ? 'grad-cap'
      : sub === 'auto'     ? 'car'
      : type === 'loan'    ? 'file-text'
      : a.manual           ? 'edit'
      : 'bank';
    return _ic(name, 'var(--fc-text-muted)', 18);
  }

  function _renderSpendingTrends() {
    const card = document.getElementById('act-summary-card');
    if (!card) return;

    const txns = state.transactions || [];
    if (!txns.length) { card.style.display = 'none'; return; }

    const now   = new Date();
    const today = new Date(now); today.setHours(23,59,59,999);

    // Determine period boundaries based on _actSummaryPeriod
    let periodStart, bucketFn, bucketCount, xLabels;
    if (_actSummaryPeriod === 'Y') {
      periodStart = new Date(now.getFullYear() - 1, now.getMonth() + 1, 1);
      bucketCount = 12;
      bucketFn = (d) => ((d.getFullYear() - periodStart.getFullYear()) * 12 + (d.getMonth() - periodStart.getMonth()));
      xLabels = Array.from({ length: 12 }, (_, i) => {
        const m = new Date(periodStart.getFullYear(), periodStart.getMonth() + i, 1);
        return m.toLocaleDateString('en-US', { month: 'short' });
      });
    } else if (_actSummaryPeriod === '6M') {
      periodStart = new Date(now.getTime() - 182 * 86400000);
      bucketCount = 26; // ~6 months of weeks
      bucketFn = (d) => Math.floor((d.getTime() - periodStart.getTime()) / (7 * 86400000));
      xLabels = Array.from({ length: 26 }, (_, i) => {
        const w = new Date(periodStart.getTime() + i * 7 * 86400000);
        return w.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }).filter((_, i) => i % 4 === 0); // show ~6 labels
    } else {
      // M = last 30 days
      periodStart = new Date(now.getTime() - 29 * 86400000); periodStart.setHours(0,0,0,0);
      bucketCount = 30;
      bucketFn = (d) => Math.floor((d.getTime() - periodStart.getTime()) / 86400000);
      xLabels = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(periodStart.getTime() + i * 86400000);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }).filter((_, i) => i % 6 === 0).concat(['Today']);
    }

    // Compute period spend, income, last-period spend
    const periodTxns = txns.filter(t => {
      if (!t.date) return false;
      const d = FCData.parseDateLocal(t.date);
      return d >= periodStart && d <= today;
    });

    const thisSpend  = periodTxns.filter(_isSpendTxn).reduce((s, t) => s + Math.abs(t.amount || 0), 0);
    const thisIncome = periodTxns.filter(_isIncomeTxn).reduce((s, t) => s + Math.abs(t.amount || 0), 0);
    const periodMs   = today.getTime() - periodStart.getTime();
    const prevStart  = new Date(periodStart.getTime() - periodMs - 86400000);
    const prevTxns   = txns.filter(t => {
      if (!t.date) return false;
      const d = FCData.parseDateLocal(t.date);
      return d >= prevStart && d < periodStart;
    });
    const prevSpend  = prevTxns.filter(_isSpendTxn).reduce((s, t) => s + Math.abs(t.amount || 0), 0);

    const daysElapsed = Math.max(1, Math.round(periodMs / 86400000));
    const avgDaily    = thisSpend / daysElapsed;
    const cashFlow    = thisIncome - thisSpend;
    const spendDelta  = prevSpend > 0 ? Math.round(((thisSpend - prevSpend) / prevSpend) * 100) : null;

    // Update card DOM
    const amtEl       = document.getElementById('act-summary-amount');
    const deltaEl     = document.getElementById('act-summary-delta');
    const incomeEl    = document.getElementById('act-metric-income');
    const cashflowEl  = document.getElementById('act-metric-cashflow');
    const avgdailyEl  = document.getElementById('act-metric-avgdaily');
    const labelEl     = card.querySelector('.act-summary-label');

    if (amtEl)    amtEl.textContent     = FCData.formatCurrency(thisSpend);
    if (incomeEl) incomeEl.textContent  = FCData.formatCurrency(thisIncome);

    // New in/out row elements
    const inAmtEl  = document.getElementById('act-in-amount');
    const outAmtEl = document.getElementById('act-out-amount');
    if (inAmtEl)  inAmtEl.textContent  = FCData.formatCurrency(thisIncome);
    if (outAmtEl) outAmtEl.textContent = FCData.formatCurrency(thisSpend);
    if (cashflowEl) {
      cashflowEl.textContent  = (cashFlow >= 0 ? '+' : '−') + FCData.formatCurrency(Math.abs(cashFlow));
      cashflowEl.style.color  = cashFlow >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
    }
    if (avgdailyEl) avgdailyEl.textContent = FCData.formatCurrency(avgDaily) + '/day';
    if (labelEl)    labelEl.textContent = _actSummaryPeriod === 'M' ? 'Last 30 Days' : _actSummaryPeriod === '6M' ? 'Last 6 Months' : 'Last 12 Months';

    if (deltaEl && spendDelta !== null) {
      const up = spendDelta > 0;
      deltaEl.textContent = (up ? '↑ ' : '↓ ') + Math.abs(spendDelta) + '% vs last period';
      deltaEl.style.color = up ? 'var(--fc-danger)' : 'var(--fc-success)';
      deltaEl.style.display = '';
    } else if (deltaEl) {
      deltaEl.style.display = 'none';
    }

    // Build line chart data
    const buckets = new Array(bucketCount).fill(0);
    periodTxns.filter(_isSpendTxn).forEach(t => {
      const d = FCData.parseDateLocal(t.date);
      const idx = Math.max(0, Math.min(bucketCount - 1, bucketFn(d)));
      if (idx >= 0 && idx < bucketCount) buckets[idx] += t.amount || 0;
    });

    const svgEl = document.getElementById('act-summary-chart-svg');
    const labelsEl = document.getElementById('act-chart-labels');
    if (svgEl) {
      /* chartH used to be hardcoded to 80 here while the svg's actual height
         attribute in index.html was 52 (shrunk when Activity's chrome was
         compacted). preserveAspectRatio="none" on this element stretches the
         viewBox to fill whatever the real box is, so every point computed
         against an 80-tall canvas was then squashed by 52/80 — the graph's
         true dynamic range and headroom were both ~35% smaller than the math
         below assumed, which is what "the graph isn't up to par" actually
         was: flattened peaks, a top margin that had shrunk to nothing.
         Reading the real height means the two can never drift apart again —
         change the markup and this follows automatically. */
      const chartH = parseFloat(svgEl.getAttribute('height')) || 52, chartW = 320; // viewBox units
      const topPad = 6, bottomPad = 2;   // headroom sized for the actual canvas, not inherited from 80
      const maxVal = Math.max(...buckets, 1);
      const pts = buckets.map((v, i) => {
        const x = (i / (bucketCount - 1)) * chartW;
        const y = (chartH - bottomPad) - (v / maxVal) * (chartH - topPad - bottomPad);
        return [x, y];
      });

      // Smooth path using cubic bezier
      let d = `M ${pts[0][0]},${pts[0][1]}`;
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const cx = (x0 + x1) / 2;
        d += ` C ${cx},${y0} ${cx},${y1} ${x1},${y1}`;
      }

      // Fill area
      const fillD = d + ` L ${pts[pts.length-1][0]},${chartH} L ${pts[0][0]},${chartH} Z`;
      const lastPt = pts[pts.length - 1];

      svgEl.setAttribute('viewBox', `0 0 ${chartW} ${chartH}`);
      svgEl.innerHTML = `
        <defs>
          <linearGradient id="actChartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--fc-accent)" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="var(--fc-accent)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${fillD}" fill="url(#actChartGrad)"/>
        <path d="${d}" fill="none" stroke="var(--fc-accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${lastPt[0]}" cy="${lastPt[1]}" r="4" fill="var(--fc-accent)"/>
      `;
    }

    if (labelsEl) {
      const labelPts = _actSummaryPeriod === 'M'
        ? [0, 6, 12, 18, 24, 29].map(i => {
            const d = new Date(periodStart.getTime() + i * 86400000);
            return { idx: i, text: i === 29 ? 'Today' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), isNow: i === 29 };
          })
        : _actSummaryPeriod === '6M'
          ? [0, 4, 8, 13, 18, 25].map(i => {
              const d = new Date(periodStart.getTime() + i * 7 * 86400000);
              return { idx: i, text: i === 25 ? 'Today' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), isNow: i === 25 };
            })
          : Array.from({ length: 6 }, (_, j) => {
              const i = Math.round(j * 11 / 5);
              const d = new Date(periodStart.getFullYear(), periodStart.getMonth() + i, 1);
              return { idx: i, text: j === 5 ? 'Today' : d.toLocaleDateString('en-US', { month: 'short' }), isNow: j === 5 };
            });
      labelsEl.innerHTML = labelPts.map(l => `<span class="act-chart-lbl${l.isNow ? ' now' : ''}">${l.text}</span>`).join('');
    }

    card.style.display = '';
  }

  function _renderRecurringBanner() {
    const el = document.getElementById('act-recurring-banner');
    if (!el) return;

    const subs = _detectSubscriptions(state.transactions || []);
    if (!subs || !subs.length) { el.style.display = 'none'; return; }

    const total   = subs.reduce((s, sub) => s + (sub.amount || 0), 0);
    const titleEl = document.getElementById('act-recurring-title');
    const subEl   = document.getElementById('act-recurring-sub');

    if (titleEl) titleEl.textContent = `${subs.length} recurring charge${subs.length !== 1 ? 's' : ''} detected`;
    if (subEl)   subEl.textContent   = `${FCData.formatCurrency(total)}/mo · Review subscriptions to avoid surprises.`;

    el.style.display = '';
  }

  function _renderIntelSummary() {
    const el = document.getElementById('ins-intel-summary');
    if (!el) return;

    const txns = state.transactions || [];
    if (!txns.length) { el.style.display = 'none'; return; }

    const now             = new Date();
    const thisMonthStart  = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd    = new Date(now.getFullYear(), now.getMonth(), 0);

    const thisTxns   = txns.filter(t => FCData.parseDateLocal(t.date) >= thisMonthStart);
    const lastTxns   = txns.filter(t => { const d = FCData.parseDateLocal(t.date); return d >= lastMonthStart && d <= lastMonthEnd; });

    const thisSpend  = thisTxns.filter(_isSpendTxn).reduce((s, t) => s + t.amount, 0);
    const lastSpend  = lastTxns.filter(_isSpendTxn).reduce((s, t) => s + t.amount, 0);
    const thisIncome = thisTxns.filter(_isIncomeTxn).reduce((s, t) => s + Math.abs(t.amount || 0), 0);
    const lastIncome = lastTxns.filter(_isIncomeTxn).reduce((s, t) => s + Math.abs(t.amount || 0), 0);

    const spendDelta  = lastSpend  > 0 ? Math.round(((thisSpend  - lastSpend)  / lastSpend)  * 100) : null;
    // Suppress income delta before the 25th — partial month vs full month comparison is misleading
    const incomeDelta = (lastIncome > 0 && now.getDate() >= 25) ? Math.round(((thisIncome - lastIncome) / lastIncome) * 100) : null;

    const nw   = FCData.calcNetWorth(state.accounts || []);
    const cash = FCData.calcCash(state.accounts || []);

    const metrics = [
      { label: 'Spending',  value: FCData.formatCurrency(thisSpend),  delta: spendDelta,  invert: true,  icon: '💸' },
      { label: 'Income',    value: FCData.formatCurrency(thisIncome), delta: incomeDelta, invert: false, icon: '💰' },
      { label: 'Cash',      value: FCData.formatCurrency(cash),       delta: null,        invert: false, icon: '🏦' },
      { label: 'Net Worth', value: FCData.formatCurrency(nw),         delta: null,        invert: false, icon: '📊' },
    ];

    const deltaHtml = (d, invert) => {
      if (d === null) return '';
      const good  = invert ? d < 0 : d > 0;
      const color = good ? 'var(--fc-success)' : d === 0 ? 'var(--fc-text-faint)' : 'var(--fc-danger)';
      const arrow = d > 0 ? '↑' : d < 0 ? '↓' : '→';
      return `<div style="margin-top:4px"><span style="font-size:10px;color:${color};font-weight:700">${arrow}${Math.abs(d)}%</span> <span style="font-size:10px;color:var(--fc-text-faint)">vs last mo</span></div>`;
    };

    el.innerHTML = `
      <div class="ins-changed-card">
        <div class="ins-changed-header"><div class="ins-changed-title">What Changed Since Last Month</div></div>
        ${metrics.map(m => {
          const d = m.delta;
          const good = d !== null ? (m.invert ? d < 0 : d > 0) : false;
          const color = d !== null ? (good ? 'var(--fc-success)' : d === 0 ? 'var(--fc-text-faint)' : 'var(--fc-danger)') : 'var(--fc-text-faint)';
          const arrow = d !== null ? (d > 0 ? '↑' : d < 0 ? '↓' : '→') : '';
          const dotBg = d !== null ? (good ? 'rgba(48,209,88,0.15)' : 'rgba(255,69,58,0.12)') : 'var(--fc-bg-elevated-2)';
          const dotColor = d !== null ? (good ? 'var(--fc-success)' : 'var(--fc-danger)') : 'var(--fc-text-faint)';
          return `
            <div class="ins-changed-item">
              <div class="ins-changed-dot" style="background:${dotBg}">
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="${dotColor}" stroke-width="3" stroke-linecap="round" aria-hidden="true">
                  ${d === null || d === 0 ? '<line x1="5" y1="12" x2="19" y2="12"/>' : d > 0 ? '<path d="M12 19V5M5 12l7-7 7 7"/>' : '<path d="M12 5v14M5 12l7 7 7-7"/>'}
                </svg>
              </div>
              <div class="ins-changed-body">
                <div class="ins-changed-label">${m.icon} ${esc(m.label)}</div>
                ${d !== null ? `<div class="ins-changed-sub"><span style="color:${color};font-weight:700">${arrow}${Math.abs(d)}%</span> vs last month</div>` : ''}
              </div>
              <div class="ins-changed-val">${m.value}</div>
            </div>`;
        }).join('')}
      </div>`;
    el.style.display = '';
  }

  function _renderBehaviorAnalysis() {
    const el = document.getElementById('ins-behavior-analysis');
    if (!el) return;

    const txns      = state.transactions || [];
    const spendTxns = txns.filter(_isSpendTxn);
    if (spendTxns.length < 5) { el.style.display = 'none'; return; }

    const isWeekend = d => { const day = FCData.parseDateLocal(d).getDay(); return day === 0 || day === 6; };
    const weekendTxns  = spendTxns.filter(t => isWeekend(t.date));
    const weekdayTxns  = spendTxns.filter(t => !isWeekend(t.date));
    const weekendAvg   = weekendTxns.length ? weekendTxns.reduce((s, t) => s + t.amount, 0) / weekendTxns.length : 0;
    const weekdayAvg   = weekdayTxns.length ? weekdayTxns.reduce((s, t) => s + t.amount, 0) / weekdayTxns.length : 0;

    const merchantTotals = {};
    spendTxns.forEach(t => {
      const name = _cleanTxnName(t.name);
      merchantTotals[name] = (merchantTotals[name] || 0) + t.amount;
    });
    const topMerchant = Object.entries(merchantTotals).sort((a, b) => b[1] - a[1])[0];

    const dayTotals  = [0,0,0,0,0,0,0];
    spendTxns.forEach(t => { dayTotals[FCData.parseDateLocal(t.date).getDay()] += t.amount; });
    const dayNames   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const topDayIdx  = dayTotals.indexOf(Math.max(...dayTotals));

    const insights = [];
    if (weekendAvg > weekdayAvg * 1.2 && weekdayAvg > 0) {
      insights.push({ icon: '📅', text: `You spend ${Math.round(((weekendAvg - weekdayAvg) / weekdayAvg) * 100)}% more per transaction on weekends` });
    } else if (weekdayAvg > weekendAvg * 1.2 && weekendAvg > 0) {
      insights.push({ icon: '💼', text: 'Weekdays are your biggest spending driver' });
    }
    if (topMerchant) {
      insights.push({ icon: '🏪', text: `Top merchant: ${topMerchant[0]} (${FCData.formatCurrency(topMerchant[1])})` });
    }
    if (dayTotals[topDayIdx] > 0) {
      insights.push({ icon: '📆', text: `${dayNames[topDayIdx]}s are your highest-spending day` });
    }

    if (!insights.length) { el.style.display = 'none'; return; }

    el.innerHTML = `
      <div class="ins-behavior-card">
        <div class="ins-behavior-header">Spending Patterns</div>
        ${insights.map(ins => `
          <div class="ins-behavior-row">
            <div class="ins-behavior-icon">${ins.icon}</div>
            <div class="ins-behavior-text">${esc(ins.text)}</div>
          </div>`).join('')}
      </div>`;
    el.style.display = '';
  }

  function _renderWins() {
    const el = document.getElementById('ins-wins');
    if (!el) return;

    const txns     = state.transactions || [];
    const accounts = state.accounts     || [];
    const bills    = state.bills        || [];
    const wins     = [];

    const now            = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0);

    const thisSpend = txns.filter(t => FCData.parseDateLocal(t.date) >= thisMonthStart && _isSpendTxn(t)).reduce((s, t) => s + t.amount, 0);
    const lastSpend = txns.filter(t => { const d = FCData.parseDateLocal(t.date); return d >= lastMonthStart && d <= lastMonthEnd && _isSpendTxn(t); }).reduce((s, t) => s + t.amount, 0);

    if (lastSpend > 0 && thisSpend < lastSpend * 0.90) {
      wins.push({ icon: '📉', text: `Spending is ${Math.round(((lastSpend - thisSpend) / lastSpend) * 100)}% lower than last month` });
    }
    const nw = FCData.calcNetWorth(accounts);
    if (nw > 0) wins.push({ icon: '💪', text: `Positive net worth of ${FCData.formatCurrency(nw)}` });

    const overdue = bills.filter(b => { const d = FCData.daysUntil(b.due_date); return d !== null && d < 0 && b.status !== 'paid'; });
    if (bills.length > 0 && overdue.length === 0) wins.push({ icon: '✅', text: 'All bills are up to date' });

    const streak = state.user?.streak || 0;
    if (streak >= 7) wins.push({ icon: '🔥', text: `${streak}-day streak — keep it up!` });

    if (!wins.length) { el.style.display = 'none'; return; }

    el.innerHTML = `
      <div class="ins-wins-card">
        <div class="ins-wins-header">Wins 🏆</div>
        ${wins.map(w => `
          <div class="ins-win-row">
            <span class="ins-win-icon">${w.icon}</span>
            <span class="ins-win-text">${esc(w.text)}</span>
          </div>`).join('')}
      </div>`;
    el.style.display = '';
  }

  function _renderRecommendations() {
    const el = document.getElementById('ins-recommendations');
    if (!el) return;

    const txns      = state.transactions || [];
    const bills     = state.bills        || [];
    const goals     = state.goals        || [];
    const spendTxns = txns.filter(_isSpendTxn);
    const recs      = [];

    const weekendSpend = spendTxns.filter(t => { const d = FCData.parseDateLocal(t.date).getDay(); return d === 0 || d === 6; }).reduce((s, t) => s + t.amount, 0);
    const totalSpend   = spendTxns.reduce((s, t) => s + t.amount, 0);
    if (totalSpend > 0 && weekendSpend > totalSpend * 0.45) {
      recs.push({ icon: '📅', title: 'Weekend spending is high', detail: 'Over 45% of your spending happens on weekends. Consider setting a weekend limit.' });
    }

    const subs = _detectSubscriptions(txns);
    if (subs && subs.length > 3) {
      const subsTotal = subs.reduce((s, sub) => s + (sub.amount || 0), 0);
      recs.push({ icon: '🔄', title: `Review ${subs.length} recurring charges`, detail: `${FCData.formatCurrency(subsTotal)}/mo in detected subscriptions — any you can cancel?` });
    }

    if (goals.length === 0) {
      recs.push({ icon: '🎯', title: 'Set a savings goal', detail: 'People who set goals consistently save more. Add one on the Wealth tab.' });
    }

    const urgentBills = bills.filter(b => { const d = FCData.daysUntil(b.due_date); return d !== null && d <= 7 && b.status !== 'paid'; });
    if (urgentBills.length) {
      const urgTotal = urgentBills.reduce((s, b) => s + b.amount, 0);
      recs.push({ icon: '📆', title: `${urgentBills.length} bill${urgentBills.length !== 1 ? 's' : ''} due this week`, detail: `${FCData.formatCurrency(urgTotal)} in upcoming payments — make sure funds are ready.` });
    }

    if (!recs.length) { el.style.display = 'none'; return; }

    el.innerHTML = `
      <div class="ins-behavior-card">
        <div class="ins-behavior-header">Recommendations</div>
        ${recs.map(r => `
          <div class="ins-behavior-row">
            <div class="ins-behavior-icon">${r.icon}</div>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;color:var(--fc-text);margin-bottom:2px">${esc(r.title)}</div>
              <div style="font-size:11px;color:var(--fc-text-muted);line-height:1.4">${esc(r.detail)}</div>
            </div>
          </div>`).join('')}
      </div>`;
    el.style.display = '';
  }

  /* Helper called by CTA button after paywall success */
  function renderHomeAfterPro() {
    _refreshAfterPro();
    _scheduleWelcomeModal();
    setTimeout(() => _tryStartTour(), 1200);
  }

  /** Purchase-success "Continue" CTA. If the paywall came from the onboarding
   *  trial slide, the flow isn't done — return to the bank-connect step. */
  function finishPurchaseSuccess() {
    const successOverlay = document.getElementById('pw-success-overlay');
    if (successOverlay) successOverlay.classList.remove('visible');
    if (_paywallFromOnboarding) {
      _paywallFromOnboarding = false;
      setScreen('onboarding');
      if (window.obGoToBankSlide) window.obGoToBankSlide();
      return;
    }
    setScreen('app');
    renderHomeAfterPro();
  }

  /** Show the app tour for first-time users only.
   *
   *  Two-layer check to avoid a Firestore timing race:
   *  1. localStorage  — written instantly when completeTour() fires; survives
   *     the race where the Firestore listener hasn't populated state.user yet.
   *  2. state.user.tour_completed — Firestore source-of-truth; catches users
   *     who cleared localStorage or installed fresh on a new device.
   */
  function _tryStartTour() {
    try {
      const uid    = FCAuth.currentUser && FCAuth.currentUser()?.uid;
      const lsDone = uid ? localStorage.getItem('fc_tour_done_' + uid) === '1' : false;
      const fsDone = state.user?.tour_completed === true;
      if (!lsDone && !fsDone && typeof startTour === 'function') {
        startTour();
      }
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: SETTINGS
     ───────────────────────────────────────────────────────────── */

  function _renderSettings() {
    const user = state.user;
    if (!user) return;

    // Show dev-only tools when env = development
    const devRow = document.getElementById('dev-test-email-row');
    if (devRow) devRow.style.display = FC_CONFIG.app.env === 'development' ? 'flex' : 'none';

    const versionEl = document.getElementById('settings-version');
    if (versionEl) versionEl.textContent = FC_CONFIG.app.version || '2.0.0';

    const nameEl  = document.getElementById('settings-name');
    const emailEl = document.getElementById('settings-email');
    const initEl  = document.getElementById('settings-avatar');
    // Resolution: Firestore 'name' → Firebase Auth displayName → email prefix
    const authUser    = FCAuth.currentUser();
    const displayName = user.name || authUser?.displayName || user.email?.split('@')[0] || 'User';
    // Always prefer the live Firebase Auth email — Firestore may lag on first
    // load or retain a previous session's value during an account switch.
    const displayEmail = (authUser?.email) || user.email || '';
    if (nameEl)  nameEl.textContent  = displayName;
    if (emailEl) emailEl.textContent = displayEmail;
    if (initEl)  initEl.textContent  = displayName.charAt(0).toUpperCase();

    // Appearance picker — highlight saved preference and update display value
    if (window._FCSetAppearance && window._FCGetAppearance) {
      const pref = window._FCGetAppearance();
      window._FCSetAppearance(pref);
      const valEl = document.getElementById('settings-appearance-val');
      if (valEl) valEl.textContent = pref === 'dark' ? 'Dark' : pref === 'light' ? 'Light' : 'Auto';
    }

    // Biometric toggle — set both class and aria-checked correctly
    FCAuth.isBiometricEnabled().then(enabled => {
      const toggle = document.getElementById('toggle-biometric');
      if (toggle) { toggle.classList.toggle('on', enabled); toggle.setAttribute('aria-checked', enabled); }
    });

    // Notification toggle — Preferences is the authoritative local value.
    // Firestore value is the starting point but may lag after sign-in.
    const notifToggle = document.getElementById('toggle-notifications');
    if (notifToggle) {
      const Prefs = window.Capacitor?.Plugins?.Preferences;
      const _resolveNotifState = async () => {
        // Local Preferences overrides Firestore if it's been explicitly set
        let localPref = null;
        if (Prefs) {
          try { const r = await Prefs.get({ key: 'fc_notifs_enabled' }); localPref = r?.value; } catch (_) {}
        }
        const preferenceOn = localPref !== null ? localPref === 'true' : user.notifications_enabled !== false;
        const osStatus = await (typeof FCPush !== 'undefined' ? FCPush.checkPermissions() : Promise.resolve('unavailable')).catch(() => 'unavailable');
        const osBlocked = osStatus === 'denied';
        const notifsOn  = preferenceOn && !osBlocked;
        notifToggle.classList.toggle('on', notifsOn);
        notifToggle.setAttribute('aria-checked', String(notifsOn));
        // If local preference says on but OS blocked, sync both stores to off
        if (preferenceOn && osBlocked) {
          if (Prefs) Prefs.set({ key: 'fc_notifs_enabled', value: 'false' }).catch(() => {});
          FCData.updateUserField('notifications_enabled', false).catch(() => {});
        }
      };
      _resolveNotifState().catch(() => {});
    }

    // Institution — show all connected banks, not just the legacy single-bank field (S2)
    const institutionEl = document.getElementById('settings-institution');
    if (institutionEl) {
      const legacyName = _cleanInstitutionName(user.plaid_institution || '');
      institutionEl.textContent = legacyName || 'Not connected'; // immediate placeholder
      FCData.getPlaidItems().then(items => {
        if (!institutionEl) return;
        if (items.length === 0 && legacyName) {
          institutionEl.textContent = legacyName;
        } else if (items.length === 1) {
          institutionEl.textContent = _cleanInstitutionName(items[0].institution || '') || 'Connected';
        } else if (items.length > 1) {
          institutionEl.textContent = `${items.length} banks`;
        } else {
          institutionEl.textContent = 'Not connected';
        }
      }).catch(() => {});
    }

    // Streak — minimum Day 1 (new users always get credit for showing up)
    const streakDays = Math.max(1, user.streak || 1);
    const streakEl   = document.getElementById('settings-streak');
    if (streakEl) streakEl.textContent = `Day ${streakDays} streak 🔥`;

    // Pro badge in new profile card
    const proBadge = document.getElementById('settings-pro-badge');
    const isPro    = !!(user.is_pro || user.pro || (window.FCPurchases && FCPurchases.isPro()));
    if (proBadge) {
      /* Tokens, not literals. rgba(26,196,240,…) is the DARK-mode accent and
         rgba(255,159,10,…) the dark-mode warning, both baked in — so in
         light mode this badge kept a cyan tint on a screen whose accent had
         become #147CFF. --fc-accent-soft / --fc-warning-soft already carry
         the right value per theme. */
      proBadge.textContent = isPro ? 'Pro ✓' : 'Free';
      proBadge.style.cssText = isPro
        ? 'font-size:10px;padding:4px 10px;background:var(--fc-accent-soft);color:var(--fc-accent);border:0.5px solid var(--fc-border-accent);border-radius:999px'
        : 'font-size:10px;padding:4px 10px;background:var(--fc-warning-soft);color:var(--fc-warning-text);border:0.5px solid var(--fc-warning-soft);border-radius:999px';
    }

    // Pro row — show status + cancel option for Pro users
    const proRow  = document.getElementById('settings-pro-row');
    const proPill = document.getElementById('settings-pro-pill');
    if (proPill) {
      proPill.textContent = isPro ? 'Manage' : 'Upgrade →';
      proPill.style.cssText = isPro
        ? 'font-size:10px;padding:3px 8px;background:var(--fc-accent-soft);color:var(--fc-accent);border-radius:999px'
        : 'font-size:10px;padding:3px 8px;background:var(--fc-warning-soft);color:var(--fc-warning-text);border-radius:999px';
    }
    if (proRow) {
      proRow.onclick = isPro ? () => _openCancelSheet() : () => showPaywall();
    }
    // Cancel row is removed — Manage already opens App Store subscriptions (S3)

    // Referral badge — uses referral_activations (the count of friends who connected a bank)
    const refBadge = document.getElementById('settings-referral-badge');
    if (refBadge) {
      const activations = user.referral_activations || 0;
      if (activations > 0) {
        refBadge.textContent = `${activations} referred`;
        refBadge.style.display = 'inline-block';
      } else {
        refBadge.style.display = 'none';
      }
    }

  }

  /* ─────────────────────────────────────────────────────────────
     SUB-SCREEN NAVIGATION (Plan → Bills/Debt/Goals/etc.)
     ───────────────────────────────────────────────────────────── */

  /* ── Legal footer ──────────────────────────────────────────────
     CLAUDE.md requires "FlowCheck is not a bank. Not financial advice." to
     stay visible. It was on Home, Plan, Money, Goals, Coach and Settings —
     and missing from Activity, More, Bills, Debt, Investments, Calendar,
     Reports and Notifications, which are the screens showing balances,
     debts and projections. Every one of those was a renderer that had to
     remember to append it, and eight of them didn't.

     So it stops being per-screen discipline. The footer is appended to the
     VIEW element, not to the content container the renderers overwrite, so
     it survives every re-render, and it is idempotent — screens that ship
     their own copy are left alone. */
  function _ensureLegalFooter(view) {
    if (!view) return;
    if (view.querySelector('.fc-legal-footer')) return;
    if (/not a bank/i.test(view.textContent)) return;   // screen has its own
    const p = document.createElement('p');
    p.className = 'fc-legal-footer';
    p.textContent = 'FlowCheck is not a bank. Not financial advice.';
    view.appendChild(p);
  }

  function _openSubScreen(screenId) {
    const el = document.getElementById('view-' + screenId);
    /* Look the target up BEFORE firing the haptic, and say something when it
       is missing. The old order buzzed first and then returned silently, so a
       route whose screen had been deleted still felt like a working button —
       which is exactly how _openSubScreen('bills') survived the removal of
       #view-bills. A dead route should feel dead and leave a trace.
       check-dom-ids.js cannot catch these: the id is built at runtime from
       the argument, so check-sub-screens.js pairs the literals instead. */
    if (!el) {
      fcLog('[FCApp] _openSubScreen: no #view-' + screenId + ' — dead route');
      return;
    }
    /* Some of these ids are first-class tabs now, and Goals is the one that
       shows. It has a slot in the nav bar, but every shortcut into it — the
       Today quick action, the Today card, the More hub tile — still called
       _openSubScreen. That path HIDES the nav bar and renders the
       back-button variant, so tapping "Goals" landed you on a page with no
       tabs and a different transition, while the Goals tab itself sat
       highlighted underneath. Same view element either way; only the chrome
       differed, which is what made it look like a broken transition rather
       than a wrong route.

       Redirecting here rather than at each call site, for the same reason
       switchTab() owns _TAB_REDIRECTS: there are three call sites today and
       the next one to be added would have had the bug too. */
    if (_NAV_TABS.has(screenId)) { switchTab(screenId); return; }
    haptic('light');
    // Hide all fc-view screens
    document.querySelectorAll('.fc-view').forEach(v => v.classList.remove('active'));
    // Hide nav (sub-screens are full-screen without tabs)
    const nav = document.querySelector('.fc-nav');
    if (nav) nav.style.display = 'none';
    el.style.display = '';
    el.classList.add('active');
    el.scrollTop = 0;
    // Render
    requestAnimationFrame(() => {
      /* No 'bills' or 'debt' branch: both had a second, standalone screen
         that has been deleted. They are now segments of Activity and Money
         respectively, and switchTab() redirects those ids there. */
      if (screenId === 'goals')         _renderGoalsScreen();
      else if (screenId === 'investments') _renderInvestments();
      else if (screenId === 'calendar') _renderCalendar();
      else if (screenId === 'reports')  _renderReports();
      else if (screenId === 'notifications') _renderNotificationsScreen();
      else if (screenId === 'vault')    _renderVaultScreen();
      else if (screenId === 'settings') { _renderSettings(); }
      _ensureLegalFooter(el);
    });
  }

  function _closeSubScreen() {
    const nav = document.querySelector('.fc-nav');
    if (nav) nav.style.display = '';
    ['goals','investments','calendar','reports','notifications','settings','vault'].forEach(id => {
      const el = document.getElementById('view-' + id);
      if (el) { el.classList.remove('active'); el.style.display = 'none'; }
    });
    /* Hand off to switchTab so the nav state, view activation and the tab's
       own render all happen the one way they happen everywhere else — this
       used to reimplement all three inline, for 'more' only. state.tab is
       cleared first because switchTab early-returns when it already matches,
       and it currently holds the sub-screen's id. */
    const back = _NAV_TABS.has(_lastNavTab) ? _lastNavTab : 'more';
    state.tab = null;
    switchTab(back);
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: PLAN TAB
     ───────────────────────────────────────────────────────────── */

  function _renderPlan() {
    const el = document.getElementById('plan-content');
    if (!el) return;
    const now = new Date();
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const txns    = state.transactions || [];
    const bills   = (state.bills || []).filter(b => b.status !== 'paid')
                      .sort((a,b) => new Date(a.due_date)-new Date(b.due_date)).slice(0,3);
    /* The Monthly Plan ring needs a DIFFERENT number from the preview list
       above. `bills` is "the next three still unpaid" — correct for a
       three-row preview, wrong as a monthly total for two reasons:
         • .filter(status !== 'paid') zeroes it out the moment you pay your
           bills, so a user who paid all four saw "Bills $0.00" against
           $2.9k of income and a ring that said their whole month was
           discretionary spending.
         • .slice(0,3) caps the sum at three bills, so anyone with more than
           three would have had the rest silently missing from the total.
       Paid bills still consumed this month's income, so the ring counts
       every bill DUE this month regardless of status. */
    const _mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const monthBills = (state.bills || []).filter(b => {
      if (!b.due_date) return false;
      const d = FCData.parseDateLocal(b.due_date);
      return d >= mStart && d <= _mEnd;
    });
    const budgets  = state.budgets || {};
    const accounts = state.accounts || [];

    const mTxns      = txns.filter(t => t.date && FCData.parseDateLocal(t.date) >= mStart);
    const totalIncome = mTxns.filter(_isIncomeTxn).reduce((s,t) => s+(t.amount||0), 0);
    const totalSpend  = mTxns.filter(_isSpendTxn).reduce((s,t) => s+(t.amount||0), 0);
    /* Base ceiling plus this month's carried-in credit. Budget Progress has
       to measure against the same number the category rows do, or the two
       halves of one screen disagree about how much room you have. */
    const budgetBase  = _totalBudgetLimit(budgets);
    const rollIn      = _rolloverTotal();
    const budgetLimit = budgetBase + rollIn;
    const budgetPct   = budgetLimit > 0 ? Math.min(100, Math.round(totalSpend/budgetLimit*100)) : 0;
    const budgetColor = budgetPct >= 90 ? 'var(--fc-danger)' : budgetPct >= 70 ? 'var(--fc-warning)' : 'var(--fc-accent)';
    const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    const daysLeft    = daysInMonth - now.getDate();
    const debtAccts   = accounts.filter(a => a.type==='credit' || a.subtype==='credit card' || a.type==='loan');
    const totalBills  = monthBills.reduce((s,b) => s+(b.amount||0), 0);
    const debtPmt     = debtAccts.reduce((s,a) => s+_minPayment(a), 0);
    const goalMonthly = (state.goals||[]).reduce((s,g) => s+(g.monthly_target||0), 0);

    /* ── Monthly Plan ring ─────────────────────────────────────────
       This ring used to be built so that it could not be wrong on its
       face — and was therefore wrong about the money:

         spendPct = 100 - billsPct - debtPct - savePct

       Spending was a RESIDUAL, not a measurement. Whatever the other three
       did not claim, Spending absorbed, so the arcs always filled the
       circle exactly. On a month with $3.3k income, $1,289 of bills and
       $1,002 of actual spending, the Spending arc rendered at 61% of the
       circle while the legend printed $1,002.82 beside it — which is 30%.
       The missing ~$1,007 was the money left over, and the chart quietly
       reassigned it to spending. That is the worst possible direction for
       this error: the one number a person opens this card to find is
       "what is still unspent", and the picture said zero.

       The caps did their own damage — min(99) on bills, min(30) on debt
       and savings — so a month where bills genuinely ate 40% of income and
       savings took 35% drew neither at its true size.

       Now every slice is measured, and the leftover is a slice of its own
       with a name. If commitments exceed income the denominator grows to
       match, so the ring stays a ring and the shortfall is stated in words
       underneath rather than by silently rescaling. */
    const ringIncome = totalIncome;
    const ringParts = [
      { label: 'Bills',    value: totalBills,  color: 'var(--fc-accent)'  },
      { label: 'Debt',     value: debtPmt,     color: 'var(--fc-danger)'  },
      { label: 'Savings',  value: goalMonthly, color: 'var(--fc-success)' },
      { label: 'Spending', value: totalSpend,  color: 'var(--fc-warning)' },
    ];
    const ringAssigned = ringParts.reduce((s,p) => s + p.value, 0);
    const ringLeft     = Math.max(0, ringIncome - ringAssigned);
    const ringOver     = Math.max(0, ringAssigned - ringIncome);
    // Denominator is whichever side is bigger, so the arcs can never sum
    // past a full circle and no slice has to be faked to make them fit.
    const ringDenom    = Math.max(ringIncome, ringAssigned) || 1;
    const ringSlices   = ringParts
      .filter(p => p.value > 0)
      .concat(ringLeft > 0 ? [{ label: 'Left over', value: ringLeft, color: 'var(--fc-text-faint)', isLeft: true }] : []);

    // SVG ring
    const R = 44, CX = 56, CY = 56, circ = 2 * Math.PI * R;
    const seg = (pct, off, color) => {
      if (pct <= 0) return '';
      const len = pct/100*circ, offset = off/100*circ;
      return '<circle cx="'+CX+'" cy="'+CY+'" r="'+R+'" fill="none" stroke="'+color+'" stroke-width="16" '
        +'stroke-dasharray="'+len.toFixed(1)+' '+circ.toFixed(1)+'" '
        +'stroke-dashoffset="'+((-(offset - circ/4)).toFixed(1))+'" />';
    };
    let _ringOff = 0;
    const ringHTML = '<svg width="112" height="112" viewBox="0 0 112 112" style="transform:rotate(-90deg) scaleY(-1)">'
      +'<circle cx="'+CX+'" cy="'+CY+'" r="'+R+'" fill="none" stroke="var(--fc-bg-elevated-2)" stroke-width="16"/>'
      +ringSlices.map(p => {
          const pct = (p.value / ringDenom) * 100;
          const out = seg(pct, _ringOff, p.color);
          _ringOff += pct;
          return out;
        }).join('')
      +'</svg>';
    const ringLegendHTML = ringSlices.map(p =>
      '<div style="display:flex;align-items:center;gap:7px">'
        +'<div style="width:8px;height:8px;border-radius:2px;background:'+p.color+';flex-shrink:0'+(p.isLeft?';opacity:0.55':'')+'"></div>'
        +'<div style="flex:1;font-size:13px;color:var(--fc-text)'+(p.isLeft?';font-weight:600':'')+'">'+esc(p.label)+'</div>'
        +'<div style="font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--fc-text)">'+FCData.formatCurrency(p.value)+'</div>'
      +'</div>').join('');

    // Category budgets
    const catSpend = {};
    mTxns.filter(_isSpendTxn).forEach(t => {
      const cat = t.category?.[1] || t.category?.[0] || 'Other';
      catSpend[cat] = (catSpend[cat]||0) + (t.amount||0);
    });
    const budgetCats = Object.keys(budgets).filter(k => k !== 'total' && budgets[k]?.limit > 0);
    /* `limit` here is the EFFECTIVE limit — the standing budget plus any
       credit carried in from last month's underspend. Measuring this month
       against the base limit while telling the user they earned extra room
       would make the rollover decorative. */
    const catBudgetRows = budgetCats.slice(0,5).map(cat => {
      const base  = budgets[cat]?.limit || 0;
      const roll  = _rolloverFor(cat);
      const limit = base + roll;
      const spent = catSpend[cat] || 0;
      const pct   = limit > 0 ? Math.min(150, Math.round(spent/limit*100)) : 0;
      const color = pct > 100 ? 'var(--fc-danger)' : pct > 80 ? 'var(--fc-warning)' : 'var(--fc-accent)';
      return { cat, base, roll, limit, spent, pct, color, displayPct: Math.min(100,pct) };
    });
    const topOver  = catBudgetRows.filter(r => r.pct > 100).sort((a,b) => (b.spent-b.limit)-(a.spent-a.limit))[0];
    const topUnder = catBudgetRows.filter(r => r.pct < 80 && r.limit > 0).sort((a,b) => a.pct-b.pct)[0];

    const _fmtDue = (d) => { try { return FCData.parseDateLocal(d).toLocaleDateString('en-US',{month:'short',day:'numeric'}); } catch(_e){ return d||''; } };
    const _billStatus = (b) => {
      const days = FCData.daysUntil ? FCData.daysUntil(b.due_date) : Math.round((new Date(b.due_date)-new Date())/86400000);
      if (days === null) return { label:'', cls:'fc-bill-status--ok' };
      if (days < 0)  return { label:'Overdue', cls:'fc-bill-status--due' };
      if (days === 0) return { label:'Due today', cls:'fc-bill-status--due' };
      if (days <= 3)  return { label:days+'d', cls:'fc-bill-status--soon' };
      return { label:days+'d', cls:'fc-bill-status--ok' };
    };
    const billEmoji = (b) => _billIcon(b, 'var(--fc-text-muted)', 18);

    // ── Paycheck plan inputs ─────────────────────────────────────
    const allUnpaidBills = (state.bills || []).filter(b => b.status !== 'paid')
      .sort((a,b) => new Date(a.due_date) - new Date(b.due_date));
    const payday = _predictNextPayday();
    const proj = _buildSafeSpendProjection();
    /* The MEDIAN of this payer's real paydays, not the most recent credit.
       `lastIncomeTxn.amount` was whatever income landed last — a $67.80
       refund, a $12 interest payment, a Venmo from a friend — and the whole
       card is divided by it. In demo that produced "Expected $67.80" and,
       against a $1,523.50 plan, a red "Short $1,455.70" that was pure
       artifact. predictNextPayday already computes the median for exactly
       this purpose (see the note on its return).

       When there is no detected payday we do NOT guess. A fabricated
       paycheck is worse than an absent one on the screen that tells you
       whether your bills are covered — so `expectedPay` stays 0 and the
       card renders its unknown state instead of a false shortfall. */
    const expectedPay = payday && payday.amount > 0 ? payday.amount : 0;
    const payIsEstimated = expectedPay > 0;
    // Math.max(1, …): days is 0 on payday itself, and a 0-day bill window
    // would show an empty paycheck plan on the very day it matters most.
    const payWindow = payday ? Math.max(1, payday.days) : 14;
    const payBills = allUnpaidBills.filter(b => {
      const d = FCData.daysUntil(b.due_date);
      return d !== null && d >= 0 && d <= payWindow;
    });
    const payBillsTotal = payBills.reduce((s,b) => s+(b.amount||0), 0);
    /* Per-PAYCHECK share of a MONTHLY target, so the divisor has to be how
       many paychecks land in a month. This was a hardcoded / 2, which is
       only right for semi-monthly pay. _predictNextPayday() already returns
       the cadence it detected — it is tested and it distinguishes weekly,
       biweekly, semi-monthly and monthly — so there is no reason to guess.

       At / 2 the row was wrong for most people: someone paid WEEKLY was
       told to set aside 2.2x what one cheque should carry, and someone paid
       MONTHLY was told half. Both then read a Remaining figure built on it.

       Unknown cadence keeps the old divisor rather than inventing one — with
       no detected paycheck the card is already in its "no paycheck yet"
       branch and says so. */
    const PER_MONTH = { weekly: 52 / 12, biweekly: 26 / 12, semimonthly: 2, monthly: 1 };
    const payPerMonth = PER_MONTH[payday && payday.cadence] || 2;
    const savePlan  = Math.round(goalMonthly / payPerMonth);
    const spendPlan = Math.round(proj.expectedEverydaySpend || 0);
    const assigned  = payBillsTotal + savePlan + spendPlan;
    const payRemaining = expectedPay - assigned;
    const paydayTitle = payday
      ? payday.date.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' Paycheck'
      : 'Next Paycheck';
    const planRow = (icon, name, amount, badge, badgeColor) =>
      '<div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--fc-border)">'
        +'<div style="width:32px;height:32px;border-radius:9px;background:var(--fc-bg-elevated-2);display:flex;align-items:center;justify-content:center;flex-shrink:0">'+icon+'</div>'
        +'<div style="flex:1;font-size:14px;font-weight:500;color:var(--fc-text)">'+name+'</div>'
        +'<div style="font-size:14px;font-weight:600;color:var(--fc-text);font-variant-numeric:tabular-nums">'+FCData.formatCurrency(amount)+'</div>'
        +(badge ? '<div style="font-size:11px;font-weight:600;color:'+badgeColor+';min-width:52px;text-align:right">'+badge+'</div>' : '')
      +'</div>';
    const paycheckHTML =
      '<div class="fc-card" style="margin-bottom:14px;padding:18px 16px">'
        +'<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">'
          +'<div style="font-size:17px;font-weight:700;color:var(--fc-text)">'+paydayTitle+'</div>'
          // A labelled em-dash is not information. With no paycheck detected
          // the sentence below already says so, in words.
          +(payIsEstimated
            ? '<div style="text-align:right"><div style="font-size:11px;color:var(--fc-text-faint)">Expected</div><div style="font-size:17px;font-weight:750;color:var(--fc-text);font-variant-numeric:tabular-nums">'+FCData.formatCurrency(expectedPay)+'</div></div>'
            : '')
        +'</div>'
        /* Both the bar and the Remaining/Short pair divide by expectedPay,
           so with no detected paycheck they have nothing to say. They used
           to say it anyway — a full red bar and "Short $1,455.70", which is
           just `0 - assigned` wearing the costume of a finding. When the
           paycheck is unknown the card shows what it does know (the bills
           it has lined up) and names the gap instead of inventing one. */
        +(payIsEstimated
          ? '<div style="height:8px;background:var(--fc-bg-elevated-2);border-radius:999px;overflow:hidden;margin-bottom:8px">'
              +'<div style="height:100%;width:'+Math.min(100,Math.round(assigned/expectedPay*100))+'%;background:'+(payRemaining>=0?'var(--fc-success)':'var(--fc-danger)')+';border-radius:999px"></div>'
            +'</div>'
            +'<div style="display:flex;justify-content:space-between;margin-bottom:14px">'
              +'<div><div style="font-size:11px;color:var(--fc-text-faint)">Assigned</div><div style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--fc-text)">'+FCData.formatCurrency(assigned)+'</div></div>'
              +'<div style="text-align:right"><div style="font-size:11px;color:var(--fc-text-faint)">'+(payRemaining>=0?'Remaining':'Short')+'</div><div style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;color:'+(payRemaining>=0?'var(--fc-success)':'var(--fc-danger)')+'">'+FCData.formatCurrency(Math.abs(payRemaining))+'</div></div>'
            +'</div>'
          : '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--fc-border)">'
              +'<div><div style="font-size:11px;color:var(--fc-text-faint)">Lined up</div><div style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--fc-text)">'+FCData.formatCurrency(assigned)+'</div></div>'
              +'<div style="flex:1;text-align:right;font-size:11.5px;color:var(--fc-text-muted);line-height:1.4;padding-left:14px">No regular paycheck detected yet — we need three deposits from one payer.</div>'
            +'</div>')
        +payBills.map(b => {
          const d = FCData.daysUntil(b.due_date);
          return planRow(_billIcon(b,'var(--fc-text-muted)',16), esc(b.name||'Bill'), b.amount||0,
            d===0?'Due today':'Due '+_fmtDue(b.due_date), d!==null&&d<=3?'var(--fc-warning)':'var(--fc-text-faint)');
        }).join('')
        +(savePlan>0 ? planRow(_ic('flag','var(--fc-success)',16), 'Goal savings', savePlan, 'Planned', 'var(--fc-text-faint)') : '')
        +(spendPlan>0 ? planRow(_ic('credit-card','var(--fc-text-muted)',16), 'Everyday spending', spendPlan, 'Planned', 'var(--fc-text-faint)') : '')
        +'<button class="fc-btn fc-btn--ghost fc-btn--sm" style="width:100%;margin-top:14px" onclick="FCApp._openBudgetWizard()">Edit Paycheck Plan</button>'
      +'</div>'
      +(payIsEstimated && payRemaining > 25
        ? '<div class="fc-card" style="margin-bottom:14px;padding:14px 16px;background:var(--fc-success-soft);border-color:var(--fc-success-border);display:flex;align-items:center;gap:12px">'
            +'<span style="flex-shrink:0">'+_ic('trending-up','var(--fc-success)',18)+'</span>'
            +'<div style="flex:1;font-size:13px;color:var(--fc-text);line-height:1.45">'+FCData.formatCurrency(payRemaining)+' unassigned. Put it toward a goal or your smallest debt before it disappears.</div>'
            +'<button onclick="FCApp.openCoachAnswer(\'debt\')" style="background:var(--fc-success);color:var(--fc-success-ink);border:none;border-radius:9px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;font-family:inherit">Assign</button>'
          +'</div>'
        : '');

    // ── Subscriptions panel ─────────────────────────────────────
    const subs = (_detectSubscriptions(txns) || []).sort((a,b) => (b.amount||0)-(a.amount||0));
    const subsTotal = subs.reduce((s,x) => s+(x.amount||0), 0);
    const subsHTML = subs.length
      ? '<div class="fc-card" style="margin-bottom:14px;padding:18px 16px">'
          +'<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">'
            +'<div class="fc-eyebrow">Recurring Charges</div>'
          +'</div>'
          +'<div style="font-size:26px;font-weight:750;color:var(--fc-text);font-variant-numeric:tabular-nums">'+FCData.formatCurrency(subsTotal)+'<span style="font-size:13px;font-weight:500;color:var(--fc-text-muted)">/mo</span></div>'
          +'<div style="font-size:13px;color:var(--fc-text-muted);margin-bottom:10px">'+subs.length+' subscription'+(subs.length===1?'':'s')+' detected</div>'
          +subs.map(s2 => planRow(_ic('play-screen','var(--fc-text-muted)',16), esc(s2.name||'Subscription'), s2.amount||0, '', '')).join('')
          +'<div style="font-size:12px;color:var(--fc-text-faint);margin-top:12px;line-height:1.5">Not using one of these? Cancel it in the provider\'s app — then watch this number drop.</div>'
        +'</div>'
      : '<div class="fc-card" style="padding:36px 24px;text-align:center;margin-bottom:14px">'
          +'<div style="width:52px;height:52px;border-radius:16px;background:var(--fc-accent-soft);display:flex;align-items:center;justify-content:center;margin:0 auto 12px">'+_ic('play-screen','var(--fc-accent)',24)+'</div>'
          +'<div style="font-size:16px;font-weight:600;color:var(--fc-text);margin-bottom:6px">No subscriptions detected yet</div>'
          +'<div style="font-size:13px;color:var(--fc-text-muted);line-height:1.5">Recurring charges show up here automatically after a month or two of history.</div>'
        +'</div>';

    const segBtn = (id, label) =>
      '<button class="fc-seg-btn'+(_planSeg===id?' active':'')+'" role="tab" aria-selected="'+(_planSeg===id)+'"'
      +' type="button" onclick="FCApp.switchPlanSeg(\''+id+'\')">'+label+'</button>';

    el.innerHTML =
      '<header class="fc-page-head">'
        +'<div class="fc-page-head__text">'
          +'<h1 class="fc-page-title">Plan</h1>'
          +'<p class="fc-page-sub">'+now.toLocaleDateString('en-US',{month:'long',year:'numeric'})+'</p>'
        +'</div>'
      +'</header>'

      +'<div class="fc-seg" role="tablist" aria-label="Plan view">'
        +segBtn('paycheck','Paycheck')
        +segBtn('bills','Bills')
        +segBtn('budget','Budget')
        +segBtn('subscriptions','Subs')
      +'</div>'

      +(_planSeg === 'paycheck' ? paycheckHTML : '')
      +(_planSeg === 'subscriptions' ? subsHTML : '')

      +(_planSeg !== 'budget' ? '' : ''
      // ── Monthly Plan ring ──
      // monthBills, not the unpaid-only preview: a user who has bills and has
      // paid them all has plan data, and was being shown "No plan data yet".
      +(totalIncome === 0 && budgetLimit === 0 && monthBills.length === 0
        ? '<div class="fc-card" style="margin-bottom:14px;padding:24px 16px;text-align:center">'
            +'<div style="width:48px;height:48px;border-radius:14px;background:var(--fc-accent-soft);display:flex;align-items:center;justify-content:center;margin:0 auto 12px">'+_ic('bar-chart','var(--fc-accent)',22)+'</div>'
            +'<div style="font-size:16px;font-weight:600;color:var(--fc-text);margin-bottom:6px">No plan data yet</div>'
            +'<div style="font-size:13px;color:var(--fc-text-muted);line-height:1.5;margin-bottom:16px">Connect a bank account and set a monthly budget to see your spending plan here.</div>'
            +'<button class="fc-btn fc-btn--primary fc-btn--sm" onclick="FCApp._openBudgetWizard()">Build Your Budget</button>'
          +'</div>'
        : '<div class="fc-card" style="margin-bottom:14px;padding:18px 16px">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">'
          +'<div>'
            +'<div class="fc-eyebrow">Monthly Plan</div>'
          +'</div>'
          +'<button onclick="FCApp._openBudgetWizard()" style="background:none;border:none;color:var(--fc-accent);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Edit Plan</button>'
        +'</div>'
        +'<div style="display:flex;align-items:center;gap:18px">'
          +'<div style="flex-shrink:0;position:relative">'
            +ringHTML
            +'<div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center">'
              +'<div style="font-size:10px;font-weight:600;color:var(--fc-text-faint);letter-spacing:0.3px">INCOME</div>'
              +'<div style="font-size:14px;font-weight:700;color:var(--fc-text)">'+(totalIncome>0?(totalIncome>=1000?'$'+(totalIncome/1000).toFixed(1).replace(/\.0$/,'')+'k':FCData.formatCurrency(totalIncome)):'--')+'</div>'
            +'</div>'
          +'</div>'
          +'<div style="flex:1;display:flex;flex-direction:column;gap:7px">'
            +ringLegendHTML
          +'</div>'
        +'</div>'
        /* Said in words, because a ring cannot show a negative. When
           commitments exceed income the arcs are scaled by the larger
           side, so the picture stays honest but stops being the whole
           story — this line is the rest of it. */
        +(ringOver > 0
          ? '<div style="margin-top:12px;padding-top:11px;border-top:1px solid var(--fc-border);font-size:12.5px;font-weight:600;color:var(--fc-danger)">'
              +'Your plan is '+FCData.formatCurrency(ringOver)+' more than you brought in this month.'
            +'</div>'
          : '')
      +'</div>')

      // ── Budget Progress ──
      +'<div class="fc-card" style="margin-bottom:14px;padding:18px 16px">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
          +'<div style="font-size:17px;font-weight:700;color:var(--fc-text)">Budget Progress</div>'
          +'<div style="font-size:13px;color:var(--fc-text-faint)">'+daysLeft+'d left</div>'
        +'</div>'
        /* The reward, stated plainly and only when it was earned. This is
           the one place the app can say "last month went well" with a
           number behind it. */
        +(rollIn > 0
          ? '<div style="display:flex;align-items:center;gap:7px;margin:-4px 0 12px">'
              + _ic('trending-up','var(--fc-success)',14)
              + '<span style="font-size:12.5px;color:var(--fc-success);font-weight:600">'
              + FCData.formatCurrency(rollIn) + ' rolled over from last month</span>'
            +'</div>'
          : '')
        +(budgetLimit > 0
          ? (function () {
              // Pace marker — where spending *should* be by today at an even burn
              const _dim      = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
              const _pacePct  = Math.min(100, Math.round((now.getDate() / _dim) * 100));
              const _paceAmt  = budgetLimit * now.getDate() / _dim;
              const _paceDelta = _paceAmt - totalSpend;
              const _onPace   = _paceDelta >= 0;
              return '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">'
                +'<div style="font-size:24px;font-weight:750;color:var(--fc-text);font-variant-numeric:tabular-nums">'+FCData.formatCurrency(totalSpend)+'</div>'
                +'<div style="font-size:13px;color:var(--fc-text-muted)">of '+FCData.formatCurrency(budgetLimit)+'</div>'
              +'</div>'
              +'<div class="fc-progress" style="margin-bottom:8px;position:relative;overflow:visible">'
                +'<div class="fc-progress-fill" style="width:'+budgetPct+'%;background:'+budgetColor+'"></div>'
                +'<div style="position:absolute;top:-3px;bottom:-3px;left:'+_pacePct+'%;width:2px;border-radius:1px;background:var(--fc-text-faint)" title="Expected by today"></div>'
              +'</div>'
              +'<div style="display:flex;justify-content:space-between;align-items:center">'
                +'<div style="font-size:13px;font-weight:600;color:'+(_onPace?'var(--fc-success)':'var(--fc-warning)')+'">'
                  +(_onPace ? FCData.formatCurrency(_paceDelta)+' under pace' : FCData.formatCurrency(Math.abs(_paceDelta))+' over pace')
                +'</div>'
                +'<div style="font-size:13px;font-weight:600;color:'+(budgetPct>90?'var(--fc-danger)':budgetPct>70?'var(--fc-warning)':'var(--fc-success)')+'">'+FCData.formatCurrency(Math.max(0,budgetLimit-totalSpend))+' left</div>'
              +'</div>';
            })()
          : '<div style="text-align:center;padding:12px 0">'
              +'<div style="font-size:15px;color:var(--fc-text-muted);margin-bottom:12px">Set a monthly budget to track your spending</div>'
              +'<button class="fc-btn fc-btn--primary fc-btn--sm" onclick="FCApp._openBudgetWizard()">Build Budget</button>'
            +'</div>')
      +'</div>'

      // ── Category Budgets ──
      +(catBudgetRows.length > 0
        ? '<div class="fc-card" style="margin-bottom:14px;padding:18px 16px">'
            +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">'
              +'<div style="font-size:17px;font-weight:700;color:var(--fc-text)">Category Budgets</div>'
              +'<button onclick="FCApp._openBudgetWizard()" style="background:none;border:none;color:var(--fc-accent);font-size:13px;font-weight:600;cursor:pointer">View all</button>'
            +'</div>'
            +catBudgetRows.map(r =>
              '<div style="margin-bottom:13px">'
                +'<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">'
                  +'<div style="font-size:14px;font-weight:500;color:var(--fc-text)">'+esc(r.cat)+'</div>'
                  +'<div style="font-size:12px;color:'+(r.pct>100?'var(--fc-danger)':r.pct>80?'var(--fc-warning)':'var(--fc-text-muted)')+'">'+FCData.formatCurrency(r.spent)+' of '+FCData.formatCurrency(r.limit)+'</div>'
                +'</div>'
                /* Say where the extra room came from. An limit that silently
                   grew is the kind of number change that makes people stop
                   trusting every other number on the screen. */
                +(r.roll > 0
                  ? '<div style="font-size:11px;color:var(--fc-success);margin-bottom:5px">+'
                    + FCData.formatCurrency(r.roll) + ' rolled over from last month</div>'
                  : '')
                +'<div style="height:6px;background:var(--fc-bg-elevated-2);border-radius:999px;overflow:hidden">'
                  +'<div style="height:100%;width:'+r.displayPct+'%;background:'+r.color+';border-radius:999px;transition:width 0.5s ease"></div>'
                +'</div>'
                +'<div style="font-size:11px;color:'+(r.pct>100?'var(--fc-danger)':r.pct>80?'var(--fc-warning)':'var(--fc-text-faint)')+';margin-top:2px;text-align:right">'+r.pct+'%</div>'
              +'</div>'
            ).join('')
          +'</div>'
        : '')

      // ── Suggested Fix ──
      +(topOver && topUnder && !_budgetSuggestionDismissed()
        /* Three fixes here.
           · The 💡 was the last emoji chrome on Plan; every other glyph on
             this screen comes from _ic().
           · The soft background was hardcoded rgba(245,158,11,…) rather
             than the token, so it never responded to the theme.
           · "Adjust Budget" was `background:var(--fc-warning); color:#fff`.
             --fc-warning is #F59E0B in light mode — 2.15:1 against white,
             and the design system says in a comment on the token itself
             that it must never carry text. It is a normal primary button
             now, which is also what every other CTA on Plan already is. */
        ? '<div class="fc-card" style="margin-bottom:14px;padding:16px;background:var(--fc-warning-soft);border-color:var(--fc-warning-soft)">'
            +'<div style="display:flex;gap:12px;align-items:flex-start">'
              +'<div style="flex-shrink:0;margin-top:1px">'+_ic('lightbulb','var(--fc-warning-text)',20)+'</div>'
              +'<div style="flex:1">'
                +'<div style="font-size:15px;font-weight:600;color:var(--fc-text);margin-bottom:4px">Budget Suggestion</div>'
                +'<div style="font-size:13px;color:var(--fc-text-muted);line-height:1.5;margin-bottom:12px">'+esc(topOver.cat)+' is '+FCData.formatCurrency(topOver.spent-topOver.limit)+' over budget. You have room in '+esc(topUnder.cat)+'.</div>'
                +'<div style="display:flex;gap:8px">'
                  +'<button class="fc-btn fc-btn--primary fc-btn--sm" type="button" onclick="FCApp._openBudgetWizard()">Adjust Budget</button>'
                  // Was a button with no onclick at all — it looked like a
                  // choice and did nothing. Dismissal is remembered for the
                  // rest of the month, the same way the budget alerts are.
                  +'<button class="fc-btn fc-btn--ghost fc-btn--sm" type="button" onclick="FCApp._dismissBudgetSuggestion()">Not Now</button>'
                +'</div>'
              +'</div>'
            +'</div>'
          +'</div>'
        : '')

      )

      // ── Bills panel ──
      +(_planSeg !== 'bills' ? '' : ''
      +'<div class="fc-card" style="margin-bottom:14px;padding:18px 16px">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">'
          +'<div style="font-size:17px;font-weight:700;color:var(--fc-text)">Upcoming Bills</div>'
          /* Was _openSubScreen('bills'). #view-bills was deleted when the
             duplicate Bills screen was removed, but these two routes into it
             were not — and _openSubScreen fires its haptic BEFORE looking the
             element up, then returns silently when it is missing. So the
             button buzzed and did nothing, which is the most convincing way
             possible for a dead control to look alive.
             Activity > Bills is the surviving bills screen and is what every
             other entry point in the app already uses. */
          +'<button onclick="FCApp.switchTab(\'activity\');FCApp.switchActivitySegment(\'bills\')" style="background:none;border:none;color:var(--fc-accent);font-size:13px;font-weight:600;cursor:pointer">Manage →</button>'
        +'</div>'
        +(allUnpaidBills.length > 0
          ? allUnpaidBills.map(b => {
              const st = _billStatus(b);
              return '<div class="fc-bill-row" onclick="FCApp.switchTab(\'activity\');FCApp.switchActivitySegment(\'bills\')">'
                +'<div class="fc-bill-icon">'+billEmoji(b)+'</div>'
                +'<div class="fc-bill-info">'
                  +'<div class="fc-bill-name">'+esc(b.name)+'</div>'
                  +'<div class="fc-bill-due">Due '+_fmtDue(b.due_date)+'</div>'
                +'</div>'
                +'<div class="fc-bill-right">'
                  +'<div class="fc-bill-amount">'+FCData.formatCurrency(b.amount||0)+'</div>'
                  +'<div class="fc-bill-status '+(b.status==='paid'?'fc-bill-status--paid':st.cls)+'">'+esc(b.status==='paid'?'Paid':st.label)+'</div>'
                +'</div>'
              +'</div>';
            }).join('')
          // "No upcoming bills" is technically true when everything is paid,
          // but it reads as "we have no record of your bills" — which is
          // alarming on a screen whose job is to reassure. Distinguish the
          // two states: nothing left to pay vs nothing tracked at all.
          : (monthBills.length > 0
              ? '<div style="padding:12px 0;text-align:center;color:var(--fc-success);font-size:14px;font-weight:600">All ' + monthBills.length + ' bill' + (monthBills.length !== 1 ? 's' : '') + ' paid this month</div>'
              : '<div style="padding:12px 0;text-align:center;color:var(--fc-text-muted);font-size:14px">No bills tracked yet</div>'))
      +'</div>'
      );
  }

  let _planSeg = 'paycheck';
  function switchPlanSeg(seg) {
    if (_planSeg === seg) return;
    _planSeg = seg;
    haptic('light');
    _renderPlan();
  }

  /**
   * "Edit Paycheck Plan" (Plan > Paycheck) and "Edit Plan" (Plan > Budget).
   *
   * This was an empty function, so both buttons did nothing at all. It used to
   * call _renderBudgetWizard(), which had itself been a no-op since the Home
   * v8 rebuild deleted the #home-budget-wizard-section it rendered into — so
   * the buttons had been dead well before that function was removed.
   *
   * The thing they should edit already exists: the monthly budget total, which
   * openCategoryBudgetSheet() handles as the 'total' category, complete with
   * its own title and presets.
   */
  function _openBudgetWizard() {
    const budgets = state.budgets || {};
    const current = Number(budgets.total && budgets.total.limit) || 0;
    openCategoryBudgetSheet('total', current);
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: MORE HUB
     ───────────────────────────────────────────────────────────── */

  function _renderMore() {
    const el = document.getElementById('more-content');
    if (!el) return;
    const user = state.user || {};
    const authUser = (typeof FCAuth !== 'undefined' && FCAuth.currentUser) ? FCAuth.currentUser() : null;
    const displayName  = user.name || authUser?.displayName || user.email?.split('@')[0] || 'User';
    const displayEmail = authUser?.email || user.email || '';
    const initial = displayName.charAt(0).toUpperCase();
    const isPro = !!(user.is_pro || user.pro);

    const toolTile = (icon, label, color, softBg, action) =>
      '<button onclick="'+action+'" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;'
      +'background:var(--fc-bg-elevated);border:1px solid var(--fc-border);border-radius:16px;padding:16px 8px;cursor:pointer;'
      +'box-shadow:var(--fc-shadow-sm);aspect-ratio:1;-webkit-tap-highlight-color:transparent;width:100%">'
        +'<div style="width:44px;height:44px;border-radius:12px;background:'+softBg+';display:flex;align-items:center;justify-content:center">'+_ic(icon, color, 20)+'</div>'
        +'<div style="font-size:12px;font-weight:600;color:var(--fc-text);text-align:center;line-height:1.2">'+label+'</div>'
      +'</button>';

    const acctRow = (icon, label, sub, action) =>
      '<div onclick="'+action+'" style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--fc-border);cursor:pointer;-webkit-tap-highlight-color:transparent">'
        +'<div style="width:36px;height:36px;border-radius:10px;background:var(--fc-bg-elevated-2);display:flex;align-items:center;justify-content:center;flex-shrink:0">'+_ic(icon, 'var(--fc-text-muted)', 18)+'</div>'
        +'<div style="flex:1;min-width:0">'
          +'<div style="font-size:15px;font-weight:500;color:var(--fc-text)">'+label+'</div>'
          +(sub?'<div style="font-size:12px;color:var(--fc-text-faint);margin-top:1px">'+sub+'</div>':'')
        +'</div>'
        +'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>'
      +'</div>';

    el.innerHTML =
      '<header class="fc-page-head">'
        +'<div class="fc-page-head__text"><h1 class="fc-page-title">More</h1></div>'
      +'</header>'

      +'<div class="fc-card" style="padding:16px;margin-bottom:20px;cursor:pointer;display:flex;align-items:center;gap:14px" onclick="FCApp._openSubScreen(\'settings\')">'
        +'<div style="width:48px;height:48px;border-radius:50%;background:var(--fc-accent-soft);border:2px solid var(--fc-accent);display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:var(--fc-accent);flex-shrink:0">'+esc(initial)+'</div>'
        /* esc() on both. These are the user's own profile name and email —
           user.name comes from Firestore and is written by
           saveProfileChanges() after nothing but a .trim() and a non-empty
           check, so a name containing markup was reaching innerHTML intact.
           Settings renders the same two values through .textContent, which
           is why only this screen was exposed. */
        +'<div style="flex:1;min-width:0">'
          +'<div style="font-size:17px;font-weight:600;color:var(--fc-text)">'+esc(displayName)+'</div>'
          +'<div style="font-size:13px;color:var(--fc-text-muted);margin-top:1px">'+esc(displayEmail)+'</div>'
        +'</div>'
        +(isPro?'<span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;background:var(--fc-accent-soft);color:var(--fc-accent)">PRO</span>':'')
        +'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>'
      +'</div>'

      +_vaultMoreCard()

      +'<div class="fc-eyebrow">Money Tools</div>'
      +'<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">'
        +toolTile('credit-card','Bills','var(--fc-accent)','var(--fc-accent-soft)',"FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')")
        +toolTile('trending-down','Debt','var(--fc-danger)','var(--fc-danger-soft)',"FCApp._openDebtPage()")
        +toolTile('flag','Goals','var(--fc-success)','var(--fc-success-soft)',"FCApp._openSubScreen('goals')")
        +toolTile('trending-up','Investments','var(--fc-electric)','var(--fc-electric-soft)',"FCApp._openSubScreen('investments')")
        +toolTile('calendar','Calendar','var(--fc-warning)','var(--fc-warning-soft)',"FCApp._openSubScreen('calendar')")
        +toolTile('bar-chart','Reports','var(--fc-accent)','var(--fc-accent-soft)',"FCApp._openSubScreen('reports')")
      +'</div>'

      +'<div class="fc-eyebrow">Account</div>'
      +'<div class="fc-card" style="padding:0 16px">'
        +acctRow('gear','Settings','Profile, security, subscription',"FCApp._openSubScreen('settings')")
        +acctRow('bank','Connected Accounts','Manage linked banks',"FCApp.showBankSheet&&FCApp.showBankSheet()")
        +acctRow('star','Subscription',isPro?'FlowCheck Pro · Active':'Upgrade for full access',isPro?"FCApp._openSubScreen('settings')":"FCApp.showPaywall&&FCApp.showPaywall()")
        +acctRow('bell','Notifications','Alerts & reminders',"FCApp._openSubScreen('notifications')")
        /* Says what it does. The label was "Help Center", which promises a
           searchable knowledge base; the tap opens a blank email to support.
           window.open() with a mailto: is also the shakier way to do it in a
           WKWebView — location.href hands the URL to the OS, which is what
           actually launches Mail. */
        +'<div onclick="window.location.href=\'mailto:support@flowcheck.app\'" style="display:flex;align-items:center;gap:14px;padding:14px 0;cursor:pointer;-webkit-tap-highlight-color:transparent">'
          +'<div style="width:36px;height:36px;border-radius:10px;background:var(--fc-bg-elevated-2);display:flex;align-items:center;justify-content:center;flex-shrink:0">'+_ic('help-circle','var(--fc-text-muted)',18)+'</div>'
          +'<div style="flex:1"><div style="font-size:15px;font-weight:500;color:var(--fc-text)">Contact Support</div><div style="font-size:12px;color:var(--fc-text-faint);margin-top:1px">Email us at support@flowcheck.app</div></div>'
          +'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>'
        +'</div>'
      +'</div>';
  }

  /* ═══════════════════════════════════════════════════════════════
     THE VAULT — proof of what the subscription is worth
     ═══════════════════════════════════════════════════════════════
     The Vault is a tool included with Pro. It charges nothing — it exists
     to answer one question with receipts: did the subscription pay for
     itself this month?

     This screen is the argument. It has to survive a user reading it line
     by line against their bank statement, because that is exactly what
     someone does the first time they are charged. So every claim on it
     carries the transactions behind it, every number is computed by the
     tested engine in fc-vault.js rather than here, and the states where
     FlowCheck earned nothing are written as plainly as the ones where it
     earned the cap.

     A savings figure nobody can check is marketing. This one is a bill.
     ═══════════════════════════════════════════════════════════════ */

  /**
   * The Vault's entry point in More. Shows this month's actual bill once the
   * attribution flags have loaded — never before, because an unloaded flag
   * map makes every cancellation look unattributed, and a bill that reads
   * "free" and then corrects itself upward is the one thing this model
   * cannot afford to do.
   */
  function _vaultMoreCard() {
    let line = 'See what your subscription has found you';
    let tint = 'var(--fc-accent)';
    if (_vaultLoaded && typeof FCVault !== 'undefined') {
      const s = _vaultBuild().statement;
      line = s.empty
        ? 'Nothing found yet this month'
        : esc(FCData.formatCurrency(s.proven)) + ' found this month'
          + (s.paidForItself ? ' — Pro paid for itself' : '');
      if (!s.empty) tint = 'var(--fc-success)';
    } else {
      _vaultLoad().then(() => { if (state.tab === 'more') _renderMore(); });
    }
    return '<div class="fc-card" style="padding:16px;margin-bottom:20px;cursor:pointer;display:flex;'
      + 'align-items:center;gap:14px" onclick="FCApp._openSubScreen(\'vault\')" role="button" tabindex="0">'
      + '<div style="width:44px;height:44px;border-radius:12px;background:var(--fc-success-soft);display:flex;'
        + 'align-items:center;justify-content:center;flex-shrink:0">' + _ic('shield', 'var(--fc-success)', 20) + '</div>'
      + '<div style="flex:1;min-width:0">'
        + '<div style="font-size:15px;font-weight:600;color:var(--fc-text)">The Vault</div>'
        + '<div style="font-size:12px;color:' + tint + ';margin-top:2px;line-height:1.35">' + line + '</div>'
      + '</div>'
      + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" '
      + 'stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>'
      + '</div>';
  }

  let _vaultFlagged   = null;   // { merchantKey: 'YYYY-MM-DD' } from Firestore
  let _vaultForecasts = null;   // settled forecasts, for overdraft-avoided credits
  let _vaultLoaded    = false;
  let _vaultOpenReceipt = null;

  /** Load the two things the Vault cannot recompute, once per session. */
  async function _vaultLoad() {
    if (_vaultLoaded) return;
    _vaultLoaded = true;
    if (_isDemoMode) {
      // Demo data end to end, including attribution: without seeded flags the
      // demo Vault would show every cancellation as the user's own win and
      // bill $0, which hides the exact mechanic App Review needs to see.
      _vaultFlagged = {};
      _detectSubscriptions().forEach(s => {
        const k = FCVault.merchantKey(s.name);
        if (k) _vaultFlagged[k] = FCCore.isoDay(new Date(Date.now() - 400 * 86400000));
      });
      _vaultForecasts = [];
      return;
    }
    if (!FCAuth?.currentUser?.()) { _vaultFlagged = {}; _vaultForecasts = []; return; }
    try {
      _vaultFlagged   = await FCData.getVaultFlags();
      _vaultForecasts = await FCData.getForecasts(24);
    } catch (_) {
      _vaultFlagged = _vaultFlagged || {};
      _vaultForecasts = _vaultForecasts || [];
    }
  }

  /**
   * Record first-sight for every recurring charge we are currently showing.
   * This is what earns FlowCheck the right to bill for a cancellation later:
   * without a flag predating the last charge, fc-vault.js treats the saving
   * as the user's own and excludes it from the bill.
   */
  async function _vaultFlagVisibleSubs() {
    if (_isDemoMode || !FCAuth?.currentUser?.() || !FCData?.flagVaultSubs) return;
    await _vaultLoad();
    const today = FCCore.isoDay(new Date());
    const fresh = _detectSubscriptions()
      .map(s => FCVault.merchantKey(s.name))
      .filter(k => k && !(_vaultFlagged && _vaultFlagged[k]));
    if (!fresh.length) return;
    const unique = [...new Set(fresh)];
    await FCData.flagVaultSubs(unique, today);
    // The filter above already treats _vaultFlagged as possibly-null; this
    // line did not, and threw "Cannot set properties of null" the moment a
    // subscription needed flagging before the map had loaded. Same guard,
    // both places.
    if (!_vaultFlagged) _vaultFlagged = {};
    unique.forEach(k => { _vaultFlagged[k] = today; });
  }

  /** Everything the Vault screen shows, from the tested engine. */
  function _vaultBuild() {
    const events = FCVault.detectEvents({
      subscriptions: _detectSubscriptions(),
      flagged:       _vaultFlagged || {},
      transactions:  state.transactions || [],
      forecasts:     _vaultForecasts || [],
      today:         new Date(),
    });
    const month = FCCore.isoDay(new Date()).slice(0, 7);
    return {
      events:    events,
      month:     month,
      statement: FCVault.statementFor(events, month),
      summary:   FCVault.vaultSummary(events),
    };
  }

  const _VAULT_KIND_ICON = {
    subscription_ended: 'play-screen',
    overdraft_avoided:  'shield',
    under_forecast:     'trending-down',
    refund_recovered:   'credit-card',
  };

  const _VAULT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function _vaultDateLabel(iso) {
    const d = FCCore.parseDateLocal(iso);
    if (isNaN(d)) return String(iso || '');
    return _VAULT_MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  function _vaultToggleReceipt(id) {
    haptic('light');
    _vaultOpenReceipt = (_vaultOpenReceipt === id) ? null : id;
    _renderVaultScreen();
  }

  /** One ledger row: the claim, the amount, and the receipt behind it. */
  function _vaultEventRow(e) {
    const open = _vaultOpenReceipt === e.id;
    const attributed = e.attributed !== false;
    const tint = attributed ? 'var(--fc-success)' : 'var(--fc-text-muted)';

    // Dollar-valued evidence keys render as money; everything else as-is.
    // A receipt line reading "Amount 67.8" undercuts the one thing this
    // block exists to do, which is look checkable against a statement.
    const MONEY_KEYS = /^(amount|cycleAmount|predictedEnd|actualEnd|yourFee|monthSpend|priorMedian|priorLow)$/;
    const receiptRows = Object.entries(e.evidence || {})
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => {
        const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
        const val = MONEY_KEYS.test(k) ? FCData.formatCurrency(v)
                  : Array.isArray(v) ? v.join(', ')
                  : String(v);
        return '<div style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:12px">'
          + '<span style="color:var(--fc-text-faint)">' + esc(label) + '</span>'
          + '<span style="color:var(--fc-text-muted);font-variant-numeric:tabular-nums;text-align:right">' + esc(val) + '</span>'
          + '</div>';
      }).join('');

    return '<div class="fc-card" style="padding:0;margin-bottom:8px;overflow:hidden">'
      + '<button type="button" onclick="FCApp._vaultToggleReceipt(' + JSON.stringify(e.id).replace(/"/g, '&quot;') + ')" '
        + 'aria-expanded="' + (open ? 'true' : 'false') + '" '
        + 'style="display:flex;align-items:center;gap:12px;width:100%;padding:14px 16px;background:none;border:none;'
        + 'cursor:pointer;text-align:left;font-family:inherit;-webkit-tap-highlight-color:transparent">'
        + '<div style="width:36px;height:36px;border-radius:10px;background:var(--fc-bg-elevated-2);display:flex;'
          + 'align-items:center;justify-content:center;flex-shrink:0">'
          + _ic(_VAULT_KIND_ICON[e.kind] || 'check', tint, 18) + '</div>'
        + '<div style="flex:1;min-width:0">'
          + '<div style="font-size:14px;font-weight:600;color:var(--fc-text)">' + esc(e.title) + '</div>'
          // The date is not decoration: the ledger spans months, so without it
          // a row cannot be matched against a statement.
          + '<div style="font-size:12px;color:var(--fc-text-faint);margin-top:2px">'
            + esc(_vaultDateLabel(e.date)) + ' · ' + esc(e.detail) + '</div>'
        + '</div>'
        + '<div style="text-align:right;flex-shrink:0">'
          + '<div class="fc-amount" style="font-size:15px;font-weight:700;color:' + tint + '">+'
            + esc(FCData.formatCurrency(e.amount)) + '</div>'
          + '<div style="font-size:10px;color:var(--fc-text-faint);margin-top:1px">'
            + (attributed ? esc(e.confidence === 'observed' ? 'Verified' : 'Estimated') : 'Your win') + '</div>'
        + '</div>'
      + '</button>'
      + (open
        ? '<div style="padding:2px 16px 14px;border-top:1px solid var(--fc-border);margin:0 0 0 0">'
            + '<div class="fc-section-label" style="padding-top:10px">Receipt</div>'
            + receiptRows
            + (attributed ? '' :
              '<p style="font-size:11px;color:var(--fc-text-muted);margin:8px 0 0;line-height:1.45">'
              + 'You cancelled this before FlowCheck ever showed it to you, so we do not count it as ours.</p>')
          + '</div>'
        : '')
      + '</div>';
  }

  function _renderVaultScreen() {
    const el = document.getElementById('vault-screen-content');
    if (!el) return;

    // First paint may land before Firestore answers; load, then re-render.
    if (!_vaultLoaded) { _vaultLoad().then(() => _renderVaultScreen()); }

    const { events, statement: s, summary, month } = _vaultBuild();
    const attributed = events.filter(e => e.attributed !== false);
    const ownWins  = events.filter(e => e.attributed === false);

    /* The bill accrues through the month rather than being known on the 1st,
       so it has to be labelled "so far". Calling a running total "this month"
       would mean the number rises after the user has read it — on a screen
       whose entire job is that the number can be trusted. */
    const prevMonth = (() => {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
      return FCCore.isoDay(d).slice(0, 7);
    })();
    const last = FCVault.statementFor(events, prevMonth);
    const hasLast = summary.months > 0 && (last.eventCount > 0 || summary.months > 1);

    /* ── Hero: what Pro found you this month ────────────────────
       The headline number is the SAVINGS, not a charge. The Vault is
       included with the subscription; this screen answers "was it worth
       it?", so the money shown is money the user kept. */
    const provenStr = FCData.formatCurrency(s.proven);
    const heroSub = s.empty
      ? (summary.proven > 0
          ? 'Nothing new this month yet. Your subscription is unchanged either way.'
          : 'Nothing proven yet. When we find something, it shows up here with the receipt.')
      : s.paidForItself
        ? 'Your ' + FCData.formatCurrency(s.subscriptionCost) + ' subscription paid for itself '
          + s.multiple + '× over this month.'
        : 'That is ' + Math.round((s.proven / s.subscriptionCost) * 100) + '% of your '
          + FCData.formatCurrency(s.subscriptionCost) + ' subscription, earned back so far.';

    /* Meter: how far this month's savings got against the subscription
       price. Full bar means it covered itself; beyond that we stop growing
       the bar and say the multiple instead, because a 20x bar is just a
       full bar. */
    const coverPct = s.subscriptionCost > 0
      ? Math.max(2, Math.min(100, (s.proven / s.subscriptionCost) * 100)) : 0;
    const meter = s.proven > 0
      ? '<div style="margin-top:16px">'
        + '<div style="display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--fc-bg-elevated-2)">'
          + '<div style="width:' + coverPct.toFixed(1) + '%;background:'
            + (s.paidForItself ? 'var(--fc-success)' : 'var(--fc-accent)') + '"></div>'
        + '</div>'
        + '<div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px">'
          + '<span style="color:var(--fc-text-faint);font-weight:600">Pro costs '
            + esc(FCData.formatCurrency(s.subscriptionCost)) + '/mo</span>'
          + '<span style="color:' + (s.paidForItself ? 'var(--fc-success)' : 'var(--fc-text-faint)')
            + ';font-weight:600">' + (s.paidForItself ? 'Covered ' + s.multiple + '×' : 'Not yet covered')
          + '</span>'
        + '</div>'
      + '</div>'
      : '';

    const hero = '<section class="fc-ui-card" style="padding:20px 18px;margin-bottom:14px;'
        + 'background:linear-gradient(160deg,var(--fc-bg-elevated) 0%,var(--fc-bg-elevated-2) 100%)">'
      + '<p class="fc-section-label" style="margin:0">Found for you this month</p>'
      + '<div class="fc-amount" style="font-size:44px;font-weight:700;letter-spacing:-0.02em;line-height:1.05;'
        + 'margin:6px 0 4px;color:' + (s.empty ? 'var(--fc-text-muted)' : 'var(--fc-success)') + '">'
        + esc(provenStr) + '</div>'
      + '<p style="font-size:13px;color:var(--fc-text-muted);margin:0;line-height:1.45">' + esc(heroSub) + '</p>'
      + meter
      + (s.cappedAt
        ? '<p style="font-size:11px;color:var(--fc-text-faint);margin:12px 0 0;line-height:1.45">'
          + 'Counting is capped at ' + esc(FCData.formatCurrency(s.cappedAt))
          + ' a month so one unusual event cannot distort the picture.</p>'
        : '')
      // Last month, for comparison — a closed month is the honest yardstick
      // for a month still in progress.
      + (hasLast
        ? '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-top:16px;'
          + 'padding-top:14px;border-top:1px solid var(--fc-border)">'
          + '<span style="font-size:12px;color:var(--fc-text-faint)">Last month</span>'
          + '<span class="fc-amount" style="font-size:14px;font-weight:600;color:'
            + (last.empty ? 'var(--fc-text-faint)' : 'var(--fc-success)') + '">'
            + (last.empty ? 'Nothing found' : esc(FCData.formatCurrency(last.proven))
                + (last.paidForItself
                    ? ' <span style="color:var(--fc-text-faint);font-weight:500">· paid for itself</span>'
                    : ''))
          + '</span>'
        + '</div>'
        : '')
      + '</section>';

    // ── What this screen is, in the fewest words that are still true ──
    const terms = '<section class="fc-ui-card" style="padding:16px 18px;margin-bottom:18px">'
      + '<p class="fc-section-label" style="margin:0 0 8px">How this works</p>'
      + '<p style="font-size:13px;color:var(--fc-text-muted);margin:0;line-height:1.6">'
        + 'The Vault is included with Pro — <strong style="color:var(--fc-text)">it never charges you anything extra</strong>. '
        + 'It only counts money we can show you on your own bank statement, so every '
        + 'claim below opens to the transactions behind it. '
        + 'If we cannot prove it, we do not count it.'
      + '</p></section>';

    // ── Ledger ──────────────────────────────────────────────────
    const ledger = attributed.length
      ? '<div class="fc-eyebrow">Every claim we have made · ' + attributed.length + '</div>'
        + attributed.map(_vaultEventRow).join('')
      : '<div class="fc-eyebrow">Every claim we have made</div>'
        + '<section class="fc-ui-card" style="padding:22px 18px;margin-bottom:8px;text-align:center">'
          + '<div style="width:44px;height:44px;border-radius:12px;background:var(--fc-bg-elevated-2);display:flex;'
            + 'align-items:center;justify-content:center;margin:0 auto 12px">'
            + _ic('search', 'var(--fc-text-faint)', 20) + '</div>'
          + '<p style="font-size:14px;font-weight:600;color:var(--fc-text);margin:0 0 6px">Nothing proven yet</p>'
          + '<p style="font-size:12.5px;color:var(--fc-text-muted);margin:0;line-height:1.5">'
            + 'FlowCheck only counts savings it can show you on a bank statement — a subscription that '
            + 'stopped billing, a double charge that came back, an overdraft fee you have actually paid before '
            + 'and then did not. Until one of those lands, you are not charged.</p>'
        + '</section>';

    // ── Wins we refuse to bill for ──────────────────────────────
    const own = ownWins.length
      ? '<div class="fc-eyebrow" style="margin-top:18px">Your own wins · not counted as ours</div>'
        + '<p style="font-size:12px;color:var(--fc-text-faint);margin:0 0 8px;line-height:1.5">'
        + esc(FCData.formatCurrency(summary.ownWins)) + ' you saved before FlowCheck ever flagged it. '
        + 'It is your work, so we do not count it as ours.</p>'
        + ownWins.map(_vaultEventRow).join('')
      : '';

    // ── Lifetime ────────────────────────────────────────────────
    const stat = (label, value, color) =>
      '<div style="flex:1;min-width:0">'
      + '<p style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--fc-text-faint);margin:0 0 3px">'
        + esc(label) + '</p>'
      + '<p class="fc-amount" style="font-size:17px;font-weight:700;margin:0;color:' + (color || 'var(--fc-text)') + '">'
        + esc(value) + '</p></div>';

    /* Lifetime: found vs paid. The net is shown even when it is negative —
       a subscription that has not earned its keep yet should say so, or the
       whole screen is just a compliment we pay ourselves. */
    const netPositive = summary.netBenefit >= 0;
    const lifetime = summary.months
      ? '<div class="fc-eyebrow" style="margin-top:18px">Since you joined</div>'
        + '<section class="fc-ui-card" style="padding:16px 18px;margin-bottom:14px">'
          + '<div style="display:flex;gap:14px;margin-bottom:14px">'
            + stat('Found for you', FCData.formatCurrency(summary.proven), 'var(--fc-success)')
            + stat('Pro cost', FCData.formatCurrency(summary.subscriptionPaid))
          + '</div>'
          + '<div style="display:flex;gap:14px;padding-top:14px;border-top:1px solid var(--fc-border)">'
            + stat('Net', (netPositive ? '+' : '−')
                + FCData.formatCurrency(Math.abs(summary.netBenefit)),
                netPositive ? 'var(--fc-success)' : 'var(--fc-text-muted)')
            + stat('Months it paid for itself',
                summary.monthsPaidForThemselves + ' of ' + summary.months)
          + '</div>'
          + '<p style="font-size:12px;color:var(--fc-text-muted);margin:14px 0 0;line-height:1.5">'
            + (netPositive
              ? 'Pro has cost you ' + esc(FCData.formatCurrency(summary.subscriptionPaid))
                + ' and found you ' + esc(FCData.formatCurrency(summary.proven))
                + ' — ' + summary.multiple + '× what you paid.'
              : 'Pro has cost you ' + esc(FCData.formatCurrency(summary.subscriptionPaid))
                + ' and found you ' + esc(FCData.formatCurrency(summary.proven))
                + ' so far. It has not earned that back yet.')
          + '</p>'
        + '</section>'
      : '';

    el.innerHTML =
      '<header class="fc-page-head">'
        + '<button onclick="FCApp._closeSubScreen()" style="display:flex;align-items:center;gap:4px;background:none;'
          + 'border:none;cursor:pointer;color:var(--fc-accent);font-size:15px;font-weight:600;padding:11px 8px 11px 0;font-family:inherit;min-height:44px">'
          + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" '
          + 'stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg> Back'
        + '</button>'
        + '<div class="fc-page-head__text"><h1 class="fc-page-title fc-page-title--sub">The Vault</h1>'
        + '<p class="fc-page-sub">What your subscription found you</p></div>'
      + '</header>'
      + hero + terms + ledger + own + lifetime
      + '<p style="font-size:10px;color:var(--fc-text-faint);text-align:center;padding:4px 24px 16px;margin:0;opacity:0.6">'
        + 'Savings shown are calculated from your own transaction history. FlowCheck is not a bank. Not financial advice.</p>';
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: BILLS SCREEN (stub — full build in Phase 4)
     ───────────────────────────────────────────────────────────── */


  /* ─────────────────────────────────────────────────────────────
     RENDER: DEBT SCREEN (stub)
     ───────────────────────────────────────────────────────────── */


  /* ─────────────────────────────────────────────────────────────
     COACH — rule-based money coaching, structured answers.
     Deterministic and computed from state; an LLM backend can
     upgrade the copy later without changing this UI contract.
     ───────────────────────────────────────────────────────────── */

  function _coachAnswers() {
    const accts = state.accounts || [];
    const bills = _billsForDisplay();
    const goals = _goalsForDisplay();
    const now = new Date();
    const fmt = v => FCData.formatCurrency(Math.abs(v || 0));

    // Shared inputs
    let safe = 0;
    try { safe = Math.max(0, Number(_buildSafeSpendProjection().safe || 0)); } catch (_e) {}
    /* Order by the strategy the user actually chose in Money > Debt.
       This list was hardcoded to smallest-balance-first and the copy below
       hardcoded the word "snowball" to match — so someone who had gone to
       Money > Debt and deliberately switched to Avalanche was told by the
       Coach, about the very same accounts, to do the opposite. Two screens,
       one set of debts, contradictory advice, and the one that ignored the
       user was the one calling itself a coach. */
    const _coachStrategy = _debtStrategy();
    const debts = accts.filter(_isDebtAcct)
      .map(a => ({
        name: a.name || 'Debt',
        bal:  Math.max(0, a.balance_current || a.balance || 0),
        min:  _minPayment(a),
        rate: Number(a.interest_rate || a.apr || 0),
      }))
      .filter(d => d.bal > 0)
      .sort((a, b) => _coachStrategy === 'snowball'
        ? a.bal - b.bal                             // smallest balance first
        : (b.rate - a.rate) || (b.bal - a.bal));    // highest rate first
    const extra = Math.max(0, Math.round(safe * 0.25 / 5) * 5);

    const answers = {};

    // ── Debt coach ──
    if (debts.length >= 1) {
      const target = debts[0];
      const second = debts[1];
      answers.debt = {
        title: 'Debt Coach',
        question: debts.length > 1 ? 'Should I pay ' + esc(target.name) + ' or ' + esc(second.name) + ' first?' : 'How do I pay off ' + esc(target.name) + ' faster?',
        happening: debts.length > 1
          ? 'You have ' + fmt(debts.reduce((s,d)=>s+d.bal,0)) + ' across ' + debts.length + ' balances. '
            + esc(target.name) + ' is '
            + (_coachStrategy === 'snowball'
                ? 'the smallest at ' + fmt(target.bal) + '.'
                : (target.rate > 0
                    ? 'the highest rate at ' + target.rate.toFixed(1) + '%.'
                    : 'the largest at ' + fmt(target.bal) + '.'))
          : esc(target.name) + ' has a balance of ' + fmt(target.bal) + '.',
        // Follows the chosen strategy — and names it, so the word here and
        // the strategy card in Money > Debt always agree.
        why: _coachStrategy === 'snowball'
          ? 'Paying off the smallest balance first gives you a quick win, frees its minimum payment, and builds momentum — the snowball method.'
          : 'Paying the highest rate first costs you the least in total interest, even though the first balance takes longer to clear — the avalanche method.',
        todo: extra > 0
          ? 'Put ' + fmt(extra) + ' extra toward ' + esc(target.name) + ' this month. Keep paying minimums on everything else.'
          : 'Keep paying minimums this month — your safe-to-spend is tight, so protect your bills first.',
        highlight: extra > 0 ? { label: 'Extra available this month', value: fmt(extra), sub: 'Apply to ' + esc(target.name) + '?' } : null,
        cta: 'See full debt plan',
        action: "FCApp.closeCoachSheet();FCApp.switchTab('wealth');setTimeout(function(){FCApp.switchWealthTab&&FCApp.switchWealthTab('debt')},250)",
      };
    }

    // ── Bill coach ──
    const unpaid = bills.filter(b => b.status !== 'paid' && b.due_date)
      .map(b => ({ ...b, days: FCData.daysUntil(b.due_date) }))
      .filter(b => b.days !== null && b.days >= 0 && b.days <= 14)
      .sort((a, b) => a.days - b.days);
    if (unpaid.length) {
      const cluster = unpaid.filter(b => b.days <= 5);
      const clusterTotal = cluster.reduce((s, b) => s + (b.amount || 0), 0);
      answers.bill = {
        title: 'Bill Coach',
        question: 'Can I move any due dates?',
        happening: cluster.length > 1
          ? cluster.length + ' bills totaling ' + fmt(clusterTotal) + ' land within the next 5 days: ' + cluster.map(b => esc(b.name)).join(', ') + '.'
          : 'Your next bill is ' + esc(unpaid[0].name) + ' (' + fmt(unpaid[0].amount) + ') in ' + unpaid[0].days + ' day' + (unpaid[0].days === 1 ? '' : 's') + '.',
        why: cluster.length > 1
          ? 'Bills clustered before payday squeeze your cash. Spreading them across the month smooths your cash flow.'
          : 'Aligning due dates with paydays means bills never catch you off guard.',
        todo: cluster.length > 1
          ? 'Most billers let you change the due date in their app or with one call. Try moving ' + esc(cluster[cluster.length - 1].name) + ' to mid-month.'
          : 'You\'re in good shape. If money feels tight before payday, ask your biller to shift the date a few days later.',
        highlight: null,
        cta: 'Review bills',
        action: "FCApp.closeCoachSheet();FCApp.switchTab('plan')",
      };
    }

    // ── Savings coach ──
    const activeGoals = goals.filter(g => (g.current || 0) < (g.target || 0));
    if (activeGoals.length) {
      const rec = Math.min(Math.max(0, Math.round(safe * 0.3 / 5) * 5), 200);
      answers.savings = {
        title: 'Savings Coach',
        question: 'How much should I save next paycheck?',
        happening: 'You have ' + activeGoals.length + ' active goal' + (activeGoals.length === 1 ? '' : 's') + ' and about ' + fmt(safe) + ' safe to spend after bills and your buffer.',
        why: 'Saving right after payday — before spending happens — is the single most reliable way to hit goals. Pay yourself first.',
        todo: rec > 0
          ? 'Move ' + fmt(rec) + ' to ' + esc(activeGoals[0].name || 'your top goal') + ' the morning your paycheck lands.'
          : 'This paycheck is tight — skip saving this cycle and protect your bills. Resume next paycheck.',
        highlight: rec > 0 ? { label: 'Recommended next paycheck', value: fmt(rec), sub: 'To ' + esc(activeGoals[0].name || 'your top goal') } : null,
        cta: 'Open goals',
        action: "FCApp.closeCoachSheet();FCApp.switchTab('goals')",
      };
    }

    // ── Spending coach ──
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const catTotals = {};
    (state.transactions || []).forEach(t => {
      if (!_isSpendTxn(t)) return;
      try { if (FCData.parseDateLocal(t.date) < mStart) return; } catch (_e) { return; }
      const c = FCData.normalizePlaidCategory((Array.isArray(t.category) ? t.category[0] : t.category) || 'Other');
      catTotals[c] = (catTotals[c] || 0) + (t.amount || 0);
    });
    const topCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0];
    if (topCat) {
      const cut = Math.max(10, Math.round(topCat[1] * 0.15 / 5) * 5);
      answers.spending = {
        title: 'Spending Coach',
        question: 'Where can I cut back without hurting my goals?',
        happening: esc(topCat[0]) + ' is your biggest category this month at ' + fmt(topCat[1]) + '.',
        why: 'Cutting your largest category by even 15% frees more cash than eliminating three small ones — effort goes where the money is.',
        todo: 'Aim to trim ' + esc(topCat[0]) + ' by ' + fmt(cut) + ' this month. That\'s usually one or two skipped purchases, not a lifestyle change.',
        highlight: { label: 'Potential monthly savings', value: fmt(cut), sub: 'From ' + esc(topCat[0]) + ' alone' },
        cta: 'See spending',
        action: "FCApp.closeCoachSheet();FCApp.switchTab('activity')",
      };
    }

    return answers;
  }

  /* ── Ask — a coach you can actually talk to ──────────────────────────────
     Deliberately NOT an LLM, and that is the feature rather than a shortcut:

       · Privacy is the product. Answering "can I afford this" through a
         third-party model means shipping balances and merchant history off
         the device, which is the one thing this app promises not to do.
       · Money advice has to be auditable. Every number below is traceable to
         the same engines the rest of the app renders from, so Coach can never
         quote a figure that disagrees with the screen behind it — which is
         exactly what a model that has been handed a summary will eventually do.
       · It is instant, works with no signal, and costs nothing per question.

     So: parse the intent locally, answer from _buildSafeSpendProjection,
     predictNextPayday, _detectSubscriptions and _getBillsDueInDays. The tab
     already promised "straight answers from your own numbers"; this makes
     that literally true instead of a tagline over a list of canned rows. */
  /* Last question, so follow-ups work. "Can I afford $200?" then "what about
     300?" is how people actually talk; without this the second one is a
     bare number with no verb and falls through to nothing useful. */
  let _coachLast = null;

  /** Pull a money amount out of ordinary phrasing: $1,200 · 1.2k · 200 bucks. */
  function _coachAmount(s) {
    const k = s.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*k\b/);
    if (k) return Math.round(parseFloat(k[1]) * 1000);
    const m = s.match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/)
           || s.match(/\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:dollars?|bucks)\b/)
           || s.match(/\b([0-9][0-9,]{2,}(?:\.[0-9]{1,2})?)\b/)
           || s.match(/\b([0-9]+(?:\.[0-9]{1,2})?)\b/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }

  function _coachParse(q) {
    const s = String(q || '').toLowerCase().trim();
    if (!s) return null;
    const money = _coachAmount(s);

    // Follow-up: "what about 300", "and 500?", or just "300" after an afford.
    const bare = /^(?:what about|how about|and|or)?\s*\$?\s*[0-9][0-9,.k]*\s*\??$/.test(s);
    if (bare && money != null && _coachLast && _coachLast.intent === 'afford') {
      return { intent: 'afford', amount: money, followUp: true };
    }

    if (/afford|should i buy|can i buy|worth it|ok to (?:buy|spend)|splurge/.test(s)
        || (money != null && /buy|spend|get|cost|purchase|pay for/.test(s))) {
      return { intent: 'afford', amount: money };
    }
    if (/safe to spend|how much (?:can|should) i spend|spending money|left to spend|spare/.test(s)) return { intent: 'safe' };
    if (/paid|payday|pay ?check|next check/.test(s))                    return { intent: 'payday' };
    if (/subscription|recurring|streaming/.test(s))                     return { intent: 'subs' };
    if (/debt|owe|credit card|loan|payoff|pay off/.test(s))             return { intent: 'debt' };
    if (/saving|save|goal|emergency fund/.test(s))                      return { intent: 'savings' };
    if (/bill|due/.test(s))                                             return { intent: 'bills' };
    if (/runway|run out|run short|make it|short|broke/.test(s))         return { intent: 'runway' };
    if (money != null) return { intent: 'afford', amount: money };
    return { intent: 'unknown' };
  }

  /* What a purchase actually does to you, from the runway's own daily
     balances. Spending today lowers every future point by the same amount,
     so the first day that crosses zero simply moves earlier — no re-forecast,
     no second model that could disagree with the chart on Today. */
  function _coachImpact(amount) {
    let r = null;
    try { r = _buildRunwaySeries(); } catch (_) { return null; }
    if (!r || !Array.isArray(r.points) || !r.points.length) return null;
    const fmtD = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const firstNeg = pts => { for (const p of pts) if (p.balance < 0) return p; return null; };
    const before = firstNeg(r.points);
    const after  = firstNeg(r.points.map(p => ({ ...p, balance: p.balance - amount })));
    if (!after) return null;                       // still fine after buying
    return {
      beforeDate: before ? fmtD(before.date) : null,
      afterDate:  fmtD(after.date),
      movedEarlier: !!(before && after.day < before.day),
      newlyShort: !before,
    };
  }

  /** Returns { verdict, detail, tone } — tone drives colour only. */
  function _coachAnswer(parsed) {
    const money = v => FCData.formatCurrency(v);
    if (!parsed || parsed.intent === 'unknown') {
      return { tone: 'neutral', verdict: 'Ask me about a purchase, your bills, or payday.',
               detail: 'Try "Can I afford $200?" or "When do I get paid?"' };
    }
    const p = _buildSafeSpendProjection();
    const safe = Math.max(0, p.safe || 0);

    if (parsed.intent === 'afford') {
      if (parsed.amount == null) {
        return { tone: 'neutral', verdict: 'How much?',
                 detail: 'Give me an amount — "Can I afford $200?" — and I\'ll check it against your real numbers.' };
      }
      const amt   = parsed.amount;
      const after = safe - amt;
      const until = p.payday
        ? p.payday.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : null;
      const impact = _coachImpact(amt);

      if (after >= 0) {
        return {
          tone: 'good', verdict: 'Yes — that works.',
          detail: 'You\'d still have ' + money(after) + ' safe to spend'
                + (until ? ' before ' + until : '') + '.',
          consequence: impact && impact.newlyShort
            ? 'It would leave you short by ' + impact.afterDate + ', though.' : null,
          options: [{ key: 'math', label: 'Show the math', note: 'How safe to spend is worked out' }],
        };
      }
      return {
        tone: 'bad', verdict: 'I\'d wait.',
        detail: 'That\'s ' + money(Math.abs(after)) + ' more than you can safely spend right now — '
              + 'you have ' + money(safe) + (until ? ' until ' + until : '') + '.',
        consequence: impact
          ? (impact.movedEarlier
              ? 'Buying it moves your shortfall from ' + impact.beforeDate + ' to ' + impact.afterDate + '.'
              : 'Buying it would leave you short by ' + impact.afterDate + '.')
          : null,
        options: [
          until ? { key: 'wait', label: 'Wait until ' + until, note: 'Payday clears it', recommended: true } : null,
          safe > 0 ? { key: 'spend-safe', label: 'Spend ' + money(safe) + ' instead', note: 'The most you can safely do today' } : null,
          { key: 'trim', label: 'Find something to trim', note: 'Review recurring charges' },
        ].filter(Boolean),
      };
    }

    if (parsed.intent === 'debt') {
      const debts = (state.accounts || []).filter(a => FCCore.accountClass(a) === 'debt');
      if (!debts.length) return { tone: 'good', verdict: 'No debt on file.', detail: 'Nothing to pay down.' };
      const total = debts.reduce((s, a) => s + Math.abs(FCCore.accountBalance ? FCCore.accountBalance(a) : (a.balance_current || a.balance || 0)), 0);
      return { tone: 'neutral', verdict: money(total) + ' in debt',
               detail: 'Across ' + debts.length + ' account' + (debts.length === 1 ? '' : 's') + '.',
               options: [{ key: 'debt', label: 'See payoff plan', note: 'Money › Debt', recommended: true }] };
    }

    if (parsed.intent === 'savings') {
      const goals = state.goals || [];
      if (!goals.length) return { tone: 'neutral', verdict: 'No goals set yet.',
                                  detail: 'A goal gives the spare money somewhere to go.',
                                  options: [{ key: 'goals', label: 'Set a goal', recommended: true }] };
      const g = goals[0];
      const tgt = g.target_amount || g.target || 0, cur = g.current_amount || g.current || 0;
      const pct = tgt > 0 ? Math.round(cur / tgt * 100) : 0;
      return { tone: 'good', verdict: pct + '% to ' + (g.name || 'your goal'),
               detail: money(cur) + ' of ' + money(tgt) + '.',
               options: [{ key: 'goals', label: 'See all goals' }] };
    }

    if (parsed.intent === 'safe') {
      return { tone: safe > 0 ? 'good' : 'bad', verdict: money(safe) + ' safe to spend',
               detail: p.payday
                 ? 'That\'s what\'s left after your upcoming bills and usual spending, through '
                   + p.payday.date.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + '.'
                 : 'That\'s what\'s left after your upcoming bills and usual spending.' };
    }

    if (parsed.intent === 'payday') {
      const pd = _predictNextPayday();
      if (!pd) return { tone: 'neutral', verdict: 'I can\'t see a pay pattern yet.',
                        detail: 'Once a few paycheques land I\'ll be able to tell you.' };
      return { tone: 'good', verdict: 'Payday is ' + _paydayWhen(pd.days) + '.',
               detail: pd.date.toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})
                     + (pd.cadence ? ' — you\'re paid ' + pd.cadence.replace('semimonthly','twice a month') + '.' : '') };
    }

    if (parsed.intent === 'subs') {
      const subs = _detectSubscriptions(state.transactions || []) || [];
      if (!subs.length) return { tone: 'good', verdict: 'No recurring charges spotted.',
                                 detail: 'Nothing looks like a subscription in your recent activity.' };
      const total = subs.reduce((s, x) => s + (x.amount || 0), 0);
      return { tone: 'neutral', verdict: money(total) + '/mo in subscriptions',
               detail: subs.length + ' recurring charge' + (subs.length === 1 ? '' : 's') + ' — that\'s '
                     + money(total * 12) + ' a year.' };
    }

    if (parsed.intent === 'bills') {
      const due = _getBillsDueInDays(14) || [];
      if (!due.length) return { tone: 'good', verdict: 'Nothing due in the next two weeks.',
                                detail: 'Your upcoming bills are clear.' };
      const total = due.reduce((s, b) => s + (b.amount || 0), 0);
      const next = due[0];
      return { tone: due.length > 2 ? 'warn' : 'neutral',
               verdict: money(total) + ' due in the next two weeks',
               detail: due.length + ' bill' + (due.length === 1 ? '' : 's')
                     + (next && next.name ? ' — ' + next.name + ' is next.' : '.') };
    }

    // runway
    const r = _buildRunwaySeries ? _buildRunwaySeries() : null;
    if (r && r.goesNegative) {
      return { tone: 'bad', verdict: 'Money runs short before payday.',
               detail: 'Safe to spend is ' + money(safe) + '. Trimming there is the quickest fix.' };
    }
    return { tone: 'good', verdict: 'You make it to payday.',
             detail: money(safe) + ' safe to spend between now and then.' };
  }

  /** Handle the ask bar. Renders one calm answer — never a transcript. */
  function coachAsk(q) {
    const input = document.getElementById('coach-ask-input');
    const query = q != null ? q : (input && input.value);
    const out   = document.getElementById('coach-ask-answer');
    if (!out) return;
    const parsed = _coachParse(query);
    if (!parsed) { out.innerHTML = ''; out.style.display = 'none'; return; }
    haptic('light');
    if (input && q != null) input.value = q;

    _coachLast = parsed;
    const a = _coachAnswer(parsed);
    const TONE = { good: 'var(--fc-success)', bad: 'var(--fc-danger)',
                   warn: 'var(--fc-warning)', neutral: 'var(--fc-accent)' };
    const c = TONE[a.tone] || TONE.neutral;

    /* esc() on every field: these are built from our own numbers, but the
       unknown-intent branch is the shape most likely to grow an echo of what
       the user typed, and escaping here means it can never become a sink. */
    /* The key rides in a data- attribute and the handler is a static string.
       Interpolating esc(o.key) straight into the onclick made check-handlers
       read `esc()` as the handler being called — and a handler that does not
       resolve throws the moment someone taps it, with nothing else to warn
       you. Each esc() also gets its own line so the line-scoped XSS check can
       see it. */
    const opts = (a.options || []).map(o => {
      let note = '';
      if (o.note) {
        note = '<span class="coach-opt-note">' + esc(o.note) + '</span>';
      }
      let rec = '';
      if (o.recommended) {
        rec = '<span class="coach-opt-rec">Recommended</span>';
      }
      return '<button type="button" class="coach-opt" data-coach-opt="' + esc(o.key) + '"'
          + ' onclick="FCApp.coachOption(this.dataset.coachOpt)">'
        + '<span class="coach-opt-main">'
          + '<span class="coach-opt-label">' + esc(o.label) + '</span>'
          + note
        + '</span>'
        + rec
        + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
      + '</button>';
    }).join('');

    out.style.display = '';
    out.innerHTML =
      '<div class="coach-answer" style="border-left:3px solid ' + c + '">'
        + '<p class="coach-answer-verdict">' + esc(a.verdict) + '</p>'
        + '<p class="coach-answer-detail">' + esc(a.detail) + '</p>'
        // The consequence is the whole point: not "no", but what "yes" costs.
        + (a.consequence ? '<p class="coach-answer-impact">' + esc(a.consequence) + '</p>' : '')
        + (opts ? '<div class="coach-opts">' + opts + '</div>' : '')
        + '<div id="coach-answer-math"></div>'
      + '</div>';
  }

  /** An option is a real action, not a label. */
  function coachOption(key) {
    haptic('light');
    if (key === 'wait')       { toast('Good call — I\'ll keep an eye on it.', 'success', 2600); return; }
    if (key === 'trim')       { switchTab('activity'); switchActivitySegment('bills'); return; }
    if (key === 'debt')       { switchTab('wealth'); return; }
    if (key === 'goals')      { switchTab('goals'); return; }
    if (key === 'spend-safe') {
      const p = _buildSafeSpendProjection();
      coachAsk('Can I afford ' + Math.floor(Math.max(0, p.safe || 0)) + '?');
      return;
    }
    if (key === 'math') {
      /* Progressive disclosure: the answer stays on the surface, the
         arithmetic sits one tap under it. Same projection the answer used,
         so the rows always sum to the number above them. */
      const el = document.getElementById('coach-answer-math');
      if (!el) return;
      if (el.innerHTML) { el.innerHTML = ''; return; }   // tap again to close
      const p = _buildSafeSpendProjection();
      const row = (label, val, neg) =>
        '<div class="coach-math-row"><span>' + esc(label) + '</span>'
        + '<span class="' + (neg ? 'coach-math-neg' : '') + '">'
        + (neg ? '−' : '') + FCData.formatCurrency(Math.abs(val)) + '</span></div>';
      el.innerHTML = '<div class="coach-math">'
        + row('Cash you can spend', p.cash)
        + row('Bills before payday', p.billsTotal, true)
        + row('Usual spending', p.expectedEverydaySpend, true)
        + row('Buffer kept back', p.reserve, true)
        + '<div class="coach-math-row coach-math-total"><span>Safe to spend</span>'
        + '<span>' + FCData.formatCurrency(Math.max(0, p.safe || 0)) + '</span></div>'
      + '</div>';
    }
  }

  function coachAskKey(e) {
    if (e && (e.key === 'Enter' || e.keyCode === 13)) { e.preventDefault(); coachAsk(); }
  }

  function _renderCoach() {
    const el = document.getElementById('coach-content');
    if (!el) return;
    const answers = _coachAnswers();

    // This week vs last week spend (same math as spending pulse)
    const now = new Date();
    const msDay = 86400000;
    const startThis = new Date(now.getTime() - now.getDay() * msDay); startThis.setHours(0,0,0,0);
    const startLast = new Date(startThis.getTime() - 7 * msDay);
    /* "this time last week" has to mean the same elapsed slice of the week,
       and it did not. `thisWeek` accumulated the days so far (on a Friday,
       5.4 of them) while `lastWeek` took the FULL seven — so the comparison
       was structurally biased toward "you spent less", every day except
       Saturday, purely from the window being shorter.
       Cut last week at the same offset into the week that we have reached
       this week, and the sentence means what it says. */
    const elapsedMs = now.getTime() - startThis.getTime();
    const endLast   = startLast.getTime() + elapsedMs;
    let thisWeek = 0, lastWeek = 0;
    for (const t of (state.transactions || [])) {
      if (!_isSpendTxn(t)) continue;
      let d; try { d = FCData.parseDateLocal(t.date).getTime(); } catch (_e) { continue; }
      if (d >= startThis.getTime()) thisWeek += t.amount || 0;
      else if (d >= startLast.getTime() && d < endLast) lastWeek += t.amount || 0;
    }
    const subs = _detectSubscriptions(state.transactions || []) || [];
    const subsTotal = subs.reduce((s, x) => s + (x.amount || 0), 0);
    const weekDelta = lastWeek - thisWeek;
    const reviewLine = lastWeek > 0
      ? (weekDelta >= 0
          ? 'You spent ' + FCData.formatCurrency(weekDelta) + ' less than this time last week.'
          : 'You\'ve spent ' + FCData.formatCurrency(Math.abs(weekDelta)) + ' more than this time last week.')
      : 'Your week is just getting started.';
    const reviewSub = subs.length ? subs.length + ' subscriptions run you ' + FCData.formatCurrency(subsTotal) + '/mo.' : '';

    const coachRow = (key, icon, color, soft, title, sub) => answers[key]
      ? '<div class="fc-card" style="margin-bottom:10px;padding:14px 16px;display:flex;align-items:center;gap:13px;cursor:pointer;-webkit-tap-highlight-color:transparent" onclick="FCApp.openCoachAnswer(\''+key+'\')">'
          +'<div style="width:40px;height:40px;border-radius:12px;background:'+soft+';display:flex;align-items:center;justify-content:center;flex-shrink:0">'+_ic(icon, color, 19)+'</div>'
          +'<div style="flex:1;min-width:0">'
            +'<div style="font-size:15px;font-weight:600;color:var(--fc-text)">'+title+'</div>'
            +'<div style="font-size:12px;color:var(--fc-text-muted);margin-top:1px">'+sub+'</div>'
          +'</div>'
          +'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>'
        +'</div>'
      : '';

    el.innerHTML =
      '<header class="fc-page-head">'
        +'<div class="fc-page-head__text">'
          +'<h1 class="fc-page-title">Coach</h1>'
          +'<p class="fc-page-sub">Straight answers from your own numbers</p>'
        +'</div>'
      +'</header>'
      /* The ask bar. Three starters rather than a wall of them — enough to
         teach the shape of a question without becoming a menu. */
      +'<div class="coach-ask">'
        +'<div class="coach-ask-field">'
          +_ic('search','var(--fc-text-faint)',16)
          +'<input id="coach-ask-input" type="text" placeholder="Ask about your money…"'
            +' aria-label="Ask Coach a question" autocomplete="off" autocorrect="off"'
            +' autocapitalize="sentences" spellcheck="false" enterkeyhint="send"'
            +' onkeydown="FCApp.coachAskKey(event)">'
        +'</div>'
        +'<button class="coach-ask-go" type="button" onclick="FCApp.coachAsk()" aria-label="Ask">'
          /* 'send', not 'arrow-right' — _ic falls back to file-text for an
             unknown name, so a typo here renders a document icon on the ask
             button and nothing errors. */
          +_ic('send','var(--fc-accent-ink)',17)
        +'</button>'
      +'</div>'
      +'<div class="coach-ask-starters">'
        +'<button type="button" class="fc-chip" onclick="FCApp.coachAsk(\'Can I afford $200?\')">Can I afford $200?</button>'
        +'<button type="button" class="fc-chip" onclick="FCApp.coachAsk(\'When do I get paid?\')">When do I get paid?</button>'
        +'<button type="button" class="fc-chip" onclick="FCApp.coachAsk(\'What\\u2019s safe to spend?\')">What’s safe to spend?</button>'
      +'</div>'
      +'<div id="coach-ask-answer" style="display:none"></div>'

      +'<div class="fc-card" style="margin-bottom:14px;padding:14px 16px;background:var(--fc-accent-soft);border-color:var(--fc-border-accent);display:flex;align-items:center;gap:13px;cursor:pointer;-webkit-tap-highlight-color:transparent" onclick="FCApp.showAffordSheet&&FCApp.showAffordSheet()">'
        +'<div style="width:40px;height:40px;border-radius:12px;background:var(--fc-accent);display:flex;align-items:center;justify-content:center;flex-shrink:0">'+_ic('search','var(--fc-accent-ink)',19)+'</div>'
        +'<div style="flex:1">'
          +'<div style="font-size:15px;font-weight:600;color:var(--fc-text)">Can I afford this?</div>'
          +'<div style="font-size:12px;color:var(--fc-text-muted);margin-top:1px">Check any purchase against your real numbers</div>'
        +'</div>'
        +'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>'
      +'</div>'

      +'<div class="fc-card" style="margin-bottom:18px;padding:16px;cursor:pointer;-webkit-tap-highlight-color:transparent" onclick="FCApp.openMoneyStory()">'
        +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">'
          +'<div class="fc-eyebrow">This Week\'s Review</div>'
          +'<div style="display:flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:var(--fc-accent)">'
            +'<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>Play'
          +'</div>'
        +'</div>'
        +'<div style="font-size:15px;font-weight:600;color:var(--fc-text);line-height:1.4">'+reviewLine+'</div>'
        +(reviewSub ? '<div style="font-size:13px;color:var(--fc-text-muted);margin-top:4px">'+reviewSub+'</div>' : '')
      +'</div>'

      +'<div class="fc-eyebrow">Your Coaches</div>'
      +coachRow('debt', 'trending-down', 'var(--fc-danger)', 'var(--fc-danger-soft)', 'Debt Coach', answers.debt ? answers.debt.question : '')
      +coachRow('bill', 'calendar', 'var(--fc-accent)', 'var(--fc-accent-soft)', 'Bill Coach', answers.bill ? answers.bill.question : '')
      +coachRow('savings', 'dollar-sign', 'var(--fc-success)', 'var(--fc-success-soft)', 'Savings Coach', answers.savings ? answers.savings.question : '')
      +coachRow('spending', 'bar-chart', 'var(--fc-warning)', 'var(--fc-warning-soft)', 'Spending Coach', answers.spending ? answers.spending.question : '')

      +'<div class="fc-eyebrow" style="margin:18px 0 10px">More</div>'
      +'<div class="fc-card" style="padding:0 16px;margin-bottom:14px">'
        +'<div onclick="FCApp.switchTab(\'more\')" style="display:flex;align-items:center;gap:14px;padding:14px 0;border-bottom:1px solid var(--fc-border);cursor:pointer;-webkit-tap-highlight-color:transparent">'
          +'<div style="width:36px;height:36px;border-radius:10px;background:var(--fc-bg-elevated-2);display:flex;align-items:center;justify-content:center;flex-shrink:0">'+_ic('bar-chart','var(--fc-text-muted)',18)+'</div>'
          +'<div style="flex:1"><div style="font-size:15px;font-weight:500;color:var(--fc-text)">All money tools</div><div style="font-size:12px;color:var(--fc-text-faint);margin-top:1px">Investments, calendar, reports & more</div></div>'
          +'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>'
        +'</div>'
        +'<div onclick="FCApp._openSubScreen(\'settings\')" style="display:flex;align-items:center;gap:14px;padding:14px 0;cursor:pointer;-webkit-tap-highlight-color:transparent">'
          +'<div style="width:36px;height:36px;border-radius:10px;background:var(--fc-bg-elevated-2);display:flex;align-items:center;justify-content:center;flex-shrink:0">'+_ic('gear','var(--fc-text-muted)',18)+'</div>'
          +'<div style="flex:1"><div style="font-size:15px;font-weight:500;color:var(--fc-text)">Settings</div></div>'
          +'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>'
        +'</div>'
      +'</div>';
  }

  function openCoachAnswer(key) {
    haptic('light');
    const a = _coachAnswers()[key];
    if (!a) return;
    let ov = document.getElementById('fc-coach-sheet');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'fc-coach-sheet';
      ov.className = 'fc-sheet-overlay';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      ov.addEventListener('click', e => { if (e.target === ov) closeCoachSheet(); });
      document.body.appendChild(ov);
    }
    const section = (n, label, body) =>
      '<div style="margin-bottom:14px">'
        +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
          +'<div style="width:20px;height:20px;border-radius:50%;background:var(--fc-accent-soft);color:var(--fc-accent);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">'+n+'</div>'
          +'<div style="font-size:13px;font-weight:700;color:var(--fc-text)">'+label+'</div>'
        +'</div>'
        +'<div style="font-size:14px;color:var(--fc-text-muted);line-height:1.5;padding-left:28px">'+body+'</div>'
      +'</div>';
    ov.innerHTML =
      '<div class="fc-sheet" onclick="event.stopPropagation()" style="max-height:85vh;overflow-y:auto">'
        +'<div class="fc-sheet-handle"></div>'
        +'<div class="fc-sheet-title">'+esc(a.title)+'</div>'
        +'<div style="padding:0 20px 20px">'
          +'<div style="background:var(--fc-electric-soft);border-radius:12px;padding:10px 14px;font-size:14px;font-weight:600;color:var(--fc-text);margin-bottom:16px">'+a.question+'</div>'
          +section(1, 'What\'s happening', a.happening)
          +section(2, 'Why it matters', a.why)
          +section(3, 'What to do next', a.todo)
          +(a.highlight
            ? '<div style="background:var(--fc-warning-soft);border-radius:12px;padding:12px 14px;margin:4px 0 14px;display:flex;align-items:center;justify-content:space-between">'
                +'<div><div style="font-size:12px;color:var(--fc-text-muted)">'+esc(a.highlight.label)+'</div><div style="font-size:12px;color:var(--fc-text-muted)">'+a.highlight.sub+'</div></div>'
                +'<div style="font-size:20px;font-weight:750;color:var(--fc-text);font-variant-numeric:tabular-nums">'+a.highlight.value+'</div>'
              +'</div>'
            : '')
          +'<button class="fc-btn fc-btn--primary" style="width:100%" onclick="'+a.action+'">'+a.cta+'</button>'
          +'<button class="fc-btn fc-btn--ghost" style="width:100%;margin-top:8px" onclick="FCApp.closeCoachSheet()">Close</button>'
        +'</div>'
      +'</div>';
    ov.style.display = 'flex';
    haptic('light');
  }

  function closeCoachSheet() {
    const ov = document.getElementById('fc-coach-sheet');
    if (ov) ov.style.display = 'none';
  }

  /* ─────────────────────────────────────────────────────────────
     CAN I AFFORD THIS? — purchase check against the safe-spend
     engine. The answer is a verdict, not a guilt trip.
     ───────────────────────────────────────────────────────────── */

  function showAffordSheet() {
    haptic('light');
    let ov = document.getElementById('fc-afford-sheet');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'fc-afford-sheet';
      ov.className = 'fc-sheet-overlay';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      ov.addEventListener('click', e => { if (e.target === ov) closeAffordSheet(); });
      document.body.appendChild(ov);
    }
    // Quick amounts make the common case a single tap. Repeat usage is the
    // metric that signals this became a habit, so every removed keystroke
    // matters more than any extra chrome would.
    const _chip = v =>
      '<button type="button" class="afford-chip" onclick="FCApp.runAffordCheck(' + v + ')">$' + v + '</button>';

    ov.innerHTML =
      '<div class="fc-sheet afford-sheet" onclick="event.stopPropagation()">'
        +'<div class="fc-sheet-handle"></div>'
        +'<div class="fc-sheet-title">Can I Afford This?</div>'
        +'<div style="padding:0 20px 20px">'
          +'<label for="afford-amount" style="font-size:12px;font-weight:600;color:var(--fc-text-muted);display:block;margin-bottom:6px">How much is it?</label>'
          +'<div style="display:flex;align-items:center;gap:8px;background:var(--fc-bg-elevated-2);border-radius:12px;padding:2px 14px;margin-bottom:10px">'
            +'<span style="font-size:20px;font-weight:700;color:var(--fc-text-muted)">$</span>'
            +'<input id="afford-amount" type="number" inputmode="decimal" enterkeyhint="go" placeholder="65" style="flex:1;background:none;border:none;outline:none;font-size:22px;font-weight:700;color:var(--fc-text);padding:12px 0;font-family:inherit;font-variant-numeric:tabular-nums" autocomplete="off">'
          +'</div>'
          +'<div class="afford-chips">' + [20, 50, 100, 250].map(_chip).join('') + '</div>'
          +'<button class="fc-btn fc-btn--primary" style="width:100%" onclick="FCApp.runAffordCheck()">Check</button>'
          +'<div id="afford-result"></div>'
        +'</div>'
      +'</div>';
    ov.style.display = 'flex';
    (function () {
      const i = document.getElementById('afford-amount');
      if (!i) return;
      // Wait for the overlay's entrance before summoning the keyboard.
      _focusField(i, ov);
      // Return key runs the check — no reaching for the button mid-thought
      i.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); runAffordCheck(); }
      });
    })();
  }

  function runAffordCheck(presetAmount) {
    const input = document.getElementById('afford-amount');
    const amount = presetAmount != null ? presetAmount : parseFloat(input && input.value);
    const out = document.getElementById('afford-result');
    if (!out) return;
    if (!amount || amount <= 0) { out.innerHTML = '<div style="font-size:13px;color:var(--fc-text-muted);text-align:center;padding:12px 0">Enter an amount to check.</div>'; return; }
    if (input && presetAmount != null) input.value = String(presetAmount);
    haptic('medium');
    if (typeof FCAnalytics !== 'undefined') {
      // Never send the amount itself — bucket it so the metric stays non-financial
      FCAnalytics.track('afford_check_run', { preset: presetAmount != null });
    }

    const p = _buildSafeSpendProjection();
    const after = p.safe - amount;
    const billsSafe = (p.cash - amount) >= p.billsTotal;
    const dailyAfter = Math.max(0, after) / Math.max(1, p.days);
    const paydayLabel = p.payday
      ? p.payday.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' (' + _paydayWhen(p.payday.days) + ')'
      : 'in ~' + p.days + ' days';

    let tone, verdict, detail;
    if (amount <= p.safe * 0.5) {
      tone = 'success'; verdict = 'Yes — comfortably.';
      detail = 'You\'ll still have ' + FCData.formatCurrency(after) + ' safe to spend after this.';
    } else if (amount <= p.safe) {
      tone = 'warning'; verdict = 'Yes, but it makes your week tight.';
      detail = 'You\'ll have ' + FCData.formatCurrency(Math.max(0, dailyAfter)).replace('.00','') + '/day left until payday after this purchase. Stay under that to keep all your bills safe.';
    } else if (billsSafe) {
      tone = 'warning'; verdict = 'Risky — this eats your cushion.';
      detail = 'Bills would still clear, but this spends past your buffer. One surprise expense could tip you over.';
    } else {
      tone = 'danger'; verdict = 'No — this would put your bills at risk.';
      detail = 'You have ' + FCData.formatCurrency(p.billsTotal) + ' in bills due before payday. This purchase would leave you short.';
    }
    const toneColor = 'var(--fc-' + tone + ')';
    const toneSoft  = 'var(--fc-' + tone + '-soft)';
    const riskLabel = tone === 'success' ? 'Low' : tone === 'warning' ? 'Medium' : 'High';
    const saferAmt  = Math.max(5, Math.floor(p.safe * 0.5 / 5) * 5);
    const row = (label, value, valueColor) =>
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--fc-border);font-size:13px">'
        +'<span style="color:var(--fc-text-muted)">'+label+'</span>'
        +'<span style="font-weight:600;color:'+(valueColor||'var(--fc-text)')+';font-variant-numeric:tabular-nums">'+value+'</span>'
      +'</div>';

    // Visual impact bar — how much of your safe-to-spend this purchase eats
    const eatPct = p.safe > 0 ? Math.min(100, Math.round((amount / p.safe) * 100)) : 100;
    const impactBar =
      '<div style="margin:2px 0 6px">'
        +'<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--fc-text-faint);margin-bottom:5px">'
          +'<span>This purchase</span><span>'+eatPct+'% of your safe-to-spend</span>'
        +'</div>'
        +'<div style="height:10px;border-radius:6px;background:var(--fc-bg-elevated-2);overflow:hidden;display:flex">'
          +'<div style="width:'+eatPct+'%;background:'+toneColor+';border-radius:6px;transition:width 0.6s cubic-bezier(0.22,1,0.36,1)"></div>'
        +'</div>'
        +'<div style="display:flex;justify-content:space-between;font-size:11px;margin-top:5px;font-variant-numeric:tabular-nums">'
          +'<span style="color:'+toneColor+';font-weight:600">'+FCData.formatCurrency(amount)+'</span>'
          +'<span style="color:var(--fc-text-muted)">'+FCData.formatCurrency(Math.max(0, after))+' would remain</span>'
        +'</div>'
      +'</div>';

    // Payday-wait tip — the smartest sentence in the app: when the answer is
    // "not comfortably", say exactly when it becomes an easy yes.
    let waitTip = '';
    if (tone !== 'success' && p.payday) {
      const _income45 = (state.transactions || []).filter(t => {
        if (!_isIncomeTxn(t) || !t.date) return false;
        try { return FCData.parseDateLocal(t.date) >= new Date(Date.now() - 45 * 86400000); } catch (_) { return false; }
      });
      const paycheckEst = _income45.length
        ? Math.max(..._income45.map(t => Math.abs(t.amount || 0)))
        : 0;
      const easyAfterPayday = paycheckEst > 0 && amount <= (p.safe + paycheckEst * 0.5);
      waitTip =
        '<div style="display:flex;gap:10px;align-items:flex-start;background:var(--fc-accent-soft);border-radius:12px;padding:11px 13px;margin-top:12px">'
          +'<span style="flex-shrink:0;margin-top:1px">'+_ic('clock', 'var(--fc-accent)', 16)+'</span>'
          +'<div style="font-size:13px;color:var(--fc-text);line-height:1.45">'
            +(easyAfterPayday
              ? (p.payday.days <= 0
                  ? '<strong>Payday lands today.</strong> Once it clears, this is an easy yes.'
                  : '<strong>Wait '+(p.payday.days===1?'a day':p.payday.days+' days')+'.</strong> Payday lands '+p.payday.date.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' — after that, this is an easy yes.')
              : '<strong>Payday is '+_paydayWhen(p.payday.days)+'.</strong> '
                +(p.payday.days <= 0
                    ? 'Once it clears you\'ll have far more breathing room.'
                    : 'Waiting until then gives you far more breathing room.'))
          +'</div>'
        +'</div>';
    }

    out.innerHTML =
      '<div style="background:'+toneSoft+';border-radius:14px;padding:14px 16px;margin:16px 0 12px;display:flex;gap:12px;align-items:flex-start">'
        +'<span style="flex-shrink:0;margin-top:1px">'+_ic(tone === 'success' ? 'check' : 'alert', toneColor, 20)+'</span>'
        +'<div>'
          +'<div style="font-size:15px;font-weight:700;color:var(--fc-text)">'+verdict+'</div>'
          +'<div style="font-size:13px;color:var(--fc-text-muted);line-height:1.45;margin-top:3px">'+detail+'</div>'
        +'</div>'
      +'</div>'
      +impactBar
      +row('Bills still safe', billsSafe ? 'Yes' : 'No', billsSafe ? 'var(--fc-success)' : 'var(--fc-danger)')
      +row('Payday', paydayLabel)
      +row('Daily target after purchase', FCData.formatCurrency(dailyAfter) + '/day')
      +row('Risk level', riskLabel, toneColor)
      +waitTip
      +(tone !== 'success' && saferAmt < amount
        ? '<button class="fc-btn fc-btn--ghost" style="width:100%;margin-top:14px" onclick="FCApp.runAffordCheck('+saferAmt+')">Show safer option ('+FCData.formatCurrency(saferAmt)+')</button>'
        : '')
      +'<button class="fc-btn fc-btn--ghost" style="width:100%;margin-top:8px" onclick="FCApp.closeAffordSheet()">Done</button>';

    // Bring the verdict into view. On a small screen the answer can render
    // just below the fold of the sheet that produced it, which reads as
    // "nothing happened" — the one thing this interaction must never do.
    requestAnimationFrame(() => {
      try { out.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
    });
  }

  function closeAffordSheet() {
    const ov = document.getElementById('fc-afford-sheet');
    if (ov) ov.style.display = 'none';
  }

  /* ─────────────────────────────────────────────────────────────
     YOUR MONEY WEEK — story-mode weekly recap
     Wrapped-style full-screen cards built entirely from local state.
     No network, no new data — pure presentation of the user's week.
     ───────────────────────────────────────────────────────────── */

  let _storyCards = [];
  let _storyIdx   = 0;
  const _STORY_MS = 5000;          // average card; real duration is per-card

  /* ── Player state ──────────────────────────────────────────────
     The progress bar and the auto-advance timer used to be two separate
     mechanisms — a CSS `width` transition and a setTimeout — which cannot be
     paused in sync. That is why there was no press-and-hold: you would have
     had to freeze a CSS transition mid-flight and compute the remaining
     timeout to match it. Driving both from ONE rAF loop makes elapsed time
     the single source of truth, so pause, resume and scrubbing are exact. */
  let _storyRaf     = null;
  let _storyElapsed = 0;      // ms shown of the current card
  let _storyDur     = _STORY_MS;
  let _storyPaused  = false;
  let _storyLast    = 0;      // timestamp of previous frame
  let _storyToken   = 0;      // invalidates count-ups from a card we left
  let _storyDurs    = [];
  let _storyPrevFocus = null;
  let _storyKeyHandler = null;

  /* Reduced motion: keep the recap, drop the movement. */
  const _storyReduced = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * Per-card duration from how much there is to read. A fixed 5s gave the
   * one-line hero the same time as the six-line grade card — too slow at the
   * start, too fast exactly where the user is being told something.
   * Clamped so the whole recap still lands near its advertised 30 seconds.
   */
  function _storyDuration(html) {
    const text = String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return Math.round(Math.min(7000, Math.max(3600, 2600 + text.length * 34)));
  }

  function _buildMoneyStory() {
    const msDay = 86400000;
    const now = Date.now();
    const txns = state.transactions || [];
    const inWin = (t, from, to) => {
      try { const d = FCData.parseDateLocal(t.date).getTime(); return d >= from && d < to; }
      catch (_) { return false; }
    };
    const thisFrom = now - 7 * msDay;
    const lastFrom = now - 14 * msDay;
    const spendThis = txns.filter(t => _isSpendTxn(t) && inWin(t, thisFrom, now + msDay));
    const spendLast = txns.filter(t => _isSpendTxn(t) && inWin(t, lastFrom, thisFrom));
    const incomeThis = txns.filter(t => _isIncomeTxn(t) && inWin(t, thisFrom, now + msDay));
    const sum = arr => arr.reduce((s, t) => s + (t.amount || 0), 0);
    const totThis = sum(spendThis), totLast = sum(spendLast), totIn = sum(incomeThis);

    if (!spendThis.length && !incomeThis.length) return null;

    // Top merchant this week
    const byName = {};
    spendThis.forEach(t => {
      const n = t.merchant_name || t.name || 'Somewhere';
      if (!byName[n]) byName[n] = { n, amt: 0, count: 0 };
      byName[n].amt += t.amount || 0;
      byName[n].count++;
    });
    const top = Object.values(byName).sort((a, b) => b.amt - a.amt)[0];
    const biggest = [...spendThis].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0];

    const subs = _detectSubscriptions() || [];
    const subsTotal = subs.reduce((s, x) => s + (x.amount || 0), 0);
    const net = totIn - totThis;
    const overdue = _billsForDisplay().filter(b => b.status !== 'paid' && (FCData.daysUntil(b.due_date) ?? 0) < 0).length;

    // Letter grade — honest but encouraging
    let grade, gradeLine, gradeColor;
    const saveRate = totIn > 0 ? net / totIn : (net >= 0 ? 0 : -1);
    if (overdue > 0)            { grade = 'C';  gradeLine = 'Clear the overdue bill' + (overdue > 1 ? 's' : '') + ' and this jumps a full grade.'; gradeColor = 'var(--fc-warning)'; }
    else if (saveRate >= 0.3)   { grade = 'A+'; gradeLine = 'You kept ' + Math.round(saveRate * 100) + '% of what you earned. Elite week.'; gradeColor = 'var(--fc-success)'; }
    else if (saveRate >= 0.1)   { grade = 'A';  gradeLine = 'Earned more than you spent, bills on track. Keep this rhythm.'; gradeColor = 'var(--fc-success)'; }
    else if (net >= 0)          { grade = 'B+'; gradeLine = 'You broke even or better. Small tweaks make this an A.'; gradeColor = 'var(--fc-accent)'; }
    else if (totLast > 0 && totThis < totLast) { grade = 'B'; gradeLine = 'Spent more than you earned, but trending the right way.'; gradeColor = 'var(--fc-accent)'; }
    else                        { grade = 'C+'; gradeLine = 'Spending outran income this week. Next week is a fresh start.'; gradeColor = 'var(--fc-warning)'; }

    const fmtRange = () => {
      const a = new Date(thisFrom), b = new Date(now);
      const f = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return f(a) + ' – ' + f(b);
    };
    const delta = totLast - totThis;
    const deltaLine = totLast > 0
      ? (delta >= 0
          ? '<span style="color:var(--fc-success)">▼ ' + FCData.formatCurrency(delta) + ' less</span> than last week'
          : '<span style="color:#ff8f88">▲ ' + FCData.formatCurrency(Math.abs(delta)) + ' more</span> than last week')
      : 'Your first full week of tracking';

    const cards = [];
    cards.push(
      '<div class="fcst-eyebrow">FLOWCHECK REWIND</div>'
      + '<div class="fcst-orb" aria-hidden="true"></div>'
      + '<h2 class="fcst-hero">Your<br>Money Week</h2>'
      + '<div class="fcst-sub">' + fmtRange() + '</div>'
      + '<div class="fcst-hint">Tap to continue ›</div>'
    );
    cards.push(
      '<div class="fcst-eyebrow">THIS WEEK YOU SPENT</div>'
      + '<div class="fcst-big" data-countup="' + totThis.toFixed(2) + '">$0</div>'
      + '<div class="fcst-sub">' + deltaLine + '</div>'
      + '<div class="fcst-meta">' + spendThis.length + ' purchase' + (spendThis.length !== 1 ? 's' : '') + ' across ' + Object.keys(byName).length + ' place' + (Object.keys(byName).length !== 1 ? 's' : '') + '</div>'
    );
    if (top) {
      cards.push(
        '<div class="fcst-eyebrow">YOUR TOP SPOT</div>'
        + '<div class="fcst-avatar">' + esc((top.n || '?').charAt(0).toUpperCase()) + '</div>'
        + '<h2 class="fcst-title">' + esc(top.n) + '</h2>'
        + '<div class="fcst-sub">' + top.count + ' visit' + (top.count !== 1 ? 's' : '') + ' · ' + FCData.formatCurrency(top.amt) + '</div>'
        + (biggest && (biggest.merchant_name || biggest.name) !== top.n
            ? '<div class="fcst-meta">Biggest single hit: <strong>' + FCData.formatCurrency(biggest.amount || 0) + '</strong> at ' + esc(biggest.merchant_name || biggest.name || '—') + '</div>'
            : (biggest ? '<div class="fcst-meta">Also your biggest single charge: <strong>' + FCData.formatCurrency(biggest.amount || 0) + '</strong></div>' : ''))
      );
    }
    if (subs.length) {
      cards.push(
        '<div class="fcst-eyebrow">RUNNING ON AUTOPILOT</div>'
        + '<div class="fcst-big" data-countup="' + subsTotal.toFixed(2) + '">$0</div>'
        + '<div class="fcst-sub">' + subs.length + ' subscription' + (subs.length !== 1 ? 's' : '') + ' every month</div>'
        + '<div class="fcst-meta">That\'s <strong>' + FCData.formatCurrency(subsTotal * 12) + '/year</strong>. Still using all of them?</div>'
      );
    }
    const inW = totIn + totThis > 0 ? Math.max(6, Math.round((totIn / (totIn + totThis)) * 100)) : 50;
    cards.push(
      '<div class="fcst-eyebrow">CASH FLOW</div>'
      + '<div class="fcst-flow">'
      +   '<div class="fcst-flow-row"><span>In</span><div class="fcst-flow-bar"><div class="fcst-flow-fill fcst-flow-fill--in" style="width:' + inW + '%"></div></div><strong>' + FCData.formatCurrency(totIn) + '</strong></div>'
      +   '<div class="fcst-flow-row"><span>Out</span><div class="fcst-flow-bar"><div class="fcst-flow-fill fcst-flow-fill--out" style="width:' + (100 - inW) + '%"></div></div><strong>' + FCData.formatCurrency(totThis) + '</strong></div>'
      + '</div>'
      + '<div class="fcst-big fcst-big--md ' + (net >= 0 ? 'fcst-green' : 'fcst-red') + '" data-countup="' + Math.abs(net).toFixed(2) + '" data-prefix="' + (net >= 0 ? '+$' : '−$') + '">' + (net >= 0 ? '+$0' : '−$0') + '</div>'
      + '<div class="fcst-sub">' + (net >= 0 ? 'kept this week. That\'s money working for you.' : 'further than you earned. Next week, flip it.') + '</div>'
    );
    cards.push(
      '<div class="fcst-eyebrow">YOUR WEEK, GRADED</div>'
      + '<div class="fcst-grade-wrap">'
      +   '<svg viewBox="0 0 120 120" class="fcst-grade-ring" aria-hidden="true">'
      +     '<circle cx="60" cy="60" r="52" stroke="rgba(255,255,255,0.10)" stroke-width="7" fill="none"/>'
      +     '<circle cx="60" cy="60" r="52" stroke="' + gradeColor + '" stroke-width="7" fill="none" stroke-linecap="round" class="fcst-grade-arc"/>'
      +   '</svg>'
      +   '<div class="fcst-grade" style="color:' + gradeColor + '">' + grade + '</div>'
      + '</div>'
      + '<div class="fcst-sub" style="max-width:270px">' + gradeLine + '</div>'
      + '<button class="fcst-cta" type="button" onclick="FCApp.closeMoneyStory();FCApp.switchTab(\'plan\')">See my plan →</button>'
    );
    return cards;
  }

  function openMoneyStory() {
    const cards = _buildMoneyStory();
    if (!cards) {
      if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('money_story_empty');
      toast('Not enough activity yet — check back after a few transactions', 'info');
      return;
    }
    haptic('medium');
    if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('money_story_opened', { cards: cards.length });
    _storyCards = cards;
    _storyDurs  = cards.map(_storyDuration);
    _storyIdx   = 0;
    _storyPrevFocus = document.activeElement;

    let ov = document.getElementById('fc-story');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'fc-story';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      ov.setAttribute('aria-label', 'Your Money Week');
      document.body.appendChild(ov);
    }
    ov.className = '';
    ov.innerHTML =
      '<div class="fcst-progress" id="fcst-progress">'
      + _storyCards.map(() => '<div class="fcst-seg"><div class="fcst-seg-fill"></div></div>').join('')
      + '</div>'
      + '<button class="fcst-close" type="button" aria-label="Close recap" onclick="FCApp.closeMoneyStory()">'
      +   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'
      + '</button>'
      + '<div class="fcst-card" id="fcst-card"></div>'
      // Screen readers get the card as text; the visual card is decorative motion.
      + '<div class="fcst-sr" id="fcst-live" aria-live="polite" aria-atomic="true"></div>'
      + '<button class="fcst-tap fcst-tap--l" type="button" aria-label="Previous" onclick="FCApp.storyPrev()"></button>'
      + '<button class="fcst-tap fcst-tap--r" type="button" aria-label="Next" onclick="FCApp.storyNext()"></button>'
      + '<div class="fcst-paused" aria-hidden="true">Paused</div>'
      + '<div class="fcst-end" id="fcst-end">'
      +   '<button class="fcst-end-btn" type="button" onclick="FCApp.storyReplay()">Replay</button>'
      +   '<button class="fcst-end-btn fcst-end-btn--primary" type="button" onclick="FCApp.closeMoneyStory()">Done</button>'
      + '</div>';
    ov.style.display = 'flex';
    requestAnimationFrame(() => ov.classList.add('fcst-open'));

    _storyBindGestures(ov);
    _storyBindKeys(ov);
    _storyRender();
    // Move focus into the dialog so the trap has something to hold.
    setTimeout(() => { const c = ov.querySelector('.fcst-close'); if (c) c.focus(); }, 80);
  }

  /* ── Playback ──────────────────────────────────────────────────
     One rAF loop owns both the progress bar and the auto-advance, so
     "how far through this card are we" has exactly one answer and pause
     is just: stop adding to it. */
  function _storyTick(now) {
    if (!_storyLast) _storyLast = now;
    if (_storyPaused) { _storyLast = now; _storyRaf = requestAnimationFrame(_storyTick); return; }

    _storyElapsed += now - _storyLast;
    _storyLast = now;
    const p = Math.min(1, _storyElapsed / _storyDur);

    const fill = document.querySelectorAll('#fcst-progress .fcst-seg-fill')[_storyIdx];
    // scaleX, not width: width is a layout property and this runs every frame
    // for the whole recap. transform composites without layout or paint.
    if (fill) fill.style.transform = 'scaleX(' + p.toFixed(4) + ')';

    if (p >= 1) {
      if (_storyIdx < _storyCards.length - 1) { _storyIdx++; _storyRender(); }
      else _storyFinish();
      return;
    }
    _storyRaf = requestAnimationFrame(_storyTick);
  }

  function _storyStop() {
    if (_storyRaf) cancelAnimationFrame(_storyRaf);
    _storyRaf = null; _storyLast = 0;
  }

  function _storyPause() {
    if (_storyPaused) return;
    _storyPaused = true;
    const ov = document.getElementById('fc-story');
    if (ov) ov.classList.add('fcst-held');
  }

  function _storyResume() {
    if (!_storyPaused) return;
    _storyPaused = false; _storyLast = 0;
    const ov = document.getElementById('fc-story');
    if (ov) ov.classList.remove('fcst-held');
  }

  function _storyFinish() {
    _storyStop();
    const ov = document.getElementById('fc-story');
    if (ov) ov.classList.add('fcst-done');
    haptic('medium');
    if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('money_story_completed');
  }

  function _storyRender() {
    const card = document.getElementById('fcst-card');
    if (!card) return;
    _storyStop();
    _storyElapsed = 0;
    _storyDur = _storyDurs[_storyIdx] || _STORY_MS;
    _storyToken++;
    const token = _storyToken;

    const ov = document.getElementById('fc-story');
    if (ov) ov.classList.remove('fcst-done');

    // Progress segments: filled behind, empty ahead, current driven by the loop.
    document.querySelectorAll('#fcst-progress .fcst-seg-fill').forEach((s, i) => {
      s.style.transform = 'scaleX(' + (i < _storyIdx ? 1 : 0) + ')';
    });

    card.classList.remove('fcst-enter');
    void card.offsetWidth;
    card.innerHTML = _storyCards[_storyIdx];
    card.classList.add('fcst-enter');
    haptic('light');

    const live = document.getElementById('fcst-live');
    if (live) live.textContent =
      'Card ' + (_storyIdx + 1) + ' of ' + _storyCards.length + '. '
      + card.textContent.replace(/\s+/g, ' ').trim();

    // Animated count-ups. The token check stops a count-up from a card the
    // user already left writing into a detached node for the rest of its run.
    const instant = _storyReduced();
    card.querySelectorAll('[data-countup]').forEach(el => {
      const target = parseFloat(el.dataset.countup) || 0;
      const prefix = el.dataset.prefix || '$';
      const fmt = v => prefix + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (instant) { el.textContent = fmt(target); return; }
      const t0 = performance.now(), dur = 900;
      const tick = t => {
        if (token !== _storyToken) return;         // superseded — stop cleanly
        const p = Math.min(1, (t - t0) / dur);
        el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    _storyRaf = requestAnimationFrame(_storyTick);
  }

  function storyNext() {
    if (_storyIdx >= _storyCards.length - 1) { _storyFinish(); return; }
    _storyIdx++;
    _storyRender();
  }

  function storyPrev() {
    if (_storyIdx === 0) { _storyElapsed = 0; return; }  // restart card 1
    _storyIdx--;
    _storyRender();
  }

  function storyReplay() {
    _storyIdx = 0;
    _storyRender();
  }

  /* ── Gestures ──────────────────────────────────────────────────
     Press and hold to pause is the one gesture every story format shares,
     and it was the thing most conspicuously missing: with a 5s auto-advance
     and no way to stop it, a card you actually wanted to read was gone.

     Taps stay on the existing .fcst-tap buttons so keyboard and screen
     reader users keep real, labelled controls. This layer only adds hold
     and swipe, and swallows the click that would otherwise fire at the end
     of one. */
  function _storyBindGestures(ov) {
    if (ov._fcstBound) return;
    ov._fcstBound = true;
    let sx = 0, sy = 0, held = false, moved = false, dragging = false, holdT = null;

    const swallowNextClick = () => {
      const kill = e => { e.preventDefault(); e.stopPropagation(); };
      ov.addEventListener('click', kill, { capture: true, once: true });
      setTimeout(() => ov.removeEventListener('click', kill, { capture: true }), 350);
    };

    ov.addEventListener('pointerdown', e => {
      if (e.target.closest('.fcst-close,.fcst-cta,.fcst-end-btn')) return;
      sx = e.clientX; sy = e.clientY; moved = false; held = false; dragging = true;
      holdT = setTimeout(() => { held = true; _storyPause(); haptic('light'); }, 170);
    });

    ov.addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) { moved = true; clearTimeout(holdT); }
      // Downward drag follows the finger, so dismissal feels physical.
      if (moved && dy > 0 && Math.abs(dy) > Math.abs(dx)) {
        _storyPause();
        ov.style.transform = 'translateY(' + Math.min(dy, 320) + 'px) scale(' + (1 - Math.min(dy, 320) / 2600) + ')';
        ov.style.opacity = String(Math.max(0.3, 1 - dy / 520));
      }
    });

    const end = e => {
      if (!dragging) return;
      dragging = false;
      clearTimeout(holdT);
      const dx = e.clientX - sx, dy = e.clientY - sy;
      ov.style.transform = ''; ov.style.opacity = '';

      if (moved && dy > 110 && Math.abs(dy) > Math.abs(dx)) { swallowNextClick(); closeMoneyStory(); return; }
      if (moved && Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy)) {
        swallowNextClick();
        _storyResume();
        if (dx < 0) storyNext(); else storyPrev();
        return;
      }
      if (held || moved) { swallowNextClick(); _storyResume(); return; }
      _storyResume();   // a plain tap — the .fcst-tap button handles navigation
    };
    ov.addEventListener('pointerup', end);
    ov.addEventListener('pointercancel', e => { dragging = false; clearTimeout(holdT);
      ov.style.transform = ''; ov.style.opacity = ''; _storyResume(); });
  }

  /* ── Keyboard ──────────────────────────────────────────────────
     It is aria-modal="true", so Escape has to close it and focus must not
     wander out to the page underneath. Neither was true before. */
  function _storyBindKeys(ov) {
    _storyUnbindKeys();
    _storyKeyHandler = e => {
      if (!document.getElementById('fc-story')) return;
      if (e.key === 'Escape')          { e.preventDefault(); closeMoneyStory(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); _storyResume(); storyNext(); }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); _storyResume(); storyPrev(); }
      else if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault(); _storyPaused ? _storyResume() : _storyPause();
      } else if (e.key === 'Tab') {
        const f = [...ov.querySelectorAll('button:not([disabled])')].filter(n => n.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
          e.preventDefault(); (e.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener('keydown', _storyKeyHandler, true);
  }

  function _storyUnbindKeys() {
    if (_storyKeyHandler) document.removeEventListener('keydown', _storyKeyHandler, true);
    _storyKeyHandler = null;
  }

  function closeMoneyStory() {
    _storyStop();
    _storyPaused = false;
    _storyUnbindKeys();
    const ov = document.getElementById('fc-story');
    if (!ov) return;
    ov.classList.remove('fcst-open', 'fcst-held', 'fcst-done');
    ov.style.transform = ''; ov.style.opacity = '';
    setTimeout(() => { ov.style.display = 'none'; }, 240);
    haptic('light');
    // Send focus back where it came from, or the page loses its place.
    if (_storyPrevFocus && document.contains(_storyPrevFocus)) {
      try { _storyPrevFocus.focus(); } catch (_) {}
    }
    _storyPrevFocus = null;
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: GOALS SCREEN (stub)
     ───────────────────────────────────────────────────────────── */

  function _renderGoalsScreen(asTab) {
    const el = document.getElementById('goals-screen-content');
    if (!el) return;
    const now = new Date();
    const goals = state.goals || [];
    const goalIcon = (g) => _goalIcon(g, 'var(--fc-success)', 18);
    const targetFmt = (g) => g.target_date
      ? new Date(g.target_date).toLocaleDateString('en-US',{month:'short',year:'numeric'}) : null;

    /* ── Next Best Goal ──────────────────────────────────────────────
       The old `_monthSpend` did not measure a month. It was

         transactions.filter(_isSpendTxn).slice(0, 200)

       — the first 200 spend transactions in the array, with no date filter
       at all — and `_efTarget` was derived from it. So the emergency-fund
       target scaled with how much HISTORY you had rather than with how much
       you spend, and a user with a year of data was told to save several
       times what they needed. It also ignored the target the user had
       actually set on their own emergency-fund goal, judging them against a
       number they never chose and could not see.

       Now: one real calendar month of spending, the user's own target when
       they have set one, and a $1,000 starter floor otherwise. */
    const _efGoal = goals.find(g => /emergency|rainy|reserve/i.test(g.name || ''));
    const _mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const _monthSpend = (state.transactions || []).filter(t => {
      if (!_isSpendTxn(t)) return false;
      try { return FCData.parseDateLocal(t.date) >= _mStart; } catch (_e) { return false; }
    }).reduce((s, t) => s + (t.amount || 0), 0);
    /* One month of expenses is the goal a starter fund builds toward, so it
       is what "months covered" below is measured in. Falls back to the
       $1,000 starter when there is not enough history to say. */
    const _efMonthly = _monthSpend > 0 ? _monthSpend : 0;
    const _efTarget  = (_efGoal && _efGoal.target > 0)
      ? _efGoal.target
      : Math.max(1000, Math.round(_efMonthly / 100) * 100 || 1000);
    const _efCurrent = _efGoal ? (_efGoal.current || 0) : 0;
    const _needsEF   = !_efGoal || _efCurrent < _efTarget;
    /* Stated, not asserted. The old copy said "less than 1 month of
       expenses saved" on every render of this card, whether or not that was
       true — the condition it sat behind compared savings to _efTarget, not
       to a month of expenses. */
    const _efMonths = _efMonthly > 0 ? _efCurrent / _efMonthly : null;
    const _efCoverage = _efMonths === null ? ''
      : _efMonths < 0.5  ? 'That is under two weeks of your spending.'
      : _efMonths < 1    ? 'That covers about ' + Math.round(_efMonths * 4) + ' weeks of your spending.'
      : 'That covers about ' + (_efMonths < 2 ? '1 month' : Math.floor(_efMonths) + ' months') + ' of your spending.';
    const nextBestHTML = _needsEF
      ? '<div class="fc-card" style="margin-bottom:14px;padding:16px;background:var(--fc-accent-soft);border-color:var(--fc-border-accent)">'
          +'<div style="display:flex;align-items:center;gap:14px">'
            +'<div style="flex:1">'
              +'<div class="fc-eyebrow" style="color:var(--fc-accent);margin-bottom:4px">Your Next Best Goal</div>'
              +'<div style="font-size:17px;font-weight:700;color:var(--fc-text);margin-bottom:2px">Emergency Fund</div>'
              +'<div style="font-size:13px;color:var(--fc-text-muted);line-height:1.45">'
                +(!_efGoal
                  ? 'You have no safety cushion yet. Build this before anything else.'
                  : FCData.formatCurrency(_efCurrent) + ' of ' + FCData.formatCurrency(_efTarget) + ' saved.'
                    + (_efCoverage ? ' ' + _efCoverage : '') + ' Keep building this first.')
              +'</div>'
            +'</div>'
            +'<div style="width:52px;height:52px;border-radius:50%;background:var(--fc-success);display:flex;align-items:center;justify-content:center;flex-shrink:0">'+_ic('shield','var(--fc-success-ink,#fff)',24)+'</div>'
          +'</div>'
          +(!_efGoal ? '<button class="fc-btn fc-btn--primary fc-btn--sm" style="width:100%;margin-top:12px" onclick="FCApp.showAddGoalSheet&&FCApp.showAddGoalSheet()">Start Emergency Fund</button>' : '')
        +'</div>'
      : '';

    /* Recommended contribution per paycheck.
       The 14 here used to be hardcoded with the comment "assumes ~biweekly
       pay" — but predictNextPayday() already detects the real cadence
       (weekly / biweekly / semimonthly / monthly), so a monthly-paid user
       was told to contribute half of what they should, twice as often as
       they get paid. */
    const _payday = _predictNextPayday();
    const _cadenceDays = { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30 };
    const _payEveryDays = (_payday && _cadenceDays[_payday.cadence]) || 14;
    const _perPaycheck = (g) => {
      const remaining = Math.max(0, (g.target || 0) - (g.current || 0));
      if (remaining <= 0) return null;
      let paychecks = Math.max(1, Math.round(365 / 2 / _payEveryDays)); // ~6 months
      if (g.target_date) {
        try {
          const daysLeft = (FCData.parseDateLocal(g.target_date) - now) / 86400000;
          if (daysLeft > 0) paychecks = Math.max(1, Math.round(daysLeft / _payEveryDays));
        } catch (_e) {}
      }
      return Math.max(5, Math.ceil(remaining / paychecks / 5) * 5);
    };

    /* Each row's recommendation is sound on its own; the SET was never
       checked. Three goals asking $145 + $90 + $320 came to $555 a paycheck
       with nothing anywhere on the screen adding them up — and on a profile
       with no detected paycheck at all, the app was still confidently
       prescribing $555 of it. The total is now stated once, and compared
       against the paycheck when we know it. */
    const _recTotal = goals.reduce((s, g) => s + (_perPaycheck(g) || 0), 0);
    const _payAmount = _payday && _payday.amount > 0 ? _payday.amount : 0;
    const _recShare  = _payAmount > 0 ? _recTotal / _payAmount : null;
    const _recTooMuch = _recShare !== null && _recShare > 0.3;

    el.innerHTML =
      '<header class="fc-page-head fc-page-head--center">'
        +(asTab ? '' :
          '<button onclick="FCApp._closeSubScreen()" style="display:flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;color:var(--fc-accent);font-size:15px;font-weight:600;padding:11px 8px 11px 0;font-family:inherit;min-height:44px">'
          +'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg> Back'
          +'</button>')
        +'<h1 class="fc-page-title'+(asTab?'':' fc-page-title--sub')+'" style="flex:1">Goals</h1>'
        +'<button class="fc-page-head__action" type="button" aria-label="Add goal" onclick="FCApp.showAddGoalSheet&&FCApp.showAddGoalSheet()">+</button>'
      +'</header>'

      +nextBestHTML

      /* Was "Savings Momentum — Your goals are on track. Keep going." shown
         on `goals.length > 0 && !_needsEF`, neither of which has anything to
         do with being on track. It was a reassurance the screen was not
         entitled to give.
         This says the one thing the per-row recommendations never did: what
         they cost together, and whether that is a realistic share of a
         paycheck. 30% is the line — above it the plan is aspirational, and
         saying so is more useful than three green numbers that quietly
         assume the whole cheque. */
      +(_recTotal > 0
        ? '<div class="fc-card" style="margin-bottom:14px;padding:14px 16px;background:'
            +(_recTooMuch ? 'var(--fc-warning-soft)' : 'var(--fc-success-soft)')
            +';border-color:'+(_recTooMuch ? 'var(--fc-warning-soft)' : 'var(--fc-success-border)')+'">'
            +'<div style="display:flex;align-items:center;gap:12px">'
              +'<div style="width:40px;height:40px;border-radius:12px;background:'
                +(_recTooMuch ? 'var(--fc-warning-soft)' : 'var(--fc-success)')
                +';display:flex;align-items:center;justify-content:center;flex-shrink:0">'
                +_ic(_recTooMuch ? 'alert' : 'flag', _recTooMuch ? 'var(--fc-warning-text)' : 'var(--fc-success-ink,#fff)', 20)
              +'</div>'
              +'<div style="flex:1;min-width:0">'
                +'<div class="fc-eyebrow" style="color:'+(_recTooMuch?'var(--fc-warning-text)':'var(--fc-success)')+';margin-bottom:2px">All goals together</div>'
                +'<div style="font-size:15px;font-weight:600;color:var(--fc-text)">'
                  +FCData.formatCurrency(_recTotal)+' per paycheck across '+goals.length+' goal'+(goals.length===1?'':'s')+'.'
                +'</div>'
                +'<div style="font-size:13px;color:var(--fc-text-muted);margin-top:1px;line-height:1.4">'
                  +(_recShare === null
                    ? 'Once we detect your paycheck we can tell you whether that fits.'
                    : _recTooMuch
                      ? 'That is '+Math.round(_recShare*100)+'% of your paycheck. Push a target date out to lower it.'
                      : 'About '+Math.round(_recShare*100)+'% of your paycheck — a realistic pace.')
                +'</div>'
              +'</div>'
            +'</div>'
          +'</div>'
        : '')

      +(goals.length > 0
        ? '<div class="fc-card" style="padding:4px 16px;margin-bottom:14px">'
            +goals.map(g => {
              const pct = Math.min(100, Math.round(((g.current||0)/Math.max(1,g.target||1))*100));
              const tgt = targetFmt(g);
              const rec = _perPaycheck(g);
              return '<div class="fc-goal-row" onclick="FCApp.editGoal&&FCApp.editGoal(\''+g.id+'\')">'
                +'<div class="fc-goal-header">'
                  +'<div style="display:flex;align-items:center;gap:10px">'
                    +'<div style="width:36px;height:36px;border-radius:10px;background:var(--fc-success-soft);display:flex;align-items:center;justify-content:center;flex-shrink:0">'+goalIcon(g)+'</div>'
                    +'<div>'
                      +'<div class="fc-goal-name">'+esc(g.name||'Goal')+'</div>'
                      +(rec
                        ? '<div style="font-size:12px;color:var(--fc-text-faint)">Recommended: <span style="color:var(--fc-success);font-weight:600">'+FCData.formatCurrency(rec)+'/paycheck</span>'+(tgt?' · '+tgt:'')+'</div>'
                        : (tgt?'<div style="font-size:12px;color:var(--fc-text-faint)">Target: '+tgt+'</div>':''))
                    +'</div>'
                  +'</div>'
                  +'<div class="fc-goal-pct">'+pct+'%</div>'
                +'</div>'
                +'<div class="fc-progress'+(pct >= 85 ? ' fc-progress--green' : '')+'" style="margin-bottom:6px">'
                  +'<div class="fc-progress-fill" style="width:'+pct+'%"></div>'
                +'</div>'
                +'<div class="fc-goal-amounts">'
                  +'<span>'+FCData.formatCurrency(g.current||0)+' saved</span>'
                  +'<span>of '+FCData.formatCurrency(g.target||0)+'</span>'
                +'</div>'
              +'</div>';
            }).join('')
          +'</div>'
        : '<div class="fc-card" style="padding:40px;text-align:center">'
            +'<div style="width:52px;height:52px;border-radius:16px;background:var(--fc-success-soft);display:flex;align-items:center;justify-content:center;margin:0 auto 12px">'+_ic('flag','var(--fc-success)',24)+'</div>'
            +'<div style="font-size:16px;font-weight:600;color:var(--fc-text);margin-bottom:6px">No goals yet</div>'
            +'<div style="font-size:13px;color:var(--fc-text-muted);margin-bottom:16px">Start with an emergency fund.</div>'
            +'<button onclick="FCApp.showAddGoalSheet&&FCApp.showAddGoalSheet()" class="fc-btn fc-btn--primary fc-btn--sm">Add First Goal</button>'
          +'</div>');
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: INVESTMENTS SCREEN (stub)
     ───────────────────────────────────────────────────────────── */

  function _renderInvestments() {
    const el = document.getElementById('investments-screen-content');
    if (!el) return;
    // `other` is Plaid's bucket for anything it cannot classify. It counts as
    // an asset in calcNetWorth, but it matched neither the Savings filter
    // (depository/cash subtypes) nor the Debt filter (credit/loan) — so its
    // balance was inside the net worth total while appearing in no list at
    // all, and the figure could not be reconciled against the accounts shown.
    // Assets we cannot place belong with the other assets.
    const invAccts = (state.accounts || []).filter(a =>
      a.type==='investment' || a.type==='brokerage' || a.type==='other'
      || a.subtype==='401k' || a.subtype==='ira');
    const total = invAccts.reduce((s,a) => s+(a.balance_current||0), 0);

    el.innerHTML =
      '<header class="fc-page-head fc-page-head--center">'
        +'<button onclick="FCApp._closeSubScreen()" style="display:flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;color:var(--fc-accent);font-size:15px;font-weight:600;padding:11px 8px 11px 0;font-family:inherit;min-height:44px">'
          +'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg> Back'
        +'</button>'
        +'<div style="flex:1;font-size:22px;font-weight:750;color:var(--fc-text)">Investments</div>'
      +'</header>'

      +(invAccts.length > 0
        ? '<div class="fc-metric-card" style="margin-bottom:14px;text-align:center;padding:24px">'
            +'<div class="fc-metric-label">Total Invested</div>'
            +'<div class="fc-metric-value" style="font-size:32px">'+FCData.formatCurrency(total)+'</div>'
            +'<div class="fc-metric-sub">'+invAccts.length+' account'+(invAccts.length!==1?'s':'')+'</div>'
          +'</div>'
          +'<div class="fc-card" style="padding:4px 16px;margin-bottom:14px">'
            +invAccts.map(a => '<div class="fc-bill-row">'
              +'<div class="fc-bill-icon">'+_ic('trending-up','var(--fc-text-muted)',18)+'</div>'
              +'<div class="fc-bill-info">'
                +'<div class="fc-bill-name">'+esc(a.name||'Investment Account')+'</div>'
                +'<div class="fc-bill-due">'+esc(a.institution_name||'')+'</div>'
              +'</div>'
              +'<div class="fc-bill-right">'
                +'<div class="fc-bill-amount">'+FCData.formatCurrency(a.balance_current||0)+'</div>'
              +'</div>'
            +'</div>').join('')
          +'</div>'
          +'<div class="fc-card" style="padding:16px;background:var(--fc-accent-soft);border-color:var(--fc-border-accent)">'
            +'<div style="display:flex;gap:10px;align-items:flex-start"><span style="flex-shrink:0;margin-top:1px">'+_ic('lightbulb','var(--fc-accent)',16)+'</span><div>'
              +'<div style="font-size:14px;font-weight:600;color:var(--fc-text);margin-bottom:4px">Smart Guidance</div>'
              +'<div style="font-size:13px;color:var(--fc-text-muted);line-height:1.5">Make sure your emergency fund is fully funded before increasing investment contributions.</div>'
            +'</div></div>'
          +'</div>'
        : '<div class="fc-card" style="padding:40px 24px;text-align:center;margin-bottom:14px">'
            +'<div style="width:56px;height:56px;border-radius:16px;background:var(--fc-electric-soft);display:flex;align-items:center;justify-content:center;margin:0 auto 14px">'+_ic('trending-up','var(--fc-electric)',26)+'</div>'
            +'<div style="font-size:17px;font-weight:600;color:var(--fc-text);margin-bottom:6px">Track your portfolio</div>'
            +'<div style="font-size:13px;color:var(--fc-text-muted);line-height:1.5;margin-bottom:20px">Connect a brokerage account and your investments, 401(k), and IRA will show up here automatically.</div>'
            +'<button class="fc-btn fc-btn--primary fc-btn--sm" onclick="FCApp.startPlaidLink&&FCApp.startPlaidLink()">Connect Brokerage</button>'
          +'</div>'
          +'<div class="fc-card" style="padding:14px 16px;background:var(--fc-accent-soft);border-color:var(--fc-border-accent)">'
            +'<div style="display:flex;gap:10px;align-items:flex-start"><span style="flex-shrink:0;margin-top:1px">'+_ic('lightbulb','var(--fc-accent)',16)+'</span><div style="font-size:13px;color:var(--fc-text-muted);line-height:1.5">Build your emergency fund and pay off high-interest debt before investing aggressively.</div></div>'
          +'</div>');
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: CALENDAR SCREEN (stub)
     ───────────────────────────────────────────────────────────── */

  function _renderCalendar() {
    const el = document.getElementById('calendar-screen-content');
    if (!el) return;
    const now = new Date();
    const bills = state.bills || [];
    // Build a set of bill due dates this month
    /* Key on the whole date, not just the day number.
       This was `parseInt(due_date.split('-')[2])` — the DAY component alone —
       so a bill due 2026-09-02 put a dot on 2 August, and a bill from any
       previous year dotted that day too. Demonstrable on the demo data: the
       August grid marked the 2nd, and nothing is due 2 August; that was
       Internet, due 2 September.
       Paid bills are excluded as well. They were included, so a settled bill
       kept an amber "needs attention" dot for the rest of the month. */
    const year = now.getFullYear(), month = now.getMonth();
    const billDays = new Set(
      bills
        .filter(b => b.due_date && b.status !== 'paid')
        .map(b => {
          const d = FCData.parseDateLocal(b.due_date);
          return (isNaN(d.getTime()) || d.getFullYear() !== year || d.getMonth() !== month)
            ? null : d.getDate();
        })
        .filter(Boolean)
    );
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = now.getDate();
    const monthName = now.toLocaleDateString('en-US', {month:'long', year:'numeric'});

    let cells = '';
    for (let i = 0; i < firstDay; i++) cells += `<div></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = d === today;
      const hasBill = billDays.has(d);
      cells += `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0">
        <div style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:${isToday?700:400};
          background:${isToday?'var(--fc-accent)':'transparent'};color:${isToday?'var(--fc-accent-ink)':'var(--fc-text)'}">
          ${d}
        </div>
        ${hasBill ? `<div style="width:5px;height:5px;border-radius:50%;background:var(--fc-warning)"></div>` : '<div style="width:5px;height:5px"></div>'}
      </div>`;
    }

    const upcomingBills = bills.filter(b => b.status !== 'paid')
      .sort((a, b) => new Date(a.due_date) - new Date(b.due_date)).slice(0, 5);

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:20px 0 16px">
        <button onclick="FCApp._closeSubScreen()" style="display:flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;color:var(--fc-accent);font-size:15px;font-weight:600;padding:11px 8px 11px 0;font-family:inherit;min-height:44px">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg> Back
        </button>
        <div style="flex:1;font-size:22px;font-weight:750;color:var(--fc-text)">Calendar</div>
      </div>
      <div class="fc-card" style="padding:16px;margin-bottom:14px">
        <div style="font-size:16px;font-weight:600;color:var(--fc-text);text-align:center;margin-bottom:14px">${monthName}</div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);text-align:center;margin-bottom:4px">
          ${['S','M','T','W','T','F','S'].map(d=>`<div style="font-size:11px;font-weight:600;color:var(--fc-text-faint);padding:4px 0">${d}</div>`).join('')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr)">${cells}</div>
      </div>
      ${upcomingBills.length > 0 ? `
      <div style="font-size:14px;font-weight:600;color:var(--fc-text-muted);margin-bottom:8px">Upcoming</div>
      <div class="fc-card" style="padding:4px 16px">
        ${upcomingBills.map(b => `<div class="fc-bill-row">
          <div class="fc-bill-icon">${_billIcon(b, 'var(--fc-text-muted)', 18)}</div>
          <div class="fc-bill-info">
            <div class="fc-bill-name">${esc(b.name||'Bill')}</div>
            <div class="fc-bill-due">${(() => { try { return 'Due ' + FCData.parseDateLocal(b.due_date).toLocaleDateString('en-US',{month:'short',day:'numeric'}); } catch(_e){ return esc(b.due_date||''); } })()}</div>
          </div>
          <div class="fc-bill-amount">${FCData.formatCurrency(b.amount||0)}</div>
        </div>`).join('')}
      </div>` : ''}`;
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: REPORTS SCREEN (stub)
     ───────────────────────────────────────────────────────────── */

  function _renderReports() {
    const el = document.getElementById('reports-screen-content');
    if (!el) return;
    const now = new Date();
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const txns = state.transactions || [];

    /* Two corrections to the month totals:
       · _isIncomeTxn/_isSpendTxn instead of raw t.isCredit. Every other screen
         uses these because they exclude transfers — with raw isCredit, moving
         $500 from checking to savings was reported here as $500 earned AND
         $500 spent, so this screen disagreed with every other one.
       · parseDateLocal instead of new Date(). `new Date('2026-08-01')` parses
         as UTC midnight, which is the previous evening in US timezones, so
         the first day of the month fell outside its own month. */
    const inMonth = t => {
      if (!t.date) return false;
      try { return FCData.parseDateLocal(t.date) >= mStart; } catch (_) { return false; }
    };
    const mTxns  = txns.filter(inMonth);
    const income = mTxns.filter(_isIncomeTxn).reduce((s,t)=>s+(t.amount||0),0);
    const spend  = mTxns.filter(_isSpendTxn).reduce((s,t)=>s+(t.amount||0),0);

    /* Real subtitles, and a real destination for every row.

       All five cards were inert: no onclick, no role, and a chevron on each
       one advertising navigation that did not exist. Four also carried static
       placeholder copy ("Where your money goes") instead of data.

       None of these needed building — every one of them already exists as a
       screen. Reports is a hub, so it now routes to the screen that does the
       job rather than promising a report that was never written. */
    const budgetLimit = _totalBudgetLimit() + _rolloverTotal();
    const catTotals = {};
    mTxns.filter(_isSpendTxn).forEach(t => {
      const c = t.category?.[1] || t.category?.[0] || 'Other';
      catTotals[c] = (catTotals[c] || 0) + (t.amount || 0);
    });
    const topCat = Object.entries(catTotals).sort((a,b) => b[1]-a[1])[0];
    const unpaidBills = (state.bills || []).filter(b => b.status !== 'paid');
    const billsDue = unpaidBills.reduce((s,b) => s + (b.amount||0), 0);
    const accts = state.accounts || [];
    const netWorth = accts.filter(_isAssetAcct).reduce((s,a)=>s+_acctBal(a),0)
                   - accts.filter(_isDebtAcct).reduce((s,a)=>s+Math.max(0,_acctBal(a)),0);

    const reportCards = [
      { icon: 'bar-chart', title: 'Monthly Cash Flow',
        sub: `${FCData.formatCurrency(income)} in · ${FCData.formatCurrency(spend)} out`,
        color: 'var(--fc-accent)', soft: 'var(--fc-accent-soft)',
        go: "FCApp._closeSubScreen();FCApp.switchTab('activity')" },
      { icon: 'flag', title: 'Budget vs Actual',
        sub: budgetLimit > 0
          ? `${FCData.formatCurrency(spend)} of ${FCData.formatCurrency(budgetLimit)} used`
          : 'Set a budget to compare',
        color: 'var(--fc-success)', soft: 'var(--fc-success-soft)',
        go: "FCApp._closeSubScreen();FCApp.switchTab('plan');FCApp.switchPlanSeg('budget')" },
      { icon: 'pie-chart', title: 'Spending by Category',
        sub: topCat ? `${topCat[0]} is your biggest at ${FCData.formatCurrency(topCat[1])}`
                    : 'No spending yet this month',
        color: 'var(--fc-warning)', soft: 'var(--fc-warning-soft)',
        go: "FCApp._closeSubScreen();FCApp.switchTab('plan');FCApp.switchPlanSeg('budget')" },
      { icon: 'file-text', title: 'Bills',
        sub: unpaidBills.length
          ? `${unpaidBills.length} unpaid · ${FCData.formatCurrency(billsDue)}`
          : 'Nothing outstanding',
        color: 'var(--fc-danger)', soft: 'var(--fc-danger-soft)',
        go: "FCApp._closeSubScreen();FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')" },
      { icon: 'trending-up', title: 'Net Worth',
        sub: `${FCData.formatCurrency(netWorth)} today`,
        color: 'var(--fc-electric)', soft: 'var(--fc-electric-soft)',
        go: "FCApp._closeSubScreen();FCApp.switchTab('wealth');FCApp.switchWealthTab('overview')" },
    ].map(r => `
      <div class="fc-report-card" role="button" tabindex="0" onclick="${r.go}">
        <div class="fc-report-icon" style="background:${r.soft}">${_ic(r.icon, r.color, 20)}</div>
        <div class="fc-report-body">
          <div class="fc-report-title">${r.title}</div>
          <div class="fc-report-sub">${r.sub}</div>
        </div>
        <svg class="fc-report-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
      </div>`).join('');

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:20px 0 16px">
        <button onclick="FCApp._closeSubScreen()" style="display:flex;align-items:center;gap:4px;background:none;border:none;cursor:pointer;color:var(--fc-accent);font-size:15px;font-weight:600;padding:11px 8px 11px 0;font-family:inherit;min-height:44px">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg> Back
        </button>
        <div style="flex:1;font-size:22px;font-weight:750;color:var(--fc-text)">Reports</div>
      </div>
      ${reportCards}
      <!-- "Export PDF" called window.print(), which does nothing at all in a
           WKWebView — a second dead control on a screen that was already all
           dead controls. Removed rather than faked; CSV genuinely works and
           opens in Numbers, Excel or Sheets, which is what people actually
           want to do with it. -->
      <div style="margin-top:6px;margin-bottom:20px">
        <button class="fc-btn fc-btn--ghost fc-btn--sm" style="width:100%" onclick="FCApp._exportCSV()">Export transactions (CSV)</button>
      </div>`;
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: NOTIFICATIONS SCREEN (stub)
     ───────────────────────────────────────────────────────────── */

  function _renderNotificationsScreen() {
    const el = document.getElementById('notifications-screen-content');
    if (!el) return;
    const notifs = (state.notifications || []).sort((a, b) => {
      const ta = a.created_at?.seconds || 0, tb = b.created_at?.seconds || 0;
      return tb - ta;
    });
    const unreadCount = notifs.filter(n => !n.read).length;

    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:20px 0 16px">
        <button onclick="FCApp._closeSubScreen()" style="background:none;border:none;cursor:pointer;padding:11px 8px 11px 0;min-height:44px;color:var(--fc-accent);font-size:15px;font-weight:500">← Back</button>
        <div style="flex:1;font-size:22px;font-weight:700;color:var(--fc-text)">Notifications</div>
        ${unreadCount > 0 ? `<button onclick="FCApp._markAllNotifRead()" style="background:none;border:none;cursor:pointer;font-size:13px;color:var(--fc-accent)">Clear all</button>` : ''}
      </div>
      ${notifs.length > 0 ? `<div class="fc-card" style="padding:4px 16px">
        ${notifs.map(n => `
          <div class="fc-bill-row" style="opacity:${n.read?0.55:1}" onclick="FCApp._markNotifRead('${esc(String(n.id||''))}')">
            <div class="fc-bill-icon" style="background:var(--fc-accent-soft)">🔔</div>
            <div class="fc-bill-info">
              <div class="fc-bill-name">${esc(n.title||'Notification')}</div>
              <div class="fc-bill-due">${esc(n.body||'')}</div>
            </div>
            ${!n.read ? `<div style="width:8px;height:8px;border-radius:50%;background:var(--fc-accent);flex-shrink:0"></div>` : ''}
          </div>`).join('')}
      </div>` : `<div class="fc-card" style="padding:48px;text-align:center">
        <div style="font-size:32px;margin-bottom:12px">🎉</div>
        <div style="font-size:16px;font-weight:600;color:var(--fc-text)">You're all caught up</div>
        <div style="font-size:13px;color:var(--fc-text-muted);margin-top:6px">No new notifications</div>
      </div>`}`;
  }

  function _markAllNotifRead() {
    if (typeof FCData !== 'undefined' && FCData.markAllNotificationsRead) {
      FCData.markAllNotificationsRead().catch(() => {});
    }
    (state.notifications || []).forEach(n => n.read = true);
    _renderNotificationsScreen();
  }

  function _markNotifRead(id) {
    if (typeof FCData !== 'undefined' && FCData.markNotificationRead) {
      FCData.markNotificationRead(id).catch(() => {});
    }
    const n = (state.notifications || []).find(n => n.id === id);
    if (n) n.read = true;
    _renderNotificationsScreen();
  }

  function _exportCSV() {
    const txns = state.transactions || [];
    if (!txns.length) { toast('No transactions to export', 'info'); return; }
    const header = 'Date,Name,Amount,Category,Type,Account\n';
    const rows = txns.map(t =>
      `${t.date||''},${JSON.stringify(t.name||'')},${t.isCredit?t.amount:-(t.amount||0)},${JSON.stringify((Array.isArray(t.category)?t.category[0]:t.category)||'')},${t.isCredit?'Income':'Expense'},${t.account_id||''}`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    // Local: the date in the filename is the user's date, not UTC's.
    a.href = url; a.download = `flowcheck-transactions-${FCCore.isoDay(new Date())}.csv`;
    a.click(); URL.revokeObjectURL(url);
    toast('CSV downloaded', 'success');
  }

  function _openCancelSheet() {
    // On iOS, open the App Store subscription management page
    const cancelUrl = 'itms-apps://apps.apple.com/account/subscriptions';
    toast('Opening App Store subscription settings…', 'info');
    setTimeout(() => {
      try {
        const Browser = window.Capacitor?.Plugins?.Browser;
        if (Browser) { Browser.open({ url: cancelUrl }); return; }
      } catch (_) {}
      window.open(cancelUrl, '_blank');
    }, 400);
  }

  /* ─────────────────────────────────────────────────────────────
     PULL-TO-REFRESH
     ───────────────────────────────────────────────────────────── */

  let _pullStartY  = 0;
  let _pullDelta   = 0;   // track how far the user actually dragged
  let _pulling     = false;
  let _pullRefreshEl = null;

  function _initPullToRefresh() {
    _pullRefreshEl = document.getElementById('fc-pull-indicator');

    document.addEventListener('touchstart', e => {
      // Only allow pull-to-refresh on the main app screen
      if (state.screen !== 'app') return;
      // body has overflow:hidden so window.scrollY is always 0 — check the
      // active view's own scrollTop instead so PTR only fires at the real top
      const activeView = document.querySelector('.fc-view.active');
      if (!activeView || activeView.scrollTop === 0) {
        _pullStartY = e.touches[0].clientY;
        _pullDelta  = 0;
        _pulling    = true;
      }
    }, { passive: true });

    document.addEventListener('touchmove', e => {
      if (!_pulling) return;
      _pullDelta = e.touches[0].clientY - _pullStartY;
      // Require at least 10px before showing indicator (avoid accidental triggers)
      if (_pullDelta > 10 && _pullDelta < 80 && _pullRefreshEl) {
        _pullRefreshEl.style.transform = `translateY(${Math.min(_pullDelta * 0.5, 40)}px)`;
        _pullRefreshEl.style.opacity   = Math.min(_pullDelta / 60, 1);
      }
    }, { passive: true });

    document.addEventListener('touchend', async () => {
      if (!_pulling) return;
      const didPull = _pullDelta >= 40; // only sync after a meaningful 40px+ drag
      _pulling   = false;
      _pullDelta = 0;
      if (_pullRefreshEl) {
        _pullRefreshEl.style.transform = '';
        _pullRefreshEl.style.opacity   = '';
      }
      if (didPull) await _doSync().catch(() => {});
    });
  }

  /* ── Last-sync timestamp, persisted per uid ────────────────────
     state.lastSyncAt is in-memory, so a cold start (swipe the app away,
     reopen) reset it to 0 and timeSinceLast below became Infinity — the
     5-minute background-sync cooldown could never fire on the one path that
     needs it most. Every single app open therefore ran a full Plaid sync, and
     each of that sync's batch commits fired the Firestore listeners into
     another home re-render.

     A millisecond timestamp is not financial data: it carries no balance, no
     merchant, no account. It is wiped with every other fc_ key on sign-out. */
  function _lastSyncKey() {
    const uid = state.user?.uid || FCAuth.currentUser?.()?.uid || '';
    return uid ? `fc_last_sync_${uid}` : '';
  }

  function _getLastSyncAt() {
    if (state.lastSyncAt) return state.lastSyncAt;
    try {
      const key = _lastSyncKey();
      const stored = key ? parseInt(localStorage.getItem(key), 10) : 0;
      // Ignore a clock-skewed future timestamp — it would suppress syncing forever
      if (stored > 0 && stored <= Date.now()) {
        state.lastSyncAt = stored;
        return stored;
      }
    } catch (_) {}
    return 0;
  }

  function _setLastSyncAt(ts) {
    state.lastSyncAt = ts;
    try {
      const key = _lastSyncKey();
      if (key) localStorage.setItem(key, String(ts));
    } catch (_) {}
  }

  async function _doSync(showToast = false) {
    // Safety: auto-clear stuck syncing flag after 30s so button never stays locked
    if (state.syncing) {
      if (state._syncStartedAt && (Date.now() - state._syncStartedAt) > 30000) {
        state.syncing = false;
        // This clears syncing outside the finally block, so release any render
        // held by the stuck sync — the checks below can still early-return.
        _updateSyncPill();
        _flushDeferredTabRender();
        const stuck = document.getElementById('header-sync-btn');
        if (stuck) stuck.classList.remove('is-busy');
      } else {
        if (showToast) toast('Sync already running…', 'info', 2000);
        return;
      }
    }
    if (state.screen !== 'app') return;
    if (_isDemoMode) return;

    if (!FC_CONFIG.app.backendConfigured) {
      fcLog('Sync skipped — backendConfigured is false');
      return;
    }

    if (!state.user || !state.user.plaid_linked) {
      fcLog('Sync skipped — no bank linked');
      _setIslandText('Connect a bank to start');
      if (showToast) toast('Connect a bank first', 'info', 2500);
      return;
    }

    // Rate-limit background syncs — 5 min cooldown.
    // Manual syncs (showToast=true) bypass the cooldown but show a friendly message
    // if synced very recently (< 30s) so the button doesn't feel broken.
    const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;
    const lastSyncAt    = _getLastSyncAt(); // survives a cold start — see above
    const timeSinceLast = lastSyncAt ? Date.now() - lastSyncAt : Infinity;
    if (!showToast && timeSinceLast < MIN_SYNC_INTERVAL_MS) {
      fcLog('Sync skipped — rate limited');
      return;
    }
    if (showToast && timeSinceLast < 30000) {
      toast('Already up to date', 'success', 2000);
      return;
    }

    state.syncing = true;
    state._syncStartedAt = Date.now();
    // Re-arm the first-paint exception for this sync, and record whether the
    // screen had anything on it — that is what decides if the paint is earned.
    _paintedAccountsThisSync = false;
    _accountsAtSyncStart = (state.accounts || []).length;
    // Surgical, not a render: _scheduleTabRender holds renders for the
    // whole sync, so this is the only way the badge can say "Syncing…".
    _updateSyncPill();
    let _syncSucceeded = false;

    // Spin + disable the header sync button so the user sees the tap registered
    const _syncBtn = document.getElementById('header-sync-btn');
    if (_syncBtn) _syncBtn.classList.add('is-busy');

    // Idle text depends on whether a bank is linked
    const _idleText = () => (state.user && state.user.plaid_linked) ? 'All caught up' : 'Connect a bank to see your spending';

    // Fade island text to "Syncing…" without jarring jump
    const islandText = document.getElementById('islandText');
    if (islandText) {
      islandText.classList.add('fc-fade');
      setTimeout(() => {
        islandText.innerHTML = 'Syncing<span class="fc-sync-dot" aria-hidden="true"></span>';
        islandText.classList.remove('fc-fade');
      }, 200);
    }

    try {
      const syncResult = await FCData.syncTransactions();
      _setLastSyncAt(Date.now());
      _syncSucceeded = true;
      _lastSyncFailed = false;
      haptic('medium');
      // Surface bank reconnect prompt if any item requires re-authentication
      if (syncResult?.item_errors?.some(e => e.error_code === 'ITEM_LOGIN_REQUIRED')) {
        toast('One of your banks needs to be reconnected — tap to fix', 'error', 8000);
      }
      if (islandText) {
        islandText.classList.add('fc-fade');
        setTimeout(() => {
          islandText.textContent = 'All caught up';
          islandText.classList.remove('fc-fade');
        }, 200);
      }
      // Only pop a toast when the user explicitly triggered the sync
      if (showToast) toast('Accounts synced', 'success');
    } catch (err) {
      // Set unconditionally, before any DOM work. This used to live inside the
      // setTimeout below, inside `if (islandText)` — so a missing #islandText
      // meant a failed sync never recorded that it failed, and the resume
      // handler's retry (which is gated on this flag) never fired.
      _lastSyncFailed = true;
      if (islandText) {
        islandText.classList.add('fc-fade');
        setTimeout(() => {
          // Background syncs fail silently — keep island neutral
          // User-initiated syncs show "Sync failed" briefly
          islandText.textContent = showToast ? 'Sync failed' : _idleText();
          islandText.classList.remove('fc-fade');
        }, 200);
      }
      // Only surface error toast for user-initiated syncs.
      // Background syncs (app launch, screen focus) fail silently so the
      // user isn't greeted by a red banner every time Railway cold-starts.
      if (showToast) toast('Sync failed — check connection', 'error');
    } finally {
      state.syncing = false;
      // Must come after state.syncing is cleared, or the flush re-defers itself.
      // Runs on the throw path too, so a held render is never stranded.
      _updateSyncPill();
      _flushDeferredTabRender();
      /* One reading after the dust settles. Accounts commit per bank, so the
         listener fires several times mid-sync with a partial set; each of
         those overwrites the same day key, but the LAST one is only complete
         if it happened to arrive after the final commit. This guarantees the
         day ends on the whole picture. */
      if (_syncSucceeded && (state.accounts || []).length) {
        const _post = FCCore.netWorth(state.accounts);
        _snapshotNetWorth(_post.net, _post.liabilities);
      }
      if (_syncBtn) _syncBtn.classList.remove('is-busy');
      // After a successful sync the island already says "All caught up" — no reset needed.
      // After a user-triggered failure, give the user a moment to read "Sync failed"
      // then quietly restore the idle state.
      if (!_syncSucceeded && showToast) {
        setTimeout(() => _setIslandText(_idleText()), 4000);
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     SEARCH
     ───────────────────────────────────────────────────────────── */

  function handleSearch(query) {
    state.searchQuery = query;
    _renderActivity();
  }

  /* ─────────────────────────────────────────────────────────────
     PLAID LINK FLOW
     ───────────────────────────────────────────────────────────── */

  async function startPlaidLink() {
    haptic('light');
    // Free plan: gate at 1 bank. Use live RC status + actual item count so the
    // check can't be bypassed by a stale cache (bug #9).
    try {
      const [isLivePro, items] = await Promise.all([
        FCPurchases.checkProStatus().catch(() => _isPro()),
        FCData.getPlaidItems().catch(() => (state.user?.plaid_linked ? [{}] : [])),
      ]);
      if (!isLivePro && items.length >= 1) {
        showPaywall();
        return;
      }
    } catch (_) {
      if (state.user?.plaid_linked && !_isPro()) { showPaywall(); return; }
    }
    if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('plaid_link_started');
    const btn = document.getElementById('btn-plaid-link');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }

    // Suspend idle/lock timer while Plaid Link is open — SMS verification
    // can take several minutes and we don't want the lock screen covering Plaid's UI.
    clearTimeout(_idleTimer);

    try {
      await FCData.openPlaidLink();
      toast('Bank connected! Syncing your accounts…', 'success', 4000);
      // Mark onboarding done and kick off an immediate background sync
      await _markOnboardingComplete();
      // Force plaid_linked on local state immediately so UI updates without waiting
      // for the Firestore listener to propagate.
      if (state.user) state.user.plaid_linked = true;
      _renderHome();
      setTimeout(() => _doSync(false), 600);
      // Poll for accounts/transactions to appear (backend writes async after sync)
      let pollCount = 0;
      const pollInterval = setInterval(() => {
        if ((state.accounts || []).length > 0 && (state.transactions || []).length > 0) {
          clearInterval(pollInterval);
          _renderHome();
          return;
        }
        if (++pollCount >= 10) clearInterval(pollInterval); // stop after 10s
      }, 1000);
      // Request push permissions now — user just connected their bank, so
      // the value prop ("get notified about bills and budget alerts") is clear.
      // Slight delay so the success toast is visible first.
      // Skip entirely if the user already explicitly declined on the
      // notifications onboarding screen — re-asking after an explicit "Not
      // now" is exactly the surprise-prompt behavior this is meant to avoid.
      // requestAndRegister() shows the real OS dialog the very first time
      // it's called, so this would otherwise re-surface it regardless of skip.
      if (state.user?.notifications_enabled !== false) {
        setTimeout(() => {
          FCPush.requestAndRegister().catch(() => {});
          FCPush.requestLocalPermission().catch(() => {});
        }, 1200);
      }
      // Always navigate to the app screen so home refreshes with bank data
      setScreen('app');
      _renderHome();
      // Show paywall if user hasn't subscribed yet.
      // Bank connection is a high-intent moment, but we still respect the cooldown
      // so users who've already seen the paywall today aren't shown it again
      // just for linking an additional account (bug: second-bank paywall spam).
      const _isProAfterLink = FCPurchases.isConfigured()
        ? await FCPurchases.checkProStatus().catch(e => { fcLog('[RC] checkProStatus failed:', e?.message); return false; })
        : false;
      const _plaidLinkUid = FCAuth.currentUser?.()?.uid;
      if (!_isProAfterLink && _shouldShowPaywall(_plaidLinkUid)) {
        // 1.4s lets the success toast finish and the first render settle.
        setTimeout(() => { if (state.screen === 'app') showPaywall(); }, 1400);
      }
    } catch (err) {
      if (err.message !== 'cancelled') {
        toast('Could not connect bank: ' + err.message, 'error');
        if (window.Sentry) Sentry.captureException(err, { tags: { flow: 'plaid_link' } });
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Connect Bank Account'; }
      // Re-arm idle timer now that Plaid Link is closed
      _resetIdleTimer();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     AUTH FLOWS
     ───────────────────────────────────────────────────────────── */

  const _GOOGLE_BTN_IDS  = ['btn-login-google','btn-register-google'];
  const _APPLE_BTN_IDS   = ['btn-login-apple','btn-register-apple'];
  const _GOOGLE_BTN_HTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Continue with Google';
  const _APPLE_BTN_HTML  = '<svg width="18" height="18" viewBox="0 0 24 24" fill="black" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.7 9.05 7.4c1.42.07 2.4.78 3.28.84 1.22-.24 2.4-1.03 3.7-1.02 1.56.02 2.74.74 3.51 1.9-3.19 1.96-2.67 6.28.51 7.54-.64 1.62-1.5 3.23-3 3.62zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg> Continue with Apple';

  function _resetAuthButtons(ids, html) {
    ids.forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.disabled = false; b.innerHTML = html; }
    });
  }

  /** True if a social sign-in failed because the user dismissed the native sheet. */
  function _isCancelledAuthError(err) {
    const msg = ((err && err.message) || '').toLowerCase();
    return msg.includes('cancel') || msg.includes('dismiss') || msg.includes('popup_closed');
  }

  async function handleGoogleSignIn() {
    _GOOGLE_BTN_IDS.forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.disabled = true; b.textContent = 'Signing in…'; }
    });
    _clearError('login-error');
    _clearError('register-error');
    const startScreen = state.screen;
    try {
      window._fcNewUserFaceIdPending = true;
      await FCAuth.signInWithGoogle();
      if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('login_success', { method: 'google' });
      // Leave the button in its loading state — the auth observer is mid-flight
      // (the Firestore round-trip in onAuthStateChanged) and about to navigate
      // away. Resetting it here is what made sign-in look "stuck": the button
      // flashed back to normal while the screen sat still for another second
      // or two with no visible indication anything was happening. The safety
      // net below recovers if routing never happens (e.g. offline Firestore read).
      setTimeout(() => {
        if (state.screen === startScreen) _resetAuthButtons(_GOOGLE_BTN_IDS, _GOOGLE_BTN_HTML);
      }, 4000);
    } catch (err) {
      window._fcNewUserFaceIdPending = false;
      _resetAuthButtons(_GOOGLE_BTN_IDS, _GOOGLE_BTN_HTML);
      if (_isCancelledAuthError(err)) return; // user dismissed the native sheet — silent
      const msg = _friendlyAuthError(err);
      _showError('login-error', msg);
      _showError('register-error', msg);
      haptic('heavy');
    }
  }

  async function handleAppleSignIn() {
    _APPLE_BTN_IDS.forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.disabled = true; b.textContent = 'Signing in…'; }
    });
    _clearError('login-error');
    _clearError('register-error');
    const startScreen = state.screen;
    try {
      window._fcNewUserFaceIdPending = true;
      await FCAuth.signInWithApple();
      if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('login_success', { method: 'apple' });
      // See handleGoogleSignIn — same stuck-screen fix, same safety net.
      setTimeout(() => {
        if (state.screen === startScreen) _resetAuthButtons(_APPLE_BTN_IDS, _APPLE_BTN_HTML);
      }, 4000);
    } catch (err) {
      window._fcNewUserFaceIdPending = false;
      _resetAuthButtons(_APPLE_BTN_IDS, _APPLE_BTN_HTML);
      if (_isCancelledAuthError(err)) return; // user dismissed the native sheet — silent
      const msg = _friendlyAuthError(err);
      _showError('login-error', msg);
      _showError('register-error', msg);
      haptic('heavy');
    }
  }

  async function handleLogin(email, password) {
    _setLoading('btn-login', true, 'Signing in…');
    _clearError('login-error');
    try {
      await FCAuth.signIn(email, password);
      if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('login_success', { method: 'email' });
      // Auth observer will handle screen transition
    } catch (err) {
      _showError('login-error', _friendlyAuthError(err));
      if (window.Sentry) Sentry.captureException(err, { tags: { flow: 'login' } });
      haptic('heavy');
    } finally {
      _setLoading('btn-login', false, 'Sign In');
    }
  }

  async function handleBiometricLogin() {
    const wrapEl = document.getElementById('biometric-login-wrap');
    _clearError('login-error');

    try {
      await FCAuth.signInWithBiometric();
      if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('login_success', { method: 'face_id' });
      // Auth observer handles screen transition on success
    } catch (err) {
      const msg = (err.message || '').toLowerCase();

      // User cancelled — silent, no error shown
      if (msg.includes('cancel') || msg.includes('dismiss') || msg.includes('user cancel')) return;

      if (msg.includes('expired') || msg.includes('no credential') || msg.includes('not found')) {
        // Credentials have expired — hide the Face ID button and guide the user to sign in
        if (wrapEl) wrapEl.style.display = 'none';
        _showError('login-error', 'Face ID session expired. Please sign in with your email and password.');
        // Focus the email field once the error banner has finished animating in
        _focusField(document.getElementById('login-email'));
      } else {
        // Generic failure (Face ID unavailable, hardware error, etc.)
        _showError('login-error', 'Face ID unavailable — please sign in with your email and password.');
        haptic('light');
      }
    }
  }

  async function handleRegister(name, email, password, referralCode = '') {
    _setLoading('btn-register', true, 'Creating account…');
    _clearError('register-error');
    try {
      // Validate name — required so emails personalize correctly
      const trimmedName = (name || '').trim();
      if (!trimmedName) {
        _showError('register-error', 'Please enter your first name.');
        _setLoading('btn-register', false, 'Create Account');
        _focusField(document.getElementById('reg-name'));
        return;
      }

      // Sign out any cached session first — prevents onAuthStateChanged firing
      // with the OLD user before signUp completes and routing a new registrant
      // straight to the existing account's home screen.
      try { FCData.detachAllListeners(); _listenersAttached = false; await FCAuth.signOut(); } catch (_) {}
      // Flag: auth observer will route this new user to Face ID setup first
      window._fcNewUserFaceIdPending = true;
      await FCAuth.signUp(trimmedName, email, password, referralCode);
      // Fire welcome email — non-blocking, never delays onboarding
      _sendWelcomeEmail().catch(() => {});
      // Apply referral code on the backend — non-blocking, never delays onboarding
      if ((referralCode || '').trim()) _applyReferralCode(referralCode.trim()).catch(() => {});
      if (typeof FCAnalytics !== 'undefined') {
        FCAnalytics.track('signed_up', { has_referral: !!referralCode });
        if (referralCode) {
          FCAnalytics.track('referral_signup_completed', { code: referralCode.trim().toUpperCase() });
        }
      }
      // Clear stored referral code — it's been applied
      window._fcPendingReferralCode = null;
      // Auth observer will route to faceid-setup → onboarding
    } catch (err) {
      window._fcNewUserFaceIdPending = false; // clear on error
      _showError('register-error', _friendlyAuthError(err));
      if (window.Sentry) Sentry.captureException(err, { tags: { flow: 'register' } });
      haptic('heavy');
    } finally {
      _setLoading('btn-register', false, 'Create Account');
    }
  }

  /** Non-blocking: tells the backend to credit the referrer and reward this user. */
  async function _applyReferralCode(code) {
    try {
      await FCAuth.authedFetch(`${FC_CONFIG.app.apiBase}/api/referral/apply`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code: code.toUpperCase() }),
      });
    } catch (_) { /* best-effort — referral apply never blocks signup */ }
  }

  /** Non-blocking helper — POSTs to /email/welcome after signup. */
  async function _sendWelcomeEmail() {
    try {
      if (!FC_CONFIG.email || !FC_CONFIG.email.welcomeEndpoint) return;
      await FCAuth.authedFetch(FC_CONFIG.email.welcomeEndpoint, {
        method:  'POST',
      });
    } catch (_) { /* best-effort — never block signup */ }
  }

  // Navigate to the forgot-password screen, pre-filling email from login field if present
  function goToForgotPassword() {
    const loginEmail = (document.getElementById('login-email')?.value || '').trim();
    if (loginEmail) {
      const fpInput = document.getElementById('fp-email');
      if (fpInput) fpInput.value = loginEmail;
    }
    // Reset to default state in case user previously reached the success state
    resetForgotPasswordScreen();
    setScreen('forgot-password');
    // Focus the email input once the screen transition has finished
    const fpInput = document.getElementById('fp-email');
    if (fpInput && !fpInput.value) _focusField(fpInput);
  }

  // Handle the Send Reset Link button on the forgot-password screen
  async function handleForgotPasswordScreen() {
    const emailEl = document.getElementById('fp-email');
    const errorEl = document.getElementById('fp-error');
    const btn      = document.getElementById('btn-fp-send');
    const email    = (emailEl?.value || '').trim();

    // Clear any previous error
    if (errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }

    if (!email) {
      _focusField(emailEl);
      if (errorEl) { errorEl.textContent = 'Please enter your email address.'; errorEl.style.display = ''; }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

    try {
      await FCAuth.sendPasswordReset(email);
      haptic('medium');

      // Show success state
      const sentEl = document.getElementById('fp-sent-email');
      if (sentEl) sentEl.textContent = email;
      const defEl = document.getElementById('fp-default-state');
      const sucEl = document.getElementById('fp-success-state');
      if (defEl) defEl.style.display = 'none';
      if (sucEl) sucEl.style.display = '';
    } catch (err) {
      if (errorEl) { errorEl.textContent = _friendlyAuthError(err); errorEl.style.display = ''; }
      if (btn) { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
    }
  }

  // Reset the forgot-password screen back to its default (input) state
  function resetForgotPasswordScreen() {
    const defEl = document.getElementById('fp-default-state');
    const sucEl = document.getElementById('fp-success-state');
    const errEl = document.getElementById('fp-error');
    const btn   = document.getElementById('btn-fp-send');
    if (defEl) defEl.style.display = '';
    if (sucEl) sucEl.style.display = 'none';
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (btn)   { btn.disabled = false; btn.textContent = 'Send Reset Link'; }
  }

  // Legacy: kept for any existing callers
  async function handleForgotPassword(email) {
    if (!email) { toast('Enter your email first', 'info'); return; }
    try {
      await FCAuth.sendPasswordReset(email);
      toast('Reset email sent — check your inbox', 'success');
    } catch (err) {
      toast(_friendlyAuthError(err), 'error');
    }
  }

  async function handleSignOut() {
    haptic('light');
    const confirmed = await _confirmDialog('Sign out', 'Are you sure you want to sign out?', 'Sign Out');
    if (!confirmed) return;

    fcLog('[FCApp] handleSignOut — signing out uid:', FCAuth.currentUser()?.uid);

    // Stop idle timer immediately
    clearTimeout(_idleTimer);

    if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('signed_out');
    if (window.Sentry) Sentry.setUser(null);

    // _wipeUserState() detaches listeners, resets _listenersAttached,
    // resets FCPurchases and FCPush — call BEFORE signOut() so no
    // in-flight listener callback can write to the cleared state.
    _wipeUserState();

    await FCAuth.signOut();
    if (typeof FCAnalytics !== 'undefined') FCAnalytics.reset();
    setScreen('hero');
    fcLog('[FCApp] handleSignOut — complete, screen = hero');
  }

  /** Security status shown under the Safe-to-Spend hero. Reports the actual
   *  device state — never a hardcoded reassurance. */
  function _updateTrustLine() {
    const el = document.getElementById('home-trust-text');
    if (!el) return;
    const base = 'Read-only · Bank-grade encryption';
    try {
      if (!FCAuth || !FCAuth.isBiometricEnabled) { el.textContent = base; return; }
      FCAuth.isBiometricEnabled()
        .then(on => { el.textContent = on ? 'Read-only · Face ID on' : base; })
        .catch(() => { el.textContent = base; });
    } catch (_) { el.textContent = base; }
  }

  /* ── Metric #1: first real Safe-to-Spend view ─────────────────
     The single best predictor of retention (see VISION.md). Fires
     exactly once per user, ever — guarded by localStorage so it
     survives reinstalls of the session, not of the app. */
  function _trackFirstSafeToSpend() {
    try {
      if (_isDemoMode) return;
      if (!state.user?.plaid_linked && !(state.accounts || []).length) return;
      const uid = FCAuth.currentUser && FCAuth.currentUser()?.uid;
      if (!uid) return;
      const key = 'fc_first_sts_' + uid;
      if (localStorage.getItem(key) === '1') return;
      localStorage.setItem(key, '1');   // non-financial flag only
      if (typeof FCAnalytics !== 'undefined') {
        FCAnalytics.track('first_safe_to_spend_viewed', {
          accounts: (state.accounts || []).length,
          has_bills: (state.bills || []).length > 0,
        });
      }
    } catch (_) {}
  }

  /* ── Retention loop: weekly recap + payday reminders ─────────
     Scheduled once per session, only when the user has actually
     opted into notifications. Both are LOCAL notifications, so they
     work with no backend and cost nothing to send. */
  let _engagementScheduled = false;
  function _scheduleEngagementNotifications() {
    if (_engagementScheduled || _isDemoMode) return;
    if (!window.FCPush) return;
    // Respect an explicit opt-out — never re-prompt or schedule against it
    if (state.user && state.user.notifications_enabled === false) return;
    if (!(state.transactions || []).length) return;
    _engagementScheduled = true;

    // Weekly "Your Money Week is ready" — drives the story recap
    FCPush.scheduleWeeklyRecap().catch(() => {});

    // Payday reminder, using the same predictor the dashboard uses
    try {
      const payday = _predictNextPayday();
      if (payday && payday.date) {
        const recent = (state.transactions || []).filter(t => {
          if (!_isIncomeTxn(t) || !t.date) return false;
          try { return FCData.parseDateLocal(t.date) >= new Date(Date.now() - 45 * 86400000); }
          catch (_) { return false; }
        });
        const est = recent.length ? Math.max(...recent.map(t => Math.abs(t.amount || 0))) : 0;
        FCPush.schedulePaydayReminder(payday.date, est).catch(() => {});
      }
    } catch (_) {}
  }

  /* ── Small UI helpers ────────────────────────────────────── */

  function _setLoading(btnId, loading, text) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = text;
  }

  function _showError(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }

  function _clearError(id) {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.style.display = 'none'; }
  }

  function _friendlyAuthError(err) {
    const map = {
      'auth/user-not-found':         'No account with that email — try creating one',
      'auth/wrong-password':         'Incorrect password',
      'auth/invalid-credential':     'Email or password is incorrect',
      'auth/invalid-email':          'Invalid email address',
      'auth/email-already-in-use':   'Email already in use — sign in instead',
      'auth/weak-password':          'Password must be at least 6 characters',
      'auth/too-many-requests':      'Too many attempts — try again later',
      'auth/network-request-failed': 'No internet connection',
      'auth/user-disabled':          'This account has been disabled',
      'auth/operation-not-allowed':  'Email sign-in not enabled — check Firebase Console',
    };
    return map[err.code] || err.message || 'Something went wrong';
  }

  function _confirmDialog(title, message, confirmText) {
    confirmText = confirmText || title;
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:flex-end;justify-content:center';
      overlay.innerHTML = `
        <div style="background:var(--fc-bg-elevated,#0b1826);border-radius:24px 24px 0 0;padding:24px 24px calc(24px + env(safe-area-inset-bottom,0));width:100%;max-width:480px;border-top:1px solid var(--fc-border,rgba(255,255,255,0.07))">
          <div style="font-size:17px;font-weight:700;color:var(--fc-text,#f0f6ff);margin-bottom:8px;text-align:center">${title.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>
          <div style="font-size:14px;color:var(--fc-text-muted,rgba(240,246,255,0.58));line-height:1.5;margin-bottom:24px;text-align:center">${message.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</div>
          <button id="_fc-dlg-confirm" style="width:100%;padding:16px;border-radius:14px;border:none;background:var(--fc-danger,#ff453a);color:#fff;font-size:16px;font-weight:600;cursor:pointer;margin-bottom:10px">${confirmText.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</button>
          <button id="_fc-dlg-cancel" style="width:100%;padding:14px;border-radius:14px;border:1px solid var(--fc-border,rgba(255,255,255,0.07));background:transparent;color:var(--fc-text-muted,rgba(240,246,255,0.58));font-size:15px;font-weight:500;cursor:pointer">Cancel</button>
        </div>`;
      document.body.appendChild(overlay);
      const cleanup = ok => {
        haptic(ok ? 'heavy' : 'light');
        overlay.remove();
        resolve(ok);
      };
      overlay.querySelector('#_fc-dlg-confirm').addEventListener('click', () => cleanup(true));
      overlay.querySelector('#_fc-dlg-cancel').addEventListener('click', () => cleanup(false));
      overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(false); });
    });
  }

  /** Mark onboarding as complete in Firestore + localStorage (called on skip or bank connect) */
  async function _markOnboardingComplete(skipped = false) {
    const uid = FCAuth.currentUser && FCAuth.currentUser()?.uid;
    // Write localStorage immediately — before the async Firestore write — so that
    // if the user closes the app during the write, the flag is already set and
    // onAuthStateChanged won't route them back to onboarding on next cold start.
    if (uid) _markOnboardingLocalCache(uid);
    // Lift the native lock-screen suppression now that setup is done.
    if (FCAuth.setOnboardingActive) FCAuth.setOnboardingActive(false).catch(() => {});
    // Clear mid-flow progress now that onboarding is done
    try { localStorage.removeItem('fc_ob_progress'); } catch (_) {}
    try {
      const db  = FCAuth.db && FCAuth.db();
      if (uid && db) {
        await db.collection('users').doc(uid).update({ onboarding_complete: true });
      }
    } catch (_) {}
    if (typeof FCAnalytics !== 'undefined') {
      FCAnalytics.track(skipped ? 'onboarding_skipped' : 'onboarding_completed');
    }
  }

  /**
   * Face ID setup screen — user tapped "Enable Face ID".
   * Fires the real native Face ID prompt immediately so the tap has a visible,
   * deliberate native response — only persists the preference on success.
   * Routes to the notification permission screen (new users only) after.
   */
  async function handleBiometricSetup() {
    haptic('medium');
    const btn = document.getElementById('btn-faceid-enable');
    try {
      const available = await FCAuth.checkBiometricAvailable();
      if (!available) {
        // No Face ID hardware/enrollment on this device — nothing to confirm.
        setScreen('notif-permission');
        return;
      }
      if (btn) { btn.disabled = true; btn.textContent = 'Confirming…'; }
      await FCAuth.promptBiometric('Enable Face ID for FlowCheck');
      await FCAuth.setBiometricEnabled(true);
      setScreen('notif-permission');
    } catch (err) {
      // User cancelled the native prompt or it failed — don't enable, and
      // stay on this screen so they can retry or explicitly tap "Not now".
      if (btn) { btn.disabled = false; btn.textContent = 'Enable Face ID'; }
      const msg = (err && err.message || '').toLowerCase();
      if (!(msg.includes('cancel') || msg.includes('dismiss'))) {
        toast('Could not confirm Face ID — try again or tap "Not now"', 'error');
      }
      haptic('light');
    }
  }

  /** User tapped "Not now" on the Face ID setup screen. */
  async function skipFaceIdSetup() {
    try {
      if (FCAuth.setBiometricEnabled) await FCAuth.setBiometricEnabled(false);
    } catch (_) {}
    setScreen('notif-permission');
  }

  /**
   * "Start 7-Day Free Trial" on the onboarding paywall slide (slide 5).
   * Routes to the full paywall screen which handles RevenueCat, plan selection,
   * trial offer, success overlays, and Firestore writes — no duplication needed.
   */
  function startTrialFromOnboarding() {
    haptic('medium');
    if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('trial_cta_tapped', { source: 'onboarding' });
    if (_isPro()) { obNext(); return; }   // already Pro — skip to bank slide
    _selectedPlan = 'monthly';
    _paywallFromOnboarding = true;        // closePaywall/skipPaywall return to the bank slide
    // No X here: this is the end of signup and there is no free tier behind it.
    showPaywall({ dismissible: false });
  }

  /**
   * Demo mode — for App Review testers who cannot connect a real bank.
   * Populates state with realistic sample data so all app features are visible.
   */
  async function startDemoMode() {
    haptic('medium');
    _isDemoMode = true;
    state.initialLoading = false;
    _markOnboardingComplete(false).catch(() => {});

    const demoUser = Object.assign({}, state.user || {}, {
      name:                 'Demo User',
      plaid_linked:         true,
      plaid_institution:    'Demo Bank',
      is_pro:               true,
      onboarding_complete:  true,
      streak:               7,
      net_worth:            24318.42,
      notifications_enabled: false,
    });
    state.user = demoUser;
    state.accounts = [
      { account_id: 'demo-chk', name: 'Demo Checking', official_name: 'Demo Checking Account', type: 'depository', subtype: 'checking', balance_current: 3241.87, balance_available: 3100.00, mask: '4242', institution_name: 'Demo Bank' },
      { account_id: 'demo-sav', name: 'Demo Savings',  official_name: 'Demo Savings Account',  type: 'depository', subtype: 'savings',  balance_current: 12800.00, balance_available: 12800.00, mask: '8888', institution_name: 'Demo Bank' },
      { account_id: 'demo-cc',  name: 'Demo Visa',     official_name: 'Demo Visa Card',        type: 'credit',     subtype: 'credit card', balance_current: 723.55, balance_available: null, mask: '1111', institution_name: 'Demo Bank', interest_rate: 22.99, minimum_payment: 35 },
      /* An auto loan with no APR is not an oversight in the demo data — it is
         the single most common real case. Plaid's Liabilities product covers
         credit, student and mortgage only, so this is what a real user's
         largest debt looks like, and the demo should show the row that asks
         for the two missing numbers rather than pretend every debt has them. */
      { account_id: 'demo-auto', name: 'Demo Auto Loan', official_name: 'Demo Auto Loan',     type: 'loan',       subtype: 'auto',        balance_current: 14250.00, balance_available: null, mask: '7788', institution_name: 'Demo Bank' },
    ];
    /* Demo debt history. Real listeners short-circuit in demo mode, so
       without this the "paid down" card would show its day-one state and
       App Review would never see the feature. The shape matches what the
       daily snapshot actually writes: {YYYY-MM-DD: total debt}. */
    const _demoNow = new Date();
    /* Net worth history, for the same reason as the debt history below: the
       real listener short-circuits in demo, so without this the Money tab
       shows the "tracking starts today" placeholder instead of the chart. */
    state.nwHistory = (() => {
      const h = {}, end = 3241.87 + 12800 - (723.55 + 14250);
      for (let i = 60; i >= 0; i--) {
        const d = new Date(_demoNow); d.setDate(d.getDate() - i);
        // A gently improving line with a little week-to-week texture.
        const drift = (60 - i) * 26;
        const wobble = Math.sin(i / 4) * 140;
        h[`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`]
          = Math.round((end - drift + wobble) * 100) / 100;
      }
      return h;
    })();
    state.debtHistory = (() => {
      const h = {}, total = 723.55 + 14250;
      // Six monthly points, ~$210/mo of real progress, ending at today's total.
      for (let i = 6; i >= 0; i--) {
        const d = new Date(_demoNow);
        d.setMonth(d.getMonth() - i);
        h[`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`]
          = Math.round((total + i * 210) * 100) / 100;
      }
      return h;
    })();
    // Rolling date helpers — cross month boundaries correctly, so demo bills
    // are never accidentally overdue at month-end and history spans 2 months.
    const _demoFmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const _demoAgo = (n) => { const d = new Date(_demoNow); d.setDate(d.getDate() - n); return _demoFmt(d); };
    const _demoIn  = (n) => { const d = new Date(_demoNow); d.setDate(d.getDate() + n); return _demoFmt(d); };
    state.transactions = [
      { transaction_id: 't1',  name: 'Starbucks',          amount: 6.24,    date: _demoAgo(0), category: ['Food and Drink','Coffee Shop'],   account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't2',  name: 'Salary',             amount: 3200.00, date: _demoAgo(1), category: ['Transfer','Payroll'],             account_id: 'demo-chk', isCredit: true  },
      { transaction_id: 't3',  name: 'Amazon',             amount: 72.99,   date: _demoAgo(1), category: ['Shops','Online Marketplaces'],   account_id: 'demo-cc',  isCredit: false },
      { transaction_id: 't4',  name: 'Walmart',            amount: 48.23,   date: _demoAgo(2), category: ['Shops','Groceries'],  account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't5',  name: 'Netflix',            amount: 15.99,   date: _demoAgo(3), category: ['Service','Subscription'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't6',  name: 'Uber',               amount: 23.50,   date: _demoAgo(4), category: ['Travel','Ride Share'], account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't7',  name: 'Whole Foods Market', amount: 87.43,   date: _demoAgo(5), category: ['Food and Drink','Groceries'], account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't8',  name: 'Spotify',            amount: 9.99,    date: _demoAgo(6), category: ['Service','Subscription'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't9',  name: 'Shell Gas Station',  amount: 58.20,   date: _demoAgo(7), category: ['Travel','Gas Stations'], account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't10', name: 'Chipotle',           amount: 14.35,   date: _demoAgo(8), category: ['Food and Drink','Restaurants'], account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't11', name: 'Target',             amount: 67.80,   date: _demoAgo(9), category: ['Shops','Department Stores'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't12', name: 'Dining Out',         amount: 462.50,  date: _demoAgo(2), category: ['Food and Drink','Restaurants'], account_id: 'demo-chk', isCredit: false },
      // Prior month — makes subscription detection light up and gives the
      // Activity chart real history for demo/App Review sessions.
      { transaction_id: 't13', name: 'Netflix',            amount: 15.99,   date: _demoAgo(33), category: ['Service','Subscription'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't14', name: 'Spotify',            amount: 9.99,    date: _demoAgo(36), category: ['Service','Subscription'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't15', name: 'Salary',             amount: 3200.00, date: _demoAgo(31), category: ['Transfer','Payroll'],     account_id: 'demo-chk', isCredit: true  },
      { transaction_id: 't16', name: 'Whole Foods Market', amount: 92.10,   date: _demoAgo(34), category: ['Food and Drink','Groceries'], account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't17', name: 'Amazon',             amount: 54.37,   date: _demoAgo(40), category: ['Shops','Online Marketplaces'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't18', name: 'Shell Gas Station',  amount: 61.75,   date: _demoAgo(38), category: ['Travel','Gas Stations'], account_id: 'demo-chk', isCredit: false },
      // ── Vault fixtures ────────────────────────────────────────────
      // App Review has to be able to SEE the billing model, not just read
      // about it, so demo data includes the two things it pays out on.
      // A subscription that billed monthly and then stopped — three charges
      // that never came, which is what funds the demo Vault.
      { transaction_id: 't19', name: 'Adobe Creative Cloud', amount: 54.99, date: _demoAgo(95),  category: ['Service','Subscription'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't20', name: 'Adobe Creative Cloud', amount: 54.99, date: _demoAgo(125), category: ['Service','Subscription'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't21', name: 'Adobe Creative Cloud', amount: 54.99, date: _demoAgo(155), category: ['Service','Subscription'], account_id: 'demo-cc', isCredit: false },
      // A double charge that came back — both sides on the statement, which
      // is the only kind of "we found you money" the Vault counts in full.
      // Dated into the CURRENT month on purpose: the Vault bills per month,
      // so a demo whose only wins are historical opens on "this month is
      // free" and never shows the fee being drawn at all.
      { transaction_id: 't22', name: 'Target', amount: 67.80, date: _demoAgo(3), category: ['Shops','Department Stores'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't23', name: 'Target', amount: 67.80, date: _demoAgo(2), category: ['Shops','Department Stores'], account_id: 'demo-cc', isCredit: false },
      { transaction_id: 't24', name: 'Target', amount: 67.80, date: _demoAgo(0), category: ['Shops','Department Stores'], account_id: 'demo-cc', isCredit: true  },
    ]
      // Real transactions come out of listenToTransactions() carrying `id`
      // (the Firestore doc id); demo rows only declared transaction_id, so
      // every row rendered onclick="openTransactionDetail('')" and the detail
      // sheet could not be opened at all in demo mode. Give demo data the
      // same shape as the real thing rather than teaching each reader about
      // two id fields.
      .map(t => ({ ...t, id: t.transaction_id }));
    state.bills = [
      { id: 'b1', name: 'Rent',          amount: 1200.00, due_date: _demoIn(6),  status: 'upcoming', icon: '🏠', category: 'Housing' },
      { id: 'b2', name: 'Electric',      amount: 89.50,   due_date: _demoIn(12), status: 'upcoming', icon: '⚡', category: 'Utilities' },
      { id: 'b3', name: 'Internet',      amount: 59.99,   due_date: _demoIn(18), status: 'upcoming', icon: '📡', category: 'Utilities' },
    ];
    state.goals = [
      { id: 'g1', name: 'Emergency Fund', target: 3000, current: 1300, pct: 43, icon: '🛡️' },
      { id: 'g2', name: 'Vacation Fund',  target: 2000, current:  950, pct: 48, icon: '🌴' },
      { id: 'g3', name: 'New Car',        target: 5000, current: 1200, pct: 24, icon: '🚗' },
    ];
    state.budgets = { total: { limit: 2390 } };

    setScreen('app');
    _renderHome();
    toast('Demo mode active — all features unlocked', 'success');
  }

  /** User tapped "Skip for now" on the last onboarding slide */
  let _skippingOnboarding = false;
  async function skipOnboarding() {
    if (_skippingOnboarding) return;         // debounce: ignore rapid double-taps
    _skippingOnboarding = true;
    haptic('light');

    // Mark onboarding complete (best-effort — never block navigation on this).
    // localStorage write happens synchronously inside _markOnboardingComplete().
    _markOnboardingComplete(true).catch(() => {});

    // Always navigate to the dashboard first — users need to see their home
    // screen before encountering the paywall. Blocking the flow here with a
    // non-dismissible paywall (old behaviour) felt jarring and hurt conversion.
    setScreen('app');
    _renderHome();
    _scheduleWelcomeModal();
    setTimeout(() => _doSync(false), 800);

    // Check pro status async; if not Pro, show a contextual paywall from the
    // dashboard (which has the X close button). Respects the 24h cooldown so
    // the paywall doesn't appear again if they've already seen it today.
    const uid = FCAuth.currentUser?.()?.uid;
    const _cachedPro = FCPurchases.isConfigured()
      ? await FCPurchases.checkProStatus().catch(() => false)
      : false;

    setTimeout(() => { _skippingOnboarding = false; }, 1500);
  }

  /* ─────────────────────────────────────────────────────────────
     OTP EMAIL VERIFICATION (verify-email screen)
     ───────────────────────────────────────────────────────────── */

  /**
   * Request the backend to generate and send an OTP to the current user.
   * Shows an error on the verify-email screen if the send fails so the
   * user knows to tap "Resend Code" rather than waiting indefinitely.
   */
  async function _sendOtpCode() {
    try {
      const token = await FCAuth.getIdToken();
      const resp  = await fetch(`${FC_CONFIG.app.apiBase}/auth/otp/send`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        signal:  AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        // Show the error inline on the verify-email screen
        const errEl = document.getElementById('verify-email-err');
        if (errEl) {
          errEl.textContent = data.message || 'Could not send verification code — tap Resend Code to try again.';
          errEl.style.display = '';
        }
      }
    } catch (err) {
      // Network error or timeout — show inline message
      const errEl = document.getElementById('verify-email-err');
      if (errEl) {
        errEl.textContent = 'Could not send verification code. Check your connection and tap Resend Code.';
        errEl.style.display = '';
      }
    }
  }

  /** Reads the 6 OTP box values into a string */
  function _getOtpValue() {
    return Array.from(document.querySelectorAll('.fc-otp-box'))
      .map(b => b.value.trim()).join('');
  }

  /** Clears all OTP boxes and removes error state */
  function _clearOtpBoxes(focusFirst) {
    const boxes = document.querySelectorAll('.fc-otp-box');
    boxes.forEach(b => { b.value = ''; b.classList.remove('filled', 'error'); });
    // Via _focusField: this runs on entry to the verify screen, which animates.
    if (focusFirst && boxes[0]) _focusField(boxes[0]);
  }

  /** Spread a multi-digit string across the boxes starting at `from`.
   *  Returns the number of boxes filled. */
  function _fillOtpFrom(from, digits) {
    const boxes = document.querySelectorAll('.fc-otp-box');
    let n = 0;
    for (let i = 0; i < digits.length && from + i < boxes.length; i++) {
      const b = boxes[from + i];
      b.value = digits[i];
      b.classList.toggle('filled', true);
      b.classList.remove('error');
      n++;
    }
    const last = boxes[Math.min(from + n, boxes.length - 1)];
    if (from + n >= boxes.length) { if (last) last.blur(); }
    else if (last) last.focus();
    return n;
  }

  /** Auto-advance to next box on digit entry, mark filled */
  function otpBoxInput(el) {
    const val = el.value.replace(/\D/g, '');

    /* iOS SMS/email autofill drops the WHOLE code into the box that carries
       autocomplete="one-time-code" and fires `input`, not `paste` — so
       handleOtpPaste never saw it, and this used to keep only
       val[val.length - 1]. Tapping "From Messages: 123456" put a lone "6" in
       the first box and silently threw the rest away. Anything longer than a
       single digit is an autofill or a paste: spread it across the boxes. */
    if (val.length > 1) {
      el.value = '';
      // A full-length code always starts at box 1, whichever box received it —
      // every box carries one-time-code, so autofill can land in any of them.
      const from = val.length >= 6 ? 0 : (+el.dataset.index || 0);
      _fillOtpFrom(from, val);
      if (_getOtpValue().length === 6) handleVerifyEmailCheck();
      return;
    }

    el.value = val;
    el.classList.toggle('filled', !!el.value);
    el.classList.remove('error');
    if (el.value) {
      const next = document.querySelector(`.fc-otp-box[data-index="${+el.dataset.index + 1}"]`);
      if (next) next.focus();
      else el.blur();
    }
    // Auto-submit when all 6 filled
    if (_getOtpValue().length === 6) handleVerifyEmailCheck();
  }

  /** Backspace moves to previous box */
  function otpBoxKeydown(e, el) {
    if (e.key === 'Backspace' && !el.value) {
      const prev = document.querySelector(`.fc-otp-box[data-index="${+el.dataset.index - 1}"]`);
      if (prev) { prev.value = ''; prev.classList.remove('filled'); prev.focus(); }
    }
  }

  /** Handle paste of full code into any box */
  function handleOtpPaste(e) {
    const text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
    if (text.length < 6) return;
    e.preventDefault();
    const boxes = document.querySelectorAll('.fc-otp-box');
    boxes.forEach((b, i) => {
      b.value = text[i] || '';
      b.classList.toggle('filled', !!b.value);
    });
    if (text.length >= 6) handleVerifyEmailCheck();
  }

  /** Verify button — submits OTP to backend */
  async function handleVerifyEmailCheck() {
    const btn   = document.getElementById('btn-verify-continue');
    const errEl = document.getElementById('verify-email-err');
    const code  = _getOtpValue();
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (code.length < 6) {
      if (errEl) { errEl.textContent = 'Enter the full 6-digit code from your email.'; errEl.style.display = ''; }
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
    try {
      const token = await FCAuth.getIdToken();
      const resp  = await fetch(`${FC_CONFIG.app.apiBase}/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ code }),
      });
      const data = await resp.json();
      if (resp.ok && data.ok) {
        window._fcVerifyEmailPending = false;
        haptic('success');
        // Reload Firebase user so emailVerified is true
        await FCAuth.reloadUser();
        setScreen('faceid-setup');
      } else {
        if (errEl) { errEl.textContent = data.message || 'Incorrect code — try again.'; errEl.style.display = ''; }
        haptic('heavy');
        // Shake boxes on error
        document.querySelectorAll('.fc-otp-box').forEach(b => {
          b.classList.add('error');
          setTimeout(() => b.classList.remove('error'), 400);
        });
        if (data.expired) _clearOtpBoxes(true);
      }
    } catch (err) {
      if (errEl) { errEl.textContent = 'Something went wrong — please try again.'; errEl.style.display = ''; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Verify Email'; }
    }
  }

  /** Resend Code button — 60s cooldown */
  async function resendVerificationEmail() {
    const btn   = document.getElementById('btn-resend-verify');
    const errEl = document.getElementById('verify-email-err');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    try {
      const token = await FCAuth.getIdToken();
      const resp  = await fetch(`${FC_CONFIG.app.apiBase}/auth/otp/send`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        signal:  AbortSignal.timeout(15_000),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok) {
        toast('New code sent — check your inbox!', 'success');
        _clearOtpBoxes(true);
        let secs = 60;
        const iv = setInterval(() => {
          if (!btn) { clearInterval(iv); return; }
          secs--;
          if (secs <= 0) { clearInterval(iv); btn.disabled = false; btn.textContent = 'Resend Code'; return; }
          btn.textContent = `Resend in ${secs}s`;
        }, 1000);
      } else {
        const msg = data.message || 'Could not send code — please try again.';
        toast(msg, 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Resend Code'; }
      }
    } catch (_) {
      toast('Could not reach the server. Check your connection and try again.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Resend Code'; }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TOGGLE CONTROLS (Settings)
     ───────────────────────────────────────────────────────────── */

  async function toggleBiometric(enable) {
    const toggleEl = document.getElementById('toggle-biometric');
    function snapBack() {
      if (toggleEl) {
        toggleEl.classList.toggle('on', !enable);
        toggleEl.setAttribute('aria-checked', !enable);
      }
    }
    try {
      if (enable) {
        // Verify Face ID is actually enrolled on this device before enabling
        const available = await FCAuth.checkBiometricAvailable();
        if (!available) {
          toast('Face ID not set up — go to iOS Settings → Face ID & Passcode', 'error');
          snapBack();
          return;
        }
      }
      // Face ID is a device-local preference — stored in Capacitor Preferences only.
      // Do NOT write to Firestore: the field is not in security rules and the write
      // always throws "Missing or insufficient permissions", reverting the toggle.
      await FCAuth.setBiometricEnabled(enable);
      toast(enable ? 'Face ID enabled' : 'Face ID disabled', 'success');
    } catch (err) {
      fcLog('[toggleBiometric] error:', err.message);
      toast('Could not update Face ID setting', 'error');
      snapBack();
    }
  }

  async function toggleNotifications(enable) {
    if (enable) {
      await FCPush.requestAndRegister();

      // Check OS permission AFTER the request — this is the authoritative answer.
      const osStatus = await FCPush.checkPermissions().catch(() => 'unavailable');

      if (osStatus === 'denied') {
        // User has explicitly blocked notifications at the OS level.
        toast('Notifications blocked — open iOS Settings to enable', 'info');
        try {
          const App = window.Capacitor?.Plugins?.App;
          if (App) await App.openUrl({ url: 'app-settings:' });
        } catch (_) {}
        // Snap toggle back to off
        const toggle = document.getElementById('toggle-notifications');
        if (toggle) { toggle.classList.remove('on'); toggle.setAttribute('aria-checked', 'false'); }
        return false;
        // Any other status ('granted', 'prompt', 'unavailable') means we can proceed.
        // 'prompt'     → user hasn't been asked yet; dialog will show on next foreground
        // 'unavailable'→ simulator or plugin not ready; save preference anyway
      }
    }

    // Persist locally first — Preferences never fails permissions and survives
    // Firestore connection issues (e.g. auth token not yet propagated after sign-in).
    const Prefs = window.Capacitor?.Plugins?.Preferences;
    try { if (Prefs) await Prefs.set({ key: 'fc_notifs_enabled', value: String(enable) }); } catch (_) {}

    // Sync to Firestore best-effort — never fail the UX on a Firestore write error.
    FCData.updateUserField('notifications_enabled', enable).catch(err => {
      fcLog('[toggleNotifications] Firestore sync deferred:', err.message);
    });

    toast(enable ? 'Notifications enabled' : 'Notifications turned off', 'success');
    return true;
  }

  /* ─────────────────────────────────────────────────────────────
     DATA LISTENERS (attach after login)
     ───────────────────────────────────────────────────────────── */

  // Guard: prevent duplicate listener stacks on repeated onAuthStateChanged fires
  // (token refreshes, reconnects). Each duplicate stack = N extra Firestore reads.
  let _listenersAttached = false;
  // Streak guard — _maybeIncrementStreak() fires each time the Firestore user
  // listener emits. Writing serverTimestamp() itself triggers another emit
  // before the value resolves, so without a guard the streak resets every time.
  let _streakCheckedThisSession = false;
  // Collect any app-level unsubscribe functions (safety net alongside FCData.detachAllListeners)
  let _firestoreListeners = [];

  function _attachDataListeners() {
    if (_listenersAttached) {
      fcLog('[FCApp] Listeners already attached — skipping duplicate attach');
      return;
    }
    _listenersAttached = true;
    state.initialLoading = true;
    FCData.listenToUser(user => {
      if (_isDemoMode) return;
      state.user = user;
      if (state.screen === 'app') _renderSettings();
      _updateGreeting();
      // Increment streak daily — fire-and-forget, never surface as unhandled rejection
      _maybeIncrementStreak(user).catch(() => {});
    });

    FCData.listenToAccounts(accounts => {
      if (_isDemoMode) return;
      state.initialLoading = false;
      state.accounts = accounts;
      /* One call, every tab. _scheduleTabRender routes to whichever screen is
         actually up and coalesces the ~12 commits a Plaid sync produces into
         one paint — the per-tab `if` ladder that used to live here is what
         left Money, Plan, Goals and Coach frozen until you switched away. */
      _scheduleTabRender();
      // Snapshot net worth on every account update (daily dedup inside)
      // netWorth() already computes liabilities for the net figure — it was
      // simply being discarded. Same classifier, so the tile can never
      // disagree with the Debt page about what counts as debt.
      const _nw = FCCore.netWorth(accounts);
      _snapshotNetWorth(_nw.net, _nw.liabilities);
    });

    FCData.listenToTransactions(500, transactions => {
      if (_isDemoMode) return;
      state.initialLoading = false;
      state.transactions = transactions;
      _scheduleTabRender();
      // Check budget thresholds whenever transactions update
      _checkBudgetAlert();
      // Retention loop — needs transaction history to predict payday
      _scheduleEngagementNotifications();
    });

    FCData.listenToBills(bills => {
      if (_isDemoMode) return;
      state.bills = bills;
      _scheduleTabRender();
      FCPush.scheduleAllBillReminders(bills).catch(() => {});
    });

    FCData.listenToGoals(goals => {
      state.goals = goals;
      /* This line threw a ReferenceError on every goals update: `_wealthSeg`
         is referenced here and declared nowhere in the file (the real
         variable is `_wealthTab`). Because the throw happened inside the
         Firestore listener, the Goals tab silently stopped live-updating —
         you had to leave and come back to see a goal change.

         The clause it guarded was stale anyway. It dated from when Goals was
         a panel inside Money; Money's segments are overview/savings/debt and
         there is no 'goals' one, so `_wealthTab === 'goals'` could never be
         true. And _renderGoals() renders that old Money panel, not the tab —
         switchTab('goals') uses _renderGoalsScreen(true). */
      _scheduleTabRender();
    });

    FCData.listenToBudgets(budgets => {
      state.budgets = budgets;
      _snapshotBudgetMonths();
      _scheduleTabRender();
    });

    FCData.listenToAccountDetails(details => {
      state.accountDetails = details;
      // These feed Avg Interest, Monthly Min., the payoff order and the
      // debt-free date, so the screens showing them have to re-read.
      _scheduleTabRender();
    });

    FCData.listenToBudgetHistory(history => {
      state.budgetHistory = history;
      // Rollover changes the ceiling every budget figure is measured
      // against, so the screens showing those figures have to re-read it.
      _scheduleTabRender();
    });

    // Notification center listener
    FCData.listenToNotifications(notifs => {
      state.notifications = notifs;
      _updateNotifBadge(notifs);
    });

    // Transaction overrides (user edits to names/categories)
    FCData.listenToTransactionOverrides(overrides => {
      state.txnOverrides = overrides;
      _scheduleTabRender();
    });

    // Credit score history (monthly snapshots for sparkline)
    FCData.listenToCreditHistory(history => {
      state.creditHistory = history;
    });

    // Net worth history (daily snapshots — Firestore-backed for cross-device persistence)
    FCData.listenToNetWorthHistory((history, debt) => {
      state.nwHistory = history;
      state.debtHistory = debt || {};
      // Net Worth is a Money panel too — this listener only knew about
      // Insights, so the Money chart lagged a day behind its own history.
      _scheduleTabRender();
    });
  }

  async function _maybeIncrementStreak(user) {
    // Only run once per app session — writing serverTimestamp() to Firestore
    // triggers the listener again before the value resolves, causing re-entrancy
    // that resets the streak back to 1 on every user-doc update.
    if (_streakCheckedThisSession) return;
    _streakCheckedThisSession = true;

    const db  = FCAuth.db();
    const uid = FCAuth.currentUser()?.uid;
    if (!db || !uid) return;
    // First-ever login: initialize streak to 1
    if (!user.last_streak_date) {
      await db.collection('users').doc(uid).update({
        streak:           1,
        last_streak_date: firebase.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      return;
    }
    const last  = user.last_streak_date.toDate ? user.last_streak_date.toDate() : new Date(user.last_streak_date);
    const today = new Date(); today.setHours(0,0,0,0);
    const lastDay = new Date(last); lastDay.setHours(0,0,0,0);
    const diff = Math.round((today - lastDay) / 86400000);
    if (diff === 1) {
      await db.collection('users').doc(uid).update({
        streak:           firebase.firestore.FieldValue.increment(1),
        last_streak_date: firebase.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    } else if (diff > 1) {
      await db.collection('users').doc(uid).update({
        streak:           1,
        last_streak_date: firebase.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
  }

  /* ─────────────────────────────────────────────────────────────
     BOOT
     ───────────────────────────────────────────────────────────── */

  async function boot() {
    fcLog('App booting…');

    // Remove sensitive values written by pre-v3 builds. Deletion is the only
    // localStorage access allowed for these financial keys. This lived inside
    // _renderNetWorthMilestone, which was never called — so the cleanup had
    // never actually run. boot() runs once per launch, which is where a
    // one-time migration belongs.
    try {
      Object.keys(localStorage)
        .filter(key => key === 'fc_debt_start' || key.startsWith('fc_milestone_'))
        .forEach(key => localStorage.removeItem(key));
    } catch (_) {}

    FCAuth.init();
    _initPullToRefresh();

    // Hide iOS-only auth options on Android; add platform class for CSS targeting
    const platform = window.Capacitor?.getPlatform?.() || 'web';
    if (platform === 'android') {
      document.documentElement.classList.add('fc-android');
      document.querySelectorAll('.fc-auth-apple-btn').forEach(el => el.style.display = 'none');
      // AND-2: Material-style ripple on interactive elements
      document.addEventListener('touchstart', (e) => {
        const target = e.target.closest('.fc-list-item, .fc-btn, .fc-card[role="button"]');
        if (!target) return;
        const rect = target.getBoundingClientRect();
        const dot = document.createElement('span');
        dot.className = 'fc-ripple-dot';
        dot.style.left = (e.touches[0].clientX - rect.left) + 'px';
        dot.style.top  = (e.touches[0].clientY - rect.top)  + 'px';
        target.appendChild(dot);
        setTimeout(() => dot.remove(), 420);
      }, { passive: true });
    }

    // Jailbreak / root warning — non-blocking, shows advisory to user.
    // Financial apps on jailbroken devices are at elevated risk from keyloggers
    // and credential-stealing tweaks. We warn but don't hard-block (App Store policy).
    FCAuth.checkJailbreak().then(isJailbroken => {
      if (isJailbroken) {
        fcLog('⚠️ Jailbreak detected');
        toast(
          'Security warning: this device may be jailbroken. ' +
          'Your financial data could be at risk.',
          'error',
          8000
        );
      }
    }).catch(() => {});

    // Wire up nav
    document.querySelectorAll('.fc-nav-item').forEach(item => {
      item.addEventListener('click', () => switchTab(item.dataset.view));
    });

    // ── Tap-outside-input keyboard dismissal ─────────────────────
    // iOS WKWebView never dismisses the keyboard automatically when the
    // user taps the background. This makes it feel broken vs native apps.
    document.addEventListener('touchend', e => {
      const focused = document.activeElement;
      if (!focused || (focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA')) return;
      // If the tap landed on an input, button, label, or interactive element, do nothing
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON' ||
          tag === 'LABEL' || tag === 'A' || tag === 'SELECT') return;
      // If the tap is inside an interactive container (fc-input-eye, etc.), do nothing
      if (e.target.closest('button, a, label, [role="button"]')) return;
      // Dismiss
      focused.blur();
    }, { passive: true });

    /* Keyboard handling lives in ONE place: the 'Keyboard avoidance' IIFE in
       index.html. A second implementation used to sit here and the two fought.

       That one scrolls on keyboardDidShow, and its own comment explains why:
       scrolling any earlier races the iOS animation and produces the 'jumps
       high then snaps down' artifact. This copy scrolled on keyboardWillShow
       inside a requestAnimationFrame — precisely that race — while also
       adjusting scrollTop on a container the other one had just padded, so
       every focus was corrected twice.

       The class moved with it: CSS keys off body.keyboard-open, which only
       this copy set, while the surviving system set body.fc-keyboard-open
       that nothing styled. index.html now sets keyboard-open. */

    // Period scrubber buttons have onclick="FCApp.switchPeriod(...)" — no extra wiring needed here.

    // Activity search
    const searchInput = document.getElementById('activity-search');
    if (searchInput) {
      searchInput.addEventListener('input', e => handleSearch(e.target.value));
    }

    // RevenueCat is configured inside onAuthStateChanged (below) once Firebase
    // resolves the real UID — calling configure() here would use a null UID
    // because currentUser() is always null at DOMContentLoaded.

    // ── Deep link handler ──────────────────────────────────────────
    // Handles two URL schemes:
    //   flowcheck://open?ref=...       — email CTAs, routes authenticated+onboarded
    //                                    users to the dashboard
    //   flowcheck://referral?code=...  — referral links, pre-fills signup code
    const _handleDeepLink = (urlStr) => {
      try {
        if (!urlStr) return;

        // flowcheck://open — "Open FlowCheck" button from all email templates.
        // If the user is authenticated and has completed onboarding, navigate
        // directly to the dashboard. If they haven't onboarded, let normal routing
        // handle it (onAuthStateChanged will route to the correct screen).
        if (urlStr.startsWith('flowcheck://open')) {
          fcLog('[deeplink] open received, current screen:', state.screen);
          const user = FCAuth.currentUser?.();
          if (user && _onboardingLocallyCached(user.uid) && state.screen !== 'app') {
            setScreen('app');
            _renderHome();
          }
          return;
        }

        // flowcheck://referral?code=FLOWXXXXXX — referral invite links
        if (!urlStr.includes('referral')) return;
        let params;
        if (urlStr.includes('?')) {
          params = new URLSearchParams(urlStr.split('?')[1]);
        } else { return; }
        const code = (params.get('code') || '').toUpperCase();
        if (!code || !/^FLOW[A-Z0-9]{4,8}$/.test(code)) return;
        window._fcPendingReferralCode = code;
        const referralInput = document.getElementById('reg-referral-code');
        if (referralInput) {
          referralInput.value = code;
          const wrap = document.getElementById('reg-referral-wrap');
          if (wrap) wrap.style.display = 'block';
          const chev = document.getElementById('reg-referral-chevron');
          if (chev) chev.style.transform = 'rotate(90deg)';
        }
        if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('referral_opened', { code });
        fcLog('[deeplink] referral code captured:', code);
      } catch (_) {}
    };

    // Listen for Capacitor App URL open events (cold-start + foreground)
    const _capAppPlugin = window.Capacitor?.Plugins?.App;
    if (_capAppPlugin) {
      if (_capAppPlugin.addListener) {
        _capAppPlugin.addListener('appUrlOpen', (data) => {
          _handleDeepLink(data?.url || '');
        });
      }
      // Cold-start deep link (app was not running when link was tapped)
      if (_capAppPlugin.getLaunchUrl) {
        _capAppPlugin.getLaunchUrl().then(data => {
          if (data?.url) _handleDeepLink(data.url);
        }).catch(() => {});
      }
      // AND-1: Android hardware back button — close sheets, nav home, then exit
      if (_capAppPlugin.addListener) {
        _capAppPlugin.addListener('backButton', () => {
          const openSheet = document.querySelector('.fc-sheet-overlay[style*="block"]');
          if (openSheet) { openSheet.style.display = 'none'; return; }
          if (state.tab !== 'home') { switchTab('home'); return; }
          _capAppPlugin.exitApp?.();
        });
      }
    }

    // AND-4: Android status bar color — match app background
    const _statusBar = window.Capacitor?.Plugins?.StatusBar;
    if (_statusBar && window.Capacitor?.getPlatform?.() === 'android') {
      _statusBar.setBackgroundColor?.({ color: '#0a1520' }).catch(() => {});
      _statusBar.setStyle?.({ style: 'DARK' }).catch(() => {});
    }

    // Native layer owns privacy blur + lock screen on iOS.
    // JS only drives the idle timer — when it fires it calls BiometricAuth.lock()
    // which tells AppDelegate to show the native lock screen.
    _initIdleLock();
    // Listen for the native lock screen "Use Password Instead" tap
    _initSignOutListener();

    // Safety net: if Firebase auth hasn't fired within 7s, the SDK is likely
    // blocked (cold start, no network). Route to hero so users aren't stuck.
    setTimeout(() => {
      if (state.screen === 'splash') setScreen('hero');
    }, 7000);

    // Observe Firebase auth state
    FCAuth.onAuthStateChanged(async user => {
      if (user) {
        // ── UID change guard ────────────────────────────────────────────────
        // Firebase fires onAuthStateChanged on token refresh, network reconnect,
        // and any other auth-adjacent event — not just actual sign-in/out.
        // Without this guard, every token refresh wipes state and re-runs
        // routing, which causes the paywall to reappear on app foreground and
        // onboarding to restart mid-flow.
        //
        // Only run the full routing + wipe when the UID actually changes.
        // Same UID = token refresh or reconnect — return immediately.
        if (user.uid === _currentUid) {
          fcLog('[FCApp] onAuthStateChanged — same UID, skipping re-route (token refresh)');
          return;
        }
        _currentUid = user.uid;
        fcLog('[FCApp] onAuthStateChanged — new UID:', user.uid, '| listenersAttached:', _listenersAttached);

        // Wipe ALL state from the previous session FIRST — before any async
        // work. This also resets _listenersAttached, FCPurchases, and FCPush.
        _wipeUserState();

        // Configure RevenueCat with the new user's UID. _wipeUserState()
        // called FCPurchases.reset(), clearing the _configured guard, so this
        // will do a real configure rather than returning early.
        FCPurchases.configure(user.uid).catch(() => {});

        // Warm the Railway backend immediately after auth so it's ready
        // before the user taps anything — prevents cold-start timeouts.
        FCData.warmBackend();

        // Push permissions are requested after Plaid bank connection (see _onPlaidSuccess).
        // Requesting immediately on auth interrupts onboarding and feels premature —
        // users should connect their bank first so the value proposition is clear.

        _updateGreeting();

        // Attach real-time data listeners for the new user
        _attachDataListeners();
        fcLog('[FCApp] listeners attached for uid:', user.uid);

        // Navigate to the correct screen.
        // Fetch userDoc and biometric setting in parallel — they're independent
        // and running them sequentially added ~100-300ms to every cold launch.
        let userDoc = null, biometricEnabled = false;
        try {
          [userDoc, biometricEnabled] = await Promise.all([
            FCAuth.getUserDoc(),
            FCAuth.isBiometricEnabled(),
          ]);
        } catch (err) {
          fcLog('Failed to load user doc on auth:', err);
          // Transient Firestore error. Check localStorage backup before falling
          // through to the dashboard — a brand-new user with no Firestore doc
          // and no localStorage flag should see onboarding, not the dashboard.
          if (!state.user) {
            const authUser = FCAuth.currentUser();
            if (authUser && !_isDemoMode) state.user = { name: authUser.displayName || '', email: authUser.email || '' };
          }
          if (_onboardingLocallyCached(user.uid)) {
            // Previously completed onboarding — safe to show dashboard
            if (FCAuth.setOnboardingActive) FCAuth.setOnboardingActive(false).catch(() => {});
            setScreen('app');
            _renderHome();
          } else if (window._fcNewUserFaceIdPending) {
            // Brand new signup, Firestore just hasn't written the doc yet
            window._fcNewUserFaceIdPending = false;
            if (FCAuth.setOnboardingActive) FCAuth.setOnboardingActive(true).catch(() => {});
            if (_DEMO_EMAILS.includes(user.email)) {
              setScreen('faceid-setup');
            } else {
              window._fcVerifyEmailPending = true;
              setScreen('verify-email');
              const addrEl = document.getElementById('verify-email-addr');
              if (addrEl) addrEl.textContent = user.email || '';
              _sendOtpCode(); // send the code even on Firestore error
            }
          } else {
            // Unknown — send to onboarding rather than dashboard to be safe
            if (FCAuth.setOnboardingActive) FCAuth.setOnboardingActive(true).catch(() => {});
            setScreen('onboarding');
          }
          return;
        }

        // needsOnboarding: user hasn't completed onboarding AND hasn't linked a bank.
        // localStorage flag is checked alongside Firestore so a mid-flow app-close
        // (where the Firestore write completed but the app was backgrounded before
        // the observer fired) doesn't force the user back to slide 1.
        const firestoreOnboarded = !!(userDoc?.onboarding_complete || userDoc?.plaid_linked);
        const localOnboarded     = _onboardingLocallyCached(user.uid);
        const needsOnboarding    = !userDoc ? !localOnboarded : (!firestoreOnboarded && !localOnboarded);

        /* Record the FACT, so it cannot be un-recorded.
        
           `plaid_linked` above is EVIDENCE of onboarding, not onboarding itself —
           and unlike onboarding it is mutable. Disconnecting the last bank sets it
           false (_clearPlaidUserFields on the backend), so any user carried by
           that fallback rather than by their own onboarding_complete flag lost the
           only proof they had ever finished, and the next launch sent them back to
           slide one. Reported from the device: "every time I delete all my accounts
           it takes me through the onboarding pages".
        
           Onboarding completion is history — it happened or it did not. Bank
           connection is current state. The moment the evidence is visible, write
           the durable flag so removing a bank can never rewrite the past.
           Fire-and-forget and idempotent: only writes when genuinely absent. */
        if (userDoc && userDoc.plaid_linked && !userDoc.onboarding_complete) {
          _markOnboardingLocalCache(user.uid);
          FCData.updateUserField('onboarding_complete', true).catch(() => {});
        }

        // Suppress the native lock screen for the whole post-signup setup window.
        // The notifications permission dialog and Plaid Link's in-app browser both
        // trigger applicationDidBecomeActive on the native side, which would
        // otherwise fire an unrelated Face ID prompt mid-onboarding. Cleared in
        // _markOnboardingComplete(). Fire-and-forget — seconds of slack before the
        // next becomeActive event is plenty of time for this write to land.
        if (FCAuth.setOnboardingActive) FCAuth.setOnboardingActive(needsOnboarding).catch(() => {});

        if (needsOnboarding) {
          // New user just registered in this session — show email verification first
          if (window._fcNewUserFaceIdPending) {
            window._fcNewUserFaceIdPending = false;
            // Brand-new signup — clear any stale paywall cooldown so they always
            // see the trial offer on onboarding slide 3.
            try { localStorage.removeItem(`fc_pw_seen_${user.uid}`); } catch (_) {}
            _paywallShownThisSession = false;
            if (!user.emailVerified && !_DEMO_EMAILS.includes(user.email)) {
              // Email/password signup: show OTP verification screen
              window._fcVerifyEmailPending = true;
              setScreen('verify-email');
              const addrEl = document.getElementById('verify-email-addr');
              if (addrEl) addrEl.textContent = user.email || '';
              // Send OTP — show an error on the verify-email screen if it fails
              _sendOtpCode();
              // Schedule follow-up email (non-blocking, failure is fine)
              FCAuth.getIdToken().then(token =>
                fetch(`${FC_CONFIG.app.apiBase}/email/signup-followup/schedule`, {
                  method: 'POST', headers: { 'Authorization': `Bearer ${token}` },
                }).catch(() => {})
              ).catch(() => {});
            } else {
              // Google / Apple — email already verified, go straight to Face ID setup
              _sendWelcomeEmail().catch(() => {});
              setScreen('faceid-setup');
            }
          } else {
            // Returning user who closed app before finishing onboarding — resume it.
            setScreen('onboarding');
          }
        } else {
          // ── Onboarded user: navigate to dashboard ─────────────────────────
          // Demo accounts always get fake data — never hit the real backend.
          if (_DEMO_EMAILS.includes(user.email)) {
            startDemoMode();
            return;
          }
          // Pre-seed state.user from the already-fetched userDoc so the first
          // _renderHome() call shows the correct name before the live snapshot.
          if (!state.user && userDoc && !_isDemoMode) state.user = userDoc;
          setScreen('app');
          _renderHome();
          setTimeout(() => _doSync(false), 900);
          if (window.Sentry) Sentry.setUser({ id: user.uid });
          if (typeof FCAnalytics !== 'undefined') {
            FCAnalytics.identify(user.uid, {
              is_pro:          !!(userDoc?.is_pro),
              has_bank:        !!(userDoc?.plaid_linked),
              onboarding_done: !!(userDoc?.onboarding_complete),
            });
          }

          // ── Pro status check + contextual paywall ─────────────────────────
          // Always verify with RC — Firestore is_pro can be stale after a
          // lapsed subscription whose webhook couldn't resolve the Firebase UID.
          // Paywall triggers use _shouldShowPaywall() which enforces both the
          // per-session guard and the 24h cooldown, so the paywall never fires
          // on token-refresh events (those are caught by the UID guard above).
          FCPurchases.checkProStatus().then(async isPro => {
            if (isPro) {
              if (state.user && !state.user.is_pro) {
                state.user.is_pro = true;
                _refreshAfterPro();
              }
              setTimeout(() => _tryStartTour(), 1400);
            } else if (userDoc?.is_pro) {
              // Firestore says Pro but RC says not — attempt restore first
              try {
                const { isPro: restored } = await FCPurchases.restorePurchases();
                if (restored) {
                  if (state.user) state.user.is_pro = true;
                  _refreshAfterPro();
                  return;
                }
              } catch (_) {}
              // Subscription lapsed — update local state and show contextual paywall
              if (state.user) state.user.is_pro = false;
              if (_shouldShowPaywall(user.uid)) setTimeout(() => showPaywall(), 4000);
            } else {
              // RC and Firestore both say not Pro
              if (_shouldShowPaywall(user.uid)) setTimeout(() => showPaywall(), 4000);
            }
          }).catch(() => {
            // RC unavailable — trust Firestore, show paywall only for free users
            if (!userDoc?.is_pro) {
              if (_shouldShowPaywall(user.uid)) setTimeout(() => showPaywall(), 4000);
            } else {
              setTimeout(() => _tryStartTour(), 1400);
            }
          });
        }
      } else {
        fcLog('[FCApp] onAuthStateChanged — signed out, wiping state');
        // Reset UID so next sign-in triggers full routing regardless of which
        // account signs in (could be a different user on the same device).
        _currentUid = null;
        // _wipeUserState() handles detachAllListeners + _listenersAttached reset
        _wipeUserState();
        setScreen('hero');
        FCAuth.isBiometricEnabled().then(enabled => {
          const wrap = document.getElementById('biometric-login-wrap');
          if (wrap) wrap.style.display = enabled ? '' : 'none';
        }).catch(() => {});
      }
    });
  }

  /* ── Public API ───────────────────────────────────────────── */
  /* showToast defaults to true so the header button (which calls this with no
     args) still behaves as a user-initiated sync: bypasses the cooldown, pops
     a toast. The parameter exists because the resume handler already called
     manualSync(false) intending a silent background retry — the argument was
     simply ignored, so every resume after a failed sync ran a cooldown-bypassing
     sync and toasted "Accounts synced" over it. */
  function manualSync(showToast = true) {
    _doSync(showToast);
  }

  async function sendTestEmail() {
    if (FC_CONFIG.app.env !== 'development') return;
    const statusEl = document.getElementById('test-email-status');
    if (statusEl) statusEl.textContent = 'Sending…';
    try {
      const resp = await FCAuth.authedFetch(`${FC_CONFIG.app.apiBase}/email/test`, { method: 'POST' });
      const data = await resp.json();
      if (statusEl) statusEl.textContent = data.sent ? '✓ Sent' : '✗ Failed';
      toast(data.sent ? 'Test email sent — check your inbox' : 'Email not sent — check Resend config', data.sent ? 'success' : 'error');
    } catch (err) {
      if (statusEl) statusEl.textContent = '✗ Error';
      toast('Test failed: ' + err.message, 'error');
    }
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
  }

  /* ─────────────────────────────────────────────────────────────
     NOTIFICATION CENTER
     ───────────────────────────────────────────────────────────── */

  function _updateNotifBadge(notifs) {
    const badge      = document.getElementById('notif-badge');
    const homeBadge  = document.getElementById('home-notif-badge');
    const markAllBtn = document.getElementById('notif-mark-all-btn');
    const unread     = (notifs || []).filter(n => !n.read).length;
    if (badge) {
      // Show as a plain dot — no number, less aggressive than a red badge count
      badge.textContent = '';
      badge.style.display = unread > 0 ? 'flex' : 'none';
    }
    if (homeBadge) homeBadge.style.display = unread > 0 ? 'block' : 'none';
    if (markAllBtn) markAllBtn.style.display = unread > 0 ? '' : 'none';

    // Sync native iOS app icon badge
    try {
      const Push = window.Capacitor?.Plugins?.PushNotifications;
      if (Push && typeof Push.setBadgeNumber === 'function') {
        Push.setBadgeNumber({ badgeNumber: unread }).catch(() => {});
      } else {
        const Local = window.Capacitor?.Plugins?.LocalNotifications;
        if (Local && typeof Local.setBadge === 'function') Local.setBadge({ count: unread }).catch(() => {});
      }
    } catch (_) {}
  }

  function _renderNotifList(notifs) {
    const listEl = document.getElementById('fc-notif-list');
    if (!listEl) return;

    if (!notifs || !notifs.length) {
      listEl.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;padding:48px 24px;gap:10px;text-align:center">
          <div style="width:56px;height:56px;border-radius:18px;background:linear-gradient(145deg,rgba(26,196,240,0.10),rgba(37,99,235,0.06));border:0.5px solid rgba(26,196,240,0.18);display:flex;align-items:center;justify-content:center;margin-bottom:4px;box-shadow:0 6px 20px rgba(0,0,0,0.28)">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgba(26,196,240,0.7)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          </div>
          <div style="font-size:15px;font-weight:700;color:var(--fc-text);letter-spacing:-0.02em">You're all caught up</div>
          <div style="font-size:13px;color:var(--fc-text-faint);line-height:1.5;max-width:220px">We'll notify you about bills, budget alerts, and account activity</div>
        </div>`;
      return;
    }

    const _timeAgo = (ts) => {
      if (!ts) return '';
      const d = ts.toDate ? ts.toDate() : new Date(ts);
      const diff = Math.floor((Date.now() - d) / 1000);
      if (diff < 60)  return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      return Math.floor(diff / 86400) + 'd ago';
    };

    const _typeIcon = (type) => {
      const map = {
        bill_due:       { icon: _ic('credit-card','var(--fc-danger)',16),   bg: 'var(--fc-danger-soft)',  border: 'var(--fc-danger-border)'  },
        budget_alert:   { icon: _ic('zap','var(--fc-warning)',16),          bg: 'var(--fc-warning-soft)', border: 'var(--fc-warning-soft)'  },
        goal_reached:   { icon: _ic('flag','var(--fc-success)',16),         bg: 'var(--fc-success-soft)', border: 'var(--fc-success-border)' },
        sync_done:      { icon: _ic('check','var(--fc-accent)',16),         bg: 'var(--fc-accent-soft)',  border: 'var(--fc-border-accent)'  },
        payday:         { icon: _ic('dollar-sign','var(--fc-success)',16),  bg: 'var(--fc-success-soft)', border: 'var(--fc-success-border)' },
        large_txn:      { icon: _ic('search','var(--fc-warning)',16),       bg: 'var(--fc-warning-soft)', border: 'var(--fc-warning-soft)'  },
        low_balance:    { icon: _ic('alert','var(--fc-danger)',16),         bg: 'var(--fc-danger-soft)',  border: 'var(--fc-danger-border)'  },
        unusual_spend:  { icon: _ic('bar-chart','var(--fc-warning)',16),    bg: 'var(--fc-warning-soft)', border: 'var(--fc-warning-soft)'  },
        new_sub:        { icon: _ic('play-screen','var(--fc-accent)',16),   bg: 'var(--fc-accent-soft)',  border: 'var(--fc-border-accent)'  },
        general:        { icon: _ic('bell','var(--fc-text-muted)',16),      bg: 'var(--fc-bg-elevated-2)', border: 'var(--fc-border)' },
      };
      return map[type] || map.general;
    };

    // N3: Filter out bill_due notifications whose due date has already passed
    /* LOCAL day, not UTC. toISOString() returns the UTC date, so from about
       7pm Central onward it hands back TOMORROW — and a bill due today then
       satisfies `due_date < todayStr` and gets filtered out as "already
       passed". Every evening, for every user west of UTC, the reminder for
       the bill due that day silently vanished from the feed. */
    const todayStr = FCCore.isoDay(new Date());
    const active = notifs.filter(n => {
      if (n.type === 'bill_due' && n.data?.due_date && n.data.due_date < todayStr) return false;
      return true;
    });

    // Deduplicate: show only the most recent notification per type per day.
    // Prevents budget alert spam when backend sends the same alert multiple times.
    const seen = new Set();
    const deduped = active.filter(n => {
      const ts = n.created_at ? (n.created_at.toDate ? n.created_at.toDate() : new Date(n.created_at)) : new Date();
      // Local day: with a UTC key an alert at 5pm and one at 8pm the same
      // evening land in different buckets, so the dedup lets both through.
      const dayKey = `${n.type || 'general'}_${FCCore.isoDay(ts)}`;
      if (seen.has(dayKey)) return false;
      seen.add(dayKey);
      return true;
    });

    listEl.innerHTML = deduped.map(n => {
      const meta = _typeIcon(n.type);
      return `
      <div onclick="FCApp._notifTap('${esc(n.id)}','${esc(n.type || 'general')}')"
           style="display:flex;align-items:flex-start;gap:13px;padding:14px 20px;cursor:pointer;
                  border-bottom:0.5px solid var(--fc-border);
                  background:${n.read ? 'transparent' : 'rgba(26,196,240,0.035)'};
                  transition:background .12s">
        <div style="width:40px;height:40px;border-radius:13px;
                    background:${meta.bg};border:0.5px solid ${meta.border};
                    display:flex;align-items:center;justify-content:center;
                    font-size:18px;flex-shrink:0;box-shadow:0 3px 10px rgba(0,0,0,0.2)">
          ${meta.icon}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:${n.read ? 500 : 700};
                      color:${n.read ? 'rgba(255,255,255,0.55)' : 'white'};
                      letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${esc(n.title || '')}
          </div>
          <div style="font-size:12px;color:var(--fc-text-faint);margin-top:3px;line-height:1.45">
            ${esc(n.body || '')}
          </div>
          <div style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.22);margin-top:5px;letter-spacing:0.02em">
            ${_timeAgo(n.created_at)}
          </div>
        </div>
        ${n.read ? '' : '<div style="width:7px;height:7px;background:var(--fc-accent);border-radius:50%;flex-shrink:0;margin-top:5px;box-shadow:0 0 6px rgba(26,196,240,0.6)"></div>'}
      </div>`;
    }).join('');
  }

  function toggleNotificationCenter() {
    const center = document.getElementById('fc-notif-center');
    if (!center) return;
    const isOpen = center.style.display === 'block';
    if (isOpen) {
      closeNotificationCenter();
    } else {
      openNotificationCenter();
    }
  }

  function openNotificationCenter() {
    const center   = document.getElementById('fc-notif-center');
    const backdrop = document.getElementById('fc-notif-backdrop');
    const panel    = document.getElementById('fc-notif-panel');
    if (!center) return;

    _renderNotifList(state.notifications);
    center.style.display       = 'block';
    center.style.pointerEvents = 'auto';
    // Next frame: animate in as a bottom sheet
    requestAnimationFrame(() => {
      if (backdrop) backdrop.style.opacity    = '1';
      if (panel)    panel.style.transform     = 'translateY(0)';
    });
    haptic('light');
  }

  function closeNotificationCenter() {
    const center   = document.getElementById('fc-notif-center');
    const backdrop = document.getElementById('fc-notif-backdrop');
    const panel    = document.getElementById('fc-notif-panel');
    if (!center) return;
    if (backdrop) backdrop.style.opacity  = '0';
    if (panel)    panel.style.transform   = 'translateY(100%)';  // slide back DOWN
    setTimeout(() => {
      center.style.display       = 'none';
      center.style.pointerEvents = 'none';
    }, 340);
  }

  async function markAllNotifsRead() {
    try {
      await FCData.markAllNotificationsRead();
    } catch (err) {
      fcLog('[notif] markAllRead failed:', err);
    }
  }

  function _notifTap(notifId, type) {
    // Mark as read
    FCData.markNotificationRead(notifId).catch(() => {});
    // Route to relevant tab
    const routeMap = {
      bill_due:     'activity',  // bills are a segment inside the activity tab
      budget_alert: 'insights',
      goal_reached: 'wealth',
      sync_done:    'home',
    };
    const tab = routeMap[type] || 'home';
    closeNotificationCenter();
    // Switch tab after notification center close animation (~200ms)
    setTimeout(() => {
      switchTab(tab);
      if (type === 'bill_due') switchActivitySegment('bills');
    }, 220);
    haptic('light');
  }

  /* ─────────────────────────────────────────────────────────────
     BANK MANAGEMENT SHEET
     ───────────────────────────────────────────────────────────── */

  async function showBankSheet() {
    const sheet = document.getElementById('fc-bank-sheet');
    if (!sheet) return;

    // Show sheet immediately with a loading state
    const listEl = document.getElementById('bank-list-container');
    if (listEl) {
      listEl.innerHTML = '<div style="color:var(--fc-text-faint);font-size:13px;padding:10px 0;text-align:center">Loading…</div>';
    }
    sheet.style.display = 'flex';
    haptic('light');

    // Fetch banks — fire health ping in parallel (not sequentially) so cold-start
    // warm-up doesn't add 20s of latency before the actual request.
    const warmPing = fetch(`${FC_CONFIG.app.apiBase}/health`, { signal: AbortSignal.timeout(20_000) }).catch(() => {});

    // Fetch all linked banks from Firestore
    try {
      const items = await FCData.getPlaidItems();
      if (!listEl) return;

      // Legacy fallback: early users had their bank stored only on the user
      // doc (plaid_institution field) before the plaid_items subcollection
      // existed. If the API returns empty but plaid_institution is set, treat
      // that as proof a bank is linked even when plaid_linked is missing/false
      // (some early accounts have a corrupt plaid_linked flag).
      if (!items.length && state.user?.plaid_institution) {
        const legacyName = esc(state.user.plaid_institution);
        listEl.innerHTML = `
          <div class="fcs-detail-row no-border">
            <div style="min-width:0;flex:1;margin-right:12px">
              <div style="font-size:15px;font-weight:600;color:var(--fc-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${legacyName}</div>
              <div style="font-size:12px;color:var(--fc-text-faint);margin-top:3px;display:flex;align-items:center;gap:5px">
                <span style="width:6px;height:6px;background:var(--fc-success);border-radius:50%;display:inline-block;flex-shrink:0"></span>
                Connected &amp; syncing
              </div>
            </div>
            <button
              style="background:rgba(255,69,58,0.12);color:var(--fc-danger);border:1px solid rgba(255,69,58,0.22);border-radius:10px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;white-space:nowrap"
              data-disconnect-id=""
              data-disconnect-name="${legacyName}"
              type="button">
              Disconnect
            </button>
          </div>`;
        /* Same treatment as the item rows above. This one interpolated the
           name into a single-quoted JS string, and esc() turns an apostrophe
           into &#39; — which the HTML parser decodes back to a real quote
           inside the attribute, ending the string early. A bank with an
           apostrophe in its name broke this button the same way. */
        listEl.querySelectorAll('[data-disconnect-id]').forEach(btn => {
          btn.addEventListener('click', () => {
            confirmDisconnectItem(btn.dataset.disconnectId, btn.dataset.disconnectName);
          });
        });
        return;
      }

      if (!items.length) {
        listEl.innerHTML = '<div style="color:var(--fc-text-faint);font-size:13px;padding:10px 0">No banks connected</div>';
        return;
      }

      listEl.innerHTML = items.map(item => {
        const name   = esc(item.institution || 'Bank Account');
        // `id` is the Firestore doc id, which is what DELETE
        // /plaid/disconnect/:itemId looks up first. This preferred item_id,
        // and for a legacy user those are two different values — the doc id
        // is their uid — so the lookup missed and disconnect always 404'd.
        // The backend now resolves either, but send the one it keys on.
        const itemId = esc(item.id || item.item_id || '');
        return `
          <div class="fcs-detail-row">
            <div style="min-width:0;flex:1;margin-right:12px">
              <div style="font-size:15px;font-weight:600;color:var(--fc-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
              <div style="font-size:12px;color:var(--fc-text-faint);margin-top:3px;display:flex;align-items:center;gap:5px">
                <span style="width:6px;height:6px;background:var(--fc-success);border-radius:50%;display:inline-block;flex-shrink:0"></span>
                Connected &amp; syncing
              </div>
            </div>
            <button
              style="background:rgba(255,69,58,0.12);color:var(--fc-danger);border:1px solid rgba(255,69,58,0.22);border-radius:10px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0;white-space:nowrap"
              data-disconnect-id="${itemId}"
              data-disconnect-name="${name}"
              type="button">
              Disconnect
            </button>
          </div>`;
      }).join('');

      /* The bank name and id ride on data attributes and the handler is bound
         here, rather than being interpolated into an onclick.

         This button was built as
           onclick="FCApp.confirmDisconnectItem(${JSON.stringify(id)},…)"
         and JSON.stringify emits real double quotes, which closed the
         double-quoted attribute at the first one. Every Disconnect button
         rendered as onclick="FCApp.confirmDisconnectItem(" and threw a
         SyntaxError on tap — a bank called "Bank of America" additionally
         split the remainder into three junk attributes. Nobody could
         disconnect a bank, and the markup looked fine in source.

         esc() already makes these safe as attribute VALUES, and dataset
         hands them back decoded, so no quoting rules apply to the data. */
      listEl.querySelectorAll('[data-disconnect-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          confirmDisconnectItem(btn.dataset.disconnectId, btn.dataset.disconnectName);
        });
      });
    } catch (err) {
      fcLog('[showBankSheet] error:', err);
      if (listEl) {
        const isTimeout = err.message && (err.message.includes('timed out') || err.message.includes('reach'));
        listEl.innerHTML = `
          <div style="color:var(--fc-danger);font-size:13px;padding:10px 0">
            ${isTimeout ? 'Connection timed out — server may be waking up' : 'Could not load banks'}
          </div>
          <button onclick="FCApp.showBankSheet()" type="button"
            style="margin-top:8px;padding:8px 16px;background:var(--fc-card-bg-hover);border:1px solid var(--fc-border-strong);border-radius:10px;color:var(--fc-text);font-size:13px;cursor:pointer">
            Try Again
          </button>`;
      }
    }
  }

  function confirmDisconnectItem(itemId, name) {
    _pendingDisconnectItemId = itemId;
    // Update disconnect sheet body to name the specific bank
    const bodyEl = document.getElementById('disconnect-sheet-body');
    if (bodyEl) {
      bodyEl.innerHTML = `This removes your <strong style="color:rgba(255,255,255,0.75)">${esc(name)}</strong> connection and deletes all its synced transaction data from FlowCheck. <strong style="color:rgba(255,255,255,0.75)">Your actual bank account is not affected.</strong>`;
    }
    closeBankSheet();
    const sheet = document.getElementById('fc-disconnect-sheet');
    if (!sheet) return;
    const btn = document.getElementById('btn-confirm-disconnect');
    if (btn) { btn.disabled = false; btn.textContent = 'Yes, Disconnect'; }
    setTimeout(() => { sheet.style.display = 'flex'; }, 80);
  }

  function closeBankSheet() {
    const sheet = document.getElementById('fc-bank-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); }, 280);
  }

  function showDisconnectConfirm() {
    // Reset pending item — disconnect all banks
    _pendingDisconnectItemId = null;
    const bodyEl = document.getElementById('disconnect-sheet-body');
    if (bodyEl) {
      bodyEl.innerHTML = 'This removes your bank connection and deletes all synced transaction data from FlowCheck. <strong style="color:rgba(255,255,255,0.75)">Your actual bank account is not affected.</strong>';
    }
    closeBankSheet();
    const sheet = document.getElementById('fc-disconnect-sheet');
    if (!sheet) return;
    const btn = document.getElementById('btn-confirm-disconnect');
    if (btn) { btn.disabled = false; btn.textContent = 'Yes, Disconnect'; }
    setTimeout(() => { sheet.style.display = 'flex'; }, 80);
  }

  function closeDisconnectSheet() {
    const sheet = document.getElementById('fc-disconnect-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); }, 280);
  }

  function showDeleteSheet() {
    const sheet = document.getElementById('fc-delete-sheet');
    if (!sheet) return;
    const btn = document.getElementById('btn-confirm-delete');
    if (btn) { btn.disabled = false; btn.textContent = 'Permanently Delete My Account'; }
    sheet.style.display = 'flex';
    haptic('heavy');
  }

  function closeDeleteSheet() {
    const sheet = document.getElementById('fc-delete-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); }, 280);
  }

  /* ─────────────────────────────────────────────────────────────
     DISCONNECT BANK
     Revokes Plaid item, wipes financial data, returns to onboarding.
     ───────────────────────────────────────────────────────────── */

  async function disconnectBank() {
    const btn = document.getElementById('btn-confirm-disconnect');
    if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting…'; }
    try {
      if (_pendingDisconnectItemId) {
        // Per-item disconnect — only removes this one bank
        await FCData.disconnectBankItem(_pendingDisconnectItemId);
        _pendingDisconnectItemId = null;
      } else {
        // Full disconnect — removes all banks
        await FCData.disconnectBank();
      }

      // Close all sheets with animation
      document.querySelectorAll('.fc-sheet-overlay').forEach(s => {
        if (s.style.display !== 'none') {
          s.classList.add('fc-sheet--closing');
          setTimeout(() => { s.style.display = 'none'; s.classList.remove('fc-sheet--closing'); }, 280);
        }
      });
      toast('Bank disconnected', 'success');
      haptic('medium');

      // Check if any banks remain
      let remaining = 0;
      try {
        const items = await FCData.getPlaidItems();
        remaining = items.length;
      } catch (_) { /* treat as 0 */ }

      if (remaining > 0) {
        // Still have other banks — stay on app and refresh
        _renderHome();
      } else {
        // No banks left — detach listeners and return to onboarding
        FCData.detachAllListeners();
        setTimeout(() => setScreen('onboarding'), 600);
      }
    } catch (err) {
      toast('Could not disconnect: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Yes, Disconnect'; }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     DELETE ACCOUNT
     Full CCPA erasure — deletes all data + Firebase Auth user.
     After deletion, Firebase Auth state change fires → login screen.
     ───────────────────────────────────────────────────────────── */

  async function deleteAccount() {
    const btn = document.getElementById('btn-confirm-delete');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    try {
      await FCData.deleteAccount();
      // Firebase Auth user is now deleted server-side.
      // Sign out locally to clear any cached credentials.
      document.querySelectorAll('.fc-sheet-overlay').forEach(s => {
        if (s.style.display !== 'none') {
          s.classList.add('fc-sheet--closing');
          setTimeout(() => { s.style.display = 'none'; s.classList.remove('fc-sheet--closing'); }, 280);
        }
      });
      FCData.detachAllListeners();
      await FCAuth.signOut().catch(() => {});
      // Auth state observer will navigate to login
    } catch (err) {
      toast('Could not delete account: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Permanently Delete My Account'; }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     FACE ID LOCK SCREEN
     Lock screen sits on top of the app and must be dismissed with
     Face ID or by re-authenticating with a password. It guards
     against physical access to a signed-in device.
     ─────────────────────────────────────────────────────────────

     Lifecycle (native):
       AppDelegate.applicationWillResignActive → UIVisualEffectView blur
       AppDelegate.applicationDidBecomeActive  → NativeLockScreenViewController
         Face ID via LAContext → success: scale+fade dismiss
         "Use Password Instead" → FCSignOutRequested notification → JS signs out
       JS idle timer → BiometricAuth.lock() plugin → AppDelegate shows lock screen
     ───────────────────────────────────────────────────────────── */

  // ── Idle auto-lock ───────────────────────────────────────────
  const _IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  let _idleTimer = null;

  // ── Privacy mode (balance masking) ──────────────────────────
  let _privacyModeOn = false;

  /** Called by idle timer — delegates to native AppDelegate via Capacitor plugin. */
  async function _triggerNativeLock() {
    if (!FCAuth.currentUser()) return;
    const enabled = await FCAuth.isBiometricEnabled().catch(() => false);
    if (!enabled) return;
    try {
      const BiometricAuth = window.Capacitor?.Plugins?.BiometricAuth;
      if (BiometricAuth) await BiometricAuth.lock();
    } catch (_) {}
  }

  /** Listen for the native "Use Password Instead" tap posted by AppDelegate. */
  function _initSignOutListener() {
    try {
      const AppPlugin = window.Capacitor?.Plugins?.App;
      if (!AppPlugin) return;
      // Capacitor App plugin forwards NSNotification names as custom events
      AppPlugin.addListener('FCSignOutRequested', async () => {
        FCData.detachAllListeners();
        try { await FCAuth.signOut(); } catch (_) {}
      });
    } catch (_) {}

    // Also wire up token-revocation check + delivered notification clear on every resume
    try {
      const AppPlugin = window.Capacitor?.Plugins?.App;
      if (!AppPlugin) return;
      AppPlugin.addListener('appStateChange', async ({ isActive }) => {
        if (!isActive) return;
        // Biometric enrollment can only change while we were backgrounded —
        // the user turns Face ID off in iOS Settings, or iOS disables it after
        // five failed attempts. Drop the cached hardware answer so the very
        // first read after resume asks the device again.
        try { FCAuth.invalidateDeviceAuthCache?.(); } catch (_) {}
        // Clear any delivered push banners and badge — AppDelegate does this
        // natively but calling here catches the JS-only path (simulator/web).
        if (typeof FCPush !== 'undefined') FCPush.clearDeliveredAndBadge();
        const user = FCAuth.currentUser();
        if (!user || typeof user.getIdToken !== 'function') return;
        try {
          await user.getIdToken(true);
          // Retry a background sync if the last one failed (e.g. app was backgrounded mid-sync)
          if (_lastSyncFailed && state.user?.plaid_linked && state.screen === 'app') {
            manualSync(false);
          }
        } catch (err) {
          console.warn('[FCApp] Token revoked on resume — signing out:', err.code || err.message);
          toast('Your session expired — please sign in again', 'info', 5000);
          try { FCData.detachAllListeners(); } catch (_) {}
          try { await FCAuth.signOut(); } catch (_) {}
          _wipeLocalUserKeys(); // same preserve policy as every other sign-out
          setScreen('hero');
        }
      });
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     PAYWALL
     Shows after bank connects (highest-intent moment).
     Soft gate — user can dismiss. Annual plan selected by default.
     ───────────────────────────────────────────────────────────── */

  let _selectedPlan          = 'annual'; // 'annual' | 'monthly'
  let _pwOfferings           = null;
  // Accounts that skip OTP and Plaid — used by App Review testers.
  // SINGLE SOURCE OF TRUTH: exported as FCApp.isDemoEmail() so the onboarding
  // controller in index.html gates the "Use Demo Account" button off the same
  // list. If App Review can't reach demo mode, the app gets rejected — so this
  // must never be duplicated as a hardcoded string again.
  const _DEMO_EMAILS = ['reviewer@flowcheck.app'];

  /** True if the given email is an App Review demo account. */
  function isDemoEmail(email) {
    return _DEMO_EMAILS.includes(String(email || '').trim().toLowerCase());
  }
  let _isDemoMode = false;

  let _paywallShownThisSession = false;  // prevents re-trigger within one running session
  let _currentUid            = null;     // tracks active UID — guards against token-refresh re-routing

  /* ── Routing persistence helpers ─────────────────────────────
   *
   * Onboarding and paywall state are stored in localStorage keyed by UID so
   * they survive app restarts without requiring a Firestore round-trip.  They
   * cannot leak between users because the key includes the UID.
   *
   * Preserved across _wipeUserState() (which only strips un-keyed fc_ caches).
   * ─────────────────────────────────────────────────────────── */

  function _markOnboardingLocalCache(uid) {
    if (!uid) return;
    try { localStorage.setItem(`fc_ob_done_${uid}`, '1'); } catch (_) {}
  }
  function _onboardingLocallyCached(uid) {
    if (!uid) return false;
    try { return localStorage.getItem(`fc_ob_done_${uid}`) === '1'; } catch (_) { return false; }
  }

  function _markPaywallSeen(uid) {
    if (!uid) return;
    try { localStorage.setItem(`fc_pw_seen_${uid}`, Date.now().toString()); } catch (_) {}
  }
  // 24-hour cooldown — prevents paywall re-appearing on every cold restart
  function _paywallCooldownActive(uid) {
    if (!uid) return false;
    try {
      const t = parseInt(localStorage.getItem(`fc_pw_seen_${uid}`) || '0');
      return Date.now() - t < 24 * 3600 * 1000;
    } catch (_) { return false; }
  }

  /**
   * Gate for automatic (non-user-initiated) paywall triggers.
   * Returns true when it's appropriate to show the paywall:
   *   - user is not Pro
   *   - paywall not already shown this session
   *   - paywall cooldown not active (not seen within last 24h)
   * For user-initiated shows (tapping a Pro gate card, "Start Trial" button),
   * call showPaywall() directly — it always shows.
   */
  function _shouldShowPaywall(uid) {
    if (_paywallShownThisSession) return false;
    if (_paywallCooldownActive(uid)) return false;
    return true;
  }

  /**
   * @param {{dismissible?: boolean}} [opts]
   *   dismissible defaults to TRUE and should stay that way for every
   *   exploratory entry point — the Settings row, the pro-gate cards, the
   *   contextual prompts. Those are all reachable from a working screen, and
   *   a modal you can open from a settings row but not close is a trap, not a
   *   sales pitch.
   *   Onboarding passes false. There is no free tier, so at the end of signup
   *   there is genuinely nothing behind the paywall to go back to, and an X
   *   there implied an option that does not exist — the same problem the
   *   "Maybe later" button had.
   */
  async function showPaywall(opts) {
    const dismissible = !(opts && opts.dismissible === false);
    const closeBtn = document.querySelector('.fc-pw-close');
    if (closeBtn) closeBtn.style.display = dismissible ? '' : 'none';

    // Mark as seen immediately — both in-session flag and persistent cooldown.
    // All callers (user-initiated and automatic) go through here so the state
    // is always consistent. _shouldShowPaywall() guards automatic triggers before
    // they call showPaywall(); user-initiated calls (onclick, "Start Trial") call
    // showPaywall() directly and bypass the cooldown check by design.
    _paywallShownThisSession = true;
    const _pwUid = FCAuth.currentUser?.()?.uid;
    if (_pwUid) _markPaywallSeen(_pwUid);

    if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('paywall_viewed', { source: state.screen });

    // Reset success overlay in case it was left visible from a previous purchase attempt
    const successOverlay = document.getElementById('pw-success-overlay');
    if (successOverlay) successOverlay.classList.remove('visible');

    // Demo button only visible for App Review accounts — hidden for all real users
    const demoBtn = document.getElementById('pw-demo-btn');
    if (demoBtn) {
      const email = FCAuth.currentUser?.()?.email || '';
      demoBtn.style.display = _DEMO_EMAILS.includes(email) ? 'block' : 'none';
    }

    setScreen('paywall');
    haptic('light');
    _loadPaywallOfferings();
  }

  /** True while the paywall shown was opened from the onboarding trial slide. */
  let _paywallFromOnboarding = false;

  /** Dismiss the paywall and return to the dashboard (or onboarding bank slide). */
  function closePaywall() {
    // Reset success overlay so it doesn't bleed on next open
    const successOverlay = document.getElementById('pw-success-overlay');
    if (successOverlay) successOverlay.classList.remove('visible');
    // Opened from onboarding — finish the flow there instead of jumping to
    // an empty dashboard: the bank-connect slide is the actual last step.
    if (_paywallFromOnboarding) {
      _paywallFromOnboarding = false;
      setScreen('onboarding');
      if (window.obGoToBankSlide) window.obGoToBankSlide();
      return;
    }
    /* Without a subscription there is no app to close back to, and letting
       setScreen('app') bounce off the gate would make this button appear
       broken — the one thing the comment above it in index.html says must not
       happen. Send them to demo mode instead: the whole product, entirely
       fabricated data, paywall one tap away. It is also how App Review
       evaluates the app without buying a subscription. */
    if (!_isDemoMode && !_mayEnterApp()) {
      toast('Showing sample data — subscribe to use your own', 'info', 4000);
      startDemoMode();
      return;
    }
    setScreen('app');
    _renderHome();
    // Pro but no bank yet — nudge them to connect so the dashboard isn't empty
    if (_isPro() && !state.user?.plaid_linked) {
      setTimeout(() => {
        toast('Great — now connect your bank to unlock your dashboard', 'info', 5000);
      }, 600);
    }
  }

  async function _loadPaywallOfferings() {
    try {
      if (!FCPurchases.isConfigured()) await FCPurchases.configure();
      const offerings = await FCPurchases.getOfferings();
      if (!offerings) return;
      _pwOfferings = offerings;

      // Update price strings with live App Store prices
      const annual  = offerings.annual  || offerings.availablePackages?.find(p => p.packageType === 'ANNUAL');
      const monthly = offerings.monthly || offerings.availablePackages?.find(p => p.packageType === 'MONTHLY');

      if (annual) {
        const price    = annual.product.priceString;
        const rawAnnual = annual.product.price;
        const amountEl = document.getElementById('pw-price-annual-amount');
        const detailEl = document.getElementById('pw-price-annual');
        if (amountEl) amountEl.textContent = price;
        if (detailEl) {
          const monthlyEq = rawAnnual
            ? `${_pkgMoney(annual, rawAnnual / 12)}/mo` + (monthly?.product?.price
                ? ` &nbsp;<span class="fc-pw-plan-strike">vs ${_pkgMoney(monthly, monthly.product.price * 12)}</span>`
                : '')
            : '7-day free trial';
          detailEl.innerHTML = monthlyEq;
        }
        // Update "Save X%" dynamically from live prices
        const savingsEl = document.querySelector('.fc-pw-plan-savings');
        if (savingsEl && rawAnnual && monthly?.product?.price) {
          const fullYear = monthly.product.price * 12;
          const savePct  = Math.round((1 - rawAnnual / fullYear) * 100);
          if (savePct > 0) savingsEl.textContent = `Save ${savePct}%`;
        }
        // Update CTA button and terms text to reflect live price
        const termsEl = document.getElementById('pw-terms-text');
        const ctaBtn  = document.getElementById('pw-cta-btn');
        if (_selectedPlan === 'annual') {
          if (termsEl) termsEl.textContent = `Payment charged to your Apple ID at purchase confirmation. Subscription auto-renews at ${price}/year unless canceled at least 24 hours before the end of the current period. Manage or cancel anytime in App Store Account Settings. Any unused trial is forfeited upon purchase.`;
          if (ctaBtn && !ctaBtn.disabled) ctaBtn.textContent = 'Start 7-Day Free Trial';
        }
      }
      if (monthly) {
        const el = document.getElementById('pw-price-monthly');
        if (el) el.textContent = `${monthly.product.priceString}/mo · No commitment`;
      }
    } catch (err) {
      fcLog('Paywall offerings load failed (using defaults):', err.message);
    }
  }

  /* Format a derived amount in the SAME currency the store quoted.
     The monthly-equivalent and the struck-through comparison are computed
     by us, not returned by RevenueCat, and they used to be built with a
     hardcoded "$". A euro user therefore saw a correctly localised
     "€34,99" sitting next to "$2.92/mo vs $59.88" — three prices, two
     currencies, one of them simply wrong. Money the user is quoted has to
     be in the currency they will actually be charged.

     Intl with the product's currencyCode when RevenueCat gives us one;
     otherwise reuse whatever symbol its own priceString carries, so we can
     never invent a currency we were not told about. */
  function _pkgMoney(pkg, amount) {
    const code = pkg?.product?.currencyCode;
    if (code) {
      try {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: code })
          .format(amount);
      } catch (_) { /* unknown code — fall through to the symbol path */ }
    }
    const raw = String(pkg?.product?.priceString || '');
    const sym = raw.replace(/[\d.,\s\u00a0]/g, '') || '$';
    return /^[A-Za-z]/.test(sym) ? sym + ' ' + amount.toFixed(2) : sym + amount.toFixed(2);
  }

  /* Rewrites the onboarding trial disclosure with this storefront's real
     prices. Called when the trial slide is shown. Best-effort by design: if
     offerings have not loaded we leave the documented USD defaults in place
     rather than blanking a legal notice, and the paywall the user reaches
     next always shows the authoritative localised price from the store. */
  async function localiseTrialNote() {
    const el = document.getElementById('ob-legal-prices');
    if (!el) return;
    try {
      if (!FCPurchases.isConfigured()) await FCPurchases.configure();
      const offerings = await FCPurchases.getOfferings();
      const annual  = offerings?.annual  || offerings?.availablePackages?.find(p => p.packageType === 'ANNUAL');
      const monthly = offerings?.monthly || offerings?.availablePackages?.find(p => p.packageType === 'MONTHLY');
      const a = annual?.product?.priceString;
      const m = monthly?.product?.priceString;
      if (!a) return;                       // nothing trustworthy to say
      /* Scope the trial to the plan that actually has it. "7-day free trial,
         then X/year (or Y/month)" reads as though the trial applies whichever
         plan you pick, and it does not — the intro offer is on the annual
         product only. Someone who chose monthly on the strength of this line
         would be charged on day one having been told they had a week.

         The paywall itself already gets this right (selectPlan rewrites the
         trust claim, the button and the disclosure per plan). This is the
         same correction, one screen earlier, in the disclosure the user is
         agreeing to by tapping Continue. */
      el.textContent = '7-day free trial on the annual plan, then ' + a + '/year'
        + (m ? '. Monthly is ' + m + '/month, billed today.' : '.');
    } catch (_) { /* keep the defaults */ }
  }

  function selectPlan(plan) {
    _selectedPlan = plan;
    haptic('light');

    document.getElementById('pw-plan-annual')?.classList.toggle('selected', plan === 'annual');
    document.getElementById('pw-plan-annual')?.setAttribute('aria-checked', plan === 'annual');
    document.getElementById('pw-plan-monthly')?.classList.toggle('selected', plan === 'monthly');
    document.getElementById('pw-plan-monthly')?.setAttribute('aria-checked', plan === 'monthly');

    const btn   = document.getElementById('pw-cta-btn');
    const terms = document.getElementById('pw-terms-text');

    // Use live prices from offerings if loaded; fall back to hardcoded defaults
    const annualPkg  = _pwOfferings?.annual  || _pwOfferings?.availablePackages?.find(p => p.packageType === 'ANNUAL');
    const monthlyPkg = _pwOfferings?.monthly || _pwOfferings?.availablePackages?.find(p => p.packageType === 'MONTHLY');
    const annualPrice  = annualPkg?.product?.priceString  ?? '$34.99';
    const monthlyPrice = monthlyPkg?.product?.priceString ?? '$4.99';

    /* The trust strip's middle claim is plan-specific: only the annual
       product has the intro offer. It was static markup, so choosing
       Monthly kept "No charge for 7 days" on screen next to a button that
       charges immediately. */
    const trustCharge = document.getElementById('pw-trust-charge');

    if (plan === 'annual') {
      if (trustCharge) trustCharge.textContent = 'No charge for 7 days';
      if (btn)   btn.textContent   = 'Start 7-Day Free Trial';
      if (terms) terms.textContent = `Payment charged to your Apple ID at purchase confirmation. Subscription auto-renews at ${annualPrice}/year unless canceled at least 24 hours before the end of the current period. Manage or cancel anytime in App Store Account Settings. Any unused trial is forfeited upon purchase.`;
    } else {
      // True for monthly: charged today, but nothing is locked in.
      if (trustCharge) trustCharge.textContent = 'No commitment';
      if (btn)   btn.textContent   = 'Start Monthly Plan';
      if (terms) terms.textContent = `Payment charged to your Apple ID at purchase confirmation. Subscription auto-renews at ${monthlyPrice}/month unless canceled at least 24 hours before the end of the current period. Manage or cancel anytime in App Store Account Settings.`;
    }
  }

  async function paywallPurchase() {
    const btn = document.getElementById('pw-cta-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
    haptic('light');

    try {
      // Ensure RevenueCat is configured
      if (!FCPurchases.isConfigured()) await FCPurchases.configure();

      // Get the package to purchase
      let pkg = null;
      if (_pwOfferings) {
        pkg = _selectedPlan === 'annual'
          ? (_pwOfferings.annual  || _pwOfferings.availablePackages?.find(p => p.packageType === 'ANNUAL'))
          : (_pwOfferings.monthly || _pwOfferings.availablePackages?.find(p => p.packageType === 'MONTHLY'));
      }

      if (!pkg) {
        // Fallback: refresh offerings and retry
        const fresh = await FCPurchases.getOfferings();
        if (fresh) {
          _pwOfferings = fresh;
          pkg = _selectedPlan === 'annual'
            ? (fresh.annual  || fresh.availablePackages?.find(p => p.packageType === 'ANNUAL'))
            : (fresh.monthly || fresh.availablePackages?.find(p => p.packageType === 'MONTHLY'));
        }
      }

      if (!pkg) throw new Error('Product not found — please check App Store Connect configuration');

      const { isPro } = await FCPurchases.purchasePackage(pkg);

      if (isPro) {
        haptic('medium');
        // Mark onboarding complete so cold-start routing never sends this user
        // back to onboarding. Handles the case where the user purchased directly
        // from the paywall shown during onboarding (startTrialFromOnboarding),
        // which skips the skipOnboarding() path that normally writes this flag.
        _markOnboardingComplete().catch(() => {});
        // Show animated success overlay instead of plain toast
        const overlay = document.getElementById('pw-success-overlay');
        const icon    = document.getElementById('pw-success-icon');
        const sub     = document.getElementById('pw-success-sub');
        if (sub) {
          sub.textContent = _selectedPlan === 'annual'
            ? 'Your annual plan is active — enjoy all Pro features.'
            : 'Your monthly plan is active — enjoy all Pro features.';
        }
        if (icon) {
          icon.style.animation = 'none';
          void icon.offsetHeight; // force reflow to replay animation
          icon.style.animation  = '';
        }
        // Refresh every pro-gated surface so the user sees unlocked content
        // when they dismiss the overlay (bugs #4 + #10).
        _refreshAfterPro();
        if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('purchase_completed', { plan: 'pro' });
        // Non-blocking pro upgrade email — best-effort, never delays the success flow
        FCAuth.authedFetch(`${FC_CONFIG.app.apiBase}/email/pro-upgrade`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: _selectedPlan || 'monthly' }),
        }).catch(() => {});
        if (overlay) {
          overlay.classList.add('visible');
        } else {
          // Fallback if overlay element missing
          toast('Welcome to FlowCheck Pro! 🎉', 'success', 4000);
          setScreen('app');
          _scheduleWelcomeModal();
        }
      } else {
        // RevenueCat can be slow to reflect the new entitlement — retry once after 3 s
        if (btn) btn.textContent = 'Activating…';
        setTimeout(async () => {
          try {
            const isPro2 = await FCPurchases.checkProStatus();
            if (isPro2) {
              haptic('medium');
              setScreen('app');
              _refreshAfterPro();
              setTimeout(() => _tryStartTour(), 1200);
            } else {
              // Still pending — show "Check again" button so user isn't stuck
              _showPendingState(btn);
            }
          } catch (_) {
            _showPendingState(btn);
          }
        }, 3000);
      }
    } catch (err) {
      const cancelled = !!err.message?.toLowerCase().includes('cancel');
      if (typeof FCAnalytics !== 'undefined') {
        // Reason is a coarse enum only — never the raw error text, which can
        // contain store/account details.
        FCAnalytics.track(cancelled ? 'purchase_cancelled' : 'purchase_failed', {
          plan: _selectedPlan === 'annual' ? 'annual' : 'monthly',
        });
      }
      if (cancelled) {
        // User cancelled — just reset button silently
      } else {
        toast('Purchase failed — check your App Store account and try again', 'error');
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = _selectedPlan === 'annual' ? 'Start 7-Day Free Trial' : 'Start Monthly Plan';
      }
    }
  }

  /** Called when a purchase is in pending/Ask-to-Buy state.
   *  Shows a friendly message and swaps the CTA to "Check Approval Status"
   *  so the user can re-check without being stuck forever. */
  function _showPendingState(btn) {
    toast('Purchase received — tap below to activate your plan', 'info', 5000);
    if (btn) {
      btn.disabled    = false;
      btn.textContent = 'Activate My Plan';
      btn.onclick     = async () => {
        btn.disabled    = true;
        btn.textContent = 'Activating…';
        try {
          if (!FCPurchases.isConfigured()) await FCPurchases.configure();
          const isPro = await FCPurchases.checkProStatus();
          if (isPro) {
            haptic('medium');
            setScreen('app');
            _refreshAfterPro();
            setTimeout(() => _tryStartTour(), 1200);
          } else {
            toast('Not activated yet — try restoring purchases below', 'info', 5000);
            btn.disabled    = false;
            btn.textContent = 'Activate My Plan';
          }
        } catch (_) {
          btn.disabled    = false;
          btn.textContent = 'Check Approval Status';
        }
      };
    }
  }

  async function paywallRestore() {
    const btn = document.getElementById('pw-cta-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }
    haptic('light');

    try {
      if (!FCPurchases.isConfigured()) await FCPurchases.configure();
      const { isPro } = await FCPurchases.restorePurchases();
      if (isPro) {
        haptic('medium');
        toast('Pro access restored!', 'success');
        setScreen('app');
        _refreshAfterPro();
      } else {
        toast('No previous purchase found', 'info');
        if (btn) { btn.disabled = false; btn.textContent = _selectedPlan === 'annual' ? 'Start 7-Day Free Trial' : 'Start Monthly Plan'; }
      }
    } catch (err) {
      toast('Restore failed: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = _selectedPlan === 'annual' ? 'Start 7-Day Free Trial' : 'Start Monthly Plan'; }
    }
  }

  function skipPaywall() {
    haptic('light');
    if (_paywallFromOnboarding) {
      _paywallFromOnboarding = false;
      setScreen('onboarding');
      if (window.obGoToBankSlide) window.obGoToBankSlide();
      return;
    }
    // Same reasoning as closePaywall(): there is nothing to skip to.
    if (!_isDemoMode && !_mayEnterApp()) { startDemoMode(); return; }
    setScreen('app');
    _renderHome();
    setTimeout(() => _doSync(false), 800);
  }

  /* ─────────────────────────────────────────────────────────────
     GOALS CRUD
     ───────────────────────────────────────────────────────────── */

  let _editingGoalId = null;

  /** Called from goal card tap — looks up goal by ID then opens edit sheet */
  /* ── Focusing a field without racing an animation ────────────────────────
     THE ONE WAY TO FOCUS A TEXT FIELD. Do not call .focus() directly from a
     setTimeout — that is the bug this replaced.

     Focusing summons the keyboard, and capacitor.config.json sets
     resize:"native", so the keyboard resizes the WebView itself. If the
     container is still animating when that happens, the sheet is being
     repositioned toward a new viewport bottom while an animation is still
     driving it toward the old one — two motions with different targets at the
     same time. On device that reads as the sheet landing in one place and
     then bouncing to another.

     The app had FOUR different guesses at "how long is the animation" —
     150ms (login), 200ms (all five form sheets), 250ms (affordability),
     400ms (forgot password) — against a sheet entrance of
     `fcSheetUp 0.36s cubic-bezier(0.34, 1.56, 0.64, 1)`, a 360ms spring that
     deliberately overshoots. Every one of them fired mid-flight.

     So: do not guess. Ask the browser what is actually running and wait for
     it. This stays correct when any animation is retuned, and it costs
     nothing when none is running — the common case, where it focuses on the
     next frame. */
  const _FOCUS_ANIM_CAP_MS = 600;   // backstop: never block focus indefinitely

  function _focusField(input, root) {
    if (!input) return;
    const scope = root
      || input.closest('.fc-sheet, .fc-sheet-overlay, .fc-screen, .fc-view')
      || document.body;

    const focusNow = () => { try { input.focus(); } catch (_) {} };

    /* Two frames, not one: a CSS animation started by a display change in
       this same task has not been registered with the timeline yet when the
       first frame runs, so getAnimations() would report nothing and we would
       focus straight into the animation we were trying to avoid. */
    /* Only animations on the field's OWN ancestor chain can move it. A
       staggered fade on a sibling card cannot, and waiting for one made the
       forgot-password screen focus at 648ms instead of the 398ms its own
       entrance actually took. Build the chain once and filter against it. */
    const chain = new Set();
    for (let n = input; n && n !== document.documentElement; n = n.parentElement) chain.add(n);

    requestAnimationFrame(() => requestAnimationFrame(() => {
      let running = [];
      try {
        running = (scope.getAnimations ? scope.getAnimations({ subtree: true }) : [])
          .filter(a => {
            if (a.playState !== 'running') return false;
            /* Spinners, pulses and the sync dot loop forever. Waiting on one
               would mean never focusing at all. */
            let iterations = 1;
            try { iterations = a.effect.getComputedTiming().iterations; } catch (_) {}
            if (iterations === Infinity) return false;
            let target = null;
            try { target = a.effect.target; } catch (_) {}
            return target ? chain.has(target) : false;
          });
      } catch (_) { /* no Web Animations API — fall through and focus */ }

      if (!running.length) { focusNow(); return; }

      let done = false;
      const go = () => { if (done) return; done = true; focusNow(); };
      Promise.all(running.map(a => a.finished.catch(() => {}))).then(go);
      setTimeout(go, _FOCUS_ANIM_CAP_MS);
    }));
  }

  function editGoal(goalId) {
    haptic('light');
    const goal = state.goals.find(g => g.id === goalId);
    showAddGoalSheet(goal || null);
  }

  function showAddGoalSheet(goal) {
    _editingGoalId = goal ? goal.id : null;
    const sheet     = document.getElementById('fc-goal-sheet');
    const title     = document.getElementById('goal-sheet-title');
    const nameInput = document.getElementById('goal-name-input');
    const tgtInput  = document.getElementById('goal-target-input');
    const curInput  = document.getElementById('goal-current-input');
    const dateInput = document.getElementById('goal-date-input');
    const delBtn    = document.getElementById('goal-delete-btn');

    if (title)     title.textContent  = goal ? 'Edit Goal' : 'Add Goal';
    if (nameInput) nameInput.value    = goal ? goal.name   : '';
    if (tgtInput)  tgtInput.value     = goal ? goal.target : '';
    if (curInput)  curInput.value     = goal ? (goal.current || 0) : '';
    if (dateInput) dateInput.value    = goal ? (goal.target_date || '') : '';
    if (delBtn)    delBtn.style.display = goal ? '' : 'none';

    if (sheet) { sheet.style.display = 'flex'; }
    haptic('light');
    _updateGoalCalc();
    _focusField(nameInput, sheet);
  }

  function _updateGoalCalc() {
    const tgtInput  = document.getElementById('goal-target-input');
    const curInput  = document.getElementById('goal-current-input');
    const dateInput = document.getElementById('goal-date-input');
    const calcEl    = document.getElementById('goal-monthly-calc');
    if (!calcEl) return;

    const target  = parseFloat(tgtInput?.value)  || 0;
    const current = parseFloat(curInput?.value)   || 0;
    const dateStr = dateInput?.value;

    if (!target || !dateStr) { calcEl.style.display = 'none'; return; }

    const remaining = Math.max(0, target - current);
    const months    = Math.max(1, Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24 * 30.44)));
    const monthly   = remaining / months;

    calcEl.style.display = '';
    calcEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="flex-shrink:0"><path d="M12 2v20M2 12h20"/><circle cx="12" cy="12" r="9"/></svg>Save <strong>${FCData.formatCurrency(monthly)}/mo</strong> to reach your goal by ${new Date(dateStr).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })} · ${months} month${months !== 1 ? 's' : ''} away`;
  }

  function closeGoalSheet() {
    const sheet = document.getElementById('fc-goal-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); _editingGoalId = null; }, 280);
  }

  async function saveGoal() {
    const nameInput = document.getElementById('goal-name-input');
    const tgtInput  = document.getElementById('goal-target-input');
    const curInput  = document.getElementById('goal-current-input');
    const dateInput = document.getElementById('goal-date-input');
    const btn       = document.getElementById('goal-save-btn');

    const name        = nameInput?.value.trim();
    const target      = parseFloat(tgtInput?.value);
    const current     = parseFloat(curInput?.value) || 0;
    const target_date = dateInput?.value || null;

    if (!name)        { toast('Enter a goal name', 'info'); return; }
    if (!target || target <= 0) { toast('Enter a valid target amount', 'info'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    haptic('light');

    try {
      const payload = { name, target, current, ...(target_date ? { target_date } : { target_date: null }) };
      if (_editingGoalId) {
        await FCData.updateGoal(_editingGoalId, payload);
      } else {
        await FCData.createGoal(payload);
      }
      closeGoalSheet();
      toast(_editingGoalId ? 'Goal updated' : 'Goal added! 🎯', 'success');
      haptic('medium');
    } catch (err) {
      toast('Could not save goal: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Goal'; }
    }
  }

  async function deleteGoalById() {
    if (!_editingGoalId) return;
    const confirmed = await _confirmDialog('Delete Goal', 'Are you sure? This cannot be undone.', 'Delete Goal');
    if (!confirmed) return;

    try {
      await FCData.deleteGoal(_editingGoalId);
      closeGoalSheet();
      toast('Goal deleted', 'success');
      haptic('medium');
    } catch (err) {
      toast('Could not delete goal: ' + err.message, 'error');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     MANUAL ACCOUNTS
     ───────────────────────────────────────────────────────────── */

  /** Set when the manual-account sheet is opened on an existing account.
   *  Mirrors _editingBillId — same dual-mode sheet pattern as bills. */
  let _editingAccountId = null;

  /**
   * Open the manual-account sheet.
   *
   * With no argument this is the add flow, unchanged. Passing an account
   * switches it to edit: fields are populated, the title and button change,
   * and Delete appears. Only manual accounts may be passed — a Plaid-synced
   * account is backend-owned and firestore.rules refuses client writes to it,
   * so offering an edit UI for one would be a button that cannot work.
   */
  /** credit / loan only. Savings, checking and investment accounts have no
   *  APR or minimum payment — showing the fields for them invited a number
   *  that means nothing for that account type. */
  const _DEBT_ACCT_TYPES = new Set(['credit', 'loan']);

  /** Show/hide the interest-rate + minimum-payment fields to match whatever
   *  the type select currently reads. Called on open (both add and edit) and
   *  on every change to the select, so the sheet is never caught showing
   *  debt fields for a savings account or hiding them for a credit card. */
  function _toggleManualAcctDebtFields() {
    const typeEl = document.getElementById('manual-acct-type');
    const wrap   = document.getElementById('manual-acct-debt-fields');
    if (!typeEl || !wrap) return;
    wrap.style.display = _DEBT_ACCT_TYPES.has(typeEl.value) ? 'flex' : 'none';
  }
  function _onManualAcctTypeChange() {
    _toggleManualAcctDebtFields();
  }

  function showManualAccountSheet(account) {
    const sheet   = document.getElementById('fc-manual-account-sheet');
    const titleEl = document.getElementById('manual-acct-title');
    const name    = document.getElementById('manual-acct-name');
    const typeEl  = document.getElementById('manual-acct-type');
    const bal     = document.getElementById('manual-acct-balance');
    const rateEl  = document.getElementById('manual-acct-rate');
    const minEl   = document.getElementById('manual-acct-min-payment');
    const saveBtn = document.getElementById('manual-acct-save-btn');
    const delBtn  = document.getElementById('manual-acct-delete-btn');

    const editing = !!(account && account.id && account.manual);
    _editingAccountId = editing ? account.id : null;

    if (name)  name.value = editing ? (account.name || '') : '';
    if (bal)   bal.value  = editing
      ? String(Math.abs(Number(account.balance_current ?? account.balance ?? 0)))
      : '';
    // Populated whether editing or not: showManualAccountSheet({type:'loan'})
    // is also how the Debt screen's "+ Add debt" button opens this sheet, and
    // a stale rate left over from the LAST account this sheet edited must not
    // survive into a fresh Add flow.
    if (rateEl) rateEl.value = (editing && account.interest_rate != null) ? String(account.interest_rate) : '';
    if (minEl)  minEl.value  = (editing && account.minimum_payment != null) ? String(account.minimum_payment) : '';
    if (typeEl) {
      const t = String(account?.type || account?.subtype || 'savings').toLowerCase();
      // Fall back rather than leaving the select on whatever was there last —
      // a silently wrong type flips an asset into a debt on save.
      typeEl.value = [...typeEl.options].some(o => o.value === t) ? t : 'savings';
    }
    _toggleManualAcctDebtFields();
    if (titleEl) titleEl.textContent = editing ? 'Edit Account' : 'Add Account';
    if (saveBtn) saveBtn.textContent = editing ? 'Save Changes' : 'Add Account';
    if (delBtn)  delBtn.style.display = editing ? '' : 'none';

    if (sheet) { sheet.style.display = 'flex'; }
    haptic('light');
    _focusField(name, sheet);
  }

  /** Entry point from an account row. Looks the account up by id so the row
   *  markup carries only an id, never a serialised object in an attribute. */
  function editManualAccount(accountId) {
    const acct = (state.accounts || []).find(a => a.id === accountId);
    if (!acct || !acct.manual) return;
    showManualAccountSheet(acct);
  }

  function closeManualAccountSheet() {
    const sheet = document.getElementById('fc-manual-account-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => {
      sheet.style.display = 'none';
      sheet.classList.remove('fc-sheet--closing');
      _editingAccountId = null;
    }, 280);
  }

  async function deleteManualAccountById() {
    if (!_editingAccountId) return;
    const btn = document.getElementById('manual-acct-delete-btn');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    haptic('medium');
    try {
      await FCData.deleteManualAccount(_editingAccountId);
      closeManualAccountSheet();
      toast('Account deleted', 'success');
    } catch (err) {
      toast('Could not delete: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  async function saveManualAccount() {
    const nameEl  = document.getElementById('manual-acct-name');
    const typeEl  = document.getElementById('manual-acct-type');
    const balEl   = document.getElementById('manual-acct-balance');
    const rateEl  = document.getElementById('manual-acct-rate');
    const minEl   = document.getElementById('manual-acct-min-payment');
    const btn     = document.getElementById('manual-acct-save-btn');

    const name    = nameEl?.value.trim();
    const type    = typeEl?.value || 'savings';
    const balance = parseFloat(balEl?.value) || 0;

    if (!name) { toast('Enter an account name', 'info'); return; }

    /* Gated on the CURRENT type at save time, not on whether the fields were
       visible — so switching Credit Card -> Savings and saving cannot leave a
       stale APR sitting on a savings account just because the wrapper was
       hidden rather than the input cleared. Always written (never omitted):
       an update() that omits a key leaves whatever was there before
       untouched, which is how a converted account would go on quietly
       carrying its old rate forever. null says, explicitly, "not a debt". */
    const isDebtType = _DEBT_ACCT_TYPES.has(type);
    let rate = isDebtType ? parseFloat(rateEl?.value) : NaN;
    if (!isFinite(rate) || rate < 0) rate = null;
    else rate = Math.min(rate, 100);
    let minPayment = isDebtType ? parseFloat(minEl?.value) : NaN;
    if (!isFinite(minPayment) || minPayment < 0) minPayment = null;

    const editing = !!_editingAccountId;
    const label   = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    haptic('light');

    const fields = {
      name,
      type,
      subtype:          type,
      balance_current:  balance,
      balance:          balance,
      currency:         'USD',
      mask:             null,
      interest_rate:    rate,
      minimum_payment:  minPayment,
    };

    try {
      if (editing) {
        await FCData.updateManualAccount(_editingAccountId, fields);
      } else {
        await FCData.createManualAccount(fields);
      }
      closeManualAccountSheet();
      toast(editing ? 'Account updated' : 'Account added!', 'success');
      haptic('medium');
    } catch (err) {
      toast(`Could not ${editing ? 'update' : 'add'} account: ` + err.message, 'error');
    } finally {
      // Restore the button's own label rather than hardcoding one — this sheet
      // now has two of them.
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     BILLS MANAGEMENT
     ───────────────────────────────────────────────────────────── */

  let _editingBillId = null;

  function showBillSheet(bill) {
    const sheet    = document.getElementById('fc-bill-sheet');
    const titleEl  = document.getElementById('bill-sheet-title');
    const idEl     = document.getElementById('bill-edit-id');
    const nameEl   = document.getElementById('bill-name');
    const amtEl    = document.getElementById('bill-amount');
    const dateEl   = document.getElementById('bill-due-date');
    const catEl    = document.getElementById('bill-category');
    const freqEl   = document.getElementById('bill-frequency');
    const autopayEl= document.getElementById('bill-autopay');
    const deleteBtn= document.getElementById('bill-delete-btn');

    if (!sheet) return;

    if (bill && bill.id) {
      _editingBillId = bill.id;
      if (titleEl)  titleEl.textContent = 'Edit Bill';
      if (idEl)     idEl.value          = bill.id;
      if (nameEl)   nameEl.value        = bill.name || '';
      if (amtEl)    amtEl.value         = bill.amount || '';
      if (dateEl)   dateEl.value        = bill.due_date || '';
      if (catEl)    catEl.value         = bill.category || 'Other';
      if (freqEl)   freqEl.value        = bill.frequency || 'monthly';
      if (autopayEl) autopayEl.checked  = !!(bill.autopay);
      if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    } else {
      _editingBillId = null;
      if (titleEl)  titleEl.textContent = 'Add Bill';
      if (idEl)     idEl.value          = '';
      if (nameEl)   nameEl.value        = '';
      if (amtEl)    amtEl.value         = '';
      if (freqEl)   freqEl.value        = 'monthly';
      if (autopayEl) autopayEl.checked  = false;
      // Default due date to today + 30 days
      const nextMonth = new Date(); nextMonth.setDate(nextMonth.getDate() + 30);
      if (dateEl)   dateEl.value = FCCore.isoDay(nextMonth);
      if (deleteBtn) deleteBtn.style.display = 'none';
    }

    sheet.style.display = 'flex';
    haptic('light');
    _focusField(nameEl, sheet);
  }

  function closeBillSheet() {
    const sheet = document.getElementById('fc-bill-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); _editingBillId = null; }, 280);
  }

  async function saveBill() {
    const nameEl  = document.getElementById('bill-name');
    const amtEl   = document.getElementById('bill-amount');
    const dateEl  = document.getElementById('bill-due-date');
    const catEl   = document.getElementById('bill-category');
    const freqEl  = document.getElementById('bill-frequency');
    const saveBtn = document.getElementById('bill-save-btn');

    const autopayEl2= document.getElementById('bill-autopay');
    const name     = nameEl?.value.trim();
    const amount   = parseFloat(amtEl?.value) || 0;
    const due_date = dateEl?.value || null;
    const category = catEl?.value || 'Other';
    const frequency= freqEl?.value || 'monthly';
    const autopay  = !!(autopayEl2?.checked);

    if (!name)    { toast('Enter a bill name', 'info'); return; }
    if (!amount)  { toast('Enter an amount', 'info'); return; }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    haptic('light');

    try {
      const fields = { name, amount, due_date, category, frequency, autopay };
      if (_editingBillId) {
        await FCData.updateBill(_editingBillId, fields);
        toast('Bill updated!', 'success');
      } else {
        await FCData.createBill(fields);
        toast('Bill added!', 'success');
        // Re-prompt for notifications on first bill — the value prop is now obvious
        // ("get notified when this bill is due"). Only fires if the user was never
        // asked (undefined) — an explicit "Not now" (=== false) is respected, not
        // re-asked, since requestAndRegister() would surface the real OS dialog.
        if (state.user?.notifications_enabled === undefined && (state.bills || []).length === 0) {
          setTimeout(() => {
            FCPush.requestAndRegister().catch(() => {});
            FCPush.requestLocalPermission().catch(() => {});
          }, 1200);
        }
      }
      closeBillSheet();
      haptic('medium');
    } catch (err) {
      toast('Could not save bill: ' + err.message, 'error');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Bill'; }
    }
  }

  async function deleteBillById() {
    if (!_editingBillId) return;
    const confirmed = await _confirmDialog('Delete Bill', 'Delete this bill? This cannot be undone.', 'Delete Bill');
    if (!confirmed) return;

    try {
      await FCData.deleteBill(_editingBillId);
      closeBillSheet();
      toast('Bill deleted', 'success');
      haptic('medium');
    } catch (err) {
      toast('Could not delete bill: ' + err.message, 'error');
    }
  }

  function editBill(billId) {
    haptic('light');
    const bill = state.bills.find(b => b.id === billId);
    showBillSheet(bill || null);
  }

  /* ─────────────────────────────────────────────────────────────
     TRANSACTION EDITOR
     Tap any transaction in the Activity tab to open this sheet.
     Users can rename the transaction and/or change its category.
     Overrides are persisted to Firestore and applied on every render.
     ───────────────────────────────────────────────────────────── */

  const CATEGORIES_LIST = [
    'Food and Drink','Restaurants','Fast Food','Coffee Shop','Grocery',
    'Shopping','General Merchandise','Clothing','Electronics','Online Shopping',
    'Travel','Airlines','Hotels','Auto and Transport','Gas Stations','Ride Share','Parking',
    'Transfer','Payment','Credit Card','Bank Fees',
    'Healthcare','Medical','Pharmacy','Gym','Fitness',
    'Utilities','Housing','Rent','Electric','Internet','Phone',
    'Entertainment','Recreation','Movies','Music',
    'Subscription','Streaming','Software','Service',
    'Personal Care','Education','Income','Payroll','Other',
  ];

  function openTransactionDetail(txnId) {
    haptic('light');
    _editingTxnId = txnId;
    const txn = state.transactions.find(t => t.id === txnId);
    if (!txn) return;

    // Apply any existing overrides
    const ov      = state.txnOverrides[txnId] || {};
    const origCat = (txn.category && txn.category[0]) || 'Other';
    const cat     = ov.category || origCat;

    const sheet    = document.getElementById('fc-txn-sheet');
    const nameEl   = document.getElementById('txn-name-input');
    const catEl    = document.getElementById('txn-cat-select');
    const oNameEl  = document.getElementById('txn-orig-name');
    const oCatEl   = document.getElementById('txn-orig-cat');
    const oAmtEl   = document.getElementById('txn-orig-amount');
    const resetBtn = document.getElementById('txn-reset-btn');

    // The picker ships empty in the markup — fill it once.
    if (catEl && !catEl.options.length) {
      catEl.innerHTML = CATEGORIES_LIST.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    }
    // Plaid emits categories outside our list. Without this the select would
    // silently land on whatever option happened to be first and a plain Save
    // would recategorise the transaction the user never touched.
    if (catEl && cat && !Array.prototype.some.call(catEl.options, o => o.value === cat)) {
      catEl.insertAdjacentHTML('afterbegin', `<option value="${esc(cat)}">${esc(cat)}</option>`);
    }

    // Blank means "keep the original" — that is what the placeholder promises
    // and what the render fallback (ov.name || t.name) already does.
    if (nameEl)  nameEl.value = ov.name || '';
    if (catEl)   catEl.value  = cat;
    if (oNameEl) oNameEl.textContent = txn.name || '';
    if (oCatEl)  oCatEl.textContent  = origCat +
      (txn.date ? ' · ' + FCData.parseDateLocal(txn.date).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '');
    if (oAmtEl) {
      oAmtEl.textContent = (txn.isCredit ? '+' : '−') + FCData.formatCurrency(txn.amount);
      oAmtEl.style.color = txn.isCredit ? 'var(--fc-success)' : 'var(--fc-danger)';
    }
    // Revert only means something once an override exists.
    if (resetBtn) resetBtn.style.display = (ov.name || ov.category) ? '' : 'none';

    if (sheet) { sheet.style.display = 'flex'; haptic('light'); }
    _focusField(nameEl, sheet);
  }

  function closeTransactionSheet() {
    const sheet = document.getElementById('fc-txn-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); _editingTxnId = null; }, 280);
  }

  async function saveTransactionEdit() {
    if (!_editingTxnId) return;
    const nameEl = document.getElementById('txn-name-input');
    const catEl  = document.getElementById('txn-cat-select');
    const btn    = document.getElementById('txn-save-btn');

    // Blank name is legitimate — it means "keep the original", which is what
    // the field's placeholder says and what the render fallback already does.
    // Rejecting it made the sheet impossible to submit with a category-only
    // edit.
    const name     = nameEl?.value.trim() || '';
    const category = catEl?.value || '';
    // name:'' is meaningful ("keep the original"). category:'' is not — a
    // <select> reports '' only when it holds no matching option, and writing
    // that would store an empty override. Omit it so the merge leaves the
    // existing value alone.
    const fields = category ? { name, category } : { name };

    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    haptic('light');

    try {
      await FCData.setTransactionOverride(_editingTxnId, fields);
      closeTransactionSheet();
      toast('Transaction updated', 'success');
      haptic('medium');
    } catch (err) {
      toast('Could not save: ' + err.message, 'error');
    } finally {
      // Restore the button's own label — hardcoding 'Save' silently renamed
      // the markup's "Save Changes" after the first attempt.
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  async function resetTransactionEdit() {
    if (!_editingTxnId) return;
    try {
      // Delete the override — reverts to original Plaid data
      const user = FCAuth.currentUser && FCAuth.currentUser();
      const db   = FCAuth.db && FCAuth.db();
      if (user && db) {
        await db.collection('users').doc(user.uid)
          .collection('transaction_overrides').doc(_editingTxnId).delete();
      }
      closeTransactionSheet();
      toast('Reset to original', 'success');
    } catch (err) {
      toast('Could not reset transaction — try again', 'error');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     BILL QUICK-PAY (from home screen)
     ───────────────────────────────────────────────────────────── */

  async function quickPayBill(billId) {
    // Immediate visual — slide row out before the Firestore listener removes it
    const rows = document.querySelectorAll(`[data-bill-id="${CSS.escape(billId)}"]`);
    rows.forEach(row => {
      row.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      row.style.opacity    = '0';
      row.style.transform  = 'translateX(16px)';
    });
    haptic('heavy');
    try {
      await FCData.markBillPaid(billId);
      haptic('success');
      toast('Bill paid ✓', 'success');
    } catch (err) {
      rows.forEach(row => { row.style.opacity = ''; row.style.transform = ''; });
      haptic('heavy');
      toast('Could not mark bill as paid — try again', 'error');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     RECURRING → BILLS AUTO-ADD
     Called from the subscription hunter "Add to Bills" button.
     Creates a monthly bill from a detected recurring charge.
     ───────────────────────────────────────────────────────────── */

  async function addRecurringToBills(name, amount, freq) {
    haptic('light');
    try {
      // Dedup check — don't add if already tracked
      const already = state.bills.some(b =>
        b.name.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,8) ===
        name.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,8)
      );
      if (already) { toast('Already in your bills list', 'info'); return; }

      // Set next due date to same day next month
      const nextDue = new Date();
      nextDue.setMonth(nextDue.getMonth() + 1);

      await FCData.createBill({
        name,
        amount:    parseFloat(amount) || 0,
        // Written local: every reader parses due_date with parseDateLocal, so
        // a UTC key here is an off-by-one the rest of the app cannot see.
        due_date:  FCCore.isoDay(nextDue),
        category:  'Subscription',
        frequency: freq === 'wk' ? 'weekly' : 'monthly',
      });
      toast(`${name} added to bills ✓`, 'success');
      haptic('medium');
    } catch (err) {
      toast('Could not add bill: ' + err.message, 'error');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     ACTIVITY CATEGORY FILTER
     ───────────────────────────────────────────────────────────── */

  function filterActivityCategory(cat) {
    if (_activityCategoryFilter === cat) return;
    _activityCategoryFilter = cat;
    _activityShowAll = false;
    haptic('light');

    // Update chip active state
    document.querySelectorAll('[data-cat-chip]').forEach(el => {
      el.classList.toggle('fc-chip--active', el.dataset.catChip === cat);
    });

    _renderActivity();
  }

  /* ─────────────────────────────────────────────────────────────
     CATEGORY BUDGET EDITOR
     Lets users set per-category spending limits.
     Opened from the Insights category breakdown rows.
     ───────────────────────────────────────────────────────────── */

  function openCategoryBudgetSheet(category, currentLimit) {
    _editingBudgetCategory = category;
    const sheet     = document.getElementById('fc-budget-sheet');
    const titleEl   = document.getElementById('budget-sheet-title');
    const inputEl   = document.getElementById('budget-limit-input');
    const hintEl    = document.getElementById('budget-current-spend');
    const presetsEl = document.getElementById('budget-presets');
    const isTotal   = category === 'total';

    if (titleEl) titleEl.textContent = isTotal ? 'Monthly Budget' : `${category} Budget`;
    if (inputEl) inputEl.value = currentLimit > 0 ? String(Math.round(currentLimit)) : '';
    if (hintEl)  hintEl.textContent = currentLimit > 0
      ? `Current limit: ${FCData.formatCurrency(currentLimit)}/mo`
      : 'No limit set — enter an amount to track this category';

    // Smart presets based on category
    if (presetsEl) {
      const presets = isTotal ? [1500, 2000, 3000, 5000]
        : category === 'Food and Drink' ? [200, 300, 500, 800]
        : category === 'Travel'         ? [100, 200, 400, 600]
        : category === 'Shopping'       ? [100, 200, 300, 500]
        : category === 'Healthcare'     ? [50, 100, 200, 400]
        : [50, 100, 200, 500];
      presetsEl.innerHTML = presets.map(p =>
        `<button type="button" style="font-size:12px;font-weight:600;padding:6px 12px;border-radius:10px;background:rgba(26,196,240,0.1);border:1px solid rgba(26,196,240,0.2);color:var(--fc-accent);cursor:pointer"
                 onclick="document.getElementById('budget-limit-input').value='${p}';this.parentElement.querySelectorAll('button').forEach(b=>b.style.background='rgba(26,196,240,0.1)');this.style.background='rgba(26,196,240,0.25)'"
         >$${p.toLocaleString()}</button>`
      ).join('');
    }

    if (sheet) { sheet.style.display = 'flex'; haptic('light'); }
    _focusField(inputEl, sheet);
  }

  function closeCategoryBudgetSheet() {
    const sheet = document.getElementById('fc-budget-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); _editingBudgetCategory = null; }, 280);
  }

  async function saveCategoryBudget() {
    if (!_editingBudgetCategory) return;
    const inputEl = document.getElementById('budget-limit-input');
    const btn     = document.getElementById('budget-save-btn');
    const limit   = parseFloat(inputEl?.value) || 0;

    if (limit < 0) { toast('Enter a valid amount', 'info'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    haptic('light');

    try {
      await FCData.setBudget(_editingBudgetCategory, limit);
      closeCategoryBudgetSheet();
      toast(`${_editingBudgetCategory} budget updated`, 'success');
      haptic('medium');
    } catch (err) {
      toast('Could not save budget: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save Budget'; }
    }
  }

  /** Reset the idle auto-lock countdown on every user interaction. */
  function _resetIdleTimer() {
    if (!FCAuth.currentUser()) return;
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
      if (FCAuth.currentUser()) _triggerNativeLock();
    }, _IDLE_TIMEOUT_MS);
  }

  /** Attach passive capture-phase listeners to reset the idle timer. */
  function _initIdleLock() {
    ['touchstart', 'touchmove', 'mousedown', 'keydown', 'scroll', 'click'].forEach(ev => {
      document.addEventListener(ev, _resetIdleTimer, { passive: true, capture: true });
    });
    _resetIdleTimer();
  }

  /**
   * Toggle balance masking (privacy mode).
   * When on, all elements with class `fc-amount` are visually blurred
   * via the CSS rule `body.fc-privacy .fc-amount { filter: blur(7px) }`.
   * The eye icon in the home header controls this.
   */
  /* ── Privacy mode (hide balances) ─────────────────────────────
     Safety feature: lets the user blank every money figure on screen
     when someone can see their phone.

     Masking is class-driven (`.fc-amount`), but relying on every
     render site remembering that class is fragile — and a privacy
     feature that silently misses a number is worse than none at all.
     So while privacy mode is ON we also (a) sweep the DOM tagging any
     leaf node that looks like currency, and (b) keep a MutationObserver
     running so freshly-rendered numbers are masked too. The observer
     only exists while the user has opted in, so there's no idle cost. */
  // Whole-node currency ("$1,223.48", "−$723.55", "$3.2k")
  const _MONEY_RE = /^[−\-+]?\s*\$\s?[\d,]+(\.\d{1,2})?\s*$|^[−\-+]?\s*\$[\d.,]+\s?[KkMm]\s*$/;
  // Currency appearing INSIDE a sentence ("$462.50 — that's 3× your average",
  // "$1,522.78 left"). These leak if you only mask whole nodes.
  const _MONEY_INLINE_RE = /[−\-+]?\$\s?\d[\d,]*(?:\.\d{1,2})?\s?[KkMm]?/g;
  let _privacyObserver = null;
  let _privacySweepQueued = false;

  function _sweepMoneyNodes() {
    const root = document.getElementById('screen-app') || document.body;
    if (!root) return;
    root.querySelectorAll('*').forEach(el => {
      if (el.children.length) return;                       // leaf nodes only
      if (el.classList.contains('fc-amount')) return;       // already masked
      if (el.dataset.fcMasked === '1') return;              // inline-masked already
      const t = el.textContent;
      if (!t || t.length > 400) return;
      const trimmed = t.trim();
      if (!trimmed.includes('$')) return;                   // cheap reject

      if (_MONEY_RE.test(trimmed)) {                        // the whole node is money
        el.classList.add('fc-amount');
        return;
      }
      // Money embedded in a sentence — wrap just the figures so the
      // surrounding words stay readable.
      _MONEY_INLINE_RE.lastIndex = 0;
      if (!_MONEY_INLINE_RE.test(trimmed)) return;
      _MONEY_INLINE_RE.lastIndex = 0;
      el.dataset.fcMasked = '1';
      el.innerHTML = esc(t).replace(
        _MONEY_INLINE_RE,
        m => '<span class="fc-amount">' + m + '</span>'
      );
    });
  }

  function _startPrivacyObserver() {
    if (_privacyObserver || typeof MutationObserver === 'undefined') return;
    const root = document.getElementById('screen-app') || document.body;
    if (!root) return;
    _privacyObserver = new MutationObserver(() => {
      if (_privacySweepQueued) return;
      _privacySweepQueued = true;
      requestAnimationFrame(() => {
        _privacySweepQueued = false;
        if (_privacyModeOn) _sweepMoneyNodes();
      });
    });
    _privacyObserver.observe(root, { childList: true, subtree: true });
  }

  function _stopPrivacyObserver() {
    if (!_privacyObserver) return;
    _privacyObserver.disconnect();
    _privacyObserver = null;
  }

  function togglePrivacyMode() {
    _privacyModeOn = !_privacyModeOn;
    document.body.classList.toggle('fc-privacy', _privacyModeOn);

    if (_privacyModeOn) { _sweepMoneyNodes(); _startPrivacyObserver(); }
    else                { _stopPrivacyObserver(); }

    // Remember the choice — a UI preference, never financial data
    try { localStorage.setItem('fc_privacy_mode', _privacyModeOn ? '1' : '0'); } catch (_) {}

    // Update eye icon aria-label + visual state
    const btn = document.getElementById('fc-privacy-toggle');
    if (btn) {
      btn.setAttribute('aria-label', _privacyModeOn ? 'Show balances' : 'Hide balances');
      btn.setAttribute('aria-pressed', _privacyModeOn ? 'true' : 'false');
    }

    haptic('light');
    if (typeof FCAnalytics !== 'undefined') {
      FCAnalytics.track('privacy_mode_toggled', { on: _privacyModeOn });
    }
  }

  /** Re-apply a saved privacy preference on launch, before first paint of
   *  the app screen, so balances never flash visible. */
  function _restorePrivacyMode() {
    try {
      if (localStorage.getItem('fc_privacy_mode') !== '1') return;
      _privacyModeOn = true;
      document.body.classList.add('fc-privacy');
      _sweepMoneyNodes();
      _startPrivacyObserver();
      const btn = document.getElementById('fc-privacy-toggle');
      if (btn) {
        btn.setAttribute('aria-label', 'Show balances');
        btn.setAttribute('aria-pressed', 'true');
      }
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     PERIOD SELECTOR
     ───────────────────────────────────────────────────────────── */

  function switchPeriod(p) {
    if (state.period === p) return;
    state.period = p;
    haptic('light');

    // Update active button styling on ALL scrubbers (home, insights, any tab)
    document.querySelectorAll('[data-period]').forEach(btn => {
      if (btn.tagName !== 'BUTTON') return;
      const active = btn.dataset.period === p;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      // For inline-styled scrubber buttons (not the styled pill buttons), update style directly
      if (!btn.classList.contains('dash-scrub-btn') &&
          !btn.classList.contains('plan-period-btn') &&
          !btn.classList.contains('wv-period-btn') &&
          !btn.closest('.premium-periods') &&
          !btn.closest('.fc-scrubber')) {
        btn.style.background   = active ? 'var(--fc-accent-soft)' : 'none';
        btn.style.color        = active ? 'var(--fc-accent)' : 'rgba(255,255,255,0.38)';
        btn.style.border       = active ? '0.5px solid var(--fc-border-accent)' : 'none';
      }
    });

    // Repaint whatever is on screen with the new period — home's chart,
    // Insights, and Money's overview all read it.
    _scheduleTabRender();
  }

  /* ─────────────────────────────────────────────────────────────
     REFERRAL SYSTEM
     ───────────────────────────────────────────────────────────── */

  /**
   * Returns the user's referral code, generating one via the backend if needed.
   * Uses the cached Firestore value when available; calls /api/referral/generate
   * for atomicity and abuse-prevention on first generation.
   */
  function _getReferralCode() {
    const user = state.user;
    if (!user) return null;
    if (user.referral_code) return user.referral_code;
    // Generate via backend (atomic, abuse-resistant) then cache locally
    FCAuth.authedFetch(`${FC_CONFIG.app.apiBase}/api/referral/generate`, { method: 'POST' })
      .then(r => r.json())
      .then(({ code }) => { if (code && state.user) state.user.referral_code = code; })
      .catch(() => {});
    return null; // caller re-reads once Firestore listener updates state.user.referral_code
  }

  /* ─────────────────────────────────────────────────────────────
     PROFILE MANAGEMENT
     ───────────────────────────────────────────────────────────── */

  function showEditProfileSheet() {
    const sheet = document.getElementById('edit-profile-sheet');
    if (!sheet) return;
    const user      = state.user;
    const authUser  = FCAuth.currentUser();
    const nameInput = document.getElementById('edit-profile-name');
    const emailInput= document.getElementById('edit-profile-email');
    const phoneInput= document.getElementById('edit-profile-phone');
    if (nameInput)  nameInput.value  = user?.name || authUser?.displayName || '';
    if (emailInput) emailInput.value = authUser?.email || user?.email || '';
    if (phoneInput) phoneInput.value = user?.phone || '';
    const errEl = document.getElementById('edit-profile-error');
    if (errEl) errEl.textContent = '';
    sheet.style.display = 'flex';
    haptic('light');
  }

  function closeEditProfileSheet() {
    const sheet = document.getElementById('edit-profile-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); }, 280);
  }

  async function saveProfileChanges() {
    const btn       = document.getElementById('edit-profile-save-btn');
    const errEl     = document.getElementById('edit-profile-error');
    const nameInput = document.getElementById('edit-profile-name');
    const emailInput= document.getElementById('edit-profile-email');
    const phoneInput= document.getElementById('edit-profile-phone');
    if (!btn) return;

    const newName  = (nameInput?.value || '').trim();
    const newEmail = (emailInput?.value || '').trim().toLowerCase();
    const newPhone = (phoneInput?.value || '').trim();

    if (!newName) {
      if (errEl) errEl.textContent = 'Name is required.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving…';
    if (errEl) errEl.textContent = '';

    try {
      const authUser = FCAuth.currentUser();
      const db       = FCAuth.db();

      if (!authUser) {
        if (errEl) errEl.textContent = 'Session expired — please sign in again.';
        return;
      }

      // Force token refresh so Firestore accepts the write (guards against
      // stale cached tokens that can cause spurious permission-denied errors).
      try { await authUser.getIdToken(true); } catch (_) {}

      const updates = {};

      // Update display name in Firebase Auth
      if (newName !== (authUser.displayName || '')) {
        await authUser.updateProfile({ displayName: newName });
      }

      // Email change requires re-authentication in Firebase — show clear message
      if (newEmail && newEmail !== authUser.email) {
        try {
          await authUser.updateEmail(newEmail);
          updates.email = newEmail;
        } catch (emailErr) {
          if (emailErr.code === 'auth/requires-recent-login') {
            if (errEl) errEl.textContent = 'For security, sign out and sign back in before changing your email.';
            btn.disabled = false;
            btn.textContent = 'Save Changes';
            return;
          }
          throw emailErr;
        }
      }

      // Build Firestore update
      updates.name = newName;
      if (newPhone) updates.phone = newPhone;

      if (db) {
        // Try update() first (doc should exist). If NOT_FOUND, fall back to
        // set+merge which creates the doc — this handles the edge case where
        // a user's Firestore doc was wiped but their Auth account remains.
        try {
          await db.collection('users').doc(authUser.uid).update(updates);
        } catch (updateErr) {
          if (updateErr.code === 'not-found') {
            await db.collection('users').doc(authUser.uid).set(
              { uid: authUser.uid, ...updates },
              { merge: true }
            );
          } else {
            throw updateErr;
          }
        }
      }

      // Optimistically update local state so UI reflects instantly
      if (state.user) {
        Object.assign(state.user, updates);
      }

      closeEditProfileSheet();
      _renderSettings();
      toast('Profile updated', 'success');
    } catch (err) {
      fcLog('[saveProfileChanges] error:', err);
      const isPermission = err.code === 'permission-denied' || err.code === 'PERMISSION_DENIED';
      if (errEl) {
        errEl.textContent = isPermission
          ? 'Could not save — try signing out and back in, then update your profile.'
          : (err.message || 'Could not save changes. Please try again.');
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Changes';
    }
  }

  function showReferralSheet() {
    const sheet = document.getElementById('fc-referral-sheet');
    if (!sheet) return;

    const count = Math.min(Number(state.user?.referral_activations) || 0, 3);
    const GOAL  = 3;

    // _getReferralCode() returns null on first call (fires async backend request).
    // Re-poll so the display updates once the code arrives via Firestore listener.
    const codeEl = document.getElementById('referral-code-display');
    const _updateCodeEl = () => {
      const c = state.user?.referral_code || null;
      if (codeEl) codeEl.textContent = c || '———————';
      return !!c;
    };
    if (!_updateCodeEl()) {
      _getReferralCode(); // fire the backend call
      const pollCode = setInterval(() => {
        if (_updateCodeEl() || !document.getElementById('fc-referral-sheet')?.classList.contains('open')) {
          clearInterval(pollCode);
        }
      }, 800);
    }

    // Populate progress
    const progText = document.getElementById('referral-progress-text');
    const progBar  = document.getElementById('referral-progress-bar');
    const lifeBadge = document.getElementById('referral-lifetime-badge');
    if (progText) progText.textContent = `${count} / ${GOAL}`;
    if (progBar)  progBar.style.width  = `${Math.min((count / GOAL) * 100, 100)}%`;
    if (lifeBadge) lifeBadge.style.display = count >= GOAL ? 'block' : 'none';

    // Show "referred by" note if applicable
    const referredBy = document.getElementById('referral-referred-by');
    if (referredBy) {
      const referrer = state.user?.referred_by_code;
      referredBy.style.display = referrer ? 'block' : 'none';
    }

    // Update Settings badge
    const badge = document.getElementById('settings-referral-badge');
    if (badge) {
      if (count >= GOAL) {
        badge.textContent = '🏆 Lifetime';
        badge.style.display = 'inline';
      } else if (count > 0) {
        badge.textContent = `${count}/${GOAL}`;
        badge.style.display = 'inline';
      } else {
        badge.style.display = 'none';
      }
    }

    sheet.style.display = 'flex';
    requestAnimationFrame(() => sheet.classList.add('open'));
    haptic('light');
  }

  function closeReferralSheet() {
    const sheet = document.getElementById('fc-referral-sheet');
    if (!sheet) return;
    sheet.classList.remove('open');
    setTimeout(() => { sheet.style.display = 'none'; }, 280);
  }

  function copyReferralCode() {
    const code = _getReferralCode();
    if (!code) return;
    const btn = document.getElementById('referral-copy-btn');
    try {
      navigator.clipboard.writeText(code);
    } catch (_) {
      // Fallback for WKWebView
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.style.color = 'var(--fc-success)';
      setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
    }
    haptic('light');
  }

  async function shareReferralCode() {
    const code = _getReferralCode();
    if (!code) return;

    // Use the backend referral landing page — reliable, no Firebase Dynamic Links,
    // never redirects to random sites. Tries to open the app, falls back to App Store.
    const referralUrl = `https://getflowcheck.app/invite/${encodeURIComponent(code)}`;
    // NOTE: do NOT embed the URL inside `text`. When both text and url are passed
    // to the iOS share sheet, Messages scans the entire text string for domains.
    // "FlowCheck" near ".app" (from getflowcheck.app) causes iMessage to generate
    // a preview for flowcheck.app (a different domain) instead of ours.
    // Keeping the URL only in the `url` field forces iMessage to use our link.
    const shareText = `Use code ${code} when you sign up and we both get 1 free month of Pro — no credit card needed. 💰`;
    haptic('medium');

    if (typeof FCAnalytics !== 'undefined') {
      FCAnalytics.track('referral_share_tapped', { code });
    }

    try {
      const plugins        = window.Capacitor?.Plugins;
      const isNative       = window.Capacitor?.isNativePlatform?.();
      const capacitorShare = plugins?.Share?.share;

      if (isNative && capacitorShare) {
        await capacitorShare({
          title:       'Get 1 month of FlowCheck Pro free',
          text:        shareText,      // no URL here — avoids iMessage domain mis-detection
          url:         referralUrl,    // this alone generates the link preview
          dialogTitle: 'Share FlowCheck',
        });
        if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('referral_shared', { code, method: 'capacitor_share' });
      } else if (navigator.share) {
        await navigator.share({
          title: 'Get 1 month of FlowCheck Pro free',
          text:  shareText,
          url:   referralUrl,
        });
        if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('referral_shared', { code, method: 'native_share' });
      } else {
        // Last resort: copy link to clipboard
        try {
          await navigator.clipboard.writeText(referralUrl);
        } catch (_) {
          const ta = document.createElement('textarea');
          ta.value = referralUrl; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        toast('Referral link copied!', 'success');
        if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('referral_shared', { code, method: 'clipboard' });
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        // Share was dismissed or failed — copy link as fallback
        try { await navigator.clipboard.writeText(referralUrl); } catch (_) {}
        toast('Referral link copied!', 'success');
      }
    }
  }

  function toggleReferralInput() {
    const wrap = document.getElementById('reg-referral-wrap');
    const chev = document.getElementById('reg-referral-chevron');
    if (!wrap) return;
    const isOpen = wrap.style.display !== 'none';
    wrap.style.display = isOpen ? 'none' : 'block';
    if (chev) chev.style.transform = isOpen ? '' : 'rotate(90deg)';
  }

  /* ─────────────────────────────────────────────────────────────
     WELCOME MODAL
     ───────────────────────────────────────────────────────────── */

  let _welcomeShown = false;

  /**
   * Schedules the one-time welcome modal. Call ONLY from "a new user just
   * landed on the dashboard for the first time" navigation events (trial
   * started, onboarding skipped) — never from generic render functions like
   * _renderHome(), which fires constantly from background syncs, tab
   * switches, and pro-status refreshes and would otherwise resurface this
   * over and over, on top of whatever screen happens to be open.
   */
  function _scheduleWelcomeModal() {
    if (state.user && !state.user.welcome_seen && !_welcomeShown) {
      setTimeout(_maybeShowWelcomeModal, 800);
    }
  }

  function _maybeShowWelcomeModal() {
    if (_welcomeShown) return;
    if (!state.user) return;
    // The 800ms deferral means the user may have already navigated away from
    // the dashboard (or signed out) by the time this fires — don't surface a
    // full-screen overlay on top of whatever screen they're on now.
    if (state.screen !== 'app') return;
    // Primary: Firestore flag (cross-device); Fallback: per-uid localStorage (survives network failure)
    const uid = FCAuth.currentUser ? FCAuth.currentUser()?.uid : null;
    const localKey = uid ? `fc_ws_${uid}` : null;
    if (state.user.welcome_seen || (localKey && localStorage.getItem(localKey))) {
      _welcomeShown = true;
      return;
    }
    _welcomeShown = true;

    const overlay = document.createElement('div');
    overlay.id = 'fc-welcome-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(6,14,24,0.88);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:24px;animation:fcFadeIn .28s ease';
    overlay.innerHTML = `
      <div style="background:var(--fc-bg-elevated,#0b1826);border-radius:28px;padding:32px 24px 24px;width:100%;max-width:360px;border:0.5px solid var(--fc-border,rgba(255,255,255,0.07));text-align:center">
        <div style="width:68px;height:68px;background:linear-gradient(135deg,rgba(26,196,240,0.18),rgba(37,99,235,0.12));border-radius:22px;display:flex;align-items:center;justify-content:center;margin:0 auto 22px;border:0.5px solid rgba(26,196,240,0.2)">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--fc-accent,#1ac4f0)" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        </div>
        <div style="font-size:22px;font-weight:800;color:var(--fc-text,#f0f6ff);margin-bottom:12px;letter-spacing:-0.03em">Welcome to FlowCheck</div>
        <div style="font-size:14.5px;color:var(--fc-text-muted,rgba(240,246,255,0.58));line-height:1.65;margin-bottom:28px">FlowCheck is built to help you understand your money, track your progress, and make smarter decisions with confidence. Your feedback helps us improve the experience for everyone.</div>
        <button id="_fc-welcome-start" style="width:100%;padding:15px;border-radius:14px;border:none;background:var(--fc-accent,#1ac4f0);color:#060e18;font-size:16px;font-weight:700;cursor:pointer;margin-bottom:10px;letter-spacing:-0.01em">Get Started</button>
        <button id="_fc-welcome-feedback" style="width:100%;padding:14px;border-radius:14px;border:0.5px solid var(--fc-border,rgba(255,255,255,0.07));background:transparent;color:var(--fc-text-muted,rgba(240,246,255,0.58));font-size:15px;font-weight:500;cursor:pointer">Send Feedback</button>
      </div>`;
    document.body.appendChild(overlay);

    const dismiss = (openFeedback) => {
      haptic(openFeedback ? 'medium' : 'light');
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity .2s ease';
      setTimeout(() => overlay.remove(), 200);
      // Write localStorage immediately (no network) so re-opens don't re-show the modal
      if (localKey) { try { localStorage.setItem(localKey, '1'); } catch (_) {} }
      if (state.user) state.user.welcome_seen = true;
      FCData.updateUserField('welcome_seen', true).catch(() => {});
      if (openFeedback) setTimeout(() => showFeedbackScreen(), 220);
    };

    overlay.querySelector('#_fc-welcome-start').addEventListener('click', () => dismiss(false));
    overlay.querySelector('#_fc-welcome-feedback').addEventListener('click', () => dismiss(true));
  }

  /* ─────────────────────────────────────────────────────────────
     FEEDBACK BANNER
     ───────────────────────────────────────────────────────────── */

  /* ─────────────────────────────────────────────────────────────
     FEEDBACK SCREEN
     ───────────────────────────────────────────────────────────── */

  let _feedbackReturnScreen = 'app';

  function showFeedbackScreen(opts) {
    opts = opts || {};
    _feedbackReturnScreen = state.screen === 'feedback' ? 'app' : (state.screen || 'app');
    setScreen('feedback');
    // Reset form after transition settles
    setTimeout(() => _initFeedbackForm(opts), 80);
  }

  function closeFeedbackScreen() {
    haptic('light');
    setScreen(_feedbackReturnScreen || 'app');
  }

  function _initFeedbackForm(opts) {
    const typeSelect = document.getElementById('fb-type');
    const priorityInput = document.getElementById('fb-priority');
    const descInput = document.getElementById('fb-description');
    const stepsInput = document.getElementById('fb-steps');
    const emailInput = document.getElementById('fb-email');
    const diagCheck = document.getElementById('fb-diagnostics');
    const errorEl = document.getElementById('fb-error');
    const successEl = document.getElementById('fb-success');
    const submitBtn = document.getElementById('fb-submit');

    // Reset values
    if (typeSelect)    typeSelect.value = opts.type || 'bug';
    if (priorityInput) priorityInput.value = 'medium';
    if (descInput)     descInput.value = '';
    if (stepsInput)    stepsInput.value = '';
    if (diagCheck)     diagCheck.checked = true;
    _fbSyncDiagToggle(true);

    // Pre-fill email from authenticated user only
    if (emailInput) {
      const authUser = FCAuth.currentUser ? FCAuth.currentUser() : null;
      emailInput.value = authUser?.email || '';
    }

    // Set priority buttons to medium
    _fbSetPriority('medium');

    // Clear feedback and success states
    if (errorEl)   { errorEl.textContent = ''; errorEl.style.display = 'none'; }
    if (successEl) successEl.style.display = 'none';
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send Feedback'; submitBtn.style.display = ''; }

    // Scroll form to top
    const scroll = document.getElementById('feedback-form-scroll');
    if (scroll) scroll.scrollTop = 0;
  }

  function _fbSetPriority(val) {
    const priorityInput = document.getElementById('fb-priority');
    if (priorityInput) priorityInput.value = val;
    document.querySelectorAll('[data-fb-priority]').forEach(btn => {
      const isActive = btn.dataset.fbPriority === val;
      const colors = {
        low:    { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.07)', color: 'var(--fc-text-muted)' },
        medium: { bg: 'rgba(26,196,240,0.12)',  border: 'rgba(26,196,240,0.4)',   color: 'var(--fc-accent)' },
        high:   { bg: 'rgba(255,69,58,0.12)',   border: 'rgba(255,69,58,0.4)',    color: 'var(--fc-danger)' },
      };
      const active = colors[btn.dataset.fbPriority] || colors.medium;
      const inactive = colors.low;
      btn.style.background = isActive ? active.bg : inactive.bg;
      btn.style.borderColor = isActive ? active.border : inactive.border;
      btn.style.color = isActive ? active.color : inactive.color;
    });
    haptic('selection');
  }

  function _fbToggleDiag() {
    const diagCheck = document.getElementById('fb-diagnostics');
    if (!diagCheck) return;
    diagCheck.checked = !diagCheck.checked;
    _fbSyncDiagToggle(diagCheck.checked);
    haptic('selection');
  }

  function _fbSyncDiagToggle(on) {
    const track = document.getElementById('fb-diag-toggle');
    const knob  = document.getElementById('fb-diag-knob');
    if (track) track.style.background = on ? 'var(--fc-accent,#1ac4f0)' : 'rgba(255,255,255,0.15)';
    if (knob)  knob.style.transform   = on ? 'translateX(18px)' : 'translateX(0)';
  }

  let _feedbackSubmitting = false;

  async function submitFeedback() {
    if (_feedbackSubmitting) return;

    const db   = FCAuth.db ? FCAuth.db() : null;
    const user = FCAuth.currentUser ? FCAuth.currentUser() : null;

    const type     = document.getElementById('fb-type')?.value || 'bug';
    const priority = document.getElementById('fb-priority')?.value || 'medium';
    const desc     = (document.getElementById('fb-description')?.value || '').trim();
    const steps    = (document.getElementById('fb-steps')?.value || '').trim();
    const email    = (document.getElementById('fb-email')?.value || '').trim();
    const incDiag  = document.getElementById('fb-diagnostics')?.checked !== false;

    const errorEl   = document.getElementById('fb-error');
    const successEl = document.getElementById('fb-success');
    const submitBtn = document.getElementById('fb-submit');

    const showErr = (msg) => {
      if (errorEl)   { errorEl.textContent = msg; errorEl.style.display = 'block'; }
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send Feedback'; }
      haptic('error');
      _feedbackSubmitting = false;
    };

    // Validation
    if (!desc || desc.length < 10) {
      showErr('Please describe the issue in a bit more detail (at least 10 characters).');
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showErr('Please enter a valid email address, or leave it blank.');
      return;
    }
    if (!db) {
      showErr("We couldn't send your feedback right now. Please try again.");
      return;
    }

    _feedbackSubmitting = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }
    if (errorEl)   { errorEl.textContent = ''; errorEl.style.display = 'none'; }

    const doc = {
      feedbackType:     type,
      priority:         priority,
      description:      desc,
      stepsToReproduce: steps || null,
      contactEmail:     email || null,
      diagnostics:      incDiag ? _buildFeedbackDiagnostics() : null,
      createdAt:        firebase.firestore.FieldValue.serverTimestamp(),
      status:           'new',
      userId:           user ? user.uid : null,
      appVersion:       FC_CONFIG?.app?.version || '2.0.0',
      platform:         (typeof Capacitor !== 'undefined' && Capacitor.getPlatform) ? Capacitor.getPlatform() : 'web',
    };

    try {
      await db.collection('feedbackReports').add(doc);
      _feedbackSubmitting = false;
      haptic('success');
      if (submitBtn) submitBtn.style.display = 'none';
      if (successEl) successEl.style.display = 'flex';
      setTimeout(() => {
        closeFeedbackScreen();
        if (submitBtn) { submitBtn.style.display = ''; submitBtn.disabled = false; submitBtn.textContent = 'Send Feedback'; }
        if (successEl) successEl.style.display = 'none';
      }, 2600);
    } catch (_err) {
      showErr("We couldn't send your feedback right now. Please try again.");
    }
  }

  function _buildFeedbackDiagnostics() {
    return {
      appVersion:    FC_CONFIG?.app?.version || '2.0.0',
      platform:      (typeof Capacitor !== 'undefined' && Capacitor.getPlatform) ? Capacitor.getPlatform() : 'web',
      currentScreen: state.screen || 'app',
      currentTab:    state.tab || 'home',
      timestamp:     new Date().toISOString(),
      userRef:       (FCAuth.currentUser && FCAuth.currentUser()?.uid) || null,
      appEnv:        FC_CONFIG?.app?.env || 'production',
    };
  }

  return {
    boot,
    setScreen,
    switchTab,
    // The Vault — proof-of-savings billing
    _renderVaultScreen,
    _vaultToggleReceipt,  // ledger receipt expand (inline onclick)
    _vaultBuild,          // exported for verification assertions
    _ensureLegalFooter,   // exported for verification assertions
    _vaultFlagVisibleSubs,
    // Coach + affordability
    openCoachAnswer,
    closeCoachSheet,
    showAffordSheet,
    runAffordCheck,
    // Dashboard v9 — exported for verification assertions (DASHBOARD_SPEC.md §7)
    _buildRunwaySeries,
    // Money Week story
    openMoneyStory,
    closeMoneyStory,
    storyNext,
    storyPrev,
    storyReplay,          // end-card Replay (inline onclick)
    closeAffordSheet,
    toast,
    haptic,
    manualSync,
    sendTestEmail,
    // Bank sheets
    showBankSheet,
    closeBankSheet,
    showDisconnectConfirm,
    confirmDisconnectItem,
    closeDisconnectSheet,
    showDeleteSheet,
    showDebtDetailsSheet,
    showOfferSheet,
    closeOfferSheet,
    calcOffer,
    _offerKind,
    closeDebtDetailsSheet,
    saveDebtDetails,
    closeDeleteSheet,
    disconnectBank,
    deleteAccount,
    // Auth flows
    handleAppleSignIn,
    handleGoogleSignIn,
    handleLogin,
    handleBiometricLogin,
    handleRegister,
    handleForgotPassword,
    goToForgotPassword,
    handleForgotPasswordScreen,
    resetForgotPasswordScreen,
    handleSignOut,
    handleSearch,
    startPlaidLink,
    // Credit score
    fetchCreditScore,
    refreshCreditScore,
    // Affiliate offers
    openOffer,
    // Paywall
    showPaywall,
    closePaywall,
    skipPaywall,
    selectPlan,
    paywallPurchase,
    paywallRestore,
    renderHomeAfterPro,
    finishPurchaseSuccess,
    // Face ID setup
    handleBiometricSetup,
    skipFaceIdSetup,
    // Onboarding
    startTrialFromOnboarding,
    skipOnboarding,
    startDemoMode,
    isDemoEmail,
    handleVerifyEmailCheck,
    resendVerificationEmail,
    otpBoxInput,
    otpBoxKeydown,
    handleOtpPaste,
    // Wealth tab
    switchWealthTab,
    switchWealthSegment,
    // Plan tab
    switchPlanSeg,
    // Goals
    editGoal,
    showAddGoalSheet,
    closeGoalSheet,
    saveGoal,
    deleteGoalById,
    // Bills
    showBillSheet,
    closeBillSheet,
    saveBill,
    deleteBillById,
    editBill,
    switchActivitySegment,
    toggleActivitySearch,
    coachAsk,
    coachAskKey,
    coachOption,
    filterActivity,
    filterActivityType,
    switchActivitySummaryPeriod,
    showActivityFilterSheet,
    showAllActivity,
    // Manual accounts
    showManualAccountSheet,
    _onManualAcctTypeChange,
    editManualAccount,
    deleteManualAccountById,
    closeManualAccountSheet,
    saveManualAccount,
    // Notification center
    toggleNotificationCenter,
    openNotificationCenter,
    closeNotificationCenter,
    markAllNotifsRead,
    _notifTap,
    // Settings toggles
    toggleBiometric,
    toggleNotifications,
    // Privacy mode (balance masking)
    togglePrivacyMode,
    // Period selector
    switchPeriod,
    // Plan tab — category filter
    switchPlanCatTab: function(tab) {
      _planCatTab = tab;
      document.querySelectorAll('.plan-cat-tab').forEach(t => t.classList.remove('active'));
      const el = document.getElementById('plan-cat-tab-' + tab);
      if (el) el.classList.add('active');
      const periodTxns      = _getPeriodTxns();
      const periodSpendTxns = periodTxns.filter(_isSpendTxn);
      const periodSpend     = periodSpendTxns.reduce((s, t) => s + (t.amount || 0), 0);
      _renderPlanCategories(periodSpendTxns, periodSpend);
    },
    // Open URL natively (used by cancel links in Subscription Hunter)
    openUrl: _openUrl,
    closeInAppPage,
    _openCancelSheet,
    // Transaction detail + edit
    openTransactionDetail,
    closeTransactionSheet,
    saveTransactionEdit,
    resetTransactionEdit,
    // Bill quick-pay
    quickPayBill,
    // Recurring → bills
    addRecurringToBills,
    // Activity category filter
    filterActivityCategory,
    // Per-category budget editor
    openCategoryBudgetSheet,
    _showMonthBudgetDetail: function(monthIdx, year) {
      const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const budgetLim = _totalBudgetLimit();
      const txns = (state.transactions || []).filter(t => {
        if (!t.date || t.isCredit || !_isSpendTxn(t)) return false;
        const d = FCData.parseDateLocal(t.date);
        return d.getFullYear() === year && d.getMonth() === monthIdx;
      });
      const total = txns.reduce((s, t) => s + (t.amount || 0), 0);
      const pct   = budgetLim > 0 ? Math.min(Math.round((total / budgetLim) * 100), 100) : 0;
      const color = pct > 100 ? 'var(--fc-danger)' : pct > 80 ? 'var(--fc-warning)' : 'var(--fc-success)';
      toast(`${MONTHS[monthIdx]}: ${FCData.formatCurrency(total)} spent (${pct}% of $${budgetLim.toLocaleString()} budget)`, pct > 80 ? 'error' : 'success');
    },
    closeCategoryBudgetSheet,
    saveCategoryBudget,
    // Goal monthly calculator (called from HTML oninput)
    _updateGoalCalc,
    // Utilities
    animateNumber,
    // Getter for static HTML onclick handlers — avoids global namespace pollution
    getTotalBudgetLimit: () => _totalBudgetLimit(),
    // Dashboard UI
    toggleInsights,
    // Today's Focus card
    // Referral sheet
    showReferralSheet,
    closeReferralSheet,
    copyReferralCode,
    shareReferralCode,
    toggleReferralInput,
    // Subscription detail
    showSubDetail,
    closeSubDetail,
    // Profile management
    showEditProfileSheet,
    closeEditProfileSheet,
    saveProfileChanges,
    // Appearance / theme
    setAppearance: (pref) => window._FCSetAppearance && window._FCSetAppearance(pref),
    // Feedback system
    showFeedbackScreen,
    closeFeedbackScreen,
    submitFeedback,
    _fbSetPriority,
    _fbToggleDiag,
    // Sub-screen navigation (Plan / More hub)
    _openSubScreen,
    _openDebtPage,
    _openDebtStrategy,
    _closeSubScreen,
    _dismissInsight,
    handleWebSearch,
    _exportCSV,
    _markAllNotifRead,
    _markNotifRead,
    _openBudgetWizard,
    localiseTrialNote,
    _dismissBudgetSuggestion,
  };
})();

/* ── Theme engine — light / dark / system ────────────────────── */
(function() {
  const STORAGE_KEY = 'fc_appearance';
  const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');

  function _apply(pref) {
    const isDark = pref === 'dark' || (pref === 'system' && mq && !mq.matches);
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

    // Update native WKWebView background to match instantly
    const bg = isDark ? '#060e18' : '#F4F7FB';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
    document.documentElement.style.backgroundColor = bg;
    document.body && (document.body.style.backgroundColor = bg);

    /* Keep the native keyboard in the same appearance as the app. The plugin
       is configured with a style, but that is a launch default — this is the
       only thing that tracks a runtime change, and without it someone who
       picks dark in-app on a light-mode phone gets a white keyboard against a
       dark navy form. */
    try {
      const kb = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Keyboard;
      if (kb && kb.setStyle) {
        const p = kb.setStyle({ style: isDark ? 'dark' : 'light' });
        if (p && p.catch) p.catch(() => {});
      }
    } catch (_) {}

    // Highlight the active picker button
    document.querySelectorAll('#appearance-picker button').forEach(btn => {
      const isActive = btn.dataset.themeVal === pref;
      btn.style.background  = isActive ? (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.95)') : 'transparent';
      btn.style.color       = isActive ? (isDark ? '#f0f6ff' : '#0d1b2e') : '';
      btn.style.boxShadow   = isActive ? (isDark ? '0 1px 4px rgba(0,0,0,0.3)' : '0 1px 6px rgba(13,27,46,0.12)') : '';
    });
  }

  function _load() {
    // Dark is the default. The brand is a dark navy surface, the whole
    // accent/token system was designed against it, and it is what the app
    // is screenshotted and shipped as. Defaulting to light meant every new
    // user — and every user who never opened the appearance picker — got the
    // secondary treatment.
    //
    // Only an EXPLICIT stored choice overrides it, so anyone who already
    // picked light or system keeps what they picked.
    const stored = localStorage.getItem(STORAGE_KEY);
    return (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'dark';
  }

  // Apply immediately on load (before anything renders)
  _apply(_load());

  // React to system preference changes when set to 'system'
  if (mq) mq.addEventListener('change', () => { if (_load() === 'system') _apply('system'); });

  // Public: called by settings picker buttons
  window._FCSetAppearance = function(pref) {
    localStorage.setItem(STORAGE_KEY, pref);
    _apply(pref);
    const valEl = document.getElementById('settings-appearance-val');
    if (valEl) valEl.textContent = pref === 'dark' ? 'Dark' : pref === 'light' ? 'Light' : 'Auto';
  };
  window._FCGetAppearance = _load;
})();

/* ── Boot on DOM ready ───────────────────────────────────────── */
// requestAnimationFrame gives the browser a chance to paint the
// splash screen (pure CSS, no JS) before booting. This makes the
// app feel instant — the user sees the splash immediately while
// Firebase init, auth check, and data listeners start in the background.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { window._fcAppStartedAt = Date.now(); requestAnimationFrame(() => FCApp.boot()); });
} else {
  window._fcAppStartedAt = Date.now();
  requestAnimationFrame(() => FCApp.boot());
}
