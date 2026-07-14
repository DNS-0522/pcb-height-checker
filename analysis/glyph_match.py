# -*- coding: utf-8 -*-
"""Method A: offline vector glyph matching for stroked H= labels.

No OCR, no network. Each label is a cluster of vector strokes; each character
("piece") is a fine sub-cluster. Pieces are normalized and matched against a
small template library (Chamfer distance on sampled stroke points), trying
8 orientations (4 rotations x mirror). Pieces are then assembled into a string
and validated against ^H=\\d+(\\.\\d+)?$.

Commands:
  py glyph_match.py build      # bootstrap templates from confirmed labels
  py glyph_match.py evaluate   # recognize all 150 labels, compare to human reads
"""
import sys, io, json, os, math
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import numpy as np
import ezdxf

HERE = os.path.dirname(os.path.abspath(__file__))
DXF = os.path.join(HERE, '..', 'samples', 'ux3607_nvl_mb_dxf_20260625.dxf')
TEMPLATES = os.path.join(HERE, 'glyph_templates.json')

MAX_SEG = 8.0        # mm — glyph strokes only
PIECE_GAP = 0.38     # mm — sub-cluster gap that separates characters
SAMPLE_STEP = 0.04   # normalized units between sampled points
DOT_MAX_H = 0.30     # piece height (normalized to label height) below which it's '.'

# ---------------------------------------------------------------- geometry
def collect_segments(msp):
    """All short strokes in the doc: (bbox, sample_pts ndarray)."""
    segs = []
    for e in msp:
        t = e.dxftype()
        pts = None
        if t == 'LINE':
            a = (e.dxf.start.x, e.dxf.start.y); b = (e.dxf.end.x, e.dxf.end.y)
            ln = math.hypot(b[0]-a[0], b[1]-a[1])
            if ln == 0 or ln > MAX_SEG: continue
            n = max(3, int(ln / 0.05))
            pts = np.linspace(a, b, n)
        elif t == 'ARC':
            r = e.dxf.radius
            a0, a1 = math.radians(e.dxf.start_angle), math.radians(e.dxf.end_angle)
            sweep = (a1 - a0) % (2 * math.pi)
            ln = r * sweep
            if ln == 0 or ln > MAX_SEG: continue
            n = max(4, int(ln / 0.05))
            ang = a0 + np.linspace(0, sweep, n)
            cx, cy = e.dxf.center.x, e.dxf.center.y
            pts = np.stack([cx + r*np.cos(ang), cy + r*np.sin(ang)], axis=1)
        elif t == 'ELLIPSE':
            # some '0' glyphs are ellipses; sample the full curve
            c = np.array([e.dxf.center.x, e.dxf.center.y])
            mj = np.array([e.dxf.major_axis.x, e.dxf.major_axis.y])
            ratio = e.dxf.ratio
            if np.linalg.norm(mj) > MAX_SEG: continue
            mi = np.array([-mj[1], mj[0]]) * ratio
            ang = np.linspace(0, 2*math.pi, 40)
            pts = c + np.outer(np.cos(ang), mj) + np.outer(np.sin(ang), mi)
        elif t == 'POLYLINE':
            vs = [(p[0], p[1]) for p in e.points()]
            if len(vs) < 2: continue
            arr = np.array(vs)
            span = arr.max(axis=0) - arr.min(axis=0)
            if max(span) > MAX_SEG: continue
            chunks = []
            for i in range(len(vs)-1):
                a, b = arr[i], arr[i+1]
                ln = np.linalg.norm(b-a)
                n = max(3, int(ln / 0.05))
                chunks.append(np.linspace(a, b, n))
            pts = np.concatenate(chunks)
        if pts is None: continue
        bb = (pts[:,0].min(), pts[:,1].min(), pts[:,0].max(), pts[:,1].max())
        segs.append((bb, pts))
    return segs

def in_bbox(bb, box, pad=0.3):
    cx, cy = (bb[0]+bb[2])/2, (bb[1]+bb[3])/2
    return box[0]-pad <= cx <= box[2]+pad and box[1]-pad <= cy <= box[3]+pad

