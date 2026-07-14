# -*- coding: utf-8 -*-
"""Cluster stroked glyphs on *_DXF_TEXT layers into text strings.

Each glyph is one POLYLINE/LINE/SOLID on a `*DXF_TEXT` layer (~2-3mm wide,
5mm tall). Glyphs sharing a baseline and separated by small x-gaps form one
string. Outputs clusters as JSON (bbox in DXF coords) and renders one PNG
crop per cluster for visual reading of the value.

Usage:  py text_cluster.py [--render OUTDIR]
"""
import sys, io, json, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import ezdxf

PATH = os.path.join(os.path.dirname(__file__), '..', 'samples', 'ux3607_nvl_mb_dxf_20260625.dxf')

doc = ezdxf.readfile(PATH)
msp = doc.modelspace()

# ---- collect glyph bboxes from *_DXF_TEXT layers -------------------------
def entity_bbox(e):
    t = e.dxftype()
    if t == 'LINE':
        xs = [e.dxf.start.x, e.dxf.end.x]; ys = [e.dxf.start.y, e.dxf.end.y]
    elif t == 'POLYLINE':
        pts = list(e.points())
        if not pts: return None
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    elif t == 'SOLID':
        pts = [e.dxf.vtx0, e.dxf.vtx1, e.dxf.vtx2, e.dxf.vtx3]
        xs = [p.x for p in pts]; ys = [p.y for p in pts]
    else:
        return None
    return (min(xs), min(ys), max(xs), max(ys))

glyphs = []
for e in msp:
    if 'DXF_TEXT' not in e.dxf.layer.upper() and not e.dxf.layer.upper().endswith('_TEXT'):
        continue
    bb = entity_bbox(e)
    if bb:
        glyphs.append({'bb': bb, 'layer': e.dxf.layer})

print(f'glyph entities: {len(glyphs)}', file=sys.stderr)

# ---- cluster: union-find on proximity ------------------------------------
# Two glyph bboxes belong to the same string when their y-ranges overlap
# (shared line) and the x gap is < XGAP mm.
XGAP = 3.5

parent = list(range(len(glyphs)))
def find(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]; i = parent[i]
    return i
def union(i, j):
    parent[find(i)] = find(j)

# sort by x for locality
order = sorted(range(len(glyphs)), key=lambda i: glyphs[i]['bb'][0])
for a in range(len(order)):
    i = order[a]
    x0i, y0i, x1i, y1i = glyphs[i]['bb']
    for b in range(a + 1, len(order)):
        j = order[b]
        x0j, y0j, x1j, y1j = glyphs[j]['bb']
        if x0j - x1i > XGAP:
            break
        # y overlap (allow small slack for sub/superscript strokes)
        if min(y1i, y1j) - max(y0i, y0j) > -1.0:
            union(i, j)

clusters = {}
for i, g in enumerate(glyphs):
    clusters.setdefault(find(i), []).append(g)

strings = []
for members in clusters.values():
    x0 = min(m['bb'][0] for m in members); y0 = min(m['bb'][1] for m in members)
    x1 = max(m['bb'][2] for m in members); y1 = max(m['bb'][3] for m in members)
    strings.append({
        'x0': round(x0, 2), 'y0': round(y0, 2), 'x1': round(x1, 2), 'y1': round(y1, 2),
        'cx': round((x0 + x1) / 2, 2), 'cy': round((y0 + y1) / 2, 2),
        'nglyphs': len(members),
        'layers': sorted({m['layer'] for m in members}),
    })
strings.sort(key=lambda s: (-s['y0'], s['x0']))

# tag which board view each string falls in (from prior segmentation)
VIEWS = {
    'TOP_CONN':  (35, 620, 345, 800),
    'BOT_CONN':  (445, 620, 800, 800),
    'TOP_LIMIT': (40, 445, 345, 605),
    'BOT_LIMIT': (445, 445, 800, 605),
    'TOP_PAD':   (35, 260, 345, 440),
    'BOT_PAD':   (445, 260, 800, 440),
    'TOP_WHITE': (35, 100, 345, 245),
    'BOT_WHITE': (445, 100, 800, 245),
}
for s in strings:
    s['view'] = next((v for v, bb in VIEWS.items()
                      if bb[0] <= s['cx'] <= bb[2] and bb[1] <= s['cy'] <= bb[3]), None)

out = os.path.join(os.path.dirname(__file__), 'text_clusters.json')
with open(out, 'w', encoding='utf-8') as f:
    json.dump(strings, f, indent=1)
print(f'{len(strings)} clusters -> {out}', file=sys.stderr)

from collections import Counter
print('per view:', dict(Counter(s['view'] or 'other' for s in strings)), file=sys.stderr)

# ---- optional: render each cluster crop ----------------------------------
if '--render' in sys.argv:
    outdir = sys.argv[sys.argv.index('--render') + 1]
    os.makedirs(outdir, exist_ok=True)
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy

    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
    ctx = RenderContext(doc)
    MARGIN = 1.5   # mm around the string
    SCALE = 30     # px per mm

    todo = [(i, s) for i, s in enumerate(strings) if s['view'] in ('TOP_LIMIT', 'BOT_LIMIT')]
    for i, s in todo:
        x0, y0, x1, y1 = s['x0'] - MARGIN, s['y0'] - MARGIN, s['x1'] + MARGIN, s['y1'] + MARGIN
        w, h = x1 - x0, y1 - y0
        dpi = 100
        fig = plt.figure(figsize=(w * SCALE / dpi, h * SCALE / dpi), dpi=dpi)
        ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white'); fig.patch.set_facecolor('white')
        backend = MatplotlibBackend(ax)
        Frontend(ctx, backend, config=cfg).draw_layout(msp, finalize=False)
        ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect('equal'); ax.axis('off')
        name = f"c{i:03d}_{s['view']}_{s['cx']}_{s['cy']}.png"
        fig.savefig(os.path.join(outdir, name), dpi=dpi, facecolor='white')
        plt.close(fig)
        print('saved', name, file=sys.stderr)
    print(f'rendered {len(todo)} Limit-view crops', file=sys.stderr)
