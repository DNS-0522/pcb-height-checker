import { Router } from 'express';
import {
  PublicClientApplication,
  type AccountInfo,
  type ICachePlugin,
  type TokenCacheContext,
} from '@azure/msal-node';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync,
} from 'fs';
import { join, resolve } from 'path';
import { UPLOADS_DIR } from './analyze';

// ── OneDrive sync (方案 B) ────────────────────────────────────────────────
// Device-code sign-in via MSAL; datasets are mirrored under the OneDrive App
// Folder (應用程式/<app name>/boards/<boardId>/). Scope is Files.ReadWrite.AppFolder
// only, so the app can never touch anything else in the drive.
//
// Configure with env ONEDRIVE_CLIENT_ID or server/cloud.config.json {"clientId": "..."}.

const DATA_DIR = resolve(__dirname, '..', 'data');
const CACHE_PATH = join(DATA_DIR, '.msal-cache.json');
const CONFIG_PATH = resolve(__dirname, '..', 'cloud.config.json');
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['Files.ReadWrite.AppFolder'];
// regenerable artifacts we never sync
const SKIP = /^(debug_|\.msal)/;

function clientId(): string | null {
  if (process.env.ONEDRIVE_CLIENT_ID) return process.env.ONEDRIVE_CLIENT_ID;
  if (existsSync(CONFIG_PATH)) {
    try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')).clientId ?? null; } catch { /* ignore */ }
  }
  return null;
}

const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext) {
    if (existsSync(CACHE_PATH)) ctx.tokenCache.deserialize(readFileSync(CACHE_PATH, 'utf-8'));
  },
  async afterCacheAccess(ctx: TokenCacheContext) {
    if (ctx.cacheHasChanged) {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(CACHE_PATH, ctx.tokenCache.serialize());
    }
  },
};

let pca: PublicClientApplication | null = null;
function app(): PublicClientApplication {
  const id = clientId();
  if (!id) throw new Error('not_configured');
  if (!pca) {
    pca = new PublicClientApplication({
      auth: { clientId: id, authority: 'https://login.microsoftonline.com/common' },
      cache: { cachePlugin },
    });
  }
  return pca;
}

async function account(): Promise<AccountInfo | null> {
  const accounts = await app().getTokenCache().getAllAccounts();
  return accounts[0] ?? null;
}

async function token(): Promise<string> {
  const acc = await account();
  if (!acc) throw new Error('not_signed_in');
  const res = await app().acquireTokenSilent({ account: acc, scopes: SCOPES });
  return res.accessToken;
}

