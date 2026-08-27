#!/usr/bin/env node
/**
 * check-paywall-gate.js
 *
 * FlowCheck is subscription-only. The client gate is `_mayEnterApp()`, and
 * CLAUDE.md is explicit about why it lives in `setScreen` rather than at each
 * caller:
 *
 *   "That check lives in setScreen on purpose — there are a dozen
 *    setScreen('app') call sites and gating them individually is how a hole
 *    gets left."
 *
 * The guard exists. Nothing tested that it still stands, and it is exactly the
 * kind of thing a refactor removes without noticing: the app keeps working for
 * everyone who is paying, and the hole is invisible until someone finds it.
 *
 * This is a STRUCTURAL check, not a behavioural one. It proves there is no
 * ungated route onto the app screen. It does NOT prove `_mayEnterApp()` decides
 * correctly — driving that needs a hook that mutates auth state at runtime, and
 * shipping one of those in a finance app is a worse idea than the coverage is
 * worth. The real enforcement is `requireEntitlement` in backend/server.js;
 * this guards the client's half.
 *
 * Exit 0 = clean. Exit 1 = something can reach the app ungated.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const rel = 'www/js/fc-app.js';
const src = fs.readFileSync(path.join(root, rel), 'utf8');

const failures = [];
const lineOf = idx => src.slice(0, idx).split('\n').length;

/** Extent of a `function <name>(` body, by brace matching. */
function functionBody(name) {
  const start = src.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (start === -1) return null;
  const open = src.indexOf('{', start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start, open, end: i, text: src.slice(open, i + 1) };
    }
  }
  return null;
}

const setScreen   = functionBody('setScreen');
const doSetScreen = functionBody('_doSetScreen');

