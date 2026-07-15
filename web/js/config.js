'use strict';

// Shared configuration for board geometry and gcode generation.
// Distances in mm, feed rates in mm/min.
const CONFIG = {
  // Physical board: X = 30 in, Y = 20 in, origin at bottom-left.
  boardW: 700,
  boardH: 500,
  // Keep-out border on all sides (1 in). No pen moves land inside it.
  margin: 25,
  // Side length of a user drawing region (admin-configurable at runtime).
  tile: 70,
  // Demo gcode files are authored on this tile size (see make_demos.py);
  // they get scaled by tile/demoSize at preview/send time.
  demoSize: 150,

  // Pen lift servo. Adjust angles once the hardware is tuned.
  penUpCmd: 'M280 P0 S140',
  penDownCmd: 'M280 P0 S40',
  penDwellMs: 40, // servo settle time after a pen move

  // Pen carousel servo (P1). One entry per color, in carousel order.
  // `css` is only for on-screen rendering; `cmd` rotates the carousel.
  // The pen must be UP before any of these run or the mechanism jams —
  // always switch via gcSelectColor()/penColorCommand(), never raw.
  pens: [
    { id: 'green',  label: 'Green',  css: '#2f9e44', cmd: 'M280 P1 S40'  },
    { id: 'blue',   label: 'Blue',   css: '#1e6be0', cmd: 'M280 P1 S62'  },
    { id: 'red',    label: 'Red',    css: '#e03131', cmd: 'M280 P1 S91'  },
    { id: 'yellow', label: 'Yellow', css: '#eab308', cmd: 'M280 P1 S117' },
  ],
  colorSettleMs: 300, // lift/rotate settle time around a color switch

  drawFeed: 6000,
  travelFeed: 8000,

  // Point simplification before emitting gcode.
  simplifyMinDist: 0.2, // drop consecutive points closer than this
  simplifyEpsilon: 0.15, // Douglas-Peucker tolerance

  // Where the head parks after a job (machine home).
  parkX: 0,
  parkY: 0,

  // Debug aid: copy the submitted gcode to the clipboard so it can be
  // inspected/pasted elsewhere. Turn off for the fair kiosk.
  copyGcodeToClipboard: true,
};

function penById(id) {
  return CONFIG.pens.find(p => p.id === id) || CONFIG.pens[0];
}

// Largest tile that still fits inside the keep-out margins.
function maxTile() {
  return Math.min(CONFIG.boardW, CONFIG.boardH) - 2 * CONFIG.margin;
}

// Factory values of the admin-editable settings, for the reset button.
const SETTINGS_DEFAULTS = {
  tile: CONFIG.tile,
  penUpCmd: CONFIG.penUpCmd,
  penDownCmd: CONFIG.penDownCmd,
  penCmds: Object.fromEntries(CONFIG.pens.map(p => [p.id, p.cmd])),
};

// The admin panel can override the tile size and pen up/down/color gcode;
// overrides persist in localStorage so the kiosk keeps them across
// reloads. (localStorage is absent under node in test_gcode.mjs.)
const SETTINGS_KEY = 'plotterSettings';
(function applySettingsOverrides() {
  if (typeof localStorage === 'undefined') return;
  let o;
  try {
    o = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch (err) {
    return; // corrupt overrides: keep factory defaults
  }
  if (typeof o.tile === 'number' && o.tile >= 20 && o.tile <= maxTile()) {
    CONFIG.tile = o.tile;
  }
  if (typeof o.penUpCmd === 'string') CONFIG.penUpCmd = o.penUpCmd;
  if (typeof o.penDownCmd === 'string') CONFIG.penDownCmd = o.penDownCmd;
  for (const pen of CONFIG.pens) {
    if (o.penCmds && typeof o.penCmds[pen.id] === 'string') {
      pen.cmd = o.penCmds[pen.id];
    }
  }
})();
