# Big Plotter

Interactive pen-plotter exhibit for Open Sauce. Visitors pick a 150×150mm
spot on a 30in × 20in board, make a drawing in a web app (or choose a
ready-made demo), and hit **Draw it!** — the drawing is converted to gcode in
the browser and streamed to the plotter.

```
visitor's browser ──WiFi──> ESP32-S2 Mini ──UART──> SKR 1.4 (Marlin) ──> pen
     (web app)             (hosts the app,
                            queues gcode)
```

The plotter itself is 3D printed and driven by a BigTreeTech SKR 1.4 running
Marlin, with a servo pen lift (`M280`).

## Repo layout

```
web/       the web app (vanilla HTML/CSS/JS, no build step) — this exact
           folder is what gets flashed to the ESP32's LittleFS
server/    desktop mock of the ESP32 for development, plus dev tools
esp32/     PlatformIO firmware for the ESP32-S2 Mini
marlin/    Marlin config + build script for the SKR 1.4, and the built
           firmware.bin (the Marlin source tree itself is not committed)
tasks/     working notes (todo, lessons)
```

## Develop locally (no hardware needed)

```sh
python3 server/server.py        # http://localhost:8080  (stdlib only)
```

`server/server.py` mimics the ESP32 exactly: same endpoints, but received
gcode lands in `server/prints/*.gcode` (instead of the printer) and manual
admin commands in `server/commands.log`. Board state persists in
`server/board.json`.

Tests for the browser-side gcode pipeline (transforms, bounds clamping,
simplification, demo parsing/offsetting — runs the real `web/js` sources):

```sh
node server/test_gcode.mjs
```

## ESP32: build & upload

One-time setup:

```sh
pipx install platformio        # or: brew install platformio
```

Then, from `esp32/`:

```sh
pio run                 # compile
pio run -t uploadfs     # flash the web app (mirrors ../web -> LittleFS)
pio run -t upload       # flash the firmware
pio device monitor      # watch logs; prints the IP after WiFi joins
```

Run `uploadfs` again whenever anything in `web/` changes; `upload` again
whenever `src/main.cpp` changes. `esp32/data/` is regenerated from `web/` on
every build — never edit it.

Configuration lives at the top of `esp32/src/main.cpp`: WiFi SSID/password,
UART pins, baud rate, fallback AP credentials.

### WiFi behavior

- Joins the configured hotspot as a client; mDNS name `http://plotter.local`.
- If it can't join within 20s it starts a fallback AP — network
  `plotter-setup`, password `opensauce1`, app at `http://192.168.4.1` — so
  the exhibit still works if the venue hotspot misbehaves.
- The ESP32-S2 is **2.4GHz-only**. For an iPhone hotspot, enable
  **"Maximize Compatibility"**, and note that iOS hotspot names use a curly
  apostrophe (`Anthony’s iPhone`), not the ASCII `'`.
- The boot log prints every SSID the board can see — the first thing to
  check when it won't connect.

### Upload troubleshooting

- **"Could not open /dev/cu.usbmodem01" / "Resource busy"**: something else
  has the serial port open — close the Arduino IDE (including its background
  serial-monitor process), other monitors, etc. `lsof /dev/cu.usbmodem01`
  shows the culprit.
- If auto-reset into the bootloader fails: hold the **0** button, tap
  **RST**, release **0** — the board enters download mode (the port name may
  change) — then rerun the upload.

## Wiring: ESP32-S2 Mini ↔ SKR 1.4

Use the SKR's 5-pin **TFT** header (UART0). On the back silkscreen the row
is labeled `+5V GND 0.2 0.3 RESET` (square pad = `+5V`).

| SKR TFT pin | connects to | ESP32-S2 Mini pin |
|---|---|---|
| `0.3` (SKR RX) | ← | GPIO17 (ESP TX) |
| `0.2` (SKR TX) | → | GPIO18 (ESP RX) |
| `GND` | ↔ | GND |
| `+5V` | → | VBUS — powers the ESP from the plotter (unplug this wire while USB is attached to be safe) |
| `RESET` | | not connected |

- TX/RX are **crossed**. If the printer never answers (10s timeout,
  `printer not responding` in `/api/status`), swap the `0.2`/`0.3` wires
  first — both boards are 3.3V logic, so a swap is harmless.
- Pen servo plugs into the SKR **SERVOS** header (P2.0 = `SERVO0`, matching
  `M280 P0`).
- Marlin config requirements: `SERIAL_PORT_2 0` (the TFT header) at
  **115200** baud (`BAUDRATE 115200` or `BAUDRATE_2 115200`), and
  `NUM_SERVOS 2` (pen lift + color carousel).
- UART pins/baud are constants at the top of `esp32/src/main.cpp` if the
  wiring changes.

