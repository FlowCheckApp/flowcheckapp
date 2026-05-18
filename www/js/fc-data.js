/**
 * FlowCheck — Data Layer
 * ─────────────────────────────────────────────────────────────
 * Handles: Plaid Link, Firestore reads/writes, real-time listeners,
 *          transaction formatting, balance aggregation.
 *
 * Architecture note: Plaid access_tokens NEVER touch the client.
 * All Plaid API calls go through your backend. This module only:
 *   1. Opens Plaid Link to get a public_token
 *   2. Sends public_token to YOUR backend for exchange
 *   3. Reads cached data your backend writes to Firestore
 * ─────────────────────────────────────────────────────────────
 */
window.FCData = (function () {
  'use strict';

  /* ── State ────────────────────────────────────────────────── */
  let _listeners   = [];   // Active Firestore unsubscribe functions
  let _plaidHandler = null;

  /**
   * Parse a Plaid/Firestore date string "YYYY-MM-DD" as LOCAL midnight.
   * `new Date("2026-05-17")` parses as UTC midnight which is the prior
   * evening in US timezones — causing off-by-one day bugs everywhere.
   */
  function parseDateLocal(dateStr) {
    if (!dateStr) return new Date();
    if (typeof dateStr === 'object' && dateStr.toDate) return dateStr.toDate(); // Firestore Timestamp
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(y, m - 1, d); // local midnight
  }

  /* ── Authenticated fetch helper ───────────────────────────── */
  /**
   * Fetch with:
   *  - 15-second AbortController timeout (prevents hang if backend is down)
   *  - Auto 401 retry: forces a Firebase token refresh and retries once
   *  - Friendly error messages for common failure modes
   */
  async function _authedFetch(url, options = {}, _retried = false) {
    const user = FCAuth.currentUser();
    if (!user) throw new Error('Not authenticated');

    const idToken = await user.getIdToken();

    // Hard 15-second timeout — Railway cold-starts can be slow but shouldn't hang forever
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 15_000);

    let res;
    try {
      res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${idToken}`,
          ...(options.headers || {}),
        },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('Request timed out — check your connection and try again');
      }
      throw new Error('Could not reach FlowCheck servers — check your internet connection');
    }
    clearTimeout(timeoutId);

    // 401: Firebase token may have expired — refresh once and retry
    if (res.status === 401 && !_retried) {
      await user.getIdToken(true); // force server-side refresh
      return _authedFetch(url, options, true);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 429) throw new Error('Too many requests — please wait a moment and try again');
      if (res.status >= 500) throw new Error('FlowCheck servers are temporarily unavailable — try again shortly');
      throw new Error(err.message || `Request failed (HTTP ${res.status})`);
    }
    return res.json();
  }

  /* ─────────────────────────────────────────────────────────────
     PLAID LINK
     ───────────────────────────────────────────────────────────── */

  /** Open Plaid Link. Resolves when user successfully connects a bank. */
  async function openPlaidLink() {
    return new Promise(async (resolve, reject) => {
      try {
        // 1. Get link_token from your backend
        const { link_token } = await _authedFetch(FC_CONFIG.plaid.linkTokenEndpoint, {
          method: 'POST',
        });

        // 2. Initialise Plaid Link
        _plaidHandler = window.Plaid.create({
          token: link_token,

          onSuccess: async (publicToken, metadata) => {
            fcLog('Plaid Link success:', metadata.institution);
            try {
              // 3. Exchange public_token on backend
              const result = await _authedFetch(FC_CONFIG.plaid.exchangeTokenEndpoint, {
                method: 'POST',
                body: JSON.stringify({ public_token: publicToken, metadata }),
              });
              // Backend (exchange-token) already writes plaid_linked, plaid_institution,
              // plaid_institution_id, plaid_linked_at via Admin SDK — no client write needed.
              resolve({ institution: metadata.institution, ...result });
            } catch (err) {
              reject(err);
            }
          },

          onExit: (err, metadata) => {
            if (err) {
              console.error('[FCData] Plaid Link exit with error:', err);
              reject(new Error(err.display_message || 'Plaid Link closed'));
            } else {
              reject(new Error('cancelled'));
            }
          },

          onEvent: (eventName, metadata) => {
            fcLog('Plaid event:', eventName, metadata);
          },
        });

        _plaidHandler.open();
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Trigger a backend sync and wait for Firestore to update */
  async function syncTransactions() {
    if (!FC_CONFIG.app.backendConfigured) {
      fcLog('Sync skipped — backend not configured yet (set backendConfigured: true in fc-config.js)');
      return;
    }
    await _authedFetch(FC_CONFIG.plaid.syncEndpoint);
  }

  /**
   * Disconnect the linked bank account.
   * Revokes Plaid item server-side, wipes all financial data from
   * Firestore, and sets plaid_linked: false on the user document.
   * Required by Plaid ToS and CCPA right-to-deletion.
   */
  async function disconnectBank() {
    if (!FC_CONFIG.app.backendConfigured) throw new Error('Backend not configured');
    await _authedFetch(FC_CONFIG.plaid.disconnectEndpoint, { method: 'DELETE' });
  }

  /**
   * Disconnect a single Plaid item (one bank) by item_id.
   * Deletes only that bank's accounts/transactions. If it was
   * the last bank, backend sets plaid_linked: false.
   */
  async function disconnectBankItem(itemId) {
    if (!FC_CONFIG.app.backendConfigured) throw new Error('Backend not configured');
    await _authedFetch(`${FC_CONFIG.plaid.disconnectEndpoint}/${itemId}`, { method: 'DELETE' });
  }

  /**
   * Read all linked Plaid items via the backend (access_tokens never reach client).
   * Returns array of { id, item_id, institution, institution_id, linked_at, … }
   */
  async function getPlaidItems() {
    try {
      const result = await _authedFetch(`${FC_CONFIG.app.apiBase}/plaid/items`);
      return result.items || [];
    } catch (err) {
      console.error('[getPlaidItems]', err.message);
      return [];
    }
  }

  /**
   * Permanently delete this account and all associated data.
   * Calls the backend which: revokes Plaid, deletes all Firestore
   * collections, and deletes the Firebase Auth user.
   * CCPA Article 17 / Right to Erasure compliant.
   */
  async function deleteAccount() {
    if (!FC_CONFIG.app.backendConfigured) throw new Error('Backend not configured');
    await _authedFetch(FC_CONFIG.user.deleteEndpoint, { method: 'DELETE' });
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — USER
     ───────────────────────────────────────────────────────────── */

  function listenToUser(callback) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;

    const unsub = db.collection('users').doc(user.uid)
      .onSnapshot(snap => {
        if (snap.exists) callback({ id: snap.id, ...snap.data() });
      }, err => console.error('[FCData] User listener error:', err));

    _listeners.push(unsub);
    return unsub;
  }

  async function updateUserField(field, value) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).update({ [field]: value });
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — ACCOUNTS & BALANCES
     ───────────────────────────────────────────────────────────── */

  function listenToAccounts(callback) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;

    // NOTE: No orderBy here — orderBy('balance_current') requires a Firestore
    // composite index that may not exist, causing the listener to silently
    // return nothing. We sort client-side instead.
    const unsub = db.collection('users').doc(user.uid)
      .collection('accounts')
      .onSnapshot(snap => {
        const accounts = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.balance_current || 0) - (a.balance_current || 0));
        callback(accounts);
      }, err => console.error('[FCData] Accounts listener error:', err));

    _listeners.push(unsub);
    return unsub;
  }

  function calcNetWorth(accounts) {
    return accounts.reduce((sum, a) => {
      const bal = a.balance_current || a.balance || 0;
      // Liabilities (credit cards, loans) reduce net worth
      const sign = ['credit', 'loan', 'mortgage'].includes(a.type) ? -1 : 1;
      return sum + sign * bal;
    }, 0);
  }

  function calcCash(accounts) {
    return accounts
      .filter(a => ['depository', 'checking', 'savings'].includes(a.type))
      .reduce((sum, a) => sum + (a.balance_current || a.balance || 0), 0);
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — TRANSACTIONS
     ───────────────────────────────────────────────────────────── */

  function listenToTransactions(limitCount, callback) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;

    const unsub = db.collection('users').doc(user.uid)
      .collection('transactions')
      .orderBy('date', 'desc')
      .limit(limitCount || 500)
      .onSnapshot(snap => {
        const txns = snap.docs.map(d => {
          const data = d.data();
          // isCredit is stored by the backend (after server fix).
          // Fallback: raw Plaid negative amount = income (old data compatibility).
          const isCredit = data.isCredit !== undefined
            ? data.isCredit
            : (data.amount < 0);
          return {
            id: d.id,
            ...data,
            amount: Math.abs(data.amount),
            isCredit,
          };
        });
        callback(txns);
      }, err => console.error('[FCData] Transactions listener error:', err));

    _listeners.push(unsub);
    return unsub;
  }

  function groupTransactionsByDate(transactions) {
    const groups = {};
    const today     = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

    for (const txn of transactions) {
      // Use parseDateLocal to avoid UTC→local day-shift bug
      const d = parseDateLocal(txn.date);
      d.setHours(0,0,0,0);
      let label;
      if (+d === +today)          label = 'Today';
      else if (+d === +yesterday) label = 'Yesterday';
      else label = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

      if (!groups[label]) groups[label] = [];
      groups[label].push(txn);
    }
    return groups;
  }

  function categoryColor(category) {
    const map = {
      // Food
      'Food and Drink':     '#ff6b35',
      'Restaurants':        '#ff6b35',
      'Fast Food':          '#ff8c42',
      'Coffee Shop':        '#c67c52',
      'Grocery':            '#f9a825',
      'Food':               '#ff6b35',
      // Shopping
      'Shopping':           '#f093fb',
      'General Merchandise':'#e056cd',
      'Clothing':           '#fd79a8',
      'Electronics':        '#a29bfe',
      'Online Shopping':    '#6c5ce7',
      // Travel & Transport
      'Travel':             '#4facfe',
      'Airlines':           '#00cec9',
      'Hotels':             '#0984e3',
      'Car Rental':         '#74b9ff',
      'Auto and Transport': '#2d3436',
      'Gas Stations':       '#636e72',
      'Parking':            '#b2bec3',
      'Ride Share':         '#6c5ce7',
      'Public Transit':     '#00b894',
      'Taxi':               '#fdcb6e',
      // Financial
      'Transfer':           '#43e97b',
      'Payment':            '#ffd60a',
      'Credit Card':        '#e17055',
      'Loan':               '#d63031',
      'Mortgage':           '#b2bec3',
      'Bank Fees':          '#ff7675',
      // Health
      'Healthcare':         '#fd79a8',
      'Medical':            '#e84393',
      'Pharmacy':           '#fd79a8',
      'Gym':                '#ff6b9d',
      'Fitness':            '#c44569',
      // Utilities & Home
      'Utilities':          '#ffd60a',
      'Housing':            '#55efc4',
      'Rent':               '#00b894',
      'Electric':           '#fdcb6e',
      'Internet':           '#74b9ff',
      'Phone':              '#a29bfe',
      // Entertainment
      'Recreation':         '#a18cd1',
      'Entertainment':      '#e17055',
      'Movies':             '#6c5ce7',
      'Music':              '#fd79a8',
      'Sports':             '#00b894',
      // Subscriptions & Services
      'Subscription':       '#1ac4f0',
      'Service':            '#6c5ce7',
      'Software':           '#0984e3',
      'Streaming':          '#e84393',
      // Personal
      'Personal Care':      '#fab1a0',
      'Spa':                '#fd79a8',
      'Hair':               '#e17055',
      // Education
      'Education':          '#0984e3',
      'Books':              '#74b9ff',
      'Tuition':            '#4facfe',
      // Income
      'Income':             '#00b894',
      'Payroll':            '#00b894',
      'Deposit':            '#55efc4',
      // Other
      'ATM':                '#b2bec3',
      'Community':          '#a29bfe',
      'Charity':            '#fd79a8',
      'Taxes':              '#e17055',
    };
    if (!category) return '#555570';
    const lower = category.toLowerCase();
    for (const [key, val] of Object.entries(map)) {
      if (lower.includes(key.toLowerCase())) return val;
    }
    return '#6b7c93';
  }

  function categoryInitial(name) {
    return name ? name.charAt(0).toUpperCase() : '?';
  }

  // Returns an emoji icon for a transaction/category — much more recognizable than a letter
  function categoryEmoji(categoryArr, name) {
    const cat  = (Array.isArray(categoryArr) ? (categoryArr[0] || '') : (categoryArr || '')).toLowerCase();
    const nm   = (name || '').toLowerCase();

    // Name-based overrides (most specific)
    if (nm.includes('netflix'))    return '🎬';
    if (nm.includes('spotify'))    return '🎵';
    if (nm.includes('apple'))      return '🍎';
    if (nm.includes('amazon'))     return '📦';
    if (nm.includes('starbucks'))  return '☕';
    if (nm.includes('uber eats') || nm.includes('doordash') || nm.includes('grubhub')) return '🛵';
    if (nm.includes('uber') || nm.includes('lyft')) return '🚗';
    if (nm.includes('airbnb'))     return '🏠';
    if (nm.includes('delta') || nm.includes('united') || nm.includes('southwest') || nm.includes('american air')) return '✈️';
    if (nm.includes('target'))     return '🎯';
    if (nm.includes('walmart'))    return '🏬';
    if (nm.includes('costco'))     return '🏪';
    if (nm.includes('gas') || nm.includes('shell') || nm.includes('chevron') || nm.includes('exxon')) return '⛽';
    if (nm.includes('gym') || nm.includes('planet fitness') || nm.includes('la fitness')) return '💪';
    if (nm.includes('hulu') || nm.includes('disney') || nm.includes('paramount') || nm.includes('hbo') || nm.includes('max')) return '📺';
    if (nm.includes('microsoft') || nm.includes('office') || nm.includes('adobe')) return '💻';
    if (nm.includes('google'))     return '🔍';
    if (nm.includes('paypal'))     return '💰';
    if (nm.includes('venmo') || nm.includes('zelle') || nm.includes('cashapp')) return '💸';
    if (nm.includes('hospital') || nm.includes('clinic') || nm.includes('pharmacy') || nm.includes('cvs') || nm.includes('walgreen')) return '💊';
    if (nm.includes('insurance'))  return '🛡️';
    if (nm.includes('rent') || nm.includes('mortgage')) return '🏡';
    if (nm.includes('electric') || nm.includes('pg&e') || nm.includes('con ed')) return '⚡';
    if (nm.includes('water'))      return '💧';
    if (nm.includes('internet') || nm.includes('comcast') || nm.includes('verizon') || nm.includes('att') || nm.includes('tmobile')) return '📡';

    // Category-based
    if (cat.includes('food') || cat.includes('restaurant') || cat.includes('dining')) return '🍽️';
    if (cat.includes('coffee'))    return '☕';
    if (cat.includes('grocery'))   return '🛒';
    if (cat.includes('fast food')) return '🍔';
    if (cat.includes('travel'))    return '✈️';
    if (cat.includes('hotel'))     return '🏨';
    if (cat.includes('transport') || cat.includes('auto') || cat.includes('gas')) return '🚗';
    if (cat.includes('shopping'))  return '🛍️';
    if (cat.includes('clothing'))  return '👕';
    if (cat.includes('entertain')) return '🎭';
    if (cat.includes('streaming') || cat.includes('subscription')) return '📺';
    if (cat.includes('music'))     return '🎵';
    if (cat.includes('health') || cat.includes('medical')) return '🏥';
    if (cat.includes('pharmacy'))  return '💊';
    if (cat.includes('gym') || cat.includes('fitness') || cat.includes('sport')) return '🏋️';
    if (cat.includes('education'))  return '📚';
    if (cat.includes('housing') || cat.includes('rent')) return '🏠';
    if (cat.includes('electric') || cat.includes('util')) return '⚡';
    if (cat.includes('phone'))     return '📱';
    if (cat.includes('internet'))  return '🌐';
    if (cat.includes('software'))  return '💻';
    if (cat.includes('income') || cat.includes('payroll') || cat.includes('deposit')) return '💰';
    if (cat.includes('transfer'))  return '↔️';
    if (cat.includes('payment'))   return '💳';
    if (cat.includes('atm'))       return '🏧';
    if (cat.includes('invest'))    return '📈';
    if (cat.includes('insurance')) return '🛡️';
    if (cat.includes('charity'))   return '❤️';
    if (cat.includes('personal'))  return '🧴';
    if (cat.includes('hair') || cat.includes('beauty')) return '💇';
    if (cat.includes('pet'))       return '🐾';
    if (cat.includes('child') || cat.includes('kid'))   return '👶';
    if (cat.includes('tax'))       return '📋';
    if (cat.includes('parking'))   return '🅿️';

    // Fallback to first letter of name
    return name ? name.charAt(0).toUpperCase() : '?';
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — BILLS
     ───────────────────────────────────────────────────────────── */

  function listenToBills(callback) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;

    const unsub = db.collection('users').doc(user.uid)
      .collection('bills')
      .orderBy('due_date', 'asc')
      .onSnapshot(snap => {
        const bills = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        callback(bills);
      }, err => console.error('[FCData] Bills listener error:', err));

    _listeners.push(unsub);
    return unsub;
  }

  async function markBillPaid(billId) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid)
      .collection('bills').doc(billId)
      .update({ status: 'paid', paid_at: firebase.firestore.FieldValue.serverTimestamp() });
  }

  async function createBill(bill) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).collection('bills').add({
      name:       bill.name || 'Unnamed Bill',
      amount:     parseFloat(bill.amount) || 0,
      due_date:   bill.due_date || null,
      category:   bill.category || 'Other',
      frequency:  bill.frequency || 'monthly',
      status:     'pending',
      created_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function updateBill(billId, fields) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).collection('bills').doc(billId).update({
      ...fields,
      updated_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function deleteBill(billId) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).collection('bills').doc(billId).delete();
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    // Use parseDateLocal so "2026-05-19" is treated as local midnight,
    // not UTC midnight (which is the prior evening in US timezones).
    const due   = parseDateLocal(dateStr); due.setHours(0,0,0,0);
    const today = new Date(); today.setHours(0,0,0,0);
    return Math.round((due - today) / 86400000);
  }

  function billDueLabelAndColor(days) {
    if (days < 0)   return { label: 'Overdue',                color: 'var(--fc-danger)' };
    if (days === 0) return { label: 'Due today',               color: 'var(--fc-danger)' };
    if (days === 1) return { label: 'Due tomorrow',            color: 'var(--fc-warning)' };
    if (days <= 3)  return { label: `Due in ${days} days`,     color: 'var(--fc-warning)' };
    if (days <= 7)  return { label: `Due in ${days} days`,     color: 'var(--fc-text-muted)' };
    const label = new Date(Date.now() + days * 86400000)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ` · ${days} days`;
    return { label, color: 'var(--fc-text-faint)' };
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — GOALS
     ───────────────────────────────────────────────────────────── */

  function listenToGoals(callback) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;

    const unsub = db.collection('users').doc(user.uid)
      .collection('goals')
      .orderBy('created_at', 'desc')
      .onSnapshot(snap => {
        const goals = snap.docs.map(d => ({
          id: d.id,
          ...d.data(),
          pct: Math.round(((d.data().current || 0) / (d.data().target || 1)) * 100),
        }));
        callback(goals);
      }, err => console.error('[FCData] Goals listener error:', err));

    _listeners.push(unsub);
    return unsub;
  }

  async function createGoal(goal) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).collection('goals').add({
      ...goal,
      current:    (goal.current != null && !isNaN(goal.current)) ? parseFloat(goal.current) : 0,
      created_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function updateGoalProgress(goalId, amount) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).collection('goals').doc(goalId).update({
      current:    amount,
      updated_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function updateGoal(goalId, fields) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).collection('goals').doc(goalId).update({
      ...fields,
      updated_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function deleteGoal(goalId) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).collection('goals').doc(goalId).delete();
  }

  async function createManualAccount(account) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).collection('accounts').add({
      ...account,
      manual:     true,
      created_at: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function deleteManualAccount(accountId) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid).collection('accounts').doc(accountId).delete();
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — BUDGETS (spending limits by category)
     ───────────────────────────────────────────────────────────── */

  function listenToBudgets(callback) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;

    const unsub = db.collection('users').doc(user.uid)
      .collection('budgets')
      .onSnapshot(snap => {
        const budgets = {};
        snap.docs.forEach(d => { budgets[d.id] = { id: d.id, ...d.data() }; });
        callback(budgets);
      }, err => console.error('[FCData] Budgets listener error:', err));

    _listeners.push(unsub);
    return unsub;
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — TRANSACTION OVERRIDES
     Users can rename any Plaid transaction and change its category.
     Stored at users/{uid}/transaction_overrides/{txn_id}.
     Applied client-side on top of the raw Plaid data.
     ───────────────────────────────────────────────────────────── */

  /**
   * Listen to all transaction overrides for this user.
   * Callback receives a plain object: { [txnId]: {name, category} }
   */
  function listenToTransactionOverrides(callback) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;

    const unsub = db.collection('users').doc(user.uid)
      .collection('transaction_overrides')
      .onSnapshot(snap => {
        const overrides = {};
        snap.docs.forEach(d => { overrides[d.id] = d.data(); });
        callback(overrides);
      }, err => console.error('[FCData] TransactionOverrides listener error:', err));

    _listeners.push(unsub);
    return unsub;
  }

  /**
   * Persist a rename/re-categorize override for one transaction.
   * @param {string} txnId  - Plaid transaction_id
   * @param {object} fields - { name?, category? } — only set fields are written
   */
  async function setTransactionOverride(txnId, fields) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) throw new Error('Not authenticated');
    await db.collection('users').doc(user.uid)
      .collection('transaction_overrides').doc(txnId)
      .set({
        ...fields,
        updated_at: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — BUDGETS: SET PER-CATEGORY LIMIT
     ───────────────────────────────────────────────────────────── */

  /**
   * Set (or update) a spending limit for a category.
   * @param {string} category - e.g. 'Food and Drink', 'Shopping', or 'total'
   * @param {number} limit    - monthly spending limit in USD
   */
  async function setBudget(category, limit) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) throw new Error('Not authenticated');
    await db.collection('users').doc(user.uid)
      .collection('budgets').doc(category)
      .set({
        limit:      parseFloat(limit) || 0,
        category,
        updated_at: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — CREDIT SCORE HISTORY
     Monthly snapshots stored at users/{uid}/credit_history/{YYYY-MM}.
     Used to render a trend sparkline in the credit score card.
     ───────────────────────────────────────────────────────────── */

  /**
   * Save today's credit score as a monthly snapshot.
   * Idempotent — overwrites the same YYYY-MM doc on re-check.
   * @param {number} score - numeric credit score (e.g. 712)
   */
  async function saveCreditSnapshot(score) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db || !score) return;
    const monthKey = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
    await db.collection('users').doc(user.uid)
      .collection('credit_history').doc(monthKey)
      .set({
        score:      score,
        month:      monthKey,
        updated_at: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
  }

  /**
   * Listen to credit score history (last 13 months, ordered by month key).
   * Callback receives array of { month: 'YYYY-MM', score: number } sorted oldest-first.
   */
  function listenToCreditHistory(callback) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;

    const unsub = db.collection('users').doc(user.uid)
      .collection('credit_history')
      .orderBy('month', 'asc')
      .limit(13)
      .onSnapshot(snap => {
        const history = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        callback(history);
      }, err => console.error('[FCData] CreditHistory listener error:', err));

    _listeners.push(unsub);
    return unsub;
  }

  /* ─────────────────────────────────────────────────────────────
     FIRESTORE — NOTIFICATIONS
     ───────────────────────────────────────────────────────────── */

  /**
   * Listen to the user's notifications subcollection (most recent 30).
   * Callback receives array of { id, title, body, type, read, created_at, … }
   */
  function listenToNotifications(callback) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;

    const unsub = db.collection('users').doc(user.uid)
      .collection('notifications')
      .orderBy('created_at', 'desc')
      .limit(30)
      .onSnapshot(snap => {
        const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        callback(items);
      }, err => console.error('[FCData] Notifications listener error:', err));

    _listeners.push(unsub);
    return unsub;
  }

  /** Mark a single notification as read in Firestore */
  async function markNotificationRead(notifId) {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    await db.collection('users').doc(user.uid)
      .collection('notifications').doc(notifId).update({ read: true });
  }

  /** Mark all notifications read in Firestore */
  async function markAllNotificationsRead() {
    const user = FCAuth.currentUser();
    const db   = FCAuth.db();
    if (!user || !db) return;
    const snap = await db.collection('users').doc(user.uid)
      .collection('notifications').where('read', '==', false).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { read: true }));
    await batch.commit();
  }

  /* ─────────────────────────────────────────────────────────────
     CLEANUP
     ───────────────────────────────────────────────────────────── */

  function detachAllListeners() {
    _listeners.forEach(unsub => { try { unsub(); } catch (_) {} });
    _listeners = [];
    if (_plaidHandler) { try { _plaidHandler.destroy(); } catch (_) {} }
    _plaidHandler = null;
    fcLog('All data listeners detached');
  }

  /* ── Format helpers ──────────────────────────────────────── */
  function formatCurrency(amount, showSign = false) {
    const abs = Math.abs(amount);
    const formatted = abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (showSign) return amount < 0 ? `-$${formatted}` : `+$${formatted}`;
    return `$${formatted}`;
  }

  /* ── Public API ───────────────────────────────────────────── */
  return {
    openPlaidLink,
    syncTransactions,
    disconnectBank,
    disconnectBankItem,
    getPlaidItems,
    deleteAccount,
    listenToUser,
    listenToAccounts,
    listenToTransactions,
    listenToBills,
    listenToGoals,
    listenToBudgets,
    listenToTransactionOverrides,
    setTransactionOverride,
    setBudget,
    saveCreditSnapshot,
    listenToCreditHistory,
    listenToNotifications,
    markNotificationRead,
    markAllNotificationsRead,
    detachAllListeners,
    updateUserField,
    markBillPaid,
    createBill,
    updateBill,
    deleteBill,
    createGoal,
    updateGoalProgress,
    updateGoal,
    deleteGoal,
    createManualAccount,
    deleteManualAccount,
    calcNetWorth,
    calcCash,
    parseDateLocal,
    groupTransactionsByDate,
    categoryColor,
    categoryInitial,
    categoryEmoji,
    daysUntil,
    billDueLabelAndColor,
    formatCurrency,
  };
})();
