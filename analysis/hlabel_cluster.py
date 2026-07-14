# -*- coding: utf-8 -*-
"""Find stroked H= labels inside the Limit views.

Labels are stroked text: dense clusters of SHORT line/arc segments on the
outline layers. Zone outlines use long segments, so clustering short
segments by proximity isolates label candidates. Renders one crop per
candidate for visual value reading.

Usage: py hlabel_cluster.py [--render OUTDIR]
"""
import sys, io, json, os, math
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import ezdxf

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, '..', 'samples', 'ux3607_nvl_mb_dxf_20260625.dxf')

VIEWS = {
    'TOP_LIMIT': (40, 445, 345, 610),
    'BOT_LIMIT': (445, 445, 800, 610),
}

MAX_SEG = 4.0    # mm — glyph strokes are short
GAP = 1.2        # mm — cluster joining distance
MIN_SEGS = 5     # a real label has many strokes
MAX_DIM = 30.0   # mm — label bbox upper bound
MIN_DIM = 0.8    # mm

doc = ezdxf.readfile(PATH)
msp = doc.modelspace()

def seg_info(e):
    t = e.dxftype()
    if t == 'LINE':
        x0, y0 = e.dxf.start.x, e.dxf.start.y
        x1, y1 = e.dxf.end.x, e.dxf.end.y
        return (min(x0,x1), min(y0,y1), max(x0,x1), max(y0,y1)), math.hypot(x1-x0, y1-y0)
    if t == 'ARC':
        r = e.dxf.radius
        cx, cy = e.dxf.center.x, e.dxf.center.y
        a0, a1 = math.radians(e.dxf.start_angle), math.radians(e.dxf.end_angle)
        sweep = (a1 - a0) % (2*math.pi)
        return (cx-r, cy-r, cx+r, cy+r), r*sweep
    return None, None

segs = {v: [] for v in VIEWS}
for e in msp:
    if 'DXF_TEXT' in e.dxf.layer.upper():
        continue  # view titles handled separately
    bb, length = seg_info(e)
    if bb is None or length is None or length > MAX_SEG or length == 0:
        continue
    cx, cy = (bb[0]+bb[2])/2, (bb[1]+bb[3])/2
    for v, vb in VIEWS.items():
        if vb[0] <= cx <= vb[2] and vb[1] <= cy <= vb[3]:
            segs[v].append(bb)
            break

def bb_gap(a, b):
    dx = max(0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(dx, dy)

labels = []
for v, items in segs.items():
    print(f'{v}: {len(items)} short segments', file=sys.stderr)
    n = len(items)
    parent = list(range(n))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    order = sorted(range(n), key=lambda i: items[i][0])
    for a in range(n):
        i = order[a]
        for b in range(a+1, n):
            j = order[b]
            if items[j][0] - items[i][2] > GAP:
                break
            if bb_gap(items[i], items[j]) <= GAP:
                parent[find(i)] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(items[i])
    for g in groups.values():
        if len(g) < MIN_SEGS:
            continue
        x0 = min(b[0] for b in g); y0 = min(b[1] for b in g)
        x1 = max(b[2] for b in g); y1 = max(b[3] for b in g)
        w, h = x1-x0, y1-y0
        if not (MIN_DIM <= w <= MAX_DIM and MIN_DIM <= h <= MAX_DIM):
            continue
        labels.append({'view': v, 'x0': round(x0,2), 'y0': round(y0,2),
                       'x1': round(x1,2), 'y1': round(y1,2),
                       'cx': round((x0+x1)/2,2), 'cy': round((y0+y1)/2,2),
                       'w': round(w,2), 'h': round(h,2), 'nsegs': len(g)})

labels.sort(key=lambda s: (s['view'], -s['cy'], s['cx']))
out = os.path.join(HERE, 'hlabel_candidates.json')
json.dump(labels, open(out, 'w', encoding='utf-8'), indent=1)
from collections import Counter
print(f'{len(labels)} label candidates -> {out}', file=sys.stderr)
print('per view:', dict(Counter(l["view"] for l in labels)), file=sys.stderr)

if '--render' in sys.argv:
    outdir = os.path.join(HERE, sys.argv[sys.argv.index('--render')+1])
    os.makedirs(outdir, exist_ok=True)
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
    ctx = RenderContext(doc)
    MARGIN = 0.8
    for i, s in enumerate(labels):
        x0, y0, x1, y1 = s['x0']-MARGIN, s['y0']-MARGIN, s['x1']+MARGIN, s['y1']+MARGIN
        w, h = x1-x0, y1-y0
        scale = min(60, 400/max(w, h))   # px per mm, cap image ~400px on long side minimum readable
        scale = max(scale, 20)
        dpi = 100
        fig = plt.figure(figsize=(w*scale/dpi, h*scale/dpi), dpi=dpi)
        ax = fig.add_axes([0,0,1,1]); ax.set_facecolor('white'); fig.patch.set_facecolor('white')
        Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
        ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect('equal'); ax.axis('off')
        name = f"h{i:03d}_{s['view']}.png"
        fig.savefig(os.path.join(outdir, name), dpi=dpi, facecolor='white')
        plt.close(fig)
    print(f'rendered {len(labels)} crops -> {outdir}', file=sys.stderr)