First hardware test: open the web app → ⚙️ admin panel → **Pen up**. The
serial monitor should show `[printer] ok`. Then jog with the arrows, set the
origin with 📍 (`G92 X0 Y0` + `M211 S1` — the machine has no endstops; this
also arms the firmware's software endstops, see the Marlin section), and
plot the star demo. The panel also has **Motors off** (`M84`, so the head
can be positioned by hand), color swatches that rotate the pen carousel
(always lifting the pen first — rotating with the pen down jams the
mechanism), a collapsible **Pen gcode settings** form (edits the pen
up/down/color commands live; saved to the browser's localStorage, **Reset
defaults** restores `config.js` values), and a custom-gcode box for one-off
commands (`M92` calibration, `M211 S0`, servo angle tests, …).

## Marlin firmware for the SKR 1.4

The plotter's controller runs a custom Marlin **2.1.2.5** build. Our changes
live in `marlin/config/` (Configuration.h, Configuration_adv.h, and the SKR
pins file); `marlin/build.sh` clones Marlin at the pinned tag, applies them,
and builds:

```sh
./marlin/build.sh       # requires PlatformIO; output: marlin/firmware.bin
```

**Flashing** (LPC1768 boards are SD-card only): copy `marlin/firmware.bin`
to a FAT32 SD card, insert into the SKR, power-cycle. The bootloader
installs it and renames the file to `FIRMWARE.CUR` — that rename is the
sign it worked.

What the build configures:

- True 2-axis Cartesian machine ("Big Plotter"): X + Y only, no Z, no
  extruder, no heaters/thermistors.
- TMC2208/2209 drivers in standalone (STEP/DIR) mode; **100 steps/mm**
  (GT2 belt, 16T pulleys, assumes 1/16 microstep jumpers under the
  drivers).
- Motion limits: 200mm/s max, 1500mm/s² acceleration; bed 762×508mm.
- **Both serial ports live**: USB and the TFT header (ESP32) at 115200.
- **Servos on the endstop ports** (their 3-pin plugs fit directly):
  | Function | gcode | port | signal pin |
  |---|---|---|---|
  | Pen lift | `M280 P0 S<angle>` | X-endstop | P1.29 |
  | Color select | `M280 P1 S<angle>` | Y-endstop | P1.28 |

  Endstop functions are remapped to unused pins — fine, since the machine
  has no switches and homes via `G92`.
- No endstops: never send `G28`. Software min/max endstops are enabled and
  actually enforced via two of our changes: stock Marlin only clamps *homed*
  axes (and only `G28` sets that flag), so our patched `G92.cpp` marks
  `G92`'d axes homed/trusted, and `NO_WORKSPACE_OFFSETS` makes `G92` set the
  native position directly (soft-endstop bounds live in native space). Net
  effect: after the admin **set home** (`G92 X0 Y0` at the physical origin)
  the firmware clamps all moves to 0–762 × 0–508mm. Before set-home, jogging
  is unrestricted. To deliberately jog past a stale zero when re-homing,
  send `M211 S0` from the admin gcode box (set home re-arms with `M211 S1`),
  or use **Motors off** (`M84`) and move the head by hand.
- EEPROM on: tune steps/mm with `M92 X… Y…` + `M500` (e.g. after the
  100mm-line calibration test) without reflashing.

Hardware cautions for the servo-on-endstop-port wiring: verify the port's
power pin is actually 5V before plugging a servo in (if it's 3.3V, power
the servo from the SERVOS header and use only the endstop signal pin), and
the endstop inputs have RC filter parts that round the PWM edges — if a
servo jitters, move its signal to P2.0 (SERVOS) / P0.10 (PROBE), a one-line
change in `marlin/config/pins_BTT_SKR_V1_4.h`.

## API (implemented by both `server/server.py` and the firmware)

| Method   | Path           | Body           | Behavior |
|----------|----------------|----------------|----------|
| `GET`    | `/api/board`   | —              | `{"drawings":[{id,name,x,y,size,polylines,colors,ts}]}` — everything plotted so far. `x`/`y` = board mm of the region's bottom-left corner; `polylines` = compact `[x,y]` mm pairs relative to the tile (y-down), used for thumbnails; `colors` = one pen id per polyline (older records may lack it). |
| `POST`   | `/api/board`   | JSON record    | Append one drawing record. |
| `POST`   | `/api/print`   | raw gcode (`application/octet-stream`) | Queue the (single, latest) drawing for the plotter. 409 if a job is active. |
| `POST`   | `/api/command` | raw gcode (`application/octet-stream`) | Immediate machine command from the admin panel (jog, set-home, pen). 409 if busy. |
| `DELETE` | `/api/board`   | —              | Clear board state (staff "new paper" button). |
| `GET`    | `/api/status`  | —              | `{state, line, error, ip, rssi}` — job progress and WiFi info. The app polls this after each submit to surface job failures (a queued job can still die on the machine). Mock always reports idle/no error. |

Only the current drawing's gcode is ever sent to the printer; board records
exist purely so the region picker shows what's already on the paper.

## Geometry & gcode

- Board: X = 762mm (30in), Y = 508mm (20in), origin bottom-left, 25.4mm
  (1in) keep-out margin on all sides. Emitted coordinates are clamped to the
  usable area as a final guard — important because the machine has no
  endstops.
- Pen lift: servo via `M280 P0` (`S140` up / `S40` down + `G4` settle
  dwell). Commands, feeds, and angles live in `web/js/config.js`
  (admin-panel edits override them via localStorage).
- Pen colors: a second servo (`M280 P1`) rotates a 4-pen carousel — green
  `S40`, blue `S62`, red `S91`, yellow `S117` (`CONFIG.pens`). Every switch
  emits pen-up + a `colorSettleMs` dwell *before* rotating; switching with
  the pen down jams the carousel. Visitor strokes carry a color, and gcode
  emission groups strokes by color (first-appearance order) so each pen is
  selected exactly once per job. Demos plot with the default (first) pen.
- Conversion (`web/js/gcode.js`): strokes are simplified (min-distance +
  Douglas-Peucker), flipped from canvas y-down to plotter y-up, offset to
  the chosen region, and emitted as `G0` travels / `G1` draws.

## Demo drawings

`web/demos/*.gcode` are tile-relative (coords 0–150mm, y-up, `G0`/`G1` + pen
commands only). The app parses them for previews and rewrites X/Y with the
region offset at send time. Regenerate with `python3 server/make_demos.py`
(edit that script to add demos, and list them in `web/demos/manifest.json`).
