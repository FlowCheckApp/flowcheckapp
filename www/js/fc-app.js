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

  // Detect monthly-recurring subscription transactions (shared by stat + hunter)
  function _detectSubscriptions() {
    const map = {};
    for (const t of state.transactions) {
      if (t.isCredit || !t.date || !t.name) continue;
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
  // Persist today's net worth and keep 60-day rolling window
  function _snapshotNetWorth(netWorth) {
    if (!state.user || !state.user.plaid_linked) return;
    try {
      const today   = new Date().toISOString().split('T')[0];
      const raw     = localStorage.getItem('fc_nw_history');
      const history = raw ? JSON.parse(raw) : {};
      history[today] = Math.round(netWorth * 100) / 100;
      // Keep last 60 days
      const keys = Object.keys(history).sort();
      if (keys.length > 60) keys.slice(0, keys.length - 60).forEach(k => delete history[k]);
      localStorage.setItem('fc_nw_history', JSON.stringify(history));
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
    if (values.length < 2) return;

    const W = 320, H = 60, PAD = 4;
    const min  = Math.min(...values);
    const max  = Math.max(...values);
    const range = max - min || 1;

    const toX = (i) => Math.round((i / (values.length - 1)) * W);
    const toY = (v) => Math.round(PAD + (1 - (v - min) / range) * (H - PAD * 2));

    // Build smooth cubic bezier path
    let line = `M${toX(0)},${toY(values[0])}`;
    for (let i = 1; i < values.length; i++) {
      const x0 = toX(i - 1), y0 = toY(values[i - 1]);
      const x1 = toX(i),     y1 = toY(values[i]);
      const cpX = (x0 + x1) / 2;
      line += ` C${cpX},${y0} ${cpX},${y1} ${x1},${y1}`;
    }
    const lastX = toX(values.length - 1);
    const lastY = toY(values[values.length - 1]);

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
      const first   = values[Math.max(0, values.length - 30)];
      const last    = values[values.length - 1];
      const delta   = last - first;
      const pct     = first !== 0 ? Math.round((delta / Math.abs(first)) * 100) : 0;
      const up      = delta >= 0;
      deltaEl.style.display     = '';
      deltaEl.textContent       = (up ? '↑' : '↓') + ' ' + FCData.formatCurrency(Math.abs(delta));
      deltaEl.style.background  = up ? 'rgba(52,199,89,0.15)'  : 'rgba(255,69,58,0.12)';
      deltaEl.style.color       = up ? 'var(--fc-success)'     : 'var(--fc-danger)';
      deltaEl.style.border      = up ? '1px solid rgba(52,199,89,0.25)' : '1px solid rgba(255,69,58,0.2)';
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
        <stop offset="0%" stop-color="#6b3fe0" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="#1ac4f0"/>
      </linearGradient>
      <linearGradient id="cg-now" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#6b3fe0"/>
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
      const h  = b.total > 0 ? Math.max(Math.round((b.total / maxVal) * (H - 10)), 3) : 2;
      const y  = H - h;
      if (b.isNow) {
        // Active bucket: full gradient + glow + bright top cap
        return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${rx}" fill="url(#cg-now)" filter="url(#glow-bar)"/>
                <rect x="${x}" y="${y}" width="${barW}" height="${Math.min(rx * 2, h)}" rx="${rx}" fill="rgba(26,196,240,0.35)"/>`;
      }
      return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="${rx}" fill="url(#cg)" opacity="0.5"/>`;
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
    const periodSpend  = periodTxns.filter(t => !t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);
    const periodIncome = periodTxns.filter(t =>  t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);
    const label        = _PERIOD_LABELS[state.period] || 'this month';
    const insights     = [];

    // 1. Budget status
    const budgetLimit = (state.budgets && state.budgets['total']) ? state.budgets['total'].limit : 3000;
    if (budgetLimit > 0 && (periodSpend > 0 || state.user?.plaid_linked)) {
      const budgetPct = (periodSpend / budgetLimit) * 100;
      if (budgetPct >= 100) {
        insights.push({ icon: '⚠️', text: `Over budget by ${FCData.formatCurrency(periodSpend - budgetLimit)} ${label}`, color: 'var(--fc-danger)', bg: 'rgba(255,69,58,0.08)' });
      } else if (budgetPct >= 80) {
        insights.push({ icon: '⚡', text: `${Math.round(budgetPct)}% of budget used — ${FCData.formatCurrency(budgetLimit - periodSpend)} left`, color: 'var(--fc-warning)', bg: 'rgba(255,176,32,0.08)' });
      } else if (budgetPct >= 10) {
        insights.push({ icon: '✓', text: `On track — ${FCData.formatCurrency(budgetLimit - periodSpend)} of ${FCData.formatCurrency(budgetLimit)} budget remaining`, color: 'var(--fc-success)', bg: 'rgba(52,199,89,0.08)' });
      }
    }

    // 2. Top spending category
    const catMap = {};
    for (const t of periodTxns.filter(t => !t.isCredit)) {
      const cat = (t.category && t.category[0]) || 'Other';
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

    // 4. Savings rate
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

    // 5. Daily spending average + monthly projection (only for 1M period)
    if (state.period === '1M' && periodSpend > 0) {
      const dayOfMonth  = new Date().getDate();
      const dailyAvg    = periodSpend / dayOfMonth;
      const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
      const projected   = dailyAvg * daysInMonth;
      const budgetLimit2 = (state.budgets && state.budgets['total']) ? state.budgets['total'].limit : 3000;
      const overProj    = projected > budgetLimit2;
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

    // Fallback — only if no data at all
    if (insights.length === 0) {
      insights.push({ icon: '🔗', text: 'Connect a bank account to unlock personalized insights', color: 'rgba(255,255,255,0.5)', bg: 'rgba(255,255,255,0.04)', priority: 0 });
    }

    // Sort by urgency: danger > warning > success/info, then limit to 3
    const urgencyOrder = { 'var(--fc-danger)': 0, 'var(--fc-warning)': 1, 'var(--fc-success)': 2 };
    insights.sort((a, b) => (urgencyOrder[a.color] ?? 3) - (urgencyOrder[b.color] ?? 3));

    return insights.slice(0, 3);
  }

  function _renderSmartInsights() {
    const container = document.getElementById('smart-insights-list');
    if (!container) return;

    const insights = _generateSmartInsights();
    container.innerHTML = insights.map(ins => `
      <div style="display:flex;align-items:center;gap:12px;padding:11px 14px;background:${ins.bg};border:1px solid rgba(255,255,255,0.06);border-radius:14px">
        <span style="font-size:18px;flex-shrink:0;line-height:1">${ins.icon}</span>
        <span style="font-size:13px;font-weight:500;color:${ins.color};line-height:1.4;flex:1">${ins.text}</span>
      </div>`).join('');
  }

  /* ── Budget Alert ────────────────────────────────────────────── */
  let _budgetAlerted80  = false;
  let _budgetAlerted100 = false;

  async function _checkBudgetAlert() {
    if (!state.user || !state.user.plaid_linked) return;
    if (!FC_CONFIG.notifications || !FC_CONFIG.notifications.budgetAlertEndpoint) return;

    const now = new Date();
    const calMonthTxns = state.transactions.filter(t => {
      if (!t.date || t.isCredit) return false;
      const d = FCData.parseDateLocal(t.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const monthSpend  = calMonthTxns.reduce((s, t) => s + (t.amount || 0), 0);
    const budgetLimit = (state.budgets && state.budgets['total']) ? state.budgets['total'].limit : 3000;
    if (budgetLimit <= 0) return;

    const pct = (monthSpend / budgetLimit) * 100;

    // Reset at month boundary
    const storedMonth = parseInt(localStorage.getItem('fc_budget_alert_month') || '0');
    if (storedMonth !== now.getMonth()) {
      _budgetAlerted80 = false; _budgetAlerted100 = false;
      localStorage.setItem('fc_budget_alert_month', String(now.getMonth()));
    }

    let title, body;
    if (pct >= 100 && !_budgetAlerted100) {
      _budgetAlerted100 = true;
      title = 'Budget exceeded 🚨';
      body  = `You've spent ${FCData.formatCurrency(monthSpend)} — over your ${FCData.formatCurrency(budgetLimit)} budget.`;
    } else if (pct >= 80 && !_budgetAlerted80) {
      _budgetAlerted80 = true;
      title = 'Budget at 80% ⚡';
      body  = `${FCData.formatCurrency(budgetLimit - monthSpend)} left in your monthly budget.`;
    } else {
      return;
    }

    try {
      const token = await FCAuth.getIdToken();
      // Backend generates its own title/body from category+spent+limit — send those three.
      await fetch(FC_CONFIG.notifications.budgetAlertEndpoint, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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

  function setScreen(name) {
    if (state.screen === name) return;
    state.screen = name;
    document.body.dataset.screen = name;

    // Reset scroll on new screen
    window.scrollTo({ top: 0, behavior: 'instant' });

    // Update greeting dynamically
    if (name === 'app') _updateGreeting();

    fcLog('Screen →', name);
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
      if (txnsPanel)  txnsPanel.style.display  = 'flex';
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
        <div style="text-align:center;padding:48px 24px;color:var(--fc-text-faint)">
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

  function switchTab(tabId) {
    if (state.tab === tabId) return;
    const prev = state.tab;
    state.tab  = tabId;

    // Views
    document.querySelectorAll('.fc-view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById('view-' + tabId);
    if (target) target.classList.add('active');

    // Nav items
    document.querySelectorAll('.fc-nav-item').forEach(item => {
      const active = item.dataset.view === tabId;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
      item.setAttribute('tabindex', active ? '0' : '-1');
    });

    // Trigger tab-specific refresh
    if (tabId === 'home')     _renderHome();
    if (tabId === 'activity') {
      if (_activitySegment === 'bills') _renderBillsList();
      else _renderActivity();
    }
    if (tabId === 'insights') _renderInsights();
    if (tabId === 'goals')    _renderGoals();   // legacy — kept in case
    if (tabId === 'wealth')   _renderWealth();
    if (tabId === 'settings') _renderSettings();

    // Reset the view's own scroll — body has overflow:hidden so window never scrolls
    if (target) target.scrollTop = 0;
    haptic('light');
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

      element.textContent = prefix + current.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + suffix;
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
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name  = (state.user && state.user.name) ? state.user.name.split(' ')[0] : 'Brandon';
    document.querySelectorAll('.fc-greeting-text').forEach(el => {
      el.innerHTML = `${esc(greet)},<br>${esc(name)}`;
    });
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

    // 3. Budget adherence — up to 200 pts
    const bLimit = (state.budgets && state.budgets['total']) ? state.budgets['total'].limit : 3000;
    const bPct   = bLimit > 0 ? monthSpend / bLimit : 0;
    score += bPct <= 0.75 ? 200 : bPct <= 0.90 ? 170 : bPct <= 1.0 ? 130 : bPct <= 1.2 ? 80 : 30;

    // 4. Emergency fund progress — up to 200 pts
    const ef = state.goals.find(g => /emergency|rainy|reserve/i.test(g.name));
    if (ef) {
      const p = ef.pct || 0;
      score += p >= 100 ? 200 : p >= 75 ? 175 : p >= 50 ? 140 : p >= 25 ? 100 : 60;
    } else { score += 100; }

    return Math.min(Math.round(score), 850);
  }

  function _renderHealthScore(score, monthIncome, monthSpend, unpaidBills, overdueCount) {
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
      const bLimit = (state.budgets && state.budgets['total']) ? state.budgets['total'].limit : 3000;
      const bPct   = bLimit > 0 ? Math.round((monthSpend / bLimit) * 100) : 0;
      subEl.textContent = `Savings ${monthIncome > 0 ? Math.round(((monthIncome - monthSpend) / monthIncome) * 100) : 0}% · Budget ${bPct}% used · ${overdueCount === 0 ? 'All bills current' : overdueCount + ' bill' + (overdueCount > 1 ? 's' : '') + ' overdue'}`;
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
      if (t.isCredit || !t.date) continue;
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

    // Badge + headline
    if (lastWeek > 0 && badgeEl && headlineEl) {
      const pct   = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
      const less  = pct < 0;
      const absPct = Math.abs(pct);
      badgeEl.style.display = '';
      badgeEl.textContent   = (less ? '↓ ' : '↑ ') + absPct + '%';
      badgeEl.style.background = less ? 'rgba(52,199,89,0.15)'  : 'rgba(255,69,58,0.12)';
      badgeEl.style.color      = less ? 'var(--fc-success)'     : 'var(--fc-danger)';
      headlineEl.textContent   = less
        ? `Spending ${absPct}% less than last week 🎉`
        : `Spending ${absPct}% more than last week`;
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

  // Called when user taps "Check My Credit Score" — fetches from backend
  async function fetchCreditScore() {
    const btn = document.getElementById('credit-connect-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

    try {
      const token       = await FCAuth.getIdToken();
      const creditUrl   = (FC_CONFIG && FC_CONFIG.credit && FC_CONFIG.credit.scoreEndpoint)
                        || 'https://flowcheck-backend-production.up.railway.app/credit/score';
      const abort   = new AbortController();
      const timeout = setTimeout(() => abort.abort(), 12_000); // 12s frontend timeout
      const resp  = await fetch(creditUrl, {
        signal:  abort.signal,
        headers: { 'Authorization': `Bearer ${token}` },
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
    await fetchCreditScore();
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: HOME
     ───────────────────────────────────────────────────────────── */

  function _renderHome() {
    // Update island text based on bank link status
    if (state.user && !state.user.plaid_linked) {
      _setIslandText('Connect a bank to start');
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
    if (cashEl) cashEl.textContent = FCData.formatCurrency(cash);

    // Account count
    const acctEl = document.getElementById('stat-account-count');
    if (acctEl) acctEl.textContent = state.accounts.length + ' account' + (state.accounts.length !== 1 ? 's' : '');

    // Upcoming bills (next 3)
    const billsEl = document.getElementById('home-bills-list');
    if (billsEl) {
      const upcoming = state.bills
        .filter(b => b.status !== 'paid')
        .slice(0, 3);

      if (!upcoming.length) {
        billsEl.innerHTML = '<div style="color:var(--fc-text-faint);font-size:13px;padding:12px 0">No upcoming bills — nice work! 🎉</div>';
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
      subsEl.textContent = FCData.formatCurrency(autoTotal || billTotal);
    }

    // Bills due stat
    const unpaidBills = state.bills.filter(b => b.status !== 'paid');
    const unpaidBillsTotal = unpaidBills.reduce((s, b) => s + (b.amount || 0), 0);
    const billsStatEl = document.getElementById('stat-bills');
    if (billsStatEl) billsStatEl.textContent = FCData.formatCurrency(unpaidBillsTotal);

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
    const periodIncome = periodTxns.filter(t =>  t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);
    const periodSpend  = periodTxns.filter(t => !t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);

    // Calendar-month figures for health score + safe-to-spend (always month-based)
    const _now = new Date();
    const calMonthTxns = state.transactions.filter(t => {
      if (!t.date) return false;
      const d = FCData.parseDateLocal(t.date);
      return d.getMonth() === _now.getMonth() && d.getFullYear() === _now.getFullYear();
    });
    const monthIncome  = calMonthTxns.filter(t =>  t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);
    const monthSpend   = calMonthTxns.filter(t => !t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);
    const overdueCount = state.bills.filter(b => b.status !== 'paid' && FCData.daysUntil(b.due_date) < 0).length;

    const incomeEl       = document.getElementById('stat-income');
    if (incomeEl) incomeEl.textContent = FCData.formatCurrency(periodIncome);
    const incomePeriodEl = document.getElementById('stat-income-period');
    if (incomePeriodEl) incomePeriodEl.textContent = _PERIOD_LABELS[state.period] || 'this month';

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
            <defs><linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#1ac4f0"/><stop offset="100%" stop-color="#9b7aff"/></linearGradient></defs>
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
            <span style="color:var(--fc-accent);font-size:10px;font-weight:500">${pct >= 100 ? 'complete 🎉' : 'on track'}</span>
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
    _renderHealthScore(healthScore, monthIncome, monthSpend, unpaidBillsTotal, overdueCount);

    // ── Credit Score card ────────────────────────────────────────
    _renderCreditScore();

    // ── Spending Pulse ────────────────────────────────────────────
    _renderSpendingPulse();

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

    if (state.user && state.user.plaid_linked) {
      // Safe to Spend = Cash − upcoming bills − 10% savings buffer
      const buffer        = cash * 0.10;
      const safeToSpend   = Math.max(0, cash - unpaidBillsTotal - buffer);
      // Progress bar shows how much of cash has been committed (spend + bills)
      const committed     = monthSpend + unpaidBillsTotal;
      const barPct        = cash > 0 ? Math.min(Math.round((committed / cash) * 100), 100) : 0;
      const barColor      = barPct > 85 ? 'var(--fc-danger)'
                          : barPct > 65 ? 'var(--fc-warning)'
                          : 'linear-gradient(90deg,var(--fc-accent),var(--fc-purple))';

      if (safeEl)   animateNumber(safeEl, safeToSpend, '$');
      if (metaEl)   metaEl.textContent = `${Math.round(barPct)}% of cash committed`;
      if (barEl)  { barEl.style.width = barPct + '%'; barEl.style.background = barColor; }
      if (spentLbl) spentLbl.textContent = FCData.formatCurrency(monthSpend);
      if (billsLbl) billsLbl.textContent = FCData.formatCurrency(unpaidBillsTotal);
    } else {
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
        const cat   = (t.category && t.category[0]) || 'Other';
        const emoji = FCData.categoryEmoji(t.category, t.name);
        const isEmojiIcon = emoji.length <= 2 && isNaN(emoji);
        const color = t.isCredit ? 'var(--fc-success)' : 'var(--fc-danger)';
        const sign  = t.isCredit ? '+' : '−';
        const txDate = t.date ? FCData.parseDateLocal(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        const editedDot = t._edited
          ? '<span style="width:5px;height:5px;background:var(--fc-accent);border-radius:50%;display:inline-block;margin-left:4px;vertical-align:middle"></span>'
          : '';
        return `
          <div class="fc-list-item" style="cursor:pointer" onclick="FCApp.openTransactionDetail('${esc(t.id)}')" role="button">
            <div class="fc-list-icon" style="background:${isEmojiIcon ? FCData.categoryColor(cat) + '20' : FCData.categoryColor(cat)};font-size:${isEmojiIcon ? '20px' : '15px'};font-weight:${isEmojiIcon ? '400' : '700'};color:white">${emoji}</div>
            <div class="fc-list-body">
              <div class="fc-list-title">${esc(t.name || 'Transaction')}${editedDot}</div>
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
     RENDER: INSIGHTS
     ───────────────────────────────────────────────────────────── */

  function _renderInsights() {
    const container = document.getElementById('insights-categories');
    if (!container) return;

    // ── Period-aware transactions ─────────────────────────────────
    // Insights respond to the global period selector (same as home screen)
    const periodTxns  = _getPeriodTxns();
    const periodLabel = _PERIOD_LABELS[state.period] || 'this month';

    const periodSpendTxns = periodTxns.filter(t => !t.isCredit);
    const periodSpend  = periodSpendTxns.reduce((s, t) => s + (t.amount || 0), 0);
    const periodIncome = periodTxns.filter(t =>  t.isCredit).reduce((s, t) => s + (t.amount || 0), 0);

    // Update the insights period labels
    const insightsPeriodEl = document.getElementById('insights-period-label');
    if (insightsPeriodEl) insightsPeriodEl.textContent = periodLabel;
    const insightsCatPeriod = document.getElementById('insights-cat-period');
    if (insightsCatPeriod) insightsCatPeriod.textContent = periodLabel;

    // ── Spend delta vs previous period ────────────────────────────
    const spendDeltaEl = document.getElementById('insights-spend-delta');
    if (spendDeltaEl) {
      if (state.period === 'month' && state.transactions && state.transactions.length) {
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
                       : 'linear-gradient(90deg,var(--fc-accent),var(--fc-purple))';

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
    if (paceEl && state.period === 'month') {
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
        const cat = (t.category && t.category[0]) || 'Other';
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

      const merchantMap = {};
      for (const t of periodSpendTxns) {
        const name = t.name || 'Unknown';
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
        const cols = ['#1ac4f0','#6b3fe0','#ff6b35','#f093fb','#43e97b'];
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
        const history = JSON.parse(localStorage.getItem('fc_nw_history') || '{}');
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

    // Aggregate per-month spending for this year
    const monthlySpend = new Array(12).fill(0);
    (state.transactions || []).filter(t => !t.isCredit && t.date).forEach(t => {
      const d = FCData.parseDateLocal(t.date);
      if (d.getFullYear() === year) monthlySpend[d.getMonth()] += (t.amount || 0);
    });

    const totalYearSpend = monthlySpend.reduce((s, v) => s + v, 0);
    const annualBudget   = budgetLim * 12;
    const annualPct      = annualBudget > 0 ? Math.min(Math.round((totalYearSpend / annualBudget) * 100), 100) : 0;
    const annualColor    = annualPct > 100 ? 'var(--fc-danger)' : annualPct > 80 ? 'var(--fc-warning)' : 'linear-gradient(90deg,var(--fc-accent),var(--fc-purple))';

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
        const statusLabel = pct >= 100 ? 'COMPLETE' : pct >= 75 ? 'ALMOST' : 'ON TRACK';
        return `
          <div class="fc-goal-card" style="cursor:pointer" onclick="FCApp.editGoal('${esc(g.id)}')" role="button">
            <div style="width:56px;height:56px;position:relative;flex-shrink:0">
              <svg width="56" height="56" viewBox="0 0 64 64" aria-label="${pct}%">
                <defs>
                  <linearGradient id="ring-gradient" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="#1ac4f0"/><stop offset="100%" stop-color="#9b7aff"/>
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
                <div class="fc-progress-fill" style="width:${pct}%;background:${pct >= 100 ? 'var(--fc-success)' : 'linear-gradient(90deg,var(--fc-accent),var(--fc-purple))'}"></div>
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

  function _renderWealth() {
    if (_wealthSeg === 'savings') _renderSavings();
    if (_wealthSeg === 'goals')   _renderGoals();
    if (_wealthSeg === 'debt')    _renderDebt();
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
        <div class="fc-card" style="margin:0 16px 4px;padding:18px;background:linear-gradient(135deg,rgba(26,196,240,0.1),rgba(107,63,224,0.1))">
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
      const inst = a.institution_name || a.official_name || (a.manual ? 'Manual entry' : '');
      return `<div class="fc-acct-card">
        <div class="fc-acct-icon">${icon}</div>
        <div class="fc-acct-info">
          <div class="fc-acct-name">${a.name || 'Account'}</div>
          ${inst ? `<div class="fc-acct-bank">${inst}</div>` : ''}
        </div>
        <div class="fc-acct-bal">${FCData.formatCurrency(bal)}</div>
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
        <div class="fc-card" style="margin:0 16px 4px;padding:18px;background:linear-gradient(135deg,rgba(255,69,58,0.1),rgba(107,63,224,0.08))">
          <div class="fc-eyebrow">Total Debt</div>
          <div style="font-size:32px;font-weight:800;letter-spacing:-0.03em;color:white;margin-top:2px">−${FCData.formatCurrency(totalDebt)}</div>
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
          <div class="fc-acct-bal" style="color:var(--fc-danger)">−${FCData.formatCurrency(bal)}</div>
          ${util !== null ? `<div style="font-size:10px;color:${uColor};margin-top:2px">${util}% used</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  /* Helper called by CTA button after paywall success */
  function renderHomeAfterPro() {
    _renderHome();
    setTimeout(() => _tryStartTour(), 1200);
  }

  /** Show the app tour for first-time users (checks tour_completed flag) */
  function _tryStartTour() {
    try {
      // Only show if the user hasn't completed the tour yet
      if (!state.user?.tour_completed && typeof startTour === 'function') {
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
    if (nameEl)  nameEl.textContent  = user.name  || 'User';
    if (emailEl) emailEl.textContent = user.email || FCAuth.currentUser()?.email || '';
    if (initEl)  initEl.textContent  = (user.name || 'U').charAt(0).toUpperCase();

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
    if (institutionEl) institutionEl.textContent = user.plaid_institution || 'Not connected';

    // Streak
    const streakEl = document.getElementById('settings-streak');
    if (streakEl) streakEl.textContent = `Day ${user.streak || 0} streak`;

    // Pro row — show status + cancel option for Pro users
    const proRow  = document.getElementById('settings-pro-row');
    const proPill = document.getElementById('settings-pro-pill');
    const isPro   = user.is_pro || user.pro;
    if (proPill) {
      proPill.textContent = isPro ? 'Pro ✓' : 'Upgrade';
      proPill.className   = isPro
        ? 'fc-pill' : 'fc-pill fc-pill--accent';
      proPill.style.cssText = isPro
        ? 'font-size:10px;padding:3px 8px;background:rgba(52,199,89,0.12);color:var(--fc-success);border:1px solid rgba(52,199,89,0.25)'
        : 'font-size:10px;padding:3px 8px';
    }
    if (proRow) {
      proRow.onclick = isPro
        ? () => _openCancelSheet()
        : () => showPaywall();
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
      if (didPull) await _doSync();
    });
  }

  async function _doSync(showToast = false) {
    if (state.syncing) return;
    if (state.screen !== 'app') return;  // only sync inside the main app

    // If backend isn't wired up yet, skip silently — no toast
    if (!FC_CONFIG.app.backendConfigured) {
      fcLog('Sync skipped — backendConfigured is false');
      return;
    }

    // Don't hit the backend if no bank is linked — the endpoint returns 404,
    // which would show a misleading "Sync failed" error to the user.
    if (!state.user || !state.user.plaid_linked) {
      fcLog('Sync skipped — no bank linked');
      _setIslandText('Connect a bank to start');
      return;
    }

    // Rate-limit background syncs — skip if last sync was < 5 minutes ago.
    // User-triggered syncs (showToast=true) and post-link syncs always go through.
    const MIN_SYNC_INTERVAL_MS = 5 * 60 * 1000;
    if (!showToast && state.lastSyncAt && (Date.now() - state.lastSyncAt) < MIN_SYNC_INTERVAL_MS) {
      fcLog('Sync skipped — rate limited (last sync was < 5 min ago)');
      return;
    }

    state.syncing = true;
    let _syncSucceeded = false;

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
    const btn = document.getElementById('btn-plaid-link');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }

    try {
      await FCData.openPlaidLink();
      toast('Bank connected! Syncing your accounts…', 'success', 4000);
      // Mark onboarding done and kick off an immediate background sync
      await _markOnboardingComplete();
      setTimeout(() => _doSync(false), 600);
      // Always navigate to the app screen so home refreshes with bank data
      setScreen('app');
      _renderHome();
      // Then show paywall on top if user hasn't subscribed yet.
      // Configure RC first to force a live check (not stale localStorage cache).
      try { if (!FCPurchases.isConfigured()) await FCPurchases.configure(); } catch (_) {}
      const isPro = await FCPurchases.checkProStatus().catch(() => false);
      if (!isPro) {
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
    try {
      await FCAuth.signInWithBiometric();
      // Auth observer handles transition
    } catch (err) {
      if (err.message && err.message.includes('cancelled')) return;
      if (err.message && err.message.includes('expired')) {
        toast('Session expired — please sign in', 'info');
        setScreen('login');
      } else {
        toast('Face ID failed — use your password', 'error');
      }
    }
  }

  async function handleRegister(name, email, password) {
    _setLoading('btn-register', true, 'Creating account…');
    _clearError('register-error');
    try {
      // Sign out any cached session first — prevents onAuthStateChanged firing
      // with the OLD user before signUp completes and routing a new registrant
      // straight to the existing account's home screen.
      try { FCData.detachAllListeners(); _listenersAttached = false; await FCAuth.signOut(); } catch (_) {}
      await FCAuth.signUp(name, email, password);
      // Clear any stale RevenueCat pro cache from a previous test session
      // so the paywall always shows correctly for brand-new accounts.
      try { localStorage.removeItem('fc_pro_status_v1'); } catch (_) {}
      // Fire welcome email — non-blocking, never delays onboarding
      _sendWelcomeEmail().catch(() => {});
      // Auth observer will trigger onboarding
    } catch (err) {
      _showError('register-error', _friendlyAuthError(err));
      haptic('heavy');
    } finally {
      _setLoading('btn-register', false, 'Create Account');
    }
  }

  /** Non-blocking helper — POSTs to /email/welcome after signup. */
  async function _sendWelcomeEmail() {
    try {
      if (!FC_CONFIG.email || !FC_CONFIG.email.welcomeEndpoint) return;
      const token = await FCAuth.getIdToken();
      await fetch(FC_CONFIG.email.welcomeEndpoint, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
    } catch (_) { /* best-effort — never block signup */ }
  }

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

    FCData.detachAllListeners();
    await FCAuth.signOut();
    state.accounts     = [];
    state.transactions = [];
    state.bills        = [];
    state.goals        = [];
    state.user         = null;
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

  /** User tapped "Skip for now" on the last onboarding slide */
  let _skippingOnboarding = false;
  async function skipOnboarding() {
    if (_skippingOnboarding) return;         // debounce: ignore rapid double-taps
    _skippingOnboarding = true;
    haptic('light');
    try {
      await _markOnboardingComplete();
    } catch (_) {
      // Non-blocking — a Firestore error (e.g. RESOURCE_EXHAUSTED) must never
      // trap the user on the onboarding screen. The flag will be retried on
      // next launch via the normal auth boot path.
    } finally {
      // Gate non-pro users behind the paywall before entering the app.
      // Always configure RC first so we do a live check — not the localStorage
      // cache, which can falsely return true from a previous test purchase.
      try { if (!FCPurchases.isConfigured()) await FCPurchases.configure(); } catch (_) {}
      const isPro = await FCPurchases.checkProStatus().catch(() => false);
      if (!isPro) {
        showPaywall();
      } else {
        setScreen('app');
        _renderHome();
        setTimeout(() => _doSync(false), 800);
      }
      setTimeout(() => { _skippingOnboarding = false; }, 1500);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TOGGLE CONTROLS (Settings)
     ───────────────────────────────────────────────────────────── */

  async function toggleBiometric(enable) {
    try {
      await FCAuth.setBiometricEnabled(enable);
      await FCData.updateUserField('biometric_enabled', enable);
    } catch (err) {
      console.error('[toggleBiometric]', err.message);
    }
    toast(enable ? 'Face ID enabled' : 'Face ID disabled', 'success');
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

    FCData.listenToTransactions(100, transactions => {
      state.transactions = transactions;
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
    const db  = FCAuth.db();
    const uid = FCAuth.currentUser()?.uid;
    if (!db || !uid || !user.last_streak_date) return;
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

    // Observe Firebase auth state
    FCAuth.onAuthStateChanged(async user => {
      if (user) {
        fcLog('User authenticated:', user.uid);

        // Warm the Railway backend immediately after auth so it's ready
        // before the user taps anything — prevents cold-start timeouts.
        FCData.warmBackend();

        // Request push permissions (non-blocking)
        FCPush.requestAndRegister().catch(() => {});
        FCPush.requestLocalPermission().catch(() => {});

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
          setScreen('onboarding');
        } else {
          setScreen('app');
          _renderHome();
          setTimeout(() => _doSync(false), 900);
          if (biometricEnabled) showLockScreen();
          // Gate non-pro returning users — check Firestore first (instant),
          // then verify with RevenueCat if Firestore says not pro.
          if (!userDoc?.is_pro && !_paywallShownThisSession) {
            FCPurchases.checkProStatus().then(isPro => {
              if (!isPro && !_paywallShownThisSession) setTimeout(() => showPaywall(), 1500);
              else if (isPro) setTimeout(() => _tryStartTour(), 1400);
            }).catch(() => {});
          } else if (userDoc?.is_pro) {
            // Pro user — offer tour if they haven't seen it
            setTimeout(() => _tryStartTour(), 1400);
          }
        }
      } else {
        fcLog('No user — showing login');
        FCData.detachAllListeners();
        _listenersAttached = false; // allow re-attach on next sign-in
        setScreen('login');
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
        <div style="text-align:center;padding:40px 20px">
          <div style="font-size:32px;margin-bottom:10px">🔔</div>
          <div style="font-size:14px;color:var(--fc-text-faint)">No notifications yet</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.2);margin-top:4px">We'll alert you about bills, budgets, and more</div>
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
      const icons = {
        bill_due:     '💳', budget_alert: '⚠️', goal_reached: '🎯',
        sync_done:    '✅', general:      '🔔',
      };
      return icons[type] || '🔔';
    };

    listEl.innerHTML = notifs.map(n => `
      <div onclick="FCApp._notifTap('${esc(n.id)}','${esc(n.type || 'general')}')"
           style="display:flex;align-items:flex-start;gap:12px;padding:14px 20px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.04);${n.read ? '' : 'background:rgba(26,196,240,0.04)'}">
        <div style="width:36px;height:36px;border-radius:10px;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">${_typeIcon(n.type)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:${n.read ? 500 : 600};color:${n.read ? 'rgba(255,255,255,0.6)' : 'white'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(n.title || '')}</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:2px;line-height:1.4">${esc(n.body || '')}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.25);margin-top:4px">${_timeAgo(n.created_at)}</div>
        </div>
        ${n.read ? '' : '<div style="width:7px;height:7px;background:var(--fc-accent);border-radius:50%;flex-shrink:0;margin-top:4px"></div>'}
      </div>`
    ).join('');
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
    center.style.display  = 'block';
    center.style.pointerEvents = 'auto';
    requestAnimationFrame(() => {
      if (backdrop) backdrop.style.opacity = '1';
      if (panel) panel.style.transform = 'translateY(0)';
    });
    haptic('light');
  }

  function closeNotificationCenter() {
    const center   = document.getElementById('fc-notif-center');
    const backdrop = document.getElementById('fc-notif-backdrop');
    const panel    = document.getElementById('fc-notif-panel');
    if (!center) return;
    if (backdrop) backdrop.style.opacity = '0';
    if (panel) panel.style.transform = 'translateY(-100%)';
    setTimeout(() => {
      center.style.display = 'none';
    }, 300);
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
    setTimeout(() => switchTab(tab), 200);
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

    // Fetch all linked banks from Firestore
    try {
      const items = await FCData.getPlaidItems();
      if (!listEl) return;

      if (!items.length) {
        listEl.innerHTML = '<div style="color:var(--fc-text-faint);font-size:13px;padding:10px 0">No banks connected</div>';
        return;
      }

      listEl.innerHTML = items.map(item => {
        const name    = (item.institution || 'Bank Account').replace(/'/g, '&#39;');
        const itemId  = (item.item_id || item.id).replace(/'/g, '&#39;');
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
              onclick="FCApp.confirmDisconnectItem('${itemId}','${name}')"
              type="button">
              Disconnect
            </button>
          </div>`;
      }).join('');
    } catch (err) {
      console.error('[showBankSheet]', err);
      if (listEl) {
        listEl.innerHTML = '<div style="color:var(--fc-danger);font-size:13px;padding:10px 0">Could not load banks</div>';
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
    if (sheet) sheet.style.display = 'none';
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
    if (sheet) sheet.style.display = 'none';
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
    if (sheet) sheet.style.display = 'none';
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

  function showLockScreen(autoTrigger = true) {
    if (_lockActive) return;
    _lockActive = true;

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
      screen.style.transition = 'opacity 0.2s ease';
      screen.style.opacity    = '1';
    });

    if (autoTrigger) {
      // Small delay so the lock screen is visible before the OS dialog appears
      setTimeout(() => triggerBiometricUnlock(), 450);
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
    setScreen('paywall');
    haptic('light');
    _loadPaywallOfferings();
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
    if (plan === 'annual') {
      if (btn)   btn.textContent   = 'Start My Free Week →';
      if (terms) terms.textContent = 'Then $34.99/year. Cancel anytime in App Store settings.';
    } else {
      if (btn)   btn.textContent   = 'Start Monthly Plan';
      if (terms) terms.textContent = '$4.99/month. Cancel anytime in App Store settings.';
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
        await FCData.updateUserField('is_pro', true);
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
        if (overlay) {
          overlay.classList.add('visible');
        } else {
          // Fallback if overlay element missing
          toast('Welcome to FlowCheck Pro! 🎉', 'success', 4000);
          setScreen('app');
          _renderHome();
        }
      } else {
        // RevenueCat can be slow to reflect the new entitlement — retry once after 3 s
        if (btn) btn.textContent = 'Activating…';
        setTimeout(async () => {
          try {
            const isPro2 = await FCPurchases.checkProStatus();
            if (isPro2) {
              haptic('medium');
              await FCData.updateUserField('is_pro', true);
              setScreen('app');
              _renderHome();
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
            await FCData.updateUserField('is_pro', true);
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
        _renderHome();
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
    if (sheet) sheet.style.display = 'none';
    _editingGoalId = null;
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
    if (sheet) sheet.style.display = 'none';
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
    if (sheet) sheet.style.display = 'none';
    _editingBillId = null;
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
    if (sheet) sheet.style.display = 'none';
    _editingTxnId = null;
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
    if (sheet) sheet.style.display = 'none';
    _editingBudgetCategory = null;
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
      AppPlugin.addListener('appStateChange', ({ isActive }) => {
        if (isActive) _checkAndLock();
      });
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     PERIOD SELECTOR
     ───────────────────────────────────────────────────────────── */

  function switchPeriod(p) {
    if (state.period === p) return;
    state.period = p;
    haptic('light');

    // Update active button styling on ALL scrubbers (home + insights share data-period)
    document.querySelectorAll('.fc-scrubber button[data-period]').forEach(btn => {
      const active = btn.dataset.period === p;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    // Re-render home with new period data (chart + insights update inside _renderHome)
    if (state.tab === 'home') _renderHome();
    // Also refresh chart in insights view if that tab is active
    if (state.tab === 'insights') _renderInsights();
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
    handleLogin,
    handleBiometricLogin,
    handleRegister,
    handleForgotPassword,
    handleSignOut,
    handleSearch,
    startPlaidLink,
    // Credit score
    fetchCreditScore,
    refreshCreditScore,
    // Paywall
    showPaywall,
    skipPaywall,
    selectPlan,
    paywallPurchase,
    paywallRestore,
    renderHomeAfterPro,
    // Onboarding
    skipOnboarding,
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
        if (!t.date || t.isCredit) return false;
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
