# Dashboard v9 — The Runway

> Replace the card list with the picture of the product's thesis:
> **can I make it to payday?**

Status: **spec, not built.** Approved direction 2026-08-02.
Supersedes the current `.home-v8` card stack on Today.

---

## 1. Why

Today is currently ten stacked cards over 1,678px. That is the same shape as
Mint, Monarch and Rocket Money — a *better* list, but still a list. It says
"here are ten things about your money." It does not answer a question.

`VISION.md §1` says the app exists to answer **"if I spend this, am I going to
be okay?"** A card stack is the wrong instrument for that. A runway is the right
one, and no competitor has it.

**The test for every decision below:** does it make "will I make it to payday"
readable in under two seconds?

---

## 2. The core object

A horizontal timeline from **today → next payday**, with the projected balance
drawn as a line across it and bills plotted as markers where they land.

```
 $1,223 ┤●───────╮
        │         ╰──╮ Rent            ← line dips at each bill
   $340 ┤            ╰────╮
        │                  ╰──● $312   ← endpoint = balance at payday
     $0 ┼────────────────────────────
        today   Aug 4   Aug 10    Aug 27
                 ▼        ▼         ★
                Rent    Electric  PAYDAY
```

- **Line** = projected balance, day by day, starting at spendable cash
- **Dips** = each unpaid bill on its due date
- **Slope between dips** = expected everyday spend (`expectedEverydaySpend / days`)
- **★ payday** = the finish line, always the right edge
- **Endpoint dot** = what you land on. This is the number that matters.

### The one rule that makes it honest
If the line crosses **$0** before payday, that segment turns `--fc-danger` and
the card states the date in words: *"You run short on Aug 12."* Never a red
line with no explanation.

---

## 3. Layout (top to bottom)

| # | Element | Height | Notes |
|---|---|---|---|
| 1 | Greeting + Synced pill | 47px | unchanged |
| 2 | **Runway card** | ~300px | the hero — see §4 |
| 3 | **"Can I afford this?"** CTA | 56px | full-width, directly under the runway |
| 4 | Trust line | 32px | `🔒 Read-only · Face ID on` |
| 5 | Today's one move | ~110px | single card, not a carousel |
| 6 | Money Week banner | 62px | keep — it earns its place |
| 7 | Quick actions | 96px | keep |

**Everything else is cut from Today.** Bills → Plan. Goals → Goals tab.
Stats/outlook → Plan. They already have homes; duplicating them here is what
made the screen generic.

Target: **≤ 1 screen + a short scroll (~950px)**, down from 1,678px.

---

## 4. The wow moments

Three, and only three. Spend the boldness here and keep everything else quiet.

**1. The line draws itself on load.**
`stroke-dasharray` / `stroke-dashoffset` animation, ~900ms,
`cubic-bezier(0.22,1,0.36,1)`. The bill markers fade in *after* the line passes
them (stagger by their x-position). It reads as the app working the answer out.

**2. Scrub it.**
Drag along the runway and a floating label follows your finger:
*"Aug 14 — $612 left."* This is the feature people will show their friends. It
turns a chart into an instrument. Haptic tick on each day boundary.

**3. The endpoint counts up.**
The landing number animates from $0 with the existing `animateNumber` easing,
finishing just as the line completes. One number, one moment.

**Nothing else animates on this screen.** No shimmer, no pulsing, no
attention-grabbing. The restraint is what makes those three land.

---

## 5. Data — all of it already exists

```js
const p = _buildSafeSpendProjection();
// → { cash, payday:{date,days}, days, bills, billsTotal,
//     expectedEverydaySpend, reserve, safe }
```

Build the series:

```js
// one point per day from today to payday
const dailyBurn = p.expectedEverydaySpend / Math.max(1, p.days);
let balance = p.cash;
const series = [];
for (let d = 0; d <= p.days; d++) {
  const dayBills = p.bills.filter(b => FCData.daysUntil(b.due_date) === d);
  balance -= dayBills.reduce((s, b) => s + (b.amount || 0), 0);
  if (d > 0) balance -= dailyBurn;
  series.push({ day: d, balance, bills: dayBills });
}
```

No new endpoints. No new Firestore reads. No backend work.

---

## 6. States — design all of them, they are not edge cases

**All five are built and verified (2026-08-02).**

| State | Treatment | Status |
|---|---|---|
| **No bank linked** | `_renderRunwaySample()` — deterministic sample series through the *same* `_rwChartSVG()`, chart at `opacity:.3`, "Sample data" pill over it, CTA → `startPlaidLink()`. Carries **no dollar figure at all**: a made-up balance must never be mistakable for the user's. | ✅ |
| **No payday predicted** | 14-day horizon, edge label `IN 2 WEEKS`, headline "You are covered for 2 weeks", and the sub appends *"Payday not detected yet."* No date is ever invented. | ✅ |
| **No bills** | Straight declining line (verified: one constant per-day delta). Copy: *"Nothing due before payday. / This is all yours."* | ✅ |
| **Goes negative** | Danger stroke + dashed zero-line + the date in words. Endpoint shows the real negative, never clamped. | ✅ |
| **Loading** | `_renderRunwaySkeleton()` — axis and payday edge already drawn, line absent, `fc-sk` shimmer bars. Never a spinner. **Sized to 356px to match the real card exactly**, so nothing jumps when data lands. | ✅ |

