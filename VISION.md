# FlowCheck — The Vision

> **The app that tells you what you can actually spend today.**

Last updated: 2026-07-30

---

## 1. The one sentence

Every other money app shows you **the past**. FlowCheck answers **the present**.

Mint, Monarch, Copilot, YNAB — they are all, structurally, reporting tools. They
categorize what already happened and render it beautifully. Rocket Money is a
subscription-canceller with a budget bolted on. None of them answer the question
that actually wakes people up:

**"If I spend this, am I going to be okay?"**

That question is FlowCheck's entire reason to exist.

---

## 2. Who this is for

Not "people who want to budget." Budgeting apps are for people who already have
slack in their finances and want optimization. That market is crowded and it is
not who needs this.

**FlowCheck is for the person with $340 in checking, rent in nine days, and a
friend asking if they want to split a $90 dinner.**

That's roughly 6 in 10 American adults living paycheck to paycheck — including
people earning six figures. They are not bad with money. They are running a
cash-flow timing problem in their head, constantly, with incomplete information,
and it is exhausting.

They don't need a pie chart. They need someone to do the math and say a number.

### What they feel today
- Checking the bank app 4× a day and still not knowing what's safe
- "I think I'm fine?" — followed by an overdraft
- Guilt after every purchase, because every purchase is a gamble
- Existing apps make them feel *judged* — retroactively, for money already gone

### What FlowCheck gives them
- One number they trust: **Safe to Spend**
- A straight answer before they spend: **Can I afford this?**
- The end of the ambient dread

---

## 3. The signature moment

Every great app has one interaction it owns. Instagram has the feed. Shazam has
the button. Spotify has Wrapped.

**FlowCheck's is "Can I afford this?"**

> You type `$450`.
> Two taps later:
> **"Risky — this eats your cushion."** Bills would still clear, but this spends
> past your buffer. → *$0.00 would remain.*
> **"Wait 29 days. Payday lands Aug 27 — after that, this is an easy yes."**

That last line is the whole product. It doesn't just say no. It tells you *when
it becomes yes.* No other finance app on earth does this.

**This is the App Store screenshot. This is the TikTok clip. This is the demo.**
Everything else in the app exists to make this answer trustworthy.

---

## 4. The five pillars

Each maps to something that already exists in the codebase. This is not a wishlist.

| Pillar | The job it does | Where it lives |
|---|---|---|
| **Safe to Spend** | The number. Cash minus bills, goals, and a real buffer. | `_buildSafeSpendProjection()` |
| **Can I Afford This** | The decision, before you make it. | `runAffordCheck()` |
| **Paycheck Plan** | The runway. Where this paycheck is already spoken for. | Plan tab |
| **Money Week** | The ritual. A 30-second story recap that makes you *want* to come back. | `openMoneyStory()` |
| **Coach** | The answers. Debt, bills, savings, spending — in plain language. | Coach tab |

**Rule:** if a feature doesn't make one of these five better, it doesn't ship.

---

## 5. What we will never build

A vision is defined by refusals. These are permanent.

- **Bill negotiation.** Rocket Money takes 35–60% of what it "saves" you. Charging
  a paycheck-to-paycheck user a majority cut of their own savings is predatory.
  Instead: show them the cancel link and take $0.
- **Credit score theater.** A vanity number that drives daily-open metrics and
  changes nothing about whether rent clears.
- **Trading, crypto, "invest your spare change."** We serve people whose emergency
  fund is not funded. Pointing them at markets is malpractice.
- **Engagement bait.** No streak-guilt, no manufactured urgency, no notification
  we wouldn't want to receive ourselves.
- **Selling or brokering user financial data.** Not now, not at any valuation.
- **Ads.** The moment we take ad money, the product starts serving the advertiser.

> If FlowCheck ever needs one of these to hit a number, the business model is
> wrong — fix the business model, not the principles.

---

## 6. The roadmap, in acts

### Act I — Be undeniably good at one thing ✅ *(largely done)*
Safe to Spend, afford check with payday intelligence, paycheck plan, unified
design system, honest onboarding (trial and bank connect as separate, truthful
steps), Money Week story, local-notification retention loop.

### Act II — Make it a habit *(now)*
The product is good. It is not yet a *ritual*.
- Ship to TestFlight; watch 20–50 real users through the funnel
- Instrument every onboarding step; find the exact drop-off
- App Store listing built around the afford-check verdict card
- Verify weekly-recap + payday notifications on real devices
- Widget: Safe to Spend on the home screen — the number without opening the app
- Apple Watch complication (same number, wrist glance)

