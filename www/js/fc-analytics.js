/**
 * FlowCheck — Analytics (PostHog)
 * ─────────────────────────────────────────────────────────────
 * All PostHog calls go through this module so:
 *  - No PII (email, name, account numbers) ever leaves the device
 *  - Easy to disable globally by setting FC_CONFIG.app.analytics = false
 *  - Events are named consistently with snake_case
 *
 * Usage:
 *   FCAnalytics.identify(uid, { is_pro: true });
 *   FCAnalytics.track('bank_connected');
 *   FCAnalytics.screen('home');
 *   FCAnalytics.reset();   // on sign-out
 * ─────────────────────────────────────────────────────────────
 */
window.FCAnalytics = (function () {
  'use strict';

  function _enabled() {
    return typeof window.posthog !== 'undefined'
      && window.posthog.capture
      && !(window.FC_CONFIG && window.FC_CONFIG.app && window.FC_CONFIG.app.analytics === false);
  }

  /**
   * Identify the user after sign-in.
   * Only passes non-PII properties — no email, no name.
   */
  function identify(uid, props) {
    if (!_enabled() || !uid) return;
    try {
      posthog.identify(uid, {
        is_pro:          props?.is_pro          || false,
        has_bank:        props?.has_bank        || false,
        onboarding_done: props?.onboarding_done || false,
      });
    } catch (_) {}
  }

  /**
   * Track an event with optional non-PII properties.
   */
  function track(event, props) {
    if (!_enabled()) return;
    try {
      posthog.capture(event, props || {});
    } catch (_) {}
  }

  /**
   * Track a screen view (called from setScreen + switchTab).
   */
  function screen(name) {
    if (!_enabled()) return;
    try {
      posthog.capture('screen_view', { screen: name });
    } catch (_) {}
  }

  /**
   * Reset on sign-out — dissociates the device from the user.
   */
  function reset() {
    if (!_enabled()) return;
    try { posthog.reset(); } catch (_) {}
  }

  return { identify, track, screen, reset };
})();
