#!/usr/bin/env node
/**
 * check-xss-sinks.js
 *
 * Finds user- or Plaid-supplied strings interpolated into innerHTML without
 * esc(). This is stored XSS: bill/goal names are typed by the user, and
 * merchant names and institution names come from Plaid — third-party data we
 * do not control.
 *
 * Three separate audits have each found a fresh batch of these, because they
 * were found by reading rather than by a check that runs. Sites fixed so far
 * include bill names in _renderPlan(), goal names in the goal cards,
 * subscription/merchant names, the Calendar bill list and the notification
 * feed (title + body).
 *
 * Heuristic by design: it flags interpolations of risky-looking fields inside
 * a template that reaches innerHTML, unless the expression is wrapped in a
 * known-safe function. False positives are cheap to allowlist; a missed sink
 * is a stored XSS in a finance app.
 *
 * Exit 0 = clean. Exit 1 = at least one unescaped sink.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'www/js/fc-app.js', 'www/js/fc-data.js', 'www/js/fc-auth.js', 'www/index.html',
  // The web app renders the same user- and Plaid-supplied strings as the
  // phone, on a surface with no app-store review gate. Same rules apply.
  'backend/public/js/app-web.js',
];

/* Fields that carry user- or third-party-controlled text. */
const RISKY = /\.(name|merchant_name|title|body|institution|institution_name|email|description|note|memo|label|display_name|subject)\b/;

/* Wrappers that make an interpolation safe. */
const SAFE = [
  /\besc\s*\(/,                       // the app's HTML escaper
  /\bencodeURIComponent\s*\(/,
  /FCData\.formatCurrency\s*\(/,      // numeric
  /\bNumber\s*\(/, /\bparseInt\s*\(/, /\bparseFloat\s*\(/,
  /\b_ic\s*\(/, /\b_billIcon\s*\(/, /\bsubIcon\s*\(/,   // return trusted SVG
  /\.toFixed\s*\(/, /\.length\b/,
  /JSON\.stringify\s*\(/,             // CSV export path, not HTML
];

/** Extract template-literal spans that are assigned to innerHTML. */
function innerHTMLTemplates(src) {
  const spans = [];
  const re = /innerHTML\s*(?:\+)?=\s*`/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - 1;   // at the opening backtick
    // walk to the matching backtick, honouring \` escapes and nested ${ } templates
    let i = start + 1, depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') { i++; continue; }
      if (c === '$' && src[i + 1] === '{') { depth++; i++; continue; }
      if (c === '}' && depth > 0) { depth--; continue; }
      if (c === '`' && depth === 0) break;
    }
    spans.push([start, i]);
  }
  return spans;
}

const findings = [];
let scanned = 0;

for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const [s, e] of innerHTMLTemplates(src)) {
    scanned++;
    const block = src.slice(s, e);
    // every ${ ... } inside this template (non-greedy, single level is enough here)
    const ex = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let x;
    while ((x = ex.exec(block))) {
      const expr = x[1];
      if (!RISKY.test(expr)) continue;
      if (SAFE.some(rx => rx.test(expr))) continue;
      const line = src.slice(0, s + x.index).split('\n').length;
      findings.push({ file: rel, line, expr: expr.trim().replace(/\s+/g, ' ').slice(0, 96) });
    }
  }
}

console.log(`innerHTML templates scanned: ${scanned}`);

if (findings.length) {
  console.error(`\n✗ ${findings.length} unescaped interpolation(s) reaching innerHTML:\n`);
  findings.forEach(f => console.error(`  ${f.file}:${f.line}\n      \${${f.expr}}`));
  console.error('\nWrap the value in esc(). If it is genuinely safe (numeric, or');
  console.error('trusted SVG from a helper), add that helper to SAFE in this script.\n');
  process.exit(1);
}

console.log('✓ no unescaped user/Plaid strings reaching innerHTML.');
