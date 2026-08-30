'use strict';
/**
 * leaderboard.js — ranking users against each other without ever comparing
 * their money.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE SCORE CONTAINS NO DOLLAR AMOUNTS
 * ─────────────────────────────────────────────────────────────────────────
 * The obvious leaderboard for a finance app ranks net worth, or savings, or
 * "most money put away this month". Every one of those is wrong here, for
 * three separate reasons, and the third is the one that actually decides it:
 *
 *   1. It leaks. This app's promise is that nobody sees your balances. A
 *      board that sorts users by an amount tells every participant roughly
 *      what every other participant has, and the top entry exactly.
 *
 *   2. It does not motivate. In any ranking by wealth most people sit near
 *      the bottom permanently, and nothing they do this week moves them.
 *      A leaderboard you cannot climb is a leaderboard you stop opening.
 *
 *   3. It is not a contest. Someone earning five times as much cannot be
 *      out-saved by effort. Ranking on amounts ranks income, and income is
 *      mostly not the thing the user controls this month.
 *
 * So every component below is SELF-RELATIVE and DIMENSIONLESS: each user is
 * measured against their own past, never against another user's figures.
 * A student and a surgeon can genuinely compete, and the board can be shown
 * to strangers because there is no amount in it to show.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY NOT `streak`, WHICH ALREADY EXISTS AND WOULD HAVE BEEN FREE
 * ─────────────────────────────────────────────────────────────────────────
 * `streak` is in allowedUserUpdateFields() in firestore.rules — the CLIENT
 * writes it. That is fine for a number you show a user about themselves; it
 * is disqualifying for a competitive ranking shown to everyone, because the
 * top of the board would eventually be whoever wrote `streak: 99999` from a
 * console, and the honest users would see an unbeatable fake and leave.
 *
 * Everything scored here comes from `users/{uid}/transactions`, which is
 * `allow write: if false` — Plaid-derived, backend-owned, not forgeable by
 * the account it describes. If you add a component, check the rules first:
 * a client-writable input turns this into a typing contest.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE WINDOWS ARE UTC
 * ─────────────────────────────────────────────────────────────────────────
 * Everywhere else in FlowCheck a 'YYYY-MM-DD' is a LOCAL day, because it is
 * being shown to the one person it belongs to (see check-utc-dates.js).
 * A leaderboard is the exception and must not follow that rule: it compares
 * users to each other, so they have to share one clock. If each user's
 * "last 30 days" started at their own midnight, two users would be scored
 * over different spans and the ranking between them would be meaningless.
 * One instant, one window, computed for everyone at once.
 */

