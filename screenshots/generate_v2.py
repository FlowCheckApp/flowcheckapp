#!/usr/bin/env python3
"""
FlowCheck App Store Screenshots v2 — Cinematic Fintech
6 screenshots · 1290×2796 · iPhone 6.7"
Left-aligned editorial layout · Georgia Bold Italic emphasis · Deep dark premium
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os, math

OUT = "/Users/brandon/FlowCheck-clean/screenshots"
os.makedirs(OUT, exist_ok=True)

W, H = 1290, 2796

# ── Brand palette ────────────────────────────────────────────
BG       = (5, 11, 20)
CARD     = (11, 22, 40)
CARD2    = (8, 17, 30)
ACCENT   = (26, 196, 240)
ELEC     = (37, 99, 235)
WHITE    = (240, 246, 255)
MUTED    = (118, 152, 186)
FAINT    = (55, 88, 120)
SUCCESS  = (48, 209, 88)
DANGER   = (255, 69, 58)
WARN     = (255, 159, 10)
PURPLE   = (107, 63, 220)

# ── Typography ───────────────────────────────────────────────
SF      = "/System/Library/Fonts/SFNS.ttf"
SF_B    = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
GEO_BI  = "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf"
GEO_I   = "/System/Library/Fonts/Supplemental/Georgia Italic.ttf"

def sf(sz, bold=False):
    return ImageFont.truetype(SF_B if bold else SF, sz)

def geo_i(sz):
    return ImageFont.truetype(GEO_BI, sz)

# ── Layout ───────────────────────────────────────────────────
ML       = 82          # left margin
PH_CX    = W // 2      # phone center x
PH_W     = 668         # phone width
PH_H     = 1640        # phone height
PH_TOP   = 700         # phone top edge y

# ── Primitives ───────────────────────────────────────────────

def rr(draw, x1, y1, x2, y2, r, fill=None, outline=None, width=1):
    draw.rounded_rectangle([x1,y1,x2,y2], radius=r, fill=fill, outline=outline, width=width)

def bar(draw, x1, y, w, pct, color, h=7):
    rr(draw, x1, y, x1+w, y+h, h//2, fill=(*FAINT, 45))
    if pct > 0:
        rr(draw, x1, y, x1+int(w*min(pct,1.0)), y+h, h//2, fill=color)

def glow(img, cx, cy, color, radius=700, strength=0.16):
    layer = Image.new('RGBA', (W,H), (0,0,0,0))
    d     = ImageDraw.Draw(layer)
    r,g,b = color
    N = 44
    for i in range(N, 0, -1):
        rc = int(radius * i/N)
        a  = int(255 * strength * ((N-i)/N) ** 2.4)
        d.ellipse([cx-rc, cy-rc, cx+rc, cy+rc], fill=(r,g,b,a))
    return Image.alpha_composite(img.convert('RGBA'),
            layer.filter(ImageFilter.GaussianBlur(radius//5))).convert('RGB')

def grad_btn(img, x1, y1, x2, y2, text, fsize=36):
    g   = Image.new('RGB', (W,H), (0,0,0))
    gd  = ImageDraw.Draw(g)
    bw  = x2-x1
    for xi in range(bw):
        t  = xi/max(bw-1,1)
        gd.rectangle([x1+xi,y1,x1+xi+1,y2],
                     fill=(int(ACCENT[0]*(1-t)+ELEC[0]*t),
                           int(ACCENT[1]*(1-t)+ELEC[1]*t),
                           int(ACCENT[2]*(1-t)+ELEC[2]*t)))
    mask = Image.new('L',(W,H),0)
    ImageDraw.Draw(mask).rounded_rectangle([x1,y1,x2,y2], radius=48, fill=255)
    img.paste(g, mask=mask)
    ImageDraw.Draw(img).text(((x1+x2)//2,(y1+y2)//2), text,
                              font=sf(fsize,True), fill=(4,10,18), anchor='mm')

# ── Background builder ───────────────────────────────────────

def bg(g1=None, g2=None, g3=None):
    img = Image.new('RGB', (W,H), BG)
    d   = ImageDraw.Draw(img)
    for y in range(H):
        v = int(5 + (y/H)*2)
        d.line([(0,y),(W,y)], fill=(v, int(v*2.2), int(v*4)))
    for g_args in [g1,g2,g3]:
        if g_args: img = glow(img, *g_args)
    return img

# ── Phone frame ──────────────────────────────────────────────

def phone(img, ui_fn):
    px1  = PH_CX - PH_W//2
    py1  = PH_TOP
    px2  = PH_CX + PH_W//2
    py2  = PH_TOP + PH_H

    # Multi-layer shadow
    shd = Image.new('RGBA', (W,H), (0,0,0,0))
    sd  = ImageDraw.Draw(shd)
    for exp in range(56, 0, -3):
        a = int(10 * (1-exp/56)**1.4)
        sd.rounded_rectangle([px1-exp, py1-exp//2, px2+exp, py2+exp*2],
                             radius=66+exp, fill=(0,0,0,a))
    img = Image.alpha_composite(img.convert('RGBA'),
              shd.filter(ImageFilter.GaussianBlur(14))).convert('RGB')

    d = ImageDraw.Draw(img)
    # Frame body — dark titanium
    rr(d, px1,   py1,   px2,   py2,   62, fill=(6,13,23))
    rr(d, px1+1, py1+1, px2-1, py2-1, 61, outline=(44,72,105), width=1)

    # Screen
    sx1, sy1 = px1+15, py1+15
    sx2, sy2 = px2-15, py2-15
    rr(d, sx1, sy1, sx2, sy2, 50, fill=(7,16,29))

    # Dynamic Island
    diw, dih = 122, 28
    rr(d, PH_CX-diw//2, sy1+14, PH_CX+diw//2, sy1+42, 14, fill=(3,7,14))

    # Render UI onto copy then clip
    ui  = img.copy()
    ui_fn(ui, sx1, sy1, sx2, sy2)
    mask = Image.new('L', (W,H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([sx1,sy1,sx2,sy2], radius=50, fill=255)
    img.paste(ui, mask=mask)

    # Subtle screen shine (top-left triangle glare)
    shine = Image.new('RGBA', (W,H), (0,0,0,0))
    sw    = (sx2-sx1)*2//3
    sh    = (sy2-sy1)//5
    ImageDraw.Draw(shine).polygon([(sx1,sy1),(sx1+sw,sy1),(sx1,sy1+sh)],
                                   fill=(255,255,255,9))
    img = Image.alpha_composite(img.convert('RGBA'), shine).convert('RGB')

    return img, sx1, sy1, sx2, sy2

# ── Shared UI helpers ────────────────────────────────────────

def _card(d, x1,y1,x2,y2, r=20, border=None):
    rr(d, x1,y1,x2,y2, r, fill=CARD)
    if border:
        rr(d, x1,y1,x2,y2, r, outline=(*border,55), width=1)

def _nw_sparkline(d, x1, cx_end, y_top, h=44):
    pts = [0.82,0.78,0.74,0.70,0.66,0.62,0.59,0.55,0.50]
    w   = cx_end - x1
    for i in range(len(pts)-1):
        ax = x1+int(w*i/(len(pts)-1)); ay = y_top+int(h*pts[i])
        bx = x1+int(w*(i+1)/(len(pts)-1)); by = y_top+int(h*pts[i+1])
        d.line([(ax,ay),(bx,by)], fill=DANGER, width=3)
    d.ellipse([cx_end-5, y_top+int(h*pts[-1])-5,
               cx_end+5, y_top+int(h*pts[-1])+5], fill=DANGER)

def _badge(d, x1,y1,x2,y2, text, color, r=14):
    rr(d, x1,y1,x2,y2, r, fill=(*color,32))
    rr(d, x1,y1,x2,y2, r, outline=(*color,55), width=1)
    d.text(((x1+x2)//2,(y1+y2)//2), text, font=sf(17,True), fill=color, anchor='mm')

# ── App screen renderers ─────────────────────────────────────

def ui_home(img, sx1, sy1, sx2, sy2):
    d  = ImageDraw.Draw(img)
    p  = 22
    cw = sx2-sx1-p*2
    x1, x2 = sx1+p, sx2-p
    y  = sy1+64

    d.text((x1, y), "FlowCheck", font=sf(36,True), fill=WHITE)
    y += 58

    # ── Net worth ──
    _card(d, x1,y, x2,y+192, border=ACCENT)
    d.text((x1+18,y+14), "NET WORTH", font=sf(16), fill=FAINT)
    _badge(d, x2-168,y+12, x2-18,y+40, "↓ -$393", DANGER)
    d.text((x1+18,y+42), "-$56,565", font=sf(50,True), fill=WHITE)
    _nw_sparkline(d, x1+18, x2-18, y+106, 44)
    d.line([(x1+18,y+160),(x2-18,y+160)], fill=(*WHITE,12), width=1)
    d.text((x1+18,y+170), "Chase Checking", font=sf(19), fill=MUTED)
    d.text((x2-18,y+170), "$847.23", font=sf(19,True), fill=WHITE, anchor='ra')
    y += 206

    # ── Spending ──
    _card(d, x1,y, x2,y+230, border=ACCENT)
    d.text((x1+18,y+14), "SPENDING · THIS MONTH", font=sf(16), fill=FAINT)
    _badge(d, x2-202,y+12, x2-18,y+40, "−49% vs last mo", SUCCESS)
    d.text((x1+18,y+46), "$1,613.65", font=sf(50,True), fill=WHITE)
    col3 = cw//3
    sy_ = y+106
    d.line([(x1+18,sy_),(x2-18,sy_)], fill=(*WHITE,10), width=1)
    d.line([(x1+18,sy_+62),(x2-18,sy_+62)], fill=(*WHITE,10), width=1)
    for i,(l,v,c) in enumerate([("SPENT","$1,613/$2k",ACCENT),("REMAINING","$386",WHITE),("SAVINGS","0%",WARN)]):
        cx = x1+18+i*col3+col3//2
        d.text((cx,sy_+5), l, font=sf(13), fill=FAINT, anchor='mt')
        d.text((cx,sy_+27), v, font=sf(20,True), fill=c, anchor='mt')
    bar(d, x1+18,sy_+74, cw-36,0.81,ACCENT)
    d.text((x1+18,sy_+92), "⚠  $161/day · Projected $4,840 · 20d left", font=sf(17), fill=WARN)
    y += 244

    # ── AI strip ──
    _card(d, x1,y, x2,y+80, border=ELEC)
    d.text((x1+18,y+14), "✦", font=sf(22), fill=ELEC)
    d.text((x1+50,y+12), "Utilities are 40% of spending", font=sf(22), fill=WHITE)
    d.text((x1+50,y+42), "Tap to see savings opportunities →", font=sf(19), fill=MUTED)
    y += 94

    # ── Bills ──
    _card(d, x1,y, x2,y+152)
    d.text((x1+18,y+12), "UPCOMING BILLS", font=sf(15), fill=FAINT)
    d.text((x2-18,y+12), "−$651 this week", font=sf(15,True), fill=WARN, anchor='ra')
    d.line([(x1+18,y+46),(x2-18,y+46)], fill=(*WHITE,10), width=1)
    for j,(day,name,amt) in enumerate([("Thu 11","Progressive Insurance","−$246"),("Sun 14","SoFi Loan","−$405")]):
        ry = y+56+j*48
        d.ellipse([x1+18,ry+12,x1+28,ry+22], fill=DANGER)
        d.text((x1+40,ry+6), day,  font=sf(14), fill=FAINT)
        d.text((x1+40,ry+24), name, font=sf(20), fill=WHITE)
        d.text((x2-18,ry+20), amt, font=sf(20,True), fill=DANGER, anchor='ra')


def ui_health(img, sx1, sy1, sx2, sy2):
    d  = ImageDraw.Draw(img)
    p  = 22
    cw = sx2-sx1-p*2
    x1, x2 = sx1+p, sx2-p
    y  = sy1+64

    d.text((x1,y), "Insights", font=sf(36,True), fill=WHITE)
    for i,pt in enumerate(["1D","1W","1M","3M","1Y"]):
        px = x2-312+i*62
        if pt=="1M":
            rr(d, px,y+4,px+56,y+36,8, fill=(*ACCENT,38))
            d.text((px+28,y+20), pt, font=sf(17,True), fill=ACCENT, anchor='mm')
        else:
            d.text((px+28,y+20), pt, font=sf(17), fill=FAINT, anchor='mm')
    y += 60

    # ── Health card ──
    _card(d, x1,y, x2,y+286, border=ACCENT)
    d.text((x1+18,y+14), "FINANCIAL HEALTH", font=sf(16), fill=FAINT)
    _badge(d, x2-98,y+12, x2-16,y+38, "Live", ACCENT, 13)

    rcx,rcy,rrr = x1+88,y+162,60
    d.arc([rcx-rrr,rcy-rrr,rcx+rrr,rcy+rrr],138,402, fill=(*FAINT,60), width=12)
    d.arc([rcx-rrr,rcy-rrr,rcx+rrr,rcy+rrr],138,240, fill=DANGER, width=12)
    d.text((rcx,rcy-8), "F",  font=sf(42,True), fill=WHITE, anchor='mm')
    d.text((rcx,rcy+26),"39", font=sf(20),      fill=MUTED, anchor='mm')

    mx  = x1+178
    mww = (x2-18)-mx
    for i,(l,pct,c) in enumerate([("Spending",0.85,ACCENT),("Savings",0.24,SUCCESS),("Net Worth",0.15,WARN)]):
        my = y+74+i*68
        d.text((mx,my), l, font=sf(19), fill=MUTED)
        bar(d, mx,my+24, mww,pct,c,6)
        d.text((x2-18,my+20), "✓" if pct>0.7 else str(int(pct*100)), font=sf(19,True), fill=c, anchor='ra')

    tp = y+250
    d.line([(x1+18,tp),(x2-18,tp)], fill=(*WHITE,10), width=1)
    d.text((x1+18,tp+10), "💡 Saving 10% of income adds +12 pts", font=sf(18), fill=MUTED)
    y += 300

    # ── Grade ladder ──
    _card(d, x1,y, x2,y+104)
    d.text((x1+18,y+10), "YOUR PATH TO A+", font=sf(14), fill=FAINT)
    grs = [("F",DANGER,True),("D",WARN,False),("C",(185,145,28),False),
           ("B",(88,185,65),False),("A",SUCCESS,False),("A+",ACCENT,False)]
    gw2 = cw//len(grs)
    for i,(g,c,act) in enumerate(grs):
        gx = x1+i*gw2
        if act: rr(d, gx+4,y+38,gx+gw2-4,y+92,10, fill=(*DANGER,28))
        d.text((gx+gw2//2,y+65), g, font=sf(26,True), fill=c if act else FAINT, anchor='mm')
    y += 118

    # ── Spending + cats ──
    _card(d, x1,y, x2,y+178)
    d.text((x1+18,y+12), "THIS MONTH", font=sf(15), fill=FAINT)
    d.text((x1+18,y+38), "$1,613.65", font=sf(46,True), fill=WHITE)
    bar(d, x1+18,y+102, cw-36,0.81,ACCENT,7)
    d.text((x1+18,y+120), "81% of budget · Projected $4,840", font=sf(18), fill=MUTED)
    d.text((x1+18,y+148), "⚠  20 days remaining this month", font=sf(18), fill=WARN)
    y += 192

    for icon,name,amt,pct,c in [("⚡","Utilities","$853",0.53,WARN),("🛍","Shopping","$296",0.18,ELEC)]:
        _card(d, x1,y, x2,y+74)
        rr(d, x1+10,y+10,x1+50,y+50,10, fill=(*c,32))
        d.text((x1+30,y+30), icon, font=sf(20), fill=WHITE, anchor='mm')
        d.text((x1+58,y+8),  name, font=sf(21), fill=WHITE)
        d.text((x2-18,y+8),  amt,  font=sf(21,True), fill=WHITE, anchor='ra')
        bar(d, x1+10,y+66, cw-20,pct*0.72,c,5)
        y += 82


def ui_insights(img, sx1, sy1, sx2, sy2):
    d  = ImageDraw.Draw(img)
    p  = 22
    cw = sx2-sx1-p*2
    x1,x2 = sx1+p, sx2-p
    y = sy1+64

    d.text((x1,y), "Insights", font=sf(36,True), fill=WHITE)
    y += 60

    _card(d, x1,y, x2,y+218, border=ACCENT)
    d.text((x1+18,y+12), "SPENDING · THIS MONTH", font=sf(15), fill=FAINT)
    _badge(d, x2-196,y+10,x2-18,y+36,"−49% vs last mo",SUCCESS)
    d.text((x1+18,y+42), "$1,613.65", font=sf(50,True), fill=WHITE)
    col3 = cw//3
    s3 = y+104
    d.line([(x1+18,s3),(x2-18,s3)], fill=(*WHITE,10), width=1)
    d.line([(x1+18,s3+62),(x2-18,s3+62)], fill=(*WHITE,10), width=1)
    for i,(l,v,c) in enumerate([("SPENT","$1,613/$2k",ACCENT),("REMAINING","$386",WHITE),("SAVINGS","0%",WARN)]):
        cx = x1+18+i*col3+col3//2
        d.text((cx,s3+4), l, font=sf(13), fill=FAINT, anchor='mt')
        d.text((cx,s3+26), v, font=sf(20,True), fill=c, anchor='mt')
    bar(d, x1+18,s3+76, cw-36,0.81,ACCENT,6)
    d.text((x1+18,s3+94), "⚠  $161/day · Projected: $4,840 · 20d left", font=sf(17), fill=WARN)
    y += 232

    d.text((x1,y+4), "Categories", font=sf(28,True), fill=WHITE)
    d.text((x2,y+4), "this month",  font=sf(20), fill=FAINT, anchor='ra')
    y += 44

    cats = [
        ("⚡","Utilities",    "$853.29",0.53,WARN,   True),
        ("🛍","Shopping",     "$295.52",0.18,ELEC,   False),
        ("🍔","Food & Drink", "$211.91",0.13,(255,107,53),False),
        ("🔧","Services",     "$156.29",0.10,PURPLE, False),
        ("🎭","Entertainment","$96.64", 0.06,(255,165,80),False),
    ]
    for ico,name,amt,pct,c,over in cats:
        _card(d, x1,y, x2,y+76)
        if over: rr(d, x1,y, x2,y+76,20, outline=(*DANGER,40), width=1)
        rr(d, x1+10,y+10,x1+50,y+52,10, fill=(*c,32))
        d.text((x1+30,y+31), ico,  font=sf(20), fill=WHITE, anchor='mm')
        d.text((x1+58,y+8),  name, font=sf(21), fill=WHITE)
        d.text((x2-18,y+8),  amt,  font=sf(21,True), fill=WHITE, anchor='ra')
        d.text((x1+58,y+40), f"{int(pct*100)}%", font=sf(15), fill=FAINT)
        rr(d, x2-18-106,y+38,x2-18,y+62,10, fill=(*ACCENT,22))
        d.text((x2-18-53,y+50), "+ Budget", font=sf(15), fill=ACCENT, anchor='mm')
        bar(d, x1+10,y+68, cw-20,pct*0.70,c,5)
        y += 84


def ui_wealth(img, sx1, sy1, sx2, sy2):
    d  = ImageDraw.Draw(img)
    p  = 22
    cw = sx2-sx1-p*2
    x1,x2 = sx1+p, sx2-p
    y = sy1+64

    d.text((x1,y), "Wealth", font=sf(36,True), fill=WHITE)
    y += 58

    # Big NW card with chart
    _card(d, x1,y, x2,y+280, border=ACCENT)
    d.text((x1+18,y+12), "NET WORTH", font=sf(16), fill=FAINT)
    _badge(d, x2-158,y+10,x2-18,y+38,"↓ -$393.14",DANGER)
    d.text((x1+18,y+40), "-$56,565.06", font=sf(48,True), fill=WHITE)

    # Chart area with area fill
    pts  = [0.84,0.81,0.78,0.75,0.72,0.69,0.65,0.62,0.59,0.56,0.53,0.51,0.50]
    sw,sh = cw-36,96
    cy_  = y+108
    # Area under
    apts = [(x1+18,cy_+sh)]
    for i,v in enumerate(pts):
        apts.append((x1+18+int(sw*i/(len(pts)-1)), cy_+int(sh*v)))
    apts.append((x1+18+sw, cy_+sh))
    d.polygon(apts, fill=(*DANGER,18))
    # Line
    for i in range(len(pts)-1):
        ax = x1+18+int(sw*i/(len(pts)-1));     ay = cy_+int(sh*pts[i])
        bx = x1+18+int(sw*(i+1)/(len(pts)-1)); by = cy_+int(sh*pts[i+1])
        d.line([(ax,ay),(bx,by)], fill=DANGER, width=3)
    lx = x1+18+sw; ly = cy_+int(sh*pts[-1])
    d.ellipse([lx-5,ly-5,lx+5,ly+5], fill=DANGER)
    d.text((x1+18,y+218), "6-day history · 7 data points", font=sf(17), fill=FAINT)
    sep = y+246
    d.line([(x1+18,sep),(x2-18,sep)], fill=(*WHITE,10), width=1)
    d.text((x1+18,sep+10), "Chase Checking", font=sf(19), fill=MUTED)
    d.text((x2-18,sep+10), "$847.23", font=sf(19,True), fill=WHITE, anchor='ra')
    y += 294

    # Account cards
    for bank,typ,bal,c in [("Chase","CHECKING","$847.23",SUCCESS),("SoFi","LOAN","-$57,412",DANGER)]:
        _card(d, x1,y, x2,y+78)
        rr(d, x1+12,y+12,x1+54,y+54,12, fill=(*c,32))
        d.text((x1+33,y+33), bank[0], font=sf(22,True), fill=c, anchor='mm')
        d.text((x1+62,y+10), bank, font=sf(21,True), fill=WHITE)
        d.text((x1+62,y+40), typ,  font=sf(16),      fill=FAINT)
        d.text((x2-18,y+26), bal,  font=sf(22,True),  fill=c, anchor='ra')
        y += 88

    # Cash flow
    _card(d, x1,y, x2,y+96)
    d.text((x1+18,y+12), "CASH FLOW · NEXT 7 DAYS", font=sf(15), fill=FAINT)
    _badge(d, x2-212,y+10,x2-18,y+38,"−$651.00 due",WARN)
    for j,(day,name,amt) in enumerate([("Thu 11","Progressive Insurance","−$246"),("Sun 14","SoFi Loan","−$405")]):
        ry = y+46+j*36
        d.ellipse([x1+18,ry+10,x1+28,ry+20], fill=DANGER)
        d.text((x1+38,ry+6),  day,  font=sf(14), fill=FAINT)
        d.text((x1+38,ry+22), name, font=sf(19), fill=WHITE)
        d.text((x2-18,ry+18), amt,  font=sf(19,True), fill=DANGER, anchor='ra')
    y += 110

    # Top merchants
    _card(d, x1,y, x2,y+220)
    d.text((x1+18,y+12), "TOP MERCHANTS", font=sf(15), fill=FAINT)
    d.text((x2-18,y+12), "this month",    font=sf(15), fill=FAINT, anchor='ra')
    mry = y+50
    mw  = cw-36
    for mn,ma,mp,mc in [("Ysi Grandview Apts","$853",1.0,ACCENT),("Anthropic","$130",0.15,ELEC),("Casey's","$115",0.13,(255,107,53))]:
        d.text((x1+18,mry),    mn, font=sf(20),      fill=WHITE)
        d.text((x2-18,mry),    ma, font=sf(20,True), fill=WHITE, anchor='ra')
        bar(d, x1+18,mry+26,mw,mp,mc,4)
        mry += 54


def ui_security(img, sx1, sy1, sx2, sy2):
    d   = ImageDraw.Draw(img)
    p   = 22
    cw  = sx2-sx1-p*2
    x1,x2 = sx1+p, sx2-p
    cx  = (sx1+sx2)//2
    y   = sy1+62

    # Lock screen mockup
    rr(d, x1,y, x2,y+320, 24, fill=CARD2)
    rr(d, x1,y, x2,y+320, 24, outline=(*ACCENT,45), width=1)

    # App logo
    rr(d, cx-38,y+28,cx+38,y+104,18, fill=(13,28,52))
    rr(d, cx-38,y+28,cx+38,y+104,18, outline=(*ACCENT,60), width=1)
    d.text((cx,y+66), "F", font=sf(36,True), fill=ACCENT, anchor='mm')
    d.text((cx,y+118), "FlowCheck", font=sf(30,True), fill=WHITE, anchor='mt')
    d.text((cx,y+158), "Your finances are locked", font=sf(20), fill=MUTED, anchor='mt')

    # Face ID ring
    fr,fcx,fcy = 52, cx, y+256
    d.arc([fcx-fr,fcy-fr,fcx+fr,fcy+fr],0,360, fill=(*FAINT,50), width=11)
    d.arc([fcx-fr,fcy-fr,fcx+fr,fcy+fr],100,220, fill=ACCENT, width=11)
    # Face ID icon bars
    for bx,by,bw,bh in [(fcx-14,fcy-6,28,3),(fcx-14,fcy+6,28,3)]:
        rr(d, bx,by,bx+bw,by+bh,1, fill=ACCENT)
    d.text((cx,fcy+74), "Tap to unlock with Face ID", font=sf(19), fill=MUTED, anchor='mt')
    y += 340

    # Security feature list
    items = [
        ("🔐","256-bit AES encryption","All data encrypted in transit & at rest"),
        ("🛡️","Apple App Attest",       "Device integrity verified by Apple"),
        ("🔑","Biometric auth",          "Face ID + Touch ID. No passwords needed"),
        ("🤫","Zero data selling",        "Your finances never sold, ever"),
        ("🗑️","One-tap data deletion",   "CCPA compliant. Delete everything instantly"),
        ("🏦","Plaid secure linking",     "Bank-grade OAuth connections only"),
    ]
    for ico,title,sub in items:
        _card(d, x1,y, x2,y+76)
        d.text((x1+14,y+14), ico,   font=sf(24), fill=WHITE)
        d.text((x1+52,y+10), title, font=sf(21,True), fill=WHITE)
        d.text((x1+52,y+40), sub,   font=sf(17), fill=MUTED)
        y += 84


def ui_premium(img, sx1, sy1, sx2, sy2):
    d   = ImageDraw.Draw(img)
    p   = 22
    cw  = sx2-sx1-p*2
    x1,x2 = sx1+p, sx2-p
    y  = sy1+68

    # Pro badge
    _card(d, x1,y, x2,y+96, border=ACCENT)
    d.text((x1+18,y+12), "FlowCheck Pro", font=sf(28,True), fill=WHITE)
    d.text((x1+18,y+48), "Everything you need to take control", font=sf(19), fill=MUTED)
    _badge(d, x2-182,y+14,x2-18,y+46,"7 DAYS FREE",SUCCESS,15)
    y += 110

    # Feature list
    feats = [
        ("✦","Financial Health Score",  "Your 0–100 financial rating",     ACCENT),
        ("✦","Unlimited Bank Accounts", "Connect every account you own",    ELEC),
        ("✦","AI Spending Insights",    "Patterns you'd miss on your own",  ACCENT),
        ("✦","Bill Protection",         "Know every bill before it hits",   WARN),
        ("✦","Net Worth Dashboard",     "Assets + liabilities in one view", ELEC),
        ("✦","Budget Calendar",         "Your full spending history",       ACCENT),
    ]
    for ico,title,sub,c in feats:
        _card(d, x1,y, x2,y+76)
        d.text((x1+14,y+18), ico,   font=sf(20),     fill=c)
        d.text((x1+48,y+12), title, font=sf(22,True), fill=WHITE)
        d.text((x1+48,y+42), sub,   font=sf(18),      fill=MUTED)
        y += 84

    y += 10
    # CTA (draw gradient directly onto img slice)
    bh = 82
    bw = x2-x1
    for xi in range(bw):
        t  = xi/max(bw-1,1)
        d.rectangle([x1+xi,y,x1+xi+1,y+bh],
                    fill=(int(ACCENT[0]*(1-t)+ELEC[0]*t),
                          int(ACCENT[1]*(1-t)+ELEC[1]*t),
                          int(ACCENT[2]*(1-t)+ELEC[2]*t)))
    # Clip button
    mask2 = Image.new('L',(W,H),0)
    ImageDraw.Draw(mask2).rounded_rectangle([x1,y,x2,y+bh],radius=44,fill=255)
    btn_grad = img.copy()
    img.paste(btn_grad, mask=mask2)
    d2 = ImageDraw.Draw(img)
    d2.text(((x1+x2)//2,y+bh//2),"START FREE TRIAL  →",font=sf(28,True),fill=(4,10,18),anchor='mm')
    y += bh+14
    d2.text(((x1+x2)//2,y),"No credit card · Cancel anytime",font=sf(19),fill=FAINT,anchor='mt')
    y += 38

    # Pricing
    _card(d2, x1,y, x2,y+96)
    d2.text(((x1+x2)//2,y+12),"Then just", font=sf(18), fill=FAINT, anchor='mt')
    d2.text(((x1+x2)//2,y+38),"$4.99/mo or $39.99/yr", font=sf(26,True), fill=WHITE, anchor='mt')
    d2.text(((x1+x2)//2,y+74),"Save 33% with annual plan", font=sf(19), fill=MUTED, anchor='mt')

# ── Shared bottom compositing ────────────────────────────────

def compose(base_img, ui_fn,
            cat_label, h1, h2_italic,
            tagline, btn_text,
            g1=None, g2=None, g3=None):

    img = bg(g1, g2, g3)
    d   = ImageDraw.Draw(img)

    # Category label
    d.text((ML, 90), cat_label, font=sf(26,True), fill=ACCENT)

    # Headline
    d.text((ML, 152), h1,          font=sf(100,True), fill=WHITE)
    d.text((ML, 264), h2_italic,    font=geo_i(100),   fill=WHITE)

    # Tagline
    d.text((ML, 396), tagline, font=sf(44), fill=(*MUTED,195))

    # Phone
    img, sx1,sy1,sx2,sy2 = phone(img, ui_fn)
    d = ImageDraw.Draw(img)

    # Bottom chips
    chip_labels = []
    if   "home"     in ui_fn.__name__: chip_labels=[("🏦","Real-time sync"),("🧠","AI insights"),("🔒","Bank-grade")]
    elif "health"   in ui_fn.__name__: chip_labels=[("📊","Live scoring"),("🎯","Clear targets"),("🚀","Improve score")]
    elif "insights" in ui_fn.__name__: chip_labels=[("📈","Trends"),("💰","Budgets"),("⚠️","Alerts")]
    elif "wealth"   in ui_fn.__name__: chip_labels=[("💎","Net worth"),("📅","Bill calendar"),("🏦","All accounts")]
    elif "security" in ui_fn.__name__: chip_labels=[("🔐","Encrypted"),("🛡️","App Attest"),("🗑️","CCPA")]
    elif "premium"  in ui_fn.__name__: chip_labels=[("🆓","7-day trial"),("💳","No card needed"),("❌","Cancel free")]

    if chip_labels:
        chip_h  = 62
        chip_y  = H - 218
        chip_w  = (W - 160 - 20) // 3
        for i,(ico,txt) in enumerate(chip_labels):
            cx = 80 + i*(chip_w+10)
            rr(d, cx, chip_y, cx+chip_w, chip_y+chip_h, 31, fill=(*WHITE,8))
            rr(d, cx, chip_y, cx+chip_w, chip_y+chip_h, 31, outline=(*WHITE,20), width=1)
            d.text((cx+chip_w//2, chip_y+chip_h//2), f"{ico}  {txt}",
                   font=sf(25), fill=(*WHITE,155), anchor='mm')

    # CTA button
    grad_btn(img, (W-560)//2, H-130, (W+560)//2, H-50, btn_text, 36)

    return img

# ── 6 SCREENSHOTS ────────────────────────────────────────────

def run():
    specs = [
        ("v2_01_hero",
         ui_home, "FINANCIAL CLARITY",
         "Your money.", "Finally clear.",
         "See every dollar. In real time.",
         "START FREE TRIAL  →",
         (W//2, H//2-200, ACCENT, 740, 0.15),
         (180, 460, ELEC, 380, 0.07), None),

        ("v2_02_health",
         ui_health, "FINANCIAL HEALTH SCORE",
         "Know exactly", "where you stand.",
         "Your 0–100 financial health rating.",
         "TRY FREE FOR 7 DAYS  →",
         (W//2, H//2-150, ACCENT, 720, 0.15), None, None),

        ("v2_03_insights",
         ui_insights, "SPENDING INSIGHTS",
         "See where", "every dollar goes.",
         "Category breakdowns that make sense.",
         "TRY FREE FOR 7 DAYS  →",
         (W//2, H//2-100, ELEC, 680, 0.13),
         (W-80, 380, ACCENT, 300, 0.07), None),

        ("v2_04_wealth",
         ui_wealth, "WEALTH TRACKING",
         "Track your wealth.", "Watch it grow.",
         "Net worth + bills + merchants in one view.",
         "TRY FREE FOR 7 DAYS  →",
         (W//2, H//2-100, WARN, 660, 0.10),
         (W//2, 420, ACCENT, 400, 0.07), None),

        ("v2_05_security",
         ui_security, "PRIVACY & SECURITY",
         "Your money.", "Your eyes only.",
         "Bank-grade encryption. Zero data selling.",
         "TRY FREE FOR 7 DAYS  →",
         (W//2, H//2-200, ELEC, 680, 0.14), None, None),

        ("v2_06_premium",
         ui_premium, "GO PRO",
         "Start free.", "Stay forever.",
         "7-day trial. No credit card. Cancel anytime.",
         "START FREE TRIAL  →",
         (W//2, 1000, ACCENT, 760, 0.16),
         (W//2, 1900, ELEC, 500, 0.10), None),
    ]

    for name, ui_fn, cat, h1, h2, tag, btn, g1, g2, g3 in specs:
        print(f"  rendering {name}…", end=" ", flush=True)
        img = compose(None, ui_fn, cat, h1, h2, tag, btn, g1, g2, g3)
        # Top gradient stripe for premium feel
        top = Image.new('RGB',(W,6),BG)
        for xi in range(W):
            t = xi/max(W-1,1)
            ImageDraw.Draw(top).rectangle([xi,0,xi+1,6],
                fill=(int(ACCENT[0]*(1-t)+ELEC[0]*t),
                      int(ACCENT[1]*(1-t)+ELEC[1]*t),
                      int(ACCENT[2]*(1-t)+ELEC[2]*t)))
        img.paste(top, (0,0))
        # FlowCheck watermark + disclaimer
        d = ImageDraw.Draw(img)
        d.text((W//2, H-28), "FlowCheck is not a bank · Not financial advice",
               font=sf(23), fill=(*FAINT,140), anchor='mt')
        path = f"{OUT}/{name}.png"
        img.save(path, optimize=True)
        print(f"✓")

    print(f"\n✓ 6 screenshots → {OUT}/")

if __name__ == "__main__":
    print("\nFlowCheck App Store Screenshots v2\n" + "─"*42)
    run()
