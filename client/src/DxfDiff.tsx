import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GitCompareArrows, Loader2, AlertTriangle, Play, ZoomIn, MapPin, Crosshair,
} from 'lucide-react';
import { cn } from './lib/utils';
import { FilePick } from './UploadWizard';

// DXF 改版比對:上傳新舊兩版 DXF,server 以相同座標範圍渲染後做像素差異
// (紅=舊版移除、綠=新版新增、灰=未變),並聚類出差異區域清單。

interface DiffStatus {
  id: string;
  phase: 'running' | 'done' | 'error';
  progress: Record<string, number>;
  message: string;
  error?: string;
  aName: string;
  bName: string;
  log: string[];
}

interface DiffRegion {
  x0: number; y0: number; x1: number; y1: number;
  removedPx: number; addedPx: number;
}

/** server 端(run_pipeline.py diff)算出的對位結果 */
interface DiffAlign {
  applied: boolean;
  dx: number; dy: number;
  consensusPct: number | null;
  crossCheckMm: number | null;
  outliers?: number;
  reason: 'auto' | 'already_aligned' | 'low_consensus' | 'manual' | 'disabled'
    | 'no_features' | null;
  hint?: string;
  /** 共識不足時的多位移分析:每個位移及其特徵分布 */
  models?: { dx: number; dy: number; features: number; pct: number; bbox: number[] }[];
  regions?: { name: string; dx: number; dy: number; consensusPct: number; features: number }[];
  suggest?: { dx: number; dy: number; bbox: number[] };
}

interface DiffMeta {
  x0: number; y0: number; x1: number; y1: number;
  pxw: number; pxh: number;
  removedPx: number; addedPx: number;
  regions: DiffRegion[];
  regionsTotal: number;
  align?: DiffAlign;
}

type ImgMode = 'diff' | 'a' | 'b' | 'overlay';

const MODE_LABEL: Record<ImgMode, string> = {
  diff: '差異', a: '舊版', b: '新版', overlay: '疊圖微調',
};

