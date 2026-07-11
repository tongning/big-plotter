'use strict';

const $ = sel => document.querySelector(sel);

const state = {
  // Board coords (mm, origin bottom-left) of the selected tile's
  // bottom-left corner.
  region: {
    x: (CONFIG.boardW - CONFIG.tile) / 2,
    y: (CONFIG.boardH - CONFIG.tile) / 2,
  },
  drawings: [], // records already plotted on the board
  demos: [],    // [{id, name, text, localPolylines}]
  demo: null,   // demo selected for the current draw session, or null
};

async function api(method, path, body, type) {
  const res = await fetch(path, {
    method,
    body,
    headers: body ? { 'Content-Type': type } : undefined,
  });
  if (!res.ok) throw new Error(method + ' ' + path + ' failed (' + res.status + ')');
  return res.json();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2500);
}

// ---------- board view (region picker) ----------

const boardCanvas = $('#board-canvas');
const BOARD_PX = 1080;
boardCanvas.width = BOARD_PX;
boardCanvas.height = Math.round(BOARD_PX * CONFIG.boardH / CONFIG.boardW);
const bs = BOARD_PX / CONFIG.boardW; // canvas px per mm

function renderBoard() {
  const ctx = boardCanvas.getContext('2d');
  const W = boardCanvas.width, H = boardCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#fdfaf3';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#c9c2b4';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // keep-out margin
  const m = CONFIG.margin;
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = '#d8d2c4';
  ctx.strokeRect(m * bs, m * bs, (CONFIG.boardW - 2 * m) * bs, (CONFIG.boardH - 2 * m) * bs);
  ctx.setLineDash([]);

  // existing drawings (packed [x, y] polylines, local y-down within tile)
  ctx.strokeStyle = '#3a3a4a';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  for (const d of state.drawings) {
    const ox = d.x * bs;
    const oy = (CONFIG.boardH - d.y - d.size) * bs;
    for (const pl of d.polylines) {
      if (pl.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(ox + pl[0][0] * bs, oy + pl[0][1] * bs);
      for (let i = 1; i < pl.length; i++) {
        ctx.lineTo(ox + pl[i][0] * bs, oy + pl[i][1] * bs);
      }
      ctx.stroke();
    }
  }

  // selected region
  const r = state.region;
  const rx = r.x * bs, ry = (CONFIG.boardH - r.y - CONFIG.tile) * bs;
  const rs = CONFIG.tile * bs;
  ctx.fillStyle = 'rgba(74, 108, 247, 0.10)';
  ctx.fillRect(rx, ry, rs, rs);
  ctx.strokeStyle = '#4a6cf7';
  ctx.lineWidth = 3;
  ctx.strokeRect(rx, ry, rs, rs);
  ctx.fillStyle = '#4a6cf7';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('draw here', rx + rs / 2, ry + rs / 2 + 8);
}

function boardPointerMm(e) {
  const rect = boardCanvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width * CONFIG.boardW,
    y: CONFIG.boardH - (e.clientY - rect.top) / rect.height * CONFIG.boardH,
  };
}

function clampRegion(x, y) {
  const m = CONFIG.margin, t = CONFIG.tile;
  return {
    x: Math.min(Math.max(x, m), CONFIG.boardW - m - t),
    y: Math.min(Math.max(y, m), CONFIG.boardH - m - t),
  };
}

let dragOffset = null;
boardCanvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  boardCanvas.setPointerCapture(e.pointerId);
  const p = boardPointerMm(e);
  const r = state.region, t = CONFIG.tile;
  const inside = p.x >= r.x && p.x <= r.x + t && p.y >= r.y && p.y <= r.y + t;
  if (!inside) {
    state.region = clampRegion(p.x - t / 2, p.y - t / 2);
  }
  dragOffset = { x: p.x - state.region.x, y: p.y - state.region.y };
  renderBoard();
});
boardCanvas.addEventListener('pointermove', e => {
  if (!dragOffset) return;
  const p = boardPointerMm(e);
  state.region = clampRegion(p.x - dragOffset.x, p.y - dragOffset.y);
  renderBoard();
});
boardCanvas.addEventListener('pointerup', () => { dragOffset = null; });

