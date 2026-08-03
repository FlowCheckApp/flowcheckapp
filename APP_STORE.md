# FlowCheck — App Store Listing

Copy-paste ready for App Store Connect. Character counts verified.
Last updated: 2026-07-30

**Positioning note:** every line below leads with the *decision before you spend*,
not the *report after*. Do not rewrite this toward "see where your money goes" —
that is Mint/Rocket Money's ground and we lose on it. See `VISION.md §1`.

---

## Title — 24 / 30 chars

```
FlowCheck: Safe to Spend
```

**Why:** "Safe to Spend" is the phrase we want to own — it is the number the whole
app produces, and no competitor claims it. Contains "spend" for search. Brand
stays first so it still reads as a product, not a keyword dump.

**Alternate (if you want more raw volume):** `FlowCheck: Budget & Bills` (25) —
higher search volume, but drops us into a category where we rank behind Mint,
Rocket Money and YNAB with no differentiation. Not recommended at launch.

---

## Subtitle — 29 / 30 chars

```
Budget by paycheck, not month
```

**Why:** does two jobs at once, exactly as it should. Hits the high-volume
keywords **budget** and **paycheck**, *and* states the actual differentiator in
five words. Monthly budgeting is why every other app fails the paycheck-to-
paycheck user.

---

## Keyword field — 100 / 100 chars

```
afford,bill,tracker,money,cash,flow,overdraft,payday,expense,bank,checking,balance,savings,debt,goal
```

**Rules applied:**
- No word repeated from the title or subtitle (those are already indexed) — so no
  `budget`, `paycheck`, `spend`, `safe`
- Singular only (Apple treats singular/plural as the same token)
- Commas, no spaces
- No competitor brand names (policy violation)

**`afford` is first on purpose** — it is the intent behind our signature feature,
and almost nobody bids on it.

---

## Promotional text — 147 / 170 chars

*(Updatable any time without a review — use it for seasonal hooks.)*

```
Payday's still 9 days out. Can you afford that $80 dinner? FlowCheck does the math against your real bills and tells you yes, no, or "wait 4 days."
```

---

## Description

```
Rent is in nine days. There's $340 in checking. A friend just asked if you want in on a $90 dinner.

Every other money app will show you a chart of what you already spent. FlowCheck answers the question you're actually asking: can I afford this, right now, without wrecking my week?

Type the amount. Get a straight answer in two taps.

"Yes — comfortably. You'll still have $312 safe to spend."
"Not comfortably. But payday lands Aug 27 — wait 4 days and it's an easy yes."

That last part is the whole point. FlowCheck doesn't just tell you no. It tells you when it becomes yes.

──────────────────

SAFE TO SPEND
One number you can trust. Your real balance, minus the bills that haven't hit yet, minus your goals, minus a buffer for the surprises. Not what's in your account — what's actually yours to spend.

CAN I AFFORD THIS?
Check any purchase before you make it. See exactly how much of your cushion it eats, whether your bills still clear, and what your daily budget looks like afterward.

PAYCHECK PLAN
See where this paycheck is already spoken for before you spend it. Bills, goals, and everyday spending — assigned, not guessed.

YOUR MONEY WEEK
A 30-second story recap every Sunday. Where it went, what's on autopilot, and one honest letter grade. The two minutes a week that keep you on track.

COACH
Straight answers in plain language. How to pay off that card faster. Which bill to move. What to save this paycheck. No jargon, no lectures.

BILLS & SUBSCRIPTIONS
Know what's coming before it lands. FlowCheck finds the recurring charges you forgot you were paying and shows you the yearly number.

──────────────────

WHAT WE WON'T DO

We don't negotiate your bills and keep a third of your savings. We don't sell your data. We don't run ads. We don't push you toward trading or crypto. We're paid by you, so we work for you.

──────────────────

Bank-grade 256-bit encryption. Read-only access through Plaid, trusted by thousands of financial apps — FlowCheck can see your accounts and can never move your money.

Free to try for 7 days. Then $34.99/year (about $2.92/month) or $4.99/month.

FlowCheck is not a bank. Not financial advice.

Terms: https://getflowcheck.app/legal/terms
Privacy: https://getflowcheck.app/legal/privacy
```

---

## Screenshots — the 70% lever

Six frames, 1290×2796 (iPhone 6.7"). Generator already exists at
`screenshots/generate_v3.js`.

**Design rules:** dark navy background (stands out against the App Store's white
chrome), headline 3–6 words at 60px+ so it survives thumbnail size, one message
per frame, identical type and layout across all six.

| # | Headline | Sub | Shows |
|---|---|---|---|
| 1 | **"Can I afford this?"** | Get a real answer in two taps. | The verdict card — green "Yes — comfortably" + impact bar |
| 2 | **"Not today. But Friday, yes."** | FlowCheck tells you *when* it becomes a yes. | The amber verdict + "Wait 4 days" payday tip |
| 3 | **"The number that's actually yours."** | After bills, goals and a buffer. | Safe to Spend hero card |
| 4 | **"Know where the paycheck went — before it goes."** | Every dollar assigned, not guessed. | Paycheck Plan |
| 5 | **"Your week, in 30 seconds."** | A recap you'll actually want to open. | Money Week grade card (A−) |
| 6 | **"$0 of your savings taken."** | No bill-negotiation cut. No ads. No data selling. | Pricing / trust frame |

**Frame 1 is the whole ballgame.** It's the only one most people see. It must show
the verdict card with a real number, not a generic dashboard.

**Frame 2 is the differentiator** — no competitor can screenshot this.

---

## Ratings prompt

Ask via `SKStoreReviewRequest` only after a genuinely good moment. Apple caps it
at 3×/year, so don't waste one.

**Best moment for FlowCheck:** right after an afford-check returns a comfortable
"yes" — the user just got real value and feels good. Second best: after a bank
connects successfully.

Never prompt: after an error, after a "no" verdict, on first launch, or during
onboarding.

```js
// Gate: 3+ sessions, positive moment, not asked in the last year
if (sessions >= 3 && verdict === 'success' && !askedThisYear()) {
  setTimeout(requestAppStoreRating, 2000); // let the result animation land
}
```

---

## Categories

- **Primary:** Finance — where high-intent searchers are
- **Secondary:** Productivity

---

## App Review notes (paste into the review form)

```
DEMO ACCOUNT
Email: reviewer@flowcheck.app
Password: [set in App Store Connect]

This account has "Use Demo Account" enabled on the bank-connect step of
onboarding, which loads realistic sample data. No real bank credentials are
needed to review every feature.

WHY WE REQUEST BANK ACCESS
FlowCheck connects to bank accounts via Plaid in READ-ONLY mode to calculate
the user's "Safe to Spend" number. The app cannot move, transfer, or withdraw
funds — no payment or transfer capability exists anywhere in the codebase.

SUBSCRIPTION
7-day free trial, then $34.99/year or $4.99/month via RevenueCat. Terms and
pricing are disclosed on the paywall and on the onboarding trial step before
any purchase. Restore Purchases is available on the paywall.

TESTING THE SIGNATURE FEATURE
Coach tab → "Can I afford this?" → enter any amount → Check.
```

---

## What to A/B test first

Product Page Optimization, 7+ days per test, one variable at a time.

1. **Frame 1 headline** — `"Can I afford this?"` vs `"Not today. But Friday, yes."`
   The second is more distinctive but takes a beat longer to parse. Worth knowing.
2. **Title** — `Safe to Spend` vs `Budget & Bills`, once there's enough traffic to
   reach significance.

Don't test the description. Almost nobody reads it.
