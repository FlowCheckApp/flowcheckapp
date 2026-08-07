#!/usr/bin/env node
/**
 * check-motion-invariants.js
 *
 * Guards the motion rules that are invisible when broken — the ones that cost
 * nothing to delete, throw no error, and just make the app feel cheap.
 *
 * 1. THE OUTGOING VIEW MUST LEAVE THE FLOW BEFORE THE INCOMING ONE ACTIVATES.
 *    For ~120ms of every tab switch both views carry .active, and
 *    `.fc-view.active` is `display:flex; flex:1` inside a column — so they
 *    become flex siblings and split the column between them. Measured, before
 *    the fix: the outgoing view jumped from y=62/h=750 to y=429/h=383 and the
 *    incoming content spent the entire fade at half height. That is 0.42 of
 *    cumulative layout shift PER SWITCH, against a "good" threshold of 0.1,
 *    on the most frequent interaction in the app.
 *
 *    Nothing about it throws, logs, or fails a test. It just looks cheap.
 *    Delete the pinning lines in switchTab() and it silently comes back, which
 *    is why it is checked here rather than trusted to review.
 *
 * 2. THE TAB TRANSITION MUST HAVE A REDUCED-MOTION PATH.
 *    The transition animates transform; users who ask for reduced motion get
 *    the crossfade without the movement. If the override is removed, that
 *    preference is silently ignored.
 *
 * 3. THE MONEY WEEK STORY PLAYER.
 *    A 30-second auto-advancing recap. Its progress bar animates every frame
 *    for the whole runtime, so it has to be a transform and not width. Its
 *    cards vary ~179–335px in height inside a vertically-centred box, so they
 *    need a fixed box or the content re-seats on every advance. And it must
 *    keep press-and-hold to pause and Escape to close: without the first, a
 *    card you wanted to read is gone in five seconds; without the second, an
 *    aria-modal dialog traps you.
 *
 * This is a STATIC check — it verifies the code that produces the behaviour,
 * not the behaviour. Frame timing and layout shift are measured in a real
 * browser (0 shift, 0 late frames, worst frame 17.7ms across 12 switches).
 *
 * Exit 0 = clean. Exit 1 = a silent motion regression.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const failures = [];

/**
 * Extract a function body by brace-matching from its declaration.
 * A lazy regex (/function switchTab\([\s\S]*?\n  \}/) stops at the first line
 * that happens to look like a closing brace at that indent — which inside
 * switchTab is an early `if` block, not the end of the function. It silently
 * returned a truncated body and the ordering check below passed on code where
 * the pinning had been moved after activation.
 */
