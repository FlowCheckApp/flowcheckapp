#!/usr/bin/env node
/**
 * check-handlers.js
 *
 * Every function named in an inline handler — onclick, onchange, oninput,
 * onkeydown, onsubmit — must actually exist.
 *
 * Written after Reports → "Export CSV" was found to throw
 * `ReferenceError: showToast is not defined` on every click. The module's
 * function is toast(); showToast() never existed. It survived review and a
 * grep because `_doSync(showToast = false)` has an unrelated local parameter
 * of the same name, so the identifier appears in the file and looks defined.
 *
 * The failure is invisible until someone taps the button: the markup is fine,
 * the module loads, every other test passes. This makes it a build failure
 * instead.
 *
 * Resolution rules:
 *   FCApp.x()      -> must be in the object fc-app.js returns, or assigned
 *                     as FCApp.x = ... somewhere
 *   FCAuth.x() etc -> same, against that module's export object
 *   bareName()     -> must be a function declared in an index.html inline
 *                     script, a window.x = ... assignment, or an FCApp export
 *
 * Method calls on an expression (foo.trim(), e.preventDefault()) are skipped —
 * only a bare call or a call on a known FlowCheck module is checked.
 *
 * Exit 0 = clean. Exit 1 = at least one handler that cannot resolve.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULES = {
  FCApp:       'www/js/fc-app.js',
  FCAuth:      'www/js/fc-auth.js',
  FCData:      'www/js/fc-data.js',
  FCPurchases: 'www/js/fc-iap.js',
  FCPush:      'www/js/fc-push.js',
  FCVault:     'www/js/fc-vault.js',
};
const HTML = 'www/index.html';

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const html = read(HTML);
const srcs = Object.fromEntries(Object.entries(MODULES).map(([k, v]) => [k, read(v)]));
const all = [html, ...Object.values(srcs)].join('\n');

/* ── what each module exports ──────────────────────────────────── */
const exportsOf = {};
for (const [name, src] of Object.entries(srcs)) {
  const set = new Set();
  // the `return { … }` object literal that closes the IIFE
  const tail = src.slice(src.lastIndexOf('\n  return {'));
  for (const m of tail.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*(?:[,:])/gm)) set.add(m[1]);
  // …plus anything attached later: FCApp.foo = …
  for (const m of all.matchAll(new RegExp(name + '\\.([A-Za-z_$][\\w$]*)\\s*=[^=]', 'g'))) set.add(m[1]);
  exportsOf[name] = set;
}

/* ── globals reachable from an inline handler ──────────────────── */
const globals = new Set();
for (const m of html.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) globals.add(m[1]);
for (const m of all.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=[^=]/g)) globals.add(m[1]);
for (const m of html.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/gm)) {
  globals.add(m[1]);
}

/* Built-ins and DOM methods that may legitimately appear bare in a handler. */
const BUILTIN = new Set([
  'alert','confirm','prompt','setTimeout','setInterval','clearTimeout','clearInterval',
  'parseInt','parseFloat','String','Number','Boolean','Array','Object','JSON','Math','Date',
  'encodeURIComponent','decodeURIComponent','isNaN','requestAnimationFrame','fetch',
  'if','for','while','switch','catch','return','typeof','function','new','void','event',
]);

/* ── every inline handler ──────────────────────────────────────── */
const ATTR = /\bon(?:click|change|input|keydown|keyup|keypress|submit|focus|blur|paste|touchstart|touchend)\s*=\s*(["'])([\s\S]*?)\1/g;
const CALL = /(?:(^|[^.\w$])(FCApp|FCAuth|FCData|FCPurchases|FCPush|FCVault)\s*\.\s*([A-Za-z_$][\w$]*)|(^|[^.\w$])([A-Za-z_$][\w$]*))\s*\(/g;

const findings = [];
const seen = new Set();
let checked = 0;

/**
 * Reduce a handler body to just the calls that actually run on the event.
 *
 *  - `${…}` is template-literal interpolation, evaluated at RENDER time in
 *    module scope, not when the user taps. `onclick="FCApp.open('${esc(id)}')"`
 *    calls esc() while building the string; esc is a private fc-app helper and
 *    is not, and need not be, reachable from an inline handler.
 *  - Nested string literals hold CSS and text, not code: a style assignment
 *    containing rgba(…) or var(--x) is not a function call.
 */
function handlerCode(body) {
  return body
    .replace(/\$\{[\s\S]*?\}/g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, '``');
}

function scan(src, rel) {
  for (const m of src.matchAll(ATTR)) {
    const body = handlerCode(m[2]);
    const line = src.slice(0, m.index).split('\n').length;
    for (const c of body.matchAll(CALL)) {
      const mod = c[2], modFn = c[3], bare = c[5];
      let key, ok;
      if (mod) {
        key = mod + '.' + modFn;
        ok = exportsOf[mod].has(modFn);
      } else {
        if (!bare || BUILTIN.has(bare)) continue;
        key = bare;
        ok = globals.has(bare) || exportsOf.FCApp.has(bare);
      }
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      if (!ok) findings.push({ key, where: `${rel}:${line}` });
    }
  }
}
scan(html, HTML);
scan(srcs.FCApp, MODULES.FCApp); // handlers built inside template literals

console.log(`handler check: ${checked} distinct inline handler call(s) resolved`);

if (findings.length) {
  console.error(`\n✗ ${findings.length} handler(s) that do not resolve to a defined function:\n`);
  for (const f of findings) console.error(`  ${f.key}()\n      referenced at ${f.where}`);
  console.error(
    '\nThis throws a ReferenceError the moment a user taps it, and nothing\n' +
    'else will tell you — the markup is valid and the module loads fine.\n' +
    'Check for a near-miss name (toast vs showToast) or a missing export.\n'
  );
  process.exit(1);
}

console.log('✓ every inline handler resolves to a real function.');
