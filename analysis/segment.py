# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import ezdxf, numpy as np

PATH = r"F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf"
doc = ezdxf.readfile(PATH)
msp = doc.modelspace()

pts = []
for e in msp:
    t = e.dxftype()
    try:
        if t == 'LINE':
            pts.append((e.dxf.start.x, e.dxf.start.y))
            pts.append((e.dxf.end.x, e.dxf.end.y))
        elif t == 'CIRCLE':
            pts.append((e.dxf.center.x, e.dxf.center.y))
        elif t == 'ARC':
            pts.append((e.dxf.center.x, e.dxf.center.y))
        elif t in ('POLYLINE',):
            for v in e.vertices:
                pts.append((v.dxf.location.x, v.dxf.location.y))
        elif t == 'LWPOLYLINE':
            for x, y, *_ in e.get_points():
                pts.append((x, y))
        elif t == 'ELLIPSE':
            pts.append((e.dxf.center.x, e.dxf.center.y))
    except Exception:
        pass

P = np.array(pts)
print("points:", len(P), "x:", P[:,0].min(), P[:,0].max(), "y:", P[:,1].min(), P[:,1].max())

def gaps(vals, lo, hi, binw=2.0, min_gap=12.0):
    # occupancy histogram -> find empty runs (gaps) wider than min_gap
    nb = int((hi-lo)/binw)+1
    occ = np.zeros(nb, bool)
    idx = ((vals-lo)/binw).astype(int)
    idx = np.clip(idx,0,nb-1)
    occ[idx] = True
    # find runs of empty
    segs = []   # occupied segments [start,end]
    i=0
    while i<nb:
        if occ[i]:
            j=i
            while j<nb and occ[j]: j+=1
            segs.append([lo+i*binw, lo+j*binw])
            i=j
        else:
            i+=1
    # merge occupied segments separated by gap < min_gap
    merged=[segs[0]]
    for s in segs[1:]:
        if s[0]-merged[-1][1] < min_gap:
            merged[-1][1]=s[1]
        else:
            merged.append(s)
    return merged

xs = gaps(P[:,0], P[:,0].min(), P[:,0].max(), 2.0, 18.0)
ys = gaps(P[:,1], P[:,1].min(), P[:,1].max(), 2.0, 18.0)
print("\nX bands (columns):")
for a,b in xs: print(f"  {a:8.1f} .. {b:8.1f}   (w={b-a:.1f})")
print("\nY bands (rows):")
for a,b in ys: print(f"  {a:8.1f} .. {b:8.1f}   (h={b-a:.1f})")