export default function DxfDiff() {
  const [fileA, setFileA] = useState<File | null>(null);
  const [fileB, setFileB] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<DiffStatus | null>(null);
  const [meta, setMeta] = useState<DiffMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [mode, setMode] = useState<ImgMode>('diff');
  const [zoom, setZoom] = useState(1);
  const [noAlign, setNoAlign] = useState(false);
  /** 疊圖微調中的位移(mm,圖面座標);按「用這個位移重新比對」才會真的重算 */
  const [nudge, setNudge] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const [realigning, setRealigning] = useState(false);
  const [selRegion, setSelRegion] = useState<number | null>(null);
  const [zoomRegion, setZoomRegion] = useState<{ idx: number; x0: number; y0: number; x1: number; y1: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!zoomRegion) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoomRegion(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomRegion]);

  /** open the high-res zoom modal for region i, padded for context and
   *  clamped to the sheet extents */
  function openZoom(i: number) {
    if (!meta) return;
    const r = meta.regions[i];
    const w = r.x1 - r.x0; const h = r.y1 - r.y0;
    const pad = Math.max(5, 0.3 * Math.max(w, h));
    let x0 = r.x0 - pad, x1 = r.x1 + pad, y0 = r.y0 - pad, y1 = r.y1 + pad;
    const grow = (min: number, a: number, b: number): [number, number] =>
      b - a >= min ? [a, b] : [(a + b) / 2 - min / 2, (a + b) / 2 + min / 2];
    [x0, x1] = grow(20, x0, x1); [y0, y1] = grow(20, y0, y1);
    x0 = Math.max(x0, meta.x0); y0 = Math.max(y0, meta.y0);
    x1 = Math.min(x1, meta.x1); y1 = Math.min(y1, meta.y1);
    setSelRegion(i);
    setZoomRegion({ idx: i, x0, y0, x1, y1 });
  }

  async function start() {
    if (!fileA || !fileB) return;
    setUploading(true); setError(null);
    setMeta(null); setStatus(null); setSelRegion(null); setMode('diff'); setZoom(1);
    try {
      const fd = new FormData();
      fd.append('dxfA', fileA);
      fd.append('dxfB', fileB);
      if (noAlign) fd.append('noAlign', 'true');
      const res = await fetch('/api/dxfdiff', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setJobId(data.jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : '上傳失敗');
    } finally {
      setUploading(false);
    }
  }

  useEffect(() => {
    if (!jobId || meta) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/dxfdiff/${jobId}`);
        const data = (await res.json()) as DiffStatus;
        setStatus(data);
        if (data.phase === 'done') {
          clearInterval(t);
          const m = await fetch(`/api/dxfdiff/${jobId}/diff.json`);
          const parsed = (await m.json()) as DiffMeta;
          setMeta(parsed);
          setNudge({ dx: parsed.align?.dx ?? 0, dy: parsed.align?.dy ?? 0 });
          setRealigning(false);
        }
        if (data.phase === 'error') clearInterval(t);
      } catch { /* transient */ }
    }, 1500);
    return () => clearInterval(t);
  }, [jobId, meta]);

  /** sheet mm -> fraction-of-image CSS box (image y axis is flipped) */
  const regionBox = useMemo(() => {
    if (!meta) return () => ({});
    const w = meta.x1 - meta.x0;
    const h = meta.y1 - meta.y0;
    return (r: DiffRegion) => ({
      left: `${((r.x0 - meta.x0) / w) * 100}%`,
      top: `${((meta.y1 - r.y1) / h) * 100}%`,
      width: `${((r.x1 - r.x0) / w) * 100}%`,
      height: `${((r.y1 - r.y0) / h) * 100}%`,
    });
  }, [meta]);

  function jumpTo(i: number) {
    setSelRegion(i);
    const el = scrollRef.current;
    if (!el || !meta) return;
    const r = meta.regions[i];
    const fx = (((r.x0 + r.x1) / 2) - meta.x0) / (meta.x1 - meta.x0);
    const fy = (meta.y1 - ((r.y0 + r.y1) / 2)) / (meta.y1 - meta.y0);
    el.scrollTo({
      left: fx * el.scrollWidth - el.clientWidth / 2,
      top: fy * el.scrollHeight - el.clientHeight / 2,
      behavior: 'smooth',
    });
  }

  /** 用指定位移(或關閉對位)重跑同一對 DXF */
  const realign = async (opt: { dx?: number; dy?: number; noAlign?: boolean }) => {
    if (!jobId) return;
    setRealigning(true); setError(null);
    try {
      const res = await fetch(`/api/dxfdiff/${jobId}/realign`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opt),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setMeta(null); setSelRegion(null);       // 清掉 meta 會讓輪詢重新啟動
    } catch (e) {
      setError(e instanceof Error ? e.message : '重新比對失敗');
      setRealigning(false);
    }
  };

  // 疊圖模式:方向鍵微調位移(Shift = 1mm、預設 0.1mm)
  useEffect(() => {
    if (mode !== 'overlay' || !meta) return;
    const onKey = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 1 : 0.1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0],
                  ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
      if (!d) return;
      e.preventDefault();
      setNudge((n) => ({ dx: Math.round((n.dx + d[0]) * 1000) / 1000,
                         dy: Math.round((n.dy + d[1]) * 1000) / 1000 }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, meta]);

  const running = (status && status.phase === 'running') || realigning;

  return (
    <div className="space-y-6">
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl p-4 shadow-sm space-y-4">
        <h3 className="text-sm font-semibold flex items-center space-x-2">
          <GitCompareArrows className="w-4 h-4 text-blue-500" />
          <span>DXF 改版比對</span>
        </h3>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <FilePick label="舊版 DXF" accept=".dxf" file={fileA} onPick={setFileA} />
          <FilePick label="新版 DXF" accept=".dxf" file={fileB} onPick={setFileB} />
          <button
            onClick={start}
            disabled={!fileA || !fileB || uploading || !!running}
            className="sm:ml-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center space-x-2 text-sm font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploading || running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            <span>開始比對</span>
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer w-fit">
          <input
            type="checkbox" checked={noAlign}
            onChange={(e) => setNoAlign(e.target.checked)}
            className="accent-blue-600"
          />
          <span>不要自動對齊(直接用圖面原始座標比對)</span>
        </label>
        <p className="text-xs text-slate-400">
          兩版座標若在建圖過程中整體跑掉,會先用孔位比對自動量出位移並對齊(共識不足時不會硬套,
          會告訴你原因);之後仍可在「疊圖微調」手動調整。
        </p>

        {status && status.phase !== 'done' && (
          <div className="text-sm space-y-2">
            <div className="flex items-center space-x-2">
              {status.phase === 'error'
                ? <AlertTriangle className="w-4 h-4 text-red-500" />
                : <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
              <span className={cn(status.phase === 'error' && 'text-red-600 dark:text-red-400')}>
                {status.error ?? status.message}
              </span>
              <span className="text-xs text-slate-400 font-mono">{status.progress.diff ?? 0}%</span>
            </div>
            {status.phase === 'error' && status.log.length > 0 && (
              <pre className="text-[11px] text-slate-500 bg-slate-50 dark:bg-slate-900 rounded-lg p-2 overflow-x-auto max-h-40">
                {status.log.join('\n')}
              </pre>
            )}
          </div>
        )}
        {error && (
          <div className="flex items-start space-x-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span className="font-mono">{error}</span>
          </div>
        )}
      </section>

      {meta && jobId && (
        <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl p-4 shadow-sm space-y-3">
          <AlignPanel
            align={meta.align}
            nudge={nudge}
            onNudge={setNudge}
            busy={!!realigning}
            onRealign={realign}
            onOverlay={() => setMode('overlay')}
          />
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <div className="flex rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden">
              {(['diff', 'a', 'b', 'overlay'] as ImgMode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn(
                    'px-3 py-1.5 text-sm cursor-pointer',
                    mode === m
                      ? 'bg-blue-600 text-white font-medium'
                      : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-slate-900',
                  )}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
            <span className="flex items-center space-x-3 text-xs">
              <span className="flex items-center space-x-1">
                <span className="w-3 h-3 rounded-sm inline-block" style={{ background: '#e11d48' }} />
                <span className="text-slate-500">舊版移除</span>
              </span>
              <span className="flex items-center space-x-1">
                <span className="w-3 h-3 rounded-sm inline-block" style={{ background: '#16a34a' }} />
                <span className="text-slate-500">新版新增</span>
              </span>
              <span className="flex items-center space-x-1">
                <span className="w-3 h-3 rounded-sm inline-block bg-slate-400" />
                <span className="text-slate-500">未變</span>
              </span>
            </span>
            <label className="ml-auto flex items-center space-x-2 text-xs text-slate-500">
              <ZoomIn className="w-4 h-4" />
              <input
                type="range" min={1} max={6} step={0.5} value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="w-32 accent-blue-600"
              />
              <span className="font-mono w-8">{zoom}×</span>
            </label>
          </div>

          <div className="flex flex-col lg:flex-row gap-4">
            <div
              ref={scrollRef}
              className="relative flex-1 overflow-auto max-h-[70vh] border border-slate-200 dark:border-slate-800 rounded-lg bg-white"
            >
              <div className="relative" style={{ width: `${zoom * 100}%` }}>
                {mode === 'overlay' ? (
                  <div className="relative bg-white">
                    <img
                      src={`/api/dxfdiff/${jobId}/img/a.jpg`}
                      alt="舊版" className="w-full h-auto block select-none" draggable={false}
                    />
                    {/* b.jpg 已經套了伺服器算出的位移,所以這裡只再平移「差額」 */}
                    <img
                      src={`/api/dxfdiff/${jobId}/img/b.jpg`}
                      alt="新版"
                      className="absolute inset-0 w-full h-auto block select-none"
                      draggable={false}
                      style={{
                        mixBlendMode: 'difference',
                        filter: 'invert(1)',
                        transform: `translate(${((nudge.dx - (meta.align?.applied ? meta.align.dx : 0))
                          / (meta.x1 - meta.x0)) * 100}%, ${(-(nudge.dy - (meta.align?.applied ? meta.align.dy : 0))
                          / (meta.y1 - meta.y0)) * 100}%)`,
                      }}
                    />
                  </div>
                ) : (
                <img
                  src={`/api/dxfdiff/${jobId}/img/${mode}.jpg`}
                  alt={MODE_LABEL[mode]}
                  className="w-full h-auto block select-none"
                  draggable={false}
                />
                )}
                {mode === 'diff' && meta.regions.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => setSelRegion(i === selRegion ? null : i)}
                    onDoubleClick={() => openZoom(i)}
                    className={cn(
                      'absolute border rounded-sm cursor-pointer',
                      i === selRegion
                        ? 'border-2 border-blue-500 bg-blue-500/10'
                        : 'border-amber-400/70 hover:border-amber-500 hover:bg-amber-400/10',
                    )}
                    style={regionBox(r)}
                    title={`差異區 #${i + 1}(雙擊高解析放大)`}
                  />
                ))}
              </div>
            </div>

            <div className="lg:w-72 shrink-0 space-y-2">
              <p className="text-sm font-medium">
                差異區域 {meta.regionsTotal}
                {meta.regionsTotal > meta.regions.length ? `(僅列前 ${meta.regions.length})` : ''} 個
              </p>
              <p className="text-xs text-slate-400">
                移除 {meta.removedPx.toLocaleString()} px、新增 {meta.addedPx.toLocaleString()} px。點擊項目定位。
              </p>
              <div className="overflow-y-auto max-h-[58vh] space-y-1.5 pr-1">
                {meta.regions.length === 0 && (
                  <p className="text-sm text-slate-400 py-6 text-center">兩版圖面沒有差異 🎉</p>
                )}
                {meta.regions.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => jumpTo(i)}
                    className={cn(
                      'w-full text-left rounded-lg border px-3 py-2 text-xs cursor-pointer transition-colors',
                      i === selRegion
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-slate-200 dark:border-slate-800 hover:border-blue-400',
                    )}
                  >
                    <span className="flex items-center justify-between">
                      <span className="font-medium flex items-center space-x-1">
                        <MapPin className="w-3 h-3 text-slate-400" />
                        <span>#{i + 1}</span>
                      </span>
                      <span className="flex items-center space-x-2">
                        <span className="font-mono text-slate-400">
                          ({r.x0.toFixed(0)}, {r.y0.toFixed(0)})
                        </span>
                        <span
                          role="button"
                          title="高解析放大此區"
                          onClick={(e) => { e.stopPropagation(); openZoom(i); }}
                          className="p-0.5 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                        >
                          <ZoomIn className="w-3.5 h-3.5" />
                        </span>
                      </span>
                    </span>
                    <span className="mt-1 flex space-x-3">
                      {r.removedPx > 0 && (
                        <span className="text-red-600 dark:text-red-400">−{r.removedPx.toLocaleString()} px</span>
                      )}
                      {r.addedPx > 0 && (
                        <span className="text-green-600 dark:text-green-400">+{r.addedPx.toLocaleString()} px</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {zoomRegion && jobId && (
        <ZoomModal
          jobId={jobId}
          region={zoomRegion}
          onClose={() => setZoomRegion(null)}
        />
      )}
    </div>
  );
}

