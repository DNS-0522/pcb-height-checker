import { Router } from 'express';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPLOADS_DIR } from './analyze';

// DXF×STP height check over a pre-extracted board dataset.
// Zone membership (which H limit applies to which component) is decided by the
// offline extraction pipeline (analysis/); this engine only re-applies the
// judgement rules, so the UI can change them live.

export interface Zone {
  id: string;
  view: 'TOP_LIMIT' | 'BOT_LIMIT';
  value: number | null;
  conflict: boolean;
  labelValues: number[];
  areaMm2: number | null;
  explicit?: boolean;
  polygon: [number, number][];
  /** friendly number, e.g. T-07 / B-12 (assigned by area, larger first) */
  num?: string;
  /** valued: has an H; pending: needs the user; nolimit: user said no limit */
  state?: 'valued' | 'pending' | 'nolimit';
  /** user override applied */
  overridden?: boolean;
}

type ZoneOverride = number | 'nolimit';

export interface HLabel {
  id: string;
  view: 'TOP_LIMIT' | 'BOT_LIMIT';
  cx: number;
  cy: number;
  read: string;
  score: number;
  value: number | null;
  flagged: boolean;
  zoneId: string | null;
  crop?: string;
}

export interface BoardComponent {
  id: string;
  footprint: string;
  side: 'top' | 'bottom';
  view: 'TOP_LIMIT' | 'BOT_LIMIT';
  h: number;
  allowed: number | null;
  zoneId?: string | null;
  zoneConflict: boolean;
  placeholder: boolean;
  box: [number, number, number, number];
}

export interface CheckRules {
  /** mm of grace before a component counts as over-limit. */
  toleranceMm: number;
  /** H=0 semantics (decision 6 pending): how to judge components inside H=0 zones. */
  keepoutMode: 'list' | 'strict' | 'threshold';
  /** Used when keepoutMode = 'threshold': flag only if h exceeds this. */
  keepoutThresholdMm: number;
  /** 3.81 mm library placeholders: exclude from judgement or treat as real height. */
  placeholderMode: 'flag' | 'asHeight';
}

export type Status = 'ok' | 'violation' | 'keepout' | 'no_limit' | 'placeholder';

const DEFAULT_RULES: CheckRules = {
  toleranceMm: 0.05,
  keepoutMode: 'list',
  keepoutThresholdMm: 0.5,
  placeholderMode: 'flag',
};

const DATA_DIR = join(__dirname, '..', 'data');

function boardDir(boardId: string): string | null {
  if (!/^[\w-]+$/.test(boardId)) return null;
  for (const base of [DATA_DIR, UPLOADS_DIR]) {
    const dir = join(base, boardId);
    if (existsSync(join(dir, 'meta.json'))) return dir;
  }
  return null;
}

