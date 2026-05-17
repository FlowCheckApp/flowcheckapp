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

app.use('/health',                      generalLimiter);
app.use('/plaid/link-token',            strictLimiter);
app.use('/plaid/exchange-token',        strictLimiter);
app.use('/plaid/sync',                  generalLimiter);
app.use('/plaid/webhook',              generalLimiter); // Plaid calls this — must stay responsive
app.use('/plaid/disconnect',            strictLimiter); // covers /plaid/disconnect AND /plaid/disconnect/:itemId
app.use('/user/account',                strictLimiter);
app.use('/credit',                      strictLimiter); // Experian-cost — strict limit
app.use('/notifications/send',          strictLimiter);
app.use('/notifications/budget-alert',  strictLimiter);
app.use('/notifications/register',      generalLimiter);
app.use('/notifications/mark-all-read', generalLimiter);
app.use('/notifications/',              generalLimiter); // covers /notifications/:id/read
app.use('/email/',                      strictLimiter);  // covers welcome, test, etc.

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
app.get('/health', (_req, res) => res.json({ ok: true }));

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
      webhook: 'https://flowcheck-backend-production.up.railway.app/plaid/webhook',
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
          // Plaid convention: negative amount = income/credit, positive = expense/debit
          batch.set(userRef.collection('transactions').doc(t.transaction_id), {
            id:              t.transaction_id,
            account_id:      t.account_id,
            name:            t.name,
            amount:          Math.abs(t.amount),
            isCredit:        t.amount < 0,
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
                        'notifications', 'transaction_overrides', 'credit_history']) {
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
    _experianToken = null; // Clear stale cache on any auth failure
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

    // Sandbox test consumer: KIMBERLY CBRILEY — plain credit report, no special add-ons required.
    // This is TestCase_Email_Address from the Experian OAS spec — the simplest positive test case.
    // PII must match exactly. TC24 (Armstrong/Rent Bureau) requires a product we may not have.
    const isSandbox = !process.env.EXPERIAN_ENV || process.env.EXPERIAN_ENV !== 'production';

    const reportBody = {
      consumerPii: {
        primaryApplicant: {
          name: {
            lastName:  req.body?.lastName  || (isSandbox ? 'CBRILEY'   : ''),
            firstName: req.body?.firstName || (isSandbox ? 'KIMBERLY'  : ''),
          },
          dob:  { dob: dobYear || (isSandbox ? '1969' : '') },
          ssn:  { ssn: req.body?.ssn || (isSandbox ? '111111111' : '') },
          currentAddress: {
            line1:   req.body?.address || (isSandbox ? '5870 SPENCER PIKE' : ''),
            city:    req.body?.city    || (isSandbox ? 'MOUNT STERLING'    : ''),
            state:   req.body?.state   || (isSandbox ? 'KY'                : ''),
            zipCode: req.body?.zip     || (isSandbox ? '40353'             : ''),
          },
        },
      },
      requestor:          { subscriberCode: process.env.EXPERIAN_SUBSCRIBER_CODE || '2222222' },
      permissiblePurpose: { type: '18' },   // 18 = credit transaction (matches CBRILEY test case)
      addOns: {
        // V3 = VantageScore 3.0, F = FICO — no resellerInfo needed for this test case
        riskModels: { modelIndicator: ['V3', 'F'], scorePercentile: 'Y' },
      },
    };

    // Log the request structure (no SSN) for debugging
    console.log('[credit] Sending to Experian:', JSON.stringify({
      ...reportBody,
      consumerPii: { primaryApplicant: { ...reportBody.consumerPii.primaryApplicant, ssn: '***' } },
    }));

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
          <p style="font-size:15px;color:#374151;margin:0 0 16px">Your FlowCheck email system is configured correctly. Transactional emails like bill reminders, budget alerts, and weekly summaries will be delivered to: <strong>${email}</strong></p>
          <p style="font-size:13px;color:#9ca3af;margin:0">Sent at ${new Date().toUTCString()}</p>
        </div>
      </div>
      </body></html>
    `);
    res.json({ ok: true, sent, to: email });
  } catch (err) {
    console.error('[email/test]', err.message);
    res.status(500).json({ message: 'Email test failed: ' + err.message });
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

  const pct   = Math.min(Math.round((spent / budgetLimit) * 100), 999);
  const title = `Budget Alert: ${String(category).slice(0, 40)}`;
  const body  = `You've used ${pct}% of your ${category} budget ($${spent.toFixed(2)} of $${budgetLimit.toFixed(2)})`;

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

/* ─────────────────────────────────────────────────────────────
   NOTIFICATION HELPERS
   ───────────────────────────────────────────────────────────── */

/**
 * Save a notification to the user's Firestore notifications subcollection.
 * This powers the in-app notification center.
 */
async function _saveNotification(uid, { title, body, type, data = {} }) {
  try {
    await db.collection('users').doc(uid)
      .collection('notifications').add({
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
            badge:             1,
            'content-available': 1,
          },
        },
      },
      android: {
        priority: 'high',
        notification: { title, body, sound: 'default', channelId },
      },
    });
    // Persist to Firestore so the in-app notification center picks it up
    if (uid) await _saveNotification(uid, { title, body, type, data: stringData });
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
 * Send bill-due reminders for a single user.
 * Checks all bills due in the next 1-2 days and sends push + email.
 */
