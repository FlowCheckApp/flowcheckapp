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
  const RC = () => window.Capacitor?.Plugins?.Purchases;
  const CFG = () => window.FC_CONFIG?.revenueCat;

  let _configured  = false;
  let _proStatus   = false;
  let _offerings   = null;    // cached RevenueCat offerings

  /* ─────────────────────────────────────────────────────────────
     INITIALISE
     Call once, early in app boot (before showing paywall).
     ───────────────────────────────────────────────────────────── */
  async function configure() {
    const plugin = RC();
    const cfg    = CFG();
    if (!plugin || !cfg?.apiKey) {
      fcLog('FCPurchases: Purchases plugin or apiKey not available — IAP disabled');
      return;
    }
    if (_configured) return;
    try {
      await plugin.configure({ apiKey: cfg.apiKey });
      _configured = true;
      fcLog('FCPurchases: configured (entitlement:', cfg.entitlementId, ')');
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
      const cached = _readProCache();
      if (cached !== null) return cached;
      return false;
    }
    try {
      const { customerInfo } = await plugin.getCustomerInfo();
      _proStatus = customerInfo.entitlements.active[cfg.entitlementId] !== undefined;
      _writeProCache(_proStatus); // persist for network-error fallback
      fcLog('FCPurchases: pro =', _proStatus);
      return _proStatus;
    } catch (err) {
      console.error('[FCPurchases] checkProStatus error:', err.message);
      // Network failure — use last known value so paying users aren't downgraded
      const cached = _readProCache();
      if (cached !== null) {
        fcLog('FCPurchases: RC unreachable, using cached pro =', cached);
        _proStatus = cached;
        return cached;
      }
      return false; // truly unknown — default safe
    }
  }

  function _writeProCache(isPro) {
    try { localStorage.setItem(_RC_PRO_CACHE_KEY, JSON.stringify({ isPro, ts: Date.now() })); } catch (_) {}
  }

  function _readProCache() {
    try {
      const raw = localStorage.getItem(_RC_PRO_CACHE_KEY);
      if (!raw) return null;
      const { isPro, ts } = JSON.parse(raw);
      // Cache valid for 7 days — after that treat as unknown
      if (Date.now() - ts > 7 * 24 * 60 * 60 * 1000) return null;
      return isPro;
    } catch (_) { return null; }
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
  };
})();
