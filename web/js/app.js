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
  demos: [],    // [{id, name, text, native}] — native = parsed demoSize
                // polylines; converted to local per use (tile can change)
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

function renderBoard(showSelection = true) {
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
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  for (const d of state.drawings) {
    const ox = d.x * bs;
    const oy = (CONFIG.boardH - d.y - d.size) * bs;
    for (let pi = 0; pi < d.polylines.length; pi++) {
      const pl = d.polylines[pi];
      if (pl.length === 0) continue;
      // records predating pen colors have no `colors` array
      ctx.strokeStyle = d.colors && d.colors[pi]
        ? penById(d.colors[pi]).css : '#3a3a4a';
      ctx.beginPath();
      ctx.moveTo(ox + pl[0][0] * bs, oy + pl[0][1] * bs);
      for (let i = 1; i < pl.length; i++) {
        ctx.lineTo(ox + pl[i][0] * bs, oy + pl[i][1] * bs);
      }
      ctx.stroke();
    }
  }

  // selected region
  if (!showSelection) return; // clean render for the zoom snapshot
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

// Existing board records overlapping the selected region, in the
// region's local frame — the faint underlay in the draw view.
function regionBackground() {
  const r = state.region, t = CONFIG.tile;
  const out = [];
  for (const d of state.drawings) {
    if (d.x + d.size <= r.x || d.x >= r.x + t ||
        d.y + d.size <= r.y || d.y >= r.y + t) continue;
    out.push(...boardRecordToLocal(d, r));
  }
  return out;
}

function updateRegionLabel() {
  const r = state.region;
  $('#region-label').textContent =
    'Spot: X ' + Math.round(r.x) + '–' + Math.round(r.x + CONFIG.tile) +
    'mm, Y ' + Math.round(r.y) + '–' + Math.round(r.y + CONFIG.tile) + 'mm';
}

// Where the selected region sits on screen (viewport px), for the zoom.
function regionScreenRect() {
  const rect = boardCanvas.getBoundingClientRect();
  const r = state.region;
  return {
    left: rect.left + (r.x / CONFIG.boardW) * rect.width,
    top: rect.top + ((CONFIG.boardH - r.y - CONFIG.tile) / CONFIG.boardH) * rect.height,
    size: (CONFIG.tile / CONFIG.boardW) * rect.width,
  };
}

// Fly a snapshot of the selected region from its spot on the board to the
// drawing canvas, then fade it out to reveal the editor. Purely cosmetic:
// the draw view is fully functional underneath from the start.
function zoomIntoRegion(from) {
  const target = $('#draw-canvas').getBoundingClientRect();
  if (target.width === 0 || from.size === 0) return;

  // Snapshot the region's pixels without the blue selection box.
  renderBoard(false);
  const r = state.region;
  const srcSize = CONFIG.tile * bs;
  const snap = document.createElement('canvas');
  snap.width = snap.height = Math.round(srcSize);
  snap.getContext('2d').drawImage(boardCanvas,
    r.x * bs, (CONFIG.boardH - r.y - CONFIG.tile) * bs, srcSize, srcSize,
    0, 0, snap.width, snap.height);
  renderBoard();

  const ov = document.createElement('div');
  ov.className = 'zoom-overlay';
  ov.style.left = target.left + 'px';
  ov.style.top = target.top + 'px';
  ov.style.width = target.width + 'px';
  ov.style.height = target.height + 'px';
  ov.style.transform = 'translate(' + (from.left - target.left) + 'px,' +
    (from.top - target.top) + 'px) scale(' + (from.size / target.width) + ')';
  ov.appendChild(snap);
  document.body.appendChild(ov);

  // Two rAFs so the start transform is committed before transitioning.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ov.style.transform = 'translate(0px, 0px) scale(1)';
    ov.style.opacity = '0';
  }));
  setTimeout(() => ov.remove(), 900);
}

