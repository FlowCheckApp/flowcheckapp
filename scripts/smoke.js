#!/usr/bin/env node
/**
 * smoke.js
 *
 * Boots the real app in headless Chrome, drives every screen and tab, and
 * fails if anything throws or renders empty.
 *
 * This exists because three separate features were found completely dead in
 * one afternoon — Export CSV threw on a missing function, the transaction edit
 * sheet looked up ids that were not in the markup, and Home's count-ups
 * animated nothing. Every one of them passed `npm run check`, because the
 * static checks cannot see a screen that renders blank or a handler that
 * throws only when clicked.
 *
 * Deliberately dependency-free, like every other script here: it launches the
 * system Chrome with --remote-debugging-port and talks the DevTools Protocol
 * over Node's built-in WebSocket. No puppeteer, no 300MB Chromium download,
 * nothing added to package.json.
 *
 * What counts as a failure:
 *   - any uncaught error or unhandled rejection, at any point
 *   - any console.error that is not a known-benign browser message
 *   - a view or auth screen that renders less than MIN_CHARS of text
 *   - a tab that does not become active when switched to
 *
 * Usage:  npm run smoke        (add --headful to watch it run)
 *
 * Exit 0 = clean. Exit 1 = something is broken.
 */
'use strict';

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const WWW_ROOT = path.join(ROOT, 'www');
const PORT = 4399;
const HEADFUL = process.argv.includes('--headful');
const MIN_CHARS = 40; // a rendered screen with less text than this is broken

/* Console noise that is the browser's or a vendor's, never ours. */
const BENIGN = [
  /navigator\.vibrate/i,                       // needs a real user gesture
  /enableMultiTabIndexedDbPersistence/i,       // Firestore deprecation notice
  /Failed to load resource/i,                  // favicon etc. on the static server
  /net::ERR_/i,
  /Third-party cookie/i,
  /\[referral\] loadStats error Not signed in/i,
];

const CHROME = [
  process.env.CHROME_PATH,                     // explicit wins
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',             // GitHub ubuntu runners
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean).find(p => { try { return fs.existsSync(p); } catch { return false; } });

if (!CHROME) {
  console.error('✗ smoke: no Chrome found. Set CHROME_PATH to a Chrome/Chromium binary.');
  process.exit(1);
}

const MIME = { html:'text/html', css:'text/css', js:'application/javascript', json:'application/json',
               png:'image/png', svg:'image/svg+xml', ico:'image/x-icon', woff2:'font/woff2' };

function serve() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const rel = url === '/' ? '/index.html' : url;
      const file = path.resolve(WWW_ROOT, '.' + rel);
      const fromRoot = path.relative(WWW_ROOT, file);
      if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': MIME[file.split('.').pop()] || 'text/plain' });
        res.end(data);
      });
    });
    srv.once('error', reject);
    srv.listen(PORT, '127.0.0.1', () => {
      srv.removeListener('error', reject);
      resolve(srv);
    });
  });
}

/* ── minimal DevTools Protocol client ──────────────────────────── */
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onopen = () => resolve({
      send(method, params) {
        const msgId = ++id;
        ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
        return new Promise((res, rej) => pending.set(msgId, { res, rej }));
      },
      on(fn) { listeners.push(fn); },
      close() { try { ws.close(); } catch (_) {} },
    });
    ws.onerror = e => reject(new Error('CDP connect failed: ' + (e.message || 'unknown')));
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        listeners.forEach(fn => fn(msg));
      }
    };
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const getJSON = (port, route, method = 'GET') => new Promise((res, rej) => {
  const req = http.request(
    { host: '127.0.0.1', port, path: route, method },
    r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
  req.on('error', rej);
  req.end();
});

/**
 * Returns the WebSocket URL of a PAGE target, not the browser target — the
 * Runtime and Page domains only exist on a page, so connecting to
 * /json/version (the browser endpoint) fails with "'Runtime.enable' wasn't
 * found".
 */
async function endpoint(port, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try {
      const list = await getJSON(port, '/json/list');
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      /* PUT, not GET. Chrome has rejected GET on /json/new since v111 (it
         was changed to stop drive-by pages opening tabs in a debugging
         browser), so this fallback had been silently failing — which only
         mattered once Chrome also stopped opening about:blank eagerly, and
         then there was no page to attach to at all. */
      await getJSON(port, '/json/new?about:blank', 'PUT').catch(() => {});
    } catch (_) { /* Chrome still starting */ }
    await sleep(250);
  }
  /* 40s, not 15. The old window was comfortable on an idle machine and not
     on one also running an Xcode build, where this failed spuriously. */
  throw new Error('Chrome exposed no page target to attach to');
}

