# -*- coding: utf-8 -*-
"""Associate each read H= label with its enclosing zone.

1. Rasterize each Limit view at SCALE px/mm; black lines = walls.
2. Connected-component label the free space ONCE per view.
3. For each H label, sample component ids at the centre + 8 ring points
   around the label bbox; majority vote picks the zone component
   (avoids seeding inside glyph counters like the hole of an 'O').
4. Trace each used component's contour -> polygon in DXF mm.

Outputs: zones.json + renders/zones_<view>.png QA overlay.
"""
import sys, io, json, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np
import ezdxf
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
from skimage import measure
from skimage.morphology import binary_dilation
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, '..', 'samples', 'ux3607_nvl_mb_dxf_20260625.dxf')

VIEWS = {
    'TOP_LIMIT': (40, 445, 345, 610),
    'BOT_LIMIT': (445, 445, 800, 610),
}
SCALE = 14  # px per mm

labels = [l for l in json.load(open(os.path.join(HERE, 'hlabel_values.json'), encoding='utf-8'))
          if l['value'] is not None]

doc = ezdxf.readfile(PATH)
msp = doc.modelspace()
cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
ctx = RenderContext(doc)

def rasterize(bb):
    x0, y0, x1, y1 = bb
    w, h = x1 - x0, y1 - y0
    dpi = 100
    fig = plt.figure(figsize=(w * SCALE / dpi, h * SCALE / dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white'); fig.patch.set_facecolor('white')
    Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect('equal'); ax.axis('off')
    fig.canvas.draw()
    buf = np.asarray(fig.canvas.buffer_rgba())[:, :, :3]
    walls = buf.mean(axis=2) < 128
    plt.close(fig)
    return walls

zones = []
for view, bb in VIEWS.items():
    vlabels = [l for l in labels if l['view'] == view]
    if not vlabels:
        continue
    print(f'{view}: rasterizing at {SCALE}px/mm...', file=sys.stderr)
    walls = rasterize(bb)
    walls = binary_dilation(walls, footprint=np.ones((3, 3)))
    comp = measure.label(~walls, connectivity=1)
    comp_area = np.bincount(comp.ravel())
    H, W = comp.shape
    x0v, y0v, x1v, y1v = bb

    def comp_at(x, y):
        c = int(round((x - x0v) * SCALE)); r = int(round(H - 1 - (y - y0v) * SCALE))
        if 0 <= r < H and 0 <= c < W:
            return comp[r, c]
        return 0

    border = comp[0, :].tolist() + comp[-1, :].tolist() + comp[:, 0].tolist() + comp[:, -1].tolist()
    outside = Counter(c for c in border if c).most_common(1)
    outside_id = outside[0][0] if outside else -1

    used = {}
    for l in vlabels:
        cx, cy = l['cx'], l['cy']
        mx = (l['x1'] - l['x0']) / 2 + 1.0
        my = (l['y1'] - l['y0']) / 2 + 1.0
        ring = ((-1,0),(1,0),(0,-1),(0,1),(-1,-1),(1,-1),(-1,1),(1,1))
        # tiered sampling: the space between/around the glyphs is almost
        # always the label's own zone; the outer ring may spill into a
        # neighbouring zone, so it is only a fallback.
        tiers = [
            [(cx, cy)],                                            # centre
            [(cx + dx*mx*0.5, cy + dy*my*0.5) for dx, dy in ring], # inner ring
            [(cx + dx*mx, cy + dy*my) for dx, dy in ring],         # outer ring
        ]
        zone_id = None
        for pts in tiers:
            votes = Counter()
            for x, y in pts:
                cid = comp_at(x, y)
                if cid and cid != outside_id and comp_area[cid] >= 3 * SCALE * SCALE:
                    votes[cid] += 1   # ignore slivers < 3 mm^2
            if votes:
                best = max(votes.values())
                zone_id = min((cid for cid, cnt in votes.items() if cnt == best),
                              key=lambda cid: comp_area[cid])
                break
        rec = {'view': view, 'value': l['value'], 'label_index': l['index'],
               'label_xy': [cx, cy]}
        if zone_id is None:
            rec['error'] = 'no zone (all outside)'
        else:
            rec['zone_id'] = int(zone_id)
            used.setdefault(zone_id, []).append(rec)
        zones.append(rec)

    # polygons + overlay
    overlay = np.stack([np.where(walls, 60, 255)] * 3, axis=2).astype(np.uint8)
    rng = np.random.default_rng(11)
    polys = {}
    for zid, recs in used.items():
        mask = comp == zid
        area_mm2 = float(mask.sum()) / SCALE / SCALE
        padded = np.pad(mask, 1)
        cs = measure.find_contours(padded.astype(float), 0.5)
        cs.sort(key=len, reverse=True)
        poly = []
        if cs:
            cont = measure.approximate_polygon(cs[0], tolerance=1.2) - 1
            for r, c in cont:
                poly.append([round(x0v + c / SCALE, 2), round(y0v + (H - 1 - r) / SCALE, 2)])
        color = rng.integers(80, 240, 3)
        overlay[mask] = color
        for rec in recs:
            rec['area_mm2'] = round(area_mm2, 1)
            rec['polygon_pts'] = len(poly)
        polys[zid] = poly
    for rec in zones:
        if rec.get('view') == view and 'zone_id' in rec:
            rec['polygon'] = polys.get(rec['zone_id'], [])
    plt.imsave(os.path.join(HERE, 'renders', f'zones_{view}.png'), overlay)

    # conflicts: one zone, multiple distinct values
    for zid, recs in used.items():
        vals = sorted({r['value'] for r in recs})
        if len(vals) > 1:
            for r in recs:
                r['conflict_values'] = vals

out = os.path.join(HERE, 'zones.json')
json.dump(zones, open(out, 'w', encoding='utf-8'), indent=1)
ok = [z for z in zones if 'zone_id' in z]
conf = [z for z in ok if 'conflict_values' in z]
huge = [z for z in ok if z.get('area_mm2', 0) > 15000]
print(f'{len(ok)}/{len(zones)} labels associated -> {out}', file=sys.stderr)
print(f'conflicts: {len(conf)} labels, leaked(>15000mm2): {len(huge)}', file=sys.stderr)
for z in zones:
    if 'error' in z:
        print('  ERR', z['view'], z['value'], z['label_xy'], z['error'], file=sys.stderr)
for z in huge:
    print('  HUGE', z['view'], z['value'], z['label_xy'], z['area_mm2'], file=sys.stderr)
