import { useCallback, useEffect, useRef, useState } from 'react';
import { FileUp, Loader2, AlertTriangle, Crop, Play, X } from 'lucide-react';
import { cn } from './lib/utils';

type View = 'TOP_LIMIT' | 'BOT_LIMIT';

interface JobStatus {
  id: string;
  phase: 'preparing' | 'awaiting-views' | 'extracting' | 'registering' | 'migrating' | 'done' | 'error';
  progress: Record<string, number>;
  message: string;
  error?: string;
  overviewReady: boolean;
  /** replace-dxf: previous revision's view boxes (mm) for framing prefill */
  prevViews?: Partial<Record<View, [number, number, number, number]>>;
  log: string[];
}

interface Extents {
  x0: number; y0: number; x1: number; y1: number; pxw: number; pxh: number;
}

/** px (displayed image) -> DXF mm box, given natural extents. */
function toDxfBox(
  r: { x: number; y: number; w: number; h: number },
  ext: Extents,
  disp: { w: number; h: number },
): [number, number, number, number] {
  const sx = (ext.x1 - ext.x0) / disp.w;
  const sy = (ext.y1 - ext.y0) / disp.h;
  const x0 = ext.x0 + r.x * sx;
  const x1 = ext.x0 + (r.x + r.w) * sx;
  const y1 = ext.y1 - r.y * sy;
  const y0 = ext.y1 - (r.y + r.h) * sy;
  return [Math.round(x0 * 10) / 10, Math.round(y0 * 10) / 10,
          Math.round(x1 * 10) / 10, Math.round(y1 * 10) / 10];
}