/* ── the script that runs inside the page ──────────────────────── */
const DRIVE = `(async () => {
  const w = ms => new Promise(r => setTimeout(r, ms));
  const problems = [];
  const rendered = {};

  await w(1200);
  if (!window.FCApp || typeof FCApp.startDemoMode !== 'function') {
    return { fatal: 'FCApp did not boot' };
  }
  FCApp.startDemoMode();
  await w(2800);

  /* Home chrome is part of the product, not decoration. The old layout
     floated the nav above a separately-painted safe-area strip, then added
     bottom clearance to both #view-home and .home-v8. On iPhone that became
     a black band under the nav and a large empty tail above it. Exercise the
     geometry at the smoke harness's 390x844 mobile viewport. */
  {
    const nav = document.querySelector('.fc-nav');
    const home = document.getElementById('view-home');
    const layout = home && home.querySelector('.home-v8');
    const disclaimer = layout && layout.querySelector('.home-v8__disclaimer');
    const orb = document.getElementById('fc-coach-orb');
    if (!nav || !home || !layout || !disclaimer) {
      problems.push('home chrome: nav or dashboard layout is missing');
    } else {
      const navRect = nav.getBoundingClientRect();
      const viewPad = parseFloat(getComputedStyle(home).paddingBottom) || 0;
      const layoutPad = parseFloat(getComputedStyle(layout).paddingBottom) || 0;
      if (Math.abs(navRect.bottom - innerHeight) > 1) {
        problems.push('home chrome: nav is not docked to the viewport bottom');
      }
      if (viewPad > 1) {
        problems.push('home chrome: #view-home still adds duplicate bottom padding (' + viewPad + 'px)');
      }
      if (layoutPad < navRect.height + 16 || layoutPad > navRect.height + 32) {
        problems.push('home chrome: dashboard clearance is not nav height + 16–32px (' + layoutPad + 'px vs ' + navRect.height + 'px)');
      }
      home.scrollTop = home.scrollHeight;
      const footerGap = navRect.top - disclaimer.getBoundingClientRect().bottom;
      if (footerGap < 16 || footerGap > 32) {
        problems.push('home chrome: final content leaves a ' + footerGap.toFixed(1) + 'px gap above the nav');
      }
      home.scrollTop = 0;
      if (orb && !orb.hidden) {
        problems.push('home chrome: Coach orb obscures the dashboard despite existing Home entry points');
      }

      const runway = layout.querySelector('.st-runway .rw-chart');
      const plot = runway && runway.querySelector('.rw-plot[data-rw-interactive="true"]');
      const scrub = plot && plot.querySelector('#rw-scrub');
      const readout = plot && plot.querySelector('#rw-readout');
      if (!runway || !plot || !scrub || !readout) {
        problems.push('runway chart: interactive plot controls are missing');
      } else {
        const plotHeight = plot.getBoundingClientRect().height;
        if (plotHeight < 120) {
          problems.push('runway chart: plot collapsed below 120px (' + plotHeight.toFixed(1) + 'px)');
        }
        if (!plot.querySelector('.rw-safe-area')) {
          problems.push('runway chart: projected balance area is missing');
        }
        if (plot.querySelectorAll('.rw-dot').length < 2) {
          problems.push('runway chart: start/end markers are missing');
        }
        if (plot.querySelector('.rw-marker') && !plot.querySelector('.rw-evt__name')) {
          problems.push('runway chart: bill markers do not have named event labels');
        }
        const chartLabel = plot.getAttribute('aria-label') || '';
        if (!/cash runway/i.test(chartLabel) || !/arrow keys/i.test(chartLabel)) {
          problems.push('runway chart: accessible summary or keyboard hint is missing');
        }

        plot.focus({ preventScroll: true });
        plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await w(40);
        if (!runway.classList.contains('rw-scrubbing') || !readout.textContent.trim() || readout.dataset.day !== '1') {
          problems.push('runway chart: arrow-key inspection did not update the readout');
        }
        plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        const plotRect = plot.getBoundingClientRect();
        plot.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          buttons: 1,
          clientX: plotRect.left + plotRect.width * 0.65,
          pointerId: 42,
          pointerType: 'touch',
        }));
        await w(40);
        if (!runway.classList.contains('rw-scrubbing') || Number(readout.dataset.day || 0) <= 1) {
          problems.push('runway chart: pointer inspection did not follow the requested day');
        }
        plot.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 42, pointerType: 'touch' }));
      }
    }
  }

  const TABS = ['home','activity','plan','wealth','more','settings','vault','goals',
                'coach','reports','calendar','investments','notifications',
                'leaderboard'];

  /* Tabs that deliberately land somewhere other than view-<name>. Both of
     these used to be standalone screens duplicating a segment of another
     tab; neither #view-debt nor #view-bills exists any more, so switchTab
     redirects the ids to the one surviving page. Asserting the old
     destination would fail the build for behaving correctly.
     These ids belong HERE and not in TABS above: that loop asserts the
     active view is view-<name>, with no knowledge of redirects, so leaving
     'bills' in it would fail the build for landing where it should. The
     loop below is what actually covers the redirect. */
  const REDIRECTS = { debt: 'view-wealth', bills: 'view-activity' };
  for (const t of TABS) {
    FCApp.switchTab(t);
    /* 900ms, not 420. Five of these tabs are _openSubScreen targets whose
       content loads asynchronously — Vault reads Firestore before it can
       draw anything. At 420ms they reported zero own-content, which looked
       like five broken screens and was really the harness measuring too
       early. */
    await w(900);
    const active = document.querySelector('.fc-view.active');
    const id = active && active.id;
    /* The legal footer does not count as content.

       It is 45 characters that every view gets automatically, and MIN_CHARS
       was 40 — so a screen that rendered NOTHING but its own disclaimer
       cleared the bar and reported as fine. Coach did exactly that while its
       renderer was not running, and this loop passed it.

       Measure what the screen itself produced. */
    let text = active ? active.innerText.replace(/\\s+/g,' ').trim() : '';
    const foot = active && active.querySelector('.fc-legal-footer');
    if (foot) text = text.replace(foot.innerText.replace(/\\s+/g,' ').trim(), '').trim();
    rendered[t] = text.length;
    if (id !== 'view-' + t) problems.push('tab ' + t + ' did not activate (active=' + id + ')');
    else if (text.length < ${MIN_CHARS}) problems.push('tab ' + t + ' rendered only ' + text.length + ' chars of its own content');

    if (t === 'activity' && id === 'view-activity') {
      const navbar = active.querySelector('.act-navbar');
      const title = active.querySelector('.act-navbar__title');
      const segment = active.querySelector('.act-segment-wrap');
      const appHeader = document.querySelector('.fc-screen[data-screen="app"] > .fc-header');
      if (!navbar || !title || !segment) {
        problems.push('activity chrome: navbar, title, or segment control is missing');
      } else {
        /* Chrome reports env(safe-area-inset-top) as zero, so inject the
           Dynamic Island inset through the navbar's test seam and verify
           that its replacement header actually owns that space. */
        navbar.style.setProperty('--act-safe-top', '59px');
        const navbarRect = navbar.getBoundingClientRect();
        const titleRect = title.getBoundingClientRect();
        const segmentRect = segment.getBoundingClientRect();
        const paddingTop = parseFloat(getComputedStyle(navbar).paddingTop) || 0;
        if (paddingTop < 64 || paddingTop > 66) {
          problems.push('activity chrome: 59px safe area produced ' + paddingTop + 'px top padding');
        }
        if (titleRect.top < navbarRect.top + 59) {
          problems.push('activity chrome: title still enters the Dynamic Island safe area');
        }
        if (segmentRect.top < navbarRect.bottom - 1) {
          problems.push('activity chrome: segment control overlaps the pushed-screen navbar');
        }
        navbar.style.removeProperty('--act-safe-top');
      }
      if (appHeader && getComputedStyle(appHeader).display !== 'none') {
        problems.push('activity chrome: global header is stacked above the pushed-screen navbar');
      }
    }
  }

  for (const [tab, expected] of Object.entries(REDIRECTS)) {
    FCApp.switchTab(tab);
    await w(500);
    const landed = document.querySelector('.fc-view.active');
    if (!landed || landed.id !== expected) {
      problems.push('tab ' + tab + ' should route to ' + expected + ' (got ' + (landed && landed.id) + ')');
    } else if ((landed.innerText || '').replace(/\s+/g,' ').trim().length < ${MIN_CHARS}) {
      problems.push('tab ' + tab + ' routed to ' + expected + ' but it rendered near-empty');
    }
  }

  /* The Coach's recommendation. It is the app's only screen that tells the
     user to DO something, and it is assembled from four engines — levers,
     coverage, the debt plan, the agenda. A silent failure in any of them
     leaves the card absent or, worse, present with a nonsense verb:
     "Cancel your Food and Drink" was a real output before the verb came
     from the engine rather than being hardcoded. */
  FCApp.switchTab('coach'); await w(700);
  {
    const doEl  = document.querySelector('.coach-advice__do');
    const resEl = document.querySelector('.coach-advice__result');
    const leadEl = document.querySelector('.coach-lead__title');
    if (!leadEl || !leadEl.textContent.trim()) {
      problems.push('coach: no lead agenda item rendered');
    }
    /* The advice card is legitimately absent when there is nothing to
       recommend — but if it IS there, it has to make sense. */
    /* The agent's read must come BEFORE the ask box. It used to be sixth of
       seven, so the screen opened by asking the user what they wanted
       rather than telling them what it had found. */
    const askEl = document.getElementById('coach-ask-input');
    if (leadEl && askEl &&
        (leadEl.compareDocumentPosition(askEl) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
      problems.push('coach: the ask box is above the agenda — the screen leads with a blank field');
    }
    if (doEl) {
      const verb = doEl.textContent.trim().split(/\\s+/)[0];
      if (!['Cancel','Trim','Update','Review'].includes(verb)) {
        problems.push('coach: advice verb is "' + verb + '" — not from the engine');
      }
      if (!resEl || resEl.textContent.trim().length < 15) {
        problems.push('coach: advice has no consequence — that makes it an observation');
      }
    }
  }

  /* "What should I cut" — the question this app answers best, and the one
     that reached the language model and came back as "cut spending on
     services, shopping, food and drink, utilities, personal care, bank
     fees, auto and transport, entertainment, and top merchants": the model
     reading back the category names it had been given. It must be answered
     by the engine, which names ONE thing and a figure. */
  FCApp.coachAsk('What should I cut'); await w(700);
  {
    const out = document.getElementById('coach-ask-answer');
    const txt = out ? (out.innerText || '').replace(/\\s+/g, ' ').trim() : '';
    if (!txt) {
      problems.push('coach: "what should I cut" produced no answer');
    } else {
      /* A real recommendation carries a dollar figure. A list of category
         names carries none, which is exactly how the bad answer read. */
      if (!/\\$[0-9]/.test(txt)) {
        problems.push('coach: "what should I cut" answered without a figure — ' + txt.slice(0, 90));
      }
      const listy = (txt.match(/,/g) || []).length;
      if (listy >= 5) {
        problems.push('coach: "what should I cut" answered with a list of ' + listy + ' items, not a recommendation');
      }
    }
  }

  // Segmented controls — these re-render whole panels and have broken before.
  for (const s of ['paycheck','bills','budget','subs']) {
    FCApp.switchTab('plan'); await w(250); FCApp.switchPlanSeg(s); await w(280);
    const t = document.querySelector('.fc-view.active').innerText.trim();
    if (t.length < ${MIN_CHARS}) problems.push('plan segment ' + s + ' rendered ' + t.length + ' chars');
  }
  for (const s of ['networth','savings','debt','activity']) {
    FCApp.switchTab('wealth'); await w(250); FCApp.switchWealthSegment(s); await w(280);
    const t = document.querySelector('.fc-view.active').innerText.trim();
    if (t.length < ${MIN_CHARS}) problems.push('wealth segment ' + s + ' rendered ' + t.length + ' chars');
  }

  // The transaction sheet: opened blank for months without anything noticing.
  FCApp.switchTab('activity'); await w(500);
  const row = document.querySelector('[onclick*="openTransactionDetail"]');
  if (!row) problems.push('activity has no tappable transaction rows');
  else {
    if (/openTransactionDetail\\(''\\)/.test(row.getAttribute('onclick') || '')) {
      problems.push('transaction rows render an empty id — the detail sheet cannot open');
    }
    row.click(); await w(600);
    const sheet = document.getElementById('fc-txn-sheet');
    if (!sheet || getComputedStyle(sheet).display === 'none') problems.push('transaction sheet did not open');
    else {
      const cat = document.getElementById('txn-cat-select');
      if (!cat || !cat.options.length) problems.push('transaction category picker is empty');
      if (!(document.getElementById('txn-orig-name') || {}).textContent) problems.push('transaction sheet shows no original name');

      // Drive an actual save. Checking that the parts exist is not enough —
      // the sheet shipped broken for months with a perfectly good-looking
      // Original block while the editable fields pointed at ids that were not
      // in the markup. Only a round-trip catches that.
      const write = FCData.setTransactionOverride;
      let sent = null;
      FCData.setTransactionOverride = async (id, fields) => { sent = { id, fields }; return true; };
      try {
        const nameInput = sheet.querySelector('input[type="text"]');
        if (!nameInput) problems.push('transaction sheet has no name input');
        else nameInput.value = 'Smoke test rename';
        await FCApp.saveTransactionEdit();
        await w(500);
        if (!sent) problems.push('saving a transaction wrote nothing');
        else {
          if (!sent.id) problems.push('transaction save sent an empty id');
          if (sent.fields.name !== 'Smoke test rename') {
            problems.push('transaction save did not carry the edited name (got ' + JSON.stringify(sent.fields.name) + ')');
          }
        }
      } catch (e) {
        problems.push('saving a transaction threw: ' + e.message);
      } finally {
        FCData.setTransactionOverride = write;
      }
      if (typeof FCApp.closeTransactionSheet === 'function') FCApp.closeTransactionSheet();
      await w(400);
    }
  }

  // Every form control must still have an accessible name.
  const unnamed = [...document.querySelectorAll('input,select,textarea')].filter(el => {
    if (el.type === 'hidden') return false;
    const lf = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    return !lf && !el.closest('label') && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
  });
  if (unnamed.length) problems.push(unnamed.length + ' form control(s) with no accessible name');

  // Auth screens.
  for (const s of ['login','register','forgot-password','notif-permission']) {
    FCApp.setScreen(s); await w(380);
    const el = document.querySelector('.fc-screen[data-screen="' + s + '"]');
    const vis = el && getComputedStyle(el).display !== 'none';
    const text = vis ? el.innerText.replace(/\\s+/g,' ').trim() : '';
    rendered['screen:' + s] = text.length;
    if (!vis) problems.push('auth screen ' + s + ' never became visible');
    else if (text.length < ${MIN_CHARS}) problems.push('auth screen ' + s + ' rendered ' + text.length + ' chars');
  }

  return { problems, rendered };
})()`;