async function graph(path: string, init: RequestInit = {}): Promise<Response> {
  const t = await token();
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${t}`, ...(init.headers ?? {}) },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`graph ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

// upload one file into approot; >4MB goes through an upload session
async function uploadFile(remotePath: string, buf: Buffer): Promise<void> {
  const enc = remotePath.split('/').map(encodeURIComponent).join('/');
  if (buf.length <= 4 * 1024 * 1024) {
    const r = await graph(`/me/drive/special/approot:/${enc}:/content`, {
      method: 'PUT', body: new Uint8Array(buf),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (r.status === 404) throw new Error(`upload failed: ${remotePath}`);
    return;
  }
  const sess = await graph(`/me/drive/special/approot:/${enc}:/createUploadSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  const { uploadUrl } = await sess.json() as { uploadUrl: string };
  const CHUNK = 327680 * 16; // 5 MiB, multiple of 320 KiB as Graph requires
  for (let off = 0; off < buf.length; off += CHUNK) {
    const end = Math.min(off + CHUNK, buf.length);
    const r = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(end - off),
        'Content-Range': `bytes ${off}-${end - 1}/${buf.length}`,
      },
      body: new Uint8Array(buf.subarray(off, end)),
    });
    if (!r.ok) throw new Error(`chunk upload failed (${r.status}) at ${off}`);
  }
}

function localBoardDir(boardId: string): { dir: string; source: 'builtin' | 'upload' } | null {
  if (!/^[\w-]+$/.test(boardId)) return null;
  for (const [base, source] of [[DATA_DIR, 'builtin'], [UPLOADS_DIR, 'upload']] as const) {
    const dir = join(base, boardId);
    if (existsSync(join(dir, 'meta.json'))) return { dir, source };
  }
  return null;
}

// ── device-code login state ──────────────────────────────────────────────
type LoginState =
  | { phase: 'idle' }
  | { phase: 'awaiting'; userCode: string; verificationUri: string; message: string }
  | { phase: 'error'; error: string };
let login: LoginState = { phase: 'idle' };

export const cloudRouter = Router();

cloudRouter.get('/status', async (_req, res) => {
  const id = clientId();
  if (!id) return res.json({ configured: false, signedIn: false });
  try {
    const acc = await account();
    res.json({
      configured: true,
      signedIn: !!acc,
      account: acc ? { username: acc.username, name: acc.name } : null,
      login: login.phase === 'idle' ? undefined : login,
    });
  } catch (e) {
    res.json({ configured: true, signedIn: false, error: String(e) });
  }
});

// starts device-code flow; responds as soon as Microsoft hands us the user code.
// completion is observed via /status (signedIn flips true).
cloudRouter.post('/login', (_req, res) => {
  let responded = false;
  try {
    login = { phase: 'idle' };
    app().acquireTokenByDeviceCode({
      scopes: SCOPES,
      deviceCodeCallback: (info) => {
        login = {
          phase: 'awaiting',
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          message: info.message,
        };
        if (!responded) { responded = true; res.json(login); }
      },
    }).then(() => {
      login = { phase: 'idle' };
    }).catch((e) => {
      login = { phase: 'error', error: String(e?.errorMessage ?? e) };
      if (!responded) { responded = true; res.status(500).json(login); }
    });
  } catch (e) {
    if (!responded) res.status(400).json({ error: String(e) });
  }
});

cloudRouter.post('/logout', async (_req, res) => {
  try {
    const cache = app().getTokenCache();
    for (const acc of await cache.getAllAccounts()) await cache.removeAccount(acc);
    if (existsSync(CACHE_PATH)) rmSync(CACHE_PATH);
    login = { phase: 'idle' };
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// list boards stored in the cloud app folder
cloudRouter.get('/remote', async (_req, res) => {
  try {
    const r = await graph('/me/drive/special/approot:/boards:/children?$select=name,lastModifiedDateTime,folder');
    if (r.status === 404) return res.json([]); // no boards folder yet
    const { value } = await r.json() as { value: { name: string; lastModifiedDateTime: string; folder?: unknown }[] };
    res.json(value.filter((v) => v.folder).map((v) => ({ id: v.name, lastModified: v.lastModifiedDateTime })));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// push one board's dataset (minus regenerable debug_* files) to the cloud
cloudRouter.post('/push', async (req, res) => {
  try {
    const boardId = String(req.body?.board ?? '');
    const loc = localBoardDir(boardId);
    if (!loc) return res.status(404).json({ error: 'unknown board' });
    const files = readdirSync(loc.dir).filter((f) =>
      !SKIP.test(f) && statSync(join(loc.dir, f)).isFile());
    for (const f of files) {
      await uploadFile(`boards/${boardId}/${f}`, readFileSync(join(loc.dir, f)));
    }
    await uploadFile(`boards/${boardId}/_cloud.json`, Buffer.from(JSON.stringify({
      source: loc.source, pushedAt: new Date().toISOString(), files,
    }, null, 2)));
    res.json({ ok: true, files: files.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// pull one board from the cloud into local storage (uploads/ unless it already
// exists as a builtin dataset)
cloudRouter.post('/pull', async (req, res) => {
  try {
    const boardId = String(req.body?.board ?? '');
    if (!/^[\w-]+$/.test(boardId)) return res.status(400).json({ error: 'bad board id' });
    const list = await graph(`/me/drive/special/approot:/boards/${encodeURIComponent(boardId)}:/children?$select=name,size,file`);
    if (list.status === 404) return res.status(404).json({ error: 'not found in cloud' });
    const { value } = await list.json() as { value: { name: string; file?: unknown }[] };
    const dest = localBoardDir(boardId)?.dir ?? join(UPLOADS_DIR, boardId);
    mkdirSync(dest, { recursive: true });
    let n = 0;
    for (const item of value) {
      if (!item.file || item.name === '_cloud.json') continue;
      const r = await graph(`/me/drive/special/approot:/boards/${encodeURIComponent(boardId)}/${encodeURIComponent(item.name)}:/content`);
      if (r.status === 404) continue;
      writeFileSync(join(dest, item.name), Buffer.from(await r.arrayBuffer()));
      n++;
    }
    res.json({ ok: true, files: n, dir: dest });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
