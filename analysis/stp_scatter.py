# -*- coding: utf-8 -*-
import sys, io, csv
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np, matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
rows=[]
with open("stp_components.csv",encoding="utf-8") as f:
    r=csv.reader(f); next(r)
    for a in r: rows.append((a[0],a[1],*map(float,a[2:])))
A=np.array([x[2:] for x in rows])
cx=(A[:,0]+A[:,3])/2; cy=(A[:,1]+A[:,4])/2
z0=A[:,2]; z1=A[:,5]
top = z1>0.05
bot = z0<-0.83
fig,ax=plt.subplots(figsize=(12,12))
ax.scatter(cx[~top&~bot],cy[~top&~bot],s=3,c='#bbb',label='mid/board')
ax.scatter(cx[bot],cy[bot],s=3,c='#2563eb',label='bottom (z0<-0.83)')
ax.scatter(cx[top],cy[top],s=3,c='#dc2626',label='top (z1>0.05)')
# board outline rect
import matplotlib.patches as mp
ax.add_patch(mp.Rectangle((332.3,-240.6),241.9,121.2,fill=False,ec='green',lw=2))
ax.set_aspect('equal'); ax.legend(); ax.set_title('STP component XY centers (green=BOARD_OUTLINE bbox)')
ax.grid(True,alpha=.3)
fig.savefig('stp_scatter.png',dpi=90)
print("saved stp_scatter.png")
print("counts: top",int(top.sum()),"bottom",int(bot.sum()),"other",int((~top&~bot).sum()))
