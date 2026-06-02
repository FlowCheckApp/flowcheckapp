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
    lastSyncAt:      0,          // timestamp of last successful sync (ms) — used for rate limiting
    searchQuery:     '',
    period:          '1M',       // active home-screen period: 1D | 1W | 1M | 3M | 1Y | All
    notifications:   [],
    txnOverrides:    {},         // { [txnId]: {name?, category?} }
    creditHistory:   [],         // [{month:'YYYY-MM', score:number}, …] oldest-first
  };

  // Tracks which specific item is being disconnected (null = disconnect all)
  let _pendingDisconnectItemId = null;

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
    const raw  = (t.category && t.category[0]) || t.category || '';
    const norm = FCData.normalizePlaidCategory(raw).toLowerCase();
    return !_XFER_SKIP.has(norm) && !norm.includes('transfer');
  }

  // ── Shared income-transaction filter ─────────────────────────────
  // Plaid stores payroll/direct-deposit as TRANSFER_IN (primary category) which
  // normalizePlaidCategory maps to 'Transfer' — that would be excluded by the old
  // includes('transfer') guard.  Whitelist Plaid's income primaries first so
  // paychecks are never silently dropped from the income total.
  const _INCOME_RAW = new Set(['INCOME', 'TRANSFER_IN', 'Income', 'Transfer In']);
  function _isIncomeTxn(t) {
    if (!t.isCredit || !t.date) return false;
    const raw = (t.category && t.category[0]) || t.category || '';
    // Explicitly include known Plaid income categories regardless of norm
    if (_INCOME_RAW.has(raw) || _INCOME_RAW.has(raw.toUpperCase().replace(/ /g,'_'))) return true;
    const norm = FCData.normalizePlaidCategory(raw).toLowerCase();
    // Exclude only explicit non-income credits (internal xfers, CC payments)
    return !_XFER_SKIP.has(norm) && !norm.includes('payment');
  }

  // ── Transaction display-name cleaner ─────────────────────────────
  // Strips raw bank strings like "DEBIT PURCHASE 0523 9264 CENEX" → "Cenex"
  // Also handles "9264 ANTHROPIC", "SQ *TACO BELL #1234", etc.
  function _cleanTxnName(t) {
    if (t.customName)    return t.customName;
    if (t.merchant_name) return t.merchant_name;
    let name = t.name || 'Transaction';

    // 1. Strip full bank prefix with 4-digit sequence + ref token
    //    e.g. "DEBIT PURCHASE 0523 9264 CENEX" → "CENEX"
    name = name.replace(/^(?:DEBIT\s+(?:PURCHASE|CARD)|POS\s+(?:PURCHASE|DEBIT)|ACH\s+DEBIT|ONLINE\s+(?:PAYMENT|PURCHASE)|ELECTRONIC|CHECKCARD|CHECK\s+CARD|VISA\s+(?:PURCHASE|DEBIT)|MASTERCARD\s+DEBIT)\s+\d{4}\s+\S+\s*/i, '');

    // 2. Strip standalone leading 4-digit reference number + any trailing junk
    //    e.g. "9264 CENEX" → "CENEX"
    //         "9264&@#anthropic" → "anthropic" → "Anthropic"
    name = name.replace(/^\d{4}[\s&@#*|_\-!%^()[\]{}]*/, '');

    // 3. Strip Square/Toast/Stripe noise: "SQ *", "TST* ", "SP * "
    name = name.replace(/^(?:SQ|TST|SP|PP)\s*\*\s*/i, '');

    // 4. Strip trailing location noise: " #1234 SEATTLE WA", " 00", " WA US"
    name = name.replace(/\s+#\d+\s+\S+\s+\S{2}\s*$/, '');
    name = name.replace(/\s+\d{9,}.*$/, '');
    name = name.replace(/\s+\d{2}\s*$/, '');

    // 5. Collapse extra whitespace
    name = name.replace(/\s{2,}/g, ' ').trim();

    // 6. Proper-case if all-caps OR all-lowercase (raw bank / corrupted format)
    if (name.length > 2 && (name === name.toUpperCase() || name === name.toLowerCase())) {
      name = name.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    }

    return name || (t.name || 'Transaction');
  }

  // Detect monthly-recurring subscription transactions (shared by stat + hunter)
  // Exclusion list: bank fees, interest charges, loan payments, transfers — these
  // recur regularly but are NOT subscriptions.
  const _SUB_EXCLUDE_RE = /\b(interest charge|interest|finance charge|late fee|annual fee|over.?limit fee|returned payment|overdraft|service charge|maintenance fee|wire transfer|ach|zelle|venmo|cashapp|paypal|transfer|loan payment|mortgage payment|auto pay|autopay)\b/i;
  function _detectSubscriptions() {
    const map = {};
    for (const t of state.transactions) {
      if (t.isCredit || !t.date || !t.name) continue;
      // Skip bank charges, interest, fees, and transfers
      if (_SUB_EXCLUDE_RE.test(t.name)) continue;
      const rawCat = (t.category && t.category[0]) || '';
      const normCat = FCData.normalizePlaidCategory(rawCat).toLowerCase();
      if (normCat.includes('transfer') || normCat === 'loan' || normCat === 'bank fees') continue;
      const key = t.name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 14);
      if (!map[key]) map[key] = { name: t.name, entries: [] };
      map[key].entries.push({ amount: t.amount || 0, ts: FCData.parseDateLocal(t.date).getTime() });
    }
    const detected = [];
    for (const [, data] of Object.entries(map)) {
      if (data.entries.length < 2) continue;
      data.entries.sort((a, b) => a.ts - b.ts);
      const gaps = [];
      for (let i = 1; i < data.entries.length; i++)
        gaps.push((data.entries[i].ts - data.entries[i - 1].ts) / 86400000);
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const avgAmt = data.entries.reduce((s, e) => s + e.amount, 0) / data.entries.length;
      const isMonthly = avgGap >= 25 && avgGap <= 37;
      const isWeekly  = avgGap >= 5  && avgGap <= 9;
      if ((isMonthly || isWeekly) && avgAmt >= 1) {
        const alreadyTracked = state.bills.some(b =>
          b.name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 8) ===
          data.name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 8));
        detected.push({ name: data.name, amount: avgAmt, freq: isMonthly ? 'mo' : 'wk', tracked: alreadyTracked });
      }
    }
    return detected;
  }

  // Cancel / manage URL for known subscription services
  function _subCancelUrl(name) {
    const n = name.toLowerCase();
    const MAP = [
      ['netflix',   'https://www.netflix.com/cancelplan'],
      ['spotify',   'https://www.spotify.com/account/subscription/'],
      ['hulu',      'https://secure.hulu.com/account/cancel'],
      ['amazon',    'https://www.amazon.com/mc/pipelines/cancellation'],
      ['apple',     'https://apps.apple.com/account/subscriptions'],
      ['disney',    'https://www.disneyplus.com/account'],
      ['youtube',   'https://www.youtube.com/paid_memberships'],
      ['max',       'https://www.max.com/account/subscription'],
      ['hbo',       'https://www.max.com/account/subscription'],
      ['paramount', 'https://www.paramountplus.com/account/'],
      ['peacock',   'https://www.peacocktv.com/account/subscription'],
      ['peloton',   'https://members.onepeloton.com/profile/preferences'],
      ['adobe',     'https://account.adobe.com/plans'],
      ['dropbox',   'https://www.dropbox.com/account/plan'],
      ['microsoft', 'https://account.microsoft.com/services'],
      ['google',    'https://myaccount.google.com/payments-and-subscriptions'],
    ];
    for (const [key, url] of MAP) {
      if (n.includes(key)) return url;
    }
    // Generic — iOS subscriptions page for anything unrecognised
    return 'https://apps.apple.com/account/subscriptions';
  }

  /* ── Net Worth History (localStorage sparkline) ─────────────── */
  // Key is user-scoped so switching accounts never leaks another user's trend data.
  function _nwHistoryKey() {
    return state.user?.uid ? `fc_nw_history_${state.user.uid}` : null;
  }

  // Persist today's net worth and keep 60-day rolling window
  function _snapshotNetWorth(netWorth) {
    if (!state.user || !state.user.plaid_linked) return;
    const key = _nwHistoryKey();
    if (!key) return;
    try {
      // One-time migration: remove the old un-namespaced key if present
      if (localStorage.getItem('fc_nw_history')) localStorage.removeItem('fc_nw_history');

      const today   = new Date().toISOString().split('T')[0];
      const raw     = localStorage.getItem(key);
      const history = raw ? JSON.parse(raw) : {};
      history[today] = Math.round(netWorth * 100) / 100;
      // Keep last 60 days
      const keys = Object.keys(history).sort();
      if (keys.length > 60) keys.slice(0, keys.length - 60).forEach(k => delete history[k]);
      localStorage.setItem(key, JSON.stringify(history));
      _drawNetWorthSparkline(history);
    } catch (_) {}
  }

  function _drawNetWorthSparkline(history) {
    const linePath = document.getElementById('sparkline-line');
    const areaPath = document.getElementById('sparkline-area');
    const dot      = document.getElementById('sparkline-dot');
    const dotBg    = document.getElementById('sparkline-dot-bg');
    const deltaEl  = document.getElementById('hero-delta');
    if (!linePath || !areaPath) return;

    const keys   = Object.keys(history).sort();
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
          pulse.setAttribute('stroke', '#1ac4f0');
          pulse.setAttribute('stroke-width', '1.5');
          pulse.setAttribute('opacity', '0');
          pulse.style.cssText = 'animation:sparkPulse 2s ease-out infinite';
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
        deltaEl.style.background  = up ? 'rgba(52,199,89,0.15)'  : 'rgba(255,69,58,0.12)';
        deltaEl.style.color       = up ? 'var(--fc-success)'     : 'var(--fc-danger)';
        deltaEl.style.border      = up ? '1px solid rgba(52,199,89,0.25)' : '1px solid rgba(255,69,58,0.2)';
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
      ? `<line x1="${GAP}" y1="${avgY}" x2="${W - GAP}" y2="${avgY}" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="3 3"/>`
      : '';

    const bars = buckets.map((b, i) => {
      const x  = GAP + i * (barW + GAP);
      const h  = b.total > 0 ? Math.max(Math.round((b.total / maxVal) * (H - 10)), 4) : 0;
      const y  = H - h;
      if (h === 0) return ''; // zero-spend day — no bar at all
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
        return `<span style="position:absolute;left:${xPct}%;transform:translateX(-50%);font-size:9px;color:rgba(255,255,255,0.35);font-weight:500;white-space:nowrap">${b.label}</span>`;
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
        deltaEl.style.background = up ? 'rgba(255,69,58,0.12)'  : 'rgba(52,199,89,0.12)';
        deltaEl.style.color      = up ? 'var(--fc-danger)'      : 'var(--fc-success)';
        deltaEl.style.border     = up ? '1px solid rgba(255,69,58,0.2)' : '1px solid rgba(52,199,89,0.2)';
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

    // 4. Savings rate (uses filtered spend vs income — accurate comparison)
    if (periodIncome > 0 && periodSpend > 0) {
      const savingsRate = Math.round(((periodIncome - periodSpend) / periodIncome) * 100);
      if (savingsRate >= 20) {
        insights.push({ icon: '🔥', text: `Saving ${savingsRate}% of income ${label} — keep it up!`, color: 'var(--fc-success)', bg: 'rgba(52,199,89,0.08)' });
      } else if (savingsRate < 0) {
        insights.push({ icon: '📉', text: `Spending ${FCData.formatCurrency(Math.abs(periodIncome - periodSpend))} more than earned ${label}`, color: 'var(--fc-danger)', bg: 'rgba(255,69,58,0.08)' });
      } else if (savingsRate > 0) {
        insights.push({ icon: '💰', text: `Saving ${savingsRate}% of income — consider increasing to 20%`, color: 'rgba(255,255,255,0.7)', bg: 'rgba(255,255,255,0.04)' });
      }
    }

    // 5. Daily spending average + monthly projection (only for 1M period, filtered spend)
    if (state.period === '1M' && periodSpend > 0) {
      const dayOfMonth  = new Date().getDate();
      const dailyAvg    = periodSpend / dayOfMonth;
      const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      const projected   = dailyAvg * daysInMonth;
      const overProj    = hasBudget && projected > budgetLimit;
      insights.push({
        icon: '📆',
        text: `Avg ${FCData.formatCurrency(dailyAvg)}/day · projected ${FCData.formatCurrency(projected)} by month end${overProj ? ' ⚠️' : ''}`,
        color: overProj ? 'var(--fc-warning)' : 'rgba(255,255,255,0.65)',
        bg: overProj ? 'rgba(255,176,32,0.07)' : 'rgba(255,255,255,0.03)',
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
      <div style="display:flex;align-items:flex-start;gap:11px;padding:12px 14px;
                  background:${ins.bg};
                  border:1px solid rgba(255,255,255,0.06);
                  border-left:3px solid ${borderColor};
                  border-radius:14px;
                  box-shadow:inset 0 1px 0 rgba(255,255,255,0.04)">
        <div style="width:32px;height:32px;border-radius:10px;
                    background:rgba(255,255,255,0.06);
                    display:flex;align-items:center;justify-content:center;
                    font-size:16px;flex-shrink:0;line-height:1;
                    margin-top:1px">${esc(ins.icon)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:#fff;line-height:1.35;margin-bottom:2px">
            ${esc(ins.text)}
          </div>
          ${ins.sub ? `<div style="font-size:11px;color:rgba(255,255,255,0.4);line-height:1.4;margin-top:3px">${esc(ins.sub)}</div>` : ''}
        </div>
        <div style="width:6px;height:6px;border-radius:50%;background:${borderColor};
                    flex-shrink:0;margin-top:5px;opacity:0.8"></div>
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
    const d = new Date();
    // Include year so alerts reset each January (not stuck across calendar years)
    const key = `fc_budget_alerted_${level}_${d.getFullYear()}_${d.getMonth()}`;
    return localStorage.getItem(key) === '1';
  }
  function _setBudgetAlerted(level) {
    const d = new Date();
    const key = `fc_budget_alerted_${level}_${d.getFullYear()}_${d.getMonth()}`;
    localStorage.setItem(key, '1');
    // Clean up keys from other months/years
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
    splash: 0, login: 1, register: 2, 'forgot-password': 1.5,
    'verify-email': 3, 'faceid-setup': 4, onboarding: 5, paywall: 6, app: 7,
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
      if (name === 'register') _clearError('register-error');
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

    const unpaid = state.bills.filter(b => b.status !== 'paid');
    const paid   = state.bills.filter(b => b.status === 'paid');

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
        <div class="fc-list-item" style="cursor:pointer" onclick="FCApp.editBill('${b.id}')" role="button">
          <div class="fc-list-icon" style="background:${bg};color:white;font-weight:700;font-size:16px">
            ${b.icon || b.name.charAt(0)}
          </div>
          <div class="fc-list-body">
            <div class="fc-list-title">${b.name}</div>
            <div class="fc-list-meta">${b.category || 'Bill'} · ${b.frequency || 'monthly'}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px">
            <div class="fc-list-amount">${FCData.formatCurrency(b.amount)}</div>
            ${statusText}
          </div>
        </div>`;
    };

    let html = '';

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

  function switchTab(tabId) {
    if (state.tab === tabId) return;
    const prev = state.tab;
    state.tab  = tabId;

    // Slide direction based on tab order
    const prevIdx = _TAB_ORDER.indexOf(prev);
    const nextIdx = _TAB_ORDER.indexOf(tabId);
    const slideClass = nextIdx > prevIdx ? 'fc-slide-right' : 'fc-slide-left';

    const target  = document.getElementById('view-' + tabId);
    const outgoing = prev ? document.getElementById('view-' + prev) : null;

    // ── Activate target FIRST (no flash between deactivate+activate) ──────
    // Reset scroll before it becomes visible so it enters at top.
    if (target) target.scrollTop = 0;
    if (target) target.classList.add('active', slideClass);

    // Deactivate outgoing AFTER target is active — avoids single-frame blank
    if (outgoing) {
      outgoing.classList.remove('active', 'fc-slide-right', 'fc-slide-left');
    }

    // Clean up animation class once the slide completes (240ms + 10ms buffer)
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
      setTimeout(_renderInsights, ANIM_MS);
    } else if (tabId === 'goals') {
      setTimeout(_renderGoals, ANIM_MS);
    } else if (tabId === 'wealth') {
      setTimeout(_renderWealth, ANIM_MS);
    } else if (tabId === 'settings') {
      setTimeout(_renderSettings, ANIM_MS);
    }

    haptic('light');
    if (typeof FCAnalytics !== 'undefined') FCAnalytics.screen('tab_' + tabId);
    fcLog('Tab →', tabId, '(from', prev + ')');
  }

  /* ─────────────────────────────────────────────────────────────
     TOAST SYSTEM
     ───────────────────────────────────────────────────────────── */

  let _toastTimer = null;

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
    duration = duration || 1000;

    const startValue = parseFloat(element.dataset.animVal || '0');
    const startTime  = performance.now();

    function step(now) {
      const elapsed  = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased    = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const current  = startValue + (target - startValue) * eased;

      const isNeg  = current < 0;
      const absStr = Math.abs(current).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      element.textContent = (isNeg ? (prefix ? '−' + prefix : '−') : (prefix || '')) + absStr + suffix;
      element.dataset.animVal = current;

      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
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
    const rawName = state.user?.name || state.user?.displayName || '';
    const name    = rawName.split(' ')[0] || 'there';
    const dateEl  = document.getElementById('home-greeting-date');
    const titleEl = document.getElementById('home-greeting-title');
    if (dateEl) dateEl.textContent = greet;
    if (titleEl) titleEl.textContent = name;
    const avatarEl = document.getElementById('home-user-avatar');
    if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase() || 'B';
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
        <div style="display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.04);border-radius:8px;padding:5px 9px">
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
     CREDIT SCORE — Experian integration
     ───────────────────────────────────────────────────────────── */

  // Map numeric score to label + arc color
  function _creditLabel(score) {
    if (!score) return { label: '—', color: 'rgba(255,255,255,0.3)' };
    if (score >= 800) return { label: 'Exceptional',  color: '#34c759' };
    if (score >= 740) return { label: 'Very Good',    color: '#30d158' };
    if (score >= 670) return { label: 'Good',         color: '#1ac4f0' };
    if (score >= 580) return { label: 'Fair',         color: '#ffb020' };
    return               { label: 'Poor',         color: '#ff453a' };
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
      .reduce((s, a) => s + (a.balances?.current || 0), 0);
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
    el.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
            <span style="font-size:14px">${offer.icon}</span>
            <span style="font-size:11px;font-weight:700;color:${offer.color};text-transform:uppercase;letter-spacing:0.06em">${offer.badge}</span>
            <span style="font-size:10px;color:rgba(255,255,255,0.3);margin-left:auto;font-weight:500">Partner</span>
          </div>
          <div style="font-size:17px;font-weight:700;color:white;line-height:1.3;margin-bottom:6px">${headline}</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.5);line-height:1.4;margin-bottom:14px">${offer.sub}</div>
          <button onclick="FCApp.openOffer('${offer.id}')"
            style="background:${offer.color};color:white;border:none;border-radius:10px;padding:10px 20px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px">
            ${offer.cta}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
        <div style="width:44px;height:44px;border-radius:12px;background:${offer.color}22;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">${offer.icon}</div>
      </div>
      <p style="margin:12px 0 0;font-size:11px;color:rgba(255,255,255,0.2);line-height:1.4">
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
    state.user          = null;
    state.accounts      = [];
    state.transactions  = [];
    state.bills         = [];
    state.goals         = [];
    state.budgets       = {};
    state.notifications = [];
    state.txnOverrides  = {};
    state.creditHistory = [];
    state.searchQuery   = '';
    _paywallShownThisSession    = false;
    _streakCheckedThisSession   = false;
    if (_privacyModeOn) {
      _privacyModeOn = false;
      document.body.classList.remove('fc-privacy');
    }
    // Wipe per-user localStorage caches (net-worth history, budget alert
    // flags, debt start, etc.) so they can't leak into the next user.
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('fc_'))
        .forEach(k => localStorage.removeItem(k));
    } catch (_) { /* localStorage unavailable in strict CSP — safe to ignore */ }
  }

  /** Re-render every pro-gated surface after a successful purchase/restore.
   *  Without this the success overlay closes but underlying gates persist
   *  (e.g. the Financial Health Score card and the settings Upgrade row). */
  function _refreshAfterPro() {
    if (state.user) state.user.is_pro = true;
    try { _renderHome();     } catch (_) {}
    try { _renderInsights(); } catch (_) {}
    try { _renderSettings(); } catch (_) {}
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
    if (!state.user?.plaid_linked || monthIncome < 50) { section.style.display = 'none'; return; }

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
    const savings     = Math.max(0, monthIncome - needs - wants);
    const savingsPct  = Math.round((savings / monthIncome) * 100);
    const needsPct    = Math.round((needs   / monthIncome) * 100);
    const wantsPct    = Math.round((wants   / monthIncome) * 100);

    // Render rows
    const rowsEl = document.getElementById('budget-wizard-rows');
    if (!rowsEl) return;

    function makeRow(label, actual, target, color, icon, tip) {
      const pct     = Math.round((actual / monthIncome) * 100);
      const barPct  = Math.min(pct, 100);
      const isOver  = pct > target + 5;
      const isUnder = pct < target - 5;
      const status  = isOver ? `${pct - target}% over` : isUnder ? `${target - pct}% under` : 'On target ✓';
      const statusColor = isOver ? '#ff453a' : isUnder ? '#ff9f0a' : '#34c759';
      return `
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
            <div style="display:flex;align-items:center;gap:7px">
              <span style="font-size:16px">${icon}</span>
              <div>
                <div style="font-size:13px;font-weight:600;color:#fff">${label}</div>
                <div style="font-size:11px;color:rgba(255,255,255,0.4)">Target: ${target}% · ${FCData.formatCurrency(Math.round(actual))}</div>
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-size:16px;font-weight:800;color:${color}">${pct}%</div>
              <div style="font-size:10px;color:${statusColor};font-weight:600">${status}</div>
            </div>
          </div>
          <div class="dash-bar-track" style="background:rgba(255,255,255,0.07)">
            <div class="dash-bar-fill" style="width:${barPct}%;background:${isOver ? '#ff453a' : color}"></div>
          </div>
          <div style="height:6px;position:relative;margin-top:2px">
            <div style="position:absolute;left:${target}%;top:-8px;width:1px;height:16px;background:rgba(255,255,255,0.2)"></div>
          </div>
        </div>`;
    }

    rowsEl.innerHTML =
      makeRow('Needs',   needs,   50, '#1ac4f0', '🏠', '') +
      makeRow('Wants',   wants,   30, '#60a5fa', '✨', '') +
      makeRow('Savings', savings, 20, '#34c759', '💰', '');

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
      const cancelUrl = _subCancelUrl(z.name);
      const icon      = subIcon(z.name);
      const name      = _cleanTxnName({ name: z.name });
      const annualCost = FCData.formatCurrency(Math.round(z.amount * 12));
      return `
        <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;
                    background:rgba(255,255,255,0.04);border-radius:12px;
                    border:1px solid rgba(255,255,255,0.06)">
          <span style="font-size:20px;flex-shrink:0">${icon}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:1px">${FCData.formatCurrency(z.amount)}/${z.freq} · ${annualCost}/yr</div>
          </div>
          ${cancelUrl ? `
          <a href="${cancelUrl}" target="_blank" rel="noopener noreferrer"
             style="flex-shrink:0;font-size:12px;font-weight:600;color:#ff453a;
                    background:rgba(255,69,58,0.10);border:1px solid rgba(255,69,58,0.25);
                    border-radius:8px;padding:5px 10px;text-decoration:none;white-space:nowrap;
                    -webkit-tap-highlight-color:transparent">
            Cancel
          </a>` : `
          <button onclick="FCApp.showBillSheet()" type="button"
             style="flex-shrink:0;font-size:12px;font-weight:600;color:var(--fc-accent);
                    background:rgba(26,196,240,0.10);border:1px solid rgba(26,196,240,0.25);
                    border-radius:8px;padding:5px 10px;font-family:inherit;cursor:pointer;white-space:nowrap">
            Track
          </button>`}
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

    // Collect debt accounts
    const debtAccts = state.accounts.filter(a =>
      (a.type === 'loan' || a.type === 'credit') &&
      (a.balances?.current || 0) > 50
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
      const balance = a.balances?.current || 0;
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
        <div style="display:flex;align-items:center;justify-content:space-between;
                    padding:9px 11px;background:rgba(255,255,255,0.04);border-radius:10px;
                    border:1px solid rgba(255,255,255,0.06)">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <span style="font-size:16px;flex-shrink:0">${debtTypeIcon(d)}</span>
            <div style="min-width:0">
              <div style="font-size:13px;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${esc(d.name)}</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.38)">~${Math.round(d.apr * 100)}% APR est.</div>
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:14px;font-weight:700;color:#fff">${FCData.formatCurrency(Math.round(d.balance))}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.38)">${FCData.formatCurrency(Math.round(d.minPay))}/mo min</div>
          </div>
        </div>`).join('');
    }

    // Render method comparison
    const compEl = document.getElementById('debt-planner-comparison');
    if (compEl) {
      function methodCard(label, data, color, isWinner) {
        return `
          <div style="background:${isWinner ? 'rgba(52,199,89,0.08)' : 'rgba(255,255,255,0.04)'};
                      border:1px solid ${isWinner ? 'rgba(52,199,89,0.25)' : 'rgba(255,255,255,0.07)'};
                      border-radius:12px;padding:12px;text-align:center">
            ${isWinner ? '<div style="font-size:9px;font-weight:700;color:#34c759;text-transform:uppercase;letter-spacing:0.07em;margin-bottom:4px">★ Recommended</div>' : '<div style="margin-bottom:4px;height:13px"></div>'}
            <div style="font-size:14px;font-weight:700;color:${color};margin-bottom:2px">${label}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:8px">${label === 'Avalanche' ? 'Highest APR first' : 'Smallest balance first'}</div>
            <div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:1px">${monthsLabel(data.months)}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-bottom:6px">to debt free</div>
            <div style="font-size:13px;font-weight:700;color:${isWinner ? '#34c759' : 'rgba(255,255,255,0.6)'}">
              ${FCData.formatCurrency(Math.round(data.totalInterest))} interest
            </div>
          </div>`;
      }
      compEl.innerHTML =
        methodCard('Avalanche', avalanche, '#1ac4f0', true) +
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
      if (ringEl) ringEl.style.strokeDashoffset = circumference - (circumference * pct / 100);
      if (pctEl)  pctEl.textContent = pct + '%';
      if (titleEl) titleEl.textContent = 'Paying down your debt';
      if (subEl)   subEl.textContent   = `${remaining} left · debt-free progress`;
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
    const celebKey   = `fc_milestone_${next}`;
    const prevKey    = `fc_milestone_prev_${next}`;
    const celebrated = localStorage.getItem(celebKey) === '1';
    const prevNW     = parseFloat(localStorage.getItem(prevKey) || '0');
    const justCrossed = prevNW < next && netWorth >= next;

    // Save current netWorth for next comparison
    localStorage.setItem(prevKey, String(netWorth));

    let showBadge = false;
    if (justCrossed && !celebrated) {
      localStorage.setItem(celebKey, '1');
      showBadge = true;
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
    const COLORS = ['#1ac4f0','#60a5fa','#34c759','#FFD60A','#ff9f0a','#ff453a'];
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
        color:    '#1ac4f0',
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
              <div style="font-size:15px;font-weight:700;color:#fff;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(card.name)}</div>
              <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px">${esc(feeStr)}</div>
            </div>
            <div style="flex-shrink:0;background:${card.color}1A;border:1px solid ${card.color}44;
                        border-radius:10px;padding:6px 10px;text-align:center">
              <div style="font-size:20px;font-weight:800;color:${card.color};line-height:1">${card.topRate}x</div>
              <div style="font-size:9px;color:rgba(255,255,255,0.45);margin-top:1px;text-transform:capitalize">${esc(card.topBucket)}</div>
            </div>
          </div>

          <!-- Why it fits -->
          <div style="background:rgba(255,255,255,0.05);border-radius:10px;padding:10px 12px;margin-bottom:12px">
            <div style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.35);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px">Why it fits you</div>
            <div style="font-size:13px;color:rgba(255,255,255,0.82);line-height:1.45">${esc(matchText)}</div>
          </div>

          <!-- Estimated rewards -->
          <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:14px">
            <div>
              <div style="font-size:11px;color:rgba(255,255,255,0.38);margin-bottom:3px">${card.fee > 0 ? 'Est. net annual value' : 'Est. annual cash back'}</div>
              <div style="font-size:24px;font-weight:800;color:${card.color};line-height:1">${netStr}</div>
            </div>
            ${card.fee > 0 ? `<div style="font-size:11px;color:rgba(255,255,255,0.32);text-align:right;line-height:1.5">After<br>$${card.fee} fee</div>` : ''}
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
          <div style="font-size:10px;color:rgba(255,255,255,0.18);text-align:center;margin-top:8px;line-height:1.4">
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
      .reduce((s, a) => s + (a.balances?.current || 0), 0);

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
      const lineColor = isDanger ? '#ff453a' : isWarning ? '#ff9f0a' : '#1ac4f0';
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
        ${minVal < 0 ? `<line x1="${PAD}" y1="${zeroY.toFixed(1)}" x2="${W-PAD}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,0.12)" stroke-width="1" stroke-dasharray="4 3"/>` : ''}
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
        lowValue.style.color  = isDanger ? '#ff453a' : isWarning ? '#ff9f0a' : '#1ac4f0';
      }
    }

    // ── 7. Stat boxes ──────────────────────────────────────────────
    const nowEl  = document.getElementById('cashflow-stat-now');
    const lowEl  = document.getElementById('cashflow-stat-low');
    const endEl  = document.getElementById('cashflow-stat-end');

    if (nowEl)  nowEl.textContent  = _fmtCompact(cashNow);
    if (lowEl) {
      lowEl.textContent = _fmtCompact(minBalance);
      lowEl.style.color = isDanger ? '#ff453a' : isWarning ? '#ff9f0a' : '#34c759';
    }
    if (endEl) {
      endEl.textContent = _fmtCompact(endBalance);
      endEl.style.color = endBalance < 0 ? '#ff453a' : endBalance < threshold ? '#ff9f0a' : '#fff';
    }

    // ── 8. Status badge ────────────────────────────────────────────
    const badge = document.getElementById('cashflow-status-badge');
    if (badge) {
      if (isDanger) {
        badge.textContent        = '⚠ Shortfall';
        badge.style.background   = 'rgba(255,69,58,0.15)';
        badge.style.color        = '#ff453a';
      } else if (isWarning) {
        badge.textContent        = '⚠ Watch Out';
        badge.style.background   = 'rgba(255,159,10,0.15)';
        badge.style.color        = '#ff9f0a';
      } else {
        badge.textContent        = '✓ On Track';
        badge.style.background   = 'rgba(52,199,89,0.15)';
        badge.style.color        = '#34c759';
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
        warnEl.style.color = '#ff453a';
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
        `<div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);
          border-radius:999px;padding:4px 10px;font-size:11px;color:rgba(255,255,255,0.55)">${esc(f)}</div>`
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
      const log = JSON.parse(localStorage.getItem('fc_offer_clicks') || '[]');
      log.push({ id: offerId, ts: Date.now() });
      localStorage.setItem('fc_offer_clicks', JSON.stringify(log.slice(-50)));
    } catch (_) {}

    haptic('light');
    _openUrl(offer.url);
  }

  // Called when user taps "Check My Credit Score" — fetches from backend
  async function fetchCreditScore() {
    const btn = document.getElementById('credit-connect-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

    try {
      const creditUrl   = (FC_CONFIG && FC_CONFIG.credit && FC_CONFIG.credit.scoreEndpoint)
                        || 'https://flowcheck-backend-production.up.railway.app/credit/score';
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

      // Show a subtle note if running on demo data
      if (data.demo) {
        toast('Showing sample score — Experian not yet configured', 'info');
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
    // Prefer Firestore 'name' field (set at registration) → Firebase Auth displayName
    // → email prefix → fallback. Never show username/email handle in the greeting.
    const rawName = state.user?.name || state.user?.displayName || '';
    const name    = rawName.split(' ')[0] || 'there';

    if (dateEl) dateEl.textContent = tod;
    titleEl.textContent = name;

    // Avatar initial
    if (avatarEl) avatarEl.textContent = name.charAt(0).toUpperCase() || 'B';

    if (subEl) {
      // Show contextual subtitle: safe-to-spend if connected, else prompt
      if (state.user?.plaid_linked && safeToSpend != null && safeToSpend > 0) {
        subEl.textContent = `${_fmtCompact(safeToSpend)} safe to spend this month`;
        subEl.style.display = '';
      } else if (state.user?.plaid_linked) {
        subEl.style.display = 'none';
      } else {
        subEl.textContent  = 'Connect a bank to see your full picture';
        subEl.style.display = '';
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: ACCOUNT PILLS
     ───────────────────────────────────────────────────────────── */
  const _ACCT_TYPE_META = {
    depository: { icon: '🏦', color: '#1ac4f0', label: 'Checking' },
    savings:    { icon: '💰', color: '#34c759', label: 'Savings'  },
    credit:     { icon: '💳', color: '#ff453a', label: 'Credit'   },
    investment: { icon: '📈', color: '#2563eb', label: 'Invest'   },
    loan:       { icon: '🏠', color: '#ff9f0a', label: 'Loan'     },
    mortgage:   { icon: '🏠', color: '#ff9f0a', label: 'Mortgage' },
    other:      { icon: '🏦', color: '#636366', label: 'Account'  },
  };

  function _renderAccountPills() {
    const wrap  = document.getElementById('home-account-pills');
    const inner = document.getElementById('home-account-pills-inner');
    const dots  = document.getElementById('acct-dots');
    if (!wrap || !inner) return;

    if (!state.accounts.length) {
      wrap.style.display = 'none';
      if (dots) dots.style.display = 'none';
      return;
    }

    wrap.style.display = '';

    // ── Per-type visual theme (dark tinted bg + color accent) ─────────────────
    const _TYPE_THEME = {
      depository: { bg:'#060d1c', border:'rgba(55,138,221,0.22)',  accent:'#378ADD', iconBg:'rgba(55,138,221,0.14)',  iconBorder:'rgba(55,138,221,0.28)'  },
      savings:    { bg:'#071811', border:'rgba(29,158,117,0.22)',  accent:'#1D9E75', iconBg:'rgba(29,158,117,0.14)',  iconBorder:'rgba(29,158,117,0.28)'  },
      credit:     { bg:'#160708', border:'rgba(216,90,48,0.22)',   accent:'#D85A30', iconBg:'rgba(216,90,48,0.14)',   iconBorder:'rgba(216,90,48,0.28)'   },
      investment: { bg:'#0d0714', border:'rgba(96,165,250,0.22)', accent:'#60a5fa', iconBg:'rgba(96,165,250,0.14)', iconBorder:'rgba(96,165,250,0.28)' },
      loan:       { bg:'#160b03', border:'rgba(255,159,10,0.22)',  accent:'#FF9F0A', iconBg:'rgba(255,159,10,0.14)',  iconBorder:'rgba(255,159,10,0.28)'  },
      mortgage:   { bg:'#160b03', border:'rgba(255,159,10,0.22)',  accent:'#FF9F0A', iconBg:'rgba(255,159,10,0.14)',  iconBorder:'rgba(255,159,10,0.28)'  },
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

    inner.innerHTML = sortedAccts.map(acct => {
      const rawType   = acct.type || 'other';
      // Detect savings subtype within depository
      const isSavings = rawType === 'depository' &&
        (acct.subtype || '').toLowerCase().includes('saving');
      const type      = isSavings ? 'savings' : rawType;
      const theme     = _TYPE_THEME[type] || _TYPE_THEME.other;
      const icon      = _TYPE_ICONS[type]  || _TYPE_ICONS.other;
      // Use type (not rawType) so savings accounts get 'Savings' label, not 'Checking'
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
        <div style="width:36px;height:36px;border-radius:12px;background:rgba(37,99,235,0.12);display:flex;align-items:center;justify-content:center;color:#2563eb">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </div>
        <div style="font-size:11px;font-weight:700;color:#2563eb;letter-spacing:0.02em;text-align:center;line-height:1.3;margin-top:4px">Add<br>Bank</div>
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
        dots.innerHTML = `<span id="acct-dot-count" style="font-size:10px;font-weight:600;color:rgba(255,255,255,0.35);letter-spacing:0.06em;background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:20px">1 of ${total}</span>`;
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
     RENDER: CATEGORY SPENDING DONUT
     ───────────────────────────────────────────────────────────── */
  const _DONUT_COLORS = [
    '#1ac4f0','#2563eb','#34c759','#ff9f0a',
    '#ff453a','#bf5af2','#00c7be','#ffd60a',
  ];
  const _DONUT_CAT_ICONS = {
    Food:'🍔', Dining:'🍔', Restaurants:'🍔', Groceries:'🛒',
    Transport:'🚗', Transportation:'🚗', 'Gas & Fuel':'⛽',
    Shopping:'🛍️', Entertainment:'🎬', Health:'💊', Medical:'💊',
    Travel:'✈️', Utilities:'💡', Bills:'📄', Subscription:'📱',
    Personal:'💇', Education:'📚', Fitness:'💪',
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
      const rawCat = (t.category && t.category[0]) || t.category || '';
      const normalized = FCData.normalizePlaidCategory(rawCat).toLowerCase();
      // Exclude internal transfers and loan/credit card payments from spending analysis
      return !_TRANSFER_CATS.has(normalized) && !normalized.includes('transfer');
    });
    if (!monthTxns.length) { section.style.display = 'none'; return; }

    // Aggregate by normalized category
    const catMap = {};
    for (const t of monthTxns) {
      const rawCat = (t.category && t.category[0]) || t.category || 'Other';
      const cat = FCData.normalizePlaidCategory(rawCat);
      catMap[cat] = (catMap[cat] || 0) + (t.amount || 0);
    }
    let cats = Object.entries(catMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5); // top 5 + Other
    const totalSpend = cats.reduce((s, [, v]) => s + v, 0);
    if (totalSpend <= 0) { section.style.display = 'none'; return; }

    section.style.display = '';
    if (total) total.textContent = FCData.formatCurrency(totalSpend);

    // Build donut SVG — conic segments using SVG arcs
    const cx = 50, cy = 50, r = 38, inner = 24;
    const circumference = 2 * Math.PI * r;
    let svgHTML = '';
    let offset = 0;
    cats.forEach(([cat, amt], i) => {
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
    // Centre hole fill
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
          <span style="font-size:11px;font-weight:600;color:white;flex-shrink:0">${pct}%</span>
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

    if (!recent.length) {
      if (section) section.style.display = state.user?.plaid_linked ? '' : 'none';
      container.innerHTML = '<div style="color:var(--fc-text-faint);font-size:13px;padding:14px 0;text-align:center">No transactions yet</div>';
      return;
    }
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
        <div class="fc-home-txn" onclick="FCApp.switchTab('activity')" role="button" tabindex="0">
          <div class="fc-home-txn-icon" style="background:${esc(color)}22">${esc(emoji)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13.5px;font-weight:500;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
            <div style="font-size:11px;color:var(--fc-text-faint);margin-top:1px">${esc(cat)} · ${esc(dateStr)}</div>
          </div>
          <div style="font-size:14px;font-weight:700;flex-shrink:0;color:${isCredit ? 'var(--fc-success)' : 'rgba(255,255,255,0.85)'};font-variant-numeric:tabular-nums">${isCredit ? '+' : '−'}${FCData.formatCurrency(amt)}</div>
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
        body: `${overdue[0].name} was due ${FCData.daysUntil(overdue[0].due_date) * -1} days ago — don't let it hit your credit.`,
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
            : `${Math.round(pct * 100)}% of your monthly budget used with ${30 - now.getDate()} days left.`,
          action: 'Review spending',
          tap: () => FCApp.switchTab('insights')
        });
      }
    }

    // ── 4. Unusual large transaction in last 3 days ──────────────
    const cutoff3d = new Date(now.getTime() - 3 * 86400000);
    const recent   = txns.filter(t => !t.isCredit && FCData.parseDateLocal(t.date) >= cutoff3d);
    if (recent.length) {
      const amounts  = txns.filter(t => !t.isCredit && _isSpendTxn(t)).map(t => t.amount || 0);
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

  // Color config per insight type
  const _FOCUS_COLORS = {
    danger: { bar: '#ff453a', dot: '#ff453a', label: 'rgba(255,69,58,0.85)',  border: 'rgba(255,69,58,0.28)',  bg: 'rgba(255,69,58,0.08)'  },
    warn:   { bar: '#ff9f0a', dot: '#ff9f0a', label: 'rgba(255,159,10,0.85)', border: 'rgba(255,159,10,0.28)', bg: 'rgba(255,159,10,0.06)' },
    info:   { bar: '#2563eb', dot: '#60a5fa', label: 'rgba(96,165,250,0.85)', border: 'rgba(37,99,235,0.28)',  bg: 'rgba(37,99,235,0.06)'  },
    good:   { bar: '#34c759', dot: '#34c759', label: 'rgba(52,199,89,0.85)',  border: 'rgba(52,199,89,0.28)',  bg: 'rgba(52,199,89,0.06)'  },
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

    if (card)      { card.style.setProperty('--focus-border', c.border); card.querySelector('.dash-focus-card::before'); }
    if (leftBar)   leftBar.style.background = `linear-gradient(180deg, ${c.bar} 0%, ${c.bar}99 100%)`;
    if (dot)       { dot.style.background = c.dot; dot.style.animationName = 'none'; void dot.offsetWidth; dot.style.animationName = 'focusPulse'; }
    if (labelEl)   { labelEl.textContent = insight.label; labelEl.style.color = c.label; }
    if (bodyEl)    bodyEl.textContent = insight.body;
    if (actionText) actionText.style.color = c.label;
    if (actionText) actionText.textContent = insight.action;

    // Apply card background/border via inline style
    if (card) {
      card.style.background = c.bg;
      card.style.border     = `0.5px solid ${c.border}`;
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
    const abs = Math.abs(val);
    const sign = val < 0 ? '−$' : '$';
    if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 10000)   return sign + (abs / 1000).toFixed(1)    + 'K';
    return FCData.formatCurrency(val);
  }

  function _renderHome() {
    // Update island text based on bank link status
    if (state.user && !state.user.plaid_linked) {
      _setIslandText('Connect a bank to start');
    }

    // Streak chip on home header
    const streakChipEl = document.getElementById('streak-chip');
    if (streakChipEl && state.user) {
      const days = Math.max(1, state.user.streak || 1);
      streakChipEl.textContent = `Day ${days}`;
    }

    // Net worth
    const netWorth = FCData.calcNetWorth(state.accounts);
    const nwEl     = document.getElementById('hero-networth');
    if (nwEl) animateNumber(nwEl, netWorth, '$');

    // Assets vs Liabilities breakdown below net worth
    const assetsEl  = document.getElementById('hero-assets');
    const liabsEl   = document.getElementById('hero-liabilities');
    if (assetsEl || liabsEl) {
      const assets = state.accounts
        .filter(a => !['credit','loan','mortgage'].includes(a.type))
        .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
      const liabs = state.accounts
        .filter(a => ['credit','loan','mortgage'].includes(a.type))
        .reduce((s, a) => s + Math.abs(a.balance_current || a.balance || 0), 0);
      if (assetsEl) assetsEl.textContent = FCData.formatCurrency(assets);
      if (liabsEl)  liabsEl.textContent  = FCData.formatCurrency(liabs);
    }

    // Cash stat
    const cash   = FCData.calcCash(state.accounts);
    const cashEl = document.getElementById('stat-cash');
    if (cashEl) cashEl.textContent = _fmtCompact(cash);

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
        .slice(0, 3);

      if (!upcoming.length) {
        billsEl.innerHTML = '<div style="color:var(--fc-text-faint);font-size:13px;padding:12px 0">All clear — no upcoming bills.</div>';
      } else {
        const allUnpaid = state.bills.filter(b => b.status !== 'paid');
        billsEl.innerHTML = upcoming.map(b => {
          const days = FCData.daysUntil(b.due_date);
          const { label, color } = FCData.billDueLabelAndColor(days);
          const bg = b.color || FCData.categoryColor(b.category || 'Service');
          return `
            <div class="fc-list-item" style="cursor:pointer" onclick="FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')" role="button">
              <div class="fc-list-icon" style="background:${esc(bg)};color:white;font-weight:700;font-size:16px">
                ${esc(b.icon || b.name.charAt(0))}
              </div>
              <div class="fc-list-body">
                <div class="fc-list-title">${esc(b.name)}</div>
                <div class="fc-list-meta" style="color:${esc(color)};font-weight:${days !== null && days <= 1 ? 600 : 400}">${esc(label)}</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
                <div class="fc-list-amount">${FCData.formatCurrency(b.amount)}</div>
                <button
                  onclick="event.stopPropagation();FCApp.quickPayBill('${esc(b.id)}')"
                  style="width:28px;height:28px;border-radius:50%;background:rgba(52,199,89,0.12);border:1px solid rgba(52,199,89,0.3);color:var(--fc-success);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0"
                  title="Mark as paid" type="button" aria-label="Mark ${esc(b.name)} as paid">✓</button>
              </div>
            </div>`;
        }).join('') + (allUnpaid.length > 3
          ? `<div style="text-align:center;padding:10px 0 4px;cursor:pointer;color:var(--fc-accent);font-size:13px;font-weight:500" onclick="FCApp.switchTab('activity');FCApp.switchActivitySegment('bills')">See all ${allUnpaid.length} bills →</div>`
          : '');
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
    if (billsStatEl) billsStatEl.textContent = _fmtCompact(unpaidBillsTotal);
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

    // Quick-stat strip: income (period-aware)
    const qsIncome = document.getElementById('fch-qs-income');
    if (qsIncome) qsIncome.textContent = _fmtCompact(periodIncome);

    // Savings rate → NW footer
    const srEl = document.getElementById('fch-savings-rate');
    if (srEl) {
      if (monthIncome > 0) {
        const sr = Math.round(((monthIncome - monthSpend) / monthIncome) * 100);
        srEl.textContent = Math.max(0, sr) + '%';
        srEl.style.color = sr >= 20 ? '#34c759' : sr >= 10 ? '#ff9f0a' : '#ff453a';
      } else {
        srEl.textContent = '—';
        srEl.style.color = '';
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
            <circle cx="32" cy="32" r="27" stroke="rgba(255,255,255,0.08)" stroke-width="6" fill="none"/>
            <circle cx="32" cy="32" r="27" stroke="url(#ring)" stroke-width="6" fill="none"
                    stroke-dasharray="${dash}" stroke-dashoffset="${offset}"
                    stroke-linecap="round" transform="rotate(-90 32 32)"/>
          </svg>
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:white;font-size:13px;font-weight:700;line-height:1">${pct}%</div>
        </div>
        <div class="fc-grow">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span class="fc-eyebrow">Goal</span>
            <span style="color:${pct >= 100 ? 'var(--fc-success)' : pct >= 75 ? 'var(--fc-accent)' : pct >= 10 ? 'var(--fc-accent)' : 'var(--fc-text-faint)'};font-size:10px;font-weight:600">${pct >= 100 ? 'Complete 🎉' : pct >= 75 ? 'Almost there' : pct >= 10 ? 'In progress' : pct > 0 ? 'Just started' : 'New goal'}</span>
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

    // ── Financial Health Score ────────────────────────────────────
    const healthScore = _calcHealthScore(monthIncome, monthSpend, unpaidBillsTotal, overdueCount);
    _renderHomeHealthScore(healthScore, monthIncome, monthSpend, unpaidBillsTotal, overdueCount);

    // ── Credit Score card ────────────────────────────────────────
    _renderCreditScore();

    // ── 50/30/20 Budget Wizard ───────────────────────────────────
    _renderBudgetWizard(monthIncome, monthSpend);

    // ── Zombie Subscription Finder ────────────────────────────────
    _renderZombieSubscriptions();

    // ── Debt Payoff Planner ───────────────────────────────────────
    _renderDebtPayoffPlanner();

    // ── Cash Flow Forecast ────────────────────────────────────────
    _renderCashFlowForecast();

    // ── Net Worth Milestone ───────────────────────────────────────
    _renderNetWorthMilestone(netWorth);

    // ── Today's Focus card ────────────────────────────────────────
    _renderTodaysFocus();

    // ── Recent transactions preview ───────────────────────────────
    _renderRecentTransactions();

    // ── Spending bar chart (period-aware) ────────────────────────
    _renderSpendingChart();

    // ── Smart Insights ───────────────────────────────────────────
    _renderSmartInsights();

    // ── Net worth sparkline snapshot ─────────────────────────────
    _snapshotNetWorth(netWorth);

    // ── Safe to Spend card ───────────────────────────────────────
    const safeEl    = document.getElementById('stat-safe-to-spend');
    const metaEl    = document.getElementById('safe-spend-meta');
    const barEl     = document.getElementById('safe-spend-bar');
    const spentLbl  = document.getElementById('safe-spent-label');
    const billsLbl  = document.getElementById('safe-bills-label');

    // ── Account pills ──────────────────────────────────────────
    _renderAccountPills();

    if (state.user && state.user.plaid_linked) {
      const buffer        = cash * 0.10;
      const safeToSpend   = Math.max(0, cash - unpaidBillsTotal - buffer);

      // ── Greeting with safe-to-spend context ─────────────────
      _renderGreeting(safeToSpend);
      // Use raw spend (includes transfers/loan payments) for committed-vs-cash
      const committed     = monthSpendRaw + unpaidBillsTotal;
      // isOver: month spending has blown past the current cash balance
      const isOver        = cash > 0 && committed >= cash;

      // Bar: when not over, tracks committed-vs-cash; when over, stays solid red
      const barPct        = cash > 0 ? Math.min(Math.round((committed / cash) * 100), 100) : 100;
      const barColor      = isOver             ? 'var(--fc-danger)'
                          : barPct > 85        ? 'var(--fc-danger)'
                          : barPct > 65        ? 'var(--fc-warning)'
                          : 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))';

      // Card label flips when over: "Safe to Spend" → "Cash Balance"
      const cardLabelEl = document.getElementById('safe-spend-card-label');
      if (cardLabelEl) cardLabelEl.textContent = isOver ? 'Cash Balance' : 'Safe to Spend';

      // Value: when over, show real cash on hand; otherwise show safe-to-spend
      if (safeEl) animateNumber(safeEl, isOver ? Math.max(0, cash) : safeToSpend, '$');

      // Meta: context-appropriate message
      if (metaEl) metaEl.textContent = isOver
        ? 'Month spend exceeds cash on hand'
        : `${Math.round(barPct)}% of cash committed`;

      if (barEl)  { barEl.style.width = barPct + '%'; barEl.style.background = barColor; }

      // ── Circular ring — update percentage and color ──────────
      const ringCircle = document.getElementById('safe-spend-ring');
      const ringPctEl  = document.getElementById('safe-spend-ring-pct');
      if (ringCircle) {
        const circumference = 201;
        const ringOffset    = circumference - (circumference * barPct / 100);
        ringCircle.style.strokeDashoffset = ringOffset;
        ringCircle.style.stroke = isOver || barPct > 85 ? '#ff453a'
                                : barPct > 65           ? '#ffb020'
                                : 'url(#safeGrad)';
      }
      if (ringPctEl) ringPctEl.textContent = barPct + '%';

      // SPENT label shows filtered month spend (no transfers)
      if (spentLbl) spentLbl.textContent = FCData.formatCurrency(monthSpend);
      if (billsLbl) billsLbl.textContent = FCData.formatCurrency(unpaidBillsTotal);
    } else {
      _renderGreeting(null);
      if (safeEl)   safeEl.textContent  = '—';
      if (metaEl)   metaEl.textContent  = 'Connect a bank';
      if (barEl)    barEl.style.width   = '0%';
      if (spentLbl) spentLbl.textContent = '$0';
      if (billsLbl) billsLbl.textContent = '$0';
    }
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: ACTIVITY
     ───────────────────────────────────────────────────────────── */

  function _renderActivity() {
    const container = document.getElementById('activity-list');
    if (!container) return;

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
      ? base.filter(t => t.name && t.name.toLowerCase().includes(state.searchQuery.toLowerCase()))
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
        const cat    = FCData.normalizePlaidCategory(rawCat);
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
    const txns     = (state.transactions || []).filter(t => FCData.isCurrentMonth && FCData.isCurrentMonth(t.date));
    const budget   = state.monthlyBudget || 3000;

    // ── 1. Spending Score (0-34) ──────────────────────────────
    const spent    = txns.filter(t => !t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);
    const spendRatio = budget > 0 ? spent / budget : 1;
    let spendScore = Math.round(34 * Math.max(0, Math.min(1, 1 - (spendRatio - 0.5) * 2)));
    // Perfect if under 75% of budget, 0 if over 150%
    if (spendRatio <= 0.75) spendScore = 34;
    else if (spendRatio >= 1.5) spendScore = 0;
    else spendScore = Math.round(34 * (1.5 - spendRatio) / 0.75);

    // ── 2. Savings Score (0-33) ───────────────────────────────
    const income   = txns.filter(t => t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);
    const savingsRate = income > 0 ? (income - spent) / income : 0;
    const savingsAccts = accts.filter(a => a.type === 'depository');
    const totalSavings = savingsAccts.reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
    let savingsScore = 0;
    if (savingsRate >= 0.2) savingsScore = 33;
    else if (savingsRate > 0) savingsScore = Math.round(33 * (savingsRate / 0.2));
    // Boost if savings balance > 1 month of income
    if (totalSavings > income && income > 0) savingsScore = Math.min(33, savingsScore + 8);

    // ── 3. Net Worth Score (0-33) ─────────────────────────────
    const assets = accts
      .filter(a => a.type === 'depository' || a.type === 'investment' || a.type === 'brokerage')
      .reduce((s, a) => s + (a.balance_current || a.balance || 0), 0);
    const debts  = accts
      .filter(a => a.type === 'credit' || a.type === 'loan')
      .reduce((s, a) => s + Math.abs(a.balance_current || a.balance || 0), 0);
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
    if (spendRatio > 0.9)    tips.push('You\'re close to your monthly budget — ease up on discretionary spending.');
    if (savingsRate < 0.1)   tips.push('Try saving at least 10% of income. Even small amounts compound over time.');
    if (nw < 0)              tips.push('Your liabilities exceed your assets. Paying down high-interest debt first will help.');
    if (!tips.length)        tips.push('You\'re on track! Keep maintaining your current habits to keep your score growing.');

    // Animate ring
    const circumference = 226;
    const offset = hasData ? circumference * (1 - total / 100) : circumference;
    ring.style.strokeDashoffset = offset;

    // Color ring by score
    ring.style.stroke = total >= 70 ? '#1ac4f0' : total >= 50 ? '#ff9f0a' : '#ff3b30';

    gradeEl.textContent  = hasData ? gradeMap[0] : '—';
    scoreEl.textContent  = hasData ? total        : 'Score';

    // Sub-metric bars (normalize to 0-100 for display)
    const setBar = (barId, valId, score, max, color) => {
      const bar = document.getElementById(barId);
      const val = document.getElementById(valId);
      if (bar) { bar.style.width = Math.round(score / max * 100) + '%'; bar.style.background = color; }
      if (val)   val.textContent = Math.round(score / max * 100);
    };
    setBar('ins-bar-spending', 'ins-val-spending', spendScore, 34, spendScore >= 25 ? 'linear-gradient(90deg,#1ac4f0,#2563eb)' : 'linear-gradient(90deg,#ff9f0a,#ff6b00)');
    setBar('ins-bar-savings',  'ins-val-savings',  savingsScore, 33, 'linear-gradient(90deg,#34c759,#1ac4f0)');
    setBar('ins-bar-networth', 'ins-val-networth', nwScore, 33, nwScore >= 20 ? 'linear-gradient(90deg,#ff9f0a,#2563eb)' : 'linear-gradient(90deg,#ff3b30,#ff9f0a)');

    // Tip
    if (tipEl) {
      tipEl.textContent = tips[0];
      tipEl.style.display = 'block';
    }

    // Subtitle
    const sub = document.getElementById('ins-health-subtitle');
    if (sub) sub.textContent = hasData ? `${total}/100 — ${gradeMap[1]}` : 'Connect a bank to see your score';
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: INSIGHTS
     ───────────────────────────────────────────────────────────── */

  function _renderInsights() {
    // Render health score first (no data dep — uses state directly)
    _renderHealthScore();

    const container = document.getElementById('insights-categories');
    if (!container) return;

    // ── Period-aware transactions ─────────────────────────────────
    // Insights respond to the global period selector (same as home screen)
    const periodTxns  = _getPeriodTxns();
    const periodLabel = _PERIOD_LABELS[state.period] || 'this month';

    // Exclude transfers & loan payments from spending so they don't pollute categories/totals
    const _SPEND_SKIP = new Set(['transfer', 'loan', 'loan payments', 'credit card payment', 'transfer in', 'transfer out']);
    const periodSpendTxns = periodTxns.filter(t => {
      if (t.isCredit) return false;
      const raw = (t.category && t.category[0]) || t.category || '';
      const norm = FCData.normalizePlaidCategory(raw).toLowerCase();
      return !_SPEND_SKIP.has(norm) && !norm.includes('transfer');
    });
    const periodSpend  = periodSpendTxns.reduce((s, t) => s + (t.amount || 0), 0);
    const periodIncome = periodTxns.filter(_isIncomeTxn).reduce((s, t) => s + (t.amount || 0), 0);

    // Update the insights period labels
    const insightsPeriodEl = document.getElementById('insights-period-label');
    if (insightsPeriodEl) insightsPeriodEl.textContent = periodLabel;
    const insightsCatPeriod = document.getElementById('insights-cat-period');
    if (insightsCatPeriod) insightsCatPeriod.textContent = periodLabel;

    // ── Spend delta vs previous period ────────────────────────────
    const spendDeltaEl = document.getElementById('insights-spend-delta');
    if (spendDeltaEl) {
      if (state.period === '1M' && state.transactions && state.transactions.length) {
        const now = new Date();
        const lmStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lmEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
        const lastMoSpend = state.transactions
          .filter(t => !t.isCredit)
          .filter(t => { const d = FCData.parseDateLocal(t.date || t.authorized_date); return d >= lmStart && d <= lmEnd; })
          .reduce((s, t) => s + (t.amount || 0), 0);
        if (lastMoSpend > 0) {
          const delta = periodSpend - lastMoSpend;
          const pct   = Math.round(Math.abs(delta) / lastMoSpend * 100);
          spendDeltaEl.style.display    = '';
          spendDeltaEl.textContent      = delta >= 0 ? `+${pct}% vs last mo` : `−${pct}% vs last mo`;
          spendDeltaEl.style.background = delta >= 0 ? 'rgba(255,69,58,0.12)' : 'rgba(52,199,89,0.12)';
          spendDeltaEl.style.color      = delta >= 0 ? 'var(--fc-danger)' : 'var(--fc-success)';
          spendDeltaEl.style.border     = delta >= 0 ? '1px solid rgba(255,69,58,0.25)' : '1px solid rgba(52,199,89,0.25)';
        } else {
          spendDeltaEl.style.display = 'none';
        }
      } else {
        spendDeltaEl.style.display = 'none';
      }
    }

    // ── Budget progress card ──────────────────────────────────────
    const budgetLimit  = state.budgets && state.budgets['total'] ? state.budgets['total'].limit : 3000;
    // budgetLimit used locally — accessed via FCApp.getTotalBudgetLimit() for the static Edit button in index.html
    const budgetPct    = Math.min(Math.round((periodSpend / budgetLimit) * 100), 100);
    const budgetColor  = budgetPct > 90 ? 'var(--fc-danger)'
                       : budgetPct > 70 ? 'var(--fc-warning)'
                       : 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))';

    const pillEl = document.getElementById('insights-budget-pill');
    if (pillEl) {
      pillEl.textContent = `${FCData.formatCurrency(periodSpend)} / ${FCData.formatCurrency(budgetLimit)}`;
      pillEl.style.background = budgetPct > 90 ? 'rgba(255,69,58,0.15)'
                              : budgetPct > 70 ? 'rgba(255,159,10,0.15)'
                              : 'rgba(26,196,240,0.12)';
      pillEl.style.color = budgetPct > 90 ? 'var(--fc-danger)'
                         : budgetPct > 70 ? 'var(--fc-warning)'
                         : 'var(--fc-accent)';
    }
    const budgetBarEl = document.getElementById('insights-budget-fill');
    if (budgetBarEl) { budgetBarEl.style.width = budgetPct + '%'; budgetBarEl.style.background = budgetColor; }
    const remEl = document.getElementById('insights-budget-remaining');
    const remaining = Math.max(0, budgetLimit - periodSpend);
    if (remEl) {
      remEl.textContent = periodSpend > budgetLimit
        ? `${FCData.formatCurrency(periodSpend - budgetLimit)} over budget`
        : `${FCData.formatCurrency(remaining)} remaining`;
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
          const spent = periodSpendTxns.filter(t => ((t.category && t.category[0]) || '') === cat).reduce((s, t) => s + t.amount, 0);
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

    const donutSvg      = document.getElementById('insights-donut-svg');
    const donutCenterEl = document.getElementById('insights-donut-center-amt');
    const donutLegend   = document.getElementById('insights-donut-legend');

    if (!periodSpendTxns.length) {
      container.innerHTML = `<div style="color:var(--fc-text-faint);text-align:center;padding:32px 0;font-size:14px">No spending data for ${periodLabel}</div>`;
      if (donutSvg)    donutSvg.innerHTML = '<circle cx="60" cy="60" r="46" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="16"/>';
      if (donutCenterEl) donutCenterEl.textContent = '—';
      if (donutLegend) donutLegend.innerHTML = '';
    } else {
      const catMap = {};
      for (const t of periodSpendTxns) {
        const rawCat = (t.category && t.category[0]) || t.category || 'Other';
        const cat = FCData.normalizePlaidCategory(rawCat);
        catMap[cat] = (catMap[cat] || 0) + t.amount;
      }
      const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 6);

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
            ? `<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:99px;background:rgba(255,69,58,0.15);color:var(--fc-danger);white-space:nowrap">OVER</span>`
            : budPct > 80
              ? `<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:99px;background:rgba(255,159,10,0.15);color:var(--fc-warning);white-space:nowrap">${budPct}%</span>`
              : `<span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:99px;background:rgba(52,199,89,0.12);color:var(--fc-success);white-space:nowrap">${budPct}%</span>`
          : `<span style="font-size:9px;font-weight:500;padding:2px 6px;border-radius:99px;background:rgba(255,255,255,0.06);color:var(--fc-text-faint);cursor:pointer;white-space:nowrap" onclick="event.stopPropagation();FCApp.openCategoryBudgetSheet('${esc(cat)}',0)">+ Budget</span>`;
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
              <div style="font-size:14px;font-weight:500;color:white">${esc(cat)}</div>
              ${budSubline ? `<div style="margin-top:1px">${budSubline}</div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
              <span style="font-size:14px;font-weight:700;color:${isOver ? 'var(--fc-danger)' : 'white'}">${FCData.formatCurrency(amount)}</span>
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
          <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
            <div style="width:38px;text-align:center">
              <div style="font-size:10px;color:var(--fc-text-faint);font-weight:500">${label}</div>
              <div style="font-size:15px;font-weight:700;color:white">${d.getDate()}</div>
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
        if (card) card.style.display = 'none';
        return;
      }
      if (card) card.style.display = '';
      const maxMerchant = top[0][1].total;

      list.innerHTML = top.map(([name, data], i) => {
        const pct  = Math.round((data.total / maxMerchant) * 100);
        const col  = FCData.categoryColor('Shopping'); // use neutral color for merchants
        const cols = ['#1ac4f0','#2563eb','#ff6b35','#f093fb','#43e97b'];
        const barColor = cols[i] || '#1ac4f0';
        const shortName = name.length > 22 ? name.substring(0, 22) + '…' : name;
        return `
          <div style="margin-bottom:10px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:13px;font-weight:500;color:white">${shortName}</span>
              <div style="text-align:right;flex-shrink:0;margin-left:8px">
                <span style="font-size:13px;font-weight:700;color:white">${FCData.formatCurrency(data.total)}</span>
                <span style="font-size:11px;color:var(--fc-text-faint);margin-left:5px">${data.count}×</span>
              </div>
            </div>
            <div style="height:4px;background:rgba(255,255,255,0.07);border-radius:99px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${barColor};border-radius:99px;transition:width 0.4s ease"></div>
            </div>
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
          <div class="fc-list-item" style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.04)">
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
        const nwKey   = _nwHistoryKey();
        const history = JSON.parse((nwKey && localStorage.getItem(nwKey)) || '{}');
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
        const color  = delta >= 0 ? '#1ac4f0' : '#ff453a';

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
          nwDelta.style.display    = '';
          nwDelta.textContent      = (delta >= 0 ? '+' : '') + FCData.formatCurrency(delta);
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

    if (periodIncome > 0) {
      const netFlow     = periodIncome - periodSpend;
      const savingsRate = Math.max(0, Math.round((netFlow / periodIncome) * 100));
      const rateColor   = savingsRate >= 20 ? 'var(--fc-success)'
                        : savingsRate >= 10 ? 'var(--fc-accent)'
                        : 'var(--fc-warning)';
      const rateIcon    = savingsRate >= 20 ? '🔥' : savingsRate >= 10 ? '📈' : '⚠️';

      // Two-column layout: just the % + icon (no long label)
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
      if (savingsMetaEl) savingsMetaEl.textContent = 'Link your accounts to track savings';
    }
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
        <div style="height:3px;background:rgba(255,255,255,0.07);border-radius:99px;overflow:hidden;margin-bottom:3px">
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
      container.innerHTML = state.goals.map(g => {
        const pct     = Math.min(g.pct || 0, 100);
        const dash    = 170;
        const offset  = dash - (dash * pct / 100);
        const color   = pct >= 100 ? 'var(--fc-success)' : 'url(#ring-gradient)';
        const statusColor = pct >= 100 ? 'var(--fc-success)' : pct >= 75 ? 'var(--fc-accent)' : 'var(--fc-text-faint)';
        const statusLabel = pct >= 100 ? 'COMPLETE' : pct >= 75 ? 'ALMOST' : pct > 0 ? 'ON TRACK' : 'NOT STARTED';
        return `
          <div class="fc-goal-card" style="cursor:pointer" onclick="FCApp.editGoal('${esc(g.id)}')" role="button">
            <div style="width:56px;height:56px;position:relative;flex-shrink:0">
              <svg width="56" height="56" viewBox="0 0 64 64" aria-label="${pct}%">
                <defs>
                  <linearGradient id="ring-gradient" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="#1ac4f0"/><stop offset="100%" stop-color="#60a5fa"/>
                  </linearGradient>
                </defs>
                <circle cx="32" cy="32" r="27" stroke="rgba(255,255,255,0.08)" stroke-width="6" fill="none"/>
                <circle cx="32" cy="32" r="27" stroke="${color}" stroke-width="6" fill="none"
                        stroke-dasharray="${dash}" stroke-dashoffset="${offset}"
                        stroke-linecap="round" transform="rotate(-90 32 32)"/>
              </svg>
              <div style="position:absolute;inset:0;display:grid;place-items:center;color:white;font-size:12px;font-weight:700">${pct}%</div>
            </div>
            <div class="fc-grow">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                <span style="color:${statusColor};font-size:10px;font-weight:600;letter-spacing:0.05em">${statusLabel}</span>
              </div>
              <div class="fc-h3" style="font-size:15px;margin-bottom:3px">${esc(g.name)}</div>
              <div class="fc-xs">${FCData.formatCurrency(g.current || 0)} of ${FCData.formatCurrency(g.target)}</div>
              ${(() => {
                if (!g.target_date) return '';
                const remaining = Math.max(0, (g.target || 0) - (g.current || 0));
                const months    = Math.max(1, Math.ceil((FCData.parseDateLocal(g.target_date) - new Date()) / (1000 * 60 * 60 * 24 * 30.44)));
                const monthly   = remaining / months;
                const dateLabel = FCData.parseDateLocal(g.target_date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                return `<div style="font-size:11px;color:var(--fc-accent);margin-top:2px">${FCData.formatCurrency(monthly)}/mo · ${dateLabel}</div>`;
              })()}
              <div class="fc-progress-bar" style="margin-top:8px">
                <div class="fc-progress-fill" style="width:${pct}%;background:${pct >= 100 ? 'var(--fc-success)' : 'linear-gradient(90deg,var(--fc-accent),var(--fc-electric))'}"></div>
              </div>
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
      .reduce((s, a) => s + Math.abs(a.balance_current || a.balance || 0), 0);
    const nw = assets - liabilities;

    const nwEl = document.getElementById('wealth-hero-nw');
    const asEl = document.getElementById('wealth-hero-assets');
    const liEl = document.getElementById('wealth-hero-liabilities');
    const dlEl = document.getElementById('wealth-hero-delta');

    if (nwEl) nwEl.textContent = FCData.formatCurrency(nw);
    if (asEl) asEl.textContent = FCData.formatCurrency(assets);
    if (liEl) liEl.textContent = FCData.formatCurrency(liabilities);

    // Delta vs last month NW history if available
    if (dlEl) {
      const hist = state.netWorthHistory || [];
      if (hist.length >= 2) {
        const prev = hist[hist.length - 2]?.nw ?? 0;
        const delta = nw - prev;
        const sign  = delta >= 0 ? '+' : '−';
        const color = delta >= 0 ? 'rgba(52,199,89,0.15)' : 'rgba(255,69,58,0.12)';
        const textColor = delta >= 0 ? 'var(--fc-success)' : 'var(--fc-danger)';
        dlEl.innerHTML = `<span>${sign}${FCData.formatCurrency(Math.abs(delta))}</span><span style="font-weight:500;color:rgba(255,255,255,0.4)">vs last month</span>`;
        dlEl.style.cssText += `;background:${color};color:${textColor}`;
        dlEl.style.display = 'inline-flex';
      }
    }
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
        <div class="fc-card" style="margin:0 16px 4px;padding:18px;background:linear-gradient(135deg,rgba(26,196,240,0.1),rgba(37,99,235,0.1))">
          <div class="fc-eyebrow">Total Savings</div>
          <div style="font-size:32px;font-weight:800;letter-spacing:-0.03em;color:white;margin-top:2px">${FCData.formatCurrency(total)}</div>
          <div style="font-size:12px;color:var(--fc-text-faint);margin-top:4px">${savingsAccts.length} account${savingsAccts.length !== 1 ? 's' : ''}</div>
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

    list.innerHTML = savingsAccts.map(a => {
      const bal  = a.balance_current || a.balance || 0;
      const icon = _accountIcon(a);
      const inst = _acctSubtext(a);
      return `<div class="fc-acct-card">
        <div class="fc-acct-icon">${icon}</div>
        <div class="fc-acct-info">
          <div class="fc-acct-name">${a.name || 'Account'}</div>
          ${inst ? `<div class="fc-acct-bank">${inst}</div>` : ''}
        </div>
        <div class="fc-acct-bal fc-amount">${FCData.formatCurrency(bal)}</div>
      </div>`;
    }).join('');
  }

  function _renderDebt() {
    const allAccts  = state.accounts || [];
    const debtAccts = allAccts.filter(a => {
      const type = (a.type    || '').toLowerCase();
      const sub  = (a.subtype || '').toLowerCase();
      return type === 'credit' || type === 'loan' ||
             ['credit card', 'line of credit', 'mortgage', 'auto', 'student', 'home equity'].includes(sub);
    });

    const totalDebt = debtAccts.reduce((s, a) => s + Math.abs(a.balance_current || a.balance || 0), 0);
    const creditCards = debtAccts.filter(a => a.type === 'credit' || (a.subtype || '').toLowerCase() === 'credit card');
    const totalLimit  = creditCards.reduce((s, a) => s + (a.balance_limit || a.balances?.limit || 0), 0);
    const totalUsed   = creditCards.reduce((s, a) => s + Math.abs(a.balance_current || a.balance || 0), 0);
    const utilPct     = totalLimit > 0 ? Math.round((totalUsed / totalLimit) * 100) : 0;

    const summaryEl = document.getElementById('debt-summary');
    if (summaryEl) {
      const utilColor = utilPct > 30 ? 'var(--fc-danger)' : utilPct > 10 ? 'var(--fc-warning)' : 'var(--fc-success)';
      summaryEl.innerHTML = `
        <div class="fc-card" style="margin:0 16px 4px;padding:18px;background:linear-gradient(135deg,rgba(255,69,58,0.1),rgba(37,99,235,0.08))">
          <div class="fc-eyebrow">Total Debt</div>
          <div class="fc-amount" style="font-size:32px;font-weight:800;letter-spacing:-0.03em;color:white;margin-top:2px">−${FCData.formatCurrency(totalDebt)}</div>
          ${totalLimit > 0 ? `
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--fc-text-faint);margin-bottom:5px">
              <span>Credit Utilization</span>
              <span style="color:${utilColor};font-weight:600">${utilPct}%</span>
            </div>
            <div class="fc-util-bar"><div class="fc-util-fill" style="width:${Math.min(utilPct, 100)}%;background:${utilColor}"></div></div>
            <div style="font-size:11px;color:var(--fc-text-faint);margin-top:5px">Keep below 30% for a healthy credit score</div>
          </div>` : ''}
        </div>`;
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
      const inst  = a.institution_name || a.official_name || (a.manual ? 'Manual entry' : '');
      return `<div class="fc-acct-card">
        <div class="fc-acct-icon">${icon}</div>
        <div class="fc-acct-info">
          <div class="fc-acct-name">${a.name || 'Account'}</div>
          ${inst ? `<div class="fc-acct-bank">${inst}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div class="fc-acct-bal fc-amount" style="color:var(--fc-danger)">−${FCData.formatCurrency(bal)}</div>
          ${util !== null ? `<div style="font-size:10px;color:${uColor};margin-top:2px">${util}% used</div>` : ''}
        </div>
      </div>`;
    }).join('');
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

    const nameEl  = document.getElementById('settings-name');
    const emailEl = document.getElementById('settings-email');
    const initEl  = document.getElementById('settings-avatar');
    const displayName = user.name || user.displayName || 'User';
    const displayEmail = user.email || FCAuth.currentUser()?.email || '';
    if (nameEl)  nameEl.textContent  = displayName;
    if (emailEl) emailEl.textContent = displayEmail;
    if (initEl)  initEl.textContent  = displayName.charAt(0).toUpperCase();

    // Biometric toggle
    FCAuth.isBiometricEnabled().then(enabled => {
      const toggle = document.getElementById('toggle-biometric');
      if (toggle) toggle.classList.toggle('on', enabled);
    });

    // Notification toggle
    const notifToggle = document.getElementById('toggle-notifications');
    if (notifToggle) notifToggle.classList.toggle('on', user.notifications_enabled !== false);

    // Institution
    const institutionEl = document.getElementById('settings-institution');
    if (institutionEl) institutionEl.textContent = _cleanInstitutionName(user.plaid_institution || '') || 'Not connected';

    // Streak — minimum Day 1 (new users always get credit for showing up)
    const streakDays = Math.max(1, user.streak || 1);
    const streakEl   = document.getElementById('settings-streak');
    if (streakEl) streakEl.textContent = `Day ${streakDays} streak 🔥`;

    // Pro badge in new profile card
    const proBadge = document.getElementById('settings-pro-badge');
    const isPro    = user.is_pro || user.pro;
    if (proBadge) {
      proBadge.textContent = isPro ? 'Pro ✓' : 'Free';
      proBadge.style.cssText = isPro
        ? 'font-size:10px;padding:4px 10px;background:rgba(26,196,240,0.15);color:#1ac4f0;border:0.5px solid rgba(26,196,240,0.25);border-radius:999px'
        : 'font-size:10px;padding:4px 10px;background:rgba(255,159,10,0.12);color:#ff9f0a;border:0.5px solid rgba(255,159,10,0.25);border-radius:999px';
    }

    // Pro row — show status + cancel option for Pro users
    const proRow  = document.getElementById('settings-pro-row');
    const proPill = document.getElementById('settings-pro-pill');
    if (proPill) {
      proPill.textContent = isPro ? 'Manage' : 'Upgrade →';
      proPill.style.cssText = isPro
        ? 'font-size:10px;padding:3px 8px;background:rgba(26,196,240,0.12);color:var(--fc-accent);border-radius:999px'
        : 'font-size:10px;padding:3px 8px;background:rgba(255,159,10,0.12);color:#ff9f0a;border-radius:999px';
    }
    if (proRow) {
      proRow.onclick = isPro ? () => _openCancelSheet() : () => showPaywall();
    }

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

    // Cancel subscription row — only shown for Pro users
    const cancelRow = document.getElementById('settings-cancel-sub-row');
    if (cancelRow) cancelRow.style.display = isPro ? 'flex' : 'none';
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
    const _idleText = () => (state.user && state.user.plaid_linked) ? 'All caught up' : 'Connect a bank to start';

    // Fade island text to "Syncing…" without jarring jump
    const islandText = document.getElementById('islandText');
    if (islandText) {
      islandText.classList.add('fc-fade');
      setTimeout(() => {
        islandText.textContent = 'Syncing…';
        islandText.classList.remove('fc-fade');
      }, 200);
    }

    try {
      await FCData.syncTransactions();
      state.lastSyncAt = Date.now();
      _syncSucceeded = true;
      haptic('light');
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
    // Free plan: 1 bank only. Show the paywall instead of opening Plaid Link
    // when a free user tries to add a second bank (bug #9).
    if (state.user?.plaid_linked && !_isPro()) {
      showPaywall();
      return;
    }
    const btn = document.getElementById('btn-plaid-link');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }

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
      // Only consult RC if it's already configured — don't await configure() here
      // because it can hang on a cold device and delay the user seeing their data.
      const _isProAfterLink = FCPurchases.isConfigured()
        ? await FCPurchases.checkProStatus().catch(() => false)
        : false;
      if (!_isProAfterLink) {
        setTimeout(() => showPaywall(), 500);
      }
    } catch (err) {
      if (err.message !== 'cancelled') {
        toast('Could not connect bank: ' + err.message, 'error');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Connect Bank Account'; }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     AUTH FLOWS
     ───────────────────────────────────────────────────────────── */

  async function handleLogin(email, password) {
    _setLoading('btn-login', true, 'Signing in…');
    _clearError('login-error');
    try {
      await FCAuth.signIn(email, password);
      // Auth observer will handle screen transition
    } catch (err) {
      _showError('login-error', _friendlyAuthError(err));
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
      // Sign out any cached session first — prevents onAuthStateChanged firing
      // with the OLD user before signUp completes and routing a new registrant
      // straight to the existing account's home screen.
      try { FCData.detachAllListeners(); _listenersAttached = false; await FCAuth.signOut(); } catch (_) {}
      // Flag: auth observer will route this new user to Face ID setup first
      window._fcNewUserFaceIdPending = true;
      await FCAuth.signUp(name, email, password, referralCode);
      // Clear any stale RevenueCat pro cache from a previous test session
      // so the paywall always shows correctly for brand-new accounts.
      try { localStorage.removeItem('fc_pro_status_v1'); } catch (_) {}
      // Fire welcome email — non-blocking, never delays onboarding
      _sendWelcomeEmail().catch(() => {});
      // Apply referral code on the backend — non-blocking, never delays onboarding
      if ((referralCode || '').trim()) _applyReferralCode(referralCode.trim()).catch(() => {});
      // Auth observer will route to faceid-setup → onboarding
    } catch (err) {
      window._fcNewUserFaceIdPending = false; // clear on error
      _showError('register-error', _friendlyAuthError(err));
      haptic('heavy');
    } finally {
      _setLoading('btn-register', false, 'Start Free Trial');
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
    const confirmed = await _confirmDialog('Sign out', 'Are you sure you want to sign out?');
    if (!confirmed) return;

    // Stop idle timer immediately
    clearTimeout(_idleTimer);

    FCData.detachAllListeners();
    if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('signed_out');
    if (window.Sentry) Sentry.setUser(null);
    await FCAuth.signOut();
    if (typeof FCAnalytics !== 'undefined') FCAnalytics.reset();
    _wipeUserState();
    setScreen('login');
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

  function _confirmDialog(title, message) {
    // Native confirm on web; could be replaced with a custom modal
    return Promise.resolve(window.confirm(title + '\n\n' + message));
  }

  /** Mark onboarding as complete in Firestore (called on skip or bank connect) */
  async function _markOnboardingComplete() {
    try {
      const uid = FCAuth.currentUser && FCAuth.currentUser()?.uid;
      const db  = FCAuth.db && FCAuth.db();
      if (uid && db) {
        await db.collection('users').doc(uid).update({ onboarding_complete: true });
      }
    } catch (_) {}
  }

  /**
   * Face ID setup screen — user tapped "Enable Face ID".
   * Requests biometric enrollment via Capacitor, then routes to onboarding.
   */
  async function handleBiometricSetup() {
    try {
      if (FCAuth.setBiometricEnabled) await FCAuth.setBiometricEnabled(true);
      haptic('medium');
    } catch (_) {
      // Biometrics unavailable on this device — silently skip
    }
    setScreen('onboarding');
  }

  /** User tapped "Not now" on the Face ID setup screen. */
  function skipFaceIdSetup() {
    try {
      if (FCAuth.setBiometricEnabled) FCAuth.setBiometricEnabled(false).catch(() => {});
    } catch (_) {}
    setScreen('onboarding');
  }

  /**
   * "Start 7-Day Free Trial" on the onboarding paywall slide (slide 5).
   * Routes to the full paywall screen which handles RevenueCat, plan selection,
   * trial offer, success overlays, and Firestore writes — no duplication needed.
   */
  function startTrialFromOnboarding() {
    haptic('medium');
    // Pre-select whichever plan the user picked on the onboarding slide
    _selectedPlan = window._obSelectedPlan || 'monthly';
    showPaywall();
  }

  /** User tapped "Skip for now" on the last onboarding slide */
  let _skippingOnboarding = false;
  async function skipOnboarding() {
    if (_skippingOnboarding) return;         // debounce: ignore rapid double-taps
    _skippingOnboarding = true;
    haptic('light');

    // Mark onboarding complete (best-effort — never block navigation on this)
    _markOnboardingComplete().catch(() => {});

    // Show paywall immediately — don't await any RevenueCat calls here because
    // configure() can hang on a cold-start device and trap the user.
    // The paywall's _loadPaywallOfferings() handles RC async on its own.
    // For the rare case the user is already Pro (e.g. reinstall), they can
    // tap "Restore Purchase" on the paywall and skip straight into the app.
    const _cachedPro = FCPurchases.isConfigured()
      ? await FCPurchases.checkProStatus().catch(() => false)
      : false;

    if (_cachedPro) {
      setScreen('app');
      _renderHome();
      setTimeout(() => _doSync(false), 800);
    } else {
      showPaywall();
    }

    setTimeout(() => { _skippingOnboarding = false; }, 1500);
  }

  /* ─────────────────────────────────────────────────────────────
     EMAIL VERIFICATION (verify-email screen)
     ───────────────────────────────────────────────────────────── */

  /** "I've Verified My Email" — reloads the Firebase user and checks emailVerified */
  async function handleVerifyEmailCheck() {
    const btn    = document.getElementById('btn-verify-continue');
    const errEl  = document.getElementById('verify-email-err');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      const freshUser = await FCAuth.reloadUser();
      if (freshUser && freshUser.emailVerified) {
        window._fcVerifyEmailPending = false;
        haptic('success');
        setScreen('faceid-setup');
      } else {
        if (errEl) {
          errEl.textContent = 'Email not verified yet. Tap the link in your inbox, then try again.';
          errEl.style.display = '';
        }
        haptic('heavy');
      }
    } catch (err) {
      if (errEl) { errEl.textContent = 'Something went wrong. Please try again.'; errEl.style.display = ''; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "I've Verified My Email"; }
    }
  }

  /** "Resend Email" button — sends a new verification email with a 60s cooldown */
  async function resendVerificationEmail() {
    const btn = document.getElementById('btn-resend-verify');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const user = FCAuth.currentUser && FCAuth.currentUser();
      if (user) await user.sendEmailVerification();
      toast('Verification email sent!', 'success');
      let secs = 60;
      const iv = setInterval(() => {
        if (!btn) { clearInterval(iv); return; }
        secs--;
        if (secs <= 0) { clearInterval(iv); btn.disabled = false; btn.textContent = 'Resend Email'; return; }
        btn.textContent = 'Resend in ' + secs + 's';
      }, 1000);
    } catch (_) {
      toast('Could not resend. Try again in a moment.', 'error');
      if (btn) { btn.disabled = false; btn.textContent = 'Resend Email'; }
    }
  }

  /** "Skip for now" — proceeds to Face ID setup without requiring verification */
  function skipEmailVerification() {
    window._fcVerifyEmailPending = false;
    haptic('light');
    setScreen('faceid-setup');
  }

  /* ─────────────────────────────────────────────────────────────
     TOGGLE CONTROLS (Settings)
     ───────────────────────────────────────────────────────────── */

  async function toggleBiometric(enable) {
    const toggleEl = document.getElementById('toggle-biometric');
    function snapBack() {
      // Toggle uses .on class, not a checkbox
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
      await FCAuth.setBiometricEnabled(enable);
      await FCData.updateUserField('biometric_enabled', enable);
      toast(enable ? 'Face ID enabled' : 'Face ID disabled', 'success');
    } catch (err) {
      console.error('[toggleBiometric]', err.message);
      toast('Could not update Face ID setting', 'error');
      snapBack();
    }
  }

  async function toggleNotifications(enable) {
    if (enable) {
      const granted = await FCPush.requestAndRegister();
      if (!granted) {
        toast('Notifications blocked — enable in iOS Settings', 'info');
        // Deep-link to iOS Settings so user can enable manually
        try {
          const App = window.Capacitor?.Plugins?.App;
          if (App) await App.openUrl({ url: 'app-settings:' });
        } catch (_) {}
        return false;
      }
    }
    try {
      await FCData.updateUserField('notifications_enabled', enable);
    } catch (err) {
      console.error('[toggleNotifications]', err.message);
    }
    toast(enable ? 'Notifications enabled' : 'Notifications disabled', 'success');
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

  function _attachDataListeners() {
    if (_listenersAttached) {
      fcLog('[FCApp] Listeners already attached — skipping duplicate attach');
      return;
    }
    _listenersAttached = true;
    FCData.listenToUser(user => {
      state.user = user;
      if (state.screen === 'app') _renderSettings();
      _updateGreeting();
      // Increment streak daily
      _maybeIncrementStreak(user);
    });

    FCData.listenToAccounts(accounts => {
      state.accounts = accounts;
      if (state.tab === 'home') _renderHome();
      if (state.tab === 'insights') _renderInsights();
      // Snapshot net worth on every account update (daily dedup inside)
      _snapshotNetWorth(FCData.calcNetWorth(accounts));
    });

    FCData.listenToTransactions(500, transactions => {
      state.transactions = transactions;
      // Re-render home so "Recent Activity" and "Safe to Spend" update immediately
      if (state.tab === 'home')     _renderHome();
      if (state.tab === 'activity') _renderActivity();
      if (state.tab === 'insights') _renderInsights();
      // Check budget thresholds whenever transactions update
      _checkBudgetAlert();
    });

    FCData.listenToBills(bills => {
      state.bills = bills;
      if (state.tab === 'home') _renderHome();
      if (state.tab === 'activity' && _activitySegment === 'bills') _renderBillsList();
      FCPush.scheduleAllBillReminders(bills);
    });

    FCData.listenToGoals(goals => {
      state.goals = goals;
      if (state.tab === 'goals') _renderGoals();
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
      });
    } else if (diff > 1) {
      await db.collection('users').doc(uid).update({
        streak:           1,
        last_streak_date: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     BOOT
     ───────────────────────────────────────────────────────────── */

  async function boot() {
    fcLog('App booting…');
    FCAuth.init();
    _initPullToRefresh();

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

    // Period scrubber buttons have onclick="FCApp.switchPeriod(...)" — no extra wiring needed here.

    // Activity search
    const searchInput = document.getElementById('activity-search');
    if (searchInput) {
      searchInput.addEventListener('input', e => handleSearch(e.target.value));
    }

    // Configure RevenueCat early so offerings are cached by the time paywall shows
    FCPurchases.configure().catch(() => {});

    // Wire up app-resume lock (runs once — the listener persists)
    _initAppResumeLock();
    // Wire up idle auto-lock (5-min inactivity → lock screen)
    _initIdleLock();
    // Wire up background privacy blur (task-switcher screenshot protection)
    _initPrivacyBlur();

    // Observe Firebase auth state
    FCAuth.onAuthStateChanged(async user => {
      if (user) {
        fcLog('User authenticated:', user.uid);

        // Warm the Railway backend immediately after auth so it's ready
        // before the user taps anything — prevents cold-start timeouts.
        FCData.warmBackend();

        // Push permissions are requested after Plaid bank connection (see _onPlaidSuccess).
        // Requesting immediately on auth interrupts onboarding and feels premature —
        // users should connect their bank first so the value proposition is clear.

        // Clear ALL stale user state from a previous session so the new
        // account's data renders cleanly. Just nulling state.user used to
        // leak the previous user's transactions/accounts arrays into the
        // first render after sign-in (bug #6).
        _wipeUserState();
        _updateGreeting();

        // Attach real-time data listeners
        _attachDataListeners();

        // Navigate to the correct screen.
        // Fetch userDoc and biometric setting in parallel — they're independent
        // and running them sequentially added ~100-300ms to every cold launch.
        const [userDoc, biometricEnabled] = await Promise.all([
          FCAuth.getUserDoc(),
          FCAuth.isBiometricEnabled(),
        ]);
        // Show onboarding only for brand-new users (no onboarding_complete flag)
        // who also haven't connected a bank yet. Existing users with plaid_linked
        // bypass regardless (backward-compatible).
        const needsOnboarding = userDoc && !userDoc.onboarding_complete && !userDoc.plaid_linked;
        if (needsOnboarding) {
          // New user just registered — show email verification first, then Face ID
          if (window._fcNewUserFaceIdPending) {
            window._fcNewUserFaceIdPending = false;
            if (!user.emailVerified) {
              // Email/password signup: verify email before proceeding
              window._fcVerifyEmailPending = true;
              setScreen('verify-email');
              const addrEl = document.getElementById('verify-email-addr');
              if (addrEl) addrEl.textContent = user.email || '';
            } else {
              // Apple Sign In or already verified (edge case)
              setScreen('faceid-setup');
            }
          } else {
            setScreen('onboarding');
          }
        } else {
          // Guard: if paywall is already shown (e.g., user just tapped "Skip" on onboarding),
          // don't override it — the Firestore write triggers this observer again, but the
          // user should stay on the paywall until they purchase or dismiss.
          if (state.screen === 'paywall' || _paywallShownThisSession) return;
          setScreen('app');
          _renderHome();
          setTimeout(() => _doSync(false), 900);
          if (biometricEnabled) showLockScreen();
          // Tag Sentry errors with the user's UID (no email or name)
          if (window.Sentry) Sentry.setUser({ id: user.uid });
          // Identify user in analytics (no PII — uid only + non-sensitive properties)
          if (typeof FCAnalytics !== 'undefined') {
            FCAnalytics.identify(user.uid, {
              is_pro:          !!(userDoc?.is_pro),
              has_bank:        !!(userDoc?.plaid_linked),
              onboarding_done: !!(userDoc?.onboarding_complete),
            });
          }
          // Gate non-pro users who have already connected a bank.
          // Don't show the paywall to brand-new users mid-onboarding — wait until
          // they've linked an account and seen real value first.
          if (!userDoc?.is_pro && !_paywallShownThisSession) {
            if (userDoc?.plaid_linked) {
              FCPurchases.checkProStatus().then(isPro => {
                if (!isPro && !_paywallShownThisSession) setTimeout(() => showPaywall(), 1500);
                else if (isPro) setTimeout(() => _tryStartTour(), 1400);
              }).catch(() => {});
            }
            // If bank not yet linked, skip paywall — let them connect first.
          } else if (userDoc?.is_pro) {
            // Pro user — offer tour if they haven't seen it
            setTimeout(() => _tryStartTour(), 1400);
          }
        }
      } else {
        fcLog('No user — showing login');
        FCData.detachAllListeners();
        _listenersAttached = false; // allow re-attach on next sign-in
        _wipeUserState();
        setScreen('login');
        // Show or hide the Face ID button based on whether biometric is
        // available AND a previous session exists (email saved in preferences).
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

  /* ─────────────────────────────────────────────────────────────
     NOTIFICATION CENTER
     ───────────────────────────────────────────────────────────── */

  function _updateNotifBadge(notifs) {
    const badge     = document.getElementById('notif-badge');
    const markAllBtn = document.getElementById('notif-mark-all-btn');
    const unread    = (notifs || []).filter(n => !n.read).length;
    if (badge) {
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.style.display = unread > 0 ? 'flex' : 'none';
    }
    if (markAllBtn) markAllBtn.style.display = unread > 0 ? '' : 'none';
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
          <div style="font-size:15px;font-weight:700;color:white;letter-spacing:-0.02em">You're all caught up</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.35);line-height:1.5;max-width:220px">We'll notify you about bills, budget alerts, and account activity</div>
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
        bill_due:     { icon: '💳', bg: 'rgba(255,69,58,0.14)',   border: 'rgba(255,69,58,0.25)'   },
        budget_alert: { icon: '⚡', bg: 'rgba(255,159,10,0.14)',  border: 'rgba(255,159,10,0.25)'  },
        goal_reached: { icon: '🎯', bg: 'rgba(52,199,89,0.14)',   border: 'rgba(52,199,89,0.25)'   },
        sync_done:    { icon: '✓',  bg: 'rgba(26,196,240,0.12)',  border: 'rgba(26,196,240,0.22)'  },
        general:      { icon: '🔔', bg: 'rgba(255,255,255,0.07)', border: 'rgba(255,255,255,0.10)' },
      };
      return map[type] || map.general;
    };

    // Deduplicate: show only the most recent notification per type per day.
    // Prevents budget alert spam when backend sends the same alert multiple times.
    const seen = new Set();
    const deduped = notifs.filter(n => {
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
          <div style="font-size:12px;color:rgba(255,255,255,0.38);margin-top:3px;line-height:1.45">
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
      bill_due:     'activity',
      budget_alert: 'insights',
      goal_reached: 'wealth',  // goals live in the Wealth tab
      sync_done:    'home',
    };
    const tab = routeMap[type] || 'home';
    closeNotificationCenter();
    // Switch tab after notification center close animation (~200ms)
    setTimeout(() => switchTab(tab), 220);
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

    // Warm the backend before fetching — Railway may be cold-starting.
    // Fire a /health ping first so the server is ready by the time /plaid/items hits.
    try { await fetch(`${FC_CONFIG.app.apiBase}/health`, { signal: AbortSignal.timeout(5000) }); } catch (_) {}

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
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <div style="min-width:0;flex:1;margin-right:12px">
              <div style="font-size:15px;font-weight:600;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${legacyName}</div>
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
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
            <div style="min-width:0;flex:1;margin-right:12px">
              <div style="font-size:15px;font-weight:600;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
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
            style="margin-top:8px;padding:8px 16px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:10px;color:var(--fc-text);font-size:13px;cursor:pointer">
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
      bodyEl.innerHTML = `This removes your <strong style="color:rgba(255,255,255,0.75)">${name}</strong> connection and deletes all its synced transaction data from FlowCheck. <strong style="color:rgba(255,255,255,0.75)">Your actual bank account is not affected.</strong>`;
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

     Lifecycle:
       showLockScreen()  → shows the overlay, auto-triggers biometric
       triggerBiometricUnlock() → prompts Face ID
         success → hideLockScreen()
         fail    → shows error state, re-prompts after delay
       unlockWithPassword() → signs out, navigates to login
     ───────────────────────────────────────────────────────────── */

  let _lockActive     = false;
  let _lastUnlockTime = 0;   // timestamp of last successful unlock
  let _biometricInFlight = false; // true while the OS Face ID dialog is open

  // ── Idle auto-lock ───────────────────────────────────────────
  const _IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of inactivity
  let _idleTimer = null;

  // ── Privacy mode (balance masking) ──────────────────────────
  let _privacyModeOn = false;

  function showLockScreen(autoTrigger = true) {
    if (_lockActive) return;
    _lockActive = true;
    // Suspend idle timer while lock screen is showing
    clearTimeout(_idleTimer);

    const screen = document.getElementById('fc-lock-screen');
    if (!screen) { _lockActive = false; return; }

    // Reset state
    const btn    = document.getElementById('fc-lock-btn');
    const status = document.getElementById('lock-status');
    const sub    = document.getElementById('lock-sub');
    if (btn)    { btn.classList.remove('fc-lock-success', 'fc-lock-fail'); btn.disabled = false; }
    if (status) { status.textContent = ''; status.className = 'fc-lock-status'; }
    if (sub)    sub.textContent = 'Your finances are locked';

    screen.classList.remove('hidden');
    screen.style.opacity = '0';
    requestAnimationFrame(() => {
      screen.style.transition = 'opacity 0.15s ease';
      screen.style.opacity    = '1';
    });

    if (autoTrigger) {
      // Trigger Face ID on the next frame — lock screen appears simultaneously
      // with the OS biometric dialog, making the experience feel instant.
      requestAnimationFrame(() => triggerBiometricUnlock());
    }
  }

  function hideLockScreen() {
    const screen = document.getElementById('fc-lock-screen');
    if (!screen) { _lockActive = false; return; }

    screen.style.transition = 'opacity 0.3s ease';
    screen.style.opacity    = '0';
    setTimeout(() => {
      screen.classList.add('hidden');
      screen.style.opacity    = '';
      screen.style.transition = '';
      _lockActive = false;
      // Restart idle timer after successful unlock
      _resetIdleTimer();
    }, 310);
  }

  async function triggerBiometricUnlock() {
    const btn    = document.getElementById('fc-lock-btn');
    const status = document.getElementById('lock-status');
    const sub    = document.getElementById('lock-sub');

    if (btn)    { btn.disabled = true; btn.classList.remove('fc-lock-success', 'fc-lock-fail'); }
    if (status) { status.textContent = ''; status.className = 'fc-lock-status'; }
    if (sub)    sub.textContent = 'Scanning…';

    _biometricInFlight = true; // block appStateChange from re-triggering lock

    try {
      await FCAuth.promptBiometric('Unlock FlowCheck');

      // Success
      _biometricInFlight = false;
      _lastUnlockTime    = Date.now(); // cooldown — ignore next appStateChange
      haptic('medium');
      if (btn) btn.classList.add('fc-lock-success');
      if (sub) sub.textContent = '';
      if (status) { status.textContent = '✓ Unlocked'; status.className = 'fc-lock-status success'; }

      setTimeout(() => hideLockScreen(), 520);

    } catch (err) {
      _biometricInFlight = false;
      haptic('heavy');

      const cancelled = err.message && (
        err.message.toLowerCase().includes('cancel') ||
        err.message.toLowerCase().includes('dismiss') ||
        err.message.toLowerCase().includes('user cancel')
      );

      if (btn) {
        btn.disabled = false;
        if (!cancelled) btn.classList.add('fc-lock-fail');
      }
      if (sub) sub.textContent = 'Your finances are locked';

      if (!cancelled) {
        if (status) { status.textContent = 'Try again'; status.className = 'fc-lock-status error'; }
        setTimeout(() => {
          if (!_lockActive) return;
          if (btn) btn.classList.remove('fc-lock-fail');
          if (status) { status.textContent = ''; status.className = 'fc-lock-status'; }
        }, 1400);
      } else {
        if (btn) btn.disabled = false;
      }
    }
  }

  /**
   * Signs the user out and shows the login screen.
   * Used when Face ID is unavailable or the user prefers a password.
   * The existing Firebase session is cleared so they must re-authenticate.
   */
  async function unlockWithPassword() {
    // Dismiss lock screen first so the transition feels smooth
    hideLockScreen();
    FCData.detachAllListeners();
    try { await FCAuth.signOut(); } catch (_) {}
    // Auth state observer will route to login screen
  }

  /**
   * Check whether the lock screen should be shown and do so.
   * Called after authentication and on app resume.
   */
  async function _checkAndLock() {
    // Skip if Face ID is actively being shown (prevents loop when
    // the iOS system dialog backgrounds then re-foregrounds the app)
    if (_biometricInFlight) return;
    // Skip if we just unlocked — the Face ID dialog dismiss itself
    // triggers another appStateChange within a second or two
    if (Date.now() - _lastUnlockTime < 8000) return;
    const user = FCAuth.currentUser();
    if (!user) return;
    const enabled = await FCAuth.isBiometricEnabled();
    if (enabled) showLockScreen();
  }

  /* ─────────────────────────────────────────────────────────────
     PAYWALL
     Shows after bank connects (highest-intent moment).
     Soft gate — user can dismiss. Annual plan selected by default.
     ───────────────────────────────────────────────────────────── */

  let _selectedPlan          = 'annual'; // 'annual' | 'monthly'
  let _pwOfferings           = null;
  let _paywallShownThisSession = false;  // prevents re-trigger mid-session

  async function showPaywall() {
    _paywallShownThisSession = true;
    if (typeof FCAnalytics !== 'undefined') FCAnalytics.track('paywall_viewed', { source: state.screen });

    // Show X close button only when triggered from inside the app (not from onboarding flow).
    // During onboarding the user must either buy or tap "Maybe later" — no escape hatch.
    const canClose = state.screen === 'app';
    const closeBtn = document.getElementById('pw-close-btn');
    if (closeBtn) closeBtn.style.display = canClose ? 'flex' : 'none';

    // Reset success overlay in case it was left visible from a previous purchase attempt
    const successOverlay = document.getElementById('pw-success-overlay');
    if (successOverlay) successOverlay.classList.remove('visible');

    setScreen('paywall');
    haptic('light');
    _loadPaywallOfferings();
  }

  /** Dismiss the paywall and return to the main app (only available when triggered in-app). */
  function closePaywall() {
    const closeBtn = document.getElementById('pw-close-btn');
    if (closeBtn) closeBtn.style.display = 'none';
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
        const price = annual.product.priceString;
        const amountEl = document.getElementById('pw-price-annual-amount');
        const detailEl = document.getElementById('pw-price-annual');
        if (amountEl) amountEl.textContent = price;
        if (detailEl) {
          // Try to compute monthly equivalent
          const raw = annual.product.price;
          const monthlyEq = raw ? `$${(raw / 12).toFixed(2)}/mo — 7-day free trial` : '7-day free trial';
          detailEl.textContent = monthlyEq;
        }
        // Update CTA & terms text to reflect live price
        const termsEl = document.getElementById('pw-terms-text');
        if (termsEl && _selectedPlan === 'annual') {
          termsEl.textContent = `Then ${price}/year. Cancel anytime in App Store settings.`;
        }
      }
      if (monthly) {
        const el = document.getElementById('pw-price-monthly');
        if (el) el.textContent = `${monthly.product.priceString}/mo · Billed monthly`;
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
      if (terms) terms.textContent = `Then ${annualPrice}/year. Cancel anytime in App Store settings.`;
    } else {
      if (btn)   btn.textContent   = 'Start Monthly Plan';
      if (terms) terms.textContent = `${monthlyPrice}/month. Cancel anytime in App Store settings.`;
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
        // Best-effort Firestore cache — rules intentionally block client writes of is_pro
        // (RevenueCat is the source of truth). Never let this fail the purchase success flow.
        try { await FCData.updateUserField('is_pro', true); } catch (_) {}
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
              try { await FCData.updateUserField('is_pro', true); } catch (_) {}
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
            try { await FCData.updateUserField('is_pro', true); } catch (_) {}
            setScreen('app');
            _renderHome();
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
        await FCData.updateUserField('is_pro', true);
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
    const confirmed = await _confirmDialog('Delete Goal', 'Are you sure? This cannot be undone.');
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
    const confirmed = await _confirmDialog('Delete Bill', 'Delete this bill? This cannot be undone.');
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
    haptic('medium');
    try {
      await FCData.markBillPaid(billId);
      toast('Bill marked as paid ✓', 'success');
    } catch (err) {
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

  /**
   * Register a Capacitor App state listener so the lock screen
   * appears whenever the app returns from the background.
   */
  function _initAppResumeLock() {
    try {
      const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
      if (!AppPlugin) return;

      AppPlugin.addListener('appStateChange', async ({ isActive }) => {
        if (!isActive) return;

        // ── 1. Show lock screen if the session has been idle ─────────────
        _checkAndLock();

        // ── 2. Token revocation check ────────────────────────────────────
        // Firebase tokens are valid for 1 hour but can be revoked server-side
        // at any time (e.g. password change, admin action, account deletion).
        // getIdToken(true) forces a fresh token fetch — if the session has
        // been revoked Firebase throws an error, which we catch here and
        // immediately sign the user out.
        //
        // This runs async in the background so it never delays the lock-screen
        // transition. A revoked user sees the lock screen first, then gets
        // redirected to login once the token check resolves.
        const user = FCAuth.currentUser();
        if (user && typeof user.getIdToken === 'function') {
          try {
            await user.getIdToken(/* forceRefresh */ true);
          } catch (err) {
            // Token revoked or user deleted — force sign-out
            console.warn('[FCApp] Token revoked on resume — signing out:', err.code || err.message);
            try { if (typeof FCData !== 'undefined') FCData.detachAllListeners(); } catch (_) {}
            try { await FCAuth.signOut(); } catch (_) {}
            // Clear any sensitive state that might linger
            try {
              Object.keys(localStorage)
                .filter(k => k.startsWith('fc_'))
                .forEach(k => localStorage.removeItem(k));
            } catch (_) {}
            setScreen('login');
          }
        }
      });
    } catch (_) {}
  }

  /**
   * Reset the idle auto-lock countdown.
   * Called on every user interaction event (touch, scroll, key).
   * Starts a fresh 5-minute timer; when it fires and the user is
   * authenticated, the lock screen is shown.
   */
  function _resetIdleTimer() {
    if (!FCAuth.currentUser()) return; // Only arm when someone is logged in
    if (_lockActive) return;           // Already locked — don't start a new timer
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(() => {
      if (FCAuth.currentUser() && !_lockActive) {
        _checkAndLock();
      }
    }, _IDLE_TIMEOUT_MS);
  }

  /**
   * Attach document-level event listeners that reset the idle timer.
   * Uses capture-phase passive listeners so they fire even inside
   * scrollable containers and can't be accidentally suppressed.
   */
  function _initIdleLock() {
    const RESET_EVENTS = ['touchstart', 'touchmove', 'mousedown', 'mousemove', 'keydown', 'scroll', 'click'];
    RESET_EVENTS.forEach(ev => {
      document.addEventListener(ev, _resetIdleTimer, { passive: true, capture: true });
    });
    _resetIdleTimer(); // Arm the timer immediately on boot
  }

  /**
   * Show a privacy overlay whenever the app is backgrounded so iOS
   * task-switcher screenshots don't capture financial data.
   *
   * Uses both `visibilitychange` (fires on all browsers/Capacitor) and
   * `pagehide` (iOS-specific additional coverage).
   */
  function _initPrivacyBlur() {
    const getOverlay = () => document.getElementById('fc-privacy-blur');

    document.addEventListener('visibilitychange', () => {
      const overlay = getOverlay();
      if (!overlay) return;
      if (document.hidden) {
        overlay.style.display = 'flex';
      } else {
        // Small delay prevents a flash when quickly switching back
        setTimeout(() => { overlay.style.display = 'none'; }, 350);
      }
    });

    // Additional iOS coverage
    window.addEventListener('pagehide', () => {
      const overlay = getOverlay();
      if (overlay) overlay.style.display = 'flex';
    });
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
        btn.style.color        = active ? '#1ac4f0' : 'rgba(255,255,255,0.38)';
        btn.style.border       = active ? '0.5px solid rgba(26,196,240,0.28)' : 'none';
      }
    });

    // Re-render home with new period data (chart + insights update inside _renderHome)
    if (state.tab === 'home') _renderHome();
    // Also refresh chart in insights view if that tab is active
    if (state.tab === 'insights') _renderInsights();
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
      const referrer = state.user?.referred_by;
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
      btn.style.color = '#34c759';
      setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 2000);
    }
    haptic('light');
  }

  async function shareReferralCode() {
    const code = _getReferralCode();
    if (!code) return;
    const shareText = `Use my code ${code} on FlowCheck and we both get a free month of Pro. 💰 Download: https://apps.apple.com/app/flowcheck`;
    haptic('medium');
    try {
      if (navigator.share) {
        await navigator.share({ title: 'FlowCheck — Refer a Friend', text: shareText });
      } else {
        // Capacitor share plugin fallback
        const { Share } = await Promise.resolve().then(() => CapacitorExports || window.Capacitor?.Plugins);
        if (Share?.share) {
          await Share.share({ title: 'FlowCheck', text: shareText, dialogTitle: 'Share FlowCheck' });
        } else {
          copyReferralCode();
          toast('Code copied — paste it to share!', 'success');
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        copyReferralCode();
        toast('Code copied — paste it to share!', 'success');
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

  return {
    boot,
    setScreen,
    switchTab,
    toast,
    manualSync,
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
    handleVerifyEmailCheck,
    resendVerificationEmail,
    skipEmailVerification,
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
    // Face ID lock screen
    showLockScreen,
    hideLockScreen,
    triggerBiometricUnlock,
    unlockWithPassword,
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
      if (card && typeof card._focusTap === 'function') card._focusTap();
    },
    // Referral sheet
    showReferralSheet,
    closeReferralSheet,
    copyReferralCode,
    shareReferralCode,
    toggleReferralInput,
  };
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
