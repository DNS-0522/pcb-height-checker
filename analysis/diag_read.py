"""一次性診斷:某個讀不出值的標註,box 往外長多少才讀得出來。
用法: py diag_read.py <dataset_dir> <view> <cx> <cy>
"""
import json, os, sys
import numpy as np
import ezdxf
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import glyph_match as gm

d, view, cx, cy = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
labels = json.load(open(os.path.join(d, 'labels.json'), encoding='utf-8'))
l = min((x for x in labels if x['view'].startswith(view)),
        key=lambda x: abs(x['cx']-cx) + abs(x['cy']-cy))
h = l['y1'] - l['y0']
print(f"目標標註 {l['id']} {l['view']} box=({l['x0']},{l['y0']})-({l['x1']},{l['y1']}) "
      f"h={h:.2f} w={l['x1']-l['x0']:.2f} read={l['read']!r} value={l['value']}")

doc = ezdxf.readfile(os.path.join(d, 'input.dxf'))
msp = doc.modelspace()
print(f'collect_segments (MAX_SEG={gm.MAX_SEG})…')
segs_all = gm.collect_segments(msp)
templates = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                        'glyph_templates.json')))

def read(box):
    best = None
    for strokes in gm.label_strokes(segs_all, tuple(box)):
        s_, w_, t_, v_, obb_ = gm.recognize_label(strokes, templates)
        rank = (0 if v_ else 1, w_)
        if best is None or rank < best[0]:
            best = (rank, s_, w_, v_)
    return best

box0 = [l['x0'], l['y0'], l['x1'], l['y1']]
print(f"{'成長':>22}  {'讀到':>10}  {'score':>6}  合法?")
for gx in (0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0):
    for side in (('右',), ('左',), ('上',), ('下',), ('上下',)) if gx else (('無',),):
        b = list(box0)
        w = box0[2]-box0[0]
        if '右' in side[0]: b[2] += gx*h
        if '左' in side[0]: b[0] -= gx*h
        if '上' in side[0]: b[3] += gx*w
        if '下' in side[0]: b[1] -= gx*w
        r = read(b)
        if r is None:
            print(f"  {side[0]}+{gx:.2f}h{'':>10}  (沒有筆畫)")
            continue
        _, st, w, v = r
        print(f"  {side[0]}+{gx:.2f}h  ({b[0]:.1f},{b[1]:.1f})-({b[2]:.1f},{b[3]:.1f})"
              f"  {st!r:>10}  {w:6.3f}  {'YES' if v else 'no'}")
