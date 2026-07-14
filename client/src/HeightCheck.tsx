import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  Ruler,
  SlidersHorizontal,
  Layers,
  Search,
  Info,
  FileUp,
  PenLine,
} from 'lucide-react';
import { cn, fmt } from './lib/utils';
import UploadWizard from './UploadWizard';

type View = 'TOP_LIMIT' | 'BOT_LIMIT';
type Status = 'ok' | 'violation' | 'keepout' | 'no_limit' | 'placeholder';

interface Zone {
  id: string;
  view: View;
  value: number | null;
  conflict: boolean;
  labelValues: number[];
  areaMm2: number | null;
  explicit?: boolean;
  polygon: [number, number][];
  num?: string;
  state?: 'valued' | 'pending' | 'nolimit';
  overridden?: boolean;
}

interface Meta {
  boardId: string;
  title: string;
  dxf: string;
  stp: string;
  board: { width: number; depth: number; thickness: number };
  views: Record<View, [number, number, number, number]>;
  extractedAt: string;
  decisionsApplied: string[];
  pendingDecisions: string[];
  registration: Record<string, {
    tx: number;
    ty: number;
    mirror: boolean;
    fitErrMm?: number | null;
    dxfBoardOutline?: [number, number][];
    stpBoardOutline?: [number, number][];
    stpBoardRect?: [number, number, number, number];
  }> & { accuracyMm?: number };
}

interface CheckRules {
  toleranceMm: number;
  keepoutMode: 'list' | 'strict' | 'threshold';
  keepoutThresholdMm: number;
  placeholderMode: 'flag' | 'asHeight';
}

interface ResultComponent {
  id: string;
  footprint: string;
  side: 'top' | 'bottom';
  view: View;
  h: number;
  allowed: number | null;
  zoneConflict: boolean;
  placeholder: boolean;
  box: [number, number, number, number];
  status: Status;
}

interface RunResponse {
  rules: CheckRules;
  stats: Record<Status, number>;
  results: ResultComponent[];
}

interface HLabel {
  id: string;
  view: View;
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  read: string;
  score: number;
  value: number | null;
  flagged: boolean;
  zoneId: string | null;
  crop?: string;
  cropBox?: [number, number, number, number];
}

interface BoardInfo {
  id: string;
  title: string;
  source: 'builtin' | 'upload';
}

const ROW_CAP = 300;

