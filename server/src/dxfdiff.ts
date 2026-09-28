import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPy } from './analyze';

// DXF revision diff: upload two revisions of the same sheet, render both at
// identical extents (analysis/run_pipeline.py diff) and serve the composed
// pixel-diff image + change-region JSON.

const DIFFS_DIR = resolve(__dirname, '..', 'diffs');

/** 對位選項:自動(預設)、停用、或手動指定位移 */
interface AlignOpt { noAlign?: boolean; dx?: number; dy?: number }

interface DiffJob {
  id: string;
  dir: string;
  phase: 'running' | 'done' | 'error';
  progress: Record<string, number>;
  message: string;
  log: string[];
  aName: string;
  bName: string;
  /** 這次比對用的對位選項(重新比對時會換) */
  alignOpt: AlignOpt;
  error?: string;
}

function alignArgs(o: AlignOpt): string[] {
  if (o.noAlign) return ['--no-align'];
  const out: string[] = [];
  if (o.dx !== undefined) out.push('--align-dx', String(o.dx));
  if (o.dy !== undefined) out.push('--align-dy', String(o.dy));
  return out;
}

function parseAlignOpt(body: Record<string, unknown> | undefined): AlignOpt {
  const num = (v: unknown) => (v !== undefined && v !== '' && !Number.isNaN(Number(v))
    ? Number(v) : undefined);
  const o: AlignOpt = {};
  if (body?.noAlign === 'true' || body?.noAlign === true) o.noAlign = true;
  const dx = num(body?.alignDx ?? (body as any)?.dx);
  const dy = num(body?.alignDy ?? (body as any)?.dy);
  // 手動位移:±500mm 內,兩軸都給(缺的那軸當 0)
  if (dx !== undefined || dy !== undefined) {
    o.dx = Math.max(-500, Math.min(500, dx ?? 0));
    o.dy = Math.max(-500, Math.min(500, dy ?? 0));
  }
  return o;
}

/** 讀出 python 寫進 diff.json 的對位結果(給 zoom 用同一個位移) */
function appliedAlign(dir: string): { dx: number; dy: number } {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'diff.json'), 'utf-8'));
    if (j?.align?.applied) return { dx: Number(j.align.dx) || 0, dy: Number(j.align.dy) || 0 };
  } catch { /* 還沒跑完或舊的 job */ }
  return { dx: 0, dy: 0 };
}

const jobs = new Map<string, DiffJob>();

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, (req as any)._jobDir as string),
  filename: (_req, file, cb) => cb(null, file.fieldname === 'dxfA' ? 'a.dxf' : 'b.dxf'),
});
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

export const dxfDiffRouter = Router();

dxfDiffRouter.post(
  '/',
  (req, _res, next) => {
    const id = randomUUID().slice(0, 8);
    const dir = join(DIFFS_DIR, id);
    mkdirSync(dir, { recursive: true });
    (req as any)._jobId = id;
    (req as any)._jobDir = dir;
    next();
  },
  upload.fields([{ name: 'dxfA', maxCount: 1 }, { name: 'dxfB', maxCount: 1 }]),
  (req, res) => {
    const id = (req as any)._jobId as string;
    const dir = (req as any)._jobDir as string;
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const a = files?.dxfA?.[0];
    const b = files?.dxfB?.[0];
    if (!a || !b || ![a, b].every((f) => /\.dxf$/i.test(f.originalname))) {
      rmSync(dir, { recursive: true, force: true });
      return res.status(400).json({ error: '需要同時上傳兩個 .dxf 檔案(舊版與新版)。' });
    }
    const alignOpt = parseAlignOpt(req.body);
    const job: DiffJob = {
      id, dir, phase: 'running', progress: { diff: 0 },
      message: '開始比對…', log: [],
      aName: a.originalname, bName: b.originalname, alignOpt,
    };
    jobs.set(id, job);
    runPy(job, 'diff',
      ['diff', '--dxf', join(dir, 'a.dxf'), '--dxf-b', join(dir, 'b.dxf'), '--out', dir,
       ...alignArgs(alignOpt)],
      (code) => {
        if (code !== 0 || !existsSync(join(dir, 'diff.json'))) {
          job.phase = 'error';
          job.error = `diff 階段失敗(exit ${code}),詳見 log`;
        } else {
          job.phase = 'done';
          job.message = '比對完成';
        }
      });
    res.json({ jobId: id });
  },
);

