# Lessons

- **The desktop mock can't reproduce ESPAsyncWebServer's request parsing.**
  The zero-motion "drawings don't plot but jogs do" bug was ESPAsyncWebServer
  consuming `text/plain` POST bodies containing `=` as form params (drawing
  gcode always has `; region x=…`; jog commands never have `=`), so the body
  callback never ran — while the Python mock accepted the same request fine.
  Client now sends `application/octet-stream` for gcode. When an ESP32
  endpoint misbehaves, suspect the framework's content-type/body handling
  first, and verify with the device serial log (`[job] started, N bytes
  spooled`), not just against the mock.

- **Plotter has no homing switches — "home" means G92, not G28.** The machine
  is zeroed by jogging the head to the origin and running `G92 X0 Y0` (set
  current position as 0,0). Never emit `G28` for this machine; there are no
  endstops to home against. Corollary: stock Marlin never applies soft
  endstops to unhomed axes (only `G28` sets the homed flag), so as of
  2026-07 we ship a patched `G92.cpp` (+ `NO_WORKSPACE_OFFSETS`) that marks
  G92'd axes homed — soft endstops then clamp to the 762×508 board after
  set-home. They're still only a backstop (require current firmware +
  set-home pressed): keep the bounds clamping in gcode.js strict.
