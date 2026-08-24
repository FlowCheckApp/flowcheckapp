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

/* ── Nothing may resize itself instantly when the keyboard opens ──────
 *
 * body.keyboard-open changes layout on several elements at once: the auth
 * orb fades, the header art collapses, the subtitle's height goes, the
 * screen's top padding shrinks, and a sheet reserves 69px for the Done bar.
 * They all animate over ~0.25s — except the ones that did not, and a single
 * untransitioned property in that group is enough to make the whole reflow
 * read as a lurch, because half the screen eases and half of it jumps.
 *
 * Three were found this way and none was visible in a browser:
 *   · .fc-auth-title  font-size, snapping while the art above it eased
 *   · .fc-auth-screen padding-top, shifting everything below it in one frame
 *   · .fc-sheet       padding-bottom, a 69px jump on every tap into an
 *                     amount field — which is most fields anyone types into
 *
 * A transition declared on the BASE selector counts: that is the correct
 * place for it, since the transition belongs to the element and not to the
 * state. The global prefers-reduced-motion rule neuters all of them, so
 * adding one costs nothing for users who have asked for stillness.
 */
{
  const ANIMATABLE = /(font-size|max-height|min-height|height|padding[a-z-]*|margin[a-z-]*|opacity|transform)\s*:/;
  const ruleRe = /body\.keyboard-open([^{]*?)\{([^}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(html)) !== null) {
    const sel  = m[1].trim();
    const body = m[2];
    if (!ANIMATABLE.test(body)) continue;
    if (/transition/.test(body)) continue;
    if (!sel) continue;                       // bare body rule: nothing to ease

    /* Is the element transitioned anywhere?

       The transition belongs on the ELEMENT, not on the state — so look for
       it on the last class in the selector, in any rule, rather than
       requiring it inside the keyboard-open block itself. For
       ".fc-kb-numeric .fc-sheet" that means .fc-sheet, which is where a
       sheet's transition correctly lives. */
    const classes = sel.match(/\.[-\w]+/g);
    if (classes && classes.length) {
      const last = classes[classes.length - 1];
      const esc  = last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const anyRule = new RegExp(esc + '(?![-\\w])[^{}]*\\{[^}]*transition[^}]*\\}');
      if (anyRule.test(html)) continue;
    }

    const line = html.slice(0, m.index).split('\n').length;
    failures.push(`www/index.html:${line} — body.keyboard-open ${sel} changes layout `
      + `with no transition. Half the screen eases and this half jumps, which is `
      + `what reads as the keyboard "glitching". Put a transition on ${sel}.`);
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
