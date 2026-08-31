import { Router } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPy } from './analyze';

// DXF revision diff: upload two revisions of the same sheet, render both at
// identical extents (analysis/run_pipeline.py diff) and serve the composed
// pixel-diff image + change-region JSON.

const DIFFS_DIR = resolve(__dirname, '..', 'diffs');

interface DiffJob {
  id: string;
  dir: string;
  phase: 'running' | 'done' | 'error';
  progress: Record<string, number>;
  message: string;
  log: string[];
  aName: string;
  bName: string;
  error?: string;
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
    const job: DiffJob = {
      id, dir, phase: 'running', progress: { diff: 0 },
      message: '開始比對…', log: [],
      aName: a.originalname, bName: b.originalname,
    };
    jobs.set(id, job);
    runPy(job, 'diff',
      ['diff', '--dxf', join(dir, 'a.dxf'), '--dxf-b', join(dir, 'b.dxf'), '--out', dir],
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
  const { id, phase, progress, message, error, aName, bName } = job;
  res.json({ id, phase, progress, message, error, aName, bName, log: job.log.slice(-12) });
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
  const name = `zoom_${x0.toFixed(1)}_${y0.toFixed(1)}_${x1.toFixed(1)}_${y1.toFixed(1)}.jpg`;
  const p = join(job.dir, name);
  if (existsSync(p)) return res.sendFile(p);
  const key = `${job.id}:${name}`;
  let run = zoomRuns.get(key);
  if (!run) {
    run = new Promise<boolean>((resolvePromise) =>
      runPy(job, 'zoom',
        ['diffzoom', '--dxf', join(job.dir, 'a.dxf'), '--dxf-b', join(job.dir, 'b.dxf'),
         '--out', job.dir, '--region', `${x0},${y0},${x1},${y1}`],
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
