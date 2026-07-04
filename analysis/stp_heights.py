# -*- coding: utf-8 -*-
import sys, io, csv, re, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np
rows=[]
with open("stp_components.csv",encoding="utf-8") as f:
    r=csv.reader(f); next(r)
    for a in r: rows.append((a[0],a[1],*map(float,a[2:])))
H=np.array([ (x[7]-x[4]) for x in rows ])  # z1-z0
print("=== component HEIGHT (z1-z0) histogram ===")
h,e=np.histogram(H,bins=30)
for i in range(len(h)):
    if h[i]: print(f"  {e[i]:5.2f}..{e[i+1]:5.2f}: {h[i]}")
print(f"\nexactly ~3.81 (3.80-3.82): {((H>3.80)&(H<3.82)).sum()} of {len(H)}")
print(f"exactly ~1.60: {((H>1.59)&(H<1.61)).sum()}")

# group by package token
def pkg(name):
    m=re.search(r'(SM\d{4}|STR\d{4}|SMR\d_\d{4}|BGA\d+|XBGA\d+|LCC\d+|QFN\d+|SOT\d+|SOIC\d+|DFN\d+|WTOB|SHUNT)', name)
    return m.group(1) if m else (name.split('_')[0][:10])
byp=collections.defaultdict(list)
for x in rows: byp[pkg(x[0] or x[1])].append(x[7]-x[4])
print("\n=== height by package (top 25 by count) ===")
print(f"{'pkg':16s}{'n':>5}{'minH':>7}{'maxH':>7}{'distinctH':>10}")
for p,hs in sorted(byp.items(),key=lambda kv:-len(kv[1]))[:25]:
    hs=np.array(hs); d=len(set(np.round(hs,2)))
    print(f"{p:16s}{len(hs):5d}{hs.min():7.2f}{hs.max():7.2f}{d:10d}")
