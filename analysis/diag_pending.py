"""一次性診斷:待確認(沒有 H 值)的區裡面,到底有沒有 H= 標註?
分三類:①區內有標註但被判給別區(關聯錯) ②區內/邊上根本沒有標註(圖面沒標)
③區內有標註但讀不出值(待人工)。
用法: py diag_pending.py <dataset_dir>
"""
import json, os, sys

d = sys.argv[1]
zones = json.load(open(os.path.join(d, 'zones.json'), encoding='utf-8'))
labels = json.load(open(os.path.join(d, 'labels.json'), encoding='utf-8'))
ov_path = os.path.join(d, 'zone_overrides.json')
ov = json.load(open(ov_path, encoding='utf-8')) if os.path.exists(ov_path) else {}

# 區 H 值 = 區內標註值取最小(和 server 的規則一致)
zval = {}
for l in labels:
    if l.get('zoneId') and l['value'] is not None:
        zval.setdefault(l['zoneId'], []).append(l['value'])

def inside(poly, x, y):
    n = len(poly); c = False
    for i in range(n):
        x0, y0 = poly[i]; x1, y1 = poly[(i+1) % n]
        if (y0 > y) != (y1 > y) and x < x0 + (y-y0)*(x1-x0)/((y1-y0) or 1e-9):
            c = not c
    return c

def near(poly, x, y, pad):
    xs = [p[0] for p in poly]; ys = [p[1] for p in poly]
    return (min(xs)-pad <= x <= max(xs)+pad) and (min(ys)-pad <= y <= max(ys)+pad)

cats = {'關聯錯': [], '讀不出': [], '沒標註': []}
for z in zones:
    if z['id'] in zval or z['id'] in ov: continue        # 已有值
    poly = z['polygon'] or []
    if not poly: continue
    ins = [l for l in labels if l['view'] == z['view'] and inside(poly, l['cx'], l['cy'])]
    if not ins:   # 放寬到 bbox+2mm(字常壓在界線上)
        ins = [l for l in labels if l['view'] == z['view']
               and near(poly, l['cx'], l['cy'], 0) and inside(poly, l['cx'], l['cy'])]
    if ins:
        if any(l['value'] is not None for l in ins):
            cats['關聯錯'].append((z, ins))
        else:
            cats['讀不出'].append((z, ins))
    else:
        cats['沒標註'].append((z, []))

tot = sum(len(v) for v in cats.values())
print(f'{os.path.basename(d)}: 沒有 H 值的區共 {tot} 個')
for k, v in cats.items():
    area = sum((z.get('areaMm2') or 0) for z, _ in v)
    print(f'  {k:>6}: {len(v):>3} 區, 合計 {area:8.0f} mm2')
for k in ('關聯錯', '讀不出'):
    v = sorted(cats[k], key=lambda t: -(t[0].get('areaMm2') or 0))
    if not v: continue
    print(f'\n  == {k} 面積前 10:')
    for z, ins in v[:10]:
        print(f"     {z['id']:>18} {z['areaMm2']:8.1f} mm2 "
              f"內含: {[(l['read'], l['value'], l.get('zoneId')) for l in ins][:3]}")
v = sorted(cats['沒標註'], key=lambda t: -(t[0].get('areaMm2') or 0))
print('\n  == 沒標註 面積前 10:')
for z, _ in v[:10]:
    poly = z['polygon']
    cx = sum(p[0] for p in poly)/len(poly); cy = sum(p[1] for p in poly)/len(poly)
    print(f"     {z['id']:>18} {z['areaMm2']:8.1f} mm2 中心=({cx:.1f},{cy:.1f})")
