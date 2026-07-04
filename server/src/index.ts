import express from 'express';
import cors from 'cors';
import { stpRouter } from './stp';

const app = express();
// Note: do NOT read process.env.PORT — the preview panel injects PORT=<client
// port> into the whole `npm run dev` env, which would make the API collide with
// the Vite client. Use a dedicated SERVER_PORT (defaults to 3001).
const PORT = process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : 3001;

app.use(cors());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pcb-height-checker', ts: new Date().toISOString() });
});

app.use('/api/stp', stpRouter);

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
