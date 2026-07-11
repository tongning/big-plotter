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
  `NUM_SERVOS 1`.
- UART pins/baud are constants at the top of `esp32/src/main.cpp` if the
  wiring changes.

First hardware test: open the web app → ⚙️ admin panel → **Pen up**. The
serial monitor should show `[printer] ok`. Then jog with the arrows, set the
origin with 📍 (`G92 X0 Y0` — the machine has no endstops), and plot the
star demo.

## API (implemented by both `server/server.py` and the firmware)

| Method   | Path           | Body           | Behavior |
|----------|----------------|----------------|----------|
| `GET`    | `/api/board`   | —              | `{"drawings":[{id,name,x,y,size,polylines,ts}]}` — everything plotted so far. `x`/`y` = board mm of the region's bottom-left corner; `polylines` = compact `[x,y]` mm pairs relative to the tile (y-down), used for thumbnails. |
| `POST`   | `/api/board`   | JSON record    | Append one drawing record. |
| `POST`   | `/api/print`   | raw gcode text | Queue the (single, latest) drawing for the plotter. 409 if a job is active. |
| `POST`   | `/api/command` | raw gcode text | Immediate machine command from the admin panel (jog, set-home, pen). 409 if busy. |
| `DELETE` | `/api/board`   | —              | Clear board state (staff "new paper" button). |
| `GET`    | `/api/status`  | —              | Firmware only: `{state, line, error, ip, rssi}` — job progress and WiFi info. |

Only the current drawing's gcode is ever sent to the printer; board records
exist purely so the region picker shows what's already on the paper.

## Geometry & gcode

- Board: X = 762mm (30in), Y = 508mm (20in), origin bottom-left, 25.4mm
  (1in) keep-out margin on all sides. Emitted coordinates are clamped to the
  usable area as a final guard — important because the machine has no
  endstops.
- Pen lift: servo via `M280` (`S90` up / `S30` down + `G4` settle dwell).
  Commands, feeds, and angles live in `web/js/config.js`.
- Conversion (`web/js/gcode.js`): strokes are simplified (min-distance +
  Douglas-Peucker), flipped from canvas y-down to plotter y-up, offset to
  the chosen region, and emitted as `G0` travels / `G1` draws.

## Demo drawings

`web/demos/*.gcode` are tile-relative (coords 0–150mm, y-up, `G0`/`G1` + pen
commands only). The app parses them for previews and rewrites X/Y with the
region offset at send time. Regenerate with `python3 server/make_demos.py`
(edit that script to add demos, and list them in `web/demos/manifest.json`).
