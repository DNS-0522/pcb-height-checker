# -*- coding: utf-8 -*-
"""Production pipeline: arbitrary DXF + STP -> board dataset for the web app.

Sub-commands (all write into --out DIR):
  overview  --dxf F           render full-sheet overview.jpg + overview.json (extents)
  stp       --stp F           OCP/XCAF world bboxes -> stp_world.json  (slow, minutes)
  extract   --dxf F --views overview_views.json
                              labels (vector glyph match, offline) + zones + registration
                              + dataset {meta,zones,components,labels}.json
  diff      --dxf A --dxf-b B render both revisions at identical extents and
                              compose a pixel diff -> a/b/diff.jpg + diff.json

Progress goes to stdout as lines "PROGRESS <percent> <message>" so the server
can stream it. Requires: ezdxf, numpy, matplotlib, scikit-image, cadquery-ocp,
and glyph_templates.json living next to this script.
"""
import sys, io, os, json, math, argparse, base64
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

def progress(pct, msg):
    print(f'PROGRESS {pct} {msg}', flush=True)

def contour_fit(outline_pts, mirror, board_mask, vb, scale, window):
    """Registration by board-shape matching: find the translation that best
    lays the STP board outline onto the DXF board blob boundary.

    outline_pts: Nx2 STP world XY points of the board contour.
    board_mask:  bool raster of the DXF board blob (view raster, walls incl.)
    window:      ((tx0,tx1),(ty0,ty1)) coarse search bounds from bbox pairing.
    Returns (tx, ty, mean_err_mm).
    """
    from scipy.ndimage import distance_transform_edt, binary_erosion
    boundary = board_mask & ~binary_erosion(board_mask, iterations=1)
    edt = distance_transform_edt(~boundary)   # px distance to nearest boundary px
    Hpx, Wpx = board_mask.shape
    pts = np.asarray(outline_pts, dtype=float)
    if mirror:
        pts = pts * np.array([-1.0, 1.0])
    def score(tx, ty):
        gx = (pts[:, 0] + tx - vb[0]) * scale
        gy = (Hpx - 1) - (pts[:, 1] + ty - vb[1]) * scale
        xi = np.clip(np.round(gx).astype(int), 0, Wpx - 1)
        yi = np.clip(np.round(gy).astype(int), 0, Hpx - 1)
        inb = (gx >= 0) & (gx < Wpx) & (gy >= 0) & (gy < Hpx)
        if inb.sum() < len(pts) * 0.5:
            return 1e9
        d = edt[yi[inb], xi[inb]]
        return float(np.mean(np.minimum(d, 30)))   # cap outliers (notches etc.)
    def dists(tx, ty, p):
        gx = (p[:, 0] + tx - vb[0]) * scale
        gy = (Hpx - 1) - (p[:, 1] + ty - vb[1]) * scale
        xi = np.clip(np.round(gx).astype(int), 0, Wpx - 1)
        yi = np.clip(np.round(gy).astype(int), 0, Hpx - 1)
        return edt[yi, xi]

    def search(p, seed=None):
        (tx0, tx1), (ty0, ty1) = window
        best = (1e18, seed[0] if seed else (tx0+tx1)/2, seed[1] if seed else (ty0+ty1)/2)
        stages = ((0.2, 1.2), (0.05, 0.3)) if seed else ((1.0, None), (0.2, 1.2), (0.05, 0.3))
        for step, span in stages:
            if span is None:
                txs = np.arange(tx0, tx1 + step, step)
                tys = np.arange(ty0, ty1 + step, step)
            else:
                txs = np.arange(best[1] - span, best[1] + span + step, step)
                tys = np.arange(best[2] - span, best[2] + span + step, step)
            for tx in txs:
                for ty in tys:
                    d = dists(tx, ty, p)
                    s = float(np.mean(np.minimum(d, 30)))
                    if s < best[0]:
                        best = (s, float(tx), float(ty))
        return best

    # pass 1: all points (holes included; they saturate at the cap)
    best = search(pts)
    # pass 2: keep only points that actually lie on the DXF board contour
    # (the STP point soup includes every drill hole, which has no DXF target)
    d = dists(best[1], best[2], pts)
    inlier = d < 1.5 * scale
    if inlier.sum() >= 100:
        best = search(pts[inlier], seed=(best[1], best[2]))
        d2 = dists(best[1], best[2], pts)
        inlier = d2 < 1.5 * scale
        err_mm = float(np.mean(d2[inlier])) / scale if inlier.any() else best[0] / scale
    else:
        err_mm = best[0] / scale
    return round(best[1], 2), round(best[2], 2), round(err_mm, 3), inlier