const STATUS_META: Record<Status, { label: string; color: string; chip: string }> = {
  violation: { label: '超高違規', color: '#dc2626', chip: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
  keepout: { label: 'H=0 區內', color: '#f59e0b', chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  ok: { label: 'OK', color: '#16a34a', chip: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' },
  no_limit: { label: '無限高標註', color: '#94a3b8', chip: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  placeholder: { label: '3.81mm 佔位', color: '#3b82f6', chip: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
};

/** Zone fill: tighter limit = hotter. */
function zoneColor(v: number): string {
  if (v === 0) return '#64748b';
  if (v <= 0.6) return '#e11d48';
  if (v <= 0.85) return '#ea580c';
  if (v <= 1) return '#d97706';
  if (v <= 1.2) return '#ca8a04';
  if (v <= 2) return '#65a30d';
  if (v <= 2.5) return '#16a34a';
  return '#0d9488';
}

export default function HeightCheck() {
  const [boards, setBoards] = useState<BoardInfo[]>([]);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [labels, setLabels] = useState<HLabel[]>([]);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState<View>('TOP_LIMIT');
  const [rules, setRules] = useState<CheckRules>({
    toleranceMm: 0.05,
    keepoutMode: 'list',
    keepoutThresholdMm: 0.5,
    placeholderMode: 'flag',
  });
  const [statusFilter, setStatusFilter] = useState<Set<Status>>(
    () => new Set<Status>(['violation', 'keepout', 'ok', 'no_limit', 'placeholder']),
  );
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const [showBackdrop, setShowBackdrop] = useState(true);
  const [showAlign, setShowAlign] = useState(true);
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const boardRef = useRef<HTMLElement | null>(null);
  const [mode, setMode] = useState<'result' | 'debug'>('result');
  const [debugBase, setDebugBase] = useState<'draw' | 'walls' | 'cc'>('cc');
  const [debugZones, setDebugZones] = useState<Record<string, { id: string; areaMm2: number; polygon: [number, number][] }[]>>({});
  const [debugLabel, setDebugLabel] = useState<string | null>(null);
  const [debugOutlines, setDebugOutlines] = useState(true);

  const refreshBoards = useCallback(async (): Promise<BoardInfo[]> => {
    const res = await fetch('/api/heightcheck/boards');
    const data = (await res.json()) as BoardInfo[];
    setBoards(data);
    return data;
  }, []);

  useEffect(() => {
    refreshBoards()
      .then((data) => setBoardId((cur) => cur ?? data[0]?.id ?? null))
      .catch(() => setError('無法取得板卡清單'));
  }, [refreshBoards]);

  const loadDataset = useCallback(async (id: string) => {
    const res = await fetch(`/api/heightcheck/dataset/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    setMeta(data.meta);
    setZones(data.zones);
    setLabels(data.labels ?? []);
  }, []);

  useEffect(() => {
    if (!boardId) return;
    setMeta(null); setRun(null); setLoading(true); setDebugZones({});
    loadDataset(boardId).catch((e) =>
      setError(e instanceof Error ? e.message : '載入資料集失敗'));
  }, [boardId, loadDataset]);

  useEffect(() => {
    if (mode !== 'debug' || !boardId || Object.keys(debugZones).length) return;
    fetch(`/api/heightcheck/debugzones/${boardId}`)
      .then((r) => r.json())
      .then(setDebugZones)
      .catch(() => {});
  }, [mode, boardId, debugZones]);

  useEffect(() => {
    if (!meta || !boardId) return;
    setLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/heightcheck/run/${boardId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rules }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        setRun(data as RunResponse);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : '檢查執行失敗');
      } finally {
        setLoading(false);
      }
    })();
  }, [meta, rules, boardId]);

  async function saveZone(zoneId: string, value: number | 'nolimit' | null) {
    if (!boardId) return;
    const res = await fetch(`/api/heightcheck/zone/${boardId}/${zoneId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (res.ok) {
      await loadDataset(boardId);       // re-derive zones; run re-triggers via meta
    }
  }

  const viewZones = useMemo(() => zones.filter((z) => z.view === view), [zones, view]);
  const viewResults = useMemo(
    () => (run?.results ?? []).filter((r) => r.view === view),
    [run, view],
  );

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (run?.results ?? [])
      .filter((r) => statusFilter.has(r.status))
      .filter((r) => !q || r.id.toLowerCase().includes(q) || r.footprint.toLowerCase().includes(q))
      .sort((a, b) => {
        const ov = (r: ResultComponent) => (r.allowed !== null && r.allowed > 0 ? r.h - r.allowed : -999);
        if (a.status === 'violation' && b.status !== 'violation') return -1;
        if (b.status === 'violation' && a.status !== 'violation') return 1;
        return ov(b) - ov(a);
      });
  }, [run, statusFilter, query]);

  const ready = !!(meta && run);
  const vb = meta?.views[view] ?? [0, 0, 1, 1];
  const [vx0, vy0, vx1, vy1] = vb;

  const toggleStatus = (s: Status) =>
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const pendingZones = zones
    .filter((z) => z.state === 'pending')
    .sort((a, b) => (b.areaMm2 ?? 0) - (a.areaMm2 ?? 0));

  return (
    <div className="space-y-6">
      {/* board selector + upload */}
      <section className="flex flex-wrap items-center gap-3">
        <label className="flex items-center space-x-2 text-sm">
          <span className="text-slate-500">板卡</span>
          <select
            value={boardId ?? ''}
            onChange={(e) => setBoardId(e.target.value)}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 outline-none focus:ring-2 focus:ring-blue-500"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}{b.source === 'upload' ? `(上傳 ${b.id})` : '(內建示範)'}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => setShowWizard((s) => !s)}
          className="px-4 py-1.5 rounded-lg border border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm font-medium flex items-center space-x-2 cursor-pointer"
        >
          <FileUp className="w-4 h-4" />
          <span>上傳新板卡</span>
        </button>
      </section>

      {showWizard && (
        <UploadWizard
          onClose={() => setShowWizard(false)}
          onDone={async (id) => {
            setShowWizard(false);
            await refreshBoards();
            setBoardId(id);
          }}
        />
      )}

      {error && !run && (
        <div className="flex items-start space-x-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="font-mono">{error}</span>
        </div>
      )}
      {!ready && !error && (
        <div className="text-center py-16 text-slate-400">
          <Loader2 className="w-8 h-8 mx-auto mb-3 animate-spin opacity-60" />
          <p className="text-sm">載入資料集…</p>
        </div>
      )}

      {meta && run && (<>
      {/* review queue: every numbered zone that still has no H value */}
      {pendingZones.length > 0 && (
        <section className="border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-950 rounded-xl p-4 shadow-sm">
          <h3 className="text-sm font-semibold mb-1 flex items-center space-x-2">
            <PenLine className="w-4 h-4 text-amber-500" />
            <span>待確認區({pendingZones.length})</span>
          </h3>
          <p className="text-xs text-slate-400 mb-3">
            這些編號區還沒有限高值(自動讀值沒讀到,或圖面沒標)。給值、或按「無限制」跳過;
            區內若有讀不出的標註會附小圖當提示。依面積大到小排列。
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {pendingZones.map((z) => (
              <PendingZoneCard
                key={z.id}
                zone={z}
                hints={labels.filter((l) => l.zoneId === z.id && l.flagged)}
                focused={focusLabel === z.id}
                outline={meta.registration[z.view]?.dxfBoardOutline}
                viewBox={meta.views[z.view]}
                onSave={saveZone}
                onLocate={() => {
                  setView(z.view);
                  setFocusLabel(z.id === focusLabel ? null : z.id);
                  boardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }}
              />
            ))}
          </div>
        </section>
      )}

      {/* stats + rules */}
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {(Object.keys(STATUS_META) as Status[]).map((s) => (
          <button
            key={s}
            onClick={() => toggleStatus(s)}
            className={cn(
              'rounded-xl border p-3 text-left shadow-sm transition-opacity cursor-pointer',
              'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950',
              !statusFilter.has(s) && 'opacity-40',
            )}
            title={statusFilter.has(s) ? '點擊隱藏此類' : '點擊顯示此類'}
          >
            <div className="flex items-center space-x-2 text-xs font-semibold text-slate-500">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: STATUS_META[s].color }} />
              <span>{STATUS_META[s].label}</span>
            </div>
            <div className="mt-1 text-2xl font-mono font-bold">{run.stats[s]}</div>
          </button>
        ))}
      </section>

      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl p-4 shadow-sm">
        <h3 className="text-sm font-semibold mb-3 flex items-center space-x-2">
          <SlidersHorizontal className="w-4 h-4 text-slate-500" />
          <span>判定規則</span>
          <span className="text-xs font-normal text-slate-400">改動即重新判定(H=0 語義 = 待決策 6)</span>
        </h3>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
          <label className="flex items-center space-x-2">
            <span className="text-slate-500">H=0 區內零件</span>
            <select
              value={rules.keepoutMode}
              onChange={(e) => setRules({ ...rules, keepoutMode: e.target.value as CheckRules['keepoutMode'] })}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-900"
            >
              <option value="list">列成獨立清單(不判違規)</option>
              <option value="strict">一律視為違規</option>
              <option value="threshold">超過門檻才違規</option>
            </select>
          </label>
          {rules.keepoutMode === 'threshold' && (
            <label className="flex items-center space-x-2">
              <span className="text-slate-500">門檻 (mm)</span>
              <input
                type="number"
                step="0.1"
                min="0"
                value={rules.keepoutThresholdMm}
                onChange={(e) => setRules({ ...rules, keepoutThresholdMm: Number(e.target.value) })}
                className="w-20 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500"
              />
            </label>
          )}
          <label className="flex items-center space-x-2">
            <span className="text-slate-500">容差 (mm)</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={rules.toleranceMm}
              onChange={(e) => setRules({ ...rules, toleranceMm: Number(e.target.value) })}
              className="w-20 rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          <label className="flex items-center space-x-2">
            <span className="text-slate-500">3.81mm 佔位件</span>
            <select
              value={rules.placeholderMode}
              onChange={(e) => setRules({ ...rules, placeholderMode: e.target.value as CheckRules['placeholderMode'] })}
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-900"
            >
              <option value="flag">另列不判定</option>
              <option value="asHeight">照 3.81mm 判定</option>
            </select>
          </label>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
        </div>
        <p className="mt-3 text-xs text-slate-400 flex items-start space-x-1.5">
          <Info className="w-3.5 h-3.5 mt-px shrink-0" />
          <span>
            已套用決策:{meta.decisionsApplied.join(';')}。對位精度約 ±{meta.registration.accuracyMm ?? 1}mm。
          </span>
        </p>
      </section>

      {/* board viewer */}
      <section
        ref={(el) => { boardRef.current = el; }}
        className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl shadow-sm overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3">
          <h3 className="text-sm font-semibold flex items-center space-x-2">
            <Ruler className="w-4 h-4 text-slate-500" />
            <span>板圖 · {meta.title}</span>
          </h3>
          <div className="flex items-center rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden text-sm">
            {(['TOP_LIMIT', 'BOT_LIMIT'] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'px-3 py-1.5 transition-colors cursor-pointer',
                  view === v ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
                )}
              >
                {v === 'TOP_LIMIT' ? '頂面 TOP' : '底面 BOT'}
              </button>
            ))}
          </div>
          <div className="flex items-center rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden text-xs">
            {(
              [
                ['result', '結果'],
                ['debug', '切區 Debug'],
              ] as const
            ).map(([m, lab]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  'px-2.5 py-1.5 transition-colors cursor-pointer',
                  mode === m ? 'bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-900' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
                )}
              >
                {lab}
              </button>
            ))}
          </div>
          {mode === 'result' ? (
            <>
              <label className="flex items-center space-x-1.5 text-xs text-slate-500 cursor-pointer">
                <input type="checkbox" checked={showBackdrop} onChange={(e) => setShowBackdrop(e.target.checked)} />
                <span>DXF 底圖</span>
              </label>
              <label className="flex items-center space-x-1.5 text-xs text-slate-500 cursor-pointer">
                <input type="checkbox" checked={showAlign} onChange={(e) => setShowAlign(e.target.checked)} />
                <span>板框對位</span>
              </label>
            </>
          ) : (
            <div className="flex items-center gap-3 text-xs text-slate-500">
              {(
                [
                  ['draw', 'DXF 原圖'],
                  ['walls', '牆壁光柵'],
                  ['cc', '切區上色'],
                ] as const
              ).map(([b, lab]) => (
                <label key={b} className="flex items-center space-x-1 cursor-pointer">
                  <input type="radio" name="dbgbase" checked={debugBase === b} onChange={() => setDebugBase(b)} />
                  <span>{lab}</span>
                </label>
              ))}
              <label className="flex items-center space-x-1 cursor-pointer border-l border-slate-300 dark:border-slate-700 pl-3">
                <input type="checkbox" checked={debugOutlines} onChange={(e) => setDebugOutlines(e.target.checked)} />
                <span>區塊外框(綠=有標註,紅=無)</span>
              </label>
            </div>
          )}
          <span className="text-xs text-slate-400 ml-auto">
            區域色 = 限高(越紅越嚴);方塊 = 零件(依判定著色);滑過看明細
          </span>
        </div>
        <div className="relative">
          <svg
            viewBox={`${vx0} ${-vy1} ${vx1 - vx0} ${vy1 - vy0}`}
            className="w-full h-auto bg-white dark:bg-slate-900"
            onMouseLeave={() => setHover(null)}
          >
            {mode === 'debug' && boardId && (
              <image
                href={
                  debugBase === 'draw'
                    ? `/api/heightcheck/viewimg/${boardId}/${view}`
                    : `/api/heightcheck/debugimg/${boardId}/${debugBase}/${view}`
                }
                x={vx0}
                y={-vy1}
                width={vx1 - vx0}
                height={vy1 - vy0}
                opacity={debugBase === 'cc' ? 0.75 : 0.9}
                preserveAspectRatio="none"
              />
            )}
            {mode === 'result' && showBackdrop && boardId && (
              <image
                href={`/api/heightcheck/viewimg/${boardId}/${view}`}
                x={vx0}
                y={-vy1}
                width={vx1 - vx0}
                height={vy1 - vy0}
                opacity={0.45}
                preserveAspectRatio="none"
              />
            )}
            {mode === 'debug' && debugOutlines && (debugZones[view] ?? []).map((z) => {
              const labeled = labels.some((l) => l.zoneId === z.id);
              return (
                <polygon
                  key={z.id}
                  points={z.polygon.map(([x, y]) => `${x},${-y}`).join(' ')}
                  fill="none"
                  stroke={labeled ? '#16a34a' : '#dc2626'}
                  strokeWidth={labeled ? 0.5 : 0.35}
                  strokeDasharray={labeled ? undefined : '1.2 0.8'}
                  onMouseMove={(e) =>
                    setHover({
                      x: e.clientX,
                      y: e.clientY,
                      lines: [
                        `區塊 ${z.id}(${labeled ? '有標註' : '無標註'})`,
                        `面積 ${fmt(z.areaMm2, 0)} mm²`,
                      ],
                    })
                  }
                />
              );
            })}
            {mode === 'debug' &&
              labels
                .filter((l) => l.view === view)
                .map((l) => (
                  <circle
                    key={l.id}
                    cx={l.cx}
                    cy={-l.cy}
                    r={1.6}
                    fill={l.value !== null ? '#16a34a' : '#f59e0b'}
                    stroke="#fff"
                    strokeWidth={0.3}
                    className="cursor-pointer"
                    onClick={() => setDebugLabel(l.id === debugLabel ? null : l.id)}
                    onMouseMove={(e) =>
                      setHover({
                        x: e.clientX,
                        y: e.clientY,
                        lines: [
                          `${l.id} 讀作「${l.read}」 score=${l.score}`,
                          `值:${l.value ?? '待確認'} → 區塊 ${l.zoneId ?? '無(認領失敗)'}`,
                          '點一下顯示認領採樣點',
                        ],
                      })
                    }
                  />
                ))}
            {mode === 'debug' && debugLabel && (() => {
              const l = labels.find((x) => x.id === debugLabel && x.view === view);
              if (!l) return null;
              const mx = (l.x1 - l.x0) / 2 + 1.0;
              const my = (l.y1 - l.y0) / 2 + 1.0;
              const ring = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]] as const;
              const tierPts: { x: number; y: number; tier: number }[] = [
                { x: l.cx, y: l.cy, tier: 0 },
                ...ring.map(([dx, dy]) => ({ x: l.cx + dx*mx*0.5, y: l.cy + dy*my*0.5, tier: 1 })),
                ...ring.map(([dx, dy]) => ({ x: l.cx + dx*mx, y: l.cy + dy*my, tier: 2 })),
              ];
              const tierColor = ['#2563eb', '#9333ea', '#ea580c'];
              const zone = (debugZones[view] ?? []).find((z) => z.id === l.zoneId);
              return (
                <g pointerEvents="none">
                  <rect x={l.x0} y={-l.y1} width={l.x1-l.x0} height={l.y1-l.y0}
                        fill="none" stroke="#0ea5e9" strokeWidth={0.35} strokeDasharray="1 0.6" />
                  {zone && (
                    <polygon
                      points={zone.polygon.map(([x, y]) => `${x},${-y}`).join(' ')}
                      fill="#16a34a" fillOpacity={0.15} stroke="#16a34a" strokeWidth={0.9}
                    />
                  )}
                  {tierPts.map((p, i) => (
                    <g key={i}>
                      <line x1={p.x-0.8} y1={-p.y} x2={p.x+0.8} y2={-p.y} stroke={tierColor[p.tier]} strokeWidth={0.35} />
                      <line x1={p.x} y1={-p.y-0.8} x2={p.x} y2={-p.y+0.8} stroke={tierColor[p.tier]} strokeWidth={0.35} />
                    </g>
                  ))}
                </g>
              );
            })()}
            {mode === 'result' && viewZones.map((z) => {
              const pending = z.state === 'pending';
              const nolimit = z.state === 'nolimit';
              if (z.value === null && !pending) {
                // nolimit / unvalued: leave uncoloured but still hoverable
                return (
                  <polygon
                    key={z.id}
                    points={z.polygon.map(([x, y]) => `${x},${-y}`).join(' ')}
                    fill="transparent"
                    stroke="none"
                    onMouseMove={(e) =>
                      setHover({
                        x: e.clientX,
                        y: e.clientY,
                        lines: [
                          `區 ${z.num ?? z.id}${nolimit ? ':已確認無限制' : ''}`,
                          z.areaMm2 ? `面積 ${fmt(z.areaMm2, 0)} mm²` : '',
                        ].filter(Boolean),
                      })
                    }
                  />
                );
              }
              return (
                <polygon
                  key={z.id}
                  points={z.polygon.map(([x, y]) => `${x},${-y}`).join(' ')}
                  fill={pending ? '#f59e0b' : zoneColor(z.value!)}
                  fillOpacity={pending ? 0.18 : z.value === 0 ? 0.28 : 0.34}
                  stroke={pending ? '#f59e0b' : z.conflict ? '#dc2626' : zoneColor(z.value!)}
                  strokeWidth={z.conflict || pending ? 0.6 : 0.25}
                  strokeDasharray={z.conflict || pending ? '1.5 1' : undefined}
                  className={pending ? 'cursor-pointer' : undefined}
                  onClick={
                    pending
                      ? () => {
                          setFocusLabel(z.id);
                          document.getElementById(`pending-${z.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                      : undefined
                  }
                  onMouseMove={(e) =>
                    setHover({
                      x: e.clientX,
                      y: e.clientY,
                      lines: pending
                        ? [`區 ${z.num ?? z.id}:待確認(點一下跳到輸入卡片)`,
                           z.areaMm2 ? `面積 ${fmt(z.areaMm2, 0)} mm²` : '']
                        : [
                            `區 ${z.num ?? z.id} · 限高 H=${z.value}${z.overridden ? '(人工)' : ''}`,
                            z.conflict ? `⚠ 多重標註 {${z.labelValues.join(', ')}} 取較低` : '',
                            z.areaMm2 ? `面積 ${fmt(z.areaMm2, 0)} mm²` : '',
                          ].filter(Boolean),
                    })
                  }
                />
              );
            })}
            {mode === 'result' && showAlign && meta.registration[view]?.dxfBoardOutline && (
              <polygon
                points={meta.registration[view].dxfBoardOutline!.map(([x, y]) => `${x},${-y}`).join(' ')}
                fill="none"
                stroke="#0f172a"
                strokeWidth={0.7}
                opacity={0.9}
                className="dark:stroke-slate-200"
              />
            )}
            {mode === 'result' && showAlign && meta.registration[view]?.stpBoardOutline?.length ? (
              <g>
                {meta.registration[view].stpBoardOutline!.map(([x, y], i) => (
                  <circle key={i} cx={x} cy={-y} r={0.45} fill="#2563eb" />
                ))}
              </g>
            ) : mode === 'result' && showAlign && meta.registration[view]?.stpBoardRect ? (() => {
              const [bx0, by0, bx1, by1] = meta.registration[view].stpBoardRect!;
              return (
                <rect
                  x={bx0}
                  y={-by1}
                  width={bx1 - bx0}
                  height={by1 - by0}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={0.8}
                  strokeDasharray="3 1.6"
                />
              );
            })() : null}
            {mode === 'result' && viewResults
              .filter((r) => statusFilter.has(r.status))
              .map((r) => {
                const [x0, y0, x1, y1] = r.box;
                return (
                  <rect
                    key={r.id + r.view}
                    x={x0}
                    y={-y1}
                    width={Math.max(x1 - x0, 0.3)}
                    height={Math.max(y1 - y0, 0.3)}
                    fill={STATUS_META[r.status].color}
                    fillOpacity={r.status === 'violation' ? 0.95 : r.status === 'ok' ? 0.5 : 0.55}
                    stroke={selected === r.id ? '#1d4ed8' : 'none'}
                    strokeWidth={selected === r.id ? 1.2 : 0}
                    className="cursor-pointer"
                    onClick={() => setSelected(r.id === selected ? null : r.id)}
                    onMouseMove={(e) =>
                      setHover({
                        x: e.clientX,
                        y: e.clientY,
                        lines: [
                          `${r.id}(${r.footprint})`,
                          `實高 ${fmt(r.h)} mm · 限高 ${r.allowed === null ? '無標註' : `H=${r.allowed}`}`,
                          `判定:${STATUS_META[r.status].label}${r.zoneConflict ? ' · ⚠ 所在區有多重標註' : ''}`,
                        ],
                      })
                    }
                  />
                );
              })}
            {mode === 'result' &&
              viewZones
                .filter((z) => z.state === 'pending' && z.polygon.length)
                .map((z) => {
                  const cx = z.polygon.reduce((s, p) => s + p[0], 0) / z.polygon.length;
                  const cy = z.polygon.reduce((s, p) => s + p[1], 0) / z.polygon.length;
                  return (
                    <text
                      key={z.id}
                      x={cx}
                      y={-cy}
                      textAnchor="middle"
                      fontSize="3.2"
                      fontWeight="bold"
                      fill="#b45309"
                      pointerEvents="none"
                    >
                      {z.num}
                    </text>
                  );
                })}
            {mode === 'result' && focusLabel && (() => {
              const z = viewZones.find((x) => x.id === focusLabel);
              if (!z || !z.polygon.length) return null;
              const cx = z.polygon.reduce((s, p) => s + p[0], 0) / z.polygon.length;
              const cy = z.polygon.reduce((s, p) => s + p[1], 0) / z.polygon.length;
              return (
                <g pointerEvents="none">
                  <polygon
                    points={z.polygon.map(([x, y]) => `${x},${-y}`).join(' ')}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth={1.2}
                  >
                    <animate attributeName="stroke-opacity" values="1;0.25;1" dur="1.4s" repeatCount="indefinite" />
                  </polygon>
                  <circle cx={cx} cy={-cy} r={7} fill="none" stroke="#f59e0b" strokeWidth={1}>
                    <animate attributeName="r" values="5;9;5" dur="1.6s" repeatCount="indefinite" />
                  </circle>
                </g>
              );
            })()}
          </svg>
          {hover && (
            <div
              className="pointer-events-none fixed z-50 rounded-lg bg-slate-900/95 text-white text-xs px-3 py-2 shadow-lg max-w-xs"
              style={{ left: hover.x + 14, top: hover.y + 14 }}
            >
              {hover.lines.map((l, i) => (
                <div key={i} className={cn(i === 0 && 'font-semibold')}>
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
          {[0, 0.5, 0.75, 1, 1.2, 2, 3].map((v) => (
            <span key={v} className="flex items-center space-x-1">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: zoneColor(v), opacity: 0.7 }} />
              <span>H={v}</span>
            </span>
          ))}
          <span className="flex items-center space-x-1">
            <span className="inline-block w-4 border-t-2 border-slate-800 dark:border-slate-200" />
            <span>DXF 板框</span>
          </span>
          <span className="flex items-center space-x-1">
            <span className="inline-block w-4 border-t-2 border-dashed border-blue-600" />
            <span>
              STP 板框(對位後,兩框重合 = 對準
              {meta.registration[view]?.fitErrMm != null && `;實測貼合誤差 ${meta.registration[view].fitErrMm}mm`})
            </span>
          </span>
          <span className="ml-auto">
            白色 = 該區無 H 標註;虛線紅框 = 多重標註區(決策 1:取較低值)
          </span>
        </div>
      </section>

      {/* results table */}
      <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center gap-3">
          <h3 className="text-sm font-semibold flex items-center space-x-2 shrink-0">
            <Layers className="w-4 h-4 text-slate-500" />
            <span>判定結果</span>
          </h3>
          <div className="relative flex-1 max-w-xs">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋 refdes / 封裝…"
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent pl-8 pr-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <span className="text-xs text-slate-500 font-mono sm:ml-auto shrink-0">
            顯示 {Math.min(listed.length, ROW_CAP)} / {listed.length}(依上方卡片篩選)
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="px-4 py-2">refdes</th>
                <th className="px-4 py-2">封裝</th>
                <th className="px-4 py-2 text-center">面</th>
                <th className="px-4 py-2 text-right">實高 (mm)</th>
                <th className="px-4 py-2 text-right">限高 H</th>
                <th className="px-4 py-2 text-right">超出</th>
                <th className="px-4 py-2 text-center">判定</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {listed.slice(0, ROW_CAP).map((r) => {
                const over = r.allowed !== null && r.allowed > 0 ? r.h - r.allowed : null;
                return (
                  <tr
                    key={r.id + r.view}
                    onClick={() => {
                      setView(r.view);
                      setSelected(r.id === selected ? null : r.id);
                    }}
                    className={cn(
                      'border-b border-slate-100 dark:border-slate-800/60 cursor-pointer',
                      selected === r.id
                        ? 'bg-blue-50 dark:bg-blue-900/20'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-900/40',
                    )}
                  >
                    <td className="px-4 py-1.5 font-semibold">{r.id}</td>
                    <td className="px-4 py-1.5 font-sans text-slate-600 dark:text-slate-300 max-w-xs truncate">
                      {r.footprint}
                    </td>
                    <td className="px-4 py-1.5 text-center text-slate-500">{r.side === 'top' ? '頂' : '底'}</td>
                    <td className="px-4 py-1.5 text-right">{fmt(r.h)}</td>
                    <td className="px-4 py-1.5 text-right text-slate-500">
                      {r.allowed === null ? '—' : r.allowed}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-1.5 text-right font-semibold',
                        over !== null && over > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-400',
                      )}
                    >
                      {over !== null && over > 0 ? `+${fmt(over)}` : '—'}
                    </td>
                    <td className="px-4 py-1.5 text-center">
                      <span className={cn('inline-block rounded px-1.5 py-0.5 text-[11px] font-sans', STATUS_META[r.status].chip)}>
                        {STATUS_META[r.status].label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      </>)}
    </div>
  );
}

function PendingZoneCard({
  zone,
  hints,
  focused,
  outline,
  viewBox,
  onSave,
  onLocate,
}: {
  zone: Zone;
  hints: HLabel[];
  focused: boolean;
  outline?: [number, number][];
  viewBox?: [number, number, number, number];
  onSave: (zoneId: string, value: number | 'nolimit' | null) => Promise<void> | void;
  onLocate: () => void;
}) {
  const [val, setVal] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focused) inputRef.current?.focus({ preventScroll: true });
  }, [focused]);
  const hint = hints[0];
  const hl = hint?.cropBox && (() => {
    const cb = hint.cropBox!;
    const cw = cb[2] - cb[0];
    const ch = cb[3] - cb[1];
    if (cw <= 0 || ch <= 0) return null;
    return {
      left: `${((hint.x0 - cb[0]) / cw) * 100}%`,
      width: `${((hint.x1 - hint.x0) / cw) * 100}%`,
      top: `${((cb[3] - hint.y1) / ch) * 100}%`,
      height: `${((hint.y1 - hint.y0) / ch) * 100}%`,
    };
  })();
  return (
    <div
      id={`pending-${zone.id}`}
      className={cn(
        'rounded-lg border p-2 space-y-2',
        focused
          ? 'border-amber-400 ring-2 ring-amber-300 dark:ring-amber-700'
          : 'border-slate-200 dark:border-slate-800',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-amber-600 dark:text-amber-400">{zone.num}</span>
        <span className="text-[11px] text-slate-400 font-mono">
          {zone.view === 'TOP_LIMIT' ? '頂面' : '底面'} · {fmt(zone.areaMm2 ?? undefined, 0)} mm²
        </span>
      </div>
      <button
        onClick={onLocate}
        title="在主板圖上定位這個區"
        className="w-full rounded border border-slate-200 dark:border-slate-700 hover:border-amber-400 cursor-pointer bg-white dark:bg-slate-900 p-0.5"
      >
        {outline && viewBox ? (
          <svg
            viewBox={`${viewBox[0]} ${-viewBox[3]} ${viewBox[2] - viewBox[0]} ${viewBox[3] - viewBox[1]}`}
            className="w-full h-12"
          >
            <polygon
              points={outline.map(([x, y]) => `${x},${-y}`).join(' ')}
              fill="#cbd5e1"
              fillOpacity={0.6}
              stroke="#64748b"
              strokeWidth={0.8}
            />
            <polygon
              points={zone.polygon.map(([x, y]) => `${x},${-y}`).join(' ')}
              fill="#dc2626"
              fillOpacity={0.85}
              stroke="#dc2626"
              strokeWidth={1.5}
            />
          </svg>
        ) : (
          <span className="text-[11px] text-slate-400">定位</span>
        )}
      </button>
      {hint?.crop && (
        <div className="relative">
          <img src={hint.crop} alt={hint.id} className="w-full h-auto rounded bg-white" />
          {hl && (
            <div
              className="absolute rounded-sm bg-amber-300/25 border border-amber-400/80 pointer-events-none"
              style={hl}
            />
          )}
          <div className="text-[10px] text-slate-400 mt-0.5">
            區內讀不出的標註(機器猜「{hint.read || '?'}」)
          </div>
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-slate-500">H=</span>
        <input
          ref={inputRef}
          type="number"
          step="0.05"
          min="0"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          className="w-16 rounded border border-slate-300 dark:border-slate-700 bg-transparent px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          disabled={val === '' || saving}
          onClick={async () => {
            setSaving(true);
            await onSave(zone.id, Number(val));
            setSaving(false);
          }}
          className="px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium cursor-pointer disabled:opacity-50"
        >
          {saving ? '…' : '儲存'}
        </button>
        <button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await onSave(zone.id, 'nolimit');
            setSaving(false);
          }}
          className="px-2.5 py-1 border border-slate-300 dark:border-slate-600 text-slate-500 rounded text-xs cursor-pointer hover:border-amber-400 disabled:opacity-50"
        >
          無限制
        </button>
      </div>
    </div>
  );
}
