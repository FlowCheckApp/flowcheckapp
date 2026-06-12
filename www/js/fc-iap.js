/**
 * FlowCheck — In-App Purchases
 * ─────────────────────────────────────────────────────────────
 * Wraps the RevenueCat Capacitor plugin (@revenuecat/purchases-capacitor).
 * The plugin must be installed and synced to iOS before purchases work:
 *
 *   npm install @revenuecat/purchases-capacitor
 *   npx cap sync ios
 *
 * Product IDs (configure in App Store Connect + RevenueCat dashboard):
 *   flowcheck.pro.monthly  — $4.99/mo
 *   flowcheck.pro.annual   — $34.99/yr  (7-day free trial)
 *
 * Entitlement ID: "premium"  ← must match RevenueCat dashboard exactly
 *
 * Architecture:
 *   - Native context  → calls Capacitor.Plugins.Purchases directly
 *   - Web / simulator → graceful no-op so UI still renders
 * ─────────────────────────────────────────────────────────────
 */
window.FCPurchases = (function () {
  'use strict';

  /* ── RevenueCat plugin reference ────────────────────────────── */
  const RC  = () => window.Capacitor?.Plugins?.Purchases;
  const CFG = () => window.FC_CONFIG?.revenueCat;
  // SecureStorage for Keychain-backed pro cache (same plugin as fc-auth.js)
  const SS  = () => window.Capacitor?.Plugins?.SecureStoragePlugin;

  let _configured  = false;
  let _proStatus   = false;
  let _offerings   = null;    // cached RevenueCat offerings

  /* ─────────────────────────────────────────────────────────────
     INITIALISE
     Call once, early in app boot (before showing paywall).
     ───────────────────────────────────────────────────────────── */
  /**
   * Configure RevenueCat SDK.
   * Pass the Firebase UID as appUserID so RC subscriber records map 1:1 to
   * Firebase users — the webhook can then use app_user_id directly as the UID.
   * Safe to call multiple times — no-op after first configure.
   */
  async function configure(appUserID = null) {
    const plugin = RC();
    const cfg    = CFG();
    const platform = window.Capacitor?.getPlatform?.() || 'web';
    const apiKey   = platform === 'android' ? (cfg.apiKeyAndroid || cfg.apiKey) : cfg.apiKey;
    if (!plugin || !apiKey) {
      fcLog('FCPurchases: Purchases plugin or apiKey not available — IAP disabled');
      return;
    }
    if (_configured) return;
    try {
      const opts = { apiKey };
      if (appUserID) opts.appUserID = String(appUserID);
      await plugin.configure(opts);
      _configured = true;
      fcLog('FCPurchases: configured, uid =', appUserID || '(anonymous)', 'entitlement:', cfg.entitlementId);
    } catch (err) {
      console.error('[FCPurchases] configure error:', err.message);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     ENTITLEMENT CHECK
     Call on app launch, foreground, and after purchase/restore.
     Returns true if the user has an active "pro" entitlement.
     ───────────────────────────────────────────────────────────── */
  const _RC_PRO_CACHE_KEY = 'fc_pro_status_v1';

  async function checkProStatus() {
    const plugin = RC();
    const cfg    = CFG();
    if (!plugin || !_configured) {
      // Offline/simulator: fall back to cached value so paying users keep access
      const cached = await _readProCache();
      if (cached !== null) return cached;
      return false;
    }
    try {
      const { customerInfo } = await plugin.getCustomerInfo();
      _proStatus = customerInfo.entitlements.active[cfg.entitlementId] !== undefined;
      _writeProCache(_proStatus); // persist for network-error fallback (fire-and-forget)
      fcLog('FCPurchases: pro =', _proStatus);
      return _proStatus;
    } catch (err) {
      console.error('[FCPurchases] checkProStatus error:', err.message);
      // Network failure — use last known value so paying users aren't downgraded
      const cached = await _readProCache();
      if (cached !== null) {
        fcLog('FCPurchases: RC unreachable, using cached pro =', cached);
        _proStatus = cached;
        return cached;
      }
      return false; // truly unknown — default safe
    }
  }

  async function _writeProCache(isPro) {
    const value = JSON.stringify({ isPro, ts: Date.now() });
    try {
      if (SS()) {
        await SS().set({ key: _RC_PRO_CACHE_KEY, value });
      }
      // Remove any legacy localStorage entry on first Keychain write
      try { localStorage.removeItem(_RC_PRO_CACHE_KEY); } catch (_) {}
    } catch (_) {}
  }

  async function _readProCache() {
    const MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
    try {
      if (SS()) {
        const r = await SS().get({ key: _RC_PRO_CACHE_KEY }).catch(() => null);
        if (r?.value) {
          const { isPro, ts } = JSON.parse(r.value);
          if (Date.now() - ts <= MAX_AGE) return isPro;
          return null; // stale
        }
      }
      // One-time migration: read from localStorage and migrate to Keychain
      const raw = localStorage.getItem(_RC_PRO_CACHE_KEY);
      if (raw) {
        const { isPro, ts } = JSON.parse(raw);
        if (Date.now() - ts <= MAX_AGE) {
          _writeProCache(isPro); // migrate to Keychain (async, fire-and-forget)
          return isPro;
        }
        localStorage.removeItem(_RC_PRO_CACHE_KEY);
      }
      return null;
    } catch (_) { return null; }
  }

  async function _clearProCache() {
    try { if (SS()) await SS().remove({ key: _RC_PRO_CACHE_KEY }).catch(() => {}); } catch (_) {}
    try { localStorage.removeItem(_RC_PRO_CACHE_KEY); } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     OFFERINGS
     Returns the RevenueCat "current" offering (cached after first fetch).
     Offering contains .monthly and .annual packages with live App Store prices.
     ───────────────────────────────────────────────────────────── */
  async function getOfferings() {
    const plugin = RC();
    if (!plugin || !_configured) return null;
    if (_offerings) return _offerings;
    try {
      const result = await plugin.getOfferings();
      _offerings   = result.current;
      fcLog('FCPurchases: offerings loaded', _offerings);
      return _offerings;
    } catch (err) {
      console.error('[FCPurchases] getOfferings error:', err.message);
      return null;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     PURCHASE
     Accepts a RevenueCat Package object from getOfferings().
     Returns { isPro, customerInfo } on success.
     Throws on failure (caller handles UI).
     ───────────────────────────────────────────────────────────── */
  async function purchasePackage(pkg) {
    const plugin = RC();
    const cfg    = CFG();
    if (!plugin || !_configured) throw new Error('Purchases not available on this device');

    const { customerInfo } = await plugin.purchasePackage({ aPackage: pkg });
    _proStatus = customerInfo.entitlements.active[cfg.entitlementId] !== undefined;
    fcLog('FCPurchases: purchase complete, pro =', _proStatus);
    return { isPro: _proStatus, customerInfo };
  }

  /* ─────────────────────────────────────────────────────────────
     RESTORE PURCHASES
     Required by App Store Review Guidelines — must be accessible in UI.
     ───────────────────────────────────────────────────────────── */
  async function restorePurchases() {
    const plugin = RC();
    const cfg    = CFG();
    if (!plugin || !_configured) throw new Error('Purchases not available on this device');

    const { customerInfo } = await plugin.restorePurchases();
    _proStatus = customerInfo.entitlements.active[cfg.entitlementId] !== undefined;
    fcLog('FCPurchases: restore complete, pro =', _proStatus);
    return { isPro: _proStatus, customerInfo };
  }

  /* ─────────────────────────────────────────────────────────────
     TRIAL STATUS
     Returns true if the user is currently in a free trial period.
     ───────────────────────────────────────────────────────────── */
  async function isInTrial() {
    const plugin = RC();
    const cfg    = CFG();
    if (!plugin || !_configured) return false;
    try {
      const { customerInfo } = await plugin.getCustomerInfo();
      const entitlement = customerInfo.entitlements.active[cfg.entitlementId];
      if (!entitlement) return false;
      return entitlement.periodType === 'TRIAL';
    } catch (_) { return false; }
  }

  /* ── Sync getter ─────────────────────────────────────────────── */
  function isPro() { return _proStatus; }
  function isConfigured() { return _configured; }

  /**
   * Reset all RC state for account switching.
   * Call this during sign-out / _wipeUserState() so the next configure()
   * call sets up a fresh RC subscriber instead of returning early.
   * Also calls plugin.logOut() to sever the RC→Firebase UID mapping so
   * entitlement checks can't bleed across account boundaries.
   */
  async function reset() {
    const wasConfigured = _configured;
    _configured = false;
    _proStatus  = false;
    _offerings  = null;
    await _clearProCache(); // prevent stale entitlement bleeding to the next account
    try {
      const plugin = RC();
      if (wasConfigured && plugin && typeof plugin.logOut === 'function') {
        await plugin.logOut().catch(err => {
          // Code 22 = "LogOut was called but the current user is anonymous"
          // This fires on sign-out when RC identity was never set (anonymous RC user).
          // It's harmless — anonymous identities don't carry entitlements.
          const code = err?.code ?? err?.errorCode;
          if (String(code) !== '22' && !String(err?.message || '').includes('anonymous')) {
            fcLog('[FCPurchases] logOut error (non-critical):', err?.message);
          }
        });
      }
    } catch (_) {}
    fcLog('[FCPurchases] reset — ready for next configure()');
  }

  /* ── Public API ───────────────────────────────────────────────── */
  return {
    configure,
    checkProStatus,
    getOfferings,
    purchasePackage,
    restorePurchases,
    isInTrial,
    isPro,
    isConfigured,
    reset,
  };
})();
