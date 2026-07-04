# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import ezdxf, numpy as np
from collections import deque

PATH = r"F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf"
doc = ezdxf.readfile(PATH); msp = doc.modelspace()

pts=[]
def add(x,y): pts.append((x,y))
for e in msp:
    t=e.dxftype()
    try:
        if t=='LINE':
            # sample a few points ALONG the line so dense view-interior fills, frame stays sparse-ish
            x0,y0=e.dxf.start.x,e.dxf.start.y; x1,y1=e.dxf.end.x,e.dxf.end.y
            L=((x1-x0)**2+(y1-y0)**2)**.5
            n=max(1,min(8,int(L/5)))
            for k in range(n+1):
                add(x0+(x1-x0)*k/n, y0+(y1-y0)*k/n)
        elif t in('CIRCLE','ARC','ELLIPSE'): add(e.dxf.center.x,e.dxf.center.y)
        elif t=='POLYLINE':
            for v in e.vertices: add(v.dxf.location.x,v.dxf.location.y)
        elif t=='LWPOLYLINE':
            for x,y,*_ in e.get_points(): add(x,y)
    except Exception: pass
P=np.array(pts)
X0,Y0,X1,Y1=0.0,0.0,1189.0,841.0
cs=4.0  # cell size mm
nx=int((X1-X0)/cs)+1; ny=int((Y1-Y0)/cs)+1
ix=np.clip(((P[:,0]-X0)/cs).astype(int),0,nx-1)
iy=np.clip(((P[:,1]-Y0)/cs).astype(int),0,ny-1)
grid=np.zeros((ny,nx),int)
np.add.at(grid,(iy,ix),1)
occ=grid>=4            # density threshold
# dilate by 1 to bridge tiny internal gaps
occ2=occ.copy()
occ2[1:,:]|=occ[:-1,:]; occ2[:-1,:]|=occ[1:,:]
occ2[:,1:]|=occ[:,:-1]; occ2[:,:-1]|=occ[:,1:]
# connected components (8-conn) BFS
lab=np.zeros_like(occ2,int); cur=0; comps=[]
for r in range(ny):
    for c in range(nx):
        if occ2[r,c] and lab[r,c]==0:
            cur+=1; q=deque([(r,c)]); lab[r,c]=cur; cells=[]
            while q:
                rr,cc=q.popleft(); cells.append((rr,cc))
                for dr in(-1,0,1):
                    for dc in(-1,0,1):
                        nr,nc=rr+dr,cc+dc
                        if 0<=nr<ny and 0<=nc<nx and occ2[nr,nc] and lab[nr,nc]==0:
                            lab[nr,nc]=cur; q.append((nr,nc))
            comps.append(cells)
# bbox of big comps
res=[]
for cells in comps:
    if len(cells)<60: continue   # ignore small blobs (symbols/dim clusters)
    rs=[c[0] for c in cells]; csl=[c[1] for c in cells]
    bx0=min(csl)*cs+X0; bx1=(max(csl)+1)*cs+X0
    by0=min(rs)*cs+Y0;  by1=(max(rs)+1)*cs+Y0
    res.append((bx0,by0,bx1,by1,len(cells)))
res.sort(key=lambda r:(-(r[3]-r[1]),(r[0])))  # by top y then x
res.sort(key=lambda r:(-r[1],r[0]))
print(f"found {len(res)} view blobs (cell>=60):\n")
for i,(a,b,c,d,n) in enumerate(res):
    print(f"  V{i:02d}  x[{a:6.1f},{c:6.1f}] y[{b:6.1f},{d:6.1f}]  w={c-a:5.1f} h={d-b:5.1f} cells={n}")
