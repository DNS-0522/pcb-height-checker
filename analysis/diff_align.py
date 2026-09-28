# -*- coding: utf-8 -*-
"""兩版 DXF 的整體位移估計 + 共識比例(diff 對位用)。

作法:用孔(CIRCLE)的圓心當特徵 —— 跨版最穩、且不受「改了什麼」影響。
依半徑分組後配對算 Δx/Δy,在 Δ 空間投票取最密的一群(眾數),再用群內中位數
細修。改動區只會投散票,選不上 → 位移由「沒改的多數」決定,改動自然成為離群值。
共識比例(inlier%)就是「這個位移可不可信」的指標,同時離群的孔本身就是改動線索。
LINE 端點做獨立交叉驗證。

用法: py diff_align.py A.dxf B.dxf [--views views.json] [--bin 0.1] [--tol 0.05]
"""
import sys, io, json, math, argparse, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np
import ezdxf


def circles(msp):
    out = []
    for e in msp:
        if e.dxftype() == 'CIRCLE':
            out.append((e.dxf.center.x, e.dxf.center.y, e.dxf.radius))
    return np.array(out, dtype=float) if out else np.zeros((0, 3))


def lines(msp):
    out = []
    for e in msp:
        if e.dxftype() == 'LINE':
            x0, y0 = e.dxf.start.x, e.dxf.start.y
            x1, y1 = e.dxf.end.x, e.dxf.end.y
            ln = math.hypot(x1-x0, y1-y0)
            if ln < 0.5:      # 極短的描邊筆畫太多且不穩,跳過
                continue
            ang = math.degrees(math.atan2(y1-y0, x1-x0)) % 180.0
            out.append(((x0+x1)/2, (y0+y1)/2, ln, ang))
    return np.array(out, dtype=float) if out else np.zeros((0, 4))


def vote(feat_a, feat_b, keycols, bin_mm, cap=400, rng=None):
    """依 keycols 分組配對,對 Δ 投票。回傳 (dx, dy, 票數, 參與配對數)。"""
    deltas = []
    def keys(f):
        k = np.round(f[:, keycols] / 0.01).astype(np.int64) if len(f) else np.zeros((0, len(keycols)), np.int64)
        return [tuple(r) for r in k]
    ka, kb = keys(feat_a), keys(feat_b)
    ga = collections.defaultdict(list); gb = collections.defaultdict(list)
    for i, k in enumerate(ka): ga[k].append(i)
    for i, k in enumerate(kb): gb[k].append(i)
    for k, ia in ga.items():
        ib = gb.get(k)
        if not ib: continue
        if len(ia) > cap: ia = ia[:cap]
        if len(ib) > cap: ib = ib[:cap]
        A = feat_a[ia][:, :2]; B = feat_b[ib][:, :2]
        d = (B[None, :, :] - A[:, None, :]).reshape(-1, 2)
        if rng is not None:
            d = d[(np.abs(d[:, 0]) <= rng) & (np.abs(d[:, 1]) <= rng)]
        if len(d): deltas.append(d)
    if not deltas:
        return None
    d = np.concatenate(deltas)
    q = np.round(d / bin_mm).astype(np.int64)
    uniq, cnt = np.unique(q, axis=0, return_counts=True)
    top = int(np.argmax(cnt))
    centre = uniq[top] * bin_mm
    near = d[(np.abs(d[:, 0] - centre[0]) < bin_mm * 1.5) &
             (np.abs(d[:, 1] - centre[1]) < bin_mm * 1.5)]
    est = np.median(near, axis=0)
    return float(est[0]), float(est[1]), int(cnt[top]), len(d)


def consensus(a, b, dx, dy, tol, keycols):
    """套用位移後,A 的特徵有幾個在 B 找到同半徑/同規格的對應。"""
    if not len(a) or not len(b):
        return 0, len(a), len(b), np.zeros((0, 2))
    kb = collections.defaultdict(list)
    for i, r in enumerate(np.round(b[:, keycols] / 0.01).astype(np.int64)):
        kb[tuple(r)].append(i)
    hit = 0
    outliers = []
    for i, r in enumerate(np.round(a[:, keycols] / 0.01).astype(np.int64)):
        cand = kb.get(tuple(r))
        ok = False
        if cand:
            p = a[i, :2] + (dx, dy)
            for j in cand:
                if abs(b[j, 0] - p[0]) <= tol and abs(b[j, 1] - p[1]) <= tol:
                    ok = True; break
        if ok: hit += 1
        else: outliers.append(a[i, :2])
    # 「新版多出」要反向算一次(同位置的重複實體不能算成多出來的)
    ka = collections.defaultdict(list)
    for i, r in enumerate(np.round(a[:, keycols] / 0.01).astype(np.int64)):
        ka[tuple(r)].append(i)
    added = 0
    for j, r in enumerate(np.round(b[:, keycols] / 0.01).astype(np.int64)):
        cand = ka.get(tuple(r))
        ok = False
        if cand:
            q = b[j, :2] - (dx, dy)
            for i in cand:
                if abs(a[i, 0] - q[0]) <= tol and abs(a[i, 1] - q[1]) <= tol:
                    ok = True; break
        if not ok: added += 1
    return hit, len(a), added, np.array(outliers) if outliers else np.zeros((0, 2))


