# Bug hunt: drawings don't plot, jogs do (2026-07-13)

Two real bugs found (both drawing-specific, jogs unaffected):

1. **Zero motion (Anthony's find): ESPAsyncWebServer eats `text/plain`
   bodies containing `=` as form params** — drawing gcode always has
   `; region x=…` in its header, so the body never reached the gcode
   callback; jog commands contain no `=`. Fix: client sends
   `application/octet-stream` for /api/print and /api/command.
2. **Mid-plot silent abort: drawings contain G4 dwells between strokes; G4
   only acks after ALL buffered motion finishes (planner holds ~16 moves,
   easily >10s at draw feed). Marlin sends "echo:busy" heartbeats meanwhile
   but pumpPrinterRx ignored them → ok-timeout killed the job.** Fix: any
   complete printer line refreshes the deadline.

Also made failures visible:

- [x] main.cpp: any complete printer line refreshes okDeadline (timeout now
      means "printer went silent", not "printer is busy")
- [x] main.cpp: spool errors → 500 (was: silent success + no motion);
      startJob fails on missing/empty job file; [job] log lines
- [x] app.js: watchJob() polls /api/status after submit; toasts
      "Plot failed: <error>" / "Plot finished"
- [x] server.py: /api/status implemented (API invariant: both impls)
- [x] verify: esp32 pio compile OK; tests pass; /api/status + E2E curl OK
- [ ] hardware session: reflash BOTH esp32 firmware (`pio run -t upload`)
      + web (`uploadfs`), then serial log `[job]`/`[printer]` lines tell
      the full story if anything still fails

# Admin panel additions + real soft endstops (2026-07-13)

Plan: admin "Motors off" button (M84), custom gcode box, and make Marlin's
software endstops actually engage after 📍 set-home. Today soft endstops are
dead code: `apply_motion_limits()` only clamps homed axes and only `G28` sets
the homed flag — so patch G92 to mark axes homed/trusted and enable
`NO_WORKSPACE_OFFSETS` so the native frame is anchored at the physical
origin. Full plan: /Users/anthony/.claude/plans/read-the-project-readme-snazzy-graham.md

- [x] git pull (friend's dual-Y config update, ff-only)
- [x] web/index.html: Motors off button + custom gcode input row
- [x] web/js/app.js: wire motors off, custom gcode send, set-home adds M211 S1
- [x] web/style.css: admin-row input styling (gcode-row stretches, input flexes)
- [x] marlin/config/Configuration_adv.h: enable NO_WORKSPACE_OFFSETS
- [x] marlin/config/G92.cpp: patched copy that sets axis homed/trusted
- [x] marlin/build.sh: copy G92.cpp into the clone
- [x] ./marlin/build.sh → new firmware.bin (LPC1768 SUCCESS, flash 17.3%)
- [x] docs: README (soft endstop story, admin controls, motion limits),
      CLAUDE.md invariant + structure, lessons.md corollary
- [x] verify: node server/test_gcode.mjs (17/17), app.js syntax-checked,
      curl'd /api/command with M84 / G92+M211 S1 / M211 S0 → all logged
      correctly in server/commands.log; element ids cross-checked HTML↔JS

NOT done here (hardware disconnected): SD-card flash of firmware.bin,
`pio run -t uploadfs`.

## Review

- Soft endstops were dead code on this machine: Marlin's
  `apply_motion_limits()` skips unhomed axes and only `G28` sets the homed
  flag. Fix = patched `G92.cpp` (marks G92'd axes homed/trusted, outside the
  NEAR_ZERO guard so it works when position is already 0) +
  `NO_WORKSPACE_OFFSETS` (soft-endstop bounds are native-space, so G92 must
  set native position for the 0–762×0–508 window to sit on the physical
  board). Diffed patched G92.cpp vs stock 2.1.2.5: one hunk only.
- Set-home button now sends `G92 X0 Y0` + `M211 S1`; re-homing escape hatch
  is `M211 S0` via the new custom gcode box (or Motors off + hand-move).
- No API changes — server.py and main.cpp untouched.
- NOT verified: interactive click-through in a real browser (Chrome
  extension not connected); UI wiring is grep-verified and the API path
  curl-verified against the running mock server. Firmware behavior (clamping
  after set-home) needs a hardware test after SD-flashing firmware.bin.

---

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
