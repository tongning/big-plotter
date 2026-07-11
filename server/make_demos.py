#!/usr/bin/env python3
"""Generate the demo gcode files in web/demos/.

Demo files are tile-relative: coordinates in 0..150 mm, y-up, containing
only pen commands and G0/G1 moves. The web app wraps them with its own
header/footer and offsets X/Y to the user-selected region at send time.

Pen commands must match web/js/config.js.
"""
import math
import pathlib

DEMOS_DIR = pathlib.Path(__file__).resolve().parent.parent / "web" / "demos"
TILE = 150

PEN_UP = "M280 P0 S90 ; pen up"
PEN_DOWN = "M280 P0 S30 ; pen down"
DWELL = "G4 P250"
DRAW_FEED = 2000
TRAVEL_FEED = 4000


def fmt(v):
    return f"{round(v * 100) / 100:g}"


def emit(polylines, comment):
    lines = [f"; {comment} (tile-relative, 0-{TILE}mm, y-up)"]
    for pl in polylines:
        lines.append(f"G0 X{fmt(pl[0][0])} Y{fmt(pl[0][1])} F{TRAVEL_FEED}")
        lines.append(PEN_DOWN)
        lines.append(DWELL)
        for i, (x, y) in enumerate(pl[1:]):
            feed = f" F{DRAW_FEED}" if i == 0 else ""
            lines.append(f"G1 X{fmt(x)} Y{fmt(y)}{feed}")
        lines.append(PEN_UP)
        lines.append(DWELL)
    return "\n".join(lines) + "\n"


def circle(cx, cy, r, segments=72, start=0.0, end=2 * math.pi):
    pts = []
    for i in range(segments + 1):
        t = start + (end - start) * i / segments
        pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    return pts


def star():
    pts = []
    for i in range(10):
        r = 60 if i % 2 == 0 else 23
        a = math.pi / 2 + i * math.pi / 5
        pts.append((75 + r * math.cos(a), 75 + r * math.sin(a)))
    pts.append(pts[0])
    return [pts]


def smiley():
    return [
        circle(75, 75, 58),
        circle(53, 95, 7, segments=24),
        circle(97, 95, 7, segments=24),
        circle(75, 78, 38, segments=36,
               start=math.radians(200), end=math.radians(340)),
    ]


# Minimal stroke font on a 3-wide, 5-tall cell (y-up).
FONT = {
    "O": [[(0, 0), (3, 0), (3, 5), (0, 5), (0, 0)]],
    "P": [[(0, 0), (0, 5), (3, 5), (3, 2.5), (0, 2.5)]],
    "E": [[(3, 0), (0, 0), (0, 5), (3, 5)], [(0, 2.5), (2.2, 2.5)]],
    "N": [[(0, 0), (0, 5), (3, 0), (3, 5)]],
    "S": [[(3, 5), (0, 5), (0, 2.5), (3, 2.5), (3, 0), (0, 0)]],
    "A": [[(0, 0), (1.5, 5), (3, 0)], [(0.6, 2), (2.4, 2)]],
    "U": [[(0, 5), (0, 0), (3, 0), (3, 5)]],
    "C": [[(3, 5), (0, 5), (0, 0), (3, 0)]],
}
ADVANCE = 4.5  # cell width 3 + spacing 1.5


def word(text, unit, x0, y0):
    polylines = []
    for i, ch in enumerate(text):
        ox = x0 + i * ADVANCE * unit
        for pl in FONT[ch]:
            polylines.append([(ox + x * unit, y0 + y * unit) for x, y in pl])
    return polylines


def opensauce():
    unit = 130 / (len("SAUCE") * ADVANCE - 1.5)  # widest line -> 130mm
    def width(t):
        return (len(t) * ADVANCE - 1.5) * unit
    return (word("OPEN", unit, (TILE - width("OPEN")) / 2, 85) +
            word("SAUCE", unit, (TILE - width("SAUCE")) / 2, 35))


def main():
    DEMOS_DIR.mkdir(parents=True, exist_ok=True)
    demos = {
        "star.gcode": emit(star(), "demo: star"),
        "smiley.gcode": emit(smiley(), "demo: smiley"),
        "opensauce.gcode": emit(opensauce(), "demo: OPEN SAUCE"),
    }
    for name, text in demos.items():
        path = DEMOS_DIR / name
        path.write_text(text)
        print(f"wrote {path} ({len(text.splitlines())} lines)")


if __name__ == "__main__":
    main()
