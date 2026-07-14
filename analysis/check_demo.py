# -*- coding: utf-8 -*-
"""PROTOTYPE end-to-end height check (demo quality, for Dennis to evaluate).

Steps:
 1. Load world-coordinate component bboxes (stp_components.csv from stp_extract.py).
 2. Select the main-board cluster, split top/bottom side, compute per-side height.
 3. Register STP -> DXF Limit view by translation voting (DXF circle centres vs
    component bbox centres; BOT view is x-mirrored).
 4. Rebuild the zone raster (same recipe as zone_extract.py), associate the read
    H labels to components, then look up each component's zone and compare
    height vs allowed H.
 5. Emit check_results.json + overlay renders/check_<view>.png
    (red = over limit, orange = in H=0 zone, green = OK, gray = no zone/placeholder).
"""
import sys, io, json, os, csv, math
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np
import ezdxf
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
from skimage import measure
from skimage.morphology import binary_dilation
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DXF = os.path.join(HERE, '..', 'samples', 'ux3607_nvl_mb_dxf_20260625.dxf')
VIEWS = {'TOP_LIMIT': (40, 445, 345, 610), 'BOT_LIMIT': (445, 445, 800, 610)}
SCALE = 14
BOARD_TOP_Z = 0.0
BOARD_BOT_Z = -0.776224
PLACEHOLDER = 3.81
TOL = 0.05  # mm grace

