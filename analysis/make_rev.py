# -*- coding: utf-8 -*-
"""從一份真實 DXF 造出「位移版」和「位移+局部改動版」,用來驗證對位估計器。
用法: py make_rev.py <in.dxf> <out.dxf> --dx 2.35 --dy -0.8 [--edit x0,y0,x1,y1]
--edit 會把該視窗內的實體刪掉(模擬局部改動),並印出刪了多少。
"""
import sys, io, argparse
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import ezdxf

ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('dst')
ap.add_argument('--dx', type=float, default=0.0); ap.add_argument('--dy', type=float, default=0.0)
ap.add_argument('--edit')
ap.add_argument('--shift-window', help='只平移這個視窗內的實體 x0,y0,x1,y1(模擬某個視圖被搬動)')
a = ap.parse_args()

print(f'讀取 {a.src}…', flush=True)
doc = ezdxf.readfile(a.src)
msp = doc.modelspace()

def centre(e):
    t = e.dxftype()
    if t == 'CIRCLE' or t == 'ARC': return e.dxf.center.x, e.dxf.center.y
    if t == 'LINE': return (e.dxf.start.x+e.dxf.end.x)/2, (e.dxf.start.y+e.dxf.end.y)/2
    if t == 'ELLIPSE': return e.dxf.center.x, e.dxf.center.y
    try:
        pts = [(p[0], p[1]) for p in e.points()]
        return sum(p[0] for p in pts)/len(pts), sum(p[1] for p in pts)/len(pts)
    except Exception:
        return None

removed = 0
if a.edit:
    x0, y0, x1, y1 = map(float, a.edit.split(','))
    doomed = []
    for e in msp:
        c = centre(e)
        if c and x0 <= c[0] <= x1 and y0 <= c[1] <= y1:
            doomed.append(e)
    for e in doomed:
        msp.delete_entity(e); removed += 1
    print(f'局部改動:刪除 ({x0},{y0})-({x1},{y1}) 內的 {removed} 個實體', flush=True)

moved = failed = 0
if a.dx or a.dy:
    win = [float(v) for v in a.shift_window.split(',')] if a.shift_window else None
    for e in msp:
        if win:
            c = centre(e)
            if not c or not (win[0] <= c[0] <= win[2] and win[1] <= c[1] <= win[3]):
                continue
        try:
            e.translate(a.dx, a.dy, 0); moved += 1
        except Exception:
            failed += 1
    scope = f'視窗 {a.shift_window} 內' if win else '整體'
    print(f'{scope}位移 ({a.dx}, {a.dy}) mm:成功 {moved}、不支援 {failed}', flush=True)

print(f'寫出 {a.dst}…', flush=True)
doc.saveas(a.dst)
print('完成', flush=True)