function loadBoard(boardId: string) {
  const dir = boardDir(boardId);
  if (!dir) throw new Error('unknown board');
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
  const zones = JSON.parse(readFileSync(join(dir, 'zones.json'), 'utf-8')) as Zone[];
  const components = JSON.parse(readFileSync(join(dir, 'components.json'), 'utf-8')) as BoardComponent[];
  let labels: HLabel[] = [];
  const labelsPath = join(dir, 'labels.json');
  if (existsSync(labelsPath)) {
    labels = JSON.parse(readFileSync(labelsPath, 'utf-8')) as HLabel[];
    // zone H values derive from auto-read labels (min on conflict, ruling d1),
    // then user zone-overrides win. Zones without any value are the review queue.
    const overridesPath = join(dir, 'zone_overrides.json');
    const overrides: Record<string, ZoneOverride> = existsSync(overridesPath)
      ? JSON.parse(readFileSync(overridesPath, 'utf-8'))
      : {};
    const zoneVals = new Map<string, number[]>();
    for (const l of labels) {
      if (l.zoneId && l.value !== null) {
        if (!zoneVals.has(l.zoneId)) zoneVals.set(l.zoneId, []);
        zoneVals.get(l.zoneId)!.push(l.value);
      }
    }
    for (const z of zones) {
      const vals = zoneVals.get(z.id) ?? [];
      z.labelValues = [...new Set(vals)].sort((a, b) => a - b);
      z.value = vals.length ? Math.min(...vals) : null;
      z.conflict = new Set(vals).size > 1;
      const ov = overrides[z.id];
      z.overridden = ov !== undefined;
      if (ov === 'nolimit') {
        z.value = null;
        z.state = 'nolimit';
      } else if (typeof ov === 'number') {
        z.value = ov;
        z.state = 'valued';
        z.conflict = false;
      } else {
        z.state = z.value !== null ? 'valued' : 'pending';
      }
    }
    // friendly numbers: per view, big zones first
    for (const view of ['TOP_LIMIT', 'BOT_LIMIT'] as const) {
      const vz = zones.filter((z) => z.view === view)
        .sort((a, b) => (b.areaMm2 ?? 0) - (a.areaMm2 ?? 0));
      vz.forEach((z, i) => {
        z.num = `${view === 'TOP_LIMIT' ? 'T' : 'B'}-${String(i + 1).padStart(2, '0')}`;
      });
    }
    const zoneById = new Map(zones.map((z) => [z.id, z]));
    for (const c of components) {
      const z = c.zoneId ? zoneById.get(c.zoneId) : undefined;
      c.allowed = z?.value ?? null;
      c.zoneConflict = z?.conflict ?? false;
    }
  }
  return { dir, meta, zones, components, labels };
}

export function judge(c: BoardComponent, rules: CheckRules): Status {
  if (c.placeholder && rules.placeholderMode === 'flag') return 'placeholder';
  if (c.allowed === null) return 'no_limit';
  if (c.allowed === 0) {
    if (rules.keepoutMode === 'strict') return 'violation';
    if (rules.keepoutMode === 'threshold')
      return c.h > rules.keepoutThresholdMm + rules.toleranceMm ? 'violation' : 'ok';
    return 'keepout';
  }
  return c.h > c.allowed + rules.toleranceMm ? 'violation' : 'ok';
}

export const heightCheckRouter = Router();

// Available boards: built-in datasets + finished uploads.
heightCheckRouter.get('/boards', (_req, res) => {
  const out: { id: string; title: string; source: string }[] = [];
  for (const [base, source] of [[DATA_DIR, 'builtin'], [UPLOADS_DIR, 'upload']] as const) {
    if (!existsSync(base)) continue;
    for (const id of readdirSync(base)) {
      const metaPath = join(base, id, 'meta.json');
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
        out.push({ id, title: meta.title ?? id, source });
      } catch { /* skip broken */ }
    }
  }
  res.json(out);
});

// Board dataset for rendering: zones (polygons + H values), labels, metadata.
heightCheckRouter.get('/dataset/:boardId', (req, res) => {
  try {
    const { meta, zones, labels } = loadBoard(req.params.boardId);
    res.json({ meta, zones, labels });
  } catch {
    res.status(404).json({ error: `Unknown board dataset: ${req.params.boardId}` });
  }
});

