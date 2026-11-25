// VERAQIS Play — NEON RIFT, a 3D third-person puzzle-platformer.
// Three heroes with different abilities — Vera glides and zaps, Pix double-jumps, dashes and fits
// through low tunnels, Brick pushes crates, ground-pounds and walks through lasers. Switch between
// them, combine them, and get every one of them into the portal.
// This module is the entry point. It owns input (keyboard, mouse, touch, gamepad), the hero
// controller, the third-person camera, the HUD and the glue to the shell in ../core.js. Rendering,
// models, the world and the levels are their own modules (contract: _dev/NEONRIFT.md); world.js
// gets render.js and models.js passed in, so every module can be tested with stubs.
import * as THREE from '../vendor/three.min.js';
import { Game, h, hud, loop, toast, reducedMotion, touchFirst } from '../core.js';
import * as render from './render.js';
import * as models from './models.js';
import { buildWorld } from './world.js';
import { LEVELS } from './levels.js';

// ---------- physics and hero tuning (level design depends on the contract's numbers) ----------
const G = 26;                 // gravity, m/s²
const MAX_FALL = 30;          // m/s
const COYOTE = 0.12;          // s after running off a ledge in which a jump still counts
const BUFFER = 0.12;          // s a jump pressed just before landing is kept
const JUMP_CUT = 2.8;         // gravity × while rising once the jump button is let go (short hops)
const APEX = 0.06;            // m over the nominal height, so a ledge of exactly that height is reachable
const IFRAMES = 1.0;          // s of invulnerability after a hit or a respawn
const KNOCK_H = 6.5;          // knock-back, m/s
const KNOCK_V = 5.5;
const TEAM_PENALTY = 10;      // s added to the clock when the whole team regroups
const GLIDE_FALL = 1.6;       // m/s — Vera's fall speed while gliding
const GLIDE_TIME = 2.5;       // s of glide per air time
const GLIDE_BRAKE = 60;       // m/s² — how fast a glide catches a fall
const DASH_DIST = 4;          // m — Pix's dash
const DASH_TIME = 0.2;
const DASH_SPEED = DASH_DIST / DASH_TIME;
const ZAP_RANGE = 14;
const ZAP_CD = 0.45;
const POUND_RADIUS = 2;
const POUND_SPEED = 24;
const AIR_DRAG = 3;           // m/s² — momentum is kept in the air when the stick is let go
const MAX_STEP = 1 / 50;      // s — longer frames are split so fast falls never skip a floor
const jv = (m) => Math.sqrt(2 * G * (m + APEX));
const POUND_HOP = Math.sqrt(2 * G * 0.55);
const HEROES = {
  vera: { name: 'Vera', kind: 'robot', radius: 0.40, height: 1.50, run: 6.0, jump: jv(1.6), airJumps: 0, hearts: 3, heavy: false,
    accel: 62, decel: 58, airAccel: 30, turn: 15, eye: 1.15, cam: 1, color: '#a78bfa', glide: true },
  pix: { name: 'Pix', kind: 'fox', radius: 0.32, height: 0.90, run: 7.5, jump: jv(1.4), double: jv(1.4), airJumps: 1, hearts: 2, heavy: false,
    accel: 82, decel: 74, airAccel: 40, turn: 19, eye: 0.72, cam: 0.88, color: '#5ee7ff', dash: true },
  brick: { name: 'Brick', kind: 'golem', radius: 0.55, height: 1.80, run: 4.2, jump: jv(0.9), airJumps: 0, hearts: 4, heavy: true,
    accel: 30, decel: 36, airAccel: 15, turn: 9, eye: 1.45, cam: 1.12, color: '#ffb347', pound: true },
};
const CAM = {
  dist: 7.5, distTouch: 8, min: 3, max: 15, pitch: 0.36, pitchMin: -0.22, pitchMax: 1.18,
  keyYaw: 2.3, padYaw: 2.8, padPitch: 1.7, mouse: 0.0052, touch: 0.0078,
  recenter: 2.4, lookAhead: 0.24,
};
const ZAPPABLE = new Set(['enemy', 'node', 'switch', 'turret', 'sentry', 'crawler', 'warden', 'target']);
const GAME_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyE', 'KeyZ', 'KeyX', 'KeyP', 'Tab',
  'Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3']);
const QKEY = 'veraqis.neonrift.quality';
const QUALITIES = ['auto', 'high', 'medium', 'low'];

// ---------- helpers ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;
const angleDiff = (to, from) => { let d = (to - from) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const toV3 = (p, out = new THREE.Vector3()) => {
  if (!p) return out.set(0, 0, 0);
  if (p.isVector3 || (typeof p.x === 'number' && typeof p.z === 'number')) return out.set(p.x, p.y || 0, p.z);
  if (Array.isArray(p)) return out.set(+p[0] || 0, +p[1] || 0, +p[2] || 0);
  return out.set(0, 0, 0);
};
const query = () => { try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); } };
// Unity-style critically damped follow for one scalar; vel is { v }.
function smoothDamp(cur, target, vel, time, dt) {
  const omega = 2 / Math.max(1e-4, time);
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * e;
  return target + (change + temp) * e;
}
function readQuality() {
  try { const q = window.localStorage.getItem(QKEY); return QUALITIES.includes(q) ? q : 'auto'; } catch { return 'auto'; }
}
function saveQuality(q) { try { window.localStorage.setItem(QKEY, q); } catch { /* storage unavailable */ } }
let glOK = null;
function hasWebGL2() {
  if (glOK !== null) return glOK;
  try {
    const c = document.createElement('canvas');
    const gl = window.WebGL2RenderingContext ? c.getContext('webgl2') : null;
    glOK = !!gl;
    if (gl) gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { glOK = false; }
  return glOK;
}

// ---------- hero portraits for the HUD (canvas, no image files) ----------
function rrect(c, x, y, w, hh, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + hh, r); c.arcTo(x + w, y + hh, x, y + hh, r);
  c.arcTo(x, y + hh, x, y, r); c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function drawFace(c, id, s) {
  c.clearRect(0, 0, s, s);
  c.save();
  c.translate(s / 2, s / 2);
  const k = s / 100;
  c.scale(k, k);
  const glow = (color, blur) => { c.shadowColor = color; c.shadowBlur = blur * k * 10; };
  if (id === 'vera') {
    c.fillStyle = '#5b21b6'; rrect(c, -34, 30, 68, 30, 14); c.fill();
    const hg = c.createRadialGradient(-12, -16, 4, 0, 0, 40);
    hg.addColorStop(0, '#efe7ff'); hg.addColorStop(1, '#a78bfa');
    c.fillStyle = hg; c.beginPath(); c.arc(0, 2, 34, 0, TAU); c.fill();
    c.strokeStyle = '#1b1233'; c.lineWidth = 3; c.stroke();
    c.fillStyle = '#0d0820'; rrect(c, -25, -10, 50, 22, 10); c.fill();
    c.strokeStyle = 'rgba(94,231,255,.9)'; c.lineWidth = 2.5; c.stroke();
    c.fillStyle = '#5ee7ff'; glow('#5ee7ff', 1.2);
    rrect(c, -15, -5, 8, 11, 3); c.fill(); rrect(c, 7, -5, 8, 11, 3); c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = '#1b1233'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(0, -31); c.quadraticCurveTo(4, -40, 6, -45); c.stroke();
    c.fillStyle = '#ffd166'; glow('#ffd166', 1.4); c.beginPath(); c.arc(6, -46, 5, 0, TAU); c.fill(); c.shadowBlur = 0;
  } else if (id === 'pix') {
    const ear = (sx) => {
      c.fillStyle = '#ff9f43'; c.beginPath(); c.moveTo(sx * 10, -18); c.lineTo(sx * 34, -46); c.lineTo(sx * 33, -8); c.closePath(); c.fill();
      c.fillStyle = '#3b1d5e'; c.beginPath(); c.moveTo(sx * 16, -16); c.lineTo(sx * 31, -36); c.lineTo(sx * 30, -12); c.closePath(); c.fill();
    };
    ear(-1); ear(1);
    const fg = c.createLinearGradient(0, -30, 0, 36);
    fg.addColorStop(0, '#ffb066'); fg.addColorStop(1, '#f97316');
    c.fillStyle = fg;
    c.beginPath(); c.moveTo(-34, -10); c.quadraticCurveTo(-36, 18, 0, 38); c.quadraticCurveTo(36, 18, 34, -10); c.quadraticCurveTo(0, -34, -34, -10); c.fill();
    c.fillStyle = '#fff4e6';
    c.beginPath(); c.moveTo(-26, 8); c.quadraticCurveTo(-10, 12, 0, 36); c.quadraticCurveTo(10, 12, 26, 8); c.quadraticCurveTo(0, 22, -26, 8); c.fill();
    c.fillStyle = '#1b1233'; c.beginPath(); c.ellipse(0, 26, 6, 4.5, 0, 0, TAU); c.fill();
    c.fillStyle = '#123'; rrect(c, -32, -12, 64, 10, 5); c.fill();
    for (const sx of [-1, 1]) {
      c.fillStyle = '#0b3b4a'; c.beginPath(); c.arc(sx * 13, -6, 11, 0, TAU); c.fill();
      c.strokeStyle = '#5ee7ff'; c.lineWidth = 3; glow('#5ee7ff', 1.2); c.stroke(); c.shadowBlur = 0;
      c.fillStyle = 'rgba(190,250,255,.9)'; c.beginPath(); c.arc(sx * 13 - 3, -9, 3, 0, TAU); c.fill();
    }
  } else {
    const sg = c.createLinearGradient(0, -38, 0, 40);
    sg.addColorStop(0, '#a89c8c'); sg.addColorStop(1, '#5d554b');
    c.fillStyle = sg; rrect(c, -36, -34, 72, 70, 14); c.fill();
    c.strokeStyle = '#2a241f'; c.lineWidth = 3; c.stroke();
    c.fillStyle = '#7d8a9c'; rrect(c, -38, -22, 76, 11, 4); c.fill();
    c.fillStyle = '#c3ccd8'; for (const x of [-28, 0, 28]) { c.beginPath(); c.arc(x, -16.5, 2.2, 0, TAU); c.fill(); }
    c.fillStyle = '#1e1a17'; rrect(c, -26, -6, 52, 16, 6); c.fill();
    c.fillStyle = '#ffb347'; glow('#ff9f1c', 1.6);
    rrect(c, -20, -2, 14, 8, 3); c.fill(); rrect(c, 6, -2, 14, 8, 3); c.fill();
    c.shadowBlur = 0;
    c.strokeStyle = 'rgba(30,26,23,.7)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(-30, 18); c.lineTo(-18, 24); c.lineTo(-22, 32); c.moveTo(24, -30); c.lineTo(18, -24); c.stroke();
    c.fillStyle = '#4a433b'; rrect(c, -20, 18, 40, 10, 4); c.fill();
    c.fillStyle = 'rgba(255,179,71,.85)'; glow('#ff9f1c', 1); c.beginPath(); c.arc(0, 23, 3, 0, TAU); c.fill(); c.shadowBlur = 0;
  }
  c.restore();
}
function faceCanvas(id, size) {
  const cv = h('canvas', { class: 'nr-face', 'aria-hidden': 'true' });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr);
  const c = cv.getContext('2d');
  if (c) { c.scale(dpr, dpr); drawFace(c, id, size); }
  return cv;
}

// ---------- the WebGL fallback ----------
// Additive glow sprites (shard halos, beacon flares, antenna glows) fill the whole screen with white when
// the camera passes right next to one. Fade them by view distance in their own shader: no per-frame cost,
// and it works for shared materials because the fade is per pixel, not per object.
function nearFade(root) {
  root.traverse((o) => {
    const m = o.isSprite ? o.material : null;
    if (!m || m.blending !== THREE.AdditiveBlending || m.userData.nearFade || m.onBeforeCompile.toString().includes('vNearFade')) return;
    m.userData.nearFade = true;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, renderer) => {
      prev.call(m, sh, renderer);
      sh.vertexShader = sh.vertexShader
        .replace('void main() {', 'varying float vNearFade;\nvoid main() {')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\n\tvNearFade = smoothstep( 0.9, 3.4, - mvPosition.z );');
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', 'varying float vNearFade;\nvoid main() {')
        .replace('#include <fog_fragment>', '#include <fog_fragment>\n\tgl_FragColor.a *= vNearFade;');
    };
    const key = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => key() + '|nearfade';
    m.needsUpdate = true;
  });
}

function noGL(api, why) {
  api.area.append(h('div', { class: 'nr-nogl', role: 'alert' },
    h('p', { class: 'g-kicker' }, 'Neon Rift · 3D'),
    h('h2', null, '3D graphics are not available here'),
    h('p', null, why, ' Updating the browser or switching on hardware acceleration usually helps. ',
      'Meanwhile, ', h('a', { href: '/play/guardian/' }, 'Vera: Archive Guardian'), ' — the 2D game — runs everywhere.'),
    h('div', { class: 'g-actions' },
      h('a', { class: 'g-btn g-btn--primary', href: '/play/guardian/' }, 'Play the 2D game ▶'),
      h('button', { class: 'g-btn g-btn--ghost', type: 'button', onclick: () => api.quit() }, 'All levels'))));
  api.say('3D graphics are not available in this browser.');
  return () => {};
}