// Full-screen viewer for one diff region, re-rendered server-side at high
// resolution (up to 20 px/mm) so stroked text and fine geometry are readable.
function ZoomModal({ jobId, region, onClose }: {
  jobId: string;
  region: { idx: number; x0: number; y0: number; x1: number; y1: number };
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const r = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
  const url = `/api/dxfdiff/${jobId}/zoom?x0=${r(region.x0)}&y0=${r(region.y0)}&x1=${r(region.x1)}&y1=${r(region.y1)}`;
  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/70 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-950 rounded-xl shadow-2xl max-w-[90vw] max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3">
          <span className="text-sm font-semibold">差異區 #{region.idx + 1} 高解析檢視</span>
          <span className="text-xs text-slate-400 font-mono">
            ({r(region.x0)}, {r(region.y0)}) – ({r(region.x1)}, {r(region.y1)}) mm
          </span>
          <span className="text-xs text-slate-400 flex items-center space-x-2 ml-2">
            <span className="flex items-center space-x-1">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: '#e11d48' }} />
              <span>移除</span>
            </span>
            <span className="flex items-center space-x-1">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: '#16a34a' }} />
              <span>新增</span>
            </span>
          </span>
          <button
            onClick={onClose}
            className="ml-auto text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer text-lg leading-none px-1"
            title="關閉(Esc)"
          >
            ×
          </button>
        </div>
        <div className="relative overflow-auto bg-white min-w-[360px] min-h-[240px]">
          {!loaded && !failed && (
            <div className="absolute inset-0 flex flex-col items-center justify-center space-y-2 text-slate-500 text-sm">
              <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
              <span>高解析重渲染中(首次約 10–20 秒,之後有快取)…</span>
            </div>
          )}
          {failed && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-red-500">
              <AlertTriangle className="w-4 h-4 mr-1.5" /> 放大渲染失敗,請重試
            </div>
          )}
          <img
            src={url}
            alt={`差異區 #${region.idx + 1}`}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cn('block max-w-[88vw] max-h-[78vh] object-contain select-none', !loaded && 'opacity-0')}
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 對位狀態面板:顯示伺服器量到的位移與共識比例,並提供手動微調。
 * 設計原則是「對位是在決定什麼算沒改」,所以一定要讓使用者看得到、關得掉、改得動。
 */
