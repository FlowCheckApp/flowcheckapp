#!/usr/bin/env node
/**
 * check-site-css-classes.js
 *
 * Flags component classes used by the marketing site / web app that are
 * defined nowhere in the stylesheets that page actually loads.
 *
 * An undefined class is silent: the element renders, nothing errors, it just
 * has no styling. This has bitten twice — `.gradient-text` (the features hero
 * accent word had no gradient at all), and `.rw-cta` (the web app's unlock
 * and connect buttons rendered as bare unstyled <button>s).
 *
 * Deliberately narrow to avoid noise: only checks classes matching the
 * project's component prefixes, since those are the ones that carry styling.
 * Utility/state classes toggled at runtime are allowlisted.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'backend', 'public');
const siteCss = fs.readFileSync(path.join(ROOT, 'css', 'site.css'), 'utf8');

/* Classes that carry styling in this project all use these prefixes. */
const PREFIX = /^(rw|wa|auth|nav|btn|hero|feature|plan|proof|webapp|form|social|badge|section|dash|fc|pw|icon|eyebrow|container|reveal|accent|card|preview)/;

/* Runtime/state classes, or ones defined by a page's own <style>. */
const ALLOW = new Set([
  'is-on', 'is-neg', 'is-paid', 'is-overdue', 'is-active', 'active',
  'in-view', 'nav-links--open', 'nav--scrolled', 'fc-privacy', 'wa-locked',
  'reveal', 'container', 'accent',
]);

function collectClasses(css, target) {
  for (const m of css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) target.add(m[1]);
}

const siteDefined = new Set();
collectClasses(siteCss, siteDefined);

const files = [];
for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.html')) files.push(path.join(ROOT, f));
const jsDir = path.join(ROOT, 'js');
for (const f of fs.readdirSync(jsDir)) if (f.endsWith('.js')) files.push(path.join(jsDir, f));

const missing = new Map();
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const localCss = new Set();
  const defined = new Set(siteDefined);

  if (file.endsWith('.html')) {
    for (const match of src.matchAll(/<link\b[^>]*href="\/css\/([^"?]+\.css)(?:\?[^"]*)?"[^>]*>/g)) {
      const stylesheet = path.join(ROOT, 'css', match[1]);
      if (fs.existsSync(stylesheet)) collectClasses(fs.readFileSync(stylesheet, 'utf8'), defined);
    }
  }

  for (const b of src.matchAll(/<style[\s\S]*?<\/style>/g))
    for (const m of b[0].matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)) localCss.add(m[1]);

  for (const m of src.matchAll(/class="([^"]+)"/g)) {
    for (let cls of m[1].split(/\s+/)) {
      // These class="" values are often inside JS string concatenation, so a
      // trailing quote or a template hole rides along. Strip / skip those.
      cls = cls.replace(/['"`+].*$/, '').trim();
      if (!cls || cls.includes('${')) continue;
      if (ALLOW.has(cls) || defined.has(cls) || localCss.has(cls)) continue;
      if (!PREFIX.test(cls)) continue;
      const key = cls;
      if (!missing.has(key)) missing.set(key, new Set());
      missing.get(key).add(path.relative(ROOT, file));
    }
  }
}

console.log(`base classes defined in site.css: ${siteDefined.size}`);

if (missing.size) {
  console.error('\n✗ classes used but never defined in that page\'s loaded CSS (they silently do nothing):\n');
  for (const [cls, where] of [...missing].sort())
    console.error(`  .${cls}  —  ${[...where].join(', ')}`);
  console.error('\nDefine it in one of the stylesheets loaded by that page.\n');
  process.exit(1);
}

console.log('✓ every prefixed class used by the site resolves to a rule.');
