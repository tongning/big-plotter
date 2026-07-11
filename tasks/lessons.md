# Lessons

- **Plotter has no homing switches — "home" means G92, not G28.** The machine
  is zeroed by jogging the head to the origin and running `G92 X0 Y0` (set
  current position as 0,0). Never emit `G28` for this machine; there are no
  endstops to home against. Corollary: soft endstops can't be relied on
  either, so keep the software bounds clamping in gcode.js strict.
