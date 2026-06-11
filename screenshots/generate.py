#!/usr/bin/env python3
"""FlowCheck App Store Screenshot Generator — 5 premium iPhone 6.7" screenshots"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os, math

OUT = "/Users/brandon/FlowCheck-clean/screenshots"
os.makedirs(OUT, exist_ok=True)

# iPhone 6.7" App Store: 1290 × 2796
W, H = 1290, 2796

# ── Brand colors ────────────────────────────────────────────
BG       = (6,  14, 24)
BG2      = (10, 21, 32)
CARD     = (13, 28, 52)
CARD2    = (9,  18, 34)
ACCENT   = (26, 196, 240)
ELECTRIC = (37,  99, 235)
WHITE    = (240, 246, 255)
MUTED    = (130, 160, 195)
FAINT    = (65, 100, 135)
SUCCESS  = (48, 209,  88)
DANGER   = (255, 69,  58)
WARNING  = (255,159,  10)

# ── Fonts ───────────────────────────────────────────────────
SF       = "/System/Library/Fonts/SFNS.ttf"
SF_BOLD  = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
HN       = "/System/Library/Fonts/HelveticaNeue.ttc"

def fnt(size, bold=False):
    try:
        return ImageFont.truetype(SF_BOLD if bold else SF, size)
    except:
        return ImageFont.load_default()

# ── Drawing helpers ─────────────────────────────────────────

def rr(draw, x1, y1, x2, y2, r, fill=None, outline=None, width=1):
    draw.rounded_rectangle([x1, y1, x2, y2], radius=r, fill=fill,
                           outline=outline, width=width)

def glow(img, cx, cy, color, radius=600, strength=0.16):
    """Soft radial glow composited onto img."""
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r, g, b = color
    steps = 40
    for i in range(steps, 0, -1):
        rc = int(radius * i / steps)
        a  = int(255 * strength * ((steps - i) / steps) ** 2.2)
        d.ellipse([cx-rc, cy-rc, cx+rc, cy+rc], fill=(r, g, b, a))
    blurred = layer.filter(ImageFilter.GaussianBlur(radius // 5))
    return Image.alpha_composite(img.convert('RGBA'), blurred).convert('RGB')

def gradient_btn(img, x1, y1, x2, y2, r, text, fsize=38):
    """Gradient button: cyan → electric, clipped to rounded rect."""
    grad = Image.new('RGB', (W, H), (0, 0, 0))
    gd   = ImageDraw.Draw(grad)
    w    = x2 - x1
    for xi in range(w):
        t  = xi / max(w - 1, 1)
        rc = int(ACCENT[0] * (1-t) + ELECTRIC[0] * t)
        gc = int(ACCENT[1] * (1-t) + ELECTRIC[1] * t)
        bc = int(ACCENT[2] * (1-t) + ELECTRIC[2] * t)
        gd.rectangle([x1+xi, y1, x1+xi+1, y2], fill=(rc, gc, bc))
    mask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([x1, y1, x2, y2], radius=r, fill=255)
    img.paste(grad, mask=mask)
    d = ImageDraw.Draw(img)
    d.text(((x1+x2)//2, (y1+y2)//2), text, font=fnt(fsize, bold=True),
           fill=(4, 10, 18), anchor='mm')

def phone(img, cx, top, ph=1560):
    """Draw phone frame, return screen rect (sx1,sy1,sx2,sy2)."""
    pw = 730
    x1, y1 = cx - pw//2, top
    x2, y2 = cx + pw//2, top + ph

    # Drop shadow
    shd = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd  = ImageDraw.Draw(shd)
    for i in range(36, 0, -1):
        sd.rounded_rectangle([x1-i, y1-i//2, x2+i, y2+i*2],
                             radius=66+i, fill=(0,0,0, 7))
    img_c = Image.alpha_composite(img.convert('RGBA'),
                shd.filter(ImageFilter.GaussianBlur(18))).convert('RGB')
    img.paste(img_c)

    d = ImageDraw.Draw(img)
    # Body
    rr(d, x1, y1, x2, y2, 64, fill=(7, 16, 28), outline=(38, 68, 100), width=1)
    # Screen
    sx1, sy1 = x1+18, y1+18
    sx2, sy2 = x2-18, y2-18
    rr(d, sx1, sy1, sx2, sy2, 50, fill=(8, 18, 32))
    # Dynamic island
    di_w, di_h = 130, 30
    rr(d, cx-di_w//2, sy1+14, cx+di_w//2, sy1+44, 15, fill=(3, 8, 16))
    return sx1, sy1, sx2, sy2, img

def bottom_strip(draw, line1, line2=None, btn_text=None):
    """Consistent bottom section with optional CTA button."""
    y = 2360
    draw.text((W//2, y), line1, font=fnt(40), fill=MUTED, anchor='mt')
    if line2:
        y += 54
        draw.text((W//2, y), line2, font=fnt(40, bold=True), fill=WHITE, anchor='mt')

# ─────────────────────────────────────────────────────────────
# APP UI COMPONENTS
# ─────────────────────────────────────────────────────────────

def _header(d, sx1, sy1, title="FlowCheck"):
    """App header bar."""
    pad = 28
    d.text((sx1+pad, sy1+70), title, font=fnt(40, bold=True), fill=WHITE)

def _card(d, x1, y1, x2, y2, r=20, accent=None):
    """Base card, optional accent border."""
    rr(d, x1, y1, x2, y2, r, fill=CARD)
    if accent:
        rr(d, x1, y1, x2, y2, r, outline=(*accent, 70), width=1)

def _bar(d, x1, y, w, pct, color, h=8):
    rr(d, x1, y, x1+w, y+h, h//2, fill=(*FAINT, 60))
    filled = int(w * min(pct, 1.0))
    if filled > 0:
        rr(d, x1, y, x1+filled, y+h, h//2, fill=color)

# ─────────────────────────────────────────────────────────────
# HOME SCREEN
# ─────────────────────────────────────────────────────────────

def draw_home(img, sx1, sy1, sx2, sy2):
    d = ImageDraw.Draw(img)
    pad = 24
    cw  = sx2 - sx1 - pad*2
    y   = sy1 + 64

    _header(d, sx1, sy1)
    y += 76

    # ── Net Worth card ───────────────────────────────────────
    x1, x2 = sx1+pad, sx2-pad
    _card(d, x1, y, x2, y+190, accent=ACCENT)
    d.text((x1+20, y+16), "NET WORTH", font=fnt(18), fill=FAINT)
    d.text((x1+20, y+46), "-$56,565", font=fnt(54, bold=True), fill=WHITE)
    # Sparkline (simple red line)
    pts_raw = [0.82,0.78,0.73,0.70,0.67,0.63,0.59,0.55,0.50]
    sw, sh  = cw - 40, 36
    spk_y   = y + 118
    for i in range(len(pts_raw)-1):
        px1 = x1+20 + int(sw * i / (len(pts_raw)-1))
        px2 = x1+20 + int(sw * (i+1) / (len(pts_raw)-1))
        py1 = spk_y + int(sh * pts_raw[i])
        py2 = spk_y + int(sh * pts_raw[i+1])
        d.line([(px1,py1),(px2,py2)], fill=DANGER, width=3)
    d.text((x2-20, y+46), "↓ -$393", font=fnt(24, bold=True), fill=DANGER, anchor='ra')
    # Account row
    sep_y = y + 162
    d.line([(x1+20, sep_y), (x2-20, sep_y)], fill=(*WHITE, 18), width=1)
    d.text((x1+20, sep_y+12), "Chase Checking", font=fnt(22), fill=MUTED)
    d.text((x2-20, sep_y+12), "$847.23", font=fnt(22, bold=True), fill=WHITE, anchor='ra')
    y += 204

    # ── Spending card ────────────────────────────────────────
    _card(d, x1, y, x2, y+240, accent=ACCENT)
    d.text((x1+20, y+16), "SPENDING · THIS MONTH", font=fnt(17), fill=FAINT)
    # Green badge
    badge_text = "−49% vs last mo"
    bx = x2 - 20 - 210
    rr(d, bx, y+14, x2-20, y+42, 14, fill=(*SUCCESS, 35))
    d.text(((bx + x2-20)//2, y+28), badge_text, font=fnt(18), fill=SUCCESS, anchor='mm')
    d.text((x1+20, y+50), "$1,613.65", font=fnt(58, bold=True), fill=WHITE)

    # 3-col stats
    col_w3 = cw // 3
    sy3 = y + 124
    d.line([(x1+20, sy3), (x2-20, sy3)], fill=(*WHITE, 15), width=1)
    d.line([(x1+20, sy3+70), (x2-20, sy3+70)], fill=(*WHITE, 15), width=1)
    for i,(lbl,val,col) in enumerate([("SPENT","$1,613/$2k",ACCENT),("REMAINING","$386",WHITE),("SAVINGS","0% ⚠",WARNING)]):
        cx = x1+20 + i*col_w3 + col_w3//2
        d.text((cx, sy3+8),  lbl, font=fnt(15), fill=FAINT,  anchor='mt')
        d.text((cx, sy3+36), val, font=fnt(22, bold=True), fill=col, anchor='mt')

    # Budget bar + pace
    _bar(d, x1+20, sy3+82, cw-40, 0.81, ACCENT, h=7)
    d.text((x1+20, sy3+100), "⚠  $161/day · Projected $4,840 · 20d left", font=fnt(20), fill=WARNING)
    y += 254

    # ── AI insight strip ─────────────────────────────────────
    _card(d, x1, y, x2, y+88, accent=ELECTRIC)
    d.text((x1+20, y+14), "✦", font=fnt(26), fill=ELECTRIC)
    d.text((x1+56, y+14), "Utilities are 40% of spending", font=fnt(25), fill=WHITE)
    d.text((x1+56, y+48), "Tap to see savings tips  →", font=fnt(21), fill=MUTED)
    y += 100

    # ── Upcoming bills ───────────────────────────────────────
    _card(d, x1, y, x2, y+155)
    d.text((x1+20, y+14), "UPCOMING BILLS", font=fnt(17), fill=FAINT)
    d.text((x2-20, y+14), "-$651 due this week", font=fnt(17), fill=WARNING, anchor='ra')
    sep_y2 = y+50
    d.line([(x1+20, sep_y2), (x2-20, sep_y2)], fill=(*WHITE, 12), width=1)
    for j,(day,name,amt) in enumerate([("Thu 11","Progressive Insurance","−$246"),("Sun 14","SoFi Loan","−$405")]):
        ry = sep_y2 + 14 + j*52
        d.ellipse([x1+20, ry+10, x1+32, ry+22], fill=DANGER)
        d.text((x1+44, ry+8), day, font=fnt(16), fill=FAINT)
        d.text((x1+44, ry+26), name, font=fnt(22), fill=WHITE)
        d.text((x2-20, ry+22), amt, font=fnt(22, bold=True), fill=DANGER, anchor='ra')

# ─────────────────────────────────────────────────────────────
# HEALTH SCORE SCREEN
# ─────────────────────────────────────────────────────────────

def draw_health(img, sx1, sy1, sx2, sy2):
    d   = ImageDraw.Draw(img)
    pad = 24
    cw  = sx2 - sx1 - pad*2
    y   = sy1 + 64

    _header(d, sx1, sy1, "Insights")
    y += 76

    # ── Health score card ────────────────────────────────────
    x1, x2 = sx1+pad, sx2-pad
    _card(d, x1, y, x2, y+290, accent=ACCENT)
    d.text((x1+20, y+16), "FINANCIAL HEALTH", font=fnt(17), fill=FAINT)
    rr(d, x2-110, y+14, x2-20, y+42, 14, fill=(*ACCENT, 30))
    d.text(((x2-110+x2-20)//2, y+28), "Live", font=fnt(18, bold=True), fill=ACCENT, anchor='mm')

    # Ring
    rcx, rcy, rr_r = x1+94, y+170, 62
    d.arc([rcx-rr_r, rcy-rr_r, rcx+rr_r, rcy+rr_r], 140, 400, fill=(*FAINT, 80), width=13)
    d.arc([rcx-rr_r, rcy-rr_r, rcx+rr_r, rcy+rr_r], 140, 240, fill=DANGER, width=13)
    d.text((rcx, rcy-6), "F",  font=fnt(46, bold=True), fill=WHITE, anchor='mm')
    d.text((rcx, rcy+30), "39", font=fnt(22), fill=MUTED, anchor='mm')

    # Metrics
    mx = x1 + 186
    mw = (x2-20) - mx
    for i,(lbl,pct,col) in enumerate([("Spending",0.85,ACCENT),("Savings",0.24,SUCCESS),("Net Worth",0.15,WARNING)]):
        my = y+80 + i*70
        d.text((mx, my), lbl, font=fnt(21), fill=MUTED)
        _bar(d, mx, my+28, mw, pct, col, h=6)
        val = "✓" if pct > 0.7 else str(int(pct*100))
        d.text((x2-20, my+24), val, font=fnt(21, bold=True), fill=col, anchor='ra')

    # Tip
    tp = y+254
    d.line([(x1+20, tp), (x2-20, tp)], fill=(*WHITE, 12), width=1)
    d.text((x1+20, tp+12), "💡 Save at least 10% of income to improve score", font=fnt(20), fill=MUTED)
    y += 304

    # ── Grade ladder ─────────────────────────────────────────
    _card(d, x1, y, x2, y+110)
    d.text((x1+20, y+12), "YOUR PATH TO A+", font=fnt(16), fill=FAINT)
    grades = [("F",DANGER,True),("D",WARNING,False),("C",(200,160,40),False),
              ("B",(100,200,80),False),("A",SUCCESS,False),("A+",ACCENT,False)]
    gw2 = cw // len(grades)
    for i,(g,col,active) in enumerate(grades):
        gx = x1 + i*gw2
        if active:
            rr(d, gx+4, y+42, gx+gw2-4, y+96, 10, fill=(*DANGER, 35))
            rr(d, gx+4, y+42, gx+gw2-4, y+96, 10, outline=(*DANGER, 70), width=1)
        d.text((gx+gw2//2, y+69), g, font=fnt(28, bold=True),
               fill=col if active else FAINT, anchor='mm')
    y += 122

    # ── Spending card ────────────────────────────────────────
    _card(d, x1, y, x2, y+188)
    d.text((x1+20, y+14), "SPENDING · THIS MONTH", font=fnt(17), fill=FAINT)
    d.text((x1+20, y+44), "$1,613.65", font=fnt(50, bold=True), fill=WHITE)
    _bar(d, x1+20, y+112, cw-40, 0.81, ACCENT, h=7)
    d.text((x1+20, y+130), "81% of $2,000 budget", font=fnt(21), fill=MUTED)
    d.text((x1+20, y+158), "⚠  Projected: $4,840 this month", font=fnt(21), fill=WARNING)
    y += 200

    # ── Category previews ────────────────────────────────────
    cats = [("⚡","Utilities","$853",0.53,WARNING,True),
            ("🛍","Shopping","$296",0.18,ELECTRIC,False)]
    for icon,name,amt,pct,col,over in cats:
        _card(d, x1, y, x2, y+80)
        if over:
            rr(d, x1, y, x2, y+80, 20, outline=(*DANGER, 50), width=1)
        ic_bg = (*col, 40)
        rr(d, x1+14, y+16, x1+54, y+56, 10, fill=ic_bg)
        d.text((x1+34, y+36), icon, font=fnt(22), fill=WHITE, anchor='mm')
        d.text((x1+68, y+14), name, font=fnt(24), fill=WHITE)
        d.text((x2-20, y+14), amt, font=fnt(24, bold=True), fill=WHITE, anchor='ra')
        d.text((x1+68, y+46), f"{int(pct*100)}%", font=fnt(18), fill=FAINT)
        _bar(d, x1+14, y+70, cw-28, pct*0.75, col, h=5)
        y += 90

# ─────────────────────────────────────────────────────────────
# INSIGHTS / CATEGORIES SCREEN
# ─────────────────────────────────────────────────────────────

def draw_insights(img, sx1, sy1, sx2, sy2):
    d   = ImageDraw.Draw(img)
    pad = 24
    cw  = sx2 - sx1 - pad*2
    y   = sy1 + 64

    _header(d, sx1, sy1, "Insights")

    # Period selector
    periods = ["1D","1W","1M","3M","1Y"]
    ptotal  = len(periods)*58+4
    px0     = sx2 - pad - ptotal
    rr(d, px0-6, sy1+66, sx2-pad+2, sy1+108, 12, fill=(*WHITE, 8))
    for i,p in enumerate(periods):
        px = px0 + i*58
        if p == "1M":
            rr(d, px, sy1+70, px+54, sy1+104, 9, fill=(*ACCENT, 40))
            rr(d, px, sy1+70, px+54, sy1+104, 9, outline=(*ACCENT, 80), width=1)
            d.text((px+27, sy1+87), p, font=fnt(19, bold=True), fill=ACCENT, anchor='mm')
        else:
            d.text((px+27, sy1+87), p, font=fnt(19), fill=FAINT, anchor='mm')
    y += 76

    x1, x2 = sx1+pad, sx2-pad

    # ── Spending hero card ───────────────────────────────────
    _card(d, x1, y, x2, y+220, accent=ACCENT)
    d.text((x1+20, y+14), "SPENDING · THIS MONTH", font=fnt(17), fill=FAINT)
    bx = x2-20-200
    rr(d, bx, y+12, x2-20, y+40, 14, fill=(*SUCCESS, 35))
    d.text(((bx+x2-20)//2, y+26), "−49% vs last mo", font=fnt(17), fill=SUCCESS, anchor='mm')
    d.text((x1+20, y+46), "$1,613.65", font=fnt(54, bold=True), fill=WHITE)

    # Stats cols
    col3 = cw // 3
    st3  = y+112
    d.line([(x1+20,st3),(x2-20,st3)], fill=(*WHITE,14), width=1)
    d.line([(x1+20,st3+66),(x2-20,st3+66)], fill=(*WHITE,14), width=1)
    for i,(lbl,val,col) in enumerate([("SPENT","$1,613/$2k",ACCENT),("REMAINING","$386",WHITE),("SAVINGS","0% ⚠",WARNING)]):
        cx = x1+20+i*col3+col3//2
        d.text((cx,st3+6),  lbl, font=fnt(15), fill=FAINT, anchor='mt')
        d.text((cx,st3+32), val, font=fnt(21,bold=True), fill=col, anchor='mt')
    _bar(d, x1+20, st3+78, cw-40, 0.81, ACCENT, h=7)
    d.text((x1+20, st3+96), "⚠  $161/day · Projected: $4,840 · 20d left", font=fnt(19), fill=WARNING)
    y += 234

    # ── Categories header ────────────────────────────────────
    d.text((x1, y+6), "Categories", font=fnt(32, bold=True), fill=WHITE)
    d.text((x2, y+6), "this month", font=fnt(22), fill=FAINT, anchor='ra')
    y += 46

    # ── Category rows ────────────────────────────────────────
    cats5 = [
        ("⚡","Utilities",    "$853.29",0.53,WARNING, True),
        ("🛍","Shopping",     "$295.52",0.18,ELECTRIC,False),
        ("🍔","Food & Drink", "$211.91",0.13,(255,107,53),False),
        ("🔧","Services",     "$156.29",0.10,(107,63,220),False),
        ("🎭","Entertainment","$96.64", 0.06,(255,165,80),False),
    ]
    for icon,name,amt,pct,col,over in cats5:
        _card(d, x1, y, x2, y+80)
        if over:
            rr(d, x1, y, x2, y+80, 20, outline=(*DANGER,50), width=1)
        rr(d, x1+12, y+14, x1+52, y+54, 10, fill=(*col, 38))
        d.text((x1+32, y+34), icon, font=fnt(22), fill=WHITE, anchor='mm')
        d.text((x1+62, y+12), name, font=fnt(24), fill=WHITE)
        d.text((x2-20, y+12), amt, font=fnt(24,bold=True), fill=WHITE, anchor='ra')
        d.text((x1+62, y+44), f"{int(pct*100)}%", font=fnt(17), fill=FAINT)
        badge_w = 110
        rr(d, x2-20-badge_w, y+42, x2-20, y+66, 10, fill=(*ACCENT, 25))
        d.text((x2-20-badge_w//2, y+54), "+ Budget", font=fnt(17), fill=ACCENT, anchor='mm')
        _bar(d, x1+12, y+73, cw-24, pct*0.72, col, h=5)
        y += 88

# ─────────────────────────────────────────────────────────────
# CASH FLOW / BILLS SCREEN
# ─────────────────────────────────────────────────────────────

def draw_bills(img, sx1, sy1, sx2, sy2):
    d   = ImageDraw.Draw(img)
    pad = 24
    cw  = sx2 - sx1 - pad*2
    y   = sy1 + 64

    _header(d, sx1, sy1, "Insights")
    y += 76
    x1, x2 = sx1+pad, sx2-pad

    # ── Net worth trend ──────────────────────────────────────
    _card(d, x1, y, x2, y+168)
    d.text((x1+20, y+14), "NET WORTH TREND", font=fnt(17), fill=FAINT)
    d.text((x1+20, y+42), "-$56,565.06", font=fnt(44, bold=True), fill=WHITE)
    rr(d, x2-160, y+12, x2-20, y+42, 15, fill=(*DANGER, 30))
    d.text(((x2-160+x2-20)//2, y+27), "−$393.14", font=fnt(19, bold=True), fill=DANGER, anchor='mm')
    # Sparkline
    pts = [0.82,0.77,0.73,0.69,0.65,0.61,0.57,0.53,0.50]
    sw, sh = cw-40, 50
    sy_ = y+100
    for i in range(len(pts)-1):
        px1_ = x1+20 + int(sw*i/(len(pts)-1))
        px2_ = x1+20 + int(sw*(i+1)/(len(pts)-1))
        py1_ = sy_ + int(sh*pts[i])
        py2_ = sy_ + int(sh*pts[i+1])
        d.line([(px1_,py1_),(px2_,py2_)], fill=DANGER, width=3)
    last_x = x1+20+sw
    last_y = sy_ + int(sh*pts[-1])
    d.ellipse([last_x-5, last_y-5, last_x+5, last_y+5], fill=DANGER)
    d.text((x1+20, y+156), "6-day history · 7 data points", font=fnt(17), fill=FAINT)
    y += 180

    # ── Cash flow card ───────────────────────────────────────
    _card(d, x1, y, x2, y+380)
    rr(d, x1, y, x2, y+380, 20, outline=(*WARNING, 55), width=1)
    d.text((x1+20, y+14), "CASH FLOW", font=fnt(17), fill=FAINT)
    d.text((x1+20, y+42), "Next 7 Days", font=fnt(38, bold=True), fill=WHITE)
    rr(d, x2-220, y+38, x2-20, y+72, 17, fill=(*WARNING, 30))
    rr(d, x2-220, y+38, x2-20, y+72, 17, outline=(*WARNING, 60), width=1)
    d.text(((x2-220+x2-20)//2, y+55), "−$651.00 due", font=fnt(21,bold=True), fill=WARNING, anchor='mm')

    sep_y = y+86
    d.line([(x1+20,sep_y),(x2-20,sep_y)], fill=(*WHITE,14), width=1)

    bills_data = [("Thu","11","Progressive Insurance","−$246.00"),
                  ("Sun","14","SoFi Loan","−$405.00")]
    by = sep_y + 16
    for day,date,name,amt in bills_data:
        d.text((x1+20, by),    day,  font=fnt(17), fill=FAINT)
        d.text((x1+20, by+20), date, font=fnt(34, bold=True), fill=WHITE)
        d.ellipse([x1+76, by+26, x1+90, by+40], fill=DANGER)
        d.text((x1+104, by+22), name, font=fnt(25), fill=MUTED)
        d.text((x2-20,  by+22), amt,  font=fnt(25, bold=True), fill=DANGER, anchor='ra')
        by += 78
        d.line([(x1+20,by),(x2-20,by)], fill=(*WHITE,8), width=1)
        by += 8

    d.text((W//2, y+314), "Next 7 days · 3 bills pending", font=fnt(21), fill=FAINT, anchor='mt')
    y += 392

    # ── Top Merchants ────────────────────────────────────────
    _card(d, x1, y, x2, y+264)
    d.text((x1+20, y+14), "WHERE YOU SPEND", font=fnt(17), fill=FAINT)
    d.text((x1+20, y+42), "Top Merchants", font=fnt(34, bold=True), fill=WHITE)
    d.text((x2-20, y+42), "this month", font=fnt(21), fill=FAINT, anchor='ra')

    merchants = [("Ysi Grandview Apts","$853.29",1.0,ACCENT),
                 ("Anthropic","$130.00",0.15,ELECTRIC),
                 ("Casey's","$115.01",0.135,(255,107,53)),
                 ("Top Golf Bay","$82.74",0.097,(240,93,251))]
    my = y+88
    mw = cw-40
    for mname,mamt,mpct,mcol in merchants:
        d.text((x1+20, my), mname, font=fnt(22), fill=WHITE)
        d.text((x2-20, my), mamt,  font=fnt(22,bold=True), fill=WHITE, anchor='ra')
        _bar(d, x1+20, my+28, mw, mpct, mcol, h=5)
        my += 52

    # ── Sub hunter teaser ────────────────────────────────────
    y += 276
    _card(d, x1, y, x2, y+110)
    rr(d, x1+12, y+14, x1+54, y+56, 10, fill=(*DANGER, 30))
    d.text((x1+33, y+35), "🔍", font=fnt(22), fill=WHITE, anchor='mm')
    d.text((x1+68, y+14), "Subscriptions", font=fnt(28, bold=True), fill=WHITE)
    rr(d, x1+68+180, y+12, x1+68+220, y+36, 12, fill=(*DANGER, 60))
    d.text((x1+68+200, y+24), "1", font=fnt(18,bold=True), fill=WHITE, anchor='mm')
    d.text((x1+68, y+48), "Amazon Prime Video · ~$5.34/mo", font=fnt(21), fill=MUTED)

# ─────────────────────────────────────────────────────────────
# FREE TRIAL SCREEN (features + small phone)
# ─────────────────────────────────────────────────────────────

def draw_trial_phone(img, sx1, sy1, sx2, sy2):
    d   = ImageDraw.Draw(img)
    pad = 22
    cw  = sx2 - sx1 - pad*2
    y   = sy1 + 56

    d.text((sx1+pad, y), "FlowCheck Pro", font=fnt(32, bold=True), fill=WHITE)
    y += 50

    x1, x2 = sx1+pad, sx2-pad
    features_mini = [
        ("✦","Financial Health Score","Know your 0–100 rating"),
        ("✦","Unlimited Accounts",    "Connect every bank"),
        ("✦","AI Spending Insights",  "Know your patterns"),
        ("✦","Bill Protection",       "Never miss a payment"),
        ("✦","Net Worth Tracking",    "Full wealth picture"),
    ]
    for icon,title,sub in features_mini:
        _card(d, x1, y, x2, y+72)
        d.text((x1+14, y+14), icon, font=fnt(22), fill=ACCENT)
        d.text((x1+46, y+10), title, font=fnt(24,bold=True), fill=WHITE)
        d.text((x1+46, y+40), sub,   font=fnt(19), fill=MUTED)
        y += 80

# ─────────────────────────────────────────────────────────────
# THE 5 SCREENSHOTS
# ─────────────────────────────────────────────────────────────

def screenshot_1():
    """Hero — Know your money, for real."""
    img = Image.new('RGB', (W, H), BG)
    img = glow(img, W//2, H//2-200, ACCENT, 700, 0.15)

    d = ImageDraw.Draw(img)

    # Headline
    d.text((W//2,  88), "Know your",   font=fnt(112, bold=True), fill=WHITE,  anchor='mt')
    d.text((W//2, 210), "money.",       font=fnt(112, bold=True), fill=ACCENT, anchor='mt')
    d.text((W//2, 354), "For real.",    font=fnt(72),             fill=MUTED,  anchor='mt')

    # Phone
    img, sx1, sy1, sx2, sy2 = _phone_and_ui(img, draw_home, cx=W//2, top=490, ph=1560)
    d = ImageDraw.Draw(img)

    # Bottom feature pills
    pills = [("🏦","Real-time sync"),("🧠","AI insights"),("🔒","Bank-grade security")]
    pw, ph2 = 330, 68
    total = len(pills)*(pw+14)-14
    px0 = (W-total)//2
    py  = 2170
    for i,(ico,txt) in enumerate(pills):
        px = px0 + i*(pw+14)
        rr(d, px, py, px+pw, py+ph2, 34, fill=(*ACCENT, 22))
        rr(d, px, py, px+pw, py+ph2, 34, outline=(*ACCENT, 50), width=1)
        d.text((px+pw//2, py+ph2//2), f"{ico}  {txt}", font=fnt(28), fill=WHITE, anchor='mm')

    gradient_btn(img, (W-580)//2, 2280, (W+580)//2, 2370, 46,
                 "START FREE TRIAL  →", fsize=38)
    d = ImageDraw.Draw(img)
    d.text((W//2, 2384), "No credit card required", font=fnt(32), fill=FAINT, anchor='mt')

    # "vs" note
    d.text((W//2, 2700), "FlowCheck is not a bank. Not financial advice.",
           font=fnt(25), fill=FAINT, anchor='mt')

    img.save(f"{OUT}/01_hero.png")
    print("✓ 01_hero.png")


def screenshot_2():
    """Financial Health Score."""
    img = Image.new('RGB', (W, H), BG)
    img = glow(img, W//2, H//2-150, ACCENT, 680, 0.14)

    d = ImageDraw.Draw(img)
    d.text((W//2,  88), "Your financial",  font=fnt(92, bold=True), fill=WHITE,  anchor='mt')
    d.text((W//2, 196), "health score.",   font=fnt(92, bold=True), fill=ACCENT, anchor='mt')
    d.text((W//2, 320), "One number. Total clarity.",  font=fnt(54), fill=MUTED, anchor='mt')

    img, sx1, sy1, sx2, sy2 = _phone_and_ui(img, draw_health, cx=W//2, top=420, ph=1600)
    d = ImageDraw.Draw(img)

    d.text((W//2, 2120), "See where you stand.", font=fnt(44,bold=True), fill=WHITE, anchor='mt')
    d.text((W//2, 2176), "Know exactly what to fix.",  font=fnt(40), fill=MUTED, anchor='mt')

    gradient_btn(img, (W-620)//2, 2260, (W+620)//2, 2354, 46, "TRY FREE FOR 7 DAYS  →", fsize=38)
    d = ImageDraw.Draw(img)
    d.text((W//2, 2368), "No credit card required", font=fnt(32), fill=FAINT, anchor='mt')
    d.text((W//2, 2700), "FlowCheck is not a bank. Not financial advice.",
           font=fnt(25), fill=FAINT, anchor='mt')

    img.save(f"{OUT}/02_health_score.png")
    print("✓ 02_health_score.png")


def screenshot_3():
    """Spending categories — See where it all goes."""
    img = Image.new('RGB', (W, H), BG)
    img = glow(img, W//2, H//2-100, ELECTRIC, 640, 0.13)

    d = ImageDraw.Draw(img)
    d.text((W//2,  88), "See where",    font=fnt(102, bold=True), fill=WHITE,  anchor='mt')
    d.text((W//2, 204), "it all goes.", font=fnt(102, bold=True), fill=ACCENT, anchor='mt')
    d.text((W//2, 334), "Every dollar. Every category.",  font=fnt(54), fill=MUTED, anchor='mt')

    img, sx1, sy1, sx2, sy2 = _phone_and_ui(img, draw_insights, cx=W//2, top=432, ph=1620)
    d = ImageDraw.Draw(img)

    d.text((W//2, 2152), "Know your patterns", font=fnt(44,bold=True), fill=WHITE, anchor='mt')
    d.text((W//2, 2208), "before they cost you.",  font=fnt(40), fill=MUTED, anchor='mt')

    gradient_btn(img, (W-620)//2, 2294, (W+620)//2, 2388, 46, "TRY FREE FOR 7 DAYS  →", fsize=38)
    d = ImageDraw.Draw(img)
    d.text((W//2, 2402), "No credit card required", font=fnt(32), fill=FAINT, anchor='mt')
    d.text((W//2, 2700), "FlowCheck is not a bank. Not financial advice.",
           font=fnt(25), fill=FAINT, anchor='mt')

    img.save(f"{OUT}/03_categories.png")
    print("✓ 03_categories.png")


def screenshot_4():
    """Cash Flow + Bills."""
    img = Image.new('RGB', (W, H), BG)
    img = glow(img, W//2, H//2-100, WARNING, 600, 0.11)

    d = ImageDraw.Draw(img)
    d.text((W//2,  88), "No more",        font=fnt(110, bold=True), fill=WHITE,  anchor='mt')
    d.text((W//2, 208), "surprise bills.", font=fnt(110, bold=True), fill=ACCENT, anchor='mt')
    d.text((W//2, 344), "Know what hits before it does.", font=fnt(52), fill=MUTED, anchor='mt')

    img, sx1, sy1, sx2, sy2 = _phone_and_ui(img, draw_bills, cx=W//2, top=444, ph=1600)
    d = ImageDraw.Draw(img)

    d.text((W//2, 2148), "Never get caught off guard.",  font=fnt(44,bold=True), fill=WHITE, anchor='mt')
    d.text((W//2, 2204), "Always know what's coming.",   font=fnt(40), fill=MUTED, anchor='mt')

    gradient_btn(img, (W-620)//2, 2290, (W+620)//2, 2384, 46, "TRY FREE FOR 7 DAYS  →", fsize=38)
    d = ImageDraw.Draw(img)
    d.text((W//2, 2398), "No credit card required", font=fnt(32), fill=FAINT, anchor='mt')
    d.text((W//2, 2700), "FlowCheck is not a bank. Not financial advice.",
           font=fnt(25), fill=FAINT, anchor='mt')

    img.save(f"{OUT}/04_bills.png")
    print("✓ 04_bills.png")


def screenshot_5():
    """Free trial CTA."""
    img = Image.new('RGB', (W, H), BG)
    img = glow(img, W//2, 900, ACCENT, 750, 0.16)
    img = glow(img, W//2, 1800, ELECTRIC, 500, 0.10)

    # Top gradient bar
    g_img = Image.new('RGB', (W, 7), BG)
    for xi in range(W):
        t  = xi/max(W-1,1)
        rc = int(ACCENT[0]*(1-t)+ELECTRIC[0]*t)
        gc = int(ACCENT[1]*(1-t)+ELECTRIC[1]*t)
        bc = int(ACCENT[2]*(1-t)+ELECTRIC[2]*t)
        ImageDraw.Draw(g_img).rectangle([xi,0,xi+1,7], fill=(rc,gc,bc))
    img.paste(g_img, (0,0))

    d = ImageDraw.Draw(img)
    d.text((W//2,  30), "Start free.",    font=fnt(110, bold=True), fill=WHITE,  anchor='mt')
    d.text((W//2, 152), "Stay because",   font=fnt(90),             fill=MUTED,  anchor='mt')
    d.text((W//2, 260), "it works.",      font=fnt(110, bold=True), fill=ACCENT, anchor='mt')

    # Feature card
    fc_x1, fc_y1, fc_x2, fc_y2 = 90, 406, W-90, 1180
    _card(d, fc_x1, fc_y1, fc_x2, fc_y2, r=32)
    rr(d, fc_x1, fc_y1, fc_x2, fc_y2, 32, outline=(*ACCENT, 50), width=1)

    d.text((W//2, fc_y1+28), "Everything in Pro",      font=fnt(44, bold=True), fill=WHITE, anchor='mt')
    d.text((W//2, fc_y1+82), "7-day free trial included", font=fnt(32), fill=MUTED, anchor='mt')
    d.line([(fc_x1+60, fc_y1+128), (fc_x2-60, fc_y1+128)], fill=(*WHITE,16), width=1)

    features = [
        ("✦","Financial Health Score","Your unique 0–100 financial rating"),
        ("✦","Unlimited Bank Accounts","Connect Chase, SoFi, and more"),
        ("✦","AI Spending Insights",   "Patterns you'd miss on your own"),
        ("✦","Bill Protection",        "Know what's due before it hits"),
        ("✦","Net Worth Dashboard",    "Assets, liabilities, one view"),
        ("✦","Budget Calendar",        "Month-by-month spending history"),
    ]
    fy = fc_y1 + 148
    for icon,title,sub in features:
        d.text((fc_x1+50, fy+4),  icon,  font=fnt(24),           fill=ACCENT)
        d.text((fc_x1+90, fy),    title, font=fnt(28,bold=True),  fill=WHITE)
        d.text((fc_x1+90, fy+36), sub,   font=fnt(22),            fill=MUTED)
        fy += 90

    # Big CTA
    gradient_btn(img, 90, 1218, W-90, 1316, 50, "START 7-DAY FREE TRIAL", fsize=42)
    d = ImageDraw.Draw(img)
    d.text((W//2, 1330), "Cancel anytime · No credit card required",
           font=fnt(32), fill=FAINT, anchor='mt')

    # Pricing block
    pr_y1, pr_y2 = 1410, 1568
    _card(d, 90, pr_y1, W-90, pr_y2, r=24)
    d.text((W//2, pr_y1+18), "Then just", font=fnt(28), fill=FAINT, anchor='mt')
    d.text((W//2, pr_y1+56), "$4.99/month",  font=fnt(52, bold=True), fill=WHITE, anchor='mt')
    d.text((W//2, pr_y1+118), "or $39.99/year — save 33%", font=fnt(30), fill=MUTED, anchor='mt')

    # Small phone
    img, sx1, sy1, sx2, sy2 = _phone_and_ui(img, draw_trial_phone, cx=W//2, top=1610, ph=960)
    d = ImageDraw.Draw(img)

    d.text((W//2, 2700), "FlowCheck is not a bank. Not financial advice.",
           font=fnt(25), fill=FAINT, anchor='mt')

    img.save(f"{OUT}/05_free_trial.png")
    print("✓ 05_free_trial.png")


# ─────────────────────────────────────────────────────────────
# PHONE HELPER (returns updated img + screen coords)
# ─────────────────────────────────────────────────────────────

def _phone_and_ui(img, ui_fn, cx=W//2, top=490, ph=1560):
    pw   = 730
    x1, y1 = cx-pw//2, top
    x2, y2 = cx+pw//2, top+ph

    # Shadow
    shd = Image.new('RGBA', (W, H), (0,0,0,0))
    sd  = ImageDraw.Draw(shd)
    for i in range(32, 0, -2):
        sd.rounded_rectangle([x1-i, y1-i//2, x2+i, y2+i*2],
                             radius=66+i, fill=(0,0,0, 8))
    img = Image.alpha_composite(img.convert('RGBA'),
              shd.filter(ImageFilter.GaussianBlur(16))).convert('RGB')

    d = ImageDraw.Draw(img)
    rr(d, x1, y1, x2, y2, 64, fill=(7, 16, 28), outline=(38, 65, 95), width=1)
    sx1, sy1_ = x1+18, y1+18
    sx2, sy2_ = x2-18, y2-18
    rr(d, sx1, sy1_, sx2, sy2_, 50, fill=(8, 18, 32))
    di_w, di_h = 130, 30
    rr(d, cx-di_w//2, sy1_+14, cx+di_w//2, sy1_+44, 15, fill=(3,8,16))

    # Clip UI to screen area using mask
    ui_img = img.copy()
    ui_fn(ui_img, sx1, sy1_, sx2, sy2_)
    mask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([sx1, sy1_, sx2, sy2_], radius=50, fill=255)
    img.paste(ui_img, mask=mask)

    return img, sx1, sy1_, sx2, sy2_


if __name__ == "__main__":
    print("Generating FlowCheck App Store screenshots…\n")
    screenshot_1()
    screenshot_2()
    screenshot_3()
    screenshot_4()
    screenshot_5()
    print(f"\n✓ Done — 5 screenshots in {OUT}/")
    print("  Dimensions: 1290 × 2796 px (iPhone 6.7\" App Store)")
