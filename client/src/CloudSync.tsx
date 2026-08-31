import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Cloud, CloudOff, LogOut, UploadCloud, DownloadCloud, Loader2, Copy, Check, X,
} from 'lucide-react';
import { cn } from './lib/utils';

type Status = {
  configured: boolean;
  signedIn: boolean;
  account?: { username: string; name?: string } | null;
  login?: { phase: string; userCode?: string; verificationUri?: string; error?: string };
};
type LocalBoard = { id: string; title: string; source: string };
type RemoteBoard = { id: string; lastModified: string };

export default function CloudSync() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [locals, setLocals] = useState<LocalBoard[]>([]);
  const [remotes, setRemotes] = useState<RemoteBoard[]>([]);
  const [busy, setBusy] = useState<string | null>(null); // "push:id" | "pull:id" | "login"
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await (await fetch('/api/cloud/status')).json() as Status;
      setStatus(s);
      return s;
    } catch { return null; }
  }, []);

  const refreshLists = useCallback(async (signedIn: boolean) => {
    try {
      setLocals(await (await fetch('/api/heightcheck/boards')).json());
    } catch { /* ignore */ }
    if (signedIn) {
      try {
        const r = await (await fetch('/api/cloud/remote')).json();
        setRemotes(Array.isArray(r) ? r : []);
      } catch { setRemotes([]); }
    }
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    if (open) refreshStatus().then((s) => refreshLists(!!s?.signedIn));
  }, [open, refreshStatus, refreshLists]);

  // while a device-code login is pending, poll until signedIn flips
  useEffect(() => {
    if (busy !== 'login') return;
    pollRef.current = window.setInterval(async () => {
      const s = await refreshStatus();
      if (s?.signedIn || s?.login?.phase === 'error') {
        setBusy(null);
        if (s?.signedIn) refreshLists(true);
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [busy, refreshStatus, refreshLists]);

  const startLogin = async () => {
    setMsg(null);
    setBusy('login');
    try {
      const r = await fetch('/api/cloud/login', { method: 'POST' });
      const j = await r.json();
      if (!r.ok) { setMsg(j.error ?? '登入啟動失敗'); setBusy(null); return; }
      setStatus((s) => (s ? { ...s, login: j } : s));
    } catch (e) { setMsg(String(e)); setBusy(null); }
  };

  const logout = async () => {
    await fetch('/api/cloud/logout', { method: 'POST' });
    setRemotes([]);
    refreshStatus();
  };

  const act = async (kind: 'push' | 'pull', id: string) => {
    setMsg(null);
    setBusy(`${kind}:${id}`);
    try {
      const r = await fetch(`/api/cloud/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ board: id }),
      });
      const j = await r.json();
      if (!r.ok) setMsg(j.error ?? `${kind} 失敗`);
      else setMsg(kind === 'push' ? `已上傳 ${id}(${j.files} 個檔案)` : `已下載 ${id}(${j.files} 個檔案)`);
      refreshLists(true);
    } catch (e) { setMsg(String(e)); }
    setBusy(null);
  };

  const login = status?.login;
  const remoteIds = new Set(remotes.map((r) => r.id));

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'p-2 rounded-lg transition-colors cursor-pointer',
          status?.signedIn
            ? 'text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20'
            : 'text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20',
        )}
        aria-label="OneDrive 同步"
        title={status?.signedIn ? `OneDrive:${status.account?.username}` : 'OneDrive 同步'}
      >
        {status?.signedIn ? <Cloud className="w-5 h-5" /> : <CloudOff className="w-5 h-5" />}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-96 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-4 space-y-3 z-20 text-sm">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold">OneDrive 工作狀態同步</h3>
            <button onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer" aria-label="關閉">
              <X className="w-4 h-4" />
            </button>
          </div>

          {status === null ? (
            <p className="text-slate-500">載入中…</p>
          ) : !status.configured ? (
            <div className="space-y-2 text-slate-600 dark:text-slate-300">
              <p>尚未設定 Azure 應用程式。請在 Azure Portal 註冊 App 後,把 Client ID 填入 <code className="text-xs bg-slate-100 dark:bg-slate-800 px-1 rounded">server/cloud.config.json</code>:</p>
              <pre className="text-xs bg-slate-100 dark:bg-slate-800 rounded p-2 overflow-x-auto">{'{ "clientId": "xxxxxxxx-..." }'}</pre>
              <p className="text-xs text-slate-500">註冊步驟見專案 README(支援任何組織與個人帳戶、啟用公用用戶端流程)。</p>
            </div>
          ) : !status.signedIn ? (
            <div className="space-y-3">
              {login?.phase === 'awaiting' && login.userCode ? (
                <div className="space-y-2">
                  <p>請開啟 <a className="text-blue-600 underline" href={login.verificationUri} target="_blank" rel="noreferrer">{login.verificationUri}</a> 並輸入代碼:</p>
                  <div className="flex items-center space-x-2">
                    <code className="text-lg font-mono font-bold tracking-widest bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded">{login.userCode}</code>
                    <button
                      onClick={() => { navigator.clipboard.writeText(login.userCode!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                      className="p-1.5 text-slate-400 hover:text-blue-500 cursor-pointer" aria-label="複製代碼"
                    >
                      {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 flex items-center"><Loader2 className="w-3 h-3 mr-1 animate-spin" />等待你在瀏覽器完成登入…</p>
                </div>
              ) : (
                <button
                  onClick={startLogin}
                  disabled={busy === 'login'}
                  className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors cursor-pointer disabled:opacity-50"
                >
                  {busy === 'login' ? '啟動中…' : '登入 Microsoft 帳戶'}
                </button>
              )}
              {login?.phase === 'error' && <p className="text-xs text-red-500">{login.error}</p>}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="truncate">{status.account?.username}</span>
                <button onClick={logout} className="flex items-center space-x-1 hover:text-red-500 cursor-pointer">
                  <LogOut className="w-3.5 h-3.5" /><span>登出</span>
                </button>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase mb-1.5">本機板子 → 雲端</h4>
                <ul className="space-y-1 max-h-40 overflow-y-auto">
                  {locals.map((b) => (
                    <li key={b.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 bg-slate-50 dark:bg-slate-800/60">
                      <span className="truncate mr-2">{b.title}{remoteIds.has(b.id) && <span className="ml-1.5 text-[10px] text-blue-500">已在雲端</span>}</span>
                      <button
                        onClick={() => act('push', b.id)}
                        disabled={busy !== null}
                        className="flex items-center space-x-1 text-xs text-blue-600 hover:text-blue-700 cursor-pointer disabled:opacity-40"
                      >
                        {busy === `push:${b.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UploadCloud className="w-3.5 h-3.5" />}
                        <span>上傳</span>
                      </button>
                    </li>
                  ))}
                  {locals.length === 0 && <li className="text-xs text-slate-400 px-2">沒有本機板子</li>}
                </ul>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-500 uppercase mb-1.5">雲端板子 → 本機</h4>
                <ul className="space-y-1 max-h-40 overflow-y-auto">
                  {remotes.map((b) => (
                    <li key={b.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 bg-slate-50 dark:bg-slate-800/60">
                      <span className="truncate mr-2">{b.id}<span className="ml-1.5 text-[10px] text-slate-400">{new Date(b.lastModified).toLocaleDateString()}</span></span>
                      <button
                        onClick={() => act('pull', b.id)}
                        disabled={busy !== null}
                        className="flex items-center space-x-1 text-xs text-blue-600 hover:text-blue-700 cursor-pointer disabled:opacity-40"
                      >
                        {busy === `pull:${b.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <DownloadCloud className="w-3.5 h-3.5" />}
                        <span>下載</span>
                      </button>
                    </li>
                  ))}
                  {remotes.length === 0 && <li className="text-xs text-slate-400 px-2">雲端尚無板子</li>}
                </ul>
              </div>

              {msg && <p className="text-xs text-slate-600 dark:text-slate-300">{msg}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
