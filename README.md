# PCB Height Checker

A web tool for notebook PCB mechanical review:

1. **DXF revision diff** — compare two 2D PCB DXF revisions and visualise added / removed / changed height-limit zones (`H=0`, `H=1`, …) and component outlines.
2. **DXF × STP height check** — parse a layout-output STP (STEP) 3D model, extract each component's real height, register it against the DXF height-limit zones, and flag any component that exceeds its allowed height.

> `H=n` markings denote the component height limit in **millimetres** for that zone (`H=0` = keep-out / no components).

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19 + Vite + TypeScript + Tailwind CSS v4 |
| DXF parsing | `dxf-parser` (planned) + custom SVG/Canvas renderer |
| STP parsing | `occt-import-js` (OpenCascade WASM) running on the Node backend |
| Backend | Express + TypeScript |

## Project layout

```
client/   React + Vite frontend
server/   Express backend (STP parsing endpoint)
samples/  Drop sample .dxf / .stp files here for development (git-ignored)
```

## Develop

Prerequisites: Node 20+, **Python 3.12+ with the Windows `py` launcher**
(`winget install Python.Python.3.12`, or python.org installer with
"py launcher" checked). Python is a runtime requirement — the server spawns
the analysis pipeline through `py`.

```bash
npm run setup        # npm install (both workspaces) + Python pipeline deps
npm run dev          # runs client (5173) + server (3001) together
```

> `npm install` alone does NOT install the Python libraries. Standalone:
> `py -m pip install -r analysis/requirements.txt`.

- Frontend: http://localhost:5173 (proxies `/api/*` to the backend)
- Backend health check: http://localhost:3001/api/health

## Roadmap

- [x] **Phase 0** — scaffold + prove STP parsing (per-component bounding box / height)
- [ ] **Phase 1** — DXF parsing + viewer + `H=n` zone extraction
- [ ] **Phase 2** — two-revision DXF diff (overlay + change list)
- [ ] **Phase 3** — coordinate registration + height-violation check
- [ ] **Phase 4** — report export (Excel/PDF), saved comparisons
