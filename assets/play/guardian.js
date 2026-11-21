// VERAQIS Play — Vera: Archive Guardian.
// A top-down action game: walk Vera through an archive, take only data you can prove, scan the
// unproven, and stop the creatures that stand for real archive threats. The archives are simulated;
// the rules are the ones on /security.html and in the evidence model.
import { Game, h, hud, loop, toast, shake, makeRng, fmtInt, reducedMotion, touchFirst } from './core.js';
import { LEVELS, ENDLESS, randomMap } from './guardian-levels.js';
import { drawVera, drawSlipper, drawRot, drawBomblet, drawLinker, drawHydra, drawPortal, drawBlock, drawVault, drawHole, drawCharacter, rr } from './characters.js';

const DIRS = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
const SPEED = { vera: 5.0, slipper: 2.2, rot: 1.9, linker: 2.3, hydra: 1.45, hydra2: 1.85 };
const SCAN_RADIUS = 3.2;
const SCAN_MAX = 3;
const SCAN_REGEN = 4.5;
const ZAP_RANGE = 7;
const ZAP_COOLDOWN = 0.42;
const BOMB_GROW = 9;      // ×10 → ×100 → ×1,000 over this many seconds
const BOMB_FUSE = 1.6;    // then ×∞ flashes for this long and bursts
const JUNK_TIME = 6;      // a burst floods the floor around it for this long
const ESCAPE_TIME = 2.2;  // a Slipper needs this long to squeeze through a "../" hole
const CHEW_TIME = 1.5;    // a Rot beetle needs this long to corrupt a block
const PORTAL_LIFE = 14;
const BOLT_SPEED = 4.6;    // the Hydra's overlap bolts, tiles per second (Vera can outrun one)
const FREEZE = 2.0;       // creatures wait while the level banner shows
const LIMIT = 240;        // hard session limit per level, seconds
const k = (x, y) => `${x},${y}`;
const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y;
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const OUCH = ['Ouch!', 'Shield down!', 'Hey!'];

function enemy(type, x, y, extra = {}) {
  return { type, x, y, tx: x, ty: y, dir: null, look: { x: 0, y: 1 }, alive: true, t: Math.random() * 10, moving: false, ...extra };
}
function buildWorld(def, rng, wave) {
  const map = def.endless ? randomMap(rng, wave) : def.map;
  const H = map.length;
  const W = map[0].length;
  const w = { W, H, tiles: [], items: new Map(), enemies: [], bolts: [], holes: [], junk: new Map(), portals: [], chainNext: 1, chainMax: 0, start: null, vault: null, vaultOpen: false, boss: null };
  let bombIndex = 0;
  const stagger = def.bombStagger || 3;
  for (let y = 0; y < H; y++) {
    const row = [];
    for (let x = 0; x < W; x++) {
      const ch = map[y][x];
      row.push(ch === '#' ? 'wall' : ch === 'H' ? 'hole' : ch === 'V' ? 'vault' : 'floor');
      if (ch === 'P') w.start = { x, y };
      else if (ch === 'V') w.vault = { x, y };
      else if (ch === 'H') w.holes.push({ x, y });
      else if (ch === 'g') w.items.set(k(x, y), { x, y, kind: 'g' });
      else if (ch === '?') w.items.set(k(x, y), { x, y, kind: 'q', hidden: rng.chance(def.pGreen) ? 'g' : 'r' });
      else if (ch === 'r') w.items.set(k(x, y), { x, y, kind: 'r' });
      else if (/[1-9]/.test(ch)) { w.items.set(k(x, y), { x, y, kind: 'c', n: Number(ch), red: false }); w.chainMax = Math.max(w.chainMax, Number(ch)); }
      else if (ch === 'S') w.enemies.push(enemy('slipper', x, y));
      else if (ch === 'R') w.enemies.push(enemy('rot', x, y));
      else if (ch === 'L') w.enemies.push(enemy('linker', x, y, { portalT: 0 }));
      else if (ch === 'B') w.enemies.push(enemy('bomblet', x, y, { age: -(bombIndex++ * stagger) }));
      else if (ch === 'X') {
        const hp = def.boss ? def.boss.hp : 14;
        w.boss = enemy('hydra', x, y, { hp, max: hp, inv: 0, spawnT: 0 });
        w.enemies.push(w.boss);
      }
    }
    w.tiles.push(row);
  }
  return w;
}