export default function UploadWizard({
  onDone,
  onClose,
  replace,
}: {
  onDone: (boardId: string) => void;
  onClose: () => void;
  /** 更換模式:'stp' = 只換 3D 模型(保留 DXF 成果);'dxf' = 只換圖面(沿用 STP 與未變區的人工判定) */
  replace?: { mode: 'stp' | 'dxf'; id: string; title: string } | null;
}) {
  const repStp = replace?.mode === 'stp';
  const repDxf = replace?.mode === 'dxf';
  const [dxf, setDxf] = useState<File | null>(null);
  const [stp, setStp] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [extents, setExtents] = useState<Extents | null>(null);
  const [rects, setRects] = useState<Partial<Record<View, { x: number; y: number; w: number; h: number }>>>({});
  const [drawTarget, setDrawTarget] = useState<View>('TOP_LIMIT');
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  async function start() {
    if (repStp ? !stp : repDxf ? !dxf : (!dxf || !stp)) return;
    setUploading(true); setError(null);
    try {
      const fd = new FormData();
      if (!repDxf) fd.append('stp', stp!);
      if (!repStp) fd.append('dxf', dxf!);
      if (replace) fd.append('sourceBoardId', replace.id);
      const url = repStp ? '/api/analyze/replace-stp'
        : repDxf ? '/api/analyze/replace-dxf' : '/api/analyze';
      const res = await fetch(url, { method: 'POST', body: fd });
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
    if (!jobId) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/analyze/${jobId}`);
        const data = (await res.json()) as JobStatus;
        setStatus(data);
        if (data.phase === 'done') {
          clearInterval(t);
          onDone(jobId);
        }
        if (data.phase === 'error') clearInterval(t);
      } catch { /* transient */ }
    }, 1500);
    return () => clearInterval(t);
  }, [jobId, onDone]);

  useEffect(() => {
    if (status?.overviewReady && jobId && !extents) {
      fetch(`/api/analyze/${jobId}/overview.json`)
        .then((r) => r.json())
        .then(setExtents)
        .catch(() => {});
    }
  }, [status?.overviewReady, jobId, extents]);

  async function submitViews() {
    if (!jobId || !extents || !imgRef.current || !rects.TOP_LIMIT || !rects.BOT_LIMIT) return;
    const disp = { w: imgRef.current.clientWidth, h: imgRef.current.clientHeight };
    const views = {
      TOP_LIMIT: toDxfBox(rects.TOP_LIMIT, extents, disp),
      BOT_LIMIT: toDxfBox(rects.BOT_LIMIT, extents, disp),
    };
    const res = await fetch(`/api/analyze/${jobId}/views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ views }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data?.error || `HTTP ${res.status}`);
    }
  }

  // replace-dxf:把上一版的視圖框(mm)換算成顯示座標預填,確認即可
  const [prefilled, setPrefilled] = useState(false);
  const prefill = useCallback(() => {
    const pv = status?.prevViews;
    const img = imgRef.current;
    if (prefilled || !repDxf || !extents || !pv?.TOP_LIMIT || !pv?.BOT_LIMIT || !img?.clientWidth) return;
    const sx = img.clientWidth / (extents.x1 - extents.x0);
    const sy = img.clientHeight / (extents.y1 - extents.y0);
    const toPx = (b: [number, number, number, number]) => ({
      x: (b[0] - extents.x0) * sx,
      y: (extents.y1 - b[3]) * sy,
      w: (b[2] - b[0]) * sx,
      h: (b[3] - b[1]) * sy,
    });
    setRects({ TOP_LIMIT: toPx(pv.TOP_LIMIT), BOT_LIMIT: toPx(pv.BOT_LIMIT) });
    setPrefilled(true);
  }, [prefilled, repDxf, extents, status?.prevViews]);
  useEffect(() => { prefill(); }, [prefill, status?.phase]);

  const framing = status?.phase === 'awaiting-views' && extents;

  return (
    <section className="border border-blue-300 dark:border-blue-800 bg-white dark:bg-slate-950 rounded-xl p-4 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center space-x-2">
          <FileUp className="w-4 h-4 text-blue-500" />
          <span>
            {repStp
              ? `更換 STP:${replace!.title}(保留 DXF 標註成果)`
              : repDxf
                ? `更換 DXF:${replace!.title}(沿用 STP 與人工判定)`
                : '上傳新板卡(DXF + STP)'}
          </span>
        </h3>
        <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer" aria-label="關閉">
          <X className="w-4 h-4" />
        </button>
      </div>

      {!jobId && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          {!repStp && <FilePick label={repDxf ? '新版 DXF(2D 圖面)' : 'DXF(2D 圖面)'} accept=".dxf" file={dxf} onPick={setDxf} />}
          {!repDxf && <FilePick label={repStp ? '新 STP(3D 模型)' : 'STP(3D 模型)'} accept=".stp,.step" file={stp} onPick={setStp} />}
          <button
            onClick={start}
            disabled={(repStp ? !stp : repDxf ? !dxf : (!dxf || !stp)) || uploading}
            className="sm:ml-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center space-x-2 text-sm font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            <span>開始分析</span>
          </button>
        </div>
      )}

      {status && status.phase !== 'awaiting-views' && (
        <div className="text-sm space-y-2">
          <div className="flex items-center space-x-2">
            {status.phase === 'error'
              ? <AlertTriangle className="w-4 h-4 text-red-500" />
              : <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
            <span className={cn(status.phase === 'error' && 'text-red-600 dark:text-red-400')}>
              {status.error ?? status.message}
            </span>
          </div>
          <div className="flex gap-4 text-xs text-slate-500 font-mono">
            {Object.entries(status.progress).map(([k, v]) => (
              <span key={k}>{k}: {v}%</span>
            ))}
          </div>
          {status.phase === 'preparing' && (
            <p className="text-xs text-slate-400">
              {repStp
                ? 'STP 世界座標解算需要數分鐘(OpenCASCADE),完成後會自動重新對位;DXF 標註與已填的 H 值全部保留,不需重新框視圖。'
                : repDxf
                  ? '正在渲染新版縮覽;完成後會出現預填好的視圖框,確認或微調即可。'
                  : 'STP 世界座標解算需要數分鐘(OpenCASCADE)。縮覽圖好了就可以先框視圖,兩者平行進行。'}
            </p>
          )}
          {status.phase === 'migrating' && (
            <p className="text-xs text-slate-400">
              正在比對新舊圖面差異:沒變的區域自動沿用上一版判定,有變的區域會進待確認清單。
            </p>
          )}
        </div>
      )}

      {framing && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Crop className="w-4 h-4 text-slate-500" />
            <span>
              {repDxf && prefilled
                ? '已預填上一版的視圖框,直接確認或重新拖曳調整:'
                : '在縮覽圖上拖曳框出兩個 Limit 視圖:'}
            </span>
            {(['TOP_LIMIT', 'BOT_LIMIT'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setDrawTarget(v)}
                className={cn(
                  'px-3 py-1 rounded-lg border text-sm cursor-pointer',
                  drawTarget === v
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 font-semibold'
                    : 'border-slate-300 dark:border-slate-700 text-slate-500',
                  rects[v] && 'ring-1 ring-green-500',
                )}
              >
                {v === 'TOP_LIMIT' ? '① 頂面 Limit' : '② 底面 Limit'}
                {rects[v] ? ' ✓' : ''}
              </button>
            ))}
            <button
              onClick={submitViews}
              disabled={!rects.TOP_LIMIT || !rects.BOT_LIMIT}
              className="ml-auto px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              確認並繼續分析
            </button>
          </div>
          <div
            className="relative select-none overflow-auto max-h-[520px] border border-slate-200 dark:border-slate-800 rounded-lg"
            onMouseDown={(e) => {
              const r = imgRef.current?.getBoundingClientRect();
              if (!r) return;
              setDrag({ x: e.clientX - r.left, y: e.clientY - r.top });
              setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
            }}
            onMouseMove={(e) => {
              if (!drag) return;
              const r = imgRef.current?.getBoundingClientRect();
              if (!r) return;
              setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
            }}
            onMouseUp={() => {
              if (drag && cursor) {
                const x = Math.min(drag.x, cursor.x); const y = Math.min(drag.y, cursor.y);
                const w = Math.abs(cursor.x - drag.x); const h = Math.abs(cursor.y - drag.y);
                if (w > 12 && h > 12) {
                  setRects((prev) => ({ ...prev, [drawTarget]: { x, y, w, h } }));
                  if (drawTarget === 'TOP_LIMIT' && !rects.BOT_LIMIT) setDrawTarget('BOT_LIMIT');
                }
              }
              setDrag(null); setCursor(null);
            }}
          >
            <img
              ref={imgRef}
              src={`/api/analyze/${jobId}/overview.jpg`}
              alt="DXF 縮覽"
              className="w-full h-auto cursor-crosshair"
              draggable={false}
              onLoad={prefill}
            />
            {(Object.entries(rects) as [View, { x: number; y: number; w: number; h: number }][]).map(([v, r]) => (
              <div
                key={v}
                className={cn(
                  'absolute border-2 pointer-events-none',
                  v === 'TOP_LIMIT' ? 'border-blue-500 bg-blue-500/10' : 'border-amber-500 bg-amber-500/10',
                )}
                style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
              >
                <span className={cn(
                  'absolute -top-5 left-0 text-[11px] font-semibold px-1 rounded',
                  v === 'TOP_LIMIT' ? 'bg-blue-500 text-white' : 'bg-amber-500 text-white',
                )}>
                  {v === 'TOP_LIMIT' ? 'TOP Limit' : 'BOT Limit'}
                </span>
              </div>
            ))}
            {drag && cursor && (
              <div
                className="absolute border-2 border-dashed border-blue-400 pointer-events-none"
                style={{
                  left: Math.min(drag.x, cursor.x), top: Math.min(drag.y, cursor.y),
                  width: Math.abs(cursor.x - drag.x), height: Math.abs(cursor.y - drag.y),
                }}
              />
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start space-x-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="font-mono">{error}</span>
        </div>
      )}
      {status?.phase === 'error' && status.log.length > 0 && (
        <pre className="text-[11px] text-slate-500 bg-slate-50 dark:bg-slate-900 rounded-lg p-2 overflow-x-auto max-h-40">
          {status.log.join('\n')}
        </pre>
      )}
    </section>
  );
}

export function FilePick({
  label, accept, file, onPick,
}: {
  label: string; accept: string; file: File | null; onPick: (f: File | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      <input
        ref={ref} type="file" accept={accept} className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <button
        onClick={() => ref.current?.click()}
        className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:border-blue-500 text-sm flex items-center space-x-2 cursor-pointer"
      >
        <FileUp className="w-4 h-4" />
        <span>{label}</span>
      </button>
      <span className="text-xs text-slate-500 font-mono max-w-[160px] truncate">
        {file ? file.name : '未選擇'}
      </span>
    </div>
  );
}