/** Day keys are compared as strings, which is timezone-free and exact. */
function dayKey(ms) {
  const d = new Date(ms);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/* A window shorter than this cannot distinguish a habit from a good week,
   and a user newer than this has no "own past" to be measured against. */
const MIN_HISTORY_DAYS = 60;

/* Below this many ranked participants a leaderboard is not a leaderboard —
   it is a list of the three people who happened to opt in, and being told
   you are 2nd of 3 motivates nobody. The board holds itself back until it
   has a population. */
const MIN_PARTICIPANTS = 5;

const RECENT_DAYS = 30;
const BASELINE_DAYS = 90;
const CONSISTENCY_WEEKS = 8;

/* Transfers, credit-card payments and investment buys are movements between
   a user's own pockets, not spending or income. Counting them would make
   somebody who moves money to savings look like a huge spender AND a huge
   earner in the same window, and net to a savings rate of roughly zero. */
const INTERNAL = new Set([
  'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS',
]);

function isInternal(txn) {
  return INTERNAL.has(txn.category);
}

/** Median without mutating the caller's array. */
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

/**
 * How much of what came in did not go back out, over the recent window.
 *
 * Clamped at 0 rather than allowed to go negative: a month where you spent
 * more than you earned is a 0, not a −3, so that one bad month cannot sink
 * a score below what a user who does nothing at all would score. The board
 * ranks progress, and an unrecoverable hole is not progress.
 */
function savingsRate(txns) {
  let income = 0;
  let spend = 0;
  for (const t of txns) {
    if (isInternal(t)) continue;
    if (t.isCredit) income += t.amount;
    else spend += t.amount;
  }
  if (income <= 0) return null;  // nothing came in — not a rate, an unknown
  return clamp((income - spend) / income, 0, 1);
}

/**
 * Is spending going down relative to this user's own baseline?
 *
 * The single most motivating component, because it is the one that answers
 * "did I do better than last month" rather than "am I rich". Compared as
 * daily averages so the unequal window lengths do not decide it.
 */
function momentum(recent, baseline) {
  const recentDaily = spendPerDay(recent, RECENT_DAYS);
  const baseDaily = spendPerDay(baseline, BASELINE_DAYS);
  if (baseDaily <= 0) return null;
  /* −1 = doubled your spending, 0 = unchanged, +1 = cut it to nothing.
     Mapped onto 0..1 so "unchanged" sits at the middle of the range. */
  const change = (baseDaily - recentDaily) / baseDaily;
  return clamp((clamp(change, -1, 1) + 1) / 2, 0, 1);
}

function spendPerDay(txns, days) {
  let spend = 0;
  for (const t of txns) {
    if (!isInternal(t) && !t.isCredit) spend += t.amount;
  }
  return days > 0 ? spend / days : 0;
}

/**
 * How EVEN this user's spending is across the last eight weeks.
 *
 * Present so the score cannot be won with one dramatic month. Someone who
 * spends nothing for three weeks then blows out the fourth has the same
 * total as someone steady, and a total-based score would call them equal.
 *
 * Measured as spread relative to size (the coefficient of variation), which
 * is dimensionless like everything else here — a $200/week user and a
 * $2,000/week user with the same evenness score the same.
 *
 * The first version of this counted weeks at or under the user's own median.
 * That reads as reasonable and is nearly useless: for any user whose weeks
 * are not all identical, half of them fall below their own median BY
 * DEFINITION, so it returned ~0.5 for everybody and separated only the
 * perfectly flat. It contributed no ranking information at all.
 */
function consistency(txns, nowMs) {
  const weeks = new Array(CONSISTENCY_WEEKS).fill(0);
  const oldest = dayKey(nowMs - CONSISTENCY_WEEKS * 7 * DAY_MS);
  let sawAny = false;

  for (const t of txns) {
    if (isInternal(t) || t.isCredit) continue;
    if (t.date < oldest) continue;
    const age = Math.floor((nowMs - Date.parse(`${t.date}T00:00:00Z`)) / DAY_MS);
    const bucket = Math.floor(age / 7);
    if (bucket < 0 || bucket >= CONSISTENCY_WEEKS) continue;
    weeks[bucket] += t.amount;
    sawAny = true;
  }
  if (!sawAny) return null;

  const mean = weeks.reduce((sum, w) => sum + w, 0) / CONSISTENCY_WEEKS;
  if (mean <= 0) return null;
  const variance =
    weeks.reduce((sum, w) => sum + (w - mean) ** 2, 0) / CONSISTENCY_WEEKS;
  /* A CV of 1 (spread as large as the average week) scores 0; a CV of 0
     scores 1. Beyond 1 is clamped rather than allowed to go negative. */
  return clamp(1 - Math.sqrt(variance) / mean, 0, 1);
}

/* Weights. Savings rate carries the most because it is the closest thing to
   the outcome the app exists to improve; momentum is next because it is the
   part a user can move this week; consistency is the tiebreaker that stops
   one lucky month from topping the board. */
const WEIGHTS = { savings: 0.5, momentum: 0.3, consistency: 0.2 };

/**
 * Score one user from their own transactions.
 *
 * Returns `{ eligible: false, reason }` rather than a zero when a user
 * cannot be scored, so the UI can say WHY someone is not on the board.
 * A silent zero would put every new user at the bottom of a ranking they
 * did not lose — they just have not been here long enough yet.
 */
function scoreUser(transactions, nowMs = Date.now()) {
  const txns = (transactions || []).filter(t => t && t.date && !t.pending);
  if (!txns.length) {
    return { eligible: false, reason: 'no_transactions' };
  }

  const oldest = txns.reduce((min, t) => (t.date < min ? t.date : min), txns[0].date);
  const spanDays = Math.floor((nowMs - Date.parse(`${oldest}T00:00:00Z`)) / DAY_MS);
  if (spanDays < MIN_HISTORY_DAYS) {
    return { eligible: false, reason: 'too_new', daysUntilEligible: MIN_HISTORY_DAYS - spanDays };
  }

  const recentFrom = dayKey(nowMs - RECENT_DAYS * DAY_MS);
  const baseFrom = dayKey(nowMs - (RECENT_DAYS + BASELINE_DAYS) * DAY_MS);

  const recent = txns.filter(t => t.date >= recentFrom);
  const baseline = txns.filter(t => t.date >= baseFrom && t.date < recentFrom);

  const parts = {
    savings: savingsRate(recent),
    momentum: momentum(recent, baseline),
    consistency: consistency(txns, nowMs),
  };

  /* Renormalise over the components that could actually be computed, rather
     than scoring a missing one as zero. Someone whose paycheque lands
     outside the window has an unknown savings rate, not a savings rate of
     nothing, and treating those the same would rank them below a user who
     genuinely saved none of a known income. */
  let weighted = 0;
  let totalWeight = 0;
  for (const key of Object.keys(WEIGHTS)) {
    if (parts[key] == null) continue;
    weighted += parts[key] * WEIGHTS[key];
    totalWeight += WEIGHTS[key];
  }
  if (totalWeight <= 0) {
    return { eligible: false, reason: 'not_enough_signal' };
  }

  return {
    eligible: true,
    score: Math.round((weighted / totalWeight) * 1000),
    components: {
      savings: parts.savings == null ? null : Math.round(parts.savings * 100),
      momentum: parts.momentum == null ? null : Math.round(parts.momentum * 100),
      consistency: parts.consistency == null ? null : Math.round(parts.consistency * 100),
    },
  };
}

/**
 * Rank scored entries, sharing a rank between ties.
 *
 * Ties are common here because the score is a rounded integer over a small
 * range, and quietly ordering equal scores by document id would show two
 * users with identical numbers at 4th and 5th with no visible reason —
 * which reads as a bug to the one placed lower.
 */
function rankBoard(entries) {
  const sorted = [...entries].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.handle || '').localeCompare(String(b.handle || ''));
  });

  let lastScore = null;
  let lastRank = 0;
  return sorted.map((entry, index) => {
    const rank = entry.score === lastScore ? lastRank : index + 1;
    lastScore = entry.score;
    lastRank = rank;
    return { ...entry, rank };
  });
}

