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
  };

  // Tracks which specific item is being disconnected (null = disconnect all)
  let _pendingDisconnectItemId = null;
  let _lastSyncFailed = false;

  // Transaction edit state
  let _editingTxnId = null;

  // Category budget edit state
  let _editingBudgetCategory = null;

  // Activity category filter ('all' or a category name)
  let _activityCategoryFilter = 'all';

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
  const _PERIOD_LABELS = { '1D':'today', '1W':'this week', '1M':'this month', '3M':'3 months', '1Y':'this year', 'All':'all time' };

  // ── Shared spend-transaction filter ──────────────────────────────
  // Excludes transfers, loan payments, and credit card payments so they don't
  // pollute spending totals, budgets, or insights.  Used by every widget that
  // needs "real" discretionary spend (pulse, insights, stat card, health score).
  const _XFER_SKIP = new Set([
    'transfer', 'loan', 'loan payments', 'loan payment',
    'credit card payment', 'transfer in', 'transfer out',
  ]);
  function _isSpendTxn(t) {
    if (t.isCredit || !t.date) return false;
    const raw  = (Array.isArray(t.category) ? t.category[0] : t.category) || '';
    const norm = FCData.normalizePlaidCategory(raw).toLowerCase();
    return !_XFER_SKIP.has(norm) && !norm.includes('transfer');
  }

  // ── Shared income-transaction filter ─────────────────────────────
  // Strategy: count ALL credits as income, exclude only explicit non-income
  // categories. Plaid frequently classifies direct deposits and paychecks as
  // "Transfer" or "TRANSFER_IN" — a whitelist approach silently drops them.
  //
  // Hard-exclude only:
  //   • Outbound transfers (credit to loan, CC payment, transfer out)
  //   • Loan and credit card payments (money leaving to pay a debt)
  // Everything else that is a credit (isCredit=true) is income.
  const _INCOME_HARD_EXCLUDE = new Set([
    'credit card', 'credit card payment', 'loan payment', 'loan payments',
    'transfer out', 'payment',
  ]);
  function _isIncomeTxn(t) {
    if (!t.isCredit || !t.date) return false;
    const raw  = ((Array.isArray(t.category) ? t.category[0] : t.category) || '').trim();
    const norm = FCData.normalizePlaidCategory(raw).toLowerCase();
    // Exclude explicit payment/outbound categories only
    if (_INCOME_HARD_EXCLUDE.has(raw.toLowerCase())) return false;
    if (_INCOME_HARD_EXCLUDE.has(norm)) return false;
    if (norm.includes('credit card') || norm.includes('loan payment')) return false;
    // All other credits (transfers in, income, deposits, refunds, cashback) = income
    return true;
  }

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
        <div style="font-size:32px;font-weight:800;color:var(--fc-text);margin-bottom:2px">${FCData.formatCurrency(sub.amount)}<span style="font-size:16px;font-weight:500;color:var(--fc-text-muted)">/${sub.freq}</span></div>
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
          <span style="font-size:13px;font-weight:600;color:var(--fc-warning)">${nextLabel}</span>
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

  /* ── Net Worth History (Firestore sparkline, localStorage for instant render) ── */
  // localStorage key kept for same-session immediate sparkline draw;
  // Firestore is the durable store that survives reinstall/device switch.
  function _snapshotNetWorth(netWorth) {
    // Capture uid before any async gap to avoid races with sign-out
    const uid = state.user?.uid;
    if (!uid || !state.user?.plaid_linked) return;

    const today = new Date().toISOString().split('T')[0];

    // Firestore write — best-effort, never blocks the UI
    FCData.saveNetWorthSnapshot(today, netWorth).catch(() => {});

    // One-time cleanup of legacy localStorage net worth data
    try {
      if (localStorage.getItem('fc_nw_history')) localStorage.removeItem('fc_nw_history');
      const legacyKey = `fc_nw_history_${uid}`;
      if (localStorage.getItem(legacyKey)) localStorage.removeItem(legacyKey);
    } catch (_) {}

    _drawNetWorthSparkline(state.nwHistory);
  }

  function _drawNetWorthSparkline(history) {
    const linePath = document.getElementById('sparkline-line');
    const areaPath = document.getElementById('sparkline-area');
    const dot      = document.getElementById('sparkline-dot');
    const dotBg    = document.getElementById('sparkline-dot-bg');
    const deltaEl  = document.getElementById('hero-delta');
    if (!linePath || !areaPath) return;

    // Filter history to the selected period window
    const _PERIOD_DAYS = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '1Y': 365, 'ALL': 0 };
    const windowDays = _PERIOD_DAYS[state.period];
    let allKeys = Object.keys(history).sort();
    if (windowDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - windowDays);
      const cutoffStr = cutoff.toISOString().split('T')[0];
      allKeys = allKeys.filter(k => k >= cutoffStr);
    }

    const keys   = allKeys;
    const values = keys.map(k => history[k]);
    // Need at least 1 data point to draw; pad to 2 so the bezier always has a path
    if (values.length < 1) return;
    const displayValues = values.length === 1 ? [values[0], values[0]] : values;

    const W = 320, H = 60, PAD = 4;
    const min  = Math.min(...displayValues);
    const max  = Math.max(...displayValues);
    // When all values are identical (flat), offset min slightly so the line renders midscreen
    const range = max - min || Math.abs(max) * 0.01 || 1;

    const toX = (i) => Math.round((i / (displayValues.length - 1)) * W);
    const toY = (v) => Math.round(PAD + (1 - (v - min) / range) * (H - PAD * 2));

    // Build smooth cubic bezier path
    let line = `M${toX(0)},${toY(displayValues[0])}`;
    for (let i = 1; i < displayValues.length; i++) {
      const x0 = toX(i - 1), y0 = toY(displayValues[i - 1]);
      const x1 = toX(i),     y1 = toY(displayValues[i]);
      const cpX = (x0 + x1) / 2;
      line += ` C${cpX},${y0} ${cpX},${y1} ${x1},${y1}`;
    }
    const lastX = toX(displayValues.length - 1);
    const lastY = toY(displayValues[displayValues.length - 1]);

    // Thicker line + stronger glow
    linePath.setAttribute('d', line);
    linePath.setAttribute('stroke-width', '2.5');
    areaPath.setAttribute('d', `${line} L${lastX},${H} L0,${H} Z`);

    // Animate the endpoint dot with a CSS pulse
    if (dot) {
      dot.setAttribute('cx', lastX);
      dot.setAttribute('cy', lastY);
      dot.setAttribute('r', '3.5');
      // Add pulse ring as sibling element if not already present
      const sparkSvg = dot.closest('svg');
      if (sparkSvg) {
        let pulse = sparkSvg.querySelector('#sparkline-pulse');
        if (!pulse) {
          pulse = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          pulse.setAttribute('id', 'sparkline-pulse');
          pulse.setAttribute('fill', 'none');
          pulse.setAttribute('stroke-width', '1.5');
          pulse.setAttribute('opacity', '0');
          pulse.style.cssText = 'stroke:var(--fc-accent);animation:sparkPulse 2s ease-out infinite';
          sparkSvg.appendChild(pulse);
          // Inject keyframes once
          if (!document.getElementById('spark-pulse-style')) {
            const s = document.createElement('style');
            s.id = 'spark-pulse-style';
            s.textContent = '@keyframes sparkPulse{0%{r:3.5px;opacity:0.8}100%{r:10px;opacity:0}}';
            document.head.appendChild(s);
          }
        }
        pulse.setAttribute('cx', lastX);
        pulse.setAttribute('cy', lastY);
      }
    }
    if (dotBg) { dotBg.setAttribute('cx', lastX); dotBg.setAttribute('cy', lastY); dotBg.setAttribute('r', '7'); dotBg.setAttribute('opacity', '0.25'); }

    // Delta badge: compare today vs 30 days ago (or earliest available)
    if (deltaEl && values.length >= 2) {
      const first   = values[Math.max(0, values.length - 30)]; // use original (non-padded) array
      const last    = values[values.length - 1];
      const delta   = last - first;
      // Only show delta badge if the reference point is meaningful (not zero / first-ever snapshot)
      if (first !== 0) {
        const up      = delta >= 0;
        deltaEl.style.display     = '';
        deltaEl.textContent       = (up ? '↑' : '↓') + ' ' + FCData.formatCurrency(Math.abs(delta));
        deltaEl.style.background  = up ? 'var(--fc-success-soft)' : 'var(--fc-danger-soft)';
        deltaEl.style.color       = up ? 'var(--fc-success)'      : 'var(--fc-danger)';
        deltaEl.style.border      = up ? '1px solid var(--fc-success-border)' : '1px solid var(--fc-danger-border)';
      } else {
        deltaEl.style.display = 'none';
      }
    }
  }

  /* ── Spending Chart ──────────────────────────────────────────── */
  // Groups period transactions into buckets for the bar chart
  function _groupChartBuckets(txns) {
    const now = new Date();
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    // Helper: format a local Date as "YYYY-MM-DD" for string comparison with t.date
    const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    // Helper: sum txns whose date string falls within [dateStart, dateEnd) as local dates
    const sumRange = (tList, dStart, dEnd) => {
      const s = fmtDate(dStart), e = fmtDate(dEnd);
      return tList.filter(t => t.date >= s && t.date < e).reduce((acc, t) => acc + t.amount, 0);
    };

    if (state.period === '1D') {
      // Plaid only gives day-level dates (no time), so hourly buckets are meaningless.
      // Show 7-day history with today highlighted — gives context and is always populated.
      const result = [];
      for (let i = 6; i >= 0; i--) {
        const d    = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
        const total = sumRange(txns, d, next);
        const label = i === 0 ? 'Today' : i === 1 ? 'Yest' : i === 6 ? DAYS[d.getDay()] : '';
        result.push({ label, total, isNow: i === 0 });
      }
      return result;
    }

    if (state.period === '1W') {
      // Last 7 days
      const result = [];
      for (let i = 6; i >= 0; i--) {
        const d    = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
        const total = sumRange(txns, d, next);
        result.push({ label: DAYS[d.getDay()], total, isNow: i === 0 });
      }
      return result;
    }

    if (state.period === '1M') {
      // Daily buckets for this calendar month
      const days  = now.getDate();
      const result = [];
      for (let i = 0; i < days; i++) {
        const d    = new Date(now.getFullYear(), now.getMonth(), i + 1);
        const next = new Date(now.getFullYear(), now.getMonth(), i + 2);
        const total = sumRange(txns, d, next);
        const label = (i === 0 || i === Math.floor(days / 2) || i === days - 1) ? String(i + 1) : '';
        result.push({ label, total, isNow: i === days - 1 });
      }
      return result;
    }

    if (state.period === '3M') {
      // Weekly buckets over 90 days
      const cutoff = _getPeriodCutoff();
      const weeks  = Math.ceil((now.getTime() - cutoff.getTime()) / (7 * 86400000));
      return Array.from({length: weeks}, (_, i) => {
        const wStart = new Date(cutoff.getTime() + i * 7 * 86400000);
        const wEnd   = new Date(wStart.getTime() + 7 * 86400000);
        const total  = sumRange(txns, wStart, wEnd);
        const label  = (i === 0 || i === Math.floor(weeks / 2) || i === weeks - 1) ? MONTHS[wStart.getMonth()] : '';
        return { label, total, isNow: i === weeks - 1 };
      });
    }

    // 1Y / All — monthly buckets
    const cutoff = _getPeriodCutoff();
    const result = [];
    let cur = new Date(cutoff.getFullYear(), cutoff.getMonth(), 1);
    while (cur <= now) {
      const mStart = new Date(cur);
      const mEnd   = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      const total  = sumRange(txns, mStart, mEnd);
      // Label includes the year when spanning multiple years (e.g. "Jun '24")
      const isFirstMonthOfYear = cur.getMonth() === 0;
      const spanYears = (now.getFullYear() - cutoff.getFullYear()) > 0;
      const monthLabel = MONTHS[cur.getMonth()] + (spanYears && isFirstMonthOfYear ? ` '${String(cur.getFullYear()).slice(2)}` : '');
      result.push({ label: monthLabel, total, isNow: cur.getMonth() === now.getMonth() && cur.getFullYear() === now.getFullYear() });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    return result;
  }

  function _renderSpendingChart() {
    const svgEl   = document.getElementById('spending-chart-svg');
    const totalEl = document.getElementById('chart-total');
    const deltaEl = document.getElementById('chart-delta');
    const labelsEl= document.getElementById('chart-x-labels');
    if (!svgEl) return;

    const periodTxns = _getPeriodTxns().filter(t => !t.isCredit && t.amount > 0);
    const total      = periodTxns.reduce((s, t) => s + t.amount, 0);

    if (totalEl) totalEl.textContent = FCData.formatCurrency(total);

    if (!periodTxns.length) {
      svgEl.innerHTML = '<text x="50%" y="44" text-anchor="middle" fill="rgba(255,255,255,0.15)" font-size="12" font-family="-apple-system,sans-serif">No spending data for this period</text>';
      if (labelsEl) labelsEl.innerHTML = '';
      if (deltaEl)  deltaEl.style.display = 'none';
      return;
    }

    const buckets  = _groupChartBuckets(periodTxns);
    const maxVal   = Math.max(...buckets.map(b => b.total), 1);
    const W = 320, H = 84, GAP = 3;
    const barW  = Math.max(Math.floor((W - GAP * (buckets.length + 1)) / buckets.length), 2);
    const rx    = Math.min(Math.ceil(barW / 2.5), 5); // rounded tops

    // Gradient: bottom = purple, top = cyan — more premium upward flow
    const DEFS  = `<defs>
      <linearGradient id="cg" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#2563eb" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="#1ac4f0"/>
      </linearGradient>
      <linearGradient id="cg-now" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#2563eb"/>
        <stop offset="100%" stop-color="#1ac4f0"/>
      </linearGradient>
      <filter id="glow-bar" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>`;

    // Subtle average reference line
    const avgH   = buckets.filter(b => b.total > 0).reduce((s, b) => s + b.total, 0) / (buckets.filter(b => b.total > 0).length || 1);
    const avgY   = H - Math.max(Math.round((avgH / maxVal) * (H - 10)), 1);
    const refLine = avgH > 0
      ? `<line x1="${GAP}" y1="${avgY}" x2="${W - GAP}" y2="${avgY}" style="stroke:var(--fc-border)" stroke-width="1" stroke-dasharray="3 3"/>`
      : '';

    const bars = buckets.map((b, i) => {
      const x  = GAP + i * (barW + GAP);
      const h  = b.total > 0 ? Math.max(Math.round((b.total / maxVal) * (H - 10)), 4) : 2;
      const y  = H - h;
      // Zero-spend: render a 2px stub so x-axis labels stay aligned with bars
      if (b.total <= 0) return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${rx}" fill="rgba(255,255,255,0.05)"/>`;
      if (b.isNow) {
        // Active bucket: full gradient + glow + bright top cap
        return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${rx}" fill="url(#cg-now)" filter="url(#glow-bar)"/>
                <rect x="${x}" y="${y}" width="${barW}" height="${Math.min(rx * 2, h)}" rx="${rx}" fill="rgba(26,196,240,0.35)"/>`;
      }
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${rx}" fill="url(#cg)" opacity="0.75"/>`;
    }).join('');

    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svgEl.innerHTML = DEFS + refLine + bars;

    // Build x-axis labels — cap at ~6 labels max to avoid overflow
    if (labelsEl) {
      const step = Math.max(1, Math.ceil(buckets.length / 6));
      labelsEl.innerHTML = buckets.map((b, i) => {
        // Skip if no label, OR if this bucket isn't on our stride
        // Always show first and last bucket labels
        const isFirst = i === 0;
        const isLast  = i === buckets.length - 1;
        if (!b.label || (!isFirst && !isLast && i % step !== 0)) return '';
        const xPct = ((GAP + i * (barW + GAP) + barW / 2) / W * 100).toFixed(1);
        return `<span style="position:absolute;left:${xPct}%;transform:translateX(-50%);font-size:9px;color:var(--fc-text-faint);font-weight:500;white-space:nowrap">${b.label}</span>`;
      }).join('');
      labelsEl.style.position = 'relative';
      labelsEl.style.height   = '14px';
    }

    // Delta vs previous period
    if (deltaEl) {
      const prevCutoff = _getPrevPeriodCutoff();
      const prevTxns   = state.transactions.filter(t => {
        if (t.isCredit || !t.date) return false;
        const ts = FCData.parseDateLocal(t.date).getTime();
        return ts >= prevCutoff.start && ts < prevCutoff.end;
      });
      const prevTotal = prevTxns.reduce((s, t) => s + t.amount, 0);
      if (prevTotal > 0 && total > 0) {
        const pct  = Math.round(((total - prevTotal) / prevTotal) * 100);
        const up   = pct > 0;
        deltaEl.style.display    = '';
        deltaEl.textContent      = (up ? '↑' : '↓') + Math.abs(pct) + '%';
        deltaEl.style.background = up ? 'var(--fc-danger-soft)'   : 'var(--fc-success-soft)';
        deltaEl.style.color      = up ? 'var(--fc-danger)'        : 'var(--fc-success)';
        deltaEl.style.border     = up ? '1px solid var(--fc-danger-border)' : '1px solid var(--fc-success-border)';
      } else {
        deltaEl.style.display = 'none';
      }
    }
  }

  // Returns start/end timestamps for the previous equivalent period
  function _getPrevPeriodCutoff() {
    const now      = new Date();
    const cutoff   = _getPeriodCutoff();
    const duration = now.getTime() - cutoff.getTime();
    return { start: cutoff.getTime() - duration, end: cutoff.getTime() };
  }

  /* ── Smart Insights ─────────────────────────────────────────── */
  function _generateSmartInsights() {
    const periodTxns   = _getPeriodTxns();
    // Use filtered spend (no transfers/loan payments) so insights reflect real discretionary spending
    const periodSpend  = periodTxns.filter(_isSpendTxn).reduce((s, t) => s + (t.amount || 0), 0);
    const periodIncome = periodTxns.filter(_isIncomeTxn).reduce((s, t) => s + (t.amount || 0), 0);
    const label        = _PERIOD_LABELS[state.period] || 'this month';
    const insights     = [];

    // 1. Budget status — only show if user has explicitly set a budget
    const hasBudget   = state.budgets && state.budgets['total'] && (state.budgets['total'].limit || 0) > 0;
    const budgetLimit = hasBudget ? state.budgets['total'].limit : 0;
    if (hasBudget && periodSpend > 0) {
      const budgetPct = (periodSpend / budgetLimit) * 100;
      if (budgetPct >= 100) {
        insights.push({ icon: '⚠️', text: `Over budget by ${FCData.formatCurrency(periodSpend - budgetLimit)} ${label}`, color: 'var(--fc-danger)', bg: 'rgba(255,69,58,0.08)' });
      } else if (budgetPct >= 80) {
        insights.push({ icon: '⚡', text: `${Math.round(budgetPct)}% of budget used — ${FCData.formatCurrency(budgetLimit - periodSpend)} left`, color: 'var(--fc-warning)', bg: 'rgba(255,176,32,0.08)' });
      } else if (budgetPct >= 10) {
        insights.push({ icon: '✓', text: `On track — ${FCData.formatCurrency(budgetLimit - periodSpend)} of ${FCData.formatCurrency(budgetLimit)} budget remaining`, color: 'var(--fc-success)', bg: 'rgba(52,199,89,0.08)' });
      }
    } else if (!hasBudget && state.user?.plaid_linked && periodSpend > 0) {
      // Prompt to set a budget instead of showing a false "over budget" warning
      insights.push({ icon: '🎯', text: `Set a monthly budget to track your ${FCData.formatCurrency(periodSpend)} in spending ${label}`, color: 'var(--fc-accent)', bg: 'rgba(26,196,240,0.07)' });
    }

    // 2. Top spending category (filtered — no transfers)
    const catMap = {};
    for (const t of periodTxns.filter(_isSpendTxn)) {
      const rawCat = (t.category && t.category[0]) || 'Other';
      const cat    = FCData.normalizePlaidCategory(rawCat);
      catMap[cat] = (catMap[cat] || 0) + (t.amount || 0);
    }
    const topCat = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];
    if (topCat && periodSpend > 0) {
      const pct = Math.round((topCat[1] / periodSpend) * 100);
      insights.push({ icon: '📊', text: `${topCat[0]} is your top category — ${FCData.formatCurrency(topCat[1])} (${pct}%) ${label}`, color: 'var(--fc-accent)', bg: 'rgba(26,196,240,0.06)' });
    }

    // 3. Next bill due soon
    const upcoming = state.bills
      .filter(b => b.status !== 'paid' && b.due_date)
      .map(b => ({ ...b, days: FCData.daysUntil(b.due_date) }))
      .filter(b => b.days !== null && b.days <= 7)
      .sort((a, b) => a.days - b.days)[0];
    if (upcoming) {
      const when = upcoming.days === 0 ? 'today' : upcoming.days === 1 ? 'tomorrow' : `in ${upcoming.days} days`;
      const urgent = upcoming.days <= 2;
      insights.push({ icon: '📅', text: `${upcoming.name} (${FCData.formatCurrency(upcoming.amount)}) is due ${when}`, color: urgent ? 'var(--fc-danger)' : 'var(--fc-warning)', bg: urgent ? 'rgba(255,69,58,0.08)' : 'rgba(255,176,32,0.06)' });
    }

    // 4. Savings rate — suppress positive spin when over budget (contradictory messaging)
    if (periodIncome > 0 && periodSpend > 0) {
      const savingsRate  = Math.round(((periodIncome - periodSpend) / periodIncome) * 100);
      const isOverBudget = hasBudget && (periodSpend / budgetLimit) >= 1.0;
      if (savingsRate < 0) {
        insights.push({ icon: '📉', text: `Spending ${FCData.formatCurrency(Math.abs(periodIncome - periodSpend))} more than earned ${label}`, color: 'var(--fc-danger)', bg: 'rgba(255,69,58,0.08)' });
      } else if (!isOverBudget) {
        if (savingsRate >= 20) {
          insights.push({ icon: '🔥', text: `Saving ${savingsRate}% of income ${label} — keep it up!`, color: 'var(--fc-success)', bg: 'rgba(52,199,89,0.08)' });
        } else if (savingsRate > 0) {
          insights.push({ icon: '💰', text: `Saving ${savingsRate}% of income — consider increasing to 20%`, color: 'rgba(255,255,255,0.7)', bg: 'rgba(255,255,255,0.04)' });
        }
      }
    }

    // 5. Daily spending average + monthly projection (only for 1M period, filtered spend)
    if (state.period === '1M' && periodSpend > 0) {
      const dayOfMonth  = new Date().getDate();
      const dailyAvg    = periodSpend / dayOfMonth;
      const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      const projected   = dailyAvg * daysInMonth;
      const overProj    = hasBudget && projected > budgetLimit;
      const severeProj  = periodIncome > 0 && projected > periodIncome * 1.2;
      const projColor   = severeProj ? 'var(--fc-danger)' : overProj ? 'var(--fc-warning)' : 'rgba(255,255,255,0.65)';
      const projBg      = severeProj ? 'rgba(255,69,58,0.08)' : overProj ? 'rgba(255,176,32,0.07)' : 'rgba(255,255,255,0.03)';
      insights.push({
        icon: severeProj ? '🚨' : '📆',
        text: `Avg ${FCData.formatCurrency(dailyAvg)}/day · projected ${FCData.formatCurrency(projected)} by month end${severeProj ? ' — exceeds income!' : overProj ? ' ⚠️' : ''}`,
        color: projColor,
        bg: projBg,
      });
    }

    // 6. Subscription load
    const subs = _detectSubscriptions();
    if (subs.length > 0) {
      const subTotal = subs.reduce((s, sub) => s + sub.amount, 0);
      insights.push({ icon: '📱', text: `${subs.length} active subscriptions — ${FCData.formatCurrency(subTotal)}/mo in recurring charges`, color: 'rgba(255,255,255,0.6)', bg: 'rgba(255,255,255,0.04)' });
    }

    // 7. Spending Anomaly Detection — compare this week vs 4-week rolling average per category
    if (state.user?.plaid_linked) {
      const nowMs       = Date.now();
      const week1Start  = new Date(nowMs - 7  * 86400000);
      const week5Start  = new Date(nowMs - 35 * 86400000); // 5 weeks back = baseline window

      const txnsThisWeek = state.transactions.filter(t =>
        t.date && FCData.parseDateLocal(t.date) >= week1Start && _isSpendTxn(t)
      );
      const txnsPastWeeks = state.transactions.filter(t => {
        if (!t.date || !_isSpendTxn(t)) return false;
        const d = FCData.parseDateLocal(t.date);
        return d >= week5Start && d < week1Start;
      });

      // Aggregate spend per category for each window
      const catThisWeek  = {};
      for (const t of txnsThisWeek) {
        const c = FCData.normalizePlaidCategory((Array.isArray(t.category) ? t.category[0] : t.category) || 'Other');
        catThisWeek[c] = (catThisWeek[c] || 0) + (t.amount || 0);
      }
      const catPast4Wks  = {};
      for (const t of txnsPastWeeks) {
        const c = FCData.normalizePlaidCategory((Array.isArray(t.category) ? t.category[0] : t.category) || 'Other');
        catPast4Wks[c] = (catPast4Wks[c] || 0) + (t.amount || 0);
      }
      // Divide past 4-week totals by 4 to get weekly average baseline
      for (const k of Object.keys(catPast4Wks)) catPast4Wks[k] /= 4;

      let worstAnomaly = null; // only show the single biggest spike
      for (const [cat, thisAmt] of Object.entries(catThisWeek)) {
        const avgAmt = catPast4Wks[cat];
        if (!avgAmt || avgAmt < 5) continue; // not enough baseline history
        const delta  = thisAmt - avgAmt;
        const pct    = Math.round((delta / avgAmt) * 100);
        if (pct >= 50 && delta >= 25) {
          if (!worstAnomaly || delta > worstAnomaly.delta) {
            worstAnomaly = { cat, thisAmt, avgAmt, delta, pct };
          }
        }
      }
      if (worstAnomaly) {
        insights.push({
          icon: '🔺',
          text: `${worstAnomaly.cat} up ${worstAnomaly.pct}% this week — ${FCData.formatCurrency(Math.round(worstAnomaly.thisAmt))} vs your usual ${FCData.formatCurrency(Math.round(worstAnomaly.avgAmt))}/wk`,
          color: 'var(--fc-warning)',
          bg:   'rgba(255,176,32,0.09)',
          _urgency: 1,
        });
      }
    }

    // 8. Payday Prediction — detect recurring income and predict next deposit
    if (state.user?.plaid_linked) {
      const incomeByKey = {};
      for (const t of state.transactions) {
        if (!t.isCredit || !t.date || !t.amount) continue;
        const cleaned = _cleanTxnName(t);
        const key = cleaned.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 12);
        if (!incomeByKey[key]) incomeByKey[key] = { name: cleaned, dates: [], amounts: [] };
        incomeByKey[key].dates.push(FCData.parseDateLocal(t.date).getTime());
        incomeByKey[key].amounts.push(t.amount);
      }
      let paydayInsight = null;
      for (const [, data] of Object.entries(incomeByKey)) {
        if (data.dates.length < 2) continue;
        data.dates.sort((a, b) => a - b);
        const gaps = [];
        for (let i = 1; i < data.dates.length; i++)
          gaps.push((data.dates[i] - data.dates[i - 1]) / 86400000);
        const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const isBiweekly = avgGap >= 12 && avgGap <= 16;
        const isMonthly  = avgGap >= 25 && avgGap <= 37;
        if (!isBiweekly && !isMonthly) continue;
        const lastTs    = data.dates[data.dates.length - 1];
        const nextTs    = lastTs + avgGap * 86400000;
        const daysUntil = Math.round((nextTs - Date.now()) / 86400000);
        if (daysUntil >= 0 && daysUntil <= 14) {
          const avgAmt = data.amounts.reduce((s, a) => s + a, 0) / data.amounts.length;
          const when   = daysUntil === 0 ? 'today'
                       : daysUntil === 1 ? 'tomorrow'
                       : `in ${daysUntil} days`;
          paydayInsight = {
            icon: '💸',
            text: `Payday predicted ${when} — ${FCData.formatCurrency(Math.round(avgAmt))} from ${esc(data.name)} expected`,
            color: daysUntil <= 2 ? 'var(--fc-success)' : 'rgba(255,255,255,0.65)',
            bg:   daysUntil <= 2 ? 'rgba(52,199,89,0.09)' : 'rgba(255,255,255,0.04)',
            _urgency: daysUntil <= 2 ? 2 : 4,
          };
          break; // one payday prediction max
        }
      }
      if (paydayInsight) insights.push(paydayInsight);
    }

    // Fallback — only if no data at all
    if (insights.length === 0) {
      insights.push({ icon: '🔗', text: 'Connect a bank account to unlock personalized insights', color: 'rgba(255,255,255,0.5)', bg: 'rgba(255,255,255,0.04)' });
    }

    // Sort by urgency: danger(0) > anomaly/warning(1) > success(2) > payday(?) > info(3+)
    const _U = { 'var(--fc-danger)': 0, 'var(--fc-warning)': 1, 'var(--fc-success)': 2 };
    insights.sort((a, b) => {
      const ua = a._urgency ?? (_U[a.color] ?? 3);
      const ub = b._urgency ?? (_U[b.color] ?? 3);
      return ua - ub;
    });

    return insights.slice(0, 5);
  }

  function _renderSmartInsights() {
    const container = document.getElementById('smart-insights-list');
    if (!container) return;

    const insights = _generateSmartInsights();
    container.innerHTML = insights.map(ins => {
      // Derive a left-border accent color from the insight's text color
      const borderColor = ins.color || 'rgba(26,196,240,0.8)';
      return `
      <div class="fcs-insight-card" style="background:${ins.bg};border-left:3px solid ${borderColor}">
        <div class="fcs-icon">${esc(ins.icon)}</div>
        <div style="flex:1;min-width:0">
          <div class="fcs-row-val" style="line-height:1.35;margin-bottom:2px">${esc(ins.text)}</div>
          ${ins.sub ? `<div class="fcs-sub" style="line-height:1.4;margin-top:3px">${esc(ins.sub)}</div>` : ''}
        </div>
        <div style="width:6px;height:6px;border-radius:50%;background:${borderColor};flex-shrink:0;margin-top:5px;opacity:0.8"></div>
      </div>`;
    }).join('');

    // Update count badge on collapsible header
    const badge = document.getElementById('insights-count-badge');
    if (badge) badge.textContent = insights.length;
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
    if (!state.budgets || !state.budgets['total'] || !state.budgets['total'].limit) return;
    const budgetLimit = state.budgets['total'].limit;
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

  function filterActivity(filter) {
    if (_activityFilter === filter) return;
    _activityFilter = filter;
    haptic('light');
    document.querySelectorAll('[data-activity-period]').forEach(btn => {
      const active = btn.dataset.activityPeriod === filter;
      btn.classList.toggle('fc-chip--active', active);
    });
    _renderActivity();
  }

  function switchActivitySegment(segment) {
    _activitySegment = segment;
    const txnsPanel  = document.getElementById('activity-txns-panel');
    const billsPanel = document.getElementById('activity-bills-panel');
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

    const byDue    = (a, b) => (FCData.daysUntil(a.due_date) ?? 999) - (FCData.daysUntil(b.due_date) ?? 999);
    const allUnpaid = state.bills.filter(b => b.status !== 'paid').sort(byDue);
    const overdue  = allUnpaid.filter(b => (FCData.daysUntil(b.due_date) ?? 0) < 0);
    const unpaid   = allUnpaid.filter(b => (FCData.daysUntil(b.due_date) ?? 0) >= 0);
    const paid     = state.bills.filter(b => b.status === 'paid').sort(byDue);

    if (!state.bills.length) {
      container.innerHTML = `
        <div style="width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;color:var(--fc-text-faint);text-align:center">
          <div style="font-size:48px;margin-bottom:12px">🧾</div>
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

      return `
        <div class="fc-list-item" data-bill-id="${b.id}" style="cursor:pointer" onclick="FCApp.editBill('${b.id}')" role="button">
          <div class="fc-list-icon" style="background:${bg};color:white;font-weight:700;font-size:16px">
            ${esc(b.icon || b.name.charAt(0))}
          </div>
          <div class="fc-list-body">
            <div class="fc-list-title">${esc(b.name)}</div>
            <div class="fc-list-meta">${esc(b.category || 'Bill')} · ${esc(b.frequency || 'monthly')}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
            <div class="fc-list-amount">${FCData.formatCurrency(b.amount)}</div>
            ${statusText}
          </div>
        </div>`;
    };

    let html = '';

    if (overdue.length) {
      html += `<div class="fc-date-label" style="color:var(--fc-danger)">⚠️ Overdue</div>
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

  const _TAB_ORDER = ['home', 'activity', 'insights', 'wealth', 'settings'];
  let _tabFadeTimer = null; // tracks the outgoing-view fade timeout so rapid taps can cancel it

  function switchTab(tabId) {
    if (state.tab === tabId) return;
    haptic('light');
    const prev = state.tab;
    state.tab  = tabId;

    // Clean up any in-flight animation classes from a previous rapid tap
    document.querySelectorAll('.fc-view').forEach(v => {
      v.classList.remove('fc-slide-right', 'fc-slide-left');
    });

    const prevIdx = _TAB_ORDER.indexOf(prev);
    const nextIdx = _TAB_ORDER.indexOf(tabId);
    const slideClass = nextIdx > prevIdx ? 'fc-slide-right' : 'fc-slide-left';

    const target   = document.getElementById('view-' + tabId);
    const outgoing = prev ? document.getElementById('view-' + prev) : null;

    // Mark outgoing tab as fc-loaded — suppresses fc-fade-up replay on return
    if (outgoing) outgoing.classList.add('fc-loaded');

    // ── Deactivate outgoing FIRST to prevent flex-layout conflict ──────────
    // Two active flex:1 views split the container height 50/50, causing the
    // infamous "layout jump" glitch. Remove active before adding it to target.
    if (outgoing) {
      outgoing.classList.remove('active', 'fc-slide-right', 'fc-slide-left');
    }

    // ── Activate incoming with fade-in animation ───────────────────────────
    if (target) {
      target.scrollTop = 0;
      target.classList.add('active', slideClass);
    }

    // Clean up animation class after it completes
    if (target) {
      setTimeout(() => target.classList.remove('fc-slide-right', 'fc-slide-left'), 260);
    }

    // ── Nav items ──────────────────────────────────────────────────────────
    document.querySelectorAll('.fc-nav-item').forEach(item => {
      const active = item.dataset.view === tabId;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
      item.setAttribute('tabindex', active ? '0' : '-1');
    });

    // ── Defer heavy renders past the 240ms slide animation ────────────────
    // Keeping innerHTML writes away from the CSS animation window prevents
    // layout thrash and dropped frames on WKWebView.
    const ANIM_MS = 250;
    if (tabId === 'home') {
      setTimeout(_renderHome, ANIM_MS);
    } else if (tabId === 'activity') {
      setTimeout(() => {
        if (_activitySegment === 'bills') _renderBillsList();
        else _renderActivity();
      }, ANIM_MS);
    } else if (tabId === 'insights') {
      // rAF inside the timeout ensures DOM write lands after animation — prevents
      // the "shake" artifact on WKWebView. Scroll is re-pinned after render.
      setTimeout(() => requestAnimationFrame(() => {
        _renderInsights();
        if (target) target.scrollTop = 0;
      }), ANIM_MS);
    } else if (tabId === 'goals') {
      setTimeout(_renderGoals, ANIM_MS);
    } else if (tabId === 'wealth') {
      setTimeout(_renderWealth, ANIM_MS);
    } else if (tabId === 'settings') {
      setTimeout(_renderSettings, ANIM_MS);
    }

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
    if (dateEl) dateEl.textContent = greet;
    if (titleEl) titleEl.textContent = name || greet.split(' ')[1]; // "Good morning" → "morning" if truly no name
    const avatarEl = document.getElementById('home-user-avatar');
    const avatarLetter = name.charAt(0).toUpperCase() || (authUser?.email || '').charAt(0).toUpperCase() || '?';
    if (avatarEl) avatarEl.textContent = avatarLetter;
  }

  /* ─────────────────────────────────────────────────────────────
     FINANCIAL HEALTH SCORE  (0 – 850, proprietary)
     ───────────────────────────────────────────────────────────── */

  function _calcHealthScore(monthIncome, monthSpend, unpaidBills, overdueCount) {
    let score = 0;

    // 1. Savings rate — up to 250 pts
    if (monthIncome > 0) {
      const rate = (monthIncome - monthSpend) / monthIncome;
      score += rate >= 0.20 ? 250 : rate >= 0.10 ? 200 : rate >= 0.05 ? 140 : rate >= 0 ? 90 : 40;
    } else { score += 150; } // no data yet

    // 2. Bills paid on time — up to 200 pts
    score += overdueCount === 0 ? 200 : overdueCount === 1 ? 140 : overdueCount <= 3 ? 90 : 40;

    // 3. Budget adherence — up to 200 pts (skip if no budget set — don't penalise new users)
    const bLimit = (state.budgets && state.budgets['total'] && state.budgets['total'].limit > 0)
                 ? state.budgets['total'].limit : 0;
    if (bLimit > 0) {
      const bPct = monthSpend / bLimit;
      score += bPct <= 0.75 ? 200 : bPct <= 0.90 ? 170 : bPct <= 1.0 ? 130 : bPct <= 1.2 ? 80 : 30;
    } else {
      score += 150; // neutral — user hasn't set a budget yet
    }

    // 4. Emergency fund progress — up to 200 pts
    const ef = state.goals.find(g => /emergency|rainy|reserve/i.test(g.name));
    if (ef) {
      const p = ef.pct || 0;
      score += p >= 100 ? 200 : p >= 75 ? 175 : p >= 50 ? 140 : p >= 25 ? 100 : 60;
    } else { score += 100; }

    return Math.min(Math.round(score), 850);
  }

  function _renderHomeHealthScore(score, monthIncome, monthSpend, unpaidBills, overdueCount) {
    const numEl   = document.getElementById('health-score-num');
    const ringEl  = document.getElementById('health-score-ring');
    const labelEl = document.getElementById('health-score-label');
    const subEl   = document.getElementById('health-score-sub');
    const factEl  = document.getElementById('health-factors');

    if (!state.user || !state.user.plaid_linked) {
      if (numEl)   numEl.textContent  = '—';
      if (labelEl) labelEl.textContent = 'Not scored';
      if (subEl)   subEl.textContent   = 'Connect a bank to calculate your score';
      if (ringEl)  ringEl.style.strokeDashoffset = '214';
      if (factEl)  factEl.innerHTML = '';
      return;
    }

    const label = score >= 750 ? 'Excellent' : score >= 650 ? 'Great' : score >= 500 ? 'Good' : score >= 350 ? 'Fair' : 'Needs Work';
    const color = score >= 750 ? 'var(--fc-success)' : score >= 500 ? 'var(--fc-accent)' : score >= 350 ? 'var(--fc-warning)' : 'var(--fc-danger)';
    // ring: 214 = full circumference, 0 = full fill
    const offset = 214 - (214 * score / 850);

    if (numEl)   { numEl.textContent = score; numEl.style.color = color; }
    if (ringEl)  { ringEl.style.stroke = color; ringEl.style.strokeDashoffset = offset; }
    if (labelEl) { labelEl.textContent = label; labelEl.style.color = color; }
    if (subEl)   {
      const bLimit = (state.budgets && state.budgets['total'] && state.budgets['total'].limit > 0)
                   ? state.budgets['total'].limit : 0;
      const bPctStr = bLimit > 0
        ? `Budget ${Math.round((monthSpend / bLimit) * 100)}% used`
        : 'Budget not set';
      subEl.textContent = `Savings ${monthIncome > 0 ? Math.round(((monthIncome - monthSpend) / monthIncome) * 100) : 0}% · ${bPctStr} · ${overdueCount === 0 ? 'All bills current' : overdueCount + ' bill' + (overdueCount > 1 ? 's' : '') + ' overdue'}`;
    }

    if (factEl) {
      const factors = [
        { label: 'Savings',      ok: monthIncome > 0 && (monthIncome - monthSpend) / monthIncome >= 0.10 },
        { label: 'Bills',        ok: overdueCount === 0 },
        { label: 'Budget',       ok: monthIncome > 0 && monthSpend <= (state.budgets?.['total']?.limit || 3000) },
        { label: 'Emrg. Fund',   ok: !!state.goals.find(g => /emergency|rainy|reserve/i.test(g.name) && (g.pct || 0) >= 50) },
      ];
      factEl.innerHTML = factors.map(f => `
        <div class="fcs-factor-pill">
          <span style="color:${f.ok ? 'var(--fc-success)' : 'var(--fc-warning)'};font-size:11px">${f.ok ? '✓' : '!'}</span>
          <span style="font-size:11px;font-weight:500;color:${f.ok ? 'var(--fc-text-muted)' : 'var(--fc-warning)'}">${f.label}</span>
        </div>`).join('');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     SPENDING PULSE  (week-over-week)
     ───────────────────────────────────────────────────────────── */

  function _renderSpendingPulse() {
    const now           = new Date();
    const dayOfWeek     = now.getDay(); // 0=Sun
    const msDay         = 86400000;

    // Start of this week (Sunday midnight)
    const startThis = new Date(now.getTime() - dayOfWeek * msDay);
    startThis.setHours(0, 0, 0, 0);

    const startLast = new Date(startThis.getTime() - 7 * msDay);

    let thisWeek = 0, lastWeek = 0;
    for (const t of state.transactions) {
      // Use shared filter so transfers/loan payments don't distort week-over-week comparison
      if (!_isSpendTxn(t)) continue;
      const d = FCData.parseDateLocal(t.date).getTime();
      if (d >= startThis.getTime()) thisWeek += t.amount || 0;
      else if (d >= startLast.getTime()) lastWeek += t.amount || 0;
    }

    const headlineEl = document.getElementById('pulse-headline');
    const badgeEl    = document.getElementById('pulse-badge');
    const thisEl     = document.getElementById('pulse-this-week');
    const lastEl     = document.getElementById('pulse-last-week');
    const thisBar    = document.getElementById('pulse-this-bar');
    const lastBar    = document.getElementById('pulse-last-bar');

    if (thisEl)  thisEl.textContent = FCData.formatCurrency(thisWeek);
    if (lastEl)  lastEl.textContent = FCData.formatCurrency(lastWeek);

    // Relative bar widths
    const max = Math.max(thisWeek, lastWeek, 1);
    if (thisBar) thisBar.style.width = Math.round((thisWeek / max) * 100) + '%';
    if (lastBar) lastBar.style.width = Math.round((lastWeek / max) * 100) + '%';

    // Normalize by days elapsed so Monday morning doesn't look like huge savings
    const daysElapsed = Math.max(1, dayOfWeek === 0 ? 7 : dayOfWeek); // Sun=0 → treat as 7 (full week just ended)
    const thisAvg = thisWeek / daysElapsed;
    const lastAvg = lastWeek / 7;

    // Badge + headline — only show if last week had spend AND at least 2 days have elapsed
    if (lastWeek > 0 && daysElapsed >= 2 && badgeEl && headlineEl) {
      const pct    = Math.round(((thisAvg - lastAvg) / lastAvg) * 100);
      const less   = pct < 0;
      const absPct = Math.abs(pct);
      badgeEl.style.display = '';
      badgeEl.textContent   = (less ? '↓ ' : '↑ ') + absPct + '%';
      badgeEl.style.background = less ? 'rgba(52,199,89,0.15)'  : 'rgba(255,69,58,0.12)';
      badgeEl.style.color      = less ? 'var(--fc-success)'     : 'var(--fc-danger)';
      headlineEl.textContent   = less
        ? `Spending ${absPct}% less per day than last week 🎉`
        : `Spending ${absPct}% more per day than last week`;
      headlineEl.style.color   = less ? 'var(--fc-success)' : 'white';
    } else if (badgeEl) {
      badgeEl.style.display = 'none';
    }
  }

  /* ─────────────────────────────────────────────────────────────
     CREDIT SCORE — manual entry (user enters their own score)
     ───────────────────────────────────────────────────────────── */

  // Map numeric score to label + arc color
  function _creditLabel(score) {
    if (!score) return { label: '—', color: 'rgba(255,255,255,0.3)' };
    if (score >= 800) return { label: 'Exceptional',  color: 'var(--fc-success)' };
    if (score >= 740) return { label: 'Very Good',    color: '#30d158' };
    if (score >= 670) return { label: 'Good',         color: 'var(--fc-accent)' };
    if (score >= 580) return { label: 'Fair',         color: '#ffb020' };
    return               { label: 'Poor',         color: 'var(--fc-danger)' };
  }

  /* ── Affiliate Offer Card ─────────────────────────────────────
     Picks the single most relevant offer based on the user's
     financial state and renders it on the home dashboard.
     Offer definitions live in FC_CONFIG.offers (fc-config.js).
     ───────────────────────────────────────────────────────────── */
  function _renderOfferCard(monthIncome, monthSpend) {
    const el = document.getElementById('home-offer-card');
    if (!el) return;

    const offers = (window.FC_CONFIG && window.FC_CONFIG.offers) || [];
    if (!offers.length) { el.style.display = 'none'; return; }

    // Compute user signals
    const savings      = state.accounts
      .filter(a => a.type === 'depository')
      .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
    const hasInvestments = state.accounts.some(a => a.type === 'investment');

    // Score each offer — higher = more relevant
    function scoreOffer(offer) {
      const t = offer.trigger || {};
      if (t.minSavings  !== undefined && savings      <  t.minSavings)  return -1;
      if (t.maxSavings  !== undefined && savings      >  t.maxSavings)  return -1;
      if (t.minIncome   !== undefined && monthIncome  <  t.minIncome)   return -1;
      if (t.noInvestments && hasInvestments)                             return -1;
      // Suppress offer if user already has an account at this institution
      const offerInst = (offer.institution || '').toLowerCase();
      if (offerInst) {
        const alreadyHas = state.accounts.some(a =>
          (a.institution_name || '').toLowerCase().includes(offerInst)
        );
        if (alreadyHas) return -1;
      }
      // Prefer offers where the user has room to act
      let score = 0;
      if (t.maxSavings && savings < t.maxSavings * 0.5) score += 2; // Low savings = urgent
      if (t.noInvestments && !hasInvestments) score += 3;            // No investing = big gap
      if (t.minIncome && monthIncome >= t.minIncome * 2) score += 1; // High income = more relevant
      return score;
    }

    const eligible = offers
      .map(o => ({ ...o, _score: scoreOffer(o) }))
      .filter(o => o._score >= 0)
      .sort((a, b) => b._score - a._score);

    if (!eligible.length) { el.style.display = 'none'; return; }

    const offer = eligible[0];

    // Only show if bank is linked — unlinked users haven't seen real data yet
    if (!state.user?.plaid_linked) { el.style.display = 'none'; return; }

    // Personalise headline if we know their savings balance
    let headline = offer.headline;
    if (offer.id && offer.id.startsWith('hysa') && savings > 100) {
      headline = `Your ${FCData.formatCurrency(savings)} could earn ${savings >= 10000 ? 'much' : 'a lot'} more`;
    }

    el.style.display = '';
    // Escape all offer string fields to prevent XSS if offers come from external config
    el.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
            <span style="font-size:14px">${esc(offer.icon)}</span>
            <span style="font-size:11px;font-weight:700;color:${esc(offer.color)};text-transform:uppercase;letter-spacing:0.06em">${esc(offer.badge)}</span>
            <span style="font-size:10px;color:rgba(255,255,255,0.3);margin-left:auto;font-weight:500">Partner</span>
          </div>
          <div style="font-size:17px;font-weight:700;color:var(--fc-text);line-height:1.3;margin-bottom:6px">${esc(headline)}</div>
          <div style="font-size:13px;color:var(--fc-text-muted);line-height:1.4;margin-bottom:14px">${esc(offer.sub)}</div>
          <button onclick="FCApp.openOffer('${esc(offer.id)}')"
            style="background:${esc(offer.color)};color:white;border:none;border-radius:10px;padding:10px 20px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px">
            ${esc(offer.cta)}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
        <div style="width:44px;height:44px;border-radius:12px;background:${esc(offer.color)}22;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">${esc(offer.icon)}</div>
      </div>
      <p class="fcs-disclosure" style="margin:12px 0 0">
        FlowCheck may earn a commission if you open an account. This doesn't affect our recommendations or your costs.
      </p>`;
    el.dataset.offerId = offer.id;
  }

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

  /** Wipe every per-user piece of in-memory state. Called from handleSignOut
   *  AND from the auth observer when Firebase reports no user, so a session
   *  ended by token expiry or programmatic signOut doesn't leak the previous
   *  user's accounts/transactions into the next sign-in. */
  function _wipeUserState() {
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
    state.searchQuery   = '';
    state.initialLoading = false;
    _paywallShownThisSession    = false;
    _streakCheckedThisSession   = false;
    if (_privacyModeOn) {
      _privacyModeOn = false;
      document.body.classList.remove('fc-privacy');
    }
    // Wipe per-user localStorage caches (net-worth history, budget alert
    // flags, debt start, milestone flags, RC pro cache, etc.) so they can't
    // leak into the next user's session.
    // PRESERVE uid-keyed routing flags (fc_ob_done_, fc_pw_seen_) — they are
    // keyed by UID so they cannot cross-contaminate between users, and they
    // provide cross-session onboarding + paywall cooldown for the same user.
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('fc_') && !k.startsWith('fc_ob_done_') && !k.startsWith('fc_pw_seen_'))
        .forEach(k => localStorage.removeItem(k));
    } catch (_) { /* localStorage unavailable in strict CSP — safe to ignore */ }

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
    try { _renderGoals();      } catch (_) {}
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
  function _renderBudgetWizard(monthIncome, monthSpend) {
    const section = document.getElementById('home-budget-wizard-section');
    if (!section) return;
    if (!_isPro()) {
      _renderProGate(section, '🎯', '50/30/20 Budget Wizard',
        'See exactly how your spending splits into needs, wants, and savings — then get a plan to fix it.');
      return;
    }
    if (!state.user?.plaid_linked || !_incomeIsReliable(monthIncome, monthSpend)) { section.style.display = 'none'; return; }

    // Category → bucket mapping
    const _NEEDS_CATS = new Set([
      'supermarkets and groceries', 'groceries', 'food delivery',
      'gas stations', 'gas', 'public transportation services', 'taxi', 'ride share',
      'utilities', 'telecommunications', 'healthcare', 'pharmacies',
      'insurance', 'subscription', 'streaming', 'rent', 'mortgage',
      'home improvement', 'home maintenance',
    ]);
    const _WANTS_CATS = new Set([
      'food and drink', 'restaurants', 'fast food', 'coffee shop', 'bars', 'alcohol and bars',
      'entertainment', 'travel', 'airlines and aviation services', 'hotels and motels',
      'sporting goods', 'hobbies', 'arts and entertainment',
      'shopping', 'clothing and accessories', 'electronics',
      'personal care', 'hair', 'spa and beauty', 'gym and fitness', 'health and fitness',
      'pets', 'gifts', 'toys', 'books and magazines',
    ]);

    // Get calendar-month transactions
    const now     = new Date();
    const monStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monTxns  = state.transactions.filter(t =>
      t.date && FCData.parseDateLocal(t.date) >= monStart && _isSpendTxn(t)
    );

    let needs = 0, wants = 0;
    for (const t of monTxns) {
      const rawCat = (Array.isArray(t.category) ? t.category[0] : t.category) || '';
      const norm   = FCData.normalizePlaidCategory(rawCat).toLowerCase();
      if (_NEEDS_CATS.has(norm))      needs += t.amount || 0;
      else if (_WANTS_CATS.has(norm)) wants += t.amount || 0;
      // else: uncategorized — skip (don't pollute buckets)
    }
    const base        = Math.max(monthIncome, 1); // safe denominator — wizard is only shown when income is reliable
    const savings     = Math.max(0, monthIncome - needs - wants);
    const savingsPct  = Math.round((savings / base) * 100);
    const needsPct    = Math.round((needs   / base) * 100);
    const wantsPct    = Math.round((wants   / base) * 100);

    // Render rows
    const rowsEl = document.getElementById('budget-wizard-rows');
    if (!rowsEl) return;

    function makeRow(label, actual, target, color, icon, tip) {
      const pct     = Math.round((actual / base) * 100);
      const barPct  = Math.min(pct, 100);
      const isOver  = pct > target + 5;
      const isUnder = pct < target - 5;
      const status  = isOver ? `${pct - target}% over` : isUnder ? `${target - pct}% under` : 'On target ✓';
      const statusColor = isOver ? 'var(--fc-danger)' : isUnder ? 'var(--fc-warning)' : 'var(--fc-success)';
      return `
        <div>
          <div class="fcs-bw-row-header">
            <div class="fcs-bw-row-lhs">
              <span style="font-size:16px">${icon}</span>
              <div>
                <div class="fcs-row-val">${label}</div>
                <div class="fcs-sub">Target: ${target}% · ${FCData.formatCurrency(Math.round(actual))}</div>
              </div>
            </div>
            <div class="fcs-bw-row-rhs">
              <div style="font-size:16px;font-weight:800;color:${color}">${pct}%</div>
              <div style="font-size:10px;color:${statusColor};font-weight:600">${status}</div>
            </div>
          </div>
          <div class="dash-bar-track fcs-bar-track">
            <div class="dash-bar-fill" style="width:${barPct}%;background:${isOver ? 'var(--fc-danger)' : color}"></div>
          </div>
          <div style="height:6px;position:relative;margin-top:2px">
            <div style="position:absolute;left:${target}%;top:-8px;width:1px;height:16px;background:rgba(255,255,255,0.2)"></div>
          </div>
        </div>`;
    }

    rowsEl.innerHTML =
      makeRow('Needs',   needs,   50, 'var(--fc-accent)', '🏠', '') +
      makeRow('Wants',   wants,   30, '#60a5fa', '✨', '') +
      makeRow('Savings', savings, 20, 'var(--fc-success)', '💰', '');

    // Tip
    const tipEl = document.getElementById('budget-wizard-tip');
    if (tipEl) {
      let tip = '';
      if (needsPct > 55)       tip = `Your needs are ${needsPct}% of income — above the 50% guideline. Look for fixed costs to trim: subscriptions, insurance, or phone plans.`;
      else if (wantsPct > 35)  tip = `Wants at ${wantsPct}% is above the 30% target. Dining and entertainment are usually the biggest levers — review your recent activity.`;
      else if (savingsPct < 15) tip = `You're saving ${savingsPct}% of income — aim for 20%. Even automating an extra $50/mo builds a powerful habit.`;
      else                      tip = `You're following the 50/30/20 rule well. Keep it up — consistency compounds.`;
      tipEl.textContent = tip;
      tipEl.style.display = '';
    }

    // Subtitle
    const subEl = document.getElementById('budget-wizard-subtitle');
    if (subEl) subEl.textContent = `Based on ${FCData.formatCurrency(Math.round(monthIncome))} income this month`;

    section.style.display = '';
  }

  /* ── Zombie Subscription Finder ─────────────────────────────────────
     Surfaces auto-detected recurring charges that are NOT in the user's
     tracked bills list. Helps users discover and cancel forgotten subs.
     Only shown when 2+ zombie subscriptions are found.
     ─────────────────────────────────────────────────────────────────── */
  function _renderZombieSubscriptions() {
    const section = document.getElementById('home-zombie-subs-section');
    if (!section) return;
    if (!_isPro()) {
      _renderProGate(section, '🧟', 'Zombie Subscription Finder',
        'Find subscriptions you forgot about and cancel them — most users save $40+/mo.');
      return;
    }
    if (!state.user?.plaid_linked) { section.style.display = 'none'; return; }

    const zombies = _detectSubscriptions().filter(s => !s.tracked);
    if (zombies.length < 2) { section.style.display = 'none'; return; }

    // Sort by amount descending — biggest waste first
    zombies.sort((a, b) => b.amount - a.amount);
    const totalMonthly = zombies.reduce((s, z) => s + z.amount, 0);

    const totalEl = document.getElementById('zombie-subs-total');
    if (totalEl) totalEl.textContent = `${FCData.formatCurrency(Math.round(totalMonthly))}/mo`;

    const listEl = document.getElementById('zombie-subs-list');
    if (!listEl) return;

    // Known streaming/sub icons
    function subIcon(name) {
      const n = name.toLowerCase();
      if (n.includes('netflix'))   return '🎬';
      if (n.includes('spotify'))   return '🎵';
      if (n.includes('apple'))     return '🍎';
      if (n.includes('amazon'))    return '📦';
      if (n.includes('hulu'))      return '📺';
      if (n.includes('disney'))    return '🏰';
      if (n.includes('youtube'))   return '▶️';
      if (n.includes('gym') || n.includes('fitness') || n.includes('planet')) return '💪';
      if (n.includes('adobe'))     return '🎨';
      if (n.includes('microsoft') || n.includes('office') || n.includes('xbox')) return '🖥️';
      if (n.includes('google'))    return '🔍';
      if (n.includes('dropbox') || n.includes('icloud') || n.includes('storage')) return '☁️';
      return '📱';
    }

    listEl.innerHTML = zombies.slice(0, 6).map(z => {
      const icon      = subIcon(z.name);
      const name      = _cleanTxnName({ name: z.name });
      const annualCost = FCData.formatCurrency(Math.round(z.amount * 12));
      const encoded   = encodeURIComponent(z.name);
      return `
        <div onclick="FCApp.showSubDetail('${encoded}')" class="fcs-list-row">
          <span style="font-size:20px;flex-shrink:0">${icon}</span>
          <div style="flex:1;min-width:0">
            <div class="fcs-row-val" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
            <div class="fcs-sub" style="margin-top:1px">${FCData.formatCurrency(z.amount)}/${z.freq} · ${annualCost}/yr</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--fc-text-faint)" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
        </div>`;
    }).join('');

    section.style.display = '';
  }

  /* ── Debt Payoff Planner ─────────────────────────────────────────────
     Compares Avalanche (highest APR first) vs Snowball (smallest balance
     first) payoff strategies for connected loan + credit accounts.

     Interest rates are estimated by account type/name — accurate APR data
     is not available from Plaid. Users are shown the disclaimer.

     Payoff formula (standard amortization):
       months = -ln(1 - r·B/P) / ln(1+r)  where r = monthly rate, P = payment
     ─────────────────────────────────────────────────────────────────── */
  function _renderDebtPayoffPlanner() {
    const section = document.getElementById('home-debt-planner-section');
    if (!section) return;
    if (!_isPro()) {
      _renderProGate(section, '📉', 'Debt Payoff Planner',
        'Get a personalized payoff schedule across all your loans and cards — with exact payoff dates.');
      return;
    }
    if (!state.user?.plaid_linked) { section.style.display = 'none'; return; }

    // Collect debt accounts — use balance_current (Firestore flat field, not Plaid nested)
    const debtAccts = state.accounts.filter(a =>
      (a.type === 'loan' || a.type === 'credit') &&
      (a.balance_current || a.balance || 0) > 50
    );
    if (!debtAccts.length) { section.style.display = 'none'; return; }

    // Estimate APR by account type and name
    function estimateAPR(acct) {
      const name = (acct.name || acct.official_name || '').toLowerCase();
      const sub  = (acct.subtype || '').toLowerCase();
      if (sub === 'student' || name.includes('student'))           return 0.055;
      if (sub === 'auto'    || name.includes('auto') || name.includes('car')) return 0.065;
      if (sub === 'mortgage'|| name.includes('mortgage'))         return 0.070;
      if (acct.type === 'credit')                                  return 0.229;
      if (name.includes('personal') || name.includes('sofi'))     return 0.130;
      return 0.100; // generic loan
    }

    // Build debt objects
    const debts = debtAccts.map(a => {
      const balance = a.balance_current || a.balance || 0;
      const apr     = estimateAPR(a);
      const monthly = apr / 12;
      // Minimum payment: 1% of balance for credit cards, fixed ~$50 for loans, min $25
      const minPay  = a.type === 'credit'
        ? Math.max(25, balance * 0.01)
        : Math.max(50, balance / 60);
      return {
        name:    _cleanTxnName({ name: a.name || 'Account', merchant_name: null }),
        balance,
        apr,
        monthly,
        minPay,
        type:    a.type,
        subtype: a.subtype || '',
      };
    });

    const totalDebt = debts.reduce((s, d) => s + d.balance, 0);
    if (totalDebt < 100) { section.style.display = 'none'; return; }

    // Extra monthly payment available (estimated: 10% of min payments total, min $50)
    const totalMinPay = debts.reduce((s, d) => s + d.minPay, 0);
    const extraPay    = Math.max(50, totalMinPay * 0.10);

    const MAX_MONTHS = 600; // 50-year safety cap
    // Payoff simulation — returns { months, totalInterest }
    function simulate(orderedDebts) {
      // Clone debts with mutable balance
      const working = orderedDebts.map(d => ({ ...d, bal: d.balance }));
      let extra = extraPay;
      let months = 0;
      let totalInterest = 0;

      while (working.some(d => d.bal > 0.01) && months < MAX_MONTHS) {
        months++;
        extra = extraPay; // reset extra each month
        for (const d of working) {
          if (d.bal <= 0.01) continue;
          const interest  = d.bal * d.monthly;
          totalInterest  += interest;
          const payment   = Math.min(d.bal + interest, d.minPay + extra);
          extra           = Math.max(0, extra - Math.max(0, payment - d.minPay));
          d.bal           = Math.max(0, d.bal + interest - payment);
          if (d.bal < 0.01) {
            // Debt paid off — redirect its min payment as extra for next debt
            extra += d.minPay;
          }
        }
      }
      return { months, totalInterest };
    }

    // Avalanche: highest APR first
    const avalancheOrder = [...debts].sort((a, b) => b.apr - a.apr);
    const avalanche = simulate(avalancheOrder);

    // Snowball: smallest balance first
    const snowballOrder = [...debts].sort((a, b) => a.balance - b.balance);
    const snowball = simulate(snowballOrder);

    const savedInterest = Math.max(0, snowball.totalInterest - avalanche.totalInterest);
    const savedMonths   = Math.max(0, snowball.months - avalanche.months);

    // Helper: months → human label
    function monthsLabel(m) {
      if (m >= MAX_MONTHS) return 'Very long';
      const yrs = Math.floor(m / 12);
      const mos = m % 12;
      if (yrs === 0) return `${mos} mo`;
      if (mos === 0) return `${yrs} yr`;
      return `${yrs}y ${mos}m`;
    }

    // Render debt list
    const listEl = document.getElementById('debt-planner-list');
    function debtTypeIcon(d) {
      if (d.type === 'credit')               return '💳';
      if (d.subtype.includes('student'))     return '🎓';
      if (d.subtype.includes('auto') || d.name.toLowerCase().includes('auto')) return '🚗';
      if (d.subtype.includes('mortgage'))    return '🏠';
      return '🏦';
    }

    if (listEl) {
      listEl.innerHTML = debts.map(d => `
        <div class="fcs-item">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span style="font-size:16px;flex-shrink:0">${debtTypeIcon(d)}</span>
            <div style="min-width:0">
              <div class="fcs-row-val" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${esc(d.name)}</div>
              <div class="fcs-sub">~${Math.round(d.apr * 100)}% APR est.</div>
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:14px;font-weight:700;color:var(--fc-text)">${FCData.formatCurrency(Math.round(d.balance))}</div>
            <div class="fcs-sub">${FCData.formatCurrency(Math.round(d.minPay))}/mo min</div>
          </div>
        </div>`).join('');
    }

    // Render method comparison
    const compEl = document.getElementById('debt-planner-comparison');
    if (compEl) {
      function methodCard(label, data, color, isWinner) {
        return `
          <div class="fcs-method-card${isWinner ? ' winner' : ''}">
            ${isWinner ? '<div style="font-size:9px;font-weight:700;color:var(--fc-success);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px">★ Recommended</div>' : '<div style="margin-bottom:4px;height:13px"></div>'}
            <div style="font-size:14px;font-weight:700;color:${color};margin-bottom:2px">${label}</div>
            <div class="fcs-sub" style="margin-bottom:8px">${label === 'Avalanche' ? 'Highest APR first' : 'Smallest balance first'}</div>
            <div style="font-size:20px;font-weight:800;color:var(--fc-text);margin-bottom:1px">${monthsLabel(data.months)}</div>
            <div class="fcs-sub" style="margin-bottom:6px">to debt free</div>
            <div style="font-size:13px;font-weight:700;color:${isWinner ? 'var(--fc-success)' : 'var(--fc-text-muted)'}">
              ${FCData.formatCurrency(Math.round(data.totalInterest))} interest
            </div>
          </div>`;
      }
      compEl.innerHTML =
        methodCard('Avalanche', avalanche, 'var(--fc-accent)', true) +
        methodCard('Snowball',  snowball,  '#60a5fa', false);
    }

    // Savings call-out
    const savingsEl = document.getElementById('debt-planner-savings');
    if (savingsEl) {
      if (savedInterest >= 100) {
        savingsEl.textContent = `Avalanche saves you ${FCData.formatCurrency(Math.round(savedInterest))} in interest${savedMonths > 0 ? ` and gets you debt-free ${savedMonths} month${savedMonths > 1 ? 's' : ''} sooner` : ''}.`;
        savingsEl.style.display = '';
      } else {
        savingsEl.style.display = 'none';
      }
    }

    // Badge + subtitle
    const badgeEl = document.getElementById('debt-planner-total-badge');
    if (badgeEl) badgeEl.textContent = FCData.formatCurrency(Math.round(totalDebt)) + ' total';
    const subEl = document.getElementById('debt-planner-subtitle');
    if (subEl) subEl.textContent = `${debts.length} debt${debts.length > 1 ? 's' : ''} · Avalanche vs Snowball`;

    section.style.display = '';
  }

  /* ── Net Worth Milestone Tracker ─────────────────────────────────────
     Shows progress to the next net worth milestone and celebrates when
     the user crosses one. Milestone flags are stored in localStorage so
     the celebration only fires once per milestone.
     ─────────────────────────────────────────────────────────────────── */
  function _renderNetWorthMilestone(netWorth) {
    const section = document.getElementById('home-milestone-section');
    if (!section) return;
    if (!state.user?.plaid_linked) { section.style.display = 'none'; return; }

    const MILESTONES = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];

    // Format milestone labels
    function fmtMs(v) {
      if (v >= 1000000) return '$' + (v / 1000000) + 'M';
      if (v >= 1000)    return '$' + (v / 1000) + 'K';
      return FCData.formatCurrency(v);
    }

    const ringEl  = document.getElementById('milestone-ring');
    const pctEl   = document.getElementById('milestone-ring-pct');
    const titleEl = document.getElementById('milestone-title');
    const subEl   = document.getElementById('milestone-sub');
    const badgeEl = document.getElementById('milestone-badge');

    // ── Debt payoff mode — negative net worth ─────────────────────────────
    if (netWorth < 0) {
      // Progress: how far from worst point toward $0
      // Use localStorage to track the user's starting debt (most negative recorded)
      const debtKey = 'fc_debt_start';
      const storedStart = parseFloat(localStorage.getItem(debtKey) || String(netWorth));
      const debtStart   = Math.min(storedStart, netWorth); // track lowest point
      localStorage.setItem(debtKey, String(debtStart));

      const totalDebt  = Math.abs(debtStart);
      const paidOff    = Math.max(0, Math.abs(debtStart) - Math.abs(netWorth));
      const pct        = totalDebt > 0 ? Math.max(0, Math.min(100, Math.round((paidOff / totalDebt) * 100))) : 0;
      const remaining  = FCData.formatCurrency(Math.abs(netWorth));

      const circumference = 144.5;
      if (ringEl) {
        ringEl.style.strokeDashoffset = circumference - (circumference * pct / 100);
        ringEl.style.stroke = pct > 20 ? 'var(--fc-success)' : 'var(--fc-warning)';
      }
      if (pctEl)   pctEl.textContent  = pct + '%';
      // More motivating framing: celebrate progress made, not distance remaining
      const motivator = pct === 0  ? 'Every payment chips away at this'
                      : pct < 10   ? `${pct}% eliminated — momentum is building`
                      : pct < 25   ? `${pct}% down — you\'re making real progress`
                      : pct < 50   ? `${pct}% gone — almost halfway there!`
                      : pct < 75   ? `${pct}% paid off — over halfway! Keep going`
                      : `${pct}% eliminated — the finish line is close`;
      if (titleEl) titleEl.textContent = 'Debt payoff journey';
      if (subEl)   subEl.textContent   = `${remaining} remaining · ${motivator}`;
      if (badgeEl) badgeEl.style.display = 'none';
      section.style.display = '';
      return;
    }

    // ── Normal milestone mode — positive net worth ────────────────────────
    // Find next milestone
    const next = MILESTONES.find(m => netWorth < m);
    if (!next) { section.style.display = 'none'; return; } // beyond all milestones

    // Find previous milestone (progress baseline)
    const prevIdx = MILESTONES.indexOf(next) - 1;
    const prev    = prevIdx >= 0 ? MILESTONES[prevIdx] : 0;
    const pct     = Math.max(0, Math.min(100, Math.round(((netWorth - prev) / (next - prev)) * 100)));

    const nextLabel = fmtMs(next);
    const remaining = FCData.formatCurrency(Math.round(next - netWorth));

    // Check if milestone was just crossed (netWorth >= prev milestone for first time)
    const _msUid   = FCAuth.currentUser?.()?.uid || state.user?.uid || '';
    const celebKey = `fc_milestone_${_msUid}_${next}`;
    const prevKey  = `fc_milestone_prev_${_msUid}_${next}`;
    const celebrated = localStorage.getItem(celebKey) === '1';
    const prevNW     = parseFloat(localStorage.getItem(prevKey) || '0');
    const justCrossed = prevNW < next && netWorth >= next;

    // Save current netWorth for next comparison
    localStorage.setItem(prevKey, String(netWorth));

    let showBadge = false;
    if (justCrossed && !celebrated) {
      localStorage.setItem(celebKey, '1');
      showBadge = true;
      haptic('success');
      // Confetti burst
      const canvas = document.getElementById('milestone-confetti');
      if (canvas) {
        canvas.style.opacity = '1';
        _confettiBurst(canvas);
        setTimeout(() => { canvas.style.opacity = '0'; }, 3000);
      }
    }

    // Update ring
    const circumference = 144.5;
    if (ringEl) ringEl.style.strokeDashoffset = circumference - (circumference * pct / 100);
    if (pctEl)  pctEl.textContent = pct + '%';

    // Update text
    if (titleEl) titleEl.textContent = showBadge ? `You hit ${nextLabel}!` : `On the way to ${nextLabel}`;
    if (subEl)   subEl.textContent   = showBadge
      ? 'Milestone reached — incredible work. Next stop is higher.'
      : `${remaining} away · ${pct}% of the way there`;
    if (badgeEl) badgeEl.style.display = showBadge ? '' : 'none';

    section.style.display = '';
  }

  // Lightweight confetti burst for milestone celebration
  function _confettiBurst(canvas) {
    const ctx    = canvas.getContext('2d');
    const W      = canvas.offsetWidth  || 300;
    const H      = canvas.offsetHeight || 80;
    canvas.width  = W;
    canvas.height = H;
    const COLORS = ['var(--fc-accent)','#60a5fa','var(--fc-success)','#FFD60A','var(--fc-warning)','var(--fc-danger)'];
    const particles = Array.from({ length: 60 }, () => ({
      x:   Math.random() * W,
      y:   Math.random() * H * 0.4,
      vx:  (Math.random() - 0.5) * 3,
      vy:  Math.random() * 2 + 0.5,
      r:   Math.random() * 4 + 2,
      c:   COLORS[Math.floor(Math.random() * COLORS.length)],
      rot: Math.random() * Math.PI * 2,
      rv:  (Math.random() - 0.5) * 0.2,
      life:1,
    }));
    let start = null;
    function frame(ts) {
      if (!start) start = ts;
      const elapsed = ts - start;
      ctx.clearRect(0, 0, W, H);
      let alive = false;
      for (const p of particles) {
        p.x   += p.vx;
        p.y   += p.vy;
        p.vy  += 0.05; // gravity
        p.rot += p.rv;
        p.life = Math.max(0, 1 - elapsed / 2800);
        if (p.life > 0) { alive = true; }
        ctx.save();
        ctx.globalAlpha = p.life;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6);
        ctx.restore();
      }
      if (alive && elapsed < 3000) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    }
    requestAnimationFrame(frame);
  }

  /* ── Credit Card Optimizer ──────────────────────────────────────────
     Analyzes the user's real spending by category over the last 90 days,
     scores a curated catalog of top rewards cards, and renders a carousel
     of the top 2-3 picks showing estimated annual rewards.

     Privacy: no spending data leaves the device. All scoring is done
     locally against the in-memory transaction array.
     ─────────────────────────────────────────────────────────────────── */
  function _renderCardRecommendations() {
    const section = document.getElementById('home-card-recommender-section');
    const el      = document.getElementById('home-card-recommender');
    if (!section || !el) return;
    if (!_isPro()) {
      _renderProGate(section, '💳', 'Credit Card Optimizer',
        'Find out which card earns you the most rewards based on where you actually spend.');
      return;
    }
    // Only show after a bank is linked
    if (!state.user?.plaid_linked) { section.style.display = 'none'; return; }

    // ── 1. Build 90-day spending sample ───────────────────────────
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const txns90 = state.transactions.filter(t =>
      t.date && FCData.parseDateLocal(t.date) >= cutoff && _isSpendTxn(t)
    );

    if (txns90.length < 5) { section.style.display = 'none'; return; }

    // ── 2. Map Plaid normalized categories → reward buckets ────────
    // Keys are the lowercase output of FCData.normalizePlaidCategory()
    const _CAT_BUCKET = {
      'food and drink':                'dining',
      'restaurants':                   'dining',
      'fast food':                     'dining',
      'coffee shop':                   'dining',
      'bars':                          'dining',
      'alcohol and bars':              'dining',
      'groceries':                     'groceries',
      'supermarkets and groceries':    'groceries',
      'food delivery':                 'groceries',
      'travel':                        'travel',
      'airlines and aviation services':'travel',
      'hotels and motels':             'hotels',
      'car services':                  'rental',
      'taxi':                          'transit',
      'ride share':                    'transit',
      'public transportation services':'transit',
      'gas stations':                  'gas',
      'gas':                           'gas',
      'streaming':                     'streaming',
      'subscription':                  'streaming',
      'entertainment':                 'entertainment',
      'pharmacies':                    'drugstores',
      'health and fitness':            'health',
    };

    // ── 3. Sum spend per bucket (monthly average from 90-day sample) ─
    const bucketSpend = {};
    for (const t of txns90) {
      const rawCat = (Array.isArray(t.category) ? t.category[0] : t.category) || '';
      const norm   = FCData.normalizePlaidCategory(rawCat).toLowerCase();
      const bucket = _CAT_BUCKET[norm] || 'other';
      bucketSpend[bucket] = (bucketSpend[bucket] || 0) + (t.amount || 0);
    }
    // Convert 90-day totals → monthly averages
    for (const k of Object.keys(bucketSpend)) bucketSpend[k] = bucketSpend[k] / 3;

    const totalMonthly = Object.values(bucketSpend).reduce((s, v) => s + v, 0);
    if (totalMonthly < 50) { section.style.display = 'none'; return; }

    // ── 4. Card catalog ────────────────────────────────────────────
    // rates: reward multiplier per dollar (4 = 4% cash back or 4x points ≈ 4%)
    const CARDS = [
      {
        id:       'amex-gold',
        name:     'Amex Gold',
        full:     'American Express Gold Card',
        issuer:   'american express',
        fee:      250,
        color:    '#C9AA71',
        gradient: 'linear-gradient(135deg,#3a2800 0%,#1a1000 100%)',
        rates:    { dining: 4, groceries: 4, travel: 3, other: 1 },
        perks:    ['4x at restaurants worldwide', '4x at US supermarkets', '$120 dining credit/yr'],
        badge:    'Best for Dining & Groceries',
        url:      'https://americanexpress.com/en-us/credit-cards/gold-card/',
      },
      {
        id:       'chase-sapphire-preferred',
        name:     'Sapphire Preferred',
        full:     'Chase Sapphire Preferred®',
        issuer:   'chase',
        fee:      95,
        color:    '#5B9BD5',
        gradient: 'linear-gradient(135deg,#071e38 0%,#030e1c 100%)',
        rates:    { dining: 3, groceries: 3, streaming: 3, travel: 2, other: 1 },
        perks:    ['3x dining, groceries & streaming', '2x on all travel', '25% more value on travel redemptions'],
        badge:    'Best All-Around Travel Card',
        url:      'https://creditcards.chase.com/rewards-credit-cards/sapphire/preferred',
      },
      {
        id:       'amex-blue-cash-preferred',
        name:     'Blue Cash Preferred',
        full:     'Amex Blue Cash Preferred®',
        issuer:   'american express',
        fee:      95,
        color:    '#00A86B',
        gradient: 'linear-gradient(135deg,#001f14 0%,#00100a 100%)',
        rates:    { groceries: 6, streaming: 6, gas: 3, transit: 3, other: 1 },
        perks:    ['6% at US supermarkets (up to $6K/yr)', '6% on select streaming', '3% on gas & transit'],
        badge:    'Best for Groceries & Streaming',
        url:      'https://americanexpress.com/en-us/credit-cards/blue-cash-preferred/',
      },
      {
        id:       'citi-double-cash',
        name:     'Citi Double Cash',
        full:     'Citi Double Cash® Card',
        issuer:   'citi',
        fee:      0,
        color:    '#7B7ECD',
        gradient: 'linear-gradient(135deg,#0e1032 0%,#070921 100%)',
        rates:    { other: 2 },
        perks:    ['2% cash back on everything', 'No annual fee', 'No categories to track'],
        badge:    'Best No-Fee Card',
        url:      'https://www.citi.com/credit-cards/citi-double-cash-credit-card',
      },
      {
        id:       'chase-freedom-unlimited',
        name:     'Freedom Unlimited',
        full:     'Chase Freedom Unlimited®',
        issuer:   'chase',
        fee:      0,
        color:    'var(--fc-accent)',
        gradient: 'linear-gradient(135deg,#001a24 0%,#000d14 100%)',
        rates:    { dining: 3, drugstores: 3, travel: 5, other: 1.5 },
        perks:    ['1.5% on all purchases', '3% dining & drugstores', 'No annual fee'],
        badge:    'Best No-Fee Flat Rate',
        url:      'https://creditcards.chase.com/cash-back-credit-cards/freedom/unlimited',
      },
      {
        id:       'capital-one-venture',
        name:     'Venture Rewards',
        full:     'Capital One Venture Rewards',
        issuer:   'capital one',
        fee:      95,
        color:    '#60a5fa',
        gradient: 'linear-gradient(135deg,#130f1e 0%,#0a0814 100%)',
        rates:    { hotels: 5, rental: 5, travel: 2, other: 2 },
        perks:    ['2x miles on every purchase', '5x on hotels & rentals via C1 Travel', 'Up to $100 Global Entry credit'],
        badge:    'Best Miles Card',
        url:      'https://capitalone.com/credit-cards/venture',
      },
    ];

    // ── 5. Score each card ─────────────────────────────────────────
    function scoreCard(card) {
      // Soft suppression: if user already has a credit card at this issuer, skip
      const issuer = card.issuer.toLowerCase();
      const hasIssuer = state.accounts.some(a =>
        a.type === 'credit' &&
        (a.institution_name || '').toLowerCase().includes(issuer)
      );
      if (hasIssuer) return null;

      // Calculate annual gross rewards
      let annualRewards = 0;
      for (const [bucket, monthlyAmt] of Object.entries(bucketSpend)) {
        const rate = card.rates[bucket] != null ? card.rates[bucket] : (card.rates.other || 1);
        annualRewards += monthlyAmt * 12 * (rate / 100);
      }
      const netValue = annualRewards - card.fee;

      // Find the top contributing category for the "why it fits" copy
      let topBucket = 'other';
      let topBucketAmt = 0;
      let topRate = card.rates.other || 1;
      for (const [bucket, amt] of Object.entries(bucketSpend)) {
        const rate = card.rates[bucket] != null ? card.rates[bucket] : (card.rates.other || 1);
        // Weight by spend × rate so we pick the category that earns the most
        if (amt >= 20 && amt * rate > topBucketAmt * topRate) {
          topBucket    = bucket;
          topBucketAmt = amt;
          topRate      = rate;
        }
      }

      return { ...card, annualRewards, netValue, topBucket, topBucketAmt, topRate };
    }

    const ranked = CARDS
      .map(scoreCard)
      .filter(Boolean)
      .sort((a, b) => b.netValue - a.netValue)
      .slice(0, 3);

    if (!ranked.length) { section.style.display = 'none'; return; }

    // ── 6. Update subtitle with user's top spend buckets ──────────
    const subtitleEl = document.getElementById('card-rec-subtitle');
    if (subtitleEl) {
      const topBuckets = Object.entries(bucketSpend)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([b]) => b);
      subtitleEl.textContent = topBuckets.length
        ? `Based on your ${topBuckets.join(' & ')} spending`
        : 'Based on your spending habits';
    }

    // ── 7. Render carousel ────────────────────────────────────────
    el.innerHTML = ranked.map((card, i) => {
      const annualStr  = FCData.formatCurrency(Math.round(card.annualRewards));
      const netStr     = card.fee > 0
        ? FCData.formatCurrency(Math.max(0, Math.round(card.netValue)))
        : annualStr;
      const feeStr     = card.fee > 0 ? `$${card.fee}/yr` : 'No annual fee';

      // "Why it fits" copy — driven by actual spend data
      const spendAmt   = card.topBucketAmt;
      const matchText  = spendAmt >= 20
        ? `You spend ${FCData.formatCurrency(Math.round(spendAmt))}/mo on ${card.topBucket} — earn ${card.topRate}x back`
        : card.perks[0];

      const isTop      = i === 0;

      return `
        <div style="flex:0 0 272px;scroll-snap-align:start;border-radius:20px;
                    background:${card.gradient};border:1px solid rgba(255,255,255,0.07);
                    padding:16px;box-sizing:border-box;position:relative;overflow:hidden"
             aria-label="${esc(card.full)} card recommendation">

          <!-- Decorative glow -->
          <div aria-hidden="true" style="position:absolute;top:-40px;right:-40px;
               width:120px;height:120px;border-radius:50%;
               background:${card.color};opacity:0.10;pointer-events:none"></div>

          <!-- Header: name + fee + rate badge -->
          <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px">
            <div style="flex:1;min-width:0;padding-right:10px">
              ${isTop ? `<div style="font-size:10px;font-weight:700;color:${card.color};text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px">★ Top Pick</div>` : ''}
              <div style="font-size:15px;font-weight:700;color:var(--fc-text);line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(card.name)}</div>
              <div class="fcs-sub" style="margin-top:2px">${esc(feeStr)}</div>
            </div>
            <div style="flex-shrink:0;background:${card.color}1A;border:1px solid ${card.color}44;border-radius:10px;padding:6px 10px;text-align:center">
              <div style="font-size:20px;font-weight:800;color:${card.color};line-height:1">${card.topRate}x</div>
              <div style="font-size:9px;color:rgba(255,255,255,0.45);margin-top:1px;text-transform:capitalize">${esc(card.topBucket)}</div>
            </div>
          </div>

          <!-- Why it fits -->
          <div class="fcs-why-box">
            <div class="fc-eyebrow" style="margin-bottom:3px">Why it fits you</div>
            <div style="font-size:13px;color:var(--fc-text-muted);line-height:1.45">${esc(matchText)}</div>
          </div>

          <!-- Estimated rewards -->
          <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:14px">
            <div>
              <div class="fcs-sub" style="margin-bottom:3px">${card.fee > 0 ? 'Est. net annual value' : 'Est. annual cash back'}</div>
              <div style="font-size:24px;font-weight:800;color:${card.color};line-height:1">${netStr}</div>
            </div>
            ${card.fee > 0 ? `<div class="fcs-sub" style="text-align:right;line-height:1.5">After<br>$${card.fee} fee</div>` : ''}
          </div>

          <!-- Apply CTA -->
          <a href="${card.url}" target="_blank" rel="noopener noreferrer" class="dash-apply-btn">
            Apply Now
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </a>

          <!-- Disclosure -->
          <div class="fcs-disclosure">
            Partner offer · FlowCheck may earn a referral fee
          </div>
        </div>`;
    }).join('');

    section.style.display = '';
  }

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
  function _renderCashFlowForecast() {
    const section = document.getElementById('home-cashflow-section');
    if (!section) return;
    if (!_isPro()) {
      _renderProGate(section, '📈', '31-Day Cash Flow Forecast',
        'See if you\'ll run short before your next paycheck — before it happens.');
      return;
    }
    // Only show after a bank is linked with real data
    if (!state.user?.plaid_linked || !state.accounts.length) {
      section.style.display = 'none'; return;
    }

    // ── 1. Current cash balance ────────────────────────────────────
    const cashNow = state.accounts
      .filter(a => a.type === 'depository')
      .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);

    if (cashNow <= 0) { section.style.display = 'none'; return; }

    // ── 2. Daily spend rate (14-day average of real spending) ──────
    const cutoff14 = new Date(Date.now() - 14 * 86400000);
    const txns14   = state.transactions.filter(t =>
      t.date && FCData.parseDateLocal(t.date) >= cutoff14 && _isSpendTxn(t)
    );
    const spend14     = txns14.reduce((s, t) => s + (t.amount || 0), 0);
    const dailySpend  = spend14 / 14;

    // Need at least a little spend history to make a meaningful projection
    if (dailySpend <= 0 && !state.bills.length) { section.style.display = 'none'; return; }

    // ── 3. Map upcoming bills to their due-day offsets (0–30) ──────
    const today     = new Date();
    today.setHours(0, 0, 0, 0);
    const billsByDay = {}; // { dayOffset: totalAmount }

    for (const bill of state.bills) {
      if (bill.status === 'paid') continue;
      const days = FCData.daysUntil(bill.due_date);
      if (days == null || days < 0 || days > 30) continue;
      billsByDay[days] = (billsByDay[days] || 0) + (bill.amount || 0);
    }

    // ── 4. Build 31-point balance series (day 0 = today) ──────────
    const DAYS    = 31;
    const series  = new Array(DAYS);
    let   running = cashNow;
    series[0]     = cashNow;

    for (let d = 1; d < DAYS; d++) {
      running -= dailySpend;
      running -= (billsByDay[d] || 0);
      series[d] = running;
    }

    // ── 5. Derived stats ───────────────────────────────────────────
    const endBalance   = series[DAYS - 1];
    const minBalance   = Math.min(...series);
    const minDay       = series.indexOf(minBalance);
    const threshold    = Math.max(200, cashNow * 0.10); // warn below 10% or $200
    const isWarning    = minBalance < threshold;
    const isDanger     = minBalance < 0;

    // ── 6. SVG sparkline ──────────────────────────────────────────
    const chartEl = document.getElementById('cashflow-chart');
    if (chartEl) {
      const W = 320, H = 80, PAD = 4;
      const maxVal = Math.max(cashNow, ...series);
      const minVal = Math.min(0, minBalance);
      const range  = maxVal - minVal || 1;

      // Map day index + value → SVG coords
      function px(d) { return PAD + (d / (DAYS - 1)) * (W - PAD * 2); }
      function py(v) { return H - PAD - ((v - minVal) / range) * (H - PAD * 2); }

      // Build polyline points
      const pts = series.map((v, d) => `${px(d).toFixed(1)},${py(v).toFixed(1)}`).join(' ');

      // Build area fill path (line + bottom close)
      const linePath = series
        .map((v, d) => `${d === 0 ? 'M' : 'L'}${px(d).toFixed(1)},${py(v).toFixed(1)}`)
        .join(' ');
      const areaPath = `${linePath} L${px(DAYS-1).toFixed(1)},${H} L${px(0).toFixed(1)},${H} Z`;

      // Zero-line y position (only draw if minVal < 0)
      const zeroY    = py(0);
      const lineColor = isDanger ? 'var(--fc-danger)' : isWarning ? 'var(--fc-warning)' : 'var(--fc-accent)';
      const gradId    = isDanger ? 'cfGradDanger' : isWarning ? 'cfGradWarn' : 'cfGrad';

      chartEl.innerHTML = `
        <defs>
          <linearGradient id="cfGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#1ac4f0" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#1ac4f0" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="cfGradWarn" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ff9f0a" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#ff9f0a" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="cfGradDanger" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ff453a" stop-opacity="0.28"/>
            <stop offset="100%" stop-color="#ff453a" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${minVal < 0 ? `<line x1="${PAD}" y1="${zeroY.toFixed(1)}" x2="${W-PAD}" y2="${zeroY.toFixed(1)}" style="stroke:var(--fc-border)" stroke-width="1" stroke-dasharray="4 3"/>` : ''}
        <path d="${areaPath}" fill="url(#${gradId})"/>
        <polyline points="${pts}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <!-- Low-point dot -->
        <circle cx="${px(minDay).toFixed(1)}" cy="${py(minBalance).toFixed(1)}" r="4" fill="${lineColor}" opacity="0.9"/>
      `;

      // Position the low-point callout tooltip
      const callout   = document.getElementById('cashflow-low-callout');
      const lowLabel  = document.getElementById('cashflow-low-label');
      const lowValue  = document.getElementById('cashflow-low-value');
      if (callout && lowLabel && lowValue) {
        const dotXPct = px(minDay) / W * 100;
        // Clamp so tooltip doesn't overflow left/right
        const leftPct = Math.min(Math.max(dotXPct, 8), 72);
        callout.style.left    = `${leftPct}%`;
        callout.style.bottom  = `${H - py(minBalance) + 10}px`;
        callout.style.display = '';
        lowLabel.textContent  = minDay === 0 ? 'Today' : `Day ${minDay}`;
        lowValue.textContent  = FCData.formatCurrency(Math.round(minBalance));
        lowValue.style.color  = isDanger ? 'var(--fc-danger)' : isWarning ? 'var(--fc-warning)' : 'var(--fc-accent)';
      }
    }

    // ── 7. Stat boxes ──────────────────────────────────────────────
    const nowEl  = document.getElementById('cashflow-stat-now');
    const lowEl  = document.getElementById('cashflow-stat-low');
    const endEl  = document.getElementById('cashflow-stat-end');

    if (nowEl)  nowEl.textContent  = _fmtCompact(cashNow);
    if (lowEl) {
      lowEl.textContent = _fmtCompact(minBalance);
      lowEl.style.color = isDanger ? 'var(--fc-danger)' : isWarning ? 'var(--fc-warning)' : 'var(--fc-success)';
    }
    if (endEl) {
      endEl.textContent = _fmtCompact(endBalance);
      endEl.style.color = endBalance < 0 ? 'var(--fc-danger)' : endBalance < threshold ? 'var(--fc-warning)' : '#fff';
    }

    // ── 8. Status badge ────────────────────────────────────────────
    const badge = document.getElementById('cashflow-status-badge');
    if (badge) {
      if (isDanger) {
        badge.textContent        = '⚠ Shortfall';
        badge.style.background   = 'rgba(255,69,58,0.15)';
        badge.style.color        = 'var(--fc-danger)';
      } else if (isWarning) {
        badge.textContent        = '⚠ Watch Out';
        badge.style.background   = 'rgba(255,159,10,0.15)';
        badge.style.color        = 'var(--fc-warning)';
      } else {
        badge.textContent        = '✓ On Track';
        badge.style.background   = 'rgba(52,199,89,0.15)';
        badge.style.color        = 'var(--fc-success)';
      }
    }

    // ── 9. Warning message ─────────────────────────────────────────
    const warnEl = document.getElementById('cashflow-warning');
    if (warnEl) {
      if (isDanger) {
        // Find earliest day that goes negative
        const negDay = series.findIndex(v => v < 0);
        const negDate = new Date(today);
        negDate.setDate(negDate.getDate() + negDay);
        const negLabel = negDay <= 7 ? `in ${negDay} day${negDay === 1 ? '' : 's'}`
                       : negDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        warnEl.textContent = `At your current spending rate, your balance is projected to go negative ${negLabel}. Consider reducing discretionary spending or transferring funds.`;
        warnEl.style.display = '';
        warnEl.style.color = 'var(--fc-danger)';
        warnEl.style.borderColor = 'rgba(255,69,58,0.25)';
        warnEl.style.background  = 'rgba(255,69,58,0.08)';
      } else if (isWarning) {
        const lowDate = new Date(today);
        lowDate.setDate(lowDate.getDate() + minDay);
        const dateLabel = minDay <= 7 ? `in ${minDay} day${minDay === 1 ? '' : 's'}`
                        : lowDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        warnEl.textContent = `Your balance is projected to dip to ${FCData.formatCurrency(Math.round(minBalance))} ${dateLabel}. Upcoming bills are the main driver — review your bills list or pause discretionary spending.`;
        warnEl.style.display = '';
        warnEl.style.color = '#ffb020';
        warnEl.style.borderColor = 'rgba(255,159,10,0.25)';
        warnEl.style.background  = 'rgba(255,159,10,0.08)';
      } else {
        warnEl.style.display = 'none';
      }
    }

    // ── 10. Subtitle ───────────────────────────────────────────────
    const subEl = document.getElementById('cashflow-subtitle');
    if (subEl) {
      const billCount = Object.keys(billsByDay).length;
      const parts = [];
      if (dailySpend > 0) parts.push(`${FCData.formatCurrency(Math.round(dailySpend * 30))}/mo spend rate`);
      if (billCount > 0)  parts.push(`${billCount} bill${billCount > 1 ? 's' : ''} due`);
      subEl.textContent = parts.length ? parts.join(' · ') : 'Based on your spending history';
    }

    section.style.display = '';
  }

  // Render the credit score card from cached user data (state.user.credit_score)
  function _renderCreditScore() {
    const noScore  = document.getElementById('credit-no-score');
    const display  = document.getElementById('credit-score-display');
    const refreshBtn = document.getElementById('credit-refresh-btn');
    if (!noScore || !display) return;

    const score = state.user?.credit_score;
    if (!score) {
      noScore.style.display  = '';
      display.style.display  = 'none';
      if (refreshBtn) refreshBtn.style.display = 'none';
      return;
    }

    // Show score
    noScore.style.display  = 'none';
    display.style.display  = '';
    if (refreshBtn) refreshBtn.style.display = '';

    const numEl     = document.getElementById('cs-number');
    const typeEl    = document.getElementById('cs-type');
    const labelEl   = document.getElementById('cs-label');
    const arcEl     = document.getElementById('cs-arc');
    const updatedEl = document.getElementById('cs-updated');
    const factorsEl = document.getElementById('cs-factors');

    const { label, color } = _creditLabel(score);

    if (numEl) numEl.textContent = score;
    if (typeEl) {
      // Abbreviate long score type names so they fit inside the 88px gauge circle
      const rawType = (state.user.credit_score_type || 'FICO').trim();
      const shortType = rawType.replace(/vantagescore\s*/i, 'VS ').replace(/\s+/g, ' ').trim();
      typeEl.textContent = shortType;
    }
    if (labelEl){ labelEl.textContent = label; labelEl.style.color = color; }

    // Animate arc: 188 total arc units for 300–850 range
    if (arcEl) {
      const pct  = Math.max(0, Math.min(1, (score - 300) / 550));
      const dash = Math.round(pct * 188);
      arcEl.setAttribute('stroke-dasharray', `${dash} 226`);
      arcEl.setAttribute('stroke', color);
    }

    if (updatedEl && state.user.credit_score_updated_at) {
      const d = state.user.credit_score_updated_at.toDate
              ? state.user.credit_score_updated_at.toDate()
              : new Date(state.user.credit_score_updated_at);
      updatedEl.textContent = 'Updated ' + d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
    }

    if (factorsEl) {
      const factors = state.user.credit_factors || [];
      factorsEl.innerHTML = factors.slice(0, 3).map(f =>
        `<div class="fcs-factor-chip">${esc(f)}</div>`
      ).join('');
    }

    // Credit score history sparkline (if we have ≥2 months)
    const histEl = document.getElementById('cs-history-chart');
    if (histEl && state.creditHistory && state.creditHistory.length >= 2) {
      const W = 280, H = 48, PAD = 4;
      const vals = state.creditHistory.map(h => h.score || 0).filter(v => v > 0);
      if (vals.length >= 2) {
        const minV = Math.min(...vals) - 10;
        const maxV = Math.max(...vals) + 10;
        const range = maxV - minV || 1;
        const toX = i => Math.round(PAD + (i / (vals.length - 1)) * (W - PAD * 2));
        const toY = v => Math.round(PAD + (1 - (v - minV) / range) * (H - PAD * 2));
        let d = `M${toX(0)},${toY(vals[0])}`;
        for (let i = 1; i < vals.length; i++) {
          const x0 = toX(i-1), y0 = toY(vals[i-1]), x1 = toX(i), y1 = toY(vals[i]);
          const cpX = (x0 + x1) / 2;
          d += ` C${cpX},${y0} ${cpX},${y1} ${x1},${y1}`;
        }
        const lastX = toX(vals.length - 1), lastY = toY(vals[vals.length - 1]);
        const firstMonth = state.creditHistory[0].month || '';
        const lastMonth  = state.creditHistory[state.creditHistory.length - 1].month || '';
        histEl.innerHTML = `
          <div style="font-size:10px;color:var(--fc-text-faint);margin-bottom:6px;font-weight:500">Score trend · ${firstMonth} → ${lastMonth}</div>
          <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="overflow:visible">
            <defs>
              <linearGradient id="cs-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
                <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <path d="${d} L${lastX},${H} L${PAD},${H} Z" fill="url(#cs-grad)"/>
            <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
            <circle cx="${lastX}" cy="${lastY}" r="4" fill="${color}"/>
            <circle cx="${lastX}" cy="${lastY}" r="7" fill="${color}" opacity="0.2"/>
          </svg>`;
        histEl.style.display = 'block';
      }
    } else if (histEl) {
      histEl.style.display = 'none';
    }
  }

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

      _renderCreditScore();
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

    if (dateEl) dateEl.textContent = tod;
    titleEl.textContent = (name || 'Welcome back') + ' 👋';

    // Avatar initial
    const avatarLetter2 = name.charAt(0).toUpperCase() || (authUser2?.email || '').charAt(0).toUpperCase() || '?';
    if (avatarEl) avatarEl.textContent = avatarLetter2;

    // home-greeting-sub is now a hidden compat element — skip visual mutations
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: ACCOUNT PILLS
     ───────────────────────────────────────────────────────────── */
  const _ACCT_TYPE_META = {
    depository: { icon: '🏦', color: 'var(--fc-accent)', label: 'Checking' },
    savings:    { icon: '💰', color: 'var(--fc-success)', label: 'Savings'  },
    credit:     { icon: '💳', color: 'var(--fc-danger)', label: 'Credit'   },
    investment: { icon: '📈', color: 'var(--fc-electric)', label: 'Invest'   },
    loan:       { icon: '🏠', color: 'var(--fc-warning)', label: 'Loan'     },
    mortgage:   { icon: '🏠', color: 'var(--fc-warning)', label: 'Mortgage' },
    other:      { icon: '🏦', color: '#636366', label: 'Account'  },
  };

  function _renderAccountPills() {
    const wrap     = document.getElementById('home-account-pills');
    const inner    = document.getElementById('home-account-pills-inner');
    const dots     = document.getElementById('acct-dots');
    const skeleton = document.getElementById('home-acct-skeleton');
    if (!wrap || !inner) return;

    if (!state.accounts.length) {
      // Show skeleton while bank is linked and data is in-flight; hide otherwise
      const loading = !!(state.user?.plaid_linked && (state.syncing || state.initialLoading));
      if (skeleton) skeleton.style.display = loading ? '' : 'none';
      wrap.style.display = 'none';
      if (dots) dots.style.display = 'none';
      return;
    }
    if (skeleton) skeleton.style.display = 'none';

    wrap.style.display = '';

    // ── Per-type visual theme (dark tinted bg + color accent) ─────────────────
    const _TYPE_THEME = {
      depository: { bg:'#060d1c', border:'rgba(55,138,221,0.22)',  accent:'#378ADD', iconBg:'rgba(55,138,221,0.14)',  iconBorder:'rgba(55,138,221,0.28)'  },
      savings:    { bg:'#071811', border:'rgba(29,158,117,0.22)',  accent:'#1D9E75', iconBg:'rgba(29,158,117,0.14)',  iconBorder:'rgba(29,158,117,0.28)'  },
      credit:     { bg:'#160708', border:'rgba(216,90,48,0.22)',   accent:'#D85A30', iconBg:'rgba(216,90,48,0.14)',   iconBorder:'rgba(216,90,48,0.28)'   },
      investment: { bg:'#0d0714', border:'rgba(96,165,250,0.22)', accent:'#60a5fa', iconBg:'rgba(96,165,250,0.14)', iconBorder:'rgba(96,165,250,0.28)' },
      loan:       { bg:'#160b03', border:'rgba(255,159,10,0.22)',  accent:'var(--fc-warning)', iconBg:'rgba(255,159,10,0.14)',  iconBorder:'rgba(255,159,10,0.28)'  },
      mortgage:   { bg:'#160b03', border:'rgba(255,159,10,0.22)',  accent:'var(--fc-warning)', iconBg:'rgba(255,159,10,0.14)',  iconBorder:'rgba(255,159,10,0.28)'  },
      other:      { bg:'#111118', border:'rgba(255,255,255,0.09)', accent:'#888',    iconBg:'rgba(255,255,255,0.07)', iconBorder:'rgba(255,255,255,0.10)' },
    };

    // ── SVG icons per type ────────────────────────────────────────────────────
    const _TYPE_ICONS = {
      depository: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="9" x2="21" y2="9"/><path d="M3 9l9-6 9 6"/><rect x="4" y="9" width="3" height="8"/><rect x="10.5" y="9" width="3" height="8"/><rect x="17" y="9" width="3" height="8"/><line x1="2" y1="17" x2="22" y2="17"/></svg>`,
      savings:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 7a7 7 0 1 0-10.9 5.79C8.07 12.79 8 13.09 8 13.4V15h8v-1.6c0-.31-.07-.61-.1-.79A7 7 0 0 0 19 7z"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="9" y1="18" x2="15" y2="18"/></svg>`,
      credit:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
      investment: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`,
      loan:       `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
      mortgage:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
      other:      `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>`,
    };

    // Sort: savings/checking first, then credit, invest, loan, other
    const _PILL_ORDER = { depository: 0, savings: 1, credit: 2, investment: 3, loan: 4, mortgage: 5, other: 6 };
    const sortedAccts = [...state.accounts].sort((a, b) =>
      (_PILL_ORDER[a.type] ?? 6) - (_PILL_ORDER[b.type] ?? 6)
    );

    // Institution brand colors — overrides type-based accent for known banks
    const _INST_ACCENT = (instName) => {
      const n = (instName || '').toLowerCase();
      if (n.includes('discover'))           return { accent:'#FF6600', iconBg:'rgba(255,102,0,0.14)',  border:'rgba(255,102,0,0.22)'  };
      if (n.includes('capital one'))        return { accent:'#C0392B', iconBg:'rgba(192,57,43,0.14)',  border:'rgba(192,57,43,0.22)'  };
      if (n.includes('chase') || n.includes('jpmorgan')) return { accent:'#117ACA', iconBg:'rgba(17,122,202,0.14)', border:'rgba(17,122,202,0.22)' };
      if (n.includes('bank of america') || n.includes('bofa')) return { accent:'#E31837', iconBg:'rgba(227,24,55,0.14)', border:'rgba(227,24,55,0.22)' };
      if (n.includes('wells fargo'))        return { accent:'#D71E28', iconBg:'rgba(215,30,40,0.14)',  border:'rgba(215,30,40,0.22)'  };
      if (n.includes('american express') || n.includes('amex')) return { accent:'#007BC1', iconBg:'rgba(0,123,193,0.14)', border:'rgba(0,123,193,0.22)' };
      if (n.includes('citi') || n.includes('citibank'))  return { accent:'#003B93', iconBg:'rgba(0,59,147,0.14)',  border:'rgba(0,59,147,0.22)'  };
      if (n.includes('sofi'))               return { accent:'#6A29FF', iconBg:'rgba(106,41,255,0.14)', border:'rgba(106,41,255,0.22)' };
      if (n.includes('ally'))               return { accent:'#8B14BF', iconBg:'rgba(139,20,191,0.14)', border:'rgba(139,20,191,0.22)' };
      if (n.includes('td bank') || n.includes('td ameritrade')) return { accent:'#34B233', iconBg:'rgba(52,178,51,0.14)', border:'rgba(52,178,51,0.22)' };
      if (n.includes('us bank') || n.includes('usbank'))  return { accent:'#8B0000', iconBg:'rgba(139,0,0,0.14)', border:'rgba(139,0,0,0.22)' };
      if (n.includes('pnc'))                return { accent:'#F58025', iconBg:'rgba(245,128,37,0.14)', border:'rgba(245,128,37,0.22)' };
      if (n.includes('fidelity'))           return { accent:'#538131', iconBg:'rgba(83,129,49,0.14)',  border:'rgba(83,129,49,0.22)'  };
      if (n.includes('vanguard'))           return { accent:'#A8192E', iconBg:'rgba(168,25,46,0.14)',  border:'rgba(168,25,46,0.22)'  };
      if (n.includes('schwab'))             return { accent:'#0E3C6E', iconBg:'rgba(14,60,110,0.14)',  border:'rgba(14,60,110,0.22)'  };
      return null; // fall through to type-based theme
    };

    inner.innerHTML = sortedAccts.map(acct => {
      const rawType   = acct.type || 'other';
      const isSavings = rawType === 'depository' &&
        (acct.subtype || '').toLowerCase().includes('saving');
      const type      = isSavings ? 'savings' : rawType;
      const typeTheme = _TYPE_THEME[type] || _TYPE_THEME.other;
      const instOver  = _INST_ACCENT(acct.institution_name);
      // Institution brand colors take priority over type colors for accent/icon/border
      const theme     = instOver ? { ...typeTheme, ...instOver } : typeTheme;
      const icon      = _TYPE_ICONS[type]  || _TYPE_ICONS.other;
      const meta      = _ACCT_TYPE_META[type] || _ACCT_TYPE_META.other;

      const bal    = acct.balance_current ?? acct.balance ?? 0;
      const isNeg  = bal < 0;
      const absVal = Math.abs(bal);
      const dollars = Math.floor(absVal).toLocaleString('en-US');
      const cents   = String(Math.round((absVal - Math.floor(absVal)) * 100)).padStart(2, '0');
      const name    = esc(acct.name || acct.official_name || meta.label);
      const bank    = esc(acct.institution_name || meta.label);
      const mask    = acct.mask ? `•••• ${esc(acct.mask)}` : '';
      const negPfx  = isNeg ? '−' : '';

      return `<div class="dash-acct-card" onclick="FCApp.switchTab('wealth')" role="button" tabindex="0"
           aria-label="${name}: ${negPfx}$${dollars}.${cents}"
           style="background:${theme.bg};border-color:${theme.border}">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${theme.accent};border-radius:22px 22px 0 0"></div>
        <div class="dash-acct-icon" style="color:${theme.accent};background:${theme.iconBg};border-color:${theme.iconBorder}">${icon}</div>
        <div class="dash-acct-bank">${bank}</div>
        <div class="dash-acct-name">${name}</div>
        <div class="dash-acct-mask">${mask || '&nbsp;'}</div>
        <div class="dash-acct-bal fc-amount">${negPfx}$${dollars}<span class="dash-acct-cents">.${cents}</span></div>
      </div>`;
    }).join('') + `<div class="dash-acct-add" onclick="FCApp.startPlaidLink()" role="button" tabindex="0" aria-label="Add bank account">
        <div style="width:36px;height:36px;border-radius:12px;background:rgba(37,99,235,0.12);display:flex;align-items:center;justify-content:center;color:var(--fc-electric)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </div>
        <div style="font-size:11px;font-weight:700;color:var(--fc-electric);letter-spacing:0.02em;text-align:center;line-height:1.3;margin-top:4px">Add<br>Bank</div>
      </div>`;

    // ── Carousel dots — update active on scroll ───────────────────────────────
    if (dots && sortedAccts.length > 0) {
      dots.style.display = 'flex';
      const total = sortedAccts.length;
      const CARD_W = 222 + 11; // card width + gap

      if (total <= 5) {
        // Few accounts — render individual dots
        dots.innerHTML = Array.from({ length: total }, (_, i) =>
          `<div class="dash-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></div>`
        ).join('');
        wrap.onscroll = () => {
          const active = Math.min(Math.round(wrap.scrollLeft / CARD_W), total - 1);
          dots.querySelectorAll('.dash-dot').forEach((d, i) =>
            d.classList.toggle('active', i === active)
          );
        };
      } else {
        // Many accounts — show a subtle scroll indicator pill
        dots.innerHTML = `<span id="acct-dot-count" class="fcs-acct-counter">1 of ${total}</span>`;
        wrap.onscroll = () => {
          const active = Math.min(Math.round(wrap.scrollLeft / CARD_W), total - 1);
          const countEl = document.getElementById('acct-dot-count');
          if (countEl) countEl.textContent = `${active + 1} of ${total}`;
        };
      }
    } else if (dots) {
      dots.style.display = 'none';
    }
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: ACCOUNT ROWS (v2 compact list)
     ───────────────────────────────────────────────────────────── */
  function _renderAccountRows() {
    const section   = document.getElementById('home-acct-rows-section');
    const container = document.getElementById('home-account-rows');
    if (!section || !container) return;

    if (!state.accounts.length) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';

    const _PILL_ORDER = { depository: 0, savings: 1, credit: 2, investment: 3, loan: 4, mortgage: 5, other: 6 };
    const sorted = [...state.accounts].sort((a, b) =>
      (_PILL_ORDER[a.type] ?? 6) - (_PILL_ORDER[b.type] ?? 6)
    );

    const typeLabel = t => ({ depository:'Checking', savings:'Savings', credit:'Credit Card', investment:'Investment', loan:'Loan', mortgage:'Mortgage' }[t] || 'Account');
    const typeColor = t => ({ depository:'rgba(55,138,221,0.18)', savings:'rgba(29,158,117,0.18)', credit:'rgba(216,90,48,0.18)', investment:'rgba(96,165,250,0.18)', loan:'rgba(255,159,10,0.18)', mortgage:'rgba(255,159,10,0.18)' }[t] || 'rgba(255,255,255,0.07)');
    const typeAccent = t => ({ depository:'#378ADD', savings:'#1D9E75', credit:'#D85A30', investment:'#60a5fa', loan:'var(--fc-warning)', mortgage:'var(--fc-warning)' }[t] || '#888');
    const typeIcon = t => ({ depository:'🏦', savings:'💰', credit:'💳', investment:'📈', loan:'🏠', mortgage:'🏠' }[t] || '🏦');

    const shown = sorted.slice(0, 4);
    const extra = sorted.length - shown.length;
    const isDebtType = t => ['credit','loan','mortgage'].includes(t);

    container.innerHTML = shown.map(a => {
      const type   = (a.type === 'depository' && (a.subtype||'').toLowerCase().includes('saving')) ? 'savings' : (a.type || 'other');
      const bal    = a.balance_current ?? a.balance ?? 0;
      const isDebt = isDebtType(type);
      const name   = esc(a.name || a.official_name || typeLabel(type));
      const mask   = a.mask ? ` ••${esc(a.mask)}` : '';
      const balFmt = FCData.formatCurrency(Math.abs(bal));
      const balColor = isDebt ? 'var(--fc-danger)' : 'var(--fc-text)';
      const balPrefix = isDebt ? '−' : (bal < 0 ? '−' : '');
      return `<div class="dash-acct-row" onclick="FCApp.switchTab('wealth')" role="button" tabindex="0" aria-label="${name} ${balFmt}">
        <div class="dash-acct-row-icon" style="background:${typeColor(type)};color:${typeAccent(type)}">${typeIcon(type)}</div>
        <div class="dash-acct-row-body">
          <div class="dash-acct-row-name">${name}</div>
          <div class="dash-acct-row-type">${typeLabel(type)}${mask}</div>
        </div>
        <div class="dash-acct-row-bal" style="color:${balColor}">${balPrefix}${balFmt}</div>
      </div>`;
    }).join('') +
      (extra > 0
        ? `<div class="dash-acct-row-cta" onclick="FCApp.switchTab('wealth')" role="button" tabindex="0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
            View ${extra} more account${extra !== 1 ? 's' : ''}
          </div>`
        : `<div class="dash-acct-row-cta" onclick="FCApp.startPlaidLink()" role="button" tabindex="0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            Add account
          </div>`);
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: CATEGORY SPENDING DONUT
     ───────────────────────────────────────────────────────────── */
  const _DONUT_COLORS = [
    'var(--fc-accent)','var(--fc-electric)','var(--fc-success)','var(--fc-warning)',
    'var(--fc-danger)','#bf5af2','#00c7be','#ffd60a',
  ];

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

  // Icons keyed on the OUTPUT of _prettyCategory()
  const _DONUT_CAT_ICONS = {
    'Dining':        '🍔',
    'Coffee':        '☕',
    'Groceries':     '🛒',
    'Transport':     '🚗',
    'Gas':           '⛽',
    'Shopping':      '🛍️',
    'Entertainment': '🎬',
    'Healthcare':    '💊',
    'Travel':        '✈️',
    'Utilities':     '💡',
    'Personal Care': '💇',
    'Services':      '🔧',
    'Home':          '🏠',
    'Education':     '📚',
    'Fitness':       '💪',
    'Bank Fees':     '🏦',
    'Loans':         '💰',
    'Investments':   '📈',
    'Government':    '🏛️',
    'Income':        '💵',
  };

  function _renderCategoryDonut() {
    const section = document.getElementById('category-donut-section');
    const svg     = document.getElementById('category-donut-svg');
    const legend  = document.getElementById('category-donut-legend');
    const total   = document.getElementById('donut-total');
    if (!section || !svg || !legend) return;

    // Calendar-month spend by category — exclude transfers & loan payments
    const _TRANSFER_CATS = new Set(['transfer', 'loan', 'loan payments', 'loan payment', 'credit card payment', 'transfer in', 'transfer out']);
    const now = new Date();
    const monthTxns = state.transactions.filter(t => {
      if (t.isCredit || !t.date) return false;
      const d = FCData.parseDateLocal(t.date);
      if (d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) return false;
      const rawCat = (Array.isArray(t.category) ? t.category[0] : t.category) || '';
      const normalized = FCData.normalizePlaidCategory(rawCat).toLowerCase();
      // Exclude internal transfers and loan/credit card payments from spending analysis
      return !_TRANSFER_CATS.has(normalized) && !normalized.includes('transfer');
    });
    if (!monthTxns.length) { section.style.display = 'none'; return; }

    // Aggregate by pretty category (merge Restaurants + Food and Drink → Dining, etc.)
    const catMap = {};
    for (const t of monthTxns) {
      const rawCat = (Array.isArray(t.category) ? t.category[0] : t.category) || 'Other';
      const cat = _prettyCategory(FCData.normalizePlaidCategory(rawCat));
      catMap[cat] = (catMap[cat] || 0) + (t.amount || 0);
    }
    let cats = Object.entries(catMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const totalSpend = cats.reduce((s, [, v]) => s + v, 0);
    if (totalSpend <= 0) { section.style.display = 'none'; return; }

    section.style.display = '';
    if (total) total.textContent = FCData.formatCurrency(totalSpend);

    // Build donut SVG
    const cx = 50, cy = 50, r = 38, inner = 24;
    const circumference = 2 * Math.PI * r;
    let svgHTML = '';
    let offset = 0;
    cats.forEach(([, amt], i) => {
      const pct    = amt / totalSpend;
      const dash   = pct * circumference;
      const gap    = circumference - dash;
      const color  = _DONUT_COLORS[i % _DONUT_COLORS.length];
      const rotate = (offset / circumference) * 360 - 90;
      svgHTML += `<circle cx="${cx}" cy="${cy}" r="${r}"
        fill="none" stroke="${color}" stroke-width="${r - inner}"
        stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
        stroke-dashoffset="0"
        transform="rotate(${rotate.toFixed(2)} ${cx} ${cy})"
        style="transition:stroke-dasharray 0.8s var(--fc-ease-out)"
      />`;
      offset += dash;
    });
    svgHTML += `<circle cx="${cx}" cy="${cy}" r="${inner}" fill="var(--fc-card-bg,#141f2a)"/>`;
    svg.innerHTML = svgHTML;

    // Centre label = top category
    const topCat   = cats[0][0];
    const topPct   = Math.round((cats[0][1] / totalSpend) * 100);
    const centerPct   = document.getElementById('donut-center-pct');
    const centerLabel = document.getElementById('donut-center-label');
    if (centerPct)   centerPct.textContent   = topPct + '%';
    if (centerLabel) centerLabel.textContent = topCat;

    // Legend rows
    legend.innerHTML = cats.map(([cat, amt], i) => {
      const pct   = Math.round((amt / totalSpend) * 100);
      const color = _DONUT_COLORS[i % _DONUT_COLORS.length];
      const icon  = _DONUT_CAT_ICONS[cat] || '💸';
      return `
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
          <span style="font-size:11px;color:var(--fc-text-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1">${esc(icon)} ${esc(cat)}</span>
          <span class="fcs-row-val" style="flex-shrink:0">${pct}%</span>
        </div>`;
    }).join('');
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: RECENT TRANSACTIONS (home preview)
     ───────────────────────────────────────────────────────────── */
  function _renderRecentTransactions() {
    const container = document.getElementById('home-recent-txns');
    const section   = document.getElementById('recent-activity-section');
    if (!container) return;

    const recent = state.transactions
      .filter(t => t.date)
      .sort((a, b) => FCData.parseDateLocal(b.date) - FCData.parseDateLocal(a.date))
      .slice(0, 5);

    const skeleton = document.getElementById('home-txn-skeleton');
    if (!recent.length) {
      if (section) section.style.display = state.user?.plaid_linked ? '' : 'none';
      // Show shimmer skeleton while syncing, plain empty state otherwise
      if (state.user?.plaid_linked && (state.syncing || state.initialLoading)) {
        if (skeleton) skeleton.style.display = '';
        return;
      }
      if (skeleton) skeleton.style.display = 'none';
      container.innerHTML = '<div class="fc-empty"><div class="fc-empty-icon">💳</div><div class="fc-empty-title">No transactions yet</div><div class="fc-empty-sub">Your recent activity will appear here</div></div>';
      return;
    }
    if (skeleton) skeleton.style.display = 'none';
    if (section) section.style.display = '';

    const now       = new Date(); now.setHours(0,0,0,0);
    const yesterday = new Date(now.getTime() - 86400000);

    container.innerHTML = recent.map(t => {
      const rawCat   = (t.category && t.category[0]) || t.category || 'Other';
      const cat      = FCData.normalizePlaidCategory(rawCat);
      const emoji    = (typeof FCData.categoryEmoji === 'function') ? FCData.categoryEmoji(rawCat, t.name) : '💳';
      const color    = (typeof FCData.categoryColor === 'function') ? FCData.categoryColor(rawCat) : '#636366';
      const d        = FCData.parseDateLocal(t.date); d.setHours(0,0,0,0);
      const dateStr  = d.getTime() === now.getTime()       ? 'Today'
                     : d.getTime() === yesterday.getTime() ? 'Yesterday'
                     : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const name     = _cleanTxnName(t);
      const amt      = t.amount || 0;
      const isCredit = t.isCredit;
      return `
        <div class="fc-home-txn" onclick="FCApp.openTransactionDetail('${esc(t.id)}')" role="button" tabindex="0">
          <div class="fc-home-txn-icon" style="background:${esc(color)}22">${esc(emoji)}</div>
          <div style="flex:1;min-width:0">
            <div class="fc-txn-name">${esc(name)}</div>
            <div class="fc-txn-meta">${esc(cat)} · ${esc(dateStr)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
            <div class="fc-txn-amt${isCredit ? ' fc-txn-credit' : ''}">${isCredit ? '+' : '−'}${FCData.formatCurrency(amt)}</div>
            <svg class="fc-txn-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
          </div>
        </div>`;
    }).join('');
  }

  /* ─────────────────────────────────────────────────────────────
     TODAY'S FOCUS — single actionable daily insight engine
     Generates prioritised insights from live user data.
     ───────────────────────────────────────────────────────────── */

  // Internal state — index cycles when user taps "Next →"
  let _focusInsights = [];
  let _focusIdx      = 0;

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
      insights.push({
        type: 'danger',
        label: 'Action Required',
        body: `${overdue[0].name} was due ${Math.abs(FCData.daysUntil(overdue[0].due_date) ?? 0)} days ago — don't let it hit your credit.`,
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
        label: 'Bill Alert',
        body: `${b.name} (${FCData.formatCurrency(b.amount || 0)}) is due ${when}.`,
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
      if (pct > 0.9) {
        insights.push({
          type: pct >= 1 ? 'danger' : 'warn',
          label: pct >= 1 ? 'Over Budget' : 'Budget Alert',
          body: pct >= 1
            ? `You've spent ${FCData.formatCurrency(spent)} — ${FCData.formatCurrency(spent - budget)} over your monthly budget.`
            : `${Math.round(pct * 100)}% of your monthly budget used with ${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate()} days left.`,
          action: 'Review spending',
          tap: () => FCApp.switchTab('insights')
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
        if (overage > 500 && !(budget > 0 && monthSpend / budget > 0.9)) {
          insights.push({
            type: 'danger',
            label: 'Spending Alert',
            body: `At this rate you'll spend ${FCData.formatCurrency(projected)} by month end — ${FCData.formatCurrency(overage)} more than your income.`,
            action: 'See budget',
            tap: () => FCApp.switchTab('insights')
          });
        }
      }
    }

    // ── 4. Unusual large transaction in last 3 days ──────────────
    const cutoff3d  = new Date(now.getTime() - 3  * 86400000);
    const cutoff60d = new Date(now.getTime() - 60 * 86400000);
    const recent   = txns.filter(t => !t.isCredit && FCData.parseDateLocal(t.date) >= cutoff3d);
    if (recent.length) {
      // Use 60-day rolling window so one large historical payment doesn't permanently
      // raise the "average" and suppress future unusual-spend alerts.
      const amounts  = txns.filter(t => !t.isCredit && _isSpendTxn(t) && FCData.parseDateLocal(t.date) >= cutoff60d).map(t => t.amount || 0);
      const avg      = amounts.length ? amounts.reduce((a,b)=>a+b,0)/amounts.length : 0;
      const outlier  = recent.find(t => (t.amount || 0) > avg * 3 && (t.amount || 0) > 50);
      if (outlier && avg > 0) {
        insights.push({
          type: 'info',
          label: 'Unusual Spend',
          body: `${_cleanTxnName(outlier)} (${FCData.formatCurrency(outlier.amount)}) is 3× your average transaction. Recognize it?`,
          action: 'View transaction',
          tap: () => FCApp.switchTab('activity')
        });
      }
    }

    // ── 5. Low cash balance warning ──────────────────────────────
    const cashBal = FCData.calcCash(accounts);
    if (cashBal < 500 && cashBal >= 0 && accounts.length > 0) {
      insights.push({
        type: 'warn',
        label: 'Low Balance',
        body: `Your cash balance is ${FCData.formatCurrency(cashBal)} — keep an eye on upcoming bills.`,
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
          label: 'Save Money',
          body: `We found ${zombies.length} unused subscription${zombies.length>1?'s':''} totaling ${FCData.formatCurrency(total)}/mo you might not need.`,
          action: 'Review subscriptions',
          tap: () => FCApp.switchTab('insights')
        });
      }
    } catch(_) { /* _detectSubscriptions may not be ready yet */ }

    // ── 7. Positive streak — good week ───────────────────────────
    if (!insights.length && txns.length > 0) {
      const weekSpend = txns
        .filter(t => !t.isCredit && _isSpendTxn(t) && FCData.parseDateLocal(t.date) >= new Date(now.getTime() - 7*86400000))
        .reduce((s,t) => s + (t.amount||0), 0);
      const income = txns
        .filter(t => t.isCredit && FCData.isCurrentMonth(t.date))
        .reduce((s,t) => s + (t.amount||0), 0);
      if (income > 0 && weekSpend < income * 0.15) {
        insights.push({
          type: 'good',
          label: 'Great Progress',
          body: `You spent only ${FCData.formatCurrency(weekSpend)} this week — you're on track to save this month! 🎉`,
          action: 'See full breakdown',
          tap: () => FCApp.switchTab('insights')
        });
      } else {
        // Default: net worth update
        const nw = FCData.calcNetWorth(accounts);
        insights.push({
          type: 'info',
          label: 'Net Worth',
          body: `Your current net worth is ${FCData.formatCurrency(nw)}. Keep adding accounts for a complete picture.`,
          action: 'View all accounts',
          tap: () => FCApp.switchTab('wealth')
        });
      }
    }

    return insights;
  }

  // Color + icon config per insight type
  const _FOCUS_COLORS = {
    danger: { bar:'var(--fc-danger)',   label:'rgba(255,69,58,0.90)',  border:'rgba(255,69,58,0.28)',  bg:'rgba(255,69,58,0.08)',  iconBg:'rgba(255,69,58,0.15)',  icon:'⚠️' },
    warn:   { bar:'var(--fc-warning)',  label:'rgba(255,159,10,0.90)', border:'rgba(255,159,10,0.28)', bg:'rgba(255,159,10,0.06)', iconBg:'rgba(255,159,10,0.14)', icon:'🔔' },
    info:   { bar:'var(--fc-electric)', label:'rgba(96,165,250,0.90)', border:'rgba(37,99,235,0.28)',  bg:'rgba(37,99,235,0.06)',  iconBg:'rgba(37,99,235,0.14)',  icon:'💡' },
    good:   { bar:'var(--fc-success)',  label:'rgba(52,199,89,0.90)',  border:'rgba(52,199,89,0.28)',  bg:'rgba(52,199,89,0.06)',  iconBg:'rgba(52,199,89,0.14)',  icon:'✨' },
  };

  function _renderTodaysFocus() {
    const section = document.getElementById('todays-focus-section');
    if (!section) return;

    // Only show if plaid is linked and we have data
    if (!state.user?.plaid_linked || (!state.transactions?.length && !state.bills?.length)) {
      section.style.display = 'none';
      return;
    }

    _focusInsights = _buildFocusInsights();
    if (!_focusInsights.length) { section.style.display = 'none'; return; }

    // Clamp index
    _focusIdx = Math.min(_focusIdx, _focusInsights.length - 1);

    section.style.display = '';
    _applyFocusInsight(_focusIdx);
  }

  function _applyFocusInsight(idx) {
    const insight     = _focusInsights[idx];
    if (!insight) return;
    const c           = _FOCUS_COLORS[insight.type] || _FOCUS_COLORS.info;
    const card        = document.getElementById('todays-focus-card');
    const leftBar     = card?.querySelector('.dash-focus-left-bar');
    const dot         = card?.querySelector('.dash-focus-dot');
    const labelEl     = card?.querySelector('.dash-focus-label');
    const bodyEl      = document.getElementById('focus-body');
    const actionText  = document.getElementById('focus-action-text');
    const counter     = document.getElementById('focus-counter');
    const nextBtn     = document.getElementById('todays-focus-next-btn');

    const iconEl = document.getElementById('focus-icon');
    if (card)    { card.style.background = c.bg; card.style.border = `0.5px solid ${c.border}`; }
    if (leftBar) leftBar.style.background = `linear-gradient(180deg, ${c.bar} 0%, transparent 100%)`;
    if (iconEl)  { iconEl.textContent = c.icon; iconEl.style.background = c.iconBg; }
    if (labelEl) { labelEl.textContent = insight.label; labelEl.style.color = c.label; }

    // For bill insights, highlight due-day text in large cyan
    if (bodyEl) {
      const highlighted = insight.body.replace(
        /\b(today|tomorrow|in \d+ days?)\b/gi,
        m => `<span style="color:var(--fc-accent);font-weight:800">${m}</span>`
      );
      bodyEl.innerHTML = highlighted;
    }

    // For "Mark as paid" → filled cyan button; otherwise default ghost pill
    const actionEl = document.getElementById('focus-action');
    if (actionText) actionText.textContent = insight.action;
    if (actionEl && insight.action === 'Mark as paid') {
      actionEl.style.cssText = 'font-size:13px;font-weight:700;display:inline-flex;align-items:center;gap:5px;padding:9px 16px;border-radius:999px;background:var(--fc-accent);color:#000;border:none;box-shadow:0 4px 14px rgba(26,196,240,0.35)';
      if (actionText) actionText.style.color = '#000';
    } else if (actionEl) {
      actionEl.style.cssText = 'font-size:12px;font-weight:700;display:inline-flex;align-items:center;gap:5px;padding:5px 10px 5px 8px;border-radius:999px;background:rgba(255,255,255,0.07);border:0.5px solid rgba(255,255,255,0.10)';
      if (actionText) actionText.style.color = c.label;
    }

    // Counter badge: "2 / 3"
    if (counter && _focusInsights.length > 1) {
      counter.textContent = `${idx + 1} / ${_focusInsights.length}`;
      counter.style.display = '';
    } else if (counter) {
      counter.style.display = 'none';
    }

    // Show "Next →" only when there are multiple insights
    if (nextBtn) nextBtn.style.display = _focusInsights.length > 1 ? '' : 'none';

    // Store pending tap action on the card element
    if (card) card._focusTap = insight.tap;
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

  function _renderHome() {
    // Update island text based on bank link status — only when truly no accounts at all
    if (state.user && !state.user.plaid_linked && state.accounts.length === 0) {
      _setIslandText('Connect a bank to start');
    }

    // Streak chip on home header
    const streakChipEl = document.getElementById('streak-chip');
    if (streakChipEl && state.user) {
      const days = Math.max(1, state.user.streak || 1);
      const fire = days >= 7 ? '🔥 ' : '';
      streakChipEl.textContent = `${fire}Day ${days}`;
      streakChipEl.title = days >= 100 ? '100-day legend 🔥' : days >= 30 ? '30-day streak!' : days >= 7 ? '7-day streak!' : '';
    }

    // Net worth
    const netWorth = FCData.calcNetWorth(state.accounts);
    const nwEl     = document.getElementById('hero-networth');
    if (nwEl) animateNumber(nwEl, netWorth, '$');

    // TS-2: Last synced timestamp below hero
    const syncEl = document.getElementById('hero-sync-time');
    if (syncEl && state.lastSyncAt) {
      const mins = Math.floor((Date.now() - state.lastSyncAt) / 60000);
      syncEl.textContent = mins < 1 ? 'Updated just now'
        : mins < 60 ? `Updated ${mins} min ago`
        : `Updated at ${new Date(state.lastSyncAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
      syncEl.style.display = '';
    }

    // Color-code the hero card based on NW sign: cyan glow for positive, red for negative
    const nwCard = document.querySelector('.dash-nw-card');
    if (nwCard) {
      if (netWorth < 0) {
        nwCard.style.borderColor = 'rgba(255,69,58,0.26)';
        nwCard.style.setProperty('--nw-glow-color', 'rgba(255,69,58,0.22)');
      } else {
        nwCard.style.borderColor = '';
        nwCard.style.setProperty('--nw-glow-color', '');
      }
    }
    // NW tag — always "NET WORTH", negative signaled by border color + red delta pill
    const nwTag = document.querySelector('.dash-nw-tag');
    if (nwTag) nwTag.textContent = 'NET WORTH';

    // Assets vs Liabilities breakdown below net worth
    const assetsEl  = document.getElementById('hero-assets');
    const liabsEl   = document.getElementById('hero-liabilities');
    if (assetsEl || liabsEl) {
      const assets = state.accounts
        .filter(a => !['credit','loan','mortgage'].includes(a.type))
        .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
      const liabs = state.accounts
        .filter(a => ['credit','loan','mortgage'].includes(a.type))
        .reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
      if (assetsEl) assetsEl.textContent = FCData.formatCurrency(assets);
      if (liabsEl)  liabsEl.textContent  = FCData.formatCurrency(liabs);
    }

    // Cash stat
    const cash   = FCData.calcCash(state.accounts);
    const cashEl = document.getElementById('stat-cash');
    if (cashEl) animateNumber(cashEl, cash, '$');

    // Account count
    const acctEl = document.getElementById('stat-account-count');
    if (acctEl) acctEl.textContent = state.accounts.length + ' account' + (state.accounts.length !== 1 ? 's' : '');

    // Quick-stat strip (new dashboard)
    const qsCash = document.getElementById('fch-qs-cash');
    if (qsCash) qsCash.textContent = _fmtCompact(cash);

    // Upcoming bills (next 3)
    const billsEl = document.getElementById('home-bills-list');
    if (billsEl) {
      const upcoming = state.bills
        .filter(b => b.status !== 'paid')
        .sort((a, b) => (FCData.daysUntil(a.due_date) ?? 999) - (FCData.daysUntil(b.due_date) ?? 999))
        .slice(0, 3);

      if (!upcoming.length) {
        billsEl.innerHTML = '<div class="fc-empty"><div class="fc-empty-icon">✅</div><div class="fc-empty-title">All clear</div><div class="fc-empty-sub">No upcoming bills</div></div>';
      } else {
        const allUnpaid = state.bills.filter(b => b.status !== 'paid');
        billsEl.innerHTML = upcoming.map(b => {
          const days = FCData.daysUntil(b.due_date);
          const { label, color } = FCData.billDueLabelAndColor(days !== null ? days : 999);
          const bg = b.color || FCData.categoryColor(b.category || 'Service');
          return `
            <div class="fc-list-item" data-bill-id="${esc(b.id)}" style="cursor:pointer" onclick="FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')" role="button">
              <div class="fc-list-icon" style="background:${esc(bg)};color:white;font-weight:700;font-size:16px">
                ${esc(b.icon || b.name.charAt(0))}
              </div>
              <div class="fc-list-body">
                <div class="fc-list-title">${esc(b.name)}</div>
                <div class="fc-list-meta" style="color:${esc(color)};font-weight:${days !== null && days <= 1 ? 600 : 400}">${esc(label)}</div>
              </div>
              <div style="flex-shrink:0">
                <div class="fc-list-amount">${FCData.formatCurrency(b.amount)}</div>
              </div>
            </div>`;
        }).join('') +
          (allUnpaid.length > 3
            ? `<div style="text-align:center;padding:10px 0 4px;cursor:pointer;color:var(--fc-accent);font-size:13px;font-weight:500" onclick="FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')">See all ${allUnpaid.length} bills →</div>`
            : '') +
          `<div class="fc-bills-total">
            <span class="fc-bills-total-lbl">Total due</span>
            <span class="fc-bills-total-amt">${FCData.formatCurrency(allUnpaid.reduce((s,b) => s + (b.amount || 0), 0))}</span>
          </div>`;
      }

      // Badge count
      const overdue = state.bills.filter(b => b.status !== 'paid' && FCData.daysUntil(b.due_date) <= 3);
      const badgeEl = document.getElementById('bills-badge');
      if (badgeEl) {
        badgeEl.textContent = overdue.length;
        badgeEl.style.display = overdue.length ? 'inline-flex' : 'none';
      }
    }

    // Subs total — auto-detected recurring transactions + manual subscription bills
    const subsEl = document.getElementById('stat-subs');
    if (subsEl) {
      const detectedSubs = _detectSubscriptions();
      const autoTotal    = detectedSubs.reduce((s, sub) => s + sub.amount, 0);
      const billTotal    = state.bills
        .filter(b => b.category === 'Subscription' || b.type === 'subscription')
        .reduce((sum, b) => sum + (b.amount || 0), 0);
      subsEl.textContent = _fmtCompact(autoTotal || billTotal);
    }

    // Bills due stat
    const unpaidBills = state.bills.filter(b => b.status !== 'paid');
    const unpaidBillsTotal = unpaidBills.reduce((s, b) => s + (b.amount || 0), 0);
    const billsStatEl = document.getElementById('stat-bills');
    if (billsStatEl) animateNumber(billsStatEl, unpaidBillsTotal, '$');
    // Quick-stat strip: bills
    const qsBills = document.getElementById('fch-qs-bills');
    if (qsBills) {
      qsBills.textContent = _fmtCompact(unpaidBillsTotal);
      qsBills.className = 'dash-sp-val ' + (unpaidBillsTotal > 0 ? 'dash-red' : 'dash-green');
    }

    // Update bills-due-meta label dynamically — only red if something is actually due soon
    const billsDueMeta = document.getElementById('bills-due-meta');
    if (billsDueMeta) {
      const soonBill = unpaidBills
        .map(b => ({ ...b, days: FCData.daysUntil(b.due_date) }))
        .filter(b => b.days !== null && b.days <= 7)
        .sort((a, b) => a.days - b.days)[0];

      const billsStatCard = billsStatEl?.closest('.fc-stat');
      if (soonBill) {
        const urgent = soonBill.days <= 3;
        billsDueMeta.textContent = soonBill.days === 0 ? 'due today'
          : soonBill.days === 1 ? 'due tomorrow'
          : `due in ${soonBill.days}d`;
        billsDueMeta.className = urgent ? 'fc-stat-meta fc-stat-meta--danger' : 'fc-stat-meta fc-stat-meta--warn';
      } else if (unpaidBills.length === 0) {
        billsDueMeta.textContent = 'no bills';
        billsDueMeta.className   = 'fc-stat-meta';
      } else {
        billsDueMeta.textContent = `${unpaidBills.length} unpaid`;
        billsDueMeta.className   = 'fc-stat-meta';
      }
    }

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
    const overdueCount     = state.bills.filter(b => b.status !== 'paid' && FCData.daysUntil(b.due_date) < 0).length;

    const incomeEl       = document.getElementById('stat-income');
    if (incomeEl) incomeEl.textContent = _fmtCompact(periodIncome);
    const incomePeriodEl = document.getElementById('stat-income-period');
    if (incomePeriodEl) incomePeriodEl.textContent = _PERIOD_LABELS[state.period] || 'this month';

    // Quick-stat strip: spent (period-aware, red when over 80% of income)
    const qsSpent = document.getElementById('fch-qs-spent');
    if (qsSpent) {
      qsSpent.textContent = _fmtCompact(periodSpend);
      // Only color-code if income is reliably detected; otherwise neutral
      qsSpent.className = 'dash-sp-val ' + (
        _incomeIsReliable(periodIncome, periodSpend) && periodSpend / periodIncome > 0.9 ? 'dash-red' :
        _incomeIsReliable(periodIncome, periodSpend) && periodSpend / periodIncome > 0.7 ? '' : ''
      );
    }

    // Cash flow → NW footer — only meaningful when income is detectable
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

    // ── Month Pulse bar ──────────────────────────────────────────
    const pulseRow       = document.getElementById('dash-pulse-row');
    const pulseFill      = document.getElementById('dash-pulse-fill');
    const pulseSpentEl   = document.getElementById('dash-pulse-spent');
    const pulseIncomeEl  = document.getElementById('dash-pulse-income');
    const pulseDaysEl    = document.getElementById('dash-pulse-days');
    const pulseProjEl    = document.getElementById('dash-pulse-projected');

    if (pulseRow) {
      if (state.user && state.user.plaid_linked) {
        pulseRow.style.display = '';
        const incomeOk   = _incomeIsReliable(monthIncome, monthSpend);
        const pulsePct   = incomeOk ? Math.min(Math.round((monthSpend / monthIncome) * 100), 100) : 0;
        const fillColor  = incomeOk && pulsePct >= 90 ? 'var(--fc-danger)'
                         : incomeOk && pulsePct >= 70 ? 'var(--fc-warning)'
                         : 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))';
        if (incomeOk && pulsePct >= 90) pulseRow.classList.add('dash-pulse--danger');
        else pulseRow.classList.remove('dash-pulse--danger');

        if (pulseSpentEl)  pulseSpentEl.textContent  = _fmtCompact(monthSpend);
        const pulseIncomeLabelEl = document.getElementById('dash-pulse-income-label');
        if (pulseIncomeEl) {
          if (incomeOk) {
            pulseIncomeEl.textContent = _fmtCompact(monthIncome);
            if (pulseIncomeLabelEl) pulseIncomeLabelEl.style.display = '';
          } else {
            pulseIncomeEl.textContent = '';
            if (pulseIncomeLabelEl) pulseIncomeLabelEl.style.display = 'none';
          }
        }
        if (pulseFill) {
          pulseFill.style.width      = incomeOk ? pulsePct + '%' : '100%';
          pulseFill.style.background = monthSpend > 0 ? fillColor : 'rgba(255,255,255,0.10)';
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
          const overBudget = incomeOk && projected > monthIncome;
          pulseProjEl.style.display = '';
          pulseProjEl.innerHTML = `Est. <span style="${overBudget ? 'color:var(--fc-danger)' : ''}">${_fmtCompact(projected)}</span> by month end`;
        } else if (pulseProjEl) {
          pulseProjEl.style.display = 'none';
        }
      } else {
        pulseRow.style.display = 'none';
      }
    }

    // ── Quick-stat sub-labels ───────────────────────────────────
    const cashSubEl  = document.getElementById('fch-qs-cash-sub');
    const spentSubEl = document.getElementById('fch-qs-spent-sub');
    const billsSubEl = document.getElementById('fch-qs-bills-sub');

    if (cashSubEl) {
      const n = state.accounts.length;
      cashSubEl.textContent = n ? `${n} account${n !== 1 ? 's' : ''}` : 'connect a bank';
    }
    if (spentSubEl) {
      const incomeOkSub = _incomeIsReliable(monthIncome, monthSpend);
      if (incomeOkSub && monthSpend > 0) {
        const spentPct = Math.round((monthSpend / monthIncome) * 100);
        spentSubEl.textContent = `${spentPct}% of income`;
        spentSubEl.style.color = spentPct >= 90 ? 'var(--fc-danger)' : spentPct >= 70 ? 'var(--fc-warning)' : '';
      } else {
        // For 1W, clarify it can include prior-month transactions
        const label = state.period === '1W' ? 'last 7 days'
                    : _PERIOD_LABELS[state.period] || 'this month';
        spentSubEl.textContent = label;
        spentSubEl.style.color = '';
      }
    }
    if (billsSubEl) {
      const billCount = unpaidBills.length;
      billsSubEl.textContent = billCount ? `${billCount} upcoming` : 'all clear';
      // Tint bills stat card top bar red only when there are bills due
      const billsStatCard = document.getElementById('dash-stat-bills');
      if (billsStatCard) {
        billsStatCard.style.setProperty('--bills-bar-color',
          overdueCount > 0 ? 'var(--fc-danger)'
          : billCount  > 0 ? 'var(--fc-warning)'
          : 'rgba(255,255,255,0.14)'
        );
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
          <div class="fc-h3" style="font-size:16px;margin-bottom:2px">${g.name}</div>
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

    // ── Today's Focus card ────────────────────────────────────────
    _renderTodaysFocus();

    // ── Recent transactions preview ───────────────────────────────
    _renderRecentTransactions();

    // ── Account rows (compact list) ───────────────────────────────
    _renderAccountRows();

    // ── Net worth sparkline snapshot ─────────────────────────────
    _snapshotNetWorth(netWorth);

    // ── Safe to Spend hero ───────────────────────────────────────
    const safeEl    = document.getElementById('stat-safe-to-spend');
    const metaEl    = document.getElementById('safe-spend-meta');
    const barEl     = document.getElementById('safe-spend-bar');
    const spentLbl  = document.getElementById('safe-spent-label');
    const billsLbl  = document.getElementById('safe-bills-label');

    if (state.user && state.user.plaid_linked) {
      const buffer        = cash * 0.10;
      const safeToSpend   = Math.max(0, cash - unpaidBillsTotal - buffer);

      _renderGreeting(safeToSpend);

      const committed     = monthSpendRaw;
      const isOver        = cash > 0 && committed >= cash;
      const barPct        = cash > 0 ? Math.min(Math.round((committed / cash) * 100), 100) : 100;
      const barColor      = isOver             ? 'var(--fc-danger)'
                          : barPct > 85        ? 'var(--fc-danger)'
                          : barPct > 65        ? 'var(--fc-warning)'
                          : 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))';

      const cardLabelEl = document.getElementById('safe-spend-card-label');
      if (cardLabelEl) cardLabelEl.textContent = isOver ? 'Cash Balance' : 'Safe to Spend';

      if (safeEl) {
        safeEl.classList.remove('dash-hero-amount--empty');
        animateNumber(safeEl, isOver ? Math.max(0, cash) : safeToSpend, '$');
      }

      if (metaEl) metaEl.textContent = isOver
        ? 'Month spend exceeds cash on hand'
        : `${Math.round(barPct)}% of cash committed`;

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
    }

    // ── Mini cards: Financial Health + Net Worth side-by-side ─────
    (function () {
      const miniSection = document.getElementById('dash-mini-cards');
      if (!miniSection) return;

      const hasData = state.user?.plaid_linked && state.accounts.length > 0;
      if (!hasData) { miniSection.classList.remove('visible'); return; }
      miniSection.classList.add('visible');

      // Health score (reuse same algorithm as _renderHealthScore)
      const accts2    = state.accounts || [];
      const txns2     = (state.transactions || []).filter(t => FCData.isCurrentMonth(t.date));
      const budget2   = (state.budgets?.['total']?.limit) || 3000;
      const spent2    = txns2.filter(t => !t.isCredit && _isSpendTxn(t)).reduce((s, t) => s + (t.amount || 0), 0);
      const income2   = txns2.filter(_isIncomeTxn).reduce((s, t) => s + (t.amount || 0), 0);
      const sRatio2   = budget2 > 0 ? spent2 / budget2 : 0.5;
      let ss2 = sRatio2 <= 0.75 ? 34 : sRatio2 >= 1.5 ? 0 : Math.round(34 * (1.5 - sRatio2) / 0.75);
      const savRate2  = _incomeIsReliable(income2, spent2) ? (income2 - spent2) / income2 : null;
      let savScore2   = savRate2 === null ? 16 : savRate2 >= 0.2 ? 33 : savRate2 > 0 ? Math.round(33 * savRate2 / 0.2) : 0;
      const assets2   = accts2.filter(a => a.type === 'depository' || a.type === 'investment').reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
      const debts2    = accts2.filter(a => a.type === 'credit' || a.type === 'loan').reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
      const nw2       = assets2 - debts2;
      let nwScore2    = nw2 > 50000 ? 33 : nw2 > 10000 ? Math.round(33 * nw2 / 50000) : nw2 > 0 ? Math.round(20 * nw2 / 10000) : nw2 === 0 ? 10 : Math.max(0, Math.round(10 + nw2 / 5000));
      const total2    = Math.min(100, ss2 + savScore2 + nwScore2);
      const gradeMap2 = total2 >= 90 ? ['A+','Excellent'] : total2 >= 80 ? ['A','Great'] : total2 >= 70 ? ['B','Good'] : total2 >= 60 ? ['C','Fair'] : total2 >= 50 ? ['D','Needs Work'] : ['F','At Risk'];
      const ringColor2 = total2 >= 70 ? 'var(--fc-accent)' : total2 >= 50 ? 'var(--fc-warning)' : 'var(--fc-danger)';
      const gradeColor2 = total2 >= 70 ? 'var(--fc-success)' : total2 >= 50 ? 'var(--fc-warning)' : 'var(--fc-danger)';

      const homeRing  = document.getElementById('home-health-ring');
      const homeScore = document.getElementById('home-health-ring-score');
      const homeGrade = document.getElementById('home-health-grade');
      const homeDelta = document.getElementById('home-health-delta');
      if (homeRing) { homeRing.style.strokeDashoffset = 113 * (1 - total2 / 100); homeRing.style.stroke = ringColor2; }
      if (homeScore) homeScore.textContent = total2;
      if (homeGrade) { homeGrade.textContent = gradeMap2[1]; homeGrade.style.color = gradeColor2; }
      if (homeDelta) {
        homeDelta.style.display = 'none'; // trend computation requires prev month data
      }

      // Mini NW card
      const miniNw  = document.getElementById('home-mini-nw');
      const miniDelta = document.getElementById('home-mini-nw-delta');
      if (miniNw) animateNumber(miniNw, netWorth, '$');
      if (miniDelta) {
        const hist = state.nwHistory || {};
        const histKeys = Object.keys(hist).sort();
        if (histKeys.length >= 2) {
          const prev2 = hist[histKeys[histKeys.length - 2]] ?? 0;
          const delta2 = netWorth - prev2;
          const isNegNW2 = netWorth < 0;
          miniDelta.textContent = delta2 >= 0
            ? (isNegNW2 ? '↑ Improved ' : '↑ +') + FCData.formatCurrency(Math.abs(delta2)) + ' this month'
            : '↓ ' + FCData.formatCurrency(Math.abs(delta2)) + ' this month';
          miniDelta.style.color = delta2 >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
          miniDelta.style.display = '';
        } else {
          miniDelta.style.display = 'none';
        }
      }

      // Mini sparkline
      (function () {
        const svg2  = document.getElementById('home-mini-sparkline');
        const line2 = document.getElementById('home-mini-sparkline-line');
        const dot2  = document.getElementById('home-mini-sparkline-dot');
        if (!svg2 || !line2) return;
        const hist2 = state.nwHistory || {};
        const keys2 = Object.keys(hist2).sort();
        const vals2 = keys2.map(k => hist2[k]);
        if (vals2.length < 2) { line2.setAttribute('d', 'M0,24 L120,24'); return; }
        const W2 = 120, H2 = 28, pad2 = 3;
        const min2 = Math.min(...vals2), max2 = Math.max(...vals2);
        const rng2 = max2 - min2 || 1;
        const toY2 = v => pad2 + (H2 - 2 * pad2) * (1 - (v - min2) / rng2);
        const toX2 = i => (i / (vals2.length - 1)) * W2;
        const pts2 = vals2.map((v, i) => [toX2(i), toY2(v)]);
        let d2 = `M${pts2[0][0].toFixed(1)},${pts2[0][1].toFixed(1)}`;
        for (let i2 = 1; i2 < pts2.length; i2++) {
          const [x0, y0] = pts2[i2 - 1], [x1, y1] = pts2[i2];
          const cx2 = (x0 + x1) / 2;
          d2 += ` C${cx2.toFixed(1)},${y0.toFixed(1)} ${cx2.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
        }
        line2.setAttribute('d', d2);
        const lp2 = pts2[pts2.length - 1];
        if (dot2) { dot2.setAttribute('cx', lp2[0].toFixed(1)); dot2.setAttribute('cy', lp2[1].toFixed(1)); }
        const isPos2 = vals2[vals2.length - 1] >= vals2[0];
        line2.setAttribute('stroke', isPos2 ? '#1ac4f0' : 'var(--fc-danger)');
        if (dot2) dot2.setAttribute('fill', isPos2 ? '#1ac4f0' : 'var(--fc-danger)');
      })();
    })();

    // V3 home enhancements
    _renderDailyBrief();
    _renderPriorityActions();
    _renderCashRunway();
    _renderTimeline();

    // Feedback banner
    _renderFeedbackBanner();

    // Welcome modal — show once per user, deferred so home renders first
    if (state.user && !state.user.welcome_seen && !_welcomeShown) {
      setTimeout(_maybeShowWelcomeModal, 800);
    }
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

    // V3: spending trends + recurring banner
    _renderSpendingTrends();
    _renderRecurringBanner();

    // Apply period filter
    const _now2 = new Date(); _now2.setHours(0,0,0,0);
    const _actFilterFn = (t) => {
      if (!t.date) return false;
      // Use parseDateLocal to avoid UTC→local day-shift bug on "YYYY-MM-DD" strings
      const ts = FCData.parseDateLocal(t.date).getTime();
      switch (_activityFilter) {
        case 'today': return ts >= _now2.getTime();
        case 'week':  return ts >= _now2.getTime() - 6 * 86400000;
        case 'month': {
          const d = FCData.parseDateLocal(t.date);
          return d.getMonth() === _now2.getMonth() && d.getFullYear() === _now2.getFullYear();
        }
        case 'income': return !!t.isCredit;
        default: return true;
      }
    };

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

    let base = txnsWithOverrides.filter(_actFilterFn);

    // Category chip filter
    // Chip values are short keywords; map to the Plaid category name fragments
    const CAT_CHIP_MAP = {
      food:          ['food', 'dining', 'restaurants', 'coffee', 'fast food', 'groceries'],
      transport:     ['travel', 'transport', 'gas', 'parking', 'taxi', 'ride', 'auto', 'car', 'airlines', 'ferry', 'rail', 'bus'],
      shopping:      ['shops', 'shopping', 'clothing', 'supermarket', 'department', 'merchandise', 'warehouse'],
      entertainment: ['entertainment', 'arts', 'recreation', 'games', 'music', 'movies', 'sports'],
      health:        ['healthcare', 'health', 'medical', 'pharmacy', 'dentist', 'doctor', 'hospital', 'fitness'],
    };
    if (_activityCategoryFilter !== 'all') {
      const catFilter = _activityCategoryFilter.toLowerCase();
      if (catFilter === 'income') {
        base = base.filter(t => t.isCredit);
      } else {
        const aliases = CAT_CHIP_MAP[catFilter] || [catFilter];
        base = base.filter(t => {
          // Check all category array entries for a match
          const cats = (t.category || []).map(c => c.toLowerCase());
          return cats.some(c => aliases.some(alias => c.includes(alias)));
        });
      }
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

    const filterLabel = { all: 'transactions', today: 'transactions today', week: 'transactions this week', month: 'transactions this month', income: 'income transactions' }[_activityFilter] || 'transactions';

    if (!filtered.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:48px 24px;color:var(--fc-text-faint)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:12px;opacity:0.4"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>
          <div style="font-size:15px;font-weight:500;margin-bottom:4px;color:var(--fc-text-muted)">
            ${state.accounts.length ? `No ${filterLabel} yet` : 'Connect a bank to see transactions'}
          </div>
          <div style="font-size:13px">
            ${state.accounts.length ? 'Pull down to sync' : 'Tap the link button above'}
          </div>
        </div>`;
      return;
    }

    const groups = FCData.groupTransactionsByDate(filtered);
    let html = '';

    for (const [label, txns] of Object.entries(groups)) {
      html += `<div class="fc-date-label">${label}</div>
               <article class="fc-card" style="padding:4px 16px;margin-bottom:0">`;

      html += txns.map(t => {
        const rawCat = (t.category && t.category[0]) || t.category || 'Other';
        const cat    = _prettyCategory(FCData.normalizePlaidCategory(rawCat));
        const emoji  = FCData.categoryEmoji(rawCat, t.name);
        const isEmojiIcon = emoji.length <= 2 && isNaN(emoji);
        const color  = t.isCredit ? 'var(--fc-success)' : 'var(--fc-danger)';
        const sign   = t.isCredit ? '+' : '−';
        // Always use the cleaner — strips raw bank strings like "DEBIT PURCHASE 0523 9264 CENEX"
        const displayName = _cleanTxnName(t);
        const txDate = t.date ? FCData.parseDateLocal(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const editedDot = t._edited
          ? '<span style="width:5px;height:5px;background:var(--fc-accent);border-radius:50%;display:inline-block;margin-left:4px;vertical-align:middle"></span>'
          : '';
        return `
          <div class="fc-list-item" style="cursor:pointer" onclick="FCApp.openTransactionDetail('${esc(t.id)}')" role="button">
            <div class="fc-list-icon" style="background:${isEmojiIcon ? FCData.categoryColor(rawCat) + '20' : FCData.categoryColor(rawCat)};font-size:${isEmojiIcon ? '20px' : '15px'};font-weight:${isEmojiIcon ? '400' : '700'};color:white">${emoji}</div>
            <div class="fc-list-body">
              <div class="fc-list-title">${esc(displayName)}${editedDot}</div>
              <div class="fc-list-meta">${esc(cat)}${txDate ? ' · ' + txDate : ''}</div>
            </div>
            <div class="fc-list-amount" style="color:${color}">${sign}${FCData.formatCurrency(t.amount)}</div>
          </div>`;
      }).join('');

      html += '</article>';
    }

    container.innerHTML = html;
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
    const budget   = (state.budgets?.['total']?.limit) || 3000;

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
    const savingsAccts = accts.filter(a => a.type === 'depository');
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
      .filter(a => a.type === 'depository' || a.type === 'investment' || a.type === 'brokerage')
      .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
    const debts  = accts
      .filter(a => a.type === 'credit' || a.type === 'loan')
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

    const budget     = state.budgets?.['total']?.limit || 3000;
    const unpaid     = (state.bills || []).filter(b => b.status !== 'paid');
    const unpaidTotal = unpaid.reduce((s, b) => s + (b.amount || 0), 0);
    const cash       = Math.max(0, state.accounts ? state.accounts.filter(a => a.type === 'depository').reduce((s, a) => s + (a.balance_current || a.balance || 0), 0) : 0);
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

  function _renderInsights() {
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
    // Insights respond to the global period selector (same as home screen)
    const periodTxns  = _getPeriodTxns();
    const periodLabel = _PERIOD_LABELS[state.period] || 'this month';

    // Use the shared _isSpendTxn filter so insights and activity screens
    // always agree on what counts as spending (avoids set-divergence bugs).
    const periodSpendTxns = periodTxns.filter(_isSpendTxn);
    const periodSpend  = periodSpendTxns.reduce((s, t) => s + (t.amount || 0), 0);
    const periodIncome = periodTxns.filter(_isIncomeTxn).reduce((s, t) => s + (t.amount || 0), 0);

    // Update the insights period labels
    const insightsPeriodEl = document.getElementById('insights-period-label');
    if (insightsPeriodEl) insightsPeriodEl.textContent = periodLabel;
    const insightsCatPeriod = document.getElementById('insights-cat-period');
    if (insightsCatPeriod) insightsCatPeriod.textContent = periodLabel;

    // ── This Period Summary (week card) ──────────────────────────
    _renderWeekSummary(periodSpend, periodIncome, periodLabel);

    // ── Spending ring + budget progress ──────────────────────────
    const budgetLimit  = state.budgets && state.budgets['total'] ? state.budgets['total'].limit : 3000;
    const budgetPct    = Math.min(Math.round((periodSpend / budgetLimit) * 100), 100);
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
      remEl.textContent = periodSpend > budgetLimit
        ? `${FCData.formatCurrency(periodSpend - budgetLimit)} over`
        : `${FCData.formatCurrency(remaining)} left`;
      remEl.style.color = periodSpend > budgetLimit ? 'var(--fc-danger)' : 'var(--fc-text-faint)';
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
            ${budLim > 0 ? `<div style="position:absolute;top:0;left:0;height:100%;width:${Math.min(budPct,100)}%;background:${budColor};border-radius:99px;transition:width 0.5s ease"></div>` : ''}
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
                  <span style="font-size:13px;color:var(--fc-text-muted);flex:1">${b.name}</span>
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
        if (card) card.style.display = '';
        list.innerHTML = '<div style="color:var(--fc-text-faint);text-align:center;padding:16px 0;font-size:11px">No spending data yet</div>';
        return;
      }
      if (card) card.style.display = '';

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
              <div class="fc-list-title" style="font-size:14px">${s.name}</div>
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
    const budgetLim  = (state.budgets && state.budgets['total']) ? state.budgets['total'].limit : 3000;

    if (yearLabelEl) yearLabelEl.textContent = year;

    // Aggregate per-month spending for this year (spending txns only — no transfers or income)
    const monthlySpend = new Array(12).fill(0);
    (state.transactions || []).filter(t => !t.isCredit && t.date && _isSpendTxn(t)).forEach(t => {
      const d = FCData.parseDateLocal(t.date);
      if (d.getFullYear() === year) monthlySpend[d.getMonth()] += (t.amount || 0);
    });

    const totalYearSpend = monthlySpend.reduce((s, v) => s + v, 0);
    const annualBudget   = budgetLim * 12;
    const annualPct      = annualBudget > 0 ? Math.min(Math.round((totalYearSpend / annualBudget) * 100), 100) : 0;
    const annualColor    = annualPct > 100 ? 'var(--fc-danger)' : annualPct > 80 ? 'var(--fc-warning)' : 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))';

    if (annualSpend)  annualSpend.textContent  = FCData.formatCurrency(totalYearSpend);
    if (annualLimit)  annualLimit.textContent  = `of ${FCData.formatCurrency(annualBudget)}`;
    if (annualFill)   { annualFill.style.width = annualPct + '%'; annualFill.style.background = annualColor; }
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
      const pct     = budgetLim > 0 ? Math.min(Math.round((spend / budgetLim) * 100), 100) : 0;
      const color   = isFut ? 'rgba(255,255,255,0.12)'
                    : pct > 100 ? 'var(--fc-danger)'
                    : pct > 80  ? 'var(--fc-warning)'
                    : 'var(--fc-accent)';
      const cardBg  = isCur ? 'rgba(26,196,240,0.1)' : 'rgba(255,255,255,0.04)';
      const border  = isCur ? '1px solid rgba(26,196,240,0.3)' : '1px solid rgba(255,255,255,0.06)';
      const amtTxt  = isFut ? '—' : spend >= 1000 ? `$${(spend/1000).toFixed(1)}k` : `$${Math.round(spend)}`;
      const amtCol  = isFut ? 'rgba(255,255,255,0.18)' : 'white';
      return `<div style="flex-shrink:0;width:68px;scroll-snap-align:start;border-radius:14px;background:${cardBg};border:${border};padding:10px 6px 8px;text-align:center;cursor:${isFut?'default':'pointer'}" ${!isFut ? `onclick="FCApp._showMonthBudgetDetail(${i},${year})"` : ''}>
        <div style="font-size:9px;font-weight:700;color:${isCur?'var(--fc-accent)':'var(--fc-text-faint)'};letter-spacing:0.5px;text-transform:uppercase;margin-bottom:5px">${name}</div>
        <div style="font-size:13px;font-weight:800;color:${amtCol};margin-bottom:5px;letter-spacing:-0.02em">${amtTxt}</div>
        <div class="fcs-bar-track" style="height:3px;margin-bottom:3px">
          <div style="height:100%;width:${isFut?0:pct}%;background:${color};border-radius:99px"></div>
        </div>
        <div style="font-size:9px;font-weight:600;color:${color}">${isFut?'':pct+'%'}</div>
      </div>`;
    }).join('');

    // Scroll to current month card
    requestAnimationFrame(() => {
      const cur = gridEl.children[curMonth];
      if (cur) cur.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: GOALS
     ───────────────────────────────────────────────────────────── */

  function _renderGoals() {
    const container = document.getElementById('goals-list');
    if (!container) return;

    if (!state.goals.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:48px 24px;color:var(--fc-text-faint)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:12px;opacity:0.4">
            <circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>
          </svg>
          <div style="font-size:15px;font-weight:500;color:var(--fc-text-muted);margin-bottom:4px">No goals yet</div>
          <div style="font-size:13px">Tap + below to add your first goal</div>
        </div>`;
    } else {
      container.innerHTML = `
        <svg width="0" height="0" style="position:absolute">
          <defs>
            <linearGradient id="goal-ring-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#1ac4f0"/><stop offset="100%" stop-color="#60a5fa"/>
            </linearGradient>
          </defs>
        </svg>` +
      state.goals.map(g => {
        const pct     = Math.min(g.pct || 0, 100);
        const r       = 27;
        const circ    = 2 * Math.PI * r;
        // W8: ensure minimum visible arc (at least 4% equivalent) when goal is started
        const drawPct = pct > 0 ? Math.max(pct, 4) : 0;
        const offset  = circ * (1 - drawPct / 100);
        const strokeColor = pct >= 100 ? 'var(--fc-success)' : 'url(#goal-ring-grad)';
        const ringGlow    = pct >= 100 ? '0 0 12px rgba(48,209,88,0.5)' : '0 0 12px rgba(26,196,240,0.4)';

        // Smart status: check if behind schedule
        let statusLabel, statusBg, statusBorder, statusText;
        if (pct >= 100) {
          statusLabel = 'COMPLETE'; statusBg = 'rgba(48,209,88,0.12)'; statusBorder = 'rgba(48,209,88,0.3)'; statusText = 'var(--fc-success)';
        } else if (g.target_date) {
          const daysTotal   = Math.max(1, (FCData.parseDateLocal(g.target_date) - new Date()) / 86400000);
          const expectedPct = Math.max(0, Math.min(100, 100 - (daysTotal / 365) * 100));
          const isBehind    = pct < expectedPct - 10; // more than 10% behind schedule
          if (isBehind) {
            statusLabel = 'BEHIND'; statusBg = 'rgba(255,159,10,0.12)'; statusBorder = 'rgba(255,159,10,0.3)'; statusText = 'var(--fc-warning)';
          } else if (pct >= 75) {
            statusLabel = 'ALMOST'; statusBg = 'rgba(26,196,240,0.12)'; statusBorder = 'rgba(26,196,240,0.3)'; statusText = 'var(--fc-accent)';
          } else {
            statusLabel = 'ON TRACK'; statusBg = 'rgba(48,209,88,0.10)'; statusBorder = 'rgba(48,209,88,0.25)'; statusText = 'var(--fc-success)';
          }
        } else {
          // W7: without a target date, "ON TRACK" is meaningless — use "IN PROGRESS" instead
          statusLabel = pct >= 75 ? 'ALMOST' : pct > 0 ? 'IN PROGRESS' : 'NOT STARTED';
          statusBg    = pct >= 75 ? 'rgba(26,196,240,0.12)' : pct > 0 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.06)';
          statusBorder= pct >= 75 ? 'rgba(26,196,240,0.3)' : pct > 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.12)';
          statusText  = pct >= 75 ? 'var(--fc-accent)' : pct > 0 ? 'var(--fc-text-muted)' : 'var(--fc-text-faint)';
        }

        return `
          <div class="fc-goal-card" style="cursor:pointer" onclick="FCApp.editGoal('${esc(g.id)}')" role="button">
            <!-- Circular progress ring -->
            <div style="width:64px;height:64px;position:relative;flex-shrink:0">
              <svg width="64" height="64" viewBox="0 0 64 64" style="transform:rotate(-90deg)" aria-label="${pct}%">
                <circle cx="32" cy="32" r="${r}" stroke="rgba(255,255,255,0.08)" stroke-width="6" fill="none"/>
                <circle cx="32" cy="32" r="${r}" stroke="${strokeColor}" stroke-width="6" fill="none"
                        stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
                        stroke-linecap="round"
                        style="transition:stroke-dashoffset 1s cubic-bezier(0.22,1,0.36,1);filter:drop-shadow(${ringGlow})"/>
              </svg>
              <div style="position:absolute;inset:0;display:grid;place-items:center;font-size:12px;font-weight:800;color:var(--fc-text)">${pct}%</div>
            </div>
            <div class="fc-grow">
              <!-- Status pill -->
              <div style="margin-bottom:5px">
                <span style="display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:${statusBg};border:0.5px solid ${statusBorder};color:${statusText};font-size:9px;font-weight:800;letter-spacing:0.08em">${statusLabel}</span>
              </div>
              <div class="fc-h3" style="font-size:15px;margin-bottom:3px">${esc(g.name)}</div>
              <div class="fc-xs">${FCData.formatCurrency(g.current || 0)} of ${FCData.formatCurrency(g.target)}</div>
              ${(() => {
                if (!g.target_date) return '';
                const remaining = Math.max(0, (g.target || 0) - (g.current || 0));
                const months    = Math.max(1, Math.ceil((FCData.parseDateLocal(g.target_date) - new Date()) / (1000 * 60 * 60 * 24 * 30.44)));
                const monthly   = remaining / months;
                const dateLabel = FCData.parseDateLocal(g.target_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                return `<div style="font-size:11px;color:var(--fc-accent);margin-top:3px">${FCData.formatCurrency(monthly)}/mo · ${dateLabel}</div>`;
              })()}
            </div>
          </div>`;
      }).join('');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: WEALTH TAB (Savings | Goals | Debt)
     ───────────────────────────────────────────────────────────── */

  let _wealthSeg = 'savings';

  function switchWealthSegment(seg) {
    _wealthSeg = seg;
    document.querySelectorAll('.fc-wealth-seg').forEach(btn => {
      btn.classList.toggle('fc-wealth-seg--active', btn.dataset.seg === seg);
    });
    document.querySelectorAll('.fc-wealth-panel').forEach(panel => {
      panel.classList.toggle('fc-wealth-panel--active', panel.id === `wealth-panel-${seg}`);
    });
    haptic('light');
    if (seg === 'savings') _renderSavings();
    if (seg === 'goals')   _renderGoals();
    if (seg === 'debt')    _renderDebt();
  }

  function _renderWealthHero() {
    const accts = state.accounts || [];
    const assets = accts
      .filter(a => a.type === 'depository' || a.type === 'investment' || a.type === 'brokerage')
      .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
    const liabilities = accts
      .filter(a => a.type === 'credit' || a.type === 'loan')
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
        const color = delta >= 0 ? 'rgba(52,199,89,0.15)' : 'rgba(255,69,58,0.12)';
        const textColor = delta >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
        dlEl.innerHTML = `<span>${sign}${FCData.formatCurrency(Math.abs(delta))}</span><span style="font-weight:500;color:var(--fc-text-faint);margin-left:4px">(${delta >= 0 ? '+' : ''}${liabilities > 0 ? Math.round((delta / Math.max(1, Math.abs(prev))) * 100) : 0}%) this month</span>`;
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
        const wCutoffStr = wCutoff.toISOString().split('T')[0];
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
      const strokeColor = isPositive ? '#1ac4f0' : 'var(--fc-danger)';
      line.setAttribute('stroke', strokeColor);
      if (dot) dot.setAttribute('fill', strokeColor);
    })();
  }

  function _renderWealth() {
    _renderWealthHero();
    if (_wealthSeg === 'savings') _renderSavings();
    if (_wealthSeg === 'goals')   _renderGoals();
    if (_wealthSeg === 'debt')    _renderDebt();
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
    if (sub === 'savings')          return '💰';
    if (sub === 'checking')         return '🏦';
    if (sub === 'credit card' || type === 'credit') return '💳';
    if (sub === 'mortgage')         return '🏠';
    if (sub === 'student')          return '🎓';
    if (sub === 'auto')             return '🚗';
    if (type === 'loan')            return '📋';
    if (a.manual)                   return '📝';
    return '🏦';
  }

  function _renderSavings() {
    const allAccts = state.accounts || [];
    const savingsAccts = allAccts.filter(a =>
      a.type === 'depository' || ['savings', 'checking', 'money market', 'cd', 'cash management'].includes((a.subtype || '').toLowerCase())
    );
    const total = savingsAccts.reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);

    const summaryEl = document.getElementById('savings-summary');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="fc-card" style="margin:0 16px 4px;padding:20px;background:linear-gradient(135deg,rgba(26,196,240,0.10),rgba(37,99,235,0.08));display:flex;align-items:center;gap:16px">
          <!-- Money-bag illustration -->
          <div style="width:56px;height:56px;border-radius:18px;background:rgba(26,196,240,0.12);border:0.5px solid rgba(26,196,240,0.22);display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0">💰</div>
          <div style="flex:1;min-width:0">
            <div class="fc-eyebrow" style="margin-bottom:3px">Total Savings</div>
            <div class="fc-amount" style="font-size:32px;font-weight:800;letter-spacing:-0.03em;color:var(--fc-text)">${FCData.formatCurrency(total)}</div>
            <div style="font-size:12px;color:var(--fc-text-faint);margin-top:3px">${savingsAccts.length} account${savingsAccts.length !== 1 ? 's' : ''} connected</div>
          </div>
        </div>`;
    }

    const list = document.getElementById('savings-list');
    if (!list) return;

    if (!savingsAccts.length) {
      list.innerHTML = `
        <div style="text-align:center;padding:48px 24px;color:var(--fc-text-faint)">
          <div style="font-size:40px;margin-bottom:10px">🏦</div>
          <div style="font-size:15px;font-weight:600;color:var(--fc-text-muted);margin-bottom:4px">No savings accounts yet</div>
          <div style="font-size:13px">Connect a bank or add an account manually</div>
        </div>`;
      return;
    }

    // Separate savings vs checking for clearer layout (W4)
    const isSavingsAcct = a => ['savings','money market','cd','cash management'].includes((a.subtype||'').toLowerCase());
    const savingsGroup  = savingsAccts.filter(isSavingsAcct);
    const checkingGroup = savingsAccts.filter(a => !isSavingsAcct(a));

    // Build a map of name → count so we can append mask when names collide (W5)
    const nameCounts = {};
    savingsAccts.forEach(a => { nameCounts[a.name || ''] = (nameCounts[a.name || ''] || 0) + 1; });
    const acctDisplayName = a => {
      const base = a.name || 'Account';
      return (nameCounts[base] > 1 && a.mask) ? `${base} ••${a.mask}` : base;
    };

    const renderAcctRow = (a, isLast) => {
      const bal  = a.balance_current || a.balance || 0;
      const icon = _accountIcon(a);
      const inst = _acctSubtext(a);
      return `<div style="display:flex;align-items:center;gap:13px;padding:14px 16px;${isLast ? '' : 'border-bottom:0.5px solid rgba(255,255,255,0.05)'}">
        <div style="width:38px;height:38px;border-radius:12px;background:rgba(26,196,240,0.10);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600;color:var(--fc-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(acctDisplayName(a))}</div>
          ${inst ? `<div style="font-size:11px;color:var(--fc-text-faint);margin-top:1px">${esc(inst)}</div>` : ''}
        </div>
        <div class="fc-amount" style="font-size:15px;font-weight:700;color:var(--fc-text);font-variant-numeric:tabular-nums;flex-shrink:0">${FCData.formatCurrency(bal)}</div>
      </div>`;
    };

    const renderGroup = (accounts, label) => {
      if (!accounts.length) return '';
      return `
        <div style="font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--fc-text-faint);margin:12px 16px 6px">${label}</div>
        <div class="fc-card" style="margin:0 16px;padding:0;overflow:hidden">
          ${accounts.map((a, i) => renderAcctRow(a, i === accounts.length - 1)).join('')}
        </div>`;
    };

    list.innerHTML = renderGroup(savingsGroup, 'Savings') + renderGroup(checkingGroup, 'Checking');
  }

  function _renderDebt() {
    const allAccts  = state.accounts || [];
    const debtAccts = allAccts.filter(a => {
      const type = (a.type    || '').toLowerCase();
      const sub  = (a.subtype || '').toLowerCase();
      return type === 'credit' || type === 'loan' ||
             ['credit card', 'line of credit', 'mortgage', 'auto', 'student', 'home equity'].includes(sub);
    });

    const totalDebt    = debtAccts.reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
    const creditCards  = debtAccts.filter(a => a.type === 'credit' || ['credit card','line of credit'].includes((a.subtype||'').toLowerCase()));
    const loans        = debtAccts.filter(a => a.type === 'loan' || ['mortgage','auto','student','home equity'].includes((a.subtype||'').toLowerCase()));
    const otherDebt    = debtAccts.filter(a => !creditCards.includes(a) && !loans.includes(a));

    const ccTotal      = creditCards.reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
    const loansTotal   = loans.reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);
    const otherTotal   = otherDebt.reduce((s, a) => s + Math.max(0, a.balance_current || a.balance || 0), 0);

    const totalLimit  = creditCards.reduce((s, a) => s + (a.balance_limit || a.balances?.limit || 0), 0);
    const utilPct     = totalLimit > 0 ? Math.round((ccTotal / totalLimit) * 100) : 0;

    const summaryEl = document.getElementById('debt-summary');
    if (summaryEl && totalDebt > 0) {
      // Donut chart data
      const segments = [
        { label: 'Credit Cards', value: ccTotal,    color: '#ff453a' },
        { label: 'Loans',        value: loansTotal,  color: '#ff9f0a' },
        { label: 'Other',        value: otherTotal,  color: '#636366' },
      ].filter(s => s.value > 0);

      // Build SVG donut
      let donutSvg = '';
      if (segments.length > 0) {
        const R = 42, r = 26, cx = 52, cy = 52;
        const circ = 2 * Math.PI * R;
        let cumAngle = -90; // start at top
        const arcs = segments.map(seg => {
          const pct    = totalDebt > 0 ? seg.value / totalDebt : 0;
          const angle  = pct * 360;
          const startA = (cumAngle * Math.PI) / 180;
          const endA   = ((cumAngle + angle) * Math.PI) / 180;
          const x1 = cx + R * Math.cos(startA), y1 = cy + R * Math.sin(startA);
          const x2 = cx + R * Math.cos(endA),   y2 = cy + R * Math.sin(endA);
          const large = angle > 180 ? 1 : 0;
          // Inner arc (reversed)
          const ix1 = cx + r * Math.cos(endA),  iy1 = cy + r * Math.sin(endA);
          const ix2 = cx + r * Math.cos(startA), iy2 = cy + r * Math.sin(startA);
          const path = `M${x1.toFixed(1)},${y1.toFixed(1)} A${R},${R} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} L${ix1.toFixed(1)},${iy1.toFixed(1)} A${r},${r} 0 ${large},0 ${ix2.toFixed(1)},${iy2.toFixed(1)} Z`;
          cumAngle += angle;
          return `<path d="${path}" fill="${seg.color}" opacity="0.88"/>`;
        });
        donutSvg = `
          <svg viewBox="0 0 104 104" width="104" height="104" style="flex-shrink:0" aria-hidden="true">
            ${arcs.join('')}
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--fc-bg-elevated,#0b1826)"/>
            <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="white" font-size="11" font-weight="800" font-family="inherit">${segments.length > 0 ? '−' : ''}${totalDebt >= 1000 ? `$${(totalDebt/1000).toFixed(0)}K` : `$${Math.round(totalDebt)}`}</text>
            <text x="${cx}" y="${cy + 9}" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="8" font-family="inherit">total</text>
          </svg>`;
      }

      const utilColor = utilPct > 30 ? 'var(--fc-danger)' : utilPct > 10 ? 'var(--fc-warning)' : 'var(--fc-success)';
      summaryEl.innerHTML = `
        <div class="fc-card" style="margin:0 16px 4px;padding:18px;background:linear-gradient(135deg,rgba(255,69,58,0.08),rgba(37,99,235,0.06))">
          <div style="display:flex;align-items:center;gap:16px">
            ${donutSvg}
            <div style="flex:1;min-width:0">
              <div class="fc-eyebrow" style="margin-bottom:4px">Total Debt</div>
              <div class="fc-amount" style="font-size:28px;font-weight:800;letter-spacing:-0.03em;color:var(--fc-danger)">−${FCData.formatCurrency(totalDebt)}</div>
              <!-- Legend -->
              <div style="margin-top:10px;display:flex;flex-direction:column;gap:4px">
                ${segments.map(s => `
                  <div style="display:flex;align-items:center;gap:6px">
                    <div style="width:8px;height:8px;border-radius:2px;background:${s.color};flex-shrink:0"></div>
                    <span style="font-size:11px;color:var(--fc-text-faint);flex:1">${s.label}</span>
                    <span class="fc-amount" style="font-size:11px;font-weight:700;color:var(--fc-text)">${FCData.formatCurrency(s.value)}</span>
                  </div>`).join('')}
              </div>
            </div>
          </div>
          ${totalLimit > 0 ? `
          <div style="margin-top:14px;padding-top:12px;border-top:0.5px solid rgba(255,255,255,0.07)">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--fc-text-faint);margin-bottom:5px">
              <span>Credit Utilization</span>
              <span style="color:${utilColor};font-weight:600">${utilPct}%</span>
            </div>
            <div class="fc-util-bar"><div class="fc-util-fill" style="width:${Math.min(utilPct, 100)}%;background:${utilColor}"></div></div>
            <div style="font-size:11px;color:var(--fc-text-faint);margin-top:5px">Keep below 30% for a healthy credit score</div>
          </div>` : ''}
        </div>`;
    } else if (summaryEl) {
      summaryEl.innerHTML = '';
    }

    const list = document.getElementById('debt-list');
    if (!list) return;

    if (!debtAccts.length) {
      list.innerHTML = `
        <div style="text-align:center;padding:48px 24px;color:var(--fc-text-faint)">
          <div style="font-size:40px;margin-bottom:10px">💳</div>
          <div style="font-size:15px;font-weight:600;color:var(--fc-text-muted);margin-bottom:4px">No debts tracked</div>
          <div style="font-size:13px">Connect a credit card or loan to see it here</div>
        </div>`;
      return;
    }

    list.innerHTML = debtAccts.map(a => {
      const bal   = Math.abs(a.balance_current || a.balance || 0);
      const limit = a.balance_limit || a.balances?.limit || 0;
      const util  = limit > 0 ? Math.round((bal / limit) * 100) : null;
      const uColor = util !== null ? (util > 30 ? 'var(--fc-danger)' : util > 10 ? 'var(--fc-warning)' : 'var(--fc-success)') : '';
      const icon  = _accountIcon(a);
      const inst  = _cleanInstitutionName(a.institution_name || a.official_name || '') || (a.manual ? 'Manual entry' : '');
      // Humanize raw Plaid account names for loans (e.g. "DEALER-UB" → "Auto Loan")
      const sub = (a.subtype || '').toLowerCase();
      const rawName = (a.name || '').toLowerCase();
      const displayName = (sub === 'auto' || rawName.includes('dealer') || rawName.includes('auto'))
        ? 'Auto Loan'
        : (sub === 'student' ? 'Student Loan' : (sub === 'mortgage' ? 'Mortgage' : (a.name || 'Account')));
      return `<div class="fc-acct-card">
        <div class="fc-acct-icon">${icon}</div>
        <div class="fc-acct-info">
          <div class="fc-acct-name">${esc(displayName)}</div>
          ${inst ? `<div class="fc-acct-bank">${esc(inst)}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="fc-acct-bal fc-amount" style="color:var(--fc-danger)">−${FCData.formatCurrency(bal)}</div>
          ${util !== null ? `<div style="font-size:10px;color:${uColor};margin-top:2px">${util}% used</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  /* ─────────────────────────────────────────────────────────────
     V3 RENDER FUNCTIONS
     ───────────────────────────────────────────────────────────── */

  function _renderDailyBrief() {
    const el     = document.getElementById('home-daily-brief');
    const textEl = document.getElementById('home-brief-text');
    if (!el || !textEl) return;

    const txns     = state.transactions || [];
    const accounts = state.accounts    || [];
    const bills    = state.bills       || [];

    if (!accounts.length && !txns.length) { el.style.display = 'none'; return; }

    const today = new Date(); today.setHours(0,0,0,0);
    const dayName = today.toLocaleDateString('en-US', { weekday: 'long' });

    const todayTxns  = txns.filter(t => t.date && FCData.parseDateLocal(t.date).getTime() >= today.getTime() && _isSpendTxn(t));
    const todaySpend = todayTxns.reduce((s, t) => s + (t.amount || 0), 0);
    const biggestToday = todayTxns.sort((a, b) => b.amount - a.amount)[0];

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthSpend = txns
      .filter(t => t.date && FCData.parseDateLocal(t.date) >= monthStart && _isSpendTxn(t))
      .reduce((s, t) => s + (t.amount || 0), 0);

    const nextBill = bills
      .filter(b => b.status !== 'paid' && FCData.daysUntil(b.due_date) !== null && FCData.daysUntil(b.due_date) >= 0)
      .sort((a, b) => FCData.daysUntil(a.due_date) - FCData.daysUntil(b.due_date))[0];

    let brief = '';
    if (todaySpend > 0 && biggestToday) {
      brief = `Happy ${dayName}. You've spent ${FCData.formatCurrency(todaySpend)} today — ${esc(_cleanTxnName(biggestToday.name))} was your biggest charge (${FCData.formatCurrency(biggestToday.amount)}).`;
    } else {
      brief = `Happy ${dayName}. No spending recorded yet today.`;
    }

    if (nextBill) {
      const days = FCData.daysUntil(nextBill.due_date);
      if (days === 0)      brief += ` ${esc(nextBill.name)} (${FCData.formatCurrency(nextBill.amount)}) is due today.`;
      else if (days === 1) brief += ` ${esc(nextBill.name)} (${FCData.formatCurrency(nextBill.amount)}) is due tomorrow.`;
      else if (days <= 7)  brief += ` ${esc(nextBill.name)} (${FCData.formatCurrency(nextBill.amount)}) is due in ${days} days.`;
    }

    if (monthSpend > 0) brief += ` You're at ${FCData.formatCurrency(monthSpend)} spent this month.`;

    textEl.textContent = brief;
    el.style.display = '';
  }

  function _renderPriorityActions() {
    const el     = document.getElementById('home-priority-actions');
    const listEl = document.getElementById('home-actions-list');
    if (!el || !listEl) return;

    const bills    = state.bills    || [];
    const accounts = state.accounts || [];
    const actions  = [];

    bills.filter(b => {
      const d = FCData.daysUntil(b.due_date);
      return d !== null && d < 0 && b.status !== 'paid';
    }).forEach(b => actions.push({ priority: 'high', icon: '🔴', title: `${b.name} payment overdue`, sub: FCData.formatCurrency(b.amount) + ' past due' }));

    bills.filter(b => FCData.daysUntil(b.due_date) === 0 && b.status !== 'paid')
      .forEach(b => actions.push({ priority: 'high', icon: '⚠️', title: `${b.name} due today`, sub: FCData.formatCurrency(b.amount) }));

    bills.filter(b => { const d = FCData.daysUntil(b.due_date); return d !== null && d > 0 && d <= 3 && b.status !== 'paid'; })
      .forEach(b => {
        const d = FCData.daysUntil(b.due_date);
        actions.push({ priority: 'medium', icon: '📅', title: `${b.name} due in ${d} day${d !== 1 ? 's' : ''}`, sub: FCData.formatCurrency(b.amount) });
      });

    if (accounts.length === 0 && !state.user?.plaid_linked) {
      actions.push({ priority: 'medium', icon: '🏦', title: 'Connect your bank account', sub: 'See your spending and net worth' });
    }

    if (!actions.length) { el.style.display = 'none'; return; }

    const bgMap     = { high: 'rgba(255,69,58,0.08)',   medium: 'rgba(255,159,10,0.08)'  };
    const borderMap = { high: 'rgba(255,69,58,0.20)',   medium: 'rgba(255,159,10,0.20)'  };
    const dotMap    = { high: 'var(--fc-danger)',        medium: 'var(--fc-warning)'      };

    listEl.innerHTML = actions.slice(0, 3).map(a => `
      <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:14px;
                  background:${bgMap[a.priority]};border:0.5px solid ${borderMap[a.priority]};cursor:pointer"
           role="button" onclick="FCApp.switchTab('activity')">
        <div style="font-size:16px;flex-shrink:0">${a.icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--fc-text)">${esc(a.title)}</div>
          <div style="font-size:11px;color:var(--fc-text-muted);margin-top:1px">${esc(a.sub)}</div>
        </div>
        <div style="width:6px;height:6px;border-radius:3px;background:${dotMap[a.priority]};flex-shrink:0"></div>
      </div>`).join('');

    el.style.display = '';
  }

  function _renderCashRunway() {
    const el = document.getElementById('home-cash-runway');
    if (!el) return;

    const accounts = state.accounts     || [];
    const txns     = state.transactions || [];
    if (!accounts.length || !txns.length) { el.style.display = 'none'; return; }

    const cash = FCData.calcCash(accounts);
    if (cash <= 0) { el.style.display = 'none'; return; }

    const cutoff     = new Date(Date.now() - 30 * 86400000);
    const recent30   = txns.filter(t => _isSpendTxn(t) && FCData.parseDateLocal(t.date) >= cutoff);
    const dailySpend = recent30.reduce((s, t) => s + (t.amount || 0), 0) / 30;
    if (dailySpend <= 0) { el.style.display = 'none'; return; }

    const days   = Math.round(cash / dailySpend);
    const daysEl = document.getElementById('home-runway-days');
    const subEl  = document.getElementById('home-runway-sub');
    const barEl  = document.getElementById('home-runway-bar');

    if (daysEl) daysEl.textContent = days + (days === 1 ? ' day' : ' days');
    if (subEl)  subEl.textContent  = `${FCData.formatCurrency(cash)} cash · ${FCData.formatCurrency(dailySpend)}/day avg (last 30 days)`;

    const pct = Math.min(100, Math.round((days / 90) * 100));
    if (barEl) {
      barEl.style.width      = pct + '%';
      barEl.style.background = days < 14
        ? 'var(--fc-danger)'
        : days < 30
        ? 'var(--fc-warning)'
        : 'linear-gradient(90deg,var(--fc-electric),var(--fc-accent))';
    }

    el.style.display = '';
  }

  function _renderTimeline() {
    const el     = document.getElementById('home-timeline');
    const listEl = document.getElementById('home-timeline-list');
    if (!el || !listEl) return;

    const bills = state.bills || [];
    const items = bills
      .filter(b => { const d = FCData.daysUntil(b.due_date); return d !== null && d >= 0 && d <= 14 && b.status !== 'paid'; })
      .map(b => ({ days: FCData.daysUntil(b.due_date), icon: b.icon || '💳', label: b.name, amount: b.amount,
                   color: FCData.daysUntil(b.due_date) <= 1 ? 'var(--fc-danger)' : FCData.daysUntil(b.due_date) <= 3 ? 'var(--fc-warning)' : 'var(--fc-text-muted)' }))
      .sort((a, b) => a.days - b.days)
      .slice(0, 5);

    if (!items.length) { el.style.display = 'none'; return; }

    const dayLabel = d => d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days`;

    listEl.innerHTML = items.map((item, i) => `
      <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;${i > 0 ? 'border-top:0.5px solid var(--fc-border)' : ''}">
        <div style="width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">${item.icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--fc-text)">${esc(item.label)}</div>
          <div style="font-size:11px;color:${item.color};margin-top:1px;font-weight:${item.days <= 1 ? 600 : 400}">${dayLabel(item.days)}</div>
        </div>
        <div style="font-size:14px;font-weight:700;color:var(--fc-danger);font-variant-numeric:tabular-nums;flex-shrink:0">−${FCData.formatCurrency(item.amount)}</div>
      </div>`).join('');

    el.style.display = '';
  }

  function _renderSpendingTrends() {
    const el = document.getElementById('act-spending-trends');
    if (!el) return;

    const txns = state.transactions || [];
    if (!txns.length) { el.style.display = 'none'; return; }

    const now = new Date(); now.setHours(0,0,0,0);
    const weeks = Array.from({ length: 6 }, (_, i) => {
      const w     = 5 - i;
      const start = new Date(now.getTime() - (w + 1) * 7 * 86400000);
      const end   = new Date(now.getTime() - w * 7 * 86400000);
      const total = txns
        .filter(t => { if (!_isSpendTxn(t)) return false; const d = FCData.parseDateLocal(t.date); return d >= start && d < end; })
        .reduce((s, t) => s + (t.amount || 0), 0);
      return { label: start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), total };
    });

    const max = Math.max(...weeks.map(w => w.total), 1);
    const thisWeek = weeks[weeks.length - 1]?.total || 0;

    const totalEl  = document.getElementById('act-trends-total');
    const barsEl   = document.getElementById('act-trends-bars');
    const labelsEl = document.getElementById('act-trends-labels');

    if (totalEl) totalEl.textContent = FCData.formatCurrency(thisWeek) + ' this week';

    if (barsEl) {
      barsEl.innerHTML = weeks.map((w, i) => {
        const pct    = Math.max(8, (w.total / max) * 100);
        const isLast = i === weeks.length - 1;
        return `<div style="flex:1;height:100%;display:flex;align-items:flex-end">
          <div style="width:100%;height:${pct.toFixed(0)}%;border-radius:4px 4px 0 0;
               background:${isLast ? 'var(--fc-accent)' : 'rgba(255,255,255,0.14)'};
               transition:height .6s var(--fc-ease-out)"></div>
        </div>`;
      }).join('');
    }

    if (labelsEl) {
      labelsEl.innerHTML = weeks.map((w, i) => {
        const isLast = i === weeks.length - 1;
        return `<div style="flex:1;text-align:center;font-size:8px;color:${isLast ? 'var(--fc-accent)' : 'var(--fc-text-faint)'};font-weight:${isLast ? 700 : 400}">
          ${isLast ? 'Now' : w.label.split(' ')[1]}
        </div>`;
      }).join('');
    }

    el.style.display = '';
  }

  function _renderRecurringBanner() {
    const el = document.getElementById('act-recurring-banner');
    if (!el) return;

    const subs = _detectSubscriptions(state.transactions || []);
    if (!subs || !subs.length) { el.style.display = 'none'; return; }

    const total    = subs.reduce((s, sub) => s + (sub.amount || 0), 0);
    const titleEl  = document.getElementById('act-recurring-title');
    const subEl    = document.getElementById('act-recurring-sub');

    if (titleEl) titleEl.textContent = `${subs.length} recurring charge${subs.length !== 1 ? 's' : ''} detected`;
    if (subEl)   subEl.textContent   = `${FCData.formatCurrency(total)}/mo · Tap to review in Bills`;

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
    const thisIncome = thisTxns.filter(_isIncomeTxn).reduce((s, t) => s + t.amount, 0);
    const lastIncome = lastTxns.filter(_isIncomeTxn).reduce((s, t) => s + t.amount, 0);

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
      return `<div style="margin-top:4px"><span style="font-size:10px;color:${color};font-weight:700">${arrow}${Math.abs(d)}%</span> <span style="font-size:9px;color:var(--fc-text-faint)">vs last mo</span></div>`;
    };

    el.innerHTML = `
      <div style="padding:16px;border-radius:18px;background:rgba(255,255,255,0.04);border:0.5px solid rgba(255,255,255,0.08);margin:0 16px 10px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:var(--fc-text-faint);margin-bottom:12px">Monthly Intelligence</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          ${metrics.map(m => `
            <div style="padding:12px;border-radius:14px;background:rgba(255,255,255,0.03);border:0.5px solid rgba(255,255,255,0.06)">
              <div style="font-size:11px;color:var(--fc-text-faint);margin-bottom:4px">${m.icon} ${m.label}</div>
              <div style="font-size:17px;font-weight:800;color:var(--fc-text);font-variant-numeric:tabular-nums;letter-spacing:-0.03em">${m.value}</div>
              ${deltaHtml(m.delta, m.invert)}
            </div>`).join('')}
        </div>
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
      <div style="padding:16px;border-radius:18px;background:rgba(255,255,255,0.04);border:0.5px solid rgba(255,255,255,0.08);margin:0 16px 10px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:var(--fc-text-faint);margin-bottom:12px">Behavior Analysis</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${insights.map(ins => `
            <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,0.03)">
              <span style="font-size:15px;flex-shrink:0">${ins.icon}</span>
              <span style="font-size:13px;color:var(--fc-text-muted)">${esc(ins.text)}</span>
            </div>`).join('')}
        </div>
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
      <div style="padding:16px;border-radius:18px;background:rgba(48,209,88,0.07);border:0.5px solid rgba(48,209,88,0.22);margin:0 16px 10px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:var(--fc-success);margin-bottom:12px">Wins</div>
        <div style="display:flex;flex-direction:column;gap:7px">
          ${wins.map(w => `
            <div style="display:flex;align-items:center;gap:10px">
              <span style="font-size:15px;flex-shrink:0">${w.icon}</span>
              <span style="font-size:13px;color:var(--fc-text)">${esc(w.text)}</span>
            </div>`).join('')}
        </div>
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
      recs.push({ icon: '🎯', title: 'Set a savings goal', detail: 'Users with goals save 34% more on average. Add one on the Wealth tab.' });
    }

    const urgentBills = bills.filter(b => { const d = FCData.daysUntil(b.due_date); return d !== null && d <= 7 && b.status !== 'paid'; });
    if (urgentBills.length) {
      const urgTotal = urgentBills.reduce((s, b) => s + b.amount, 0);
      recs.push({ icon: '📆', title: `${urgentBills.length} bill${urgentBills.length !== 1 ? 's' : ''} due this week`, detail: `${FCData.formatCurrency(urgTotal)} in upcoming payments — make sure funds are ready.` });
    }

    if (!recs.length) { el.style.display = 'none'; return; }

    el.innerHTML = `
      <div style="padding:16px;border-radius:18px;background:rgba(255,255,255,0.04);border:0.5px solid rgba(255,255,255,0.08);margin:0 16px 10px">
        <div style="font-size:10px;font-weight:700;letter-spacing:.10em;text-transform:uppercase;color:var(--fc-text-faint);margin-bottom:12px">Recommendations</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${recs.map((r, i) => `
            <div style="display:flex;align-items:flex-start;gap:10px;padding:12px;border-radius:14px;background:rgba(255,255,255,0.03);border:0.5px solid rgba(255,255,255,0.06)">
              <div style="width:28px;height:28px;border-radius:8px;background:rgba(26,196,240,0.12);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">${r.icon}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;color:var(--fc-text);margin-bottom:3px">${esc(r.title)}</div>
                <div style="font-size:11px;color:var(--fc-text-muted);line-height:1.45">${esc(r.detail)}</div>
              </div>
              <div style="font-size:9px;font-weight:700;background:rgba(26,196,240,0.12);color:var(--fc-accent);padding:3px 7px;border-radius:6px;flex-shrink:0">#${i + 1}</div>
            </div>`).join('')}
        </div>
      </div>`;
    el.style.display = '';
  }

  /* Helper called by CTA button after paywall success */
  function renderHomeAfterPro() {
    _refreshAfterPro();
    setTimeout(() => _tryStartTour(), 1200);
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

    // Appearance picker — highlight saved preference
    if (window._FCSetAppearance && window._FCGetAppearance) {
      window._FCSetAppearance(window._FCGetAppearance());
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
      proBadge.textContent = isPro ? 'Pro ✓' : 'Free';
      proBadge.style.cssText = isPro
        ? 'font-size:10px;padding:4px 10px;background:rgba(26,196,240,0.15);color:var(--fc-accent);border:0.5px solid rgba(26,196,240,0.25);border-radius:999px'
        : 'font-size:10px;padding:4px 10px;background:rgba(255,159,10,0.12);color:var(--fc-warning);border:0.5px solid rgba(255,159,10,0.25);border-radius:999px';
    }

    // Pro row — show status + cancel option for Pro users
    const proRow  = document.getElementById('settings-pro-row');
    const proPill = document.getElementById('settings-pro-pill');
    if (proPill) {
      proPill.textContent = isPro ? 'Manage' : 'Upgrade →';
      proPill.style.cssText = isPro
        ? 'font-size:10px;padding:3px 8px;background:rgba(26,196,240,0.12);color:var(--fc-accent);border-radius:999px'
        : 'font-size:10px;padding:3px 8px;background:rgba(255,159,10,0.12);color:var(--fc-warning);border-radius:999px';
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

  async function _doSync(showToast = false) {
    // Safety: auto-clear stuck syncing flag after 30s so button never stays locked
    if (state.syncing) {
      if (state._syncStartedAt && (Date.now() - state._syncStartedAt) > 30000) {
        state.syncing = false;
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
    const timeSinceLast = state.lastSyncAt ? Date.now() - state.lastSyncAt : Infinity;
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
      state.lastSyncAt = Date.now();
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
      if (islandText) {
        islandText.classList.add('fc-fade');
        setTimeout(() => {
          // Background syncs fail silently — keep island neutral
          // User-initiated syncs show "Sync failed" briefly
          islandText.textContent = showToast ? 'Sync failed' : _idleText();
          _lastSyncFailed = true;
          islandText.classList.remove('fc-fade');
        }, 200);
      }
      // Only surface error toast for user-initiated syncs.
      // Background syncs (app launch, screen focus) fail silently so the
      // user isn't greeted by a red banner every time Railway cold-starts.
      if (showToast) toast('Sync failed — check connection', 'error');
    } finally {
      state.syncing = false;
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
      setTimeout(() => {
        FCPush.requestAndRegister().catch(() => {});
        FCPush.requestLocalPermission().catch(() => {});
      }, 1200);
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

  async function handleGoogleSignIn() {
    // Disable all Google buttons to prevent double-tap
    ['btn-login-google','btn-register-google'].forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.disabled = true; b.textContent = 'Signing in…'; }
    });
    _clearError('login-error');
    _clearError('register-error');
    try {
      window._fcNewUserFaceIdPending = true;
      await FCAuth.signInWithGoogle();
      if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('login_success', { method: 'google' });
    } catch (err) {
      window._fcNewUserFaceIdPending = false;
      const msg = _friendlyAuthError(err);
      _showError('login-error', msg);
      _showError('register-error', msg);
      haptic('heavy');
    } finally {
      ['btn-login-google','btn-register-google'].forEach(id => {
        const b = document.getElementById(id);
        if (b) { b.disabled = false; b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> Continue with Google'; }
      });
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
        // Focus the email field
        setTimeout(() => {
          const emailEl = document.getElementById('login-email');
          if (emailEl) emailEl.focus();
        }, 150);
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
        document.getElementById('reg-name')?.focus();
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
    // Focus email input after transition
    setTimeout(() => {
      const fpInput = document.getElementById('fp-email');
      if (fpInput && !fpInput.value) fpInput.focus();
    }, 400);
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
      if (emailEl) emailEl.focus();
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
   * Saves biometric preference, then routes to the notification
   * permission screen (new users only) before onboarding.
   */
  async function handleBiometricSetup() {
    haptic('medium');
    try {
      if (FCAuth.setBiometricEnabled) await FCAuth.setBiometricEnabled(true);
    } catch (_) {
      // Biometrics unavailable on this device — silently skip
    }
    setScreen('notif-permission');
  }

  /** User tapped "Not now" on the Face ID setup screen. */
  function skipFaceIdSetup() {
    try {
      if (FCAuth.setBiometricEnabled) FCAuth.setBiometricEnabled(false).catch(() => {});
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
    if (_isPro()) { obNext(); return; }   // already Pro — skip to bank slide
    _selectedPlan = 'monthly';
    showPaywall();
  }

  /**
   * Demo mode — for App Review testers who cannot connect a real bank.
   * Populates state with realistic sample data so all app features are visible.
   */
  async function startDemoMode() {
    haptic('medium');
    _isDemoMode = true;
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
      { account_id: 'demo-cc',  name: 'Demo Visa',     official_name: 'Demo Visa Card',        type: 'credit',     subtype: 'credit card', balance_current: 723.55, balance_available: null, mask: '1111', institution_name: 'Demo Bank' },
    ];
    state.transactions = [
      { transaction_id: 't1', name: 'Whole Foods Market', amount: 87.43,   date: '2026-06-08', category: ['Food and Drink', 'Groceries'],        account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't2', name: 'Netflix',            amount: 15.99,   date: '2026-06-07', category: ['Service', 'Subscription'],             account_id: 'demo-cc',  isCredit: false },
      { transaction_id: 't3', name: 'Uber',               amount: 23.50,   date: '2026-06-06', category: ['Travel', 'Ride Share'],                account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't4', name: 'Spotify',            amount: 9.99,    date: '2026-06-05', category: ['Service', 'Subscription'],             account_id: 'demo-cc',  isCredit: false },
      { transaction_id: 't5', name: 'Starbucks',          amount: 6.75,    date: '2026-06-05', category: ['Food and Drink', 'Coffee Shop'],       account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't6', name: 'Amazon',             amount: 134.99,  date: '2026-06-04', category: ['Shops', 'Online Marketplaces'],        account_id: 'demo-cc',  isCredit: false },
      { transaction_id: 't7', name: 'Shell Gas Station',  amount: 58.20,   date: '2026-06-03', category: ['Travel', 'Gas Stations'],              account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't8', name: 'Chipotle',           amount: 14.35,   date: '2026-06-02', category: ['Food and Drink', 'Restaurants'],       account_id: 'demo-chk', isCredit: false },
      { transaction_id: 't9', name: 'Direct Deposit',     amount: -3200.00, date: '2026-06-01', category: ['Transfer', 'Payroll'],                 account_id: 'demo-chk', isCredit: true  },
    ];
    state.bills = [];

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
    if (focusFirst && boxes[0]) boxes[0].focus();
  }

  /** Auto-advance to next box on digit entry, mark filled */
  function otpBoxInput(el) {
    const val = el.value.replace(/\D/g, '');
    el.value = val ? val[val.length - 1] : '';
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
      console.error('[toggleBiometric]', err.message);
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
      if (state.tab === 'home') _renderHome();
      if (state.tab === 'insights') _renderInsights();
      // Snapshot net worth on every account update (daily dedup inside)
      _snapshotNetWorth(FCData.calcNetWorth(accounts));
    });

    FCData.listenToTransactions(500, transactions => {
      if (_isDemoMode) return;
      state.initialLoading = false;
      state.transactions = transactions;
      // Re-render home so "Recent Activity" and "Safe to Spend" update immediately
      if (state.tab === 'home')     _renderHome();
      if (state.tab === 'activity') _renderActivity();
      if (state.tab === 'insights') _renderInsights();
      // Check budget thresholds whenever transactions update
      _checkBudgetAlert();
    });

    FCData.listenToBills(bills => {
      if (_isDemoMode) return;
      state.bills = bills;
      if (state.tab === 'home') _renderHome();
      if (state.tab === 'activity' && _activitySegment === 'bills') _renderBillsList();
      FCPush.scheduleAllBillReminders(bills).catch(() => {});
    });

    FCData.listenToGoals(goals => {
      state.goals = goals;
      if (state.tab === 'goals' || (state.tab === 'wealth' && _wealthSeg === 'goals')) _renderGoals();
    });

    FCData.listenToBudgets(budgets => {
      state.budgets = budgets;
      if (state.tab === 'insights') _renderInsights();
    });

    // Notification center listener
    FCData.listenToNotifications(notifs => {
      state.notifications = notifs;
      _updateNotifBadge(notifs);
    });

    // Transaction overrides (user edits to names/categories)
    FCData.listenToTransactionOverrides(overrides => {
      state.txnOverrides = overrides;
      if (state.tab === 'activity') _renderActivity();
      if (state.tab === 'insights') _renderInsights();
    });

    // Credit score history (monthly snapshots for sparkline)
    FCData.listenToCreditHistory(history => {
      state.creditHistory = history;
      if (state.tab === 'home') _renderCreditScore();
    });

    // Net worth history (daily snapshots — Firestore-backed for cross-device persistence)
    FCData.listenToNetWorthHistory(history => {
      state.nwHistory = history;
      // Re-draw sparkline with the authoritative Firestore data
      _drawNetWorthSparkline(history);
      if (state.tab === 'insights') _renderInsights();
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

    // ── Keyboard scroll-to-input (Capacitor Keyboard plugin) ─────
    // On notched iPhones the keyboard can cover the focused input.
    // scrollIntoView centers it above the keyboard automatically.
    const _kbPlugin = window.Capacitor?.Plugins?.Keyboard;
    if (_kbPlugin?.addListener) {
      _kbPlugin.addListener('keyboardWillShow', () => {
        setTimeout(() => {
          document.activeElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
      });
    }

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
            setScreen('app');
            _renderHome();
          } else if (window._fcNewUserFaceIdPending) {
            // Brand new signup, Firestore just hasn't written the doc yet
            window._fcNewUserFaceIdPending = false;
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
              if (_shouldShowPaywall(user.uid)) setTimeout(() => showPaywall(), 1200);
            } else {
              // RC and Firestore both say not Pro
              if (_shouldShowPaywall(user.uid)) setTimeout(() => showPaywall(), 1200);
            }
          }).catch(() => {
            // RC unavailable — trust Firestore, show paywall only for free users
            if (!userDoc?.is_pro) {
              if (_shouldShowPaywall(user.uid)) setTimeout(() => showPaywall(), 1200);
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
  function manualSync() {
    _doSync(true); // user-initiated — show toast
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
    const markAllBtn = document.getElementById('notif-mark-all-btn');
    const unread     = (notifs || []).filter(n => !n.read).length;
    if (badge) {
      // Show as a plain dot — no number, less aggressive than a red badge count
      badge.textContent = '';
      badge.style.display = unread > 0 ? 'flex' : 'none';
    }
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
        bill_due:       { icon: '💳', bg: 'rgba(255,69,58,0.14)',   border: 'rgba(255,69,58,0.25)'   },
        budget_alert:   { icon: '⚡', bg: 'rgba(255,159,10,0.14)',  border: 'rgba(255,159,10,0.25)'  },
        goal_reached:   { icon: '🎯', bg: 'rgba(52,199,89,0.14)',   border: 'rgba(52,199,89,0.25)'   },
        sync_done:      { icon: '✓',  bg: 'rgba(26,196,240,0.12)',  border: 'rgba(26,196,240,0.22)'  },
        payday:         { icon: '🎉', bg: 'rgba(52,199,89,0.14)',   border: 'rgba(52,199,89,0.25)'   },
        large_txn:      { icon: '💸', bg: 'rgba(255,159,10,0.14)',  border: 'rgba(255,159,10,0.25)'  },
        low_balance:    { icon: '⚠️', bg: 'rgba(255,69,58,0.14)',   border: 'rgba(255,69,58,0.25)'   },
        unusual_spend:  { icon: '📊', bg: 'rgba(255,159,10,0.14)',  border: 'rgba(255,159,10,0.25)'  },
        new_sub:        { icon: '🔄', bg: 'rgba(26,196,240,0.12)',  border: 'rgba(26,196,240,0.22)'  },
        general:        { icon: '🔔', bg: 'rgba(255,255,255,0.07)', border: 'rgba(255,255,255,0.10)' },
      };
      return map[type] || map.general;
    };

    // N3: Filter out bill_due notifications whose due date has already passed
    const todayStr = new Date().toISOString().split('T')[0];
    const active = notifs.filter(n => {
      if (n.type === 'bill_due' && n.data?.due_date && n.data.due_date < todayStr) return false;
      return true;
    });

    // Deduplicate: show only the most recent notification per type per day.
    // Prevents budget alert spam when backend sends the same alert multiple times.
    const seen = new Set();
    const deduped = active.filter(n => {
      const ts = n.created_at ? (n.created_at.toDate ? n.created_at.toDate() : new Date(n.created_at)) : new Date();
      const dayKey = `${n.type || 'general'}_${ts.toISOString().split('T')[0]}`;
      if (seen.has(dayKey)) return false;
      seen.add(dayKey);
      return true;
    });

    listEl.innerHTML = deduped.map(n => {
      const meta = _typeIcon(n.type);
      return `
      <div onclick="FCApp._notifTap('${esc(n.id)}','${esc(n.type || 'general')}')"
           style="display:flex;align-items:flex-start;gap:13px;padding:14px 20px;cursor:pointer;
                  border-bottom:0.5px solid rgba(255,255,255,0.045);
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
      console.error('[notif] markAllRead failed:', err);
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
              onclick="FCApp.confirmDisconnectItem('','${legacyName}')"
              type="button">
              Disconnect
            </button>
          </div>`;
        return;
      }

      if (!items.length) {
        listEl.innerHTML = '<div style="color:var(--fc-text-faint);font-size:13px;padding:10px 0">No banks connected</div>';
        return;
      }

      listEl.innerHTML = items.map(item => {
        const name   = esc(item.institution || 'Bank Account');
        const itemId = esc(item.item_id || item.id || '');
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
              onclick="FCApp.confirmDisconnectItem(${JSON.stringify(itemId)},${JSON.stringify(name)})"
              type="button">
              Disconnect
            </button>
          </div>`;
      }).join('');
    } catch (err) {
      console.error('[showBankSheet]', err);
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

      // Close all sheets
      document.querySelectorAll('.fc-sheet-overlay').forEach(s => { s.style.display = 'none'; });
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
      document.querySelectorAll('.fc-sheet-overlay').forEach(s => { s.style.display = 'none'; });
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
          try {
            Object.keys(localStorage).filter(k => k.startsWith('fc_'))
              .forEach(k => localStorage.removeItem(k));
          } catch (_) {}
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
  // Accounts that skip OTP and Plaid — used by App Review testers
  const _DEMO_EMAILS = ['reviewer@flowcheck.app'];
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

  async function showPaywall() {
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

  /** Dismiss the paywall and return to the dashboard. */
  function closePaywall() {
    // Reset success overlay so it doesn't bleed on next open
    const successOverlay = document.getElementById('pw-success-overlay');
    if (successOverlay) successOverlay.classList.remove('visible');
    setScreen('app');
    _renderHome();
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
          const monthlyEq = rawAnnual ? `$${(rawAnnual / 12).toFixed(2)}/mo &nbsp;<span class="fc-pw-plan-strike">vs $${(rawAnnual > 0 && monthly ? (monthly.product.price * 12).toFixed(2) : '59.88')}</span>` : '7-day free trial';
          detailEl.innerHTML = monthlyEq;
        }
        // Update "Save X%" dynamically from live prices
        const savingsEl = document.querySelector('.fc-pw-plan-savings');
        if (savingsEl && rawAnnual && monthly?.product?.price) {
          const fullYear = monthly.product.price * 12;
          const savePct  = Math.round((1 - rawAnnual / fullYear) * 100);
          if (savePct > 0) savingsEl.textContent = `Save ${savePct}%`;
        }
        // Update CTA & terms text to reflect live price
        const termsEl = document.getElementById('pw-terms-text');
        if (termsEl && _selectedPlan === 'annual') {
          termsEl.textContent = `Payment charged to your Apple ID at purchase confirmation. Subscription auto-renews at ${price}/year unless canceled at least 24 hours before the end of the current period. Manage or cancel in App Store Account Settings. Any unused trial is forfeited upon purchase.`;
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

    if (plan === 'annual') {
      if (btn)   btn.textContent   = 'Start My Free Week →';
      if (terms) terms.textContent = `Payment charged to your Apple ID at purchase confirmation. Subscription auto-renews at ${annualPrice}/year unless canceled at least 24 hours before the end of the current period. Manage or cancel in App Store Account Settings. Any unused trial is forfeited upon purchase.`;
    } else {
      if (btn)   btn.textContent   = 'Start Monthly Plan';
      if (terms) terms.textContent = `Payment charged to your Apple ID at purchase confirmation. Subscription auto-renews at ${monthlyPrice}/month unless canceled at least 24 hours before the end of the current period. Manage or cancel in App Store Account Settings.`;
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
            ? 'Your annual plan is active — enjoy all premium features.'
            : 'Your monthly plan is active — enjoy all premium features.';
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
      if (err.message?.toLowerCase().includes('cancel')) {
        // User cancelled — just reset button silently
      } else {
        toast('Purchase failed: ' + err.message, 'error');
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = _selectedPlan === 'annual' ? 'Try Free for 7 Days' : 'Start Monthly Plan';
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
        if (btn) { btn.disabled = false; btn.textContent = _selectedPlan === 'annual' ? 'Try Free for 7 Days' : 'Start Monthly Plan'; }
      }
    } catch (err) {
      toast('Restore failed: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.textContent = _selectedPlan === 'annual' ? 'Try Free for 7 Days' : 'Start Monthly Plan'; }
    }
  }

  function skipPaywall() {
    haptic('light');
    setScreen('app');
    _renderHome();
    setTimeout(() => _doSync(false), 800);
  }

  /* ─────────────────────────────────────────────────────────────
     GOALS CRUD
     ───────────────────────────────────────────────────────────── */

  let _editingGoalId = null;

  /** Called from goal card tap — looks up goal by ID then opens edit sheet */
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
    setTimeout(() => nameInput && nameInput.focus(), 200);
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

  function showManualAccountSheet() {
    const sheet = document.getElementById('fc-manual-account-sheet');
    const name  = document.getElementById('manual-acct-name');
    const bal   = document.getElementById('manual-acct-balance');
    if (name) name.value = '';
    if (bal)  bal.value  = '';
    if (sheet) { sheet.style.display = 'flex'; }
    haptic('light');
    setTimeout(() => name && name.focus(), 200);
  }

  function closeManualAccountSheet() {
    const sheet = document.getElementById('fc-manual-account-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); }, 280);
  }

  async function saveManualAccount() {
    const nameEl  = document.getElementById('manual-acct-name');
    const typeEl  = document.getElementById('manual-acct-type');
    const balEl   = document.getElementById('manual-acct-balance');
    const btn     = document.getElementById('manual-acct-save-btn');

    const name    = nameEl?.value.trim();
    const type    = typeEl?.value || 'savings';
    const balance = parseFloat(balEl?.value) || 0;

    if (!name) { toast('Enter an account name', 'info'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    haptic('light');

    try {
      await FCData.createManualAccount({
        name,
        type,
        subtype:          type,
        balance_current:  balance,
        balance:          balance,
        currency:         'USD',
        mask:             null,
      });
      closeManualAccountSheet();
      toast('Account added!', 'success');
      haptic('medium');
    } catch (err) {
      toast('Could not add account: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Add Account'; }
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
      if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    } else {
      _editingBillId = null;
      if (titleEl)  titleEl.textContent = 'Add Bill';
      if (idEl)     idEl.value          = '';
      if (nameEl)   nameEl.value        = '';
      if (amtEl)    amtEl.value         = '';
      if (freqEl)   freqEl.value        = 'monthly';
      // Default due date to today + 30 days
      const nextMonth = new Date(); nextMonth.setDate(nextMonth.getDate() + 30);
      if (dateEl)   dateEl.value = nextMonth.toISOString().split('T')[0];
      if (deleteBtn) deleteBtn.style.display = 'none';
    }

    sheet.style.display = 'flex';
    haptic('light');
    setTimeout(() => nameEl && nameEl.focus(), 200);
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

    const name     = nameEl?.value.trim();
    const amount   = parseFloat(amtEl?.value) || 0;
    const due_date = dateEl?.value || null;
    const category = catEl?.value || 'Other';
    const frequency= freqEl?.value || 'monthly';

    if (!name)    { toast('Enter a bill name', 'info'); return; }
    if (!amount)  { toast('Enter an amount', 'info'); return; }

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    haptic('light');

    try {
      const fields = { name, amount, due_date, category, frequency };
      if (_editingBillId) {
        await FCData.updateBill(_editingBillId, fields);
        toast('Bill updated!', 'success');
      } else {
        await FCData.createBill(fields);
        toast('Bill added!', 'success');
        // Re-prompt for notifications on first bill — the value prop is now obvious
        // ("get notified when this bill is due"). Only fires if they skipped during onboarding.
        if (!state.user?.notifications_enabled && (state.bills || []).length === 0) {
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
    const ov   = state.txnOverrides[txnId] || {};
    const name = ov.name || txn.name || '';
    const cat  = (ov.category) || (txn.category && txn.category[0]) || 'Other';

    const sheet   = document.getElementById('fc-txn-sheet');
    const nameEl  = document.getElementById('txn-edit-name');
    const catEl   = document.getElementById('txn-edit-category');
    const amtEl   = document.getElementById('txn-edit-amount');
    const dateEl  = document.getElementById('txn-edit-date');
    const origEl  = document.getElementById('txn-edit-original');

    if (nameEl)  nameEl.value  = name;
    if (catEl)   catEl.value   = cat;
    if (amtEl)   amtEl.textContent = (txn.isCredit ? '+' : '−') + FCData.formatCurrency(txn.amount);
    if (amtEl)   amtEl.style.color = txn.isCredit ? 'var(--fc-success)' : 'var(--fc-danger)';
    if (dateEl)  dateEl.textContent = txn.date ? FCData.parseDateLocal(txn.date).toLocaleDateString('en-US', { weekday:'short', month:'long', day:'numeric' }) : '';
    if (origEl)  {
      origEl.textContent = ov.name ? `Original: ${txn.name}` : '';
      origEl.style.display = ov.name ? '' : 'none';
    }

    if (sheet) { sheet.style.display = 'flex'; haptic('light'); }
    setTimeout(() => nameEl && nameEl.focus(), 200);
  }

  function closeTransactionSheet() {
    const sheet = document.getElementById('fc-txn-sheet');
    if (!sheet) return;
    sheet.classList.add('fc-sheet--closing');
    setTimeout(() => { sheet.style.display = 'none'; sheet.classList.remove('fc-sheet--closing'); _editingTxnId = null; }, 280);
  }

  async function saveTransactionEdit() {
    if (!_editingTxnId) return;
    const nameEl = document.getElementById('txn-edit-name');
    const catEl  = document.getElementById('txn-edit-category');
    const btn    = document.getElementById('txn-save-btn');

    const name     = nameEl?.value.trim();
    const category = catEl?.value;

    if (!name) { toast('Enter a name', 'info'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    haptic('light');

    try {
      await FCData.setTransactionOverride(_editingTxnId, { name, category });
      closeTransactionSheet();
      toast('Transaction updated', 'success');
      haptic('medium');
    } catch (err) {
      toast('Could not save: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
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
      toast('Could not reset', 'error');
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
      toast('Could not update bill', 'error');
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
        due_date:  nextDue.toISOString().split('T')[0],
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
    setTimeout(() => inputEl && inputEl.focus(), 200);
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
  function togglePrivacyMode() {
    _privacyModeOn = !_privacyModeOn;
    document.body.classList.toggle('fc-privacy', _privacyModeOn);

    // Update eye icon aria-label + visual state
    const btn = document.getElementById('fc-privacy-toggle');
    if (btn) {
      btn.setAttribute('aria-label', _privacyModeOn ? 'Show balances' : 'Hide balances');
      btn.setAttribute('aria-pressed', _privacyModeOn ? 'true' : 'false');
    }

    haptic('light');
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
      // For inline-styled scrubber buttons (insights tab), update style directly
      if (!btn.classList.contains('dash-scrub-btn') && !btn.closest('.fc-scrubber')) {
        btn.style.background   = active ? 'rgba(26,196,240,0.16)' : 'none';
        btn.style.color        = active ? 'var(--fc-accent)' : 'rgba(255,255,255,0.38)';
        btn.style.border       = active ? '0.5px solid rgba(26,196,240,0.28)' : 'none';
      }
    });

    // Re-render home with new period data (chart + insights update inside _renderHome)
    if (state.tab === 'home') _renderHome();
    // Also refresh chart in insights view if that tab is active
    if (state.tab === 'insights') _renderInsights();
    // Wealth sparkline also responds to period buttons on that tab
    if (state.tab === 'wealth') _renderWealthHero();
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
      console.error('[saveProfileChanges]', err);
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

  function _maybeShowWelcomeModal() {
    if (_welcomeShown) return;
    if (!state.user) return;
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
      FCData.updateUserField('welcome_seen', true).catch(() => {});
      if (openFeedback) setTimeout(() => showFeedbackScreen(), 220);
    };

    overlay.querySelector('#_fc-welcome-start').addEventListener('click', () => dismiss(false));
    overlay.querySelector('#_fc-welcome-feedback').addEventListener('click', () => dismiss(true));
  }

  /* ─────────────────────────────────────────────────────────────
     FEEDBACK BANNER
     ───────────────────────────────────────────────────────────── */

  function _renderFeedbackBanner() {
    const banner = document.getElementById('home-feedback-banner');
    if (!banner) return;
    banner.style.display = state.user?.feedback_banner_dismissed ? 'none' : 'block';
  }

  function dismissFeedbackBanner() {
    haptic('light');
    const banner = document.getElementById('home-feedback-banner');
    if (banner) banner.style.display = 'none';
    if (state.user) state.user.feedback_banner_dismissed = true;
    FCData.updateUserField('feedback_banner_dismissed', true).catch(() => {});
  }

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
    closeDeleteSheet,
    disconnectBank,
    deleteAccount,
    // Auth flows
    handleAppleSignIn: () => FCAuth.signInWithApple(),
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
    // Face ID setup
    handleBiometricSetup,
    skipFaceIdSetup,
    // Onboarding
    startTrialFromOnboarding,
    skipOnboarding,
    startDemoMode,
    handleVerifyEmailCheck,
    resendVerificationEmail,
    otpBoxInput,
    otpBoxKeydown,
    handleOtpPaste,
    // Wealth tab
    switchWealthSegment,
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
    filterActivity,
    // Manual accounts
    showManualAccountSheet,
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
      const budgetLim = (state.budgets && state.budgets['total']) ? state.budgets['total'].limit : 3000;
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
    getTotalBudgetLimit: () => (state.budgets && state.budgets['total'] ? state.budgets['total'].limit : 3000),
    // Dashboard UI
    toggleInsights,
    // Alert banner tap — routes to the most relevant tab based on alert type
    _alertBannerTap() {
      const banner = document.getElementById('home-alert-inner');
      const tab    = banner?.dataset?.alertTab || 'activity';
      switchTab(tab);
    },
    // Today's Focus card
    nextFocusInsight() {
      if (!_focusInsights.length) return;
      _focusIdx = (_focusIdx + 1) % _focusInsights.length;
      _applyFocusInsight(_focusIdx);
    },
    _focusCardTap() {
      const card = document.getElementById('todays-focus-card');
      if (!card) return;
      // Show "Done ✓" resolution state for 1.8s, then advance to next insight
      const bodyEl = document.getElementById('focus-body');
      const actionEl = document.getElementById('focus-action');
      if (bodyEl) {
        const prevText = bodyEl.textContent;
        bodyEl.textContent = 'Done ✓';
        bodyEl.style.color = 'var(--fc-success)';
        if (actionEl) actionEl.style.opacity = '0';
        haptic('medium');
        setTimeout(() => {
          bodyEl.style.color = '';
          if (actionEl) actionEl.style.opacity = '';
          if (_focusInsights.length > 1) {
            _focusIdx = (_focusIdx + 1) % _focusInsights.length;
            _applyFocusInsight(_focusIdx);
          } else {
            bodyEl.textContent = prevText;
          }
        }, 1800);
      }
      if (typeof card._focusTap === 'function') card._focusTap();
    },
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
    dismissFeedbackBanner,
    submitFeedback,
    _fbSetPriority,
    _fbToggleDiag,
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
    const bg = isDark ? '#060e18' : '#f2f4f8';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
    document.documentElement.style.backgroundColor = bg;
    document.body && (document.body.style.backgroundColor = bg);

    // Highlight the active picker button
    document.querySelectorAll('#appearance-picker button').forEach(btn => {
      const isActive = btn.dataset.themeVal === pref;
      btn.style.background  = isActive ? (isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.95)') : 'transparent';
      btn.style.color       = isActive ? (isDark ? '#f0f6ff' : '#0d1b2e') : '';
      btn.style.boxShadow   = isActive ? (isDark ? '0 1px 4px rgba(0,0,0,0.3)' : '0 1px 6px rgba(13,27,46,0.12)') : '';
    });
  }

  function _load() {
    return localStorage.getItem(STORAGE_KEY) || 'dark';
  }

  // Apply immediately on load (before anything renders)
  _apply(_load());

  // React to system preference changes when set to 'system'
  if (mq) mq.addEventListener('change', () => { if (_load() === 'system') _apply('system'); });

  // Public: called by settings picker buttons
  window._FCSetAppearance = function(pref) {
    localStorage.setItem(STORAGE_KEY, pref);
    _apply(pref);
  };
  window._FCGetAppearance = _load;
})();

/* ── Boot on DOM ready ───────────────────────────────────────── */
// requestAnimationFrame gives the browser a chance to paint the
// splash screen (pure CSS, no JS) before booting. This makes the
// app feel instant — the user sees the splash immediately while
// Firebase init, auth check, and data listeners start in the background.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(() => FCApp.boot()));
} else {
  requestAnimationFrame(() => FCApp.boot());
}
