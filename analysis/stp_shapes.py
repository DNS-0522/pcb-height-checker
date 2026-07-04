# -*- coding: utf-8 -*-
import sys, io, csv
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np, matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt, matplotlib.patches as mp
rows=[]
with open("stp_components.csv",encoding="utf-8") as f:
    r=csv.reader(f); next(r)
    for a in r: rows.append((a[0],a[1],*map(float,a[2:])))
A=np.array([x[2:] for x in rows])
cy=(A[:,1]+A[:,4])/2
# 3 Y bands
def band(y):
    if y> -50: return 2      # top cluster ~ +50
    if y< -290: return 0     # bottom cluster ~ -360
    return 1                 # middle (board)
cols={0:'#2563eb',1:'#16a34a',2:'#dc2626'}
fig,ax=plt.subplots(figsize=(13,13))
for i,(nm,part,x0,y0,z0,x1,y1,z1) in enumerate(rows):
    b=band(cy[i])
    ax.add_patch(mp.Rectangle((x0,y0),x1-x0,y1-y0,fill=False,ec=cols[b],lw=0.3))
ax.add_patch(mp.Rectangle((332.3,-240.6),241.9,121.2,fill=False,ec='black',lw=2,ls='--'))
ax.set_xlim(130,620); ax.set_ylim(-440,180); ax.set_aspect('equal')
ax.set_title('STP component footprints by Y-band (black dashed=BOARD_OUTLINE)')
ax.grid(True,alpha=.3)
fig.savefig('stp_shapes.png',dpi=85)
for b in (0,1,2):
    m=np.array([band(cy[i])==b for i in range(len(rows))])
    print(f"band{b}: n={m.sum()} X[{A[m,0].min():.0f},{A[m,3].max():.0f}] Y[{A[m,1].min():.0f},{A[m,4].max():.0f}]")
print("saved stp_shapes.png")