// ---------- one level ----------
function play(api) {
  const { sfx } = api;
  const lv = api.level;
  const def = lv.def || {};
  const motion = !reducedMotion();
  const q = query();
  const debug = q.has('debug');
  const speed = debug ? clamp(Number(q.get('speed')) || 1, 0.25, 4) : 1;
  const par = Number(def.par) || 120;
  api.area.classList.add('nr-area');
  api.stage.classList.add('stage--nr');
  if (!hasWebGL2() || (debug && q.has('nogl'))) return noGL(api, 'This browser or device has WebGL 2 switched off or does not support it.');

  // ---------- renderer and world ----------
  const view = h('div', { class: 'nr-view' });
  const canvas = h('canvas', { class: 'nr-canvas', role: 'img', 'aria-label': `3D view of ${lv.name}` });
  view.append(canvas);
  api.area.append(view);
  let R = null;
  let W = null;
  try {
    R = render.createRenderer(canvas, { quality: readQuality(), reducedMotion: !motion });
    R.setTheme(def.theme || 'neon');
    W = buildWorld(def, { R, models, render });
  } catch (err) {
    console.error('Neon Rift could not start:', err);
    let gl0 = null;
    try { gl0 = R && R.renderer && R.renderer.getContext(); } catch { gl0 = null; }
    try { W?.dispose(); } catch { /* ignore */ }
    try { R?.dispose(); } catch { /* ignore */ }
    try { if (gl0 && !gl0.isContextLost()) gl0.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
    view.remove();
    return noGL(api, R ? 'The level could not be built in this browser.' : 'This browser could not start WebGL 2.');
  }
  const fx = R.fx || {};
  const scene = R.scene;
  const camera = R.camera;

  // ---------- heroes ----------
  const ids = (W.heroes && W.heroes.length ? W.heroes : def.heroes || ['vera']).filter((id) => HEROES[id]);
  const heroes = ids.map((id) => {
    const S = HEROES[id];
    const model = models.makeHero(id);
    const root = model.root;              // ours: position (feet) and rotation.y; the model animates its children
    root.name = 'hero-' + id;
    scene.add(root);
    return {
      id, S, model, root, alive: true, active: false, hearts: S.hearts, deadT: 0, onRevive: null,
      body: { id, pos: new THREE.Vector3(), vel: new THREE.Vector3(), radius: S.radius, height: S.height, heavy: S.heavy,
        pushing: false, grounded: false, ceiling: false, wall: null, ground: null },
      yaw: 0, yawVis: 0, inv: 0, hurtT: 0, sinceGround: 0, jumpBuf: 0, jumped: false, cut: false, doubleT: 0,
      airJumps: S.airJumps, dashReady: true, dashT: 0, dashCd: 0, dashDir: new THREE.Vector3(), dashGround: false, trail: null,
      dashFrom: new THREE.Vector3(), lastDash: 0,
      glideFuel: GLIDE_TIME, gliding: false, pound: null, poundT: 0, zapT: 0, zapCd: 0, sniffCd: 0,
      speedSm: 0, prev: new THREE.Vector3(), hintShown: false,
      s: { speed: 0, vy: 0, grounded: true, action: 'idle', active: false, blink: false },
    };
  });
  nearFade(scene);
  let active = 0;
  heroes[0].active = true;
  const heroIndex = (id) => heroes.findIndex((hh) => hh.id === id);
  const st = { time: 0, respawns: 0, teamWipes: 0, enemies: 0, zaps: 0, hits: 0, shards: 0 };
  let mode = 'intro';           // 'intro' → 'play' → 'won'
  let paused = false;
  let over = false;
  let clock = 0;
  let needRender = true;
  const timers = new Set();
  const later = (fn, ms) => { const id = window.setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };

  // shards from the level file (for Pix's nose); the world counts the real ones
  const shardList = (def.items || []).filter((it) => it.type === 'shard').map((it) => ({ pos: toV3(it.p).add(new THREE.Vector3(0, 0.6, 0)), taken: false }));

  // ---------- spawn points ----------
  const cp = { pos: toV3(W.spawn && W.spawn.pos), yaw: (W.spawn && W.spawn.yaw) || 0 };
  const tA = new THREE.Vector3();
  const tB = new THREE.Vector3();
  const tC = new THREE.Vector3();
  const tD = new THREE.Vector3();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const SPOTS = [[0, 0], [1.35, 0], [-1.35, 0], [0, -1.35], [0, 1.35], [1.35, -1.35], [-1.35, -1.35]];
  // A free, supported spot near base for hero number idx (side by side), written into out.
  function spotNear(base, yaw, idx, out, self) {
    const rx = -Math.cos(yaw); const rz = Math.sin(yaw);   // right of a hero facing yaw
    const fx2 = Math.sin(yaw); const fz2 = Math.cos(yaw);
    for (let k = 0; k < SPOTS.length; k++) {
      const [ox, oz] = SPOTS[(idx + k) % SPOTS.length];
      tA.set(base.x + rx * ox + fx2 * oz, base.y + 1.2, base.z + rz * ox + fz2 * oz);
      let hit = null;
      try { hit = W.raycast(tA, DOWN, 3); } catch { hit = null; }
      if (!hit || Math.abs(hit.point.y - base.y) > 1.3) continue;
      let clear = true;
      for (const o of heroes) if (o !== self && Math.hypot(o.body.pos.x - tA.x, o.body.pos.z - tA.z) < 0.95 && Math.abs(o.body.pos.y - hit.point.y) < 1.5) clear = false;
      if (!clear) continue;
      return out.set(tA.x, hit.point.y + 0.02, tA.z);
    }
    return out.set(base.x, base.y + 0.05 + idx * 0.02, base.z);
  }
  heroes.forEach((hh, i) => {
    const ws = W.spawn && W.spawn.heroes && W.spawn.heroes[hh.id];
    const hs = def.heroStarts && def.heroStarts[hh.id];
    if (ws) toV3(ws, hh.body.pos);
    else if (hs) toV3(hs, hh.body.pos);
    else spotNear(cp.pos, cp.yaw, i, hh.body.pos, hh);
    hh.yaw = hh.yawVis = cp.yaw;
    hh.prev.copy(hh.body.pos);
    hh.root.position.copy(hh.body.pos);
    hh.root.rotation.y = hh.yawVis;
  });

  // ---------- DOM: HUD over the 3D view ----------
  const timeEl = h('span', null, '0:00');
  const parEl = h('span', { class: 'nr-par' }, `par ${fmtTime(par)}`);
  const bar = hud(view, [
    ['lv', 'Level', String(api.index + 1)],
    ['shards', 'Shards', `0/${W.shardsTotal || 0}`],
    ['time', 'Time', h('span', { class: 'nr-time' }, timeEl, parEl)],
  ], () => api.quit());
  const pauseIc = h('span', { class: 'nr-pause-ic', 'aria-hidden': 'true' }, '❚❚');
  const pauseTxt = h('span', { class: 'nr-pause-t' }, 'Pause');
  const pauseBtn = h('button', { class: 'g-btn g-btn--ghost nr-pausebtn', type: 'button', 'aria-label': 'Pause', title: 'Pause (P)' }, pauseIc, pauseTxt, h('span', { class: 'g-key' }, 'P'));
  pauseBtn.addEventListener('click', () => { togglePause(); if (!paused) api.stage.focus({ preventScroll: true }); });
  const qBtn = h('button', { class: 'g-btn g-btn--ghost nr-qbtn', type: 'button', title: 'Graphics quality' });
  qBtn.addEventListener('click', () => { cycleQuality(); api.stage.focus({ preventScroll: true }); });
  bar.el.querySelector('.hud-quit')?.prepend(pauseBtn, qBtn);

  // hero cards: portrait, name, hearts, key; a tap or click switches
  const cards = heroes.map((hh, i) => {
    const hearts = h('span', { class: 'nr-hearts', 'aria-hidden': 'true' });
    for (let k = 0; k < hh.S.hearts; k++) hearts.append(h('i', { class: 'nr-heart' }, '♥'));
    const el = h('button', { class: `nr-card nr-card--${hh.id}`, type: 'button', title: `${hh.S.name} (${i + 1})` },
      faceCanvas(hh.id, 44),
      h('span', { class: 'nr-card-t' }, h('span', { class: 'nr-card-n' }, hh.S.name), hearts),
      h('span', { class: 'g-key nr-card-k' }, String(i + 1)));
    el.addEventListener('click', () => { select(i); api.stage.focus({ preventScroll: true }); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return { el, hearts };
  });
  const teamEl = h('div', { class: 'nr-team' + (heroes.length === 1 ? ' nr-team--solo' : ''), role: 'group', 'aria-label': 'Heroes' }, cards.map((c) => c.el));
  const hintEl = h('div', { class: 'nr-hint', 'aria-hidden': 'true' });
  const meter = h('i', { class: 'nr-meter-fill' });
  const meterEl = h('span', { class: 'nr-meter' }, meter);
  const portalN = h('b', null, '0');
  const portalEl = h('div', { class: 'nr-portal', 'aria-hidden': 'true' }, h('span', { class: 'nr-portal-ic' }, '◎'), ' portal ', portalN, `/${heroes.length}`);
  const banner = h('div', { class: 'nr-banner', 'aria-hidden': 'true' },
    h('p', { class: 'g-kicker' }, `Level ${api.index + 1}`),
    h('h3', null, lv.title || lv.name),
    lv.blurb ? h('p', { class: 'nr-banner-sub' }, lv.blurb) : null,
    h('p', { class: 'nr-skip' }, touchFirst() ? 'tap to skip' : 'press any key to skip'));
  const flash = h('div', { class: 'nr-flash', 'aria-hidden': 'true' });
  const cine = h('div', { class: 'nr-cine', 'aria-hidden': 'true' });

  // pause overlay with every control
  const resumeBtn = h('button', { class: 'g-btn g-btn--primary', type: 'button' }, '▶ Resume ', h('span', { class: 'g-key' }, 'P'));
  resumeBtn.addEventListener('click', () => togglePause(false));
  const qBtn2 = h('button', { class: 'g-btn nr-qbtn2', type: 'button' });
  qBtn2.addEventListener('click', () => cycleQuality());
  const ctrl = (k, v) => h('div', { class: 'nr-ctl' }, h('dt', null, k), h('dd', null, v));
  const keyRow = (...ks) => ks.map((k) => (typeof k === 'string' && k.length <= 6 && !k.includes(' ') ? h('span', { class: 'g-key' }, k) : k));
  const pauseEl = h('div', { class: 'nr-pause', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Paused' },
    h('div', { class: 'nr-pause-card' },
      h('p', { class: 'g-kicker' }, 'Paused'),
      h('h3', null, lv.name),
      h('div', { class: 'nr-pause-cols' },
        h('dl', { class: 'nr-ctls nr-ctls--keys' },
          h('p', { class: 'nr-ctls-h' }, 'Keyboard + mouse'),
          ctrl(keyRow('WASD', ' / ', '←↑↓→'), 'move'),
          ctrl(keyRow('Space'), 'jump · hold: higher, Vera glides'),
          ctrl(keyRow('E'), 'ability: zap · pound · sniff'),
          ctrl(keyRow('Shift'), 'Pix dashes'),
          ctrl(keyRow('Tab', ' ', '1', '2', '3'), 'switch hero'),
          ctrl(keyRow('Z', ' ', 'X'), 'turn camera · drag · wheel zooms'),
          ctrl(keyRow('P', ' ', 'F', ' ', 'M', ' ', 'Esc'), 'pause · full screen · sound · levels')),
        h('dl', { class: 'nr-ctls nr-ctls--touch' },
          h('p', { class: 'nr-ctls-h' }, 'Touch'),
          ctrl('left thumb', 'move'), ctrl('JUMP', 'hold for higher jumps / glide'), ctrl('ACTION', 'zap · dash · pound'),
          ctrl('SWITCH / portrait', 'change hero'), ctrl('drag · pinch', 'camera · zoom')),
        h('dl', { class: 'nr-ctls nr-ctls--pad' },
          h('p', { class: 'nr-ctls-h' }, 'Gamepad'),
          ctrl('sticks', 'move · camera'), ctrl('A · X · B', 'jump · ability · dash'), ctrl('LB · RB', 'switch hero'), ctrl('Start', 'pause'))),
      h('div', { class: 'g-actions nr-pause-actions' }, resumeBtn, qBtn2,
        h('button', { class: 'g-btn g-btn--ghost', type: 'button', onclick: () => api.quit() }, 'All levels'))));
  pauseEl.hidden = true;

  // touch controls: a floating thumb stick on the left, JUMP / ACTION / SWITCH on the right
  const knob = h('div', { class: 'nr-knob' });
  const base = h('div', { class: 'nr-base' }, knob);
  const stickZone = h('div', { class: 'nr-stick', 'aria-hidden': 'true' }, base, h('span', { class: 'nr-stick-hint' }, 'move'));
  const jumpBtn = h('button', { class: 'nr-tb nr-tb--jump', type: 'button', 'aria-label': 'Jump' }, h('span', { class: 'nr-tb-ic' }, '▲'), h('span', { class: 'nr-tb-t' }, 'JUMP'));
  const actIc = h('span', { class: 'nr-tb-ic' }, '⚡');
  const actTxt = h('span', { class: 'nr-tb-t' }, 'ZAP');
  const actBtn = h('button', { class: 'nr-tb nr-tb--act', type: 'button', 'aria-label': 'Ability' }, actIc, actTxt);
  const swBtn = h('button', { class: 'nr-tb nr-tb--switch', type: 'button', 'aria-label': 'Switch hero' }, h('span', { class: 'nr-tb-ic' }, '⇄'), h('span', { class: 'nr-tb-t' }, 'SWITCH'));
  const touchEl = h('div', { class: 'nr-touch' + (heroes.length === 1 ? ' nr-touch--solo' : '') }, stickZone, h('div', { class: 'nr-btns' }, swBtn, actBtn, jumpBtn));
  const tips = h('p', { class: 'nr-tips' },
    h('span', { class: 'g-key' }, 'WASD'), ' move · ', h('span', { class: 'g-key' }, 'Space'), ' jump · ',
    h('span', { class: 'g-key' }, 'E'), ' ability · ', h('span', { class: 'g-key' }, 'Shift'), ' dash · ',
    h('span', { class: 'g-key' }, 'Tab'), ' switch · drag or ', h('span', { class: 'g-key' }, 'Z'), h('span', { class: 'g-key' }, 'X'), ' camera · ',
    h('span', { class: 'g-key' }, 'P'), ' pause · ', h('span', { class: 'g-key' }, 'F'), ' full screen');
  view.append(cine, flash, teamEl, hintEl, portalEl, banner, touchEl, pauseEl);
  api.area.append(tips);

  // ---------- input ----------
  const keys = new Set();
  const press = { jump: false, action: false, dash: false };
  const stick = { id: null, x: 0, y: 0, cx: 0, cy: 0 };
  const look = { dx: 0, dy: 0, zoom: 1 };
  const touches = new Map();
  let pinch = 0;
  let mouse = null;
  let jumpTouch = false;
  const pad = { x: 0, y: 0, cx: 0, cy: 0, zoom: 0, jump: false, on: false };
  const gpPrev = [];
  const virt = { on: false, x: 0, y: 0, world: false, jump: false, until: 0 };
  let touchUI = touchFirst();
  const inp = { wx: 0, wz: 0, mag: 0, jumpHeld: false, jumpPressed: false, actionPressed: false, dashPressed: false, camYaw: 0, camPitch: 0 };

  const playing = () => mode === 'play' && !paused && !over;
  function clearInput() {
    keys.clear(); jumpTouch = false; restStick(); touches.clear(); pinch = 0; mouse = null;
    press.jump = press.action = press.dash = false;
    jumpBtn.classList.remove('on'); actBtn.classList.remove('on');
  }
  function onDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (mode === 'intro' && !paused && !e.repeat && !['Escape', 'f', 'F', 'm', 'M', 'Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
      e.preventDefault(); skipIntro(); return;
    }
    if (!GAME_CODES.has(e.code)) return;
    if (paused) {
      // the pause menu is a normal dialog: Space and Tab work its buttons, P resumes
      if (e.code === 'KeyP' && !e.repeat) { e.preventDefault(); togglePause(false); }
      else if (e.code !== 'Space' && e.code !== 'Tab') e.preventDefault();
      return;
    }
    e.preventDefault();
    // Space would also press whichever button has focus; keep focus on the stage while playing.
    const ae = document.activeElement;
    if (ae && ae !== api.stage && api.stage.contains(ae)) api.stage.focus({ preventScroll: true });
    if (e.code === 'KeyP') { if (!e.repeat) togglePause(); return; }
    keys.add(e.code);
    if (e.repeat) return;
    if (e.code === 'Space') press.jump = true;
    else if (e.code === 'KeyE') press.action = true;
    else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') press.dash = true;
    else if (e.code === 'Tab') cycle(e.shiftKey ? -1 : 1);
    else if (/^(Digit|Numpad)[123]$/.test(e.code)) select(Number(e.code.slice(-1)) - 1);
  }
  function onUp(e) { keys.delete(e.code); }
  document.addEventListener('keydown', onDown);
  document.addEventListener('keyup', onUp);
  const onBlur = () => { clearInput(); if (mode !== 'won' && !over) togglePause(true); };
  window.addEventListener('blur', onBlur);
  const onVis = () => { if (document.hidden) { clearInput(); if (!over) togglePause(true); } };
  document.addEventListener('visibilitychange', onVis);

  // thumb stick: it appears under the thumb and follows it when the thumb runs past the rim
  const STICK_R = 46;
  function restStick() {
    stick.id = null; stick.x = 0; stick.y = 0;
    base.classList.remove('on');
    base.style.left = ''; base.style.top = '';
    knob.style.transform = '';
  }
  function stickMove(e) {
    let dx = e.clientX - stick.cx;
    let dy = e.clientY - stick.cy;
    let dist = Math.hypot(dx, dy);
    if (dist > STICK_R * 1.5) {
      const pull = (dist - STICK_R * 1.5) / dist;
      stick.cx += dx * pull; stick.cy += dy * pull;
      const zr = stickZone.getBoundingClientRect();
      base.style.left = `${Math.round(stick.cx - zr.left)}px`;
      base.style.top = `${Math.round(stick.cy - zr.top)}px`;
      dx = e.clientX - stick.cx; dy = e.clientY - stick.cy; dist = Math.hypot(dx, dy);
    }
    const kk = dist > STICK_R ? STICK_R / dist : 1;
    knob.style.transform = `translate(${(dx * kk).toFixed(1)}px, ${(dy * kk).toFixed(1)}px)`;
    const m = Math.min(1, dist / STICK_R);
    const live = m < 0.14 ? 0 : (m - 0.14) / 0.86;
    stick.x = dist > 0 ? (dx / dist) * live : 0;
    stick.y = dist > 0 ? (-dy / dist) * live : 0;
  }
  stickZone.addEventListener('pointerdown', (e) => {
    if (stick.id != null) return;
    e.preventDefault();
    if (mode === 'intro') { skipIntro(); return; }
    stick.id = e.pointerId;
    try { stickZone.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const zr = stickZone.getBoundingClientRect();
    const x = clamp(e.clientX - zr.left, 56, Math.max(56, zr.width - 56));
    const y = clamp(e.clientY - zr.top, 56, Math.max(56, zr.height - 56));
    stick.cx = zr.left + x; stick.cy = zr.top + y;
    base.style.left = `${Math.round(x)}px`;
    base.style.top = `${Math.round(y)}px`;
    base.classList.add('on');
    stickMove(e);
  });
  stickZone.addEventListener('pointermove', (e) => { if (e.pointerId === stick.id) stickMove(e); });
  const stickEnd = (e) => { if (e.pointerId === stick.id) restStick(); };
  stickZone.addEventListener('pointerup', stickEnd);
  stickZone.addEventListener('pointercancel', stickEnd);
  stickZone.addEventListener('lostpointercapture', stickEnd);
  // buttons
  const holdBtn = (btn, down, up) => {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (mode === 'intro') { skipIntro(); return; }
      btn.classList.add('on');
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      down();
    });
    const end = () => { btn.classList.remove('on'); if (up) up(); };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('lostpointercapture', end);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => e.preventDefault());
  };
  holdBtn(jumpBtn, () => { press.jump = true; jumpTouch = true; }, () => { jumpTouch = false; });
  holdBtn(actBtn, () => { if (heroes[active].S.dash) press.dash = true; else press.action = true; });
  holdBtn(swBtn, () => cycle(1));
  stickZone.addEventListener('contextmenu', (e) => e.preventDefault());
  // the first touch on the stage switches the touch controls on (a touchscreen laptop, say)
  const onAnyPointer = (e) => { if (e.pointerType === 'touch' && !touchUI) { touchUI = true; fit(); } };
  api.stage.addEventListener('pointerdown', onAnyPointer, true);

  // camera: drag on the view (mouse: any button, touch: one finger), pinch or wheel to zoom
  canvas.addEventListener('pointerdown', (e) => {
    if (mode === 'intro') { skipIntro(); e.preventDefault(); return; }
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    } else {
      mouse = { id: e.pointerId, x: e.clientX, y: e.clientY };
      canvas.classList.add('drag');
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      const t = touches.get(e.pointerId);
      if (!t) return;
      if (touches.size === 1) { look.dx += (e.clientX - t.x) * CAM.touch / CAM.mouse; look.dy += (e.clientY - t.y) * CAM.touch / CAM.mouse; }
      t.x = e.clientX; t.y = e.clientY;
      if (touches.size >= 2) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && d > 0) look.zoom *= pinch / d;
        pinch = d;
      }
    } else if (mouse && mouse.id === e.pointerId) {
      look.dx += e.clientX - mouse.x; look.dy += e.clientY - mouse.y;
      mouse.x = e.clientX; mouse.y = e.clientY;
    }
  });
  const lookEnd = (e) => {
    if (e.pointerType === 'touch') { touches.delete(e.pointerId); if (touches.size < 2) pinch = 0; }
    else if (mouse && mouse.id === e.pointerId) { mouse = null; canvas.classList.remove('drag'); }
  };
  canvas.addEventListener('pointerup', lookEnd);
  canvas.addEventListener('pointercancel', lookEnd);
  canvas.addEventListener('lostpointercapture', lookEnd);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  const onWheel = (e) => { e.preventDefault(); if (mode === 'intro') return; look.zoom *= Math.exp(clamp(e.deltaY, -200, 200) * 0.0012); };
  view.addEventListener('wheel', onWheel, { passive: false });
  const onTouchMove = (e) => { e.preventDefault(); };
  view.addEventListener('touchmove', onTouchMove, { passive: false });

  // gamepad: left stick moves, right stick turns the camera, A jump, X ability, B dash, LB/RB switch, Start pause
  const dz = (v, d = 0.16) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d));
  function pollPad() {
    let gp = null;
    try {
      const list = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const g of list) if (g && g.connected) { gp = g; break; }
    } catch { gp = null; }
    if (!gp) { pad.on = false; pad.x = pad.y = pad.cx = pad.cy = pad.zoom = 0; pad.jump = false; return; }
    const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    let ax = gp.axes[0] || 0;
    let ay = gp.axes[1] || 0;
    const m = Math.hypot(ax, ay);
    if (m < 0.18) { ax = 0; ay = 0; } else { const k = Math.min(1, (m - 0.18) / 0.82) / m; ax *= k; ay *= k; }
    if (b(14)) ax = -1;
    if (b(15)) ax = 1;
    if (b(12)) ay = -1;
    if (b(13)) ay = 1;
    pad.on = true; pad.x = ax; pad.y = -ay;
    pad.cx = dz(gp.axes[2] || 0); pad.cy = dz(gp.axes[3] || 0);
    pad.zoom = ((gp.buttons[6] && gp.buttons[6].value) || 0) - ((gp.buttons[7] && gp.buttons[7].value) || 0);
    pad.jump = b(0);
    for (let i = 0; i < 16; i++) {
      const now = b(i);
      if (now && !gpPrev[i]) {
        if (mode === 'intro' && !paused) skipIntro();
        else if (i === 9) togglePause();
        else if (paused) { if (i === 0) togglePause(false); }
        else if (i === 0) press.jump = true;
        else if (i === 1) press.dash = true;
        else if (i === 2) press.action = true;
        else if (i === 3) recenter();
        else if (i === 4) cycle(-1);
        else if (i === 5) cycle(1);
      }
      gpPrev[i] = now;
    }
  }

  function readInput() {
    let x = 0;
    let y = 0;
    let world = false;
    if (virt.on && (!virt.until || performance.now() < virt.until)) { x = virt.x; y = virt.y; world = virt.world; }
    else {
      virt.on = false;
      if (stick.id != null && (stick.x || stick.y)) { x = stick.x; y = stick.y; }
      else if (pad.on && (pad.x || pad.y)) { x = pad.x; y = pad.y; }
      else {
        x = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
        y = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      }
    }
    const mag = Math.min(1, Math.hypot(x, y));
    if (world) { inp.wx = x; inp.wz = y; }
    else {
      const sy = Math.sin(cam.yaw); const cy = Math.cos(cam.yaw);
      inp.wx = sy * y - cy * x;      // forward (sin, cos) · y + right (−cos, sin) · x
      inp.wz = cy * y + sy * x;
    }
    const wl = Math.hypot(inp.wx, inp.wz);
    if (wl > 1e-6) { inp.wx /= wl; inp.wz /= wl; }
    inp.mag = mag;
    inp.jumpHeld = keys.has('Space') || jumpTouch || pad.jump || virt.jump;
    inp.jumpPressed = press.jump;
    inp.actionPressed = press.action;
    inp.dashPressed = press.dash;
    inp.camYaw = ((keys.has('KeyZ') ? 1 : 0) - (keys.has('KeyX') ? 1 : 0)) * CAM.keyYaw - pad.cx * CAM.padYaw;
    inp.camPitch = pad.cy * CAM.padPitch;
    return inp;
  }

  // ---------- camera ----------
  const cam = {
    yaw: cp.yaw, pitch: CAM.pitch, dist: touchUI ? CAM.distTouch : CAM.dist, cur: 6, pitchAdj: 0,
    focus: new THREE.Vector3(), disp: new THREE.Vector3(), ahead: new THREE.Vector3(),
    fvx: { v: 0 }, fvy: { v: 0 }, fvz: { v: 0 }, manualT: 0, trauma: 0, groundY: 0,
    swoop: null, blend: null, lookAt: new THREE.Vector3(), dip: 0, dipV: 0, doomT: 0,
  };
  function dipCam(k) { if (motion) cam.dipV -= 1.6 * k; }
  const swoopFrom = new THREE.Vector3();
  const blendPos = new THREE.Vector3();
  const blendLook = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const camRight = new THREE.Vector3();
  const rayDir = new THREE.Vector3();
  function focusTarget(hh, out) { return out.set(hh.body.pos.x, hh.body.pos.y + hh.S.eye, hh.body.pos.z); }
  function snapCamera() {
    const hh = heroes[active];
    focusTarget(hh, cam.focus);
    cam.groundY = hh.body.pos.y;
    cam.fvx.v = cam.fvy.v = cam.fvz.v = 0;
    cam.ahead.set(0, 0, 0);
    cam.swoop = null;
    cam.doomT = 0;
    cam.cur = cam.dist * hh.S.cam;
  }
  function startSwoop() {
    const hh = heroes[active];
    if (!motion) { snapCamera(); return; }
    swoopFrom.copy(cam.disp);
    focusTarget(hh, cam.focus);
    cam.fvx.v = cam.fvy.v = cam.fvz.v = 0;
    cam.ahead.set(0, 0, 0);
    cam.groundY = hh.body.pos.y;
    cam.doomT = 0;
    const d = swoopFrom.distanceTo(cam.focus);
    cam.swoop = { t: 0, dur: clamp(0.38 + d * 0.025, 0.42, 0.95), lift: clamp(d * 0.12, 0.2, 2.6), pull: clamp(d / 8, 0, 1) };
  }
  function recenter() {
    const hh = heroes[active];
    const d = angleDiff(hh.yawVis, cam.yaw);
    cam.yaw += d;
    cam.pitch = CAM.pitch;
    cam.manualT = 0;
  }
  function shakeCam(a) { if (motion) cam.trauma = Math.min(1, cam.trauma + a); }
  // How far the camera can sit from the focus along dir before level geometry is in the way.
  function clearance(from, dir, want) {
    let best = want;
    let hit = null;
    try { hit = W.raycast(from, dir, want + 0.3); } catch { hit = null; }
    if (hit && hit.dist < best + 0.3) best = Math.min(best, hit.dist - 0.3);
    // two more rays toward the sides of the camera so its near plane does not poke through edges
    camRight.set(-Math.cos(cam.yaw), 0, Math.sin(cam.yaw));
    for (let k = 0; k < 2; k++) {
      const side = k ? 0.32 : -0.32;
      tD.copy(dir).multiplyScalar(want).addScaledVector(camRight, side).add(from);
      rayDir.copy(tD).sub(from);
      const len = rayDir.length();
      rayDir.divideScalar(len);
      try { hit = W.raycast(from, rayDir, len + 0.2); } catch { hit = null; }
      if (hit) best = Math.min(best, (hit.dist - 0.3) * (want / len));
    }
    return Math.max(0.8, best);
  }
  function camDirFor(yaw, pitch, out) {
    const cp2 = Math.cos(pitch);
    return out.set(-Math.sin(yaw) * cp2, Math.sin(pitch), -Math.cos(yaw) * cp2);
  }
  function updateCamera(dt, input) {
    const hh = heroes[active];
    const b = hh.body;
    // manual steering
    let dyaw = -look.dx * CAM.mouse;
    let dpitch = look.dy * CAM.mouse * 0.85;
    look.dx = 0; look.dy = 0;
    if (input) { dyaw += input.camYaw * dt; dpitch += input.camPitch * dt; }
    if (dyaw || dpitch) { cam.manualT = 0; cam.yaw += dyaw; cam.pitch = clamp(cam.pitch + dpitch, CAM.pitchMin, CAM.pitchMax); }
    else cam.manualT += dt;
    if (mode === 'won' && motion) cam.yaw += dt * 0.45;
    const zoomRate = pad.zoom ? Math.exp(pad.zoom * dt * 1.4) : 1;
    if (look.zoom !== 1 || zoomRate !== 1) { cam.dist = clamp(cam.dist * look.zoom * zoomRate, CAM.min, CAM.max); look.zoom = 1; }
    // swing back behind a hero who runs for a while and the player is not steering
    const sp = Math.hypot(b.vel.x, b.vel.z);
    if (mode === 'play' && !over && cam.manualT > CAM.recenter && sp > 2.2 && hh.dashT <= 0) {
      const heading = Math.atan2(b.vel.x, b.vel.z);
      const d = angleDiff(heading, cam.yaw);
      if (Math.abs(d) < 2.3) cam.yaw += d * (1 - Math.exp(-dt * 1.15 * Math.min(1, sp / hh.S.run)));
      cam.pitch += (CAM.pitch - cam.pitch) * (1 - Math.exp(-dt * 0.6));
    }
    // follow: tight sideways, lazy upward while jumping, tight again when the hero falls past its ledge —
    // but not into the abyss: with nothing below a falling hero the camera stays and watches it go
    if (b.grounded) { cam.groundY = b.pos.y; cam.doomT = 0; }
    else if (b.vel.y < -7 && hh.alive) {
      let below = null;
      try { below = W.raycast(tC.set(b.pos.x, b.pos.y + 0.2, b.pos.z), DOWN, 40); } catch { below = null; }
      cam.doomT = below ? 0 : cam.doomT + dt;
    }
    if (hh.alive && cam.doomT < 0.05) {
      focusTarget(hh, tA);
      tB.set(b.vel.x, 0, b.vel.z).multiplyScalar(CAM.lookAhead);
      if (tB.lengthSq() > 2.6) tB.setLength(1.6);
      cam.ahead.lerp(tB, 1 - Math.exp(-dt * 2.6));
      tA.add(cam.ahead);
      const vt = b.grounded ? 0.12 : b.pos.y < cam.groundY - 0.4 ? 0.06 : 0.32;
      cam.focus.x = smoothDamp(cam.focus.x, tA.x, cam.fvx, 0.08, dt);
      cam.focus.z = smoothDamp(cam.focus.z, tA.z, cam.fvz, 0.08, dt);
      cam.focus.y = smoothDamp(cam.focus.y, tA.y, cam.fvy, vt, dt);
    }
    cam.disp.copy(cam.focus);
    let distMul = hh.S.cam * aspectK;
    if (cam.swoop) {
      const s = cam.swoop;
      s.t += dt;
      const k = clamp(s.t / s.dur, 0, 1);
      const e = ease(k);
      cam.disp.lerpVectors(swoopFrom, cam.focus, e);
      cam.disp.y += s.lift * Math.sin(Math.PI * e);
      distMul *= 1 + 0.22 * s.pull * Math.sin(Math.PI * e);
      if (k >= 1) cam.swoop = null;
    }
    // place the camera; pull it in front of any wall between it and the hero, dip under low ceilings
    const want = cam.dist * distMul;
    const pitch = clamp(cam.pitch + cam.pitchAdj, CAM.pitchMin, CAM.pitchMax);
    camDirFor(cam.yaw, pitch, camDir);
    let allowed = clearance(cam.disp, camDir, want);
    let adjWant = 0;
    if (allowed < want * 0.55 && pitch > 0.1) {
      camDirFor(cam.yaw, 0.06, tC);
      const low = clearance(cam.disp, tC, want);
      if (low > allowed * 1.4) adjWant = 0.06 - cam.pitch;
    }
    cam.pitchAdj += (adjWant - cam.pitchAdj) * (1 - Math.exp(-dt * 5));
    if (allowed < cam.cur) cam.cur = allowed;
    else cam.cur += (allowed - cam.cur) * (1 - Math.exp(-dt * 3.2));
    camera.position.copy(cam.disp).addScaledVector(camDir, cam.cur);
    cam.lookAt.copy(cam.disp);
    if (cam.dip || cam.dipV) {
      cam.dipV += (-150 * cam.dip - 15 * cam.dipV) * dt;
      cam.dip += cam.dipV * dt;
      if (Math.abs(cam.dip) < 1e-3 && Math.abs(cam.dipV) < 1e-2) { cam.dip = 0; cam.dipV = 0; }
      camera.position.y += cam.dip; cam.lookAt.y += cam.dip * 0.6;
    }
    if (cam.trauma > 0) {
      const s = cam.trauma * cam.trauma;
      camera.position.x += (Math.sin(clock * 41.3) + Math.sin(clock * 23.1) * 0.5) * s * 0.22;
      camera.position.y += (Math.sin(clock * 37.7 + 1.3) + Math.sin(clock * 19.9) * 0.5) * s * 0.18;
      cam.lookAt.y += Math.sin(clock * 29.3 + 2.1) * s * 0.08;
      cam.trauma = Math.max(0, cam.trauma - dt * 1.7);
    }
    if (cam.blend) {
      const bl = cam.blend;
      bl.t += dt;
      const e = ease(clamp(bl.t / bl.dur, 0, 1));
      camera.position.lerpVectors(blendPos, camera.position, e);
      cam.lookAt.lerpVectors(blendLook, cam.lookAt, e);
      if (bl.t >= bl.dur) cam.blend = null;
    }
    camera.lookAt(cam.lookAt);
  }

  // ---------- intro: a short fly-over from the portal back to the team; any key skips ----------
  let intro = null;
  function buildIntro() {
    const blocks = def.blocks || [];
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const bl of blocks) {
      if (!bl.p || !bl.s) continue;
      min.x = Math.min(min.x, bl.p[0] - bl.s[0] / 2); max.x = Math.max(max.x, bl.p[0] + bl.s[0] / 2);
      min.y = Math.min(min.y, bl.p[1] - bl.s[1] / 2); max.y = Math.max(max.y, bl.p[1] + bl.s[1] / 2);
      min.z = Math.min(min.z, bl.p[2] - bl.s[2] / 2); max.z = Math.max(max.z, bl.p[2] + bl.s[2] / 2);
    }
    if (!Number.isFinite(min.x)) { min.copy(cp.pos).addScalar(-10); max.copy(cp.pos).addScalar(10); }
    const centre = min.clone().add(max).multiplyScalar(0.5);
    const size = Math.max(10, max.x - min.x, max.z - min.z);
    const portalIt = (def.items || []).find((it) => it.type === 'portal');
    const goal = portalIt ? toV3(portalIt.p) : centre.clone();
    const start = focusTarget(heroes[active], new THREE.Vector3());
    // where the gameplay camera will be when the intro ends
    snapCamera();
    updateCamera(0, null);
    const endPos = camera.position.clone();
    const away = goal.clone().sub(start).setY(0);
    if (away.lengthSq() < 1) away.set(Math.sin(cp.yaw), 0, Math.cos(cp.yaw));
    away.normalize();
    const side = new THREE.Vector3(-away.z, 0, away.x);
    const topY = Math.max(max.y, goal.y, start.y);
    const p0 = goal.clone().addScaledVector(away, 7).addScaledVector(side, 6).setY(goal.y + 5);
    const p1 = goal.clone().addScaledVector(away, -4).addScaledVector(side, -7).setY(topY + 7);
    const p2 = centre.clone().addScaledVector(side, size * 0.25).setY(topY + 6 + size * 0.18);
    const pts = [p0, p1, p2, endPos];
    const mid = centre.clone().setY(Math.max(start.y, goal.y)).lerp(start, 0.5);
    const lookPts = [goal.clone().setY(goal.y + 1.4), goal.clone().setY(goal.y + 1), mid, start.clone()];
    if (goal.distanceTo(start) < 8) { pts.splice(2, 1); lookPts.splice(2, 1); }
    intro = {
      path: new THREE.CatmullRomCurve3(pts, false, 'centripetal'),
      look: new THREE.CatmullRomCurve3(lookPts, false, 'centripetal'),
      t: 0, dur: clamp(3.6 + size * 0.035, 4, 6.5), pos: new THREE.Vector3(), at: new THREE.Vector3(), cur: Infinity,
    };
    view.classList.add('nr-intro');
  }
  function updateIntro(dt) {
    intro.t += dt;
    const k = clamp(intro.t / intro.dur, 0, 1);
    const e = k * k * (3 - 2 * k);
    intro.path.getPoint(e, intro.pos);
    intro.look.getPoint(Math.min(1, e * 1.05), intro.at);
    // the flight never puts a wall between the camera and what it looks at
    rayDir.copy(intro.pos).sub(intro.at);
    const len = rayDir.length();
    let allowed = len;
    if (len > 1e-3) {
      rayDir.divideScalar(len);
      let hit = null;
      try { hit = W.raycast(intro.at, rayDir, len); } catch { hit = null; }
      if (hit) allowed = Math.max(1.5, hit.dist - 0.5);
    }
    if (allowed < intro.cur) intro.cur = allowed;
    else intro.cur += (allowed - intro.cur) * (1 - Math.exp(-dt * 2.2));
    camera.position.copy(intro.at).addScaledVector(rayDir, Math.min(len, intro.cur));
    camera.lookAt(intro.at);
    if (k >= 1) endIntro(false);
  }
  function skipIntro() { if (mode === 'intro') endIntro(true); }
  function endIntro(skipped) {
    if (mode !== 'intro') return;
    mode = 'play';
    view.classList.remove('nr-intro');
    snapCamera();
    if (intro && skipped && motion) {
      blendPos.copy(camera.position); blendLook.copy(intro.at);
      cam.blend = { t: 0, dur: 0.55 };
    }
    intro = null;
    banner.classList.add('out');
    later(() => banner.remove(), 600);
    for (const t of pendingTips.splice(0)) tip(t);
    if (heroes.length > 1) {
      later(() => {
        if (over) return;
        toast(api.toasts, touchUI ? `${heroes.length} heroes: tap a portrait or SWITCH to change. Everyone has to reach the portal.`
          : `${heroes.length} heroes: Tab or 1–${heroes.length} to switch. Everyone has to reach the portal.`, 'info', 4200);
      }, 700);
    }
    api.say(`${lv.name}. ${heroes.map((x) => x.S.name).join(', ')}. Get ${heroes.length > 1 ? 'every hero' : 'Vera'} into the portal.`);
  }

  // ---------- hero actions ----------
  const buzz = (pattern) => { try { if (touchUI && navigator.vibrate) navigator.vibrate(pattern); } catch { /* ignore */ } };
  const near = (hh) => hh.active || hh.body.pos.distanceTo(camera.position) < 14;
  function jump(hh, v, dbl) {
    const b = hh.body;
    // a jump from a moving platform keeps its speed
    const g = b.ground;
    if (!dbl && g && g.vel && g.vel.isVector3) { b.vel.x += g.vel.x; b.vel.z += g.vel.z; }
    b.vel.y = v;
    b.grounded = false;
    hh.jumped = true; hh.cut = true; hh.jumpBuf = 0; hh.sinceGround = COYOTE + 1;
    hh.gliding = false;
    if (dbl) {
      hh.doubleT = 0.45;
      if (near(hh)) { sfx.tone(620, 0.1, 'triangle', 0.05, 1040); fx.burst?.(b.pos.clone().setY(b.pos.y + 0.2), '#5ee7ff', 12, 2.5); }
    } else if (near(hh)) {
      sfx.tone(hh.S.heavy ? 240 : 400, 0.09, 'square', 0.03, hh.S.heavy ? 380 : 660);
      if (hh.S.heavy) fx.dust?.(b.pos.clone());
    }
  }
  function startDash(hh, input) {
    const b = hh.body;
    if (input && input.mag > 0.2) hh.dashDir.set(input.wx, 0, input.wz);
    else hh.dashDir.set(Math.sin(hh.yawVis), 0, Math.cos(hh.yawVis));
    hh.dashDir.normalize();
    hh.dashGround = b.grounded && b.vel.y <= 0.01;
    hh.dashT = DASH_TIME; hh.dashReady = false; hh.dashCd = 0.35;
    hh.dashFrom.copy(b.pos);
    hh.yaw = hh.yawVis = Math.atan2(hh.dashDir.x, hh.dashDir.z);
    hh.gliding = false; hh.cut = false;
    b.vel.y = 0;
    sfx.noise(0.16, 0.07, 4200); sfx.tone(980, 0.13, 'sawtooth', 0.03, 320);
    try { hh.trail = fx.trail ? fx.trail(hh.root, '#5ee7ff') : null; } catch { hh.trail = null; }
    if (hh.dashGround) fx.dust?.(b.pos.clone());
  }
  function endDash(hh, bonk) {
    const b = hh.body;
    hh.dashT = 0;
    hh.lastDash = Math.hypot(b.pos.x - hh.dashFrom.x, b.pos.z - hh.dashFrom.z);
    const sp = Math.hypot(b.vel.x, b.vel.z);
    const keep = hh.S.run * 1.1;
    if (sp > keep) { b.vel.x *= keep / sp; b.vel.z *= keep / sp; }
    if (bonk) { b.vel.x *= -0.25; b.vel.z *= -0.25; shakeCam(0.15); sfx.tone(180, 0.08, 'square', 0.04); }
    const tr = hh.trail;
    hh.trail = null;
    if (tr) later(() => { try { tr.stop(); } catch { /* ignore */ } }, 140);
  }
  function startPound(hh, onGround) {
    if (hh.pound) return;
    const b = hh.body;
    hh.gliding = false;
    if (onGround) {
      hh.pound = 'hop';
      b.vel.y = POUND_HOP; b.grounded = false;
      hh.jumped = true; hh.cut = false; hh.sinceGround = COYOTE + 1;
      sfx.tone(200, 0.12, 'square', 0.035, 320);
    } else {
      hh.pound = 'windup'; hh.poundT = 0.12;
      sfx.tone(320, 0.12, 'sine', 0.04, 520);
    }
  }
  function poundImpact(hh) {
    const b = hh.body;
    hh.pound = 'land'; hh.poundT = 0.28;
    let n = 0;
    try { n = W.pound(b.pos.clone(), POUND_RADIUS) || 0; } catch { n = 0; }
    if (hh.active) dipCam(1);
    fx.shockwave?.(b.pos.clone().setY(b.pos.y + 0.05), '#ffb347', 3);
    fx.dust?.(b.pos.clone());
    sfx.boom();
    if (hh.active) shakeCam(n ? 0.75 : 0.5);
    buzz(n ? [40, 30, 60] : 40);
    if (n) { fx.burst?.(b.pos.clone().setY(b.pos.y + 0.4), '#ffd166', 30, 6); api.say('Crack!'); }
  }
  const aimDir = new THREE.Vector3();
  const aimBest = new THREE.Vector3();
  const PITCHES = [-0.26, -0.09, 0.08, 0.26, 0.48, 0.72];
  // Vera aims at the zappable thing closest to where the camera (and she) look.
  function findAim(origin, baseYaw, out) {
    let best = Infinity;
    for (let yi = -8; yi <= 8; yi++) {
      const yaw = baseYaw + yi * 0.0873;
      for (const p of PITCHES) {
        const c = Math.cos(p);
        aimDir.set(Math.sin(yaw) * c, Math.sin(p), Math.cos(yaw) * c);
        let hit = null;
        try { hit = W.raycast(origin, aimDir, ZAP_RANGE, { solidOnly: false }); } catch { hit = null; }
        if (!hit || !ZAPPABLE.has(hit.kind)) continue;
        const score = Math.abs(yi) * 1.2 + Math.abs(p - 0.08) * 6 + hit.dist * 0.25;
        if (score < best) { best = score; out.copy(hit.point); }
      }
    }
    return best < Infinity;
  }
  const zapFrom = new THREE.Vector3();
  function zap(hh) {
    if (hh.zapCd > 0) return;
    const b = hh.body;
    hh.zapCd = ZAP_CD; hh.zapT = 0.3; st.zaps++;
    tA.set(b.pos.x, b.pos.y + hh.S.height * 0.68, b.pos.z);
    let found = false;
    if (typeof W.aim === 'function') {
      const tryAim = (yaw) => {
        aimDir.set(Math.sin(yaw), 0.12, Math.cos(yaw)).normalize();
        let a = null;
        try { a = W.aim(tA, aimDir, ZAP_RANGE, 34); } catch { a = null; }
        if (a && a.point) { aimBest.copy(a.point); return true; }
        return false;
      };
      found = tryAim(cam.yaw) || tryAim(hh.yawVis);
    } else found = findAim(tA, cam.yaw, aimBest) || findAim(tA, hh.yawVis, aimBest);
    let yaw;
    if (found) yaw = Math.atan2(aimBest.x - b.pos.x, aimBest.z - b.pos.z);
    else yaw = inp.mag > 0.3 || mode !== 'play' ? hh.yawVis : cam.yaw;
    hh.yaw = hh.yawVis = yaw;
    hh.root.rotation.y = yaw;
    hh.root.position.copy(b.pos);
    hh.root.updateMatrixWorld(true);
    const hand = hh.model.anchors && hh.model.anchors.hand;
    if (hand) hand.getWorldPosition(zapFrom); else zapFrom.copy(tA).add(tB.set(Math.sin(yaw) * 0.4, 0, Math.cos(yaw) * 0.4));
    const dir = new THREE.Vector3();
    if (found) dir.copy(aimBest).sub(zapFrom).normalize();
    else dir.set(Math.sin(yaw), 0, Math.cos(yaw));
    let hit = null;
    try { hit = W.zap(zapFrom.clone(), dir.clone(), ZAP_RANGE); } catch { hit = null; }
    const end = hit && hit.point ? hit.point.clone() : zapFrom.clone().addScaledVector(dir, ZAP_RANGE);
    fx.beam?.(zapFrom.clone(), end, '#5ee7ff', 0.07);
    if (hit) fx.sparkle?.(end.clone(), '#5ee7ff');
    sfx.zap();
    if (hit && ZAPPABLE.has(hit.kind)) sfx.tone(1320, 0.08, 'triangle', 0.04, 0, 0.05);
  }
  function sniff(hh) {
    if (hh.sniffCd > 0) return;
    hh.sniffCd = 1.2;
    const b = hh.body;
    let best = null;
    let bd = Infinity;
    for (const s of shardList) {
      if (s.taken) continue;
      const d = s.pos.distanceTo(b.pos);
      if (d < bd) { bd = d; best = s; }
    }
    sfx.tone(880, 0.06, 'sine', 0.03); sfx.tone(1180, 0.08, 'sine', 0.03, 0, 0.08);
    const head = b.pos.clone().setY(b.pos.y + hh.S.height + 0.3);
    if (!best) { fx.text?.(head, '✓', '#3ddc97'); toast(api.toasts, 'Pix sniffs… no shards left here.', 'info', 2200); return; }
    fx.sparkle?.(best.pos.clone(), '#ffd166');
    fx.text?.(best.pos.clone().setY(best.pos.y + 0.8), '✦', '#ffd166');
    fx.text?.(head, '?!', '#ffd166');
    const rel = angleDiff(Math.atan2(best.pos.x - b.pos.x, best.pos.z - b.pos.z), cam.yaw);
    const where = Math.abs(rel) < 0.7 ? 'ahead' : Math.abs(rel) > 2.4 ? 'behind you' : rel > 0 ? 'to the left' : 'to the right';
    const dy = best.pos.y - b.pos.y;
    const up = dy > 1.6 ? ', up high' : dy < -1.6 ? ', down below' : '';
    toast(api.toasts, `Pix smells a shard ${Math.round(bd)} m ${where}${up}.`, 'info', 2600);
  }
  function action(hh, input, onGround) {
    if (hh.S.glide) zap(hh);
    else if (hh.S.pound) startPound(hh, onGround);
    else sniff(hh);
    if (input) input.actionPressed = false;
  }

  // ---------- the controller: one fixed recipe for the active hero and the idle ones ----------
  function stepHero(hh, dt, input) {
    const S = hh.S;
    const b = hh.body;
    if (!hh.alive) {
      hh.deadT -= dt;
      if (hh.deadT <= 0) { hh.alive = true; const f = hh.onRevive; hh.onRevive = null; if (f) f(); }
      return;
    }
    hh.inv = Math.max(0, hh.inv - dt);
    hh.hurtT = Math.max(0, hh.hurtT - dt);
    hh.zapT = Math.max(0, hh.zapT - dt);
    hh.zapCd = Math.max(0, hh.zapCd - dt);
    hh.sniffCd = Math.max(0, hh.sniffCd - dt);
    hh.jumpBuf = Math.max(0, hh.jumpBuf - dt);
    hh.dashCd = Math.max(0, hh.dashCd - dt);
    hh.doubleT = Math.max(0, hh.doubleT - dt);
    const onGround = b.grounded && b.vel.y <= 0.01;
    if (onGround) {
      hh.sinceGround = 0; hh.airJumps = S.airJumps; hh.glideFuel = GLIDE_TIME; hh.jumped = false; hh.cut = false;
      if (hh.dashT <= 0 && hh.dashCd <= 0) hh.dashReady = true;
    } else hh.sinceGround += dt;
    const free = hh.hurtT <= 0 && !hh.pound;
    // ---- abilities from button presses ----
    if (input) {
      if (input.jumpPressed) hh.jumpBuf = BUFFER;
      const coyote = !onGround && !hh.jumped && hh.sinceGround <= COYOTE;
      if (hh.jumpBuf > 0 && (onGround || coyote) && free) {
        if (hh.dashT > 0) endDash(hh);
        jump(hh, S.jump, false);
        input.jumpPressed = false;
      } else if (input.jumpPressed && !onGround && !coyote && hh.airJumps > 0 && free) {
        if (hh.dashT > 0) endDash(hh);
        hh.airJumps--;
        jump(hh, S.double, true);
        input.jumpPressed = false;
      }
      if (input.dashPressed && S.dash && hh.dashReady && hh.dashT <= 0 && free) { startDash(hh, input); input.dashPressed = false; }
      if (input.actionPressed && hh.hurtT <= 0) action(hh, input, onGround);
    }
    // ---- glide: hold jump while falling ----
    hh.gliding = !!(S.glide && input && input.jumpHeld && !b.grounded && b.vel.y < 0 && hh.glideFuel > 0 && free && hh.dashT <= 0);
    if (hh.gliding) hh.glideFuel = Math.max(0, hh.glideFuel - dt);
    // ---- horizontal ----
    const dashing = hh.dashT > 0;
    if (dashing) {
      const k = Math.min(1, hh.dashT / Math.max(1e-6, dt));   // the last step covers only what is left: 4 m exactly
      b.vel.x = hh.dashDir.x * DASH_SPEED * k; b.vel.z = hh.dashDir.z * DASH_SPEED * k;
      hh.dashT -= dt;
    } else if (hh.pound && hh.pound !== 'hop') {
      b.vel.x *= Math.exp(-dt * 20); b.vel.z *= Math.exp(-dt * 20);
    } else {
      const ctrl = !input ? 0 : hh.hurtT > 0 ? 0.25 : 1;
      const mag = input ? input.mag * ctrl : 0;
      const tx = input ? input.wx * S.run * mag : 0;
      const tz = input ? input.wz * S.run * mag : 0;
      let a;
      if (mag > 0.04) {
        a = onGround ? S.accel : S.airAccel;
        if (onGround && b.vel.x * tx + b.vel.z * tz < 0) a *= 1.7;   // reversing: extra grip
      } else a = onGround ? S.decel * (hh.hurtT > 0 ? 0.3 : 1) : AIR_DRAG;
      if (hh.gliding) a *= 0.8;
      const dvx = tx - b.vel.x;
      const dvz = tz - b.vel.z;
      const dl = Math.hypot(dvx, dvz);
      const step = a * dt;
      if (dl <= step) { b.vel.x = tx; b.vel.z = tz; }
      else { b.vel.x += (dvx / dl) * step; b.vel.z += (dvz / dl) * step; }
    }
    // ---- vertical: v0 → v1 over the step; the body moves with the average, so a jump peaks at exactly
    // v²/2g whatever the frame rate (plain Euler would come up short by v·dt/2) ----
    let v0 = b.vel.y;
    let v1;
    if (dashing) v0 = v1 = hh.dashGround ? -1 : 0;   // level flight (hugging the floor on a ground dash)
    else if (hh.pound === 'windup') {
      v0 = v1 = 0;
      hh.poundT -= dt;
      if (hh.poundT <= 0) { hh.pound = 'slam'; v1 = -POUND_SPEED; sfx.noise(0.25, 0.06, 900); }
    } else if (hh.pound === 'slam') v0 = v1 = -POUND_SPEED;
    else {
      let g = G;
      if (v0 > 0 && hh.cut && !(input && input.jumpHeld)) g *= JUMP_CUT;
      v1 = Math.max(-MAX_FALL, v0 - g * dt);
      if (hh.gliding && v1 < -GLIDE_FALL) v1 = Math.min(-GLIDE_FALL, v1 + GLIDE_BRAKE * dt);
    }
    if (hh.pound === 'land') { hh.poundT -= dt; if (hh.poundT <= 0) hh.pound = null; }
    // ---- move with collisions ----
    const wasGround = b.grounded;
    const vyBefore = v0;
    const vAvg = (v0 + v1) / 2;
    b.vel.y = vAvg;
    hh.prev.copy(b.pos);
    let contacts = null;
    try { contacts = W.moveBody(b, dt); } catch (err) { if (debug) console.warn(err); }
    if (b.vel.y === vAvg) b.vel.y = v1;               // the world changes it only on landings, ceilings and pads
    if (hh.pound === 'hop' && b.vel.y <= 1.2) { hh.pound = 'windup'; hh.poundT = 0.1; }
    if (dashing && hh.dashT <= 0) endDash(hh, false);
    if (b.grounded && b.vel.y < 0) b.vel.y = 0;
    if (b.ceiling && b.vel.y > 0) b.vel.y = 0;
    const n = b.wall;
    if (n && typeof n.x === 'number') {
      if (hh.dashT > 0 && hh.dashDir.x * n.x + hh.dashDir.z * n.z < -0.6) endDash(hh, true);
      const vn = b.vel.x * n.x + b.vel.z * n.z;
      if (vn < 0) { b.vel.x -= n.x * vn; b.vel.z -= n.z * vn; }
    }
    if (!b.pushing && S.heavy && Array.isArray(contacts)) {
      for (let k = 0; k < contacts.length; k++) if (contacts[k] && contacts[k].kind === 'crate') { b.pushing = true; break; }
    }
    // displacement speed for the run cycle (minus whatever a moving platform carried)
    let mx = b.pos.x - hh.prev.x;
    let mz = b.pos.z - hh.prev.z;
    const gv = b.ground && b.ground.vel;
    if (gv && gv.isVector3) { mx -= gv.x * dt; mz -= gv.z * dt; }
    const sp = dt > 0 ? Math.hypot(mx, mz) / dt : 0;
    hh.speedSm += (Math.min(sp, Math.hypot(b.vel.x, b.vel.z) + 0.5) - hh.speedSm) * (1 - Math.exp(-dt * 14));
    if (!wasGround && b.grounded) land(hh, vyBefore);
    // ---- facing ----
    if (hh.dashT <= 0 && input && input.mag > 0.1 && hh.hurtT <= 0 && !(hh.pound && hh.pound !== 'hop')) hh.yaw = Math.atan2(input.wx, input.wz);
    hh.yawVis += angleDiff(hh.yaw, hh.yawVis) * (1 - Math.exp(-S.turn * dt));
  }
  function land(hh, vy) {
    const b = hh.body;
    if (hh.pound === 'slam' || hh.pound === 'windup') { poundImpact(hh); return; }
    const impact = clamp(-vy / 22, 0, 1);
    if (impact < 0.12) return;
    if (hh.active && impact > 0.3) dipCam(impact * (hh.S.heavy ? 1 : 0.6));
    if (impact > 0.32) fx.dust?.(b.pos.clone());
    if (near(hh)) { sfx.noise(0.07, 0.03 + impact * 0.06, hh.S.heavy ? 450 : 900); sfx.tone(hh.S.heavy ? 80 : 130, 0.07, 'sine', 0.03 + impact * 0.04); }
    if (hh.S.heavy && impact > 0.45 && hh.active) shakeCam(0.18 * impact);
  }

  // ---------- hurt, falls and respawns ----------
  function hurt(ev) {
    const i = heroIndex(ev.hero);
    if (i < 0 || over) return;
    const hh = heroes[i];
    if (hh.inv > 0 || !hh.alive) return;
    const dmg = Math.max(1, Math.round(ev.dmg || 1));
    hh.hearts = Math.max(0, hh.hearts - dmg);
    hh.inv = IFRAMES; hh.hurtT = 0.38;
    st.hits++;
    const b = hh.body;
    if (hh.dashT > 0) endDash(hh, false);
    hh.pound = null; hh.gliding = false;
    // knock-back away from the source
    const from = ev.from ? toV3(ev.from, tA) : tA.copy(b.pos).addScaledVector(tB.set(Math.sin(hh.yawVis), 0, Math.cos(hh.yawVis)), 1);
    tB.set(b.pos.x - from.x, 0, b.pos.z - from.z);
    if (tB.lengthSq() < 1e-4) tB.set(-Math.sin(hh.yawVis), 0, -Math.cos(hh.yawVis));
    tB.normalize();
    b.vel.x = tB.x * KNOCK_H * (hh.S.heavy ? 0.6 : 1);
    b.vel.z = tB.z * KNOCK_H * (hh.S.heavy ? 0.6 : 1);
    b.vel.y = KNOCK_V * (hh.S.heavy ? 0.7 : 1);
    b.grounded = false; hh.jumped = true; hh.cut = false; hh.sinceGround = COYOTE + 1;
    fx.burst?.(b.pos.clone().setY(b.pos.y + hh.S.height * 0.6), '#ff5f6d', 18, 4);
    sfx.bad();
    if (hh.active) { shakeCam(0.55); hitFlash(); buzz(70); }
    paintHearts(i, true);
    if (hh.hearts <= 0) { later(() => teamWipe(hh), 380); return; }
    if (!hh.active) toast(api.toasts, `${hh.S.name} is under attack!`, 'bad', 2000);
    api.say(`${hh.S.name} was hit. ${hh.hearts} ${hh.hearts === 1 ? 'heart' : 'hearts'} left.`);
  }
  // A hero that is out plays its 'dead' animation for a moment, then pops back in at the checkpoint.
  function kill(hh, delay, then) {
    if (hh.dashT > 0) endDash(hh, false);
    hh.alive = false; hh.deadT = delay; hh.onRevive = then;
    hh.body.vel.set(0, 0, 0);
    hh.pound = null; hh.gliding = false; hh.hurtT = 0;
  }
  function fell(ev) {
    const i = heroIndex(ev.hero);
    if (i < 0 || over) return;
    const hh = heroes[i];
    if (!hh.alive) return;
    hh.hearts = Math.max(0, hh.hearts - 1);
    st.respawns++;
    sfx.tone(520, 0.45, 'sine', 0.05, 90);
    paintHearts(i, true);
    if (hh.hearts <= 0) { teamWipe(hh); return; }
    const killY = Number.isFinite(W.killY) ? W.killY : Number(def.killY) || -15;
    kill(hh, hh.body.pos.y < killY + 1.5 ? 0.3 : 0.85, () => { respawn(hh, i); if (hh.active) startSwoop(); });
    if (hh.active) hitFlash();
    toast(api.toasts, `${hh.S.name} fell — back at the checkpoint with one heart less.`, 'bad', 2400);
    api.say(`${hh.S.name} fell and is back at the checkpoint.`);
  }
  function respawn(hh, i) {
    const b = hh.body;
    const wc = W.checkpoint;
    const slot = wc && wc.heroes && wc.heroes[hh.id];
    let yaw = cp.yaw;
    if (slot && !heroes.some((o) => o !== hh && o.alive && Math.hypot(o.body.pos.x - slot.x, o.body.pos.z - slot.z) < 0.9 && Math.abs(o.body.pos.y - slot.y) < 1.5)) {
      toV3(slot, b.pos);
      if (Number.isFinite(wc.yaw)) yaw = wc.yaw;
    } else spotNear(wc && wc.pos ? toV3(wc.pos, tC) : cp.pos, yaw, i, b.pos, hh);
    b.vel.set(0, 0, 0);
    b.grounded = false; b.ground = null; b.wall = null;
    hh.pound = null; hh.gliding = false; hh.hurtT = 0; hh.inv = IFRAMES; hh.jumpBuf = 0; hh.dashT = 0;
    hh.yaw = hh.yawVis = yaw;
    hh.prev.copy(b.pos);
    hh.root.position.copy(b.pos);
    hh.root.rotation.y = yaw;
    fx.burst?.(b.pos.clone().setY(b.pos.y + 0.8), hh.S.color, 22, 3);
    fx.shockwave?.(b.pos.clone().setY(b.pos.y + 0.05), hh.S.color, 1.8);
  }
  let lastWipe = -9;
  function teamWipe(who) {
    if (over || clock - lastWipe < 1) return;
    lastWipe = clock;
    st.teamWipes++; st.respawns++;
    st.time += TEAM_PENALTY;
    try { W.clearShots?.(); } catch { /* ignore */ }
    heroes.forEach((hh, i) => {
      kill(hh, 0.9, () => {
        hh.hearts = hh.S.hearts;
        respawn(hh, i);
        paintHearts(i, false);
        if (hh.active && mode === 'play') startSwoop();
      });
    });
    sfx.tone(392, 0.2, 'triangle', 0.05); sfx.tone(262, 0.35, 'triangle', 0.05, 0, 0.16);
    timeEl.parentElement?.classList.remove('bump');
    void timeEl.offsetWidth;
    timeEl.parentElement?.classList.add('bump');
    toast(api.toasts, `${who ? who.S.name + ' is out of hearts — ' : ''}the team regroups at the checkpoint. +${TEAM_PENALTY} s`, 'bad', 3200);
    api.say(`The team regroups at the checkpoint. ${TEAM_PENALTY} seconds added.`);
  }
  function hitFlash() {
    if (!motion) return;
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
  }

  // ---------- world events ----------
  const pendingTips = [];
  let shownTips = 0;
  let shardCombo = 0;
  let shardT = 0;
  let portalIn = 0;
  function tip(text) {
    if (!text) return;
    shownTips++;
    toast(api.toasts, text, 'info', clamp(2200 + text.length * 45, 3200, 6500));
  }
  function onShard(ev) {
    const p = ev.pos ? toV3(ev.pos, new THREE.Vector3()) : null;
    let best = null;
    let bd = 3;
    const ref = p || (heroIndex(ev.hero) >= 0 ? heroes[heroIndex(ev.hero)].body.pos : null);
    if (ref) for (const s of shardList) { if (s.taken) continue; const d = s.pos.distanceTo(ref); if (d < bd) { bd = d; best = s; } }
    if (best) best.taken = true;
    shardCombo = shardT > 0 ? shardCombo + 1 : 1;
    shardT = 2.2;
    sfx.good(shardCombo);
    if (p) { fx.sparkle?.(p.clone(), '#ffd166'); fx.text?.(p.clone().setY(p.y + 0.6), '+1', '#ffd166'); }
    const total = W.shardsTotal || 0;
    if (total && W.shards >= total) {
      later(() => { sfx.power(); toast(api.toasts, 'Every shard found! ★', 'good', 2600); }, 250);
      api.say('Every shard found.');
    }
  }
  function onEvents(evs) {
    if (!evs || !evs.length) return;
    for (const ev of evs) {
      if (!ev || !ev.type) continue;
      switch (ev.type) {
        case 'shard': onShard(ev); break;
        case 'checkpoint': {
          const p = toV3(ev.pos, new THREE.Vector3());
          const moved = p.distanceTo(cp.pos) > 0.5;
          cp.pos.copy(p);
          if (typeof ev.yaw === 'number') cp.yaw = ev.yaw;
          if (moved && mode !== 'intro') {
            sfx.power();
            fx.shockwave?.(p.clone().setY(p.y + 0.05), '#3ddc97', 2.6);
            fx.text?.(p.clone().setY(p.y + 2.2), 'CHECKPOINT', '#3ddc97');
            toast(api.toasts, 'Checkpoint ✓', 'good', 1600);
            api.say('Checkpoint.');
          }
          break;
        }
        case 'hurt': hurt(ev); break;
        case 'void': fell(ev); break;
        case 'signal':
          if (mode !== 'intro') {
            if (ev.on) { sfx.tone(660, 0.07, 'square', 0.03); sfx.tone(990, 0.1, 'square', 0.03, 0, 0.07); }
            else { sfx.tone(700, 0.07, 'square', 0.025); sfx.tone(470, 0.1, 'square', 0.025, 0, 0.07); }
          }
          break;
        case 'tip': if (mode === 'intro') pendingTips.push(ev.text); else tip(ev.text); break;
        case 'alarm':
          sfx.tone(880, 0.1, 'square', 0.04); sfx.tone(880, 0.1, 'square', 0.04, 0, 0.16);
          if (ev.pos) fx.text?.(toV3(ev.pos, new THREE.Vector3()).add(tB.set(0, 2.4, 0)), '!', '#ff5f6d');
          break;
        case 'enemyDown': {
          st.enemies++;
          sfx.good(3); sfx.noise(0.2, 0.08, 2400);
          if (ev.pos) { const p = toV3(ev.pos, new THREE.Vector3()); fx.burst?.(p.clone().setY(p.y + 0.6), '#3ddc97', 26, 5); fx.text?.(p.clone().setY(p.y + 1.6), '+50', '#3ddc97'); }
          break;
        }
        case 'portal': {
          const inside = Math.max(0, ev.inside | 0);
          const need = Math.max(1, ev.need | 0 || heroes.length);
          if (inside > portalIn && inside < need) {
            sfx.tone(392 + inside * 98, 0.16, 'triangle', 0.05);
            toast(api.toasts, `Portal: ${inside} of ${need} — bring ${need - inside === 1 ? 'the last hero' : 'the others'}!`, 'info', 2400);
          }
          portalIn = inside;
          portalN.textContent = String(inside);
          portalEl.classList.toggle('on', inside > 0);
          break;
        }
        case 'break':
          sfx.noise(0.45, 0.16, 1100); sfx.tone(90, 0.3, 'sine', 0.08, 50);
          shakeCam(0.3);
          break;
        case 'exit': win(); break;
        case 'bounce': {
          const i = heroIndex(ev.hero);
          if (i < 0) break;
          const hh = heroes[i];
          const b = hh.body;
          const power = Number(ev.power) || 16;
          if (b.vel.y < power * 0.5) b.vel.y = power;
          b.grounded = false;
          hh.jumped = true; hh.cut = false; hh.sinceGround = COYOTE + 1; hh.jumpBuf = 0;
          hh.airJumps = hh.S.airJumps; hh.glideFuel = GLIDE_TIME; hh.dashReady = true;
          if (hh.pound) hh.pound = null;
          sfx.tone(260, 0.28, 'sine', 0.07, 820);
          fx.burst?.(b.pos.clone(), '#3ddc97', 16, 4);
          break;
        }
        default: break;
      }
    }
  }

  // ---------- switching ----------
  function select(i) {
    if (mode === 'intro') skipIntro();
    if (over || mode === 'won' || i < 0 || i >= heroes.length || i === active) return false;
    const prev = heroes[active];
    prev.active = false; prev.gliding = false;
    active = i;
    const hh = heroes[i];
    hh.active = true;
    if (mode === 'play') startSwoop(); else snapCamera();
    paintTeam(); paintHint();
    sfx.tone(523, 0.07, 'triangle', 0.05); sfx.tone(784, 0.1, 'triangle', 0.05, 0, 0.06);
    fx.sparkle?.(hh.body.pos.clone().setY(hh.body.pos.y + hh.S.height + 0.2), hh.S.color);
    if (!hh.hintShown && mode === 'play') {
      hh.hintShown = true;
      const t = touchUI ? {
        vera: 'Vera: hold JUMP to glide. ZAP hits nodes and drones from afar.',
        pix: 'Pix: JUMP twice for a double jump, DASH in the air — and she fits through low tunnels.',
        brick: 'Brick: pushes crates, holds heavy plates, walks through lasers. POUND smashes cracked floors.',
      }[hh.id] : {
        vera: 'Vera: hold Space to glide. E zaps nodes and drones from afar.',
        pix: 'Pix: Space twice for a double jump, Shift dashes, E sniffs out shards — and she fits through low tunnels.',
        brick: 'Brick: pushes crates, holds heavy plates, walks through lasers. Jump, then E: ground-pound.',
      }[hh.id];
      if (t) toast(api.toasts, t, 'info', 3400);
    }
    api.say(`Now playing ${hh.S.name}.`);
    return true;
  }
  function cycle(d) {
    if (heroes.length < 2) { if (mode === 'play') toast(api.toasts, 'Only Vera in this level.', 'info', 1400); return; }
    select((active + d + heroes.length) % heroes.length);
  }

  // ---------- HUD painting ----------
  function paintHearts(i, hit) {
    const c = cards[i];
    const hh = heroes[i];
    [...c.hearts.children].forEach((el, k) => el.classList.toggle('off', k >= hh.hearts));
    c.el.setAttribute('aria-label', `${hh.S.name}, ${hh.hearts} of ${hh.S.hearts} hearts${hh.active ? ', playing' : ''}. Key ${i + 1}.`);
    if (hit) { c.el.classList.remove('hit'); void c.el.offsetWidth; c.el.classList.add('hit'); }
    c.el.classList.toggle('low', hh.hearts <= 1);
  }
  function paintTeam() {
    cards.forEach((c, i) => { c.el.classList.toggle('on', i === active); c.el.setAttribute('aria-pressed', String(i === active)); paintHearts(i, false); });
  }
  const K = (t) => h('span', { class: 'g-key' }, t);
  function paintHint() {
    const hh = heroes[active];
    hintEl.textContent = '';
    hintEl.className = `nr-hint nr-hint--${hh.id}`;
    const parts = {
      vera: [K('Space'), ' jump · hold to ', h('b', null, 'glide'), ' ', meterEl, ' · ', K('E'), ' ', h('b', null, 'zap')],
      pix: [K('Space'), '×2 ', h('b', null, 'double jump'), ' · ', K('Shift'), ' ', h('b', null, 'dash'), ' ', meterEl, ' · ', K('E'), ' sniff · low tunnels'],
      brick: [K('Space'), ' + ', K('E'), ' ', h('b', null, 'ground-pound'), ' · pushes crates · heavy · laser-proof'],
    }[hh.id] || [];
    hintEl.append(h('span', { class: 'nr-hint-n' }, hh.S.name), ...parts);
    actIc.textContent = hh.S.glide ? '⚡' : hh.S.dash ? '»' : '▼';
    actTxt.textContent = hh.S.glide ? 'ZAP' : hh.S.dash ? 'DASH' : 'POUND';
    actBtn.setAttribute('aria-label', hh.S.glide ? 'Zap' : hh.S.dash ? 'Dash' : 'Ground-pound');
    actBtn.className = `nr-tb nr-tb--act nr-tb--${hh.id}`;
  }
  let shownSec = -1;
  let shownShards = -1;
  let shownMeter = -1;
  let shownCd = -1;
  let qPaintT = 0;
  function paintHud(dt) {
    const sec = Math.floor(st.time);
    if (sec !== shownSec) {
      shownSec = sec;
      timeEl.textContent = fmtTime(st.time);
      const v = bar.item('time');
      if (v) v.className = 'hud-v' + (st.time > par ? ' warn' : '');
    }
    if (W.shards !== shownShards) {
      const first = shownShards < 0;
      shownShards = W.shards;
      bar.set('shards', `${W.shards}/${W.shardsTotal || 0}`, (W.shardsTotal && W.shards >= W.shardsTotal ? 'good' : '') + (first ? '' : ' bump'));
    }
    const hh = heroes[active];
    let m = -1;
    if (hh.S.glide) m = hh.glideFuel / GLIDE_TIME;
    else if (hh.S.dash) m = hh.dashReady && hh.dashT <= 0 ? 1 : 0;
    m = Math.round(m * 50) / 50;
    if (m !== shownMeter) {
      shownMeter = m;
      meter.style.width = `${Math.round(Math.max(0, m) * 100)}%`;
      meterEl.classList.toggle('empty', m <= 0);
      jumpBtn.style.setProperty('--fuel', hh.S.glide && !hh.body.grounded ? String(m) : '1');
    }
    const cd = hh.S.glide ? Math.round((hh.zapCd / ZAP_CD) * 20) / 20 : hh.S.dash ? (hh.dashReady ? 0 : 1) : 0;
    if (cd !== shownCd) { shownCd = cd; actBtn.style.setProperty('--cd', String(cd)); }
    qPaintT -= dt;
    if (qPaintT <= 0) { qPaintT = 2; paintQuality(); }
  }

  // ---------- quality ----------
  let qPref = readQuality();
  function paintQuality() {
    const tier = R.quality || 'high';
    const label = qPref === 'auto' ? `Auto · ${tier}` : qPref[0].toUpperCase() + qPref.slice(1);
    qBtn.textContent = '';
    qBtn.append(h('span', { class: 'nr-q-ic', 'aria-hidden': 'true' }, '◈'), h('span', { class: 'nr-q-t' }, label));
    qBtn.setAttribute('aria-label', `Graphics quality: ${label}. Click to change.`);
    qBtn2.textContent = `Graphics: ${label}`;
  }
  function setQuality(qv) {
    if (!QUALITIES.includes(qv)) return;
    qPref = qv;
    saveQuality(qv);
    try { R.setQuality(qv); } catch (err) { if (debug) console.warn(err); }
    paintQuality();
    fit();
    needRender = true;
  }
  function cycleQuality() { setQuality(QUALITIES[(QUALITIES.indexOf(qPref) + 1) % QUALITIES.length]); sfx.click(); }

  // ---------- pause ----------
  function togglePause(force) {
    const want = typeof force === 'boolean' ? force : !paused;
    if (want === paused || over || !W) return;
    paused = want;
    pauseEl.hidden = !paused;
    view.classList.toggle('nr-paused', paused);
    pauseIc.textContent = paused ? '▶' : '❚❚';
    pauseTxt.textContent = paused ? 'Resume' : 'Pause';
    pauseBtn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    if (paused) {
      clearInput();
      needRender = true;
      paintQuality();
      if (!touchUI) resumeBtn.focus({ preventScroll: true });
    } else api.stage.focus({ preventScroll: true });
    api.say(paused ? 'Paused.' : 'Resumed.');
  }

  // ---------- win ----------
  function win() {
    if (over) return;
    over = true;
    mode = 'won';
    const total = W.shardsTotal || 0;
    const got = Math.min(total, W.shards || 0);
    const all = got >= total;
    const fast = st.time <= par;
    const stars = 1 + (all ? 1 : 0) + (fast ? 1 : 0);
    const score = Math.max(100, 1000 + got * 100 + (all ? 500 : 0) + Math.max(0, Math.round((par - st.time) * 10)) + st.enemies * 50 - st.respawns * 50);
    heroes.forEach((hh) => { hh.gliding = false; if (hh.dashT > 0) endDash(hh, false); });
    for (const hh of heroes) fx.burst?.(hh.body.pos.clone().setY(hh.body.pos.y + 1), hh.S.color, 26, 4);
    view.classList.add('nr-won');
    cam.manualT = 0;
    const say = stars === 3 ? 'Every shard, under par, everyone through. That’s how a team does it!'
      : !all && !fast ? 'We made it! There are shards left behind — and the clock beat us this time.'
        : !all ? 'Through the rift! A few shards are still out there.' : 'Every shard! Now let’s do it under par.';
    api.finish({
      won: true, stars, score,
      title: stars === 3 ? 'Flawless rift run' : 'Rift cleared',
      say,
      stats: [['Time', fmtTime(st.time)], ['Par', `${fmtTime(par)}${fast ? ' ✓' : ''}`], ['Shards', `${got} / ${total}`],
        ['Respawns', String(st.respawns)], ...(st.enemies ? [['Enemies', String(st.enemies)]] : [])],
      lesson: lv.lesson,
      delay: motion ? 1900 : 900,
    });
  }

  // ---------- layout ----------
  function fit() {
    const full = api.stage.classList.contains('stage--full');
    api.area.classList.toggle('nr-area--touch', touchUI);
    view.classList.toggle('nr-touchui', touchUI);
    api.stage.classList.toggle('stage--nr-touch', touchUI);
    if (full) view.style.height = '';
    else {
      const header = document.querySelector('header');
      const top = header ? header.getBoundingClientRect().height : 0;
      const w = view.clientWidth || api.area.clientWidth || 640;
      const tipsH = touchUI ? 0 : tips.getBoundingClientRect().height + 10;
      const avail = window.innerHeight - top - tipsH - 60;
      const hgt = clamp(Math.min(avail, w * (w < 600 ? 1.5 : 0.66)), 300, 980);
      view.style.height = `${Math.round(hgt)}px`;
    }
    resize();
    placeToasts();
  }
  function placeToasts() {
    const sr = api.stage.getBoundingClientRect();
    const below = touchUI && heroes.length ? teamEl : bar.el;
    const r = below.getBoundingClientRect();
    const top = (touchUI ? r.bottom : r.top + Math.min(r.height, 64)) - sr.top + 8;
    api.stage.style.setProperty('--nr-toast-top', `${Math.max(8, Math.round(top))}px`);
  }
  let lastW = 0;
  let lastH = 0;
  let aspectK = 1;     // a tall, narrow view (a phone held upright) sees little sideways: pull the camera back
  function resize() {
    const w = Math.max(1, Math.round(view.clientWidth));
    const hgt = Math.max(1, Math.round(view.clientHeight));
    if (w === lastW && hgt === lastH) return;
    lastW = w; lastH = hgt;
    const asp = w / hgt;
    aspectK = asp < 0.95 ? 1 + (0.95 - asp) * 0.5 : 1;
    try { R.setSize(w, hgt); } catch (err) { if (debug) console.warn(err); }
    needRender = true;
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(view);
  const onResize = () => fit();
  window.addEventListener('resize', onResize);
  // leaving full screen in the middle of a run pauses it; either way the layout is redone
  const onFull = (e) => {
    if (!e.detail && mode === 'play' && !paused && !over) togglePause(true);
    window.requestAnimationFrame(fit);
  };
  api.stage.addEventListener('g-fullscreen', onFull);
  const onLost = (e) => {
    e.preventDefault();
    if (over) return;
    if (!paused) togglePause(true);
    toast(api.toasts, 'The browser reset the 3D graphics. Choose “All levels” and start again.', 'bad', 6000);
  };
  canvas.addEventListener('webglcontextlost', onLost);

  // ---------- frame ----------
  function frame(dt) {
    pollPad();
    if (paused) {
      if (needRender) { needRender = false; try { R.render(0); } catch { /* ignore */ } }
      return;
    }
    clock += dt;
    if (mode === 'play' && !over) st.time += dt;
    shardT = Math.max(0, shardT - dt);
    const input = mode === 'play' && !over ? readInput() : null;
    press.jump = press.action = press.dash = false;
    // the heroes: the active one gets the input, the others idle where they are
    const steps = Math.max(1, Math.min(4, Math.ceil(dt / MAX_STEP)));
    const h2 = dt / steps;
    for (let k = 0; k < steps; k++) {
      for (const hh of heroes) stepHero(hh, h2, hh.active ? input : null);
      if (input) { input.jumpPressed = false; input.actionPressed = false; input.dashPressed = false; }
    }
    let evs = null;
    try { evs = W.update(clock, dt, heroes); } catch (err) { if (debug) console.warn(err); }
    onEvents(evs);
    for (const hh of heroes) animateHero(hh, dt);
    if (mode === 'intro' && intro) updateIntro(dt);
    else updateCamera(dt, input);
    paintHud(dt);
    try { R.setShadowFocus?.(heroes[active].body.pos); } catch { /* ignore */ }
    try { fx.update?.(dt); } catch (err) { if (debug) console.warn(err); }
    try { R.render(dt); } catch (err) { if (debug) console.warn(err); }
    needRender = false;
  }
  function animateHero(hh, dt) {
    const b = hh.body;
    const air = !b.grounded && (hh.sinceGround > 0.09 || b.vel.y > 0.5);
    let a;
    if (!hh.alive) a = 'dead';
    else if (over) a = 'cheer';
    else if (hh.hurtT > 0) a = 'hurt';
    else if (hh.pound) a = hh.pound === 'hop' ? 'jump' : 'pound';
    else if (hh.zapT > 0) a = 'zap';
    else if (hh.dashT > 0) a = 'dash';
    else if (hh.gliding) a = 'glide';
    else if (air) a = b.vel.y > 0 ? (hh.doubleT > 0 ? 'double' : 'jump') : 'fall';
    else if (b.pushing && hh.speedSm > 0.15) a = 'push';
    else a = hh.speedSm > 0.4 ? 'run' : 'idle';
    const s = hh.s;
    s.speed = hh.speedSm; s.vy = b.vel.y; s.grounded = !!b.grounded; s.action = a; s.active = hh.active; s.blink = hh.inv > 0;
    hh.root.position.copy(b.pos);
    hh.root.rotation.y = hh.yawVis;
    try { hh.model.update(clock, dt, s); } catch (err) { if (debug) console.warn(err); }
  }

  // ---------- start ----------
  paintTeam(); paintHint(); paintQuality();
  fit();
  if (motion) buildIntro();
  else { mode = 'play'; snapCamera(); updateCamera(0, null); later(() => endIntroBanner(), 1400); }
  function endIntroBanner() { banner.classList.add('out'); later(() => banner.remove(), 600); }
  if (!motion) {
    for (const t of pendingTips.splice(0)) tip(t);
    api.say(`${lv.name}. Get ${heroes.length > 1 ? 'every hero' : 'Vera'} into the portal.`);
  }
  const stopLoop = loop((raw) => { frame(raw * speed); return true; });

  // ---------- debug hook (?debug only) ----------
  if (debug) {
    const vec = (v) => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
    const virtBtn = { jump: 0, action: 0, dash: 0 };
    window.__nr = {
      world: W,
      get R() { return R; },
      THREE,
      state: () => ({
        level: api.index + 1, name: lv.name, mode, paused, over, time: +st.time.toFixed(2), par,
        shards: W.shards, shardsTotal: W.shardsTotal, active: heroes[active].id, heroes: heroes.map((x) => x.id),
        respawns: st.respawns, teamWipes: st.teamWipes, enemies: st.enemies, zaps: st.zaps, hits: st.hits, tips: shownTips,
        portal: portalIn, quality: qPref, tier: R.quality, touchUI, checkpoint: vec(cp.pos),
        cam: { yaw: +cam.yaw.toFixed(3), pitch: +cam.pitch.toFixed(3), dist: +cam.dist.toFixed(2), cur: +cam.cur.toFixed(2), pos: vec(camera.position), focus: vec(cam.disp), swoop: !!cam.swoop },
        stats: R.stats ? R.stats() : null,
      }),
      team: () => heroes.map((x) => ({
        id: x.id, active: x.active, pos: vec(x.body.pos), vel: vec(x.body.vel), grounded: !!x.body.grounded, hearts: x.hearts,
        action: x.s.action, inv: +x.inv.toFixed(2), gliding: x.gliding, glideFuel: +x.glideFuel.toFixed(2), airJumps: x.airJumps,
        dashReady: x.dashReady, dashing: x.dashT > 0, lastDash: +x.lastDash.toFixed(3), pound: x.pound, yaw: +x.yawVis.toFixed(3), pushing: !!x.body.pushing, alive: x.alive,
      })),
      setPos(id, x, y, z) {
        const i = heroIndex(id);
        if (i < 0) return false;
        const hh = heroes[i];
        hh.body.pos.set(x, y, z); hh.body.vel.set(0, 0, 0); hh.body.grounded = false; hh.body.ground = null;
        hh.prev.copy(hh.body.pos); hh.root.position.copy(hh.body.pos);
        if (hh.active) snapCamera();
        return true;
      },
      teleport(x, y, z) { return this.setPos(heroes[active].id, x, y, z); },
      select: (id) => select(typeof id === 'number' ? id : heroIndex(id)),
      press(name, ms = 90) {
        if (name === 'jump') { press.jump = true; virt.jump = true; virtBtn.jump++; const n = virtBtn.jump; later(() => { if (virtBtn.jump === n) virt.jump = false; }, ms); }
        else if (name === 'action') press.action = true;
        else if (name === 'dash') press.dash = true;
        else if (name === 'switch' || name === 'next') cycle(1);
        else if (name === 'prev') cycle(-1);
        else if (name === 'pause') togglePause();
        else if (name === 'recenter') recenter();
        else return false;
        return true;
      },
      hold(name, on = true) { if (name === 'jump') { virt.jump = !!on; if (on) press.jump = true; } return true; },
      move(x, y, ms = 0) { virt.on = !!(x || y); virt.x = x; virt.y = y; virt.world = false; virt.until = ms ? performance.now() + ms : 0; return true; },
      moveWorld(x, z, ms = 0) { virt.on = !!(x || z); virt.x = x; virt.y = z; virt.world = true; virt.until = ms ? performance.now() + ms : 0; return true; },
      camera(yaw, pitch, dist) {
        if (typeof yaw === 'number') cam.yaw = yaw;
        if (typeof pitch === 'number') cam.pitch = clamp(pitch, CAM.pitchMin, CAM.pitchMax);
        if (typeof dist === 'number') cam.dist = clamp(dist, CAM.min, CAM.max);
        cam.manualT = 0;
        return true;
      },
      look(dx, dy) { look.dx += dx; look.dy += dy; },
      zoom(f) { look.zoom *= f; },
      skip: () => skipIntro(),
      pause: (on) => togglePause(on),
      quality: (qv) => { if (qv) setQuality(qv); return { pref: qPref, tier: R.quality }; },
      cycleQuality,
      hurt: (id, dmg = 1, from) => hurt({ type: 'hurt', hero: id || heroes[active].id, dmg, from: from || null }),
      fall: (id) => fell({ type: 'void', hero: id || heroes[active].id }),
      emit: (ev) => onEvents([ev]),
      win: () => win(),
      raycast: (o, d, m, opt) => W.raycast(new THREE.Vector3(...o), new THREE.Vector3(...d).normalize(), m, opt),
    };
  }

  // ---------- cleanup: everything this level made goes away ----------
  return () => {
    stopLoop();
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    document.removeEventListener('keydown', onDown);
    document.removeEventListener('keyup', onUp);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVis);
    api.stage.removeEventListener('g-fullscreen', onFull);
    api.stage.removeEventListener('pointerdown', onAnyPointer, true);
    view.removeEventListener('wheel', onWheel);
    view.removeEventListener('touchmove', onTouchMove);
    canvas.removeEventListener('webglcontextlost', onLost);
    ro?.disconnect();
    for (const hh of heroes) { try { hh.trail?.stop(); } catch { /* ignore */ } }
    try { W.dispose(); } catch (err) { console.warn('Neon Rift: world cleanup failed', err); }
    for (const hh of heroes) {
      hh.root.removeFromParent();
      try { hh.model.dispose(); } catch (err) { console.warn('Neon Rift: hero cleanup failed', err); }
    }
    let gl = null;
    try { gl = R.renderer && R.renderer.getContext(); } catch { gl = null; }
    try { R.dispose(); } catch (err) { console.warn('Neon Rift: renderer cleanup failed', err); }
    // make sure the WebGL context is released now, not whenever the garbage collector gets to it
    try { if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* ignore */ }
    canvas.remove();
    view.remove();
    tips.remove();
    if (debug) delete window.__nr;
  };
}

const root = document.getElementById('game');
if (root) {
  new Game(root, {
    id: 'neon-rift',
    title: 'Neon Rift',
    levels: LEVELS,
    immersive: true,
    controls: 'Move: WASD or arrows (the camera decides where forward is) · Jump: Space — hold for a higher jump; Vera glides while you hold it · E: ability — Vera zaps, Brick ground-pounds (in the air), Pix sniffs out shards · Shift: Pix dashes · Switch hero: Tab or 1 2 3 · Camera: drag with the mouse, Z / X, wheel zooms · P pause · F full screen · M sound · Esc levels. Phone: thumb stick, JUMP / ACTION / SWITCH, drag to look, pinch to zoom. Gamepad: sticks, A jump, X ability, B dash, LB/RB switch, Start pause.',
    howto: 'Every hero in a level has to stand in the portal to open it. Shards and the par time earn the other two stars. Progress is saved in this browser only.',
    play,
  });
}
