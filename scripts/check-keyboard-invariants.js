#!/usr/bin/env node
/**
 * check-keyboard-invariants.js
 *
 * The keyboard is the one surface where a missing attribute is invisible in a
 * browser and obvious on a phone. Every rule here is something that was
 * actually wrong and was actually felt:
 *
 *   · A text field with no autocorrect="off" gets its merchant or bill name
 *     rewritten by iOS as you type it.
 *   · A field with no enterkeyhint shows a Return key labelled "return" that
 *     does nothing, on a form whose only other exit is tapping the background.
 *   · An inline style="padding:24px" on a sheet drops the bottom safe-area
 *     inset AND outranks the keyboard-open override, because inline styles win.
 *   · -webkit-user-select:none inherited into an <input> takes away caret
 *     placement and the selection loupe — you can type but not correct.
 *   · A SECOND keyboard listener set is the bug this whole area keeps having
 *     (94e7c1c deleted one, and the two had been fighting for weeks).
 *
 * Exit 0 = clean. Exit 1 = something regressed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(root, 'www/js/fc-app.js'), 'utf8');

const failures = [];
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/* ── 1. Field attributes ──────────────────────────────────────────── */
// Types that open a keyboard with a Return key. select/date/month/number-pad
// fields have no Return key on iOS, so enterkeyhint is meaningless for them.
const NEEDS_ENTERKEYHINT = new Set(['text', 'email', 'password', 'search', 'url']);
// Free-text fields where iOS autocorrect actively corrupts input.
const NEEDS_AUTOCORRECT_OFF = new Set(['text', 'search']);

