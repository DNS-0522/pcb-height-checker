import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GitCompareArrows, Loader2, AlertTriangle, Play, ZoomIn, MapPin,
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

interface DiffMeta {
  x0: number; y0: number; x1: number; y1: number;
  pxw: number; pxh: number;
  removedPx: number; addedPx: number;
  regions: DiffRegion[];
  regionsTotal: number;
}

type ImgMode = 'diff' | 'a' | 'b';

const MODE_LABEL: Record<ImgMode, string> = { diff: '差異', a: '舊版', b: '新版' };

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
  const [selRegion, setSelRegion] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function start() {
    if (!fileA || !fileB) return;
    setUploading(true); setError(null);
    setMeta(null); setStatus(null); setSelRegion(null); setMode('diff'); setZoom(1);
    try {
      const fd = new FormData();
      fd.append('dxfA', fileA);
      fd.append('dxfB', fileB);
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
          setMeta((await m.json()) as DiffMeta);
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

  const running = status && status.phase === 'running';

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
        <p className="text-xs text-slate-400">
          兩版圖面需來自同一張圖框(相同座標系統的 CAD 輸出);整張圖會以相同範圍渲染後逐像素比對。
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
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <div className="flex rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden">
              {(['diff', 'a', 'b'] as ImgMode[]).map((m) => (
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
                <img
                  src={`/api/dxfdiff/${jobId}/img/${mode}.jpg`}
                  alt={MODE_LABEL[mode]}
                  className="w-full h-auto block select-none"
                  draggable={false}
                />
                {mode === 'diff' && meta.regions.map((r, i) => (
                  <button
                    key={i}
                    onClick={() => setSelRegion(i === selRegion ? null : i)}
                    className={cn(
                      'absolute border rounded-sm cursor-pointer',
                      i === selRegion
                        ? 'border-2 border-blue-500 bg-blue-500/10'
                        : 'border-amber-400/70 hover:border-amber-500 hover:bg-amber-400/10',
                    )}
                    style={regionBox(r)}
                    title={`差異區 #${i + 1}`}
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
                      <span className="font-mono text-slate-400">
                        ({r.x0.toFixed(0)}, {r.y0.toFixed(0)})
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
    </div>
  );
}
