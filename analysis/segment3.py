# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import ezdxf, numpy as np

PATH = r"F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf"
doc = ezdxf.readfile(PATH); msp = doc.modelspace()
pts=[]
for e in msp:
    t=e.dxftype()
    try:
        if t=='LINE':
            x0,y0=e.dxf.start.x,e.dxf.start.y; x1,y1=e.dxf.end.x,e.dxf.end.y
            L=((x1-x0)**2+(y1-y0)**2)**.5; n=max(1,min(6,int(L/6)))
            for k in range(n+1): pts.append((x0+(x1-x0)*k/n,y0+(y1-y0)*k/n))
        elif t in('CIRCLE','ARC','ELLIPSE'): pts.append((e.dxf.center.x,e.dxf.center.y))
        elif t=='POLYLINE':
            for v in e.vertices: pts.append((v.dxf.location.x,v.dxf.location.y))
        elif t=='LWPOLYLINE':
            for x,y,*_ in e.get_points(): pts.append((x,y))
    except Exception: pass
P=np.array(pts)

def bands(mask, axis_vals, lo, hi, binw=2.0, min_gap=14.0, min_run=8.0):
    v=axis_vals[mask]
    nb=int((hi-lo)/binw)+1; occ=np.zeros(nb,bool)
    idx=np.clip(((v-lo)/binw).astype(int),0,nb-1); occ[idx]=True
    segs=[]; i=0
    while i<nb:
        if occ[i]:
            j=i
            while j<nb and occ[j]: j+=1
            segs.append([lo+i*binw,lo+j*binw]); i=j
        else: i+=1
    merged=[segs[0]]
    for s in segs[1:]:
        if s[0]-merged[-1][1]<min_gap: merged[-1][1]=s[1]
        else: merged.append(s)
    return [m for m in merged if m[1]-m[0]>=min_run]

# Column X bands across board region (exclude title block area x>900)
inboard = (P[:,1]>120)&(P[:,1]<800)&(P[:,0]<900)
print("COLUMN X-bands (board region):")
for a,b in bands(inboard, P[:,0], 0, 900, 2.0, 30.0, 30.0):
    print(f"   x {a:7.1f}..{b:7.1f}  w={b-a:.1f}")

for name,(cx0,cx1) in [("LEFT(top)",(30,345)),("RIGHT(bottom)",(450,760))]:
    m=(P[:,0]>cx0)&(P[:,0]<cx1)&(P[:,1]>120)&(P[:,1]<800)
    print(f"\n{name} column ROW Y-bands:")
    for a,b in bands(m, P[:,1], 120, 800, 2.0, 16.0, 25.0):
        print(f"   y {a:7.1f}..{b:7.1f}  h={b-a:.1f}")