function play(api) {
  const { fx, sfx } = api;
  const def = api.level;
  const endless = api.endless;
  const r = makeRng(api.seed);
  const motion = !reducedMotion();
  const debug = (() => { try { return new URLSearchParams(window.location.search).has('debug'); } catch { return false; } })();
  const speed = debug ? (() => { try { return Math.min(4, Math.max(0.25, Number(new URLSearchParams(window.location.search).get('speed')) || 1)); } catch { return 1; } })() : 1;
  const st = { score: 0, shields: 3, shieldsLost: 0, guesses: 0, time: 0, collected: 0, zapped: 0, shots: 0, wave: 1, escaped: 0, corrupted: 0, over: false };
  let w = null;
  let p = null;
  let paused = false;
  let freeze = 0;
  let banner = null;
  let bubble = null;
  let beam = null;
  let scanRing = null;
  let zapCd = 0;
  let scanCharges = SCAN_MAX;
  let particles = [];
  let texts = [];
  let wavesT = 0;
  let wavesLeft = 0;
  let teleCd = 0;
  let shownSec = -1;
  let shownCd = '';
  const hintsShown = new Set();

  // ---------- DOM ----------
  const scanEl = h('span', { class: 'gd-charges' }, '◉◉◉');
  const bar = hud(api.area, [
    ['lv', endless ? 'Wave' : 'Level', endless ? '1' : String(api.index + 1)],
    ['shields', 'Shields', '◆◆◆'],
    ['data', 'Proven data', '0/0'],
    ['scan', 'Scan', scanEl],
    ['score', 'Score', '0'],
    ['time', 'Time', '0:00'],
  ], () => api.quit());
  const canvas = h('canvas', { class: 'gd-canvas', role: 'img', 'aria-label': 'Archive map: Vera, data blocks and creatures' });
  const ctx = canvas.getContext('2d');
  const pauseIc = h('span', { class: 'gd-pause-ic', 'aria-hidden': 'true' }, '❚❚');
  const pauseTxt = h('span', { class: 'gd-pause-t' }, 'Pause');
  const pauseBtn = h('button', { class: 'g-btn g-btn--ghost gd-pause', type: 'button', 'aria-label': 'Pause', title: 'Pause (P)' }, pauseIc, pauseTxt, h('span', { class: 'g-key' }, 'P'));
  pauseBtn.addEventListener('click', () => { togglePause(); api.stage.focus({ preventScroll: true }); });
  // touch controls: a thumb stick on the left, fire and scan on the right
  const arrows = [['u', '▲'], ['r', '▶'], ['d', '▼'], ['l', '◀']].map(([c, t]) => h('i', { class: 'gd-arr gd-arr--' + c }, t));
  const knob = h('div', { class: 'gd-knob' });
  const base = h('div', { class: 'gd-base' }, arrows, knob);
  const stickZone = h('div', { class: 'gd-stick-zone', 'aria-hidden': 'true' }, base, h('span', { class: 'gd-zone-hint' }, 'drag to move'));
  const dots = [0, 1, 2].map(() => h('i', { class: 'gd-dot' }));
  const zapBtn = h('button', { class: 'gd-act gd-act--zap', type: 'button', 'aria-label': 'Zap — hold to keep firing' },
    h('span', { class: 'gd-act-ic', 'aria-hidden': 'true' }, '⚡'), h('span', null, 'ZAP'));
  const scanBtn = h('button', { class: 'gd-act gd-act--scan', type: 'button', 'aria-label': 'Scan' },
    h('span', { class: 'gd-act-ic', 'aria-hidden': 'true' }, '◎'), h('span', null, 'SCAN'), h('span', { class: 'gd-dots', 'aria-hidden': 'true' }, dots));
  const actZone = h('div', { class: 'gd-act-zone' }, scanBtn, zapBtn);
  const tips = h('p', { class: 'gd-tips' },
    h('span', { class: 'g-key' }, '←↑↓→'), ' or ', h('span', { class: 'g-key' }, 'WASD'), ' move · ',
    h('span', { class: 'g-key' }, 'Space'), ' zap (hold to keep firing) · ', h('span', { class: 'g-key' }, 'E'), ' scan · ',
    h('span', { class: 'g-key' }, 'F'), ' full screen · click a tile to walk there · gamepad works too');
  const wrap = h('div', { class: 'gd-wrap' }, canvas);
  const body = h('div', { class: 'gd-body' }, stickZone, wrap, actZone);
  bar.el.querySelector('.hud-quit')?.prepend(pauseBtn);
  api.area.classList.add('gd-area');
  api.stage.classList.add('stage--gd');
  api.area.append(body, tips);

  // ---------- input ----------
  const held = [];
  const KEYDIR = { ArrowUp: 0, w: 0, W: 0, ArrowRight: 1, d: 1, D: 1, ArrowDown: 2, s: 2, S: 2, ArrowLeft: 3, a: 3, A: 3 };
  const ZAPKEYS = new Set([' ', 'j', 'J', 'z', 'Z']);
  const SCANKEYS = new Set(['e', 'E', 'k', 'K', 'x', 'X']);
  let stickDirs = [];   // thumb stick: [main direction, second direction for cornering]
  let padDirs = [];     // gamepad, the same way
  let tapDir = null;    // a short tap or flick still moves one tile
  let path = null;      // a route from clicking or tapping a tile
  let zapKey = false;
  let zapTouch = false;
  let zapPad = false;
  let touchUI = touchFirst();
  // What the player is asking for, most wanted first.
  function wantedDirs() {
    if (stickDirs.length) return stickDirs;
    if (padDirs.length) return padDirs;
    if (held.length) return held.slice().reverse().map((i) => DIRS[i]);
    return [];
  }
  const anyHeld = () => stickDirs.length > 0 || padDirs.length > 0 || held.length > 0;
  function onDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const isGameKey = e.key in KEYDIR || ZAPKEYS.has(e.key) || SCANKEYS.has(e.key) || e.key === 'p' || e.key === 'P';
    if (!isGameKey) return;
    e.preventDefault();
    // Space would also press whichever button has focus; keep focus on the stage while playing.
    const ae = document.activeElement;
    if (ae && ae !== api.stage && api.stage.contains(ae)) api.stage.focus({ preventScroll: true });
    if (e.key in KEYDIR) {
      const d = KEYDIR[e.key];
      if (!held.includes(d)) held.push(d);
      if (!e.repeat) tapDir = d;
      path = null;
    } else if (ZAPKEYS.has(e.key)) { if (!e.repeat) { zapKey = true; zap(); } }
    else if (SCANKEYS.has(e.key)) { if (!e.repeat) scan(); }
    else if (!e.repeat) togglePause();
  }
  function onUp(e) {
    if (e.key in KEYDIR) { const i = held.indexOf(KEYDIR[e.key]); if (i >= 0) held.splice(i, 1); }
    if (ZAPKEYS.has(e.key)) zapKey = false;
  }
  document.addEventListener('keydown', onDown);
  document.addEventListener('keyup', onUp);
  const blurClear = () => { held.length = 0; restStick(); zapKey = false; zapTouch = false; };
  window.addEventListener('blur', blurClear);
  const visPause = () => { if (document.hidden && !paused && !st.over) togglePause(); };
  document.addEventListener('visibilitychange', visPause);

  // Thumb stick: it appears under the thumb, and sliding the thumb turns Vera without lifting it.
  const STICK_R = 44;
  const DEAD = 11;
  let stickId = null;
  function restStick() {
    stickId = null;
    stickDirs = [];
    base.classList.remove('on');
    base.removeAttribute('data-dir');
    base.style.left = '';
    base.style.top = '';
    knob.style.transform = '';
  }
  function stickMove(e) {
    const r0 = base.getBoundingClientRect();
    const dx = e.clientX - (r0.left + r0.width / 2);
    const dy = e.clientY - (r0.top + r0.height / 2);
    const dist = Math.hypot(dx, dy);
    const kk = dist > STICK_R ? STICK_R / dist : 1;
    knob.style.transform = `translate(${(dx * kk).toFixed(1)}px, ${(dy * kk).toFixed(1)}px)`;
    if (dist < DEAD) { stickDirs = []; base.removeAttribute('data-dir'); return; }
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const cur = stickDirs[0];
    const horiz = cur ? (cur.x ? ax * 1.3 >= ay : ax > ay * 1.3) : ax >= ay; // no flicker on a diagonal
    const hDir = dx > 0 ? 1 : 3;
    const vDir = dy > 0 ? 2 : 0;
    const main = horiz ? hDir : vDir;
    const dirs = [DIRS[main]];
    if ((horiz ? ay : ax) > (horiz ? ax : ay) * 0.45) dirs.push(DIRS[horiz ? vDir : hDir]);
    if (stickDirs[0] !== DIRS[main]) { tapDir = main; path = null; }
    stickDirs = dirs;
    base.setAttribute('data-dir', ['up', 'right', 'down', 'left'][main]);
  }
  stickZone.addEventListener('pointerdown', (e) => {
    if (stickId != null) return;
    e.preventDefault();
    stickId = e.pointerId;
    try { stickZone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const zr = stickZone.getBoundingClientRect();
    const half = base.offsetWidth / 2 || 62;
    const x = Math.min(zr.width - half, Math.max(half, e.clientX - zr.left));
    const y = Math.min(zr.height - half, Math.max(half, e.clientY - zr.top));
    base.style.left = `${Math.round(x)}px`;
    base.style.top = `${Math.round(y)}px`;
    base.classList.add('on');
    stickMove(e);
  });
  stickZone.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) stickMove(e); });
  const stickEnd = (e) => { if (e.pointerId === stickId) restStick(); };
  stickZone.addEventListener('pointerup', stickEnd);
  stickZone.addEventListener('pointercancel', stickEnd);
  stickZone.addEventListener('lostpointercapture', stickEnd);
  // Fire: hold to keep firing. Scan: one tap, one scan.
  zapBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    zapTouch = true;
    zapBtn.classList.add('on');
    zap();
    try { zapBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  const zapEnd = () => { zapTouch = false; zapBtn.classList.remove('on'); };
  zapBtn.addEventListener('pointerup', zapEnd);
  zapBtn.addEventListener('pointercancel', zapEnd);
  zapBtn.addEventListener('lostpointercapture', zapEnd);
  scanBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    scanBtn.classList.add('on');
    scan();
    window.setTimeout(() => scanBtn.classList.remove('on'), 140);
  });
  for (const el of [stickZone, zapBtn, scanBtn, canvas]) el.addEventListener('contextmenu', (e) => e.preventDefault());
  // The first touch on the stage switches the touch controls on (a touchscreen laptop, say).
  const onAnyPointer = (e) => { if (e.pointerType === 'touch' && !touchUI) { touchUI = true; relayout(); } };
  api.stage.addEventListener('pointerdown', onAnyPointer, true);
  // Click or tap a tile and Vera walks there by the shortest open route.
  canvas.addEventListener('pointerdown', (e) => {
    if (!w || paused || st.over) return;
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor(((e.clientX - rect.left) / rect.width) * w.W);
    const ty = Math.floor(((e.clientY - rect.top) / rect.height) * w.H);
    const from = { x: Math.round(p.tx), y: Math.round(p.ty) };
    if (tx === from.x && ty === from.y) { path = null; return; }
    const route = bfs(from, (x, y) => x === tx && y === ty, 'vera', true);
    if (route && route.length) {
      path = route; held.length = 0;
      addText(tx + 0.5, ty + 0.5, '◇', '94,231,255', 0.5);
    } else addText(tx + 0.5, ty + 0.5, '✕', '255,95,109', 0.5);
  });

  // Gamepad: stick or d-pad moves; A zaps (hold to keep firing); X or B scans; Start pauses.
  const gpPrev = {};
  function pollGamepad() {
    let gp = null;
    try { gp = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(Boolean) || null; } catch { gp = null; }
    if (!gp) { padDirs = []; zapPad = false; return; }
    const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    let ax = gp.axes[0] || 0;
    let ay = gp.axes[1] || 0;
    if (b(14)) ax = -1;
    if (b(15)) ax = 1;
    if (b(12)) ay = -1;
    if (b(13)) ay = 1;
    const dirs = [];
    if (Math.max(Math.abs(ax), Math.abs(ay)) > 0.45) {
      const horiz = Math.abs(ax) >= Math.abs(ay);
      const hDir = ax > 0 ? 1 : 3;
      const vDir = ay > 0 ? 2 : 0;
      dirs.push(DIRS[horiz ? hDir : vDir]);
      if (Math.min(Math.abs(ax), Math.abs(ay)) > 0.45) dirs.push(DIRS[horiz ? vDir : hDir]);
    }
    if (dirs.length) { path = null; if (padDirs[0] !== dirs[0]) tapDir = DIRS.indexOf(dirs[0]); }
    padDirs = dirs;
    zapPad = b(0);
    const edge = (i, fn) => { const now = b(i); if (now && !gpPrev[i]) fn(); gpPrev[i] = now; };
    edge(0, zap); edge(1, scan); edge(2, scan); edge(9, togglePause);
  }

  // ---------- geometry ----------
  const bombAt = (x, y) => w.enemies.some((e) => e.alive && e.type === 'bomblet' && e.x === x && e.y === y);
  function passable(x, y, who) {
    if (x < 0 || y < 0 || x >= w.W || y >= w.H) return false;
    const t = w.tiles[y][x];
    if (t === 'wall') return false;
    if (w.junk.has(k(x, y))) return false;
    if (t === 'hole') return who === 'slipper';
    if (t === 'vault') return who === 'vera' && w.vaultOpen;
    if (bombAt(x, y)) return false;
    return true;
  }
  // Breadth-first search: the first step toward the nearest goal tile, or the whole route.
  function bfs(from, goal, who, fullPath = false) {
    const seen = new Set([k(from.x, from.y)]);
    const prev = new Map();
    const q = [from];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      if (qi > 0 && goal(c.x, c.y)) {
        const steps = [];
        let cur = c;
        while (!(cur.x === from.x && cur.y === from.y)) { steps.push(cur); cur = prev.get(k(cur.x, cur.y)); }
        steps.reverse();
        return fullPath ? steps : { x: steps[0].x - from.x, y: steps[0].y - from.y };
      }
      for (const d of DIRS) {
        const nx = c.x + d.x;
        const ny = c.y + d.y;
        const key = k(nx, ny);
        if (seen.has(key) || !passable(nx, ny, who)) continue;
        seen.add(key); prev.set(key, c); q.push({ x: nx, y: ny });
      }
    }
    return null;
  }
  function randomStep(e, who) {
    const opts = DIRS.filter((d) => passable(e.x + d.x, e.y + d.y, who) && w.tiles[e.y + d.y][e.x + d.x] !== 'hole');
    if (!opts.length) return null;
    const fwd = opts.filter((d) => !(e.dir && d.x === -e.dir.x && d.y === -e.dir.y));
    return r.pick(fwd.length ? fwd : opts);
  }
  // Grid movement: travel between tile centres and choose the next tile at each centre.
  function advance(e, speed, dt, choose, arrive) {
    let left = speed * dt;
    let guard = 0;
    while (left > 1e-6 && guard++ < 6) {
      const dist = Math.abs(e.tx - e.x) + Math.abs(e.ty - e.y);
      if (dist < 1e-6) {
        e.x = e.tx; e.y = e.ty;
        const d = choose(e);
        if (!d) { e.moving = false; e.dir = null; return; }
        e.dir = d; e.look = d; e.tx = e.x + d.x; e.ty = e.y + d.y; e.moving = true;
        if (d.x) e.face = d.x;
        continue;
      }
      const step = Math.min(left, dist);
      e.x += Math.sign(e.tx - e.x) * step;
      e.y += Math.sign(e.ty - e.y) * step;
      left -= step;
      if (step >= dist - 1e-9) {
        e.x = e.tx; e.y = e.ty;
        arrive(e);
        if (!e.alive || st.over || e.hold) { e.moving = false; return; }
      }
    }
  }
  // A straight, open line from creature a to Vera (for the Hydra's bolts), or null.
  function lineTo(a, b, maxLen = 10) {
    const ax = Math.round(a.x); const ay = Math.round(a.y);
    const bx = Math.round(b.x); const by = Math.round(b.y);
    if ((ax !== bx && ay !== by) || (ax === bx && ay === by)) return null;
    const dx = Math.sign(bx - ax); const dy = Math.sign(by - ay);
    const n = Math.abs(bx - ax) + Math.abs(by - ay);
    if (n > maxLen) return null;
    for (let i = 1; i < n; i++) {
      const x = ax + dx * i; const y = ay + dy * i;
      if (w.tiles[y][x] === 'wall' || (w.tiles[y][x] === 'vault' && !w.vaultOpen) || w.junk.has(k(x, y))) return null;
    }
    return { x: dx, y: dy };
  }
  function freeTiles(minFromVera = 0, maxFromVera = 99) {
    const out = [];
    const vx = Math.round(p.x);
    const vy = Math.round(p.y);
    for (let y = 1; y < w.H - 1; y++) {
      for (let x = 1; x < w.W - 1; x++) {
        if (w.tiles[y][x] !== 'floor' || w.items.has(k(x, y)) || w.junk.has(k(x, y))) continue;
        if (w.enemies.some((e) => e.alive && (same({ x: Math.round(e.x), y: Math.round(e.y) }, { x, y }) || same({ x: e.tx, y: e.ty }, { x, y })))) continue;
        if (w.portals.some((pp) => same(pp.a, { x, y }) || same(pp.b, { x, y }))) continue;
        const d = Math.abs(x - vx) + Math.abs(y - vy);
        if (d >= minFromVera && d <= maxFromVera) out.push({ x, y });
      }
    }
    return out;
  }

  // ---------- data ----------
  const provable = (it) => !!it && (it.kind === 'g' || (it.kind === 'q' && it.hidden === 'g') || (it.kind === 'c' && !it.red));
  function remaining() {
    let n = 0;
    for (const it of w.items.values()) if (provable(it)) n++;
    return n;
  }
  function updateVault() {
    const open = remaining() === 0 && (!w.boss || !w.boss.alive);
    if (open && !w.vaultOpen) {
      w.vaultOpen = true;
      banner = { text: 'VAULT OPEN', sub: 'walk in', t: 0, color: '61,220,151' };
      sfx.win();
      burstTile(w.vault.x, w.vault.y, '61,220,151', 40, 4);
      say('Vault’s open — let’s go!');
      api.say('The vault is open.');
    }
    bar.set('data', `${st.collected}/${st.collected + remaining()}`, open ? 'good' : '');
  }
  function corrupt(it) {
    if (it.kind === 'g' || it.kind === 'q') it.kind = 'r';
    else if (it.kind === 'c' && !it.red) {
      for (const c of w.items.values()) if (c.kind === 'c' && c.n >= it.n) { c.red = true; burstTile(c.x, c.y, '255,95,109', 8, 2); }
      say('The chain broke!');
      hint('chainbreak', `Chain broken at ${it.n}: block ${it.n} and every block after it can no longer be decoded. Only the prefix is recoverable.`);
    } else return false;
    st.corrupted++;
    burstTile(it.x, it.y, '255,95,109', 18, 2.6);
    updateVault();
    return true;
  }

  // ---------- effects ----------
  function burstTile(x, y, color, n = 24, spd = 3.2) {
    const cnt = motion ? n : Math.min(6, n);
    for (let i = 0; i < cnt; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = spd * (0.3 + Math.random() * 0.8);
      particles.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.4 + Math.random() * 0.5, color, size: 0.05 + Math.random() * 0.07 });
    }
  }
  function addText(x, y, text, color, life = 0.9) { texts.push({ x, y, text, color, t: 0, life }); }
  function say(text, life = 1.9) { bubble = { text, t: 0, life }; }
  function hint(id, text) {
    if (hintsShown.has(id)) return;
    hintsShown.add(id);
    toast(api.toasts, text, 'info', 3800);
  }
  // A point on the stage (for the shared FX layer), from tile coordinates.
  function stagePt(x, y) {
    const sr = api.stage.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    return { x: cr.left - sr.left + (x + 0.5) * (cr.width / w.W), y: cr.top - sr.top + (y + 0.5) * (cr.height / w.H) };
  }
  const paintShields = () => bar.set('shields', '◆'.repeat(Math.max(0, st.shields)) + '◇'.repeat(3 - Math.max(0, st.shields)), st.shields <= 1 ? 'bad' : '');
  const paintScan = () => {
    const full = Math.floor(scanCharges);
    scanEl.textContent = '◉'.repeat(full) + '◯'.repeat(SCAN_MAX - full);
    dots.forEach((d, i) => d.classList.toggle('on', i < full));
  };
  const buzz = (pattern) => { try { if (touchUI && navigator.vibrate) navigator.vibrate(pattern); } catch { /* ignore */ } };

  // ---------- actions ----------
  // Where a beam in direction d stops, and the first creature on that line.
  function beamLine(d, ox, oy) {
    let end = { x: ox, y: oy };
    for (let i = 0; i <= ZAP_RANGE; i++) {
      const x = ox + d.x * i;
      const y = oy + d.y * i;
      if (i > 0 && (x < 0 || y < 0 || x >= w.W || y >= w.H || w.tiles[y][x] === 'wall' || (w.tiles[y][x] === 'vault' && !w.vaultOpen) || w.junk.has(k(x, y)))) break;
      end = { x, y };
      let hit = null;
      let best = Infinity;
      for (const e of w.enemies) {
        const reach = e.type === 'hydra' ? 0.95 : 0.62;
        if (!e.alive || Math.abs(e.x - x) >= reach || Math.abs(e.y - y) >= reach) continue;
        const dd = Math.abs(e.x - p.x) + Math.abs(e.y - p.y);
        if (dd < best) { best = dd; hit = e; }
      }
      if (hit) return { hit, end, i };
    }
    return { hit: null, end, i: Infinity };
  }
  function zap() {
    if (!w || paused || st.over || zapCd > 0) return;
    zapCd = ZAP_COOLDOWN;
    st.shots++;
    p.zapT = 0.18;
    const ox = Math.round(p.x);
    const oy = Math.round(p.y);
    // Aim the way Vera faces if a creature is on that line; otherwise at the nearest creature on any straight line.
    let d = p.look || { x: p.face || 1, y: 0 };
    let line = beamLine(d, ox, oy);
    if (!line.hit) {
      for (const d2 of DIRS) {
        if (d2.x === d.x && d2.y === d.y) continue;
        const l2 = beamLine(d2, ox, oy);
        if (l2.hit && (!line.hit || l2.i < line.i)) { line = l2; d = d2; }
      }
    }
    p.look = d;
    if (d.x) p.face = d.x;
    const { hit, end } = line;
    beam = { x1: p.x + 0.5 + d.x * 0.3, y1: p.y + 0.5 + d.y * 0.3, x2: (hit ? hit.x : end.x + d.x * 0.45) + 0.5, y2: (hit ? hit.y : end.y + d.y * 0.45) + 0.5, t: 0.16 };
    sfx.zap();
    if (hit) onHit(hit);
  }
  function onHit(e) {
    if (e.type === 'hydra') {
      if (e.inv > 0) return;
      e.hp--; e.inv = 0.2; e.hurt = 0.15;
      st.score += 40;
      burstTile(e.x, e.y, '233,221,255', 14, 3);
      sfx.tone(240 + e.hp * 14, 0.12, 'square', 0.06);
      if (e.hp === Math.floor(e.max / 2)) { say('It’s angry now — keep moving!'); banner = { text: 'PHASE 2', sub: 'faster, and it spawns Rot', t: 0, color: '255,95,109' }; }
      if (e.hp <= 0) {
        e.alive = false; st.score += 1000; st.zapped++;
        burstTile(e.x, e.y, '167,139,250', 90, 6); burstTile(e.x, e.y, '255,209,102', 60, 5);
        fx.flash('255,255,255', 0.35); fx.ring(stagePt(e.x, e.y), '255,209,102', 260); sfx.boom(); shake(api.view, true);
        banner = { text: 'HYDRA DOWN', sub: 'one set of bytes, no more heads', t: 0, color: '255,209,102' };
        say('Heads off!');
        buzz([30, 40, 90]);
        for (const o of w.enemies) if (o.alive && o !== e) { o.alive = false; burstTile(o.x, o.y, '167,139,250', 16, 3); }
        for (const b of w.bolts) burstTile(b.x, b.y, '167,139,250', 10, 2);
        w.bolts = [];
        updateVault();
      }
      bar.set('score', fmtInt(st.score), 'bump');
      return;
    }
    e.alive = false;
    st.zapped++;
    const pts = e.type === 'bomblet' ? 80 : 100;
    st.score += pts;
    addText(e.x + 0.5, e.y + 0.2, `+${pts}`, '61,220,151');
    const color = { slipper: '61,220,151', rot: '255,95,109', bomblet: '255,209,102', linker: '255,209,102' }[e.type];
    burstTile(e.x, e.y, color, 30, 4);
    fx.ring(stagePt(e.x, e.y), color, 70);
    if (e.type === 'bomblet') addText(e.x + 0.5, e.y - 0.25, 'DEFUSED', '255,209,102', 1.1);
    if (e.type === 'slipper' && e.escapeT != null) { addText(e.x + 0.5, e.y - 0.25, 'CAUGHT', '61,220,151', 1.1); say('Not today!'); }
    if (e.type === 'rot' && e.chew != null) { addText(e.x + 0.5, e.y - 0.25, 'SAVED', '61,220,151', 1.1); }
    if (e.type === 'linker') {
      const before = w.portals.length;
      w.portals = w.portals.filter((pp) => pp.owner !== e);
      if (before !== w.portals.length) addText(e.x + 0.5, e.y - 0.25, 'LINKS CLOSED', '255,209,102', 1.1);
    }
    sfx.good(2);
    bar.set('score', fmtInt(st.score), 'bump');
  }
  function scan() {
    if (!w || paused || st.over) return;
    if (scanCharges < 1) { addText(p.x + 0.5, p.y - 0.3, 'recharging…', '94,231,255', 0.8); sfx.tick(); return; }
    scanCharges -= 1;
    scanRing = { x: p.x + 0.5, y: p.y + 0.5, t: 0 };
    let n = 0;
    let bad = 0;
    for (const it of w.items.values()) {
      if (it.kind === 'q' && Math.hypot(it.x - p.x, it.y - p.y) <= SCAN_RADIUS) {
        it.kind = it.hidden; n++;
        if (it.kind === 'r') bad++;
        burstTile(it.x, it.y, it.kind === 'g' ? '61,220,151' : '255,95,109', 10, 2);
      }
    }
    sfx.scan(); sfx.tone(520, 0.2, 'sine', 0.05, 1040);
    if (n) {
      addText(p.x + 0.5, p.y - 0.35, `${n - bad} ✓  ${bad} ✕`, '94,231,255', 1.1);
      if (bad) hint('scanred', 'Red means the check failed: that block is corrupted. Walk over it — never take it.');
    } else addText(p.x + 0.5, p.y - 0.35, 'nothing to prove here', '94,231,255', 0.9);
    paintScan();
    updateVault();
  }
  function hurt(msg) {
    if (p.inv > 0 || st.over) return;
    if (debug) (st.hits || (st.hits = [])).push(`${st.time.toFixed(1)}s ${msg.slice(0, 40)}`);
    st.shields--; st.shieldsLost++;
    p.inv = 1.6;
    paintShields();
    fx.flash('255,95,109', 0.4); fx.alert = 1; shake(api.view, true); sfx.bad(); buzz(70);
    toast(api.toasts, msg, 'bad', 3400);
    burstTile(p.x, p.y, '255,95,109', 26, 4);
    say(r.pick(OUCH), 1.2);
    if (st.shields <= 0) lose('Out of shields', msg);
  }
  // An escape costs a shield even while Vera is still blinking from a hit.
  function breach(msg) {
    if (st.over) return;
    if (debug) (st.hits || (st.hits = [])).push(`${st.time.toFixed(1)}s ${msg.slice(0, 40)}`);
    st.shields--; st.shieldsLost++;
    paintShields();
    fx.flash('255,95,109', 0.35); fx.alert = 1; sfx.bad(); buzz([40, 30, 40]);
    toast(api.toasts, msg, 'bad', 3400);
    say('One got out!', 1.4);
    if (st.shields <= 0) lose('Folder compromised', msg);
  }
  function togglePause() {
    if (st.over || !w) return;
    paused = !paused;
    pauseIc.textContent = paused ? '▶' : '❚❚';
    pauseTxt.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    api.say(paused ? 'Paused.' : 'Resumed.');
  }

  // ---------- arrivals ----------
  function veraArrive(e) {
    const key = k(e.x, e.y);
    if (w.tiles[e.y][e.x] === 'vault' && w.vaultOpen) { win(); return; }
    const it = w.items.get(key);
    if (it) {
      if (it.kind === 'g') {
        w.items.delete(key); st.collected++; st.score += 50;
        addText(e.x + 0.5, e.y + 0.1, '+50', '61,220,151'); burstTile(e.x, e.y, '61,220,151', 14, 2.4);
        sfx.good(1);
      } else if (it.kind === 'q') {
        w.items.delete(key); st.guesses++;
        if (it.hidden === 'g') {
          st.collected++; st.score += 20;
          addText(e.x + 0.5, e.y + 0.1, 'unproven +20', '255,209,102', 1.1);
          say('Phew… lucky.');
          toast(api.toasts, 'Lucky — it was good, but you took it without proof. Scan first (E) for the full score and the third star.', 'info', 3800);
          sfx.good(0);
        } else {
          burstTile(e.x, e.y, '255,95,109', 20, 3);
          hurt('False recovered bytes: you took unproven data and it was corrupted. Scan grey data before you take it.');
        }
      } else if (it.kind === 'c') {
        if (it.red) hint('redchain', 'That block is past the break — it can never be decoded. Leave it.');
        else if (it.n === w.chainNext) {
          w.items.delete(key); w.chainNext++; st.collected++; st.score += 60;
          addText(e.x + 0.5, e.y + 0.1, `#${it.n} +60`, '61,220,151'); burstTile(e.x, e.y, '61,220,151', 16, 2.4);
          sfx.good(it.n);
          if (it.n === w.chainMax) say('Whole chain decoded!');
        } else hint('chainorder', `Block ${it.n} only decodes after block ${w.chainNext}. A solid archive is read in order — the lit block is next.`);
      } else if (it.kind === 'r') hint('red', 'Red data failed its check. Proven-corrupted data is never emitted — walk on.');
      bar.set('score', fmtInt(st.score), 'bump');
      updateVault();
    }
    if (st.over) return;
    if (teleCd <= 0) {
      for (const pp of w.portals) {
        const other = same(pp.a, e) ? pp.b : same(pp.b, e) ? pp.a : null;
        if (!other) continue;
        burstTile(e.x, e.y, '255,209,102', 18, 3);
        e.x = e.tx = other.x; e.y = e.ty = other.y; e.moving = false; path = null; teleCd = 0.9;
        burstTile(other.x, other.y, '255,209,102', 22, 3);
        sfx.tone(300, 0.25, 'sine', 0.06, 1200);
        say('Whoa — redirected!', 1.4);
        hint('portal', 'A Linker portal sent you somewhere else — that is what a symlink does to an extraction. Zap the Linker to close its portals.');
        break;
      }
    }
    if (!hintsShown.has('grey')) {
      for (const it2 of w.items.values()) {
        if (it2.kind === 'q' && Math.hypot(it2.x - e.x, it2.y - e.y) <= 2.2) { hint('grey', 'Grey “?” data is unproven. Press E (or SCAN) near it to check it before you take it.'); break; }
      }
    }
  }
  function slipperArrive(e) {
    if (w.tiles[e.y][e.x] === 'hole') {
      e.hold = true; e.escapeT = 0;
      addText(e.x + 0.5, e.y - 0.3, '!', '255,95,109', 0.8);
      sfx.tone(880, 0.1, 'square', 0.04, 440);
      hint('slip', 'A Slipper is squeezing through a “../” hole — zap it before it gets out!');
    }
  }
  function rotArrive(e) {
    const key = k(e.x, e.y);
    if (provable(w.items.get(key))) {
      e.hold = true; e.chew = 0; e.chewKey = key;
      hint('rot', 'A Rot beetle is chewing on verified data. Zap it before the block turns red!');
    }
  }

  // ---------- creatures ----------
  function chooseFor(e) {
    switch (e.type) {
      case 'slipper': {
        const d = w.holes.length && r.chance(0.72) ? bfs({ x: e.x, y: e.y }, (x, y) => w.tiles[y][x] === 'hole', 'slipper') : null;
        return d || randomStep(e, 'slipper');
      }
      case 'rot': {
        if (r.chance(0.6)) {
          const d = bfs({ x: e.x, y: e.y }, (x, y) => provable(w.items.get(k(x, y))), 'rot');
          if (d) return d;
        }
        return randomStep(e, 'rot');
      }
      case 'linker': return randomStep(e, 'linker');
      case 'hydra': {
        const vx = Math.round(p.x);
        const vy = Math.round(p.y);
        return bfs({ x: e.x, y: e.y }, (x, y) => x === vx && y === vy, 'hydra') || randomStep(e, 'hydra');
      }
      default: return null;
    }
  }
  function explode(b) {
    b.alive = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = b.x + dx;
        const y = b.y + dy;
        if (x < 0 || y < 0 || x >= w.W || y >= w.H || w.tiles[y][x] !== 'floor') continue;
        const it = w.items.get(k(x, y));
        if (it && it.kind !== 'r') corrupt(it);
        for (const o of w.enemies) {
          if (!o.alive || o === b || o.type === 'hydra' || Math.round(o.x) !== x || Math.round(o.y) !== y) continue;
          if (o.type === 'bomblet') o.age = Math.max(o.age, BOMB_GROW + BOMB_FUSE - 0.18); // chain reaction
          else { o.alive = false; burstTile(o.x, o.y, '255,159,28', 14, 3); }
        }
        const onVera = (x === Math.round(p.x) && y === Math.round(p.y)) || (x === p.tx && y === p.ty);
        if (!onVera) w.junk.set(k(x, y), JUNK_TIME);
      }
    }
    burstTile(b.x, b.y, '255,159,28', 70, 6);
    burstTile(b.x, b.y, '255,95,109', 40, 4);
    fx.ring(stagePt(b.x, b.y), '255,159,28', 200);
    sfx.boom();
    shake(api.view, true);
    if (Math.hypot(p.x - b.x, p.y - b.y) < 1.6) hurt('A Bomblet reached ×∞ right next to Vera. Defuse them while they are small.');
    else hint('blast', 'A Bomblet burst: the floor around it is flooded for a few seconds, and the data there turned red.');
  }
  function updateEnemies(dt) {
    const ramp = endless ? Math.min(1.5, 1 + (st.wave - 1) * 0.06) : 1; // endless archives get faster
    for (const e of w.enemies) {
      if (!e.alive) continue;
      e.t += dt;
      if (e.type === 'bomblet') {
        const before = e.age;
        e.age += dt * ramp;
        if (before < BOMB_GROW && e.age >= BOMB_GROW) { addText(e.x + 0.5, e.y - 0.35, '×∞', '255,95,109', 1); sfx.tone(1200, 0.4, 'square', 0.04, 300); }
        if (e.age >= BOMB_GROW + BOMB_FUSE) explode(e);
        if (st.over) return;
        continue;
      }
      if (e.type === 'slipper' && e.hold) {
        e.escapeT += dt;
        if (e.escapeT >= ESCAPE_TIME) {
          e.alive = false; st.escaped++;
          burstTile(e.x, e.y, '255,95,109', 26, 3);
          breach('A Slipper escaped through “../” — a file landed outside the folder you chose. That is Zip Slip.');
          if (st.over) return;
          continue;
        }
      } else if (e.type === 'rot' && e.hold) {
        const it = w.items.get(e.chewKey);
        if (!provable(it)) { e.hold = false; e.chew = null; }
        else {
          e.chew += dt;
          if (e.chew >= CHEW_TIME) { corrupt(it); e.hold = false; e.chew = null; addText(e.x + 0.5, e.y - 0.3, 'CORRUPTED', '255,95,109', 1); }
        }
      } else if (e.type === 'hydra') {
        e.inv = Math.max(0, e.inv - dt);
        e.hurt = Math.max(0, (e.hurt || 0) - dt);
        e.spawnT += dt;
        const phase2 = e.hp <= e.max / 2;
        if (e.spawnT >= (phase2 ? 3.6 : 5)) {
          e.spawnT = 0;
          const spots = freeTiles(3, 6);
          if (spots.length) {
            const s = r.pick(spots);
            const kind = phase2 && r.chance(0.5) ? 'rot' : 'bomblet';
            w.enemies.push(kind === 'rot' ? enemy('rot', s.x, s.y) : enemy('bomblet', s.x, s.y, { age: 1.5 }));
            burstTile(s.x, s.y, '167,139,250', 18, 2.5);
            addText(s.x + 0.5, s.y - 0.3, kind === 'rot' ? 'ROT!' : 'BOMB!', '167,139,250', 0.9);
          }
        }
        e.fireT = (e.fireT || 0) + dt;
        if (e.charge > 0) {
          e.charge -= dt;
          if (e.charge <= 0) {
            e.charge = 0;
            w.bolts.push({ x: Math.round(e.x), y: Math.round(e.y), dx: e.aim.x, dy: e.aim.y, t: 0 });
            sfx.tone(520, 0.25, 'sawtooth', 0.05, 160);
          }
        } else {
          const aim = lineTo(e, p, 8);
          if (aim && e.fireT >= (phase2 ? 1.5 : 2.1) && !(e.stun > 0)) {
            e.aim = aim; e.charge = phase2 ? 0.55 : 0.75; e.fireT = 0;
            sfx.tone(160, 0.45, 'sawtooth', 0.035, 480);
            hint('bolt', 'The Hydra’s heads glow when it lines up with Vera — step out of the line before the bolt flies!');
          } else if (!(e.stun > 0)) advance(e, phase2 ? SPEED.hydra2 : SPEED.hydra, dt, chooseFor, () => {});
        }
      } else if (!(e.stun > 0)) {
        const arrive = e.type === 'slipper' ? slipperArrive : e.type === 'rot' ? rotArrive : () => {};
        advance(e, SPEED[e.type] * ramp, dt, chooseFor, arrive);
        if (e.type === 'linker') {
          const every = def.linkerEvery || 8;
          e.portalT += dt;
          const mine = w.portals.filter((pp) => pp.owner === e).length;
          if (e.portalT >= every && mine < 2) {
            e.portalT = 0;
            const spots = freeTiles(2);
            for (let tries = 0; tries < 24 && spots.length > 1; tries++) {
              const a = r.pick(spots);
              const b = r.pick(spots);
              if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) >= 6) {
                w.portals.push({ a, b, owner: e, t: 0 });
                burstTile(a.x, a.y, '255,209,102', 14, 2); burstTile(b.x, b.y, '255,209,102', 14, 2);
                sfx.tone(420, 0.18, 'sine', 0.04, 840);
                hint('portals', 'A Linker opened a pair of portals. Walk into one and you come out of the other.');
                break;
              }
            }
          }
        }
      }
      if (!e.alive || st.over) continue;
      if (e.stun > 0) e.stun -= dt;
      const reach = e.type === 'hydra' ? 0.95 : 0.62;
      if (Math.abs(e.x - p.x) < reach && Math.abs(e.y - p.y) < reach && p.inv <= 0) {
        const who = { slipper: 'A Slipper', rot: 'A Rot beetle', linker: 'A Linker', hydra: 'The Hydra' }[e.type];
        hurt(`${who} touched Vera. Keep your distance and zap from afar.`);
        e.stun = 1.2; // a creature that touched Vera stops for a moment, so she can get clear
        if (st.over) return;
      }
    }
    w.enemies = w.enemies.filter((e) => e.alive);
  }

  // ---------- lifecycle ----------
  function startLevel() {
    w = buildWorld(def, r, st.wave);
    p = { x: w.start.x, y: w.start.y, tx: w.start.x, ty: w.start.y, face: 1, look: { x: 1, y: 0 }, moving: false, walk: 0, inv: 0, zapT: 0, alive: true };
    path = null; held.length = 0; tapDir = null;
    particles = []; texts = []; beam = null; scanRing = null; teleCd = 0;
    wavesT = 0;
    wavesLeft = def.slipperWaves ? def.slipperWaves.max : endless ? Math.min(4, Math.floor(st.wave / 2)) : 0;
    freeze = FREEZE;
    banner = { text: endless ? `WAVE ${st.wave}` : `LEVEL ${api.index + 1}`, sub: endless ? 'random archive' : def.name.toUpperCase(), t: 0, color: '167,139,250' };
    bar.set('lv', endless ? String(st.wave) : String(api.index + 1));
    sizeCanvas();
    renderStatic();
    updateVault();
    paintScan();
    paintShields();
    say(endless && st.wave > 1 ? 'Next archive!' : 'Let’s secure this archive.');
    api.say(`${banner.text}. ${def.name}. Collect ${remaining()} blocks of proven data, then reach the vault.`);
  }
  function win() {
    if (st.over) return;
    if (endless) {
      st.score += 250 * st.wave;
      if (st.wave % 2 === 0) st.shields = Math.min(3, st.shields + 1); // every second archive gives a shield back
      st.wave++;
      bar.set('score', fmtInt(st.score), 'bump');
      sfx.win(); fx.confetti(70);
      startLevel();
      return;
    }
    st.over = true;
    const bonusTime = Math.max(0, Math.round((def.par - st.time) * 10));
    const bonusSafe = st.shieldsLost === 0 ? 300 : 0;
    st.score += bonusTime + bonusSafe;
    const stars = 1 + (st.shieldsLost === 0 ? 1 : 0) + (st.guesses === 0 && st.time <= def.par ? 1 : 0);
    say(stars === 3 ? 'Perfect!' : 'Secured!');
    api.finish({
      won: true, stars, score: st.score,
      title: stars === 3 ? 'Proof-first clear' : 'Archive secured',
      stats: [['Time', `${fmtTime(st.time)} (par ${fmtTime(def.par)})`], ['Proven data', `${st.collected}`], ['Lost to corruption', `${st.corrupted}`],
        ['Zapped', `${st.zapped}`], ['Guesses', `${st.guesses}`], ['Shields lost', `${st.shieldsLost}`]],
      delay: 800,
    });
  }
  function lose(title, msg) {
    if (st.over) return;
    st.over = true;
    if (endless) {
      api.finish({ won: false, score: st.score, title: 'Run over', lesson: [msg, ' ', def.lesson],
        stats: [['Waves cleared', `${st.wave - 1}`], ['Zapped', `${st.zapped}`], ['Proven data', `${st.collected}`]], delay: 1200 });
      return;
    }
    api.finish({ won: false, stars: 0, score: st.score, title, lesson: [msg, ' ', def.lesson],
      stats: [['Time', fmtTime(st.time)], ['Proven data', `${st.collected}`], ['Zapped', `${st.zapped}`]], delay: 1200 });
  }

  // ---------- layout: map size, touch controls, and which way the map lies ----------
  const CONTROLS_H = 176;
  let T = 32;
  let dpr = 1;
  let staticLayer = null;
  // Swap x and y for the whole world, so a phone held upright gets a tall map (and back when it turns).
  function turnWorld() {
    const swap = (o) => { const t = o.x; o.x = o.y; o.y = t; };
    const swapV = (v) => (v ? { x: v.y, y: v.x } : v);
    const tiles = [];
    for (let y = 0; y < w.W; y++) { const row = []; for (let x = 0; x < w.H; x++) row.push(w.tiles[x][y]); tiles.push(row); }
    w.tiles = tiles;
    [w.W, w.H] = [w.H, w.W];
    const items = new Map();
    for (const it of w.items.values()) { swap(it); items.set(k(it.x, it.y), it); }
    w.items = items;
    const junk = new Map();
    for (const [key, v] of w.junk) { const [x, y] = key.split(',').map(Number); junk.set(k(y, x), v); }
    w.junk = junk;
    w.holes.forEach(swap);
    swap(w.start);
    swap(w.vault);
    for (const pp of w.portals) { swap(pp.a); swap(pp.b); }
    for (const b of w.bolts) { swap(b); [b.dx, b.dy] = [b.dy, b.dx]; }
    for (const a of [...w.enemies, p]) {
      [a.x, a.y] = [a.y, a.x];
      [a.tx, a.ty] = [a.ty, a.tx];
      a.dir = swapV(a.dir);
      a.look = swapV(a.look);
      if (a.aim) a.aim = swapV(a.aim);
      if (a.chewKey) { const [x, y] = a.chewKey.split(',').map(Number); a.chewKey = k(y, x); }
      if (a.look && a.look.x) a.face = a.look.x;
    }
    if (path) path.forEach(swap);
    particles = []; texts = []; beam = null; scanRing = null;
    w.turned = !w.turned;
  }
  function sizeCanvas() {
    api.area.classList.toggle('gd-area--touch', touchUI);
    const full = api.stage.classList.contains('stage--full');
    const areaW = Math.max(240, api.area.clientWidth || 600);
    const hudH = bar.el.getBoundingClientRect().height + 14;
    let availH;
    if (full) availH = api.area.clientHeight - hudH;
    else {
      const header = document.querySelector('header');
      availH = window.innerHeight - (header ? header.getBoundingClientRect().height : 0) - hudH - 44;
    }
    availH = Math.max(200, availH);
    // touch: controls under the map when there is height to spare, beside it on a wide, short screen
    const side = touchUI && areaW >= 520 && areaW > availH * 1.3;
    api.area.classList.toggle('gd-area--side', side);
    const sideW = Math.round(Math.min(230, Math.max(136, areaW * 0.21)));
    api.area.style.setProperty('--gd-side', `${sideW}px`);
    let mapW = areaW;
    let mapH = availH;
    if (touchUI && side) mapW = areaW - 2 * sideW - 24;
    else if (touchUI) mapH = availH - CONTROLS_H - 12;
    else mapH = availH - (tips.getBoundingClientRect().height + 12);
    mapW = Math.max(150, mapW);
    mapH = Math.max(150, mapH);
    // turn the map on its diagonal when that gives clearly bigger tiles
    if (Math.min(mapW / w.H, mapH / w.W) > Math.min(mapW / w.W, mapH / w.H) * 1.12) turnWorld();
    T = Math.max(16, Math.min(64, Math.floor(Math.min(mapW / w.W, mapH / w.H))));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w.W * T * dpr);
    canvas.height = Math.round(w.H * T * dpr);
    canvas.style.width = `${w.W * T}px`;
    canvas.style.height = `${w.H * T}px`;
    // hints appear over the bottom of the map, never over the controls
    const sr = api.stage.getBoundingClientRect();
    const belowEl = touchUI ? (side ? null : stickZone) : tips;
    const top = belowEl ? belowEl.getBoundingClientRect().top : sr.bottom - 2;
    api.stage.style.setProperty('--gd-toast-bottom', `${Math.max(12, Math.round(sr.bottom - top + 10))}px`);
  }
  function relayout() {
    if (!w) return;
    sizeCanvas();
    renderStatic();
  }
  function renderStatic() {
    staticLayer = document.createElement('canvas');
    staticLayer.width = canvas.width;
    staticLayer.height = canvas.height;
    const c = staticLayer.getContext('2d');
    c.scale(dpr, dpr);
    c.fillStyle = '#0d0820';
    c.fillRect(0, 0, w.W * T, w.H * T);
    c.font = `${Math.round(T * 0.22)}px ui-monospace, Menlo, Consolas, monospace`;
    c.textBaseline = 'top';
    for (let y = 0; y < w.H; y++) {
      for (let x = 0; x < w.W; x++) {
        const t = w.tiles[y][x];
        const px = x * T;
        const py = y * T;
        if (t === 'wall') {
          const g = c.createLinearGradient(px, py, px, py + T);
          g.addColorStop(0, '#3b2a78'); g.addColorStop(1, '#241a4a');
          c.fillStyle = g; c.fillRect(px, py, T, T);
          c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(px, py, T, Math.max(2, T * 0.12));
          c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(px, py + T - Math.max(2, T * 0.1), T, Math.max(2, T * 0.1));
          c.strokeStyle = 'rgba(167,139,250,.35)'; c.lineWidth = 1; c.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
        } else {
          c.fillStyle = (x + y) % 2 ? '#160f30' : '#120b28';
          c.fillRect(px, py, T, T);
          c.strokeStyle = 'rgba(167,139,250,.07)';
          c.strokeRect(px + 0.5, py + 0.5, T - 1, T - 1);
          if ((x * 7 + y * 13) % 5 === 0 && T >= 26) {
            c.fillStyle = 'rgba(167,139,250,.11)';
            c.fillText(((x * 31 + y * 17) & 255).toString(16).toUpperCase().padStart(2, '0'), px + T * 0.08, py + T * 0.08);
          }
        }
      }
    }
  }
  function progressArc(c, x, y, rad, frac, color) {
    c.strokeStyle = 'rgba(0,0,0,.55)'; c.lineWidth = Math.max(3, T * 0.1);
    c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = color; c.lineWidth = Math.max(2, T * 0.08);
    c.beginPath(); c.arc(x, y, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac)); c.stroke();
  }
  function drawBubble(c, x, y, text, a) {
    c.font = `800 ${Math.max(11, Math.round(T * 0.3))}px ui-sans-serif, system-ui, sans-serif`;
    const tw = c.measureText(text).width;
    const bw = tw + T * 0.5;
    const bh = Math.max(18, T * 0.52);
    const bx = Math.max(4, Math.min(w.W * T - bw - 4, x - bw / 2));
    const by = Math.max(4, y - T * 1.25);
    const tail = Math.max(bx + 10, Math.min(bx + bw - 10, x));
    c.globalAlpha = a;
    c.fillStyle = 'rgba(241,236,255,.96)';
    rr(c, bx, by, bw, bh, bh / 2); c.fill();
    c.beginPath(); c.moveTo(tail - T * 0.1, by + bh - 1); c.lineTo(tail, by + bh + T * 0.16); c.lineTo(tail + T * 0.1, by + bh - 1); c.fill();
    c.fillStyle = '#1b1233';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, bx + bw / 2, by + bh / 2 + 1);
    c.globalAlpha = 1;
  }
  function draw(t) {
    const c = ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w.W * T, w.H * T);
    if (staticLayer) c.drawImage(staticLayer, 0, 0, w.W * T, w.H * T);
    const cx = (v) => (v + 0.5) * T;
    for (const [key, left] of w.junk) {
      const [x, y] = key.split(',').map(Number);
      c.fillStyle = `rgba(255,159,28,${(0.25 + 0.15 * Math.sin(t * 8 + x)).toFixed(3)})`;
      c.fillRect(x * T + 2, y * T + 2, T - 4, T - 4);
      c.strokeStyle = 'rgba(255,209,102,.55)'; c.lineWidth = 2;
      c.save(); c.beginPath(); c.rect(x * T + 2, y * T + 2, T - 4, T - 4); c.clip();
      c.beginPath();
      for (let i = -1; i < 3; i++) { c.moveTo(x * T + (i * T) / 3, y * T + T); c.lineTo(x * T + (i * T) / 3 + T / 2, y * T); }
      c.stroke(); c.restore();
      if (left < 1.2) { c.fillStyle = 'rgba(13,8,32,.4)'; c.fillRect(x * T, y * T, T, T); }
    }
    for (const hl of w.holes) drawHole(c, cx(hl.x), cx(hl.y), T, t);
    drawVault(c, cx(w.vault.x), cx(w.vault.y), T, t, w.vaultOpen);
    for (const it of w.items.values()) {
      if (it.kind === 'c') drawBlock(c, cx(it.x), cx(it.y), T, t, it.red ? 'r' : 'g', String(it.n), !it.red && it.n !== w.chainNext);
      else drawBlock(c, cx(it.x), cx(it.y), T, t, it.kind);
    }
    for (const pp of w.portals) {
      c.globalAlpha = pp.t > PORTAL_LIFE - 2 && Math.floor(t * 8) % 2 === 0 ? 0.4 : 1;
      drawPortal(c, cx(pp.a.x), cx(pp.a.y), T, t);
      drawPortal(c, cx(pp.b.x), cx(pp.b.y), T, t);
      c.globalAlpha = 1;
    }
    if (scanRing) {
      const kk = Math.min(1, scanRing.t / 0.45);
      c.strokeStyle = `rgba(94,231,255,${(1 - kk).toFixed(3)})`; c.lineWidth = 3;
      c.beginPath(); c.arc(scanRing.x * T, scanRing.y * T, SCAN_RADIUS * T * kk, 0, Math.PI * 2); c.stroke();
      c.fillStyle = `rgba(94,231,255,${(0.12 * (1 - kk)).toFixed(3)})`; c.fill();
    }
    // creatures and Vera, back to front
    const actors = [...w.enemies, { type: 'vera', x: p.x, y: p.y }].sort((a, b) => a.y - b.y);
    for (const e of actors) {
      const ex = cx(e.x);
      const ey = cx(e.y);
      if (e.type === 'vera') {
        const blink = p.inv > 0 && Math.floor(t * 12) % 2 === 0;
        drawVera(c, ex, ey, T, { t, face: p.face, look: p.look, moving: p.moving, walk: p.walk, zap: p.zapT > 0, alpha: blink ? 0.35 : 1 });
      } else if (e.type === 'slipper') {
        const sq = e.hold ? 1 - Math.min(0.45, (e.escapeT / ESCAPE_TIME) * 0.45) : 1;
        c.save(); c.translate(ex, ey); c.scale(sq, sq); drawSlipper(c, 0, 0, T, e.t * (e.hold ? 2 : 1), { look: e.look }); c.restore();
        if (e.hold) progressArc(c, ex, ey, T * 0.48, e.escapeT / ESCAPE_TIME, '#ff5f6d');
      } else if (e.type === 'rot') {
        const jit = e.hold ? Math.sin(t * 40) * T * 0.03 : 0;
        drawRot(c, ex + jit, ey, T, e.t * (e.hold ? 1.8 : 1), { dir: e.dir || e.look });
        if (e.hold) progressArc(c, ex, ey, T * 0.46, e.chew / CHEW_TIME, '#ff5f6d');
      } else if (e.type === 'linker') drawLinker(c, ex, ey, T, e.t, { look: e.look });
      else if (e.type === 'bomblet') {
        const stage = e.age < 0 ? 0 : Math.min(3, Math.floor(e.age / (BOMB_GROW / 3)));
        const fuse = e.age >= BOMB_GROW;
        drawBomblet(c, ex, ey, T, e.t, stage, fuse && Math.floor(t * 10) % 2 === 0);
        if (fuse) progressArc(c, ex, ey, T * 0.5, (e.age - BOMB_GROW) / BOMB_FUSE, '#ff9f1c');
      } else if (e.type === 'hydra') {
        if (e.charge > 0 && e.aim) {
          let n = 0;
          let x = Math.round(e.x); let y = Math.round(e.y);
          while (n < 14) {
            x += e.aim.x; y += e.aim.y;
            if (x < 0 || y < 0 || x >= w.W || y >= w.H || w.tiles[y][x] === 'wall') break;
            n++;
          }
          const a = 0.18 + 0.14 * Math.sin(t * 30);
          c.fillStyle = `rgba(255,95,109,${a.toFixed(3)})`;
          const x0 = cx(Math.round(e.x)); const y0 = cx(Math.round(e.y));
          if (e.aim.x) c.fillRect(Math.min(x0, x0 + e.aim.x * n * T), y0 - T * 0.22, Math.abs(n * T), T * 0.44);
          else c.fillRect(x0 - T * 0.22, Math.min(y0, y0 + e.aim.y * n * T), T * 0.44, Math.abs(n * T));
        }
        drawHydra(c, ex, ey - T * 0.15, T * 1.25, e.t, { hurt: e.hurt > 0 || (e.charge > 0 && Math.floor(t * 14) % 2 === 0) });
        const bw = T * 1.7;
        const frac = Math.max(0, e.hp / e.max);
        c.fillStyle = 'rgba(0,0,0,.65)'; rr(c, ex - bw / 2, ey - T * 1.3, bw, 7, 3); c.fill();
        if (frac > 0) { c.fillStyle = frac > 0.5 ? '#a78bfa' : '#ff5f6d'; rr(c, ex - bw / 2, ey - T * 1.3, bw * frac, 7, 3); c.fill(); }
      }
    }
    for (const b of w.bolts) {
      const bx = cx(b.x); const by = cx(b.y);
      const tx0 = bx - b.dx * T * 1.3; const ty0 = by - b.dy * T * 1.3;
      const g = c.createLinearGradient(tx0, ty0, bx, by);
      g.addColorStop(0, 'rgba(167,139,250,0)'); g.addColorStop(1, 'rgba(233,221,255,.9)');
      c.strokeStyle = g; c.lineWidth = T * 0.24; c.lineCap = 'round';
      c.beginPath(); c.moveTo(tx0, ty0); c.lineTo(bx, by); c.stroke();
      c.fillStyle = '#ffffff'; c.shadowColor = '#a78bfa'; c.shadowBlur = T * 0.7;
      c.beginPath(); c.arc(bx, by, T * 0.17, 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;
    }
    if (beam) {
      const a = Math.max(0, beam.t / 0.16);
      c.lineCap = 'round';
      c.strokeStyle = `rgba(94,231,255,${a.toFixed(3)})`; c.lineWidth = Math.max(3, T * 0.14);
      c.shadowColor = '#5ee7ff'; c.shadowBlur = T * 0.5;
      c.beginPath(); c.moveTo(beam.x1 * T, beam.y1 * T); c.lineTo(beam.x2 * T, beam.y2 * T); c.stroke();
      c.shadowBlur = 0;
      c.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`; c.lineWidth = Math.max(1, T * 0.05);
      c.beginPath(); c.moveTo(beam.x1 * T, beam.y1 * T); c.lineTo(beam.x2 * T, beam.y2 * T); c.stroke();
    }
    if (motion) {
      const vx = cx(p.x);
      const vy = cx(p.y);
      const g = c.createRadialGradient(vx, vy, T * 2.5, vx, vy, Math.max(w.W, w.H) * T * 0.8);
      g.addColorStop(0, 'rgba(13,8,32,0)'); g.addColorStop(1, 'rgba(13,8,32,.42)');
      c.fillStyle = g; c.fillRect(0, 0, w.W * T, w.H * T);
    }
    c.globalCompositeOperation = 'lighter';
    for (const q of particles) {
      const a = 1 - q.life / q.max;
      c.fillStyle = `rgba(${q.color},${a.toFixed(3)})`;
      c.beginPath(); c.arc(q.x * T, q.y * T, q.size * T, 0, Math.PI * 2); c.fill();
    }
    c.globalCompositeOperation = 'source-over';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `900 ${Math.round(T * 0.34)}px ui-monospace, Menlo, Consolas, monospace`;
    for (const tx of texts) {
      const a = 1 - tx.t / tx.life;
      c.fillStyle = `rgba(0,0,0,${(a * 0.6).toFixed(3)})`;
      c.fillText(tx.text, tx.x * T + 1, (tx.y - tx.t * 0.9) * T + 1);
      c.fillStyle = `rgba(${tx.color},${a.toFixed(3)})`;
      c.fillText(tx.text, tx.x * T, (tx.y - tx.t * 0.9) * T);
    }
    if (bubble && !banner) {
      const a = bubble.t < 0.15 ? bubble.t / 0.15 : Math.max(0, 1 - (bubble.t - bubble.life + 0.3) / 0.3);
      drawBubble(c, cx(p.x), cx(p.y), bubble.text, Math.min(1, a));
    }
    if (banner) {
      const a = banner.t < 0.25 ? banner.t / 0.25 : Math.max(0, 1 - (banner.t - 1.4) / 0.6);
      if (a > 0) {
        c.fillStyle = `rgba(13,8,32,${(0.6 * a).toFixed(3)})`; c.fillRect(0, w.H * T * 0.36, w.W * T, w.H * T * 0.28);
        c.fillStyle = `rgba(${banner.color},${a.toFixed(3)})`;
        c.font = `900 ${Math.round(Math.min(T * 0.95, (w.W * T) / 9))}px ui-sans-serif, system-ui, sans-serif`;
        c.shadowColor = `rgba(${banner.color},1)`; c.shadowBlur = T * 0.6;
        c.fillText(banner.text, (w.W * T) / 2, w.H * T * 0.465);
        c.shadowBlur = 0;
        c.fillStyle = `rgba(241,236,255,${a.toFixed(3)})`;
        c.font = `700 ${Math.round(Math.min(T * 0.38, (w.W * T) / 22))}px ui-monospace, Menlo, Consolas, monospace`;
        c.fillText(banner.sub, (w.W * T) / 2, w.H * T * 0.575);
      }
    }
    if (paused) {
      c.fillStyle = 'rgba(13,8,32,.74)'; c.fillRect(0, 0, w.W * T, w.H * T);
      c.fillStyle = '#ffffff'; c.font = `900 ${Math.round(T * 0.9)}px ui-sans-serif, system-ui, sans-serif`;
      c.fillText('PAUSED', (w.W * T) / 2, w.H * T * 0.46);
      c.font = `700 ${Math.round(T * 0.34)}px ui-monospace, Menlo, Consolas, monospace`;
      c.fillStyle = '#bdb4e0'; c.fillText('press P or Resume', (w.W * T) / 2, w.H * T * 0.58);
    }
  }

  // ---------- main loop ----------
  function update(dt) {
    pollGamepad();
    if (paused || st.over) return;
    st.time += dt;
    if (!endless && st.time > LIMIT) { lose('Session expired', 'Four minutes passed and the archive session timed out.'); return; }
    zapCd = Math.max(0, zapCd - dt);
    if ((zapKey || zapTouch || zapPad) && zapCd <= 0) zap();
    if (touchUI) {
      const cd = (zapCd / ZAP_COOLDOWN).toFixed(2);
      if (cd !== shownCd) { shownCd = cd; zapBtn.style.setProperty('--cd', cd); }
    }
    teleCd = Math.max(0, teleCd - dt);
    p.inv = Math.max(0, p.inv - dt);
    p.zapT = Math.max(0, p.zapT - dt);
    const before = Math.floor(scanCharges);
    scanCharges = Math.min(SCAN_MAX, scanCharges + dt / SCAN_REGEN);
    if (Math.floor(scanCharges) !== before) paintScan();
    // turning back mid-tile is instant
    const want = path && path.length ? null : (wantedDirs()[0] || (tapDir != null ? DIRS[tapDir] : null));
    if (want && p.moving && p.dir && want.x === -p.dir.x && want.y === -p.dir.y) {
      p.tx -= p.dir.x; p.ty -= p.dir.y; p.dir = want; p.look = want; if (want.x) p.face = want.x; tapDir = null;
    } else if (want && !p.moving) { p.look = want; if (want.x) p.face = want.x; }
    advance(p, SPEED.vera, dt, (e) => {
      if (path && path.length) {
        const nx = path[0];
        if (Math.abs(nx.x - e.x) + Math.abs(nx.y - e.y) === 1 && passable(nx.x, nx.y, 'vera')) { path.shift(); return { x: nx.x - e.x, y: nx.y - e.y }; }
        path = null;
      }
      const wants = wantedDirs();
      const list = wants.length ? wants : (tapDir != null ? [DIRS[tapDir]] : []);
      tapDir = null;
      for (const d of list) if (passable(e.x + d.x, e.y + d.y, 'vera')) return d;
      if (list.length && e.dir && anyHeld() && passable(e.x + e.dir.x, e.y + e.dir.y, 'vera')) return e.dir; // keep going until a turn opens
      if (list.length) { e.look = list[0]; if (list[0].x) e.face = list[0].x; }
      return null;
    }, veraArrive);
    if (st.over) return;
    if (p.moving) p.walk += dt * 2.2;
    if (freeze > 0) freeze -= dt;
    else {
      updateEnemies(dt);
      if (st.over) return;
      if (wavesLeft > 0 && w.holes.length) {
        wavesT += dt;
        const every = def.slipperWaves ? def.slipperWaves.every : 14;
        if (wavesT >= every) {
          wavesT = 0;
          const spots = freeTiles(5);
          if (spots.length) {
            const s = r.pick(spots);
            w.enemies.push(enemy('slipper', s.x, s.y));
            wavesLeft--;
            burstTile(s.x, s.y, '61,220,151', 16, 2.5);
            addText(s.x + 0.5, s.y - 0.25, 'SLIPPER!', '61,220,151', 1);
            sfx.tone(660, 0.12, 'square', 0.04, 990);
          }
        }
      }
      for (const b of w.bolts) {
        b.t += dt;
        b.x += b.dx * BOLT_SPEED * dt;
        b.y += b.dy * BOLT_SPEED * dt;
        const bx = Math.round(b.x); const by = Math.round(b.y);
        if (b.t > 4 || bx < 0 || by < 0 || bx >= w.W || by >= w.H || w.tiles[by][bx] === 'wall' || (w.tiles[by][bx] === 'vault' && !w.vaultOpen)) {
          b.dead = true; burstTile(b.x, b.y, '167,139,250', 12, 2.2); continue;
        }
        if (Math.abs(b.x - p.x) < 0.55 && Math.abs(b.y - p.y) < 0.55) {
          b.dead = true; burstTile(b.x, b.y, '233,221,255', 20, 3);
          hurt('An overlap bolt hit Vera — the same bytes, read one more time. Step out of the Hydra’s line when its heads glow.');
          if (st.over) return;
        }
      }
      w.bolts = w.bolts.filter((b) => !b.dead);
      for (const pp of w.portals) pp.t += dt;
      w.portals = w.portals.filter((pp) => pp.t < PORTAL_LIFE);
    }
    for (const [key, left] of w.junk) { const v = left - dt; if (v <= 0) w.junk.delete(key); else w.junk.set(key, v); }
    if (beam) { beam.t -= dt; if (beam.t <= 0) beam = null; }
    if (scanRing) { scanRing.t += dt; if (scanRing.t > 0.5) scanRing = null; }
    if (banner) { banner.t += dt; if (banner.t > 2.1) banner = null; }
    if (bubble) { bubble.t += dt; if (bubble.t > bubble.life) bubble = null; }
    particles = particles.filter((q) => (q.life += dt) < q.max);
    for (const q of particles) { q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.95; q.vy *= 0.95; }
    texts = texts.filter((tx) => (tx.t += dt) < tx.life);
    fx.mood = Math.min(1, w.enemies.length / 8);
    const sec = Math.floor(st.time);
    if (sec !== shownSec) {
      shownSec = sec;
      bar.set('time', fmtTime(st.time), !endless && st.time > LIMIT - 30 ? 'bad' : !endless && st.time > def.par ? 'warn' : '');
    }
  }

  startLevel();
  const onResize = () => relayout();
  window.addEventListener('resize', onResize);
  // leaving full screen in the middle of a run pauses it; either way the layout is redone
  const onFull = (e) => {
    if (!e.detail && w && !paused && !st.over) togglePause();
    window.requestAnimationFrame(relayout);
  };
  api.stage.addEventListener('g-fullscreen', onFull);
  let clock = 0;
  const stopLoop = loop((dt) => {
    clock += dt;
    update(dt * speed);
    if (w) draw(clock);
    return true;
  });

  if (debug) {
    window.__guardian = {
      get w() { return w; }, get p() { return p; }, st, remaining, DIRS,
      passable: (x, y) => passable(x, y, 'vera'),
      busy: () => !!(p.moving || (path && path.length)),
      walk: (x, y, max = 99) => {
        const route = bfs({ x: Math.round(p.tx), y: Math.round(p.ty) }, (gx, gy) => gx === x && gy === y, 'vera', true);
        if (route) path = route.slice(0, max);
        return !!route;
      },
      setPath: (steps) => { path = steps.map((q) => ({ x: q.x, y: q.y })); },
      face: (i) => { p.look = DIRS[i]; if (DIRS[i].x) p.face = DIRS[i].x; },
      zap, scan, charges: () => scanCharges, cooldown: () => zapCd, frozen: () => freeze > 0,
      turned: () => !!w.turned, touchUI: () => touchUI, tile: () => T, paused: () => paused,
    };
  }

  return () => {
    stopLoop();
    document.removeEventListener('keydown', onDown);
    document.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', blurClear);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', visPause);
    api.stage.removeEventListener('g-fullscreen', onFull);
    api.stage.removeEventListener('pointerdown', onAnyPointer, true);
    if (debug) delete window.__guardian;
  };
}

// ---------- the animated "who's who" cards on the page ----------
function animateRoster() {
  const cards = [...document.querySelectorAll('canvas[data-char]')];
  if (!cards.length) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const items = cards.map((cv) => {
    const size = Number(cv.dataset.size) || 96;
    cv.width = Math.round(size * dpr);
    cv.height = Math.round(size * dpr);
    return { c: cv.getContext('2d'), size, id: cv.dataset.char };
  }).filter((it) => it.c);
  const still = reducedMotion();
  let tt = 1.3;
  const paint = () => {
    for (const { c, size, id } of items) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, size, size);
      drawCharacter(c, id, size / 2, size * 0.56, size * 0.8, tt + id.length);
    }
  };
  if (still) { paint(); return; }
  loop((dt) => { tt += dt; paint(); return true; });
}

const root = document.getElementById('game');
if (root) {
  new Game(root, {
    id: 'guardian',
    title: 'Vera: Archive Guardian',
    levels: LEVELS,
    endless: ENDLESS,
    immersive: true,
    controls: 'Move: arrows or WASD, the thumb stick on a phone, or click a tile · Zap: Space (hold to keep firing — it aims at the nearest creature in line) · Scan: E · Pause: P · Full screen: F · Gamepad: stick or d-pad, A zaps, X or B scans · Esc: back to the levels.',
    howto: 'Progress is saved in this browser only. The archives are simulated; every creature stands for a real archive threat.',
    play,
  });
  animateRoster();
}
