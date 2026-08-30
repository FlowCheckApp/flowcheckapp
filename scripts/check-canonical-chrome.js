#!/usr/bin/env node
/**
 * check-canonical-chrome.js
 *
 * The bottom tab bar had SEVEN .fc-nav box definitions spread across all
 * three stylesheets — three in flowcheck-design-system.css, one in
 * fc-screens.css, three in fc-premium-screens.css.
 *
 * They set min-height to 66px, then 58px, then 74px, each with !important,
 * each overriding the last. Background, padding and border were set three
 * times over. The bar that actually rendered was decided by stylesheet load
 * order, and none of it was visible in review, because every one of the seven
 * blocks reads as perfectly reasonable on its own.
 *
 * CLAUDE.md already makes this rule for page titles, segmented controls and
 * chips ("★ CANONICAL SCREEN CHROME ★"). The nav is the same class of
 * component and had drifted the same way, so it gets the same enforcement.
 *
 * What counts as a box definition: a rule whose selector is .fc-nav itself
 * (optionally with a body/theme prefix) and which sets any geometry or
 * surface property. Theme-token overrides that only recolour, the
 * display:none guards, and shared transition groups are all fine — they do
 * not decide where the bar is or how big it is.
 *
 * Exit 0 = clean. Exit 1 = a second definition is back.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const SOURCES = [
  'www/css/flowcheck-design-system.css',
  'www/css/fc-screens.css',
  'www/css/fc-premium-screens.css',
  'www/index.html',
];

/* Properties that decide the bar's geometry or surface. Colour-only
   overrides are deliberately absent: theming the bar per mode is fine. */
const BOX_PROPS = /(^|[;{\s])(position|top|left|right|bottom|width|height|min-height|max-height|padding|margin|border-radius|border(-top)?(-width|-style)?|box-shadow|backdrop-filter|-webkit-backdrop-filter|display|grid-template-columns|z-index)\s*:/;

/* Selectors that legitimately touch .fc-nav without defining the box. */
const ALLOWED = [
  /display\s*:\s*none/,                       // hide outside the app shell
  /^\s*\.fc-nav\s*,/,                          // shared transition/font groups
];

const failures = [];
const found = [];

for (const rel of SOURCES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');

  /* Walk rule-by-rule. A rule is `selector { body }`; nested at-rules are
     handled by matching the innermost braces only, which is all a CSS rule
     ever has here. */
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(text)) !== null) {
    /* Strip any comment block sitting between the previous rule and this
       selector, or the reported "selector" is the doc comment above it. */
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const body = m[2];
    if (!/(^|[\s,>])\.fc-nav\s*(,|$)/.test(selector) && !/\.fc-nav$/.test(selector)) continue;
    if (/\.fc-nav-item/.test(selector)) continue;      // items are a separate component
    if (ALLOWED.some(re => re.test(body) || re.test(selector))) continue;
    if (!BOX_PROPS.test(body)) continue;                // colour-only override

    const line = text.slice(0, m.index).split('\n').length;
    found.push({ rel, line, selector: selector.replace(/\s+/g, ' ').slice(0, 60) });
  }
}

if (found.length === 0) {
  failures.push('no .fc-nav box definition found at all — the tab bar has lost its geometry.');
} else if (found.length > 1) {
  failures.push(
    `${found.length} .fc-nav box definitions — there must be exactly one:\n` +
    found.map(f => `      ${f.rel}:${f.line}  ${f.selector}`).join('\n') +
    '\n    Fold the change into the ★ CANONICAL BOTTOM NAV ★ block in\n' +
    '    flowcheck-design-system.css instead of adding another override.'
  );
}

/* ── 1b. The card surface is defined ONCE ──────────────────────────────
 *
 * Every card in the app — Home's .fc-ui-card, Money's .wv-card, Plan's
 * .plan-card, the generic .fc-card, Activity's summary and the Settings
 * profile — is one component, and it mirrors FlowCheckCard in the SwiftUI
 * app. It was six.
 *
 * Settings' card alone was declared FIVE times across three files, at 24,
 * 24, 18, 14 and 22px, four of them with !important, and which one rendered
 * was decided by load order. Money's was overridden by the premium layer's
 * `background: … !important`, which replaces the background-image that draws
 * the card's gradient hairline — so Money got the right fill with a flat
 * border while Home and Plan kept the hairline. None of it is visible in
 * review: every one of those blocks reads as correct on its own.
 *
 * A rule may still set a card's LAYOUT — margin, padding, overflow. What it
 * may not do is redefine the surface: the radius, the fill, the border or
 * the shadow. Those come from ★ THE CARD ★ in flowcheck-design-system.css.
 */
const CARD_SELECTORS = [
  '.fc-ui-card', '.wv-card', '.plan-card', '.fc-card',
  '.act-summary-card', '.settings-profile-card',
];
/* The surface. Deliberately NOT margin/padding/overflow — a screen owning
   its own density is fine and is why these rules still exist. */
