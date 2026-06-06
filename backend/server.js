/**
 * FlowCheck — Plaid Backend API
 * ─────────────────────────────────────────────────────────────
 * Deploy to Railway or Render. Plaid access_tokens NEVER leave
 * this server — stored in a server-only Firestore collection.
 *
 * Endpoints:
 *   GET  /health                → { ok: true }
 *   POST /plaid/link-token      → { link_token }
 *   POST /plaid/exchange-token  → { success, item_id }
 *   GET  /plaid/sync            → { accounts: N, transactions: N }
 *   DELETE /plaid/disconnect    → { success: true }
 *   DELETE /user/account        → { success: true }
 * ─────────────────────────────────────────────────────────────
 */

'use strict';
require('dotenv').config();

/* ── Sentry — must be initialized before anything else ──────── */
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: 0,        // no perf tracing — keeps it lightweight
    // Never send financial data or PII in error payloads
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers['authorization'];
          delete event.request.headers['cookie'];
        }
        // Don't log request bodies — may contain SSN, DOB, account data
        delete event.request.data;
      }
      return event;
    },
  });
  console.log('[Sentry] Initialized — backend error tracking active');
} else {
  console.warn('[Sentry] SENTRY_DSN not set — error tracking disabled');
}

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const compression  = require('compression');
const admin        = require('firebase-admin');
const crypto       = require('crypto');
const path         = require('path');
const {
  Configuration, PlaidApi, PlaidEnvironments,
  Products, CountryCode,
} = require('plaid');

/* ── Validate required env vars on boot ──────────────────────── */
const REQUIRED = [
  'PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV',
  'FIREBASE_PROJECT_ID', 'FIREBASE_SERVICE_ACCOUNT',
];
for (const key of REQUIRED) {
  if (!process.env[key]) { console.error(`[Boot] Missing required env var: ${key}`); process.exit(1); }
}

const PLAID_ENV_VALID = ['sandbox', 'development', 'production'];
if (!PLAID_ENV_VALID.includes(process.env.PLAID_ENV)) {
  console.error(`[Boot] PLAID_ENV must be one of: ${PLAID_ENV_VALID.join(', ')}`);
  process.exit(1);
}

/* ── Firebase Admin ──────────────────────────────────────────── */
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  projectId:  process.env.FIREBASE_PROJECT_ID,
});
const db = admin.firestore();

/* ── Plaid client ────────────────────────────────────────────── */
const plaidEnv = process.env.PLAID_ENV; // 'sandbox' or 'production'
const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET':    process.env.PLAID_SECRET,
    },
  },
}));

console.log(`[Boot] FlowCheck API | Firebase: ${process.env.FIREBASE_PROJECT_ID} | Plaid: ${plaidEnv}`);

/* ── Backend base URL (used for Plaid webhook + OAuth redirect) ─ */
// Set BACKEND_URL in Railway env vars, e.g.:
//   https://getflowcheck.app
// Falls back to the hard-coded value so existing deploys keep working.
const BACKEND_URL = (process.env.BACKEND_URL || 'https://getflowcheck.app').replace(/\/$/, '');

/* ── Safe error messages — never leak internals to clients ─────── */
// Returns a safe, user-friendly error string. Plaid error details,
// stack traces, and internal codes stay in server logs only.
// Plaid error_codes that are safe and actionable to surface to the user:
const _SAFE_PLAID_CODES = new Set([
  'INSTITUTION_DOWN','INSTITUTION_NOT_RESPONDING','INSTITUTION_NOT_AVAILABLE',
  'ITEM_LOGIN_REQUIRED','USER_SETUP_REQUIRED','MFA_NOT_SUPPORTED',
  'OAUTH_STATE_ID_ALREADY_PROCESSED','NO_ACCOUNTS','ITEM_LOCKED',
]);
function _safeMsg(err, fallback = 'Something went wrong — please try again') {
  // Safe Plaid error codes shown to user verbatim (actionable)
  const plaidCode = err?.response?.data?.error_code;
  if (plaidCode && _SAFE_PLAID_CODES.has(plaidCode)) {
    return err.response.data.display_message || err.response.data.error_message || fallback;
  }
  // Firebase auth errors are user-facing by design
  if (err?.code?.startsWith('auth/')) return err.message;
  // In development, expose internals for debugging
  if (process.env.NODE_ENV !== 'production') return err?.message || fallback;
  return fallback;
}

/* ── HTML escape — prevents injection in email templates ────────── */
// Any user-controlled string interpolated into HTML must be passed
// through this function first (bill names, categories, display names).
function _htmlEscape(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Resolve a user's display name for email personalization.
 * Priority: Firestore `name` field → Firebase Auth displayName → 'Friend'.
 * Firestore is preferred because it's user-editable from within the app;
 * Auth displayName is a fallback for Apple/Google sign-in users who haven't
 * set a name in-app yet.
 */
async function _resolveDisplayName(uid, fallback = 'Friend') {
  try {
    const snap = await db.collection('users').doc(uid).get();
    if (snap.exists) {
      const name = (snap.data().name || '').trim();
      if (name) return _htmlEscape(name.split(' ')[0]);
    }
  } catch (_) {}
  try {
    const record = await admin.auth().getUser(uid);
    const name = (record.displayName || '').trim();
    if (name) return _htmlEscape(name.split(' ')[0]);
  } catch (_) {}
  return fallback;
}

/* ── Firebase ID-token cache (LRU, 14-min TTL) ──────────────────── */
// Firebase Admin SDK caches tokens internally but still does JWT
// parsing on every call. This thin in-process cache cuts redundant
// work on bursts of requests from the same user.
const _TOKEN_CACHE_TTL_MS = 14 * 60 * 1000; // 14 min (tokens expire at 60 min)
const _tokenCache = new Map(); // token → { uid, expiresAt }

async function _verifyFirebaseToken(token) {
  const now    = Date.now();
  const cached = _tokenCache.get(token);
  if (cached) {
    if (now < cached.expiresAt) return cached.uid;
    _tokenCache.delete(token); // expired — evict eagerly
  }

  // checkRevoked: true ensures manually revoked sessions are rejected
  const decoded = await admin.auth().verifyIdToken(token, true);

  // Evict stale entries when approaching limit.
  // First pass: remove all expired entries (TTL-based eviction).
  // Second pass: if still full, remove the oldest by insertion order (FIFO).
  if (_tokenCache.size >= 1000) {
    for (const [k, v] of _tokenCache) {
      if (now >= v.expiresAt) _tokenCache.delete(k);
    }
    if (_tokenCache.size >= 1000) {
      // All entries are still valid — evict the oldest
      _tokenCache.delete(_tokenCache.keys().next().value);
    }
  }
  _tokenCache.set(token, { uid: decoded.uid, expiresAt: now + _TOKEN_CACHE_TTL_MS });
  return decoded.uid;
}

/* ── Express ─────────────────────────────────────────────────── */
const app = express();
app.set('trust proxy', 1); // Railway / Render sit behind a reverse proxy

// ── Response compression ───────────────────────────────────────
app.use(compression());

// ── Static website files (public/) ────────────────────────────
// Serves the marketing website: CSS, JS, images.
// The root / route is handled explicitly below (user-agent check).
// This must come before the API routes so assets resolve first.
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  index:       false,        // root handled by explicit GET / route
  extensions:  ['html'],    // /features → features.html, /pricing → pricing.html
}));

// ── Security headers (Helmet) ──────────────────────────────────
// Removes X-Powered-By, adds HSTS, X-Frame-Options, X-Content-Type,
// Referrer-Policy, and Permissions-Policy headers automatically.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'none'"],
      connectSrc:  ["'self'"],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'no-referrer' },
}));

// ── CORS ───────────────────────────────────────────────────────
// Capacitor iOS apps use 'capacitor://localhost' or null origin.
const ALLOWED_ORIGINS = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'http://localhost:3000',
  'https://getflowcheck.app',
]);
app.use(cors({
  origin: (origin, cb) => {
    // Native apps send no origin header — allow null/undefined
    if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    cb(new Error(`CORS: origin not allowed — ${origin}`));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false, // We use Bearer tokens, not cookies — disable credentials
}));

// ── Global request timeout ─────────────────────────────────────
// Kill any request that hasn't responded in 30 seconds.
// Prevents hung Plaid API calls from tying up the event loop.
// The webhook route handles its own tight timing — 30s is plenty there.
app.use((req, res, next) => {
  const timer = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ message: 'Request timed out — please try again' });
    }
  }, 30_000);
  res.on('finish', () => clearTimeout(timer));
  res.on('close',  () => clearTimeout(timer));
  next();
});

// Cap request body size to prevent large-payload DoS.
// The `verify` callback captures the raw buffer — required for
// Plaid webhook JWT signature verification on POST /plaid/webhook.
app.use(express.json({
  limit: '32kb',
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ── Unique request ID for tracing ──────────────────────────────
app.use((req, _res, next) => {
  req.requestId = crypto.randomBytes(8).toString('hex');
  next();
});

/* ── Rate limiting ───────────────────────────────────────────── */
// General: 120 req / 15 min per IP
const generalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             120,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { message: 'Too many requests — try again later' },
});

// Strict: 15 req / 15 min — protects Plaid-cost endpoints
const strictLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             15,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { message: 'Too many requests — try again later' },
});

// Per-user strict limiter: 10 Plaid calls / 15 min per UID
// Applied AFTER requireAuth so req.uid is available.
// The store is capped at 10K entries and expired entries are purged every
// WINDOW ms so it doesn't grow unbounded in production.
function perUserLimiter(max = 10) {
  const store  = new Map();
  const WINDOW = 15 * 60 * 1000;
  const MAX_STORE_SIZE = 10_000;
  let   lastPurge = Date.now();

  return (req, res, next) => {
    const uid = req.uid;
    if (!uid) return next(); // requireAuth already rejected un-authed
    const now = Date.now();

    // Periodic purge: remove entries whose rate-limit window has expired.
    // Runs at most once per WINDOW so overhead is negligible.
    if (now - lastPurge > WINDOW) {
      for (const [k, v] of store) {
        if (now > v.reset) store.delete(k);
      }
      lastPurge = now;
    }

    // Hard cap: if still over limit after purge, evict oldest entries.
    if (store.size >= MAX_STORE_SIZE) {
      let evict = Math.floor(MAX_STORE_SIZE * 0.1); // drop 10%
      for (const k of store.keys()) {
        store.delete(k);
        if (--evict <= 0) break;
      }
    }

    const entry = store.get(uid) || { count: 0, reset: now + WINDOW };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + WINDOW; }
    entry.count++;
    store.set(uid, entry);
    if (entry.count > max) {
      return res.status(429).json({ message: 'Too many requests — try again later' });
    }
    next();
  };
}

app.use('/health',                      generalLimiter);
app.use('/plaid/link-token',            strictLimiter);
app.use('/plaid/exchange-token',        strictLimiter);
app.use('/plaid/sync',                  generalLimiter);
app.use('/plaid/webhook',              generalLimiter); // Plaid calls this — must stay responsive
app.use('/plaid/disconnect',            strictLimiter); // covers /plaid/disconnect AND /plaid/disconnect/:itemId
app.use('/user/account',                strictLimiter);
app.use('/credit',                      strictLimiter); // manual credit score entry
app.use('/notifications/send',          strictLimiter);
app.use('/notifications/budget-alert',  strictLimiter);
app.use('/notifications/register',      generalLimiter);
app.use('/notifications/mark-all-read', generalLimiter);
app.use('/notifications/',              generalLimiter); // covers /notifications/:id/read
app.use('/email/',                      strictLimiter);  // covers welcome, test, etc.
app.use('/auth/otp',                    strictLimiter);  // OTP send + verify
app.use('/auth/login-event',            generalLimiter); // login security alerts
app.use('/api/referral',                generalLimiter); // referral generate/apply/activate/stats
// /unsubscribe uses its own _unsubLimiter defined inline (no auth — uid in URL)

/* ── Referral router ─────────────────────────────────────────── */
const makeReferralRouter = require('./referral');
app.use('/api/referral', makeReferralRouter(admin, db));

