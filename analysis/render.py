# -*- coding: utf-8 -*-
"""Render a DXF (or a sub-region of it) to PNG.
Usage:
  py render.py OUT.png PXWIDTH [xmin ymin xmax ymax]
If bbox omitted -> full $EXTMIN/$EXTMAX.
"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration

PATH = r"F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf"

out = sys.argv[1]
pxw = int(sys.argv[2])
if len(sys.argv) >= 7:
    xmin, ymin, xmax, ymax = map(float, sys.argv[3:7])
else:
    xmin, ymin, xmax, ymax = 0.0, 0.0, 1189.0, 841.0

doc = ezdxf.readfile(PATH)
msp = doc.modelspace()

w = xmax - xmin
h = ymax - ymin
aspect = h / w
pxh = int(pxw * aspect)

dpi = 100
fig = plt.figure(figsize=(pxw / dpi, pxh / dpi), dpi=dpi)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_facecolor('white')
fig.patch.set_facecolor('white')

try:
    cfg = Configuration(background_policy=__import__('ezdxf.addons.drawing.config', fromlist=['BackgroundPolicy']).BackgroundPolicy.WHITE,
                        color_policy=__import__('ezdxf.addons.drawing.config', fromlist=['ColorPolicy']).ColorPolicy.BLACK)
except Exception as e:
    print("cfg fallback:", e)
    cfg = Configuration()

ctx = RenderContext(doc)
backend = MatplotlibBackend(ax)
Frontend(ctx, backend, config=cfg).draw_layout(msp, finalize=False)

ax.set_xlim(xmin, xmax)
ax.set_ylim(ymin, ymax)
ax.set_aspect('equal')
ax.axis('off')
fig.savefig(out, dpi=dpi, facecolor='white')
print(f"saved {out}  {pxw}x{pxh}px  bbox=({xmin},{ymin})-({xmax},{ymax})")
