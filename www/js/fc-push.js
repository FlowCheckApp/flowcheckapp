/**
 * FlowCheck — Push & Local Notifications Module
 * ─────────────────────────────────────────────────────────────
 * Handles: FCM token registration, push notification permission,
 *          bill-due local notifications, notification tap routing.
 * ─────────────────────────────────────────────────────────────
 */
window.FCPush = (function () {
  'use strict';

  const Cap   = () => window.Capacitor && window.Capacitor.Plugins;
  const Push  = () => Cap() && Cap().PushNotifications;
  const Local = () => Cap() && Cap().LocalNotifications;

  let _listenersAdded = false;
  let _fcmToken = null;

  /* ── Notification ID namespaces ───────────────────────────────
     Local-notification IDs must be stable and non-colliding. Bill
     reminders are derived deterministically from the bill id (so a
     re-sync reschedules the SAME id instead of stacking duplicates),
     and recurring engagement notifications live in a reserved range
     that bill re-syncs must never cancel. */
  const NOTIF_BILL_MIN   = 1000;
  const NOTIF_BILL_MAX   = 799999;
  const NOTIF_WEEKLY_RECAP = 900001;
  const NOTIF_PAYDAY       = 900002;
  const RESERVED_IDS = [NOTIF_WEEKLY_RECAP, NOTIF_PAYDAY];

  /** Stable 32-bit hash → bill-reminder id. Same bill always maps to the
   *  same id, so rescheduling replaces rather than duplicates. */
  function _billNotifId(bill) {
    if (Number.isFinite(bill && bill.notification_id)) return bill.notification_id;
    const key = String((bill && (bill.id || bill.name)) || 'bill');
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    return NOTIF_BILL_MIN + (Math.abs(h) % (NOTIF_BILL_MAX - NOTIF_BILL_MIN));
  }

  /* ── Request permission & register ──────────────────────── */
  async function requestAndRegister() {
    const push = Push();
    if (!push) {
      fcLog('PushNotifications plugin not available (web/simulator)');
      return false;
    }

    try {
      const permission = await push.requestPermissions();
      // 'denied' = user explicitly blocked; 'prompt' = not yet asked (shouldn't
      // land here after requestPermissions returns). Anything else ('granted',
      // 'provisional', unknown) we treat as granted and proceed.
      if (permission.receive === 'denied') {
        fcLog('Push permission denied by user');
        return false;
      }

      // Attach listeners BEFORE calling register() so the 'registration' event
      // (which delivers the FCM token) is never missed if register() resolves
      // synchronously or the listener fires in the same microtask tick.
      _attachListeners();

      // register() initiates APNs registration. The actual token arrives
      // asynchronously via the 'registration' listener above — we must NOT
      // treat a register() rejection as "no permission". Network errors,
      // APNs misconfigs, or simulator limitations all cause register() to
      // throw even when the user has explicitly granted permission.
      try {
        await push.register();
      } catch (regErr) {
        // Log for diagnostics but do NOT return false — the OS permission was
        // granted. The token may arrive later when connectivity is restored.
        console.error('[FCPush] APNs register() failed (non-fatal):', regErr);
      }

      fcLog('Push notifications permission granted, registration initiated');
      return true;
    } catch (err) {
      console.error('[FCPush] requestPermissions failed:', err);
      return false;
    }
  }

  /* ── Save a token to Firestore + backend ────────────────────── */
  async function _saveToken(token) {
    if (!token || token === _fcmToken) return;
    _fcmToken = token;
    fcLog('FCM token:', token.slice(0, 12) + '…');
    try {
      const user = FCAuth.currentUser();
      const db   = FCAuth.db();
      if (user && db) {
        await db.collection('users').doc(user.uid).set({
          fcm_token:      token,
          fcm_updated_at: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        const idToken     = await user.getIdToken();
        const registerUrl = (window.FC_CONFIG && FC_CONFIG.notifications && FC_CONFIG.notifications.registerEndpoint)
                          || 'https://getflowcheck.app/notifications/register';
        fetch(registerUrl, {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ fcm_token: token }),
          signal:  AbortSignal.timeout(10_000),
        }).catch(err => console.error('[FCPush] Backend token register failed:', err.message));
      }
    } catch (err) {
      console.error('[FCPush] Failed to save FCM token:', err);
    }
  }

  /* ── Attach Capacitor push listeners ─────────────────────── */
  function _attachListeners() {
    if (_listenersAdded) return;
    _listenersAdded = true;

    const push = Push();
    if (!push) return;

    // Primary: Capacitor registration event (fires with FCM token when
    // FirebaseMessaging is installed, or raw APNs token as fallback)
    push.addListener('registration', async (token) => {
      await _saveToken(token.value);
    });

    // Foreground notification received
    push.addListener('pushNotificationReceived', (notification) => {
      fcLog('Foreground push received:', notification);
      const title = notification.title || '';
      const body  = notification.body  || '';

      // 1. Show as in-app toast (iOS best practice — no duplicate system banner)
      if (window.FCApp && window.FCApp.toast) {
        FCApp.toast(body || title || 'New notification', 'info', 5000);
      }

      // Note: notification is stored server-side by the backend when it sends the push.
      // Client-side writes to /notifications are blocked by Firestore rules (backend-only).
      // The notification center listener will pick up the server-written doc automatically.
    });

    // Notification tapped (app was backgrounded/closed)
    push.addListener('pushNotificationActionPerformed', (action) => {
      fcLog('Push tapped:', action);
      const data = action.notification && action.notification.data;
      if (!data) return;

      // Full routing map — all notification types → correct tab
      const routeMap = {
        payday:                    'home',
        early_pay:                 'home',
        large_txn:                 'activity',
        low_balance:               'home',
        budget_alert:              'insights',
        bill_due:                  'activity',
        bill_overdue:              'activity',
        subscription_renewal:      'insights',
        subscription_price_change: 'insights',
        savings_milestone:         'wealth',
        net_worth_change:          'wealth',
        ai_insight:                'insights',
        duplicate_charge:          'activity',
        security:                  'settings',
        weekly_summary:            'home',
        monthly_summary:           'home',
        goal_reached:              'wealth',
        sync_done:                 'home',
      };
      const tab = routeMap[data.type] || 'home';
      if (window.FCApp && window.FCApp.switchTab) {
        FCApp.switchTab(tab);
      }
    });

    // Registration error
    push.addListener('registrationError', (err) => {
      console.error('[FCPush] Registration error:', err);
    });

    // ── LOCAL notification tapped ──────────────────────────────
    // Separate plugin from PushNotifications — without this listener a
    // tapped bill/payday/recap reminder just opened the app doing nothing.
    const local = Local();
    if (local && typeof local.addListener === 'function') {
      local.addListener('localNotificationActionPerformed', (action) => {
        const extra = (action && action.notification && action.notification.extra) || {};
        fcLog('[FCPush] local notification tapped:', extra.type);
        if (!window.FCApp) return;
        // Defer so the app has finished its resume/render pass first
        setTimeout(() => {
          try {
            if (extra.type === 'weekly_recap' && FCApp.openMoneyStory) {
              FCApp.switchTab && FCApp.switchTab('home');
              FCApp.openMoneyStory();
            } else if (extra.type === 'bill_due') {
              FCApp.switchTab && FCApp.switchTab('plan');
            } else {
              FCApp.switchTab && FCApp.switchTab('home');
            }
          } catch (_) {}
        }, 350);
      });
    }
  }

  /* ── Check current OS permission status (no prompt) ─────── */
  async function checkPermissions() {
    const push = Push();
    if (!push) return 'unavailable';
    try {
      const result = await push.checkPermissions();
      return result.receive; // 'granted' | 'denied' | 'prompt'
    } catch (_) { return 'unavailable'; }
  }

  /* ── Request local notification permission ───────────────── */
  async function requestLocalPermission() {
    const local = Local();
    if (!local) return false;
    try {
      const result = await local.requestPermissions();
      return result.display === 'granted';
    } catch (_) { return false; }
  }

  /* ── Schedule a bill-due local notification ──────────────── */
  async function scheduleBillReminder(bill) {
    const local = Local();
    if (!local) return;

    // Parse as local midnight (avoids UTC→local day-shift bug on "YYYY-MM-DD")
    const [y, m, d] = String(bill.due_date).split('-').map(Number);
    const dueDate   = new Date(y, m - 1, d);
    // Notify 1 day before at 9 AM
    const notifyAt  = new Date(dueDate);
    notifyAt.setDate(notifyAt.getDate() - 1);
    notifyAt.setHours(9, 0, 0, 0);

    if (notifyAt <= new Date()) return; // Already past

    try {
      await local.schedule({
        notifications: [{
          id:    _billNotifId(bill),
          title: `${bill.name} due tomorrow`,
          body:  `$${bill.amount.toFixed(2)} will be charged tomorrow. Tap to review.`,
          schedule: { at: notifyAt },
          sound: 'default',
          extra: { type: 'bill_due', bill_id: bill.id },
          smallIcon: 'ic_notification',
          iconColor: '#1ac4f0',
        }],
      });
      fcLog(`Scheduled reminder for ${bill.name} at ${notifyAt}`);
    } catch (err) {
      console.error('[FCPush] Failed to schedule local notification:', err);
    }
  }

  /* ── Schedule reminders for all upcoming bills ───────────── */
  async function scheduleAllBillReminders(bills) {
    // Cancel existing first to avoid duplicates
    await cancelAllBillReminders();
    for (const bill of (bills || [])) {
      if (bill.due_date && bill.status !== 'paid') {
        await scheduleBillReminder(bill);
      }
    }
  }

  /* ── Cancel scheduled bill reminders ─────────────────────────
     Only touches the bill-id range. Recurring engagement
     notifications (weekly recap, payday) survive a bill re-sync —
     cancelling everything here used to silently wipe them. */
  async function cancelAllBillReminders() {
    const local = Local();
    if (!local) return;
    try {
      const pending = await local.getPending();
      const doomed = (pending && pending.notifications || [])
        .filter(n => !RESERVED_IDS.includes(n.id));
      if (doomed.length) {
        await local.cancel({ notifications: doomed.map(n => ({ id: n.id })) });
      }
    } catch (_) {}
  }

  /* ── Weekly recap: "Your Money Week is ready" ─────────────────
     Sundays at 6pm local. This is the retention loop that pulls
     people back into the Money Week story. */
  async function scheduleWeeklyRecap() {
    const local = Local();
    if (!local) return false;
    try {
      await local.cancel({ notifications: [{ id: NOTIF_WEEKLY_RECAP }] }).catch(() => {});
      await local.schedule({
        notifications: [{
          id:    NOTIF_WEEKLY_RECAP,
          title: 'Your Money Week is ready',
          body:  'See where your money actually went — a 30-second recap.',
          // repeats: fires every Sunday at 18:00 local
          schedule: { on: { weekday: 1, hour: 18, minute: 0 }, allowWhileIdle: true },
          sound: 'default',
          extra: { type: 'weekly_recap' },
          smallIcon: 'ic_notification',
          iconColor: '#1ac4f0',
        }],
      });
      fcLog('[FCPush] weekly recap scheduled (Sun 6pm)');
      return true;
    } catch (err) {
      fcLog('[FCPush] weekly recap schedule failed:', err && err.message);
      return false;
    }
  }

  /* ── Payday reminder ──────────────────────────────────────────
     Fired the morning a predicted paycheck lands, so the user opens
     the app at the exact moment the money-planning decision matters.
     `at` must be a Date; amount is optional and only used for copy. */
  async function schedulePaydayReminder(at, amount) {
    const local = Local();
    if (!local || !(at instanceof Date) || isNaN(at)) return false;
    const when = new Date(at);
    when.setHours(9, 0, 0, 0);
    if (when <= new Date()) return false; // already passed — nothing to schedule
    const amt = Number(amount) > 0
      ? '$' + Math.round(Number(amount)).toLocaleString('en-US') + ' should have landed. '
      : '';
    try {
      await local.cancel({ notifications: [{ id: NOTIF_PAYDAY }] }).catch(() => {});
      await local.schedule({
        notifications: [{
          id:    NOTIF_PAYDAY,
          title: "It's payday",
          body:  amt + 'See what\'s safe to spend before it disappears.',
          schedule: { at: when, allowWhileIdle: true },
          sound: 'default',
          extra: { type: 'payday' },
          smallIcon: 'ic_notification',
          iconColor: '#1ac4f0',
        }],
      });
      fcLog('[FCPush] payday reminder scheduled for', when.toISOString());
      return true;
    } catch (err) {
      fcLog('[FCPush] payday schedule failed:', err && err.message);
      return false;
    }
  }

  /* ── Clear delivered notifications on foreground ─────────── */
  // Only safe to call after APNs registration completes (_fcmToken set).
  // Calling removeAllDeliveredNotifications before capacitorDidRegisterForRemoteNotifications
  // fires produces a noisy "event not called" error from the Capacitor bridge.
  function clearDeliveredAndBadge() {
    if (!_fcmToken) return; // skip until APNs registration has completed
    try {
      const push = Push();
      if (push && typeof push.removeAllDeliveredNotifications === 'function') {
        push.removeAllDeliveredNotifications().catch(() => {});
      }
    } catch (_) {}
  }

  /* ── Getters ──────────────────────────────────────────────── */
  function getFcmToken() { return _fcmToken; }

  /**
   * Reset push state for account switching.
   * Clears the listener-guard so the next requestAndRegister() call re-attaches
   * all Capacitor push listeners and saves a fresh token for the new user.
   * Does NOT cancel pending local notifications — those are bill-specific and
   * will be re-scheduled by FCData.listenToBills on next sign-in.
   */
  function reset() {
    _listenersAdded = false;
    _fcmToken       = null;
    fcLog('[FCPush] reset — listeners will re-attach on next registration');
  }

  /* ── Public API ──────────────────────────────────────────── */
  return {
    requestAndRegister,
    checkPermissions,
    requestLocalPermission,
    scheduleBillReminder,
    scheduleAllBillReminders,
    cancelAllBillReminders,
    scheduleWeeklyRecap,
    schedulePaydayReminder,
    clearDeliveredAndBadge,
    getFcmToken,
    reset,
  };
})();
