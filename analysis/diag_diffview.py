# -*- coding: utf-8 -*-
"""把 diff 結果縮圖 / 裁切成看得清楚的圖(給人看的,不是產品程式)。
用法: py diag_diffview.py <diff_dir> <out.png> [--region x0,y0,x1,y1] [--width 1500]
"""
import argparse, json, os
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('d'); ap.add_argument('out')
ap.add_argument('--region'); ap.add_argument('--width', type=int, default=1500)
a = ap.parse_args()

meta = json.load(open(os.path.join(a.d, 'diff.json'), encoding='utf-8'))
im = Image.open(os.path.join(a.d, 'diff.jpg')).convert('RGB')
W, H = im.size
if a.region:
    x0, y0, x1, y1 = map(float, a.region.split(','))
    sx = W / (meta['x1'] - meta['x0']); sy = H / (meta['y1'] - meta['y0'])
    c0 = int((x0 - meta['x0']) * sx); c1 = int((x1 - meta['x0']) * sx)
    r1 = int(H - (y0 - meta['y0']) * sy); r0 = int(H - (y1 - meta['y0']) * sy)
    im = im.crop((max(0, c0), max(0, r0), min(W, c1), min(H, r1)))
if im.width != a.width:          # 裁切後的小圖要放大才看得清楚
    resample = Image.LANCZOS if im.width > a.width else Image.NEAREST
    im = im.resize((a.width, max(1, round(im.height * a.width / im.width))), resample)
im.save(a.out)
al = meta.get('align') or {}
print(f"{os.path.basename(a.d)}: {im.size[0]}x{im.size[1]}  "
      f"差異像素 舊-{meta['removedPx']} / 新+{meta['addedPx']}  "
      f"差異區域 {meta.get('regionsTotal')}  "
      f"對位={al.get('applied')} ({al.get('dx')},{al.get('dy')}) "
      f"共識={al.get('consensusPct')}% 原因={al.get('reason')}")