function enterDraw(demo) {
  state.demo = demo;
  // Zoom only when coming from the board view (not e.g. "start blank
  // instead" inside the draw view), and honor reduced-motion.
  const zoomFrom = $('#view-board').classList.contains('hidden') ||
    matchMedia('(prefers-reduced-motion: reduce)').matches
    ? null : regionScreenRect();
  $('#view-board').classList.add('hidden');
  $('#view-draw').classList.remove('hidden');
  // Anything already plotted where this region sits shows faintly under
  // the new drawing (setStrokes below triggers the render).
  surface.background = regionBackground();
  updateRegionLabel();
  const banner = $('#demo-banner');
  if (demo) {
    surface.readonly = true;
    surface.setStrokes(gcodePolylinesToLocal(demo.native).map(pl => ({
      points: pl,
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
  if (zoomFrom) zoomIntoRegion(zoomFrom);
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

// Round swatch button showing a pen's ink color (used in the toolbar and
// the admin panel).
function makeSwatch(pen, title, onclick) {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.setProperty('--pen', pen.css);
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onclick);
  return b;
}

const swatchHolder = $('#color-swatches');
for (const pen of CONFIG.pens) {
  const b = makeSwatch(pen, pen.label + ' pen', () => {
    surface.color = pen.id;
    swatchHolder.querySelectorAll('.swatch').forEach(x =>
      x.classList.toggle('active', x === b));
  });
  b.classList.toggle('active', pen.id === surface.color);
  swatchHolder.appendChild(b);
}

// A queued job can still die on the machine (e.g. "printer not
// responding") — the POST succeeding only means the upload worked. Watch
// /api/status after each submit and surface the outcome as a toast.
let watchTimer = null;
function watchJob() {
  clearInterval(watchTimer);
  let idlePolls = 0, polls = 0;
  watchTimer = setInterval(async () => {
    let st;
    try {
      st = await api('GET', '/api/status');
    } catch (err) {
      clearInterval(watchTimer); // status unavailable — nothing to report
      return;
    }
    if (st.error) {
      clearInterval(watchTimer);
      toast('⚠️ Plot failed: ' + st.error);
    } else if (st.state === 'idle') {
      // Two consecutive idle polls = job finished (one could be a race
      // with the job not having started yet).
      if (++idlePolls >= 2) {
        clearInterval(watchTimer);
        toast('Plot finished 🖊️');
      }
    } else {
      idlePolls = 0;
    }
    if (++polls > 450) clearInterval(watchTimer); // give up after ~15 min
  }, 2000);
}

$('#btn-submit').addEventListener('click', async () => {
  const btn = $('#btn-submit');
  const name = state.demo ? state.demo.name : 'visitor drawing';
  let gcode, polylines, colors;
  if (state.demo) {
    gcode = demoToGcode(state.demo.text, state.region, state.demo.name);
    polylines = gcodePolylinesToLocal(state.demo.native);
    // demos plot with the default pen (demoToGcode selects it)
    colors = polylines.map(() => CONFIG.pens[0].id);
  } else {
    if (surface.isEmpty()) {
      toast('Draw something first! ✏️');
      return;
    }
    gcode = strokesToGcode(surface.strokes, state.region, name);
    polylines = surface.strokes.map(s => gcSimplify(s.points));
    colors = surface.strokes.map(s => penById(s.color).id);
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
    // ESPAsyncWebServer mistakes text/plain that contains `=` for form data.
    // Generated gcode includes `; region x=…`, so send it as an opaque body.
    await api('POST', '/api/print', gcode, 'application/octet-stream');
    await api('POST', '/api/board', JSON.stringify({
      id: String(Date.now()),
      name,
      x: Math.round(state.region.x * 10) / 10,
      y: Math.round(state.region.y * 10) / 10,
      size: CONFIG.tile,
      polylines: packPolylines(polylines),
      colors,
      ts: Date.now(),
    }), 'application/json');
    toast(copied ? 'Sent to the plotter! 🖊️ (gcode copied to clipboard)'
                 : 'Sent to the plotter! 🖊️');
    watchJob();
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

// Clicking/tapping anywhere outside the open panel dismisses it. The ⚙️
// button is excluded so its own click still toggles rather than reopening.
document.addEventListener('pointerdown', e => {
  const panel = $('#admin-panel');
  if (panel.classList.contains('hidden')) return;
  if (e.target.closest('#admin-panel, #btn-admin')) return;
  panel.classList.add('hidden');
});

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
    await api('POST', '/api/command', gcode, 'application/octet-stream');
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

// Set home = zero here (G92) + turn software endstops on (M211). The
// patched Marlin marks G92'd axes as homed, so from this point the firmware
// clamps moves to the board; M211 S1 re-arms them in case an operator sent
// M211 S0 (the escape hatch for jogging past a stale zero when re-homing).
$('#btn-home').addEventListener('click', () =>
  sendCommand('G92 X0 Y0\nM211 S1\n', 'set home (0,0) + endstops on'));
$('#btn-pen-up').addEventListener('click', () =>
  sendCommand(CONFIG.penUpCmd + '\n', 'pen up'));
$('#btn-pen-down').addEventListener('click', () =>
  sendCommand(CONFIG.penDownCmd + '\n', 'pen down'));
$('#btn-motors-off').addEventListener('click', () =>
  sendCommand('M84\n', 'motors off'));

// Color switching. The pen MUST be up while the carousel rotates or the
// mechanism jams, so every switch lifts first and dwells before rotating.
function penColorCommand(pen) {
  return CONFIG.penUpCmd + '\nG4 P' + CONFIG.colorSettleMs + '\n' +
         pen.cmd + '\n';
}

const adminColors = $('#admin-colors');
for (const pen of CONFIG.pens) {
  adminColors.appendChild(makeSwatch(pen,
    'Switch to ' + pen.label.toLowerCase() + ' (lifts pen first)',
    () => sendCommand(penColorCommand(pen), pen.label.toLowerCase() + ' pen')));
}

// Editable settings: drawing-region (tile) size + pen up/down/color
// gcode. Saved values override config.js via localStorage — see
// applySettingsOverrides().
const cfgRows = $('#machine-settings-rows');
const cfgInputs = {}; // 'tile' | 'penUpCmd' | 'penDownCmd' | pen id -> input
function addCfgRow(key, label, value) {
  const row = document.createElement('div');
  row.className = 'cfg-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  const input = document.createElement('input');
  input.value = value;
  input.spellcheck = false;
  input.autocomplete = 'off';
  row.append(lab, input);
  cfgRows.appendChild(row);
  cfgInputs[key] = input;
}
addCfgRow('tile', 'tile mm', CONFIG.tile);
addCfgRow('penUpCmd', 'pen up', CONFIG.penUpCmd);
addCfgRow('penDownCmd', 'pen down', CONFIG.penDownCmd);
for (const pen of CONFIG.pens) addCfgRow(pen.id, pen.label, pen.cmd);

function fillCfgInputs() {
  cfgInputs.tile.value = CONFIG.tile;
  cfgInputs.penUpCmd.value = CONFIG.penUpCmd;
  cfgInputs.penDownCmd.value = CONFIG.penDownCmd;
  for (const pen of CONFIG.pens) cfgInputs[pen.id].value = pen.cmd;
}

// Region size changed: keep the selection on the board and repaint both
// views (an open drawing keeps its strokes' mm positions).
function tileChanged() {
  state.region = clampRegion(state.region.x, state.region.y);
  renderBoard();
  if ($('#view-draw').classList.contains('hidden')) return;
  updateRegionLabel();
  if (state.demo) {
    enterDraw(state.demo); // rescale a previewed demo
  } else {
    surface.background = regionBackground();
    surface.render();
  }
}

$('#btn-settings-save').addEventListener('click', () => {
  const status = $('#admin-status');
  const tile = parseFloat(cfgInputs.tile.value);
  if (!(tile >= 20 && tile <= maxTile())) {
    status.textContent = '✗ tile size must be 20–' + maxTile() + 'mm';
    return;
  }
  for (const [key, input] of Object.entries(cfgInputs)) {
    if (key !== 'tile' && !input.value.trim()) {
      status.textContent = '✗ settings: empty command';
      return;
    }
  }
  const tileWas = CONFIG.tile;
  CONFIG.tile = tile;
  CONFIG.penUpCmd = cfgInputs.penUpCmd.value.trim();
  CONFIG.penDownCmd = cfgInputs.penDownCmd.value.trim();
  for (const pen of CONFIG.pens) pen.cmd = cfgInputs[pen.id].value.trim();
  fillCfgInputs();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    tile: CONFIG.tile,
    penUpCmd: CONFIG.penUpCmd,
    penDownCmd: CONFIG.penDownCmd,
    penCmds: Object.fromEntries(CONFIG.pens.map(p => [p.id, p.cmd])),
  }));
  if (CONFIG.tile !== tileWas) tileChanged();
  status.textContent = '✓ settings saved';
});

$('#btn-settings-reset').addEventListener('click', () => {
  const tileWas = CONFIG.tile;
  CONFIG.tile = SETTINGS_DEFAULTS.tile;
  CONFIG.penUpCmd = SETTINGS_DEFAULTS.penUpCmd;
  CONFIG.penDownCmd = SETTINGS_DEFAULTS.penDownCmd;
  for (const pen of CONFIG.pens) pen.cmd = SETTINGS_DEFAULTS.penCmds[pen.id];
  localStorage.removeItem(SETTINGS_KEY);
  fillCfgInputs();
  if (CONFIG.tile !== tileWas) tileChanged();
  $('#admin-status').textContent = '✓ settings reset to defaults';
});

const gcodeInput = $('#gcode-input');
function sendCustomGcode() {
  const text = gcodeInput.value.trim();
  if (!text) return;
  sendCommand(text + '\n', text);
}
$('#btn-gcode-send').addEventListener('click', sendCustomGcode);
gcodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendCustomGcode();
});

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
        native: parseGcode(text),
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
    drawPreview(cv, gcodePolylinesToLocal(demo.native));
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
  ctx.strokeStyle = CONFIG.pens[0].css; // demos plot with the default pen
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
