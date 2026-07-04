# -*- coding: utf-8 -*-
import sys, io, re
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np
PATH = r"F:\ux3607ya.10-3d_0616\0616_1839_top_and_bottom.stp"
txt = open(PATH, 'r', encoding='utf-8', errors='replace').read()

# units
for m in re.finditer(r"#\d+\s*=\s*\(?[^;]*?(LENGTH_UNIT|SI_UNIT|CONVERSION_BASED_UNIT)[^;]*;", txt)[:0] if False else []:
    pass
for kw in ['SI_UNIT', 'LENGTH_UNIT', 'CONVERSION_BASED_UNIT', '.MILLI.', '.METRE.']:
    idx = txt.find(kw)
    print(f"unit kw {kw!r} firstpos={idx}")
# print a few unit lines
for m in re.finditer(r"#\d+=[^;]*(?:SI_UNIT|CONVERSION_BASED_UNIT)[^;]*;", txt):
    print("  UNIT:", m.group(0)[:120])
    if m.start() > 200000: break

# CARTESIAN_POINT coords
pts = re.findall(r"CARTESIAN_POINT\('[^']*',\(([^)]*)\)\)", txt)
print("\ncartesian_point matches:", len(pts))
xs=[];ys=[];zs=[]
for p in pts:
    parts = p.split(',')
    if len(parts) >= 3:
        try:
            xs.append(float(parts[0])); ys.append(float(parts[1])); zs.append(float(parts[2]))
        except: pass
X=np.array(xs);Y=np.array(ys);Z=np.array(zs)
print(f"parsed xyz: {len(X)}")
print(f"X range: {X.min():.2f} .. {X.max():.2f}  (span {X.max()-X.min():.2f})")
print(f"Y range: {Y.min():.2f} .. {Y.max():.2f}  (span {Y.max()-Y.min():.2f})")
print(f"Z range: {Z.min():.2f} .. {Z.max():.2f}  (span {Z.max()-Z.min():.2f})")
# Z histogram
print("\nZ histogram (raw local points):")
hist,edges=np.histogram(Z,bins=24)
for i in range(len(hist)):
    print(f"  {edges[i]:7.2f}..{edges[i+1]:7.2f}: {hist[i]}")
