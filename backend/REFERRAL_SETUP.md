# Referral System — Integration Notes

## 1. Mount the router in server.js

Add these two lines near the top of `server.js` where other routes are defined:

```js
const makeReferralRouter = require('./referral');
app.use('/api/referral', makeReferralRouter(admin, db));
```

`admin` and `db` are whatever you've already initialized with `firebase-admin`.

## 2. Call activate after Plaid token exchange

Inside your existing Plaid token-exchange handler (the route that exchanges a
public_token for an access_token), after you've saved the access token to
Firestore, make an internal call to activate the referral:

```js
// After saving the Plaid access_token to /plaid_items/{uid}:
try {
  // Decode the ID token you already verified
  const referral = await db.collection('users').doc(uid).get();
  if (referral.data()?.referred_by_code && !referral.data()?.referral_activated) {
    // Directly call the activation logic (no HTTP round-trip needed)
    const referralRouter = require('./referral');
    // OR: inline the activation logic here
    // OR: POST internally to /api/referral/activate using the user's token
    await activateReferralForUser(admin, db, uid);  // see referral.js for logic
  }
} catch(e) { /* non-fatal */ }
```

Alternatively, expose the activation function directly:

```js
// referral.js also exports the raw function for server-side use:
const { activateReferralForUser } = require('./referral');
```

You can add this export to `referral.js`:
```js
module.exports.activateReferralForUser = async function(admin, db, uid) {
  // same logic as the /activate route but without HTTP
  // ...copy the transaction block from the /activate handler
};
```

## 3. Deploy Firestore rules

```bash
firebase deploy --only firestore:rules
```

The updated `firestore.rules` adds a `referrals/{code}` collection
(backend-write only, no client access).

## 4. What the frontend does automatically

- Register screen: optional "Have a referral code?" collapsible input
- `FCApp.handleRegister()` receives the code as a 4th argument — you need to
  call `FCApp.applyReferralCodeAfterSignup(code)` inside your existing
  `handleRegister` function in `fc-app.js` after account creation succeeds:

```js
// Inside handleRegister in fc-app.js, after firebase.auth().createUserWithEmailAndPassword():
if (referralCode) {
  FCApp.applyReferralCodeAfterSignup(referralCode).catch(() => {});
}
```

- Settings tab: "Refer a Friend" row auto-loads stats when settings opens
- Referral sheet: shows code, copy button, native share sheet, progress 0/3