const SURFACE_PROPS =
  /(^|[;{\s])(border-radius|background(-image|-color)?|border(-color|-width|-style)?|box-shadow)\s*:/;

const cardDefs = [];
for (const rel of SOURCES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(text)) !== null) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const body = m[2];
    /* Only rules that TARGET a card, not ones that merely mention it inside
       a longer descendant selector like `.wv-card .wv-row`. */
    const targetsCard = CARD_SELECTORS.some(c => {
      const re = new RegExp(`\\${c}\\s*(,|$)`);
      return selector.split(',').some(part => re.test(part.trim() + ','));
    });
    if (!targetsCard) continue;
    if (!SURFACE_PROPS.test(body)) continue;
    /* Shared transition groups name every card but decide no surface. */
    if (/^\s*transition\s*:/.test(body.trim()) || /^[\s;]*$/.test(body)) continue;

    const line = text.slice(0, m.index).split('\n').length;
    cardDefs.push({ rel, line, selector: selector.replace(/\s+/g, ' ').slice(0, 70) });
  }
}

/* A CEILING, not a limit of one — the same shape as check-design-scale.js,
   and for the same reason. There are still 17 rules that touch a card's
   surface, most of them `[data-theme="light"]` overrides that exist only to
   undo hardcoded dark values the canonical card no longer has. They are
   redundant rather than harmful: the five views measured after this change
   all render an identical card. Unpicking the rest is careful work, because
   a losing copy is not dead — a property only one copy declares still
   applies, which is how a display:none once hid a whole rendered section.

   So: this cannot GROW. Lower it as the redundant overrides come out; never
   raise it. Reaching 1 is the goal. */
const CARD_DEF_CEILING = 17;

if (cardDefs.length === 0) {
  failures.push('no card surface definition found at all — every card has lost its background.');
} else if (cardDefs.length > CARD_DEF_CEILING) {
  failures.push(
    `${cardDefs.length} card SURFACE definitions, up from ${CARD_DEF_CEILING}:\n` +
    cardDefs.map(f => `      ${f.rel}:${f.line}  ${f.selector}`).join('\n') +
    '\n    Cards are one component and mirror FlowCheckCard in the SwiftUI app.\n' +
    '    Fold the change into ★ THE CARD ★ in flowcheck-design-system.css.\n' +
    '    A screen may still set its own margin/padding/overflow — just not the\n' +
    '    radius, fill, border or shadow.'
  );
} else if (cardDefs.length < CARD_DEF_CEILING) {
  console.log(`  ↓ card surface definitions down to ${cardDefs.length} (ceiling ${CARD_DEF_CEILING}) — lower CARD_DEF_CEILING in this file.`);
}

/* ── 2. No Home-card selector may live in two stylesheets ─────────────
 *
 * The nav was not the only component written twice. The Payday Runway card
 * — .st-*, .rw-*, .home-v8* — was defined in BOTH flowcheck-design-system.css
 * and fc-screens.css, 21 selectors deep. fc-screens loads second, so it won
 * every property both files set, and edits made to the design-system copy
 * did nothing at all. That is the expensive part: the losing copy is not
 * dead, so it does not look dead. A property only ONE copy declares still
 * applies, which is how `.st-bills { display: none }` kept a fully rendered
 * bills section invisible from a file whose other 8 declarations were inert,
 * and how `.st-allocation > div`'s 16px padding survived in a rule that
 * looked entirely overridden.
 *
 * So the rule is not "don't override" — it is "one component, one file".
 * Cross-file only: a second rule in the SAME file is visible in review and
 * resolves by document order, which is legible. Two files is where load
 * order decides silently.
 */
const NS = /^\.(st-|rw-|home-v8)/;
const homeWhere = {};

for (const rel of SOURCES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs) || !rel.endsWith('.css')) continue;
  const text = fs.readFileSync(abs, 'utf8');
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let r;
  while ((r = ruleRe.exec(text)) !== null) {
    const sel = r[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (!sel || sel.startsWith('@')) continue;
    const line = text.slice(0, r.index).split('\n').length;
    for (const raw of sel.split(',')) {
      const one = raw.replace(/\s+/g, ' ').trim();
      if (!NS.test(one)) continue;
      (homeWhere[one] = homeWhere[one] || []).push({ rel, line });
    }
  }
}

const split = Object.entries(homeWhere)
  .filter(([, hits]) => new Set(hits.map(h => h.rel)).size > 1);

if (split.length) {
  failures.push(
    `${split.length} Home-card selector(s) defined in more than one stylesheet:\n` +
    split.map(([sel, hits]) =>
      `      ${sel}\n` +
      hits.map(h => `          ${h.rel}:${h.line}`).join('\n')
    ).join('\n') +
    '\n    Pick the file that already wins on load order and fold the other\n' +
    "    copy into it. Check for properties only the losing copy declares —\n" +
    '    those are live and will vanish silently if you just delete it.'
  );
}

console.log('canonical-chrome check: bottom nav single-source + Home-card namespace');
if (failures.length) {
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('  ✓ the tab bar is defined exactly once (' + found[0].rel + ':' + found[0].line + ').');
console.log('  ✓ ' + Object.keys(homeWhere).length + ' Home-card selectors, none split across stylesheets.');
