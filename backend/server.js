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
 * ─────────────────────────────────────────────────────────────
 */

'use strict';
require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const admin     = require('firebase-admin');
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

/* ── Express ─────────────────────────────────────────────────── */
const app = express();
// Capacitor iOS apps use 'capacitor://localhost' or null origin.
// We also allow the Railway preview URL for testing.
const ALLOWED_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'http://localhost:3000',
  'https://flowcheck-backend-production.up.railway.app',
];
app.use(cors({
  origin: (origin, cb) => {
    // Native apps send no origin header — allow null/undefined
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin not allowed — ${origin}`));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '64kb' })); // Cap request body size

/* ── Rate limiting ───────────────────────────────────────────── */
// General: 120 requests / 15 min per IP
const generalLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             120,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { message: 'Too many requests — try again later' },
});

// Strict: 10 requests / 15 min — protects Plaid-cost endpoints
const strictLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { message: 'Too many requests — try again later' },
});

app.use('/health',                generalLimiter);
app.use('/plaid/link-token',      strictLimiter);
app.use('/plaid/exchange-token',  strictLimiter);
app.use('/plaid/sync',            generalLimiter);
app.use('/plaid/disconnect',      strictLimiter);
app.use('/user/account',          strictLimiter);

/* ── Firebase auth middleware ────────────────────────────────── */
async function requireAuth(req, res, next) {
  const header = (req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const decoded = await admin.auth().verifyIdToken(header.slice(7));
    req.uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ message: 'Invalid token' });
  }
}

/* ── Health check ────────────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ ok: true, plaidEnv }));

/* ─────────────────────────────────────────────────────────────
   POST /plaid/link-token
   ───────────────────────────────────────────────────────────── */
app.post('/plaid/link-token', requireAuth, async (req, res) => {
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
app.post('/plaid/exchange-token', requireAuth, async (req, res) => {
  const { public_token, metadata } = req.body;
  if (!public_token) return res.status(400).json({ message: 'public_token required' });

  try {
    const { data } = await plaid.itemPublicTokenExchange({ public_token });

    // access_token stored server-side only — never sent to client
    await db.collection('plaid_items').doc(req.uid).set({
      access_token:   data.access_token,
      item_id:        data.item_id,
      institution:    metadata?.institution?.name || '',
      institution_id: metadata?.institution?.institution_id || '',
      env:            plaidEnv,
      linked_at:      admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[exchange] uid:${req.uid} linked → ${data.item_id}`);
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
app.get('/plaid/sync', requireAuth, async (req, res) => {
  try {
    const itemSnap = await db.collection('plaid_items').doc(req.uid).get();
    if (!itemSnap.exists) return res.status(404).json({ message: 'No linked account' });
    const { access_token } = itemSnap.data();

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
    }));

    /* Transactions — paginate through all results */
    const now   = new Date();
    const start = new Date(+now - 90 * 864e5);
    const fmt   = d => d.toISOString().slice(0, 10);

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

    /* Write to Firestore in batches of 400 */
    const userRef = db.collection('users').doc(req.uid);
    const TS      = admin.firestore.FieldValue.serverTimestamp;

    // Accounts
    let batch = db.batch();
    accounts.forEach(a => {
      batch.set(userRef.collection('accounts').doc(a.id), { ...a, updated_at: TS() }, { merge: true });
    });
    await batch.commit();

    // Transactions
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

    await userRef.update({ last_synced: TS() });
    console.log(`[sync] uid:${req.uid} → ${accounts.length} accounts, ${allTxns.length} txns`);
    res.json({ accounts: accounts.length, transactions: allTxns.length });
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
  const uid = req.uid;
  try {
    const itemRef  = db.collection('plaid_items').doc(uid);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) {
      return res.status(404).json({ message: 'No linked account found' });
    }
    const { access_token } = itemSnap.data();

    // Revoke at Plaid — best-effort, clean up our data regardless
    try {
      await plaid.itemRemove({ access_token });
      console.log(`[disconnect] uid:${uid} Plaid item revoked`);
    } catch (plaidErr) {
      console.error(`[disconnect] uid:${uid} Plaid revoke failed (continuing cleanup):`, plaidErr.message);
    }

    // Delete plaid_items doc (access_token gone from DB)
    await itemRef.delete();

    // Wipe all financial subcollections (paginated for large datasets)
    const userRef = db.collection('users').doc(uid);
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

    console.log(`[disconnect] uid:${uid} fully disconnected`);
    res.json({ success: true });
  } catch (err) {
    console.error('[disconnect]', err.message);
    res.status(500).json({ message: err.message });
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
    // 1. Revoke Plaid if linked
    const itemSnap = await db.collection('plaid_items').doc(uid).get();
    if (itemSnap.exists) {
      try {
        await plaid.itemRemove({ access_token: itemSnap.data().access_token });
      } catch (_) { /* best-effort */ }
      await db.collection('plaid_items').doc(uid).delete();
    }

    // 2. Delete all Firestore subcollections
    const userRef = db.collection('users').doc(uid);
    for (const sub of ['accounts', 'transactions', 'goals', 'budgets', 'bills']) {
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
    res.status(500).json({ message: err.message });
  }
});

const PORT = parseInt(process.env.PORT) || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`[Boot] Listening on :${PORT}`));
