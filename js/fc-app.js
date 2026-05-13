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
    screen:       'splash',   // splash | login | register | onboarding | app
    tab:          'home',
    user:         null,
    accounts:     [],
    transactions: [],
    bills:        [],
    goals:        [],
    budgets:      {},
    syncing:      false,
    searchQuery:  '',
  };

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
    if (tabId === 'activity') _renderActivity();
    if (tabId === 'insights') _renderInsights();
    if (tabId === 'goals')    _renderGoals();
    if (tabId === 'settings') _renderSettings();

    window.scrollTo({ top: 0, behavior: 'instant' });
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

  function showSkeleton(containerId) {
    const el = document.getElementById(containerId);
    if (el) el.classList.add('fc-skeleton-wrap');
  }

  function hideSkeleton(containerId) {
    const el = document.getElementById(containerId);
    if (el) el.classList.remove('fc-skeleton-wrap');
  }

  /* ─────────────────────────────────────────────────────────────
     GREETING
     ───────────────────────────────────────────────────────────── */

  function _updateGreeting() {
    const h = new Date().getHours();
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name  = (state.user && state.user.name) ? state.user.name.split(' ')[0] : 'Brandon';
    document.querySelectorAll('.fc-greeting-text').forEach(el => {
      el.innerHTML = `${greet},<br>${name}`;
    });
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: HOME
     ───────────────────────────────────────────────────────────── */

  function _renderHome() {
    // Net worth
    const netWorth = FCData.calcNetWorth(state.accounts);
    const nwEl     = document.getElementById('hero-networth');
    if (nwEl) animateNumber(nwEl, netWorth, '$');

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
        billsEl.innerHTML = upcoming.map(b => {
          const days = FCData.daysUntil(b.due_date);
          const { label, color } = FCData.billDueLabelAndColor(days);
          const bg = b.color || FCData.categoryColor(b.category || 'Service');
          return `
            <div class="fc-list-item">
              <div class="fc-list-icon" style="background:${bg};color:white;font-weight:700;font-size:16px">
                ${b.icon || b.name.charAt(0)}
              </div>
              <div class="fc-list-body">
                <div class="fc-list-title">${b.name}</div>
                <div class="fc-list-meta" style="color:${color};font-weight:${days <= 1 ? 600 : 400}">${label}</div>
              </div>
              <div class="fc-list-amount">${FCData.formatCurrency(b.amount)}</div>
            </div>`;
        }).join('');
      }

      // Badge count
      const overdue = state.bills.filter(b => b.status !== 'paid' && FCData.daysUntil(b.due_date) <= 3);
      const badgeEl = document.getElementById('bills-badge');
      if (badgeEl) {
        badgeEl.textContent = overdue.length;
        badgeEl.style.display = overdue.length ? 'inline-flex' : 'none';
      }
    }

    // Subs total
    const subsEl = document.getElementById('stat-subs');
    if (subsEl) {
      const subTotal = state.bills
        .filter(b => b.type === 'subscription')
        .reduce((sum, b) => sum + (b.amount || 0), 0);
      subsEl.textContent = FCData.formatCurrency(subTotal);
    }

    // Bills due stat
    const billsStatEl = document.getElementById('stat-bills');
    if (billsStatEl) {
      const total = state.bills.filter(b => b.status !== 'paid').reduce((s, b) => s + b.amount, 0);
      billsStatEl.textContent = FCData.formatCurrency(total);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     RENDER: ACTIVITY
     ───────────────────────────────────────────────────────────── */

  function _renderActivity() {
    const container = document.getElementById('activity-list');
    if (!container) return;

    const filtered = state.searchQuery
      ? state.transactions.filter(t =>
          t.name && t.name.toLowerCase().includes(state.searchQuery.toLowerCase()))
      : state.transactions;

    if (!filtered.length) {
      container.innerHTML = `
        <div style="text-align:center;padding:48px 24px;color:var(--fc-text-faint)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:12px;opacity:0.4"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg>
          <div style="font-size:15px;font-weight:500;margin-bottom:4px;color:var(--fc-text-muted)">
            ${state.accounts.length ? 'No transactions yet' : 'Connect a bank to see transactions'}
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
        const bg    = FCData.categoryColor(t.category && t.category[0]);
        const init  = FCData.categoryInitial(t.name);
        const color = t.isCredit ? 'var(--fc-success)' : 'var(--fc-danger)';
        const sign  = t.isCredit ? '+' : '-';
        const cat   = (t.category && t.category[0]) || 'Other';
        return `
          <div class="fc-list-item">
            <div class="fc-list-icon" style="background:${bg};color:white;font-weight:700;font-size:15px">${init}</div>
            <div class="fc-list-body">
              <div class="fc-list-title">${t.name || 'Transaction'}</div>
              <div class="fc-list-meta">${cat}</div>
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

    // Group spending by category this month
    const now = new Date();
    const thisMonth = state.transactions.filter(t => {
      if (!t.date) return false;
      const d = new Date(t.date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && !t.isCredit;
    });

    const catMap = {};
    let totalSpend = 0;
    for (const t of thisMonth) {
      const cat = (t.category && t.category[0]) || 'Other';
      catMap[cat] = (catMap[cat] || 0) + t.amount;
      totalSpend += t.amount;
    }

    // Update total spend
    const totalEl = document.getElementById('insights-total-spend');
    if (totalEl) animateNumber(totalEl, totalSpend, '$');

    // User's budget (if set)
    const budget = state.budgets['total'] ? state.budgets['total'].limit : 3000;
    const pct    = Math.min(Math.round((totalSpend / budget) * 100), 100);
    const barEl  = document.getElementById('insights-budget-fill');
    if (barEl) {
      const color = pct > 90 ? 'var(--fc-danger)' : pct > 70 ? 'var(--fc-warning)' : 'var(--fc-accent)';
      barEl.style.width = pct + '%';
      barEl.style.background = color;
    }
    const remEl = document.getElementById('insights-budget-remaining');
    if (remEl) remEl.textContent = `${FCData.formatCurrency(Math.max(0, budget - totalSpend))} remaining`;

    if (!thisMonth.length) {
      container.innerHTML = `<div style="color:var(--fc-text-faint);text-align:center;padding:32px 0;font-size:14px">No spending data yet</div>`;
      return;
    }

    const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 6);
    container.innerHTML = sorted.map(([cat, amount]) => {
      const p   = totalSpend ? Math.round((amount / totalSpend) * 100) : 0;
      const col = FCData.categoryColor(cat);
      return `
        <div class="fc-category-row">
          <div class="fc-category-dot" style="background:${col}"></div>
          <div class="fc-category-label">${cat}</div>
          <div class="fc-category-amount">${FCData.formatCurrency(amount)}<span class="fc-category-pct">${p}%</span></div>
        </div>
        <div class="fc-category-bar"><div class="fc-category-bar-fill" style="width:${p}%;background:${col}"></div></div>`;
    }).join('');
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
          <div class="fc-goal-card">
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
              <div class="fc-h3" style="font-size:15px;margin-bottom:3px">${g.name}</div>
              <div class="fc-xs">${FCData.formatCurrency(g.current || 0)} of ${FCData.formatCurrency(g.target)}</div>
              <div class="fc-progress-bar" style="margin-top:8px">
                <div class="fc-progress-fill" style="width:${pct}%;background:${pct >= 100 ? 'var(--fc-success)' : 'linear-gradient(90deg,var(--fc-accent),var(--fc-purple))'}"></div>
              </div>
            </div>
          </div>`;
      }).join('');
    }
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
  }

  /* ─────────────────────────────────────────────────────────────
     PULL-TO-REFRESH
     ───────────────────────────────────────────────────────────── */

  let _pullStartY  = 0;
  let _pulling     = false;
  let _pullRefreshEl = null;

  function _initPullToRefresh() {
    _pullRefreshEl = document.getElementById('fc-pull-indicator');

    document.addEventListener('touchstart', e => {
      // Only allow pull-to-refresh on the main app screen
      if (state.screen !== 'app') return;
      if (window.scrollY === 0) {
        _pullStartY = e.touches[0].clientY;
        _pulling    = true;
      }
    }, { passive: true });

    document.addEventListener('touchmove', e => {
      if (!_pulling) return;
      const delta = e.touches[0].clientY - _pullStartY;
      // Require at least 10px before showing indicator (avoid accidental triggers)
      if (delta > 10 && delta < 80 && _pullRefreshEl) {
        _pullRefreshEl.style.transform = `translateY(${Math.min(delta * 0.5, 40)}px)`;
        _pullRefreshEl.style.opacity   = Math.min(delta / 60, 1);
      }
    }, { passive: true });

    document.addEventListener('touchend', async () => {
      if (!_pulling) return;
      _pulling = false;
      if (_pullRefreshEl) {
        _pullRefreshEl.style.transform = '';
        _pullRefreshEl.style.opacity   = '';
      }
      // Require meaningful pull (40px+) before triggering sync
      await _doSync();
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

    state.syncing = true;

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
          islandText.textContent = 'Sync failed';
          islandText.classList.remove('fc-fade');
        }, 200);
      }
      // Always show errors so the user knows something went wrong
      toast('Sync failed — check connection', 'error');
    } finally {
      state.syncing = false;
      setTimeout(() => {
        if (islandText) {
          islandText.classList.add('fc-fade');
          setTimeout(() => {
            islandText.textContent = 'All caught up';
            islandText.classList.remove('fc-fade');
          }, 200);
        }
      }, 3000);
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
      setScreen('app');
      // Data listeners will auto-update via Firestore
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
      await FCAuth.signUp(name, email, password);
      // Auth observer will trigger onboarding
    } catch (err) {
      _showError('register-error', _friendlyAuthError(err));
      haptic('heavy');
    } finally {
      _setLoading('btn-register', false, 'Create Account');
    }
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

  /* ─────────────────────────────────────────────────────────────
     TOGGLE CONTROLS (Settings)
     ───────────────────────────────────────────────────────────── */

  async function toggleBiometric(enable) {
    await FCAuth.setBiometricEnabled(enable);
    await FCData.updateUserField('biometric_enabled', enable);
    toast(enable ? 'Face ID enabled' : 'Face ID disabled', 'success');
  }

  async function toggleNotifications(enable) {
    if (enable) {
      const granted = await FCPush.requestAndRegister();
      if (!granted) {
        toast('Notifications blocked — enable in iOS Settings', 'info');
        return false;
      }
    }
    await FCData.updateUserField('notifications_enabled', enable);
    return true;
  }

  /* ─────────────────────────────────────────────────────────────
     DATA LISTENERS (attach after login)
     ───────────────────────────────────────────────────────────── */

  function _attachDataListeners() {
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
    });

    FCData.listenToTransactions(100, transactions => {
      state.transactions = transactions;
      if (state.tab === 'activity') _renderActivity();
      if (state.tab === 'insights') _renderInsights();
    });

    FCData.listenToBills(bills => {
      state.bills = bills;
      if (state.tab === 'home') _renderHome();
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

    // Wire up nav
    document.querySelectorAll('.fc-nav-item').forEach(item => {
      item.addEventListener('click', () => switchTab(item.dataset.view));
    });

    // Wire up scrubbers
    document.querySelectorAll('.fc-scrubber button').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.fc-scrubber').querySelectorAll('button').forEach(b => {
          b.classList.remove('active'); b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        haptic('light');
      });
    });

    // Activity search
    const searchInput = document.getElementById('activity-search');
    if (searchInput) {
      searchInput.addEventListener('input', e => handleSearch(e.target.value));
    }

    // Wire up app-resume lock (runs once — the listener persists)
    _initAppResumeLock();

    // Observe Firebase auth state
    FCAuth.onAuthStateChanged(async user => {
      if (user) {
        fcLog('User authenticated:', user.uid);

        // Request push permissions (non-blocking)
        FCPush.requestAndRegister().catch(() => {});
        FCPush.requestLocalPermission().catch(() => {});

        // Attach real-time data listeners
        _attachDataListeners();

        // Navigate to the correct screen
        const userDoc = await FCAuth.getUserDoc();
        if (userDoc && !userDoc.plaid_linked) {
          setScreen('onboarding');
        } else {
          setScreen('app');
          _renderHome();
          // Show lock screen on first load if biometrics are enabled.
          // (App-resume lock handles subsequent background-to-foreground.)
          const biometricEnabled = await FCAuth.isBiometricEnabled();
          if (biometricEnabled) showLockScreen();
        }
      } else {
        fcLog('No user — showing login');
        FCData.detachAllListeners();
        setScreen('login');
      }
    });
  }

  /* ── Public API ───────────────────────────────────────────── */
  function manualSync() {
    _doSync(true); // user-initiated — show toast
  }

  /* ─────────────────────────────────────────────────────────────
     BANK MANAGEMENT SHEET
     ───────────────────────────────────────────────────────────── */

  function showBankSheet() {
    const sheet = document.getElementById('fc-bank-sheet');
    if (!sheet) return;
    // Populate bank name from state
    const nameEl = document.getElementById('sheet-bank-name');
    if (nameEl && state.user && state.user.plaid_institution) {
      nameEl.textContent = state.user.plaid_institution;
    }
    sheet.style.display = 'flex';
    haptic('light');
  }

  function closeBankSheet() {
    const sheet = document.getElementById('fc-bank-sheet');
    if (sheet) sheet.style.display = 'none';
  }

  function showDisconnectConfirm() {
    closeBankSheet();
    const sheet = document.getElementById('fc-disconnect-sheet');
    if (!sheet) return;
    // Reset button state in case of previous error
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
      await FCData.disconnectBank();
      // Close all sheets
      document.querySelectorAll('.fc-sheet-overlay').forEach(s => { s.style.display = 'none'; });
      // Detach listeners — data is gone
      FCData.detachAllListeners();
      toast('Bank disconnected', 'success');
      haptic('medium');
      // Return to onboarding so user can reconnect or skip
      setTimeout(() => setScreen('onboarding'), 600);
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

  let _lockActive = false;

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
    if (sub)    sub.textContent = 'Use Face ID to unlock';

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
    if (sub)    sub.textContent = 'Authenticating…';

    try {
      // Prompt Face ID — verifies user identity without a new sign-in
      await FCAuth.promptBiometric('Unlock FlowCheck');

      // Success — animate then dismiss
      haptic('medium');
      if (btn) btn.classList.add('fc-lock-success');
      if (sub) sub.textContent = '';
      if (status) { status.textContent = 'Unlocked'; status.className = 'fc-lock-status success'; }

      setTimeout(() => hideLockScreen(), 480);

    } catch (err) {
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
      if (sub) sub.textContent = 'Use Face ID to unlock';

      if (!cancelled) {
        if (status) { status.textContent = 'Face ID failed — try again'; status.className = 'fc-lock-status error'; }
        // Auto re-prompt after a moment to match iOS behaviour
        setTimeout(() => {
          if (!_lockActive) return;
          if (btn) btn.classList.remove('fc-lock-fail');
          if (status) { status.textContent = ''; status.className = 'fc-lock-status'; }
        }, 1400);
      } else {
        // User cancelled — let them tap manually
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
    const user = FCAuth.currentUser();
    if (!user) return; // Not authenticated — no need to lock
    const enabled = await FCAuth.isBiometricEnabled();
    if (enabled) showLockScreen();
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
    // Settings toggles
    toggleBiometric,
    toggleNotifications,
    // Face ID lock screen
    showLockScreen,
    hideLockScreen,
    triggerBiometricUnlock,
    unlockWithPassword,
    // Utilities
    animateNumber,
  };
})();

/* ── Boot on DOM ready ───────────────────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => FCApp.boot());
} else {
  FCApp.boot();
}