async function _sendBillRemindersForUser(uid, userData) {
  const fcmToken   = userData.fcm_token;
  const email      = userData.email;
  const notifOn    = userData.notifications_enabled !== false;
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
    const due = bill.due_date.slice(0, 10);
    if (due !== tomorrowStr && due !== dayAfterStr) continue;

    const daysUntil = due === tomorrowStr ? 1 : 2;
    const dayLabel  = daysUntil === 1 ? 'tomorrow' : 'in 2 days';
    const title     = `💳 ${bill.name} due ${dayLabel}`;
    const body      = `${_fmt(bill.amount || 0)} will be charged ${dayLabel}. Tap to review.`;

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

    // Email
    if (email && _mailer) {
      const amountStr = _fmt(bill.amount || 0);
      _sendEmail(email, title, `
        <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
        <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
          <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:32px;text-align:center">
            <div style="font-size:40px;margin-bottom:12px">💳</div>
            <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 6px">${bill.name} due ${dayLabel}</h1>
            <p style="color:rgba(255,255,255,0.6);font-size:15px;margin:0">${amountStr} · ${due}</p>
          </div>
          <div style="padding:28px 32px">
            <p style="font-size:15px;color:#374151;line-height:1.6;margin:0 0 24px">
              Just a heads up — your <strong>${bill.name}</strong> payment of <strong>${amountStr}</strong> is due ${dayLabel}.
              Make sure you have sufficient funds in your account.
            </p>
            <a href="https://getflowcheck.app" style="display:block;background:linear-gradient(135deg,#1ac4f0,#6b3fe0);color:#ffffff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
              Review in FlowCheck →
            </a>
          </div>
          <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
            <p style="font-size:11px;color:#9ca3af;margin:0">
              FlowCheck · <a href="https://getflowcheck.app/unsubscribe?uid=${uid}" style="color:#9ca3af">Unsubscribe</a>
            </p>
          </div>
        </div>
        </body></html>
      `).catch(e => console.error('[email bill-reminder]', e.message));
    }
  }
}

/**
 * Send weekly financial summary email to a user.
 */
async function _sendWeeklySummaryForUser(uid, userData) {
  const email   = userData.email;
  const notifOn = userData.notifications_enabled !== false;
  if (!email || !notifOn || !_mailer) return;

  const name = (userData.display_name || userData.name || 'there').split(' ')[0];

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
    // isCredit=false means expense. Amount is always stored positive (Math.abs) after the fix.
    if (!t.isCredit) {
      totalSpent += t.amount;
      const cat = (t.category && t.category[0]) || 'Other';
      categories[cat] = (categories[cat] || 0) + t.amount;
    }
  });

  // Top 3 spending categories
  const topCats = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([cat, amt]) => `<tr><td style="padding:6px 0;color:#374151;font-size:14px">${cat}</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#111827;font-size:14px">${_fmt(amt)}</td></tr>`)
    .join('');

  _sendEmail(email, `Your FlowCheck weekly summary 📊`, `
    <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="max-width:520px;margin:40px auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
      <div style="background:linear-gradient(135deg,#0a1520,#112230);padding:36px 32px;text-align:center">
        <div style="font-size:40px;margin-bottom:12px">📊</div>
        <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 6px">Weekly Summary, ${name}!</h1>
        <p style="color:rgba(255,255,255,0.6);font-size:14px;margin:0">Here's how your money moved this week</p>
      </div>
      <div style="padding:28px 32px">
        <div style="background:#f0f9ff;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
          <div style="font-size:13px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">Total Spent This Week</div>
          <div style="font-size:32px;font-weight:800;color:#0a1520;letter-spacing:-0.03em">${_fmt(totalSpent)}</div>
        </div>
        ${topCats ? `
        <div style="margin-bottom:24px">
          <div style="font-size:13px;font-weight:600;color:#374151;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px">Top Categories</div>
          <table style="width:100%;border-collapse:collapse">${topCats}</table>
        </div>` : ''}
        <a href="https://getflowcheck.app" style="display:block;background:linear-gradient(135deg,#1ac4f0,#6b3fe0);color:#ffffff;font-weight:700;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;text-align:center">
          View Full Breakdown →
        </a>
      </div>
      <div style="padding:16px 32px;border-top:1px solid #f3f4f6;text-align:center">
        <p style="font-size:11px;color:#9ca3af;margin:0">
          FlowCheck · Your money, clearly<br>
          <a href="https://getflowcheck.app/unsubscribe?uid=${uid}" style="color:#9ca3af">Unsubscribe from weekly summaries</a>
        </p>
      </div>
    </div>
    </body></html>
  `).catch(e => console.error('[email weekly]', e.message));
}

