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
  penUpCmd: 'M280 P0 S90',
  penDownCmd: 'M280 P0 S30',
  penDwellMs: 250, // servo settle time after a pen move

  drawFeed: 2000,
  travelFeed: 4000,

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
