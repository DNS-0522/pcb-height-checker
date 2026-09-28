"""一次性診斷:為什麼有些明顯的 H= 標註讀不出來。
用法: py diag_labels.py <dataset_dir>
"""
import json, math, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

d = sys.argv[1]
meta = json.load(open(os.path.join(d, 'meta.json'), encoding='utf-8'))
views = meta['views']
labels = json.load(open(os.path.join(d, 'labels.json'), encoding='utf-8'))
zones = json.load(open(os.path.join(d, 'zones.json'), encoding='utf-8'))
dxf = os.path.join(d, 'input.dxf')

import ezdxf
doc = ezdxf.readfile(dxf)
msp = doc.modelspace()

def seg_bb_len(e):
    t = e.dxftype()
    if t == 'LINE':
        x0, y0, x1, y1 = e.dxf.start.x, e.dxf.start.y, e.dxf.end.x, e.dxf.end.y
        return (min(x0,x1), min(y0,y1), max(x0,x1), max(y0,y1)), math.hypot(x1-x0, y1-y0)
    if t == 'ARC':
        r = e.dxf.radius; cx, cy = e.dxf.center.x, e.dxf.center.y
        a0, a1 = math.radians(e.dxf.start_angle), math.radians(e.dxf.end_angle)
        return (cx-r, cy-r, cx+r, cy+r), r*((a1-a0) % (2*math.pi))
    if t == 'ELLIPSE':
        cx, cy = e.dxf.center.x, e.dxf.center.y
        mj = math.hypot(e.dxf.major_axis.x, e.dxf.major_axis.y)
        mi = mj * e.dxf.ratio
        return (cx-mj, cy-mi, cx+mj, cy+mi), 2*math.pi*max(mj, 0.01)
    if t == 'POLYLINE':
        pts = [(p[0], p[1]) for p in e.points()]
        if len(pts) < 2: return None, None
        xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
        ln = sum(math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1]) for i in range(len(pts)-1))
        return (min(xs), min(ys), max(xs), max(ys)), ln
    return None, None

segs = {v: [] for v in views}
dropped = {v: [] for v in views}   # 被 ln>8 濾掉的
for e in msp:
    bb, ln = seg_bb_len(e)
    if bb is None or ln is None or ln == 0: continue
    cx, cy = (bb[0]+bb[2])/2, (bb[1]+bb[3])/2
    for v, vb in views.items():
        if vb[0] <= cx <= vb[2] and vb[1] <= cy <= vb[3]:
            (segs[v] if ln <= 8.0 else dropped[v]).append((bb, ln)); break

print('== 每視圖線段數(<=8mm 進入聚類 / >8mm 直接丟棄)')
for v in views:
    print(f'  {v}: {len(segs[v])} / {len(dropped[v])}')

# 標註尺寸分佈:找出「大字體」
print('\n== labels.json 尺寸 vs 讀值')
rows = []
for l in labels:
    w = l['x1']-l['x0']; h = l['y1']-l['y0']
    rows.append((h, w, l['read'], l['value'], l['id'], l['view'], l['cx'], l['cy'], l.get('zoneId')))
rows.sort(key=lambda r: -r[0])
print('  最高的 12 個:')
for h, w, r, v, i, vw, cx, cy, z in rows[:12]:
    print(f'   {i} {vw[:3]} h={h:5.2f} w={w:5.2f} read={r!r:10} value={v} zone={z}')
flag = [r for r in rows if r[3] is None]
ok = [r for r in rows if r[3] is not None]
print(f'\n  讀出值 {len(ok)} 個: 高度 median {np.median([r[0] for r in ok]):.2f} '
      f'範圍 {min(r[0] for r in ok):.2f}–{max(r[0] for r in ok):.2f}')
print(f'  讀不出 {len(flag)} 個: 高度 median {np.median([r[0] for r in flag]):.2f} '
      f'範圍 {min(r[0] for r in flag):.2f}–{max(r[0] for r in flag):.2f}')
print('  讀不出的寬高比 w/h:', [f'{r[1]/r[0]:.2f}' for r in flag[:20]])
print('  讀出的  寬高比 w/h:', [f'{r[1]/r[0]:.2f}' for r in ok[:20]])

# 讀不出的標註:右邊/附近有沒有「沒被併進來」的候選群?
print('\n== 讀不出的標註,附近是否有未合併的字元群(字距 > 1.2mm 的證據)')
def near_segs(box, pad):
    out = []
    for v, items in segs.items():
        for bb, ln in items:
            cx, cy = (bb[0]+bb[2])/2, (bb[1]+bb[3])/2
            if box[0]-pad <= cx <= box[2]+pad and box[1]-pad <= cy <= box[3]+pad:
                out.append(bb)
    return out
for h, w, r, v, i, vw, cx, cy, z in flag[:10]:
    box = (cx-w/2, cy-h/2, cx+w/2, cy+h/2)
    n0 = len(near_segs(box, 0.0)); n1 = len(near_segs(box, h*0.5)); n2 = len(near_segs(box, h*1.2))
    print(f'   {i} read={r!r:8} h={h:5.2f} w={w:5.2f} 群內線段={n0:3d} +0.5h內={n1:3d} +1.2h內={n2:3d}')
