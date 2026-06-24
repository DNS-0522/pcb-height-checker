import { useEffect, useRef, useState, type ReactNode } from 'react';
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
} from 'lucide-react';
import { cn } from './lib/utils';

type Vec3 = [number, number, number];
type BBox = { min: Vec3; max: Vec3 };

interface Component {
  name: string;
  meshCount: number;
  bbox: BBox;
  size: Vec3;
  height: number;
}

interface ParseResult {
  meshCount: number;
  componentCount: number;
  overall: { min: Vec3; max: Vec3; size: Vec3 } | null;
  components: Component[];
}

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

const fmt = (n: number | undefined, digits = 2) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : '—';

export default function App() {
  const { dark, toggle } = useTheme();
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
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
      setResult(data as ParseResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Parse failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 transition-colors duration-200">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md">
        <div className="px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <CircuitBoard className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            <div>
              <h1 className="text-xl font-bold leading-none">PCB Height Checker</h1>
              <p className="text-xs text-slate-500 mt-1">Phase 0 · STP 解析驗證</p>
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
            驗證後端能否用 OpenCascade 解析 3D 模型，並逐件算出邊界框與高度。目前假設 <span className="font-mono">Z</span> 軸為高度方向（之後可依實際檔案調整）。
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
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatTile
                label="零件數 (top-level)"
                value={String(result.componentCount)}
                icon={<Layers className="w-4 h-4" />}
              />
              <StatTile
                label="Mesh 數"
                value={String(result.meshCount)}
                icon={<Box className="w-4 h-4" />}
              />
              <StatTile
                label="整體高度 dZ (mm)"
                value={fmt(result.overall?.size?.[2])}
                icon={<Ruler className="w-4 h-4" />}
                accent
              />
              <StatTile
                label="板面 X×Y (mm)"
                value={`${fmt(result.overall?.size?.[0])} × ${fmt(result.overall?.size?.[1])}`}
                icon={<Ruler className="w-4 h-4" />}
              />
            </section>

            <section className="border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 rounded-xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <h2 className="text-base font-semibold flex items-center space-x-2">
                  <Layers className="w-5 h-5 text-slate-500" />
                  <span>零件清單（依高度排序）</span>
                </h2>
                <span className="text-xs text-slate-500 font-mono">{result.components.length} 件</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200 dark:border-slate-800">
                      <th className="px-4 py-2">#</th>
                      <th className="px-4 py-2">名稱</th>
                      <th className="px-4 py-2 text-right">高度 dZ</th>
                      <th className="px-4 py-2 text-right">dX</th>
                      <th className="px-4 py-2 text-right">dY</th>
                      <th className="px-4 py-2 text-right">Z 範圍 (min→max)</th>
                      <th className="px-4 py-2 text-right">Mesh</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {result.components.map((c, i) => (
                      <tr
                        key={i}
                        className="border-b border-slate-100 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-900/40"
                      >
                        <td className="px-4 py-2 text-slate-400">{i + 1}</td>
                        <td className="px-4 py-2 font-sans">{c.name}</td>
                        <td className="px-4 py-2 text-right font-semibold text-blue-600 dark:text-blue-400">
                          {fmt(c.height)}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-500">{fmt(c.size[0])}</td>
                        <td className="px-4 py-2 text-right text-slate-500">{fmt(c.size[1])}</td>
                        <td className="px-4 py-2 text-right text-slate-500">
                          {fmt(c.bbox.min[2])} → {fmt(c.bbox.max[2])}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-400">{c.meshCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
      <div className={cn('mt-2 text-3xl font-mono font-bold', accent && 'text-blue-600 dark:text-blue-400')}>
        {value}
      </div>
    </div>
  );
}
