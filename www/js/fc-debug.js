/**
 * FlowCheck — Debug System
 * ─────────────────────────────────────────────────────────────
 * Tap the version number in Settings 5× to open the debug panel.
 * Only active when FC_CONFIG.app.env === 'development'.
 *
 * Features:
 *   • In-app log capture (console.log/warn/error interception)
 *   • Firebase auth + Firestore connection status
 *   • Backend config status
 *   • Capacitor plugin detection
 *   • One-tap log copy / clear
 *   • Error boundary — catches uncaught errors and shows toast
 * ─────────────────────────────────────────────────────────────
 */
window.FCDebug = (function () {
  'use strict';

  const MAX_LOGS = 200;
  const logs     = [];
  let   _panel   = null;
  let   _tapCount = 0;
  let   _tapTimer  = null;
  let   _active   = false;

  /* ── Only run in development mode ─────────────────────────── */
  function isDevMode() {
    return window.FC_CONFIG && window.FC_CONFIG.app.env === 'development';
  }

  /* ── Log levels ────────────────────────────────────────────── */
  const LEVEL_COLOR = { log: '#aaa', warn: '#ffb800', error: '#ff453a', info: '#1ac4f0' };

  function _addLog(level, args) {
    const msg = args.map(a => {
      try { return typeof a === 'object' ? JSON.stringify(a, null, 0) : String(a); }
      catch (_) { return '[unserializable]'; }
    }).join(' ');

    logs.push({ level, msg, ts: Date.now() });
    if (logs.length > MAX_LOGS) logs.shift();

    if (_panel && _panel.style.display !== 'none') {
      _appendLogRow({ level, msg, ts: logs[logs.length - 1].ts });
    }
  }

  /* ── Intercept console ─────────────────────────────────────── */
  function _interceptConsole() {
    ['log', 'warn', 'error', 'info'].forEach(level => {
      const orig = console[level].bind(console);
      console[level] = function (...args) {
        orig(...args);
        _addLog(level, args);
      };
    });
  }

  /* ── Global error boundary ─────────────────────────────────── */
  function _attachErrorBoundary() {
    window.addEventListener('error', e => {
      _addLog('error', [`UNCAUGHT: ${e.message}`, `@ ${e.filename}:${e.lineno}`]);
      if (window.FCApp && FCApp.toast) {
        FCApp.toast(`JS Error: ${e.message}`, 'error', 6000);
      }
    });

    window.addEventListener('unhandledrejection', e => {
      const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
      _addLog('error', [`UNHANDLED PROMISE: ${msg}`]);
      if (window.FCApp && FCApp.toast) {
        FCApp.toast(`Promise error: ${msg}`, 'error', 6000);
      }
    });
  }

  /* ── Secret tap trigger (tap version label 5×) ─────────────── */
  function _attachTrigger() {
    document.addEventListener('click', e => {
      const el = e.target.closest && e.target.closest('#settings-version-tap');
      if (!el) return;

      _tapCount++;
      clearTimeout(_tapTimer);
      _tapTimer = setTimeout(() => { _tapCount = 0; }, 1500);

      if (_tapCount >= 5) {
        _tapCount = 0;
        togglePanel();
      }
    });
  }

  /* ── Build the panel DOM (once) ────────────────────────────── */
  function _buildPanel() {
    if (_panel) return;

    _panel = document.createElement('div');
    _panel.id = 'fc-debug-panel';
    _panel.innerHTML = `
      <div id="fc-dbg-header">
        <span style="font-weight:700;font-size:13px;color:#1ac4f0">⚙ FlowCheck Debug</span>
        <div style="display:flex;gap:8px">
          <button id="fc-dbg-copy" style="${BTN_STYLE}">Copy</button>
          <button id="fc-dbg-clear" style="${BTN_STYLE}">Clear</button>
          <button id="fc-dbg-close" style="${BTN_STYLE};color:#ff453a">✕</button>
        </div>
      </div>
      <div id="fc-dbg-status"></div>
      <div id="fc-dbg-logs"></div>
    `;

    Object.assign(_panel.style, {
      position:   'fixed',
      bottom:     '0',
      left:       '0',
      right:      '0',
      height:     '55vh',
      background: 'rgba(8,14,22,0.97)',
      borderTop:  '1px solid rgba(26,196,240,0.3)',
      zIndex:     '9999',
      display:    'none',
      flexDirection: 'column',
      fontFamily: 'ui-monospace, monospace',
      fontSize:   '11px',
    });

    const header = _panel.querySelector('#fc-dbg-header');
    Object.assign(header.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)',
      flexShrink: '0',
    });

    const logsEl = _panel.querySelector('#fc-dbg-logs');
    Object.assign(logsEl.style, {
      flex: '1', overflowY: 'auto', padding: '4px 12px',
    });

    const statusEl = _panel.querySelector('#fc-dbg-status');
    Object.assign(statusEl.style, {
      padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)',
      display: 'flex', gap: '12px', flexWrap: 'wrap', flexShrink: '0',
    });

    document.body.appendChild(_panel);

    // Button events
    _panel.querySelector('#fc-dbg-close').addEventListener('click', hidePanel);
    _panel.querySelector('#fc-dbg-clear').addEventListener('click', () => {
      logs.length = 0;
      _panel.querySelector('#fc-dbg-logs').innerHTML = '';
    });
    _panel.querySelector('#fc-dbg-copy').addEventListener('click', () => {
      const text = logs.map(l => `[${l.level.toUpperCase()}] ${new Date(l.ts).toISOString()} ${l.msg}`).join('\n');
      navigator.clipboard && navigator.clipboard.writeText(text).then(() => {
        if (window.FCApp) FCApp.toast('Logs copied!', 'success');
      });
    });
  }

  const BTN_STYLE = 'background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:white;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:11px;font-family:inherit';

  /* ── Render a single log row ───────────────────────────────── */
  function _appendLogRow({ level, msg, ts }) {
    const logsEl = _panel && _panel.querySelector('#fc-dbg-logs');
    if (!logsEl) return;

    const row = document.createElement('div');
    row.style.cssText = `padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.03);color:${LEVEL_COLOR[level] || '#aaa'};word-break:break-all;line-height:1.4`;

    const time = new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    row.textContent = `${time} ${msg}`;
    logsEl.appendChild(row);
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  /* ── Render status badges ──────────────────────────────────── */
  function _renderStatus() {
    const statusEl = _panel && _panel.querySelector('#fc-dbg-status');
    if (!statusEl) return;

    const user    = window.FCAuth && FCAuth.currentUser();
    const backend = window.FC_CONFIG && FC_CONFIG.app.backendConfigured;
    const cap     = window.Capacitor && window.Capacitor.isNativePlatform();
    const env     = window.FC_CONFIG && FC_CONFIG.app.env;

    const badges = [
      { label: 'Auth',     ok: !!user,    val: user ? user.email || user.uid.slice(0,8) : 'signed out' },
      { label: 'Backend',  ok: backend,   val: backend ? 'configured' : 'not set' },
      { label: 'Native',   ok: cap,       val: cap ? 'Capacitor' : 'web' },
      { label: 'Env',      ok: env === 'development', val: env || '?' },
      { label: 'Logs',     ok: true,      val: logs.length + ' entries' },
    ];

    statusEl.innerHTML = badges.map(b => `
      <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color:${b.ok ? '#34c759' : '#ff9f0a'}">
        <span style="width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0"></span>
        <b style="color:white">${b.label}:</b> ${b.val}
      </span>
    `).join('');
  }

  /* ── Show / hide ───────────────────────────────────────────── */
  function showPanel() {
    _buildPanel();
    _panel.style.display = 'flex';
    _active = true;

    // Populate existing logs
    const logsEl = _panel.querySelector('#fc-dbg-logs');
    logsEl.innerHTML = '';
    logs.forEach(l => _appendLogRow(l));
    logsEl.scrollTop = logsEl.scrollHeight;

    _renderStatus();
  }

  function hidePanel() {
    if (_panel) _panel.style.display = 'none';
    _active = false;
  }

  function togglePanel() {
    _active ? hidePanel() : showPanel();
  }

  /* ── Add a tappable wrapper to the version row in Settings ─── */
  function _patchVersionRow() {
    // Called after DOM ready; wrap version value in a tappable span
    const observer = new MutationObserver(() => {
      const rows = document.querySelectorAll('.fc-settings-value');
      rows.forEach(el => {
        if (el.textContent === '2.0.0' && !el.id) {
          el.id = 'settings-version-tap';
          el.title = 'Tap 5× for debug panel';
          el.style.cursor = 'default';
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ── Production error boundary (always on) ─────────────────── */
  // Even in production, uncaught JS errors and unhandled Promise rejections
  // should show a user-friendly toast rather than silently disappearing.
  // The verbose logging (_attachErrorBoundary) only runs in dev mode,
  // but this thin production layer always runs.
  function _attachProductionErrorBoundary() {
    const _isSilentError = msg => (
      !msg ||
      msg.includes('ResizeObserver loop') ||    // benign browser noise
      msg.includes('Non-Error promise rejection') ||
      msg.includes('cancelled') ||              // Plaid user-cancelled
      msg.includes('AbortError') ||             // share sheet dismissed
      msg.includes('Failed to fetch') ||        // Railway cold-start / offline
      msg.includes('NetworkError') ||           // WKWebView network failure
      msg.includes('Load failed') ||            // iOS WKWebView fetch timeout
      msg.includes('fetch') && msg.includes('network') // generic fetch network error
    );

    window.addEventListener('unhandledrejection', e => {
      const msg = e.reason?.message || String(e.reason || '');
      if (_isSilentError(msg)) return;
      // Log to device console (shows in Xcode / Safari Web Inspector)
      console.error('[FCApp] Unhandled rejection:', msg);
      // Only show toast if FCApp is booted, visible, and past the cold-start window (3s)
      const appReady = window.FCApp?.toast && window._fcAppStartedAt && (Date.now() - window._fcAppStartedAt > 3000);
      if (appReady) {
        FCApp.toast('Something went wrong — please try again', 'error', 4000);
      }
    });

    window.addEventListener('error', e => {
      const msg = e.message || '';
      if (_isSilentError(msg)) return;
      console.error('[FCApp] Uncaught error:', msg, `@ ${e.filename}:${e.lineno}`);
    });
  }

  /* ── Init ──────────────────────────────────────────────────── */
  function init() {
    // Production error boundary always runs — catches anything that slips through
    _attachProductionErrorBoundary();

    if (!isDevMode()) return;

    // Dev-only extras: verbose logging, console interception, debug panel
    _interceptConsole();
    _attachErrorBoundary();
    _attachTrigger();
    _patchVersionRow();

    fcLog('FCDebug initialised — tap version 5× in Settings to open panel');
  }

  /* ── Public API ─────────────────────────────────────────────── */
  return { init, showPanel, hidePanel, togglePanel, logs };
})();

/* Auto-init on load */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => FCDebug.init());
} else {
  FCDebug.init();
}
