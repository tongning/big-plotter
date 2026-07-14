'use strict';

// Vector drawing surface. Strokes are polylines in local mm
// (0..CONFIG.tile, origin top-left, y-down). Never rasterized, so the
// eraser edits geometry: it removes/splits polyline segments.

const ELLIPSE_SEGMENTS = 64;
const PEN_DISPLAY_MM = 1.2; // cosmetic; the plotter pen width is fixed

class DrawingSurface {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = []; // [{points: [{x,y}, ...], color}]
    // What's already plotted in this spot, shown faintly under the new
    // drawing. Display only: never erased, submitted, or undone.
    this.background = []; // [{points, color}], color null = pre-color record
    this.undoStack = [];
    this.tool = 'pen'; // pen | eraser | line | rect | ellipse
    this.color = CONFIG.pens[0].id;
    this.eraserRadius = 6; // mm
    this.readonly = false;
    this.active = null; // in-progress stroke/shape
    this.cursor = null; // last pointer pos (for eraser outline)
    this.onchange = null;

    canvas.addEventListener('pointerdown', e => this._down(e));
    canvas.addEventListener('pointermove', e => this._move(e));
    canvas.addEventListener('pointerup', e => this._up(e));
    canvas.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.render();
    });
  }

  get scale() { return this.canvas.width / CONFIG.tile; } // px per mm

  setStrokes(strokes) {
    this.strokes = strokes;
    this.undoStack = [];
    this.active = null;
    this.render();
  }

  clear() {
    this._snapshot();
    this.strokes = [];
    this.active = null;
    this.render();
    this._changed();
  }

  undo() {
    if (this.undoStack.length === 0) return;
    this.strokes = this.undoStack.pop();
    this.render();
    this._changed();
  }

  isEmpty() {
    return this.strokes.length === 0;
  }

  _changed() {
    if (this.onchange) this.onchange();
  }

  _snapshot() {
    this.undoStack.push(this.strokes.map(s => ({
      points: s.points.map(p => ({ x: p.x, y: p.y })),
      color: s.color,
    })));
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  _toMm(e) {
    const r = this.canvas.getBoundingClientRect();
    const clamp = v => Math.min(Math.max(v, 0), CONFIG.tile);
    return {
      x: clamp((e.clientX - r.left) / r.width * CONFIG.tile),
      y: clamp((e.clientY - r.top) / r.height * CONFIG.tile),
    };
  }

  _down(e) {
    if (this.readonly) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this._toMm(e);
    this.cursor = p;
    this._snapshot();
    this._strokesBefore = JSON.stringify(this.strokes);
    if (this.tool === 'pen') {
      this.active = { type: 'pen', color: this.color, points: [p] };
    } else if (this.tool === 'eraser') {
      this.active = { type: 'eraser' };
      this._eraseAt(p);
    } else {
      this.active = { type: this.tool, color: this.color, start: p, end: p };
    }
    this.render();
  }

  _move(e) {
    const p = this._toMm(e);
    this.cursor = p;
    if (this.active) {
      if (this.active.type === 'pen') {
        const last = this.active.points[this.active.points.length - 1];
        if (gcDist(p, last) > 0.15) this.active.points.push(p);
      } else if (this.active.type === 'eraser') {
        this._eraseAt(p);
      } else {
        this.active.end = p;
      }
    }
    this.render();
  }

  _up(e) {
    if (!this.active) return;
    const a = this.active;
    this.active = null;
    if (a.type === 'pen') {
      this.strokes.push({ points: a.points, color: a.color });
    } else if (a.type !== 'eraser') {
      const pts = shapeToPolyline(a);
      if (pts.length >= 2) this.strokes.push({ points: pts, color: a.color });
    }
    // Drop the undo snapshot if nothing actually changed (e.g. an eraser
    // drag that touched no strokes).
    if (JSON.stringify(this.strokes) === this._strokesBefore) {
      this.undoStack.pop();
    }
    this.render();
    this._changed();
  }

  // Remove everything within eraserRadius of p, splitting polylines.
  // Long segments are subdivided first so a segment passing through the
  // eraser circle without a vertex inside it still gets cut.
  _eraseAt(p) {
    const r = this.eraserRadius;
    const out = [];
    for (const s of this.strokes) {
      if (s.points.length === 1) {
        if (gcDist(s.points[0], p) > r) out.push(s);
        continue;
      }
      const dense = densify(s.points, r / 2);
      let piece = [];
      for (const q of dense) {
        if (gcDist(q, p) <= r) {
          if (piece.length >= 2) out.push({ points: piece, color: s.color });
          piece = [];
        } else {
          piece.push(q);
        }
      }
      if (piece.length >= 2) out.push({ points: piece, color: s.color });
    }
    this.strokes = out;
  }

  render() {
    const ctx = this.ctx, s = this.scale, size = this.canvas.width;
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    // faint 10mm grid
    ctx.strokeStyle = '#eef1f4';
    ctx.lineWidth = 1;
    for (let mm = 10; mm < CONFIG.tile; mm += 10) {
      ctx.beginPath();
      ctx.moveTo(mm * s, 0); ctx.lineTo(mm * s, size);
      ctx.moveTo(0, mm * s); ctx.lineTo(size, mm * s);
      ctx.stroke();
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = PEN_DISPLAY_MM * s;

    if (this.background.length) {
      ctx.save();
      ctx.globalAlpha = 0.22;
      for (const b of this.background) {
        ctx.strokeStyle = b.color ? penById(b.color).css : '#3a3a4a';
        this._drawPolyline(b.points, s);
      }
      ctx.restore();
    }

    for (const st of this.strokes) {
      ctx.strokeStyle = penById(st.color).css;
      this._drawPolyline(st.points, s);
    }

    if (this.active && this.active.type !== 'eraser') {
      ctx.strokeStyle = penById(this.active.color).css;
      this._drawPolyline(this.active.type === 'pen'
        ? this.active.points : shapeToPolyline(this.active), s);
    }

    if (this.tool === 'eraser' && this.cursor && !this.readonly) {
      ctx.strokeStyle = '#e05a5a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(this.cursor.x * s, this.cursor.y * s, this.eraserRadius * s, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _drawPolyline(pts, s) {
    if (pts.length === 0) return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0].x * s, pts[0].y * s);
    if (pts.length === 1) {
      ctx.lineTo(pts[0].x * s + 0.01, pts[0].y * s); // dot
    }
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * s, pts[i].y * s);
    ctx.stroke();
  }
}

function densify(pts, maxLen) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = gcDist(a, b);
    const n = Math.ceil(d / maxLen);
    for (let k = 1; k <= n; k++) {
      out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
    }
  }
  return out;
}

function shapeToPolyline(shape) {
  const a = shape.start, b = shape.end;
  if (shape.type === 'line') {
    return [a, b];
  }
  if (shape.type === 'rect') {
    return [
      { x: a.x, y: a.y }, { x: b.x, y: a.y },
      { x: b.x, y: b.y }, { x: a.x, y: b.y },
      { x: a.x, y: a.y },
    ];
  }
  if (shape.type === 'ellipse') {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    if (rx < 0.3 && ry < 0.3) return [];
    const pts = [];
    for (let i = 0; i <= ELLIPSE_SEGMENTS; i++) {
      const t = (i / ELLIPSE_SEGMENTS) * Math.PI * 2;
      pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
    }
    return pts;
  }
  return [];
}
