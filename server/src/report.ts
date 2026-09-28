import { Router } from 'express';
import ExcelJS from 'exceljs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  boardDir, loadBoard, judge, DEFAULT_RULES,
  type CheckRules, type Status, type BoardComponent, type Zone,
} from './heightcheck';

// 限高檢查報告匯出:把 /run 的判定結果排成 Excel 工作簿。
// 規則由 query string 帶入,和畫面上當下的判定一致。

export const reportRouter = Router();

const STATUS_LABEL: Record<Status, string> = {
  violation: '違規', keepout: 'H=0 區', ok: '合格', no_limit: '無限制區', placeholder: '佔位件',
};

function parseRules(q: Record<string, unknown>): CheckRules {
  const num = (v: unknown) => (v !== undefined && !Number.isNaN(Number(v)) ? Number(v) : undefined);
  return {
    toleranceMm: num(q.toleranceMm) ?? DEFAULT_RULES.toleranceMm,
    keepoutMode: ['list', 'strict', 'threshold'].includes(String(q.keepoutMode))
      ? (q.keepoutMode as CheckRules['keepoutMode']) : DEFAULT_RULES.keepoutMode,
    keepoutThresholdMm: num(q.keepoutThresholdMm) ?? DEFAULT_RULES.keepoutThresholdMm,
    placeholderMode: q.placeholderMode === 'asHeight' ? 'asHeight' : DEFAULT_RULES.placeholderMode,
  };
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
const VIOLATION_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };

