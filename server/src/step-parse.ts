// Fast, occt-free STEP (.stp) parser for PCB component extraction.
//
// A PCB STEP export models every placed component as a simple extruded block
// (footprint outline x height). We parse the ISO-10303-21 text directly:
//   - NEXT_ASSEMBLY_USAGE_OCCURRENCE (NAUO)  -> component instance + refdes
//   - the instance's placement transform      -> world position (X, Y, Z; Z sign = side)
//   - the component PRODUCT's local geometry   -> bbox (footprint W x D, height = dZ)
//
// This avoids OpenCascade's ~200s B-rep reconstruction; it runs in a few seconds.

export interface StepComponent {
  /** Reference designator (U3001, R12…) when present, else the footprint/instance name. */
  id: string;
  /** Footprint / package product name (e.g. CTK0_SM0402_1150X630_MA). */
  footprint: string;
  /** World placement origin. */
  x: number;
  y: number;
  z: number;
  /** Local bounding-box size: width (X), depth (Y), height (Z). */
  width: number;
  depth: number;
  height: number;
  side: 'top' | 'bottom';
  /** True when `id` is a real reference designator (vs a footprint-derived name). */
  isRefdes: boolean;
}

export interface StepParseResult {
  componentCount: number;
  refdesCount: number;
  board: { width: number; depth: number; height: number } | null;
  components: StepComponent[];
  parseMs: number;
}

const CART_RE = /CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(([^)]*)\)/;

// A reference designator has NO underscore (footprint-derived instance names do,
// e.g. CTK0_SM0402_1150X630_MA_25) and is 1-5 leading letters then a digit. This
// accepts zone-coded refdes like PC1J14 / PL8101 / PQH1J02 — not just pure R123.
const isRefdesName = (name: string): boolean => !name.includes('_') && /^[A-Za-z]{1,5}\d/.test(name);

type Vec3 = [number, number, number];

/** Tokenise the DATA section into an id -> "ENTITY(args)" map (handles multi-line entities). */
function buildEntityMap(text: string): Map<number, string> {
  const ds = text.indexOf('DATA;');
  const de = text.indexOf('ENDSEC;', ds >= 0 ? ds : 0);
  const data = text.slice(ds >= 0 ? ds + 5 : 0, de >= 0 ? de : text.length);
  const map = new Map<number, string>();
  let buf = '';
  for (const line of data.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    buf += (buf ? ' ' : '') + t;
    if (buf.endsWith(';')) {
      const m = buf.match(/^#(\d+)\s*=\s*(.*);$/);
      if (m) map.set(Number(m[1]), m[2]);
      buf = '';
    }
  }
  return map;
}

function refsIn(raw: string): number[] {
  const out: number[] = [];
  const re = /#(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.push(Number(m[1]));
  return out;
}

const firstStr = (raw: string): string => {
  const m = raw.match(/'((?:[^']|'')*)'/);
  return m ? m[1] : '';
};

function cartesianOf(raw: string | undefined): Vec3 | null {
  if (!raw) return null;
  const m = raw.match(CART_RE);
  if (!m) return null;
  const c = m[1].split(',').map((s) => parseFloat(s));
  return [c[0] || 0, c[1] || 0, c[2] || 0];
}