/* ─────────────────────────────────────────────────────────────────────────
 * HANDLES
 * ───────────────────────────────────────────────────────────────────────── */

const HANDLE_RE = /^[a-z0-9](?:[a-z0-9_]{1,16})[a-z0-9]$/;

/**
 * Reject anything that is not a plain handle, with a reason worth showing.
 *
 * Returns `{ handle }` normalised to lowercase, or `{ error }`. Lowercasing
 * is what makes the uniqueness index honest: without it `Brandon` and
 * `brandon` are two documents and two people on one board answering to the
 * same name.
 */
function validateHandle(raw) {
  const handle = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!handle) return { error: 'Pick a display name.' };
  if (handle.length < 3) return { error: 'That is too short — 3 characters minimum.' };
  if (handle.length > 18) return { error: 'That is too long — 18 characters maximum.' };
  /* Blocking '@' and '.' specifically: the single most likely thing a user
     types into an unfamiliar name field is their email address, and this is
     a surface other people read. The charset below already excludes both;
     this exists so that case gets a message that explains itself rather than
     the generic "letters and numbers only". */
  if (handle.includes('@') || handle.includes('.')) {
    return { error: 'Use a nickname here, not an email — everyone on the board can see it.' };
  }
  if (!HANDLE_RE.test(handle)) {
    return { error: 'Letters, numbers and underscores only, starting and ending with a letter or number.' };
  }
  return { handle };
}

module.exports = {
  scoreUser,
  rankBoard,
  validateHandle,
  dayKey,
  MIN_PARTICIPANTS,
  MIN_HISTORY_DAYS,
  // exported for tests
  _internals: { savingsRate, momentum, consistency, median, isInternal },
};
