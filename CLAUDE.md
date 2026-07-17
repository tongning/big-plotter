# Big Plotter — project guide

Interactive pen-plotter exhibit for a maker fair. Browser app → ESP32-S2
Mini (WiFi + web host) → UART → SKR 1.4 running Marlin → servo pen lift.
See README.md for setup, wiring, and API details.

## Structure

```
web/                  the web app; vanilla HTML/CSS/JS, NO build step, no
                      frameworks — this folder is flashed verbatim to the
                      ESP32's LittleFS, so keep it small and dependency-free
  js/config.js        all tunables: board geometry, servo angles, feeds
  js/gcode.js         strokes→gcode and simplification
  js/draw.js          vector canvas editor (DrawingSurface class)
  js/app.js           views, region picker, admin panel, API calls
server/
  server.py           desktop mock of the ESP32 API (stdlib only) — port 8080
  test_gcode.mjs      headless tests that run the real web/js sources
esp32/
  src/main.cpp        entire firmware; config constants at the top
  scripts/sync_web.py PIO pre-script: mirrors ../web → data/ for uploadfs
  data/               GENERATED — never edit, gitignored
marlin/
  config/             our Marlin 2.1.2.5 changes (Configuration*.h, SKR pins
                      file with servos on the endstop ports, patched G92.cpp
                      that marks G92'd axes homed so soft endstops engage)
  build.sh            clones Marlin (gitignored), applies config, builds
  firmware.bin        built output; flash via SD card (LPC = no USB flash)
tasks/                todo.md (plan/progress), lessons.md (corrections)
```

## Invariants — do not break

- **Two implementations of one API.** `server/server.py` and
  `esp32/src/main.cpp` implement the same endpoints. Any API change must be
  made in both, and the frontend must keep working against both.
- **Coordinate systems** (documented at the top of `web/js/gcode.js`):
  - *local*: mm within a tile (`CONFIG.tile`, default 100mm,
    admin-adjustable at runtime), origin top-left, **y-down** (canvas).
  - *board*: plotter mm, origin bottom-left, **y-up**. Region `{x,y}` is the
    tile's bottom-left corner in board coords.
- **Drawings are vectors end-to-end.** Strokes are polylines; the eraser
  splits geometry rather than painting pixels. Never rasterize.
- **The machine has no endstops.** "Home" = jog to origin + `G92 X0 Y0`,
  never `G28`. Marlin's soft endstops only engage after set-home (our
  patched `marlin/config/G92.cpp` marks G92'd axes homed; stock Marlin never
  clamps unhomed axes) and only on freshly-flashed firmware, so the
  coordinate clamping in `gcode.js` (margin 25.4mm) remains the primary
  crash protection — keep it strict.
- **The pen carousel (`M280 P1`) may only rotate with the pen up** — it
  jams otherwise. Never emit a raw color command: use `gcSelectColor()`
  (gcode jobs) / `penColorCommand()` (admin), which lift the pen and dwell
  first. Gcode emission groups strokes by color so each job selects each
  pen at most once.
- **Only the latest drawing is sent to the printer.** Board records
  (`POST /api/board`) are display-only state for the region picker.
- Firmware stores board records as **comma-separated JSON objects** in
  `/board.dat` so `GET /api/board` can stream `{"drawings":[` + file + `]}`
  without a JSON parser. The client always sends complete records.

## Development tips

- UI work: `python3 server/server.py`, open http://localhost:8080. No build
  step — edit and reload.
- After touching `web/js/gcode.js` or `config.js`: run
  `node server/test_gcode.mjs` (fast, no deps). Extend it when adding
  conversion behavior.
- After changing anything in `web/`: `pio run -t uploadfs` (from `esp32/`)
  to reflash the ESP32's filesystem. Firmware changes: `pio run -t upload`.
- Serial port busy? Close the Arduino IDE — its background serial-monitor
  process holds `/dev/cu.usbmodem01`. Check with `lsof`.
- The gcode-to-clipboard debug feature (`CONFIG.copyGcodeToClipboard`) only
  works on localhost (secure context) — not when served from the ESP32 over
  plain HTTP. On hardware, inspect jobs via `GET /api/status` and the
  serial log (`[printer]`-prefixed lines echo everything Marlin says).
- WiFi debugging: the firmware boot log lists every SSID it can see.
  ESP32-S2 is 2.4GHz-only; iPhone hotspots need "Maximize Compatibility"
  and their names use a curly apostrophe (`’`), not ASCII `'`.
- Avoid blocking in ESPAsyncWebServer callbacks — gcode is spooled to
  LittleFS and fed to the printer by the `pumpJob()` state machine in
  `loop()` with Marlin `ok` flow control (10s timeout per line).
- Send raw gcode as `application/octet-stream`, not `text/plain`.
  ESPAsyncWebServer interprets a text body containing `=` as form data; the
  generated `region x=…` header would otherwise bypass the gcode callback.
- Kiosk UX rule: no browser-blocking dialogs (`alert`/`confirm`/`prompt`).
  Use the toast + inline two-step confirm patterns already in `app.js`.

## Task workflow

Plans and progress go in `tasks/todo.md`; after any user correction, record
the generalized lesson in `tasks/lessons.md` (read it at session start).
