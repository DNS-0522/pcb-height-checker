import { Router } from 'express';
import multer from 'multer';
import occtimportjs from 'occt-import-js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
});

// OpenCascade WASM module is initialised once and reused.
let occtPromise: Promise<any> | null = null;
function getOcct(): Promise<any> {
  if (!occtPromise) occtPromise = occtimportjs();
  return occtPromise;
}

type Vec3 = [number, number, number];
interface Box {
  min: Vec3;
  max: Vec3;
}

function emptyBox(): Box {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

function isValid(b: Box): boolean {
  return Number.isFinite(b.min[0]);
}

function expandByPositions(box: Box, positions: ArrayLike<number>): void {
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < box.min[a]) box.min[a] = v;
      if (v > box.max[a]) box.max[a] = v;
    }
  }
}

function union(target: Box, src: Box): void {
  if (!isValid(src)) return;
  for (let a = 0; a < 3; a++) {
    if (src.min[a] < target.min[a]) target.min[a] = src.min[a];
    if (src.max[a] > target.max[a]) target.max[a] = src.max[a];
  }
}

function sizeOf(b: Box): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export const stpRouter = Router();

stpRouter.post('/parse', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });
    }

    const occt = await getOcct();
    const result = occt.ReadStepFile(new Uint8Array(req.file.buffer), null);

    if (!result || !result.success) {
      return res.status(422).json({ error: 'OpenCascade failed to read the STEP file.' });
    }

    const meshes: any[] = result.meshes || [];

    // Per-mesh bounding boxes.
    const meshBoxes: Box[] = meshes.map((mesh) => {
      const box = emptyBox();
      const positions = mesh?.attributes?.position?.array;
      if (positions) expandByPositions(box, positions);
      return box;
    });

    // Walk the assembly tree: each top-level node = one component.
    const components: Array<{
      name: string;
      meshCount: number;
      bbox: Box;
      size: Vec3;
      height: number;
    }> = [];

    // Collect every node that directly carries geometry — these are the real
    // parts. Geometry lives on leaf nodes; assembly nodes higher up the tree
    // have an empty `meshes` array, so a plain top-level walk would collapse the
    // whole board into a single "component".
    const partNodes: any[] = [];
    (function walk(node: any): void {
      if (!node) return;
      if (Array.isArray(node.meshes) && node.meshes.length) partNodes.push(node);
      if (Array.isArray(node.children)) node.children.forEach(walk);
    })(result.root);

    for (const node of partNodes) {
      const box = emptyBox();
      for (const mi of node.meshes) union(box, meshBoxes[mi]);
      if (!isValid(box)) continue;
      const size = sizeOf(box);
      components.push({
        name: node.name || '(unnamed)',
        meshCount: node.meshes.length,
        bbox: box,
        size,
        height: size[2], // assume Z is the height axis
      });
    }

    // Fallback: no usable tree, expose one row per mesh.
    if (components.length === 0 && meshes.length) {
      meshes.forEach((mesh, i) => {
        const box = meshBoxes[i];
        if (!isValid(box)) return;
        const size = sizeOf(box);
        components.push({
          name: mesh?.name || `mesh_${i}`,
          meshCount: 1,
          bbox: box,
          size,
          height: size[2],
        });
      });
    }

    const overall = emptyBox();
    for (const b of meshBoxes) union(overall, b);

    res.json({
      meshCount: meshes.length,
      componentCount: components.length,
      overall: isValid(overall) ? { ...overall, size: sizeOf(overall) } : null,
      components: components.sort((a, b) => b.height - a.height),
    });
  } catch (err) {
    console.error('[stp/parse]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error parsing STEP.' });
  }
});
