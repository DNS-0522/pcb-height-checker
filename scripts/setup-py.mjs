// Install the analysis pipeline's Python deps, with a friendly guard when
// Python itself is missing (pip ships with Python — no Python, no pip).
// The server spawns the pipeline via the Windows `py` launcher, so that
// launcher (not just any python.exe) is the actual runtime requirement.
import { spawnSync } from 'node:child_process';

function has(cmd, args) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

if (!has('py', ['--version'])) {
  const pythonOnly = has('python', ['--version']);
  console.error('');
  console.error('✗ 找不到 Windows Python 啟動器 `py`。');
  if (pythonOnly) {
    console.error('  (偵測到 `python`,但 server 是用 `py` 啟動分析管線,仍需要 py 啟動器)');
  }
  console.error('');
  console.error('  請先安裝 Python 3.12+(安裝程式預設會附 py 啟動器):');
  console.error('    winget install Python.Python.3.12');
  console.error('  或到 https://www.python.org/downloads/ 下載,安裝時勾選 "py launcher"。');
  console.error('');
  console.error('  裝好後重新執行:npm run setup:py');
  process.exit(1);
}

const r = spawnSync('py', ['-m', 'pip', 'install', '-r', 'analysis/requirements.txt'], {
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
