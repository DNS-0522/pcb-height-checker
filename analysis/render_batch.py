# -*- coding: utf-8 -*-
"""Load DXF once, render many crops. Reads jobs from a file:
each line: name x0 y0 x1 y1 pxwidth
"""
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy

PATH = r"F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf"
jobs_file = sys.argv[1]
doc = ezdxf.readfile(PATH); msp = doc.modelspace()
cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
ctx = RenderContext(doc)

with open(jobs_file, encoding='utf-8') as f:
    jobs=[l.split() for l in f if l.strip() and not l.startswith('#')]

for j in jobs:
    name=j[0]; x0,y0,x1,y1=map(float,j[1:5]); pxw=int(j[5])
    flipx = len(j)>=7 and j[6]=='1'
    w=x1-x0; h=y1-y0; pxh=max(40,int(pxw*h/w)); dpi=100
    fig=plt.figure(figsize=(pxw/dpi,pxh/dpi),dpi=dpi)
    ax=fig.add_axes([0,0,1,1]); ax.set_facecolor('white'); fig.patch.set_facecolor('white')
    backend=MatplotlibBackend(ax)
    Frontend(ctx,backend,config=cfg).draw_layout(msp,finalize=False)
    if flipx: ax.set_xlim(x1,x0)
    else: ax.set_xlim(x0,x1)
    ax.set_ylim(y0,y1); ax.set_aspect('equal'); ax.axis('off')
    fig.savefig(name,dpi=dpi,facecolor='white'); plt.close(fig)
    print(f"saved {name} {pxw}x{pxh}")
print("ALL DONE")