# ---------- 1. components (world bbox from stp_extract.py CSV) ----------
comps = []
board_bb = None
with open(os.path.join(HERE, 'stp_components.csv'), newline='', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        try:
            c = {'name': row['inst'], 'footprint': row['part'],
                 'x0': float(row['x0']), 'y0': float(row['y0']), 'z0': float(row['z0']),
                 'x1': float(row['x1']), 'y1': float(row['y1']), 'z1': float(row['z1'])}
        except (ValueError, TypeError, KeyError):
            continue
        if c['name'] == 'BOARD_OUTLINE':
            board_bb = c; continue
        comps.append(c)
print(f'components loaded: {len(comps)}; board={board_bb!r}', file=sys.stderr)

def wx0(c): return c['x0']
def wx1(c): return c['x1']
def wy0(c): return c['y0']
def wy1(c): return c['y1']

# main-board cluster: overlaps the BOARD_OUTLINE xy bbox (with 5mm slack)
BX0, BY0, BX1, BY1 = board_bb['x0']-5, board_bb['y0']-5, board_bb['x1']+5, board_bb['y1']+5
mb = [c for c in comps
      if wx1(c) > BX0 and wx0(c) < BX1 and wy1(c) > BY0 and wy0(c) < BY1]
print(f'MB cluster: {len(mb)}', file=sys.stderr)

for c in mb:
    z0, z1 = c['z0'], c['z1']
    if z0 >= BOARD_BOT_Z/2:           # sits on/above top surface
        c['side'] = 'top';    c['h'] = z1 - BOARD_TOP_Z
    else:
        c['side'] = 'bottom'; c['h'] = BOARD_BOT_Z - z0
    c['cx'] = (wx0(c)+wx1(c))/2; c['cy'] = (wy0(c)+wy1(c))/2
    c['is_placeholder'] = abs((z1-z0) - PLACEHOLDER) < 0.005

# ---------- Dennis's rulings 2026-07-12 ----------
# d1: a zone carrying two H labels uses the LOWER value (min-on-conflict).
# d2: the two "IR SENSOR" boxes are themselves H=0.85 zones (surroundings H=1).
# d3: boundary-straddling labels -> min-on-conflict keeps the strip at H=0.5.
# d4: the H=0 at (75.71,552.79) applies ONLY inside its circle, not the strip.
# d5: board-edge open keep-out at BOT (669,467) is outside the board -> drop.
EXPLICIT_ZONES = [  # tightest enclosure wins over the raster zone lookup
    {'view': 'TOP_LIMIT', 'shape': 'rect',   'x0': 82.9,  'y0': 532.4, 'x1': 87.1,  'y1': 536.7, 'value': 0.85},
    {'view': 'TOP_LIMIT', 'shape': 'rect',   'x0': 262.1, 'y0': 527.6, 'x1': 266.3, 'y1': 531.7, 'value': 0.85},
    {'view': 'TOP_LIMIT', 'shape': 'circle', 'cx': 74.48, 'cy': 549.82, 'r': 3.8,   'value': 0},
]
def skip_label(l):
    if l['value'] == 0.85:                                   # d2: boxes handled explicitly
        return True
    if abs(l['cx']-75.71) < 0.5 and abs(l['cy']-552.79) < 0.5:  # d4: circle handled explicitly
        return True
    if abs(l['cx']-669.06) < 0.5 and abs(l['cy']-467.17) < 0.5: # d5: off-board keep-out
        return True
    return False

# ---------- 2. DXF raster + zones ----------
labels = [l for l in json.load(open(os.path.join(HERE, 'hlabel_values.json'), encoding='utf-8'))
          if l['value'] is not None and not skip_label(l)]
doc = ezdxf.readfile(DXF)
msp = doc.modelspace()
cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
ctx = RenderContext(doc)

def rasterize(bb, scale):
    x0, y0, x1, y1 = bb
    dpi = 100
    fig = plt.figure(figsize=((x1-x0)*scale/dpi, (y1-y0)*scale/dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white')
    Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect('equal'); ax.axis('off')
    fig.canvas.draw()
    walls = np.asarray(fig.canvas.buffer_rgba())[:, :, :3].mean(axis=2) < 128
    plt.close(fig)
    return walls

circles = {v: [] for v in VIEWS}
for e in msp:
    if e.dxftype() == 'CIRCLE':
        cx, cy = e.dxf.center.x, e.dxf.center.y
        for v, bb in VIEWS.items():
            if bb[0] <= cx <= bb[2] and bb[1] <= cy <= bb[3]:
                circles[v].append((cx, cy)); break

results = []
for view, bb in VIEWS.items():
    side = 'top' if view == 'TOP_LIMIT' else 'bottom'
    mirror = view == 'BOT_LIMIT'
    vcomps = [c for c in mb if c['side'] == side]

    # --- registration: board-corner initial guess + constrained fine vote.
    # DXF board bbox (from board_bbox.json, raster-derived; some edges carry
    # attached graphics) gives a coarse window; circle-vs-component voting
    # inside that window pins the exact translation.
    dbb = json.load(open(os.path.join(HERE, 'board_bbox.json'), encoding='utf-8'))[view]
    if mirror:
        cand_tx = [dbb[0] + board_bb['x1'], dbb[2] + board_bb['x0']]
    else:
        cand_tx = [dbb[0] - board_bb['x0'], dbb[2] - board_bb['x1']]
    cand_ty = [dbb[1] - board_bb['y0'], dbb[3] - board_bb['y1']]
    wx = (min(cand_tx) - 3, max(cand_tx) + 3)
    wy = (min(cand_ty) - 3, max(cand_ty) + 3)
    dxs, dys = [], []
    for (ccx, ccy) in circles[view]:
        for c in vcomps:
            ex = -c['cx'] if mirror else c['cx']
            dx = ccx - ex; dy = ccy - c['cy']
            if wx[0] <= dx <= wx[1] and wy[0] <= dy <= wy[1]:
                dxs.append(dx); dys.append(dy)
    Hv = Counter((round(dx*2)/2, round(dy*2)/2) for dx, dy in zip(dxs, dys))
    (px, py), votes = Hv.most_common(1)[0]
    fine = [(dx, dy) for dx, dy in zip(dxs, dys) if abs(dx-px) <= 1.0 and abs(dy-py) <= 1.0]
    tx = float(np.median([f[0] for f in fine])); ty = float(np.median([f[1] for f in fine]))
    print(f'{view}: window x{wx} y{wy} -> T=({tx:.2f},{ty:.2f}) votes={votes}/{len(fine)}', file=sys.stderr)

    # --- zones
    walls = rasterize(bb, SCALE)
    walls = binary_dilation(walls, footprint=np.ones((3, 3)))
    comp_img = measure.label(~walls, connectivity=1)
    comp_area = np.bincount(comp_img.ravel())
    Hpx, Wpx = comp_img.shape
    x0v, y0v = bb[0], bb[1]
    border = Counter(list(comp_img[0, :]) + list(comp_img[-1, :]) +
                     list(comp_img[:, 0]) + list(comp_img[:, -1]))
    outside_id = border.most_common(1)[0][0]

    def comp_at(x, y):
        cpx = int(round((x - x0v) * SCALE)); rpx = int(round(Hpx - 1 - (y - y0v) * SCALE))
        if 0 <= rpx < Hpx and 0 <= cpx < Wpx:
            return comp_img[rpx, cpx]
        return 0

    ring = ((-1,0),(1,0),(0,-1),(0,1),(-1,-1),(1,-1),(-1,1),(1,1))
    zone_val = {}       # comp id -> allowed H (min on conflict)
    zone_conflict = set()
    for l in labels:
        if l['view'] != view: continue
        cx, cy = l['cx'], l['cy']
        mx = (l['x1']-l['x0'])/2 + 1.0; my = (l['y1']-l['y0'])/2 + 1.0
        tiers = [[(cx, cy)],
                 [(cx+dx*mx*0.5, cy+dy*my*0.5) for dx, dy in ring],
                 [(cx+dx*mx, cy+dy*my) for dx, dy in ring]]
        zid = None
        for pts in tiers:
            votes2 = Counter()
            for x, y in pts:
                cid = comp_at(x, y)
                if cid and cid != outside_id and comp_area[cid] >= 3*SCALE*SCALE:
                    votes2[cid] += 1
            if votes2:
                bestn = max(votes2.values())
                zid = min((cid for cid, n in votes2.items() if n == bestn),
                          key=lambda cid: comp_area[cid])
                break
        if zid is None: continue
        if zid in zone_val and zone_val[zid] != l['value']:
            zone_conflict.add(zid)
            zone_val[zid] = min(zone_val[zid], l['value'])
        else:
            zone_val[zid] = l['value']

    # --- per-component check
    for c in vcomps:
        ex0, ex1 = ((-wx1(c), -wx0(c)) if mirror else (wx0(c), wx1(c)))
        gx0, gx1 = ex0 + tx, ex1 + tx
        gy0, gy1 = wy0(c) + ty, wy1(c) + ty
        gcx, gcy = (gx0+gx1)/2, (gy0+gy1)/2
        zid = comp_at(gcx, gcy)
        if not zid or zid == outside_id:
            # try 4 quadrant points before giving up
            for qx, qy in ((gx0+1, gy0+1), (gx1-1, gy0+1), (gx0+1, gy1-1), (gx1-1, gy1-1)):
                zid = comp_at(qx, qy)
                if zid and zid != outside_id: break
        allowed = zone_val.get(zid)
        # explicit zones (Dennis d2/d4) beat the raster lookup — tightest enclosure
        for ez in EXPLICIT_ZONES:
            if ez['view'] != view: continue
            if ez['shape'] == 'rect':
                hit = ez['x0'] <= gcx <= ez['x1'] and ez['y0'] <= gcy <= ez['y1']
            else:
                hit = math.hypot(gcx-ez['cx'], gcy-ez['cy']) <= ez['r']
            if hit:
                allowed = ez['value']; break
        status = 'no_zone'
        if c['is_placeholder']:
            status = 'placeholder'
        elif allowed is not None:
            if allowed == 0:
                status = 'keepout'
            elif c['h'] > allowed + TOL:
                status = 'violation'
            else:
                status = 'ok'
        results.append({
            'view': view, 'id': c.get('name'), 'footprint': c.get('footprint'),
            'h': round(c['h'], 3), 'allowed': allowed, 'status': status,
            'dxf_box': [round(gx0,2), round(gy0,2), round(gx1,2), round(gy1,2)],
            'conflict_zone': bool(zid in zone_conflict),
        })

    # --- overlay
    dpi = 100; oscale = 12
    fig = plt.figure(figsize=((bb[2]-bb[0])*oscale/dpi, (bb[3]-bb[1])*oscale/dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white')
    Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
    COLORS = {'violation': ('#d62728', 0.85), 'keepout': ('#ff9900', 0.65),
              'ok': ('#2ca02c', 0.35), 'no_zone': ('#888888', 0.25),
              'placeholder': ('#1f77b4', 0.2)}
    for r in results:
        if r['view'] != view: continue
        gx0, gy0, gx1, gy1 = r['dxf_box']
        col, alpha = COLORS[r['status']]
        ax.add_patch(Rectangle((gx0, gy0), gx1-gx0, gy1-gy0,
                               facecolor=col, edgecolor=col, alpha=alpha, linewidth=0.4))
    ax.set_xlim(bb[0], bb[2]); ax.set_ylim(bb[1], bb[3]); ax.set_aspect('equal'); ax.axis('off')
    fig.savefig(os.path.join(HERE, 'renders', f'check_{view}.png'), dpi=dpi, facecolor='white')
    plt.close(fig)

json.dump(results, open(os.path.join(HERE, 'check_results.json'), 'w', encoding='utf-8'), indent=1)
cnt = Counter(r['status'] for r in results)
print('status counts:', dict(cnt), file=sys.stderr)
viol = [r for r in results if r['status'] == 'violation']
viol.sort(key=lambda r: -(r['h'] - (r['allowed'] or 0)))
for r in viol[:20]:
    print(f"  VIOL {r['view']} {r['id']} ({r['footprint']}) h={r['h']} > H={r['allowed']}", file=sys.stderr)