def report(name, a, b, keycols, bin_mm, tol, rng):
    v = vote(a, b, keycols, bin_mm, rng=rng)
    if v is None:
        print(f'  {name}: 沒有可配對的特徵'); return None
    dx, dy, peak, npairs = v
    hit, tot, added, out = consensus(a, b, dx, dy, tol, keycols)
    pct = 100.0 * hit / max(1, tot)
    print(f'  {name}: 位移 = ({dx:+.3f}, {dy:+.3f}) mm   '
          f'共識 {hit}/{tot} = {pct:.1f}%   舊版少掉 {tot-hit}、新版多出 {added}   '
          f'(峰值票 {peak}/{npairs})')
    return dx, dy, pct, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a'); ap.add_argument('b')
    ap.add_argument('--views'); ap.add_argument('--bin', type=float, default=0.1)
    ap.add_argument('--tol', type=float, default=0.05)
    ap.add_argument('--range', type=float, default=60.0, help='搜尋位移上限 mm')
    args = ap.parse_args()

    print(f'讀取 {args.a}');  da = ezdxf.readfile(args.a)
    print(f'讀取 {args.b}');  db = ezdxf.readfile(args.b)
    ca, cb = circles(da.modelspace()), circles(db.modelspace())
    la, lb = lines(da.modelspace()), lines(db.modelspace())
    print(f'特徵數:孔 {len(ca)} / {len(cb)}   線段(>0.5mm) {len(la)} / {len(lb)}\n')

    print('== 全圖')
    r_circ = report('孔位', ca, cb, [2], args.bin, args.tol, args.range)
    r_line = report('線段(交叉驗證)', la, lb, [2, 3], args.bin, args.tol, args.range)
    if r_circ and r_line:
        d = math.hypot(r_circ[0]-r_line[0], r_circ[1]-r_line[1])
        print(f'  兩法差距 {d:.3f} mm → {"一致" if d < 0.1 else "不一致,需人工確認"}')

    if args.views:
        views = json.load(open(args.views, encoding='utf-8'))
        print('\n== 各視圖(檢查是否只有某個視圖被搬動)')
        for v, bb in views.items():
            sel = lambda f: f[(f[:, 0] >= bb[0]) & (f[:, 0] <= bb[2]) &
                              (f[:, 1] >= bb[1]) & (f[:, 1] <= bb[3])] if len(f) else f
            report(f'{v} 孔位', sel(ca), sel(cb), [2], args.bin, args.tol, args.range)

    if r_circ is not None and len(r_circ[3]):
        out = r_circ[3]
        print(f'\n== 離群孔位({len(out)} 個)= 真正改動的線索,依 20mm 網格聚集:')
        grid = collections.Counter((int(p[0] // 20) * 20, int(p[1] // 20) * 20) for p in out)
        for (gx, gy), n in grid.most_common(8):
            print(f'   ({gx:4d}–{gx+20:4d}, {gy:4d}–{gy+20:4d}) mm: {n} 個')


def estimate_regions(doc_a, doc_b, boxes, bin_mm=0.1, tol=0.05, rng=60.0, min_feat=8):
    """分區估位移(全域共識低時用):boxes = [(name, x0, y0, x1, y1), ...]。
    回傳每區的 (name, dx, dy, 共識%, 特徵數);特徵太少的區跳過。
    用途是回答「是不是只有某一塊被搬動」—— 不套用,只報告。"""
    ca, cb = circles(doc_a.modelspace()), circles(doc_b.modelspace())
    la, lb = None, None
    out = []
    for name, x0, y0, x1, y1 in boxes:
        sel = lambda f: f[(f[:, 0] >= x0) & (f[:, 0] <= x1) &
                          (f[:, 1] >= y0) & (f[:, 1] <= y1)] if len(f) else f
        a, b, cols = sel(ca), sel(cb), [2]
        if len(a) < min_feat or len(b) < min_feat:      # 孔太少 → 用線段
            if la is None:
                la, lb = lines(doc_a.modelspace()), lines(doc_b.modelspace())
            a, b, cols = sel(la), sel(lb), [2, 3]
        if len(a) < min_feat or len(b) < min_feat:
            continue
        v = vote(a, b, cols, bin_mm, rng=rng)
        if v is None:
            continue
        hit, tot, _added, _o = consensus(a, b, v[0], v[1], tol, cols)
        out.append({'name': name, 'dx': round(v[0], 3), 'dy': round(v[1], 3),
                    'consensusPct': round(100.0 * hit / max(1, tot), 1), 'features': tot})
    return out


def estimate_multi(doc_a, doc_b, bin_mm=0.1, tol=0.05, rng=60.0, max_models=3,
                   min_frac=0.04, min_feat=8):
    """序列式多位移估計(sequential RANSAC):投出一個位移 → 把對得上的特徵移除
    → 對剩下的再投一次。這樣「某個視圖被整塊搬動」會自成一個位移模型,而且
    不需要事先知道視圖框(粗網格會被搬動邊界切開、共識被稀釋)。
    回傳 [{dx, dy, features, pct, bbox}],pct 是佔全部特徵的比例。"""
    ca, cb = circles(doc_a.modelspace()), circles(doc_b.modelspace())
    cols = [2]
    if len(ca) < 20 or len(cb) < 20:
        ca, cb = lines(doc_a.modelspace()), lines(doc_b.modelspace())
        cols = [2, 3]
    total = len(ca)
    if total < min_feat:
        return []
    rest = ca
    models = []
    for _ in range(max_models):
        if len(rest) < max(min_feat, min_frac * total):
            break
        v = vote(rest, cb, cols, bin_mm, rng=rng)
        if v is None:
            break
        dx, dy = v[0], v[1]
        keep, inl = [], []
        kb = collections.defaultdict(list)
        for j, r in enumerate(np.round(cb[:, cols] / 0.01).astype(np.int64)):
            kb[tuple(r)].append(j)
        for i, r in enumerate(np.round(rest[:, cols] / 0.01).astype(np.int64)):
            cand = kb.get(tuple(r)); ok = False
            if cand:
                px, py = rest[i, 0] + dx, rest[i, 1] + dy
                for j in cand:
                    if abs(cb[j, 0] - px) <= tol and abs(cb[j, 1] - py) <= tol:
                        ok = True; break
            (inl if ok else keep).append(rest[i])
        if len(inl) < max(min_feat, min_frac * total):
            break
        arr = np.array(inl)
        models.append({'dx': round(dx, 3), 'dy': round(dy, 3), 'features': len(inl),
                       'pct': round(100.0 * len(inl) / total, 1),
                       'bbox': [round(float(arr[:, 0].min()), 1), round(float(arr[:, 1].min()), 1),
                                round(float(arr[:, 0].max()), 1), round(float(arr[:, 1].max()), 1)]})
        rest = np.array(keep) if keep else np.zeros((0, ca.shape[1]))
    return models


def grid_boxes(doc_a, cols=4, rows=3):
    """沒有視圖框可用時,把圖紙切成粗網格當「區域」。"""
    xs, ys = [], []
    for e in doc_a.modelspace():
        if e.dxftype() == 'LINE':
            xs += [e.dxf.start.x, e.dxf.end.x]; ys += [e.dxf.start.y, e.dxf.end.y]
    if not xs:
        return []
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    w = (x1 - x0) / cols; h = (y1 - y0) / rows
    return [(f'格 {c+1}-{r+1}', x0 + c*w, y0 + r*h, x0 + (c+1)*w, y0 + (r+1)*h)
            for r in range(rows) for c in range(cols)]


def estimate(doc_a, doc_b, bin_mm=0.1, tol=0.05, rng=60.0):
    """給 cmd_diff 用:回傳 (dx, dy, 共識%, 離群點, 交叉驗證差距 mm)。"""
    ca, cb = circles(doc_a.modelspace()), circles(doc_b.modelspace())
    v = vote(ca, cb, [2], bin_mm, rng=rng)
    if v is None or len(ca) < 8:        # 孔太少 → 改用線段
        la, lb = lines(doc_a.modelspace()), lines(doc_b.modelspace())
        v = vote(la, lb, [2, 3], bin_mm, rng=rng)
        if v is None:
            return None
        dx, dy = v[0], v[1]
        hit, tot, added, out = consensus(la, lb, dx, dy, tol, [2, 3])
        return dx, dy, 100.0*hit/max(1, tot), out, None
    dx, dy = v[0], v[1]
    hit, tot, added, out = consensus(ca, cb, dx, dy, tol, [2])
    la, lb = lines(doc_a.modelspace()), lines(doc_b.modelspace())
    v2 = vote(la, lb, [2, 3], bin_mm, rng=rng)
    gap = None if v2 is None else math.hypot(v2[0]-dx, v2[1]-dy)
    return dx, dy, 100.0*hit/max(1, tot), out, gap


if __name__ == '__main__':
    main()
