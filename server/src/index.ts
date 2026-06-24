import express from 'express';
import cors from 'cors';
import { stpRouter } from './stp';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

app.use(cors());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'pcb-height-checker', ts: new Date().toISOString() });
});

app.use('/api/stp', stpRouter);

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
