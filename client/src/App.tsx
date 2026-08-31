import { useEffect, useState } from 'react';
import { CircuitBoard, Sun, Moon, Ruler, GitCompareArrows } from 'lucide-react';
import { cn } from './lib/utils';
import HeightCheck from './HeightCheck';
import DxfDiff from './DxfDiff';
import CloudSync from './CloudSync';

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

type Page = 'check' | 'diff';

const PAGES: { id: Page; label: string; Icon: typeof Ruler }[] = [
  { id: 'check', label: '限高檢查', Icon: Ruler },
  { id: 'diff', label: 'DXF 比對', Icon: GitCompareArrows },
];

export default function App() {
  const { dark, toggle } = useTheme();
  const [page, setPage] = useState<Page>(() =>
    localStorage.getItem('page') === 'diff' ? 'diff' : 'check');
  useEffect(() => {
    localStorage.setItem('page', page);
  }, [page]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-900 dark:text-slate-100 transition-colors duration-200">
      <header className="sticky top-0 z-10 border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-md">
        <div className="px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <CircuitBoard className="w-6 h-6 text-blue-600 dark:text-blue-400" />
            <div>
              <h1 className="text-xl font-bold leading-none">PCB Height Checker</h1>
              <p className="text-xs text-slate-500 mt-1">DXF 限高 × STP 零件高度檢查</p>
            </div>
          </div>
          <div className="flex items-center space-x-1">
          <CloudSync />
          <button
            onClick={toggle}
            className="p-2 rounded-lg text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors cursor-pointer"
            aria-label="Toggle theme"
          >
            {dark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
          </div>
        </div>
        <nav className="px-4 sm:px-6 lg:px-8 flex space-x-1 border-t border-slate-100 dark:border-slate-800/60">
          {PAGES.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={cn(
                'flex items-center space-x-2 px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer',
                page === id
                  ? 'text-blue-600 dark:text-blue-400 border-blue-500'
                  : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 border-transparent',
              )}
            >
              <Icon className="w-4 h-4" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </header>

      <main className="px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* both pages stay mounted so tab switches keep state (selected board,
            rules, in-flight upload polling) */}
        <div className={cn(page !== 'check' && 'hidden')}><HeightCheck /></div>
        <div className={cn(page !== 'diff' && 'hidden')}><DxfDiff /></div>
      </main>
    </div>
  );
}
