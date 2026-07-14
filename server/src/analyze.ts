import { Router } from 'express';
import multer from 'multer';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  phase: 'preparing' | 'awaiting-views' | 'extracting' | 'done' | 'error';
  /** per-subtask progress 0-100 */
  progress: Record<string, number>;
  message: string;
  log: string[];
  dxfName: string;
  stpName: string;
  error?: string;
}

const jobs = new Map<string, Job>();

function runPy(job: Job, tag: string, args: string[], onDone: (code: number) => void) {
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

analyzeRouter.get('/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  const { id, phase, progress, message, error, dxfName, stpName } = job;
  res.json({
    id, phase, progress, message, error, dxfName, stpName,
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
      } else {
        job.phase = 'done';
        job.message = '分析完成';
      }
    });
  res.json({ ok: true });
});
