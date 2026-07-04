import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CircuitBoard,
  Sun,
  Moon,
  FileUp,
  Box,
  Loader2,
  AlertTriangle,
  Ruler,
  Layers,
  Search,
  Tag,
} from 'lucide-react';
import { cn, fmt } from './lib/utils';

interface StepComponent {
  id: string;
  footprint: string;
  x: number;
  y: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  side: 'top' | 'bottom';
  isRefdes: boolean;
}

interface StepResult {
  componentCount: number;
  refdesCount: number;
  board: { width: number; depth: number; height: number } | null;
  components: StepComponent[];
  parseMs: number;
}

const ROW_CAP = 300;

function useTheme() {
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark');
  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export default function App() {
  const { dark, toggle } = useTheme();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StepResult | null>(null);
  const [query, setQuery] = useState('');
  const [side, setSide] = useState<'all' | 'top' | 'bottom'>('all');
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleParse() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/stp/parse', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setResult(data as StepResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse failed');
    } finally {
      setLoading(false);
    }
  }

  const sideCounts = useMemo(() => {
    const top = result?.components.filter((c) => c.side === 'top').length ?? 0;
    return { top, bottom: (result?.componentCount ?? 0) - top };
  }, [result]);

  const filtered = useMemo(() => {
    if (!result) return [];
    const q = query.trim().toLowerCase();
    return result.components
      .filter((c) => side === 'all' || c.side === side)
      .filter((c) => !q || c.id.toLowerCase().includes(q) || c.footprint.toLowerCase().includes(q))
      .sort((a, b) => b.height - a.height);
  }, [result, query, side]);

  const shown = filtered.slice(0, ROW_CAP);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 transition-colors duration-200">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md">
        <div className="px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <CircuitBoard className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            <div>
              <h1 className="text-xl font-bold leading-none">PCB Height Checker</h1>
              <p className="text-xs text-slate-500 mt-1">STP 零件高度解析</p>
            </div>
          </div>
          <button
            onClick={toggle}
            className="p-2 rounded-lg text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors cursor-pointer"
            aria-label="Toggle theme"
          >
            {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl p-4 shadow-sm">
          <h2 className="text-base font-semibold mb-3 flex items-center space-x-2">
            <Box className="w-5 h-5 text-slate-500" />
            <span>上傳 STP / STEP 模型</span>
          </h2>
          <p className="text-sm text-slate-500 mb-4">
            解析 PCB 組裝體，逐件取出 <span className="font-mono">refdes</span>、封裝、座標、尺寸、高度與正/反面（純文字解析，秒級）。
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept=".stp,.step,.STP,.STEP"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setResult(null);
                setError(null);
              }}
              className="hidden"
            />
            <button
              onClick={() => inputRef.current?.click()}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:border-blue-500 text-sm font-medium flex items-center space-x-2 transition-colors cursor-pointer"
            >
              <FileUp className="w-4 h-4" />
              <span>選擇檔案</span>
            </button>
            <span className="text-sm text-slate-500 font-mono truncate">
              {file ? file.name : '尚未選擇檔案'}
            </span>
            <button
              onClick={handleParse}
              disabled={!file || loading}
              className="sm:ml-auto px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center justify-center space-x-2 transition-colors text-sm font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Box className="w-4 h-4" />}
              <span>{loading ? '解析中…' : '解析模型'}</span>
            </button>
          </div>

          {error && (
            <div className="mt-4 flex items-start space-x-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span className="font-mono">{error}</span>
            </div>
          )}
        </section>

        {result && (
          <>
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatTile label="零件總數" value={String(result.componentCount)} icon={<Layers className="w-4 h-4" />} accent />
              <StatTile label="含 refdes" value={String(result.refdesCount)} icon={<Tag className="w-4 h-4" />} />
              <StatTile
                label="板框 X×Y (mm)"
                value={result.board ? `${fmt(result.board.width, 1)}×${fmt(result.board.depth, 1)}` : '—'}
                icon={<Ruler className="w-4 h-4" />}
              />
              <StatTile label="正面 / 背面" value={`${sideCounts.top} / ${sideCounts.bottom}`} icon={<Box className="w-4 h-4" />} />
            </section>

            <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center gap-3">
                <h2 className="text-base font-semibold flex items-center space-x-2 shrink-0">
                  <Layers className="w-5 h-5 text-slate-500" />
                  <span>零件清單</span>
                </h2>
                <div className="relative flex-1 max-w-xs">
                  <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜尋 refdes / 封裝…"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-transparent pl-8 pr-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="flex items-center rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden text-sm">
                  {(['all', 'top', 'bottom'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSide(s)}
                      className={cn(
                        'px-3 py-1.5 transition-colors cursor-pointer',
                        side === s ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800',
                      )}
                    >
                      {s === 'all' ? '全部' : s === 'top' ? '正面' : '背面'}
                    </button>
                  ))}
                </div>
                <span className="text-xs text-slate-500 font-mono sm:ml-auto shrink-0">
                  顯示 {Math.min(shown.length, filtered.length)} / {filtered.length}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200 dark:border-slate-800">
                      <th className="px-4 py-2">#</th>
                      <th className="px-4 py-2">ID / refdes</th>
                      <th className="px-4 py-2">封裝</th>
                      <th className="px-4 py-2 text-right">X</th>
                      <th className="px-4 py-2 text-right">Y</th>
                      <th className="px-4 py-2 text-right">高度 (mm)</th>
                      <th className="px-4 py-2 text-center">面</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {shown.map((c, i) => (
                      <tr
                        key={i}
                        className="border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-900/40"
                      >
                        <td className="px-4 py-1.5 text-slate-400">{i + 1}</td>
                        <td className={cn('px-4 py-1.5 font-semibold', c.isRefdes ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400')}>
                          {c.id}
                        </td>
                        <td className="px-4 py-1.5 font-sans text-slate-600 dark:text-slate-300 max-w-xs truncate">{c.footprint}</td>
                        <td className="px-4 py-1.5 text-right text-slate-500">{fmt(c.x, 1)}</td>
                        <td className="px-4 py-1.5 text-right text-slate-500">{fmt(c.y, 1)}</td>
                        <td className={cn('px-4 py-1.5 text-right font-semibold', c.height >= 3 ? 'text-amber-600 dark:text-amber-400' : '')}>
                          {fmt(c.height)}
                        </td>
                        <td className="px-4 py-1.5 text-center">
                          <span
                            className={cn(
                              'inline-block rounded px-1.5 py-0.5 text-[11px] font-sans',
                              c.side === 'top'
                                ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400'
                                : 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400',
                            )}
                          >
                            {c.side === 'top' ? '正' : '背'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-400 flex items-center justify-between">
                <span>高度取自 3D 模型方塊；部分零件為 0.15&quot;/3.81mm 預設值（庫未建真實高度）。</span>
                <span className="font-mono">解析 {result.parseMs}ms</span>
              </div>
            </section>
          </>
        )}

        {!result && !loading && !error && (
          <div className="text-center py-16 text-slate-400">
            <Box className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">上傳一個 STP/STEP 檔開始解析</p>
          </div>
        )}
      </main>
    </div>
  );
}

function StatTile({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-4 shadow-sm',
        accent
          ? 'border-blue-200 dark:border-blue-900/50 bg-blue-50 dark:bg-blue-900/20'
          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950',
      )}
    >
      <div className="flex items-center space-x-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        {icon}
        <span>{label}</span>
      </div>
      <div className={cn('mt-2 text-3xl font-mono font-bold', accent && 'text-blue-600 dark:text-blue-400')}>{value}</div>
    </div>
  );
}
