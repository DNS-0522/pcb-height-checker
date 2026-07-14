import express from 'express';
import cors from 'cors';
import { stpRouter } from './stp';
import { heightCheckRouter } from './heightcheck';
import { analyzeRouter } from './analyze';
import { dxfDiffRouter } from './dxfdiff';

const app = express();
// Note: do NOT read process.env.PORT — the preview panel injects PORT=<client
// port> into the whole `npm run dev` env, which would make the API collide with
// the Vite client. Use a dedicated SERVER_PORT (defaults to 3001).
const PORT = process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pcb-height-checker', ts: new Date().toISOString() });
});

app.use('/api/stp', stpRouter);
app.use('/api/heightcheck', heightCheckRouter);
app.use('/api/analyze', analyzeRouter);
app.use('/api/dxfdiff', dxfDiffRouter);

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
