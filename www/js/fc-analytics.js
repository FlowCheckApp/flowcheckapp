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

  /* ── Property sanitiser ───────────────────────────────────────
     This module's contract is "no PII or financial data leaves the
     device". Previously that was only a comment — props were passed
     to PostHog verbatim, so one careless caller could ship a balance
     or a merchant name. Now it is enforced here, at the boundary.

     Allowed: booleans, finite numbers on non-financial keys, and
     short enum-ish strings. Everything else is dropped. */
  const _BLOCKED_KEY = /(amount|balance|total|price|cost|salary|income|spend|worth|debt|saved|target|merchant|vendor|payee|email|phone|address|name|account|mask|institution|token|uid|ssn)/i;
  const _EMAILISH    = /[^\s@]+@[^\s@]+\.[^\s@]+/;

  function _sanitize(props) {
    const out = {};
    if (!props || typeof props !== 'object') return out;
    for (const [k, v] of Object.entries(props)) {
      if (_BLOCKED_KEY.test(k)) continue;          // financial / PII key name
      if (v === null || v === undefined) continue;
      if (typeof v === 'boolean') { out[k] = v; continue; }
      if (typeof v === 'number') {
        if (Number.isFinite(v)) out[k] = v;        // counts, day offsets, indices
        continue;
      }
      if (typeof v === 'string') {
        if (v.length > 64) continue;               // free text — could be anything
        if (_EMAILISH.test(v)) continue;
        out[k] = v;
        continue;
      }
      // objects / arrays / functions are never safe to forward
    }
    return out;
  }

  /**
   * Track an event with optional non-PII properties.
   * Props are sanitised — see _sanitize(). Never pass raw money values;
   * bucket them first (e.g. `tier: 'over_500'`), never `amount: 512.30`.
   */
  function track(event, props) {
    if (!_enabled()) return;
    try {
      posthog.capture(event, _sanitize(props));
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
