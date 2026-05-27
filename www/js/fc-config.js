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

  /* ── Affiliate Offers ──────────────────────────────────────
     Partner offers shown contextually on the home dashboard.
     Replace placeholder URLs with your real affiliate links
     once approved by each partner program.

     How to get affiliate links:
       SoFi      → impact.com (search "SoFi") — $100–200/funded account
       Marcus    → marcus.com/referral or NerdWallet partner program
       Chime     → impact.com (search "Chime") — $50–100/signup
       Betterment→ betterment.com/affiliates — $100–300/funded account
       Robinhood → robinhood.com/affiliates — $20–50/signup

     'trigger' conditions — all must be true to show this offer:
       minSavings / maxSavings   — user's total savings balance
       minIncome                 — monthly income threshold
       noInvestments             — true = only show if no investment accounts
       lowSavingsRate            — true = only show if saving < 10% of income
     ─────────────────────────────────────────────────────────── */
  offers: [
    {
      id:          'hysa-sofi',
      institution: 'sofi',              // suppressed if user already has SoFi accounts
      badge:       'High-Yield Savings',
      headline:    'Earn up to 12x more on your savings',
      sub:         'SoFi members earn 4.6% APY. Most checking accounts earn 0.01%.',
      cta:         'See Offer',
      color:       '#6C47FF',   // SoFi purple
      icon:        '🏦',
      url:         'https://sofi.com/savings/?ref=PLACEHOLDER',  // replace with your affiliate URL
      trigger:     { maxSavings: 15000, minIncome: 1000 },
    },
    {
      id:          'hysa-marcus',
      institution: 'marcus',
      badge:       'High-Yield Savings',
      headline:    'Put your savings to work',
      sub:         'Marcus by Goldman Sachs offers 4.5% APY with no fees.',
      cta:         'See Offer',
      color:       '#00A86B',
      icon:        '💰',
      url:         'https://marcus.com/?ref=PLACEHOLDER',
      trigger:     { minSavings: 1000, maxSavings: 50000 },
    },
    {
      id:          'invest-betterment',
      institution: 'betterment',
      badge:       'Investing',
      headline:    'Your money should work as hard as you do',
      sub:         'Betterment automatically invests and rebalances your portfolio.',
      cta:         'Start Investing',
      color:       '#1ac4f0',
      icon:        '📈',
      url:         'https://betterment.com/?ref=PLACEHOLDER',
      trigger:     { noInvestments: true, minIncome: 2000 },
    },
    {
      id:          'checking-chime',
      institution: 'chime',
      badge:       'Free Checking',
      headline:    'Get paid up to 2 days early',
      sub:         'Chime has no monthly fees, no minimums, and early direct deposit.',
      cta:         'See Offer',
      color:       '#00D4AA',
      icon:        '💳',
      url:         'https://chime.com/?ref=PLACEHOLDER',
      trigger:     { minIncome: 500 },
    },
  ],

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
