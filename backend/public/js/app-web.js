/**
 * FlowCheck — Web app (/app)
 * ─────────────────────────────────────────────────────────────────
 * The real app on the web: your actual accounts, bills, goals and runway,
 * read from the same Firestore documents the phone reads, with the numbers
 * computed by the same shared module (fc-core.js).
 *
 * NON-NEGOTIABLES, all of which are enforced below:
 *  1. Every string that originates from a user or from Plaid is escaped
 *     before it touches innerHTML. Bill and goal names are user-typed;
 *     merchant and institution names come from Plaid — third-party data we
 *     do not control. Three stored-XSS holes of exactly this shape were
 *     found in the native app; this file must not add a fourth.
 *  2. No financial data in localStorage or sessionStorage. Ever. The only
 *     thing persisted is the privacy-mode preference, which describes the
 *     room you are in, not your money.
 *  3. Writes go only through the fields firestore.rules allows. Bills and
 *     goals live in subcollections the owner may write; `pro`, `is_pro`,
 *     `plaid_linked` and `referral_code` are backend-only and never touched.
 */
(function () {
  'use strict';

  firebase.initializeApp({
    apiKey: 'AIzaSyBtdCUetv2nRPiaZVt-_TXUtd77wxqLVSw',
    authDomain: 'flowcheck-46570.firebaseapp.com',
    projectId: 'flowcheck-46570',
    storageBucket: 'flowcheck-46570.firebasestorage.app',
    messagingSenderId: '305596636244',
    appId: '1:305596636244:web:75dc2c36fbc8afc9bca1c1',
  });

  const auth = firebase.auth();
  const db = firebase.firestore();

  let uid = null;
  const state = { user: {}, accounts: [], transactions: [], bills: [], goals: [] };

  /* ── Escaping ─────────────────────────────────────────────────── */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ESC[c]);

  /* ── Formatting ───────────────────────────────────────────────── */
  const money = n => {
    const v = Number(n || 0);
    const s = Math.abs(v).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    return (v < 0 ? '−' : '') + s;
  };
  const dLabel = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  /* ── Privacy mode ─────────────────────────────────────────────── */
  const PRIV_KEY = 'fc_privacy_mode';
  let privacyOn = false;
  try { privacyOn = localStorage.getItem(PRIV_KEY) === '1'; } catch (_) {}

  function applyPrivacy() {
    document.body.classList.toggle('fc-privacy', privacyOn);
    const b = document.getElementById('btn-privacy');
    b.setAttribute('aria-pressed', String(privacyOn));
    b.setAttribute('aria-label', privacyOn ? 'Show balances' : 'Hide balances');
    b.classList.toggle('is-on', privacyOn);
  }

  /* ── Runway chart. Same geometry as _renderRunwayCard in the app. ── */
  function runwaySVG(r) {
    const W = 320, H = 120, PAD_T = 10, PAD_B = 20;
    const maxV = Math.max(r.startBalance, 0);
    const minV = Math.min(r.lowest.balance, 0);
    const span = Math.max(1, maxV - minV);
    const x = d => (d / Math.max(1, r.horizon)) * W;
    const y = v => PAD_T + (1 - (v - minV) / span) * (H - PAD_T - PAD_B);

    const pts = r.points;
    const line = pts.map((p, i) => (i ? 'L' : 'M') + x(p.day).toFixed(1) + ',' + y(p.balance).toFixed(1)).join(' ');
    const area = line + ' L' + W + ',' + y(minV).toFixed(1) + ' L0,' + y(minV).toFixed(1) + ' Z';
    const stroke = r.goesNegative ? 'var(--red)' : 'var(--accent)';

    const markers = pts.filter(p => p.bills.length).map(p =>
      '<g class="rw-marker">'
      + '<line x1="' + x(p.day).toFixed(1) + '" y1="' + y(p.balance).toFixed(1) + '" x2="' + x(p.day).toFixed(1) + '" y2="' + (H - PAD_B) + '" stroke="var(--border-2)" stroke-width="1" stroke-dasharray="2 3"/>'
      + '<circle cx="' + x(p.day).toFixed(1) + '" cy="' + y(p.balance).toFixed(1) + '" r="3.6" fill="var(--bg-card)" stroke="' + stroke + '" stroke-width="2"/>'
      + '</g>').join('');

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<defs><linearGradient id="rwGradApp" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0%" stop-color="' + stroke + '" stop-opacity="0.24"/>'
      + '<stop offset="100%" stop-color="' + stroke + '" stop-opacity="0"/></linearGradient></defs>'
      + (minV < 0 ? '<line x1="0" y1="' + y(0).toFixed(1) + '" x2="' + W + '" y2="' + y(0).toFixed(1) + '" stroke="var(--red)" stroke-width="1" stroke-dasharray="3 3" opacity="0.55"/>' : '')
      + '<path class="rw-area" d="' + area + '" fill="url(#rwGradApp)"/>'
      + '<path class="rw-line" d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'
      + markers
      + '<circle class="rw-endpoint" cx="' + x(r.horizon).toFixed(1) + '" cy="' + y(r.endBalance).toFixed(1) + '" r="4.5" fill="' + stroke + '"/>'
      + '</svg>';
  }

  function runwayCard(r) {
    const pts = r.points;
    const edge = r.hasPayday ? 'Payday' : 'In 2 weeks';
    const headline = r.goesNegative
      ? 'You run short on ' + dLabel(pts[r.firstNegativeDay].date)
      : (r.billCount
          ? (r.hasPayday ? 'You make it to payday' : 'You are covered for 2 weeks')
          : (r.hasPayday ? 'Nothing due before payday' : 'Nothing due in the next 2 weeks'));
    let sub = r.goesNegative
      ? 'Move or delay a bill to stay above zero.'
      : (r.billCount ? r.billCount + ' bill' + (r.billCount === 1 ? '' : 's') + ' between now and then.' : 'This is all yours.');
    if (!r.hasPayday) sub += ' Payday not detected yet.';

    return '<section class="fc-ui-card rw-card">'
      + '<div class="rw-head"><div class="rw-head__text">'
      + '<p class="rw-eyebrow">Runway</p>'
      + '<h2 class="rw-headline' + (r.goesNegative ? ' rw-headline--warn' : '') + '">' + esc(headline) + '</h2>'
      + '<p class="rw-sub">' + esc(sub) + '</p></div>'
      + '<div class="rw-end"><p class="rw-end-lbl">' + esc(edge) + '</p>'
      + '<p class="rw-endpoint-value fc-amount' + (r.endBalance < 0 ? ' rw-endpoint-value--warn' : '') + '">'
      + esc(money(r.endBalance)) + '</p></div></div>'
      + '<div class="rw-chart">' + runwaySVG(r)
      + '<div class="rw-axis"><span>Today</span><span>' + esc(dLabel(pts[pts.length - 1].date)) + '</span></div></div>'
      + '<div class="rw-trust"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>'
      + '<span>Read-only · FlowCheck cannot move your money</span></div>'
      + '</section>';
  }

  /* ── Safe to spend ────────────────────────────────────────────── */
  function safeCard(r) {
    const p = r.projection;
    return '<section class="fc-ui-card wa-safe">'
      + '<p class="rw-eyebrow">Safe to spend</p>'
      + '<p class="wa-safe-n fc-amount">' + esc(money(p.safe)) + '</p>'
      + '<p class="wa-safe-sub">' + esc('After ' + money(p.billsTotal) + ' of bills, expected spending, and a '
        + money(p.reserve) + ' buffer' + (p.payday ? ' — over the next ' + p.days + ' days' : '')) + '</p>'
      + '</section>';
  }

  /* ── Accounts ─────────────────────────────────────────────────── */
  function accountsCard() {
    if (!state.accounts.length) {
      return '<section class="fc-ui-card wa-empty">'
        + '<h3 class="wa-h">No accounts connected</h3>'
        + '<p class="wa-empty-p">Connect a bank in the iPhone app and it appears here automatically.</p>'
        + '<a class="rw-cta" href="https://apps.apple.com/app/flowcheck/id6742624701">Get the app</a></section>';
    }
    const rows = state.accounts.map(a => {
      const bal = a.balance_current != null ? a.balance_current : (a.balance || 0);
      const neg = bal < 0;
      return '<li class="wa-row">'
        + '<div class="wa-row-main"><span class="wa-row-name">' + esc(a.name || 'Account') + '</span>'
        + '<span class="wa-row-sub">' + esc(a.institution || a.subtype || a.type || '') + '</span></div>'
        + '<span class="wa-row-amt fc-amount' + (neg ? ' is-neg' : '') + '">' + esc(money(bal)) + '</span></li>';
    }).join('');
    return '<section class="fc-ui-card"><h3 class="wa-h">Accounts</h3><ul class="wa-list">' + rows + '</ul></section>';
  }

  /* ── Bills — editable ─────────────────────────────────────────── */
  function billsCard() {
    const bills = state.bills.slice().sort((a, b) =>
      (FCCore.daysUntil(a.due_date) ?? 999) - (FCCore.daysUntil(b.due_date) ?? 999));

    const rows = bills.length ? bills.map(b => {
      const d = FCCore.daysUntil(b.due_date);
      const paid = b.status === 'paid';
      const overdue = !paid && d !== null && d < 0;
      const when = paid ? 'Paid'
        : d === null ? 'No date'
        : d < 0 ? Math.abs(d) + ' day' + (Math.abs(d) === 1 ? '' : 's') + ' overdue'
        : d === 0 ? 'Due today'
        : d === 1 ? 'Due tomorrow'
        : 'Due in ' + d + ' days';
      return '<li class="wa-row' + (paid ? ' is-paid' : '') + '">'
        + '<div class="wa-row-main"><span class="wa-row-name">' + esc(b.name || 'Bill') + '</span>'
        + '<span class="wa-row-sub' + (overdue ? ' is-overdue' : '') + '">' + esc(when) + '</span></div>'
        + '<span class="wa-row-amt fc-amount">' + esc(money(b.amount)) + '</span>'
        + '<button class="wa-mark" type="button" data-bill="' + esc(b.id) + '" data-paid="' + (paid ? '1' : '0') + '" '
        + 'aria-label="' + (paid ? 'Mark unpaid' : 'Mark paid') + '">'
        + (paid
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>'
            : '<span class="wa-mark-dot"></span>')
        + '</button></li>';
    }).join('') : '';

    return '<section class="fc-ui-card"><h3 class="wa-h">Bills</h3>'
      + (rows ? '<ul class="wa-list wa-list--bills">' + rows + '</ul>'
              : '<p class="wa-empty-p">No bills yet. Add one in the app and it shows up here.</p>')
      + '</section>';
  }

  /* ── Goals ────────────────────────────────────────────────────── */
  function goalsCard() {
    if (!state.goals.length) return '';
    const rows = state.goals.map(g => {
      const target = Number(g.target || 0);
      const cur = Number(g.current || 0);
      const pct = target > 0 ? Math.max(0, Math.min(100, Math.round((cur / target) * 100))) : 0;
      return '<li class="wa-goal">'
        + '<div class="wa-goal-top"><span class="wa-row-name">' + esc(g.name || 'Goal') + '</span>'
        + '<span class="wa-row-sub fc-amount">' + esc(money(cur)) + ' of ' + esc(money(target)) + '</span></div>'
        + '<div class="wa-bar"><i style="width:' + pct + '%"></i></div></li>';
    }).join('');
    return '<section class="fc-ui-card"><h3 class="wa-h">Goals</h3><ul class="wa-list">' + rows + '</ul></section>';
  }

  /* ── Render ───────────────────────────────────────────────────── */
  function render() {
    const r = FCCore.buildRunwaySeries({
      accounts: state.accounts, transactions: state.transactions, bills: state.bills,
    });
    const name = String(state.user.name || '').trim().split(/\s+/)[0] || 'there';
    const hour = new Date().getHours();
    const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    const html =
      '<header class="wa-head"><div><h1 class="wa-greet">' + esc(greet + ', ' + name) + '</h1>'
      + '<p class="wa-date">' + esc(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })) + '</p></div>'
      + '<span class="wa-live">Same numbers as your phone</span></header>'
      + runwayCard(r)
      + safeCard(r)
      + '<div class="wa-grid">' + accountsCard() + billsCard() + '</div>'
      + goalsCard()
      + '<p class="wa-legal">FlowCheck is not a bank. Not financial advice.</p>';

    const el = document.getElementById('wa-content');
    el.innerHTML = html;
    el.hidden = false;
    document.getElementById('wa-loading').hidden = true;
    applyPrivacy();
  }

  /* ── Bill paid/unpaid toggle ──────────────────────────────────── */
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.wa-mark');
    if (!btn || !uid) return;
    const id = btn.getAttribute('data-bill');
    const paid = btn.getAttribute('data-paid') === '1';
    btn.disabled = true;
    const local = state.bills.find(b => b.id === id);
    if (local) local.status = paid ? 'unpaid' : 'paid';   // optimistic
    render();
    try {
      await db.collection('users').doc(uid).collection('bills').doc(id).update({
        status: paid ? 'unpaid' : 'paid',
        paid_at: paid ? null : firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      if (local) local.status = paid ? 'paid' : 'unpaid'; // roll back
      render();
      alert('Could not update that bill. Please try again.');
    }
  });

  /* ── Demo mode (/app?demo=1) ──────────────────────────────────────
     Renders the real interface with obviously-fake fixtures so the web
     app can be seen without an account. Banner is not optional: a screen
     full of dollar figures must never be mistakable for someone's real
     money. No auth, no Firestore reads, no writes. */
  function demoFixtures() {
    const iso = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
    const ago = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
    return {
      user: { name: 'Demo' },
      accounts: [
        { id: 'a1', name: 'Demo Checking', institution: 'Demo Bank', type: 'depository', subtype: 'checking', balance_current: 3241.87 },
        { id: 'a2', name: 'Demo Savings',  institution: 'Demo Bank', type: 'depository', subtype: 'savings',  balance_current: 12800 },
        { id: 'a3', name: 'Demo Visa',     institution: 'Demo Bank', type: 'credit',     subtype: 'credit card', balance_current: -723.55 },
      ],
      bills: [
        { id: 'b1', name: 'Rent',     amount: 1200,  due_date: iso(6),  status: 'upcoming' },
        { id: 'b2', name: 'Electric', amount: 89.5,  due_date: iso(12), status: 'upcoming' },
        { id: 'b3', name: 'Internet', amount: 59.99, due_date: iso(18), status: 'upcoming' },
      ],
      goals: [
        { id: 'g1', name: 'Emergency Fund', target: 3000, current: 1300 },
        { id: 'g2', name: 'Vacation Fund',  target: 2000, current: 950 },
      ],
      transactions: [
        { id: 't1', name: 'Payroll', amount: 2100, isCredit: true, date: ago(1),  category: 'Income' },
        { id: 't2', name: 'Payroll', amount: 2100, isCredit: true, date: ago(15), category: 'Income' },
        { id: 't3', name: 'Payroll', amount: 2100, isCredit: true, date: ago(29), category: 'Income' },
        { id: 't4', name: 'Groceries', amount: 320, isCredit: false, date: ago(4),  category: 'Food and Drink' },
        { id: 't5', name: 'Dining',    amount: 180, isCredit: false, date: ago(9),  category: 'Food and Drink' },
        { id: 't6', name: 'Shopping',  amount: 240, isCredit: false, date: ago(17), category: 'Shopping' },
      ],
    };
  }

  /* Chrome listeners are wired BEFORE the demo branch below. They used to sit
     at the bottom of this file, after an early `return` in the demo path —
     so in demo mode the privacy and sign-out buttons silently did nothing. */
  document.getElementById('btn-signout').addEventListener('click', async () => {
    try { await auth.signOut(); } catch (_) {}
    window.location.href = '/';
  });

  document.getElementById('btn-privacy').addEventListener('click', () => {
    privacyOn = !privacyOn;
    try { localStorage.setItem(PRIV_KEY, privacyOn ? '1' : '0'); } catch (_) {}
    applyPrivacy();
  });

  if (new URLSearchParams(location.search).get('demo') === '1') {
    Object.assign(state, demoFixtures());
    render();
    const b = document.createElement('div');
    b.className = 'wa-demo-banner';
    b.textContent = 'Demo data — not a real account. Sign in to see your own numbers.';
    document.getElementById('wa-content').prepend(b);
    return;
  }

  /* ── Auth + live data ─────────────────────────────────────────── */
  auth.onAuthStateChanged(async (user) => {
    if (!user) { window.location.href = '/login'; return; }
    uid = user.uid;

    const base = db.collection('users').doc(uid);
    try {
      const doc = await base.get();
      state.user = doc.exists ? doc.data() : {};
      if (!state.user.name && user.displayName) state.user.name = user.displayName;
    } catch (_) { state.user = {}; }

    let first = true;
    const ready = () => { if (first) { first = false; } render(); };

    base.collection('accounts').onSnapshot(s => {
      state.accounts = s.docs.map(d => Object.assign({ id: d.id }, d.data())); ready();
    }, () => ready());

    base.collection('transactions').orderBy('date', 'desc').limit(500).onSnapshot(s => {
      state.transactions = s.docs.map(d => {
        const t = Object.assign({ id: d.id }, d.data());
        if (t.isCredit === undefined) t.isCredit = Number(t.amount) < 0;
        t.amount = Math.abs(Number(t.amount || 0));
        return t;
      });
      ready();
    }, () => ready());

    base.collection('bills').onSnapshot(s => {
      state.bills = s.docs.map(d => Object.assign({ id: d.id }, d.data())); ready();
    }, () => ready());

    base.collection('goals').onSnapshot(s => {
      state.goals = s.docs.map(d => Object.assign({ id: d.id }, d.data())); ready();
    }, () => ready());

    setTimeout(ready, 2500);   // render even if a collection is empty/denied
  });

})();