Precedence in `_renderRunwayCard()`: loading → no-bank → real. Both non-real
states set `_rwSeries = null` so the scrub handler can never report sample or
stale money.

---

## 7. Verification (do not ship on eyeballs)

Run these in the preview console; each must pass.

```js
// 1. internal consistency: end == start - bills - (burn * horizon)
//    NOTE: the endpoint deliberately does NOT equal _buildSafeSpendProjection().safe.
//    `safe` projects only min(14, paydayDays) AND subtracts the reserve;
//    the runway projects the FULL horizon to payday and shows the real
//    balance including the reserve. Different questions, both correct.
//    (An earlier draft of this spec asserted they matched — they don't.)
(() => { const r = FCApp._buildRunwaySeries();
  const bills = r.points.reduce((s,p)=>s+p.bills.reduce((a,b)=>a+ +(b.amount||0),0),0);
  return Math.abs((r.startBalance - bills - r.dailyBurn*r.horizon) - r.endBalance) < 0.01; })()

// 1b. balance never rises before payday
FCApp._buildRunwaySeries().points.every((p,i,a)=> i===0 || p.balance <= a[i-1].balance + 0.01)

// 2. every unpaid bill before payday appears as a marker
//    NOTE: compare against the RUNWAY's own billCount, not
//    _buildSafeSpendProjection().bills.length. The projection caps its bill
//    window at min(14, paydayDays) because that is the horizon `safe` covers;
//    the runway goes all the way to payday (often 29+ days). An earlier build
//    fed p.bills straight into the series and so silently dropped every bill
//    past day 14 — on demo data that hid a $59.99 bill on day 18 and
//    overstated the landing balance. _buildRunwaySeries now reads
//    _billsForDisplay() over the full horizon. Do not "simplify" it back.
document.querySelectorAll('.rw-marker').length ===
  FCApp._buildRunwaySeries().billCount

// 3. vertical rhythm still uniform (session assertion, keep passing)
new Set([...document.querySelectorAll('#view-home .home-v8 > *')]
  .map((el,i,a) => i && Math.round(el.getBoundingClientRect().top
    - a[i-1].getBoundingClientRect().bottom)).slice(1)).size === 1

// 4. one card radius app-wide.
//    MUST include .wv-card and MUST be scoped to .fc-view.active. Without
//    .wv-card this assertion passed for weeks while Money rendered three
//    radii (15px heroes / 22px cards / 24px everywhere else); unscoped it
//    picks up 14px cards inside hidden sheets and false-fails.
new Set([...document.querySelectorAll(
  '.fc-view.active .fc-ui-card, .fc-view.active .fc-card, .fc-view.active .wv-card')]
  .map(el => getComputedStyle(el).borderRadius)).size === 1

// 5. privacy mode still masks the endpoint
FCApp.togglePrivacyMode();
getComputedStyle(document.querySelector('.rw-endpoint-value')).filter !== 'none'
```

Also re-run the all-tabs leak check from the privacy work — the runway
introduces new money figures and they must mask.

---

## 8. Build order

1. `_buildRunwaySeries()` next to `_buildSafeSpendProjection()` — pure function, no DOM
2. Static SVG render, no animation, correct numbers (verify #1 and #2)
3. Cut the sections listed in §3 from the Today template
4. Draw-on animation + endpoint count-up
5. Scrub interaction + haptics
6. All five states from §6
7. Full verification pass, `npm run check`, `npm run sync:ios`

**Ship 1–3 before touching 4–6.** A correct static runway is already better
than the current screen; an animated wrong one is worse than what exists.

**Steps 1–7 are done (2026-08-02).** Remaining from the wider plan: the
Plan / Money / Goals / Coach page passes, plus the two deploys (firestore
rules, Railway backend) — neither ships via `cap sync`.

---

## 9. Naming

Prefix everything `rw-` (`.rw-card`, `.rw-line`, `.rw-marker`, `.rw-endpoint`)
and put the CSS in `fc-screens.css` under a clearly marked block. Use the
canonical chrome from `CLAUDE.md` for the card shell — do not invent new card,
radius or spacing values. The runway is new; its container is not.

⚠️ Two known cascade traps when styling this — see `CLAUDE.md`:
`fc-premium-screens.css` loads **last** and uses `!important`; inline `<style>`
in `index.html` beats external CSS at equal specificity by document order.
Scope with `#view-home` rather than reaching for `!important`.