async function loadBoard() {
  try {
    const data = await api('GET', '/api/board');
    state.drawings = data.drawings || [];
  } catch (err) {
    toast('Could not load board state: ' + err.message);
    state.drawings = [];
  }
  renderBoard();
}

// staff-only clear, with inline two-step confirm (no blocking dialogs)
const clearBtn = $('#btn-clear-board');
let clearTimer = null;
clearBtn.addEventListener('click', async () => {
  if (!clearTimer) {
    clearBtn.textContent = 'Really clear? Click again';
    clearTimer = setTimeout(() => {
      clearTimer = null;
      clearBtn.textContent = '🧹 New paper (clear board)';
    }, 3000);
    return;
  }
  clearTimeout(clearTimer);
  clearTimer = null;
  clearBtn.textContent = '🧹 New paper (clear board)';
  try {
    await api('DELETE', '/api/board');
    await loadBoard();
    toast('Board cleared');
  } catch (err) {
    toast('Clear failed: ' + err.message);
  }
});

// ---------- draw view ----------

const surface = new DrawingSurface($('#draw-canvas'));

function showBoard() {
  $('#view-draw').classList.add('hidden');
  $('#view-board').classList.remove('hidden');
}

function enterDraw(demo) {
  state.demo = demo;
  $('#view-board').classList.add('hidden');
  $('#view-draw').classList.remove('hidden');
  const r = state.region;
  $('#region-label').textContent =
    'Spot: X ' + Math.round(r.x) + '–' + Math.round(r.x + CONFIG.tile) +
    'mm, Y ' + Math.round(r.y) + '–' + Math.round(r.y + CONFIG.tile) + 'mm';
  $('#drawing-name').value = '';
  const banner = $('#demo-banner');
  if (demo) {
    surface.readonly = true;
    surface.setStrokes(demo.localPolylines.map(pl => ({
      points: pl.map(p => ({ x: p.x, y: p.y })),
    })));
    $('#toolbar').classList.add('hidden');
    banner.classList.remove('hidden');
    $('#demo-banner-text').textContent =
      '“' + demo.name + '” is ready — hit Draw it! to plot, or';
  } else {
    surface.readonly = false;
    surface.setStrokes([]);
    $('#toolbar').classList.remove('hidden');
    banner.classList.add('hidden');
  }
}

$('#btn-start').addEventListener('click', () => enterDraw(null));
$('#btn-back').addEventListener('click', showBoard);
$('#btn-demo-blank').addEventListener('click', () => enterDraw(null));
$('#btn-undo').addEventListener('click', () => surface.undo());
$('#btn-clear-drawing').addEventListener('click', () => surface.clear());

for (const btn of document.querySelectorAll('[data-tool]')) {
  btn.addEventListener('click', () => {
    surface.tool = btn.dataset.tool;
    document.querySelectorAll('[data-tool]').forEach(b =>
      b.classList.toggle('active', b === btn));
    $('#eraser-size-wrap').classList.toggle('hidden', surface.tool !== 'eraser');
    surface.render();
  });
}

$('#eraser-size').addEventListener('input', e => {
  surface.eraserRadius = Number(e.target.value);
});

$('#btn-submit').addEventListener('click', async () => {
  const btn = $('#btn-submit');
  const name = $('#drawing-name').value.trim() ||
    (state.demo ? state.demo.name : 'visitor drawing');
  let gcode, polylines;
  if (state.demo) {
    gcode = demoToGcode(state.demo.text, state.region, state.demo.name);
    polylines = state.demo.localPolylines;
  } else {
    if (surface.isEmpty()) {
      toast('Draw something first! ✏️');
      return;
    }
    gcode = strokesToGcode(surface.strokes, state.region, name);
    polylines = surface.strokes.map(s => gcSimplify(s.points));
  }
  // Copy before the network calls so it happens while the click's user
  // activation is still fresh (clipboard access requires it).
  let copied = false;
  if (CONFIG.copyGcodeToClipboard && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(gcode);
      copied = true;
    } catch (err) {
      console.warn('clipboard copy failed:', err);
    }
  }
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await api('POST', '/api/print', gcode, 'text/plain');
    await api('POST', '/api/board', JSON.stringify({
      id: String(Date.now()),
      name,
      x: Math.round(state.region.x * 10) / 10,
      y: Math.round(state.region.y * 10) / 10,
      size: CONFIG.tile,
      polylines: packPolylines(polylines),
      ts: Date.now(),
    }), 'application/json');
    toast(copied ? 'Sent to the plotter! 🖊️ (gcode copied to clipboard)'
                 : 'Sent to the plotter! 🖊️');
    await loadBoard();
    showBoard();
  } catch (err) {
    toast('Failed to send: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🖨️ Draw it!';
  }
});