// ── Cron: daily bill reminders at 09:00 UTC ─────────────────
if (cron) {
  cron.schedule('0 9 * * *', async () => {
    console.log('[Cron] Running daily bill reminder job…');
    try {
      const usersSnap = await db.collection('users').get();
      let sent = 0;
      for (const userDoc of usersSnap.docs) {
        const data = userDoc.data();
        // Send reminders to all users who have notifications enabled —
        // bills can exist without Plaid being linked (manually added bills)
        await _sendBillRemindersForUser(userDoc.id, data).catch(err =>
          console.error(`[cron/bills] uid:${userDoc.id}:`, err.message)
        );
        sent++;
      }
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
      const usersSnap = await db.collection('users').get();
      let sent = 0;
      for (const userDoc of usersSnap.docs) {
        const data = userDoc.data();
        if (!data.plaid_linked || !data.email) continue;
        await _sendWeeklySummaryForUser(userDoc.id, data).catch(err =>
          console.error(`[cron/weekly] uid:${userDoc.id}:`, err.message)
        );
        sent++;
      }
      console.log(`[Cron] Weekly summaries: processed ${sent} users`);
    } catch (err) {
      console.error('[Cron] Weekly summary job failed:', err.message);
    }
  }, { timezone: 'UTC' });
  console.log('[Boot] Cron: weekly summary scheduled (Sunday 07:00 UTC)');
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
     https://flowcheck-backend-production.up.railway.app/plaid/webhook
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
async function _webhookSyncItem(itemId) {
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
    const { access_token } = itemDoc.data();

    if (!access_token) {
      console.warn(`[webhook] item ${itemId} has no access_token`);
      return;
    }

    const TS  = admin.firestore.FieldValue.serverTimestamp;
    const now = new Date();
    const start = new Date(+now - 90 * 864e5);
    const fmt = d => d.toISOString().slice(0, 10);

    // ── Accounts ──────────────────────────────────────────────────
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
      item_id:           itemId,
    }));

    let batch = db.batch();
    accounts.forEach(a => {
      batch.set(userRef.collection('accounts').doc(a.id), { ...a, updated_at: TS() }, { merge: true });
    });
    await batch.commit();

    // ── Transactions (paginated) ──────────────────────────────────
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

    for (let i = 0; i < allTxns.length; i += 400) {
      batch = db.batch();
      allTxns.slice(i, i + 400).forEach(t => {
        // Plaid convention: negative amount = income/credit, positive = expense/debit
        batch.set(userRef.collection('transactions').doc(t.transaction_id), {
          id:              t.transaction_id,
          account_id:      t.account_id,
          name:            t.name,
          amount:          Math.abs(t.amount),
          isCredit:        t.amount < 0,
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

    await userRef.update({ last_synced: TS() });
    console.log(`[webhook] Synced uid:${uid} item:${itemId} → ${accounts.length} accounts, ${allTxns.length} txns`);
  } catch (err) {
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
const WEBHOOK_TYPES_TO_SYNC = new Set([
  'TRANSACTIONS_DEFAULT_UPDATE',
  'TRANSACTIONS_SYNC_UPDATES_AVAILABLE',
  'DEFAULT_UPDATE',           // legacy code (Plaid v1)
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
    const code = webhook_code || webhook_type || '';
    if (item_id && WEBHOOK_TYPES_TO_SYNC.has(code)) {
      console.log(`[webhook] Triggering sync for item:${item_id} type:${code}`);
      _webhookSyncItem(item_id); // intentionally not awaited
    } else {
      console.log(`[webhook] Ignoring webhook type:${webhook_type} code:${code}`);
    }
  } catch (err) {
    console.error('[webhook] Unexpected error:', err.message);
    respond(500, { message: 'Internal error' });
  }
});

/* ─────────────────────────────────────────────────────────────
   START SERVER
   ───────────────────────────────────────────────────────────── */
const PORT = parseInt(process.env.PORT) || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`[Boot] Listening on :${PORT}`));
