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

### ★ Canonical screen chrome — READ BEFORE STYLING ANY SCREEN
Every page header, segmented control, chip row, and section label in the app is
defined ONCE, in the `★ CANONICAL SCREEN CHROME ★` block at the bottom of
`flowcheck-design-system.css`. Use these classes:

| Element | Class |
|---|---|
| Page header | `.fc-page-head` + `.fc-page-head__text` + `.fc-page-title` + `.fc-page-sub` |
| Header action button | `.fc-page-head__action` (36px accent circle) |
| Sub-screen title | `.fc-page-title--sub` |
| Segmented control | `.fc-seg` + `.fc-seg-btn` (`.active` / `aria-selected`) |
| Time-range chips | `.fc-chip-row` + `.fc-chip` |
| Section label between cards | `.fc-eyebrow` |
| Label inside a card | `.fc-section-label` (9px — the smaller one) |

**Never style a page title or segment control inline or per-screen.** The app
previously had 5 different page-title treatments and 3 unrelated segment systems
held together by `!important` overrides across 3 stylesheets. Legacy names
(`.act-title`, `.wv-page-title`, `.wv-tab`, `.fc-segment-btn`, `.wv-period-btn`,
`.plan-period-btn`) are aliased to the canonical rules — don't add new ones.

Verify a change held with the computed-style assertion, not by eye:
```js
new Set([...document.querySelectorAll('.fc-seg-btn,.wv-tab,.fc-segment-btn')]
  .map(el => getComputedStyle(el).fontSize)).size === 1  // must be true
```

**Segments and chips are different components — do not assert them together.**
`.fc-seg-btn` (and its aliases `.wv-tab`, `.fc-segment-btn`) is 12.5px.
`.fc-chip` (and its aliases `.wv-period-btn`, `.plan-period-btn`) is 12px.
That 0.5px difference is deliberate; a sweep that mixes them reports a false split.

Card radius must be asserted with **`.wv-card` included and scoped to the
active view** — Money's cards are `.wv-card`, so the older
`.fc-ui-card,.fc-card` query silently skipped the entire tab:
```js
new Set([...document.querySelectorAll(
  '.fc-view.active .fc-ui-card, .fc-view.active .fc-card, .fc-view.active .wv-card')]
  .map(el => getComputedStyle(el).borderRadius)).size === 1  // must be true
```

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
- **FlowCheck is subscription-only. There is no free plan.** A free trial
  (7 days on the annual product) is the only unpaid access, and it carries the
  RevenueCat entitlement, so trial users pass every `_isPro()` check.
- After the trial the app is hard-gated: `setScreen('app')` routes to the
  paywall unless `_mayEnterApp()` passes. That check lives in `setScreen`
  on purpose — there are a dozen `setScreen('app')` call sites and gating them
  individually is how a hole gets left.
- `grandfathered: true` exempts accounts that already had a bank connected when
  the requirement shipped. Server-set only: it is in neither Firestore rules
  allowlist, and both use `hasOnly()`, so a client write containing it is
  rejected outright — same protection as `is_pro`.
- The client gate is UX. **The enforcement is `requireEntitlement` in
  `backend/server.js`**, which refuses `/plaid/sync` without an entitlement.
  Disconnect, account deletion and `GET /plaid/items` stay open on purpose —
  people must always be able to revoke bank access and delete their data,
  and `/plaid/items` is what lists the banks to disconnect.
- Demo mode is exempt from the gate. It shows fabricated data, touches no real
  account, and is how App Review evaluates the app without subscribing.

## Plaid data architecture
- Plaid tokens stored in `users/{uid}/plaid_items/{item_id}` subcollection (NEW)
- Legacy: some early users have data only in `plaid_items/{uid}` doc or just `state.user.plaid_institution`
- Always fallback: if `getPlaidItems()` returns empty, check `state.user.plaid_institution`
- **Never store Plaid tokens in localStorage or UserDefaults — Keychain only**

## Known bugs

**All 10 previously-listed bugs are FIXED and verified (2026-07-30).** They are
kept here only so a future session doesn't "rediscover" them — do not re-fix.

| # | Bug | Resolved by |
|---|---|---|
| 1 | Insights tab shake | Insights folded into Plan; render deferred via `requestAnimationFrame` |
| 2 | "No banks connected" for early users | `plaid_institution` fallback (`fc-app.js` ~13152) |
| 3 | Streak stuck at Day 1 | `_streakCheckedThisSession` guard (`fc-app.js` ~12366) |
| 4 / 10 | Pro not ungating after purchase | `_refreshAfterPro()` removes `.fc-pro-gate` + re-renders |
| 5 | Two paywall integrations | Single `showPaywall()` entry point |
| 6 | Referral code generation | Client-side by design; revisit only if abuse appears |
| 7 | Old account data flash | `_wipeUserState()` runs BEFORE `FCAuth.signOut()` |
| 8 | Lock screen / Face ID jank | Now native (`UIVisualEffectView` in AppDelegate) |
| 9 | Free-tier limits not enforced | `startPlaidLink()` checks live RC status + real item count |

**Before fixing anything listed as a "known bug" anywhere in this file: verify it
still reproduces.** This list was stale for weeks and cost a full session of
re-verification.

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
