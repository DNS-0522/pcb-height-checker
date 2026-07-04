# -*- coding: utf-8 -*-
import sys, io, csv
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np
rows=[]
with open("stp_components.csv",encoding="utf-8") as f:
    r=csv.reader(f); next(r)
    for a in r:
        rows.append((a[0],a[1],*map(float,a[2:])))
A=np.array([x[2:] for x in rows])
cx=(A[:,0]+A[:,3])/2; cy=(A[:,1]+A[:,4])/2; cz=(A[:,2]+A[:,5])/2

# Board-outline-like rows
print("=== BOARD/MARK/FIDUCIAL rows ===")
for nm,part,x0,y0,z0,x1,y1,z1 in rows:
    U=(nm+part).upper()
    if 'BOARD' in U or 'OUTLINE' in U or 'FIDUCIAL' in U or nm.startswith('MARK'):
        if (x1-x0)>50 or (y1-y0)>50 or 'OUTLINE' in U:
            print(f"  {nm:16s}|{part:16s} x[{x0:.1f},{x1:.1f}] y[{y0:.1f},{y1:.1f}] z[{z0:.2f},{z1:.2f}]")

# X / Y center histograms to find clusters
print("\n=== X-center histogram ===")
h,e=np.histogram(cx,bins=24)
for i in range(len(h)):
    if h[i]: print(f"  {e[i]:7.1f}..{e[i+1]:7.1f}: {h[i]}")
print("=== Y-center histogram ===")
h,e=np.histogram(cy,bins=24)
for i in range(len(h)):
    if h[i]: print(f"  {e[i]:7.1f}..{e[i+1]:7.1f}: {h[i]}")

# Try grouping by large Y gaps
order=np.argsort(cy); ys=cy[order]
gaps=np.where(np.diff(ys)>15)[0]
print(f"\nY-gap groups (gap>15mm): {len(gaps)+1} groups")
bounds=[0]+list(gaps+1)+[len(ys)]
for gi in range(len(bounds)-1):
    idx=order[bounds[gi]:bounds[gi+1]]
    print(f"  group{gi}: n={len(idx)} X[{cx[idx].min():.1f},{cx[idx].max():.1f}] Y[{cy[idx].min():.1f},{cy[idx].max():.1f}] Z[{cz[idx].min():.2f},{cz[idx].max():.2f}]")