### Act III — Become the calm one
- **Runway, not budgets.** "You're good until Aug 14" beats any category chart
- **Bill timing moves.** "Move your phone bill 4 days later and you never dip
  below zero" — a real, concrete, free win
- **Shared money.** Two people, one Safe to Spend. Nobody has done this well
- **Real subscription kill-list** — direct cancel links, $0 taken from the user

### Act IV — The standard
- FlowCheck's Safe-to-Spend number becomes the phrase people use
- "What does FlowCheck say?" becomes how couples settle a purchase
- Sponsor-free, ad-free, data-sale-free, and profitable — proving a consumer
  finance app can be all four

---

## 7. The economics

Honest math, not projections dressed as facts.

**Per subscriber, annual plan at $34.99:**

| | Amount |
|---|---|
| Gross | $34.99 |
| Apple's cut (15% under Small Business Program) | −$5.25 |
| Plaid (transactions + balance, est.) | −$4 to $8 |
| Firebase / Railway (est., at scale) | −$1 to $2 |
| **Net** | **≈ $20–25** |

**The single biggest threat to this model:** free users who connect a bank.
They cost real money every month and pay nothing. This is why bank sync is
Pro-gated and why `startPlaidLink()` checks live RevenueCat status *and* the real
item count before allowing a second connection. **That gate is a profitability
feature. Never weaken it for growth.**

**What has to be true for this to work** (these are bets, not facts):
- ~2–5% of installs start a trial *(industry benchmark)*
- ~40–60% of trials convert *(only if the aha-moment lands during the trial)*
- The aha-moment is the first Safe-to-Spend number after connecting a bank —
  which is why onboarding must get them to a connected bank fast and honestly

At ~$22 net and organic + content-led acquisition, **~4,500 subscribers is
~$100k/yr.** That is a real, reachable, one-person business. Ten thousand is a
company.

---

## 8. Metrics that actually matter

Track these four. Ignore vanity.

1. **Time-to-first-Safe-to-Spend** — install → seeing their real number. The
   single best predictor of retention. Target: under 3 minutes.
2. **Trial → paid conversion** — the business.
3. **Week-4 retention** — did it become a habit or a novelty?
4. **Afford-checks per active user per week** — engagement with the *signature
   moment*, not just app opens. This is the real health metric.

Explicitly **not** tracked as goals: session length, daily opens, notification
open-rate. An app that solves your problem in 20 seconds is *better*, not worse.

---

## 9. Voice

FlowCheck talks like a sharp friend who is good with money and never makes you
feel small.

| Never | Always |
|---|---|
| "You overspent on dining 🚨" | "Dining's running $60 over. Want to pull it back?" |
| "Budget exceeded!" | "You're $40 past pace. Two quiet days fixes it." |
| "You can't afford this." | "Not comfortably — but in 6 days, easily." |
| Shame, urgency, exclamation marks | Calm, specific, actionable |

**Rules**
- Always give the next action, never just the diagnosis
- Never manufacture urgency; real urgency (a bill is actually late) is enough
- Round to what a human would say — "about $1,200," not "$1,203.47," unless the
  cents matter
- Never claim certainty about the future. "On pace to" — not "you will"
- **"FlowCheck is not a bank. Not financial advice."** stays visible. Always.

---

## 10. The three-year picture

Someone opens FlowCheck on a Tuesday night. They've had a long day and a friend
just invited them to something that costs $85.

They tap once. **"Yes — comfortably. You'll still have $312 safe to spend."**

They close the app and go. Total time: four seconds. No spreadsheet, no guilt,
no 2 a.m. spiral.

On Sunday evening their phone says *Your Money Week is ready.* Thirty seconds
later they've seen where it went, gotten an A−, and know the one thing to change.

They've never once been upsold something predatory. They pay $2.92 a month and
they'd fight anyone who tried to take it away.

**That's the app. Not the biggest feature list — the one people trust with the
scariest question they ask themselves.**

---

## Appendix — Working principles

1. **The number must be trustworthy.** One wrong Safe-to-Spend costs more trust
   than ten features earn.
2. **Verify with assertions, not eyeballs.** (See the computed-style check in
   `CLAUDE.md`.)
3. **Every screen: one job.** If you can't say a screen's job in one sentence,
   it's two screens.
4. **Ship the whole thing.** A half-built feature in a finance app isn't a
   feature, it's a liability.
5. **When in doubt, choose the user's interests over the metric.**
