'use strict';

// Shared configuration for board geometry and gcode generation.
// Distances in mm, feed rates in mm/min.
const CONFIG = {
  // Physical board: X = 30 in, Y = 20 in, origin at bottom-left.
  boardW: 762,
  boardH: 508,
  // Keep-out border on all sides (1 in). No pen moves land inside it.
  margin: 25.4,
  // Side length of a user drawing region.
  tile: 150,

  // Pen lift servo. Adjust angles once the hardware is tuned.
  penUpCmd: 'M280 P0 S140',
  penDownCmd: 'M280 P0 S40',
  penDwellMs: 10, // servo settle time after a pen move

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
  colorSettleMs: 400, // lift/rotate settle time around a color switch

  drawFeed: 8000,
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

// Factory values of the admin-editable gcode, for the reset button.
const GCODE_DEFAULTS = {
  penUpCmd: CONFIG.penUpCmd,
  penDownCmd: CONFIG.penDownCmd,
  penCmds: Object.fromEntries(CONFIG.pens.map(p => [p.id, p.cmd])),
};

// The admin panel can override the pen up/down/color gcode; overrides
// persist in localStorage so the kiosk keeps them across reloads.
// (localStorage is absent under node in test_gcode.mjs.)
const GCODE_OVERRIDES_KEY = 'plotterGcodeOverrides';
(function applyGcodeOverrides() {
  if (typeof localStorage === 'undefined') return;
  let o;
  try {
    o = JSON.parse(localStorage.getItem(GCODE_OVERRIDES_KEY) || '{}');
  } catch (err) {
    return; // corrupt overrides: keep factory defaults
  }
  if (typeof o.penUpCmd === 'string') CONFIG.penUpCmd = o.penUpCmd;
  if (typeof o.penDownCmd === 'string') CONFIG.penDownCmd = o.penDownCmd;
  for (const pen of CONFIG.pens) {
    if (o.penCmds && typeof o.penCmds[pen.id] === 'string') {
      pen.cmd = o.penCmds[pen.id];
    }
  }
})();
