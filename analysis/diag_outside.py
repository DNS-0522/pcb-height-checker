"""把「被當成外部而丟掉」的區域(debug_cc 的白色)疊回視圖上看。
用法: py diag_outside.py <dataset_dir> <out_dir>
"""
import json, os, sys
import numpy as np
from PIL import Image
from skimage import measure

d, outdir = sys.argv[1], sys.argv[2]
meta = json.load(open(os.path.join(d, 'meta.json'), encoding='utf-8'))
SCALE = 14
for view, vb in meta['views'].items():
    cc = np.asarray(Image.open(os.path.join(d, f'debug_cc_{view}.png')).convert('RGB'))
    base = Image.open(os.path.join(d, f'view_{view}.jpg')).convert('RGB').resize(
        (cc.shape[1], cc.shape[0]))
    white = (cc[:, :, 0] > 250) & (cc[:, :, 1] > 250) & (cc[:, :, 2] > 250)
    lab = measure.label(white, connectivity=1)
    props = sorted(measure.regionprops(lab), key=lambda p: -p.area)
    print(f'{view}: 白色(外部)總面積 {white.sum()/SCALE/SCALE:.0f} mm2, '
          f'視圖面積 {(vb[2]-vb[0])*(vb[3]-vb[1]):.0f} mm2, 連通塊 {len(props)}')
    for rp in props[:3]:
        r0, c0 = rp.centroid
        print(f'    {rp.area/SCALE/SCALE:8.0f} mm2  bbox sheet=({vb[0]+rp.bbox[1]/SCALE:.0f},'
              f'{vb[1]+(cc.shape[0]-1-rp.bbox[2])/SCALE:.0f})-({vb[0]+rp.bbox[3]/SCALE:.0f},'
              f'{vb[1]+(cc.shape[0]-1-rp.bbox[0])/SCALE:.0f})')
    ov = np.asarray(base).copy()
    ov[white] = (0.45*ov[white] + 0.55*np.array([235, 40, 40])).astype(np.uint8)
    p = os.path.join(outdir, f'diag_outside_{os.path.basename(d)}_{view}.png')
    Image.fromarray(ov).resize((cc.shape[1]//2, cc.shape[0]//2)).save(p)
    print('    ->', p)