// Rendered DXF view background (for the alignment overlay in the viewer).
heightCheckRouter.get('/viewimg/:boardId/:view', (req, res) => {
  const dir = boardDir(req.params.boardId);
  if (!dir || !/^[A-Z_]+$/.test(req.params.view)) return res.status(404).end();
  const p = join(dir, `view_${req.params.view}.jpg`);
  if (!existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// Zone-cutting debug artifacts: walls / coloured-CC bitmaps + all zone outlines.
heightCheckRouter.get('/debugimg/:boardId/:kind/:view', (req, res) => {
  const dir = boardDir(req.params.boardId);
  const { kind, view } = req.params;
  if (!dir || !/^[A-Z_]+$/.test(view) || !['walls', 'cc'].includes(kind)) {
    return res.status(404).end();
  }
  const p = join(dir, `debug_${kind}_${view}.png`);
  if (!existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

heightCheckRouter.get('/debugzones/:boardId', (req, res) => {
  const dir = boardDir(req.params.boardId);
  if (!dir) return res.status(404).json({ error: 'unknown board' });
  const out: Record<string, unknown> = {};
  for (const view of ['TOP_LIMIT', 'BOT_LIMIT']) {
    const p = join(dir, `debug_zones_${view}.json`);
    if (existsSync(p)) out[view] = JSON.parse(readFileSync(p, 'utf-8'));
  }
  res.json(out);
});

// Zone-centric review: set a zone's H value, mark it 無限制, or clear (null).
heightCheckRouter.patch('/zone/:boardId/:zoneId', (req, res) => {
  const dir = boardDir(req.params.boardId);
  if (!dir) return res.status(404).json({ error: 'unknown board' });
  const zonesPath = join(dir, 'zones.json');
  if (!existsSync(zonesPath)) return res.status(400).json({ error: '此板卡沒有區域資料' });
  const zones = JSON.parse(readFileSync(zonesPath, 'utf-8')) as Zone[];
  if (!zones.some((z) => z.id === req.params.zoneId)) {
    return res.status(404).json({ error: 'unknown zone' });
  }
  const value = req.body?.value as ZoneOverride | null;
  if (value !== null && value !== 'nolimit'
      && (typeof value !== 'number' || value < 0 || value > 50)) {
    return res.status(400).json({ error: 'value 需為 0–50 的數字、"nolimit" 或 null' });
  }
  const overridesPath = join(dir, 'zone_overrides.json');
  const overrides: Record<string, ZoneOverride> = existsSync(overridesPath)
    ? JSON.parse(readFileSync(overridesPath, 'utf-8'))
    : {};
  if (value === null) delete overrides[req.params.zoneId];
  else overrides[req.params.zoneId] = value;
  writeFileSync(overridesPath, JSON.stringify(overrides));
  res.json({ ok: true });
});

// Human-in-the-loop: set/override the value of a (flagged) H label.
heightCheckRouter.patch('/label/:boardId/:labelId', (req, res) => {
  const dir = boardDir(req.params.boardId);
  if (!dir) return res.status(404).json({ error: 'unknown board' });
  const labelsPath = join(dir, 'labels.json');
  if (!existsSync(labelsPath)) {
    return res.status(400).json({ error: '此板卡的資料集不含標註檔(內建示範資料)' });
  }
  const value = req.body?.value;
  if (value !== null && (typeof value !== 'number' || value < 0 || value > 50)) {
    return res.status(400).json({ error: 'value 需為 0–50 的數字或 null' });
  }
  const labels = JSON.parse(readFileSync(labelsPath, 'utf-8')) as HLabel[];
  const label = labels.find((l) => l.id === req.params.labelId);
  if (!label) return res.status(404).json({ error: 'unknown label' });
  label.value = value;
  label.flagged = value === null;
  writeFileSync(labelsPath, JSON.stringify(labels));
  res.json({ ok: true, label: { ...label, crop: undefined } });
});

// Run the check with the given rules; rules are optional (defaults applied).
heightCheckRouter.post('/run/:boardId', (req, res) => {
  let board;
  try {
    board = loadBoard(req.params.boardId);
  } catch {
    return res.status(404).json({ error: `Unknown board dataset: ${req.params.boardId}` });
  }
  const rules: CheckRules = { ...DEFAULT_RULES, ...(req.body?.rules ?? {}) };
  const results = board.components.map((c) => ({ ...c, status: judge(c, rules) }));
  const stats: Record<Status, number> = { ok: 0, violation: 0, keepout: 0, no_limit: 0, placeholder: 0 };
  for (const r of results) stats[r.status as Status]++;
  res.json({ rules, stats, results });
});