/* ── run ───────────────────────────────────────────────────────── */
(async () => {
  const server = await serve();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-smoke-'));
  /* An explicit port, chosen by the OS a moment earlier.

     This used to pass --remote-debugging-port=0 and scrape the port out of
     Chrome's "DevTools listening on ws://…" stderr line. As of Chrome 151
     that line is not printed when the port is 0, and nothing is written to
     DevToolsActivePort either — so the harness waited its full 12 seconds
     and declared "Chrome did not report a debugging port" against a Chrome
     that had started fine. With an explicit port Chrome still announces
     itself normally.

     Binding :0 and closing immediately keeps the property port=0 was there
     for — parallel runs and a rerun after a crashed run do not collide on a
     hardcoded number. */
  const dbgPort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

  const chrome = spawn(CHROME, [
    HEADFUL ? '--no-first-run' : '--headless=new',
    `--remote-debugging-port=${dbgPort}`,
    `--user-data-dir=${userDir}`,
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--window-size=390,844',
    // CI runners have no usable sandbox and a small /dev/shm; without these
    // Chrome exits before it ever prints a debugging port.
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let port = null;
  chrome.stderr.on('data', d => {
    const m = String(d).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
    if (m) port = Number(m[1]);
  });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  try {
    /* endpoint() already retries for 15s while Chrome boots, so there is
       nothing to wait for separately — and nothing to parse. */
    const client = await cdp(await endpoint(dbgPort));
    const errors = [];
    client.on(msg => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push('uncaught: ' + (d.exception?.description || d.text || '').split('\n')[0]);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map(a => a.description || a.value || '').join(' ');
        if (!BENIGN.some(re => re.test(text))) errors.push('console.error: ' + text.slice(0, 160));
      }
    });

    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await sleep(1500);

    const res = await client.send('Runtime.evaluate', {
      expression: DRIVE, awaitPromise: true, returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error('driver script threw: ' + (res.exceptionDetails.exception?.description || '').split('\n')[0]);
    }

    const out = res.result.value || {};
    client.close();

    if (out.fatal) {
      console.error(`\n✗ smoke: ${out.fatal}\n`);
      process.exit(1);
    }

    const screens = Object.keys(out.rendered || {}).length;
    console.log(`smoke: ${screens} screens driven in headless Chrome, ${errors.length} runtime error(s)`);

    const problems = out.problems || [];
    if (problems.length || errors.length) {
      console.error('');
      if (errors.length) {
        console.error(`✗ ${errors.length} runtime error(s):`);
        [...new Set(errors)].forEach(e => console.error('  ' + e));
      }
      if (problems.length) {
        console.error(`✗ ${problems.length} broken screen(s)/flow(s):`);
        problems.forEach(p => console.error('  ' + p));
      }
      console.error(
        '\nA screen that renders empty or a handler that throws is invisible to\n' +
        'the static checks — that is exactly what this script is for. Run\n' +
        '`npm run smoke -- --headful` to watch it happen.\n'
      );
      process.exit(1);
    }

    console.log('✓ every screen renders, every flow survives, no runtime errors.');
  } catch (err) {
    console.error(`\n✗ smoke failed to run: ${err.message}\n`);
    process.exit(1);
  } finally {
    cleanup();
  }
})();
