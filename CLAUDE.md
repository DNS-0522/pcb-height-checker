# CLAUDE.md — PCB Height Checker

Standalone web tool: (1) DXF revision diff; (2) DXF×STP component height-limit check. Product overview/stack in `README.md` (note: README's "STP parsing = occt-import-js" is **stale** — see below).

**Talk to the user (Dennis, ASUS notebook power/mechanical engineer) in Traditional Chinese.** Apply the `web-style-guide` skill to all web UI.

## Repo / env
- GitHub `origin` = https://github.com/DNS-0522/DXF-Compare-tool (folder name differs — cosmetic).
- npm workspaces: `client` (Vite+React19+TS+Tailwind v4), `server` (Express+TS). `npm run dev` → client 5173 + server 3001.
- **Server reads `SERVER_PORT`, not `PORT`** (preview injects PORT=client-port into the whole `npm run dev`, else the API binds 5173 and collides with Vite).
- History: PCB sessions kept getting launched rooted in the *Power-budget-calculator* repo, so the preview `launch.json` config + all prior auto-memory/session history live under that project key, not this one. If you're now rooted here, that's the goal — but older context is in the Power-budget-calculator project store.

## STP parsing — current truth (overrides README)
- **Do NOT use occt-import-js** on the real board (12.5 MB → ~205 s). Use the fast hand-written STEP-text parser **`server/src/step-parse.ts`** (~0.8 s, ~250×). `POST /api/stp/parse` → `{componentCount, refdesCount, board, components[{id,footprint,x,y,z,width,depth,height,side,isRefdes}], parseMs}`.
- ⚠️ `server/src/step-parse.ts` + several edits (`server/src/stp.ts`, `index.ts`, `client/src/App.tsx`, …) are **UNCOMMITTED** as of 2026-06-30 — commit them.
- refdes = NAUO instance name; footprint = PRODUCT name; a name is a refdes iff it has **no underscore** (~2904/3924 have refdes; ~1020 are footprint-named unlabeled SMD passives).
- Board = 241.95×121.15×0.776 mm; board top face Z=0, bottom Z=−0.78. Side from placement Z sign. Top-side height = z1−0; bottom-side protrusion = −0.78−z0.
- ⚠️ **~995/3924 components carry a 3.81 mm (0.15") placeholder height** (Allegro default for parts with no real 3D model — all `CTK0_SM*` named). Must substitute by package or exclude, else thousands of false height violations.
- ⚠️ An OCP/OpenCASCADE cross-check saw components spread across **3 Y-bands** (main board in BOARD_OUTLINE bbox + 2 other clusters) — multi-board panel or transform nuance; **select only the MB cluster** for the height check. Reconcile against step-parse.ts world coords.

## DXF — findings from the FIRST REAL sample (2026-06-30)
Sample: `F:\A16_NVL_DXF_20260625\A16 NVL DXF_20260625\ux3607_nvl_mb_dxf_20260625.dxf` (Creo export, A0 1189×841).
- 🛑 **This real DXF has NO text layer** — 0 TEXT/MTEXT, zero `H=` strings; every label is exploded into LINE/ARC geometry. ⇒ the planned **"H-text → smallest containing closed polyline" algorithm CANNOT run** (it assumed real TEXT; only validated on a synthetic DXF). **OPEN DECISION — H-value source:** (a) **best: re-export DXF from Creo with text-as-TEXT (not stroked)** → original algorithm works; (b) OCR rendered tiles; (c) manual/semi-auto digitize.
- Layout = A0, **4 annotation categories × 2 sides = 8 board views**. Rows = `CONN` (connector/screw) / **`Limit` (the H= height limits)** / `PAD` (hole ⌀) / `WHITE` (silk). **Left col = TOP view, right col = BOTTOM view (mirrored; text reads normally un-flipped).** H values are only in the **Limit** pair.
- H read visually: **TOP Limit {0, 0.6, 0.75, 0.85(R-SENSOR), 1, 1.2}; BOT Limit {0, 0.5, 0.8, 1, 1.2, 2, 2.5, 3}** (bottom taller; MYLAR callout). `H=0` dominates (screw/pad clearance).
- Pad/hole **diameters ARE machine-readable**: 82 `DIMENSION` entities (`%%c<>` = ⌀, e.g. 6.5/4.5/2.5/8.5).
- One-off DXF/STP exploration scripts + renders are in **`analysis/`** (see `analysis/README.md`). Render pipeline that works: ezdxf + matplotlib, `Configuration(background_policy=WHITE, color_policy=BLACK)`, tile to ≤1456px to read stroked text by eye. `analysis/renders/` + `stp_components.csv` are git-ignored (regenerable).

## Where we are / next
**2026-07-12: H-value decision RESOLVED (OCR/vision pipeline) and the DXF×STP check now works end-to-end in the web app.**
- H extraction: stroke-cluster → vision-read → flood-fill zone association, all in `analysis/` (see its README). 150 labels / 137 zones. Dennis ruled on 5 zone-semantics questions (recorded in `analysis/check_demo.py` header + memory); **decision 6 (meaning of big H=0 zones) still pending** — the web UI exposes it as a switchable rule.
- Web feature: `server/src/heightcheck.ts` (TS rules engine; boards list; label PATCH), client `HeightCheck.tsx` tab = interactive SVG board + live rules + results table + flagged-label review panel.
- **Upload-any-board now works fully offline**: value reading = vector glyph matching (`analysis/glyph_match.py`, Chamfer + 16 orientations; 0 silent errors on the 148-label ground truth; low-confidence labels flagged). `analysis/run_pipeline.py` (overview/stp/extract subcommands) is driven by `server/src/analyze.ts` (`POST /api/analyze` upload → user frames the two Limit views on an overview render → extract). Flagged labels get crop images; user fills values in the UI (PATCH persists to labels.json; zone H re-derives live). Template library `glyph_templates.json` lacks '4' and '9' (absent from this sample).
- Registration = board-bbox window + circle vote, ±1mm (improve: exact screw-hole matching). Placeholders (3.81mm) turned out to be 0 in the MB cluster.
- Still to do: commit everything, decision 6, registration refinement, DXF revision diff (Phase 2), report export (Phase 4).
