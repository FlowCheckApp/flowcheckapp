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
const RISKY_PROP = /\.(name|merchant_name|title|body|institution|institution_name|email|description|note|memo|label|display_name|subject)\b/;

/* ── Taint laundered through a local ───────────────────────────────
   RISKY_PROP only sees PROPERTY ACCESSES. That was enough right up until
   someone wrote

     const displayName  = user.name || authUser?.displayName || '…';
     const displayEmail = authUser?.email || user.email || '';
     … '<div>' + displayName + '</div>'      ← straight into innerHTML

   in _renderMore(). The dangerous value is identical; it is just sitting in
   a local by the time it reaches the sink, so `.name` never appears on the
   offending line and the scanner saw nothing. That is a stored-XSS sink —
   user.name is written by saveProfileChanges() after a .trim() and a
   non-empty check — and it survived every run of this file.

   So also flag bare identifiers that NAME the same thing. Deliberately
   matched on the whole identifier rather than a substring: `filename` and
   `nameCounts` are not taint, and a checker that cries wolf gets muted. */
const RISKY_LOCAL = /^(?:display|user|profile|account|acct|merchant|institution|bank|goal|bill|txn|transaction)?(?:Name|Email|Title|Label|Description|Institution|MerchantName)$/;

const RISKY = {
  test: (expr) => RISKY_PROP.test(expr) || RISKY_LOCAL.test(expr.trim()),
};

/* Wrappers that make an interpolation safe. */
const SAFE = [
  /\besc\s*\(/,                       // the app's HTML escaper
  /\bencodeURIComponent\s*\(/,
  /FCData\.formatCurrency\s*\(/,      // numeric
  /\bNumber\s*\(/, /\bparseInt\s*\(/, /\bparseFloat\s*\(/,
  /\b_ic\s*\(/, /\b_billIcon\s*\(/, /\b_goalIcon\s*\(/, /\bsubIcon\s*\(/, // trusted SVG
  /\.toFixed\s*\(/, /\.length\b/,
  /JSON\.stringify\s*\(/,             // CSV export path, not HTML
];

/* ── Concatenation sinks ──────────────────────────────────────────
   Everything above only looks at TEMPLATE LITERALS: the scanner keys off
   /innerHTML\s*=\s*`/ and walks backticks. But most of fc-app.js builds its
   markup by string concatenation — 44 such statements — and every one of
   them was invisible to this file.

   Four live stored-XSS sinks were sitting in that blind spot:
     .fc-bill-name   ← a.name              (Plaid account name)
     .fc-goal-name   ← g.name              (typed by the user)
     .fc-bill-name   ← a.name              (Plaid, investments screen)
     .fc-bill-due    ← a.institution_name  (Plaid)

   Three separate audits missed them, which is exactly the point this file
   makes in its own header: they were found by reading, not by a check that
   runs. Now the check runs.

   Line-scoped on purpose. Walking a full concatenation statement means
   brace/quote matching across arrow functions and regex literals, and a
   first attempt at that silently swallowed 400 lines and reported garbage.
   A line that concatenates an expression into a string containing markup is
   enough signal, and it keeps false positives cheap to read. */
function concatSinkFindings(src, rel) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    if (!/['"]\s*\+|\+\s*['"]/.test(line)) return;   // no string concatenation
    if (!/</.test(line)) return;                     // not building markup
    // Blank out string literals; what remains are the interpolated expressions.
    const bare = line
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const part of bare.split('+')) {
      const expr = part.trim();
      if (!expr || expr === "''" || expr === '""') continue;
      if (!RISKY.test(expr)) continue;
      if (SAFE.some(rx => rx.test(expr))) continue;
      out.push({ file: rel, line: i + 1, expr: expr.replace(/\s+/g, ' ').slice(0, 96) });
    }
  });
  return out;
}

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
  // …and the concatenation-built markup the template scan cannot see.
  concatSinkFindings(src, rel).forEach(f => findings.push(f));
}

console.log(`innerHTML templates scanned: ${scanned} (+ concatenated markup, line-scoped)`);

if (findings.length) {
  console.error(`\n✗ ${findings.length} unescaped interpolation(s) reaching innerHTML:\n`);
  findings.forEach(f => console.error(`  ${f.file}:${f.line}\n      \${${f.expr}}`));
  console.error('\nWrap the value in esc(). If it is genuinely safe (numeric, or');
  console.error('trusted SVG from a helper), add that helper to SAFE in this script.\n');
  process.exit(1);
}

console.log('✓ no unescaped user/Plaid strings reaching innerHTML.');