if (!setScreen) {
  failures.push(`${rel} — setScreen() not found. The paywall gate lives in it.`);
} else {
  /* 1. The gate must still be inside setScreen. */
  if (!/_mayEnterApp\s*\(/.test(setScreen.text)) {
    failures.push(`${rel}:${lineOf(setScreen.start)} setScreen() no longer calls `
      + `_mayEnterApp(). Every route onto the app screen is now ungated.`);
  }

  /* 2. Demo mode must be the ONLY exemption, and must be part of the same
        condition — a separate early return above the gate would skip it. */
  const gateLine = (setScreen.text.match(/[^\n]*_mayEnterApp\s*\([^\n]*/) || [''])[0];
  if (!/_isDemoMode/.test(gateLine)) {
    failures.push(`${rel} the _mayEnterApp() check no longer carries the `
      + `_isDemoMode exemption on the same condition. Demo mode is exempt on `
      + `purpose (App Review evaluates the app through it); any OTHER exemption `
      + `is a hole.`);
  }

  /* 3. The gate must route to the paywall, not merely return. */
  if (!/_doSetScreen\(\s*['"]paywall['"]\s*\)/.test(setScreen.text)) {
    failures.push(`${rel} setScreen()'s gate no longer routes to the paywall.`);
  }
}

/* 4. Nothing may reach _doSetScreen except setScreen itself. It is the
      unguarded primitive — a single call from anywhere else is a bypass,
      and is precisely the "hole" CLAUDE.md warns about. */
if (doSetScreen && setScreen) {
  const re = /_doSetScreen\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const i = m.index;
    const insideSetScreen = i > setScreen.open && i < setScreen.end;
    const isDefinition = i >= doSetScreen.start && i <= doSetScreen.open;
    if (insideSetScreen || isDefinition) continue;
    failures.push(`${rel}:${lineOf(i)} calls _doSetScreen() from outside `
      + `setScreen(), bypassing the paywall gate. Call setScreen() instead.`);
  }
}

/* 5. _doSetScreen must not be exported — that would hand the bypass to
      anything with a reference to FCApp, including the console. */
if (/^\s*_doSetScreen\s*,/m.test(src)) {
  failures.push(`${rel} exports _doSetScreen. That is the ungated primitive; `
    + `exporting it makes the gate optional from outside the module.`);
}

/* ── The server half ──────────────────────────────────────────────────────
   Everything above guards the client, which is UX. CLAUDE.md is explicit
   that the enforcement is elsewhere:

     "The client gate is UX. The enforcement is requireEntitlement in
      backend/server.js, which refuses /plaid/sync without an entitlement."

   That gate was removed from /plaid/sync once, and every check in this
   repo still passed, because nothing here looked at the server. /plaid/sync
   is where balances and transactions come from, so losing it hands the whole
   product away to any authenticated account.

   The exempt routes are asserted too, in the opposite direction. Gating them
   would lock lapsed users out of revoking bank access or deleting their data,
   which Plaid's ToS and CCPA both forbid — a "fix" that added requireEntitlement
   everywhere would be its own kind of bug.                                    */
const serverRel = 'backend/server.js';
const server = fs.readFileSync(path.join(root, serverRel), 'utf8');
const serverLineOf = idx => server.slice(0, idx).split('\n').length;

/** Middleware chain of a route: from its declaration to the handler body. */
function routeMiddleware(method, routePath) {
  const i = server.indexOf(`app.${method}('${routePath}'`);
  if (i === -1) return null;
  const handler = server.indexOf('async (req', i);
  return { index: i, text: server.slice(i, handler === -1 ? i + 400 : handler) };
}

if (!/\bfunction requireEntitlement\b|\brequireEntitlement\s*=/.test(server)) {
  failures.push(`${serverRel} — requireEntitlement is not defined. It is the only `
    + `thing standing between a non-subscriber and the full product.`);
}

/* Deny by default.

   This list used to be the whole server check: two route names, hand-written.
   That is allow-by-default — a new endpoint serving the same data ships ungated
   and every check here still passes. Which is exactly what happened.
   GET /financial/snapshot was added for the native app, returns accounts,
   transactions, bills and goals in one call, and went out with requireAuth
   alone. The script was not wrong; it was never told the route existed.

   So enumerate instead. Any route whose handler reads a financial collection
   must pass through requireEntitlement, unless it is exempt for a stated
   reason. Adding a new data endpoint now fails this check until someone
   decides which side it belongs on.                                          */

/** Every `app.<method>('<path>'` declaration, with its handler body. */
function everyRoute() {
  const routes = [];
  const decl = /app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = decl.exec(server)) !== null) {
    const [, method, routePath] = m;
    // The middleware chain runs from the declaration to the handler's `(req`.
    const handlerAt = server.indexOf('(req', m.index);
    if (handlerAt === -1) continue;
    const open = server.indexOf('{', handlerAt);
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (let i = open; i < server.length; i++) {
      if (server[i] === '{') depth++;
      else if (server[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    routes.push({
      method,
      path: routePath,
      index: m.index,
      middleware: server.slice(m.index, handlerAt),
      body: server.slice(open, end + 1),
    });
  }
  return routes;
}

/* Reading any of these is reading someone's finances. */
const FINANCIAL_READ = /collection\(\s*'(accounts|transactions|bills|goals)'\s*\)|buildFinancialSnapshot\s*\(/;

/* And a route is financial by its PATH regardless of how the body is written.
   The body scan only sees a literal collection('bills'). The moment a route
   reaches its data through a helper — _billsRef(uid) — the scan stops seeing
   it and the route passes whether or not it is gated. That is precisely the
   allow-by-default behaviour this check was rewritten to remove, reappearing
   one level of indirection later; five new /bills routes went unnoticed. */
const FINANCIAL_PATH = /^\/(bills|goals|accounts|transactions|financial)\b/;

/* Exempt, each for a reason that outranks billing state. */
const EXEMPT = new Map([
  ['delete /user/account',              'erasure is required regardless of billing state'],
  ['delete /plaid/disconnect',          'revoking bank access must work when lapsed'],
  ['delete /plaid/disconnect/:itemId',  'revoking bank access must work when lapsed'],
  ['post /plaid/webhook',               'Plaid calls this, not a subscriber; authenticated by JWT'],
  /* Writes accounts after a successful link, and carries its OWN gate — a
     leftover of the free-tier model that still lets a non-subscriber connect
     one bank. That contradicts "subscription-only", but it is a product
     decision rather than a boundary this script should quietly tighten.
     Exempt so the check reports the truth; revisit the inline gate on purpose. */
  ['post /plaid/exchange-token',        'has a bespoke legacy gate; see the note above'],
]);

for (const route of everyRoute()) {
  if (!FINANCIAL_READ.test(route.body) && !FINANCIAL_PATH.test(route.path)) continue;
  const key = `${route.method} ${route.path}`;
  if (EXEMPT.has(key)) continue;
  if (/requireEntitlement\s*,/.test(route.middleware)) continue;
  failures.push(`${serverRel}:${serverLineOf(route.index)} ${route.method.toUpperCase()} `
    + `${route.path} reads financial data but does not pass through `
    + `requireEntitlement. FlowCheck is subscription-only and this is the `
    + `boundary that actually holds. Gate it, or add it to EXEMPT in `
    + `scripts/check-paywall-gate.js with the reason it must stay open.`);
}

/* Named routes worth failing loudly on even if the scan above changes shape. */
const MUST_GATE = [
  ['get',  '/plaid/sync',         'balances and transactions come from here'],
  ['get',  '/financial/snapshot', 'the native app reads the whole picture here'],
  ['post', '/coach/ask',          'hosted AI costs money per call'],
  /* The native app's bill writes. It carries no Firestore SDK, so this API is
     the only way it can add, correct or settle a bill — which also makes it
     the only place that boundary can be enforced for it. */
  ['post',   '/bills',            'creating a bill writes to the financial record'],
  ['patch',  '/bills/:id',        'editing a bill writes to the financial record'],
  ['delete', '/bills/:id',        'deleting a bill writes to the financial record'],
  ['post',   '/bills/:id/pay',    'settling a bill moves its due date'],
  ['post',   '/bills/:id/unpay',  'undoing a payment moves its due date back'],
];
for (const [method, routePath, why] of MUST_GATE) {
  const route = routeMiddleware(method, routePath);
  if (!route) {
    failures.push(`${serverRel} — ${method.toUpperCase()} ${routePath} not found; `
      + `the entitlement check cannot be verified.`);
  } else if (!/requireEntitlement\s*,/.test(route.text)) {
    failures.push(`${serverRel}:${serverLineOf(route.index)} ${method.toUpperCase()} `
      + `${routePath} no longer passes through requireEntitlement (${why}). `
      + `FlowCheck is subscription-only; this is the boundary that actually holds.`);
  }
}

const MUST_NOT_GATE = [
  ['delete', '/plaid/disconnect', 'revoking bank access must work when lapsed'],
  ['delete', '/user/account',     'erasure is required regardless of billing state'],
  ['get',    '/plaid/items',      'it lists the banks to disconnect'],
];
for (const [method, routePath, why] of MUST_NOT_GATE) {
  const route = routeMiddleware(method, routePath);
  if (route && /requireEntitlement\s*,/.test(route.text)) {
    failures.push(`${serverRel}:${serverLineOf(route.index)} ${method.toUpperCase()} `
      + `${routePath} is gated by requireEntitlement, but must not be — ${why}.`);
  }
}

if (failures.length) {
  console.error('Paywall gate check FAILED:\n');
  failures.forEach(f => console.error('  ✗ ' + f));
  console.error(`\n${failures.length} problem(s).\n`);
  process.exit(1);
}

const appRoutes = (src.match(/setScreen\(\s*['"]app['"]\s*\)/g) || []).length;
console.log(`paywall gate: ${appRoutes} setScreen('app') call site(s), all funnelled `
  + `through one _mayEnterApp() check`);
const gated = MUST_GATE.filter(([m, r]) => {
  const route = routeMiddleware(m, r);
  return route && /requireEntitlement\s*,/.test(route.text);
}).length;
console.log(`entitlement: ${gated}/${MUST_GATE.length} paid route(s) gated server-side, `
  + `${MUST_NOT_GATE.length} revocation route(s) deliberately open`);
console.log('✓ no ungated route onto the app screen.');