def glyph_erase_mask(shape, view_labels, segs_all, msp, vb, scale):
    """Pixels of recognised H-label glyph strokes, to be removed from the
    walls raster so text doesn't punch holes into or split zones.

    Two safeguards:
    - per label only strokes near the glyph-size median are chosen — corner
      arcs / boundary segments inside a polluted label bbox stay walls;
    - every NON-chosen piece of geometry (including long boundary lines the
      text may cross) forms a protect mask that the erase can never touch,
      so a real boundary is never nicked open.
    """
    import math as _m
    from skimage.morphology import binary_dilation
    Hpx, Wpx = shape

    def mark(mask, pts):
        xi = np.clip(np.round((pts[:, 0]-vb[0])*scale).astype(int), 0, Wpx-1)
        yi = np.clip(np.round((Hpx-1) - (pts[:, 1]-vb[1])*scale).astype(int), 0, Hpx-1)
        mask[yi, xi] = True

    glyph = np.zeros(shape, dtype=bool)
    protect = np.zeros(shape, dtype=bool)
    chosen = set()
    for l in view_labels:
        bx0, by0 = l['x0'] - 0.3, l['y0'] - 0.3
        bx1, by1 = l['x1'] + 0.3, l['y1'] + 0.3
        strokes = [(i, bb, pts) for i, (bb, pts) in enumerate(segs_all)
                   if bx0 <= (bb[0]+bb[2])/2 <= bx1 and by0 <= (bb[1]+bb[3])/2 <= by1]
        if not strokes:
            continue
        dims = sorted(max(bb[2]-bb[0], bb[3]-bb[1]) for _, bb, _ in strokes)
        med = dims[len(dims)//2]
        cap = min(1.5*med + 0.2, 0.95*max(bx1-bx0, by1-by0))
        for i, bb, pts in strokes:
            if max(bb[2]-bb[0], bb[3]-bb[1]) > cap:
                continue
            chosen.add(i)
            mark(glyph, pts)
    if not chosen:
        return np.zeros(shape, dtype=bool)
    # protect 1: all short strokes NOT chosen as glyphs
    for i, (bb, pts) in enumerate(segs_all):
        if i in chosen:
            continue
        if bb[2] < vb[0] or bb[0] > vb[2] or bb[3] < vb[1] or bb[1] > vb[3]:
            continue
        mark(protect, pts)
    # protect 2: long entities (boundary lines) — not present in segs_all
    for e in msp:
        t = e.dxftype()
        pts = None
        if t == 'LINE':
            a = np.array([e.dxf.start.x, e.dxf.start.y]); b = np.array([e.dxf.end.x, e.dxf.end.y])
            ln = float(np.hypot(*(b-a)))
            if ln <= 8.0: continue
            pts = np.linspace(a, b, max(2, int(ln/0.06)))
        elif t == 'ARC':
            r = e.dxf.radius
            a0, a1 = _m.radians(e.dxf.start_angle), _m.radians(e.dxf.end_angle)
            sweep = (a1-a0) % (2*_m.pi)
            if r*sweep <= 8.0: continue
            ang = a0 + np.linspace(0, sweep, max(4, int(r*sweep/0.06)))
            pts = np.stack([e.dxf.center.x + r*np.cos(ang), e.dxf.center.y + r*np.sin(ang)], axis=1)
        elif t == 'CIRCLE':
            r = e.dxf.radius
            if 2*_m.pi*r <= 8.0: continue
            ang = np.linspace(0, 2*_m.pi, max(8, int(2*_m.pi*r/0.06)))
            pts = np.stack([e.dxf.center.x + r*np.cos(ang), e.dxf.center.y + r*np.sin(ang)], axis=1)
        elif t == 'POLYLINE':
            vs = np.array([(p[0], p[1]) for p in e.points()])
            if len(vs) < 2: continue
            ln = float(np.hypot(*(vs[1:]-vs[:-1]).T).sum())
            if ln <= 8.0: continue
            chunks = []
            for k in range(len(vs)-1):
                seg = float(np.hypot(*(vs[k+1]-vs[k])))
                chunks.append(np.linspace(vs[k], vs[k+1], max(2, int(seg/0.06))))
            pts = np.concatenate(chunks)
        if pts is None: continue
        if pts[:, 0].max() < vb[0] or pts[:, 0].min() > vb[2]: continue
        if pts[:, 1].max() < vb[1] or pts[:, 1].min() > vb[3]: continue
        mark(protect, pts)
    glyph = binary_dilation(glyph, footprint=np.ones((3, 3)))
    protect = binary_dilation(protect, footprint=np.ones((3, 3)))
    return glyph & ~protect

def emit_debug(out, view, vb, scale, walls, comp_img, outside_id):
    """Per-view debug artifacts for the UI's zone-cutting debug mode:
    walls bitmap, randomly-coloured CC image, and per-zone outlines."""
    from PIL import Image
    from skimage import measure
    Hpx = comp_img.shape[0]
    Image.fromarray((~walls * 255).astype(np.uint8)).convert('L').save(
        os.path.join(out, f'debug_walls_{view}.png'))
    rng = np.random.default_rng(3)
    palette = rng.integers(60, 245, (comp_img.max() + 1, 3)).astype(np.uint8)
    palette[0] = (30, 30, 30)          # walls
    palette[outside_id] = (255, 255, 255)
    Image.fromarray(palette[comp_img]).save(os.path.join(out, f'debug_cc_{view}.png'))
    zones_dbg = []
    for rp in measure.regionprops(comp_img):
        if rp.label == outside_id: continue
        area_mm2 = rp.area / scale / scale
        if area_mm2 < 10: continue
        mask = comp_img[rp.bbox[0]:rp.bbox[2], rp.bbox[1]:rp.bbox[3]] == rp.label
        padded = np.pad(mask, 1)
        cs = measure.find_contours(padded.astype(float), 0.5)
        cs.sort(key=len, reverse=True)
        poly = []
        if cs:
            cont = measure.approximate_polygon(cs[0], tolerance=1.5) - 1
            poly = [[round(vb[0] + (rp.bbox[1] + p[1]) / scale, 2),
                     round(vb[1] + (Hpx - 1 - (rp.bbox[0] + p[0])) / scale, 2)]
                    for p in cont]
        zones_dbg.append({'id': f'{view}-{rp.label}', 'areaMm2': round(area_mm2, 1),
                          'polygon': poly})
    json.dump(zones_dbg, open(os.path.join(out, f'debug_zones_{view}.json'), 'w'))
    return len(zones_dbg)

def contour_fit_auto(outline_pts, board_mask, vb, scale, window_of):
    """Fit BOTH mirror hypotheses and pick by inlier fraction — drawings vary
    in whether the bottom view is flipped, so never assume."""
    results = {}
    for mirror in (False, True):
        tx, ty, err, inlier = contour_fit(outline_pts, mirror, board_mask, vb, scale,
                                          window_of(mirror))
        frac = float(inlier.mean()) if inlier is not None else 0.0
        results[mirror] = (frac, tx, ty, err, inlier)
    best_mirror = max(results, key=lambda m: results[m][0])
    frac, tx, ty, err, inlier = results[best_mirror]
    other = results[not best_mirror][0]
    return best_mirror, tx, ty, err, inlier, round(frac, 3), round(other, 3)

# ================================================================ overview
def cmd_overview(args):
    import ezdxf
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
    progress(5, '讀取 DXF…')
    doc = ezdxf.readfile(args.dxf)
    msp = doc.modelspace()
    xs, ys = [], []
    for e in msp:
        if e.dxftype() == 'LINE':
            xs += [e.dxf.start.x, e.dxf.end.x]; ys += [e.dxf.start.y, e.dxf.end.y]
    x0, x1 = min(xs), max(xs); y0, y1 = min(ys), max(ys)
    pad = 0.01 * max(x1-x0, y1-y0)
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    progress(30, '渲染全圖縮覽…')
    SCALE = min(3.0, 4200 / (x1-x0))
    dpi = 100
    fig = plt.figure(figsize=((x1-x0)*SCALE/dpi, (y1-y0)*SCALE/dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white')
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
    Frontend(RenderContext(doc), MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
    ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect('equal'); ax.axis('off')
    png = os.path.join(args.out, 'overview.png')
    fig.savefig(png, dpi=dpi, facecolor='white'); plt.close(fig)
    from PIL import Image
    im = Image.open(png).convert('RGB')
    im.save(os.path.join(args.out, 'overview.jpg'), 'JPEG', quality=80)
    os.remove(png)
    json.dump({'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1,
               'pxw': im.width, 'pxh': im.height},
              open(os.path.join(args.out, 'overview.json'), 'w'))
    progress(100, '縮覽完成')

# ================================================================ stp
def cmd_stp(args):
    progress(2, '載入 OpenCASCADE…')
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
    from OCP.TDF import TDF_LabelSequence
    from OCP.TDataStd import TDataStd_Name
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib

    doc = TDocStd_Document(TCollection_ExtendedString('d'))
    reader = STEPCAFControl_Reader()
    progress(5, '讀取 STEP 檔…')
    reader.ReadFile(args.stp)
    progress(35, '轉換組裝結構…(最耗時的一步)')
    reader.Transfer(doc)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    progress(70, '解算世界座標包圍盒…')

    def name_of(label):
        attr = TDataStd_Name()
        if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
            try:
                return TCollection_AsciiString(attr.Get()).ToCString()
            except Exception:
                return str(attr.Get().ToExtString())
        return ''

    rows = []
    def explore(label, loc, depth):
        if st.IsAssembly_s(label):
            comps = TDF_LabelSequence()
            st.GetComponents_s(label, comps)
            for i in range(1, comps.Length()+1):
                comp = comps.Value(i)
                cloc = loc.Multiplied(st.GetLocation_s(comp))
                ref = TDF_LabelSequence()
                orig = comp
                from OCP.TDF import TDF_Label
                refl = TDF_Label()
                if st.GetReferredShape_s(comp, refl):
                    orig = refl
                nm = name_of(comp) or name_of(orig)
                if st.IsAssembly_s(orig) and depth < 4:
                    explore(orig, cloc, depth+1)
                else:
                    shape = st.GetShape_s(orig)
                    if shape.IsNull():
                        continue
                    s2 = shape.Moved(cloc)
                    box = Bnd_Box()
                    BRepBndLib.Add_s(s2, box)
                    if box.IsVoid():
                        continue
                    p0 = box.CornerMin(); p1 = box.CornerMax()
                    rows.append({'name': nm, 'part': name_of(orig),
                                 'x0': p0.X(), 'y0': p0.Y(), 'z0': p0.Z(),
                                 'x1': p1.X(), 'y1': p1.Y(), 'z1': p1.Z()})
    from OCP.TopLoc import TopLoc_Location
    roots = TDF_LabelSequence()
    st.GetFreeShapes(roots)
    for i in range(1, roots.Length()+1):
        explore(roots.Value(i), TopLoc_Location(), 0)
    json.dump(rows, open(os.path.join(args.out, 'stp_world.json'), 'w'))

    # board outline XY contour (for contour-based registration + UI overlay):
    # sample every edge of the BOARD_OUTLINE shape, keep top-face points
    progress(90, '抽取板框輪廓…')
    try:
        outline_pts = []
        def find_board(label, loc, depth):
            if st.IsAssembly_s(label):
                comps = TDF_LabelSequence()
                st.GetComponents_s(label, comps)
                for i in range(1, comps.Length()+1):
                    comp = comps.Value(i)
                    cloc = loc.Multiplied(st.GetLocation_s(comp))
                    from OCP.TDF import TDF_Label
                    refl = TDF_Label()
                    orig = refl if st.GetReferredShape_s(comp, refl) else comp
                    nm = name_of(comp) or name_of(orig)
                    if nm == 'BOARD_OUTLINE' and not st.IsAssembly_s(orig):
                        return st.GetShape_s(orig).Moved(cloc)
                    if st.IsAssembly_s(orig) and depth < 4:
                        r = find_board(orig, cloc, depth+1)
                        if r is not None:
                            return r
            return None
        shp = None
        for i in range(1, roots.Length()+1):
            shp = find_board(roots.Value(i), TopLoc_Location(), 0)
            if shp is not None:
                break
        if shp is not None and not shp.IsNull():
            from OCP.TopExp import TopExp_Explorer
            from OCP.TopAbs import TopAbs_EDGE
            from OCP.BRepAdaptor import BRepAdaptor_Curve
            from OCP.GCPnts import GCPnts_QuasiUniformDeflection
            from OCP.TopoDS import TopoDS
            zmax = max(r['z1'] for r in rows if r['part'] == 'BOARD_OUTLINE') if any(
                r['part'] == 'BOARD_OUTLINE' for r in rows) else 0.0
            ex = TopExp_Explorer(shp, TopAbs_EDGE)
            while ex.More():
                try:
                    curve = BRepAdaptor_Curve(TopoDS.Edge_s(ex.Current()))
                    disc = GCPnts_QuasiUniformDeflection(curve, 0.2)
                    if disc.IsDone():
                        for k in range(1, disc.NbPoints()+1):
                            p = disc.Value(k)
                            if p.Z() > zmax - 0.1:   # top-face edges only
                                outline_pts.append([round(p.X(), 2), round(p.Y(), 2)])
                except Exception:
                    pass
                ex.Next()
        json.dump(outline_pts, open(os.path.join(args.out, 'board_outline_xy.json'), 'w'))
        progress(98, f'板框輪廓 {len(outline_pts)} 點')
    except Exception as e:
        print(f'[stp] outline extraction failed: {e}', flush=True)
        json.dump([], open(os.path.join(args.out, 'board_outline_xy.json'), 'w'))
    progress(100, f'STP 完成:{len(rows)} 個節點')

# ================================================================ extract
def cmd_extract(args):
    import ezdxf
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
    from skimage import measure
    from skimage.morphology import binary_dilation
    from collections import Counter
    import glyph_match as gm

    views = json.load(open(args.views, encoding='utf-8'))   # {TOP_LIMIT:[x0,y0,x1,y1], BOT_LIMIT:[...]}
    out = args.out
    progress(2, '讀取 DXF…')
    doc = ezdxf.readfile(args.dxf)
    msp = doc.modelspace()

    # ---- 1. label candidates: recursive-split clustering, two seg-length passes
    progress(8, '聚類 H 標註候選…')
    def seg_bb_len(e):
        # every entity type a glyph stroke can be: LINE/ARC, plus '0' glyphs
        # drawn as ELLIPSE, plus short POLYLINE strokes
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
            ln = sum(math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1])
                     for i in range(len(pts)-1))
            return (min(xs), min(ys), max(xs), max(ys)), ln
        return None, None

    segs = {v: [] for v in views}
    for e in msp:
        bb, ln = seg_bb_len(e)
        if bb is None or ln is None or ln == 0 or ln > 8.0:
            continue
        cx, cy = (bb[0]+bb[2])/2, (bb[1]+bb[3])/2
        for v, vb in views.items():
            if vb[0] <= cx <= vb[2] and vb[1] <= cy <= vb[3]:
                segs[v].append((bb, ln)); break

    def bb_gap(a, b):
        dx = max(0, max(a[0], b[0]) - min(a[2], b[2]))
        dy = max(0, max(a[1], b[1]) - min(a[3], b[3]))
        return math.hypot(dx, dy)

    def cluster(items, gap):
        n = len(items); parent = list(range(n))
        def find(i):
            while parent[i] != i: parent[i] = parent[parent[i]]; i = parent[i]
            return i
        order = sorted(range(n), key=lambda i: items[i][0])
        for a in range(n):
            i = order[a]
            for b in range(a+1, n):
                j = order[b]
                if items[j][0] - items[i][2] > gap: break
                if bb_gap(items[i], items[j]) <= gap: parent[find(i)] = find(j)
        groups = {}
        for i in range(n): groups.setdefault(find(i), []).append(items[i])
        return list(groups.values())

    def extract_clusters(bbs, gap=1.2, min_segs=5):
        outc = []
        for g in cluster(bbs, gap):
            if len(g) < min_segs: continue
            x0 = min(b[0] for b in g); y0 = min(b[1] for b in g)
            x1 = max(b[2] for b in g); y1 = max(b[3] for b in g)
            w, h = x1-x0, y1-y0
            if w < 0.8 or h < 0.8: continue
            if (w > 25 or h > 25) and gap > 0.25:
                outc += extract_clusters(g, gap*0.55, min_segs)
            elif w <= 25 and h <= 25:
                outc.append((x0, y0, x1, y1, len(g)))
        return outc

    candidates = []
    for v, items in segs.items():
        short = [bb for bb, ln in items if ln <= 4.0]
        cands = extract_clusters(short)
        # second pass for larger glyphs, non-overlapping only
        big = [bb for bb, ln in items if ln <= 8.0]
        for c in extract_clusters(big, gap=1.3, min_segs=6):
            if not any(c[0] <= e[2] and c[2] >= e[0] and c[1] <= e[3] and c[3] >= e[1]
                       for e in cands):
                cands.append(c)
        for c in cands:
            candidates.append({'view': v, 'x0': round(c[0], 2), 'y0': round(c[1], 2),
                               'x1': round(c[2], 2), 'y1': round(c[3], 2)})
    progress(18, f'{len(candidates)} 個候選,開始離線字形比對…')

    # ---- 2. read values with the vector glyph matcher
    segs_all = gm.collect_segments(msp)
    templates = json.load(open(os.path.join(HERE, 'glyph_templates.json')))
    labels = []

    def read_label(box):
        """Glyph-match one candidate bbox. Returns (s, worst, value) or None
        when the cluster is clearly geometry, not text."""
        def attempt(bx):
            best = None
            for strokes in gm.label_strokes(segs_all, tuple(bx)):
                s_, w_, t_, v_, obb_ = gm.recognize_label(strokes, templates)
                rank = (0 if v_ else 1, w_)
                if best is None or rank < best[0]:
                    best = (rank, s_, w_, t_, v_, obb_)
            return best
        best = attempt(box)
        for grow in (0.9, 1.8):
            grown = (box[0]-grow, box[1]-grow, box[2]+grow, box[3]+grow)
            b2 = attempt(grown)
            if b2 is None: continue
            if best is None or b2[0] < best[0]:
                best = b2
            elif (b2[4] and best[4] and len(b2[1]) > len(best[1])
                  and b2[1].startswith(best[1])):
                best = b2
            if best is not None and best[4] and best[2] <= 0.10 and grow >= 1.8:
                break
        if best is None:
            return None
        _, s, worst, ti, valid, obb = best
        # completeness check (truncation guard)
        if valid and worst <= 0.12:
            T = gm.TRANSFORMS[ti]
            ox0, oy0, ox1, oy1, lh = obb
            tail = 0
            for bb2, pts2 in segs_all:
                if not gm.in_bbox(bb2, (box[0]-3, box[1]-3, box[2]+3, box[3]+3)):
                    continue
                q = pts2 @ T.T
                cx, cy = q.mean(axis=0)
                if ox1 + 0.02*lh < cx < ox1 + 1.3*lh and oy0 - 0.2*lh < cy < oy1 + 0.2*lh:
                    dim = max(q[:,0].max()-q[:,0].min(), q[:,1].max()-q[:,1].min())
                    if 0.1*lh < dim < 1.4*lh:
                        tail += 1
            if tail >= 2:
                worst = max(worst, 0.5)
        value = None
        if valid and worst <= 0.12:
            try: value = float(s[2:])
            except ValueError: value = None
        if not valid and 'H' not in s and '=' not in s:
            return None   # geometry cluster, not a label
        return s, worst, value

    def add_label(view, box, s, worst, value):
        labels.append({'id': f'L{len(labels):03d}', 'view': view,
                       'x0': round(box[0], 2), 'y0': round(box[1], 2),
                       'x1': round(box[2], 2), 'y1': round(box[3], 2),
                       'cx': round((box[0]+box[2])/2, 2), 'cy': round((box[1]+box[3])/2, 2),
                       'read': s, 'score': round(worst, 3),
                       'value': value, 'flagged': value is None})
        return labels[-1]

    n_ok = n_flag = 0
    for k, c in enumerate(candidates):
        if k % 25 == 0:
            progress(18 + int(30 * k / max(1, len(candidates))), f'讀值 {k}/{len(candidates)}…')
        r = read_label((c['x0'], c['y0'], c['x1'], c['y1']))
        if r is None:
            continue
        s, worst, value = r
        add_label(c['view'], (c['x0'], c['y0'], c['x1'], c['y1']), s, worst, value)
        if value is None: n_flag += 1
        else: n_ok += 1
    progress(50, f'讀值完成:{n_ok} 自動、{n_flag} 待人工')

    # ---- 3. rasterize views, zone components, associate labels & board comps
    SCALE = 14
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
    ctx = RenderContext(doc)

    def rasterize(bb, scale):
        x0, y0, x1, y1 = bb
        dpi = 100
        fig = plt.figure(figsize=((x1-x0)*scale/dpi, (y1-y0)*scale/dpi), dpi=dpi)
        ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white')
        Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
        ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect('equal'); ax.axis('off')
        fig.canvas.draw()
        buf = np.asarray(fig.canvas.buffer_rgba())[:, :, :3]
        img = buf.copy()
        walls = buf.mean(axis=2) < 128
        plt.close(fig)
        return walls, img

    def save_view_jpg(img, name):
        from PIL import Image
        Image.fromarray(img).save(os.path.join(out, name), 'JPEG', quality=72)

    stp = json.load(open(os.path.join(out, 'stp_world.json'), encoding='utf-8'))
    board = next((r for r in stp if r['part'] == 'BOARD_OUTLINE' or r['name'] == 'BOARD_OUTLINE'), None)
    if board is None:
        print('ERROR STP 裡找不到 BOARD_OUTLINE', flush=True); sys.exit(2)
    comps_all = [r for r in stp if r is not board and r['part'] != 'BOARD_OUTLINE']
    BX0, BY0, BX1, BY1 = board['x0']-5, board['y0']-5, board['x1']+5, board['y1']+5
    mb = [c for c in comps_all
          if c['x1'] > BX0 and c['x0'] < BX1 and c['y1'] > BY0 and c['y0'] < BY1]
    thickness = board['z1'] - board['z0']
    for c in mb:
        if c['z0'] >= board['z0']/2 + board['z1']/2 - thickness/4 or c['z0'] >= -thickness/2 + board['z1']:
            pass
    # side/height relative to board z extents
    for c in mb:
        if c['z0'] >= board['z0'] + thickness/2:
            c['side'] = 'top'; c['h'] = c['z1'] - board['z1']
        else:
            c['side'] = 'bottom'; c['h'] = board['z0'] - c['z0']
        c['ph'] = abs((c['z1']-c['z0']) - 3.81) < 0.005

    zones_out, comps_out, meta_reg = [], [], {}
    for view, vb in views.items():
        side = 'top' if 'TOP' in view else 'bottom'
        mirror = 'BOT' in view
        vcomps = [c for c in mb if c['side'] == side]
        progress(55 if side == 'top' else 75, f'{view}:光柵化與區域分析…')
        walls, view_img = rasterize(vb, SCALE)
        save_view_jpg(view_img, f'view_{view}.jpg')
        # H-label glyph strokes are not zone boundaries: erase them BEFORE the
        # dilation (which re-closes any <=2px nick the erase leaves in a real line)
        walls &= ~glyph_erase_mask(walls.shape, [l for l in labels if l['view'] == view],
                                   segs_all, msp, vb, SCALE)
        walls = binary_dilation(walls, footprint=np.ones((3, 3)))
        comp_img = measure.label(~walls, connectivity=1)
        comp_area = np.bincount(comp_img.ravel())
        Hpx, Wpx = comp_img.shape
        border = Counter(list(comp_img[0, :]) + list(comp_img[-1, :]) +
                         list(comp_img[:, 0]) + list(comp_img[:, -1]))
        outside_id = border.most_common(1)[0][0]

        def comp_at(x, y):
            cpx = int(round((x - vb[0]) * SCALE)); rpx = int(round(Hpx - 1 - (y - vb[1]) * SCALE))
            if 0 <= rpx < Hpx and 0 <= cpx < Wpx:
                return comp_img[rpx, cpx]
            return 0

        # label -> zone (tiered sampling)
        ring = ((-1,0),(1,0),(0,-1),(0,1),(-1,-1),(1,-1),(-1,1),(1,1))
        used_zones = {}
        def associate(l):
            mx = (l['x1']-l['x0'])/2 + 1.0; my = (l['y1']-l['y0'])/2 + 1.0
            tiers = [[(l['cx'], l['cy'])],
                     [(l['cx']+dx*mx*0.5, l['cy']+dy*my*0.5) for dx, dy in ring],
                     [(l['cx']+dx*mx, l['cy']+dy*my) for dx, dy in ring]]
            zid = None
            ti_used = None
            for tier_i, pts in enumerate(tiers):
                votes = Counter()
                for x, y in pts:
                    cid = comp_at(x, y)
                    if cid and cid != outside_id and comp_area[cid] >= 3*SCALE*SCALE:
                        votes[cid] += 1
                if votes:
                    bestn = max(votes.values())
                    zid = min((cid for cid, n in votes.items() if n == bestn),
                              key=lambda cid: comp_area[cid])
                    ti_used = tier_i
                    break
            l['zoneId'] = f'{view}-{zid}' if zid else None
            l['assocTier'] = ti_used
            if zid:
                used_zones.setdefault(zid, [])
        for l in labels:
            if l['view'] == view:
                associate(l)

        n_dbg = emit_debug(out, view, vb, SCALE, walls, comp_img, outside_id)
        print(f'[debug] {view}: {n_dbg} zones >=10mm2', flush=True)

        # ---- second harvest: a sizable zone with NO label but with text-like
        # strokes inside means the candidate clustering missed its label
        # (large banner fonts etc.) — retry inside that zone's bbox, relaxed.
        labeled_ids = {int(l['zoneId'].split('-')[-1]) for l in labels
                       if l['view'] == view and l.get('zoneId')}
        harvested = 0
        for rp in measure.regionprops(comp_img):
            zid = rp.label
            if zid == outside_id or zid in labeled_ids: continue
            if rp.area < 80 * SCALE * SCALE: continue        # ≥80mm² only
            r0_, c0_, r1_, c1_ = rp.bbox
            zx0 = vb[0] + c0_/SCALE; zx1 = vb[0] + c1_/SCALE
            zy0 = vb[1] + (Hpx-1-r1_)/SCALE; zy1 = vb[1] + (Hpx-1-r0_)/SCALE
            zone_segs = [(bb, ln) for bb, ln in segs[view]
                         if zx0-0.5 <= (bb[0]+bb[2])/2 <= zx1+0.5
                         and zy0-0.5 <= (bb[1]+bb[3])/2 <= zy1+0.5]
            if len(zone_segs) < 5: continue
            cands2 = extract_clusters([bb for bb, ln in zone_segs], gap=1.5, min_segs=4)
            for cd in cands2:
                if any(cd[0] <= l['x1'] and cd[2] >= l['x0'] and cd[1] <= l['y1'] and cd[3] >= l['y0']
                       for l in labels if l['view'] == view):
                    continue
                r = read_label((cd[0], cd[1], cd[2], cd[3]))
                if r is None: continue
                s, worst, value = r
                l = add_label(view, cd, s, worst, value)
                associate(l)
                harvested += 1
        if harvested:
            progress(60 if 'TOP' in view else 80, f'{view}:二次搜尋補回 {harvested} 個標註')

        # zone inventory: every zone >=10mm2 PLUS any smaller zone a label
        # claimed — zones without a value become the user's review queue
        inventory = set(used_zones)
        for rp in measure.regionprops(comp_img):
            if rp.label != outside_id and rp.area >= 10 * SCALE * SCALE:
                inventory.add(rp.label)
        for zid in inventory:
            mask = comp_img == zid
            padded = np.pad(mask, 1)
            cs = measure.find_contours(padded.astype(float), 0.5)
            cs.sort(key=len, reverse=True)
            poly = []
            if cs:
                cont = measure.approximate_polygon(cs[0], tolerance=1.2) - 1
                poly = [[round(vb[0] + p[1]/SCALE, 2), round(vb[1] + (Hpx-1-p[0])/SCALE, 2)]
                        for p in cont]
            zones_out.append({'id': f'{view}-{zid}', 'view': view,
                              'areaMm2': round(float(mask.sum())/SCALE/SCALE, 1),
                              'polygon': poly})

        # ---- registration: fit the STP board contour onto the DXF board blob
        inside = comp_img != outside_id
        blobs = measure.label(inside, connectivity=1)
        areas = np.bincount(blobs.ravel()); areas[0] = 0
        bigb = int(np.argmax(areas))
        maskb = blobs == bigb
        rows_any = np.any(maskb, axis=1); cols_any = np.any(maskb, axis=0)
        r0 = int(np.argmax(rows_any)); r1 = len(rows_any)-1-int(np.argmax(rows_any[::-1]))
        c0 = int(np.argmax(cols_any)); c1 = len(cols_any)-1-int(np.argmax(cols_any[::-1]))
        dbb = [vb[0]+c0/SCALE, vb[1]+(Hpx-1-r1)/SCALE, vb[0]+c1/SCALE, vb[1]+(Hpx-1-r0)/SCALE]
        def window_of(m):
            if m:
                ctx_ = [dbb[0] + board['x1'], dbb[2] + board['x0']]
            else:
                ctx_ = [dbb[0] - board['x0'], dbb[2] - board['x1']]
            cty_ = [dbb[1] - board['y0'], dbb[3] - board['y1']]
            return ((min(ctx_)-4, max(ctx_)+4), (min(cty_)-4, max(cty_)+4))
        outline_path = os.path.join(out, 'board_outline_xy.json')
        outline_pts = json.load(open(outline_path)) if os.path.exists(outline_path) else []
        if len(outline_pts) >= 50:
            # mirror is decided by the data (drawings differ in whether the
            # bottom view is flipped); inlier fraction picks the hypothesis
            mirror, tx, ty, fit_err, inlier, frac, other = contour_fit_auto(
                outline_pts, maskb, vb, SCALE, window_of)
            print(f'[register] {view}: mirror={mirror} (inlier {frac} vs {other})', flush=True)
        else:  # fallback: bbox-centre pairing, keep the view-name guess
            (wx0_, wx1_), (wy0_, wy1_) = window_of(mirror)
            tx = (wx0_+wx1_)/2; ty = (wy0_+wy1_)/2
            fit_err = None; inlier = None
        # alignment visuals for the UI
        padded = np.pad(maskb, 1)
        cs = measure.find_contours(padded.astype(float), 0.5)
        cs.sort(key=len, reverse=True)
        outline = []
        if cs:
            cont = measure.approximate_polygon(cs[0], tolerance=1.5) - 1
            outline = [[round(vb[0] + p[1]/SCALE, 2), round(vb[1] + (Hpx-1-p[0])/SCALE, 2)]
                       for p in cont]
        sx = -1.0 if mirror else 1.0
        disp = ([p for p, ok in zip(outline_pts, inlier) if ok]
                if inlier is not None else outline_pts)
        disp = disp[::max(1, len(disp)//800)]
        stp_outline = [[round(sx*p[0] + tx, 2), round(p[1] + ty, 2)] for p in disp]
        meta_reg[view] = {'tx': round(tx, 2), 'ty': round(ty, 2), 'mirror': mirror,
                          'fitErrMm': fit_err,
                          'dxfBoardOutline': outline, 'stpBoardOutline': stp_outline}

        # ---- components -> zone membership
        for c in vcomps:
            ex0, ex1 = ((-c['x1'], -c['x0']) if mirror else (c['x0'], c['x1']))
            gx0, gx1 = ex0 + tx, ex1 + tx
            gy0, gy1 = c['y0'] + ty, c['y1'] + ty
            gcx, gcy = (gx0+gx1)/2, (gy0+gy1)/2
            zid = comp_at(gcx, gcy)
            if not zid or zid == outside_id:
                for qx, qy in ((gx0+1, gy0+1), (gx1-1, gy0+1), (gx0+1, gy1-1), (gx1-1, gy1-1)):
                    zid = comp_at(qx, qy)
                    if zid and zid != outside_id: break
            comps_out.append({'id': c['name'], 'footprint': c['part'],
                              'side': side, 'view': view,
                              'h': round(c['h'], 3), 'placeholder': c['ph'],
                              'zoneId': f'{view}-{zid}' if zid and zid != outside_id else None,
                              'box': [round(gx0, 2), round(gy0, 2), round(gx1, 2), round(gy1, 2)]})

    # keep zone polygons also for zones that only components reference
    have = {z['id'] for z in zones_out}
    # (component-only zones stay polygon-less; the UI colours zones by label value anyway)

    # ---- flagged label crops (base64 jpg) from a 25px/mm master raster
    progress(90, '產生待確認標註小圖…')
    from PIL import Image
    for view, vb in views.items():
        flagged = [l for l in labels if l['view'] == view and l['flagged']]
        if not flagged: continue
        _, img = rasterize(vb, 25)
        Hpx = img.shape[0]
        for l in flagged:
            m = 1.2
            cx0 = max(0, int((l['x0']-m-vb[0])*25)); cx1 = min(img.shape[1], int((l['x1']+m-vb[0])*25))
            cy1 = min(Hpx, int(Hpx-(l['y0']-m-vb[1])*25)); cy0 = max(0, int(Hpx-(l['y1']+m-vb[1])*25))
            crop = img[cy0:cy1, cx0:cx1]
            if crop.size == 0: continue
            # actual crop extent in sheet mm, so the UI can highlight the label
            l['cropBox'] = [round(vb[0]+cx0/25, 2), round(vb[1]+(Hpx-cy1)/25, 2),
                            round(vb[0]+cx1/25, 2), round(vb[1]+(Hpx-cy0)/25, 2)]
            im = Image.fromarray(crop)
            if im.width > 360:
                im = im.resize((360, int(im.height*360/im.width)))
            buf = io.BytesIO()
            im.save(buf, 'JPEG', quality=80)
            l['crop'] = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()

    # ---- dataset
    title = os.path.splitext(os.path.basename(args.dxf))[0]
    jobinfo_path = os.path.join(out, 'jobinfo.json')
    if os.path.exists(jobinfo_path):   # uploads are renamed input.dxf — use the original name
        try:
            title = os.path.splitext(json.load(open(jobinfo_path, encoding='utf-8'))['dxfName'])[0]
        except Exception:
            pass
    meta = {
        'boardId': os.path.basename(out),
        'title': title,
        'dxf': os.path.basename(args.dxf),
        'stp': args.stp and os.path.basename(args.stp) or '',
        'board': {'width': round(board['x1']-board['x0'], 2),
                  'depth': round(board['y1']-board['y0'], 2),
                  'thickness': round(thickness, 3)},
        'views': views,
        'registration': {**meta_reg, 'accuracyMm': 1.0},
        'decisionsApplied': ['同區多標註取較低 H 值(可於標註面板覆寫)'],
        'pendingDecisions': [],
    }
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(zones_out, open(os.path.join(out, 'zones.json'), 'w', encoding='utf-8'))
    json.dump(comps_out, open(os.path.join(out, 'components.json'), 'w', encoding='utf-8'))
    json.dump(labels, open(os.path.join(out, 'labels.json'), 'w', encoding='utf-8'))
    progress(100, f'完成:{len(labels)} 標註({n_flag} 待確認)、{len(zones_out)} 區、{len(comps_out)} 零件')

def cmd_alignment(args):
    """Backfill view background images + board outlines into an existing dataset."""
    import ezdxf
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
    from skimage import measure
    from collections import Counter
    from PIL import Image

    out = args.out
    meta = json.load(open(os.path.join(out, 'meta.json'), encoding='utf-8'))
    views = meta['views']
    board = None
    stp_path = os.path.join(out, 'stp_world.json')
    if os.path.exists(stp_path):
        stp = json.load(open(stp_path, encoding='utf-8'))
        board = next((r for r in stp if r['part'] == 'BOARD_OUTLINE' or r['name'] == 'BOARD_OUTLINE'), None)
    SCALE = 14
    doc = ezdxf.readfile(args.dxf)
    msp = doc.modelspace()
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
    ctx = RenderContext(doc)
    for view, vb in views.items():
        progress(10, f'{view} 底圖…')
        dpi = 100
        fig = plt.figure(figsize=((vb[2]-vb[0])*SCALE/dpi, (vb[3]-vb[1])*SCALE/dpi), dpi=dpi)
        ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white')
        Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
        ax.set_xlim(vb[0], vb[2]); ax.set_ylim(vb[1], vb[3]); ax.set_aspect('equal'); ax.axis('off')
        fig.canvas.draw()
        buf = np.asarray(fig.canvas.buffer_rgba())[:, :, :3]
        img = buf.copy(); walls = buf.mean(axis=2) < 128
        plt.close(fig)
        Image.fromarray(img).save(os.path.join(out, f'view_{view}.jpg'), 'JPEG', quality=72)
        comp_img = measure.label(~walls, connectivity=1)
        Hpx = comp_img.shape[0]
        border = Counter(list(comp_img[0, :]) + list(comp_img[-1, :]) +
                         list(comp_img[:, 0]) + list(comp_img[:, -1]))
        outside_id = border.most_common(1)[0][0]
        blobs = measure.label(comp_img != outside_id, connectivity=1)
        areas = np.bincount(blobs.ravel()); areas[0] = 0
        maskb = blobs == int(np.argmax(areas))
        padded = np.pad(maskb, 1)
        cs = measure.find_contours(padded.astype(float), 0.5)
        cs.sort(key=len, reverse=True)
        outline = []
        if cs:
            cont = measure.approximate_polygon(cs[0], tolerance=1.5) - 1
            outline = [[round(vb[0] + p[1]/SCALE, 2), round(vb[1] + (Hpx-1-p[0])/SCALE, 2)]
                       for p in cont]
        reg = meta['registration'].get(view, {})
        reg['dxfBoardOutline'] = outline
        if board and 'tx' in reg:
            tx, ty, mirror = reg['tx'], reg['ty'], reg.get('mirror', False)
            if mirror:
                reg['stpBoardRect'] = [round(tx - board['x1'], 2), round(board['y0'] + ty, 2),
                                       round(tx - board['x0'], 2), round(board['y1'] + ty, 2)]
            else:
                reg['stpBoardRect'] = [round(board['x0'] + tx, 2), round(board['y0'] + ty, 2),
                                       round(board['x1'] + tx, 2), round(board['y1'] + ty, 2)]
        meta['registration'][view] = reg
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    progress(100, 'alignment 回填完成')

def cmd_register(args):
    """Re-run registration (contour fit) + component zone mapping on an
    existing dataset, keeping labels/zones. Use after fixing registration."""
    import ezdxf
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
    from skimage import measure
    from skimage.morphology import binary_dilation
    from collections import Counter
    from PIL import Image

    out = args.out
    meta = json.load(open(os.path.join(out, 'meta.json'), encoding='utf-8'))
    views = meta['views']
    stp = json.load(open(os.path.join(out, 'stp_world.json'), encoding='utf-8'))
    board = next(r for r in stp if r['part'] == 'BOARD_OUTLINE' or r['name'] == 'BOARD_OUTLINE')
    comps_all = [r for r in stp if r['part'] != 'BOARD_OUTLINE' and r['name'] != 'BOARD_OUTLINE']
    BX0, BY0, BX1, BY1 = board['x0']-5, board['y0']-5, board['x1']+5, board['y1']+5
    mb = [c for c in comps_all
          if c['x1'] > BX0 and c['x0'] < BX1 and c['y1'] > BY0 and c['y0'] < BY1]
    thickness = board['z1'] - board['z0']
    for c in mb:
        if c['z0'] >= board['z0'] + thickness/2:
            c['side'] = 'top'; c['h'] = c['z1'] - board['z1']
        else:
            c['side'] = 'bottom'; c['h'] = board['z0'] - c['z0']
        c['ph'] = abs((c['z1']-c['z0']) - 3.81) < 0.005

    SCALE = 14
    doc = ezdxf.readfile(args.dxf)
    msp = doc.modelspace()
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
    ctx = RenderContext(doc)
    outline_path = os.path.join(out, 'board_outline_xy.json')
    outline_pts = json.load(open(outline_path)) if os.path.exists(outline_path) else []
    labels_path = os.path.join(out, 'labels.json')
    all_labels = json.load(open(labels_path, encoding='utf-8')) if os.path.exists(labels_path) else []
    segs_all = None
    if all_labels:
        import glyph_match as gm
        progress(10, '收集字形筆畫(抹除用)…')
        segs_all = gm.collect_segments(msp)
    comps_out = []
    meta_reg = {}
    for view, vb in views.items():
        side = 'top' if 'TOP' in view else 'bottom'
        mirror = 'BOT' in view
        vcomps = [c for c in mb if c['side'] == side]
        progress(20 if side == 'top' else 60, f'{view}:光柵化+輪廓對位…')
        dpi = 100
        fig = plt.figure(figsize=((vb[2]-vb[0])*SCALE/dpi, (vb[3]-vb[1])*SCALE/dpi), dpi=dpi)
        ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white')
        Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
        ax.set_xlim(vb[0], vb[2]); ax.set_ylim(vb[1], vb[3]); ax.set_aspect('equal'); ax.axis('off')
        fig.canvas.draw()
        buf = np.asarray(fig.canvas.buffer_rgba())[:, :, :3]
        img = buf.copy(); walls = buf.mean(axis=2) < 128
        plt.close(fig)
        Image.fromarray(img).save(os.path.join(out, f'view_{view}.jpg'), 'JPEG', quality=72)
        if segs_all is not None:
            walls &= ~glyph_erase_mask(walls.shape, [l for l in all_labels if l['view'] == view],
                                       segs_all, msp, vb, SCALE)
        walls = binary_dilation(walls, footprint=np.ones((3, 3)))
        comp_img = measure.label(~walls, connectivity=1)
        Hpx, Wpx = comp_img.shape
        border = Counter(list(comp_img[0, :]) + list(comp_img[-1, :]) +
                         list(comp_img[:, 0]) + list(comp_img[:, -1]))
        outside_id = border.most_common(1)[0][0]
        inside = comp_img != outside_id
        blobs = measure.label(inside, connectivity=1)
        areas = np.bincount(blobs.ravel()); areas[0] = 0
        maskb = blobs == int(np.argmax(areas))
        rows_any = np.any(maskb, axis=1); cols_any = np.any(maskb, axis=0)
        r0 = int(np.argmax(rows_any)); r1 = len(rows_any)-1-int(np.argmax(rows_any[::-1]))
        c0 = int(np.argmax(cols_any)); c1 = len(cols_any)-1-int(np.argmax(cols_any[::-1]))
        dbb = [vb[0]+c0/SCALE, vb[1]+(Hpx-1-r1)/SCALE, vb[0]+c1/SCALE, vb[1]+(Hpx-1-r0)/SCALE]
        def window_of(m):
            if m:
                ctx_ = [dbb[0] + board['x1'], dbb[2] + board['x0']]
            else:
                ctx_ = [dbb[0] - board['x0'], dbb[2] - board['x1']]
            cty_ = [dbb[1] - board['y0'], dbb[3] - board['y1']]
            return ((min(ctx_)-4, max(ctx_)+4), (min(cty_)-4, max(cty_)+4))
        mirror, tx, ty, fit_err, inlier, frac, other = contour_fit_auto(
            outline_pts, maskb, vb, SCALE, window_of)
        print(f'[register] {view}: mirror={mirror} (inlier {frac} vs {other})', flush=True)
        progress(40 if side == 'top' else 80, f'{view}: T=({tx},{ty}) fit={fit_err}mm')

        padded = np.pad(maskb, 1)
        cs = measure.find_contours(padded.astype(float), 0.5)
        cs.sort(key=len, reverse=True)
        outline = []
        if cs:
            cont = measure.approximate_polygon(cs[0], tolerance=1.5) - 1
            outline = [[round(vb[0] + p[1]/SCALE, 2), round(vb[1] + (Hpx-1-p[0])/SCALE, 2)]
                       for p in cont]
        sx = -1.0 if mirror else 1.0
        disp = [p for p, ok in zip(outline_pts, inlier) if ok] if inlier is not None else outline_pts
        disp = disp[::max(1, len(disp)//800)]
        stp_outline = [[round(sx*p[0] + tx, 2), round(p[1] + ty, 2)] for p in disp]
        meta_reg[view] = {'tx': tx, 'ty': ty, 'mirror': mirror, 'fitErrMm': fit_err,
                          'dxfBoardOutline': outline, 'stpBoardOutline': stp_outline}

        def comp_at(x, y):
            cpx = int(round((x - vb[0]) * SCALE)); rpx = int(round(Hpx - 1 - (y - vb[1]) * SCALE))
            if 0 <= rpx < Hpx and 0 <= cpx < Wpx:
                return comp_img[rpx, cpx]
            return 0
        for c in vcomps:
            ex0, ex1 = ((-c['x1'], -c['x0']) if mirror else (c['x0'], c['x1']))
            gx0, gx1 = ex0 + tx, ex1 + tx
            gy0, gy1 = c['y0'] + ty, c['y1'] + ty
            gcx, gcy = (gx0+gx1)/2, (gy0+gy1)/2
            zid = comp_at(gcx, gcy)
            if not zid or zid == outside_id:
                for qx, qy in ((gx0+1, gy0+1), (gx1-1, gy0+1), (gx0+1, gy1-1), (gx1-1, gy1-1)):
                    zid = comp_at(qx, qy)
                    if zid and zid != outside_id: break
            comps_out.append({'id': c['name'], 'footprint': c['part'],
                              'side': side, 'view': view,
                              'h': round(c['h'], 3), 'placeholder': c['ph'],
                              'zoneId': f'{view}-{zid}' if zid and zid != outside_id else None,
                              'box': [round(gx0, 2), round(gy0, 2), round(gx1, 2), round(gy1, 2)]})

    meta['registration'] = {**meta_reg, 'accuracyMm': max(
        (meta_reg[v].get('fitErrMm') or 1.0) for v in meta_reg)}
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(comps_out, open(os.path.join(out, 'components.json'), 'w', encoding='utf-8'))
    progress(100, f'register 完成:{len(comps_out)} 零件重新歸區')

def cmd_diff(args):
    """Revision diff: render two DXFs at identical extents/scale and compose a
    pixel diff (gray = unchanged, red = only in A/old, green = only in B/new).
    Writes a.jpg / b.jpg / diff.jpg + diff.json (extents, stats, change regions).
    Assumes both revisions share the sheet coordinate system (same CAD export)."""
    import ezdxf
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
    from skimage.morphology import binary_dilation
    from skimage import measure
    from PIL import Image

    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
    docs = []
    for i, path in enumerate([args.dxf, args.dxf_b]):
        progress(3 + i * 4, f'讀取{"舊版" if i == 0 else "新版"} DXF…')
        docs.append(ezdxf.readfile(path))
    xs, ys = [], []
    for doc in docs:
        for e in doc.modelspace():
            if e.dxftype() == 'LINE':
                xs += [e.dxf.start.x, e.dxf.end.x]; ys += [e.dxf.start.y, e.dxf.end.y]
    if not xs:
        print('ERROR 兩個 DXF 都沒有 LINE 實體,無法決定圖面範圍', flush=True)
        sys.exit(2)
    x0, x1 = min(xs), max(xs); y0, y1 = min(ys), max(ys)
    pad = 0.01 * max(x1 - x0, y1 - y0)
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    SCALE = min(3.0, 4200 / (x1 - x0))
    dpi = 100
    walls = []
    for i, doc in enumerate(docs):
        progress(12 + i * 34, f'渲染{"舊版" if i == 0 else "新版"}…')
        fig = plt.figure(figsize=((x1-x0)*SCALE/dpi, (y1-y0)*SCALE/dpi), dpi=dpi)
        ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white')
        Frontend(RenderContext(doc), MatplotlibBackend(ax), config=cfg).draw_layout(
            doc.modelspace(), finalize=False)
        ax.set_xlim(x0, x1); ax.set_ylim(y0, y1); ax.set_aspect('equal'); ax.axis('off')
        fig.canvas.draw()
        buf = np.asarray(fig.canvas.buffer_rgba())[:, :, :3]
        walls.append(buf.mean(axis=2) < 128)
        Image.fromarray(buf.copy()).save(
            os.path.join(args.out, f'{"ab"[i]}.jpg'), 'JPEG', quality=75)
        plt.close(fig)
    a, b = walls
    progress(82, '計算像素差異…')
    # 1px tolerance kills the anti-alias fringe of unchanged strokes
    d3 = np.ones((3, 3), dtype=bool)
    only_a = a & ~binary_dilation(b, footprint=d3)
    only_b = b & ~binary_dilation(a, footprint=d3)
    both = (a | b) & ~only_a & ~only_b
    Hpx, Wpx = a.shape
    img = np.full((Hpx, Wpx, 3), 255, np.uint8)
    img[both] = (148, 155, 164)
    img[only_a] = (225, 29, 72)
    img[only_b] = (22, 163, 74)
    Image.fromarray(img).save(os.path.join(args.out, 'diff.jpg'), 'JPEG', quality=80)
    progress(90, '聚類差異區域…')
    changed = only_a | only_b
    merged = binary_dilation(changed, footprint=np.ones((9, 9)))   # merge nearby marks
    lab = measure.label(merged, connectivity=2)
    regions = []
    for rp in measure.regionprops(lab):
        r0, c0, r1, c1 = rp.bbox
        na = int(only_a[r0:r1, c0:c1].sum()); nb = int(only_b[r0:r1, c0:c1].sum())
        if na + nb < 30:
            continue    # a few stray pixels, not a real change
        regions.append({
            'x0': round(x0 + c0 / SCALE, 2), 'y0': round(y0 + (Hpx - r1) / SCALE, 2),
            'x1': round(x0 + c1 / SCALE, 2), 'y1': round(y0 + (Hpx - r0) / SCALE, 2),
            'removedPx': na, 'addedPx': nb,
        })
    regions.sort(key=lambda r: -(r['removedPx'] + r['addedPx']))
    json.dump({'x0': round(x0, 2), 'y0': round(y0, 2), 'x1': round(x1, 2), 'y1': round(y1, 2),
               'pxw': Wpx, 'pxh': Hpx,
               'removedPx': int(only_a.sum()), 'addedPx': int(only_b.sum()),
               'regions': regions[:300], 'regionsTotal': len(regions)},
              open(os.path.join(args.out, 'diff.json'), 'w'))
    progress(100, f'比對完成:{len(regions)} 個差異區域')

def cmd_carryover(args):
    """DXF-replacement carry-over: diff the previous revision (--dxf-b) against
    the new one (--dxf) inside each Limit view, then migrate the human work
    from the prev dataset (prev_zones/prev_labels/prev_zone_overrides.json in
    --out) onto the freshly-extracted dataset:
      - zone overrides migrate onto IoU-matched zones NOT touched by any change;
      - matched-but-changed zones become review suggestions (old value shown);
      - manually-filled label values migrate onto position-matched flagged
        labels in unchanged spots.
    Writes zone_overrides.json / labels.json / carryover.json."""
    import ezdxf
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
    from skimage.morphology import binary_dilation
    from skimage.draw import polygon as sk_polygon

    out = args.out
    meta = json.load(open(os.path.join(out, 'meta.json'), encoding='utf-8'))
    views = meta['views']
    zones = json.load(open(os.path.join(out, 'zones.json'), encoding='utf-8'))
    labels = json.load(open(os.path.join(out, 'labels.json'), encoding='utf-8'))
    prev_zones = json.load(open(os.path.join(out, 'prev_zones.json'), encoding='utf-8'))
    prev_labels = json.load(open(os.path.join(out, 'prev_labels.json'), encoding='utf-8'))
    ov_path = os.path.join(out, 'prev_zone_overrides.json')
    prev_over = json.load(open(ov_path, encoding='utf-8')) if os.path.exists(ov_path) else {}

    SCALE = 14
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)

    def render_walls(doc, ctx, vb):
        dpi = 100
        fig = plt.figure(figsize=((vb[2]-vb[0])*SCALE/dpi, (vb[3]-vb[1])*SCALE/dpi), dpi=dpi)
        ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white')
        Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(doc.modelspace(), finalize=False)
        ax.set_xlim(vb[0], vb[2]); ax.set_ylim(vb[1], vb[3]); ax.set_aspect('equal'); ax.axis('off')
        fig.canvas.draw()
        w = np.asarray(fig.canvas.buffer_rgba())[:, :, :3].mean(axis=2) < 128
        plt.close(fig)
        return w

    def poly_iou(p1, p2):
        pts1 = np.asarray(p1, float); pts2 = np.asarray(p2, float)
        if len(pts1) < 3 or len(pts2) < 3:
            return 0.0
        S = 2.0
        bx0 = min(pts1[:, 0].min(), pts2[:, 0].min()); bx1 = max(pts1[:, 0].max(), pts2[:, 0].max())
        by0 = min(pts1[:, 1].min(), pts2[:, 1].min()); by1 = max(pts1[:, 1].max(), pts2[:, 1].max())
        W = max(2, int((bx1-bx0)*S)+2); H = max(2, int((by1-by0)*S)+2)
        masks = []
        for pts in (pts1, pts2):
            m = np.zeros((H, W), bool)
            rr, cc = sk_polygon((pts[:, 1]-by0)*S, (pts[:, 0]-bx0)*S, (H, W))
            m[rr, cc] = True
            masks.append(m)
        union = (masks[0] | masks[1]).sum()
        return float((masks[0] & masks[1]).sum() / union) if union else 0.0

    progress(5, '讀取新舊 DXF…')
    doc_new = ezdxf.readfile(args.dxf)
    doc_prev = ezdxf.readfile(args.dxf_b)
    ctx_new = RenderContext(doc_new)
    ctx_prev = RenderContext(doc_prev)

    changed_zone_ids = set()
    changed_masks = {}
    for vi, (view, vb) in enumerate(views.items()):
        progress(10 + vi*30, f'{view}:渲染新舊版並比對…')
        w_new = render_walls(doc_new, ctx_new, vb)
        w_prev = render_walls(doc_prev, ctx_prev, vb)
        d3 = np.ones((3, 3), dtype=bool)
        changed = (w_prev & ~binary_dilation(w_new, footprint=d3)) \
                | (w_new & ~binary_dilation(w_prev, footprint=d3))
        changed = binary_dilation(changed, footprint=np.ones((5, 5)))
        changed_masks[view] = (changed, vb)
        Hpx, Wpx = changed.shape
        for z in zones:
            if z['view'] != view or len(z.get('polygon') or []) < 3:
                continue
            pts = np.asarray(z['polygon'], float)
            rr, cc = sk_polygon(
                np.clip((Hpx - 1) - (pts[:, 1] - vb[1]) * SCALE, 0, Hpx - 1),
                np.clip((pts[:, 0] - vb[0]) * SCALE, 0, Wpx - 1), (Hpx, Wpx))
            if changed[rr, cc].sum() >= 20:
                changed_zone_ids.add(z['id'])

    def centroid(poly):
        pts = np.asarray(poly, float)
        return pts[:, 0].mean(), pts[:, 1].mean()

    progress(72, '配對新舊區域…')
    new_over, migrated, review = {}, [], []
    prev_by_view = {}
    for pz in prev_zones:
        if len(pz.get('polygon') or []) >= 3:
            prev_by_view.setdefault(pz['view'], []).append(pz)
    for z in zones:
        if len(z.get('polygon') or []) < 3:
            continue
        zc = centroid(z['polygon'])
        best, best_iou = None, 0.0
        for pz in prev_by_view.get(z['view'], []):
            pc = centroid(pz['polygon'])
            if abs(pc[0]-zc[0]) > 25 or abs(pc[1]-zc[1]) > 25:
                continue
            if pz.get('areaMm2') and z.get('areaMm2'):
                ratio = pz['areaMm2'] / z['areaMm2']
                if ratio < 0.4 or ratio > 2.5:
                    continue
            iou = poly_iou(z['polygon'], pz['polygon'])
            if iou > best_iou:
                best, best_iou = pz, iou
        if best is None or best_iou < 0.7 or best['id'] not in prev_over:
            continue
        val = prev_over[best['id']]
        if z['id'] in changed_zone_ids:
            review.append({'zoneId': z['id'], 'oldValue': val})
        else:
            new_over[z['id']] = val
            migrated.append({'zoneId': z['id'], 'value': val})

    progress(85, '搬移人工標註值…')
    def is_manual(pl):
        """A prev-label value counts as human-entered unless it is exactly what
        the auto reader produced (clean read H=<value> with a passing score)."""
        if pl.get('value') is None:
            return False
        r = str(pl.get('read', ''))
        if pl.get('score', 1) <= 0.12 and r.startswith('H='):
            try:
                return float(r[2:]) != pl['value']
            except ValueError:
                return True
        return True

    carried = []
    for l in labels:
        if not l.get('flagged'):
            continue
        changed, vb = changed_masks.get(l['view'], (None, None))
        if changed is None:
            continue
        Hpx, Wpx = changed.shape
        c0 = max(0, int((l['x0'] - 1 - vb[0]) * SCALE)); c1 = min(Wpx, int((l['x1'] + 1 - vb[0]) * SCALE))
        r0 = max(0, int((Hpx - 1) - (l['y1'] + 1 - vb[1]) * SCALE)); r1 = min(Hpx, int((Hpx - 1) - (l['y0'] - 1 - vb[1]) * SCALE))
        if c1 <= c0 or r1 <= r0 or changed[r0:r1, c0:c1].any():
            continue    # the spot changed between revisions: needs fresh judgement
        for pl in prev_labels:
            if (pl['view'] == l['view'] and is_manual(pl)
                    and abs(pl['cx'] - l['cx']) < 3 and abs(pl['cy'] - l['cy']) < 3):
                l['value'] = pl['value']
                l['flagged'] = False
                l['carried'] = True
                carried.append(l['id'])
                break

    json.dump(new_over, open(os.path.join(out, 'zone_overrides.json'), 'w'))
    json.dump(labels, open(os.path.join(out, 'labels.json'), 'w', encoding='utf-8'))
    json.dump({'migrated': migrated, 'review': review, 'carriedLabels': carried,
               'changedZones': sorted(changed_zone_ids)},
              open(os.path.join(out, 'carryover.json'), 'w'))
    progress(100, f'沿用 {len(migrated)} 區、{len(carried)} 標註;{len(review)} 區有變更待重新確認')

def cmd_debugviz(args):
    """Backfill zone-cutting debug artifacts for an existing dataset."""
    import ezdxf
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy
    from skimage import measure
    from skimage.morphology import binary_dilation
    from collections import Counter

    out = args.out
    meta = json.load(open(os.path.join(out, 'meta.json'), encoding='utf-8'))
    SCALE = 14
    doc = ezdxf.readfile(args.dxf)
    msp = doc.modelspace()
    cfg = Configuration(background_policy=BackgroundPolicy.WHITE, color_policy=ColorPolicy.BLACK)
    ctx = RenderContext(doc)
    labels_path = os.path.join(out, 'labels.json')
    all_labels = json.load(open(labels_path, encoding='utf-8')) if os.path.exists(labels_path) else []
    segs_all = None
    if all_labels:
        import glyph_match as gm
        progress(10, '收集字形筆畫(抹除用)…')
        segs_all = gm.collect_segments(msp)
    for view, vb in meta['views'].items():
        progress(30 if 'TOP' in view else 70, f'{view} debug 光柵…')
        dpi = 100
        fig = plt.figure(figsize=((vb[2]-vb[0])*SCALE/dpi, (vb[3]-vb[1])*SCALE/dpi), dpi=dpi)
        ax = fig.add_axes([0, 0, 1, 1]); ax.set_facecolor('white')
        Frontend(ctx, MatplotlibBackend(ax), config=cfg).draw_layout(msp, finalize=False)
        ax.set_xlim(vb[0], vb[2]); ax.set_ylim(vb[1], vb[3]); ax.set_aspect('equal'); ax.axis('off')
        fig.canvas.draw()
        walls = np.asarray(fig.canvas.buffer_rgba())[:, :, :3].mean(axis=2) < 128
        plt.close(fig)
        if segs_all is not None:
            walls &= ~glyph_erase_mask(walls.shape, [l for l in all_labels if l['view'] == view],
                                       segs_all, msp, vb, SCALE)
        walls = binary_dilation(walls, footprint=np.ones((3, 3)))
        comp_img = measure.label(~walls, connectivity=1)
        border = Counter(list(comp_img[0, :]) + list(comp_img[-1, :]) +
                         list(comp_img[:, 0]) + list(comp_img[:, -1]))
        outside_id = border.most_common(1)[0][0]
        n = emit_debug(out, view, vb, SCALE, walls, comp_img, outside_id)
        print(f'[debug] {view}: {n} zones', flush=True)
    progress(100, 'debugviz 完成')

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['overview', 'stp', 'extract', 'alignment', 'register', 'debugviz', 'diff', 'carryover'])
    ap.add_argument('--dxf'); ap.add_argument('--dxf-b'); ap.add_argument('--stp')
    ap.add_argument('--views'); ap.add_argument('--out', required=True)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    {'overview': cmd_overview, 'stp': cmd_stp, 'extract': cmd_extract,
     'alignment': cmd_alignment, 'register': cmd_register,
     'debugviz': cmd_debugviz, 'diff': cmd_diff, 'carryover': cmd_carryover}[args.cmd](args)

if __name__ == '__main__':
    main()
