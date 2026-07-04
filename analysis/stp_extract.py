# -*- coding: utf-8 -*-
"""Extract per-component global bounding boxes from a STEP assembly via OCP/XCAF."""
import sys, io, csv
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib

PATH = r"F:\ux3607ya.10-3d_0616\0616_1839_top_and_bottom.stp"

doc = TDocStd_Document(TCollection_ExtendedString("d"))
reader = STEPCAFControl_Reader()
print("reading...", flush=True)
reader.ReadFile(PATH)
reader.Transfer(doc)
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
print("transferred.", flush=True)

def name_of(label):
    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        try:
            return TCollection_AsciiString(attr.Get()).ToCString()
        except Exception:
            return str(attr.Get().ToExtString())
    return ""

rows = []
def explore(label, loc, path_names):
    if st.IsAssembly_s(label):
        comps = TDF_LabelSequence()
        st.GetComponents_s(label, comps)
        for i in range(1, comps.Length()+1):
            comp = comps.Value(i)
            cloc = st.GetLocation_s(comp)
            nloc = loc.Multiplied(cloc)
            iname = name_of(comp)
            ref = TDF_Label()
            if st.GetReferredShape_s(comp, ref):
                explore(ref, nloc, path_names + [iname])
            else:
                explore(comp, nloc, path_names + [iname])
    else:
        shape = st.GetShape_s(label)
        try:
            located = shape.Located(loc)
            bb = Bnd_Box()
            BRepBndLib.Add_s(located, bb, False)
            x0,y0,z0,x1,y1,z1 = bb.Get()
        except Exception as e:
            return
        # instance name = last non-empty in path, part name = label name
        inst = next((n for n in reversed(path_names) if n), "")
        part = name_of(label)
        rows.append((inst, part, x0,y0,z0,x1,y1,z1))

from OCP.TopLoc import TopLoc_Location
roots = TDF_LabelSequence()
st.GetFreeShapes(roots)
print("free shapes:", roots.Length(), flush=True)
for i in range(1, roots.Length()+1):
    explore(roots.Value(i), TopLoc_Location(), [name_of(roots.Value(i))])

print("leaf instances:", len(rows), flush=True)
A = np.array([r[2:] for r in rows], float)  # x0,y0,z0,x1,y1,z1
print(f"GLOBAL X: {A[:,0].min():.2f} .. {A[:,3].max():.2f}")
print(f"GLOBAL Y: {A[:,1].min():.2f} .. {A[:,4].max():.2f}")
print(f"GLOBAL Z: {A[:,2].min():.2f} .. {A[:,5].max():.2f}")

# Z histogram of solid centers to find board plane / top-bottom split
zc = (A[:,2]+A[:,5])/2
print("\nZ-center histogram:")
h,e = np.histogram(zc, bins=30)
for i in range(len(h)):
    if h[i]: print(f"  {e[i]:7.2f}..{e[i+1]:7.2f}: {h[i]}")

print("\nfirst 20 rows (inst, part, z0..z1):")
for r in rows[:20]:
    print(f"  {r[0]:12s} | {r[1]:18s} | z[{r[4]:6.2f},{r[7]:6.2f}] xy=({r[2]:.1f},{r[3]:.1f})-({r[5]:.1f},{r[6]:.1f})")

with open("stp_components.csv","w",newline="",encoding="utf-8") as f:
    w=csv.writer(f); w.writerow(["inst","part","x0","y0","z0","x1","y1","z1"])
    for r in rows: w.writerow(r)
print("\nsaved stp_components.csv")
