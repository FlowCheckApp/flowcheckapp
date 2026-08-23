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
const html = fs.readFileSync(path.join(root, 'www/index.html'), 'utf8');

const problems = [];

/* 1. Every back control uses the class, never an inline restyle.
   Both sources: this scanned fc-app.js only, and the one violation in the
   app lived in index.html — Settings had a hand-rolled copy of .fc-sub-back,
   identical but for a 1px padding difference, and it went unenforced. */
[['fc-app.js', app], ['index.html', html]].forEach(([name, src]) => {
  const inlineBack = [...src.matchAll(/(?:_closeSubScreen|_backToParent)\(\)"\s+style=/g)];
  if (inlineBack.length) {
    problems.push(`${name}: ${inlineBack.length} back button(s) carry inline styles instead of class="fc-sub-back".`);
  }
});

/* 1b. Every view that borrows another tab's nav highlight is a PUSH, and a
   push needs a way back. Activity and More each rendered a full page header
   with no exit at all, while the nav lit a tab the user was not on — so the
   only way out was to guess which of the five items to press. The parent
   table in fc-app.js is the list of screens this applies to, so read it
   rather than keeping a second copy here that can drift out of step. */
const parentTable = app.match(/const _NAV_PARENT = \{([^}]*)\}/);
if (!parentTable) {
  problems.push('fc-app.js: _NAV_PARENT is gone — parented views can no longer be checked for a way back.');
} else {
  const parented = [...parentTable[1].matchAll(/(\w+)\s*:/g)].map(m => m[1]);
  parented.forEach(view => {
    const open = html.indexOf(`id="view-${view}"`);
    if (open === -1) return;                       // rendered entirely from JS
    /* The view's own markup, up to the next view. */
    const next = html.indexOf('id="view-', open + 1);
    const block = html.slice(open, next === -1 ? html.length : next);
    /* Match the class within a class list, not an exact attribute value.
       The exact form failed the moment Activity's control gained a second
       class for its nav-bar position — the control was present, 63x45pt and
       working, and the check called it missing. A check that fails on
       correct code teaches people to ignore it. */
    if (!/class="[^"]*\bfc-sub-back\b[^"]*"/.test(block)) {
      problems.push(
        `view-${view} borrows the "${parentTable[1].match(new RegExp(view + "\\s*:\\s*'(\\w+)'"))?.[1]}" ` +
        `nav highlight but has no .fc-sub-back — it is a push with no way out.`
      );
    }
  });
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

/* 4. Every sheet has exactly ONE visible dismiss control: the grabber, which
      is a real <button aria-label="Close"> so it is reachable by VoiceOver.
      A second control (a header X) is the "three exits" problem in miniature. */
/* Extract each overlay by DIV DEPTH, not by "text until the next overlay".
   The last sheet in the document has no next overlay, so a text-range regex
   ran to EOF and swallowed the in-app page viewer's X — reporting a second
   dismiss control on a sheet that has exactly one. */
function overlayBodies(src) {
  const out = [];
  const open = /<div id="([a-zA-Z-]+)"[^>]*class="fc-sheet-overlay"/g;
  let m;
  while ((m = open.exec(src))) {
    let i = m.index, depth = 0, j = i;
    const tag = /<div\b|<\/div>/g;
    tag.lastIndex = i;
    let t;
    while ((t = tag.exec(src))) {
      depth += t[0] === '</div>' ? -1 : 1;
      if (depth === 0) { j = t.index + 6; break; }
    }
    out.push({ id: m[1], body: src.slice(i, j) });
  }
  return out;
}
const overlays = overlayBodies(html);
for (const { id, body } of overlays) {
  if (!/class="fc-sheet-handle"/.test(body)) {
    problems.push(`sheet #${id} has no grabber — it would have no visible way out.`);
  } else if (!/<button[^>]*class="fc-sheet-handle"[^>]*aria-label="Close"/.test(body)) {
    problems.push(`sheet #${id} grabber is not a labelled <button> — a bare div is not reachable by VoiceOver, and this is a WebView so the native sheet-dismiss gesture does not apply.`);
  }
  const extra = (body.match(/aria-label="Close"/g) || []).length - 1;
  if (extra > 0) {
    problems.push(`sheet #${id} has ${extra} dismiss control(s) besides the grabber — one way out per surface.`);
  }
}

/* 5. The grabber must stay a single definition. A duplicate in index.html's
      inline <style> silently won (it loads last) and kept the bar painted on
      the element instead of its ::before, so the finger-sized target was
      never actually 36px-wide-only by accident — it was 36x4. */
const dupes = (html.match(/^\.fc-sheet-handle\s*\{/gm) || []).length;
if (dupes) {
  problems.push(`index.html redefines .fc-sheet-handle (${dupes}x); it belongs in flowcheck-design-system.css only, and a copy here overrides it.`);
}

if (problems.length) {
  console.error('✗ back-affordance check failed:\n');
  problems.forEach(p => console.error('  ' + p));
  console.error('\n  One way back per surface. Push → .fc-sub-back (chevron + "Back").');
  console.error('  Modal → a single X. Backdrop tap and swipe-down are gestures, not controls.');
  process.exit(1);
}

const canonical = (app.match(/class="fc-sub-back"/g) || []).length;
console.log(`✓ back affordances: ${canonical} sub-screen back button(s) on one class; ${overlays.length} sheet(s), each with exactly one labelled grabber; legal pages hide their own exits when framed`);
