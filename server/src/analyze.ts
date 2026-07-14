import { Router } from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Upload a DXF + STP pair and drive the extraction pipeline (analysis/run_pipeline.py).
// Phases: preparing (overview render + STP world-bbox solve, parallel)
//       -> awaiting-views (user frames the TOP/BOT Limit views on the overview)
//       -> extracting -> done | error

export const UPLOADS_DIR = resolve(__dirname, '..', 'uploads');
const PIPELINE = resolve(__dirname, '..', '..', 'analysis', 'run_pipeline.py');

interface Job {
  id: string;
  dir: string;
  phase: 'preparing' | 'awaiting-views' | 'extracting' | 'registering' | 'migrating' | 'done' | 'error';
  /** replace-dxf jobs chain a carry-over step after extract */
  kind?: 'upload' | 'replace-dxf';
  /** per-subtask progress 0-100 */
  progress: Record<string, number>;
  message: string;
  log: string[];
  dxfName: string;
  stpName: string;
  error?: string;
}

const jobs = new Map<string, Job>();

/** Minimal job surface runPy needs — analyze jobs and dxfdiff jobs both satisfy it. */
export interface PyJob {
  progress: Record<string, number>;
  message: string;
  log: string[];
}

export function runPy(job: PyJob, tag: string, args: string[], onDone: (code: number) => void) {
  const p = spawn('py', [PIPELINE, ...args], { cwd: resolve(__dirname, '..', '..', 'analysis') });
  const feed = (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      job.log.push(`[${tag}] ${line}`);
      if (job.log.length > 400) job.log.shift();
      const m = line.match(/^PROGRESS (\d+) (.*)$/);
      if (m) {
        job.progress[tag] = Number(m[1]);
        job.message = `[${tag}] ${m[2]}`;
      }
    }
  };
  p.stdout.on('data', feed);
  p.stderr.on('data', feed);
  p.on('close', (code) => onDone(code ?? 1));
  p.on('error', () => onDone(1));
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const dir = (req as any)._jobDir as string;
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase().endsWith('.dxf') ? 'input.dxf' : 'input.stp';
    cb(null, ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 300 * 1024 * 1024 } });

export const analyzeRouter = Router();

analyzeRouter.post(
  '/',
  (req, _res, next) => {
    const id = randomUUID().slice(0, 8);
    const dir = join(UPLOADS_DIR, id);
    mkdirSync(dir, { recursive: true });
    (req as any)._jobId = id;
    (req as any)._jobDir = dir;
    next();
  },
  upload.fields([{ name: 'dxf', maxCount: 1 }, { name: 'stp', maxCount: 1 }]),
  (req, res) => {
    const id = (req as any)._jobId as string;
    const dir = (req as any)._jobDir as string;
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    if (!files?.dxf?.[0] || !files?.stp?.[0]) {
      return res.status(400).json({ error: '需要同時上傳 dxf 與 stp 兩個檔案。' });
    }
    const job: Job = {
      id, dir, phase: 'preparing', progress: { overview: 0, stp: 0 },
      message: '開始解析…', log: [],
      dxfName: files.dxf[0].originalname, stpName: files.stp[0].originalname,
    };
    jobs.set(id, job);
    // original filenames for the dataset title (uploads are renamed input.*)
    writeFileSync(join(dir, 'jobinfo.json'),
      JSON.stringify({ dxfName: job.dxfName, stpName: job.stpName }));

    let pending = 2;
    const finish = (tag: string) => (code: number) => {
      if (code !== 0) {
        job.phase = 'error';
        job.error = `${tag} 階段失敗(exit ${code}),詳見 log`;
        return;
      }
      job.progress[tag] = 100;
      if (--pending === 0 && job.phase === 'preparing') {
        job.phase = 'awaiting-views';
        job.message = '請在縮覽圖上框出 TOP Limit 與 BOT Limit 視圖';
      }
    };
    runPy(job, 'overview', ['overview', '--dxf', join(dir, 'input.dxf'), '--out', dir], finish('overview'));
    runPy(job, 'stp', ['stp', '--stp', join(dir, 'input.stp'), '--out', dir], finish('stp'));
    res.json({ jobId: id });
  },
);

// ---- replace-stp: derive a new dataset from an existing board, swapping only
// the STP. DXF-side artifacts (labels + user-filled values, zones, overrides,
// views, renders) are copied verbatim; only the STP solve + registration +
// component zone mapping re-run.

const DATA_DIR = resolve(__dirname, '..', 'data');

/** STP-side artifacts — everything else in a dataset dir is DXF-side. */
const STP_SIDE = new Set([
  'input.stp', 'stp_world.json', 'board_outline_xy.json', 'components.json', 'jobinfo.json',
]);