function AlignPanel({ align, nudge, onNudge, busy, onRealign, onOverlay }: {
  align?: DiffAlign;
  nudge: { dx: number; dy: number };
  onNudge: (n: { dx: number; dy: number }) => void;
  busy: boolean;
  onRealign: (o: { dx?: number; dy?: number; noAlign?: boolean }) => void;
  onOverlay: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!align) return null;

  const mm = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
  const tone = align.applied
    ? 'border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20'
    : align.reason === 'low_consensus'
      ? 'border-amber-300 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20'
      : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900';
  const headline = align.reason === 'manual'
    ? `使用手動指定的位移 X ${mm(align.dx)}、Y ${mm(align.dy)} mm`
    : align.applied
      ? `已自動對齊 X ${mm(align.dx)}、Y ${mm(align.dy)} mm`
      : align.reason === 'already_aligned'
        ? '兩版座標本來就對齊,未套用位移'
        : align.reason === 'low_consensus'
          ? '自動對位不可信,未套用'
          : align.reason === 'disabled'
            ? '已停用自動對位'
            : '找不到可對位的特徵';

  return (
    <div className={cn('rounded-lg border px-3 py-2 text-sm space-y-2', tone)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Crosshair className={cn('w-4 h-4 shrink-0',
          align.applied ? 'text-blue-500' : align.reason === 'low_consensus' ? 'text-amber-500' : 'text-slate-400')} />
        <span className="font-medium">{headline}</span>
        {align.consensusPct !== null && (
          <span className="text-xs text-slate-500">
            孔位共識 {align.consensusPct}%
            {align.crossCheckMm !== null && `,線段交叉驗證差 ${align.crossCheckMm} mm`}
            {align.outliers !== undefined && `,${align.outliers} 個特徵對不上`}
          </span>
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          className="ml-auto text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
        >
          {open ? '收起' : '調整對位'}
        </button>
      </div>

      {align.hint && <p className="text-xs text-amber-700 dark:text-amber-300">{align.hint}</p>}

      {align.models && align.models.length > 1 && (
        <ul className="text-xs text-slate-600 dark:text-slate-300 space-y-0.5">
          {align.models.map((m, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">X {mm(m.dx)} / Y {mm(m.dy)} mm</span>
              <span className="text-slate-400">
                {m.pct}% 的特徵({m.features} 個),分布 ({m.bbox[0]}, {m.bbox[1]})–({m.bbox[2]}, {m.bbox[3]}) mm
              </span>
              {(m.dx !== align.dx || m.dy !== align.dy) && (
                <button
                  onClick={() => onRealign({ dx: m.dx, dy: m.dy })}
                  disabled={busy}
                  className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer disabled:opacity-50"
                >
                  用這個位移重新比對
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {align.regions && align.regions.length > 0 && (
        <ul className="text-xs text-slate-500 space-y-0.5">
          {align.regions.map((r) => (
            <li key={r.name} className="font-mono">
              {r.name}:X {mm(r.dx)} / Y {mm(r.dy)} mm(共識 {r.consensusPct}%,{r.features} 個特徵)
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="flex flex-wrap items-end gap-3 pt-1 border-t border-slate-200 dark:border-slate-800">
          {(['dx', 'dy'] as const).map((k) => (
            <label key={k} className="text-xs text-slate-500 space-y-1">
              <span className="block">{k === 'dx' ? 'X 位移 (mm)' : 'Y 位移 (mm)'}</span>
              <input
                type="number" step={0.1} value={nudge[k]}
                onChange={(e) => onNudge({ ...nudge, [k]: Number(e.target.value) })}
                className="w-24 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 font-mono outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
          ))}
          <button
            onClick={onOverlay}
            className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-white dark:hover:bg-slate-800 cursor-pointer"
            title="兩版疊在一起,方向鍵微調(Shift = 1mm);對齊時線條會消失"
          >
            疊圖微調(方向鍵)
          </button>
          <button
            onClick={() => onRealign({ dx: nudge.dx, dy: nudge.dy })}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium cursor-pointer disabled:opacity-50"
          >
            {busy ? '重新比對中…' : '用這個位移重新比對'}
          </button>
          <button
            onClick={() => onRealign({ noAlign: true })}
            disabled={busy}
            className="text-xs text-slate-500 hover:underline cursor-pointer disabled:opacity-50"
          >
            不要對位
          </button>
        </div>
      )}
    </div>
  );
}
