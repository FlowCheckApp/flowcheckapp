# FlowCheck — Claude Code Context

## What this app is
FlowCheck is a personal finance iOS app built with Capacitor 8.x. It connects to bank accounts via Plaid, tracks transactions, bills, net worth, and financial health. It's a consumer finance app — privacy and security are non-negotiable.

## Tech Stack
- **Frontend**: HTML/CSS/JS (vanilla) in `www/` — no framework, no build step
- **Mobile**: Capacitor 8.x — `ios/App/` is the Xcode project
- **Backend**: Node.js/Express in `backend/server.js` — runs on Railway
- **Auth**: Firebase Auth + Firestore
- **Bank data**: Plaid (Link + Transactions API)
- **Subscriptions**: RevenueCat (`FCPurchases` module)
- **Design system**: `www/css/flowcheck-design-system.css`

## Key files
- `www/index.html` — all screens/HTML, single page app
- `www/js/fc-app.js` — main app logic, all screen renders, state management
- `www/js/fc-auth.js` — Firebase auth, Firestore helpers
- `www/js/fc-data.js` — Plaid data fetching, transaction helpers
- `www/js/fc-config.js` — `FC_CONFIG` object with `app.apiBase` (backend URL)
- `www/js/fc-iap.js` — RevenueCat integration (exports `FCPurchases.isPro()`)
- `backend/server.js` — Express API, Plaid webhooks, all `/plaid/*` routes
- `ios/App/App/AppDelegate.swift` — WKWebView cache clearing on every launch

## Design system
- Background: `#0a1520` (dark navy)
- Accent/cyan: `#1ac4f0` (`--fc-accent`)
- Electric blue (replaces old purple): `#2563eb` (`--fc-electric`)
- Text: `--fc-text`, `--fc-text-muted`, `--fc-text-faint`
- CSS vars defined in `flowcheck-design-system.css` — always use vars, never hardcode colors
- Note: `--fc-purple` is deprecated and inconsistent — use `--fc-electric` instead

## Deploy flow
```bash
# After editing www/ files:
npx cap sync ios
# Then open Xcode and hit ⌘R
```
Never edit files directly in `ios/App/App/public/` — they get overwritten by `cap sync`.

## State management
- `state` object in `fc-app.js` — single source of truth
- `state.user` — Firestore user doc (cached)
- `state.user.is_pro` — cached pro flag (use `FCPurchases.isPro()` for live check)
- `state.user.plaid_institution` — bank name (may be the only place bank data exists for early users)
- `state.screen` — current screen name

## Subscription / Pro gating
- `FCPurchases.isPro()` — async, live entitlement check via RevenueCat
- `_isPro()` in fc-app.js — sync helper using cached state
- `_renderProGate()` — renders locked card UI for non-pro users
- Free plan: 1 bank account, basic transactions, no insights/health score
- Pro: unlimited accounts, insights, financial health score, bills tracking

## Plaid data architecture
- Plaid tokens stored in `users/{uid}/plaid_items/{item_id}` subcollection (NEW)
- Legacy: some early users have data only in `plaid_items/{uid}` doc or just `state.user.plaid_institution`
- Always fallback: if `getPlaidItems()` returns empty, check `state.user.plaid_institution`
- **Never store Plaid tokens in localStorage or UserDefaults — Keychain only**

## Known bugs (fix these)
1. **Insights tab transition** — page shakes on switch. Root cause: `_renderInsights()` runs sync during CSS slide animation, `scrollTop` reset happens after render. Fix: reset `scrollTop` before render, defer `_renderInsights()` with `requestAnimationFrame`.
2. **Connected Banks shows "No banks connected"** — `getPlaidItems()` returns `[]` for early users. Fix: fallback to `state.user.plaid_institution` in `showBankSheet()`.
3. **Streak stuck at Day 1** — `_maybeIncrementStreak()` fires on every Firestore listener update (re-entrancy). Fix: add `_streakCheckedThisSession` boolean guard.
4. **Pro features not ungating after purchase** — paywall closes but UI doesn't re-render. Fix: after successful purchase, call `_renderHome()` and clear all pro-gate elements.
5. ~~**Two paywall integrations**~~ — resolved: onboarding and settings both call the single `showPaywall()` at `fc-app.js:6144`. Confirm in App Store Connect there's only one offering.
6. **Referral code generation** — client-side only (no `/referral/generate` endpoint exists). Client generates code via `FCData.updateUserField()` in `fc-app.js:7067`. Decide whether to leave client-side or move to backend for atomicity / abuse-prevention.
7. **Old account data flash on new account** — Firestore listener not cleaned up on signout. Fix: unsubscribe all listeners on `signOut()`.
8. **Lock screen / Face ID** — feels janky. Needs premium redesign. Native Face ID dialog appears 450ms after lock screen (jarring). Reduce delay, add smooth blur transition.
9. **Free mode limits not enforced** — users can add multiple accounts on free plan. Gate `linkBank()` behind pro check.
10. **Financial health score pro gate doesn't clear after upgrade** — pro-gate overlay stays after purchase.

## Security & Privacy (non-negotiable)
- No financial data in `localStorage` or `sessionStorage` — use Keychain via Capacitor Secure Storage
- No sensitive data in logs or crash reports
- Plaid tokens never in client-side storage
- All API calls use Firebase Auth tokens (`FCAuth.getIdToken()`)
- Backend validates auth on every endpoint — never trust client-side `is_pro`
- "FlowCheck is not a bank. Not financial advice." disclaimers must stay visible

## Backend API
- Base URL: `FC_CONFIG.app.apiBase` (from fc-config.js)
- All routes require `Authorization: Bearer <firebase-id-token>`
- Key routes: `POST /plaid/link-token`, `POST /plaid/exchange-token`, `GET /plaid/items`, `GET /plaid/transactions`, `GET /plaid/accounts`

## What "premium" means for this app
Study: Apple Wallet, Robinhood, Monarch Money, Copilot. Key patterns:
- Smooth 60fps transitions — no layout shifts during animation
- Blur/glass morphism for overlays — not hard cutoffs
- Haptics on every meaningful interaction
- Face ID feels instant — show the biometric prompt immediately, no staged delays
- Empty states are designed, not afterthoughts
- Numbers animate in — don't just appear