const fields = [];
const tagRe = /<(input|textarea|select)\b[\s\S]{0,500}?>/g;
let m;
while ((m = tagRe.exec(html))) {
  const tag = m[0];
  if (/type=["']?(hidden|checkbox|radio|submit|button)/.test(tag)) continue;
  fields.push({
    tag,
    line: lineOf(html, m.index),
    id: (tag.match(/id=["']([^"']+)/) || [])[1] || '(no id)',
    type: (tag.match(/type=["']([^"']+)/) || [])[1] || m[1],
  });
}

for (const f of fields) {
  /* A numeric inputmode gets the number pad, which has no autocorrect, no
     shift key and no Return key. Demanding autocorrect/autocapitalize on
     those is noise — the keyboard cannot do either. */
  const numericPad = /inputmode=["'](decimal|numeric|tel)/.test(f.tag);

  if (NEEDS_ENTERKEYHINT.has(f.type) && !numericPad && !/enterkeyhint=/.test(f.tag)) {
    failures.push(`www/index.html:${f.line} ${f.id} [${f.type}] has no enterkeyhint — `
      + `its Return key will say "return" and do nothing`);
  }
  if (NEEDS_AUTOCORRECT_OFF.has(f.type) && !numericPad && !/autocorrect=["']off/.test(f.tag)) {
    failures.push(`www/index.html:${f.line} ${f.id} [${f.type}] has no autocorrect="off" — `
      + `iOS will rewrite what the user types`);
  }
  // A field the user types a name into must not be sentence-capitalised, and
  // must not be left to iOS's default. email/tel/number suppress this natively.
  if (f.type === 'text' && !numericPad && !/autocapitalize=/.test(f.tag)) {
    failures.push(`www/index.html:${f.line} ${f.id} [text] has no autocapitalize`);
  }
}

/* ── 2. Sheets must not carry inline padding ──────────────────────── */
const inlinePad = [...html.matchAll(/<div[^>]*class="[^"]*fc-sheet[^"]*"[^>]*style="[^"]*padding:\s*24px/g)];
inlinePad.forEach(hit => {
  failures.push(`www/index.html:${lineOf(html, hit.index)} a sheet still has inline `
    + `padding:24px — it drops env(safe-area-inset-bottom) and outranks the `
    + `body.keyboard-open override. Use class="fc-sheet fc-sheet--form".`);
});

/* ── 3. Inputs inside sheets must stay selectable ─────────────────── */
if (!/\.fc-sheet input[\s\S]{0,200}user-select:\s*text/.test(html)) {
  failures.push('www/index.html — the rule restoring user-select:text on form '
    + 'controls inside .fc-sheet is gone. .fc-sheet sets user-select:none, and '
    + 'inheriting that into an input removes caret placement on iOS.');
}

/* ── 4. Exactly ONE keyboard listener set ─────────────────────────── */
// Counted across both files: index.html owns it, fc-app.js must not re-add one.
const kbListeners = [
  ...html.matchAll(/addListener\(\s*['"]keyboard(WillShow|DidShow|WillHide|DidHide)['"]/g),
  ...appJs.matchAll(/addListener\(\s*['"]keyboard(WillShow|DidShow|WillHide|DidHide)['"]/g),
];
const inApp = [...appJs.matchAll(/addListener\(\s*['"]keyboard(WillShow|DidShow|WillHide|DidHide)['"]/g)];
if (inApp.length) {
  failures.push(`www/js/fc-app.js has ${inApp.length} keyboard listener(s). Keyboard `
    + `handling lives ONLY in the "Keyboard avoidance" IIFE in index.html — a `
    + `second set was deleted in 94e7c1c after the two fought for weeks.`);
}
if (!kbListeners.length) {
  failures.push('no keyboard listeners found at all — the avoidance IIFE is gone');
}

/* ── 5. No focusing a field on a setTimeout guess ─────────────────── */
/* Focusing summons the keyboard, and resize:"native" makes the keyboard
   resize the WebView. Doing that while a container is still animating means
   the sheet is repositioned toward a new viewport bottom while an animation
   still drives it toward the old one — the bounce Brandon reported.
   The app had FOUR different guesses at the animation length (150/200/250/
   400ms) against a 360ms overshooting spring. _focusField() asks the browser
   what is actually running instead. Use it.

   Allowed: focusing a BUTTON (no keyboard, so no resize, so no race). */
const ALLOWED_TIMEOUT_FOCUS = [
  'fcst-close',   // story overlay close button — a button, not a text field
];
for (const [src, name] of [[appJs, 'www/js/fc-app.js'], [html, 'www/index.html']]) {
  const re = /setTimeout\([\s\S]{0,200}?\.focus\(\)/g;
  let hit;
  while ((hit = re.exec(src))) {
    if (ALLOWED_TIMEOUT_FOCUS.some(ok => hit[0].includes(ok))) continue;
    failures.push(`${name}:${lineOf(src, hit.index)} focuses a field inside a `
      + `setTimeout. Use _focusField(input[, scope]) — it waits for whatever is `
      + `actually animating instead of guessing a duration.`);
  }
}

/* ── 6. The class CSS keys off must be the one JS sets ────────────── */
const setsClass = /classList\.add\(\s*['"]keyboard-open['"]/.test(html);
const stylesClass = /body\.keyboard-open/.test(html);
if (!setsClass || !stylesClass) {
  failures.push('the keyboard-open class is set by JS but unused by CSS (or vice '
    + 'versa) — this exact mismatch (fc-keyboard-open vs keyboard-open) is why '
    + 'the avoidance system silently did nothing.');
}

/* ── The keyboard has ONE owner ───────────────────────────────────────
 *
 * Capacitor is configured resize:"native", so iOS resizes the WebView when
 * the keyboard appears and the page reflows once, on the system's own
 * animation. Anything else that moves the same pixels at the same time is a
 * second owner, and two owners is what "glitchy" means here.
 *
 * This rule replaces an earlier one that required the opposite. I had read
 * the mismatched timings as the bug — some properties eased, some snapped —
 * and added transitions so they would match. That made it worse: a matched
 * pair of page animations still races the viewport animation underneath it.
 * The mismatch was a symptom of there being animations at all.
 *
 * So: no transition on a layout property that changes under
 * body.keyboard-open, and no overshoot in a sheet's entry curve, since a
 * spring settling back while the WebView resizes is exactly the "goes up
 * then drops" people report.
 */
{
  const LAYOUT = /(font-size|max-height|min-height|height|padding|margin|top|bottom|transform)/;
  const ruleRe = /body\.keyboard-open([^{]*?)\{([^}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(html)) !== null) {
    const sel = m[1].trim(), body = m[2];
    const tm = body.match(/transition\s*:\s*([^;]+)/);
    if (!tm || /^\s*none\b/.test(tm[1])) continue;
    if (!LAYOUT.test(tm[1])) continue;
    const line = html.slice(0, m.index).split('\n').length;
    failures.push(`www/index.html:${line} — body.keyboard-open ${sel} transitions `
      + `a layout property (${tm[1].trim().slice(0, 48)}). iOS is already animating the `
      + `viewport; this animates on top of it. The page must not move while the `
      + `WebView resizes.`);
  }

  /* An overshoot is any cubic-bezier whose y control point exceeds 1 — but
     only on something that can be on screen WITH the keyboard. A tour card
     and a paywall celebration both spring, and both should: neither hosts a
     text field. Scoped to sheets, which do. */
  const sheetRuleRe = /(\.fc-sheet|\.fc-sheet-overlay)[^{]*\{([^}]*)\}/g;
  let sr;
  while ((sr = sheetRuleRe.exec(html)) !== null) {
    const bez = sr[2].match(/animation:[^;]*cubic-bezier\(\s*[\d.-]+\s*,\s*([\d.-]+)\s*,\s*[\d.-]+\s*,\s*([\d.-]+)\s*\)/);
    if (!bez) continue;
    if (parseFloat(bez[1]) <= 1 && parseFloat(bez[2]) <= 1) continue;
    const line = html.slice(0, sr.index).split('\n').length;
    failures.push(`www/index.html:${line} — a sheet's entry animation uses an `
      + `overshoot curve (control point > 1). A sheet that springs past its resting `
      + `position and settles back reads as "it went up then dropped" when the `
      + `keyboard opens with it.`);
  }
}

/* ── Report ───────────────────────────────────────────────────────── */
if (failures.length) {
  console.error('Keyboard invariant check FAILED:\n');
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error(`\n${failures.length} problem(s).\n`);
  process.exit(1);
}

console.log(`keyboard check: ${fields.length} fields, `
  + `${kbListeners.length} listener(s) in one place`);
console.log('✓ every field declares its keyboard, and sheets stay selectable.');
