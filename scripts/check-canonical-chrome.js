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

console.log('canonical-chrome check: bottom nav single-source');
if (failures.length) {
  failures.forEach(f => console.error('  ✗ ' + f));
  process.exit(1);
}
console.log('  ✓ the tab bar is defined exactly once (' + found[0].rel + ':' + found[0].line + ').');
