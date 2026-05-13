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
    measurementId:     'G-WCCWX0TNP1',
    databaseURL:       'https://flowcheck-46570-default-rtdb.firebaseio.com',
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

  /* ── RevenueCat ─────────────────────────────────────────────
     Get from: RevenueCat Dashboard → API Keys → Public SDK Key (iOS)
     Uncomment and populate when in-app purchases are implemented.
     ─────────────────────────────────────────────────────────── */
  // revenueCat: {
  //   apiKey: 'appl_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  // },

  /* ── App ────────────────────────────────────────────────────
     ─────────────────────────────────────────────────────────── */
  app: {
    version:    '2.0.0',
    name:       'FlowCheck',
    supportUrl: 'https://getflowcheck.app/support',
    privacyUrl: 'https://getflowcheck.app/privacy',
    termsUrl:   'https://getflowcheck.app/terms',
    // 'development' enables verbose console logging. Set to 'production' before App Store submission.
    env: 'production',
    // Backend is live at flowcheck-backend-production.up.railway.app
    backendConfigured: true,
  },
};

/* ── Debug helper ────────────────────────────────────────────── */
window.fcLog = function(...args) {
  if (window.FC_CONFIG && window.FC_CONFIG.app.env === 'development') {
    console.log('[FlowCheck]', ...args);
  }
};
