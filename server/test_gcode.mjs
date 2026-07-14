// Headless checks for the browser-side gcode pipeline. Loads the actual
// web/js sources into this scope and exercises conversion end-to-end.
// Run: node server/test_gcode.mjs
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const webJs = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'js');
const src = ['config.js', 'gcode.js']
  .map(f => readFileSync(join(webJs, f), 'utf8'))
  .join('\n');
const g = new Function(`${src}; return {
  CONFIG, strokesToGcode, demoToGcode, parseGcode,
  gcodePolylinesToLocal, gcSimplify, packPolylines, penById,
  boardRecordToLocal,
};`)();

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) console.log(`  ok  ${label}`);
  else { console.error(`FAIL  ${label} ${detail}`); failures++; }
}

const { CONFIG } = g;
// default tile is 100mm: region spans X 400-500, Y 100-200
const region = { x: 400, y: 100 };

// --- strokesToGcode ---
// diagonal from canvas top-left (0,0) to bottom-right (tile,tile),
// plus a horizontal line near the canvas top, plus a single-point dot.
const strokes = [
  { points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] },
  { points: [{ x: 10, y: 5 }, { x: 90, y: 5 }] },
  { points: [{ x: 50, y: 50 }] },
];
const gcode = g.strokesToGcode(strokes, region, 'test');
console.log('--- strokesToGcode output ---');
console.log(gcode);

const moves = [];
for (const line of gcode.split('\n')) {
  const m = line.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)/);
  if (m) moves.push({ g: +m[1], x: +m[2], y: +m[3] });
}

check('header has G21 and G90', gcode.includes('G21') && gcode.includes('G90'));
check('pen up before first travel',
  gcode.indexOf(CONFIG.penUpCmd) < gcode.indexOf('G0 '));
const nonPark = moves.slice(0, -1); // park move goes to machine home (0,0)
check('all coords inside usable area',
  nonPark.every(p => p.x >= CONFIG.margin && p.x <= CONFIG.boardW - CONFIG.margin &&
                     p.y >= CONFIG.margin && p.y <= CONFIG.boardH - CONFIG.margin),
  JSON.stringify(nonPark));
// canvas (0,0) = tile top-left -> board (400, 200); canvas (100,100) -> (500, 100)
check('y-axis flipped + region offset (start of diagonal)',
  nonPark[0].x === 400 && nonPark[0].y === 200, JSON.stringify(nonPark[0]));
check('y-axis flipped + region offset (end of diagonal)',
  nonPark[1].x === 500 && nonPark[1].y === 100, JSON.stringify(nonPark[1]));
// horizontal line at canvas y=5 -> board y = 100 + 95 = 195
check('second stroke at correct height',
  nonPark[2].y === 195 && nonPark[3].y === 195, JSON.stringify(nonPark.slice(2, 4)));
const penDowns = gcode.split('\n').filter(l => l.startsWith(CONFIG.penDownCmd)).length;
check('one pen-down per stroke incl. dot', penDowns === 3, `got ${penDowns}`);
check('ends parked', gcode.trimEnd().endsWith('; park'));

// --- pen colors ---
// Scan a gcode text and assert the color-switch safety invariant: every
// carousel command (M280 P1 …) happens with the pen up.
function colorSwitchAudit(text) {
  let penDown = false, switchesWhileDown = 0;
  const colorCmds = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(CONFIG.penDownCmd)) penDown = true;
    else if (line.startsWith(CONFIG.penUpCmd)) penDown = false;
    else if (/^M280\s+P1\b/i.test(line)) {
      colorCmds.push(line.split(';')[0].trim());
      if (penDown) switchesWhileDown++;
    }
  }
  return { colorCmds, switchesWhileDown };
}

check('strokes default to the first pen (no color set)',
  colorSwitchAudit(gcode).colorCmds.join() === g.penById(undefined).cmd,
  JSON.stringify(colorSwitchAudit(gcode).colorCmds));

const colored = g.strokesToGcode([
  { points: [{ x: 10, y: 10 }, { x: 20, y: 10 }], color: 'red' },
  { points: [{ x: 10, y: 30 }, { x: 20, y: 30 }], color: 'blue' },
  { points: [{ x: 10, y: 50 }, { x: 20, y: 50 }], color: 'red' },
], region, 'colors');
const audit = colorSwitchAudit(colored);
check('color groups in first-appearance order, one switch per color',
  audit.colorCmds.join('|') ===
    g.penById('red').cmd + '|' + g.penById('blue').cmd,
  JSON.stringify(audit.colorCmds));
