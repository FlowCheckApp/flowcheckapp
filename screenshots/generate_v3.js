#!/usr/bin/env node
/**
 * FlowCheck App Store Screenshots v3
 * Chrome-headless HTML/CSS renderer — proper SF fonts, glass effects, real shadows
 * 1290×2796 · iPhone 6.7" · 6 screenshots
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const OUT   = path.join(__dirname, 'v3');
const TMP   = path.join(__dirname, '_tmp_html');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(OUT,  { recursive: true });
fs.mkdirSync(TMP,  { recursive: true });

// ── Shared CSS ────────────────────────────────────────────────────────────────
const BASE_CSS = `
* { margin:0; padding:0; box-sizing:border-box; -webkit-font-smoothing:antialiased; }
html,body { width:1290px; height:2796px; overflow:hidden; }

body {
  font-family: -apple-system, 'Helvetica Neue', sans-serif;
  background: #F7F2EC;
  position: relative;
}

.canvas { width:1290px; height:2796px; position:relative; overflow:hidden; }

/* ── Text ── */
.cat   { font-size:24px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:#1ac4f0; }
.h1    { font-size:108px; font-weight:800; letter-spacing:-.04em; line-height:1.03; color:#18181B; }
.h1-i  { font-family:Georgia,'Times New Roman',serif; font-style:italic; font-weight:bold;
         font-size:108px; letter-spacing:-.03em; line-height:1.03; color:#18181B; }
.tag   { font-size:40px; font-weight:400; color:#6B7280; line-height:1.4; }

/* ── Phone frame ── */
.phone-wrap {
  position:absolute;
  left:50%; transform:translateX(-50%);
  width:640px;
}
.phone-outer {
  width:640px;
  border-radius:56px;
  background:linear-gradient(160deg,#14202E 0%,#0A0F1C 100%);
  box-shadow:
    0 0 0 1px rgba(255,255,255,.09),
    0 50px 120px rgba(0,0,0,.55),
    0 15px 35px rgba(0,0,0,.30);
  padding:13px;
  position:relative;
}
.phone-screen {
  border-radius:46px;
  background:#060E18;
  overflow:hidden;
  position:relative;
}
.dyn-island {
  position:absolute; top:14px; left:50%; transform:translateX(-50%);
  width:118px; height:28px;
  background:#000; border-radius:14px; z-index:20;
}

/* ── App common ── */
.app { padding:0 22px; padding-top:64px; display:flex; flex-direction:column; gap:10px; color:#F0F6FF; }
.app-hdr { font-size:36px; font-weight:800; color:#F0F6FF; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center; }
.hdr-icons { display:flex; gap:10px; opacity:.55; }
.hdr-icon { width:36px; height:36px; border-radius:18px; background:rgba(255,255,255,.10);
            display:flex; align-items:center; justify-content:center; font-size:16px; }

/* Cards */
.card {
  background:linear-gradient(145deg,#0D1B2E,#091422);
  border:1px solid rgba(255,255,255,.07);
  border-radius:20px;
  padding:18px 20px;
  box-shadow:0 4px 20px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05);
}
.card.accent { border-color:rgba(26,196,240,.22); box-shadow:0 4px 20px rgba(0,0,0,.35),0 0 30px rgba(26,196,240,.06) inset, inset 0 1px 0 rgba(255,255,255,.05); }
.card.elec   { border-color:rgba(37,99,235,.25); }

.card-eyebrow { font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:rgba(240,246,255,.36); margin-bottom:6px; }
.card-value   { font-size:48px; font-weight:900; letter-spacing:-.05em; color:#F0F6FF; line-height:1; font-variant-numeric:tabular-nums; }
.card-value.sm{ font-size:38px; }
.card-muted   { font-size:13px; color:rgba(240,246,255,.45); }

/* Badge */
.badge { display:inline-flex; align-items:center; padding:4px 12px; border-radius:999px; font-size:12px; font-weight:700; }
.badge.green  { background:rgba(48,209,88,.15); color:#30d158; border:1px solid rgba(48,209,88,.25); }
.badge.danger { background:rgba(255,69,58,.15);  color:#ff453a; border:1px solid rgba(255,69,58,.25); }
.badge.warn   { background:rgba(255,159,10,.15); color:#ff9f0a; border:1px solid rgba(255,159,10,.25); }
.badge.cyan   { background:rgba(26,196,240,.15); color:#1ac4f0; border:1px solid rgba(26,196,240,.25); }

/* Progress bar */
.bar-track { height:7px; background:rgba(255,255,255,.08); border-radius:99px; overflow:hidden; }
.bar-fill  { height:100%; border-radius:99px; }

/* Divider */
.div { border:none; border-top:1px solid rgba(255,255,255,.07); margin:12px 0; }

/* Stat row */
.stats3 { display:grid; grid-template-columns:1fr 1px 1fr 1px 1fr; gap:0; }
.stats3-div { background:rgba(255,255,255,.07); width:1px; }
.stat { text-align:center; padding:10px 0; }
.stat-lbl { font-size:9px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:rgba(240,246,255,.35); margin-bottom:5px; }
.stat-val  { font-size:15px; font-weight:800; font-variant-numeric:tabular-nums; }
.cyan { color:#1ac4f0; } .white { color:#F0F6FF; } .warn { color:#ff9f0a; }
.green { color:#30d158; } .danger { color:#ff453a; } .elec { color:#2563eb; }
.muted { color:rgba(240,246,255,.45); }

/* Category row */
.cat-row {
  display:flex; align-items:center; gap:12px;
  background:linear-gradient(145deg,#0D1B2E,#091422);
  border:1px solid rgba(255,255,255,.06);
  border-radius:16px; padding:12px 14px;
}
.cat-icon { width:40px; height:40px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:18px; flex-shrink:0; }
.cat-body { flex:1; min-width:0; }
.cat-name { font-size:14px; font-weight:600; color:#F0F6FF; }
.cat-sub  { font-size:11px; color:rgba(240,246,255,.38); }
.cat-right { text-align:right; flex-shrink:0; }
.cat-amt  { font-size:14px; font-weight:800; color:#F0F6FF; font-variant-numeric:tabular-nums; }
.cat-pct  { font-size:11px; color:rgba(240,246,255,.38); }
.cat-bar  { height:3px; background:rgba(255,255,255,.08); border-radius:99px; margin-top:8px; overflow:hidden; }
.cat-bar-fill { height:100%; border-radius:99px; }

/* Health ring (CSS-only arc) */
.health-row { display:flex; align-items:center; gap:22px; }
.ring-wrap  { position:relative; width:92px; height:92px; flex-shrink:0; }
.ring-wrap svg { transform:rotate(-90deg); }
.ring-grade { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.grade-letter { font-size:30px; font-weight:900; color:#F0F6FF; line-height:1; }
.grade-num    { font-size:11px; color:rgba(240,246,255,.40); font-weight:600; }
.metric-row   { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
.metric-lbl   { font-size:12px; color:rgba(240,246,255,.45); width:72px; flex-shrink:0; }
.metric-bar   { flex:1; height:5px; background:rgba(255,255,255,.08); border-radius:99px; overflow:hidden; }
.metric-fill  { height:100%; border-radius:99px; }
.metric-val   { font-size:12px; font-weight:800; color:#F0F6FF; width:24px; text-align:right; flex-shrink:0; }

/* Grade ladder */
.grade-ladder { display:flex; }
.grade-step   { flex:1; text-align:center; padding:10px 0; }
.grade-step.active { background:rgba(255,69,58,.12); border-radius:10px; border:1px solid rgba(255,69,58,.25); }
.grade-lbl    { font-size:20px; font-weight:800; }

/* Bill rows */
.bill-row { display:flex; align-items:center; gap:14px; padding:10px 0; border-bottom:1px solid rgba(255,255,255,.06); }
.bill-row:last-child { border-bottom:none; }
.bill-date { width:44px; text-align:center; flex-shrink:0; }
.bill-day  { font-size:9px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:rgba(240,246,255,.35); }
.bill-num  { font-size:26px; font-weight:800; color:#F0F6FF; line-height:1; }
.bill-dot  { width:8px; height:8px; border-radius:50%; background:#ff453a; flex-shrink:0; }
.bill-name { font-size:14px; color:rgba(240,246,255,.75); flex:1; }
.bill-amt  { font-size:14px; font-weight:800; color:#ff453a; font-variant-numeric:tabular-nums; }

/* Sparkline SVG */
.sparkline { overflow:visible; display:block; }

/* Account row */
.acct-row { display:flex; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid rgba(255,255,255,.06); }
.acct-row:last-child { border-bottom:none; }
.acct-icon { width:38px; height:38px; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:800; flex-shrink:0; }
.acct-body { flex:1; min-width:0; }
.acct-name { font-size:14px; font-weight:600; color:#F0F6FF; }
.acct-type { font-size:11px; color:rgba(240,246,255,.38); }
.acct-bal  { font-size:16px; font-weight:800; font-variant-numeric:tabular-nums; }

/* Pro feature list */
.feature-row { display:flex; align-items:center; gap:14px; padding:14px 16px;
               background:linear-gradient(145deg,#0D1B2E,#091422);
               border:1px solid rgba(255,255,255,.06); border-radius:16px; }
.feat-bullet { font-size:18px; color:#1ac4f0; flex-shrink:0; }
.feat-body   { flex:1; }
.feat-title  { font-size:16px; font-weight:700; color:#F0F6FF; }
.feat-sub    { font-size:13px; color:rgba(240,246,255,.45); margin-top:2px; }

/* CTA button */
.cta-btn {
  display:block; width:100%; padding:22px 0; border-radius:14px; text-align:center;
  font-size:18px; font-weight:800; color:#050E18; letter-spacing:.01em;
  background:linear-gradient(90deg,#1ac4f0,#2563eb);
  box-shadow:0 8px 24px rgba(26,196,240,.3);
}

/* Merchant row */
.merchant-row { padding:10px 0; border-bottom:1px solid rgba(255,255,255,.06); }
.merchant-row:last-child { border-bottom:none; }
.merchant-hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
.merchant-name { font-size:14px; color:#F0F6FF; font-weight:500; }
.merchant-amt  { font-size:14px; font-weight:800; color:#F0F6FF; font-variant-numeric:tabular-nums; }
`;

// ── Phone frame wrapper ────────────────────────────────────────────────────────
function phoneFrame(screenHTML, screenHeight = 1360) {
  return `
  <div class="phone-outer">
    <div class="phone-screen" style="height:${screenHeight}px">
      <div class="dyn-island"></div>
      ${screenHTML}
    </div>
  </div>`;
}

// ── App screens ───────────────────────────────────────────────────────────────

const SCREEN_HOME = phoneFrame(`
<div class="app">
  <div class="app-hdr">FlowCheck
    <div class="hdr-icons">
      <div class="hdr-icon">↻</div>
      <div class="hdr-icon">🔔</div>
    </div>
  </div>

  <!-- Net Worth -->
  <div class="card accent">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
      <div class="card-eyebrow">Net Worth</div>
      <span class="badge danger">↓ −$393</span>
    </div>
    <div class="card-value">−$56,565</div>
    <svg class="sparkline" width="100%" height="48" viewBox="0 0 560 48" preserveAspectRatio="none" style="margin:10px 0 8px">
      <defs><linearGradient id="sg1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff453a" stop-opacity=".18"/><stop offset="100%" stop-color="#ff453a" stop-opacity="0"/></linearGradient></defs>
      <path d="M0,6 C56,8 112,14 168,18 C224,22 280,28 336,32 C392,36 448,40 504,43 L560,46 L560,48 L0,48 Z" fill="url(#sg1)"/>
      <path d="M0,6 C56,8 112,14 168,18 C224,22 280,28 336,32 C392,36 448,40 504,43 L560,46" fill="none" stroke="#ff453a" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="560" cy="46" r="4" fill="#ff453a"/>
    </svg>
    <hr class="div" style="margin:4px 0 10px">
    <div style="display:flex;justify-content:space-between">
      <span class="muted" style="font-size:13px">Chase Checking</span>
      <span style="font-size:13px;font-weight:700;color:#F0F6FF">$847.23</span>
    </div>
  </div>

  <!-- Spending -->
  <div class="card accent">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <div class="card-eyebrow">Spending · This Month</div>
      <span class="badge green">−49% vs last mo</span>
    </div>
    <div class="card-value" style="margin-bottom:14px">$1,613.65</div>
    <div class="stats3" style="margin-bottom:14px;border-top:1px solid rgba(255,255,255,.07);border-bottom:1px solid rgba(255,255,255,.07)">
      <div class="stat"><div class="stat-lbl">Spent</div><div class="stat-val cyan">$1,613/$2k</div></div>
      <div class="stats3-div"></div>
      <div class="stat"><div class="stat-lbl">Remaining</div><div class="stat-val white">$386</div></div>
      <div class="stats3-div"></div>
      <div class="stat"><div class="stat-lbl">Savings</div><div class="stat-val warn">0% ⚠</div></div>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:81%;background:linear-gradient(90deg,#1ac4f0,#2563eb)"></div></div>
    <div style="font-size:12px;color:#ff9f0a;margin-top:8px">⚠ $161/day avg · Projected: $4,840 · 20 days left</div>
  </div>

  <!-- AI insight -->
  <div class="card elec" style="display:flex;gap:12px;align-items:flex-start;padding:14px 16px">
    <div style="color:#2563eb;font-size:20px;flex-shrink:0">✦</div>
    <div>
      <div style="font-size:14px;font-weight:700;color:#F0F6FF">Utilities are 40% of your spending</div>
      <div style="font-size:12px;color:rgba(240,246,255,.45);margin-top:3px">Tap to see savings opportunities →</div>
    </div>
  </div>

  <!-- Bills -->
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div class="card-eyebrow" style="margin:0">Upcoming Bills</div>
      <span class="badge warn">−$651 this week</span>
    </div>
    <hr class="div" style="margin:0 0 8px">
    <div class="bill-row">
      <div class="bill-date"><div class="bill-day">Thu</div><div class="bill-num">11</div></div>
      <div class="bill-dot"></div>
      <div class="bill-name">Progressive Insurance</div>
      <div class="bill-amt">−$246.00</div>
    </div>
    <div class="bill-row">
      <div class="bill-date"><div class="bill-day">Sun</div><div class="bill-num">14</div></div>
      <div class="bill-dot"></div>
      <div class="bill-name">SoFi Loan</div>
      <div class="bill-amt">−$405.00</div>
    </div>
  </div>
</div>
`, 1360);

const SCREEN_HEALTH = phoneFrame(`
<div class="app">
  <div class="app-hdr">Insights
    <div style="display:flex;gap:4px;background:rgba(255,255,255,.05);border-radius:10px;padding:4px">
      ${["1D","1W","1M","3M","1Y"].map(p=>
        p==="1M"
        ? `<span style="font-size:11px;font-weight:700;padding:4px 9px;border-radius:7px;background:rgba(26,196,240,.18);color:#1ac4f0;border:1px solid rgba(26,196,240,.28)">${p}</span>`
        : `<span style="font-size:11px;font-weight:600;padding:4px 9px;color:rgba(240,246,255,.35)">${p}</span>`
      ).join('')}
    </div>
  </div>

  <!-- Health score card -->
  <div class="card accent" style="padding:20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div>
        <div class="card-eyebrow">Financial Health</div>
        <div style="font-size:12px;color:rgba(240,246,255,.38)">Based on connected accounts</div>
      </div>
      <span class="badge cyan">Live</span>
    </div>
    <div class="health-row">
      <div class="ring-wrap">
        <svg width="92" height="92" viewBox="0 0 92 92">
          <circle cx="46" cy="46" r="36" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="9"/>
          <circle cx="46" cy="46" r="36" fill="none" stroke="#ff453a" stroke-width="9"
                  stroke-linecap="round" stroke-dasharray="226" stroke-dashoffset="136"
                  style="transform:rotate(-90deg);transform-origin:46px 46px"/>
        </svg>
        <div class="ring-grade"><div class="grade-letter">F</div><div class="grade-num">39</div></div>
      </div>
      <div style="flex:1">
        <div class="metric-row"><div class="metric-lbl">Spending</div><div class="metric-bar"><div class="metric-fill" style="width:85%;background:linear-gradient(90deg,#1ac4f0,#2563eb)"></div></div><div class="metric-val cyan">✓</div></div>
        <div class="metric-row"><div class="metric-lbl">Savings</div><div class="metric-bar"><div class="metric-fill" style="width:24%;background:#30d158"></div></div><div class="metric-val green">24</div></div>
        <div class="metric-row" style="margin-bottom:0"><div class="metric-lbl">Net Worth</div><div class="metric-bar"><div class="metric-fill" style="width:15%;background:#ff9f0a"></div></div><div class="metric-val warn">—</div></div>
      </div>
    </div>
    <hr class="div" style="margin:14px 0 10px">
    <div style="font-size:12px;color:rgba(240,246,255,.45)">💡 Try saving at least 10% of income. Even small amounts compound over time.</div>
  </div>

  <!-- Grade ladder -->
  <div class="card" style="padding:14px 16px">
    <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(240,246,255,.30);margin-bottom:10px">Your Path to A+</div>
    <div class="grade-ladder">
      <div class="grade-step active"><div class="grade-lbl" style="color:#ff453a">F</div></div>
      <div class="grade-step"><div class="grade-lbl" style="color:#ff9f0a">D</div></div>
      <div class="grade-step"><div class="grade-lbl" style="color:#fbbf24">C</div></div>
      <div class="grade-step"><div class="grade-lbl" style="color:#30d158">B</div></div>
      <div class="grade-step"><div class="grade-lbl" style="color:#30d158">A</div></div>
      <div class="grade-step"><div class="grade-lbl" style="color:#1ac4f0">A+</div></div>
    </div>
  </div>

  <!-- Spending -->
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <div class="card-eyebrow">Spending · This Month</div>
    </div>
    <div class="card-value sm" style="margin-bottom:12px">$1,613.65</div>
    <div class="bar-track" style="margin-bottom:8px"><div class="bar-fill" style="width:81%;background:linear-gradient(90deg,#1ac4f0,#2563eb)"></div></div>
    <div style="font-size:12px;color:rgba(240,246,255,.45)">81% of $2,000 budget · Projected $4,840</div>
    <div style="font-size:12px;color:#ff9f0a;margin-top:4px">⚠ $161/day avg · 20 days remaining</div>
  </div>

  <!-- Top categories -->
  <div style="display:flex;flex-direction:column;gap:7px">
    ${[
      ["⚡","Utilities",    "$853.29","53%","rgba(255,159,10,.18)","#ff9f0a",  73],
      ["🛍","Shopping",     "$295.52","18%","rgba(37,99,235,.18)", "#2563eb",  18],
      ["🍔","Food & Drink", "$211.91","13%","rgba(255,107,53,.18)","#ff6b35",  13],
      ["🔧","Services",     "$156.29","10%","rgba(107,63,220,.18)","#6b3fe0",  10],
    ].map(([ico,name,amt,pct,ibg,ic,w])=>`
    <div class="cat-row">
      <div class="cat-icon" style="background:${ibg}">${ico}</div>
      <div class="cat-body">
        <div class="cat-name">${name}</div>
        <div class="cat-bar"><div class="cat-bar-fill" style="width:${w}%;background:${ic}"></div></div>
      </div>
      <div class="cat-right">
        <div class="cat-amt">${amt}</div>
        <div class="cat-pct">${pct}</div>
      </div>
    </div>`).join('')}
  </div>
</div>
`, 1380);

const SCREEN_INSIGHTS = phoneFrame(`
<div class="app">
  <div class="app-hdr">Insights</div>

  <div class="card accent">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <div class="card-eyebrow">Spending · This Month</div>
      <span class="badge green">−49% vs last mo</span>
    </div>
    <div class="card-value" style="margin-bottom:14px">$1,613.65</div>
    <div class="stats3" style="border-top:1px solid rgba(255,255,255,.07);border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:14px">
      <div class="stat"><div class="stat-lbl">Spent</div><div class="stat-val cyan">$1,613/$2k</div></div>
      <div class="stats3-div"></div>
      <div class="stat"><div class="stat-lbl">Remaining</div><div class="stat-val white">$386</div></div>
      <div class="stats3-div"></div>
      <div class="stat"><div class="stat-lbl">Savings</div><div class="stat-val warn">0% ⚠</div></div>
    </div>
    <div class="bar-track"><div class="bar-fill" style="width:81%;background:linear-gradient(90deg,#1ac4f0,#2563eb)"></div></div>
    <div style="font-size:12px;color:#ff9f0a;margin-top:8px">⚠ $161/day avg · Projected: $4,840 · 20d left</div>
  </div>

  <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 4px 0">
    <div style="font-size:22px;font-weight:800;color:#F0F6FF">Categories</div>
    <div style="font-size:13px;color:rgba(240,246,255,.35)">this month</div>
  </div>

  ${[
    ["⚡","Utilities",    "$853.29","53%","rgba(255,159,10,.18)","#ff9f0a",  53,"rgba(255,69,58,.08)","rgba(255,69,58,.25)"],
    ["🛍","Shopping",     "$295.52","18%","rgba(37,99,235,.18)", "#2563eb",  18,null,null],
    ["🍔","Food & Drink", "$211.91","13%","rgba(255,107,53,.18)","#ff6b35",  13,null,null],
    ["🔧","Services",     "$156.29","10%","rgba(107,63,220,.18)","#6b3fe0",  10,null,null],
    ["🎭","Entertainment","$96.64",  "6%","rgba(255,165,80,.18)","#ffa550",   6,null,null],
  ].map(([ico,name,amt,pct,ibg,ic,w,rbg,rb])=>`
  <div class="cat-row" style="${rbg?`background:${rbg};border-color:${rb}`:''};flex-wrap:wrap">
    <div class="cat-icon" style="background:${ibg}">${ico}</div>
    <div class="cat-body">
      <div class="cat-name">${name}</div>
      <div style="font-size:11px;color:rgba(240,246,255,.38)">${w <= 18 ? `$${w===18?'382':'843'} left of ${w===18?'$678':'$900'} limit` : '—'}</div>
    </div>
    <div class="cat-right">
      <div class="cat-amt">${amt}</div>
      <div class="cat-pct">${pct}</div>
    </div>
    <div style="width:100%;margin-top:6px">
      <div class="cat-bar" style="height:4px"><div class="cat-bar-fill" style="width:${Math.round(w*0.72)}%;background:${ic}"></div></div>
    </div>
  </div>`).join('')}
</div>
`, 1380);

const SCREEN_BILLS = phoneFrame(`
<div class="app">
  <div class="app-hdr">Insights</div>

  <!-- Net worth trend -->
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="card-eyebrow">Net Worth Trend</div>
        <div class="card-value sm">−$56,565.06</div>
      </div>
      <span class="badge danger">−$393.14</span>
    </div>
    <svg class="sparkline" width="100%" height="52" viewBox="0 0 560 52" preserveAspectRatio="none" style="margin:10px 0 4px">
      <defs><linearGradient id="sg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff453a" stop-opacity=".15"/><stop offset="100%" stop-color="#ff453a" stop-opacity="0"/></linearGradient></defs>
      <path d="M0,4 C70,8 140,16 210,22 C280,28 350,34 420,39 C490,44 530,47 560,50 L560,52 L0,52 Z" fill="url(#sg2)"/>
      <path d="M0,4 C70,8 140,16 210,22 C280,28 350,34 420,39 C490,44 530,47 560,50" fill="none" stroke="#ff453a" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="560" cy="50" r="4.5" fill="#ff453a"/>
    </svg>
    <div style="font-size:11px;color:rgba(240,246,255,.30)">6-day history · 7 data points</div>
  </div>

  <!-- Cash flow -->
  <div class="card accent" style="padding:18px 20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div>
        <div class="card-eyebrow">Cash Flow</div>
        <div style="font-size:26px;font-weight:800;color:#F0F6FF;letter-spacing:-.03em">Next 7 Days</div>
      </div>
      <span class="badge warn">−$651.00 due</span>
    </div>
    <hr class="div">
    <div class="bill-row">
      <div class="bill-date"><div class="bill-day">Thu</div><div class="bill-num">11</div></div>
      <div class="bill-dot"></div>
      <div class="bill-name">Progressive Insurance</div>
      <div class="bill-amt">−$246.00</div>
    </div>
    <div class="bill-row">
      <div class="bill-date"><div class="bill-day">Sun</div><div class="bill-num">14</div></div>
      <div class="bill-dot"></div>
      <div class="bill-name">SoFi Loan</div>
      <div class="bill-amt">−$405.00</div>
    </div>
    <div style="font-size:12px;color:rgba(240,246,255,.30);text-align:center;padding-top:10px">Next 7 days · 3 bills pending</div>
  </div>

  <!-- Top Merchants -->
  <div class="card" style="padding:16px 18px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div>
        <div class="card-eyebrow">Where You Spend</div>
        <div style="font-size:20px;font-weight:800;color:#F0F6FF">Top Merchants</div>
      </div>
      <div style="font-size:12px;color:rgba(240,246,255,.35)">this month</div>
    </div>
    ${[
      ["Ysi Grandview Apts","$853.29",100,"#1ac4f0"],
      ["Anthropic",         "$130.00", 15,"#2563eb"],
      ["Casey's",           "$115.01", 13,"#ff6b35"],
      ["Top Golf Bay",      "$82.74",   9,"#f093fb"],
      ["Walmart",           "$68.40",   8,"#43e97b"],
    ].map(([n,a,w,c])=>`
    <div class="merchant-row">
      <div class="merchant-hdr"><span class="merchant-name">${n}</span><span class="merchant-amt">${a}</span></div>
      <div class="bar-track" style="height:4px"><div class="bar-fill" style="width:${w}%;background:${c}"></div></div>
    </div>`).join('')}
  </div>

  <!-- Subscriptions detected -->
  <div class="card" style="display:flex;gap:12px;align-items:center;padding:14px 16px">
    <div style="width:38px;height:38px;border-radius:11px;background:rgba(255,69,58,.12);border:1px solid rgba(255,69,58,.2);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">🔍</div>
    <div style="flex:1">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:15px;font-weight:700;color:#F0F6FF">Subscriptions</span>
        <span style="background:rgba(255,69,58,.6);color:#fff;font-size:10px;font-weight:800;padding:2px 7px;border-radius:10px">1</span>
      </div>
      <div style="font-size:12px;color:rgba(240,246,255,.40);margin-top:2px">Recurring charges detected</div>
    </div>
    <div style="font-size:13px;color:#ff453a;font-weight:700">Review →</div>
  </div>
</div>
`, 1380);

const SCREEN_WEALTH = phoneFrame(`
<div class="app">
  <div class="app-hdr">Wealth</div>

  <!-- Hero NW -->
  <div class="card accent" style="padding:20px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
      <div class="card-eyebrow">Net Worth</div>
      <span class="badge danger">↓ −$393.14</span>
    </div>
    <div style="font-size:52px;font-weight:900;letter-spacing:-.05em;color:#F0F6FF;line-height:1;margin-bottom:14px;font-variant-numeric:tabular-nums">−$56,565<span style="font-size:32px">.06</span></div>
    <svg class="sparkline" width="100%" height="64" viewBox="0 0 560 64" preserveAspectRatio="none">
      <defs><linearGradient id="sg3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff453a" stop-opacity=".2"/><stop offset="100%" stop-color="#ff453a" stop-opacity="0"/></linearGradient></defs>
      <path d="M0,4 C46,8 93,14 140,18 C186,22 233,28 280,33 C326,38 373,42 420,46 C466,50 513,54 560,58 L560,64 L0,64 Z" fill="url(#sg3)"/>
      <path d="M0,4 C46,8 93,14 140,18 C186,22 233,28 280,33 C326,38 373,42 420,46 C466,50 513,54 560,58" fill="none" stroke="#ff453a" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="560" cy="58" r="5" fill="#ff453a"/>
    </svg>
    <div style="font-size:11px;color:rgba(240,246,255,.28);margin-top:4px">6-day history · 7 data points</div>
  </div>

  <!-- Accounts -->
  <div class="card" style="padding:16px 18px">
    <div class="card-eyebrow" style="margin-bottom:10px">Your Accounts</div>
    <div class="acct-row">
      <div class="acct-icon" style="background:rgba(26,196,240,.15);color:#1ac4f0">C</div>
      <div class="acct-body"><div class="acct-name">Chase Checking</div><div class="acct-type">•••• 4821 · 2 min ago</div></div>
      <div class="acct-bal green">$847.23</div>
    </div>
    <div class="acct-row">
      <div class="acct-icon" style="background:rgba(255,69,58,.15);color:#ff453a">S</div>
      <div class="acct-body"><div class="acct-name">SoFi Personal Loan</div><div class="acct-type">•••• 9142 · 2 min ago</div></div>
      <div class="acct-bal danger">−$57,412.29</div>
    </div>
  </div>

  <!-- Monthly budget cal -->
  <div class="card" style="padding:16px 18px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div><div class="card-eyebrow">Budget Calendar</div><div style="font-size:20px;font-weight:800;color:#F0F6FF">Month by Month</div></div>
      <div style="font-size:16px;font-weight:700;color:rgba(240,246,255,.35)">2026</div>
    </div>
    <div style="display:flex;gap:8px;overflow:hidden">
      ${[
        ["APR","$2.9k","100%","#ff9f0a"],
        ["MAY","$3.2k","100%","#ff453a"],
        ["JUN","$1.6k","81%", "#1ac4f0"],
        ["JUL","—",    "0%",  "rgba(255,255,255,.15)"],
      ].map(([m,a,p,c],i)=>`
      <div style="flex:1;background:${i===2?'rgba(26,196,240,.10)':'rgba(255,255,255,.04)'};border:1px solid ${i===2?'rgba(26,196,240,.3)':'rgba(255,255,255,.07)'};border-radius:14px;padding:10px 8px;text-align:center">
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(240,246,255,.35);margin-bottom:4px">${m}</div>
        <div style="font-size:16px;font-weight:800;color:#F0F6FF;margin-bottom:8px">${a}</div>
        <div style="height:3px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden;margin-bottom:4px"><div style="height:100%;width:${p};background:${c};border-radius:99px"></div></div>
        <div style="font-size:10px;color:${c==='rgba(255,255,255,.15)'?'rgba(240,246,255,.28)':c}">${p}</div>
      </div>`).join('')}
    </div>
  </div>

  <!-- Cash flow -->
  <div class="card" style="padding:14px 16px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div><div class="card-eyebrow">Cash Flow</div><div style="font-size:18px;font-weight:800;color:#F0F6FF">Next 7 Days</div></div>
      <span class="badge warn">−$651.00 due</span>
    </div>
    <div class="bill-row" style="padding:8px 0"><div class="bill-date"><div class="bill-day">Thu</div><div class="bill-num" style="font-size:20px">11</div></div><div class="bill-dot"></div><div class="bill-name" style="font-size:13px">Progressive Insurance</div><div class="bill-amt" style="font-size:13px">−$246.00</div></div>
    <div class="bill-row" style="padding:8px 0;border:none"><div class="bill-date"><div class="bill-day">Sun</div><div class="bill-num" style="font-size:20px">14</div></div><div class="bill-dot"></div><div class="bill-name" style="font-size:13px">SoFi Loan</div><div class="bill-amt" style="font-size:13px">−$405.00</div></div>
  </div>
</div>
`, 1380);

const SCREEN_PREMIUM = phoneFrame(`
<div class="app">
  <div class="app-hdr" style="font-size:28px">FlowCheck Pro</div>

  <!-- Trial badge -->
  <div style="text-align:center;padding:6px 0 10px">
    <span style="display:inline-block;background:linear-gradient(90deg,rgba(26,196,240,.15),rgba(37,99,235,.15));border:1px solid rgba(26,196,240,.3);border-radius:999px;padding:8px 20px;font-size:13px;font-weight:700;color:#1ac4f0">✦ 7-day free trial included</span>
  </div>

  <!-- Features -->
  <div style="display:flex;flex-direction:column;gap:7px">
    ${[
      ["✦","Financial Health Score","Your unique 0–100 financial rating","#1ac4f0"],
      ["✦","Unlimited Bank Accounts","Connect every account you own","#2563eb"],
      ["✦","AI Spending Insights","Patterns you'd miss on your own","#1ac4f0"],
      ["✦","Bill Protection","Know every bill before it hits","#ff9f0a"],
      ["✦","Net Worth Dashboard","Assets + liabilities, one clear view","#2563eb"],
      ["✦","Budget Calendar","Your full spending history, month by month","#1ac4f0"],
    ].map(([b,t,s,c])=>`
    <div class="feature-row">
      <div class="feat-bullet" style="color:${c}">${b}</div>
      <div class="feat-body"><div class="feat-title">${t}</div><div class="feat-sub">${s}</div></div>
    </div>`).join('')}
  </div>

  <!-- CTA -->
  <div style="padding:6px 0 0">
    <div class="cta-btn">Start 7-Day Free Trial</div>
    <div style="text-align:center;font-size:12px;color:rgba(240,246,255,.35);margin-top:10px">No credit card required · Cancel anytime</div>
  </div>

  <!-- Pricing -->
  <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:16px;padding:16px;text-align:center">
    <div style="font-size:12px;color:rgba(240,246,255,.35);margin-bottom:6px">After free trial</div>
    <div style="font-size:28px;font-weight:900;color:#F0F6FF;letter-spacing:-.03em">$4.99<span style="font-size:16px;font-weight:400;color:rgba(240,246,255,.45)">/month</span></div>
    <div style="font-size:13px;color:rgba(240,246,255,.45);margin-top:6px">or $39.99/year — <span style="color:#30d158;font-weight:700">save 33%</span></div>
  </div>
</div>
`, 1260);

// ── Screenshot definitions ────────────────────────────────────────────────────
const SCREENSHOTS = [
  {
    file: "01_hero",
    category: "FINANCIAL CLARITY",
    h1: "Your money,",
    h2: "finally clear.",
    tagline: "Every account. Every dollar. All in one place.",
    screen: SCREEN_HOME,
    phoneTop: 476,
    bg: '#F7F2EC',
  },
  {
    file: "02_health_score",
    category: "FINANCIAL HEALTH",
    h1: "Know exactly",
    h2: "where you stand.",
    tagline: "Your 0–100 financial health rating.",
    screen: SCREEN_HEALTH,
    phoneTop: 476,
    bg: '#F7F2EC',
  },
  {
    file: "03_spending",
    category: "SPENDING INSIGHTS",
    h1: "See where every",
    h2: "dollar goes.",
    tagline: "Category breakdowns. Budget tracking. Real-time.",
    screen: SCREEN_INSIGHTS,
    phoneTop: 476,
    bg: '#F0EBE8',
  },
  {
    file: "04_bills",
    category: "CASH FLOW",
    h1: "No more",
    h2: "surprise bills.",
    tagline: "Know what's hitting your account before it does.",
    screen: SCREEN_BILLS,
    phoneTop: 476,
    bg: '#F7F2EC',
  },
  {
    file: "05_wealth",
    category: "WEALTH TRACKING",
    h1: "Your complete",
    h2: "picture of wealth.",
    tagline: "Net worth. Bills. Accounts. One clear view.",
    screen: SCREEN_WEALTH,
    phoneTop: 476,
    bg: '#EEF0F7',
  },
  {
    file: "06_premium",
    category: "GO PRO",
    h1: "Start free.",
    h2: "Stay forever.",
    tagline: "7-day trial. No credit card. Cancel anytime.",
    screen: SCREEN_PREMIUM,
    phoneTop: 476,
    bg: '#F7F2EC',
  },
];

// ── HTML generator ────────────────────────────────────────────────────────────
function makeHTML(ss) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${BASE_CSS}
body { background:${ss.bg}; }
</style>
</head>
<body>
<div class="canvas">

  <!-- Subtle noise texture overlay -->
  <svg style="position:absolute;inset:0;width:100%;height:100%;opacity:.018;pointer-events:none" xmlns="http://www.w3.org/2000/svg">
    <filter id="noise"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/></filter>
    <rect width="100%" height="100%" filter="url(#noise)"/>
  </svg>

  <!-- Text content -->
  <div style="position:absolute;left:80px;top:90px;right:80px">
    <div class="cat" style="margin-bottom:20px">${ss.category}</div>
    <div class="h1">${ss.h1}</div>
    <div class="h1-i">${ss.h2}</div>
    <div class="tag" style="margin-top:22px">${ss.tagline}</div>
  </div>

  <!-- Phone -->
  <div class="phone-wrap" style="top:${ss.phoneTop}px">
    ${ss.screen}
  </div>

</div>
</body>
</html>`;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(ss) {
  const htmlPath = path.join(TMP, `${ss.file}.html`);
  const pngPath  = path.join(OUT, `${ss.file}.png`);

  fs.writeFileSync(htmlPath, makeHTML(ss));

  try {
    execSync([
      `"${CHROME}"`,
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-web-security',
      '--hide-scrollbars',
      `--screenshot="${pngPath}"`,
      '--window-size=1290,2796',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=2000',
      `"file://${htmlPath}"`
    ].join(' '), { stdio: 'pipe' });
    console.log(`  ✓ ${ss.file}.png`);
  } catch (e) {
    console.error(`  ✗ ${ss.file}: ${e.message.slice(0,120)}`);
  }
}

console.log('\nFlowCheck App Store Screenshots v3\n' + '─'.repeat(40));
SCREENSHOTS.forEach(render);
console.log(`\n✓ Done → ${OUT}/`);

// Cleanup temp
try { fs.rmSync(TMP, { recursive: true }); } catch(_) {}
