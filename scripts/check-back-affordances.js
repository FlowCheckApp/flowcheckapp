#!/usr/bin/env node
/**
 * check-back-affordances.js
 *
 * ONE way back per surface, and the same one for the same relationship.
 *
 * WHY
 * ---
 * The app had accumulated several vocabularies for "go back", and the drift
 * was invisible in review because each one reads as correct on its own:
 *
 *   · seven sub-screens each inlined the same flex/colour/44px back button,
 *     and one had drifted to a literal "←" at font-weight 500 while the
 *     other six used a chevron SVG at 600;
 *   · the in-app legal viewer showed THREE ways out of one page — the app's
 *     own X, the page's sticky "‹ FlowCheck" bar, and the site nav's
 *     "← Back to Home" — and the sticky one called history.back(), which
 *     inside an iframe moves the frame and never leaves the app.
 *
 * THE RULE
 * --------
 *   push (a sub-screen over a tab)  → chevron-left + "Back", class .fc-sub-back
 *   modal (sheet / full-screen)     → a single X, or a grabber; never both
 *
 * Backdrop taps and swipe-down are gestures, not visible controls, and do
 * not count against the one-control rule.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'www/js/fc-app.js'), 'utf8');

const problems = [];

/* 1. Every sub-screen back control uses the class, never an inline restyle. */
const inlineBack = [...app.matchAll(/_closeSubScreen\(\)"\s+style=/g)];
if (inlineBack.length) {
  problems.push(`${inlineBack.length} sub-screen back button(s) carry inline styles instead of class="fc-sub-back".`);
}

/* 2. Nobody reintroduces an arrow glyph where the chevron SVG is the shape. */
app.split('\n').forEach((line, i) => {
  if (/_closeSubScreen/.test(line) && /[←⬅]/.test(line)) {
    problems.push(`fc-app.js:${i + 1} back control uses an "←" glyph; the shape is the chevron SVG.`);
  }
});

/* 3. The legal pages must not ship their own exits into the app's frame.
      They hide their chrome via .fc-embed — if that block goes, the three
      exits come back. */
for (const page of ['terms', 'privacy', 'support']) {
  const p = path.join(root, 'www/legal', page + '.html');
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  if (!/\.fc-embed nav/.test(src)) {
    problems.push(`www/legal/${page}.html no longer hides its nav when framed — the in-app viewer will show 3 ways out.`);
  }
  if (!/window\.self\s*!==\s*window\.top/.test(src)) {
    problems.push(`www/legal/${page}.html lost its frame detection, so .fc-embed never applies.`);
  }
}

if (problems.length) {
  console.error('✗ back-affordance check failed:\n');
  problems.forEach(p => console.error('  ' + p));
  console.error('\n  One way back per surface. Push → .fc-sub-back (chevron + "Back").');
  console.error('  Modal → a single X. Backdrop tap and swipe-down are gestures, not controls.');
  process.exit(1);
}

const canonical = (app.match(/class="fc-sub-back"/g) || []).length;
console.log(`✓ back affordances: ${canonical} sub-screen back button(s), all on one class; legal pages hide their own exits when framed`);