function findBoardDir(boardId: string): string | null {
  if (!/^[\w-]+$/.test(boardId)) return null;
  for (const base of [DATA_DIR, UPLOADS_DIR]) {
    const dir = join(base, boardId);
    if (existsSync(join(dir, 'meta.json'))) return dir;
  }
  return null;
}

analyzeRouter.post(
  '/replace-stp',
  (req, _res, next) => {
    const id = randomUUID().slice(0, 8);
    const dir = join(UPLOADS_DIR, id);
    mkdirSync(dir, { recursive: true });
    (req as any)._jobId = id;
    (req as any)._jobDir = dir;
    next();
  },
  upload.single('stp'),
  (req, res) => {
    const id = (req as any)._jobId as string;
    const dir = (req as any)._jobDir as string;
    const reject = (code: number, error: string) => {
      rmSync(dir, { recursive: true, force: true });   // job dir was pre-created
      return res.status(code).json({ error });
    };
    if (!req.file || !/\.ste?p$/i.test(req.file.originalname)) {
      return reject(400, '需要上傳一個 .stp/.step 檔案。');
    }
    const srcId = String(req.body?.sourceBoardId ?? '');
    const src = findBoardDir(srcId);
    if (!src) return reject(404, `找不到板卡 ${srcId}`);
    if (!existsSync(join(src, 'input.dxf'))) {
      return reject(400, '此板卡的資料集沒有保存原始 DXF(內建示範資料),無法只更換 STP。');
    }
    for (const f of readdirSync(src)) {
      if (STP_SIDE.has(f) || !statSync(join(src, f)).isFile()) continue;
      copyFileSync(join(src, f), join(dir, f));
    }
    let dxfName = 'input.dxf';
    try {
      dxfName = JSON.parse(readFileSync(join(src, 'jobinfo.json'), 'utf-8')).dxfName ?? dxfName;
    } catch { /* source may be dxf-named already */ }
    const job: Job = {
      id, dir, phase: 'preparing', progress: { stp: 0, register: 0 },
      message: '解析新 STP…', log: [],
      dxfName, stpName: req.file.originalname,
    };
    jobs.set(id, job);
    writeFileSync(join(dir, 'jobinfo.json'),
      JSON.stringify({ dxfName, stpName: job.stpName, stpReplacedFrom: srcId }));

    runPy(job, 'stp', ['stp', '--stp', join(dir, 'input.stp'), '--out', dir], (code) => {
      if (code !== 0) {
        job.phase = 'error';
        job.error = `stp 階段失敗(exit ${code}),詳見 log`;
        return;
      }
      job.progress.stp = 100;
      job.phase = 'registering';
      job.message = '重新對位與零件歸區…';
      runPy(job, 'register', ['register', '--dxf', join(dir, 'input.dxf'), '--out', dir], (c2) => {
        if (c2 !== 0 || !existsSync(join(dir, 'components.json'))) {
          job.phase = 'error';
          job.error = `register 階段失敗(exit ${c2}),詳見 log`;
          return;
        }
        try {   // the copied meta still carries the source board's identity
          const metaPath = join(dir, 'meta.json');
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          meta.boardId = id;
          meta.stp = job.stpName;
          writeFileSync(metaPath, JSON.stringify(meta));
        } catch { /* non-fatal: dataset still loads */ }
        job.progress.register = 100;
        job.phase = 'done';
        job.message = 'STP 更換完成';
      });
    });
    res.json({ jobId: id });
  },
);

// ---- replace-dxf: derive a new dataset from an existing board, swapping only
// the DXF. STP-side artifacts are copied (no re-solve); the previous revision's
// DXF + dataset ride along as prev_* so the carry-over step can migrate human
// work (zone overrides, hand-filled label values) onto unchanged areas.

