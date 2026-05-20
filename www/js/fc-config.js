/**
 * FlowCheck — App Configuration
 * ─────────────────────────────────────────────────────────────
 * Replace every placeholder below with your actual credentials.
 * NEVER commit real API keys to git. In production, inject these
 * via your CI/CD environment or a secure config service.
 * ─────────────────────────────────────────────────────────────
 */
window.FC_CONFIG = {

  /* ── Firebase ───────────────────────────────────────────────
     Get these from: Firebase Console → Project Settings → General
     NOTE: Firebase web API keys are safe to include in client code.
     They identify your project, not grant admin access. Security is
     enforced by Firebase Security Rules and server-side Admin SDK.
     See: https://firebase.google.com/docs/projects/api-keys
     ─────────────────────────────────────────────────────────── */
  firebase: {
    apiKey:            'AIzaSyBtdCUetv2nRPiaZVt-_TXUtd77wxqLVSw',
    authDomain:        'flowcheck-46570.firebaseapp.com',
    projectId:         'flowcheck-46570',
    storageBucket:     'flowcheck-46570.firebasestorage.app',
    messagingSenderId: '305596636244',
    appId:             '1:305596636244:web:75dc2c36fbc8afc9bca1c1',
  },

  /* ── Plaid ──────────────────────────────────────────────────
     These are YOUR server-side endpoints, not Plaid's direct URLs.
     Your backend must proxy Plaid calls (access_token stays server-side).

     POST linkTokenEndpoint     → returns { link_token }
     POST exchangeTokenEndpoint → body: { public_token } → saves access_token on server
     GET  syncEndpoint          → returns { accounts, transactions }
     DELETE disconnectEndpoint  → revokes item, wipes financial data (Plaid ToS + CCPA)
     ─────────────────────────────────────────────────────────── */
  plaid: {
    linkTokenEndpoint:     'https://flowcheck-backend-production.up.railway.app/plaid/link-token',
    exchangeTokenEndpoint: 'https://flowcheck-backend-production.up.railway.app/plaid/exchange-token',
    syncEndpoint:          'https://flowcheck-backend-production.up.railway.app/plaid/sync',
    disconnectEndpoint:    'https://flowcheck-backend-production.up.railway.app/plaid/disconnect',
  },

  /* ── User / Account management ──────────────────────────────
     DELETE deleteEndpoint → full CCPA-compliant account erasure
     Removes: Plaid item, all Firestore data, Firebase Auth user.
     ─────────────────────────────────────────────────────────── */
  user: {
    deleteEndpoint: 'https://flowcheck-backend-production.up.railway.app/user/account',
  },

  /* ── Credit ─────────────────────────────────────────────────
     Server-proxied Experian endpoints. PII (SSN, DOB) is sent
     only once to YOUR backend and never stored on-device.
     ─────────────────────────────────────────────────────────── */
  credit: {
    scoreEndpoint:  'https://flowcheck-backend-production.up.railway.app/credit/score',
    manualEndpoint: 'https://flowcheck-backend-production.up.railway.app/credit/manual',
  },

  /* ── RevenueCat ─────────────────────────────────────────────
     Public iOS SDK key — safe to include in client code.
     App ID: app4590b0f1ba
     Dashboard: https://app.revenuecat.com
     Entitlement: "pro"
     Products (configure in App Store Connect + RevenueCat dashboard):
       flowcheck.pro.monthly — $4.99/mo
       flowcheck.pro.annual  — $34.99/yr (7-day free trial)
     ─────────────────────────────────────────────────────────── */
  revenueCat: {
    apiKey:        'appl_uXPDYRZDWiuLWcHfmesBUwKHmOQ',
    appId:         'app4590b0f1ba',
    entitlementId: 'premium',
  },

  /* ── Notifications ─────────────────────────────────────────
     Server-side FCM push endpoints. Auth token required.
     ─────────────────────────────────────────────────────────── */
  notifications: {
    sendEndpoint:        'https://flowcheck-backend-production.up.railway.app/notifications/send',
    budgetAlertEndpoint: 'https://flowcheck-backend-production.up.railway.app/notifications/budget-alert',
    registerEndpoint:    'https://flowcheck-backend-production.up.railway.app/notifications/register',
    markAllReadEndpoint: 'https://flowcheck-backend-production.up.railway.app/notifications/mark-all-read',
  },

  /* ── Email ──────────────────────────────────────────────────
     Transactional email (nodemailer SMTP via backend).
     Required Railway env vars: EMAIL_HOST, EMAIL_PORT, EMAIL_USER,
     EMAIL_PASS (SendGrid API key), EMAIL_FROM
     ─────────────────────────────────────────────────────────── */
  email: {
    welcomeEndpoint: 'https://flowcheck-backend-production.up.railway.app/email/welcome',
  },

  /* ── App ────────────────────────────────────────────────────
     ─────────────────────────────────────────────────────────── */
  app: {
    version:    '2.0.0',
    name:       'FlowCheck',
    apiBase:    'https://flowcheck-backend-production.up.railway.app',
    // Local pages bundled inside the app — works offline, no external dependency.
    // Capacitor serves these from capacitor://localhost/legal/
    supportUrl: '/legal/support.html',
    privacyUrl: '/legal/privacy.html',
    termsUrl:   '/legal/terms.html',
    // 'development' enables verbose console logging. Set to 'production' before App Store submission.
    env: 'production',
    backendConfigured: true,
  },
};

/* ── Debug helper ────────────────────────────────────────────── */
window.fcLog = function(...args) {
  if (window.FC_CONFIG && window.FC_CONFIG.app.env === 'development') {
    console.log('[FlowCheck]', ...args);
  }
};
