# -*- coding: utf-8 -*-
import sys, io
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
from OCP.TopLoc import TopLoc_Location

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

def collect(label, loc, depth, node_name):
    """return (nleaf, bbox tuple or None). Print assemblies up to depth 2."""
    if st.IsAssembly_s(label):
        comps=TDF_LabelSequence(); st.GetComponents_s(label,comps)
        tot=0; ext=[1e9,1e9,1e9,-1e9,-1e9,-1e9]
        children=[]
        for i in range(1,comps.Length()+1):
            comp=comps.Value(i); cloc=loc.Multiplied(st.GetLocation_s(comp))
            iname=nm(comp); ref=TDF_Label()
            tgt = ref if st.GetReferredShape_s(comp,ref) else comp
            n,sub=collect(tgt,cloc,depth+1,iname or nm(tgt))
            tot+=n
            if sub is not None:
                for k in range(3): ext[k]=min(ext[k],sub[k])
                for k in range(3): ext[3+k]=max(ext[3+k],sub[3+k])
            children.append((iname or nm(tgt), n, sub))
        if depth<=1:
            print(f"{'  '*depth}[ASM d{depth}] {node_name!r} leaves={tot} children={comps.Length()}")
            for cn,cnn,csub in children[:40]:
                bs = f"x[{csub[0]:.0f},{csub[3]:.0f}] y[{csub[1]:.0f},{csub[4]:.0f}] z[{csub[2]:.2f},{csub[5]:.2f}]" if csub else "(asm/none)"
                print(f"{'  '*(depth+1)}- {cn!r} leaves={cnn} {bs}")
        return tot,(tuple(ext) if tot else None)
    else:
        sh=st.GetShape_s(label)
        try:
            bb=Bnd_Box(); BRepBndLib.Add_s(sh.Located(loc),bb,False); g=bb.Get()
            return 1,(g[0],g[1],g[2],g[3],g[4],g[5])
        except: return 1,None

roots=TDF_LabelSequence(); st.GetFreeShapes(roots)
for i in range(1,roots.Length()+1):
    collect(roots.Value(i),TopLoc_Location(),0,nm(roots.Value(i)))