function styleHeader(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

function componentRow(c: BoardComponent & { status: Status }, zoneNum: Map<string, string>) {
  const excess = c.status === 'violation' && c.allowed !== null
    ? Math.round((c.h - c.allowed) * 1000) / 1000 : null;
  return {
    id: c.id, footprint: c.footprint,
    side: c.side === 'top' ? 'TOP' : 'BOT',
    zone: c.zoneId ? zoneNum.get(c.zoneId) ?? c.zoneId : '',
    h: c.h, allowed: c.allowed, excess,
    status: STATUS_LABEL[c.status],
  };
}

const COMPONENT_COLS = [
  { header: 'Refdes / 名稱', key: 'id', width: 22 },
  { header: 'Footprint', key: 'footprint', width: 28 },
  { header: '面', key: 'side', width: 6 },
  { header: '區域', key: 'zone', width: 8 },
  { header: '零件高 (mm)', key: 'h', width: 12 },
  { header: '限高 (mm)', key: 'allowed', width: 11 },
  { header: '超出 (mm)', key: 'excess', width: 11 },
  { header: '判定', key: 'status', width: 10 },
];

reportRouter.get('/report/:boardId', async (req, res) => {
  let board: ReturnType<typeof loadBoard>;
  try {
    board = loadBoard(req.params.boardId);
  } catch {
    return res.status(404).json({ error: `Unknown board dataset: ${req.params.boardId}` });
  }
  const rules = parseRules(req.query as Record<string, unknown>);
  const results = board.components.map((c) => ({ ...c, status: judge(c, rules) }));
  const stats: Record<Status, number> = { ok: 0, violation: 0, keepout: 0, no_limit: 0, placeholder: 0 };
  for (const r of results) stats[r.status]++;
  const zoneNum = new Map(board.zones.filter((z) => z.num).map((z) => [z.id, z.num!] as const));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'pcb-height-checker';
  wb.created = new Date();

  // ── 總覽 ────────────────────────────────────────────────────────────────
  const ov = wb.addWorksheet('總覽');
  ov.columns = [{ width: 26 }, { width: 60 }];
  let jobinfo: { dxfName?: string; stpName?: string } = {};
  const ji = join(board.dir, 'jobinfo.json');
  if (existsSync(ji)) { try { jobinfo = JSON.parse(readFileSync(ji, 'utf-8')); } catch { /* ignore */ } }
  const keepoutDesc = rules.keepoutMode === 'list' ? '列成獨立清單(不判違規)'
    : rules.keepoutMode === 'strict' ? '一律視為違規'
      : `超過 ${rules.keepoutThresholdMm} mm 才違規`;
  const pendingZones = board.zones.filter((z) => z.state === 'pending').length;
  const rows: [string, string | number][] = [
    ['板卡', board.meta.title ?? req.params.boardId],
    ['DXF', jobinfo.dxfName ?? '—'],
    ['STP', jobinfo.stpName ?? '—'],
    ['報告產生時間', new Date().toLocaleString('zh-TW', { hour12: false })],
    ['', ''],
    ['容差 (mm)', rules.toleranceMm],
    ['H=0 區內零件', keepoutDesc],
    ['3.81mm 佔位件', rules.placeholderMode === 'flag' ? '另列不判定' : '照 3.81mm 判定'],
    ['', ''],
    ['違規', stats.violation],
    ['H=0 區內', stats.keepout],
    ['合格', stats.ok],
    ['無限制區', stats.no_limit],
    ['佔位件', stats.placeholder],
    ['尚未確認 H 值的區域', pendingZones],
  ];
  for (const [k, v] of rows) {
    const r = ov.addRow([k, v]);
    r.getCell(1).font = { bold: true };
  }
  if (pendingZones > 0 || stats.violation > 0) {
    const warn = ov.addRow(['注意', pendingZones > 0
      ? `${pendingZones} 個區域的 H 值尚未確認,其內零件的判定可能不完整。`
      : '']);
    warn.getCell(1).font = { bold: true, color: { argb: 'FFB91C1C' } };
  }

  // ── 違規清單(按超出量排序) ─────────────────────────────────────────────
  const vio = wb.addWorksheet('違規清單');
  vio.columns = COMPONENT_COLS;
  const violations = results.filter((r) => r.status === 'violation')
    .sort((a, b) => (b.h - (b.allowed ?? 0)) - (a.h - (a.allowed ?? 0)));
  for (const c of violations) {
    const r = vio.addRow(componentRow(c, zoneNum));
    r.fill = VIOLATION_FILL;
  }
  styleHeader(vio);

  // ── H=0 區清單(keepoutMode=list 時才有意義,但一律輸出供查) ───────────
  const kp = wb.addWorksheet('H=0 區零件');
  kp.columns = COMPONENT_COLS;
  for (const c of results.filter((r) => r.status === 'keepout')
    .sort((a, b) => b.h - a.h)) {
    kp.addRow(componentRow(c, zoneNum));
  }
  styleHeader(kp);

  // ── 區域 H 值總表 ───────────────────────────────────────────────────────
  const zs = wb.addWorksheet('區域 H 值');
  zs.columns = [
    { header: '區域', key: 'num', width: 8 },
    { header: '視圖', key: 'view', width: 12 },
    { header: 'H 值 (mm)', key: 'value', width: 10 },
    { header: '狀態', key: 'state', width: 12 },
    { header: '面積 (mm²)', key: 'area', width: 12 },
    { header: '標註讀值', key: 'labels', width: 16 },
    { header: '備註', key: 'note', width: 24 },
  ];
  const zoneState = (z: Zone) => (z.state === 'nolimit' ? '無限制'
    : z.state === 'pending' ? '待確認' : z.overridden ? '人工判定' : '自動讀值');
  const sortedZones = [...board.zones].sort((a, b) => (a.num ?? a.id).localeCompare(b.num ?? b.id));
  for (const z of sortedZones) {
    const r = zs.addRow({
      num: z.num ?? z.id, view: z.view === 'TOP_LIMIT' ? 'TOP' : 'BOT',
      value: z.value, state: zoneState(z),
      area: z.areaMm2 !== null ? Math.round(z.areaMm2) : null,
      labels: z.labelValues?.join(', ') ?? '',
      note: z.conflict ? '同區有多個不同讀值(取最小)' : '',
    });
    if (z.state === 'pending') r.font = { color: { argb: 'FFB91C1C' } };
  }
  styleHeader(zs);

  // ── 全部元件 ────────────────────────────────────────────────────────────
  const all = wb.addWorksheet('全部元件');
  all.columns = COMPONENT_COLS;
  for (const c of results) {
    const r = all.addRow(componentRow(c, zoneNum));
    if (c.status === 'violation') r.fill = VIOLATION_FILL;
  }
  styleHeader(all);
  all.autoFilter = { from: 'A1', to: 'H1' };

  // ── 板面圖 ─────────────────────────────────────────────────────────────
  const dir = boardDir(req.params.boardId)!;
  const imgs = wb.addWorksheet('板面圖');
  let imgRow = 1;
  for (const view of ['TOP_LIMIT', 'BOT_LIMIT'] as const) {
    const p = join(dir, `view_${view}.jpg`);
    if (!existsSync(p)) continue;
    imgs.getCell(imgRow, 1).value = view === 'TOP_LIMIT' ? '頂面 TOP Limit' : '底面 BOT Limit';
    imgs.getCell(imgRow, 1).font = { bold: true };
    const id = wb.addImage({ buffer: readFileSync(p) as unknown as ExcelJS.Buffer, extension: 'jpeg' });
    // 40 columns × ~7 rows of margin per image keeps them stacked and readable
    imgs.addImage(id, { tl: { col: 0, row: imgRow }, ext: { width: 1100, height: 550 } });
    imgRow += 30;
  }

  const title = String(board.meta.title ?? req.params.boardId).replace(/[\\/:*?"<>|]/g, '_');
  const fname = `${title}_限高檢查_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  await wb.xlsx.write(res);
  res.end();
});