def split_chars(point_arrays, label_h):
    """Anisotropic union-find on stroke point-arrays (already oriented so the
    text runs along +x): strokes join when their x-ranges overlap or nearly
    touch — chars separate on x-gaps, while the two bars of '=' (x-overlap,
    y-gap) stay together."""
    XGAP = 0.08 * label_h
    YGAP = 0.85 * label_h
    bbs = []
    for pts in point_arrays:
        lo = pts.min(axis=0); hi = pts.max(axis=0)
        bbs.append((lo[0], lo[1], hi[0], hi[1]))
    n = len(bbs)
    parent = list(range(n))
    def find(i):
        while parent[i] != i: parent[i] = parent[parent[i]]; i = parent[i]
        return i
    for i in range(n):
        for j in range(i+1, n):
            a, b = bbs[i], bbs[j]
            dx = max(0, max(a[0], b[0]) - min(a[2], b[2]))
            dy = max(0, max(a[1], b[1]) - min(a[3], b[3]))
            if dx <= XGAP and dy <= YGAP:
                parent[find(i)] = find(j)
    groups = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(point_arrays[i])
    return [np.concatenate(g) for g in groups.values()]

TRANSFORMS = []  # 16 orientation matrices (labels also appear at 45°)
for rot in range(8):
    a = rot * math.pi / 4
    R = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    TRANSFORMS.append(R)
    M = np.array([[-1, 0], [0, 1]]) @ R          # mirror-x after rotation
    TRANSFORMS.append(M)

def resample(pts, step):
    """Thin a point cloud to ~uniform density (grid dedupe)."""
    q = np.round(pts / step).astype(np.int64)
    _, idx = np.unique(q, axis=0, return_index=True)
    return pts[np.sort(idx)]

