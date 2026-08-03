#!/usr/bin/env node
/**
 * check-site-css-vars.js
 *
 * Fails if any marketing page references a CSS custom property that is
 * defined nowhere.
 *
 * This is a silent class of bug: `color: var(--muted)` where --muted does
 * not exist is invalid at computed-value time, so the declaration resolves
 * to `unset` and the property INHERITS instead. Nothing errors, nothing
 * logs — the text just quietly renders at the wrong colour. The site
 * shipped 40 such references across four pages (--muted, --success,
 * --cyan, --faint), so every "muted" paragraph on those pages was
 * rendering at full strength and the green checkmarks were not green.
 *
 * Exit 0 = every referenced var resolves. Exit 1 = at least one does not.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'backend', 'public');
const CSS  = path.join(ROOT, 'css', 'site.css');

const DEF = /(--[a-z0-9-]+)\s*:/g;
const USE = /var\(\s*(--[a-z0-9-]+)/g;

const all = s => [...s.matchAll(DEF)].map(m => m[1]);

const globalDefs = new Set(all(fs.readFileSync(CSS, 'utf8')));

const pages = [];
for (const dir of [ROOT, path.join(ROOT, 'legal')]) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.html')) pages.push(path.join(dir, f));
  }
}

const problems = [];
let totalRefs = 0;

for (const p of pages) {
  const src = fs.readFileSync(p, 'utf8');
  const local = new Set(all(src));                 // page-level <style> blocks
  const used = [...src.matchAll(USE)].map(m => m[1]);
  totalRefs += used.length;
  const bad = [...new Set(used)].filter(v => !globalDefs.has(v) && !local.has(v));
  for (const v of bad) {
    const count = used.filter(u => u === v).length;
    problems.push(`${path.relative(ROOT, p)}  ${v}  (${count} use${count === 1 ? '' : 's'})`);
  }
}

console.log(`vars defined in site.css: ${globalDefs.size}`);
console.log(`var() references across ${pages.length} pages: ${totalRefs}`);

if (problems.length) {
  console.error('\n✗ undefined CSS custom properties — these silently inherit:\n');
  problems.forEach(p => console.error('  ' + p));
  console.error('\nDefine them in site.css :root, or alias them to a canonical token.\n');
  process.exit(1);
}

console.log('✓ every var() reference resolves.');
