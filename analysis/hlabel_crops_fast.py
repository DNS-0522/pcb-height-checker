# -*- coding: utf-8 -*-
"""Fast crop rendering: rasterize each Limit view ONCE at high dpi, then cut
label crops out of the big raster with numpy. Also builds indexed contact
sheets (4x5 grid) for batch visual reading.

Usage: py hlabel_crops_fast.py
Outputs: renders/hlabels_fast/hNNN_<view>.png + renders/sheets/sheetNN.png
"""
import sys, io, json, os, math
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np
import ezdxf
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy

HERE = os.path.dirname(os.path.abspath(__file__))
PATH = os.path.join(HERE, '..', 'samples', 'ux3607_nvl_mb_dxf_20260625.dxf')

VIEWS = {
    'TOP_LIMIT': (40, 445, 345, 610),
    'BOT_LIMIT': (445, 445, 800, 610),
}
SCALE = 25   # px per mm on the master raster
MARGIN = 1.0 # mm around each label crop

labels = json.load(open(os.path.join(HERE, 'hlabel_candidates.json'), encoding='utf-8'))

doc = ezdxf.readfile(PATH)
msp = doc.modelspace()
cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
ctx = RenderContext(doc)

outdir = os.path.join(HERE, 'renders', 'hlabels_fast')
os.makedirs(outdir, exist_ok=True)

def rasterize(bb):
    x0, y0, x1, y1 = bb
    w, h = x1 - x0, y1 - y0
    dpi = 100
    fig = plt.figure(figsize=(w * SCALE / dpi, h * SCALE / dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white'); fig.patch.set_facecolor('white')
    Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect('equal'); ax.axis('off')
    fig.canvas.draw()
    buf = np.asarray(fig.canvas.buffer_rgba())[:, :, :3].copy()
    plt.close(fig)
    return buf

crops = []
for view, bb in VIEWS.items():
    idxs = [i for i, l in enumerate(labels) if l['view'] == view]
    if not idxs:
        continue
    print(f'{view}: rasterizing master...', file=sys.stderr)
    img = rasterize(bb)
    H, W = img.shape[:2]
    x0v, y0v, x1v, y1v = bb
    for i in idxs:
        l = labels[i]
        cx0 = int((l['x0'] - MARGIN - x0v) * SCALE); cx1 = int((l['x1'] + MARGIN - x0v) * SCALE)
        cy1 = int(H - (l['y0'] - MARGIN - y0v) * SCALE); cy0 = int(H - (l['y1'] + MARGIN - y0v) * SCALE)
        cx0 = max(0, cx0); cy0 = max(0, cy0); cx1 = min(W, cx1); cy1 = min(H, cy1)
        crop = img[cy0:cy1, cx0:cx1]
        name = f'h{i:03d}_{view}.png'
        plt.imsave(os.path.join(outdir, name), crop)
        crops.append(name)
print(f'{len(crops)} crops -> {outdir}', file=sys.stderr)

# ---- contact sheets -------------------------------------------------------
sheetdir = os.path.join(HERE, 'renders', 'sheets')
os.makedirs(sheetdir, exist_ok=True)
import matplotlib.image as mpimg
files = sorted(crops)
per_sheet, cols = 20, 4
rows = math.ceil(per_sheet / cols)
for si in range(0, len(files), per_sheet):
    batch = files[si:si + per_sheet]
    fig, axes = plt.subplots(rows, cols, figsize=(16, 3.0 * rows), dpi=100)
    for ax in np.asarray(axes).flat:
        ax.axis('off')
    for ax, fname in zip(np.asarray(axes).flat, batch):
        im = mpimg.imread(os.path.join(outdir, fname))
        ax.imshow(im)
        ax.set_title(fname.split('_')[0], fontsize=13, color='red')
        ax.axis('on'); ax.set_xticks([]); ax.set_yticks([])
    name = os.path.join(sheetdir, f'sheet{si // per_sheet:02d}.png')
    fig.tight_layout(); fig.savefig(name, facecolor='white'); plt.close(fig)
    print('saved', name, len(batch), file=sys.stderr)