dxfDiffRouter.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  const { id, phase, progress, message, error, aName, bName, alignOpt } = job;
  res.json({ id, phase, progress, message, error, aName, bName, alignOpt,
             log: job.log.slice(-12) });
});

// 換一個對位位移(或關閉自動對位)重新比對同一對 DXF —— UI 微調完按「套用」走這裡
dxfDiffRouter.post('/:id/realign', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  if (job.phase === 'running') return res.status(409).json({ error: '這個比對還在跑' });
  if (!existsSync(join(job.dir, 'a.dxf')) || !existsSync(join(job.dir, 'b.dxf'))) {
    return res.status(410).json({ error: '這個比對的原始 DXF 已不在,請重新上傳' });
  }
  job.alignOpt = parseAlignOpt(req.body);
  job.phase = 'running'; job.progress = { diff: 0 }; job.message = '重新比對…'; job.error = undefined;
  runPy(job, 'diff',
    ['diff', '--dxf', join(job.dir, 'a.dxf'), '--dxf-b', join(job.dir, 'b.dxf'),
     '--out', job.dir, ...alignArgs(job.alignOpt)],
    (code) => {
      if (code !== 0 || !existsSync(join(job.dir, 'diff.json'))) {
        job.phase = 'error';
        job.error = `diff 階段失敗(exit ${code}),詳見 log`;
      } else {
        job.phase = 'done';
        job.message = '比對完成';
      }
    });
  res.json({ ok: true, alignOpt: job.alignOpt });
});

dxfDiffRouter.get('/:id/diff.json', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.sendFile(join(job.dir, 'diff.json'));
});

// High-res zoom of one region: re-render both revisions cropped to the given
// sheet-mm window (run_pipeline.py diffzoom) and serve the composed diff crop.
// Results are cached on disk per rounded window; concurrent identical requests
// share one python run.
const zoomRuns = new Map<string, Promise<boolean>>();

dxfDiffRouter.get('/:id/zoom', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  const nums = ['x0', 'y0', 'x1', 'y1'].map((k) => Number(req.query[k]));
  if (nums.some((n) => !Number.isFinite(n))) {
    return res.status(400).json({ error: 'x0/y0/x1/y1 需為數字(圖面 mm 座標)' });
  }
  const r = (v: number) => Math.round(v * 10) / 10;
  const [x0, y0, x1, y1] = nums.map(r);
  if (x1 - x0 < 1 || y1 - y0 < 1 || x1 - x0 > 600 || y1 - y0 > 600) {
    return res.status(400).json({ error: '放大範圍需在 1–600 mm 之間' });
  }
  const al = appliedAlign(job.dir);
  const sgn = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  const tag = al.dx === 0 && al.dy === 0 ? '' : `_a${sgn(al.dx)}${sgn(al.dy)}`;
  const name = `zoom_${x0.toFixed(1)}_${y0.toFixed(1)}_${x1.toFixed(1)}_${y1.toFixed(1)}${tag}.jpg`;
  const p = join(job.dir, name);
  if (existsSync(p)) return res.sendFile(p);
  const key = `${job.id}:${name}`;
  let run = zoomRuns.get(key);
  if (!run) {
    run = new Promise<boolean>((resolvePromise) =>
      runPy(job, 'zoom',
        ['diffzoom', '--dxf', join(job.dir, 'a.dxf'), '--dxf-b', join(job.dir, 'b.dxf'),
         '--out', job.dir, '--region', `${x0},${y0},${x1},${y1}`,
         ...(tag ? ['--align-dx', String(al.dx), '--align-dy', String(al.dy)] : [])],
        (code) => resolvePromise(code === 0)));
    zoomRuns.set(key, run);
    run.finally(() => zoomRuns.delete(key));
  }
  run.then((ok) => {
    if (ok && existsSync(p)) res.sendFile(p);
    else res.status(500).json({ error: '區塊放大渲染失敗,詳見 job log' });
  });
});

dxfDiffRouter.get('/:id/img/:name', (req, res) => {
  const job = jobs.get(req.params.id);
  const { name } = req.params;
  if (!job || !['a.jpg', 'b.jpg', 'diff.jpg'].includes(name)) return res.status(404).end();
  const p = join(job.dir, name);
  if (!existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});
