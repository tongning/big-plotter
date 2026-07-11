# Plotter Web App — Tasks

Plan: web app (vanilla JS, ESP32-friendly) + mock server. See /Users/anthony/.claude/plans/parsed-crafting-peach.md

- [x] `web/js/config.js` — board geometry, pen/servo commands, feeds
- [x] `web/js/gcode.js` — strokes→gcode, simplification, gcode parser + offsetter for demos
- [x] `web/js/draw.js` — vector canvas: pen, eraser (vector split), line/rect/ellipse, undo
- [x] `web/js/app.js` — board view (region picker + existing drawings), draw view, submit flow
- [x] `web/index.html` + `web/style.css`
- [x] `web/demos/` — manifest + 3 generated demo gcode files (star, smiley, OPEN SAUCE)
- [x] `server/server.py` — mock ESP32: static files + /api/board + /api/print
- [x] `server/make_demos.py` — generator for demo gcode
- [x] README.md
- [x] Verify: curl API, headless pipeline checks, two-submission simulation
- [x] Clipboard copy of submitted gcode (debug aid, `CONFIG.copyGcodeToClipboard`)
- [x] Admin panel: jog d-pad, home, pen up/down → `POST /api/command` (immediate)

## Review

- All 4 API endpoints verified with curl (GET/POST/DELETE board, POST print).
- `node server/test_gcode.mjs`: 17/17 checks pass — G21/G90 header, pen up
  before travel, all coords clamped to the usable area, y-flip + region
  offset exact, one pen-down per stroke (dots included), simplification
  collapses noisy lines, all 3 demo files parse and stay within the tile.
- Two-submission simulation: latest print file contains ONLY the newest
  drawing (star offset to its region); board state accumulates both records.
- Bug found & fixed during verification: print filenames had 1-second
  resolution, so rapid submissions overwrote each other → added ms suffix.
- NOT yet verified: interactive canvas UI in a real browser (Chrome
  extension wasn't connected). JS is syntax-checked and the conversion code
  it calls is covered by the headless tests, but pointer
  drawing/eraser/region-drag should get a quick manual pass.

## Follow-ups (post-MVP)

- Manual browser pass of the drawing UI (pen/eraser/shapes/undo, region drag).
- ESP32 firmware: serve `web/` from LittleFS, implement the 4 endpoints,
  stream gcode over UART with `ok` flow control (see README).
- Tune `config.js` servo angles/feeds on real hardware.
