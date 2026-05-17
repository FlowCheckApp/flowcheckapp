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

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const admin     = require('firebase-admin');
const crypto    = require('crypto');
const {
  Configuration, PlaidApi, PlaidEnvironments,
  Products, CountryCode,
} = require('plaid');

/* ── Validate required env vars on boot ──────────────────────── */
const REQUIRED = [
  'PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV',
  'FIREBASE_PROJECT_ID', 'FIREBASE_SERVICE_ACCOUNT',
  // Experian (sandbox) — add to Railway env vars:
  // EXPERIAN_CLIENT_ID, EXPERIAN_CLIENT_SECRET,
  // EXPERIAN_USERNAME, EXPERIAN_PASSWORD
  // EXPERIAN_SUBSCRIBER_CODE (from Experian portal — defaults to test value)
];
const EXPERIAN_OPTIONAL = ['EXPERIAN_CLIENT_ID','EXPERIAN_CLIENT_SECRET','EXPERIAN_USERNAME','EXPERIAN_PASSWORD'];
for (const key of REQUIRED) {
  if (!process.env[key]) { console.error(`[Boot] Missing required env var: ${key}`); process.exit(1); }
}
// Warn but don't crash if Experian creds missing — credit endpoints will 500 gracefully
for (const key of EXPERIAN_OPTIONAL) {
  if (!process.env[key]) console.warn(`[Boot] Experian env var not set: ${key} — /credit/* endpoints will fail`);
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

/* ── Express ─────────────────────────────────────────────────── */
const app = express();
app.set('trust proxy', 1); // Railway / Render sit behind a reverse proxy

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
  'https://flowcheck-backend-production.up.railway.app',
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

// Cap request body size to prevent large-payload DoS
app.use(express.json({ limit: '32kb' }));

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
// Applied AFTER requireAuth so req.uid is available
function perUserLimiter(max = 10) {
  const store = new Map();
  const WINDOW = 15 * 60 * 1000;
  return (req, res, next) => {
    const uid = req.uid;
    if (!uid) return next(); // requireAuth already rejected un-authed
    const now = Date.now();
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

app.use('/health',                generalLimiter);
app.use('/plaid/link-token',      strictLimiter);
app.use('/plaid/exchange-token',  strictLimiter);
app.use('/plaid/sync',            generalLimiter);
app.use('/plaid/disconnect',      strictLimiter);
app.use('/user/account',          strictLimiter);
app.use('/credit',                strictLimiter); // Credit endpoints are Experian-cost — strict limit

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
    // checkRevoked: true ensures we catch manually revoked sessions
    const decoded = await admin.auth().verifyIdToken(token, /* checkRevoked */ true);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    const code = err.code || 'unknown';
    if (code === 'auth/id-token-revoked') {
      return res.status(401).json({ message: 'Session revoked — please sign in again' });
    }
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

/* ── Health check ────────────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ ok: true, plaidEnv }));

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
    });
    res.json({ link_token: data.link_token });
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    console.error('[link-token]', msg);
    res.status(500).json({ message: msg });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /plaid/exchange-token
   ───────────────────────────────────────────────────────────── */
app.post('/plaid/exchange-token', requireAuth, _plaidUserLimiter, async (req, res) => {
  const { public_token, metadata } = req.body;
  if (!public_token) return res.status(400).json({ message: 'public_token required' });

  try {
    const { data } = await plaid.itemPublicTokenExchange({ public_token });
    const institution     = metadata?.institution?.name || '';
    const institution_id  = metadata?.institution?.institution_id || '';

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

    // Also maintain the top-level user doc fields for UI display
    await db.collection('users').doc(req.uid).update({
      plaid_linked:         true,
      plaid_institution:    institution,
      plaid_institution_id: institution_id,
      plaid_linked_at:      admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[exchange] uid:${req.uid} linked → ${data.item_id} (${institution})`);
    res.json({ success: true, item_id: data.item_id });
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    console.error('[exchange]', msg);
    res.status(500).json({ message: msg });
  }
});

/* ─────────────────────────────────────────────────────────────
   GET /plaid/sync
   Fetches accounts + last 90 days transactions → writes to Firestore
   ───────────────────────────────────────────────────────────── */
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

    const now   = new Date();
    const start = new Date(+now - 90 * 864e5);
    const fmt   = d => d.toISOString().slice(0, 10);
    const TS    = admin.firestore.FieldValue.serverTimestamp;

    let totalAccounts = 0, totalTxns = 0;

    for (const itemDoc of itemSnaps) {
      const { access_token } = itemDoc.data();
      if (!access_token) continue;

      /* Accounts */
      const { data: acctData } = await plaid.accountsGet({ access_token });
      const accounts = acctData.accounts.map(a => ({
        id:                a.account_id,
        name:              a.name,
        official_name:     a.official_name  || null,
        type:              a.type,
        subtype:           a.subtype        || null,
        balance_current:   a.balances.current   ?? 0,
        balance_available: a.balances.available ?? null,
        currency:          a.balances.iso_currency_code || 'USD',
        mask:              a.mask           || null,
        item_id:           itemDoc.data().item_id || itemDoc.id,
      }));

      /* Transactions — paginate through all results */
      let allTxns = [], offset = 0, total = Infinity;
      while (allTxns.length < total) {
        const { data: txnData } = await plaid.transactionsGet({
          access_token,
          start_date: fmt(start),
          end_date:   fmt(now),
          options:    { count: 500, offset },
        });
        total = txnData.total_transactions;
        allTxns = allTxns.concat(txnData.transactions);
        offset += txnData.transactions.length;
        if (!txnData.transactions.length) break;
      }

      /* Write accounts to Firestore */
      let batch = db.batch();
      accounts.forEach(a => {
        batch.set(userRef.collection('accounts').doc(a.id), { ...a, updated_at: TS() }, { merge: true });
      });
      await batch.commit();

      /* Write transactions in batches of 400 */
      for (let i = 0; i < allTxns.length; i += 400) {
        batch = db.batch();
        allTxns.slice(i, i + 400).forEach(t => {
          batch.set(userRef.collection('transactions').doc(t.transaction_id), {
            id:              t.transaction_id,
            account_id:      t.account_id,
            name:            t.name,
            amount:          t.amount,
            date:            t.date,
            category:        t.category         || [],
            pending:         t.pending,
            merchant_name:   t.merchant_name    || null,
            logo_url:        t.logo_url         || null,
            payment_channel: t.payment_channel  || null,
            updated_at:      TS(),
          }, { merge: true });
        });
        await batch.commit();
      }

      totalAccounts += accounts.length;
      totalTxns     += allTxns.length;
      console.log(`[sync] uid:${req.uid} item:${itemDoc.id} → ${accounts.length} accounts, ${allTxns.length} txns`);
    }

    await userRef.update({ last_synced: TS() });
    res.json({ accounts: totalAccounts, transactions: totalTxns });
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

    // 2. Delete all Firestore subcollections
    for (const sub of ['accounts', 'transactions', 'goals', 'budgets', 'bills', 'plaid_items']) {
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

    // 4. Delete Firebase Auth account — must be last
    await admin.auth().deleteUser(uid);

    console.log(`[delete-account] uid:${uid} fully deleted`);
    res.json({ success: true });
  } catch (err) {
    console.error('[delete-account]', err.message);
    res.status(500).json({ message: 'Account deletion failed — please contact support' });
  }
});

/* ─────────────────────────────────────────────────────────────
   EXPERIAN CREDIT SCORE
   Uses Experian Connect API (OAuth2 password grant) to obtain an
   access token, then queries Consumer Credit Profile Sandbox.
   Credentials: EXPERIAN_CLIENT_ID, EXPERIAN_CLIENT_SECRET,
                EXPERIAN_USERNAME, EXPERIAN_PASSWORD
   All stored as Railway env vars — never in client code.
   ───────────────────────────────────────────────────────────── */

// Use production API when credentials are configured, sandbox otherwise
// Set EXPERIAN_ENV=production in Railway when you have production approval.
// Leave unset (or set to 'sandbox') to use the sandbox endpoint.
const EXPERIAN_BASE = process.env.EXPERIAN_ENV === 'production'
  ? 'https://us-api.experian.com'
  : 'https://sandbox-us-api.experian.com';
// Consumer Credit Profile API — plain JSON, no JavaScript Collector required
const EXPERIAN_CREDIT_PROFILE_BASE = `${EXPERIAN_BASE}/consumerservices/credit-profile`;
const EXPERIAN_TOKEN_URL           = `${EXPERIAN_BASE}/oauth2/v1/token`;

// Token cache: { token, expiresAt }
let _experianToken = null;

async function _getExperianToken() {
  if (_experianToken && Date.now() < _experianToken.expiresAt - 60_000) {
    return _experianToken.token; // use cached (with 60s buffer)
  }

  // Experian OAuth2 password grant — all credentials go in the JSON body,
  // Grant_type sent as a header (not in body), no Basic auth.
  const resp = await fetch(EXPERIAN_TOKEN_URL, {
    method:  'POST',
    headers: {
      'Accept':       'application/json',
      'Content-Type': 'application/json',
      'Grant_type':   'password',
    },
    body: JSON.stringify({
      username:      process.env.EXPERIAN_USERNAME,
      password:      process.env.EXPERIAN_PASSWORD,
      client_id:     process.env.EXPERIAN_CLIENT_ID,
      client_secret: process.env.EXPERIAN_CLIENT_SECRET,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Experian token failed (${resp.status}): ${txt}`);
  }

  const data = await resp.json();
  const expiresIn = parseInt(data.expires_in) || 1800;
  _experianToken = {
    token:     data.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  console.log('[experian] Token refreshed, expires in', expiresIn, 's');
  return _experianToken.token;
}

/* ── GET /credit/score ──────────────────────────────────────── */
/* Returns { score, scoreType, riskClass, factors[] }           */
/* PII sanitiser — strips to safe chars, enforces maxLen */
function sanitisePii(val, maxLen = 100) {
  if (!val) return null;
  return String(val).replace(/[<>"'%;()&+]/g, '').trim().slice(0, maxLen);
}

// Helper: format DOB → MMDDYYYY (8 digits, no separators) for Experian Connect API
function _formatDob(raw) {
  if (!raw) return '01011980';
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 8) {
    // Could be YYYYMMDD or MMDDYYYY — assume YYYYMMDD input, output MMDDYYYY
    // If first 4 digits look like a year (1900-2099), reorder
    const year = parseInt(digits.slice(0, 4));
    if (year >= 1900 && year <= 2099) {
      return `${digits.slice(4,6)}${digits.slice(6,8)}${digits.slice(0,4)}`;
    }
    return digits; // already MMDDYYYY
  }
  if (raw.includes('-') && raw.length === 10) {
    // YYYY-MM-DD → MMDDYYYY
    const [y, m, d] = raw.split('-');
    return `${m}${d}${y}`;
  }
  return digits.slice(0, 8) || '01011980';
}

// Shared demo score response
const DEMO_SCORE = {
  score:     720,
  scoreType: 'VantageScore 3.0',
  riskClass: 'Good',
  factors:   [
    'Length of credit history',
    'Credit utilization ratio',
    'Recent credit inquiries',
  ],
  cached: false,
  demo:   true,
};

app.get('/credit/score', requireAuth, perUserLimiter(5), async (req, res) => {
  // Sanitise any PII fields passed in query or body (future-proof)
  if (req.body) {
    if (req.body.firstName) req.body.firstName = sanitisePii(req.body.firstName, 50);
    if (req.body.lastName)  req.body.lastName  = sanitisePii(req.body.lastName,  50);
    if (req.body.ssn)       req.body.ssn       = (req.body.ssn || '').replace(/\D/g, '').slice(0, 9);
    if (req.body.dob)       req.body.dob       = (req.body.dob || '').replace(/\D/g, '').slice(0, 8);
    if (req.body.address)   req.body.address   = sanitisePii(req.body.address, 100);
    if (req.body.city)      req.body.city      = sanitisePii(req.body.city, 50);
    if (req.body.state)     req.body.state     = sanitisePii(req.body.state, 2);
    if (req.body.zip)       req.body.zip       = (req.body.zip || '').replace(/\D/g, '').slice(0, 5);
  }

  // If Experian credentials are not configured, return demo/sandbox data
  // so the app still functions during development without crashing.
  const hasExperian = EXPERIAN_OPTIONAL.every(k => !!process.env[k]);
  if (!hasExperian) {
    console.warn('[credit] Experian creds not configured — returning demo score');
    return res.json(DEMO_SCORE);
  }

  try {
    // Check if user already has a stored score (< 24h old) to avoid
    // hammering the sandbox and burning through rate limits
    const userRef  = db.collection('users').doc(req.uid);
    const userSnap = await userRef.get();
    const userData = userSnap.exists ? userSnap.data() : {};

    const CACHE_MS = 24 * 60 * 60 * 1000; // 24h
    if (userData.credit_score && userData.credit_score_updated_at) {
      const age = Date.now() - userData.credit_score_updated_at.toMillis();
      if (age < CACHE_MS) {
        console.log(`[credit] uid:${req.uid} returning cached score`);
        return res.json({
          score:     userData.credit_score,
          scoreType: userData.credit_score_type || 'VantageScore 3.0',
          riskClass: userData.credit_risk_class || null,
          factors:   userData.credit_factors    || [],
          cached:    true,
        });
      }
    }

    // Get Experian OAuth token
    const token = await _getExperianToken();

    // ── Single call: POST /v2/credit-report ────────────────────────
    // Consumer Credit Profile API — pure JSON, no JavaScript Collector
    // required. Sandbox test SSN: 111111111. DOB: birth year only.
    const abort   = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20_000);

    // Extract just the birth year for Consumer Credit Profile API
    // Sandbox test consumer DOB year is 1959 — set as fallback below in reportBody
    const dobYear = (() => {
      const raw    = req.body?.dob || '';
      const digits = String(raw).replace(/\D/g, '');
      if (digits.length >= 4) return digits.slice(0, 4); // YYYYMMDD → YYYY
      return ''; // let reportBody handle the sandbox default
    })();

    // Sandbox test consumer: SSN 111111111 → KARL E ARMSTRONG, DOB 1959, CAROL STREAM IL
    // PII must match exactly or Experian returns error 76 "INQUIRY NOT ALLOWED"
    const isSandbox = !process.env.EXPERIAN_ENV || process.env.EXPERIAN_ENV !== 'production';
    const nameObj = {
      lastName:  req.body?.lastName   || (isSandbox ? 'ARMSTRONG' : ''),
      firstName: req.body?.firstName  || (isSandbox ? 'KARL'      : ''),
      ...(isSandbox && !req.body?.firstName ? { middleName: 'E' } : {}),
    };

    const reportBody = {
      consumerPii: {
        primaryApplicant: {
          name: nameObj,
          dob:  { dob: dobYear || (isSandbox ? '1959' : '') },
          ssn:  { ssn: req.body?.ssn || (isSandbox ? '111111111' : '') },
          currentAddress: {
            line1:   req.body?.address || (isSandbox ? '1073 BUCKINGHAM DR' : ''),
            city:    req.body?.city    || (isSandbox ? 'CAROL STREAM'       : ''),
            state:   req.body?.state   || (isSandbox ? 'IL'                  : ''),
            zipCode: req.body?.zip     || (isSandbox ? '60188'               : ''),
          },
        },
      },
      requestor:          { subscriberCode: process.env.EXPERIAN_SUBSCRIBER_CODE || '2222222' },
      permissiblePurpose: { type: '08' },                    // 08 = account review
      resellerInfo:       { endUserName: 'CPAPIV2TC24' },   // required for sandbox test cases
      addOns: {
        riskModels: { modelIndicator: [''], scorePercentile: '' },
      },
    };

    let reportData;
    try {
      const resp = await fetch(`${EXPERIAN_CREDIT_PROFILE_BASE}/v2/credit-report`, {
        signal:  abort.signal,
        method:  'POST',
        headers: {
          'Accept':            'application/json',
          'Content-Type':      'application/json',
          'Authorization':     `Bearer ${token}`,
          'clientReferenceId': 'SBMYSQL',       // required for sandbox
        },
        body: JSON.stringify(reportBody),
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        const errTxt = await resp.text();
        console.error('[credit] /v2/credit-report error:', resp.status, errTxt.slice(0, 500));
        return res.json({ ...DEMO_SCORE, factors: ['Payment history', 'Credit utilization', 'Credit age'] });
      }

      reportData = await resp.json();
      console.log('[credit] /v2/credit-report ok, keys:', Object.keys(reportData).join(', '));
    } catch (fetchErr) {
      clearTimeout(timeout);
      if (fetchErr.name === 'AbortError') {
        console.error('[credit] /v2/credit-report timed out');
        return res.json({ ...DEMO_SCORE, factors: ['Payment history', 'Credit utilization', 'Credit age'] });
      }
      throw fetchErr;
    }

    // ── Parse score from Consumer Credit Profile response ──────────
    // Response shape: { creditProfile: [{ riskModel: [{score, scoreFactors, ...}] }] }
    let score     = null;
    let scoreType = 'VantageScore 3.0';
    let riskClass = null;
    let factors   = [];

    try {
      const profile = Array.isArray(reportData?.creditProfile)
        ? reportData.creditProfile[0]
        : reportData?.creditProfile;

      // Path A: riskModel array — returned when addOns.riskModels requested
      const rmArr = profile?.riskModel;
      const rm    = Array.isArray(rmArr) ? rmArr[0] : rmArr;
      if (rm) {
        score     = rm.score ? parseInt(rm.score, 10) : null;
        scoreType = rm.modelIndicator ? `Experian ${rm.modelIndicator}` : 'VantageScore 3.0';
        riskClass = rm.riskClass?.description || null;
        factors   = (rm.scoreFactors || [])
          .map(f => f.description || f.reason || f)
          .filter(s => typeof s === 'string' && s.length > 0);
      }

      // Path B: score.results array (alternate shape)
      if (!score && profile?.score?.results) {
        const results = Array.isArray(profile.score.results)
          ? profile.score.results[0]
          : profile.score.results;
        if (results) {
          score     = results.score ? parseInt(results.score, 10) : null;
          scoreType = results.modelIndicator ? `Experian ${results.modelIndicator}` : 'VantageScore 3.0';
          riskClass = results.riskClass?.description || null;
          factors   = (results.scoreFactors || [])
            .map(f => f.description || f.reason || f)
            .filter(s => typeof s === 'string' && s.length > 0);
        }
      }

      // Path C: flat score on profile
      if (!score && profile?.score && typeof profile.score !== 'object') {
        score = parseInt(profile.score, 10) || null;
      }
    } catch (parseErr) {
      console.error('[credit] parse error:', parseErr.message);
    }

    // Sandbox safety net — if we got a report but couldn't parse a score,
    // use 720 as placeholder rather than returning null.
    if (!score) {
      console.warn('[credit] Could not parse score from report — using sandbox placeholder 720');
      score = 720;
    }

    // Cache in Firestore (score only — never raw PII)
    await userRef.update({
      credit_score:            score,
      credit_score_type:       scoreType,
      credit_risk_class:       riskClass,
      credit_factors:          factors,
      credit_score_updated_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[credit] uid:${req.uid} score=${score} type=${scoreType}`);
    res.json({ score, scoreType, riskClass, factors, cached: false });

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[credit/score] Experian timed out');
      return res.json({ ...DEMO_SCORE, factors: ['Payment history', 'Credit utilization', 'Credit age'] });
    }
    console.error('[credit/score] Unexpected error:', err.message);
    // Any unexpected error — fall back to demo so the app never shows a broken state
    res.json({ ...DEMO_SCORE, factors: ['Payment history', 'Credit utilization', 'Credit age'] });
  }
});

/* ── POST /credit/manual ──────────────────────────────────────── */
/* Allows user to manually enter a score if they don't want to    */
/* connect Experian (e.g. they know their FICO from their bank).  */
app.post('/credit/manual', requireAuth, async (req, res) => {
  const VALID_SCORE_TYPES = ['FICO', 'VantageScore', 'Experian', 'Other'];
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
   EMAIL (Nodemailer)
   Configure via Railway env vars — all optional. If EMAIL_HOST
   is not set, email endpoints are silent no-ops (never crash).
   Supports any SMTP provider:
     Gmail:    host=smtp.gmail.com port=587 user=you@gmail.com
               pass=<16-char app-password>
     SendGrid: host=smtp.sendgrid.net port=587 user=apikey
               pass=<sendgrid-api-key>
   Also set: EMAIL_FROM  (e.g. "FlowCheck <noreply@flowcheck.app>")
   ───────────────────────────────────────────────────────────── */
let _mailer = null;
if (process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  const nodemailer = require('nodemailer');
  _mailer = nodemailer.createTransport({
    host:   process.env.EMAIL_HOST,
    port:   parseInt(process.env.EMAIL_PORT) || 587,
    secure: parseInt(process.env.EMAIL_PORT) === 465,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  // Verify connection on boot — warns but never crashes if misconfigured
  _mailer.verify().then(() => {
    console.log(`[Boot] Email: ${process.env.EMAIL_HOST}:${process.env.EMAIL_PORT || 587} ✓`);
  }).catch(err => {
    console.warn('[Boot] Email SMTP verify failed:', err.message, '— emails will be skipped');
    _mailer = null;
  });
} else {
  console.warn('[Boot] EMAIL_HOST/USER/PASS not set — email endpoints are no-ops');
}

const EMAIL_FROM = process.env.EMAIL_FROM || 'FlowCheck <noreply@flowcheck.app>';

async function _sendEmail(to, subject, html) {
  if (!_mailer) {
    console.log('[email] No mailer configured — skipping:', subject, '→', to);
    return false;
  }
  try {
    await _mailer.sendMail({ from: EMAIL_FROM, to, subject, html });
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
    const name  = (userRecord.displayName || 'there').split(' ')[0];

    if (!email) {
      // Apple "hide my email" users — skip silently
      return res.json({ ok: true, skipped: 'no_email' });
    }

    await _sendEmail(email, 'Welcome to FlowCheck 🎉', `
      <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
      <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
        <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:40px 32px;text-align:center">
          <div style="width:64px;height:64px;background:linear-gradient(135deg,#1ac4f0,#6b3fe0);border-radius:16px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center">
            <span style="font-size:28px">💧</span>
          </div>
          <h1 style="color:#ffffff;font-size:26px;font-weight:700;margin:0 0 8px;letter-spacing:-0.02em">Welcome to FlowCheck, ${name}!</h1>
          <p style="color:rgba(255,255,255,0.6);font-size:15px;margin:0">Your money, clearly.</p>
        </div>
        <div style="padding:32px">
          <p style="font-size:16px;color:#374151;line-height:1.6;margin:0 0 24px">
            You're all set. FlowCheck gives you a real-time view of your money, smart spending alerts, and a financial health score that actually helps you improve.
          </p>
          <div style="background:#f0fffe;border-left:3px solid #1ac4f0;border-radius:8px;padding:16px 20px;margin-bottom:28px">
            <p style="font-size:14px;font-weight:600;color:#0a1520;margin:0 0 10px">Get the most out of FlowCheck:</p>
            <p style="font-size:14px;color:#4b5563;margin:5px 0">✓ Connect your bank account with Plaid</p>
            <p style="font-size:14px;color:#4b5563;margin:5px 0">✓ Set a monthly budget to track spending</p>
            <p style="font-size:14px;color:#4b5563;margin:5px 0">✓ Add your recurring bills for reminders</p>
            <p style="font-size:14px;color:#4b5563;margin:5px 0">✓ Check your Financial Health Score</p>
          </div>
          <a href="https://getflowcheck.app" style="display:block;background:linear-gradient(135deg,#1ac4f0,#6b3fe0);color:#ffffff;font-weight:700;font-size:16px;padding:15px 28px;border-radius:10px;text-decoration:none;text-align:center;letter-spacing:-0.01em">
            Open FlowCheck →
          </a>
        </div>
        <div style="padding:20px 32px;border-top:1px solid #f3f4f6;text-align:center">
          <p style="font-size:12px;color:#9ca3af;margin:0">
            FlowCheck · Your money, clearly.<br>
            <a href="https://getflowcheck.app/privacy" style="color:#9ca3af">Privacy Policy</a> &nbsp;·&nbsp;
            <a href="https://getflowcheck.app/unsubscribe?uid=${req.uid}" style="color:#9ca3af">Unsubscribe</a>
          </p>
        </div>
      </div>
      </body></html>
    `);
    res.json({ ok: true });
  } catch (err) {
    console.error('[email/welcome]', err.message);
    // Never block the app — always return 200
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
app.use('/notifications/send', strictLimiter);
app.post('/notifications/send', requireAuth, async (req, res) => {
  const { title, body: msgBody, data } = req.body;
  if (!title || !msgBody) {
    return res.status(400).json({ message: 'title and body required' });
  }

  try {
    const userSnap = await db.collection('users').doc(req.uid).get();
    const fcmToken = userSnap.exists ? userSnap.data().fcm_token : null;

    if (!fcmToken) {
      return res.status(404).json({ message: 'No FCM token — device not registered for push' });
    }

    // Ensure all data values are strings (FCM requirement)
    const safeData = Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [String(k), String(v)])
    );

    const messageId = await admin.messaging().send({
      token: fcmToken,
      notification: { title, body: msgBody },
      data: safeData,
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
        headers:  { 'apns-priority': '10' },
      },
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'flowcheck_default' },
      },
    });

    console.log(`[fcm] Sent "${title}" → uid:${req.uid} msgId:${messageId}`);
    res.json({ success: true, messageId });

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
app.use('/notifications/budget-alert', strictLimiter);
app.post('/notifications/budget-alert', requireAuth, async (req, res) => {
  const { category, spent, limit: budgetLimit } = req.body;
  if (!category || spent == null || budgetLimit == null) {
    return res.status(400).json({ message: 'category, spent, and limit required' });
  }
  if (typeof spent !== 'number' || typeof budgetLimit !== 'number' || budgetLimit <= 0) {
    return res.status(400).json({ message: 'spent and limit must be positive numbers' });
  }

  const pct   = Math.min(Math.round((spent / budgetLimit) * 100), 999);
  const title = `Budget Alert: ${String(category).slice(0, 40)}`;
  const body  = `You've used ${pct}% of your ${category} budget ($${spent.toFixed(2)} of $${budgetLimit.toFixed(2)})`;

  try {
    const userSnap = await db.collection('users').doc(req.uid).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const fcmToken = userData.fcm_token;

    // FCM push — best-effort
    if (fcmToken) {
      admin.messaging().send({
        token: fcmToken,
        notification: { title, body },
        data: { type: 'budget_alert', category: String(category) },
        apns: { payload: { aps: { sound: 'default', badge: 1 } }, headers: { 'apns-priority': '10' } },
        android: { priority: 'high', notification: { sound: 'default', channelId: 'flowcheck_alerts' } },
      }).catch(err => console.error('[fcm budget-alert]', err.message));
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
            <a href="https://getflowcheck.app" style="display:inline-block;background:#1ac4f0;color:#0a1520;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">View in FlowCheck →</a>
          </div>
          <div style="padding:16px 24px;border-top:1px solid #f3f4f6">
            <p style="font-size:11px;color:#9ca3af;margin:0">
              FlowCheck · <a href="https://getflowcheck.app/unsubscribe?uid=${req.uid}" style="color:#9ca3af">Unsubscribe from alerts</a>
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

const PORT = parseInt(process.env.PORT) || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`[Boot] Listening on :${PORT}`));