analyzeRouter.post(
  '/replace-dxf',
  (req, _res, next) => {
    const id = randomUUID().slice(0, 8);
    const dir = join(UPLOADS_DIR, id);
    mkdirSync(dir, { recursive: true });
    (req as any)._jobId = id;
    (req as any)._jobDir = dir;
    next();
  },
  upload.single('dxf'),
  (req, res) => {
    const id = (req as any)._jobId as string;
    const dir = (req as any)._jobDir as string;
    const reject = (code: number, error: string) => {
      rmSync(dir, { recursive: true, force: true });
      return res.status(code).json({ error });
    };
    if (!req.file || !/\.dxf$/i.test(req.file.originalname)) {
      return reject(400, '需要上傳一個 .dxf 檔案。');
    }
    const srcId = String(req.body?.sourceBoardId ?? '');
    const src = findBoardDir(srcId);
    if (!src) return reject(404, `找不到板卡 ${srcId}`);
    for (const need of ['input.dxf', 'stp_world.json', 'views.json', 'zones.json', 'labels.json']) {
      if (!existsSync(join(src, need))) {
        return reject(400, `此板卡的資料集缺少 ${need},無法只更換 DXF。`);
      }
    }
    // STP side rides along untouched; prev_* feed the carry-over step
    const copies: [string, string][] = [
      ['stp_world.json', 'stp_world.json'],
      ['board_outline_xy.json', 'board_outline_xy.json'],
      ['input.stp', 'input.stp'],
      ['input.dxf', 'prev.dxf'],
      ['views.json', 'prev_views.json'],
      ['zones.json', 'prev_zones.json'],
      ['labels.json', 'prev_labels.json'],
      ['zone_overrides.json', 'prev_zone_overrides.json'],
    ];
    for (const [from, to] of copies) {
      if (existsSync(join(src, from))) copyFileSync(join(src, from), join(dir, to));
    }
    let stpName = '';
    try {
      stpName = JSON.parse(readFileSync(join(src, 'jobinfo.json'), 'utf-8')).stpName ?? '';
    } catch { /* builtin datasets have no jobinfo */ }
    const job: Job = {
      id, dir, phase: 'preparing', progress: { overview: 0 },
      message: '渲染新版縮覽…', log: [], kind: 'replace-dxf',
      dxfName: req.file.originalname, stpName,
    };
    jobs.set(id, job);
    writeFileSync(join(dir, 'jobinfo.json'),
      JSON.stringify({ dxfName: job.dxfName, stpName, dxfReplacedFrom: srcId }));
    runPy(job, 'overview', ['overview', '--dxf', join(dir, 'input.dxf'), '--out', dir], (code) => {
      if (code !== 0) {
        job.phase = 'error';
        job.error = `overview 階段失敗(exit ${code}),詳見 log`;
        return;
      }
      job.progress.overview = 100;
      job.phase = 'awaiting-views';
      job.message = '請確認(或調整)預填的 TOP/BOT Limit 視圖框';
    });
    res.json({ jobId: id });
  },
);

analyzeRouter.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  const { id, phase, progress, message, error, dxfName, stpName } = job;
  let prevViews: unknown;
  const pv = join(job.dir, 'prev_views.json');
  if (job.kind === 'replace-dxf' && existsSync(pv)) {
    try { prevViews = JSON.parse(readFileSync(pv, 'utf-8')); } catch { /* ignore */ }
  }
  res.json({
    id, phase, progress, message, error, dxfName, stpName, prevViews,
    overviewReady: progress.overview === 100,
    log: job.log.slice(-12),
  });
});

analyzeRouter.get('/:id/overview.jpg', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.sendFile(join(job.dir, 'overview.jpg'));
});

analyzeRouter.get('/:id/overview.json', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.sendFile(join(job.dir, 'overview.json'));
});

analyzeRouter.post('/:id/views', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  if (job.phase !== 'awaiting-views') {
    return res.status(409).json({ error: `目前階段是 ${job.phase},不能設定視圖` });
  }
  const v = req.body?.views;
  for (const k of ['TOP_LIMIT', 'BOT_LIMIT']) {
    if (!Array.isArray(v?.[k]) || v[k].length !== 4) {
      return res.status(400).json({ error: `views.${k} 需要 [x0,y0,x1,y1]` });
    }
  }
  writeFileSync(join(job.dir, 'views.json'), JSON.stringify(v));
  job.phase = 'extracting';
  job.progress.extract = 0;
  runPy(job, 'extract',
    ['extract', '--dxf', join(job.dir, 'input.dxf'), '--views', join(job.dir, 'views.json'), '--out', job.dir],
    (code) => {
      if (code !== 0 || !existsSync(join(job.dir, 'meta.json'))) {
        job.phase = 'error';
        job.error = `extract 階段失敗(exit ${code}),詳見 log`;
        return;
      }
      if (job.kind === 'replace-dxf' && existsSync(join(job.dir, 'prev.dxf'))) {
        job.phase = 'migrating';
        job.progress.carryover = 0;
        job.message = '比對新舊版並沿用人工判定…';
        runPy(job, 'carryover',
          ['carryover', '--dxf', join(job.dir, 'input.dxf'), '--dxf-b', join(job.dir, 'prev.dxf'), '--out', job.dir],
          (c2) => {
            // carry-over failure is not fatal: the fresh dataset is complete,
            // the user just re-judges everything by hand
            job.phase = 'done';
            job.message = c2 === 0 ? '分析完成(已沿用上一版人工判定)' : '分析完成,但沿用比對失敗——請手動確認各區';
          });
      } else {
        job.phase = 'done';
        job.message = '分析完成';
      }
    });
  res.json({ ok: true });
});
