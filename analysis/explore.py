# -*- coding: utf-8 -*-
import sys, io, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import ezdxf

PATH = r"F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf"

doc = ezdxf.readfile(PATH)
msp = doc.modelspace()

print("=== DXF VERSION ===", doc.dxfversion, doc.acad_release)

# Layers
print("\n=== LAYERS ===")
for layer in sorted(doc.layers, key=lambda l: l.dxf.name):
    print(f"  {layer.dxf.name}")

# Entity type counts in modelspace
print("\n=== MODELSPACE ENTITY COUNTS ===")
counts = collections.Counter(e.dxftype() for e in msp)
for t, c in counts.most_common():
    print(f"  {t:15s} {c}")

# Overall extents from header
try:
    ext_min = doc.header.get('$EXTMIN')
    ext_max = doc.header.get('$EXTMAX')
    print("\n=== EXTENTS (header) ===")
    print("  MIN", ext_min)
    print("  MAX", ext_max)
except Exception as e:
    print("extents err", e)

# Blocks (non-anonymous)
print("\n=== BLOCK DEFINITIONS (named) ===")
named = [b.name for b in doc.blocks if not b.name.startswith('*')]
print(f"  total named blocks: {len(named)}")
for n in named[:40]:
    print("   ", n)

# Find TEXT / MTEXT entities; report how many contain 'H'
print("\n=== TEXT/MTEXT scan ===")
texts = []
for e in msp:
    t = e.dxftype()
    if t in ('TEXT', 'MTEXT'):
        s = e.dxf.text if t == 'TEXT' else e.text
        try:
            ins = e.dxf.insert
            x, y = float(ins[0]), float(ins[1])
        except Exception:
            x = y = None
        texts.append((t, s, x, y, e.dxf.layer))

print(f"  total TEXT+MTEXT in modelspace: {len(texts)}")
withH = [r for r in texts if 'H' in (r[1] or '').upper()]
print(f"  containing letter 'H': {len(withH)}")
withHeq = [r for r in texts if 'H=' in (r[1] or '') or 'H＝' in (r[1] or '')]
print(f"  containing 'H=' : {len(withHeq)}")

print("\n  --- sample of 'H=' texts (first 40) ---")
for t, s, x, y, lay in withHeq[:40]:
    sshow = s.replace('\n', ' ')[:60]
    print(f"   [{t}] layer={lay} x={x} y={y}  :: {sshow!r}")