export function parseStepComponents(text: string): StepParseResult {
  const t0 = Date.now();
  const map = buildEntityMap(text);

  // Reverse-reference index: id -> ids that reference it.
  const rev = new Map<number, Set<number>>();
  for (const [id, raw] of map) {
    for (const r of refsIn(raw)) {
      let s = rev.get(r);
      if (!s) rev.set(r, (s = new Set()));
      s.add(id);
    }
  }
  const revOf = (id: number): number[] => [...(rev.get(id) || [])];
  const startsWith = (id: number, p: string) => (map.get(id) || '').startsWith(p);

  // --- Per-product local bbox (cached: many instances share one product) ---
  const bboxCache = new Map<number, { size: Vec3 } | null>();
  function productBbox(productId: number): { size: Vec3 } | null {
    if (bboxCache.has(productId)) return bboxCache.get(productId)!;
    // product -> formation -> product_definition -> product_definition_shape -> shape_def_rep -> representation
    const reps: number[] = [];
    for (const f of revOf(productId)) {
      if (!startsWith(f, 'PRODUCT_DEFINITION_FORMATION')) continue;
      for (const pd of revOf(f)) {
        if (!startsWith(pd, 'PRODUCT_DEFINITION(')) continue;
        for (const pds of revOf(pd)) {
          if (!startsWith(pds, 'PRODUCT_DEFINITION_SHAPE')) continue;
          for (const sdr of revOf(pds)) {
            if (!startsWith(sdr, 'SHAPE_DEFINITION_REPRESENTATION')) continue;
            for (const r of refsIn(map.get(sdr)!)) {
              const rr = map.get(r) || '';
              if (rr.includes('SHAPE_REPRESENTATION') || rr.startsWith('ADVANCED_BREP')) reps.push(r);
            }
          }
        }
      }
    }
    let result: { size: Vec3 } | null = null;
    for (const rep of reps) {
      const seen = new Set<number>();
      const stack = [rep];
      const mn: Vec3 = [Infinity, Infinity, Infinity];
      const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
      let n = 0;
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const raw = map.get(id);
        if (!raw) continue;
        // Only count vertices of the actual solid (ignore placement/axis points).
        if (raw.startsWith('VERTEX_POINT')) {
          for (const r of refsIn(raw)) {
            const c = cartesianOf(map.get(r));
            if (c) { for (let a = 0; a < 3; a++) { if (c[a] < mn[a]) mn[a] = c[a]; if (c[a] > mx[a]) mx[a] = c[a]; } n++; }
          }
        }
        for (const r of refsIn(raw)) stack.push(r);
      }
      if (n > 0) { result = { size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] }; break; }
    }
    bboxCache.set(productId, result);
    return result;
  }

  // --- Instance world placement (from the NAUO's context-dependent shape rep) ---
  function placementOf(nauoId: number): Vec3 | null {
    for (const pds of revOf(nauoId)) {
      if (!startsWith(pds, 'PRODUCT_DEFINITION_SHAPE')) continue;
      for (const cdsr of revOf(pds)) {
        if (!startsWith(cdsr, 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) continue;
        // Walk forward; collect AXIS2_PLACEMENT_3D origins; the non-zero one is the world placement.
        const seen = new Set<number>();
        const stack: Array<[number, number]> = refsIn(map.get(cdsr)!).map((r) => [r, 0]);
        let best: Vec3 | null = null;
        let bestMag = 0;
        while (stack.length) {
          const [id, d] = stack.pop()!;
          if (seen.has(id) || d > 6) continue;
          seen.add(id);
          if (seen.size > 400) break;
          const raw = map.get(id);
          if (!raw) continue;
          if (raw.startsWith('AXIS2_PLACEMENT_3D')) {
            const loc = cartesianOf(map.get(refsIn(raw)[0]));
            if (loc) {
              const mag = Math.abs(loc[0]) + Math.abs(loc[1]) + Math.abs(loc[2]);
              if (mag > bestMag) { bestMag = mag; best = loc; }
            }
          }
          for (const r of refsIn(raw)) stack.push([r, d + 1]);
        }
        if (best) return best;
      }
    }
    return null;
  }

  // instance product_definition -> footprint product { name, id }.
  function productOfPD(pdId: number): { name: string; productId: number } | null {
    const pd = map.get(pdId);
    if (!pd) return null;
    for (const f of refsIn(pd)) {
      const fr = map.get(f);
      if (fr && fr.startsWith('PRODUCT_DEFINITION_FORMATION')) {
        for (const p of refsIn(fr)) {
          const pr = map.get(p);
          if (pr && pr.startsWith('PRODUCT(')) return { name: firstStr(pr), productId: p };
        }
      }
    }
    return null;
  }

  // --- Board outline size (for reference / overlay scaling) ---
  let board: StepParseResult['board'] = null;
  for (const [id, raw] of map) {
    if (raw.startsWith('PRODUCT(') && firstStr(raw) === 'BOARD_OUTLINE') {
      const bb = productBbox(id);
      if (bb) board = { width: bb.size[0], depth: bb.size[1], height: bb.size[2] };
      break;
    }
  }
  const boardThickness = board ? board.height : 0.8;

  // --- Walk every component instance (NAUO) ---
  const components: StepComponent[] = [];
  for (const [id, raw] of map) {
    if (!raw.startsWith('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) continue;
    const name = firstStr(raw);
    if (name === 'BOARD_OUTLINE' || name === 'COMPONENTS') continue; // structural nodes
    const relatedPD = refsIn(raw)[1];
    if (!relatedPD) continue;
    const prod = productOfPD(relatedPD);
    if (!prod) continue;
    const pos = placementOf(id);
    if (!pos) continue;
    const bb = productBbox(prod.productId);
    if (!bb) continue;
    components.push({
      id: name,
      footprint: prod.name,
      x: pos[0],
      y: pos[1],
      z: pos[2],
      width: bb.size[0],
      depth: bb.size[1],
      height: bb.size[2],
      side: pos[2] < -boardThickness / 2 ? 'bottom' : 'top',
      isRefdes: isRefdesName(name),
    });
  }

  return {
    componentCount: components.length,
    refdesCount: components.filter((c) => c.isRefdes).length,
    board,
    components,
    parseMs: Date.now() - t0,
  };
}