check('pen is up at every color switch', audit.switchesWhileDown === 0);
// red group = strokes 1 and 3 back to back: both red strokes plot between
// the red switch and the blue switch (y 10 and 50 -> board 190 and 150).
const blueSwitchAt = colored.indexOf(g.penById('blue').cmd);
const redYs = [...colored.slice(0, blueSwitchAt).matchAll(/^G0 X[\d.]+ Y([\d.]+)/gm)]
  .map(m => +m[1]);
check('same-color strokes are grouped', redYs.join() === '190,150',
  JSON.stringify(redYs));
check('grouping preserves every stroke', // 3 stroke travels + park
  (colored.match(/^G0 X/gm) || []).length === 4);

const demoAudit = colorSwitchAudit(
  g.demoToGcode('G0 X10 Y10\nG1 X20 Y20\n', region, 'd'));
check('demo selects the default pen, pen up',
  demoAudit.colorCmds.join() === CONFIG.pens[0].cmd &&
    demoAudit.switchesWhileDown === 0,
  JSON.stringify(demoAudit));

// --- board record -> local frame (faint underlay in the draw view) ---
const rec = {
  x: 300, y: 200, size: 100,
  polylines: [[[0, 0], [100, 100]]], // tile top-left -> bottom-right
  colors: ['red'],
};
const same = g.boardRecordToLocal(rec, { x: 300, y: 200 });
check('record in its own region maps to identity',
  same[0].points[0].x === 0 && same[0].points[0].y === 0 &&
    same[0].points[1].x === 100 && same[0].points[1].y === 100 &&
    same[0].color === 'red',
  JSON.stringify(same));
// region 50mm left/below the record: the record sits 50 right and 50 up,
// so its top-left lands at x=50 and ABOVE the visible tile (y=-50).
const shifted = g.boardRecordToLocal(rec, { x: 250, y: 150 });
check('record offset into an overlapping region',
  shifted[0].points[0].x === 50 && shifted[0].points[0].y === -50,
  JSON.stringify(shifted[0].points[0]));
check('pre-color record maps with null color',
  g.boardRecordToLocal({ ...rec, colors: undefined },
    { x: 300, y: 200 })[0].color === null);

// --- simplification ---
const noisy = { points: [] };
for (let i = 0; i <= 300; i++) noisy.points.push({ x: i / 2, y: 50 + Math.sin(i) * 0.05 });
const simplified = g.gcSimplify(noisy.points);
check('simplification collapses near-straight line to few points',
  simplified.length <= 5, `got ${simplified.length}`);

// --- demo parsing + offsetting ---
const demoText = readFileSync(join(webJs, '..', 'demos', 'star.gcode'), 'utf8');
const parsed = g.parseGcode(demoText);
check('star parses to 1 polyline of 11 points',
  parsed.length === 1 && parsed[0].length === 11,
  `got ${parsed.length} / ${parsed[0] && parsed[0].length}`);
check('star coords within authored demo tile',
  parsed.flat().every(p => p.x >= 0 && p.x <= CONFIG.demoSize &&
                           p.y >= 0 && p.y <= CONFIG.demoSize));

const demoGcode = g.demoToGcode(demoText, region, 'Star');
const demoMoves = [];
for (const line of demoGcode.split('\n')) {
  const m = line.match(/^G([01]) X(-?[\d.]+) Y(-?[\d.]+)/);
  if (m) demoMoves.push({ x: +m[2], y: +m[3] });
}
// star's first point is (75, 135) on the authored 150 tile; scaled by
// 100/150 -> (50, 90), offset to the region -> (450, 190) on the board
check('demo scaled + offset applied',
  demoMoves[0].x === 450 && demoMoves[0].y === 190,
  JSON.stringify(demoMoves[0]));
check('demo moves stay inside the region',
  demoMoves.slice(0, -1).every(p =>
    p.x >= region.x && p.x <= region.x + CONFIG.tile &&
    p.y >= region.y && p.y <= region.y + CONFIG.tile));
check('demo body pen commands preserved',
  demoGcode.split(CONFIG.penDownCmd).length - 1 === 1);
const local = g.gcodePolylinesToLocal(parsed);
// (75, 135) y-up on the 150 tile -> scaled (50, 90) -> y-down (50, 10)
check('demo local conversion scales + flips y',
  local[0][0].x === 50 && local[0][0].y === 10, JSON.stringify(local[0][0]));

// --- all three demos parse and stay in bounds ---
for (const f of ['star.gcode', 'smiley.gcode', 'opensauce.gcode']) {
  const t = readFileSync(join(webJs, '..', 'demos', f), 'utf8');
  const pls = g.parseGcode(t);
  check(`${f}: parses (${pls.length} polylines) and within authored tile`,
    pls.length > 0 &&
    pls.flat().every(p => p.x >= 0 && p.x <= CONFIG.demoSize &&
                          p.y >= 0 && p.y <= CONFIG.demoSize));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
