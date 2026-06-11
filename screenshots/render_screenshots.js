#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = '/Users/brandon/FlowCheck-clean/screenshots/v3';
fs.mkdirSync(OUT, { recursive: true });

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; -webkit-font-smoothing:antialiased; }
html,body { width:1290px; height:2796px; overflow:hidden; }
body { font-family:-apple-system,'Helvetica Neue',sans-serif; }
.cat { font-size:26px; font-weight:800; letter-spacing:.10em; text-transform:uppercase; color:#1ac4f0; margin-bottom:20px; }
.h1  { font-size:112px; font-weight:800; letter-spacing:-.04em; line-height:1.02; color:#18181B; }
.h1i { font-family:Georgia,serif; font-style:italic; font-weight:bold; font-size:112px; letter-spacing:-.03em; line-height:1.02; color:#18181B; }
.tag { font-size:40px; font-weight:400; color:#6B7280; line-height:1.4; margin-top:24px; }
.po  { width:740px; border-radius:60px; background:linear-gradient(160deg,#14202E,#0A0F1C);
       box-shadow:0 0 0 1px rgba(255,255,255,.09),0 60px 140px rgba(0,0,0,.60),0 20px 40px rgba(0,0,0,.30); padding:14px; }
.ps  { border-radius:50px; background:#060E18; overflow:hidden; position:relative; }
.di  { position:absolute; top:14px; left:50%; transform:translateX(-50%);
       width:130px; height:30px; background:#000; border-radius:15px; z-index:20; }
.app { padding:0 26px; padding-top:68px; display:flex; flex-direction:column; gap:12px; color:#F0F6FF; }
.ah  { font-size:38px; font-weight:800; color:#F0F6FF; margin-bottom:4px; }
.card { background:linear-gradient(145deg,#0D1B2E,#091422); border:1px solid rgba(255,255,255,.07); border-radius:22px; padding:20px 22px; }
.ac  { border-color:rgba(26,196,240,.22); }
.el  { border-color:rgba(37,99,235,.25); }
.ey  { font-size:13px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:rgba(240,246,255,.36); margin-bottom:7px; }
.cv  { font-size:52px; font-weight:900; letter-spacing:-.05em; color:#F0F6FF; line-height:1; font-variant-numeric:tabular-nums; }
.cv2 { font-size:38px; font-weight:900; letter-spacing:-.04em; color:#F0F6FF; line-height:1; font-variant-numeric:tabular-nums; }
.bdg { display:inline-flex; align-items:center; padding:5px 13px; border-radius:999px; font-size:13px; font-weight:700; }
.bg  { background:rgba(48,209,88,.15);  color:#30d158; border:1px solid rgba(48,209,88,.25); }
.br  { background:rgba(255,69,58,.15);  color:#ff453a; border:1px solid rgba(255,69,58,.25); }
.bw  { background:rgba(255,159,10,.15); color:#ff9f0a; border:1px solid rgba(255,159,10,.25); }
.bc  { background:rgba(26,196,240,.15); color:#1ac4f0; border:1px solid rgba(26,196,240,.25); }
.bt  { height:8px; background:rgba(255,255,255,.08); border-radius:99px; overflow:hidden; }
.bf  { height:100%; border-radius:99px; }
.dv  { border:none; border-top:1px solid rgba(255,255,255,.07); margin:13px 0; }
.s3  { display:grid; grid-template-columns:1fr 1px 1fr 1px 1fr; }
.sd  { background:rgba(255,255,255,.07); }
.st  { text-align:center; padding:11px 0; }
.sl  { font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:rgba(240,246,255,.35); margin-bottom:6px; }
.sv  { font-size:17px; font-weight:800; font-variant-numeric:tabular-nums; }
.cyan{ color:#1ac4f0; } .wht{ color:#F0F6FF; } .wrn{ color:#ff9f0a; }
.grn { color:#30d158; } .dng{ color:#ff453a; } .mt { color:rgba(240,246,255,.45); } .ft{ color:rgba(240,246,255,.30); }
.cr  { display:flex; align-items:center; gap:14px; background:linear-gradient(145deg,#0D1B2E,#091422);
       border:1px solid rgba(255,255,255,.06); border-radius:18px; padding:14px 16px; }
.ci  { width:44px; height:44px; border-radius:13px; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0; }
.cn  { font-size:16px; font-weight:600; color:#F0F6FF; }
.cx  { font-size:13px; color:rgba(240,246,255,.38); }
.ca  { font-size:16px; font-weight:800; color:#F0F6FF; text-align:right; font-variant-numeric:tabular-nums; }
.cbr { height:4px; background:rgba(255,255,255,.08); border-radius:99px; margin-top:8px; overflow:hidden; }
.cbf { height:100%; border-radius:99px; }
.br2 { display:flex; align-items:center; gap:16px; padding:12px 0; border-bottom:1px solid rgba(255,255,255,.06); }
.bd2 { width:46px; text-align:center; flex-shrink:0; }
.bdn { font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:rgba(240,246,255,.35); }
.bdd { font-size:27px; font-weight:800; color:#F0F6FF; line-height:1.1; }
.dot { width:9px; height:9px; border-radius:50%; background:#ff453a; flex-shrink:0; }
.bn  { font-size:15px; color:rgba(240,246,255,.75); flex:1; }
.ba  { font-size:15px; font-weight:800; color:#ff453a; font-variant-numeric:tabular-nums; }
.rw  { position:relative; width:100px; height:100px; flex-shrink:0; }
.rw svg { transform:rotate(-90deg); }
.rg  { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.rl  { font-size:34px; font-weight:900; color:#F0F6FF; line-height:1; }
.rn  { font-size:12px; color:rgba(240,246,255,.40); font-weight:600; }
.mr  { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
.ml  { font-size:13px; color:rgba(240,246,255,.45); width:78px; flex-shrink:0; }
.mb  { flex:1; height:6px; background:rgba(255,255,255,.08); border-radius:99px; overflow:hidden; }
.mf  { height:100%; border-radius:99px; }
.mv  { font-size:13px; font-weight:800; width:26px; text-align:right; flex-shrink:0; }
.gl  { display:flex; }
.gs  { flex:1; text-align:center; padding:11px 0; }
.gsa { background:rgba(255,69,58,.12); border-radius:11px; border:1px solid rgba(255,69,58,.25); }
.glb { font-size:22px; font-weight:800; }
.frw { display:flex; align-items:center; gap:16px; padding:16px 18px;
       background:linear-gradient(145deg,#0D1B2E,#091422); border:1px solid rgba(255,255,255,.06); border-radius:18px; }
.ftt { font-size:17px; font-weight:700; color:#F0F6FF; }
.fts { font-size:13px; color:rgba(240,246,255,.45); margin-top:3px; }
.cta { display:block; width:100%; padding:24px 0; border-radius:16px; text-align:center;
       font-size:20px; font-weight:800; color:#050E18; background:linear-gradient(90deg,#1ac4f0,#2563eb);
       box-shadow:0 8px 24px rgba(26,196,240,.28); }
.ar  { display:flex; align-items:center; gap:14px; padding:13px 0; border-bottom:1px solid rgba(255,255,255,.06); }
.ai  { width:42px; height:42px; border-radius:13px; display:flex; align-items:center; justify-content:center; font-size:16px; font-weight:800; flex-shrink:0; }
.ab  { flex:1; }
.an  { font-size:15px; font-weight:600; color:#F0F6FF; }
.at  { font-size:12px; color:rgba(240,246,255,.38); }
.av  { font-size:18px; font-weight:800; font-variant-numeric:tabular-nums; }
`;

// Bottom tab bar — always visible at base of phone screen
function tabBar(active) {
  const tabs = [
    { id:'home',     icon:'⊞',  label:'Home'     },
    { id:'activity', icon:'∿',  label:'Activity'  },
    { id:'insights', icon:'▦',  label:'Insights'  },
    { id:'wealth',   icon:'↗',  label:'Wealth'    },
    { id:'settings', icon:'⚙',  label:'Settings'  },
  ];
  return `<div style="position:absolute;bottom:0;left:0;right:0;height:90px;
    background:rgba(6,14,24,.96);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);
    border-top:1px solid rgba(255,255,255,.07);display:flex;align-items:flex-start;
    padding:10px 0 0;z-index:30">
    ${tabs.map(t => {
      const isActive = t.id === active;
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
        <div style="width:28px;height:3px;border-radius:2px;background:${isActive ? '#1ac4f0' : 'transparent'};margin-bottom:2px"></div>
        <div style="font-size:22px;color:${isActive ? '#1ac4f0' : 'rgba(240,246,255,.35)'}">${t.icon}</div>
        <div style="font-size:11px;font-weight:${isActive ? 700 : 500};color:${isActive ? '#1ac4f0' : 'rgba(240,246,255,.35)'};letter-spacing:.01em">${t.label}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function snap(file, bg, cat, h1, h2, tag, scr, activeTab, phoneTop) {
  phoneTop = phoneTop || 680;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}body{background:${bg}}</style></head>
<body><div style="width:1290px;height:2796px;position:relative;overflow:hidden">
  <div style="position:absolute;left:82px;top:92px;right:82px">
    <div class="cat">${cat}</div>
    <div class="h1">${h1}</div>
    <div class="h1i">${h2}</div>
    <div class="tag">${tag}</div>
  </div>
  <div style="position:absolute;left:50%;transform:translateX(-50%);top:${phoneTop}px">
    <div class="po"><div class="ps" style="height:1960px"><div class="di"></div>${scr}${tabBar(activeTab)}</div></div>
  </div>
</div></body></html>`;
  const tmp = `/tmp/${file}.html`;
  const out = `${OUT}/${file}.png`;
  fs.writeFileSync(tmp, html);
  execSync(`"${CHROME}" --headless=new --no-sandbox --disable-gpu --hide-scrollbars --screenshot="${out}" --window-size=1290,2796 --force-device-scale-factor=1 "file://${tmp}"`,
    { stdio: 'pipe', timeout: 30000 });
  console.log(`  ✓ ${file}.png`);
}

// ── SCREEN HELPERS ────────────────────────────────────────────────────────────

function catRow(emoji, name, amount, pct, iconBg, barColor, barW) {
  return `<div class="cr">
    <div class="ci" style="background:${iconBg}">${emoji}</div>
    <div style="flex:1;min-width:0">
      <div class="cn">${name}</div>
      <div class="cbr"><div class="cbf" style="width:${barW}%;background:${barColor}"></div></div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div class="ca">${amount}</div>
      <div class="cx">${pct}</div>
    </div>
  </div>`;
}

function periodPills() {
  return `<div style="display:flex;gap:4px;background:rgba(255,255,255,.05);border-radius:10px;padding:3px">
    <span style="font-size:11px;font-weight:600;padding:4px 9px;color:rgba(240,246,255,.35)">1D</span>
    <span style="font-size:11px;font-weight:600;padding:4px 9px;color:rgba(240,246,255,.35)">1W</span>
    <span style="font-size:11px;font-weight:700;padding:4px 9px;border-radius:7px;background:rgba(26,196,240,.18);color:#1ac4f0">1M</span>
    <span style="font-size:11px;font-weight:600;padding:4px 9px;color:rgba(240,246,255,.35)">3M</span>
    <span style="font-size:11px;font-weight:600;padding:4px 9px;color:rgba(240,246,255,.35)">1Y</span>
  </div>`;
}

function sparkline(id, color) {
  return `<svg width="100%" height="52" viewBox="0 0 680 52" preserveAspectRatio="none" style="margin:12px 0 10px;display:block">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity=".18"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="M0,5 C85,9 170,18 255,24 C340,30 425,37 510,42 C595,47 640,50 680,51 L680,52 L0,52 Z" fill="url(#${id})"/>
    <path d="M0,5 C85,9 170,18 255,24 C340,30 425,37 510,42 C595,47 640,50 680,51" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="680" cy="51" r="4.5" fill="${color}"/>
  </svg>`;
}

// ── SS1: HERO ─────────────────────────────────────────────────────────────────
snap('01_hero', '#F7F2EC', 'FINANCIAL CLARITY',
  'Your money,', 'finally clear.',
  'Every account. Every dollar. In real time.',
  `<div class="app">
  <div class="ah">FlowCheck</div>
  <div class="card ac">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
      <div class="ey">Net Worth</div><span class="bdg br">↓ −$393</span>
    </div>
    <div class="cv">−$56,565</div>
    <svg width="100%" height="52" viewBox="0 0 680 52" preserveAspectRatio="none" style="margin:12px 0 10px;display:block">
      <defs><linearGradient id="sg0" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff453a" stop-opacity=".18"/><stop offset="100%" stop-color="#ff453a" stop-opacity="0"/></linearGradient></defs>
      <path d="M0,5 C85,9 170,18 255,24 C340,30 425,37 510,42 C595,47 640,50 680,51 L680,52 L0,52 Z" fill="url(#sg0)"/>
      <path d="M0,5 C85,9 170,18 255,24 C340,30 425,37 510,42 C595,47 640,50 680,51" fill="none" stroke="#ff453a" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="680" cy="51" r="4.5" fill="#ff453a"/>
    </svg>
    <hr class="dv" style="margin:4px 0 11px">
    <div style="display:flex;justify-content:space-between">
      <span class="mt" style="font-size:14px">Chase Checking</span>
      <span style="font-size:14px;font-weight:700;color:#F0F6FF">$847.23</span>
    </div>
  </div>
  <div class="card ac">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div class="ey">Spending · This Month</div><span class="bdg bg">−49% vs last mo</span>
    </div>
    <div class="cv" style="margin-bottom:16px">$1,613.65</div>
    <div class="s3" style="border-top:1px solid rgba(255,255,255,.07);border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:16px">
      <div class="st"><div class="sl">Spent</div><div class="sv cyan">$1,613/$2k</div></div>
      <div class="sd"></div>
      <div class="st"><div class="sl">Remaining</div><div class="sv wht">$386</div></div>
      <div class="sd"></div>
      <div class="st"><div class="sl">Savings</div><div class="sv wrn">0% ⚠</div></div>
    </div>
    <div class="bt"><div class="bf" style="width:81%;background:linear-gradient(90deg,#1ac4f0,#2563eb)"></div></div>
    <div style="font-size:13px;color:#ff9f0a;margin-top:9px">⚠ $161/day avg · Projected: $4,840 · 20 days left</div>
  </div>
  <div class="card el" style="display:flex;gap:13px;align-items:flex-start;padding:16px 18px">
    <div style="color:#2563eb;font-size:22px;flex-shrink:0;margin-top:1px">✦</div>
    <div>
      <div style="font-size:16px;font-weight:700;color:#F0F6FF">Utilities are 40% of spending</div>
      <div style="font-size:13px;color:rgba(240,246,255,.45);margin-top:4px">Tap to see savings opportunities →</div>
    </div>
  </div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:13px">
      <div class="ey" style="margin:0">Upcoming Bills</div><span class="bdg bw">−$651 this week</span>
    </div>
    <hr class="dv" style="margin:0 0 10px">
    <div class="br2">
      <div class="bd2"><div class="bdn">Thu</div><div class="bdd">11</div></div>
      <div class="dot"></div><div class="bn">Progressive Insurance</div><div class="ba">−$246.00</div>
    </div>
    <div class="br2" style="border:none">
      <div class="bd2"><div class="bdn">Sun</div><div class="bdd">14</div></div>
      <div class="dot"></div><div class="bn">SoFi Loan</div><div class="ba">−$405.00</div>
    </div>
  </div>
</div>`, 'home');

// ── SS2: HEALTH SCORE ─────────────────────────────────────────────────────────
snap('02_health_score', '#F7F2EC', 'FINANCIAL HEALTH',
  'Know exactly', 'where you stand.',
  'Your personal 0–100 financial health rating.',
  `<div class="app">
  <div class="ah" style="display:flex;justify-content:space-between;align-items:center">
    Insights ${periodPills()}
  </div>
  <div class="card ac" style="padding:22px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <div><div class="ey">Financial Health</div><div style="font-size:13px;color:rgba(240,246,255,.38)">Based on connected accounts</div></div>
      <span class="bdg bc">Live</span>
    </div>
    <div style="display:flex;align-items:center;gap:24px">
      <div class="rw">
        <svg width="100" height="100" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="38" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="10"/>
          <circle cx="50" cy="50" r="38" fill="none" stroke="#ff453a" stroke-width="10"
                  stroke-linecap="round" stroke-dasharray="239" stroke-dashoffset="143"
                  style="transform:rotate(-90deg);transform-origin:50px 50px"/>
        </svg>
        <div class="rg"><div class="rl">F</div><div class="rn">39</div></div>
      </div>
      <div style="flex:1">
        <div class="mr"><div class="ml">Spending</div><div class="mb"><div class="mf" style="width:85%;background:linear-gradient(90deg,#1ac4f0,#2563eb)"></div></div><div class="mv cyan">✓</div></div>
        <div class="mr"><div class="ml">Savings</div><div class="mb"><div class="mf" style="width:24%;background:#30d158"></div></div><div class="mv grn">24</div></div>
        <div class="mr" style="margin:0"><div class="ml">Net Worth</div><div class="mb"><div class="mf" style="width:15%;background:#ff9f0a"></div></div><div class="mv wrn">—</div></div>
      </div>
    </div>
    <hr class="dv" style="margin:16px 0 11px">
    <div style="font-size:13px;color:rgba(240,246,255,.45)">💡 Try saving at least 10% of income. Even small amounts compound.</div>
  </div>
  <div class="card" style="padding:16px 18px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:rgba(240,246,255,.30);margin-bottom:11px">Your Path to A+</div>
    <div class="gl">
      <div class="gs gsa"><div class="glb" style="color:#ff453a">F</div></div>
      <div class="gs"><div class="glb" style="color:#ff9f0a">D</div></div>
      <div class="gs"><div class="glb" style="color:#fbbf24">C</div></div>
      <div class="gs"><div class="glb" style="color:#30d158">B</div></div>
      <div class="gs"><div class="glb" style="color:#30d158">A</div></div>
      <div class="gs"><div class="glb" style="color:#1ac4f0">A+</div></div>
    </div>
  </div>
  <div class="card">
    <div class="ey">Spending · This Month</div>
    <div class="cv2" style="margin-bottom:13px">$1,613.65</div>
    <div class="bt" style="margin-bottom:9px"><div class="bf" style="width:81%;background:linear-gradient(90deg,#1ac4f0,#2563eb)"></div></div>
    <div style="font-size:13px;color:rgba(240,246,255,.45)">81% of $2,000 budget · Projected $4,840</div>
    <div style="font-size:13px;color:#ff9f0a;margin-top:5px">⚠ $161/day avg · 20 days remaining</div>
  </div>
  ${catRow('⚡','Utilities','$853.29','53%','rgba(255,159,10,.18)','#ff9f0a',53)}
  ${catRow('🛍','Shopping','$295.52','18%','rgba(37,99,235,.18)','#2563eb',18)}
  ${catRow('🍔','Food & Drink','$211.91','13%','rgba(255,107,53,.18)','#ff6b35',13)}
</div>`, 'insights');

// ── SS3: SPENDING CATEGORIES ──────────────────────────────────────────────────
snap('03_spending', '#F0EBE8', 'SPENDING INSIGHTS',
  'See where every', 'dollar goes.',
  'Category breakdowns. Budget tracking. Real-time.',
  `<div class="app">
  <div class="ah" style="display:flex;justify-content:space-between;align-items:center">
    Insights ${periodPills()}
  </div>
  <div class="card ac">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div class="ey">Spending · This Month</div>
      <span class="bdg bg">−49% vs last mo</span>
    </div>
    <div class="cv" style="margin-bottom:14px">$1,613.65</div>
    <div class="s3" style="border-top:1px solid rgba(255,255,255,.07);border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:14px">
      <div class="st"><div class="sl">Spent</div><div class="sv cyan">$1,613/$2k</div></div>
      <div class="sd"></div>
      <div class="st"><div class="sl">Remaining</div><div class="sv wht">$386</div></div>
      <div class="sd"></div>
      <div class="st"><div class="sl">Savings</div><div class="sv wrn">0% ⚠</div></div>
    </div>
    <div class="bt"><div class="bf" style="width:81%;background:linear-gradient(90deg,#1ac4f0,#2563eb)"></div></div>
    <div style="font-size:13px;color:#ff9f0a;margin-top:9px">⚠ $161/day avg · Projected: $4,840 · 20 days left</div>
  </div>
  <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 4px">
    <div style="font-size:22px;font-weight:800;color:#F0F6FF">Categories</div>
    <div style="font-size:13px;color:rgba(240,246,255,.35)">this month</div>
  </div>
  ${catRow('⚡','Utilities','$853.29','53%','rgba(255,159,10,.18)','#ff9f0a',53)}
  ${catRow('🛍','Shopping','$295.52','18%','rgba(37,99,235,.18)','#2563eb',18)}
  ${catRow('🍔','Food & Drink','$211.91','13%','rgba(255,107,53,.18)','#ff6b35',13)}
  ${catRow('🔧','Services','$156.29','10%','rgba(107,63,220,.18)','#6b3fe0',10)}
  ${catRow('🎭','Entertainment','$96.64','6%','rgba(255,165,80,.18)','#ffa550',6)}
</div>`, 'insights');

// ── SS4: BILLS & CASH FLOW ────────────────────────────────────────────────────
snap('04_bills', '#F7F2EC', 'CASH FLOW',
  'No more', 'surprise bills.',
  'Know what hits your account before it does.',
  `<div class="app">
  <div class="ah">Insights</div>
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div><div class="ey">Net Worth Trend</div><div class="cv2">−$56,565.06</div></div>
      <span class="bdg br">−$393.14</span>
    </div>
    ${sparkline('sg1','#ff453a')}
    <div style="font-size:11px;color:rgba(240,246,255,.30)">6-day history · 7 data points</div>
  </div>
  <div class="card ac" style="padding:20px 22px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div><div class="ey">Cash Flow</div><div style="font-size:28px;font-weight:800;color:#F0F6FF;letter-spacing:-.03em">Next 7 Days</div></div>
      <span class="bdg bw">−$651.00 due</span>
    </div>
    <hr class="dv" style="margin:0 0 4px">
    <div class="br2">
      <div class="bd2"><div class="bdn">Thu</div><div class="bdd">11</div></div>
      <div class="dot"></div>
      <div class="bn">Progressive Insurance</div>
      <div class="ba">−$246.00</div>
    </div>
    <div class="br2" style="border:none">
      <div class="bd2"><div class="bdn">Sun</div><div class="bdd">14</div></div>
      <div class="dot"></div>
      <div class="bn">SoFi Loan</div>
      <div class="ba">−$405.00</div>
    </div>
    <div style="font-size:12px;color:rgba(240,246,255,.30);text-align:center;padding-top:10px">Next 7 days · 3 bills pending</div>
  </div>
  <div class="card" style="padding:18px 20px;margin-bottom:100px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:13px">
      <div><div class="ey">Where You Spend</div><div style="font-size:22px;font-weight:800;color:#F0F6FF">Top Merchants</div></div>
      <div style="font-size:13px;color:rgba(240,246,255,.35)">this month</div>
    </div>
    ${[['Ysi Grandview Apts','$853.29',100,'#1ac4f0'],['Anthropic','$130.00',15,'#2563eb'],['Casey\'s','$115.01',13,'#ff6b35'],['Top Golf Bay','$82.74',10,'#f093fb'],['Walmart','$68.40',8,'#43e97b']].map(([n,a,w,c])=>`
    <div style="padding:9px 0;border-bottom:1px solid rgba(255,255,255,.06)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:14px;color:#F0F6FF;font-weight:500">${n}</span>
        <span style="font-size:14px;font-weight:800;color:#F0F6FF;font-variant-numeric:tabular-nums">${a}</span>
      </div>
      <div style="height:4px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden">
        <div style="height:100%;width:${w}%;background:${c};border-radius:99px"></div>
      </div>
    </div>`).join('')}
  </div>
</div>`, 'insights');

// ── SS5: WEALTH ───────────────────────────────────────────────────────────────
snap('05_wealth', '#EEF0F7', 'WEALTH TRACKING',
  'Your complete', 'picture of wealth.',
  'Net worth. Accounts. Trends. All connected.',
  `<div class="app">
  <div class="ah">Wealth</div>
  <div class="card ac" style="padding:22px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
      <div class="ey">Net Worth</div>
      <span class="bdg br">↓ −$393.14</span>
    </div>
    <div style="font-size:52px;font-weight:900;letter-spacing:-.05em;color:#F0F6FF;line-height:1;font-variant-numeric:tabular-nums">−$56,565<span style="font-size:30px">.06</span></div>
    <svg width="100%" height="64" viewBox="0 0 680 64" preserveAspectRatio="none" style="margin:14px 0 10px;display:block">
      <defs><linearGradient id="sg2" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ff453a" stop-opacity=".20"/>
        <stop offset="100%" stop-color="#ff453a" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="M0,5 C56,9 113,16 170,21 C226,26 283,31 340,37 C396,43 453,49 510,53 C566,57 623,60 680,62 L680,64 L0,64 Z" fill="url(#sg2)"/>
      <path d="M0,5 C56,9 113,16 170,21 C226,26 283,31 340,37 C396,43 453,49 510,53 C566,57 623,60 680,62" fill="none" stroke="#ff453a" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="680" cy="62" r="5" fill="#ff453a"/>
    </svg>
    <div style="font-size:12px;color:rgba(240,246,255,.30)">6-day history · 7 data points</div>
  </div>
  <div class="card" style="padding:18px 20px">
    <div class="ey" style="margin-bottom:12px">Your Accounts</div>
    <div class="ar">
      <div class="ai" style="background:rgba(26,196,240,.15);color:#1ac4f0">C</div>
      <div class="ab"><div class="an">Chase Checking</div><div class="at">•••• 4821 · updated 2 min ago</div></div>
      <div class="av grn">$847.23</div>
    </div>
    <div class="ar" style="border:none">
      <div class="ai" style="background:rgba(255,69,58,.15);color:#ff453a">S</div>
      <div class="ab"><div class="an">SoFi Personal Loan</div><div class="at">•••• 9142 · updated 2 min ago</div></div>
      <div class="av dng">−$57,412.29</div>
    </div>
  </div>
  <div class="card" style="padding:18px 20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:13px">
      <div><div class="ey">Budget Calendar</div><div style="font-size:22px;font-weight:800;color:#F0F6FF">Month by Month</div></div>
      <div style="font-size:16px;font-weight:700;color:rgba(240,246,255,.35)">2026</div>
    </div>
    <div style="display:flex;gap:8px">
      ${[['APR','$2.9k','100%','#ff9f0a',false],['MAY','$3.2k','100%','#ff453a',false],['JUN','$1.6k','81%','#1ac4f0',true],['JUL','—','0%','rgba(255,255,255,.2)',false]].map(([m,a,p,c,cur])=>`
      <div style="flex:1;background:${cur?'rgba(26,196,240,.10)':'rgba(255,255,255,.04)'};border:1px solid ${cur?'rgba(26,196,240,.3)':'rgba(255,255,255,.07)'};border-radius:14px;padding:10px 8px;text-align:center">
        <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:rgba(240,246,255,.35);margin-bottom:5px">${m}</div>
        <div style="font-size:17px;font-weight:800;color:#F0F6FF;margin-bottom:8px">${a}</div>
        <div style="height:4px;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden;margin-bottom:5px"><div style="height:100%;width:${p};background:${c};border-radius:99px"></div></div>
        <div style="font-size:11px;color:${c.includes('rgba')?'rgba(240,246,255,.28)':c}">${p}</div>
      </div>`).join('')}
    </div>
  </div>
  <div class="card" style="padding:16px 20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div><div class="ey">Cash Flow</div><div style="font-size:20px;font-weight:800;color:#F0F6FF">Next 7 Days</div></div>
      <span class="bdg bw">−$651 due</span>
    </div>
    <div class="br2" style="padding:9px 0"><div class="bd2"><div class="bdn">Thu</div><div class="bdd" style="font-size:22px">11</div></div><div class="dot"></div><div class="bn" style="font-size:14px">Progressive Insurance</div><div class="ba" style="font-size:14px">−$246.00</div></div>
    <div class="br2" style="padding:9px 0;border:none"><div class="bd2"><div class="bdn">Sun</div><div class="bdd" style="font-size:22px">14</div></div><div class="dot"></div><div class="bn" style="font-size:14px">SoFi Loan</div><div class="ba" style="font-size:14px">−$405.00</div></div>
  </div>
</div>`, 'wealth');

// ── SS6: PREMIUM / GO PRO ─────────────────────────────────────────────────────
snap('06_premium', '#F7F2EC', 'GO PRO',
  'Start free.', 'Stay forever.',
  '7-day trial. No credit card. Cancel anytime.',
  `<div class="app">
  <div class="ah">FlowCheck Pro</div>
  <div style="text-align:center;padding:2px 0 8px">
    <span style="display:inline-block;background:linear-gradient(90deg,rgba(26,196,240,.15),rgba(37,99,235,.15));border:1px solid rgba(26,196,240,.3);border-radius:999px;padding:9px 22px;font-size:14px;font-weight:700;color:#1ac4f0">✦ 7-day free trial included</span>
  </div>
  <div style="display:flex;flex-direction:column;gap:8px">
    ${[
      ['✦','Financial Health Score','Your unique 0–100 financial rating','#1ac4f0'],
      ['✦','Unlimited Bank Accounts','Connect every account you own','#2563eb'],
      ['✦','AI Spending Insights','Patterns you\'d miss on your own','#1ac4f0'],
      ['✦','Bill Protection','Know every bill before it hits','#ff9f0a'],
      ['✦','Net Worth Dashboard','Assets + liabilities in one view','#2563eb'],
      ['✦','Budget Calendar','Full spending history, month by month','#1ac4f0'],
    ].map(([b,t,s,c]) => `<div class="frw">
      <div style="font-size:20px;color:${c};flex-shrink:0">${b}</div>
      <div><div class="ftt">${t}</div><div class="fts">${s}</div></div>
    </div>`).join('')}
  </div>
  <div style="padding:4px 0 0">
    <div class="cta">Start 7-Day Free Trial</div>
    <div style="text-align:center;font-size:13px;color:rgba(240,246,255,.35);margin-top:10px">No credit card required · Cancel anytime</div>
  </div>
  <div style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:18px;padding:18px;text-align:center">
    <div style="font-size:13px;color:rgba(240,246,255,.35);margin-bottom:6px">After free trial</div>
    <div style="font-size:30px;font-weight:900;color:#F0F6FF;letter-spacing:-.03em">$4.99<span style="font-size:17px;font-weight:400;color:rgba(240,246,255,.45)">/month</span></div>
    <div style="font-size:14px;color:rgba(240,246,255,.45);margin-top:7px">or $39.99/year — <span style="color:#30d158;font-weight:700">save 33%</span></div>
  </div>
</div>`, 'settings');

console.log('\n✓ All 6 screenshots rendered');