/* ── Firebase auth middleware ────────────────────────────────── */
async function requireAuth(req, res, next) {
  const header = (req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  const token = header.slice(7);
  if (!token || token.length < 20) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    req.uid = await _verifyFirebaseToken(token);
    next();
  } catch (err) {
    // On token revocation, purge from cache so the next request re-checks
    _tokenCache.delete(token);
    const code = err.code || 'unknown';
    if (code === 'auth/id-token-revoked') {
      return res.status(401).json({ message: 'Session revoked — please sign in again' });
    }
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

/* ── Root + Health check ─────────────────────────────────────── */
// Root returns branded HTML so iMessage/social scrapers always see FlowCheck
// meta tags when the bare domain (getflowcheck.app) is shared.
app.get('/', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  // Non-browser clients (curl, monitoring, API consumers) get JSON
  // Non-browser API clients get JSON; browsers and social scrapers get the website
  if (!ua.includes('Mozilla') && !ua.includes('facebookexternalhit') &&
      !ua.includes('Twitterbot') && !ua.includes('LinkedInBot') &&
      !ua.includes('Slackbot') && !ua.includes('WhatsApp') &&
      !ua.includes('Discordbot') && !ua.includes('TelegramBot')) {
    return res.json({ name: 'FlowCheck API', status: 'ok', version: '1.0.0' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/flowcheck-icon.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'flowcheck-icon.png'));
});

/* ─────────────────────────────────────────────────────────────
   GET /open   — smart deep link for email CTAs
   Tries to redirect to the app via custom URL scheme (flowcheck://).
   If the app is installed, iOS opens it immediately. If not, the
   fallback HTML page directs the user to the App Store.
   ─────────────────────────────────────────────────────────────── */
app.get('/open', (req, res) => {
  const ref    = (req.query.ref || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
  const scheme = `flowcheck://open${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const store  = 'https://apps.apple.com/app/flowcheck/id6742624701';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Opening FlowCheck…</title>
  <meta property="og:title"  content="FlowCheck — Your financial life, organized.">
  <meta property="og:image"  content="${BACKEND_URL}/flowcheck-icon.png">
  <meta property="og:url"    content="${BACKEND_URL}/open">
  <meta name="twitter:card"  content="summary">
  <meta name="twitter:image" content="${BACKEND_URL}/flowcheck-icon.png">
  <meta name="apple-itunes-app" content="app-id=6742624701, app-argument=${scheme}">
  <style>
    body{margin:0;background:#060e18;color:#fff;font-family:-apple-system,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px;box-sizing:border-box}
    .logo{display:block;width:72px;height:72px;border-radius:18px;margin:0 auto 20px;box-shadow:0 8px 28px rgba(26,196,240,0.3)}
    h1{font-size:22px;font-weight:700;margin:0 0 8px}
    p{color:rgba(255,255,255,.5);font-size:14px;margin:0 0 28px}
    a.btn{display:inline-block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:16px;padding:14px 32px;border-radius:12px;text-decoration:none;margin-top:8px}
    a.secondary{display:block;color:rgba(255,255,255,.35);font-size:13px;margin-top:16px;text-decoration:none}
  </style>
  <script>
    // Try to open the app. Blur fires if iOS hands off to the app — use it to
    // cancel the App Store fallback so we don't redirect users who already opened.
    var launched = false;
    window.addEventListener('blur', function() { launched = true; }, { once: true });
    setTimeout(function() {
      window.location.href = '${scheme}';
      setTimeout(function() { if (!launched) window.location.href = '${store}'; }, 2000);
    }, 120);
  </script>
</head>
<body>
  <img src="/flowcheck-icon.png" class="logo" alt="FlowCheck">
  <h1>Opening FlowCheck…</h1>
  <p>If the app doesn't open automatically, tap below.</p>
  <a class="btn" href="${scheme}">Open in FlowCheck</a>
  <a class="secondary" href="${store}">Download on the App Store</a>
</body>
</html>`);
});

/* ─────────────────────────────────────────────────────────────
   GET /r/:code  — legacy referral URL, 301-redirects to /invite/:code
   Old shares (getflowcheck.app/r/FLOWXXXXXX) remain working forever.
   ─────────────────────────────────────────────────────────────── */
app.get('/r/:code', (req, res) => {
  const rawCode = (req.params.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16);
  if (!rawCode || !/^FLOW[A-Z0-9-]{4,12}$/.test(rawCode)) {
    return res.redirect(302, `${BACKEND_URL}/open`);
  }
  res.redirect(301, `${BACKEND_URL}/invite/${rawCode}`);
});

/* ─────────────────────────────────────────────────────────────
   GET /invite/:code  — primary referral landing page
   Shared as: https://getflowcheck.app/invite/FLOWXXXXXX
   - Fetches referrer first name for personalization
   - Auto-attempts app open via custom URL scheme on page load
   - Loading → success/install states (no click required)
   - Apple Smart App Banner for native UX
   - Full OG / Twitter card meta for rich link previews
   - App Store fallback if not installed
   ─────────────────────────────────────────────────────────────── */
app.get('/invite/:code', async (req, res) => {
  const rawCode = (req.params.code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16);
  if (!rawCode || !/^FLOW[A-Z0-9-]{4,12}$/.test(rawCode)) {
    return res.redirect(302, `${BACKEND_URL}/open`);
  }

  // Log analytics (non-blocking)
  db.collection('referral_opens').add({
    code:       rawCode,
    source:     'invite_page',
    timestamp:  admin.firestore.FieldValue.serverTimestamp(),
    user_agent: (req.headers['user-agent'] || '').slice(0, 200),
  }).catch(() => {});

  // Fetch referrer first name for personalised headline (best-effort, max 800ms)
  let referrerFirstName = null;
  try {
    const codeDoc = await Promise.race([
      db.collection('referrals').doc(rawCode).get(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 800)),
    ]);
    if (codeDoc.exists) {
      const referrerSnap = await db.collection('users').doc(codeDoc.data().uid).get();
      if (referrerSnap.exists) {
        const fullName = referrerSnap.data().name || referrerSnap.data().displayName || '';
        referrerFirstName = fullName.split(/\s+/)[0] || null;
      }
    }
  } catch (_) {}

  const safeFirstName = referrerFirstName ? _htmlEscape(referrerFirstName) : null;
  const inviteUrl    = `${BACKEND_URL}/invite/${rawCode}`;
  const appScheme    = `flowcheck://referral?code=${encodeURIComponent(rawCode)}`;
  const storeUrl     = 'https://apps.apple.com/app/flowcheck/id6742624701';

  const ogTitle = safeFirstName
    ? `${safeFirstName} invited you to FlowCheck`
    : 'You\'re invited to FlowCheck';
  const ogDesc  = 'Connect your bank and you both get 1 free month of Pro. No credit card required.';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>${ogTitle} — 1 Month of Pro Free</title>

  <!-- Open Graph — rich previews in iMessage, Twitter, Slack, etc. -->
  <meta property="og:title"       content="${ogTitle}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:image"       content="${BACKEND_URL}/flowcheck-icon.png">
  <meta property="og:url"         content="${inviteUrl}">
  <meta property="og:type"        content="website">
  <meta property="og:site_name"   content="FlowCheck">
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:title"       content="${ogTitle}">
  <meta name="twitter:description" content="${ogDesc}">
  <meta name="twitter:image"       content="${BACKEND_URL}/flowcheck-icon.png">

  <!-- Apple Smart App Banner — shows native "Open" prompt in Safari -->
  <meta name="apple-itunes-app" content="app-id=6742624701, app-argument=${appScheme}">

  <style>
    *,*::before,*::after{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
    :root{
      --cyan:#1ac4f0;--blue:#2563eb;--bg:#060e18;--surface:rgba(255,255,255,0.04);
      --border:rgba(255,255,255,0.08);--text:rgba(255,255,255,0.92);
      --muted:rgba(255,255,255,0.45);--faint:rgba(255,255,255,0.22);
    }
    html{height:100%;overscroll-behavior:none}
    body{
      margin:0;min-height:100%;background:var(--bg);color:var(--text);
      font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue',sans-serif;
      display:flex;flex-direction:column;align-items:center;
      padding:env(safe-area-inset-top,20px) 24px env(safe-area-inset-bottom,32px);
      position:relative;overflow-x:hidden;
    }

    /* Ambient glow background — matches FlowCheck app aesthetic */
    .glow-top{
      position:fixed;top:-160px;left:50%;transform:translateX(-50%);
      width:600px;height:600px;border-radius:50%;pointer-events:none;
      background:radial-gradient(circle,rgba(26,196,240,0.13) 0%,transparent 65%);
      filter:blur(70px);
    }
    .glow-bot{
      position:fixed;bottom:-180px;right:-80px;
      width:440px;height:440px;border-radius:50%;pointer-events:none;
      background:radial-gradient(circle,rgba(37,99,235,0.11) 0%,transparent 65%);
      filter:blur(80px);
    }

    /* Page content sits above glows */
    .content{
      position:relative;z-index:1;width:100%;max-width:360px;
      display:flex;flex-direction:column;align-items:center;
      padding-top:48px;
    }

    /* App icon */
    .icon-wrap{
      width:84px;height:84px;border-radius:22px;
      background:linear-gradient(145deg,#1ee8ff,var(--blue));
      display:flex;align-items:center;justify-content:center;
      box-shadow:0 0 0 1px rgba(26,196,240,0.25),
                 0 0 0 5px rgba(26,196,240,0.06),
                 0 16px 48px rgba(26,196,240,0.32),
                 0 4px 16px rgba(0,0,0,0.5);
      margin-bottom:24px;
      animation:iconIn .55s cubic-bezier(.22,1,.36,1) both;
    }
    @keyframes iconIn{from{opacity:0;transform:scale(.7) translateY(12px)}to{opacity:1;transform:none}}

    /* Sender badge */
    .sender{
      display:inline-flex;align-items:center;gap:6px;
      background:rgba(26,196,240,0.10);border:1px solid rgba(26,196,240,0.20);
      border-radius:20px;padding:5px 14px 5px 10px;
      font-size:12px;font-weight:600;color:var(--cyan);letter-spacing:0.03em;
      margin-bottom:18px;
      animation:fadeUp .4s .15s cubic-bezier(.22,1,.36,1) both;
    }
    .sender-dot{width:6px;height:6px;border-radius:50%;background:var(--cyan);flex-shrink:0}

    /* Headline */
    h1{
      font-size:28px;font-weight:800;letter-spacing:-.03em;line-height:1.15;
      text-align:center;margin:0 0 12px;
      animation:fadeUp .4s .22s cubic-bezier(.22,1,.36,1) both;
    }
    h1 span{
      background:linear-gradient(135deg,var(--cyan),var(--blue));
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;
      background-clip:text;
    }
    .sub{
      font-size:15px;color:var(--muted);line-height:1.55;text-align:center;
      margin:0 0 28px;max-width:280px;
      animation:fadeUp .4s .28s cubic-bezier(.22,1,.36,1) both;
    }

    /* Feature list */
    .features{
      width:100%;background:var(--surface);border:1px solid var(--border);
      border-radius:16px;padding:6px 0;margin-bottom:24px;
      animation:fadeUp .4s .34s cubic-bezier(.22,1,.36,1) both;
    }
    .feature{
      display:flex;align-items:center;gap:12px;
      padding:11px 18px;font-size:14px;color:rgba(255,255,255,.80);
    }
    .feature+.feature{border-top:1px solid var(--border)}
    .feature-icon{
      width:32px;height:32px;border-radius:10px;flex-shrink:0;
      display:flex;align-items:center;justify-content:center;font-size:16px;
    }
    .check{margin-left:auto;color:var(--cyan);font-size:15px;font-weight:700;flex-shrink:0}

    /* Code pill */
    .code-pill{
      background:var(--surface);border:1px solid var(--border);
      border-radius:14px;padding:14px 24px;margin-bottom:28px;
      display:flex;align-items:center;gap:16px;width:100%;
      animation:fadeUp .4s .40s cubic-bezier(.22,1,.36,1) both;
    }
    .code-label{font-size:10px;color:var(--faint);text-transform:uppercase;letter-spacing:.1em;margin-bottom:3px}
    .code-value{font-size:20px;font-weight:800;letter-spacing:.12em;color:var(--cyan)}

    /* CTA buttons */
    .cta-wrap{width:100%;display:flex;flex-direction:column;align-items:center;gap:12px;
      animation:fadeUp .4s .46s cubic-bezier(.22,1,.36,1) both}

    /* State: attempting to open app */
    #state-opening{display:flex;flex-direction:column;align-items:center;gap:10px}
    .spin{
      width:22px;height:22px;border:2.5px solid rgba(26,196,240,0.25);
      border-top-color:var(--cyan);border-radius:50%;
      animation:spin .7s linear infinite;display:inline-block;
    }
    @keyframes spin{to{transform:rotate(360deg)}}
    .opening-text{font-size:14px;color:var(--muted)}

    /* State: install from App Store */
    #state-install{display:none;flex-direction:column;align-items:center;gap:0;width:100%}
    .btn-primary{
      display:flex;align-items:center;justify-content:center;
      width:100%;max-width:320px;padding:17px 28px;border-radius:14px;
      background:linear-gradient(135deg,var(--cyan),var(--blue));
      color:#fff;font-weight:700;font-size:17px;letter-spacing:-.01em;
      text-decoration:none;border:none;cursor:pointer;
      box-shadow:0 6px 24px rgba(26,196,240,0.30);
      transition:opacity .15s;
    }
    .btn-primary:active{opacity:.85}
    .btn-secondary{
      display:block;color:var(--faint);font-size:13px;
      text-decoration:none;padding:12px;
    }
    .btn-secondary:active{color:rgba(255,255,255,.5)}

    /* Footer */
    .footer{
      margin-top:32px;font-size:11px;color:var(--faint);
      line-height:1.55;text-align:center;max-width:280px;
    }
    @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
  </style>
</head>
<body>
  <div class="glow-top" aria-hidden="true"></div>
  <div class="glow-bot" aria-hidden="true"></div>

  <div class="content">
    <div class="icon-wrap" aria-hidden="true">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="white" aria-hidden="true">
        <path d="M4 4h16v3H4zm0 6h11v3H4zm0 6h7v3H4z"/>
      </svg>
    </div>

    ${safeFirstName
      ? `<div class="sender"><span class="sender-dot"></span>${safeFirstName} invited you</div>`
      : `<div class="sender"><span class="sender-dot"></span>You're invited</div>`
    }

    <h1>Get 1 month of<br><span>FlowCheck Pro</span> free</h1>
    <p class="sub">Connect your bank and you both unlock Pro — real-time sync, AI insights, and more. No credit card required.</p>

    <div class="features">
      <div class="feature">
        <div class="feature-icon" style="background:rgba(14,165,233,0.12)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" stroke-width="2" stroke-linecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        </div>
        <span>Unlimited bank accounts</span>
        <span class="check">✓</span>
      </div>
      <div class="feature">
        <div class="feature-icon" style="background:rgba(99,102,241,0.12)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>
        <span>Financial Health Score</span>
        <span class="check">✓</span>
      </div>
      <div class="feature">
        <div class="feature-icon" style="background:rgba(34,197,94,0.10)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
        </div>
        <span>AI spending insights</span>
        <span class="check">✓</span>
      </div>
      <div class="feature">
        <div class="feature-icon" style="background:rgba(251,191,36,0.10)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        </div>
        <span>Bill tracking &amp; reminders</span>
        <span class="check">✓</span>
      </div>
    </div>

    <div class="code-pill" aria-label="Your referral code: ${rawCode}">
      <div>
        <div class="code-label">Your referral code</div>
        <div class="code-value">${rawCode}</div>
      </div>
    </div>

    <div class="cta-wrap">
      <div id="state-opening">
        <span class="spin" aria-hidden="true"></span>
        <p class="opening-text">Opening FlowCheck…</p>
      </div>
      <div id="state-install">
        <a class="btn-primary" href="${storeUrl}" id="store-btn">
          Download on App Store →
        </a>
        <a class="btn-secondary" href="https://getflowcheck.app/signup?code=${encodeURIComponent(rawCode)}" style="margin-top:8px;color:rgba(255,255,255,0.45);font-size:13px;text-decoration:none;display:block;padding:10px">
          Sign up on the web instead →
        </a>
        <a class="btn-secondary" href="${appScheme}" id="reopen-btn">Already installed? Open app</a>
      </div>
    </div>

    <p class="footer">
      FlowCheck is not a bank. Not financial advice.<br>
      Code applied automatically at signup. One use per account.
    </p>
  </div>

  <script>
    // Step 1: fire the custom URL scheme immediately — no user interaction needed.
    // If the app is installed, iOS hands off immediately and this page blurs.
    // If not installed, the page stays visible and we transition to the install state.
    var launched = false;
    var TIMEOUT  = 2600; // ms to wait before concluding app is not installed

    window.addEventListener('blur', function() {
      launched = true;
      clearTimeout(installTimer);
    }, { once: true });

    var installTimer = setTimeout(function() {
      if (!launched) showInstall();
    }, TIMEOUT);

    // Fire deep link after a short paint delay so the page renders first
    setTimeout(function() {
      window.location.href = '${appScheme}';
    }, 80);

    function showInstall() {
      document.getElementById('state-opening').style.display = 'none';
      document.getElementById('state-install').style.display = 'flex';
    }

    // "Already installed? Open app" — retry the deep link on tap
    document.getElementById('reopen-btn').addEventListener('click', function(e) {
      e.preventDefault();
      window.location.href = '${appScheme}';
      setTimeout(function() { showInstall(); }, 2600);
    });

    // App Store button — try scheme one final time (for when user just installed)
    document.getElementById('store-btn').addEventListener('click', function(e) {
      // Let the href navigate to App Store — no override needed
    });
  </script>
</body>
</html>`);
});

/* ─────────────────────────────────────────────────────────────
   POST /plaid/link-token
   ───────────────────────────────────────────────────────────── */
const _plaidUserLimiter = perUserLimiter(10);

app.post('/plaid/link-token', requireAuth, _plaidUserLimiter, async (req, res) => {
  try {
    const { data } = await plaid.linkTokenCreate({
      user:          { client_user_id: req.uid },
      client_name:   'FlowCheck',
      products:      [Products.Transactions],
      country_codes: [CountryCode.Us],
      language:      'en',
      // Webhook registered at link time — Plaid calls this whenever
      // new transactions are available for this item.
      webhook: `${BACKEND_URL}/plaid/webhook`,
      // OAuth redirect URI — required for banks that use OAuth (Chase, Capital One, etc.)
      // The custom scheme 'flowcheck://' must also be registered in:
      //   1. iOS Info.plist → CFBundleURLTypes (done)
      //   2. Plaid Dashboard → Team Settings → API → Allowed redirect URIs
      redirect_uri: `${BACKEND_URL}/plaid/oauth-return`,
    });
    res.json({ link_token: data.link_token });
  } catch (err) {
    const msg = _safeMsg(err);
    console.error('[link-token]', err?.response?.data?.error_code || err.message);
    res.status(500).json({ message: msg });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /plaid/oauth-return
   Plaid OAuth flow: after the user authenticates with their bank
   (Chase, Capital One, etc.), the bank redirects back to this URL.
   We immediately redirect to the app using the custom URL scheme
   so Plaid Link can complete the flow inside the app.
   Register this URL in Plaid Dashboard → Team Settings → API →
   Allowed redirect URIs.
   ───────────────────────────────────────────────────────────── */
app.get('/plaid/oauth-return', (req, res) => {
  // Pass through all query params Plaid appended (oauth_state_id, etc.)
  const params = new URLSearchParams(req.query).toString();
  const deepLink = `flowcheck://plaid-oauth-return${params ? '?' + params : ''}`;
  res.redirect(302, deepLink);
});

/* ─────────────────────────────────────────────────────────────
   POST /plaid/exchange-token
   ───────────────────────────────────────────────────────────── */
app.post('/plaid/exchange-token', requireAuth, _plaidUserLimiter, async (req, res) => {
  const { public_token, metadata } = req.body;
  if (!public_token) return res.status(400).json({ message: 'public_token required' });

  // Server-side pro gate: free users may link only 1 bank account.
  // Client-side gating alone is insufficient — enforce here authoritatively.
  try {
    const userSnap = await db.collection('users').doc(req.uid).get();
    const userData = userSnap.data() || {};
    const isPro    = !!(userData.is_pro || userData.pro);
    if (!isPro) {
      const existingItems = await db.collection('users').doc(req.uid)
        .collection('plaid_items').limit(1).get();
      if (!existingItems.empty) {
        return res.status(403).json({ message: 'Upgrade to Pro to connect additional bank accounts.' });
      }
    }
  } catch (gateErr) {
    console.error('[exchange-token] pro gate check failed:', gateErr.message);
    // Fail open only if the check itself errors — don't block legitimate users on DB hiccup.
  }

  try {
    const { data } = await plaid.itemPublicTokenExchange({ public_token });

    // Derive institution from Plaid (server-authoritative) instead of trusting
    // client-supplied metadata, which could be spoofed. Fall back to client
    // metadata only if Plaid lookup fails (e.g. institution_id missing).
    let institution     = '';
    let institution_id  = '';
    try {
      const item = await plaid.itemGet({ access_token: data.access_token });
      institution_id = item.data?.item?.institution_id || '';
      if (institution_id) {
        const inst = await plaid.institutionsGetById({
          institution_id,
          country_codes: ['US'],
        });
        institution = inst.data?.institution?.name || '';
      }
    } catch (lookupErr) {
      console.warn('[exchange-token] institution lookup failed, using client metadata:', lookupErr.message);
    }
    if (!institution_id) institution_id = metadata?.institution?.institution_id || '';
    if (!institution)    institution    = metadata?.institution?.name || '';

    // Store access_token in user's plaid_items subcollection (keyed by item_id)
    // This allows multiple banks per user — each bank gets its own doc.
    await db.collection('users').doc(req.uid)
      .collection('plaid_items').doc(data.item_id).set({
        access_token:   data.access_token,
        item_id:        data.item_id,
        institution,
        institution_id,
        env:            plaidEnv,
        linked_at:      admin.firestore.FieldValue.serverTimestamp(),
      });

    // Maintain top-level user doc — only set plaid_institution on FIRST bank connect
    // so it doesn't overwrite the name when a second/third bank is added.
    const userSnap = await db.collection('users').doc(req.uid).get();
    const alreadyLinked = userSnap.data()?.plaid_institution;
    await db.collection('users').doc(req.uid).update({
      plaid_linked:     true,
      plaid_linked_at:  admin.firestore.FieldValue.serverTimestamp(),
      // Only write institution fields if this is the first bank linked
      ...(!alreadyLinked ? {
        plaid_institution:    institution,
        plaid_institution_id: institution_id,
      } : {}),
    });

    console.log(`[exchange] uid:${req.uid} linked → ${data.item_id} (${institution})`);

    // Trigger referral activation — awards Pro month to both sides if the
    // new user had a referral code applied at signup. Non-blocking, never
    // delays the exchange-token response.
    try {
      const userSnap = await db.collection('users').doc(req.uid).get();
      const userData = userSnap.data();
      if (userData?.referred_by_code && !userData?.referral_activated) {
        // Call activate internally (reuse the router's logic directly via Firestore)
        // rather than making an HTTP self-call which adds latency and auth complexity.
        const referrerUid = userData.referred_by_uid;
        const code        = userData.referred_by_code;
        const referralRef = db.collection('referrals').doc(code);
        const referrerRef = db.collection('users').doc(referrerUid);
        const userRef     = db.collection('users').doc(req.uid);

        await db.runTransaction(async (trx) => {
          const referralSnap   = await trx.get(referralRef);
          const userSnapTrx    = await trx.get(userRef);
          const referrerSnapTrx = await trx.get(referrerRef);
          if (!referralSnap.exists) return;

          const newActivations = (referralSnap.data().activations || 0) + 1;
          const lifetimePro    = newActivations >= 3;
          const TS = admin.firestore.Timestamp;

          // Mark referred user activated + grant 1 Pro month
          trx.update(userRef, { referral_activated: true });
          if (userSnapTrx.exists) {
            const d   = userSnapTrx.data();
            const now = new Date();
            const base = d.pro_expires_at
              ? (d.pro_expires_at.toDate ? d.pro_expires_at.toDate() : new Date(d.pro_expires_at))
              : now;
            const exp = new Date(base > now ? base : now);
            exp.setMonth(exp.getMonth() + 1);
            trx.update(userRef, { pro: true, is_pro: true, pro_expires_at: TS.fromDate(exp), referral_pro_months_earned: admin.firestore.FieldValue.increment(1) });
          }

          // Grant referrer: lifetime Pro or 1 month
          if (referrerSnapTrx.exists) {
            const rd  = referrerSnapTrx.data();
            const now = new Date();
            const forever = new Date(); forever.setFullYear(forever.getFullYear() + 100);
            const base = rd.pro_expires_at
              ? (rd.pro_expires_at.toDate ? rd.pro_expires_at.toDate() : new Date(rd.pro_expires_at))
              : now;
            const exp = new Date(base > now ? base : now);
            if (!lifetimePro) exp.setMonth(exp.getMonth() + 1);
            trx.update(referrerRef, {
              pro: true, is_pro: true,
              pro_expires_at: TS.fromDate(lifetimePro ? forever : exp),
              ...(lifetimePro ? { referral_lifetime_pro: true } : { referral_pro_months_earned: admin.firestore.FieldValue.increment(1) }),
            });
          }

          trx.update(referralRef, { activations: newActivations, ...(lifetimePro ? { lifetime_pro: true } : {}) });
        });
        console.log(`[referral] activated for uid:${req.uid} via code:${code}`);

        // Email both sides about their reward — best-effort, never blocks
        try {
          const [referrerRecord, referredRecord] = await Promise.all([
            admin.auth().getUser(referrerUid).catch(() => null),
            admin.auth().getUser(req.uid).catch(() => null),
          ]);
          const [referrerName, referredName] = await Promise.all([
            _resolveDisplayName(referrerUid, 'Friend'),
            _resolveDisplayName(req.uid, 'Someone'),
          ]);

          // Notify referrer: you earned Pro
          if (referrerRecord?.email) {
            const rewardLabel  = lifetimePro ? 'Lifetime Pro 🏆' : '1 month of Pro free';
            _sendEmail(referrerRecord.email, `${referredName} joined FlowCheck — you earned ${rewardLabel}! 🎉`, `
              <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
              <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
                  ${LOGO_IMG}
                  <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 6px">Your referral just paid off, ${referrerName}!</h1>
                  <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">${referredName} connected their bank</p>
                </div>
                <div style="padding:28px 32px">
                  <div style="background:#f0fffe;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
                    <div style="font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Your Reward</div>
                    <div style="font-size:24px;font-weight:800;color:#0a1520">${rewardLabel}</div>
                    ${lifetimePro ? '<div style="font-size:13px;color:#6b7280;margin-top:4px">3 referrals — you unlocked lifetime access</div>' : ''}
                  </div>
                  <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 20px">
                    ${lifetimePro
                      ? 'You\'ve referred 3 people to FlowCheck — that earns you lifetime Pro access. Thank you for spreading the word.'
                      : 'Your Pro subscription has been extended by one month. Keep sharing and you can earn even more — 3 referrals unlocks lifetime access.'}
                  </p>
                  <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
                    Open FlowCheck →
                  </a>
                </div>
                <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
                  <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(referrerUid, 'all', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
                </div>
              </div></body></html>
            `, referrerUid).catch(() => {});
          }

          // Notify referred user: you also earned 1 month Pro
          if (referredRecord?.email) {
            _sendEmail(referredRecord.email, `You got 1 month of FlowCheck Pro — welcome gift! 🎁`, `
              <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
              <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
                  ${LOGO_IMG}
                  <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 6px">You've got 1 month Pro free, ${referredName}!</h1>
                  <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">A welcome gift for joining via referral</p>
                </div>
                <div style="padding:28px 32px">
                  <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 20px">
                    Because you joined FlowCheck through a referral, you've been given one free month of Pro — no credit card required. Here's what you have access to:
                  </p>
                  <div style="background:#f0fffe;border-left:3px solid #1ac4f0;border-radius:8px;padding:14px 18px;margin-bottom:24px">
                    <p style="font-size:13px;color:#4b5563;margin:4px 0">✦ Unlimited bank accounts</p>
                    <p style="font-size:13px;color:#4b5563;margin:4px 0">✦ Financial Health Score</p>
                    <p style="font-size:13px;color:#4b5563;margin:4px 0">✦ AI spending insights</p>
                    <p style="font-size:13px;color:#4b5563;margin:4px 0">✦ Bill tracking &amp; reminders</p>
                  </div>
                  <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
                    Explore Pro Features →
                  </a>
                </div>
                <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
                  <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(req.uid, 'all', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
                </div>
              </div></body></html>
            `, req.uid).catch(() => {});
          }
        } catch (_) {} // email errors never affect the referral grant
      }
    } catch (refErr) {
      // Non-fatal — bank is linked, referral reward is best-effort
      console.warn('[referral/auto-activate]', refErr.message);
    }

    // Non-blocking confirmation email — never delays the response
    _sendBankConnectedEmail(req.uid, institution).catch(() => {});

    res.json({ success: true, item_id: data.item_id });
  } catch (err) {
    console.error('[exchange]', err.message);
    res.status(500).json({ message: _safeMsg(err) });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /plaid/sync
   Fetches accounts + last 90 days transactions → writes to Firestore
   ───────────────────────────────────────────────────────────── */
/* ── GET /plaid/items — list connected banks (no access_tokens) ── */
app.get('/plaid/items', requireAuth, async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.uid);
    const snap    = await userRef.collection('plaid_items').get();
    let items = snap.docs.map(d => {
      const { access_token, ...safe } = d.data(); // strip access_token
      return { id: d.id, ...safe };
    });
    // Backward-compat: legacy top-level plaid_items/{uid}
    if (!items.length) {
      const legacySnap = await db.collection('plaid_items').doc(req.uid).get();
      if (legacySnap.exists) {
        const { access_token, ...safe } = legacySnap.data();
        items = [{ id: req.uid, ...safe }];
      }
    }
    res.json({ items });
  } catch (err) {
    console.error('[plaid/items]', err.message);
    res.status(500).json({ message: _safeMsg(err, 'Could not load linked banks') });
  }
});

app.get('/plaid/sync', requireAuth, perUserLimiter(30), async (req, res) => {
  try {
    const userRef = db.collection('users').doc(req.uid);

    // Load all linked items — new subcollection model (multiple banks)
    let itemSnaps = (await userRef.collection('plaid_items').get()).docs;

    // Backward-compat: also check old top-level plaid_items/{uid} doc
    if (!itemSnaps.length) {
      const legacySnap = await db.collection('plaid_items').doc(req.uid).get();
      if (legacySnap.exists) itemSnaps = [legacySnap];
    }

    if (!itemSnaps.length) return res.status(404).json({ message: 'No linked account' });

    const TS = admin.firestore.FieldValue.serverTimestamp;
    let totalAccounts = 0, totalAdded = 0, totalModified = 0, totalRemoved = 0;

    const itemErrors = [];

    for (const itemDoc of itemSnaps) {
      // Per-item try/catch — one failing bank doesn't abort sync for all others.
      // Common failure: ITEM_LOGIN_REQUIRED (user changed bank password).
      try {
        const itemData = itemDoc.data();
        const { access_token } = itemData;
        if (!access_token) continue;

        /* ── Accounts (always fresh — small write, critical for balance accuracy) ── */
        const { data: acctData } = await plaid.accountsGet({ access_token });
        const accounts = acctData.accounts.map(a => ({
          id:                a.account_id,
          name:              a.name,
          official_name:     a.official_name  || null,
          type:              a.type,
          subtype:           a.subtype        || null,
          balance_current:   a.balances.current   ?? 0,
          balance_limit:     a.balances.limit      ?? null,
          balance_available: a.balances.available  ?? null,
          currency:          a.balances.iso_currency_code || 'USD',
          mask:              a.mask           || null,
          item_id:           itemData.item_id || itemDoc.id,
          institution_name:  itemData.institution || '',
        }));

        let batch = db.batch();
        accounts.forEach(a => {
          batch.set(userRef.collection('accounts').doc(a.id), { ...a, updated_at: TS() }, { merge: true });
        });
        await batch.commit();

        /* ── Transactions — cursor-based (only writes the delta, not all history) ── */
        let cursor = itemData.plaid_cursor || undefined;
        let added = [], modified = [], removed = [];
        let hasMore = true;

        while (hasMore) {
          const reqBody = { access_token, count: 500 };
          if (cursor) reqBody.cursor = cursor;
          const { data } = await plaid.transactionsSync(reqBody);
          added    = added.concat(data.added);
          modified = modified.concat(data.modified);
          removed  = removed.concat(data.removed);
          hasMore  = data.has_more;
          cursor   = data.next_cursor;
        }

        // Persist new cursor so next sync is a true delta
        await itemDoc.ref.update({ plaid_cursor: cursor, needs_reauth: false });

        /* Write added + modified transactions */
        const upserts = [...added, ...modified];
        for (let i = 0; i < upserts.length; i += 400) {
          batch = db.batch();
          upserts.slice(i, i + 400).forEach(t => {
            batch.set(userRef.collection('transactions').doc(t.transaction_id), {
              id:              t.transaction_id,
              account_id:      t.account_id,
              name:            t.name,
              amount:          Math.abs(t.amount),
              isCredit:        t.amount < 0,
              date:            t.date,
              category:        t.personal_finance_category?.primary
                                 ? [t.personal_finance_category.primary]
                                 : (t.category || []),
              pending:         t.pending,
              merchant_name:   t.merchant_name    || null,
              logo_url:        t.logo_url         || null,
              payment_channel: t.payment_channel  || null,
              updated_at:      TS(),
            }, { merge: true });
          });
          await batch.commit();
        }

        /* Delete removed transactions */
        for (let i = 0; i < removed.length; i += 400) {
          batch = db.batch();
          removed.slice(i, i + 400).forEach(r => {
            batch.delete(userRef.collection('transactions').doc(r.transaction_id));
          });
          await batch.commit();
        }

        totalAccounts  += accounts.length;
        totalAdded     += added.length;
        totalModified  += modified.length;
        totalRemoved   += removed.length;
        console.log(`[sync] uid:${req.uid} item:${itemDoc.id} → ${accounts.length} accounts, +${added.length}~${modified.length}-${removed.length} txns`);

      } catch (itemErr) {
        const plaidCode = itemErr.response?.data?.error_code;
        const plaidMsg  = itemErr.response?.data?.error_message || itemErr.message;
        console.error(`[sync] item ${itemDoc.id} failed: ${plaidCode || plaidMsg}`);
        itemErrors.push({ item_id: itemDoc.id, error_code: plaidCode, message: plaidMsg });
        // Flag item for re-auth in Firestore so the client can surface a reconnect prompt
        if (plaidCode === 'ITEM_LOGIN_REQUIRED' || plaidCode === 'ITEM_NOT_FOUND') {
          await itemDoc.ref.update({ needs_reauth: true }).catch(() => {});
        }
        // Continue to next item — one bad bank doesn't fail the whole sync
      }
    }

    await userRef.update({ last_synced: TS() });

    // Return 200 if any items succeeded, 207 if mixed, 500 only if ALL failed
    const statusCode = totalAccounts > 0 ? 200 : (itemErrors.length === itemSnaps.length ? 500 : 207);
    res.status(statusCode).json({
      accounts: totalAccounts, added: totalAdded, modified: totalModified, removed: totalRemoved,
      ...(itemErrors.length ? { item_errors: itemErrors } : {}),
    });
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    console.error('[sync]', msg);
    res.status(500).json({ message: msg });
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /plaid/disconnect
   Revokes Plaid item, wipes all financial data, sets
   plaid_linked: false. Compliant with Plaid ToS + CCPA.
   ───────────────────────────────────────────────────────────── */
app.delete('/plaid/disconnect', requireAuth, async (req, res) => {
  const uid     = req.uid;
  const userRef = db.collection('users').doc(uid);

  try {
    // Collect all item docs — new subcollection model + legacy top-level doc
    const newItemsSnap   = await userRef.collection('plaid_items').get();
    const legacyItemSnap = await db.collection('plaid_items').doc(uid).get();

    const allItems = [
      ...newItemsSnap.docs,
      ...(legacyItemSnap.exists ? [legacyItemSnap] : []),
    ];

    if (!allItems.length) {
      return res.status(404).json({ message: 'No linked account found' });
    }

    // Revoke all Plaid items — best-effort
    for (const itemDoc of allItems) {
      const { access_token } = itemDoc.data();
      if (!access_token) continue;
      try {
        await plaid.itemRemove({ access_token });
        console.log(`[disconnect] uid:${uid} revoked item:${itemDoc.id}`);
      } catch (plaidErr) {
        console.error(`[disconnect] uid:${uid} revoke failed for item:${itemDoc.id}:`, plaidErr.message);
      }
    }

    // Delete all plaid_items subcollection docs
    for (const itemDoc of newItemsSnap.docs) {
      await itemDoc.ref.delete();
    }
    // Delete legacy top-level doc if it exists
    if (legacyItemSnap.exists) await legacyItemSnap.ref.delete();

    // Wipe all financial subcollections (accounts, transactions)
    for (const sub of ['accounts', 'transactions']) {
      let snap;
      do {
        snap = await userRef.collection(sub).limit(400).get();
        if (!snap.empty) {
          const batch = db.batch();
          snap.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      } while (!snap.empty);
    }

    // Clear Plaid fields from user doc
    await userRef.update({
      plaid_linked:         false,
      plaid_institution:    admin.firestore.FieldValue.delete(),
      plaid_institution_id: admin.firestore.FieldValue.delete(),
      plaid_linked_at:      admin.firestore.FieldValue.delete(),
      last_synced:          admin.firestore.FieldValue.delete(),
    });

    console.log(`[disconnect] uid:${uid} fully disconnected (${allItems.length} item(s))`);
    res.json({ success: true });
  } catch (err) {
    console.error('[disconnect]', err.message);
    res.status(500).json({ message: 'Failed to disconnect bank — please try again' });
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /plaid/disconnect/:itemId
   Revokes a single Plaid item, deletes its accounts + transactions.
   If this was the last item, sets plaid_linked: false.
   ───────────────────────────────────────────────────────────── */
app.delete('/plaid/disconnect/:itemId', requireAuth, async (req, res) => {
  const uid    = req.uid;
  const itemId = req.params.itemId;
  const userRef = db.collection('users').doc(uid);

  try {
    const itemDoc = await userRef.collection('plaid_items').doc(itemId).get();
    if (!itemDoc.exists) {
      return res.status(404).json({ message: 'Bank not found' });
    }

    // Revoke Plaid access token — best-effort
    const { access_token } = itemDoc.data();
    if (access_token) {
      try {
        await plaid.itemRemove({ access_token });
        console.log(`[disconnect-item] uid:${uid} revoked item:${itemId}`);
      } catch (plaidErr) {
        console.error(`[disconnect-item] revoke failed for item:${itemId}:`, plaidErr.message);
      }
    }

    // Delete the plaid_items doc
    await itemDoc.ref.delete();

    // Find all accounts for this item
    const accountsSnap = await userRef.collection('accounts')
      .where('item_id', '==', itemId).get();
    const accountIds = accountsSnap.docs.map(d => d.id);

    // Delete transactions for each account
    for (const accountId of accountIds) {
      let txSnap;
      do {
        txSnap = await userRef.collection('transactions')
          .where('account_id', '==', accountId)
          .limit(400).get();
        if (!txSnap.empty) {
          const batch = db.batch();
          txSnap.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      } while (!txSnap.empty);
    }

    // Delete the accounts themselves
    if (accountsSnap.docs.length) {
      const batch = db.batch();
      accountsSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    // Check remaining items
    const remainingSnap = await userRef.collection('plaid_items').get();
    if (remainingSnap.empty) {
      // Last bank — clear plaid state from user doc
      await userRef.update({
        plaid_linked:         false,
        plaid_institution:    admin.firestore.FieldValue.delete(),
        plaid_institution_id: admin.firestore.FieldValue.delete(),
        plaid_linked_at:      admin.firestore.FieldValue.delete(),
        last_synced:          admin.firestore.FieldValue.delete(),
      });
    } else {
      // Update user doc to reflect most-recently-connected remaining bank
      const lastItem = remainingSnap.docs[remainingSnap.docs.length - 1].data();
      await userRef.update({
        plaid_institution:    lastItem.institution    || '',
        plaid_institution_id: lastItem.institution_id || '',
      });
    }

    console.log(`[disconnect-item] uid:${uid} item:${itemId} done (${remainingSnap.size} remaining)`);
    res.json({ success: true, remaining: remainingSnap.size });
  } catch (err) {
    console.error('[disconnect-item]', err.message);
    res.status(500).json({ message: 'Failed to disconnect bank — please try again' });
  }
});

/* ─────────────────────────────────────────────────────────────
   DELETE /user/account
   Full CCPA-compliant account erasure.
   Removes: Plaid item, all Firestore data, Firebase Auth user.
   ───────────────────────────────────────────────────────────── */
app.delete('/user/account', requireAuth, async (req, res) => {
  const uid = req.uid;
  try {
    // 1. Revoke all Plaid items — new subcollection + legacy doc
    const userRef    = db.collection('users').doc(uid);
    const newItems   = await userRef.collection('plaid_items').get();
    const legacyItem = await db.collection('plaid_items').doc(uid).get();
    for (const itemDoc of [...newItems.docs, ...(legacyItem.exists ? [legacyItem] : [])]) {
      try {
        await plaid.itemRemove({ access_token: itemDoc.data().access_token });
      } catch (_) { /* best-effort */ }
      await itemDoc.ref.delete();
    }

    // 2. Delete all Firestore subcollections (CCPA: must erase everything)
    for (const sub of ['accounts', 'transactions', 'goals', 'budgets', 'bills', 'plaid_items',
                        'notifications', 'transaction_overrides', 'credit_history', 'nw_history']) {
      let snap;
      do {
        snap = await userRef.collection(sub).limit(400).get();
        if (!snap.empty) {
          const batch = db.batch();
          snap.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      } while (!snap.empty);
    }

    // 3. Delete user document
    await userRef.delete();

    // 4. Send goodbye email BEFORE deleting the auth record — last chance to
    //    read the user's email from Firebase Auth. Best-effort: never blocks deletion.
    try {
      const userRecord = await admin.auth().getUser(uid);
      const email = userRecord.email;
      const name  = userRecord.displayName ? userRecord.displayName.split(' ')[0] : 'there';
      if (email && _resendApiKey) {
        await _sendEmail(email, 'Your FlowCheck account has been deleted', `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account Deleted — FlowCheck</title></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f3f4f6">Your FlowCheck account and all associated data have been permanently deleted.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;width:100%">

  <!-- Header -->
  <tr><td style="background:linear-gradient(160deg,#060e18 0%,#0d2240 100%);border-radius:16px 16px 0 0;padding:40px 40px 36px;text-align:center">
    ${LOGO_IMG}
    <h1 style="color:#ffffff;font-size:26px;font-weight:800;margin:0 0 8px;letter-spacing:-0.03em;line-height:1.2">Account deleted.</h1>
    <p style="color:rgba(255,255,255,0.50);font-size:15px;margin:0">We're sorry to see you go, ${_htmlEscape(name)}.</p>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:36px 40px">
    <p style="font-size:15px;color:#374151;line-height:1.7;margin:0 0 24px">
      Your FlowCheck account has been <strong>permanently deleted</strong>. All of your data has been removed from our servers in accordance with our privacy policy.
    </p>

    <!-- What was deleted -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e5e7eb;border-radius:12px;margin-bottom:28px">
      <tr><td style="padding:20px 24px">
        <p style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px">What was deleted</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:4px 0;font-size:14px;color:#374151"><span style="color:#34c759;margin-right:8px;font-weight:700">✓</span>Your account and login credentials</td></tr>
          <tr><td style="padding:4px 0;font-size:14px;color:#374151"><span style="color:#34c759;margin-right:8px;font-weight:700">✓</span>All connected bank accounts (Plaid links revoked)</td></tr>
          <tr><td style="padding:4px 0;font-size:14px;color:#374151"><span style="color:#34c759;margin-right:8px;font-weight:700">✓</span>Transaction history and spending data</td></tr>
          <tr><td style="padding:4px 0;font-size:14px;color:#374151"><span style="color:#34c759;margin-right:8px;font-weight:700">✓</span>Bills, goals, and budget settings</td></tr>
          <tr><td style="padding:4px 0;font-size:14px;color:#374151"><span style="color:#34c759;margin-right:8px;font-weight:700">✓</span>All personal preferences and notifications</td></tr>
        </table>
      </td></tr>
    </table>

    <p style="font-size:14px;color:#6b7280;line-height:1.7;margin:0 0 28px">
      If you deleted by mistake or want to give FlowCheck another try, you're always welcome back. Simply download the app and create a new account.
    </p>

    <p style="font-size:13px;color:#9ca3af;line-height:1.6;margin:0 0 4px">
      Questions about your data or this deletion? Contact us at
      <a href="mailto:support@getflowcheck.app" style="color:#1ac4f0;text-decoration:none">support@getflowcheck.app</a>
    </p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 16px 16px;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0;line-height:1.5">
      FlowCheck · <a href="https://getflowcheck.app" style="color:#9ca3af;text-decoration:none">getflowcheck.app</a><br>
      This is a transactional email related to your account deletion request. No further emails will be sent to this address.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>
        `);
      }
    } catch (emailErr) {
      console.warn('[delete-account] goodbye email failed (non-fatal):', emailErr.message);
    }

    // 5. Delete Firebase Auth account — must be last (after reading email above)
    await admin.auth().deleteUser(uid);

    console.log(`[delete-account] uid:${uid} fully deleted`);
    res.json({ success: true });
  } catch (err) {
    console.error('[delete-account]', err.message);
    res.status(500).json({ message: 'Account deletion failed — please contact support' });
  }
});


/* ─────────────────────────────────────────────────────────────
   CREDIT SCORE
   Manual entry only — users enter their score from their bank
   or credit monitoring service (no third-party API required).
   ─────────────────────────────────────────────────────────────── */

/* ── GET /credit/score — returns the stored manual score ──────── */
app.get('/credit/score', requireAuth, async (req, res) => {
  try {
    const userSnap = await db.collection('users').doc(req.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    if (userData.credit_score) {
      return res.json({
        score:     userData.credit_score,
        scoreType: userData.credit_score_type || 'FICO',
        riskClass: userData.credit_risk_class || null,
        factors:   userData.credit_factors    || [],
        cached:    true,
        manual:    !!userData.credit_score_manual,
      });
    }
    // No score stored yet
    return res.json({ score: null, noScore: true });
  } catch (err) {
    console.error('[credit/score]', err.message);
    res.status(500).json({ message: 'Unable to retrieve credit score' });
  }
});

/* ── POST /credit/manual — save user-entered credit score ─────── */
app.post('/credit/manual', requireAuth, async (req, res) => {
  const VALID_SCORE_TYPES = ['FICO', 'VantageScore', 'Other'];
  const { score, scoreType } = req.body;
  const parsedScore = parseInt(score);
  if (!parsedScore || parsedScore < 300 || parsedScore > 850) {
    return res.status(400).json({ message: 'Score must be between 300 and 850' });
  }
  const safeScoreType = VALID_SCORE_TYPES.includes(scoreType) ? scoreType : 'FICO';

  try {
    await db.collection('users').doc(req.uid).update({
      credit_score:            parsedScore,
      credit_score_type:       safeScoreType,
      credit_risk_class:       null,
      credit_factors:          [],
      credit_score_updated_at: admin.firestore.FieldValue.serverTimestamp(),
      credit_score_manual:     true,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[credit/manual]', err.message);
    res.status(500).json({ message: 'Unable to save credit score — please try again' });
  }
});

/* ─────────────────────────────────────────────────────────────
   EMAIL (Resend)
   Set RESEND_API_KEY in Railway env vars.
   All email automation (bill reminders, weekly summaries, budget
   alerts, welcome emails) is handled entirely in this backend —
   no need to configure automations in the Resend dashboard.
   Also set: EMAIL_FROM  (e.g. "FlowCheck <noreply@flowcheck.app>")
             Must be a verified sender domain in Resend.
   ───────────────────────────────────────────────────────────── */
const _resendApiKey = process.env.RESEND_API_KEY || null;
if (_resendApiKey) {
  console.log('[Boot] Email: Resend configured ✓');
} else {
  console.warn('[Boot] RESEND_API_KEY not set — email endpoints are no-ops');
}

const EMAIL_FROM = process.env.EMAIL_FROM || 'FlowCheck <noreply@getflowcheck.app>';
const LOGO_IMG   = `<img src="${BACKEND_URL}/flowcheck-icon.png" width="64" height="64" style="border-radius:16px;display:block;margin:0 auto 20px;box-shadow:0 4px 20px rgba(26,196,240,0.25)" alt="FlowCheck">`;

async function _sendEmail(to, subject, html, uid = null) {
  if (!_resendApiKey) {
    console.log('[email] No Resend API key configured — skipping:', subject, '→', to);
    return false;
  }
  // RFC 8058 List-Unsubscribe headers — enables one-click unsubscribe in Gmail + Apple Mail
  const headers = uid ? {
    'List-Unsubscribe':      `<${_unsubUrl(uid, 'all', BACKEND_URL)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  } : {};
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${_resendApiKey}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify({ from: EMAIL_FROM, to, subject, html, headers }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[email] Resend error ${resp.status}:`, errText.slice(0, 300));
      return false;
    }
    console.log(`[email] Sent "${subject}" → ${to}`);
    return true;
  } catch (err) {
    console.error('[email] Send failed:', err.message);
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────
   POST /email/welcome
   Called by the client immediately after account creation.
   Sends a branded welcome email. Never blocks signup — always
   returns 200 even if email fails.
   ───────────────────────────────────────────────────────────── */
app.post('/email/welcome', requireAuth, async (req, res) => {
  try {
    const userRecord = await admin.auth().getUser(req.uid);
    const email = userRecord.email;

    if (!email) {
      return res.json({ ok: true, skipped: 'no_email' });
    }

    const name = await _resolveDisplayName(req.uid);

    await _sendEmail(email, `Welcome to FlowCheck, ${name} 👋`, `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to FlowCheck</title></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f3f4f6">Your FlowCheck account is ready — connect your bank and see your money clearly.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

  <!-- Header -->
  <tr><td style="background:linear-gradient(160deg,#060e18 0%,#0d2240 100%);border-radius:16px 16px 0 0;padding:40px 40px 36px;text-align:center">
    ${LOGO_IMG}
    <h1 style="color:#ffffff;font-size:28px;font-weight:800;margin:0 0 8px;letter-spacing:-0.03em;line-height:1.2">Welcome, ${name}.</h1>
    <p style="color:rgba(255,255,255,0.55);font-size:15px;margin:0;font-weight:400">Your money, clearly.</p>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:36px 40px">
    <p style="font-size:16px;color:#374151;line-height:1.7;margin:0 0 28px">
      You're all set. FlowCheck connects to your bank and gives you a live view of your spending, bills, and financial health — all in one place.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fffe;border-radius:12px;margin-bottom:32px">
      <tr><td style="padding:20px 24px">
        <p style="font-size:12px;font-weight:700;color:#1ac4f0;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 14px">Get started in 3 steps</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:6px 0;font-size:14px;color:#374151">
            <span style="display:inline-block;width:22px;height:22px;background:#1ac4f0;border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:800;color:#060e18;margin-right:10px;vertical-align:middle">1</span>
            Connect your bank account with Plaid
          </td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#374151">
            <span style="display:inline-block;width:22px;height:22px;background:rgba(26,196,240,0.2);border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:800;color:#1ac4f0;margin-right:10px;vertical-align:middle">2</span>
            Set a monthly budget and track spending
          </td></tr>
          <tr><td style="padding:6px 0;font-size:14px;color:#374151">
            <span style="display:inline-block;width:22px;height:22px;background:rgba(26,196,240,0.2);border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:800;color:#1ac4f0;margin-right:10px;vertical-align:middle">3</span>
            Check your Financial Health Score
          </td></tr>
        </table>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <a href="${BACKEND_URL}/open?ref=welcome_email" style="display:inline-block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#ffffff;font-weight:700;font-size:16px;padding:16px 40px;border-radius:12px;text-decoration:none;letter-spacing:-0.01em">Open FlowCheck →</a>
    </td></tr></table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#ffffff;border-radius:0 0 16px 16px;border-top:1px solid #f3f4f6;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0;line-height:1.8">
      FlowCheck · Your money, clearly.<br>
      <a href="https://getflowcheck.app/privacy" style="color:#9ca3af;text-decoration:none">Privacy Policy</a>
      &nbsp;·&nbsp;
      <a href="${_unsubUrl(req.uid, 'all', BACKEND_URL)}" style="color:#9ca3af;text-decoration:none">Unsubscribe</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>
    `, req.uid);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[email/welcome]', err.message);
    if (res.headersSent) return;
    res.json({ ok: true, error: 'email_failed' });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /email/test
   Sends a test email to the authenticated user's address.
   Useful for verifying SMTP configuration is working.
   ───────────────────────────────────────────────────────────── */
app.post('/email/test', requireAuth, async (req, res) => {
  try {
    const userRecord = await admin.auth().getUser(req.uid);
    const email = userRecord.email;
    if (!email) return res.json({ ok: true, skipped: 'no_email' });

    const sent = await _sendEmail(email, 'FlowCheck email test ✅', `
      <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08)">
        <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:28px;text-align:center">
          <div style="font-size:40px;margin-bottom:8px">✅</div>
          <h2 style="color:#fff;font-size:20px;font-weight:700;margin:0">Email is working!</h2>
        </div>
        <div style="padding:24px">
          <p style="font-size:15px;color:#374151;margin:0 0 16px">Your FlowCheck email system is configured correctly. Transactional emails like bill reminders, budget alerts, and weekly summaries will be delivered to: <strong>${_htmlEscape(email)}</strong></p>
          <p style="font-size:13px;color:#9ca3af;margin:0">Sent at ${new Date().toUTCString()}</p>
        </div>
      </div>
      </body></html>
    `);
    return res.json({ ok: true, sent, to: email });
  } catch (err) {
    console.error('[email/test]', err.message);
    if (res.headersSent) return;
    res.status(500).json({ message: _safeMsg(err, 'Email test failed') });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /email/pro-upgrade
   Sends a "Welcome to Pro" email after a successful purchase.
   Called by the client immediately after purchasePackage() resolves.
   ───────────────────────────────────────────────────────────── */
app.post('/email/pro-upgrade', requireAuth, async (req, res) => {
  try {
    const userRecord = await admin.auth().getUser(req.uid);
    const email = userRecord.email;
    if (!email) return res.json({ ok: true, skipped: 'no_email' });

    const name = await _resolveDisplayName(req.uid);
    const plan = req.body?.plan === 'annual' ? 'annual' : 'monthly';
    const planLabel = plan === 'annual' ? 'Annual plan · billed yearly' : 'Monthly plan · cancel anytime';

    await _sendEmail(email, 'You\'re now FlowCheck Pro 🚀', `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to FlowCheck Pro</title></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f3f4f6">Your Pro subscription is active — here's everything you've unlocked.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

  <!-- Header -->
  <tr><td style="background:linear-gradient(160deg,#060e18 0%,#0d2240 100%);border-radius:16px 16px 0 0;padding:40px 40px 36px;text-align:center">
    ${LOGO_IMG}
    <h1 style="color:#ffffff;font-size:28px;font-weight:800;margin:0 0 8px;letter-spacing:-0.03em;line-height:1.2">You're Pro, ${name}.</h1>
    <p style="color:rgba(255,255,255,0.55);font-size:15px;margin:0">${planLabel}</p>
  </td></tr>

  <!-- Body -->
  <tr><td style="background:#ffffff;padding:36px 40px">
    <p style="font-size:16px;color:#374151;line-height:1.7;margin:0 0 28px">
      Your subscription is active. Everything is unlocked — no limits, no restrictions.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fffe;border-radius:12px;margin-bottom:32px">
      <tr><td style="padding:20px 24px">
        <p style="font-size:12px;font-weight:700;color:#1ac4f0;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 14px">What's included</p>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>Unlimited bank accounts</td></tr>
          <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>Financial Health Score</td></tr>
          <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>AI-powered spending insights</td></tr>
          <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>Bill tracking &amp; reminders</td></tr>
          <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>Net worth tracking &amp; milestones</td></tr>
          <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>Weekly financial summaries</td></tr>
        </table>
      </td></tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <a href="${BACKEND_URL}/open?ref=pro_upgrade_email" style="display:inline-block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#ffffff;font-weight:700;font-size:16px;padding:16px 40px;border-radius:12px;text-decoration:none;letter-spacing:-0.01em">Open FlowCheck →</a>
    </td></tr></table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#ffffff;border-radius:0 0 16px 16px;border-top:1px solid #f3f4f6;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0;line-height:1.8">
      FlowCheck · Your money, clearly.<br>
      Manage your subscription in <a href="itms-apps://apps.apple.com/account/subscriptions" style="color:#9ca3af;text-decoration:none">App Store Settings</a>.<br>
      <a href="https://getflowcheck.app/privacy" style="color:#9ca3af;text-decoration:none">Privacy Policy</a>
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>
    `, req.uid);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[email/pro-upgrade]', err.message);
    if (res.headersSent) return;
    res.json({ ok: true, error: 'email_failed' });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /notifications/send
   Sends an FCM push notification to the authenticated user's
   registered device via Firebase Admin Messaging.
   Body: { title: string, body: string, data?: {} }
   Use for: budget alerts, sync complete, goal reached, etc.
   ───────────────────────────────────────────────────────────── */
app.post('/notifications/send', requireAuth, async (req, res) => {
  const { title, body: msgBody, data } = req.body;
  if (!title || !msgBody) {
    return res.status(400).json({ message: 'title and body required' });
  }

  try {
    const userSnap = await db.collection('users').doc(req.uid).get();
    const fcmToken = userSnap.exists ? userSnap.data().fcm_token : null;

    // Use improved _sendFCM helper (proper APN headers + Firestore save)
    const sent = await _sendFCM(req.uid, fcmToken, {
      title,
      body:      msgBody,
      type:      (data && data.type) || 'general',
      data:      data || {},
    });

    if (!sent) {
      return res.status(404).json({ message: 'No FCM token — device not registered for push' });
    }

    console.log(`[fcm] Sent "${title}" → uid:${req.uid}`);
    res.json({ success: true });

  } catch (err) {
    const code = err.code || '';
    console.error('[notifications/send]', code, err.message);

    // Stale token — clear it so we don't keep trying
    if (
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/registration-token-not-registered'
    ) {
      await db.collection('users').doc(req.uid)
        .update({ fcm_token: admin.firestore.FieldValue.delete() })
        .catch(() => {});
      return res.status(410).json({ message: 'FCM token expired — re-register device' });
    }
    res.status(500).json({ message: 'Failed to send notification' });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /notifications/budget-alert
   Called by client when user exceeds a budget category limit.
   Sends FCM push AND an email (if email is configured + user
   has notifications enabled).
   Body: { category, spent, limit }
   ───────────────────────────────────────────────────────────── */
app.post('/notifications/budget-alert', requireAuth, async (req, res) => {
  const { category, spent, limit: budgetLimit } = req.body;
  if (!category || spent == null || budgetLimit == null) {
    return res.status(400).json({ message: 'category, spent, and limit required' });
  }
  if (typeof spent !== 'number' || typeof budgetLimit !== 'number' || budgetLimit <= 0) {
    return res.status(400).json({ message: 'spent and limit must be positive numbers' });
  }

  const pct      = Math.min(Math.round((spent / budgetLimit) * 100), 999);
  const safeCat  = _htmlEscape(String(category).slice(0, 40));
  const title    = `Budget Alert: ${safeCat}`;
  const body     = `You've used ${pct}% of your ${safeCat} budget ($${spent.toFixed(2)} of $${budgetLimit.toFixed(2)})`;

  try {
    const userSnap = await db.collection('users').doc(req.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const fcmToken = userData.fcm_token;

    // FCM push — best-effort (uses improved _sendFCM helper)
    if (fcmToken) {
      _sendFCM(req.uid, fcmToken, {
        title, body,
        type:      'budget_alert',
        data:      { category: String(category) },
        channelId: 'flowcheck_alerts',
      }).catch(err => console.error('[fcm budget-alert]', err.message));
    } else {
      // No FCM token — still save to notification center
      _saveNotification(req.uid, { title, body, type: 'budget_alert', data: { category: String(category) } }).catch(() => {});
    }

    // Email — only if notifications enabled and user has an email address
    if (userData.email && userData.notifications_enabled !== false) {
      _sendEmail(userData.email, title, `
        <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08)">
          <div style="background:#fff3cd;border-left:4px solid #ffb020;padding:20px 24px">
            <h2 style="font-size:18px;font-weight:700;color:#92400e;margin:0 0 6px">⚠️ ${title}</h2>
            <p style="font-size:15px;color:#78350f;margin:0">${body}</p>
          </div>
          <div style="padding:24px">
            <p style="font-size:14px;color:#6b7280;margin:0 0 20px">Open FlowCheck to review your spending and adjust your budget.</p>
            <a href="${BACKEND_URL}/open" style="display:inline-block;background:#1ac4f0;color:#0a1520;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">View in FlowCheck →</a>
          </div>
          <div style="padding:16px 24px;border-top:1px solid #f3f4f6">
            <p style="font-size:11px;color:#9ca3af;margin:0">
              FlowCheck · <a href="${_unsubUrl(req.uid, 'alerts')}" style="color:#9ca3af">Unsubscribe from alerts</a>
            </p>
          </div>
        </div>
        </body></html>
      `).catch(e => console.error('[email budget-alert]', e.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[notifications/budget-alert]', err.message);
    res.status(500).json({ message: 'Failed to send budget alert' });
  }
});

/* ─────────────────────────────────────────────────────────────
   NOTIFICATION HELPERS
   ───────────────────────────────────────────────────────────── */

/**
 * Save a notification to the user's Firestore notifications subcollection.
 * This powers the in-app notification center.
 */
async function _saveNotification(uid, { title, body, type, data = {} }) {
  try {
    const notifRef = db.collection('users').doc(uid).collection('notifications');
    // Dedup: skip if same type + category already exists in the last 24 hours
    const dedupKey = `${type}:${data.category || data.bill_id || ''}`;
    const since    = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const existing = await notifRef
      .where('type', '==', type || 'general')
      .where('created_at', '>=', admin.firestore.Timestamp.fromDate(since))
      .limit(1).get();
    // Check if any existing notification has the same dedup key
    const isDup = existing.docs.some(d => {
      const d2 = d.data();
      return `${d2.type}:${d2.data?.category || d2.data?.bill_id || ''}` === dedupKey;
    });
    if (isDup) {
      console.log(`[saveNotification] skipped duplicate: ${dedupKey}`);
      return;
    }
    await notifRef.add({
      title,
      body,
      type:       type || 'general',
      data:       data,
      read:       false,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[saveNotification]', err.message);
  }
}

/**
 * Send an FCM push notification to a specific device token.
 * Includes proper iOS APN headers for reliable background + foreground delivery.
 * Also saves to Firestore for the in-app notification center.
 */
async function _sendFCM(uid, fcmToken, { title, body, type, data = {}, channelId = 'flowcheck_default' }) {
  if (!fcmToken) return false;
  const stringData = Object.fromEntries(
    Object.entries({ type: String(type || 'general'), ...data }).map(([k, v]) => [k, String(v)])
  );
  try {
    // Save to Firestore first so the badge count includes this new notification
    if (uid) await _saveNotification(uid, { title, body, type, data: stringData });

    // Count unread notifications for an accurate badge number
    let badgeCount = 1;
    if (uid) {
      try {
        const unreadSnap = await db.collection('users').doc(uid)
          .collection('notifications').where('read', '==', false).get();
        badgeCount = unreadSnap.size;
      } catch (_) {}
    }

    await admin.messaging().send({
      token:        fcmToken,
      notification: { title, body },
      data:         stringData,
      apns: {
        headers: {
          'apns-priority':  '10',
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            alert:             { title, body },
            sound:             'default',
            badge:             badgeCount,
            'content-available': 1,
          },
        },
      },
      android: {
        priority: 'high',
        notification: { title, body, sound: 'default', channelId },
      },
    });
    return true;
  } catch (err) {
    if (err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token') {
      // Token stale — clear it from Firestore
      if (uid) {
        db.collection('users').doc(uid).update({
          fcm_token: admin.firestore.FieldValue.delete(),
        }).catch(() => {});
      }
    }
    console.error('[FCM]', err.code, err.message);
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────
   POST /notifications/register
   Saves (or refreshes) the FCM token for this user.
   Called by the app immediately after push registration.
   ───────────────────────────────────────────────────────────── */
app.post('/notifications/register', requireAuth, async (req, res) => {
  const { fcm_token } = req.body;
  if (!fcm_token || typeof fcm_token !== 'string' || fcm_token.length > 500) {
    return res.status(400).json({ message: 'fcm_token required and must be under 500 chars' });
  }
  try {
    await db.collection('users').doc(req.uid).update({
      fcm_token,
      fcm_updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Failed to register token' });
  }
});

/* ─────────────────────────────────────────────────────────────
   PATCH /notifications/:id/read
   Mark a single notification as read.
   ───────────────────────────────────────────────────────────── */
app.patch('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await db.collection('users').doc(req.uid)
      .collection('notifications').doc(req.params.id)
      .update({ read: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Failed to mark read' });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /notifications/mark-all-read
   Mark all notifications read for this user.
   ───────────────────────────────────────────────────────────── */
app.post('/notifications/mark-all-read', requireAuth, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.uid)
      .collection('notifications').where('read', '==', false).get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, { read: true }));
    await batch.commit();
    res.json({ ok: true, count: snap.size });
  } catch (err) {
    res.status(500).json({ message: 'Failed to mark all read' });
  }
});

/* ─────────────────────────────────────────────────────────────
   SCHEDULED NOTIFICATIONS (node-cron)
   Runs inside this process — no external scheduler needed.
   Times are UTC. Railway servers stay up continuously.

   Daily  09:00 UTC  → Bill-due reminders (bills due in 1–2 days)
   Sunday 07:00 UTC  → Weekly financial summary email
   ───────────────────────────────────────────────────────────── */
let cron;
try { cron = require('node-cron'); } catch (_) {
  console.warn('[Cron] node-cron not installed — scheduled notifications disabled. Run: npm install node-cron');
}

/** Format a dollar amount for display */
const _fmt = (n) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Given a bill's stored due_date (YYYY-MM-DD) and frequency, return the
 * next effective due date string from today forward.
 * Without this, monthly bills only fire a reminder in the month their
 * due_date was originally set — never again.
 */
function _effectiveDueDate(dueDateStr, frequency) {
  const parts = (dueDateStr || '').split('-').map(Number);
  if (parts.length < 3 || !parts[2]) return dueDateStr;
  const [storedY, storedM, storedD] = parts;
  const now = new Date(); now.setHours(0, 0, 0, 0);

  switch ((frequency || 'monthly').toLowerCase()) {
    case 'weekly': {
      const storedDate = new Date(storedY, storedM - 1, storedD);
      const dow  = storedDate.getDay();
      const diff = (dow - now.getDay() + 7) % 7;
      const next = new Date(now);
      next.setDate(now.getDate() + (diff === 0 ? 7 : diff));
      return next.toISOString().slice(0, 10);
    }
    case 'yearly':
    case 'annual': {
      let next = new Date(now.getFullYear(), storedM - 1, storedD);
      if (next < now) next = new Date(now.getFullYear() + 1, storedM - 1, storedD);
      return next.toISOString().slice(0, 10);
    }
    case 'monthly':
    default: {
      let next = new Date(now.getFullYear(), now.getMonth(), storedD);
      if (next < now) next = new Date(now.getFullYear(), now.getMonth() + 1, storedD);
      return next.toISOString().slice(0, 10);
    }
  }
}

/** Categories that represent transfers/payments, not real spending */
const _XFER_CATS = new Set([
  'transfer', 'loan', 'loan payments', 'loan payment',
  'credit card payment', 'transfer in', 'transfer out',
]);
function _isXferTxn(t) {
  const raw  = (t.category && t.category[0]) || t.category || '';
  const norm = String(raw).toLowerCase();
  return _XFER_CATS.has(norm) || norm.includes('transfer');
}

/**
 * Send bill-due reminders for a single user.
 * Checks all bills due in the next 1-2 days and sends push + email.
 */
async function _sendBillRemindersForUser(uid, userData) {
  const fcmToken   = userData.fcm_token;
  const email      = userData.email;
  const notifOn    = userData.notifications_enabled !== false;
  const alertsOn   = userData.email_alerts_enabled  !== false; // respects granular unsubscribe
  if (!notifOn) return;

  const now        = new Date();
  const tomorrow   = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const dayAfter   = new Date(now); dayAfter.setDate(now.getDate() + 2);
  const fmt        = d => d.toISOString().slice(0, 10);
  const todayStr   = fmt(now);
  const tomorrowStr = fmt(tomorrow);
  const dayAfterStr = fmt(dayAfter);

  let billsSnap;
  try {
    billsSnap = await db.collection('users').doc(uid).collection('bills')
      .where('status', '!=', 'paid').get();
  } catch (err) {
    console.error(`[cron/bills] uid:${uid} query failed:`, err.message);
    return;
  }

  for (const doc of billsSnap.docs) {
    const bill = doc.data();
    if (!bill.due_date || !bill.name) continue;
    const due         = bill.due_date.slice(0, 10);
    const effectiveDue = _effectiveDueDate(due, bill.frequency);
    if (effectiveDue !== tomorrowStr && effectiveDue !== dayAfterStr) continue;

    const daysUntil  = effectiveDue === tomorrowStr ? 1 : 2;
    const dayLabel   = daysUntil === 1 ? 'tomorrow' : 'in 2 days';
    const safeBill   = _htmlEscape(bill.name);
    const title      = `💳 ${safeBill} due ${dayLabel}`;
    const body       = `${_fmt(bill.amount || 0)} will be charged ${dayLabel}. Tap to review.`;

    // FCM push
    if (fcmToken) {
      await _sendFCM(uid, fcmToken, {
        title, body,
        type:      'bill_due',
        data:      { bill_id: doc.id, due_date: due },
        channelId: 'flowcheck_bills',
      });
    } else if (uid) {
      // No FCM token but save to notification center anyway
      await _saveNotification(uid, { title, body, type: 'bill_due', data: { bill_id: doc.id } });
    }

    // Overdue bills: if bill is 1–7 days past due, send a "still unpaid" nudge
    const overdueDays = Math.round((new Date() - new Date(effectiveDue)) / 86400000);
    if (overdueDays > 0 && overdueDays <= 7) {
      const overdueTitle = `⚠️ ${safeBill} is ${overdueDays} day${overdueDays > 1 ? 's' : ''} overdue`;
      const overdueBody  = `${_fmt(bill.amount || 0)} was due ${overdueDays} day${overdueDays > 1 ? 's' : ''} ago. Mark it paid or update the due date.`;
      if (fcmToken) {
        await _sendFCM(uid, fcmToken, { title: overdueTitle, body: overdueBody, type: 'bill_overdue', data: { bill_id: doc.id }, channelId: 'flowcheck_bills' });
      } else {
        await _saveNotification(uid, { title: overdueTitle, body: overdueBody, type: 'bill_overdue', data: { bill_id: doc.id } });
      }
      if (email && _resendApiKey && alertsOn) {
        _sendEmail(email, overdueTitle, `
          <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
          <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
            <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:32px;text-align:center">
              ${LOGO_IMG}
              <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 6px">Payment Overdue</h1>
              <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">${safeBill} · ${_fmt(bill.amount || 0)}</p>
            </div>
            <div style="background:#fee2e2;border-left:4px solid #dc2626;padding:16px 28px">
              <p style="font-size:15px;color:#991b1b;font-weight:600;margin:0">${_fmt(bill.amount || 0)} was due ${overdueDays} day${overdueDays > 1 ? 's' : ''} ago.</p>
            </div>
            <div style="padding:24px 28px">
              <p style="font-size:14px;color:#6b7280;margin:0 0 20px">Late payments can affect your credit score. Open FlowCheck to mark it paid or update the due date.</p>
              <a href="${BACKEND_URL}/open" style="display:inline-block;background:#dc2626;color:#ffffff;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Mark as Paid →</a>
            </div>
            <div style="padding:14px 28px;border-top:1px solid #f3f4f6">
              <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'alerts', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe from bill alerts</a></p>
            </div>
          </div></body></html>
        `, uid).catch(e => console.error('[email bill-overdue]', e.message));
      }
      continue; // don't double-send an upcoming reminder for overdue bills
    }

    // Email — only if alerts not unsubscribed
    if (email && _resendApiKey && alertsOn) {
      const amountStr = _fmt(bill.amount || 0);
      _sendEmail(email, title, `
        <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:32px;text-align:center">
            ${LOGO_IMG}
            <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 6px">${safeBill} due ${dayLabel}</h1>
            <p style="color:rgba(255,255,255,0.6);font-size:15px;margin:0">${amountStr} · ${due}</p>
          </div>
          <div style="padding:28px 32px">
            <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 24px">
              Just a heads up — your <strong>${safeBill}</strong> payment of <strong>${amountStr}</strong> is due ${dayLabel}.
              Make sure you have sufficient funds in your account.
            </p>
            <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#ffffff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
              Review in FlowCheck →
            </a>
          </div>
          <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
            <p style="font-size:11px;color:#9ca3af;margin:0">
              FlowCheck · <a href="${_unsubUrl(uid, 'alerts')}" style="color:#9ca3af">Unsubscribe</a>
            </p>
          </div>
        </div>
        </body></html>
      `, uid).catch(e => console.error('[email bill-reminder]', e.message));
    }
  }
}

/**
 * Send weekly financial summary email to a user.
 */
async function _sendWeeklySummaryForUser(uid, userData) {
  const email    = userData.email;
  const notifOn  = userData.notifications_enabled !== false;
  const weeklyOn = userData.email_weekly_enabled  !== false; // respects granular unsubscribe
  if (!email || !notifOn || !weeklyOn || !_resendApiKey) return;

  const name = _htmlEscape((userData.display_name || userData.name || 'Friend').split(' ')[0]);

  // Aggregate last 7 days of transactions
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  let txnSnap;
  try {
    txnSnap = await db.collection('users').doc(uid)
      .collection('transactions')
      .where('date', '>=', cutoffStr)
      .where('pending', '==', false)
      .get();
  } catch (_) { return; }

  if (txnSnap.empty) return; // No transactions — skip

  let totalSpent = 0;
  const categories = {};
  txnSnap.docs.forEach(d => {
    const t = d.data();
    // isCredit=false means expense. Exclude transfers/loan payments so they
    // don't inflate the weekly spending total shown to the user.
    if (!t.isCredit && !_isXferTxn(t)) {
      totalSpent += t.amount;
      const cat = (t.category && t.category[0]) || 'Other';
      categories[cat] = (categories[cat] || 0) + t.amount;
    }
  });

  // Top 3 spending categories
  const topCats = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, amt]) => `<tr><td style="padding:6px 0;color:#374151;font-size:14px">${_htmlEscape(cat)}</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#111827;font-size:14px">${_fmt(amt)}</td></tr>`)
    .join('');

  // Unusual spend: compare each top category to prior 4-week average
  const fourWeeksAgo = new Date(); fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const fourWeeksStr = fourWeeksAgo.toISOString().slice(0, 10);
  let priorSnap;
  try { priorSnap = await db.collection('users').doc(uid).collection('transactions').where('date', '>=', fourWeeksStr).where('date', '<', cutoffStr).where('pending', '==', false).get(); } catch (_) { priorSnap = null; }
  const priorCats = {};
  if (priorSnap) priorSnap.docs.forEach(d => { const t = d.data(); if (!t.isCredit && !_isXferTxn(t)) { const c = (t.category && t.category[0]) || 'Other'; priorCats[c] = (priorCats[c] || 0) + t.amount; } });
  const insightLines = Object.entries(categories)
    .filter(([cat, amt]) => {
      const weeklyAvg = (priorCats[cat] || 0) / 4;
      return weeklyAvg > 10 && amt > weeklyAvg * 1.4; // 40%+ spike vs average week
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([cat, amt]) => {
      const avg = (priorCats[cat] || 0) / 4;
      const pct = Math.round((amt / avg - 1) * 100);
      const label = cat.charAt(0) + cat.slice(1).toLowerCase().replace(/_/g, ' ');
      return `<div style="background:#fff7ed;border-left:3px solid #f59e0b;border-radius:8px;padding:12px 14px;margin-bottom:10px"><p style="font-size:13px;color:#92400e;margin:0">📈 <strong>${_htmlEscape(label)}</strong> spending is up ${pct}% vs your usual week (${_fmt(amt)} vs avg ${_fmt(avg)})</p></div>`;
    }).join('');

  // Safe to spend: upcoming bills in next 7 days subtracted from total balance
  let safeToSpendHtml = '';
  try {
    const nowStr  = new Date().toISOString().slice(0, 10);
    const nextStr = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const billSnap = await db.collection('users').doc(uid).collection('bills')
      .where('next_due', '>=', nowStr).where('next_due', '<=', nextStr).where('paid', '==', false).get();
    const upcomingBills = billSnap.docs.reduce((s, d) => s + (d.data().amount || 0), 0);
    const totalIncome7 = txnSnap.docs.reduce((s, d) => { const t = d.data(); return t.isCredit ? s + t.amount : s; }, 0);
    const safeAmt = totalIncome7 - totalSpent - upcomingBills;
    if (totalIncome7 > 0 || upcomingBills > 0) {
      const safeColor = safeAmt >= 0 ? '#059669' : '#dc2626';
      safeToSpendHtml = `
        <div style="background:#f0fff4;border-radius:12px;padding:18px 20px;margin-bottom:24px">
          <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Safe to spend this week</div>
          <div style="font-size:28px;font-weight:800;color:${safeColor}">${_fmt(Math.abs(safeAmt))}</div>
          <div style="font-size:12px;color:#9ca3af;margin-top:4px">${upcomingBills > 0 ? `After ${_fmt(upcomingBills)} in upcoming bills` : 'After this week\'s spending'}</div>
        </div>`;
    }
  } catch (_) {}

  // FCM push — sent before email so users get an instant heads-up
  if (userData.fcm_token && notifOn) {
    const topCatName = Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const catLabel   = topCatName
      ? topCatName.charAt(0) + topCatName.slice(1).toLowerCase().replace(/_/g, ' ')
      : '';
    _sendFCM(uid, userData.fcm_token, {
      title: '📊 Your Weekly Summary is Ready',
      body:  `You spent ${_fmt(totalSpent)} this week${catLabel ? ` — mostly on ${catLabel}` : ''}.`,
      type:  'weekly_summary',
      channelId: 'flowcheck_default',
    }).catch(() => {});
  }

  _sendEmail(email, `Your FlowCheck weekly summary 📊`, `
    <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
      <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
        ${LOGO_IMG}
        <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 6px">Weekly Summary, ${_htmlEscape(name)}!</h1>
        <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">Here's how your money moved this week</p>
      </div>
      <div style="padding:28px 32px">
        <div style="background:#f0f9ff;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
          <div style="font-size:13px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">Total Spent This Week</div>
          <div style="font-size:32px;font-weight:800;color:#0a1520;letter-spacing:-0.03em">${_fmt(totalSpent)}</div>
        </div>
        ${safeToSpendHtml}
        ${topCats ? `
        <div style="margin-bottom:24px">
          <div style="font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px">Top Categories</div>
          <table style="width:100%;border-collapse:collapse">${topCats}</table>
        </div>` : ''}
        ${insightLines ? `<div style="margin-bottom:24px"><div style="font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Spending Insights</div>${insightLines}</div>` : ''}
        <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#ffffff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
          View Full Breakdown →
        </a>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
        <p style="font-size:11px;color:#9ca3af;margin:0">
          FlowCheck · Your money, clearly<br>
          <a href="${_unsubUrl(uid, 'weekly')}" style="color:#9ca3af">Unsubscribe from weekly summaries</a>
        </p>
      </div>
    </div>
    </body></html>
  `, uid).catch(e => console.error('[email weekly]', e.message));
}

/**
 * Send a "bank connected" confirmation email.
 * Called from exchange-token after Plaid link succeeds.
 */
async function _sendBankConnectedEmail(uid, institutionName) {
  try {
    const userRecord = await admin.auth().getUser(uid);
    const email = userRecord.email;
    if (!email || !_resendApiKey) return;
    const name = await _resolveDisplayName(uid);
    const safe = _htmlEscape(institutionName || 'your bank');
    await _sendEmail(email, `${institutionName || 'Your bank'} is connected to FlowCheck ✅`, `
      <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
        <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
          ${LOGO_IMG}
          <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 6px">${safe} connected!</h1>
          <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">Your account is syncing now</p>
        </div>
        <div style="padding:28px 32px">
          <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 20px">
            Hey ${name} — <strong>${safe}</strong> is now linked to FlowCheck. Your transactions will sync automatically so you always have a clear picture of your money.
          </p>
          <div style="background:#f0fffe;border-left:3px solid #1ac4f0;border-radius:8px;padding:14px 18px;margin-bottom:24px">
            <p style="font-size:13px;font-weight:600;color:#0a1520;margin:0 0 8px">What's next:</p>
            <p style="font-size:13px;color:#4b5563;margin:4px 0">→ Set a budget to track spending by category</p>
            <p style="font-size:13px;color:#4b5563;margin:4px 0">→ Add recurring bills so you never miss a payment</p>
            <p style="font-size:13px;color:#4b5563;margin:4px 0">→ Check your Financial Health Score</p>
          </div>
          <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#ffffff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
            View My Dashboard →
          </a>
        </div>
        <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
          <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · Your money, clearly.<br>
            <a href="${_unsubUrl(uid, 'all', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
        </div>
      </div>
      </body></html>
    `, uid);
  } catch (err) {
    console.error('[email/bank-connected]', err.message);
  }
}

/**
 * Send monthly financial summary for a single user.
 * Called by the 1st-of-month cron with the previous month's date range.
 */
async function _sendMonthlySummaryForUser(uid, userData, cutoffStr, monthLabel) {
  const email = userData.email;
  if (!email || !_resendApiKey) return;

  const name    = _htmlEscape((userData.display_name || userData.name || 'Friend').split(' ')[0]);
  const userRef = db.collection('users').doc(uid);

  // Last day of the previous month = day before cutoffStr's month rolled over
  const endDate = new Date(cutoffStr); endDate.setMonth(endDate.getMonth() + 1); endDate.setDate(0);
  const endStr  = endDate.toISOString().slice(0, 10);

  let txnSnap;
  try {
    txnSnap = await db.collection('users').doc(uid)
      .collection('transactions')
      .where('date', '>=', cutoffStr)
      .where('date', '<=', endStr)
      .where('pending', '==', false)
      .get();
  } catch (_) { return; }

  if (txnSnap.empty) return;

  let totalSpent = 0, totalIncome = 0;
  const categories = {};
  txnSnap.docs.forEach(d => {
    const t = d.data();
    if (t.isCredit) {
      totalIncome += t.amount;
    } else if (!_isXferTxn(t)) {
      totalSpent += t.amount;
      const cat = (t.category && t.category[0]) || 'Other';
      categories[cat] = (categories[cat] || 0) + t.amount;
    }
  });

  const topCats = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, amt]) =>
      `<tr>
        <td style="padding:7px 0;color:#374151;font-size:14px">${_htmlEscape(cat)}</td>
        <td style="padding:7px 0;text-align:right;font-weight:600;color:#111827;font-size:14px">${_fmt(amt)}</td>
      </tr>`
    ).join('');

  const savedAmt = totalIncome - totalSpent;
  const savedColor = savedAmt >= 0 ? '#059669' : '#dc2626';
  const savedLabel = savedAmt >= 0 ? `Saved ${_fmt(savedAmt)}` : `Overspent ${_fmt(Math.abs(savedAmt))}`;

  // ── Net worth delta ──────────────────────────────────────────
  let acctSnap;
  try { acctSnap = await userRef.collection('accounts').get(); } catch (_) {}
  const currentNW = acctSnap
    ? acctSnap.docs.reduce((s, d) => {
        const a = d.data();
        const bal = a.balance_current ?? 0;
        return (a.type === 'credit' || a.type === 'loan' || a.type === 'mortgage') ? s - bal : s + bal;
      }, 0)
    : null;
  const prevNW    = typeof userData.last_nw_monthly === 'number' ? userData.last_nw_monthly : null;
  const nwDelta   = currentNW !== null && prevNW !== null ? currentNW - prevNW : null;
  const nwColor   = nwDelta === null ? '#374151' : nwDelta >= 0 ? '#059669' : '#dc2626';
  const nwSection = currentNW !== null ? `
    <div style="background:#f0fffe;border-radius:12px;padding:16px 20px;margin-bottom:24px">
      <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Net Worth</div>
      <div style="display:flex;align-items:baseline;gap:10px">
        <div style="font-size:26px;font-weight:800;color:#0a1520">${_fmt(currentNW)}</div>
        ${nwDelta !== null ? `<div style="font-size:14px;font-weight:600;color:${nwColor}">${nwDelta >= 0 ? '+' : ''}${_fmt(nwDelta)} vs last month</div>` : ''}
      </div>
    </div>` : '';

  if (userData.fcm_token) {
    _sendFCM(uid, userData.fcm_token, {
      title: `📅 Your ${monthLabel} Summary`,
      body:  `You spent ${_fmt(totalSpent)} and ${savedAmt >= 0 ? 'saved' : 'overspent'} ${_fmt(Math.abs(savedAmt))}.`,
      type:  'monthly_summary',
    }).catch(() => {});
  }

  await _sendEmail(email, `Your ${monthLabel} financial summary 📅`, `
    <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
      <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
        ${LOGO_IMG}
        <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 6px">${_htmlEscape(monthLabel)} Recap, ${name}!</h1>
        <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">Here's how your money moved last month</p>
      </div>
      <div style="padding:28px 32px">
        <div style="display:flex;gap:12px;margin-bottom:24px">
          <div style="flex:1;background:#f0fffe;border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Spent</div>
            <div style="font-size:22px;font-weight:800;color:#0a1520">${_fmt(totalSpent)}</div>
          </div>
          <div style="flex:1;background:#f0fff4;border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Income</div>
            <div style="font-size:22px;font-weight:800;color:#0a1520">${_fmt(totalIncome)}</div>
          </div>
        </div>
        <div style="background:#f9fafb;border-radius:10px;padding:14px 16px;text-align:center;margin-bottom:24px">
          <span style="font-size:15px;font-weight:700;color:${savedColor}">${savedLabel}</span>
          <span style="font-size:13px;color:#9ca3af"> last month</span>
        </div>
        ${nwSection}
        ${topCats ? `
        <div style="margin-bottom:24px">
          <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Top Spending Categories</div>
          <table style="width:100%;border-collapse:collapse">${topCats}</table>
        </div>` : ''}
        <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#ffffff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
          View Full Breakdown →
        </a>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
        <p style="font-size:11px;color:#9ca3af;margin:0">
          FlowCheck · Your money, clearly<br>
          <a href="${_unsubUrl(uid, 'weekly')}" style="color:#9ca3af">Unsubscribe from monthly summaries</a>
        </p>
      </div>
    </div>
    </body></html>
  `, uid);

  // ── Post-send: update snapshots + maybe send health score change email ──
  const fsUpdates = {};
  if (currentNW !== null) fsUpdates.last_nw_monthly = currentNW;

  const newScore = _computeSimpleHealthScore(totalIncome, totalSpent, currentNW ?? 0, userData.streak || 0);
  const prevScore = typeof userData.last_health_score === 'number' ? userData.last_health_score : null;
  fsUpdates.last_health_score    = newScore;
  fsUpdates.last_health_score_at = admin.firestore.FieldValue.serverTimestamp();

  if (Object.keys(fsUpdates).length > 0) {
    userRef.update(fsUpdates).catch(() => {});
  }

  // Health score change email — only when diff >= 5 points and alerts are on
  if (prevScore !== null && Math.abs(newScore - prevScore) >= 5 && userData.email_alerts_enabled !== false) {
    const improved = newScore > prevScore;
    const diff     = Math.abs(newScore - prevScore);
    _sendEmail(email, `${improved ? '📈' : '📉'} Your financial health score ${improved ? 'improved' : 'dropped'} by ${diff} points`, `
      <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
        <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:32px;text-align:center">
          ${LOGO_IMG}
          <div style="font-size:40px;margin-bottom:8px">${improved ? '📈' : '📉'}</div>
          <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 4px">Financial Health Score Update</h1>
          <p style="color:rgba(255,255,255,0.55);font-size:14px;margin:0">Your score for ${_htmlEscape(monthLabel)}</p>
        </div>
        <div style="padding:28px 32px">
          <div style="background:#f9fafb;border-radius:12px;padding:20px;margin-bottom:20px;text-align:center">
            <div style="display:flex;justify-content:center;align-items:center;gap:20px">
              <div>
                <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Last month</div>
                <div style="font-size:28px;font-weight:800;color:#6b7280">${prevScore}</div>
              </div>
              <div style="font-size:24px;color:${improved ? '#059669' : '#dc2626'}">→</div>
              <div>
                <div style="font-size:11px;color:#9ca3af;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">This month</div>
                <div style="font-size:36px;font-weight:900;color:${improved ? '#059669' : '#dc2626'}">${newScore}</div>
              </div>
            </div>
            <div style="margin-top:12px;font-size:14px;font-weight:600;color:${improved ? '#059669' : '#dc2626'}">${improved ? '+' : '-'}${diff} points</div>
          </div>
          <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 20px">
            ${improved
              ? `Great work! Your score improved this month — driven by your savings rate and spending discipline.`
              : `Your score dipped this month. Open FlowCheck to see your spending breakdown and find areas to trim.`}
          </p>
          <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">See My Full Report →</a>
        </div>
        <div style="padding:14px 32px;border-top:1px solid #f3f4f6;text-align:center">
          <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'weekly')}" style="color:#9ca3af">Unsubscribe from monthly summaries</a></p>
        </div>
      </div></body></html>
    `, uid).catch(e => console.error('[email health-score]', e.message));
  }
}

// ── Cron: daily bill reminders at 09:00 UTC ─────────────────
if (cron) {
  cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running daily bill reminder job…');
    try {
      let lastDoc = null;
      let sent = 0;
      const PAGE = 200;
      do {
        let q = db.collection('users').orderBy('__name__').limit(PAGE);
        if (lastDoc) q = q.startAfter(lastDoc);
        const page = await q.get();
        if (page.empty) break;
        lastDoc = page.docs[page.docs.length - 1];
        for (const userDoc of page.docs) {
          await _sendBillRemindersForUser(userDoc.id, userDoc.data()).catch(err =>
            console.error(`[cron/bills] uid:${userDoc.id}:`, err.message)
          );
          sent++;
        }
      } while (true);
      console.log(`[Cron] Bill reminders: checked ${sent} users`);
    } catch (err) {
      console.error('[Cron] Bill reminder job failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('[Boot] Cron: daily bill reminders scheduled (09:00 UTC)');
}

// ── Cron: weekly summary email every Sunday at 07:00 UTC ────
if (cron) {
  cron.schedule('0 7 * * 0', async () => {
    console.log('[Cron] Running weekly summary job…');
    try {
      let lastDoc = null;
      let sent = 0;
      const PAGE = 200;
      do {
        let q = db.collection('users').orderBy('__name__').limit(PAGE);
        if (lastDoc) q = q.startAfter(lastDoc);
        const page = await q.get();
        if (page.empty) break;
        lastDoc = page.docs[page.docs.length - 1];
        for (const userDoc of page.docs) {
          const data = userDoc.data();
          if (!data.plaid_linked || !data.email) continue;
          await _sendWeeklySummaryForUser(userDoc.id, data).catch(err =>
            console.error(`[cron/weekly] uid:${userDoc.id}:`, err.message)
          );
          sent++;
        }
      } while (true);
      console.log(`[Cron] Weekly summaries: processed ${sent} users`);
    } catch (err) {
      console.error('[Cron] Weekly summary job failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('[Boot] Cron: weekly summary scheduled (Sunday 07:00 UTC)');
}

// ── Cron: monthly summary on 1st of month at 08:00 UTC ──────
if (cron) {
  cron.schedule('0 8 1 * *', async () => {
    console.log('[Cron] Running monthly summary job…');
    try {
      let lastDoc = null;
      let sent = 0;
      const PAGE = 200;
      const now = new Date();
      const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const cutoffStr = prevMonth.toISOString().slice(0, 10); // first day of last month
      const monthLabel = prevMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

      do {
        let q = db.collection('users').orderBy('__name__').limit(PAGE);
        if (lastDoc) q = q.startAfter(lastDoc);
        const page = await q.get();
        if (page.empty) break;
        lastDoc = page.docs[page.docs.length - 1];
        for (const userDoc of page.docs) {
          const data = userDoc.data();
          if (!data.plaid_linked || !data.email) continue;
          if (data.notifications_enabled === false) continue;
          if (data.email_weekly_enabled === false) continue; // reuse weekly opt-out flag
          await _sendMonthlySummaryForUser(userDoc.id, data, cutoffStr, monthLabel).catch(err =>
            console.error(`[cron/monthly] uid:${userDoc.id}:`, err.message)
          );
          sent++;
        }
      } while (true);
      console.log(`[Cron] Monthly summaries: processed ${sent} users`);
    } catch (err) {
      console.error('[Cron] Monthly summary job failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('[Boot] Cron: monthly summary scheduled (1st of month 08:00 UTC)');
}

/* ─────────────────────────────────────────────────────────────
   PLAID WEBHOOK — real-time transaction updates
   ─────────────────────────────────────────────────────────────
   Plaid calls this endpoint when new transactions are available.
   We verify the JWT signature using Plaid's published public key,
   then trigger a background sync for the affected user.

   Setup (Railway env vars):
     PLAID_WEBHOOK_SECRET — optional extra shared-secret header
       (not required; JWT verification is the primary auth)

   In Plaid Dashboard → Webhooks, set URL to:
     https://getflowcheck.app/plaid/webhook
   ─────────────────────────────────────────────────────────────── */

// Cache Plaid JWK keys in memory (keyed by key_id).
// Keys rotate infrequently; 1-hour TTL is Plaid's recommendation.
const _plaidKeyCache = new Map(); // key_id → { jwk, expiresAt }
const _PLAID_KEY_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch and cache a Plaid webhook verification key.
 */
async function _getPlaidWebhookKey(keyId) {
  const cached = _plaidKeyCache.get(keyId);
  if (cached && Date.now() < cached.expiresAt) return cached.jwk;

  const { data } = await plaid.webhookVerificationKeyGet({ key_id: keyId });
  const jwk = data.key;
  _plaidKeyCache.set(keyId, { jwk, expiresAt: Date.now() + _PLAID_KEY_TTL_MS });
  return jwk;
}

/**
 * Decode a base64url string to a Buffer (no padding needed).
 */
function _b64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ── Cron: onboarding drip — daily 11:00 UTC ─────────────────
// Four timed emails keyed to how long ago the user signed up
// and what they've done. Each fires at most once per user.
if (cron) {
  cron.schedule('0 11 * * *', async () => {
    if (!_resendApiKey) return;
    console.log('[Cron] Running onboarding drip job…');
    try {
      let lastDoc = null; let sent = 0; const PAGE = 200;
      do {
        let q = db.collection('users').orderBy('__name__').limit(PAGE);
        if (lastDoc) q = q.startAfter(lastDoc);
        const page = await q.get();
        if (page.empty) break;
        lastDoc = page.docs[page.docs.length - 1];
        for (const userDoc of page.docs) {
          const d = userDoc.data();
          if (!d.email) continue;
          const drip = d.onboarding_drip || {};
          const createdAt = d.created_at?.toDate ? d.created_at.toDate() : (d.created_at ? new Date(d.created_at) : null);
          if (!createdAt) continue;
          const ageDays = (Date.now() - createdAt.getTime()) / 86400000;
          await _runOnboardingDrip(userDoc.id, d, drip, ageDays).catch(err =>
            console.error(`[cron/drip] uid:${userDoc.id}:`, err.message)
          );
          sent++;
        }
      } while (true);
      console.log(`[Cron] Onboarding drip: processed ${sent} users`);
    } catch (err) { console.error('[Cron] Onboarding drip failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('[Boot] Cron: onboarding drip scheduled (daily 11:00 UTC)');
}

async function _runOnboardingDrip(uid, d, drip, ageDays) {
  const email  = d.email;
  const name   = _htmlEscape((d.name || 'Friend').split(' ')[0]);
  const linked = !!d.plaid_linked;
  const updates = {};

  // ── Email 1: +24h, no bank connected ──────────────────────
  if (!drip.day1 && ageDays >= 1 && ageDays < 7 && !linked) {
    await _sendEmail(email, "Still getting started on FlowCheck? 🏦", `
      <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
        <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
          ${LOGO_IMG}
          <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 6px">Connect your bank, ${name}</h1>
          <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">It takes about 60 seconds</p>
        </div>
        <div style="padding:28px 32px">
          <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 20px">
            You signed up but haven't connected a bank yet. Without it, FlowCheck can't show you where your money is going — which is the whole point.
          </p>
          <div style="background:#f0fffe;border-left:3px solid #1ac4f0;border-radius:8px;padding:14px 18px;margin-bottom:24px">
            <p style="font-size:13px;color:#4b5563;margin:4px 0">✓ 256-bit encryption via Plaid (same as your bank's app)</p>
            <p style="font-size:13px;color:#4b5563;margin:4px 0">✓ Read-only — FlowCheck can never move your money</p>
            <p style="font-size:13px;color:#4b5563;margin:4px 0">✓ Disconnect any time in Settings</p>
          </div>
          <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
            Connect My Bank →
          </a>
        </div>
        <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
          <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'all', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
        </div>
      </div></body></html>
    `, uid);
    updates['onboarding_drip.day1'] = true;
  }

  // ── Email 2: +3 days, bank connected, no budget yet ────────
  if (!drip.day3 && ageDays >= 3 && ageDays < 14 && linked) {
    const budgetSnap = await db.collection('users').doc(uid).collection('budgets').limit(1).get();
    if (budgetSnap.empty) {
      await _sendEmail(email, `Set your first budget — it takes 30 seconds ⚡`, `
        <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
            ${LOGO_IMG}
            <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 6px">Your bank is connected, ${name}</h1>
            <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">One more step to get the most out of FlowCheck</p>
          </div>
          <div style="padding:28px 32px">
            <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 20px">
              You've connected your bank — great start. The next step is setting a budget. People who set a budget in FlowCheck spend an average of 14% less within the first month.
            </p>
            <div style="background:#f0fffe;border-left:3px solid #1ac4f0;border-radius:8px;padding:14px 18px;margin-bottom:24px">
              <p style="font-size:13px;font-weight:600;color:#0a1520;margin:0 0 8px">How to set your first budget:</p>
              <p style="font-size:13px;color:#4b5563;margin:4px 0">1. Open FlowCheck → tap Insights tab</p>
              <p style="font-size:13px;color:#4b5563;margin:4px 0">2. Tap "Set Budget" next to any category</p>
              <p style="font-size:13px;color:#4b5563;margin:4px 0">3. Enter your monthly limit — done</p>
            </div>
            <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
              Set My First Budget →
            </a>
          </div>
          <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
            <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'all', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
          </div>
        </div></body></html>
      `, uid);
      updates['onboarding_drip.day3'] = true;
    }
  }

  // ── Email 3: +7 days, bank connected — personalized insight ─
  if (!drip.day7 && ageDays >= 7 && ageDays < 21 && linked) {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    let txnSnap;
    try {
      txnSnap = await db.collection('users').doc(uid).collection('transactions')
        .where('date', '>=', cutoffStr).where('pending', '==', false).get();
    } catch (_) { txnSnap = { empty: true }; }

    if (!txnSnap.empty) {
      let totalSpent = 0;
      const cats = {};
      txnSnap.docs.forEach(d => {
        const t = d.data();
        if (!t.isCredit && !_isXferTxn(t)) {
          totalSpent += t.amount;
          const cat = (t.category && t.category[0]) || 'Other';
          cats[cat] = (cats[cat] || 0) + t.amount;
        }
      });
      const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
      const topCatLabel = topCat
        ? topCat[0].charAt(0) + topCat[0].slice(1).toLowerCase().replace(/_/g, ' ')
        : null;

      await _sendEmail(email, `Here's what FlowCheck found in your first week 👀`, `
        <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
            ${LOGO_IMG}
            <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 6px">Your first week on FlowCheck</h1>
            <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">Here's what we found, ${name}</p>
          </div>
          <div style="padding:28px 32px">
            <div style="background:#f0fffe;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
              <div style="font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Spent This Week</div>
              <div style="font-size:32px;font-weight:800;color:#0a1520">${_fmt(totalSpent)}</div>
              ${topCatLabel ? `<div style="font-size:13px;color:#6b7280;margin-top:4px">Mostly on <strong style="color:#0a1520">${_htmlEscape(topCatLabel)}</strong></div>` : ''}
            </div>
            <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 20px">
              That's your money in motion. Open FlowCheck to see the full breakdown — every transaction categorized, your Financial Health Score, and where you could be saving.
            </p>
            <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
              See My Full Breakdown →
            </a>
          </div>
          <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
            <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'all', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
          </div>
        </div></body></html>
      `, uid);
      updates['onboarding_drip.day7'] = true;
    }
  }

  // ── Email 4: +14 days, bank connected, no bills added ───────
  if (!drip.day14 && ageDays >= 14 && ageDays < 30 && linked) {
    const billsSnap = await db.collection('users').doc(uid).collection('bills').limit(1).get();
    if (billsSnap.empty) {
      await _sendEmail(email, `Are you tracking your recurring bills? 📋`, `
        <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
            ${LOGO_IMG}
            <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 6px">Never miss a bill, ${name}</h1>
            <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">One late payment can cost you in fees and credit score</p>
          </div>
          <div style="padding:28px 32px">
            <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 20px">
              You haven't added any bills to FlowCheck yet. Add your recurring payments — rent, Netflix, phone, utilities — and we'll remind you 2 days before each one is due.
            </p>
            <div style="background:#f0fffe;border-left:3px solid #1ac4f0;border-radius:8px;padding:14px 18px;margin-bottom:24px">
              <p style="font-size:13px;color:#4b5563;margin:4px 0">✓ Push notification 2 days before due</p>
              <p style="font-size:13px;color:#4b5563;margin:4px 0">✓ Email reminder if you miss the push</p>
              <p style="font-size:13px;color:#4b5563;margin:4px 0">✓ Overdue alerts so nothing slips through</p>
            </div>
            <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
              Add My First Bill →
            </a>
          </div>
          <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
            <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'all', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
          </div>
        </div></body></html>
      `, uid);
      updates['onboarding_drip.day14'] = true;
    }
  }

  // Persist which drip emails fired (merge so other fields stay intact)
  if (Object.keys(updates).length > 0) {
    await db.collection('users').doc(uid).update(updates).catch(() => {});
  }
}

// ── Cron: re-engagement email — Wednesday 10:00 UTC ─────────
// Targets users who haven't opened the app in 14–30 days.
if (cron) {
  cron.schedule('0 10 * * 3', async () => {
    if (!_resendApiKey) return;
    console.log('[Cron] Running re-engagement job…');
    try {
      const cutoff14  = new Date(Date.now() - 14 * 86400000);
      const cutoff30  = new Date(Date.now() - 30 * 86400000);
      let lastDoc = null; let sent = 0; const PAGE = 200;
      do {
        let q = db.collection('users').orderBy('__name__').limit(PAGE);
        if (lastDoc) q = q.startAfter(lastDoc);
        const page = await q.get();
        if (page.empty) break;
        lastDoc = page.docs[page.docs.length - 1];
        for (const userDoc of page.docs) {
          const d = userDoc.data();
          if (!d.email || !d.plaid_linked) continue;
          if (d.notifications_enabled === false) continue;
          const lastSeen = d.last_seen?.toDate ? d.last_seen.toDate() : (d.last_seen ? new Date(d.last_seen) : null);
          if (!lastSeen || lastSeen > cutoff14 || lastSeen < cutoff30) continue; // only 14–30 days inactive
          const name = _htmlEscape((d.name || 'Friend').split(' ')[0]);
          await _sendEmail(d.email, `${d.name?.split(' ')[0] || 'Hey'} — your finances are waiting 👀`, `
            <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
            <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
              <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
                ${LOGO_IMG}
                <h1 style="color:#fff;font-size:22px;font-weight:700;margin:0 0 6px">You haven't checked in lately, ${name}</h1>
                <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">Your money keeps moving even when you don't</p>
              </div>
              <div style="padding:28px 32px">
                <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 20px">
                  It's been a couple of weeks. New transactions have come in, your balances may have changed, and there might be bills coming up. A quick check-in keeps you on top of it all.
                </p>
                <div style="background:#f0fffe;border-left:3px solid #1ac4f0;border-radius:8px;padding:14px 18px;margin-bottom:24px">
                  <p style="font-size:13px;color:#4b5563;margin:4px 0">→ See what you've spent since you were last here</p>
                  <p style="font-size:13px;color:#4b5563;margin:4px 0">→ Check for any bills coming due</p>
                  <p style="font-size:13px;color:#4b5563;margin:4px 0">→ Review your financial health score</p>
                </div>
                <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
                  Check In Now →
                </a>
              </div>
              <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
                <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(userDoc.id, 'all', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
              </div>
            </div></body></html>
          `, userDoc.id).catch(() => {});
          sent++;
        }
      } while (true);
      console.log(`[Cron] Re-engagement: sent ${sent} emails`);
    } catch (err) { console.error('[Cron] Re-engagement failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('[Boot] Cron: re-engagement scheduled (Wednesday 10:00 UTC)');
}

// ── Cron: year-in-review on Jan 1 at 09:00 UTC ──────────────
if (cron) {
  cron.schedule('0 9 1 1 *', async () => {
    if (!_resendApiKey) return;
    console.log('[Cron] Running year-in-review job…');
    const year = new Date().getFullYear() - 1;
    const yearStart = `${year}-01-01`;
    const yearEnd   = `${year}-12-31`;
    try {
      let lastDoc = null; let sent = 0; const PAGE = 200;
      do {
        let q = db.collection('users').orderBy('__name__').limit(PAGE);
        if (lastDoc) q = q.startAfter(lastDoc);
        const page = await q.get();
        if (page.empty) break;
        lastDoc = page.docs[page.docs.length - 1];
        for (const userDoc of page.docs) {
          const d = userDoc.data();
          if (!d.email || !d.plaid_linked) continue;
          if (d.notifications_enabled === false) continue;
          await _sendYearInReviewForUser(userDoc.id, d, year, yearStart, yearEnd).catch(err =>
            console.error(`[cron/year] uid:${userDoc.id}:`, err.message)
          );
          sent++;
        }
      } while (true);
      console.log(`[Cron] Year-in-review: processed ${sent} users`);
    } catch (err) { console.error('[Cron] Year-in-review failed:', err.message); }
  }, { timezone: 'UTC' });
  console.log('[Boot] Cron: year-in-review scheduled (Jan 1 09:00 UTC)');
}

async function _sendYearInReviewForUser(uid, userData, year, yearStart, yearEnd) {
  const email = userData.email;
  if (!email || !_resendApiKey) return;
  const name = _htmlEscape((userData.name || 'Friend').split(' ')[0]);

  let txnSnap;
  try {
    txnSnap = await db.collection('users').doc(uid)
      .collection('transactions')
      .where('date', '>=', yearStart)
      .where('date', '<=', yearEnd)
      .where('pending', '==', false)
      .get();
  } catch (_) { return; }
  if (txnSnap.empty) return;

  let totalSpent = 0, totalIncome = 0, txnCount = 0;
  const categories = {};
  txnSnap.docs.forEach(d => {
    const t = d.data();
    if (t.isCredit) { totalIncome += t.amount; }
    else if (!_isXferTxn(t)) {
      totalSpent += t.amount; txnCount++;
      const cat = (t.category && t.category[0]) || 'Other';
      categories[cat] = (categories[cat] || 0) + t.amount;
    }
  });

  const topCats = Object.entries(categories).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([cat, amt]) =>
      `<tr><td style="padding:7px 0;color:#374151;font-size:14px">${_htmlEscape(cat)}</td>
       <td style="padding:7px 0;text-align:right;font-weight:600;color:#111827;font-size:14px">${_fmt(amt)}</td></tr>`
    ).join('');

  const saved = totalIncome - totalSpent;
  const savedColor = saved >= 0 ? '#059669' : '#dc2626';

  await _sendEmail(email, `Your ${year} Year in Review 🎉`, `
    <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
      <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:40px 32px;text-align:center">
        ${LOGO_IMG}
        <h1 style="color:#fff;font-size:26px;font-weight:700;margin:0 0 6px">${year} Year in Review</h1>
        <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">Here's what your financial year looked like, ${name}</p>
      </div>
      <div style="padding:28px 32px">
        <div style="display:flex;gap:12px;margin-bottom:20px">
          <div style="flex:1;background:#f0fffe;border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Total Spent</div>
            <div style="font-size:20px;font-weight:800;color:#0a1520">${_fmt(totalSpent)}</div>
          </div>
          <div style="flex:1;background:#f0fff4;border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Total Income</div>
            <div style="font-size:20px;font-weight:800;color:#0a1520">${_fmt(totalIncome)}</div>
          </div>
        </div>
        <div style="background:#f9fafb;border-radius:10px;padding:14px 16px;text-align:center;margin-bottom:20px">
          <span style="font-size:15px;font-weight:700;color:${savedColor}">${saved >= 0 ? 'Saved' : 'Overspent'} ${_fmt(Math.abs(saved))}</span>
          <span style="font-size:13px;color:#9ca3af"> across ${txnCount.toLocaleString()} transactions</span>
        </div>
        ${topCats ? `
        <div style="margin-bottom:24px">
          <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px">Where Your Money Went</div>
          <table style="width:100%;border-collapse:collapse">${topCats}</table>
        </div>` : ''}
        <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
          Start ${year + 1} Strong →
        </a>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
        <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'weekly', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
      </div>
    </div></body></html>
  `, uid);
}

/* ─────────────────────────────────────────────────────────────
   SUBSCRIPTION DETECTION (server-side port of client _detectSubscriptions)
   ───────────────────────────────────────────────────────────── */

const _SUB_SRV_EXCLUDE_RE = /\b(transfer|refund|payment|wire|deposit|withdrawal|atm|cash|venmo|zelle|cashapp|paypal|apple pay|google pay|paycheck|salary|direct dep|rent|mortgage|hoa|loan|insurance premium|amazon prime\*|prime\*delivery|grocery|gas|uber eats|doordash|grubhub|postmates|instacart|lyft|uber(?! eats))\b/i;
const _SUB_SRV_KNOWN_RE   = /\b(netflix|hulu|disney\+|hbomax|hbo max|max\b|peacock|paramount\+|apple tv|spotify|tidal|amazon music|youtube premium|google one|icloud|dropbox|box\.com|adobe|figma|canva|github|heroku|aws|azure|gcp|google cloud|nordvpn|expressvpn|surfshark|duolingo|headspace|calm|babbel|masterclass|skillshare|linkedin premium|audible|kindle unlimited|new york times|nytimes|wsj|washington post|the atlantic|medium|substack|patreon|onlyfans|crunchyroll|funimation|vrv|nintendo online|xbox game pass|playstation plus|ps plus|ea play|geforce now|twitch|discord nitro|slack|notion|monday\.com|asana|trello|zoom|lastpass|1password|dashlane|lifelock|identityguard|simplisafe|ring|vivint|planet fitness|orangetheory|equinox|peloton|beachbody|apple one|apple music|apple arcade|apple fitness|apple news\+)\b/i;
const _SUB_SRV_GOOD_CATS  = new Set(['subscription', 'subscriptions', 'streaming', 'software', 'entertainment', 'music', 'video games', 'cloud services', 'saas', 'education']);

function _normSubKey(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
}

/**
 * Detect subscription renewals and price changes from the last 90 days of
 * transactions. Sends email/notification only for NEW subs or price changes.
 * Renewal state stored in users/{uid}.detected_subs to prevent re-alerting.
 */
async function _detectAndEmailSubscriptions(uid, userRef, userData, fcmToken) {
  const ninetyAgo = new Date(); ninetyAgo.setDate(ninetyAgo.getDate() - 90);
  const cutoff = ninetyAgo.toISOString().slice(0, 10);

  const snap = await userRef.collection('transactions')
    .where('date', '>=', cutoff)
    .where('pending', '==', false)
    .where('isCredit', '==', false)
    .get();

  if (snap.empty) return;

  // Group by normalized merchant name
  const map = {};
  snap.docs.forEach(d => {
    const t = d.data();
    if (!t.date || !t.name) return;
    if (_SUB_SRV_EXCLUDE_RE.test(t.name)) return;

    const rawCat  = (t.category && t.category[0]) || '';
    const normCat = rawCat.toLowerCase();
    const hardExclude = new Set(['transfer', 'loan', 'bank fees', 'grocery', 'groceries',
      'gas stations', 'restaurants', 'coffee shop', 'auto and transport', 'healthcare', 'medical']);
    if (hardExclude.has(normCat) || normCat.includes('transfer')) return;

    const isKnown = _SUB_SRV_KNOWN_RE.test(t.name) || _SUB_SRV_KNOWN_RE.test(t.merchant_name || '');
    const isSubCat = _SUB_SRV_GOOD_CATS.has(normCat);
    if (!isKnown && !isSubCat) return;

    const key = _normSubKey(t.merchant_name || t.name);
    if (!key) return;
    if (!map[key]) map[key] = { name: t.merchant_name || t.name, entries: [] };
    if (t.merchant_name) map[key].name = t.merchant_name;
    map[key].entries.push({ amount: t.amount, ts: new Date(t.date).getTime(), date: t.date });
  });

  const prevSubs = userData.detected_subs || {};
  const updates  = {};

  for (const [key, data] of Object.entries(map)) {
    if (data.entries.length < 2) continue;
    data.entries.sort((a, b) => a.ts - b.ts);

    const gaps = [];
    for (let i = 1; i < data.entries.length; i++)
      gaps.push((data.entries[i].ts - data.entries[i - 1].ts) / 86400000);
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

    const isMonthly = avgGap >= 21 && avgGap <= 40;
    const isWeekly  = avgGap >= 5  && avgGap <= 9;
    const isAnnual  = avgGap >= 330 && avgGap <= 370;
    const freq = isMonthly ? 'monthly' : isWeekly ? 'weekly' : isAnnual ? 'annual' : null;
    if (!freq) continue;

    const sorted = [...data.entries].sort((a, b) => a.amount - b.amount);
    const mid    = Math.floor(sorted.length / 2);
    const medAmt = sorted.length % 2 === 0
      ? (sorted[mid - 1].amount + sorted[mid].amount) / 2
      : sorted[mid].amount;
    if (medAmt < 0.99 || medAmt > 500) continue;

    const stdDev = Math.sqrt(data.entries.reduce((s, e) => s + Math.pow(e.amount - medAmt, 2), 0) / data.entries.length);
    if (stdDev / medAmt > 0.25) continue;

    const displayName = _htmlEscape(data.name);
    const prior       = prevSubs[key];

    if (!prior) {
      // New subscription detected
      const title = `🔄 New subscription detected: ${data.name}`;
      const body  = `${data.name} — ${_fmt(medAmt)}/${freq}`;
      await _saveNotification(uid, { title, body, type: 'subscription_renewal', data: { merchant: data.name, amount: String(medAmt), freq } });
      if (fcmToken) _sendFCM(uid, fcmToken, { title, body, type: 'subscription_renewal', channelId: 'flowcheck_default' }).catch(() => {});
      if (userData.email && userData.email_alerts_enabled !== false) {
        _sendEmail(userData.email, `🔄 New subscription: ${data.name} — ${_fmt(medAmt)}/${freq}`, `
          <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
          <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
            <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:32px;text-align:center">
              ${LOGO_IMG}
              <div style="font-size:32px;margin-bottom:8px">🔄</div>
              <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 4px">Subscription Spotted</h1>
              <p style="color:rgba(255,255,255,0.55);font-size:14px;margin:0">FlowCheck found a recurring charge on your account</p>
            </div>
            <div style="padding:28px 32px">
              <div style="background:#f0fffe;border-radius:12px;padding:18px 20px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center">
                <div>
                  <div style="font-size:16px;font-weight:700;color:#0a1520">${displayName}</div>
                  <div style="font-size:13px;color:#6b7280;margin-top:2px">${freq.charAt(0).toUpperCase() + freq.slice(1)} charge</div>
                </div>
                <div style="font-size:22px;font-weight:800;color:#1ac4f0">${_fmt(medAmt)}</div>
              </div>
              <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 20px">We detected this as a recurring ${freq} charge. Open FlowCheck to add it as a tracked bill or mark it as expected.</p>
              <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">View in FlowCheck →</a>
            </div>
            <div style="padding:14px 32px;border-top:1px solid #f3f4f6;text-align:center">
              <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'alerts', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe from alerts</a></p>
            </div>
          </div></body></html>`, uid).catch(e => console.error('[email sub-new]', e.message));
      }
      updates[key] = { amount: medAmt, freq, first_detected: new Date().toISOString().slice(0, 10) };
    } else if (Math.abs(medAmt - prior.amount) / prior.amount > 0.05) {
      // Price change detected (> 5%)
      const delta     = medAmt - prior.amount;
      const sign      = delta > 0 ? '+' : '';
      const changeDir = delta > 0 ? 'increased' : 'decreased';
      const title = `💡 Price change: ${data.name}`;
      const body  = `${data.name} ${changeDir} from ${_fmt(prior.amount)} → ${_fmt(medAmt)}/${freq}`;
      await _saveNotification(uid, { title, body, type: 'subscription_price_change', data: { merchant: data.name, old_amount: String(prior.amount), new_amount: String(medAmt) } });
      if (fcmToken) _sendFCM(uid, fcmToken, { title, body, type: 'subscription_price_change', channelId: 'flowcheck_alerts' }).catch(() => {});
      if (userData.email && userData.email_alerts_enabled !== false) {
        _sendEmail(userData.email, `💡 ${data.name} price ${delta > 0 ? 'increased' : 'decreased'}: ${_fmt(prior.amount)} → ${_fmt(medAmt)}`, `
          <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
          <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
            <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:32px;text-align:center">
              ${LOGO_IMG}
              <div style="font-size:32px;margin-bottom:8px">${delta > 0 ? '📈' : '📉'}</div>
              <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 4px">Subscription Price Change</h1>
              <p style="color:rgba(255,255,255,0.55);font-size:14px;margin:0">${displayName} ${changeDir} its price</p>
            </div>
            <div style="padding:28px 32px">
              <div style="background:#f9fafb;border-radius:12px;padding:18px 20px;margin-bottom:20px">
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="font-size:13px;color:#6b7280">Previous</span>
                  <span style="font-size:15px;font-weight:600;color:#374151;text-decoration:line-through">${_fmt(prior.amount)}/${freq}</span>
                </div>
                <div style="display:flex;justify-content:space-between">
                  <span style="font-size:13px;color:#6b7280">New price</span>
                  <span style="font-size:18px;font-weight:800;color:${delta > 0 ? '#dc2626' : '#059669'}">${_fmt(medAmt)}/${freq} (${sign}${_fmt(Math.abs(delta))})</span>
                </div>
              </div>
              <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 20px">
                ${delta > 0 ? 'Your subscription cost went up. If this doesn\'t look right, check your account with the provider.' : 'Your subscription cost went down — no action needed.'}
              </p>
              <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">View in FlowCheck →</a>
            </div>
            <div style="padding:14px 32px;border-top:1px solid #f3f4f6;text-align:center">
              <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'alerts', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe from alerts</a></p>
            </div>
          </div></body></html>`, uid).catch(e => console.error('[email sub-price]', e.message));
      }
      updates[key] = { ...prior, amount: medAmt };
    }
  }

  if (Object.keys(updates).length > 0) {
    const merged = { ...prevSubs, ...updates };
    await userRef.update({ detected_subs: merged }).catch(() => {});
  }
}

/**
 * Compute a simple 0–100 financial health score from monthly data.
 * Used by the monthly cron to detect significant score changes.
 */
function _computeSimpleHealthScore(income, spent, netWorth, streak) {
  const savingsRate  = income > 0 ? Math.max(0, Math.min(1, (income - spent) / income)) : 0;
  const savingsScore = Math.round(savingsRate * 40);                                    // 0–40
  const nwScore      = netWorth > 10000 ? 30 : netWorth > 0 ? 20 : netWorth > -5000 ? 10 : 0; // 0–30
  const incomeScore  = income > 0 ? 20 : 10;                                            // 10–20
  const streakScore  = Math.min(10, Math.round((streak || 0) / 30 * 10));               // 0–10
  return Math.min(100, savingsScore + nwScore + incomeScore + streakScore);
}

/**
 * Verify a Plaid webhook JWT using Node 18 native crypto.subtle (ES256).
 * Returns the parsed payload on success, throws on failure.
 *
 * Security properties:
 *  - Signature verified against Plaid's published ECDSA P-256 public key
 *  - `iat` claim checked — rejects webhooks older than 5 minutes (replay protection)
 *  - `alg` must be ES256
 */
async function _verifyPlaidJwt(token, rawBodyBuf) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const [headerB64, payloadB64, sigB64] = parts;

  // Decode header to get key_id and algorithm
  const header = JSON.parse(_b64url(headerB64).toString('utf8'));
  if (header.alg !== 'ES256') throw new Error(`Unsupported JWT alg: ${header.alg}`);
  if (!header.kid) throw new Error('JWT missing kid');

  // Fetch Plaid's public key for this key_id
  const jwk = await _getPlaidWebhookKey(header.kid);

  // Import the JWK as a CryptoKey (available in Node 18+ without webcrypto import)
  const { subtle } = require('crypto');
  const publicKey = await subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );

  // Signed content = header.payload (ASCII bytes)
  const signedContent = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
  const signature     = _b64url(sigB64);

  const valid = await subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    signedContent
  );
  if (!valid) throw new Error('JWT signature invalid');

  const payload = JSON.parse(_b64url(payloadB64).toString('utf8'));

  // Replay protection: reject webhooks older than 5 minutes
  const ageSeconds = Math.floor(Date.now() / 1000) - (payload.iat || 0);
  if (ageSeconds > 300) throw new Error(`JWT too old: ${ageSeconds}s`);

  // The payload's `request_body_sha256` must match SHA-256 of the raw request body
  if (rawBodyBuf && payload.request_body_sha256) {
    const { createHash } = require('crypto');
    const actualHash = createHash('sha256').update(rawBodyBuf).digest('hex');
    if (actualHash !== payload.request_body_sha256) {
      throw new Error('Body hash mismatch — possible tampering');
    }
  }

  return payload;
}

/**
 * Trigger a background sync for a specific Plaid item_id.
 * Finds the user who owns this item, then re-runs account + transaction sync.
 * Errors are logged but never surface to the caller (webhook must always 200).
 */
async function _webhookSyncItem(itemId, retryCount = 0) {
  try {
    // Find the user who owns this item_id
    const itemSnap = await db.collectionGroup('plaid_items')
      .where('item_id', '==', itemId)
      .limit(1)
      .get();

    if (itemSnap.empty) {
      console.warn(`[webhook] item_id ${itemId} not found in Firestore — ignoring`);
      return;
    }

    const itemDoc  = itemSnap.docs[0];
    const userRef  = itemDoc.ref.parent.parent; // users/{uid}
    const uid      = userRef.id;
    const itemData = itemDoc.data();
    const { access_token } = itemData;

    if (!access_token) {
      console.warn(`[webhook] item ${itemId} has no access_token`);
      return;
    }

    const TS = admin.firestore.FieldValue.serverTimestamp;

    // ── Accounts (always fresh — small write, critical for balance accuracy) ──
    const { data: acctData } = await plaid.accountsGet({ access_token });
    const accounts = acctData.accounts.map(a => ({
      id:                a.account_id,
      name:              a.name,
      official_name:     a.official_name  || null,
      type:              a.type,
      subtype:           a.subtype        || null,
      balance_current:   a.balances.current   ?? 0,
      balance_limit:     a.balances.limit     ?? null,
      balance_available: a.balances.available ?? null,
      currency:          a.balances.iso_currency_code || 'USD',
      mask:              a.mask           || null,
      item_id:           itemId,
      institution_name:  itemData.institution || '',
    }));

    let batch = db.batch();
    accounts.forEach(a => {
      batch.set(userRef.collection('accounts').doc(a.id), { ...a, updated_at: TS() }, { merge: true });
    });
    await batch.commit();

    // ── Transactions — cursor-based delta sync ──────────────────────
    let cursor = itemData.plaid_cursor || undefined;
    let added = [], modified = [], removed = [];
    let hasMore = true;

    while (hasMore) {
      const reqBody = { access_token, count: 500 };
      if (cursor) reqBody.cursor = cursor;
      const { data } = await plaid.transactionsSync(reqBody);
      added    = added.concat(data.added);
      modified = modified.concat(data.modified);
      removed  = removed.concat(data.removed);
      hasMore  = data.has_more;
      cursor   = data.next_cursor;
    }

    // Persist new cursor
    await itemDoc.ref.update({ plaid_cursor: cursor });

    /* Write added + modified */
    const upserts = [...added, ...modified];
    for (let i = 0; i < upserts.length; i += 400) {
      batch = db.batch();
      upserts.slice(i, i + 400).forEach(t => {
        batch.set(userRef.collection('transactions').doc(t.transaction_id), {
          id:              t.transaction_id,
          account_id:      t.account_id,
          name:            t.name,
          amount:          Math.abs(t.amount),
          isCredit:        t.amount < 0,
          date:            t.date,
          category:        t.personal_finance_category?.primary
                             ? [t.personal_finance_category.primary]
                             : (t.category || []),
          pending:         t.pending,
          merchant_name:   t.merchant_name    || null,
          logo_url:        t.logo_url         || null,
          payment_channel: t.payment_channel  || null,
          updated_at:      TS(),
        }, { merge: true });
      });
      await batch.commit();
    }

    /* Delete removed */
    for (let i = 0; i < removed.length; i += 400) {
      batch = db.batch();
      removed.slice(i, i + 400).forEach(r => {
        batch.delete(userRef.collection('transactions').doc(r.transaction_id));
      });
      await batch.commit();
    }

    await userRef.update({ last_synced: TS() });

    // ── Post-sync intelligence: payday detection + budget alerts ───────
    // Only worth running when there are new transactions to analyse.
    if (added.length > 0) {
      const userSnap = await userRef.get();
      const userData = userSnap.exists ? userSnap.data() : {};
      const fcmToken = userData.fcm_token || null;
      const notifOn  = userData.notifications_enabled !== false;

      if (notifOn) {

        // ── 1. Payday / Early-pay detection ──────────────────────────
        // Plaid encodes credits (money IN) as negative amounts.
        const INCOME_PRIMARY  = new Set(['INCOME', 'TRANSFER_IN']);
        const INCOME_DETAILED = new Set([
          'INCOME_WAGES', 'INCOME_OTHER_INCOME', 'INCOME_TAX_REFUND',
          'TRANSFER_IN_PAYROLL_ACCOUNT_DEPOSIT', 'TRANSFER_IN_ACCOUNT_TRANSFER',
        ]);
        const PAYDAY_RE     = /\b(payroll|paycheck|direct dep|direct deposit|ach dep|salary|wages|employer|adp|gusto|paychex|intuit payroll|zenpayroll|rippling|bamboohr)\b/i;
        const EARLY_PAY_RE  = /\b(earnin|dave\b|brigit|chime early|axos early|current early|one pay|albert|varo|go2bank early|jelli|even\b|floatme|klover)\b/i;
        const MIN_PAY       = 200; // ignore micro-deposits < $200

        for (const t of added) {
          if (t.amount >= 0) continue;            // positive = expense in Plaid
          const credit = Math.abs(t.amount);
          if (credit < MIN_PAY) continue;

          const catPrimary  = t.personal_finance_category?.primary  || '';
          const catDetailed = t.personal_finance_category?.detailed || '';
          const txnName     = t.name            || '';
          const merch       = t.merchant_name   || '';

          const isIncome = INCOME_PRIMARY.has(catPrimary) ||
                           INCOME_DETAILED.has(catDetailed) ||
                           PAYDAY_RE.test(txnName) ||
                           PAYDAY_RE.test(merch);
          if (!isIncome) continue;

          const isEarlyPay = EARLY_PAY_RE.test(txnName) || EARLY_PAY_RE.test(merch);
          const title = isEarlyPay ? '💸 Early Pay Arrived!' : '🎉 Payday!';
          const body  = `${_fmt(credit)} just landed in your account.`;

          await _saveNotification(uid, { title, body, type: isEarlyPay ? 'early_pay' : 'payday', data: { amount: String(credit), account_id: t.account_id || '' } });
          if (fcmToken) _sendFCM(uid, fcmToken, {
            title, body,
            type:      isEarlyPay ? 'early_pay' : 'payday',
            data:      { amount: String(credit), account_id: t.account_id || '' },
            channelId: 'flowcheck_default',
          }).catch(err => console.error('[fcm payday]', err.message));

          // Payday email — amount landed + running total balance
          if (userData.email && userData.email_alerts_enabled !== false) {
            const totalBal = accounts
              .filter(a => a.type === 'depository')
              .reduce((s, a) => s + (a.balance_available ?? a.balance_current ?? 0), 0);
            _sendEmail(userData.email,
              isEarlyPay ? `💸 Early pay: ${_fmt(credit)} just landed` : `🎉 Payday: ${_fmt(credit)} just hit your account`,
              `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
              <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
                  ${LOGO_IMG}
                  <div style="font-size:40px;font-weight:900;color:#1ac4f0;letter-spacing:-0.03em;margin-bottom:6px">${_fmt(credit)}</div>
                  <p style="color:rgba(255,255,255,0.65);font-size:15px;margin:0">${isEarlyPay ? '⚡ Early pay landed' : '🎉 Payday has arrived'}</p>
                </div>
                <div style="padding:28px 32px">
                  <div style="background:#f0fffe;border-radius:12px;padding:16px 20px;margin-bottom:20px">
                    <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Total account balance</div>
                    <div style="font-size:26px;font-weight:800;color:#0a1520">${_fmt(totalBal)}</div>
                  </div>
                  <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">View My Accounts →</a>
                </div>
                <div style="padding:14px 32px;border-top:1px solid #f3f4f6;text-align:center">
                  <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'alerts', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe from alerts</a></p>
                </div>
              </div></body></html>`, uid).catch(e => console.error('[email payday]', e.message));
          }

          break; // one payday alert per sync batch is enough
        }

        // ── 1b. Savings milestone check ───────────────────────────────
        // Runs after every sync with new transactions. Calculates net worth
        // from live account balances and fires once per crossed threshold.
        {
          const NW_MILESTONES = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000];
          const netWorth = accounts.reduce((s, a) => {
            const bal = a.balance_current ?? 0;
            return a.type === 'credit' || a.type === 'loan' ? s - bal : s + bal;
          }, 0);
          const lastMilestone = userData.last_nw_milestone || 0;
          const crossed = NW_MILESTONES.filter(m => m > lastMilestone && netWorth >= m);
          if (crossed.length > 0) {
            const milestone = crossed[crossed.length - 1];
            await userRef.update({ last_nw_milestone: milestone });
            const mTitle = `🏆 Net worth milestone: ${_fmt(milestone)}`;
            const mBody  = `You just crossed ${_fmt(milestone)} in net worth. Keep it up!`;
            await _saveNotification(uid, { title: mTitle, body: mBody, type: 'savings_milestone', data: { milestone: String(milestone) } });
            if (fcmToken) _sendFCM(uid, fcmToken, { title: mTitle, body: mBody, type: 'savings_milestone', channelId: 'flowcheck_default' }).catch(() => {});
            if (userData.email && userData.email_alerts_enabled !== false) {
              _sendEmail(userData.email, mTitle, `
              <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
              <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
                  ${LOGO_IMG}
                  <div style="font-size:48px;margin-bottom:8px">🏆</div>
                  <div style="font-size:36px;font-weight:900;color:#1ac4f0;letter-spacing:-0.03em">${_fmt(milestone)}</div>
                  <p style="color:rgba(255,255,255,0.65);font-size:15px;margin:8px 0 0">Net worth milestone reached</p>
                </div>
                <div style="padding:28px 32px">
                  <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 20px">You just crossed <strong>${_fmt(milestone)}</strong> in net worth. That's a real milestone — keep building.</p>
                  <div style="background:#f0fffe;border-radius:12px;padding:16px 20px;margin-bottom:20px">
                    <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">Current net worth</div>
                    <div style="font-size:26px;font-weight:800;color:#059669">${_fmt(netWorth)}</div>
                  </div>
                  <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">View Net Worth →</a>
                </div>
                <div style="padding:14px 32px;border-top:1px solid #f3f4f6;text-align:center">
                  <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'alerts', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
                </div>
              </div></body></html>`, uid).catch(e => console.error('[email milestone]', e.message));
            }
          }
        }

        // ── 1c. Large transaction alert ──────────────────────────────
        const LARGE_TXN_THRESHOLD = 100;
        const LARGE_SKIP_RE = /\b(mortgage|rent|loan payment|insurance|transfer|payroll)\b/i;
        for (const t of added) {
          if (t.amount <= 0) continue;
          if (t.amount < LARGE_TXN_THRESHOLD) continue;
          if (LARGE_SKIP_RE.test(t.name || '')) continue;
          const merchant  = t.merchant_name || t.name || 'A merchant';
          const safeMerch = _htmlEscape(merchant);
          const title = `💳 Large Purchase: ${_fmt(t.amount)}`;
          const body  = `${merchant} charged ${_fmt(t.amount)} to your account.`;
          await _saveNotification(uid, { title, body, type: 'large_txn', data: { amount: String(t.amount), merchant } });
          if (fcmToken) _sendFCM(uid, fcmToken, { title, body, type: 'large_txn', data: { amount: String(t.amount) }, channelId: 'flowcheck_alerts' }).catch(() => {});
          // Email for large transactions
          if (userData.email && userData.email_alerts_enabled !== false) {
            _sendEmail(userData.email, `💳 Large purchase detected: ${_fmt(t.amount)}`, `
              <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
              <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08)">
                <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:28px;text-align:center">
                  ${LOGO_IMG}
                  <h2 style="color:#fff;font-size:20px;font-weight:700;margin:0">${_fmt(t.amount)} purchase</h2>
                  <p style="color:rgba(255,255,255,0.6);font-size:13px;margin:6px 0 0">${safeMerch}</p>
                </div>
                <div style="padding:24px">
                  <p style="font-size:14px;color:#374151;margin:0 0 20px">A charge of <strong>${_fmt(t.amount)}</strong> from <strong>${safeMerch}</strong> just appeared on your account. If you don't recognize this, check your card immediately.</p>
                  <a href="${BACKEND_URL}/open" style="display:inline-block;background:#1ac4f0;color:#0a1520;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">Review Transaction →</a>
                </div>
                <div style="padding:14px 24px;border-top:1px solid #f3f4f6">
                  <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'alerts', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe from alerts</a></p>
                </div>
              </div></body></html>
            `, uid).catch(e => console.error('[email large-txn]', e.message));
          }
          break;
        }

        // ── 1c. Low balance warning ───────────────────────────────────
        const LOW_BALANCE_THRESHOLD = 200;
        for (const acct of accounts) {
          // Use balance_available (mapped field) not acct.balances (unmapped Plaid object)
          const bal = acct.balance_available ?? acct.balance_current ?? 0;
          if (acct.type !== 'depository') continue;
          if (bal > LOW_BALANCE_THRESHOLD) continue;
          const acctName = _htmlEscape(acct.name || 'Your account');
          const title    = '⚠️ Low Balance Alert';
          const body     = `${acct.name || 'Your account'} has only ${_fmt(bal)} remaining.`;
          await _saveNotification(uid, { title, body, type: 'low_balance', data: { account_id: acct.id, balance: String(bal) } });
          if (fcmToken) _sendFCM(uid, fcmToken, { title, body, type: 'low_balance', data: { balance: String(bal) }, channelId: 'flowcheck_alerts' }).catch(() => {});
          // Email alert for low balance
          if (userData.email && userData.email_alerts_enabled !== false) {
            _sendEmail(userData.email, `⚠️ Low Balance: ${acct.name || 'Your account'}`, `
              <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
              <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.08)">
                <div style="background:#fff3cd;border-left:4px solid #ffb020;padding:20px 24px">
                  <h2 style="font-size:18px;font-weight:700;color:#92400e;margin:0 0 6px">⚠️ Low Balance Alert</h2>
                  <p style="font-size:15px;color:#78350f;margin:0">${acctName} has only <strong>${_fmt(bal)}</strong> available.</p>
                </div>
                <div style="padding:24px">
                  <p style="font-size:14px;color:#6b7280;margin:0 0 20px">You may want to transfer funds or hold off on purchases to avoid overdraft fees.</p>
                  <a href="${BACKEND_URL}/open" style="display:inline-block;background:#1ac4f0;color:#0a1520;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">View Accounts →</a>
                </div>
                <div style="padding:14px 24px;border-top:1px solid #f3f4f6">
                  <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'alerts', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe from alerts</a></p>
                </div>
              </div></body></html>
            `, uid).catch(e => console.error('[email low-balance]', e.message));
          }
          break;
        }

        // ── 1d. Duplicate charge detection ───────────────────────────
        if (added.length > 0) {
          const sevenAgo = new Date(); sevenAgo.setDate(sevenAgo.getDate() - 7);
          const sevenStr = sevenAgo.toISOString().slice(0, 10);
          for (const t of added) {
            if (t.amount <= 0) continue;
            if (t.amount < 5) continue; // ignore tiny charges
            const mKey = (t.merchant_name || t.name || '').toLowerCase().trim();
            if (!mKey) continue;
            const dupSnap = await userRef.collection('transactions')
              .where('date', '>=', sevenStr)
              .where('amount', '==', t.amount)
              .where('pending', '==', false)
              .get();
            const dupes = dupSnap.docs.filter(d => {
              const tx = d.data();
              return (tx.merchant_name || tx.name || '').toLowerCase().trim() === mKey
                && d.id !== t.transaction_id;
            });
            if (dupes.length > 0) {
              const safeMerch = _htmlEscape(t.merchant_name || t.name || 'A merchant');
              const dupTitle = `⚠️ Possible duplicate charge`;
              const dupBody  = `${t.merchant_name || t.name} charged ${_fmt(t.amount)} twice in the last 7 days.`;
              await _saveNotification(uid, { title: dupTitle, body: dupBody, type: 'duplicate_charge', data: { merchant: mKey, amount: String(t.amount) } });
              if (fcmToken) _sendFCM(uid, fcmToken, { title: dupTitle, body: dupBody, type: 'duplicate_charge', channelId: 'flowcheck_alerts' }).catch(() => {});
              if (userData.email && userData.email_alerts_enabled !== false) {
                _sendEmail(userData.email, `⚠️ Possible duplicate: ${_fmt(t.amount)} from ${t.merchant_name || t.name}`, `
                <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
                <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
                  <div style="background:#fff3cd;border-left:5px solid #f59e0b;padding:24px 28px">
                    <h2 style="font-size:18px;font-weight:700;color:#92400e;margin:0 0 6px">⚠️ Possible duplicate charge</h2>
                    <p style="font-size:15px;color:#78350f;margin:0"><strong>${safeMerch}</strong> charged <strong>${_fmt(t.amount)}</strong> twice in the last 7 days.</p>
                  </div>
                  <div style="padding:24px 28px">
                    <p style="font-size:14px;color:#6b7280;margin:0 0 20px">This could be a legitimate charge or an accidental double-bill. Check your recent transactions to confirm.</p>
                    <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">Review Transactions →</a>
                  </div>
                  <div style="padding:14px 28px;border-top:1px solid #f3f4f6;text-align:center">
                    <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(uid, 'alerts', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe from alerts</a></p>
                  </div>
                </div></body></html>`, uid).catch(e => console.error('[email dup-charge]', e.message));
              }
              break; // one duplicate alert per sync
            }
          }
        }

        // ── 1f. Subscription renewal / price-change detection ────────────
        // Only runs when there are new expense transactions — avoids the cost
        // of a 90-day query on syncs that only bring income or no-ops.
        const hasNewExpenses = added.some(t => t.amount > 0);
        if (hasNewExpenses && userData.email && userData.email_alerts_enabled !== false) {
          await _detectAndEmailSubscriptions(uid, userRef, userData, fcmToken).catch(err =>
            console.error('[webhook sub-detect]', err.message)
          );
        }

        // ── 2. Budget overage detection ───────────────────────────────
        // Only check categories touched by new expense transactions.
        const budgetSnap = await userRef.collection('budgets').get();
        if (!budgetSnap.empty) {
          const budgetMap = {};
          budgetSnap.docs.forEach(d => {
            const b = d.data();
            if (b.category && b.limit) budgetMap[b.category.toUpperCase()] = b.limit;
          });

          const now        = new Date();
          const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

          // Unique expense categories from this batch
          const touchedCats = new Set(
            added
              .filter(t => t.amount > 0) // expense = positive in Plaid
              .map(t => (
                t.personal_finance_category?.primary ||
                (t.category && t.category[0]) ||
                ''
              ).toUpperCase())
              .filter(Boolean)
          );

          for (const cat of touchedCats) {
            const budgetLimit = budgetMap[cat];
            if (!budgetLimit) continue;

            // Month-to-date spend in this category (from Firestore after the batch write)
            const catSnap = await userRef.collection('transactions')
              .where('date', '>=', monthStart)
              .where('pending', '==', false)
              .where('isCredit', '==', false)
              .get();

            let monthlySpent = 0;
            catSnap.docs.forEach(d => {
              const tx = d.data();
              const txCat = (tx.category && tx.category[0] || '').toUpperCase();
              if (txCat === cat) monthlySpent += tx.amount;
            });

            if (monthlySpent > budgetLimit) {
              const overBy   = monthlySpent - budgetLimit;
              const catLabel = cat.charAt(0) + cat.slice(1).toLowerCase().replace(/_/g, ' ');
              const title    = `⚠️ Budget Exceeded: ${catLabel}`;
              const body     = `You've spent ${_fmt(monthlySpent)} of your ${_fmt(budgetLimit)} ${catLabel} budget — ${_fmt(overBy)} over.`;
              _sendFCM(uid, fcmToken, {
                title, body,
                type:      'budget_alert',
                data:      { category: cat, spent: String(monthlySpent), limit: String(budgetLimit) },
                channelId: 'flowcheck_alerts',
              }).catch(err => console.error('[fcm budget-alert/webhook]', err.message));
            }
          }
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────

    console.log(`[webhook] Synced uid:${uid} item:${itemId} → ${accounts.length} accounts, +${added.length}~${modified.length}-${removed.length} txns`);
  } catch (err) {
    // FAILED_PRECONDITION on a brand-new item means Plaid isn't ready yet — retry once
    if (err.code === 9 && retryCount < 2) {
      const delay = (retryCount + 1) * 30_000; // 30s, 60s
      console.warn(`[webhook] FAILED_PRECONDITION for item ${itemId} — retrying in ${delay / 1000}s`);
      setTimeout(() => _webhookSyncItem(itemId, retryCount + 1), delay);
      return;
    }
    console.error(`[webhook] Sync failed for item ${itemId}:`, err.message);
  }
}

/* ─────────────────────────────────────────────────────────────
   POST /plaid/webhook
   ─────────────────────────────────────────────────────────────
   Called by Plaid when transactions change. We:
   1. Verify the Plaid-Verification JWT (ES256, Plaid's public key)
   2. Respond 200 immediately (Plaid requires < 10s response)
   3. Trigger a background sync for the affected item

   Webhook types we act on:
   - TRANSACTIONS_DEFAULT_UPDATE   → new transactions available
   - TRANSACTIONS_SYNC_UPDATES_AVAILABLE → use /transactions/sync
   - TRANSACTIONS_REMOVED         → deleted transactions (future)
   ─────────────────────────────────────────────────────────────── */
// Plaid sends webhook_type ('TRANSACTIONS') and webhook_code ('DEFAULT_UPDATE') separately.
// We match on webhook_code only — the compound 'TRANSACTIONS_DEFAULT_UPDATE' strings
// are documentation shorthand, NOT what Plaid actually sends in the payload.
const WEBHOOK_CODES_TO_SYNC = new Set([
  'DEFAULT_UPDATE',           // new transactions available
  'SYNC_UPDATES_AVAILABLE',   // use /transactions/sync
  'INITIAL_UPDATE',           // first pull after link
  'HISTORICAL_UPDATE',        // historical transactions ready
]);

app.post('/plaid/webhook', async (req, res) => {
  // Always respond quickly so Plaid doesn't retry
  const respond = (status, body) => {
    if (!res.headersSent) res.status(status).json(body);
  };

  try {
    // ── 1. Verify JWT signature ──────────────────────────────────
    const token = req.headers['plaid-verification'];
    if (!token) {
      console.warn('[webhook] Missing Plaid-Verification header — ignoring');
      return respond(400, { message: 'Missing verification token' });
    }

    try {
      await _verifyPlaidJwt(token, req.rawBody);
    } catch (verifyErr) {
      console.warn('[webhook] JWT verification failed:', verifyErr.message);
      return respond(401, { message: 'Webhook verification failed' });
    }

    // ── 2. Parse body & respond 200 immediately ──────────────────
    const { webhook_type, webhook_code, item_id } = req.body || {};
    respond(200, { received: true });

    // ── 3. Trigger background sync if relevant ───────────────────
    if (item_id && WEBHOOK_CODES_TO_SYNC.has(webhook_code)) {
      console.log(`[webhook] Triggering sync for item:${item_id} type:${webhook_type} code:${webhook_code}`);
      _webhookSyncItem(item_id); // intentionally not awaited
    } else {
      console.log(`[webhook] Ignoring webhook type:${webhook_type} code:${webhook_code}`);
    }
  } catch (err) {
    console.error('[webhook] Unexpected error:', err.message);
    respond(500, { message: 'Internal error' });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET  /unsubscribe   — one-click email unsubscribe (CAN-SPAM required)
   POST /unsubscribe   — RFC 8058 List-Unsubscribe-Post support
   ─────────────────────────────────────────────────────────────
   Linked from every outbound email footer: ?uid=<firebase_uid>&type=<type>
   type values:
     all       → disable all email (marketing + alerts + weekly)
     marketing → disable marketing/welcome emails only
     alerts    → disable budget alert + bill reminder emails
     weekly    → disable weekly summary emails

   No auth token required — the uid in the URL is the only credential.
   Rate-limited to 10 req / 15 min per IP to prevent scraping.
   ─────────────────────────────────────────────────────────────── */
const _unsubLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { message: 'Too many requests' },
});

function _unsubscribeHtml(success, message) {
  const color  = success ? '#1ac4f0' : '#ef4444';
  const icon   = success ? '✅' : '⚠️';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FlowCheck · Unsubscribe</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #fff; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); max-width: 480px; width: 100%; overflow: hidden; }
    .header { background: linear-gradient(135deg, #0a1520, #112230); padding: 36px 32px; text-align: center; }
    .icon { font-size: 40px; margin-bottom: 12px; }
    .title { color: #fff; font-size: 22px; font-weight: 700; }
    .body { padding: 28px 32px; text-align: center; }
    .msg { font-size: 15px; color: #374151; line-height: 1.6; margin-bottom: 24px; }
    .badge { display: inline-block; background: ${color}22; color: ${color}; font-size: 13px; font-weight: 600; padding: 6px 14px; border-radius: 20px; margin-bottom: 20px; }
    .link { color: #6b7280; font-size: 13px; }
    .link a { color: #1ac4f0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="icon">${icon}</div>
      <div class="title">FlowCheck</div>
    </div>
    <div class="body">
      <div class="badge">${message}</div>
      <p class="msg">
        ${success
          ? 'You\'ve been unsubscribed. You may still receive critical account and security emails.'
          : 'Something went wrong. Please try again or contact support.'}
      </p>
      <p class="link">Questions? <a href="https://getflowcheck.app/support">Contact support</a></p>
    </div>
  </div>
</body>
</html>`;
}

/* ── Signed unsubscribe URL helpers ─────────────────────────────
 * Unsubscribe links arrive at a public endpoint with no auth, so the link
 * itself must prove the bearer is allowed to act on this uid. We sign
 * uid|type|exp with HMAC-SHA256 using UNSUB_SECRET.
 *
 * Backward-compat: if a link arrives without `sig`, we still honor it
 * (legacy emails already in inboxes). New emails always include sig.
 * Flip ENFORCE_UNSUB_SIG=1 once legacy emails are out of the 30-day window. */
// UNSUB_SECRET must be an independent secret — never fall back to FIREBASE_SERVICE_ACCOUNT
// Set this in Railway env vars: openssl rand -hex 32
const UNSUB_SECRET = process.env.UNSUB_SECRET || 'flowcheck-unsub-dev-only-do-not-use-in-prod';
if (!process.env.UNSUB_SECRET) {
  console.warn('[Boot] UNSUB_SECRET not set — unsubscribe links use dev fallback. Set this in Railway.');
}
// Signatures are always enforced — unsigned legacy links are rejected
const ENFORCE_UNSUB_SIG = true;

function _signUnsub(uid, type, expMs) {
  return crypto.createHmac('sha256', UNSUB_SECRET)
    .update(`${uid}|${type}|${expMs}`)
    .digest('hex');
}
function _verifyUnsub(uid, type, exp, sig) {
  if (!uid || !type || !exp || !sig) return false;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  const expected = _signUnsub(uid, type, expMs);
  try {
    return sig.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) { return false; }
}
function _unsubUrl(uid, type = 'all', base = 'https://getflowcheck.app') {
  // 90-day validity — long enough for delayed reads, short enough to limit reuse
  const exp = Date.now() + 90 * 24 * 60 * 60 * 1000;
  const sig = _signUnsub(uid, type, exp);
  return `${base}/unsubscribe?uid=${encodeURIComponent(uid)}&type=${encodeURIComponent(type)}&exp=${exp}&sig=${sig}`;
}

async function _handleUnsubscribe(uid, type) {
  if (!uid || typeof uid !== 'string' || uid.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(uid)) {
    throw new Error('invalid_uid');
  }

  const validTypes = new Set(['all', 'marketing', 'alerts', 'weekly']);
  const safeType   = validTypes.has(type) ? type : 'all';

  const update = {};
  if (safeType === 'marketing' || safeType === 'all') {
    update.email_marketing_opt_in = false;
  }
  if (safeType === 'alerts' || safeType === 'all') {
    update.email_alerts_enabled = false;
  }
  if (safeType === 'weekly' || safeType === 'all') {
    update.email_weekly_enabled = false;
  }
  // 'all' also disables notifications_enabled so cron skips this user
  if (safeType === 'all') {
    update.notifications_enabled = false;
  }

  await db.collection('users').doc(uid).update(update);
  console.log(`[unsubscribe] uid:${uid} type:${safeType} → ${JSON.stringify(update)}`);
}

app.get('/unsubscribe', _unsubLimiter, async (req, res) => {
  const { uid, type = 'all', exp, sig } = req.query;
  const hasSig = Boolean(sig);
  const validSig = hasSig && _verifyUnsub(uid, type, exp, sig);
  if (hasSig && !validSig) {
    return res.status(400).send(_unsubscribeHtml(false, 'This unsubscribe link is invalid or expired'));
  }
  if (!hasSig && ENFORCE_UNSUB_SIG) {
    return res.status(400).send(_unsubscribeHtml(false, 'This unsubscribe link is missing required signature'));
  }
  if (!hasSig) console.warn(`[unsubscribe] legacy unsigned link uid:${uid}`);
  try {
    await _handleUnsubscribe(uid, type);
    res.send(_unsubscribeHtml(true, 'You\'ve been unsubscribed'));
  } catch (err) {
    if (err.message === 'invalid_uid') {
      return res.status(400).send(_unsubscribeHtml(false, 'Invalid unsubscribe link'));
    }
    console.error('[unsubscribe GET]', err.message);
    res.status(500).send(_unsubscribeHtml(false, 'Something went wrong'));
  }
});

// POST /unsubscribe — RFC 8058 List-Unsubscribe-Post (Apple Mail, Gmail one-click)
// Add to your emails: List-Unsubscribe-Post: List-Unsubscribe=One-Click
//                     List-Unsubscribe: <https://...railway.app/unsubscribe?uid=X>
app.post('/unsubscribe', _unsubLimiter, async (req, res) => {
  const uid  = req.query.uid  || req.body?.uid;
  const type = req.query.type || req.body?.type || 'all';
  const exp  = req.query.exp  || req.body?.exp;
  const sig  = req.query.sig  || req.body?.sig;
  const hasSig = Boolean(sig);
  const validSig = hasSig && _verifyUnsub(uid, type, exp, sig);
  if (hasSig && !validSig) {
    return res.status(400).json({ message: 'Invalid or expired unsubscribe link' });
  }
  if (!hasSig && ENFORCE_UNSUB_SIG) {
    return res.status(400).json({ message: 'Missing signature' });
  }
  try {
    await _handleUnsubscribe(uid, type);
    res.json({ unsubscribed: true });
  } catch (err) {
    if (err.message === 'invalid_uid') {
      return res.status(400).json({ message: 'Invalid unsubscribe link' });
    }
    console.error('[unsubscribe POST]', err.message);
    res.status(500).json({ message: 'Unsubscribe failed' });
  }
});

/* ─────────────────────────────────────────────────────────────────
   Apple App Attest — challenge + verification endpoints
   ─────────────────────────────────────────────────────────────────
   App Attest cryptographically proves that a request originated from
   a genuine, unmodified copy of FlowCheck running on a real Apple
   device (not a jailbroken device, emulator, or API scraper).

   Flow:
     1. GET  /attest/challenge → { challenge }  (client calls before attestation)
     2. iOS calls DCAppAttestService.attestKey(keyID, SHA256(challenge))
     3. Apple returns a CBOR-encoded attestation object with cert chain
     4. POST /attest/verify   ← client POSTs { key_id, attestation, challenge }
     5. Server verifies cert chain → Apple App Attest Root CA
     6. Server verifies nonce embedded in leaf cert = SHA256(authData || SHA256(challenge))
     7. Server verifies RP ID hash in authData = SHA256(bundle ID)
     8. Server verifies credential ID matches key_id
     9. Stores verified key_id in Firestore users/{uid}.attest_key_id

   Reference: https://developer.apple.com/documentation/devicecheck/validating_apps_that_connect_to_your_server
   ───────────────────────────────────────────────────────────────── */

// Apple App Attest Root CA — embedded to avoid network round-trips.
// Downloaded from: https://www.apple.com/certificateauthority/private/
// Fingerprint (SHA-256): 1F:75:31:6A:2A:AC:...
const _APPLE_ATTEST_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTbQlEE7PkY
O7MDg4KCxNMxJjc6aQ5hniLKGc8T1m+eJJSFsw2Xn2VLOmHpCQqD1sA+OVBrjYE
q28ZVFz3SenGbRB7wBRKPnlDSiDgBBOVo2MwYTAPBgNVHRMBAf8EBTADAQH/MB8G
A1UdDgQYBBYEFKMlyqKBcFmTzER5ExAFtINi+QVuMB8GA1UdIgQYBBYEFKMlyqKB
cFmTzER5ExAFtINi+QVuMA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAwNoADBl
AjEA4pBPYk/EV0Cg2kXLimCTJxvpjPTF+6QC0XZ5fBuRvnvON3cFJhJzP3ZCXHBT
jRSFAjBWECmBRPcKASI1SgRhJB1DWjMqxNHwKAiE4JWGC2XoIiGUGFWV4D28ynp
wPFhW7c=
-----END CERTIFICATE-----`;

// In-memory challenge store: uid → { challenge, expiresAt }
// Challenges are one-time-use and expire after 5 minutes.
const _attestChallenges = new Map();
const _ATTEST_CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Lazily loaded cbor-x decoder — only required when the endpoint is hit.
let _cborDecode = null;
function _getCborDecode() {
  if (!_cborDecode) {
    try { _cborDecode = require('cbor-x').decode; }
    catch { throw new Error('cbor-x package not installed — run npm install'); }
  }
  return _cborDecode;
}

// ── Minimal DER helpers ──────────────────────────────────────────────────────
// Used to find the App Attest nonce extension (OID 1.2.840.113635.100.8.2)
// in the raw DER bytes of the leaf certificate and verify its value.
// We avoid pulling in a full ASN.1 library to keep the dependency count low.

/** Read a DER length field at buf[offset]. Returns { len, skip }. */
function _derReadLength(buf, offset) {
  if (buf[offset] < 0x80) return { len: buf[offset], skip: 1 };
  const numBytes = buf[offset] & 0x7f;
  let len = 0;
  for (let i = 1; i <= numBytes; i++) len = (len << 8) | buf[offset + i];
  return { len, skip: 1 + numBytes };
}

/** Find the first occurrence of `needle` in `haystack`. Returns -1 if absent. */
function _bufIndexOf(haystack, needle) {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// OID 1.2.840.113635.100.8.2 in DER TLV form:
// Tag=0x06 Length=0x09 Value=2A 86 48 86 F7 63 64 08 02
const _ATTEST_NONCE_OID_TLV = Buffer.from('06092a864886f763640802', 'hex');

/**
 * Extract the 32-byte nonce from the App Attest leaf certificate's extension
 * (OID 1.2.840.113635.100.8.2) and verify it equals expectedNonce.
 *
 * Extension structure inside the cert DER:
 *   SEQUENCE {               ← extension wrapper
 *     OID 1.2.840.113635.100.8.2
 *     OCTET STRING {         ← extnValue wrapper
 *       SEQUENCE {           ← DER-encoded value
 *         OCTET STRING {     ← 32-byte nonce
 *           <nonce bytes>
 *         }
 *       }
 *     }
 *   }
 */
function _verifyAttestNonce(derCert, expectedNonce) {
  const buf     = Buffer.isBuffer(derCert) ? derCert : Buffer.from(derCert);
  const oidPos  = _bufIndexOf(buf, _ATTEST_NONCE_OID_TLV);
  if (oidPos === -1) throw new Error('Nonce OID not found in leaf cert — not an App Attest cert');

  let pos = oidPos + _ATTEST_NONCE_OID_TLV.length; // skip the OID TLV

  // Optional BOOLEAN (critical flag): tag 0x01
  if (buf[pos] === 0x01) pos += 3;

  // OCTET STRING (extnValue) wrapping the encoded extension value
  if (buf[pos] !== 0x04) throw new Error('Expected OCTET STRING after nonce OID');
  pos++;
  const osLen = _derReadLength(buf, pos);
  pos += osLen.skip;

  // SEQUENCE containing the nonce OCTET STRING
  if (buf[pos] !== 0x30) throw new Error('Expected SEQUENCE in nonce extension value');
  pos++;
  const seqLen = _derReadLength(buf, pos);
  pos += seqLen.skip;

  // OCTET STRING holding the 32-byte nonce
  if (buf[pos] !== 0x04) throw new Error('Expected OCTET STRING for nonce value');
  pos++;
  const nonceLen = _derReadLength(buf, pos);
  pos += nonceLen.skip;

  const nonce = buf.slice(pos, pos + nonceLen.len);
  if (!nonce.equals(expectedNonce)) {
    throw new Error('Nonce mismatch — authData or challenge tampered');
  }
}

/**
 * Verify that the DER certificate chain in x5c terminates at
 * Apple's App Attest Root CA, and that each cert is signed by the next.
 */
function _verifyAppAttestCertChain(x5c) {
  const { X509Certificate } = crypto;
  if (!Array.isArray(x5c) || x5c.length < 2) {
    throw new Error('x5c chain must contain at least 2 certs');
  }

  const certs = x5c.map((c, i) => {
    try { return new X509Certificate(Buffer.isBuffer(c) ? c : Buffer.from(c)); }
    catch { throw new Error(`x5c[${i}] is not valid DER`); }
  });

  // Verify each cert is issued by and has a valid signature from the next
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].checkIssued(certs[i + 1])) {
      throw new Error(`x5c[${i}] was not issued by x5c[${i + 1}]`);
    }
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new Error(`x5c[${i}] signature invalid`);
    }
  }

  // The chain must terminate at Apple's known root CA
  const appleRoot = new X509Certificate(_APPLE_ATTEST_ROOT_CA_PEM);
  const chainRoot = certs[certs.length - 1];
  if (chainRoot.fingerprint256 !== appleRoot.fingerprint256) {
    throw new Error('Certificate chain does not terminate at Apple App Attest Root CA');
  }
}

/* ── GET /attest/challenge ────────────────────────────────────────── */
// Returns a fresh cryptographic challenge for the calling user.
// Stored in-memory for 5 minutes; consumed once during /attest/verify.
app.get('/attest/challenge', requireAuth, (req, res) => {
  // Purge any previously stored challenge for this user
  _attestChallenges.delete(req.uid);

  const challenge  = crypto.randomBytes(32).toString('base64');
  const expiresAt  = Date.now() + _ATTEST_CHALLENGE_TTL_MS;
  _attestChallenges.set(req.uid, { challenge, expiresAt });

  // Evict expired entries periodically so the map doesn't grow unbounded
  if (_attestChallenges.size > 5000) {
    const now = Date.now();
    for (const [uid, v] of _attestChallenges) {
      if (now > v.expiresAt) _attestChallenges.delete(uid);
    }
  }

  res.json({ challenge });
});

/* ── POST /attest/verify ──────────────────────────────────────────── */
// Full Apple App Attest verification:
//   1. Challenge freshness + one-time-use
//   2. CBOR decode of the Apple attestation object
//   3. Certificate chain → Apple App Attest Root CA
//   4. Nonce verification (prevents replay / authData tampering)
//   5. RP ID hash verification (prevents cross-app usage)
//   6. Credential ID vs provided key_id
//   7. Store attested key_id in Firestore
const _attestLimiter = rateLimit({
  windowMs:        60 * 60 * 1000, // 1 hour
  max:             5,               // max 5 attestation attempts per IP per hour
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { message: 'Too many attestation attempts — try again later' },
});

app.post('/attest/verify', requireAuth, _attestLimiter, async (req, res) => {
  const { key_id, attestation, challenge } = req.body || {};

  // ── 1. Input validation ────────────────────────────────────────────
  if (!key_id || typeof key_id !== 'string') {
    return res.status(400).json({ message: 'Missing or invalid key_id' });
  }
  if (!attestation || typeof attestation !== 'string') {
    return res.status(400).json({ message: 'Missing attestation' });
  }
  if (!challenge || typeof challenge !== 'string') {
    return res.status(400).json({ message: 'Missing challenge' });
  }

  // ── 2. Challenge freshness + single-use enforcement ────────────────
  const stored = _attestChallenges.get(req.uid);
  if (!stored) {
    return res.status(401).json({ message: 'No pending challenge — call /attest/challenge first' });
  }
  if (Date.now() > stored.expiresAt) {
    _attestChallenges.delete(req.uid);
    return res.status(401).json({ message: 'Challenge expired — request a new one' });
  }
  if (stored.challenge !== challenge) {
    return res.status(401).json({ message: 'Challenge mismatch' });
  }
  _attestChallenges.delete(req.uid); // one-time use — delete immediately

  try {
    // ── 3. CBOR decode ─────────────────────────────────────────────────
    const decode = _getCborDecode();
    let attestObj;
    try {
      attestObj = decode(Buffer.from(attestation, 'base64'));
    } catch (e) {
      return res.status(400).json({ message: 'Invalid attestation encoding' });
    }

    const { fmt, attStmt, authData } = attestObj || {};
    if (fmt !== 'apple-appattest') {
      return res.status(400).json({ message: `Unexpected attestation format: ${fmt}` });
    }
    const { x5c } = attStmt || {};
    if (!x5c || !authData) {
      return res.status(400).json({ message: 'Malformed attestation — missing x5c or authData' });
    }

    // ── 4. Certificate chain verification ─────────────────────────────
    _verifyAppAttestCertChain(x5c);

    // ── 5. Nonce verification ──────────────────────────────────────────
    // nonce = SHA256(authData || clientDataHash)
    // clientDataHash = SHA256(challenge)   (as computed by DCAppAttestService)
    const clientDataHash = crypto.createHash('sha256').update(challenge).digest();
    const expectedNonce  = crypto.createHash('sha256')
      .update(Buffer.isBuffer(authData) ? authData : Buffer.from(authData))
      .update(clientDataHash)
      .digest();
    _verifyAttestNonce(x5c[0], expectedNonce);

    // ── 6. RP ID (bundle ID) hash verification ─────────────────────────
    const BUNDLE_ID       = process.env.APP_BUNDLE_ID || 'com.brandon.flowcheck';
    const expectedRPIDHash = crypto.createHash('sha256').update(BUNDLE_ID).digest();
    const authDataBuf      = Buffer.isBuffer(authData) ? authData : Buffer.from(authData);
    const rpIDHash         = authDataBuf.slice(0, 32);
    if (!rpIDHash.equals(expectedRPIDHash)) {
      throw new Error(`RP ID hash mismatch — expected SHA256("${BUNDLE_ID}")`);
    }

    // ── 7. Credential ID vs key_id ─────────────────────────────────────
    // authData layout: [0:32]=rpIDHash [32]=flags [33:37]=signCount
    //   [37:53]=AAGUID (16B) [53:55]=credIDLen [55:55+credIDLen]=credID
    const credIDLen = authDataBuf.readUInt16BE(53);
    const credID    = authDataBuf.slice(55, 55 + credIDLen).toString('base64');
    if (credID !== key_id) {
      throw new Error('Credential ID does not match provided key_id');
    }

    // ── 8. Persist attested key ID ────────────────────────────────────
    await db.collection('users').doc(req.uid).set({
      attest_key_id:  key_id,
      attest_verified: true,
      attest_at:      admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`[AppAttest] ✅ Device attested uid:${req.uid} key:${key_id.slice(0, 8)}…`);
    res.json({ success: true });

  } catch (err) {
    console.warn(`[AppAttest] ❌ Verification failed uid:${req.uid} — ${err.message}`);
    res.status(400).json({ message: 'Attestation verification failed' });
  }
});

/* ── Sentry error handler — must come BEFORE the generic error handler ── */
// Captures unhandled errors and passes them to Sentry before responding.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

/* ── Global Express error handler ──────────────────────────────── */
// Catches any error passed to next(err) or thrown in async routes
// that isn't caught by their own try/catch.
// Must be defined with 4 params so Express recognises it as error middleware.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[Error] ${req.method} ${req.path} →`, err.message || err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    message: _safeMsg(err, 'An unexpected error occurred — please try again'),
  });
});

/* ─────────────────────────────────────────────────────────────
   OTP EMAIL VERIFICATION
   POST /auth/otp/send   — generate & email a 6-digit code
   POST /auth/otp/verify — verify the code, set emailVerified
   ─────────────────────────────────────────────────────────────
   Codes stored in Firestore: otp_codes/{uid}
   TTL: 10 minutes. Max 5 attempts per code.
   ─────────────────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────────────
   POST /auth/login-event
   Called by the client after every successful sign-in.
   Sends a "new sign-in detected" security alert email at most
   once per calendar day (UTC) per user — rate-limited by the
   generalLimiter already applied to the /auth prefix.
   ───────────────────────────────────────────────────────────── */
app.post('/auth/login-event', requireAuth, async (req, res) => {
  res.json({ ok: true }); // never block the client — respond first
  try {
    const userRef  = db.collection('users').doc(req.uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return;

    const data = userSnap.data();
    if (!data.email || !_resendApiKey) return;
    if (data.notifications_enabled === false) return;
    if (data.email_alerts_enabled === false) return;

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    if (data.last_login_alert_date === today) return;    // already sent today

    await userRef.update({ last_login_alert_date: today });

    const name    = _htmlEscape((data.name || 'there').split(' ')[0]);
    const now     = new Date();
    const timeStr = now.toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' UTC';

    _sendEmail(data.email, `🔒 New sign-in to your FlowCheck account`, `
      <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
        <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:32px;text-align:center">
          ${LOGO_IMG}
          <div style="font-size:32px;margin-bottom:8px">🔒</div>
          <h1 style="color:#fff;font-size:20px;font-weight:700;margin:0 0 4px">New sign-in detected</h1>
          <p style="color:rgba(255,255,255,0.55);font-size:14px;margin:0">Hi ${name} — someone signed in to your account</p>
        </div>
        <div style="padding:28px 32px">
          <div style="background:#f9fafb;border-radius:12px;padding:16px 20px;margin-bottom:20px">
            <div style="display:flex;justify-content:space-between;margin-bottom:6px">
              <span style="font-size:13px;color:#6b7280">Time</span>
              <span style="font-size:13px;font-weight:600;color:#374151">${timeStr}</span>
            </div>
            <div style="display:flex;justify-content:space-between">
              <span style="font-size:13px;color:#6b7280">Account</span>
              <span style="font-size:13px;font-weight:600;color:#374151">${_htmlEscape(data.email)}</span>
            </div>
          </div>
          <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 20px">If this was you, no action is needed. If you didn't sign in, reset your password immediately.</p>
          <a href="${BACKEND_URL}/open" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">Open FlowCheck →</a>
        </div>
        <div style="padding:14px 32px;border-top:1px solid #f3f4f6;text-align:center">
          <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck · <a href="${_unsubUrl(req.uid, 'alerts', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe from security alerts</a></p>
        </div>
      </div></body></html>
    `, req.uid).catch(e => console.error('[email login-alert]', e.message));
  } catch (err) {
    console.error('[auth/login-event]', err.message);
  }
});

app.post('/auth/otp/send', requireAuth, async (req, res) => {
  try {
    const userRecord = await admin.auth().getUser(req.uid);
    const email = userRecord.email;
    if (!email) return res.status(400).json({ message: 'No email address on this account' });

    // Throttle: max 1 send per 60 seconds
    const existingDoc = await db.collection('otp_codes').doc(req.uid).get();
    if (existingDoc.exists) {
      const data = existingDoc.data();
      const secondsAgo = (Date.now() - data.sent_at) / 1000;
      if (secondsAgo < 60) {
        return res.status(429).json({ message: `Please wait ${Math.ceil(60 - secondsAgo)}s before requesting a new code` });
      }
    }

    const code       = String(crypto.randomInt(100000, 1000000));
    const expires_at = Date.now() + 10 * 60 * 1000;

    await db.collection('otp_codes').doc(req.uid).set({
      code, email, expires_at, sent_at: Date.now(), attempts: 0,
    });

    const name = await _resolveDisplayName(req.uid);
    await _sendEmail(email, `${code} is your FlowCheck verification code`, `
      <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="max-width:480px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
        <div style="background:linear-gradient(135deg,#060e18,#0d2035);padding:36px 32px;text-align:center">
          ${LOGO_IMG}
          <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0;letter-spacing:-0.02em">Verify your email</h1>
        </div>
        <div style="padding:32px;text-align:center">
          <p style="font-size:15px;color:#374151;margin:0 0 28px">Hi ${_htmlEscape(name)}, enter this code in FlowCheck to verify your email.</p>
          <div style="background:#f0fffe;border:2px solid #1ac4f0;border-radius:14px;padding:24px 32px;margin-bottom:28px;display:inline-block">
            <span style="font-size:40px;font-weight:800;letter-spacing:0.18em;color:#060e18;font-variant-numeric:tabular-nums">${code}</span>
          </div>
          <p style="font-size:13px;color:#9ca3af;margin:0">Expires in 10 minutes. If you didn't request this, ignore this email.</p>
        </div>
        <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
          <p style="font-size:11px;color:#9ca3af;margin:0">FlowCheck &middot; Your money, clearly.</p>
        </div>
      </div></body></html>
    `);

    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/otp/send]', err.message);
    res.status(500).json({ message: _safeMsg(err) });
  }
});

app.post('/auth/otp/verify', requireAuth, async (req, res) => {
  const { code } = req.body || {};
  if (!code || !/^\d{6}$/.test(String(code))) {
    return res.status(400).json({ message: 'Enter the 6-digit code from your email' });
  }
  try {
    const docRef = db.collection('otp_codes').doc(req.uid);
    const snap   = await docRef.get();

    if (!snap.exists) {
      return res.status(400).json({ message: 'No verification code found — tap Resend', expired: true });
    }

    const data = snap.data();
    if (Date.now() > data.expires_at) {
      await docRef.delete();
      return res.status(400).json({ message: 'Code expired — tap Resend for a new one', expired: true });
    }
    if (data.attempts >= 5) {
      await docRef.delete();
      return res.status(400).json({ message: 'Too many attempts — tap Resend for a new code', expired: true });
    }
    if (String(data.code) !== String(code)) {
      await docRef.update({ attempts: admin.firestore.FieldValue.increment(1) });
      const left = 4 - data.attempts;
      return res.status(400).json({ message: `Incorrect code — ${left} attempt${left !== 1 ? 's' : ''} left` });
    }

    // Correct — mark email verified and clean up
    await Promise.all([
      admin.auth().updateUser(req.uid, { emailVerified: true }),
      docRef.delete(),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[auth/otp/verify]', err.message);
    res.status(500).json({ message: _safeMsg(err) });
  }
});

/* ─────────────────────────────────────────────────────────────
   ABANDONED SIGNUP FOLLOW-UP EMAILS
   POST /email/signup-followup/schedule  — called after registration
   POST /email/signup-followup/complete  — called when bank connected
   Background job fires every 5 min to send due emails.
   ─────────────────────────────────────────────────────────────── */

app.post('/email/signup-followup/schedule', requireAuth, async (req, res) => {
  try {
    const userRecord = await admin.auth().getUser(req.uid);
    const email = userRecord.email;
    if (!email) return res.json({ ok: true, skipped: 'no_email' });
    await db.collection('signup_followups').doc(req.uid).set({
      email, uid: req.uid,
      followup_at: Date.now() + 60 * 60 * 1000, // 1 hour
      completed: false, sent: false, created_at: Date.now(),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[email/signup-followup/schedule]', err.message);
    res.json({ ok: true }); // never block the app
  }
});

app.post('/email/signup-followup/complete', requireAuth, async (req, res) => {
  try {
    await db.collection('signup_followups').doc(req.uid)
      .set({ completed: true }, { merge: true });
    res.json({ ok: true });
  } catch (err) {
    console.error('[email/signup-followup/complete]', err.message);
    res.json({ ok: true });
  }
});

// Background job: check every 5 min for abandoned signups to email.
// Firestore composite index required (see firestore.indexes.json):
//   collection: signup_followups
//   fields: completed ASC, sent ASC, followup_at ASC
setInterval(async () => {
  if (!_resendApiKey) return;
  try {
    const now  = Date.now();
    const snap = await db.collection('signup_followups')
      .where('completed',  '==', false)
      .where('sent',       '==', false)
      .where('followup_at', '<=', now)
      .orderBy('followup_at', 'asc')
      .limit(20).get();

    for (const doc of snap.docs) {
      const { email, uid } = doc.data();
      try {
        await _sendEmail(email, "You're almost set up on FlowCheck 👋", `
          <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
          <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
            <div style="background:linear-gradient(135deg,#060e18,#0d2035);padding:36px 32px;text-align:center">
              ${LOGO_IMG}
              <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0;letter-spacing:-0.02em">Your account is waiting</h1>
            </div>
            <div style="padding:32px">
              <p style="font-size:16px;color:#374151;line-height:1.6;margin:0 0 20px">
                You created a FlowCheck account but haven't connected your bank yet. It only takes 60 seconds &mdash; and once you do, you'll instantly see:
              </p>
              <div style="background:#f0fffe;border-left:3px solid #1ac4f0;border-radius:8px;padding:16px 20px;margin-bottom:28px">
                <p style="font-size:14px;color:#4b5563;margin:5px 0">&#x2713; Where your money is actually going</p>
                <p style="font-size:14px;color:#4b5563;margin:5px 0">&#x2713; Subscriptions you may have forgotten</p>
                <p style="font-size:14px;color:#4b5563;margin:5px 0">&#x2713; Your financial health score</p>
                <p style="font-size:14px;color:#4b5563;margin:5px 0">&#x2713; AI-powered savings opportunities</p>
              </div>
              <a href="${BACKEND_URL}/open?ref=signup_followup_email" style="display:block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#ffffff;font-weight:700;font-size:16px;padding:15px 28px;border-radius:10px;text-decoration:none;text-align:center">
                Finish Setup &rarr;
              </a>
            </div>
            <div style="padding:20px 32px;border-top:1px solid #f3f4f6;text-align:center">
              <p style="font-size:12px;color:#9ca3af;margin:0">FlowCheck &middot; Your money, clearly.<br>
                <a href="${_unsubUrl(uid, 'all', BACKEND_URL)}" style="color:#9ca3af">Unsubscribe</a></p>
            </div>
          </div></body></html>
        `, uid);
        await doc.ref.update({ sent: true, sent_at: now });
      } catch (e) {
        console.error('[signup-followup] Failed for', email, e.message);
      }
    }
  } catch (err) {
    console.error('[signup-followup] Background job error:', err.message);
  }
}, 5 * 60 * 1000);

/* ─────────────────────────────────────────────────────────────
   POST /webhooks/revenuecat
   RevenueCat sends this on every subscription lifecycle event.
   The app_user_id is the Firebase UID (set at SDK configure time).

   Set RC_WEBHOOK_SECRET in Railway env vars to the same value you
   enter in the "Authorization header value" field in RevenueCat.
   RevenueCat sends it verbatim as the Authorization header.

   Handled events → Firestore effect:
     INITIAL_PURCHASE / RENEWAL / UNCANCELLATION  → is_pro = true
     EXPIRATION / CANCELLATION (grace ended)       → is_pro = false
     BILLING_ISSUE                                 → push alert
   All other events are acknowledged (200) but ignored.
   ─────────────────────────────────────────────────────────────── */
const _RC_PRO_EVENTS   = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE']);
const _RC_LAPSE_EVENTS = new Set(['EXPIRATION']);

app.post('/webhooks/revenuecat', async (req, res) => {
  // ── 1. Auth: verify shared secret ───────────────────────────────
  const rcSecret = process.env.RC_WEBHOOK_SECRET;
  if (rcSecret) {
    const incoming = req.headers['authorization'] || '';
    const inBuf = Buffer.from(incoming);
    const secretBuf = Buffer.from(rcSecret);
    if (inBuf.length !== secretBuf.length || !crypto.timingSafeEqual(inBuf, secretBuf)) {
      console.warn('[rc-webhook] Unauthorized — bad secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const event = req.body?.event;
  if (!event) return res.status(400).json({ error: 'Missing event' });

  const {
    type,
    app_user_id: uid,
    original_app_user_id,
    aliases = [],
    transferred_from = [],
    expiration_at_ms,
    product_id,
    period_type,
  } = event;

  // Resolve Firebase UID. Priority order:
  //   1. app_user_id (set at SDK configure time — should always be the Firebase UID)
  //   2. aliases array (for subscribers linked before the configure-with-UID fix)
  //   3. original_app_user_id (present on TRANSFER events)
  //   4. transferred_from array (TRANSFER source accounts)
  const _isAnon = (s) => !s || s.startsWith('$RCAnonymous');
  let firebaseUid = _isAnon(uid) ? null : uid;
  if (!firebaseUid) {
    firebaseUid = aliases.find(a => !_isAnon(a)) || null;
  }
  if (!firebaseUid) {
    firebaseUid = _isAnon(original_app_user_id) ? null : original_app_user_id;
  }
  if (!firebaseUid) {
    firebaseUid = transferred_from.find(a => !_isAnon(a)) || null;
  }

  if (!firebaseUid) {
    // TRANSFER/EXPIRATION for fully-anonymous subscribers is expected — log at
    // info level, not warn, so it doesn't pollute Sentry or on-call alerts.
    console.log(`[rc-webhook] No Firebase UID for ${type} (anonymous subscriber) — skipping`);
    return res.json({ ok: true, skipped: 'no_firebase_uid' });
  }

  console.log(`[rc-webhook] ${type} → uid:${firebaseUid} product:${product_id || '?'}`);

  try {
    const userRef  = db.collection('users').doc(firebaseUid);
    const TS       = admin.firestore.FieldValue.serverTimestamp;
    const now      = new Date();

    if (_RC_PRO_EVENTS.has(type)) {
      // Determine expiry — use RevenueCat's value if present, else +1 month
      let expiresAt;
      if (expiration_at_ms) {
        expiresAt = admin.firestore.Timestamp.fromMillis(expiration_at_ms);
      } else {
        const d = new Date(now); d.setMonth(d.getMonth() + 1);
        expiresAt = admin.firestore.Timestamp.fromDate(d);
      }

      await userRef.set({
        is_pro:          true,
        pro:             true,
        pro_expires_at:  expiresAt,
        pro_product_id:  product_id || null,
        pro_period_type: period_type || null,
        pro_updated_at:  TS(),
      }, { merge: true });

      console.log(`[rc-webhook] ✓ is_pro=true for uid:${firebaseUid} expires:${expiration_at_ms ? new Date(expiration_at_ms).toISOString() : 'unknown'}`);

      // Send confirmation email (non-blocking, only for new purchases)
      if (type === 'INITIAL_PURCHASE') {
        _resolveDisplayName(firebaseUid).then(name => {
          admin.auth().getUser(firebaseUid)
            .then(u => u.email)
            .then(email => {
              if (!email) return;
              const plan = (product_id || '').includes('annual') ? 'annual' : 'monthly';
              return _sendEmail(email, 'You\'re now FlowCheck Pro 🚀', `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;color:#f3f4f6">Your Pro subscription is active — everything is unlocked.</div>
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:32px 16px"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">
  <tr><td style="background:linear-gradient(160deg,#060e18 0%,#0d2240 100%);border-radius:16px 16px 0 0;padding:40px 40px 36px;text-align:center">
    ${LOGO_IMG}
    <h1 style="color:#fff;font-size:28px;font-weight:800;margin:0 0 8px;letter-spacing:-0.03em">You're Pro, ${name}.</h1>
    <p style="color:rgba(255,255,255,0.55);font-size:15px;margin:0">${plan === 'annual' ? 'Annual plan · billed yearly' : 'Monthly plan · cancel anytime'}</p>
  </td></tr>
  <tr><td style="background:#fff;padding:36px 40px">
    <p style="font-size:16px;color:#374151;line-height:1.7;margin:0 0 28px">Your subscription is active. Everything is unlocked.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fffe;border-radius:12px;margin-bottom:32px"><tr><td style="padding:20px 24px">
      <p style="font-size:12px;font-weight:700;color:#1ac4f0;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 14px">What's included</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>Unlimited bank accounts</td></tr>
        <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>Financial Health Score</td></tr>
        <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>AI-powered spending insights</td></tr>
        <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>Bill tracking &amp; reminders</td></tr>
        <tr><td style="padding:5px 0;font-size:14px;color:#374151"><span style="color:#1ac4f0;margin-right:10px;font-weight:700">✦</span>Net worth &amp; milestones</td></tr>
      </table>
    </td></tr></table>
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <a href="${BACKEND_URL}/open?ref=rc_webhook_pro" style="display:inline-block;background:linear-gradient(135deg,#1ac4f0,#2563eb);color:#fff;font-weight:700;font-size:16px;padding:16px 40px;border-radius:12px;text-decoration:none">Open FlowCheck →</a>
    </td></tr></table>
  </td></tr>
  <tr><td style="background:#fff;border-radius:0 0 16px 16px;border-top:1px solid #f3f4f6;padding:20px 40px;text-align:center">
    <p style="font-size:12px;color:#9ca3af;margin:0;line-height:1.8">FlowCheck · Your money, clearly.<br>
      Manage subscription in <a href="itms-apps://apps.apple.com/account/subscriptions" style="color:#9ca3af;text-decoration:none">App Store Settings</a>.
    </p>
  </td></tr>
</table></td></tr></table>
</body></html>
              `, firebaseUid);
            })
            .catch(() => {});
        }).catch(() => {});
      }

    } else if (_RC_LAPSE_EVENTS.has(type)) {
      await userRef.set({
        is_pro:         false,
        pro:            false,
        pro_expires_at: null,
        pro_updated_at: TS(),
      }, { merge: true });

      console.log(`[rc-webhook] ✓ is_pro=false (${type}) for uid:${firebaseUid}`);

    } else if (type === 'BILLING_ISSUE') {
      // Non-fatal — subscription is in grace period; push a heads-up
      console.log(`[rc-webhook] Billing issue for uid:${firebaseUid}`);
      const userSnap = await userRef.get();
      const fcmToken = userSnap.exists ? userSnap.data().fcm_token : null;
      if (fcmToken) {
        _sendFCM(firebaseUid, fcmToken, {
          title: 'Payment issue with your subscription',
          body:  'Please update your payment method to keep FlowCheck Pro active.',
          type:  'billing_issue',
          data:  {},
        }).catch(() => {});
      }

    } else if (type === 'CANCELLATION') {
      // User cancelled but may still be in their paid period — don't revoke yet.
      // EXPIRATION fires when access actually ends.
      await userRef.set({ pro_cancel_at_period_end: true, pro_updated_at: TS() }, { merge: true });
      console.log(`[rc-webhook] Cancellation noted for uid:${firebaseUid} — still active until expiry`);

    } else {
      console.log(`[rc-webhook] Ignored event type: ${type}`);
    }

  } catch (err) {
    console.error('[rc-webhook] Error processing event:', err.message);
    // Return 200 anyway — RevenueCat retries on non-2xx, causing duplicate writes
    return res.json({ ok: true, error: err.message });
  }

  res.json({ ok: true });
});

/* ─────────────────────────────────────────────────────────────
   PROCESS-LEVEL ERROR GUARDS
   ─────────────────────────────────────────────────────────────
   Prevent unhandled promise rejections and uncaught exceptions
   from silently crashing the process in production.
   ─────────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled promise rejection:', reason);
  if (process.env.SENTRY_DSN) Sentry.captureException(reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
  if (process.env.SENTRY_DSN) Sentry.captureException(err);
  // For truly unexpected errors, exit cleanly so Railway restarts the process.
  process.exit(1);
});

/* ─────────────────────────────────────────────────────────────
   START SERVER — with graceful shutdown
   ─────────────────────────────────────────────────────────────
   Railway sends SIGTERM before replacing this process during a
   redeploy. We stop accepting new connections and let in-flight
   requests finish (up to 10 s) before exiting cleanly.
   ─────────────────────────────────────────────────────────────── */
const PORT = parseInt(process.env.PORT) || 8080;
const server = app.listen(PORT, '0.0.0.0', () => console.log(`[Boot] Listening on :${PORT}`));

function _gracefulShutdown(signal) {
  console.log(`[Shutdown] ${signal} received — draining connections…`);
  server.close((err) => {
    if (err) console.error('[Shutdown] Error closing server:', err.message);
    console.log('[Shutdown] Server closed — exiting');
    process.exit(err ? 1 : 0);
  });
  // Force-exit after 10 s if connections haven't drained
  setTimeout(() => {
    console.error('[Shutdown] Drain timeout — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));
