/**
 * FlowCheck — Referral System
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount in server.js with:
 *   const referralRouter = require('./referral');
 *   app.use('/api/referral', referralRouter);
 *
 * Firestore structure:
 *   /referrals/{code}          — { uid, created_at, activations: 0, lifetime_pro: false }
 *   /users/{uid}               — gets fields: referral_code, referred_by_code,
 *                                referred_by_uid, referral_activations,
 *                                pro, is_pro, pro_expires_at (already exists),
 *                                referral_pro_months_earned
 *
 * Reward logic:
 *   - Referred user connects first bank → both referrer + referred get 1 free Pro month
 *   - Referrer reaches 3 activations → lifetime Pro (referral_lifetime_pro = true)
 *
 * All routes require Firebase ID token in Authorization header.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

// Expect admin and db to be injected via module.exports pattern
// server.js calls: require('./referral')(admin, db)

module.exports = function makeReferralRouter(admin, db) {

  // ── Middleware: verify Firebase ID token ──────────────────────────────────
  async function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing auth token' });
    }
    const token = header.slice(7);
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      req.uid = decoded.uid;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid auth token' });
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Derive the canonical referral code for a uid.
   * Format: FLOW + first 6 alphanumeric chars of uid, uppercase.
   * e.g. uid "abc123xyz" → "FLOWABC123"
   *
   * Matches the client-side _getReferralCode() in fc-app.js so codes
   * displayed in the UI and codes validated here are always identical.
   */
  function generateCode(uid) {
    return 'FLOW' + uid.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
  }

  /**
   * Add Pro months to a user. Stacks on top of any existing pro_expires_at.
   * @param {FirebaseFirestore.Transaction} trx
   * @param {string} uid
   * @param {number} months  Number of Pro months to credit
   */
  async function grantProMonths(trx, uid, months) {
    const userRef = db.collection('users').doc(uid);
    const userSnap = await trx.get(userRef);
    if (!userSnap.exists) return;

    const data = userSnap.data();
    const now = new Date();

    // Start from the later of now or the existing expiry
    const currentExpiry = data.pro_expires_at
      ? (data.pro_expires_at.toDate ? data.pro_expires_at.toDate() : new Date(data.pro_expires_at))
      : now;

    const base = currentExpiry > now ? currentExpiry : now;
    const newExpiry = new Date(base);
    newExpiry.setMonth(newExpiry.getMonth() + months);

    trx.update(userRef, {
      pro: true,
      is_pro: true,
      pro_expires_at: admin.firestore.Timestamp.fromDate(newExpiry),
      referral_pro_months_earned: admin.firestore.FieldValue.increment(months),
    });
  }

  // ── POST /api/referral/generate ───────────────────────────────────────────
  // Generate (or return existing) referral code for the authenticated user.
  router.post('/generate', requireAuth, async (req, res) => {
    const uid = req.uid;
    const userRef = db.collection('users').doc(uid);

    try {
      // Return existing code if already generated.
      // Use get() first — cheap read, avoids unnecessary writes.
      const userSnap = await userRef.get();

      if (userSnap.exists) {
        const existing = userSnap.data().referral_code;
        if (existing) return res.json({ code: existing });
      }
      // User doc may not exist yet during fresh signup — there's a race between
      // the client calling /generate and the client-side user-doc create committing.
      // We upsert with merge:true so we don't clobber any fields that DID commit.

      // Derive deterministic code from uid — same algorithm as the client
      const code = generateCode(uid);
      const now  = admin.firestore.FieldValue.serverTimestamp();

      // Atomic write: index doc in referrals/ + upsert code on user
      const batch = db.batch();
      batch.set(db.collection('referrals').doc(code), {
        uid,
        created_at:   now,
        activations:  0,
        lifetime_pro: false,
      }, { merge: true }); // idempotent — safe to call twice
      // Use set+merge instead of update so this succeeds even if user doc
      // hasn't been created yet (race during fresh signup).
      batch.set(userRef, { referral_code: code }, { merge: true });

      await batch.commit();

      return res.json({ code });
    } catch (err) {
      console.error('[referral/generate]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── POST /api/referral/apply ──────────────────────────────────────────────
  // Apply a referral code at signup (before or just after bank connection).
  // Safe to call multiple times — idempotent.
  router.post('/apply', requireAuth, async (req, res) => {
    const uid = req.uid;
    const { code } = req.body;

    // Accept both legacy backend format (FLOW-XXXXX) and current client
    // format (FLOWXXXXXX — FLOW + 6 alphanumeric chars, no dash).
    if (!code || typeof code !== 'string' || !/^FLOW[A-Z0-9]{4,8}$|^FLOW-[A-Z0-9]{5}$/.test(code)) {
      return res.status(400).json({ error: 'Invalid code format' });
    }

    const upperCode = code.toUpperCase();

    try {
      const userRef = db.collection('users').doc(uid);

      // ── Resolve referrer uid from the code ───────────────────────
      // Primary:  referrals/{code} index doc (written by /generate)
      // Fallback: query users where referral_code == code
      //           (covers client-side codes never passed through /generate)
      let referrerUid = null;

      const referralRef  = db.collection('referrals').doc(upperCode);
      const referralSnap = await referralRef.get();

      if (referralSnap.exists) {
        referrerUid = referralSnap.data().uid;
      } else {
        // Fallback: find the user who owns this code
        const q = await db.collection('users')
          .where('referral_code', '==', upperCode)
          .limit(1)
          .get();
        if (!q.empty) {
          referrerUid = q.docs[0].id;
          // Back-fill the referrals/ index so future lookups are O(1)
          referralRef.set({
            uid:          referrerUid,
            created_at:   admin.firestore.FieldValue.serverTimestamp(),
            activations:  0,
            lifetime_pro: false,
          }).catch(() => {});
        }
      }

      if (!referrerUid) return res.status(404).json({ error: 'Code not found' });

      const userSnap = await userRef.get();
      if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

      // Prevent self-referral
      if (referrerUid === uid) return res.status(400).json({ error: 'Cannot use your own code' });

      // Already applied
      const userData = userSnap.data();
      if (userData.referred_by_code) {
        return res.json({ status: 'already_applied', code: userData.referred_by_code });
      }

      // Save referral metadata on the new user (reward fires on first bank connection)
      await userRef.update({
        referred_by_code:    upperCode,
        referred_by_uid:     referrerUid,
        referral_applied_at: admin.firestore.FieldValue.serverTimestamp(),
        referral_activated:  false,
      });

      return res.json({ status: 'applied' });
    } catch (err) {
      console.error('[referral/apply]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── POST /api/referral/activate ───────────────────────────────────────────
  // Call this from the Plaid token-exchange flow AFTER a user successfully
  // connects their first bank account. Awards 1 free Pro month to both sides.
  // This is called SERVER-SIDE from within the token exchange route,
  // not directly by the client.
  router.post('/activate', requireAuth, async (req, res) => {
    const uid = req.uid;

    try {
      const userRef  = db.collection('users').doc(uid);
      const userSnap = await userRef.get();

      if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

      const userData = userSnap.data();

      // No referral on this account, or already activated
      if (!userData.referred_by_code) return res.json({ status: 'no_referral' });
      if (userData.referral_activated) return res.json({ status: 'already_activated' });

      const referrerUid   = userData.referred_by_uid;
      const code          = userData.referred_by_code;
      const referralRef   = db.collection('referrals').doc(code);
      const referrerRef   = db.collection('users').doc(referrerUid);

      // Run in a transaction for atomicity.
      // IMPORTANT: Firestore requires ALL reads to happen before ANY writes.
      // We front-load every trx.get() call, then perform all trx.update() calls.
      await db.runTransaction(async (trx) => {
        // ── Phase 1: ALL reads ─────────────────────────────────
        const referralSnap = await trx.get(referralRef);
        if (!referralSnap.exists) return; // referral doc was deleted, skip

        const userSnapTrx     = await trx.get(userRef);
        const referrerSnapTrx = await trx.get(referrerRef);

        // ── Phase 2: compute, then ALL writes ─────────────────
        const newActivations = (referralSnap.data().activations || 0) + 1;
        const lifetimePro    = newActivations >= 3;

        // 1. Mark the referred user as activated
        trx.update(userRef, { referral_activated: true });

        // 1b. Grant 1 Pro month to the referred user (inline — avoids extra read)
        if (userSnapTrx.exists) {
          const data = userSnapTrx.data();
          const now  = new Date();
          const currentExpiry = data.pro_expires_at
            ? (data.pro_expires_at.toDate ? data.pro_expires_at.toDate() : new Date(data.pro_expires_at))
            : now;
          const base = currentExpiry > now ? currentExpiry : now;
          const newExpiry = new Date(base);
          newExpiry.setMonth(newExpiry.getMonth() + 1);
          trx.update(userRef, {
            pro: true,
            is_pro: true,
            pro_expires_at: admin.firestore.Timestamp.fromDate(newExpiry),
            referral_pro_months_earned: admin.firestore.FieldValue.increment(1),
          });
        }

        // 2. Grant the referrer: lifetime Pro or 1 additional month
        if (lifetimePro && !referralSnap.data().lifetime_pro) {
          if (referrerSnapTrx.exists) {
            const forever = new Date();
            forever.setFullYear(forever.getFullYear() + 100);
            trx.update(referrerRef, {
              pro: true,
              is_pro: true,
              pro_expires_at: admin.firestore.Timestamp.fromDate(forever),
              referral_lifetime_pro: true,
            });
          }
          trx.update(referralRef, { activations: newActivations, lifetime_pro: true });
        } else {
          // 1 additional month stacked on referrer's existing expiry
          if (referrerSnapTrx.exists) {
            const rData = referrerSnapTrx.data();
            const now   = new Date();
            const curExp = rData.pro_expires_at
              ? (rData.pro_expires_at.toDate ? rData.pro_expires_at.toDate() : new Date(rData.pro_expires_at))
              : now;
            const base = curExp > now ? curExp : now;
            const newExp = new Date(base);
            newExp.setMonth(newExp.getMonth() + 1);
            trx.update(referrerRef, {
              pro: true,
              is_pro: true,
              pro_expires_at: admin.firestore.Timestamp.fromDate(newExp),
              referral_pro_months_earned: admin.firestore.FieldValue.increment(1),
            });
          }
          trx.update(referralRef, { activations: newActivations });
        }
      });

      // Send push notification to referrer (outside transaction, best-effort)
      try {
        const referrerSnap = await referrerRef.get();
        const fcmToken = referrerSnap.data()?.fcm_token;
        if (fcmToken) {
          const newActivations = (await referralRef.get()).data()?.activations || 1;
          const isLifetime     = newActivations >= 3;

          await admin.messaging().send({
            token: fcmToken,
            notification: {
              title: isLifetime ? '🎉 Lifetime Pro unlocked!' : '🎁 You earned a free month!',
              body: isLifetime
                ? 'You\'ve referred 3 friends — FlowCheck Pro is yours for life.'
                : 'A friend just connected their bank. You\'ve earned 1 free month of Pro!',
            },
            data: {
              type:   isLifetime ? 'referral_lifetime' : 'referral_reward',
              screen: 'settings',
            },
            apns: {
              payload: {
                aps: { badge: 1, sound: 'default' },
              },
            },
          });
        }
      } catch (notifErr) {
        // Non-fatal — reward was already applied
        console.warn('[referral/activate] push notification failed:', notifErr.message);
      }

      return res.json({ status: 'activated' });
    } catch (err) {
      console.error('[referral/activate]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── GET /api/referral/stats ───────────────────────────────────────────────
  // Return the authenticated user's referral stats for the Settings UI.
  router.get('/stats', requireAuth, async (req, res) => {
    const uid = req.uid;

    try {
      const userSnap = await db.collection('users').doc(uid).get();
      if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

      const data = userSnap.data();
      const code = data.referral_code;

      let activations       = 0;
      let lifetime_pro      = false;

      if (code) {
        const referralSnap = await db.collection('referrals').doc(code).get();
        if (referralSnap.exists) {
          activations  = referralSnap.data().activations || 0;
          lifetime_pro = referralSnap.data().lifetime_pro || false;
        }
      }

      return res.json({
        code:               code || null,
        activations,
        lifetime_pro,
        months_earned:      data.referral_pro_months_earned || 0,
        referred_by_code:   data.referred_by_code   || null,
        referral_activated: data.referral_activated || false,
      });
    } catch (err) {
      console.error('[referral/stats]', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
};