function functionBody(src, name) {
  const start = src.indexOf('function ' + name);
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/* ── 1. switchTab pins the outgoing view ─────────────────────────── */
const app = read('www/js/fc-app.js');
const body = functionBody(app, 'switchTab');
if (!body) {
  failures.push('www/js/fc-app.js: could not find switchTab() — this check needs updating.');
} else {

  const pins = /outgoing\.style\.position\s*=\s*'absolute'/.test(body);
  if (!pins) {
    failures.push(
      'www/js/fc-app.js switchTab(): the outgoing view is no longer pinned out of flow.\n' +
      '    Two .active views are flex siblings and will split the column, producing ~0.42\n' +
      '    layout shift on every tab switch. Restore the position/top/left/width/height\n' +
      '    assignment that runs BEFORE the incoming view gets .active.');
  }

  // Order matters: pinning after the incoming activates measures the wrong box.
  // Anchor on the `= 'absolute'` assignment specifically. Searching for the
  // bare "outgoing.style.position" also matches the RESET line in the
  // setTimeout, which sits earlier in source order once the pin is moved —
  // so the ordering check silently passed on exactly the code it exists to
  // catch.
  const pinMatch = body.match(/outgoing\.style\.position\s*=\s*'absolute'/);
  const pinAt = pinMatch ? pinMatch.index : -1;
  const actAt = body.indexOf("target.classList.add('active'");
  if (pins && pinAt > -1 && actAt > -1 && pinAt > actAt) {
    failures.push(
      'www/js/fc-app.js switchTab(): the outgoing view is pinned AFTER the incoming one is\n' +
      '    activated. By then both are flex siblings, so the captured rect is already the\n' +
      '    squeezed half-height box and the shift happens anyway. Pin it first.');
  }

  // It must also be un-pinned, or the view stays absolutely positioned forever.
  if (pins && !/outgoing\.style\.position\s*=\s*(outgoing\.style\.\w+\s*=\s*)*''/.test(body)
           && !/outgoing\.style\.position\s*=\s*''/.test(body)) {
    failures.push(
      'www/js/fc-app.js switchTab(): the outgoing view is pinned but never un-pinned.\n' +
      '    It will stay position:absolute at a stale size the next time it is shown.');
  }
}

/* ── 2. reduced-motion override for the tab transition ───────────── */
const html = read('www/index.html');
const reducedBlocks = html.match(/@media[^{]*prefers-reduced-motion[^{]*\{[\s\S]*?\n\}/g) || [];
const coversTabs = reducedBlocks.some(b => /fcTabIn|fc-tab-in/.test(b));
if (!coversTabs) {
  failures.push(
    'www/index.html: no prefers-reduced-motion override for the tab transition.\n' +
    '    fcTabIn/fcTabOut animate transform; without an override, users who asked the OS\n' +
    '    for reduced motion still get the movement.');
}

/**
 * Pull out one @keyframes block by brace-matching.
 * A regex like /@keyframes fcTabIn\s*\{[\s\S]*?scale\(/ looks right and is
 * useless here: keyframes contain nested { } blocks, so the lazy match runs
 * straight past the closing brace and happily finds a scale() somewhere else
 * in the file. It reported a pass after the keyframes were flattened.
 */
function keyframesBlock(src, name) {
  const start = src.indexOf('@keyframes ' + name);
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/* The default keyframes should still carry the depth transform — if someone
   flattens them back to opacity-only, that is a design decision, but it should
   be a deliberate one rather than a silent revert. */
const tabInBlock = keyframesBlock(html, 'fcTabIn');
if (!tabInBlock || !/scale\(/.test(tabInBlock)) {
  failures.push(
    'www/index.html: @keyframes fcTabIn no longer animates scale.\n' +
    '    The depth transition was measured at 0 layout shift and 0 late frames, so if it\n' +
    '    was flattened for performance, re-measure first — the cost was never the transform.');
}

/* ── 3. Money Week story player ──────────────────────────────────
   The recap is a 30-second auto-advancing story. Three things about it are
   invisible when broken and were all missing before the rewrite. */
const css = read('www/css/fc-screens.css');

// The progress bar runs every frame for the whole recap. `width` is a layout
// property; it was animating that.
const segFill = css.match(/\.fcst-seg-fill\s*\{[^}]*\}/);
if (!segFill) {
  failures.push('www/css/fc-screens.css: .fcst-seg-fill rule is missing.');
} else {
  if (/\btransition:[^;]*width/.test(segFill[0]) || /\bwidth:\s*0\b/.test(segFill[0])) {
    failures.push(
      'www/css/fc-screens.css: .fcst-seg-fill is animating width again.\n' +
      '    It runs every frame for the full 30-second recap — use transform: scaleX()\n' +
      '    with transform-origin:left, which composites without layout.');
  }
  if (!/scaleX\(/.test(segFill[0])) {
    failures.push('www/css/fc-screens.css: .fcst-seg-fill no longer uses scaleX() for progress.');
  }
}

// Cards differ in height by ~150px; without a fixed box the whole card
// re-centres on every advance.
if (!/\.fcst-card\s*\{[^}]*min-height:/.test(css)) {
  failures.push(
    'www/css/fc-screens.css: .fcst-card lost its min-height.\n' +
    '    Card heights range ~179–335px and the card is vertically centred, so without\n' +
    '    a fixed box the content jumps on every advance (measured 0.076 layout shift).');
}

// Press-and-hold to pause, and Escape on an aria-modal dialog.
if (!/function _storyPause\s*\(/.test(app) || !/pointerdown/.test(app)) {
  failures.push(
    'www/js/fc-app.js: the story player lost press-and-hold to pause.\n' +
    '    With a 5s auto-advance and no way to stop it, a card the user wants to read\n' +
    '    is gone before they finish it.');
}
if (!/_storyKeyHandler[\s\S]{0,400}Escape/.test(app)) {
  failures.push(
    'www/js/fc-app.js: the story dialog no longer closes on Escape.\n' +
    '    It is role="dialog" aria-modal="true"; Escape is required, not optional.');
}

if (failures.length) {
  console.error('\n✗ motion-invariant check failed:\n');
  failures.forEach(f => console.error('  ' + f));
  console.error('');
  process.exit(1);
}

console.log('motion-invariant check: tab pinning, reduced motion, story player');
console.log('✓ tab transitions cannot silently regress to a layout-shifting crossfade.');
