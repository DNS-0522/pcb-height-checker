# -*- coding: utf-8 -*-
import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
from OCP.TDF import TDF_LabelSequence, TDF_Label
from OCP.TDataStd import TDataStd_Name
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.TopLoc import TopLoc_Location
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID, TopAbs_FACE

PATH = r"F:\ux3607ya.10-3d_0616\0616_1839_top_and_bottom.stp"
doc = TDocStd_Document(TCollection_ExtendedString("d"))
reader = STEPCAFControl_Reader(); reader.ReadFile(PATH); reader.Transfer(doc)
st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

def nm(label):
    a=TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(),a):
        try: return TCollection_AsciiString(a.Get()).ToCString()
        except: return ""
    return ""

def bbox(shape):
    bb=Bnd_Box(); BRepBndLib.Add_s(shape,bb,False)
    try: return bb.Get()
    except: return None

def count(shape,typ):
    e=TopExp_Explorer(shape,typ); n=0
    while e.More(): n+=1; e.Next()
    return n

roots=TDF_LabelSequence(); st.GetFreeShapes(roots)
root=roots.Value(1)
comps=TDF_LabelSequence(); st.GetComponents_s(root,comps)
# root children: BOARD_OUTLINE, COMPONENTS
shown=0
for i in range(1,comps.Length()+1):
    c=comps.Value(i); ref=TDF_Label(); st.GetReferredShape_s(c,ref)
    cn=nm(c) or nm(ref)
    print(f"root child {i}: {cn!r} isAsm(ref)={st.IsAssembly_s(ref)}")
    if st.IsAssembly_s(ref):
        sub=TDF_LabelSequence(); st.GetComponents_s(ref,sub)
        print(f"   COMPONENTS children={sub.Length()}; inspecting a few leaves:")
        for j in range(1,min(sub.Length(),1)+1):
            pass
        # inspect specific leaves by name
        for j in range(1,sub.Length()+1):
            cc=sub.Value(j); rref=TDF_Label(); st.GetReferredShape_s(cc,rref)
            name=nm(cc) or nm(rref)
            if name.startswith('CTK0_SM0402') or name.startswith('J6102') or name.startswith('CTK0_SM0805'):
                proto = rref if rref else cc
                psh = st.GetShape_s(proto)         # prototype at its own origin
                csh = st.GetShape_s(cc)            # component as placed in COMPONENTS frame
                bp=bbox(psh); bc=bbox(csh)
                loc_c = st.GetLocation_s(cc)
                print(f"     {name}: solids(proto)={count(psh,TopAbs_SOLID)} faces={count(psh,TopAbs_FACE)}")
                if bp: print(f"        proto-bbox  X[{bp[0]:.2f},{bp[3]:.2f}] Y[{bp[1]:.2f},{bp[4]:.2f}] Z[{bp[2]:.2f},{bp[5]:.2f}]  (H={bp[5]-bp[2]:.2f})")
                if bc: print(f"        placed-bbox X[{bc[0]:.2f},{bc[3]:.2f}] Y[{bc[1]:.2f},{bc[4]:.2f}] Z[{bc[2]:.2f},{bc[5]:.2f}]  (H={bc[5]-bc[2]:.2f})")
                shown+=1
            if shown>=6: break
    if shown>=6: break