def chamfer(a, b):
    """Symmetric mean nearest-neighbour distance between two point sets."""
    d2 = ((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2)
    return float(np.sqrt(d2.min(axis=1)).mean() + np.sqrt(d2.min(axis=0)).mean()) / 2

def normalize_piece(pts, label_h):
    """Scale by label height, centre on piece bbox centre."""
    p = pts / label_h
    lo = p.min(axis=0); hi = p.max(axis=0)
    return resample(p - (lo + hi) / 2, SAMPLE_STEP)

# ---------------------------------------------------------------- recognize
def label_strokes(segs_all, box):
    """Candidate stroke sets for one label. Background geometry (rect corners,
    circles) may hide among the glyph strokes and neither the bbox nor stroke
    statistics identify the text height reliably on their own — so return
    several filterings; recognition keeps whichever yields a valid H=… string
    with the best score."""
    inside = [(bb, pts) for bb, pts in segs_all if in_bbox(bb, box)]
    if not inside:
        return []
    dims = sorted(max(bb[2]-bb[0], bb[3]-bb[1]) for bb, _ in inside)
    variants = []
    def filtered(hmax):
        return [pts for bb, pts in inside
                if (bb[2]-bb[0]) <= hmax and (bb[3]-bb[1]) <= hmax]
    # (a) everything
    variants.append([pts for _, pts in inside])
    # (b) capped by bbox min-dim (right when the bbox is a clean glyph bbox)
    h0 = max(0.6, min(box[2]-box[0], box[3]-box[1]))
    variants.append(filtered(1.4 * h0))
    # (c) capped by each distinct large stroke size (right when background
    #     arcs are the largest strokes: cutting just below them drops only them)
    seen = set()
    for d in dims[-6:]:
        key = round(d, 1)
        if key in seen or d < 0.5: continue
        seen.add(key)
        variants.append(filtered(d * 0.99))
    # dedupe by stroke count
    uniq, counts = [], set()
    for v in variants:
        if len(v) >= 4 and len(v) not in counts:
            counts.add(len(v)); uniq.append(v)
    return uniq

def recognize_label(strokes_raw, templates):
    """Try 8 orientations; return (string, worst_score, orientation, valid)."""
    tmpl = {ch: np.array(v) for ch, v in templates.items()}
    best = None
    for ti, T in enumerate(TRANSFORMS):
        strokes = [pts @ T.T for pts in strokes_raw]
        allpts = np.concatenate(strokes)
        label_h = allpts[:, 1].max() - allpts[:, 1].min()
        if label_h <= 0: continue
        pieces = split_chars(strokes, label_h)
        info = []
        for pts in pieces:
            lo = pts.min(axis=0); hi = pts.max(axis=0)
            h = (hi[1] - lo[1]) / label_h
            w = (hi[0] - lo[0]) / label_h
            info.append({'pts': pts, 'cx': (lo[0]+hi[0])/2, 'cy': (lo[1]+hi[1])/2,
                         'h': h, 'w': w})
        info.sort(key=lambda p: p['cx'])
        out = []      # (char, score, piece)
        ambiguous = False
        for p in info:
            if p['h'] < DOT_MAX_H and p['w'] < DOT_MAX_H:
                out.append(('.', 0.0, p)); continue
            norm = normalize_piece(p['pts'], label_h)
            scores = {ch: chamfer(norm, t) for ch, t in tmpl.items()}
            ranked = sorted(scores.items(), key=lambda kv: kv[1])
            ch, sc = ranked[0]
            # near-tie between two characters (e.g. 5 vs 6): never silently pick
            if len(ranked) > 1 and ranked[1][1] - sc < 0.018:
                ambiguous = True
            out.append((ch, sc, p))
        s = ''.join(ch for ch, _, _ in out)
        import re
        FMT = r'H=(0|[1-9]\d*)(\.\d+)?'   # no leading zeros: 'H=01' is a misread
        m = re.fullmatch(FMT, s) or re.search(FMT + r'$', s) or re.search(FMT, s)
        valid = bool(m and re.fullmatch(FMT, m.group(0)))
        used = out
        if valid:
            s = m.group(0)
            used = out[m.start():m.end()]   # 1 char = 1 piece
        worst = max((sc for _, sc, _ in used), default=9.9)
        if ambiguous:
            worst = max(worst, 0.5)   # force low confidence -> review
        rank = (0 if valid else 1, worst)
        if best is None or rank < best[0]:
            # oriented extent of the pieces that produced the string
            xs1 = [u[2]['pts'][:, 0].max() for u in used]
            ys = np.concatenate([u[2]['pts'][:, 1] for u in used]) if used else allpts[:, 1]
            obb = (min(u[2]['pts'][:, 0].min() for u in used) if used else 0,
                   float(ys.min()), max(xs1) if xs1 else 0, float(ys.max()), label_h)
            best = (rank, s, worst, ti, valid, obb)
    _, s, worst, ti, valid, obb = best
    return s, worst, ti, valid, obb

# ---------------------------------------------------------------- commands
def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'evaluate'
    doc = ezdxf.readfile(DXF)
    msp = doc.modelspace()
    print('collecting strokes...', file=sys.stderr)
    segs_all = collect_segments(msp)
    print(f'{len(segs_all)} short strokes', file=sys.stderr)
    labels = json.load(open(os.path.join(HERE, 'hlabel_values.json'), encoding='utf-8'))

    if cmd == 'build':
        # bootstrap: labels whose orientation/value I confirmed visually.
        # index -> (string, transform_index)  t=0 upright, t=1 mirrored upright
        BOOT = {
            81:  ('H=0.6',  0),
            114: ('H=0.75', 0),
            6:   ('H=2',    0),
            12:  ('H=1',    0),
            14:  ('H=3',    0),
            41:  ('H=0.5',  0),
            83:  ('H=1.2',  0),
            27:  ('H=0.8',  1),   # mirrored on sheet; unmirror to build
            95:  ('H=0.7',  1),   # mirrored rounded-rect label (source of '7')
        }
        templates = {}
        for idx, (text, ti) in BOOT.items():
            l = labels[idx]
            box = (l['x0'], l['y0'], l['x1'], l['y1'])
            expect = list(text)   # '=' is one piece (bars joined by x-overlap)
            T = TRANSFORMS[ti]
            info = None
            for strokes in label_strokes(segs_all, box):
                strokes = [pts @ T.T for pts in strokes]
                allpts = np.concatenate(strokes)
                label_h = allpts[:, 1].max() - allpts[:, 1].min()
                pieces = split_chars(strokes, label_h)
                cand = []
                for pts in pieces:
                    lo = pts.min(axis=0); hi = pts.max(axis=0)
                    cand.append(((lo[0]+hi[0])/2, pts))
                cand.sort(key=lambda p: p[0])
                if len(cand) == len(expect):
                    info = cand
                    break
            if info is None:
                print(f'  SKIP idx{idx} {text}: no variant gives {len(expect)} pieces', file=sys.stderr)
                continue
            for (cx, pts), ch in zip(info, expect):
                if ch == '.':          # size-classified at recognition
                    continue
                if ch in templates:
                    continue
                templates[ch] = normalize_piece(pts, label_h).round(4).tolist()
                print(f'  template {ch!r} from idx{idx} ({len(templates[ch])} pts)', file=sys.stderr)
        json.dump(templates, open(TEMPLATES, 'w'))
        print(f'{len(templates)} templates -> {TEMPLATES}  chars={sorted(templates)}', file=sys.stderr)
        return

    # evaluate
    templates = json.load(open(TEMPLATES))
    ok = wrong = flagged = 0
    rows = []
    for l in labels:
        if l.get('value') is None:  # merged fragments / non-labels
            continue
        if l.get('note', '').startswith(('IR SENSOR', 'qa m04')):
            continue  # boxes contain non-vocabulary text (IR SENSOR)
        box = [l['x0'], l['y0'], l['x1'], l['y1']]
        # a label split across two clusters: use the union bbox
        for frag in labels:
            if frag.get('merged_into') == l['index']:
                box = [min(box[0], frag['x0']), min(box[1], frag['y0']),
                       max(box[2], frag['x1']), max(box[3], frag['y1'])]
        def attempt(bx):
            variants = label_strokes(segs_all, tuple(bx))
            best = None
            for strokes in variants:
                s_, w_, t_, v_, obb_ = recognize_label(strokes, templates)
                rank = (0 if v_ else 1, w_)
                if best is None or rank < best[0]:
                    best = (rank, s_, w_, t_, v_, obb_)
            return best
        best = attempt(box)
        for grow in (0.9, 1.8, 2.8):
            grown = [box[0]-grow, box[1]-grow, box[2]+grow, box[3]+grow]
            b2 = attempt(grown)
            if b2 is None:
                continue
            if best is None or b2[0] < best[0]:
                best = b2   # strictly better (valid beats invalid, then score)
            elif (b2[4] and best[4] and len(b2[1]) > len(best[1])
                  and b2[1].startswith(best[1])):
                # the tight bbox truncated the label ('H=0' -> 'H=0.75'):
                # a valid extension of the current reading wins
                best = b2
            if best is not None and best[4] and best[2] <= 0.10 and grow >= 1.8:
                break
        if best is None:
            rows.append((l['index'], l['value'], None, 9.9, False, 'no strokes')); flagged += 1
            continue
        _, s, worst, ti, valid, obb = best
        if valid and worst <= 0.12:
            # completeness check: glyph-sized strokes just beyond the last
            # character mean the reading may be truncated ('H=0' of 'H=0.75')
            T = TRANSFORMS[ti]
            ox0, oy0, ox1, oy1, lh = obb
            sweep = [pts for bb, pts in segs_all
                     if in_bbox(bb, (box[0]-3, box[1]-3, box[2]+3, box[3]+3))]
            tail = 0
            for pts in sweep:
                q = pts @ T.T
                cx, cy = q.mean(axis=0)
                if ox1 + 0.02*lh < cx < ox1 + 1.3*lh and oy0 - 0.2*lh < cy < oy1 + 0.2*lh:
                    dim = max(q[:,0].max()-q[:,0].min(), q[:,1].max()-q[:,1].min())
                    if 0.1*lh < dim < 1.4*lh:
                        tail += 1
            if tail >= 2:
                worst = max(worst, 0.5)   # possibly truncated -> review
        got = None
        if valid:
            try: got = float(s[2:])
            except ValueError: pass
        expect = float(l['value'])
        correct = got is not None and abs(got - expect) < 1e-9
        confident = valid and worst <= 0.12
        if confident and correct:
            ok += 1
        elif confident and not correct:
            wrong += 1
            rows.append((l['index'], expect, s, round(worst, 3), 'SILENT WRONG'))
        else:
            flagged += 1
            rows.append((l['index'], expect, s, round(worst, 3),
                         'flagged, ' + ('correct' if correct else 'needs human')))
    total = ok + wrong + flagged
    print(f'\nauto-accepted correct: {ok}/{total} = {ok/total*100:.1f}%')
    print(f'flagged for review:    {flagged}  (safe: a human reads these)')
    print(f'SILENT WRONG:          {wrong}  (must be 0 for production)')
    for r in rows[:40]:
        print('  ', r)

if __name__ == '__main__':
    main()
