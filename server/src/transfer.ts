import { Router } from 'express';
import multer from 'multer';
import JSZip from 'jszip';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boardDir } from './heightcheck';
import { UPLOADS_DIR } from './analyze';

// 資料集搬移:把一片板子打包成 zip(帶去別台電腦 / 給同事),或把別人給的 zip
// 收進 uploads/。只搬必要檔與人工成果;debug_*、*.bak 這類重跑可再生的一律不收。

export const transferRouter = Router();

/** 少了任一個就載不起來 */
const REQUIRED = ['meta.json', 'components.json', 'zones.json'];
/** 人工成果 + 畫面底圖/對位,有就帶 */
const OPTIONAL = [
  'labels.json', 'zone_overrides.json', 'carryover.json',
  'views.json', 'board_outline_xy.json',
  'view_TOP_LIMIT.jpg', 'view_BOT_LIMIT.jpg',
];
/** ?full=1 才帶:對方要能「更換 DXF / STP」重跑管線就需要 */
const HEAVY = ['input.dxf', 'input.stp', 'stp_world.json', 'overview.jpg', 'overview.json', 'jobinfo.json'];

const ALLOWED = new Set([...REQUIRED, ...OPTIONAL, ...HEAVY]);
const MANIFEST = '_package.json';
const FORMAT = 'pcb-height-checker/board@1';

/** jpg 已經是壓縮格式,再 deflate 只是白費 CPU */
const storeOnly = (name: string): 'STORE' | 'DEFLATE' =>
  (/\.(jpg|jpeg|png)$/i.test(name) ? 'STORE' : 'DEFLATE');

transferRouter.get('/export/:boardId', async (req, res) => {
  try {
    const dir = boardDir(req.params.boardId);
    if (!dir) return res.status(404).json({ error: 'unknown board' });
    const full = req.query.full === '1';

    const names = [...REQUIRED, ...OPTIONAL, ...(full ? HEAVY : [])]
      .filter((f) => existsSync(join(dir, f)) && statSync(join(dir, f)).isFile());
    const missing = REQUIRED.filter((f) => !names.includes(f));
    if (missing.length) return res.status(409).json({ error: `dataset incomplete: ${missing.join(', ')}` });

    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
    const zip = new JSZip();
    for (const f of names) zip.file(f, readFileSync(join(dir, f)), { compression: storeOnly(f) });
    zip.file(MANIFEST, JSON.stringify({
      format: FORMAT,
      boardId: req.params.boardId,
      title: meta.title ?? req.params.boardId,
      mode: full ? 'full' : 'core',
      exportedAt: new Date().toISOString(),
      files: names,
    }, null, 2));

    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const stem = String(meta.title ?? req.params.boardId).replace(/[\/:*?"<>|]/g, '_');
    const fname = `${stem}_${req.params.boardId}${full ? '_full' : ''}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition',
      `attachment; filename="board_${req.params.boardId}.zip"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.end(buf);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 400 * 1024 * 1024 } });

/**
 * 手動用檔案總管壓縮資料夾時會多一層目錄,去掉共同前綴;
 * 那層目錄名通常就是原本的 boardId,沒有 manifest 時拿來當 id 候選。
 */
function stripPrefix(paths: string[]): { strip: (p: string) => string; folder: string } {
  const dirs = new Set(paths.map((p) => (p.includes('/') ? p.slice(0, p.indexOf('/') + 1) : '')));
  const prefix = dirs.size === 1 ? [...dirs][0] : '';
  return {
    strip: (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p),
    folder: prefix.replace(/\/$/, ''),
  };
}

transferRouter.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '沒有收到檔案' });
    const zip = await JSZip.loadAsync(req.file.buffer).catch(() => null);
    if (!zip) return res.status(400).json({ error: '不是有效的 zip 檔' });

    const entries = Object.values(zip.files).filter((f) => !f.dir);
    const { strip, folder } = stripPrefix(entries.map((f) => f.name));
    // 只收白名單內的檔名(順帶擋掉 zip-slip:我們從不拼接壓縮檔裡的路徑)
    const picked = new Map<string, JSZip.JSZipObject>();
    let manifest: { boardId?: string; title?: string } = {};
    for (const f of entries) {
      const name = strip(f.name);
      if (name === MANIFEST) {
        try { manifest = JSON.parse(await f.async('string')); } catch { /* 缺 manifest 不致命 */ }
      } else if (ALLOWED.has(name)) {
        picked.set(name, f);
      }
    }
    const missing = REQUIRED.filter((f) => !picked.has(f));
    if (missing.length) {
      return res.status(400).json({ error: `這個 zip 不是完整的板卡資料集,缺少 ${missing.join('、')}` });
    }

    // 沿用原本的 boardId;撞名就給新 id(除非明確要求覆蓋現有上傳資料集)
    const wanted = String(req.body?.id || manifest.boardId || folder || '').trim();
    const valid = /^[\w-]+$/.test(wanted) ? wanted : randomUUID().slice(0, 8);
    const existing = boardDir(valid);
    const overwrite = req.body?.overwrite === 'true' || req.body?.overwrite === true;
    let id = valid;
    let replaced = false;
    if (existing) {
      if (overwrite && existing.startsWith(UPLOADS_DIR)) replaced = true;
      else id = randomUUID().slice(0, 8);
    } else if (existsSync(join(UPLOADS_DIR, valid))) {
      id = randomUUID().slice(0, 8);      // 同名但還沒完成的 job 目錄,別混進去
    }

    const dest = replaced ? existing! : join(UPLOADS_DIR, id);
    mkdirSync(dest, { recursive: true });
    if (replaced) {                       // 覆蓋:zip 裡沒有的舊檔要清掉,免得半新半舊
      for (const f of ALLOWED) {
        if (!picked.has(f) && existsSync(join(dest, f))) rmSync(join(dest, f));
      }
    }
    for (const [name, f] of picked) writeFileSync(join(dest, name), await f.async('nodebuffer'));

    const metaPath = join(dest, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    if (meta.boardId !== id) {            // meta 還帶著來源板卡的 id
      meta.boardId = id;
      writeFileSync(metaPath, JSON.stringify(meta));
    }
    res.json({
      ok: true,
      board: { id, title: meta.title ?? id },
      files: picked.size,
      replaced,
      renamed: id !== valid ? valid : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
