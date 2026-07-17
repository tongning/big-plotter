'use strict';

// Gcode generation and parsing.
//
// Coordinate systems:
//   - "local"  : mm within a CONFIG.tile square, origin top-left, y grows
//                DOWN (matches the drawing canvas).
//   - "board"  : plotter mm, origin bottom-left, y grows UP.

function gcFmt(n) {
  return String(Math.round(n * 100) / 100);
}

function gcDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// --- simplification ---

function gcSimplifyMinDist(pts, minDist) {
  if (pts.length <= 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (gcDist(pts[i], out[out.length - 1]) >= minDist) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function gcPerpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return gcDist(p, a);
  return Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / len;
}

function gcRdp(pts, eps) {
  if (pts.length <= 2) return pts.slice();
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = gcPerpDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [a, b];
  const left = gcRdp(pts.slice(0, idx + 1), eps);
  const right = gcRdp(pts.slice(idx), eps);
  return left.slice(0, -1).concat(right);
}

function gcSimplify(pts) {
  return gcRdp(gcSimplifyMinDist(pts, CONFIG.simplifyMinDist), CONFIG.simplifyEpsilon);
}

// --- coordinate transforms ---

// region: {x, y} = board coords of the tile's bottom-left corner.
function gcLocalToBoard(p, region) {
  return { x: region.x + p.x, y: region.y + (CONFIG.tile - p.y) };
}

// Re-express a board record's polylines (packed [x,y] pairs, y-down within
// the record's own tile) in another region's local frame. Used to show
// what's already on the paper under a new drawing in the same spot; points
// can fall outside 0..tile when the tiles only partly overlap.
function boardRecordToLocal(rec, region) {
  return rec.polylines.map((pl, i) => ({
    color: rec.colors ? rec.colors[i] : null,
    points: pl.map(([px, py]) => ({
      x: rec.x + px - region.x,
      y: CONFIG.tile - (rec.y + (rec.size - py) - region.y),
    })),
  }));
}

// Last-line safety guard: never emit a coordinate inside the margin.
function gcClamp(p) {
  return {
    x: Math.min(Math.max(p.x, CONFIG.margin), CONFIG.boardW - CONFIG.margin),
    y: Math.min(Math.max(p.y, CONFIG.margin), CONFIG.boardH - CONFIG.margin),
  };
}

// --- emission ---

function gcPenUp(lines) {
  lines.push('M400');
  lines.push(CONFIG.penUpCmd + ' ; pen up');
  lines.push('G4 P' + CONFIG.penDwellMs);
}

function gcPenDown(lines) {
  lines.push('M400');
  lines.push(CONFIG.penDownCmd + ' ; pen down');
  lines.push('G4 P' + CONFIG.penDwellMs);
}

// Rotate the pen carousel. The pen MUST be up while the carousel turns or
// the mechanism jams, so this always lifts first and dwells long enough
// for the lift to physically finish before rotating.
function gcSelectColor(lines, colorId) {
  const pen = penById(colorId);
  gcPenUp(lines);
  lines.push('G4 P' + CONFIG.colorSettleMs + ' ; let pen lift fully');
  lines.push(pen.cmd + ' ; select ' + pen.id + ' pen');
  lines.push('G4 P' + CONFIG.colorSettleMs);
}

function gcHeader(name, region) {
  const lines = [];
  lines.push('; ' + name);
  lines.push('; region x=' + gcFmt(region.x) + ' y=' + gcFmt(region.y) +
             ' size=' + CONFIG.tile);
  lines.push('G21 ; mm');
  lines.push('G90 ; absolute');
  gcPenUp(lines);
  return lines;
}

function gcFooter(lines) {
  gcPenUp(lines);
  lines.push('G0 X' + gcFmt(CONFIG.parkX) + ' Y' + gcFmt(CONFIG.parkY) +
             ' F' + CONFIG.travelFeed + ' ; park');
  return lines.join('\n') + '\n';
}

// strokes: [{points: [{x,y}, ...], color}] in local (tile, y-down) mm.
// Strokes are grouped by color (groups ordered by first appearance, stroke
// order preserved within a group) so each pen is picked up exactly once.
function strokesToGcode(strokes, region, name) {
  const lines = gcHeader(name, region);
  const groups = new Map(); // colorId -> strokes, in first-appearance order
  for (const s of strokes) {
    const id = penById(s.color).id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(s);
  }
  for (const [colorId, group] of groups) {
    gcSelectColor(lines, colorId);
    for (const s of group) {
      const pts = gcSimplify(s.points).map(p => gcClamp(gcLocalToBoard(p, region)));
      if (pts.length === 0) continue;
      lines.push('G0 X' + gcFmt(pts[0].x) + ' Y' + gcFmt(pts[0].y) +
                 ' F' + CONFIG.travelFeed);
      gcPenDown(lines);
      for (let i = 1; i < pts.length; i++) {
        lines.push('G1 X' + gcFmt(pts[i].x) + ' Y' + gcFmt(pts[i].y) +
                   (i === 1 ? ' F' + CONFIG.drawFeed : ''));
      }
      // A single point is a dot: pen down + up with no G1 in between.
      gcPenUp(lines);
    }
  }
  return gcFooter(lines);
}

// Compact [x, y] pairs (0.1mm precision) for board records.
function packPolylines(polylines) {
  return polylines.map(pl =>
    pl.map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]));
}
