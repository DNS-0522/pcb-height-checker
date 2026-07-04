import { Router } from 'express';
import multer from 'multer';
import { parseStepComponents } from './step-parse';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

export const stpRouter = Router();

// Parse a PCB STEP assembly into a component list (refdes, footprint, position,
// bounding box, height, side). Text-based — fast (no OpenCascade reconstruction).
stpRouter.post('/parse', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });
    }
    const text = req.file.buffer.toString('latin1');
    const result = parseStepComponents(text);
    if (!result.componentCount) {
      return res.status(422).json({ error: 'No components found — is this a PCB STEP assembly export?' });
    }
    res.json(result);
  } catch (err) {
    console.error('[stp/parse]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error parsing STEP.' });
  }
});
