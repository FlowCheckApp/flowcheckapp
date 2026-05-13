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

  /* ── Authenticated fetch helper ───────────────────────────── */
  async function _authedFetch(url, options = {}) {
    const user = FCAuth.currentUser();
    if (!user) throw new Error('Not authenticated');
    const idToken = await user.getIdToken();
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${res.status}`);
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
              // 4. Mark user as Plaid-linked in Firestore
              const user = FCAuth.currentUser();
              const db   = FCAuth.db();
              if (user && db) {
                await db.collection('users').doc(user.uid).update({
                  plaid_linked:          true,
                  plaid_institution:     metadata.institution.name,
                  plaid_institution_id:  metadata.institution.institution_id,
                  plaid_linked_at:       firebase.firestore.FieldValue.serverTimestamp(),
                });
              }
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

    const unsub = db.collection('users').doc(user.uid)
      .collection('accounts')
      .orderBy('balance', 'desc')
      .onSnapshot(snap => {
        const accounts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
      .limit(limitCount || 50)
      .onSnapshot(snap => {
        const txns = snap.docs.map(d => ({
          id: d.id,
          ...d.data(),
          // Normalise: Plaid returns negative for income
          amount: Math.abs(d.data().amount),
          isCredit: d.data().amount < 0,
        }));
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
      const d   = txn.date ? new Date(txn.date) : new Date();
      d.setHours(0,0,0,0);
      let label;
      if (+d === +today)     label = 'Today';
      else if (+d === +yesterday) label = 'Yesterday';
      else label = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

      if (!groups[label]) groups[label] = [];
      groups[label].push(txn);
    }
    return groups;
  }

  function categoryColor(category) {
    const map = {
      'Food and Drink':   '#ff6b35',
      'Shopping':         '#f093fb',
      'Travel':           '#4facfe',
      'Transfer':         '#43e97b',
      'Payment':          '#ffd60a',
      'Recreation':       '#a18cd1',
      'Healthcare':       '#fd79a8',
      'Service':          '#6c5ce7',
      'Income':           '#00b894',
      'Housing':          '#43e97b',
      'Utilities':        '#ffd60a',
      'Subscription':     '#1ac4f0',
    };
    if (!category) return '#555';
    for (const [key, val] of Object.entries(map)) {
      if (category.toLowerCase().includes(key.toLowerCase())) return val;
    }
    return '#6b7c93';
  }

  function categoryInitial(name) {
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

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const due   = new Date(dateStr); due.setHours(0,0,0,0);
    const today = new Date(); today.setHours(0,0,0,0);
    return Math.round((due - today) / 86400000);
  }

  function billDueLabelAndColor(days) {
    if (days < 0)  return { label: 'Overdue',           color: 'var(--fc-danger)' };
    if (days === 0) return { label: 'Due today',         color: 'var(--fc-danger)' };
    if (days === 1) return { label: 'Due tomorrow',      color: 'var(--fc-danger)' };
    if (days <= 3)  return { label: `Due in ${days} days`, color: 'var(--fc-warning)' };
    return { label: `${new Date(Date.now() + days * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${days} days`, color: 'var(--fc-text-faint)' };
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
      current:    0,
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
    deleteAccount,
    listenToUser,
    listenToAccounts,
    listenToTransactions,
    listenToBills,
    listenToGoals,
    listenToBudgets,
    detachAllListeners,
    updateUserField,
    markBillPaid,
    createGoal,
    updateGoalProgress,
    calcNetWorth,
    calcCash,
    groupTransactionsByDate,
    categoryColor,
    categoryInitial,
    daysUntil,
    billDueLabelAndColor,
    formatCurrency,
  };
})();
