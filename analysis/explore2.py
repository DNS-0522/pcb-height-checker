# -*- coding: utf-8 -*-
import sys, io, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import ezdxf

PATH = r"F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf"
doc = ezdxf.readfile(PATH)
msp = doc.modelspace()

# 1) Named block definitions: entity type counts + any text
print("=== NAMED BLOCK CONTENTS ===")
for b in doc.blocks:
    if b.name.startswith('*'):
        continue
    cnt = collections.Counter(e.dxftype() for e in b)
    has_text = [e for e in b if e.dxftype() in ('TEXT', 'MTEXT', 'ATTDEF')]
    print(f"  {b.name:30s} {dict(cnt)}")
    for e in has_text:
        s = e.dxf.text if e.dxftype() != 'MTEXT' else e.text
        print(f"      TEXT> {s!r}")

# 2) INSERT entities in modelspace
print("\n=== INSERTS (modelspace) ===")
for e in msp.query('INSERT'):
    ins = e.dxf.insert
    print(f"  block={e.dxf.name:25s} at=({ins[0]:.1f},{ins[1]:.1f}) "
          f"scale=({e.dxf.xscale:.3f},{e.dxf.yscale:.3f}) rot={e.dxf.rotation:.1f} layer={e.dxf.layer}")
    # attribs?
    for a in e.attribs:
        print(f"      ATTRIB {a.dxf.tag}={a.dxf.text!r}")

# 3) DIMENSION entities: text + measurement + location
print("\n=== DIMENSIONS (first 82) ===")
dims = list(msp.query('DIMENSION'))
print(f"  total: {len(dims)}")
for e in dims[:82]:
    txt = e.dxf.get('text', '<>')
    try:
        meas = e.get_measurement()
    except Exception:
        meas = '?'
    dp = e.dxf.get('defpoint', None)
    tm = e.dxf.get('text_midpoint', None)
    print(f"  text={txt!r:12s} meas={meas} layer={e.dxf.layer} tmid={tm}")

# 4) Any TEXT anywhere via global recursive search
print("\n=== GLOBAL TEXT CHECK ===")
total_text = 0
for e in msp:
    if e.dxftype() in ('TEXT','MTEXT'):
        total_text += 1
print(f"  modelspace TEXT/MTEXT: {total_text}")
