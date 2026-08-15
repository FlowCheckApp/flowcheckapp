/**
 * FlowCheck — The Vault (PROOF-OF-SAVINGS ENGINE)
 * ─────────────────────────────────────────────────────────────────
 * Pure functions. No DOM, no network, no globals, no `state`.
 *
 * THE VAULT DOES NOT CHARGE ANYTHING.
 * ───────────────────────────────────
 * It is a tool included with the Pro subscription the user already pays for.
 * Nothing in this file bills, meters, debits or draws down. `subscriptionCost`
 * appears only as a yardstick — the savings need something to be measured
 * against — and any caller that treats it as a fee is wrong.
 *
 * WHY THIS FILE EXISTS
 * ─────────────────────
 * Every money app claims it saves you money. Almost none will show you the
 * transactions. This one answers one question, per month, with receipts:
 *
 *     did the subscription pay for itself?
 *
 * That is the whole job. A subscriber should be able to open this screen,
 * read every claim, and check each one against their own bank statement.
 *
 * WHICH MEANS THE RULES BELOW STILL HAVE TO BE BRUTAL. It is tempting to
 * relax them now that no money rides on the number — that instinct is exactly
 * backwards. An inflated savings figure is still a lie about someone's money;
 * it just costs trust instead of dollars, and trust is the only reason
 * anyone connects a bank account to this. The first time a user disproves a
 * claim on this screen, every other number in the app becomes suspect.
 *
 * So:
 *
 *   1. EVIDENCE OR NOTHING. Every event carries the transactions that prove
 *      it. If it cannot be shown on screen and checked against a statement,
 *      it does not count.
 *   2. NEVER INVENT A FEE. An "overdraft avoided" is worth the overdraft fee
 *      THIS bank has actually charged THIS user before. No fee history, no
 *      credit — not the $35 industry average, not an estimate. Zero.
 *   3. NO CREDIT WITHOUT ATTRIBUTION. A subscription the user killed before
 *      FlowCheck ever surfaced it is their win. It is shown in the ledger
 *      and explicitly excluded from the proven return.
 *   4. HAIRCUT WHAT CANNOT BE PROVEN CAUSAL. Behaviour-change claims get 50%
 *      and have to clear a bar noise cannot clear on its own.
 *   5. CREDITS EXPIRE. A cancelled subscription counts monthly as the months
 *      actually pass, for at most a year. Nothing is booked up front.
 *   6. NOTHING COUNTS TWICE. Every event id is deterministic, so re-running
 *      detection over the same data can only ever produce the same ledger.
 *
 * When in doubt, count nothing. A month with no receipts is just a quiet
 * month. A fabricated Vault is a lie about money, which is the company.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fc-core.js'));
  else root.FCVault = factory(root.FCCore);
}(typeof self !== 'undefined' ? self : this, function (FCCore) {
  'use strict';

  const DAY = 86400000;

  /* ── Terms ───────────────────────────────────────────────────────
     subscriptionCost is what Pro already costs. It is quoted so savings
     have something to be measured against — it is NOT a fee this file
     charges, and there is no take rate, because the Vault bills nothing. */
  const TERMS = {
    /* Must match the real monthly price in fc-config.js (premium_monthly).
       This said 9.99 — a price the product has not charged since it moved to
       4.99 — so the Vault told users "Pro costs $9.99/mo" and measured its own
       worth against a fee that does not exist. It understated itself by half
       (12.3× where the truth was 24.6×), but the damage is the wrong number,
       not the modesty: this is the one screen whose header promises it will
       "survive a user reading it line by line against their bank statement",
       and the first line they can check was wrong.
       The 51 vault tests did not catch it because they verify the engine's
       arithmetic, not whether this constant matches what we bill. */
    subscriptionCost: 4.99,  // what Pro costs — a yardstick, never a charge
    subCreditMonths: 12,     // a killed subscription counts for one year
    causalHaircut:   0.50,   // applied to anything not directly observed
    maxEventCredit:  500,    // sanity bound: no single event exceeds this
    maxPeriodCredit: 2000,   // sanity bound: no month credits more than this
  };

  /* ── Small helpers ───────────────────────────────────────────── */
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const parse  = d => FCCore.parseDateLocal(d);
  const isoDay = d => FCCore.isoDay(d);
  const isoMonth = d => isoDay(d).slice(0, 7);
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY);

  /* Human date for the one-line summary. The `evidence` block deliberately
     keeps full ISO dates — those exist to be matched against a bank
     statement — but "returned 2026-08-03" reads like a log line. */
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDay(d) {
    const x = parse(d);
    return isNaN(x) ? String(d || '') : MONTHS[x.getMonth()] + ' ' + x.getDate();
  }

  function median(xs) {
    if (!xs || !xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* Stable merchant key so "NETFLIX.COM *4417" and "Netflix" are one thing. */
  function merchantKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/\s*\*\s*.*$/, '')
      .replace(/\.(com|net|org|io|app)\b/g, '')
      .replace(/\b(inc|llc|ltd|co|corp|subscription|billing|payment|charge|recurring|monthly|annual|usa?|intl?)\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 20);
  }

  const CYCLE_DAYS = { wk: 7, mo: 30, '2mo': 61, yr: 365 };

  /* ═══════════════════════════════════════════════════════════════
     OBSERVED FEES — what this bank actually charges THIS user
     ═══════════════════════════════════════════════════════════════
     The single most abused number in this whole category is the fee an app
     claims it saved you. "We saved you a $35 overdraft fee" is, for most
     people, a sentence about an event that was never going to happen and a
     fee their bank does not charge. So there is exactly one source for it:
     a fee this user has actually paid, in their own transaction history.
     No history, no number. Returns 0, and 0 credits nothing. */
  const FEE_RE = {
    overdraft: /overdraft|nsf|insufficient|returned item|od fee/i,
    late:      /late fee|late charge|past due fee|delinquen/i,
  };

  function observedFee(transactions, kind) {
    const re = FEE_RE[kind];
    if (!re) return 0;
    const hits = (transactions || [])
      .filter(t => t && !t.isCredit && re.test(String(t.name || '') + ' ' + String(t.merchant_name || '')))
      .map(t => Math.abs(Number(t.amount) || 0))
      .filter(a => a > 0 && a <= 100);   // a $400 "late fee" is a bill, not a fee
    return hits.length ? round2(median(hits)) : 0;
  }

  /* ═══════════════════════════════════════════════════════════════
     1. SUBSCRIPTIONS THAT STOPPED
     ═══════════════════════════════════════════════════════════════
     Takes the app's already-detected recurring charges (each with a median
     amount, a cadence, and a last-seen date) and asks which have gone quiet
     for long enough to call dead: 1.5 cycles with no charge.

     The credit is NOT the annualised total. It accrues one cycle at a time,
     dated to the day each skipped charge would have hit, for at most a year.
     You cannot bank next March's savings in August — in August you have
     saved one month of it, and that is what the Vault says.

     `flagged` maps merchantKey → the ISO date FlowCheck first showed that
     subscription to the user. A cancellation that predates the flag was the
     user's own doing: it still lands in the ledger, marked plainly, and is
     excluded from anything FlowCheck bills against.

     `feedLastSeen` is the date of the most recent transaction ANYWHERE in
     the user's feed, and it is the difference between this rule being true
     and being wishful. "No Netflix charge in August" and "no charges at all
     in August, because the bank connection broke" look identical from here.
     Without this guard, a disconnected bank would silently read as every
     subscription being cancelled at once, and FlowCheck would bill a share
     of savings that did not happen — while the user, whose data has stopped
     syncing, has no way to see it. So a missed cycle only counts if the feed
     was demonstrably still live after the date that charge was due. */
  function subscriptionsEnded(subscriptions, flagged, today, feedLastSeen) {
    const now = today ? parse(today) : new Date();
    const seenUntil = feedLastSeen ? parse(feedLastSeen) : null;
    const out = [];

    for (const sub of subscriptions || []) {
      if (!sub || !sub.lastDate || !(sub.amount > 0)) continue;
      const cycle = CYCLE_DAYS[sub.freq];
      if (!cycle) continue;

      const quietDays = daysBetween(sub.lastDate, now);
      if (quietDays < cycle * 1.5) continue;          // still billing, or too early to tell

      const key = merchantKey(sub.name);
      const flagDate = flagged && flagged[key];
      // Attribution: we only bill for it if we surfaced it while it was alive.
      const attributed = !!flagDate && daysBetween(flagDate, sub.lastDate) >= 0;

      // One credit per skipped cycle, dated when the charge would have landed.
      const missed = Math.min(Math.floor(quietDays / cycle), TERMS.subCreditMonths);
      for (let i = 1; i <= missed; i++) {
        const when = new Date(parse(sub.lastDate).getTime() + cycle * i * DAY);
        if (when > now) break;
        // We can only say a charge "never came" for a window we were awake for.
        if (seenUntil && when > seenUntil) break;
        out.push({
          id:        'sub:' + key + ':' + isoDay(when),
          kind:      'subscription_ended',
          date:      isoDay(when),
          amount:    round2(Math.min(sub.amount, TERMS.maxEventCredit)),
          attributed:  attributed,
          confidence: 'observed',
          title:     sub.name + ' stopped billing',
          detail:    'Charge ' + i + ' of ' + TERMS.subCreditMonths + ' that never came',
          evidence: {
            lastCharged:  sub.lastDate,
            cycleAmount:  round2(sub.amount),
            frequency:    sub.freq,
            quietDays:    quietDays,
            flaggedOn:    flagDate || null,
          },
        });
      }
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════
     2. OVERDRAFTS THAT DID NOT HAPPEN
     ═══════════════════════════════════════════════════════════════
     Uses the forecast scorecard as its own evidence: a settled forecast
     that predicted a negative balance before payday, where the user in fact
     landed non-negative AND no overdraft fee shows up in the window.

     Worth exactly one of this user's own observed overdraft fees, halved,
     because FlowCheck cannot prove the warning is what changed the outcome
     — the forecast may simply have been wrong. A user who has never paid an
     overdraft fee gets nothing here, forever. That is correct: nothing was
     saved. */
  function overdraftsAvoided(forecasts, transactions, today) {
    const fee = observedFee(transactions, 'overdraft');
    if (!fee) return [];
    const now = today ? parse(today) : new Date();
    const out = [];

    for (const f of forecasts || []) {
      if (!f || !f.target_date) continue;
      if (typeof f.predicted_end !== 'number' || typeof f.actual_end !== 'number') continue;
      if (f.predicted_end >= 0) continue;      // we never called for trouble
      if (f.actual_end < 0) continue;          // trouble arrived anyway

      // A fee inside the window means the overdraft happened regardless.
      const from = parse(f.predicted_on || f.target_date).getTime();
      const to   = parse(f.target_date).getTime() + 2 * DAY;
      const feeHit = (transactions || []).some(t => {
        if (!t || t.isCredit || !t.date) return false;
        const ts = parse(t.date).getTime();
        return ts >= from && ts <= to
          && FEE_RE.overdraft.test(String(t.name || '') + ' ' + String(t.merchant_name || ''));
      });
      if (feeHit) continue;
      if (parse(f.target_date) > now) continue;

      out.push({
        id:        'od:' + f.target_date,
        kind:      'overdraft_avoided',
        date:      f.target_date,
        amount:    round2(Math.min(fee * TERMS.causalHaircut, TERMS.maxEventCredit)),
        attributed:  true,
        confidence: 'inferred',
        title:     'Overdraft called, and dodged',
        detail:    'We projected ' + fmt(f.predicted_end) + '. You landed ' + fmt(f.actual_end) + '.',
        evidence: {
          predictedEnd: round2(f.predicted_end),
          actualEnd:    round2(f.actual_end),
          yourFee:      fee,
          haircut:      TERMS.causalHaircut,
        },
      });
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════
     3. A REAL NEW LOW IN DISCRETIONARY SPEND
     ═══════════════════════════════════════════════════════════════
     The tempting version of this rule — "you spent less than your average
     month" — is worthless, because roughly half of all months beat the
     average by pure chance, and crediting a coin flip is how a savings
     number becomes fiction.

     So the bar is a genuine new low: the month has to come in under the
     LOWEST of the previous three complete months. Then the credit is half
     the gap to the median, capped. Only complete months are scored, so the
     current month never counts until it is over. */
  function underspendCredits(transactions, today, monthsBack) {
    const now = today ? parse(today) : new Date();
    const spendByMonth = {};

    for (const t of transactions || []) {
      if (!t || !t.date || !FCCore.isSpendTxn(t)) continue;
      const m = isoDay(t.date).slice(0, 7);
      spendByMonth[m] = (spendByMonth[m] || 0) + Math.abs(Number(t.amount) || 0);
    }

    const months = Object.keys(spendByMonth).sort();
    const currentMonth = isoMonth(now);
    const complete = months.filter(m => m < currentMonth);   // never score a month in progress
    const limit = monthsBack || 6;
    const out = [];

    for (let i = complete.length - 1; i >= 0 && out.length < limit; i--) {
      const m = complete[i];
      const priors = complete.slice(Math.max(0, i - 3), i);
      if (priors.length < 3) continue;                        // not enough history to judge

      const vals = priors.map(p => spendByMonth[p]);
      const floor = Math.min.apply(null, vals);
      const mid   = median(vals);
      const spent = spendByMonth[m];
      if (spent >= floor) continue;                           // not a new low — noise

      const credit = round2(Math.min((mid - spent) * TERMS.causalHaircut, TERMS.maxEventCredit));
      if (credit < 1) continue;

      out.push({
        id:        'under:' + m,
        kind:      'under_forecast',
        date:      m + '-01',
        amount:    credit,
        attributed:  true,
        confidence: 'inferred',
        title:     'Lowest spending month in four',
        detail:    'Spent ' + fmt(spent) + ' against a ' + fmt(mid) + ' normal',
        evidence: {
          monthSpend:    round2(spent),
          priorMedian:   round2(mid),
          priorLow:      round2(floor),
          monthsCompared: priors,
          haircut:       TERMS.causalHaircut,
        },
      });
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════
     4. DOUBLE CHARGES THAT CAME BACK
     ═══════════════════════════════════════════════════════════════
     Finding a duplicate charge saves nobody anything. Getting it REFUNDED
     does. So a duplicate on its own is never credited — only a duplicate
     followed by a matching credit from the same merchant within 45 days.
     That is money that left the account and came back, visible on both
     sides of the statement. Full amount, no haircut, because there is
     nothing here to infer. */
  function refundsRecovered(transactions) {
    const txns = (transactions || []).filter(t => t && t.date && Number(t.amount));
    const debits  = txns.filter(t => !t.isCredit);
    const credits = txns.filter(t => t.isCredit);
    const out = [];
    const seen = new Set();

    for (let i = 0; i < debits.length; i++) {
      for (let j = i + 1; j < debits.length; j++) {
        const a = debits[i], b = debits[j];
        const amt = Math.abs(Number(a.amount));
        if (amt < 5) continue;
        if (Math.abs(Math.abs(Number(b.amount)) - amt) > 0.005) continue;
        const ka = merchantKey(a.merchant_name || a.name);
        if (!ka || ka !== merchantKey(b.merchant_name || b.name)) continue;
        const gap = Math.abs(daysBetween(a.date, b.date));
        if (gap > 3) continue;                                // same charge twice, not a habit

        const later = parse(a.date) > parse(b.date) ? a : b;
        const refund = credits.find(c =>
          merchantKey(c.merchant_name || c.name) === ka
          && Math.abs(Math.abs(Number(c.amount)) - amt) <= 0.005
          && daysBetween(later.date, c.date) >= 0
          && daysBetween(later.date, c.date) <= 45);
        if (!refund) continue;                                // never came back = never saved

        const id = 'refund:' + ka + ':' + isoDay(refund.date) + ':' + amt.toFixed(2);
        if (seen.has(id)) continue;
        seen.add(id);

        out.push({
          id:        id,
          kind:      'refund_recovered',
          date:      isoDay(refund.date),
          amount:    round2(Math.min(amt, TERMS.maxEventCredit)),
          attributed:  true,
          confidence: 'observed',
          title:     'Double charge, refunded',
          detail:    'Charged twice on ' + shortDay(later.date) + ' — returned ' + shortDay(refund.date),
          evidence: {
            chargedOn:  [isoDay(a.date), isoDay(b.date)],
            refundedOn: isoDay(refund.date),
            amount:     round2(amt),
          },
        });
      }
    }
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════
     DETECTION — everything, deduped, newest first
     ═══════════════════════════════════════════════════════════════ */
  function detectEvents(input) {
    const i = input || {};
    const today = i.today || new Date();
    // How recently the data feed proved it was alive. Anything the Vault
    // claims about a date after this is a claim about a period it could not
    // see. Callers may pass it explicitly; otherwise it is the newest
    // transaction on file.
    const feedLastSeen = i.feedLastSeen || (i.transactions || [])
      .reduce((max, t) => (t && t.date && (!max || isoDay(t.date) > max)) ? isoDay(t.date) : max, null);
    const all = []
      .concat(subscriptionsEnded(i.subscriptions, i.flagged, today, feedLastSeen))
      .concat(overdraftsAvoided(i.forecasts, i.transactions, today))
      .concat(underspendCredits(i.transactions, today))
      .concat(refundsRecovered(i.transactions));

    // Deterministic ids mean re-detection is idempotent; last write wins.
    const byId = new Map();
    for (const e of all) if (e && e.id) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  /* ═══════════════════════════════════════════════════════════════
     THE RETURN — what the subscription bought
     ═══════════════════════════════════════════════════════════════
     THE VAULT NEVER CHARGES ANYTHING. It is a benefit of the Pro
     subscription the user already pays for, not a second bill.

     This started life as a metered billing model — take 25% of proven
     savings, capped at the list price. That was the wrong shape for a
     subscription product. It created a bill that moved every month, made
     the price impossible to state on a pricing page, needed variable
     billing that RevenueCat does not natively do, and asked a person who
     had already paid to feel charged again for a good month. A tool
     included in a subscription should make the subscription feel obvious,
     not more expensive.

     So the money question flips. Instead of "what do we take?" it is:

         did this month's subscription pay for itself?

     `subscriptionCost` here is a REFERENCE, never a charge — it is what
     the user is already paying, quoted so the savings have something to be
     measured against. Nothing in this file bills, debits, or draws down
     anything, and nothing downstream should read these numbers as if it
     did. Every detection rule above is unchanged: the credits still have to
     be provable, because an inflated return is still a lie even when no
     money moves on the back of it. */
  function statementFor(events, month, opts) {
    const t = Object.assign({}, TERMS, opts || {});
    const inMonth = (events || []).filter(e => e && String(e.date || '').slice(0, 7) === month);

    /* Attribution still matters with nothing being charged. Claiming credit
       for a subscription the user cancelled on their own would inflate the
       return, which is the same dishonesty as overbilling — it just costs
       trust instead of money. */
    const attributed   = inMonth.filter(e => e.attributed !== false);
    const unattributed = inMonth.filter(e => e.attributed === false);

    const rawProven = attributed.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const proven    = round2(Math.min(rawProven, t.maxPeriodCredit));
    const ownWins   = round2(unattributed.reduce((s, e) => s + (Number(e.amount) || 0), 0));

    const cost       = t.subscriptionCost;
    const netBenefit = round2(proven - cost);
    // "5.4x" only means something once the subscription has been covered;
    // below that the honest phrasing is how much of it has been earned back.
    const multiple   = cost > 0 ? Math.round((proven / cost) * 10) / 10 : 0;

    return {
      month:            month,
      proven:           proven,
      cappedAt:         rawProven > t.maxPeriodCredit ? t.maxPeriodCredit : null,
      ownWins:          ownWins,
      eventCount:       inMonth.length,
      events:           inMonth,

      // Reference values — what Pro costs, and how the month compares.
      subscriptionCost: cost,
      netBenefit:       netBenefit,
      paidForItself:    proven >= cost,
      multiple:         multiple,
      // Nothing proven yet this month. Not "free" — the subscription is
      // unchanged either way; this month simply has no receipts on it.
      empty:            proven === 0,
    };
  }

  /** Lifetime view: everything proven against everything paid. */
  function vaultSummary(events, opts) {
    const t = Object.assign({}, TERMS, opts || {});
    const months = [...new Set((events || [])
      .map(e => String(e && e.date || '').slice(0, 7))
      .filter(Boolean))].sort();

    let proven = 0, ownWins = 0, monthsPaidForThemselves = 0;
    const statements = months.map(m => {
      const s = statementFor(events, m, t);
      proven += s.proven; ownWins += s.ownWins;
      if (s.paidForItself) monthsPaidForThemselves++;
      return s;
    });

    const paid = round2(months.length * t.subscriptionCost);
    return {
      months:                  months.length,
      monthsPaidForThemselves: monthsPaidForThemselves,
      proven:                  round2(proven),
      ownWins:                 round2(ownWins),
      subscriptionPaid:        paid,
      netBenefit:              round2(proven - paid),
      multiple:                paid > 0 ? Math.round((proven / paid) * 10) / 10 : 0,
      statements:              statements,
    };
  }

  function fmt(n) {
    const v = Number(n) || 0;
    return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US',
      { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  return {
    TERMS,
    merchantKey, observedFee, shortDay,
    subscriptionsEnded, overdraftsAvoided, underspendCredits, refundsRecovered,
    detectEvents, statementFor, vaultSummary,
    _round2: round2, _median: median,
  };
}));
