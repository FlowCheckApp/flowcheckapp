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

  /* ── Request permission & register ──────────────────────── */
  async function requestAndRegister() {
    const push = Push();
    if (!push) {
      fcLog('PushNotifications plugin not available (web/simulator)');
      return false;
    }

    try {
      const permission = await push.requestPermissions();
      if (permission.receive !== 'granted') {
        fcLog('Push permission denied');
        return false;
      }
      await push.register();
      _attachListeners();
      fcLog('Push notifications registered');
      return true;
    } catch (err) {
      console.error('[FCPush] register failed:', err);
      return false;
    }
  }

  /* ── Attach Capacitor push listeners ─────────────────────── */
  function _attachListeners() {
    if (_listenersAdded) return;
    _listenersAdded = true;

    const push = Push();
    if (!push) return;

    // Registration: save FCM token to Firestore
    push.addListener('registration', async (token) => {
      _fcmToken = token.value;
      fcLog('FCM token:', _fcmToken);
      try {
        const user = FCAuth.currentUser();
        const db   = FCAuth.db();
        if (user && db) {
          await db.collection('users').doc(user.uid).update({
            fcm_token: _fcmToken,
            fcm_updated_at: firebase.firestore.FieldValue.serverTimestamp(),
          });
        }
      } catch (err) {
        console.error('[FCPush] Failed to save FCM token:', err);
      }
    });

    // Foreground notification received
    push.addListener('pushNotificationReceived', (notification) => {
      fcLog('Foreground push received:', notification);
      // Show as in-app toast instead of system alert (iOS UX best practice)
      if (window.FCApp && window.FCApp.toast) {
        FCApp.toast(
          notification.body || notification.title || 'New notification',
          'info',
          4000
        );
      }
    });

    // Notification tapped (app was backgrounded/closed)
    push.addListener('pushNotificationActionPerformed', (action) => {
      fcLog('Push tapped:', action);
      const data = action.notification && action.notification.data;
      if (!data) return;

      // Route to the correct tab based on notification type
      const routeMap = {
        'bill_due':     'activity',
        'budget_alert': 'insights',
        'goal_reached': 'goals',
        'sync_done':    'home',
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

    const dueDate = new Date(bill.due_date);
    // Notify 1 day before at 9 AM
    const notifyAt = new Date(dueDate);
    notifyAt.setDate(notifyAt.getDate() - 1);
    notifyAt.setHours(9, 0, 0, 0);

    if (notifyAt <= new Date()) return; // Already past

    try {
      await local.schedule({
        notifications: [{
          id:    bill.notification_id || Math.floor(Math.random() * 10000),
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

  /* ── Cancel all scheduled bill reminders ─────────────────── */
  async function cancelAllBillReminders() {
    const local = Local();
    if (!local) return;
    try {
      const pending = await local.getPending();
      if (pending && pending.notifications && pending.notifications.length) {
        await local.cancel({
          notifications: pending.notifications.map(n => ({ id: n.id })),
        });
      }
    } catch (_) {}
  }

  /* ── Getters ──────────────────────────────────────────────── */
  function getFcmToken() { return _fcmToken; }

  /* ── Public API ──────────────────────────────────────────── */
  return {
    requestAndRegister,
    requestLocalPermission,
    scheduleBillReminder,
    scheduleAllBillReminders,
    cancelAllBillReminders,
    getFcmToken,
  };
})();
