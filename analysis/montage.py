# -*- coding: utf-8 -*-
"""Combine hlabel crop PNGs into indexed contact sheets for batch reading.
Usage: py montage.py renders/hlabels renders/sheets [per_sheet]
"""
import sys, os, math
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.image as mpimg

indir, outdir = sys.argv[1], sys.argv[2]
per_sheet = int(sys.argv[3]) if len(sys.argv) > 3 else 20
os.makedirs(outdir, exist_ok=True)

files = sorted(f for f in os.listdir(indir) if f.endswith('.png'))
cols = 4
rows = math.ceil(per_sheet / cols)
for si in range(0, len(files), per_sheet):
    batch = files[si:si+per_sheet]
    fig, axes = plt.subplots(rows, cols, figsize=(16, 3.2*rows), dpi=100)
    axes = axes.flat if hasattr(axes, 'flat') else [axes]
    for ax in axes:
        ax.axis('off')
    for ax, fname in zip(axes, batch):
        img = mpimg.imread(os.path.join(indir, fname))
        ax.imshow(img)
        ax.set_title(fname.split('_')[0], fontsize=14, color='red')
        for spine in ax.spines.values():
            spine.set_visible(True); spine.set_color('#999')
        ax.axis('on'); ax.set_xticks([]); ax.set_yticks([])
    name = os.path.join(outdir, f'sheet{si//per_sheet:02d}.png')
    fig.tight_layout()
    fig.savefig(name, facecolor='white')
    plt.close(fig)
    print('saved', name, len(batch))