// ---------- admin panel (machine control) ----------

$('#btn-admin').addEventListener('click', () =>
  $('#admin-panel').classList.toggle('hidden'));

let jogStep = 10; // mm

for (const btn of document.querySelectorAll('[data-step]')) {
  btn.addEventListener('click', () => {
    jogStep = Number(btn.dataset.step);
    document.querySelectorAll('[data-step]').forEach(b =>
      b.classList.toggle('active', b === btn));
  });
}

// Immediate commands go to /api/command (ESP32: straight to UART),
// not /api/print, so they aren't recorded as print jobs.
async function sendCommand(gcode, label) {
  const status = $('#admin-status');
  status.textContent = '→ ' + label;
  try {
    await api('POST', '/api/command', gcode, 'text/plain');
    status.textContent = '✓ ' + label;
  } catch (err) {
    status.textContent = '✗ ' + label + ' — ' + err.message;
  }
}

for (const btn of document.querySelectorAll('[data-jog]')) {
  btn.addEventListener('click', () => {
    const axis = btn.dataset.jog[0].toUpperCase();
    const dist = (btn.dataset.jog[1] === '+' ? 1 : -1) * jogStep;
    // relative move, then back to absolute mode
    sendCommand('G91\nG1 ' + axis + dist + ' F' + CONFIG.travelFeed + '\nG90\n',
      'jog ' + axis + (dist > 0 ? '+' : '') + dist + 'mm');
  });
}

$('#btn-home').addEventListener('click', () =>
  sendCommand('G92 X0 Y0\n', 'set home (0,0)'));
$('#btn-pen-up').addEventListener('click', () =>
  sendCommand(CONFIG.penUpCmd + '\n', 'pen up'));
$('#btn-pen-down').addEventListener('click', () =>
  sendCommand(CONFIG.penDownCmd + '\n', 'pen down'));

// ---------- demos ----------

async function loadDemos() {
  let manifest;
  try {
    manifest = await (await fetch('demos/manifest.json')).json();
  } catch (err) {
    return; // demos are optional
  }
  for (const entry of manifest) {
    try {
      const text = await (await fetch('demos/' + entry.file)).text();
      state.demos.push({
        id: entry.id,
        name: entry.name,
        text,
        localPolylines: gcodePolylinesToLocal(parseGcode(text)),
      });
    } catch (err) {
      console.warn('demo failed to load:', entry.file, err);
    }
  }
  const holder = $('#demo-cards');
  for (const demo of state.demos) {
    const card = document.createElement('button');
    card.className = 'demo-card';
    const cv = document.createElement('canvas');
    cv.width = 96;
    cv.height = 96;
    drawPreview(cv, demo.localPolylines);
    const label = document.createElement('span');
    label.textContent = demo.name;
    card.append(cv, label);
    card.addEventListener('click', () => enterDraw(demo));
    holder.appendChild(card);
  }
}

function drawPreview(canvas, polylines) {
  const ctx = canvas.getContext('2d');
  const s = canvas.width / CONFIG.tile;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';
  for (const pl of polylines) {
    if (pl.length === 0) continue;
    ctx.beginPath();
    ctx.moveTo(pl[0].x * s, pl[0].y * s);
    for (let i = 1; i < pl.length; i++) ctx.lineTo(pl[i].x * s, pl[i].y * s);
    ctx.stroke();
  }
}

// ---------- init ----------

loadBoard();
loadDemos();
