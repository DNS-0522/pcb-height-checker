# DXF×STP component height check: offline extraction pipeline + interactive web UI

## What

End-to-end implementation of the height-limit check (roadmap Phase 1 + 3, plus upload support):

### analysis/ — offline extraction pipeline (`run_pipeline.py`)
- **H-label reading with zero OCR / zero network**: stroked CAD text is read by vector glyph matching (`glyph_match.py`: Chamfer distance against a 10-char template library, 16 orientations, ambiguity + truncation guards). Validated against a 148-label human ground truth: 0 silent errors; uncertain reads are flagged for human review instead of guessed.
- **Zone segmentation**: Limit views are rasterised, glyph strokes of recognised labels are erased behind a protect mask (so text can neither split zones nor nick real boundaries), and connected-component analysis yields numbered zones.
- **Registration**: the STP `BOARD_OUTLINE` contour is fitted onto the DXF board blob per view with automatic mirror detection (data-driven; the bottom view of the sample drawing turned out to be unmirrored despite mirrored text).
- Subcommands: `overview`, `stp` (OCP world bboxes), `extract`, `register`, `alignment`, `debugviz`.

### server/ — Express API
- `heightcheck.ts`: zone-centric dataset model — zones numbered T-xx/B-xx with states valued / pending / no-limit; judgement rules are re-runnable live (H=0 semantics is a switchable rule pending the outstanding domain decision); zone value overrides persist to `zone_overrides.json`.
- `analyze.ts`: upload DXF+STP → parallel overview render + OCP solve → the user frames the two Limit views on the overview → extraction job with streamed progress.

### client/ — React UI
- Interactive SVG board viewer: zones coloured by H value, components coloured by verdict, DXF drawing backdrop, board-outline alignment overlay with measured fit error.
- Pending-zone review queue: every zone without an H value gets a card (minimap, glyph crops as hints, direct H input or "no limit"), with two-way locate between the queue and the board.
- Zone-cutting debug mode: walls / coloured-CC bases plus label sampling-point visualisation.

## Why

The real Creo-exported DXF has no TEXT entities (all labels are stroked geometry), and the design files are confidential, so the reading step had to work fully offline. The zone-centric review model guarantees completeness: any area without a value is queued for the engineer regardless of *why* it has no value.

## Notes for review

- **Board-derived datasets are deliberately git-ignored** (`server/data/`, `analysis/*.json` except the font glyph templates): they encode confidential layout data and are regenerable locally.
- Python pipeline deps: `ezdxf matplotlib numpy scikit-image scipy cadquery-ocp` (Python ≥3.12).
- Outstanding domain decisions are documented in CLAUDE.md (notably decision 6: semantics of large H=0 zones — exposed as a UI rule for now).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
