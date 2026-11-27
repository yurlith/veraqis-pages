// NEON RIFT — world.js (owner: world): level runtime, character physics and enemy AI.
// buildWorld(def, { R, models, render }) -> W; the contract is _dev/NEONRIFT.md.
// Bodies are vertical cylinders (pos = centre of the feet) against AABBs: swept vertically, pushed out
// horizontally, in sub-steps short enough that nothing tunnels at 30 m/s. Static blocks live in a uniform XZ
// grid; movers, crumbles, doors, cracked blocks, crates and turrets form a short dynamic list.
// moveBody, update and raycast allocate nothing per frame — only events, and only when something happens.
// Conventions (shared with levels.js): blocks, movers, crumbles, doors, cracked blocks, crates, spikes and
// surfaces are centre + size; point items (checkpoint, portal, plate, switch, node, bounce, sign, tips,
// crawlers, turrets) stand on the floor at p; shards float at p; sentries and the warden hover with their eye at p.
//
// Beyond the contract (all optional for the game):
//   moveBody(body, dt) returns a reused array of contacts { what: 'ground'|'wall'|'ceiling'|'push'|'hero'|'stomp',
//     kind, ref, normal } carrying summary fields (grounded, ground, ceiling, wall, pushed, landed, impact, step, water,
//     stomp); it also sets body.pushing (a heavy body moved a crate) and body.water. Call it for every hero every frame.
//   raycast/zap results come from a ring of 8 reused objects (valid for the next 7 calls); zap hits carry
//   effect: 'stun'|'damage'|'destroy'|'shield'|'on'|'off'|'none'.
//   W.checkpoint { index (-1 = start), pos, yaw, heroes: { id: Vector3 } } · W.spawn.heroes · W.placeTeam(pos, yaw)
//   W.aim(origin, dir, range = 14, coneDeg = 25) -> { point, kind, ref, dist } | null (zap aim assist)
//   W.signal(id) · W.killY · W.bounds · W.group · W.warnings · W.stats() · W.clearShots() · W.debug (tests)
//   Extra events: { type: 'break', pos } · { type: 'shot', pos, kind } · { type: 'crumble', pos }; extra fields: hurt.kind,
//   shard.hero, checkpoint.yaw, bounce.pos/power, enemyDown.how, alarm.kind. The warden's defeat turns signal 'warden' on.
import * as THREE from '../vendor/three.min.js';

const GRAVITY = 26;           // the game applies it to heroes; the world to crates and crawlers
const MAX_FALL = 30;
const STEP = 0.35;            // walk onto ledges this high without jumping
const CELL = 4;               // broad-phase grid cell (m)
const SKIN = 0.002;           // gap kept from a wall after a push-out
const PROBE = 0.03;           // how far below the feet the ground is looked for
const PUSH_SPEED = 2.6;       // the fastest a heavy body moves a crate
const WATER_SLOW = 0.55;      // horizontal speed factor in water
const WATER_SINK = 3;         // max sinking speed in water
const HURT_CD = 1;            // one hurt per hero per second at most
const SPAWN_SAFE = 1.5;       // unhurt and unseen right after a respawn
const KNOCK = 6.5;            // knock-back, horizontal and upward
const KNOCK_UP = 5.5;
const PORTAL_R = 1.8;
const PLATE_R = 0.8;          // hero centre within this of a plate presses it
const SWITCH_R = 1.15;
const SHARD_R = 0.95;         // shard to the hero's body axis
const CHECK_R = 1.4;
const PAD_R = 0.85;
const GATE_R = 1.0;
const LASER_R = 0.1;
const ZAP_ASSIST = 0.45;      // the zap beam is this "fat" when it looks for targets
const DOOR_SOLID = 0.8;       // a door blocks until it is this far open
const MAX_SHOTS = 96;
const STEER = [0.45, 0.9, 1.35, 1.7, 2.2, 2.7];   // crawler detours to try on either side (rad)
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const UPV = new THREE.Vector3(0, 1, 0);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const at = (a, i, d = 0) => (a && typeof a[i] === 'number' && Number.isFinite(a[i]) ? a[i] : d);
const fin = Number.isFinite;
function wrapAngle(a) { a %= TAU; return a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a; }
function turnTo(a, b, max) { const d = wrapAngle(b - a); return a + (d > max ? max : d < -max ? -max : d); }

// Circle (x, z, r) against a box footprint: penetration depth (0 = apart) and the push-out normal in NRM.
const NRM = { x: 0, z: 0 };
function circleRect(x, z, r, c) {
  const qx = x < c.minX ? c.minX : x > c.maxX ? c.maxX : x;
  const qz = z < c.minZ ? c.minZ : z > c.maxZ ? c.maxZ : z;
  const dx = x - qx;
  const dz = z - qz;
  const d2 = dx * dx + dz * dz;
  if (d2 > 1e-12) {
    if (d2 >= r * r) return 0;
    const d = Math.sqrt(d2);
    NRM.x = dx / d; NRM.z = dz / d;
    return r - d;
  }
  // centre inside the footprint: leave through the nearest side
  let m = x - c.minX; NRM.x = -1; NRM.z = 0;
  let e = c.maxX - x; if (e < m) { m = e; NRM.x = 1; NRM.z = 0; }
  e = z - c.minZ; if (e < m) { m = e; NRM.x = 0; NRM.z = -1; }
  e = c.maxZ - z; if (e < m) { m = e; NRM.x = 0; NRM.z = 1; }
  return m + r;
}
function footOverlap(x, z, r, c) {
  const qx = x < c.minX ? c.minX : x > c.maxX ? c.maxX : x;
  const qz = z < c.minZ ? c.minZ : z > c.maxZ ? c.maxZ : z;
  const dx = x - qx;
  const dz = z - qz;
  return dx * dx + dz * dz < r * r;
}
// Squared distance between segments p + u·s and q + v·t (s, t in 0..1); the parameters land in SS.
const SS = { s: 0, t: 0 };
function segSeg(px, py, pz, ux, uy, uz, qx, qy, qz, vx, vy, vz) {
  const rx = px - qx; const ry = py - qy; const rz = pz - qz;
  const a = ux * ux + uy * uy + uz * uz;
  const e = vx * vx + vy * vy + vz * vz;
  const f = vx * rx + vy * ry + vz * rz;
  let s = 0; let t = 0;
  if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0; } else if (a <= 1e-12) { t = clamp(f / e, 0, 1); } else {
    const c = ux * rx + uy * ry + uz * rz;
    if (e <= 1e-12) { s = clamp(-c / a, 0, 1); } else {
      const b = ux * vx + uy * vy + uz * vz;
      const den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  SS.s = s; SS.t = t;
  const dx = px + ux * s - qx - vx * t;
  const dy = py + uy * s - qy - vy * t;
  const dz = pz + uz * s - qz - vz * t;
  return dx * dx + dy * dy + dz * dz;
}
// Ray against a box (slabs). Boxes that contain the origin are ignored. Entry distance and axis land in RB.
const RB = { t: 0, axis: 0 };
function rayBox(ox, oy, oz, dx, dy, dz, c, maxT) {
  let t0 = -Infinity; let t1 = Infinity; let ax = -1;
  if (dx !== 0) {
    let a = (c.minX - ox) / dx; let b = (c.maxX - ox) / dx;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) { t0 = a; ax = 0; }
    if (b < t1) t1 = b;
  } else if (ox <= c.minX || ox >= c.maxX) return false;
  if (dy !== 0) {
    let a = (c.minY - oy) / dy; let b = (c.maxY - oy) / dy;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) { t0 = a; ax = 1; }
    if (b < t1) t1 = b;
  } else if (oy <= c.minY || oy >= c.maxY) return false;
  if (dz !== 0) {
    let a = (c.minZ - oz) / dz; let b = (c.maxZ - oz) / dz;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) { t0 = a; ax = 2; }
    if (b < t1) t1 = b;
  } else if (oz <= c.minZ || oz >= c.maxZ) return false;
  if (t1 < t0 || t0 < 0 || t0 >= maxT) return false;
  RB.t = t0; RB.axis = ax;
  return true;
}
// Uniform XZ grid over the static boxes (each box listed in every cell it touches).
function makeGrid(cols) {
  let x0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let z1 = -Infinity;
  for (const c of cols) {
    if (c.minX < x0) x0 = c.minX; if (c.minZ < z0) z0 = c.minZ;
    if (c.maxX > x1) x1 = c.maxX; if (c.maxZ > z1) z1 = c.maxZ;
  }
  if (!cols.length) { x0 = z0 = -1; x1 = z1 = 1; }
  let cell = CELL;
  while (Math.ceil((x1 - x0) / cell) * Math.ceil((z1 - z0) / cell) > 65536) cell *= 2;
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell));
  const nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  const cells = new Array(nx * nz);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  for (const c of cols) {
    const ix0 = clamp(Math.floor((c.minX - x0) / cell), 0, nx - 1);
    const ix1 = clamp(Math.floor((c.maxX - x0) / cell), 0, nx - 1);
    const iz0 = clamp(Math.floor((c.minZ - z0) / cell), 0, nz - 1);
    const iz1 = clamp(Math.floor((c.maxZ - z0) / cell), 0, nz - 1);
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) cells[iz * nx + ix].push(c);
  }
  return { x0, z0, nx, nz, cell, cells };
}
const list = () => ({ a: [], n: 0 });

export function buildWorld(def, { R = null, models = null, render = null } = {}) {
  def = def || {};
  const scene = R && R.scene ? R.scene : null;
  const group = new THREE.Group();
  group.name = 'neonrift-world';
  if (scene) scene.add(group);
  const warnings = [];
  const owned = [];               // visuals from render/models (each has dispose())
  const ownGeo = [];
  const ownMat = [];
  const killY = num(def.killY, -15);
  const items = Array.isArray(def.items) ? def.items : [];
  const events = [];
  const pending = [];             // events raised outside update() (zap, pound, stomps) wait for the next one
  let inUpdate = false;
  const CLK = { now: 0 };         // the level clock (an object field: no number boxing per write)
  let disposed = false;
  let seed = 0x2f6b1d3;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const emit = (e) => { (inUpdate ? events : pending).push(e); };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  // ---------------------------------------------------------------- visuals from the other modules
  const blank = () => ({ root: new THREE.Group(), anchors: {}, update() {}, dispose() {} });
  const errText = (err) => (err && err.message ? err.message : String(err));
  function adopt(o, what) {
    if (o && !o.root) { warnings.push(`${what} returned no root`); o = null; }
    o = o || blank();
    group.add(o.root);
    owned.push(o);
    return o;
  }
  function newProp(type, opts) {
    let o = null;
    if (models && typeof models.makeProp === 'function') {
      try { o = models.makeProp(type, opts || {}); } catch (err) { warnings.push(`makeProp('${type}'): ${errText(err)}`); }
    }
    return adopt(o, `makeProp('${type}')`);
  }
  function newEnemyVis(type) {
    let o = null;
    if (models && typeof models.makeEnemy === 'function') {
      try { o = models.makeEnemy(type); } catch (err) { warnings.push(`makeEnemy('${type}'): ${errText(err)}`); }
    }
    return adopt(o, `makeEnemy('${type}')`);
  }
  function newStatic(blocks) {
    let o = null;
    if (render && typeof render.buildStatic === 'function') {
      try { o = render.buildStatic(blocks, R); } catch (err) { warnings.push(`buildStatic: ${errText(err)}`); }
    }
    return adopt(o, 'buildStatic');
  }
  function newSurface(type, w, d) {
    let o = null;
    if (render && typeof render.makeSurface === 'function') {
      try { o = render.makeSurface(type, w, d, R); } catch (err) { warnings.push(`makeSurface('${type}'): ${errText(err)}`); }
    }
    if (!o || !o.mesh) o = { mesh: new THREE.Group(), update() {}, dispose() {} };
    group.add(o.mesh);
    owned.push(o);
    return o;
  }
  const fx = (name, ...args) => {
    const f = R && R.fx && R.fx[name];
    if (typeof f === 'function') { try { f.apply(R.fx, args); } catch { /* effects are optional */ } }
  };

  // ---------------------------------------------------------------- signals
  const signals = new Map();
  const sigList = [];
  function sig(id) {
    const k = String(id);
    let s = signals.get(k);
    if (!s) { s = { id: k, on: false, next: false, latch: false }; signals.set(k, s); sigList.push(s); }
    return s;
  }
  function bindWhen(rec, when, logic) {
    rec.sigs = null; rec.any = logic === 'any';
    if (when === undefined || when === null || when === '') return;
    const ids = Array.isArray(when) ? when : [when];
    rec.sigs = ids.filter((x) => x !== undefined && x !== null && x !== '').map(sig);
    if (!rec.sigs.length) rec.sigs = null;
  }
  function cond(rec) {
    const s = rec.sigs;
    if (!s) return false;
    if (rec.any) { for (let i = 0; i < s.length; i++) if (s[i].on) return true; return false; }
    for (let i = 0; i < s.length; i++) if (!s[i].on) return false;
    return true;
  }

  // ---------------------------------------------------------------- static geometry
  function boxRec(kind, p, s, src) {
    const sx = Math.abs(at(s, 0, 1)); const sy = Math.abs(at(s, 1, 1)); const sz = Math.abs(at(s, 2, 1));
    const r = { kind, src, solid: true, stamp: 0, x: at(p, 0), y: at(p, 1), z: at(p, 2), hx: sx / 2, hy: sy / 2, hz: sz / 2,
      minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    syncBox(r);
    return r;
  }
  function syncBox(r) {
    r.minX = r.x - r.hx; r.maxX = r.x + r.hx; r.minY = r.y - r.hy; r.maxY = r.y + r.hy; r.minZ = r.z - r.hz; r.maxZ = r.z + r.hz;
  }
  const blocks = (Array.isArray(def.blocks) ? def.blocks : []).filter((b) => b && Array.isArray(b.p) && Array.isArray(b.s));
  const statics = blocks.map((b) => boxRec('static', b.p, b.s, b));
  const grid = makeGrid(statics);
  const bounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const c of statics) {
    bounds.minX = Math.min(bounds.minX, c.minX); bounds.minY = Math.min(bounds.minY, c.minY); bounds.minZ = Math.min(bounds.minZ, c.minZ);
    bounds.maxX = Math.max(bounds.maxX, c.maxX); bounds.maxY = Math.max(bounds.maxY, c.maxY); bounds.maxZ = Math.max(bounds.maxZ, c.maxZ);
  }
  if (blocks.length) newStatic(blocks);
  const dyn = [];                 // dynamic solids: movers, crumbles, doors, cracked, crates, turrets

  // Highest static top at (x, z) within [y - below, y + above], or null — placement helper.
  function staticTop(x, y, z, below, above) {
    const g = grid;
    const ix = Math.floor((x - g.x0) / g.cell); const iz = Math.floor((z - g.z0) / g.cell);
    if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) return null;
    let best = null;
    for (const c of g.cells[iz * g.nx + ix]) {
      if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) continue;
      if (c.maxY < y - below || c.maxY > y + above) continue;
      if (best === null || c.maxY > best) best = c.maxY;
    }
    return best;
  }
  // Boxes are centre + size; if p sits exactly on a floor top instead, it was meant as the base.
  function boxCentreY(p, sy) {
    const y = at(p, 1);
    const top = staticTop(at(p, 0), y, at(p, 2), 0.06, 0.06);
    return top !== null && sy > 0.2 ? y + sy / 2 : y;
  }

  // ---------------------------------------------------------------- query lists and the broad phase
  const CAND = list();            // moveBody candidates
  const LS = list();              // crate sweeps
  const LQ = list();              // misc queries
  let stampN = 1;
  // query stamps stay small integers (a counter past 2^30 would be boxed): wrap and clear them now and then
  function nextStamp() {
    if (++stampN > 0x3fffff00) {
      stampN = 1;
      for (const c of statics) c.stamp = 0;
      for (const c of dyn) c.stamp = 0;
    }
    return stampN;
  }
  function gather(L, minX, minY, minZ, maxX, maxY, maxZ, skip) {
    L.n = 0;
    const st = nextStamp();
    const g = grid;
    const ix0 = Math.max(0, Math.floor((minX - g.x0) / g.cell));
    const ix1 = Math.min(g.nx - 1, Math.floor((maxX - g.x0) / g.cell));
    const iz0 = Math.max(0, Math.floor((minZ - g.z0) / g.cell));
    const iz1 = Math.min(g.nz - 1, Math.floor((maxZ - g.z0) / g.cell));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const cell = g.cells[iz * g.nx + ix];
        for (let k = 0; k < cell.length; k++) {
          const c = cell[k];
          if (c.stamp === st) continue;
          c.stamp = st;
          if (c.maxY < minY || c.minY > maxY || c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
          L.a[L.n++] = c;
        }
      }
    }
    for (let k = 0; k < dyn.length; k++) {
      const c = dyn[k];
      if (!c.solid || c === skip) continue;
      if (c.maxY < minY || c.minY > maxY || c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
      L.a[L.n++] = c;
    }
  }

  // ---------------------------------------------------------------- heroes (the game's bodies)
  const heroRecs = [];            // { kind: 'hero', id, body, alive, active }
  function heroFor(body, id) {
    for (let i = 0; i < heroRecs.length; i++) if (heroRecs[i].body === body) return heroRecs[i];
    const key = id !== undefined ? id : body.id;
    for (let i = 0; i < heroRecs.length; i++) if (heroRecs[i].id === key) { heroRecs[i].body = body; return heroRecs[i]; }
    const h = { kind: 'hero', id: key, body, alive: true, active: false, solid: true, seen: false };
    heroRecs.push(h);
    return h;
  }
  function bst(body) {
    let s = body._nr;
    if (!s) {
      s = body._nr = { wall: new THREE.Vector3(), carrier: null, cx: 0, cy: 0, cz: 0, hurtT: 0, safeT: 0, voidT: 0, gateT: 0, inKill: false,
        lx: NaN, ly: NaN, lz: NaN, okX: 0, okY: 0, okZ: 0, ok: false };
    }
    return s;
  }

  // ---------------------------------------------------------------- movers
  const movers = [];
  for (const m of Array.isArray(def.movers) ? def.movers : []) {
    if (!m || !Array.isArray(m.p) || !Array.isArray(m.s)) continue;
    const r = boxRec('mover', m.p, m.s, m);
    const pts = [];
    const path = Array.isArray(m.path) ? m.path.filter(Array.isArray) : [];
    const first = path[0];
    if (!first || Math.hypot(at(first, 0) - r.x, at(first, 1) - r.y, at(first, 2) - r.z) > 0.01) pts.push([r.x, r.y, r.z]);
    for (const q of path) {
      const pt = [at(q, 0), at(q, 1), at(q, 2)];
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1], pt[2] - last[2]) > 1e-4) pts.push(pt);
    }
    r.route = pts; r.i = 0; r.dir = 1; r.u = 0; r.wait = 0;
    r.speed = Math.max(0.01, num(m.speed, 2)); r.waitTime = Math.max(0, num(m.wait, 0.5)); r.loop = m.mode === 'loop';
    r.vel = new THREE.Vector3();
    bindWhen(r, m.when, m.logic);
    r.x = pts[0][0]; r.y = pts[0][1]; r.z = pts[0][2];
    syncBox(r);
    r.s = { moving: false };
    r.prop = newProp('mover', { size: [r.hx * 2, r.hy * 2, r.hz * 2], material: m.m, tint: m.tint });
    r.prop.root.position.set(r.x, r.minY, r.z);
    movers.push(r); dyn.push(r);
  }
  function moverNext(m) {
    const n = m.route.length;
    if (m.loop) return (m.i + 1) % n;
    const j = m.i + m.dir;
    return j < 0 || j >= n ? m.i - m.dir : j;
  }
  function stepMover(m, dt) {
    const ox = m.x; const oy = m.y; const oz = m.z;
    const pts = m.route; const n = pts.length;
    const run = n > 1 && dt > 0 && (!m.sigs || cond(m));
    if (run) {
      let left = m.speed * dt;
      if (m.wait > 0) { m.wait -= dt; left = m.wait < 0 ? -m.wait * m.speed : 0; if (m.wait < 0) m.wait = 0; }
      let guard = 0;
      while (left > 1e-9 && guard++ < 16) {
        const a = pts[m.i]; const b = pts[moverNext(m)];
        const L = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2);
        const rem = L - m.u;
        if (left < rem) { m.u += left; left = 0; break; }
        left -= Math.max(0, rem);
        m.i = moverNext(m); m.u = 0;
        if (!m.loop) { if (m.i === n - 1) m.dir = -1; else if (m.i === 0) m.dir = 1; }
        if (m.waitTime > 0) { m.wait = m.waitTime; left = 0; }
      }
      const a = pts[m.i]; const b = pts[moverNext(m)];
      const L = Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2);
      const k = L > 1e-9 ? m.u / L : 0;
      m.x = a[0] + (b[0] - a[0]) * k; m.y = a[1] + (b[1] - a[1]) * k; m.z = a[2] + (b[2] - a[2]) * k;
    }
    if (dt > 0) m.vel.set((m.x - ox) / dt, (m.y - oy) / dt, (m.z - oz) / dt); else m.vel.set(0, 0, 0);
    m.s.moving = m.vel.lengthSq() > 1e-6;
    syncBox(m);
  }

  // ---------------------------------------------------------------- crumbling platforms
  const crumbles = [];
  for (const c of Array.isArray(def.crumbles) ? def.crumbles : []) {
    if (!c || !Array.isArray(c.p) || !Array.isArray(c.s)) continue;
    const r = boxRec('crumble', c.p, c.s, c);
    r.state = 'idle'; r.t = 0; r.delay = Math.max(0, num(c.delay, 0.6)); r.back = Math.max(0.5, num(c.back, 3));
    r.once = !!c.once;                       // gone for good once it falls
    bindWhen(r, c.when, c.logic);            // with `when` it falls when its signal comes on (not when stepped on)
    const blk = { p: [0, 0, 0], s: [r.hx * 2, r.hy * 2, r.hz * 2], m: c.m || 'stone' };
    if (c.tint) blk.tint = c.tint;
    r.vis = newStatic([blk]);
    r.vis.root.position.set(r.x, r.y, r.z);
    crumbles.push(r); dyn.push(r);
  }

  // ---------------------------------------------------------------- items
  const shards = []; const checkpoints = []; const plates = []; const switches = []; const nodes = [];
  const doors = []; const crates = []; const cracked = []; const pads = []; const signs = []; const portals = []; const gates = []; const triggers = [];
  for (const it of items) {
    if (!it || !it.type) continue;
    const p = it.p;
    const x = at(p, 0); const y = at(p, 1); const z = at(p, 2);
    switch (it.type) {
      case 'shard': {
        const r = { kind: 'shard', src: it, x, y, z, taken: false, s: { taken: 0 } };
        r.prop = newProp('shard', {}); r.prop.root.position.set(x, y, z);
        shards.push(r);
        break;
      }
      case 'checkpoint': {
        const r = { kind: 'checkpoint', src: it, x, y, z, index: checkpoints.length, active: false, s: { active: false } };
        r.prop = newProp('checkpoint', {}); r.prop.root.position.set(x, y, z);
        checkpoints.push(r);
        break;
      }
      case 'portal': {
        const r = { kind: 'portal', src: it, x, y, z, inside: -1, need: 0, open: false, exited: false, s: { open: false, inside: 0, need: 0 } };
        bindWhen(r, it.when, it.logic);
        r.prop = newProp('portal', {}); r.prop.root.position.set(x, y, z);
        portals.push(r);
        break;
      }
      case 'bounce': {
        const r = { kind: 'bounce', src: it, x, y, z, power: num(it.power, 16), fire: 0, s: { fire: 0 } };
        r.prop = newProp('bounce', {}); r.prop.root.position.set(x, y, z);
        pads.push(r);
        break;
      }
      case 'switch': {
        const mode = it.mode === 'hold' || it.mode === 'timed' ? it.mode : 'toggle';
        const r = { kind: 'switch', src: it, id: it.id, x, y, z, mode, time: Math.max(0.1, num(it.time, 6)), on: false, touch: false, timer: 0, pulse: 0, sig: sig(it.id ?? 'switch'), s: { on: false } };
        r.prop = newProp('switch', {}); r.prop.root.position.set(x, y, z);
        switches.push(r);
        break;
      }
      case 'node': {
        const r = { kind: 'node', src: it, id: it.id, x, y, z, time: num(it.time, 0), on: false, timer: 0, sig: sig(it.id ?? 'node'), s: { on: false, left: 0 } };
        r.prop = newProp('node', {}); r.prop.root.position.set(x, y, z);
        nodes.push(r);
        break;
      }
      case 'plate': {
        const r = { kind: 'plate', src: it, id: it.id, x, y, z, heavy: !!it.heavy, pressed: false, sig: sig(it.id ?? 'plate'), s: { pressed: false, heavy: !!it.heavy } };
        r.prop = newProp('plate', { heavy: !!it.heavy }); r.prop.root.position.set(x, y, z);
        plates.push(r);
        break;
      }
      case 'door': {
        const s = Array.isArray(it.s) ? it.s : [2, 3, 0.5];
        const r = boxRec('door', [x, boxCentreY(p, Math.abs(at(s, 1, 3))), z], s, it);
        r.open = 0; r.s = { open: 0 };
        bindWhen(r, it.when, it.logic);
        r.prop = newProp('door', { size: [r.hx * 2, r.hy * 2, r.hz * 2] }); r.prop.root.position.set(r.x, r.minY, r.z);
        doors.push(r); dyn.push(r);
        break;
      }
      case 'crate': {
        const s = Array.isArray(it.s) ? it.s : [1.4, 1.4, 1.4];
        const r = boxRec('crate', [x, boxCentreY(p, Math.abs(at(s, 1, 1.4))), z], s, it);
        r.vx = 0; r.vy = 0; r.vz = 0; r.ground = null; r.gx = 0; r.gy = 0; r.gz = 0; r.respawn = 0; r.pushT = 0;
        r.home = [r.x, r.y, r.z]; r.s = { pushed: false };
        r.prop = newProp('crate', { size: [r.hx * 2, r.hy * 2, r.hz * 2] }); r.prop.root.position.set(r.x, r.minY, r.z);
        crates.push(r); dyn.push(r);
        break;
      }
      case 'cracked': {
        const s = Array.isArray(it.s) ? it.s : [2, 0.5, 2];
        const r = boxRec('cracked', [x, boxCentreY(p, Math.abs(at(s, 1, 0.5))), z], s, it);
        r.broken = 0; r.s = { broken: 0 };
        r.prop = newProp('cracked', { size: [r.hx * 2, r.hy * 2, r.hz * 2] }); r.prop.root.position.set(r.x, r.minY, r.z);
        cracked.push(r); dyn.push(r);
        break;
      }
      case 'gate': {
        // a rift geyser: step in and it throws you somewhere else (`to`, or the last checkpoint)
        const r = { kind: 'gate', src: it, x, y, z, to: Array.isArray(it.to) ? V(at(it.to, 0), at(it.to, 1), at(it.to, 2)) : null,
          yaw: Number.isFinite(+it.yaw) ? +it.yaw : null, fire: 0, s: { open: true, fire: 0, color: it.color || '#5ef2c0' } };
        bindWhen(r, it.when, it.logic);
        r.prop = newProp('gate', { color: it.color || '#5ef2c0' }); r.prop.root.position.set(x, y, z);
        gates.push(r);
        break;
      }
      case 'trigger': {
        // invisible: the first hero inside latches signal `id` on for good (a bridge gives way, a door slams)
        triggers.push({ x, y, z, r: num(it.r, 3), h: num(it.h, 4), sig: sig(it.id ?? 'trigger'), done: false });
        break;
      }
      case 'sign': {
        const r = { kind: 'sign', src: it, x, y, z, s: {} };
        r.prop = newProp('sign', { text: it.text || '' }); r.prop.root.position.set(x, y, z);
        r.prop.root.rotation.y = num(it.yaw, 0);
        signs.push(r);
        break;
      }
      default: break;
    }
  }
  // crates that start inside a block climb out of it
  for (const c of crates) {
    for (let k = 0; k < 40; k++) {
      gather(LQ, c.minX + 0.01, c.minY + 0.01, c.minZ + 0.01, c.maxX - 0.01, c.maxY - 0.01, c.maxZ - 0.01, c);
      if (!LQ.n) break;
      let top = c.minY;
      for (let i = 0; i < LQ.n; i++) top = Math.max(top, LQ.a[i].maxY);
      c.y = top + c.hy; syncBox(c);
    }
    c.home[1] = c.y;
  }

  // ---------------------------------------------------------------- hazards
  const lasers = []; const spikes = [];
  for (const hz of Array.isArray(def.hazards) ? def.hazards : []) {
    if (!hz) continue;
    if (hz.type === 'laser' && Array.isArray(hz.from) && Array.isArray(hz.to)) {
      const fx0 = at(hz.from, 0); const fy0 = at(hz.from, 1); const fz0 = at(hz.from, 2);
      const tx = at(hz.to, 0); const ty = at(hz.to, 1); const tz = at(hz.to, 2);
      const length = Math.max(0.01, Math.hypot(tx - fx0, ty - fy0, tz - fz0));
      const r = { kind: 'laser', src: hz, fx: fx0, fy: fy0, fz: fz0, dx: (tx - fx0) / length, dy: (ty - fy0) / length, dz: (tz - fz0) / length,
        length, staticLen: length, len: length, on: true, period: null, phase: num(hz.phase, 0), s: { on: true, length } };
      if (Array.isArray(hz.period) && hz.period.length >= 2) r.period = [Math.max(0, at(hz.period, 0, 1)), Math.max(0, at(hz.period, 1, 1))];
      bindWhen(r, hz.when, hz.logic);
      r.prop = newProp('laser', { length });
      r.prop.root.position.set(fx0, fy0, fz0);
      r.prop.root.lookAt(tx, ty, tz);
      lasers.push(r);
    } else if (hz.type === 'spikes' && Array.isArray(hz.p)) {
      const s = Array.isArray(hz.s) ? hz.s : [1.5, 0.5, 1.5];
      const sx = Math.abs(at(s, 0, 1.5)); const sy = Math.max(0.1, Math.abs(at(s, 1, 0.5))); const sz = Math.abs(at(s, 2, 1.5));
      const cy = boxCentreY(hz.p, sy);
      const r = { kind: 'spikes', src: hz, x: at(hz.p, 0), z: at(hz.p, 2), minX: at(hz.p, 0) - sx / 2, maxX: at(hz.p, 0) + sx / 2,
        minZ: at(hz.p, 2) - sz / 2, maxZ: at(hz.p, 2) + sz / 2, base: cy - sy / 2, h: sy, up: 1, period: null, phase: num(hz.phase, 0), s: { up: 1 } };
      if (Array.isArray(hz.period) && hz.period.length >= 2) r.period = [Math.max(0, at(hz.period, 0, 1)), Math.max(0, at(hz.period, 1, 1))];
      r.prop = newProp('spikes', { size: [sx, sy, sz] }); r.prop.root.position.set(r.x, r.base, r.z);
      spikes.push(r);
    }
  }

  // ---------------------------------------------------------------- surfaces (lava / water / void)
  const surfaces = []; const waters = []; const killers = [];
  for (const sf of Array.isArray(def.surfaces) ? def.surfaces : []) {
    if (!sf || !Array.isArray(sf.p) || !Array.isArray(sf.s)) continue;
    const type = sf.type === 'water' || sf.type === 'void' ? sf.type : 'lava';
    const s = sf.s;
    const w = Math.abs(at(s, 0, 4)); const d = Math.abs(s.length >= 3 ? at(s, 2, 4) : at(s, 1, 4));
    const hgt = s.length >= 3 ? Math.abs(at(s, 1, 0)) : 0;
    const top = at(sf.p, 1) + hgt / 2;
    const r = { kind: type, src: sf, x: at(sf.p, 0), z: at(sf.p, 2), top, minX: at(sf.p, 0) - w / 2, maxX: at(sf.p, 0) + w / 2,
      minZ: at(sf.p, 2) - d / 2, maxZ: at(sf.p, 2) + d / 2 };
    r.vis = newSurface(type, w, d);
    r.vis.mesh.position.set(r.x, top, r.z);
    surfaces.push(r);
    if (type === 'water') waters.push(r); else killers.push(r);
  }
  function waterAt(x, z, y) {
    for (let i = 0; i < waters.length; i++) {
      const w = waters[i];
      if (y < w.top && x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ) return w;
    }
    return null;
  }
  function killAt(x, z, y) {
    if (y < killY) return true;
    for (let i = 0; i < killers.length; i++) {
      const k = killers[i];
      if (y < k.top - 0.05 && x >= k.minX && x <= k.maxX && z >= k.minZ && z <= k.maxZ) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- solid ray casts
  // castSolid fills RC with the nearest solid (static + dynamic) along a unit direction.
  const RC = { t: 0, rec: null, nx: 0, ny: 0, nz: 0 };
  function castSolid(ox, oy, oz, dx, dy, dz, maxT, skip, staticOnly) {
    let best = maxT; let rec = null; let axis = 0;
    const g = grid;
    // clip the ray to the grid footprint, then walk the cells it crosses
    let t0 = 0; let t1 = maxT;
    const gx1 = g.x0 + g.nx * g.cell; const gz1 = g.z0 + g.nz * g.cell;
    if (dx !== 0) {
      let a = (g.x0 - ox) / dx; let b = (gx1 - ox) / dx;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
    } else if (ox < g.x0 || ox > gx1) t1 = -1;
    if (dz !== 0) {
      let a = (g.z0 - oz) / dz; let b = (gz1 - oz) / dz;
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
    } else if (oz < g.z0 || oz > gz1) t1 = -1;
    if (t0 <= t1) {
      const st = nextStamp();
      const sx = ox + dx * t0; const sz = oz + dz * t0;
      let ix = clamp(Math.floor((sx - g.x0) / g.cell), 0, g.nx - 1);
      let iz = clamp(Math.floor((sz - g.z0) / g.cell), 0, g.nz - 1);
      const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
      const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
      let tmx = dx !== 0 ? (g.x0 + (ix + (dx > 0 ? 1 : 0)) * g.cell - ox) / dx : Infinity;
      let tmz = dz !== 0 ? (g.z0 + (iz + (dz > 0 ? 1 : 0)) * g.cell - oz) / dz : Infinity;
      const tdx = dx !== 0 ? g.cell / Math.abs(dx) : Infinity;
      const tdz = dz !== 0 ? g.cell / Math.abs(dz) : Infinity;
      for (let guard = 0; guard < 4096; guard++) {
        const cell = g.cells[iz * g.nx + ix];
        for (let k = 0; k < cell.length; k++) {
          const c = cell[k];
          if (c.stamp === st) continue;
          c.stamp = st;
          if (rayBox(ox, oy, oz, dx, dy, dz, c, best)) { best = RB.t; rec = c; axis = RB.axis; }
        }
        const tn = tmx < tmz ? tmx : tmz;
        if (best <= tn || tn > t1) break;
        if (tmx < tmz) { ix += stepX; tmx += tdx; } else { iz += stepZ; tmz += tdz; }
        if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) break;
      }
    }
    if (!staticOnly) {
      for (let k = 0; k < dyn.length; k++) {
        const c = dyn[k];
        if (!c.solid || c === skip) continue;
        if (rayBox(ox, oy, oz, dx, dy, dz, c, best)) { best = RB.t; rec = c; axis = RB.axis; }
      }
    }
    RC.t = best; RC.rec = rec;
    RC.nx = axis === 0 ? -Math.sign(dx) : 0; RC.ny = axis === 1 ? -Math.sign(dy) : 0; RC.nz = axis === 2 ? -Math.sign(dz) : 0;
    return rec;
  }
  // Clear line between two points (solids only)?
  function clearLine(ax, ay, az, bx, by, bz, skip) {
    const dx = bx - ax; const dy = by - ay; const dz = bz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6) return true;
    return !castSolid(ax, ay, az, dx / d, dy / d, dz / d, d - 0.05, skip, false);
  }

  // ---------------------------------------------------------------- character controller
  const CONTACTS = [];            // moveBody's return value: [{ kind, ref, normal, what }] + summary fields
  const CPOOL = [];
  for (let i = 0; i < 12; i++) CPOOL.push({ what: '', kind: '', ref: null, normal: new THREE.Vector3() });
  let CN = 0;
  const C = { grounded: false, ground: null, ceiling: false, wall: null, pushed: null, impact: 0, step: 0, water: false, stomp: null, was: false };
  function contact(what, rec, nx, ny, nz) {
    for (let i = 0; i < CN; i++) if (CPOOL[i].ref === rec && CPOOL[i].what === what) return;
    if (CN >= CPOOL.length) return;
    const c = CPOOL[CN++];
    c.what = what; c.kind = rec.kind; c.ref = rec; c.normal.set(nx, ny, nz);
  }
  const SUP = { top: 0 };
  let curSt = null;               // state of the body being moved (wall normal lives there)

  // Highest support under the feet with its top in [lo, feet + 0.02]; heroes' heads and (falling) crawler backs count.
  function support(body, r, lo, me, crawl) {
    const pos = body.pos; const x = pos.x; const z = pos.z; const hi = pos.y + 0.02; const fr = r - 0.01;
    let best = -Infinity; let bc = null;
    for (let i = 0; i < CAND.n; i++) {
      const c = CAND.a[i];
      if (!c.solid) continue;
      const top = c.maxY;
      if (top > hi || top < lo || top <= best) continue;
      if (!footOverlap(x, z, fr, c)) continue;
      best = top; bc = c;
    }
    if (me) {
      for (let i = 0; i < heroRecs.length; i++) {
        const o = heroRecs[i];
        if (o === me || !o.alive) continue;
        const ob = o.body; const top = ob.pos.y + ob.height;
        if (top > hi || top < lo || top <= best) continue;
        const ddx = ob.pos.x - x; const ddz = ob.pos.z - z; const rr = ob.radius + r - 0.02;
        if (ddx * ddx + ddz * ddz >= rr * rr) continue;
        best = top; bc = o;
      }
      if (crawl) {
        for (let i = 0; i < crawlers.length; i++) {
          const e = crawlers[i];
          if (!e.alive) continue;
          const b = e.body; const top = b.pos.y + b.height;
          if (top > hi || top < lo || top <= best) continue;
          const ddx = b.pos.x - x; const ddz = b.pos.z - z; const rr = b.radius + r - 0.05;
          if (ddx * ddx + ddz * ddz >= rr * rr) continue;
          best = top; bc = e;
        }
      }
    }
    SUP.top = best;
    return bc;
  }
  function vpass(body, r, h, dy, me) {
    const pos = body.pos;
    if (dy <= 0) {
      const sup = support(body, r, pos.y + dy - PROBE, me, body.vel.y < -1);
      if (sup) {
        pos.y = SUP.top;
        if (sup.kind === 'enemy' && sup.type === 'crawler') { stomp(body, me, sup); return null; }   // turrets are just solid
        if (body.vel.y < 0) { if (body.vel.y < C.impact) C.impact = body.vel.y; body.vel.y = 0; }
        return sup;
      }
      pos.y += dy;
      return null;
    }
    // moving up: the lowest ceiling between the head now and after the move
    const head = pos.y + h; const hi = head + dy; const x = pos.x; const z = pos.z; const fr = r - 0.01;
    let best = Infinity; let bc = null;
    for (let i = 0; i < CAND.n; i++) {
      const c = CAND.a[i];
      if (!c.solid) continue;
      const b = c.minY;
      if (b < head - 0.02 || b > hi || b >= best) continue;
      if (!footOverlap(x, z, fr, c)) continue;
      best = b; bc = c;
    }
    if (me) {
      for (let i = 0; i < heroRecs.length; i++) {
        const o = heroRecs[i];
        if (o === me || !o.alive) continue;
        const ob = o.body; const b = ob.pos.y;
        if (b < head - 0.02 || b > hi || b >= best) continue;
        const ddx = ob.pos.x - x; const ddz = ob.pos.z - z; const rr = ob.radius + r - 0.02;
        if (ddx * ddx + ddz * ddz >= rr * rr) continue;
        best = b; bc = o;
      }
    }
    if (bc) {
      pos.y = best - h;
      body.vel.y = 0;
      C.ceiling = true;
      contact('ceiling', bc, 0, -1, 0);
      return null;
    }
    pos.y += dy;
    return null;
  }
  // Free spot for a body of radius r, height h with its feet at (x, y, z)?
  function freeAt(x, y, z, r, h, me, skip) {
    const fr = r - 0.004;
    for (let i = 0; i < CAND.n; i++) {
      const c = CAND.a[i];
      if (!c.solid || c === skip) continue;
      if (c.minY >= y + h - 0.004 || c.maxY <= y + 0.004) continue;
      if (footOverlap(x, z, fr, c)) return false;
    }
    if (me) {
      for (let i = 0; i < heroRecs.length; i++) {
        const o = heroRecs[i];
        if (o === me || !o.alive) continue;
        const ob = o.body;
        if (ob.pos.y >= y + h - 0.004 || ob.pos.y + ob.height <= y + 0.004) continue;
        const ddx = ob.pos.x - x; const ddz = ob.pos.z - z; const rr = ob.radius + fr;
        if (ddx * ddx + ddz * ddz < rr * rr) return false;
      }
    }
    return true;
  }
  function setWall(nx, nz) {
    const w = curSt.wall;
    if (!C.wall) { w.set(nx, 0, nz); C.wall = w; } else { w.x += nx; w.z += nz; const l = Math.sqrt(w.x * w.x + w.z * w.z); if (l > 1e-6) { w.x /= l; w.z /= l; } }
  }
  function hpass(body, r, h, dx, dz, me, sdt, canStep) {
    const pos = body.pos; const vel = body.vel;
    pos.x += dx; pos.z += dz;
    for (let iter = 0; iter < 3; iter++) {
      let hit = false;
      for (let i = 0; i < CAND.n; i++) {
        const c = CAND.a[i];
        if (!c.solid) continue;
        if (c.minY >= pos.y + h - 0.001 || c.maxY <= pos.y + 0.001) continue;
        let pen = circleRect(pos.x, pos.z, r, c);
        if (pen <= 0) continue;
        // a low ledge: step onto it (only with head-room up there)
        const rise = c.maxY - pos.y;
        if (canStep && rise <= STEP && freeAt(pos.x, c.maxY, pos.z, r, h, me, c)) {
          pos.y = c.maxY; C.step += rise; hit = true;
          continue;
        }
        // a heavy body shoves crates
        if (c.kind === 'crate' && body.heavy) {
          const moved = pushCrate(c, body, r, sdt);
          if (moved > 0) {
            C.pushed = c;
            contact('push', c, NRM.x, 0, NRM.z);
            pen = circleRect(pos.x, pos.z, r, c);
            if (pen > 0) {
              pos.x += NRM.x * (pen + SKIN); pos.z += NRM.z * (pen + SKIN);
              const vn = vel.x * NRM.x + vel.z * NRM.z;
              if (vn < -PUSH_SPEED) { const k = -PUSH_SPEED - vn; vel.x += NRM.x * k; vel.z += NRM.z * k; }
            }
            hit = true;
            continue;
          }
          pen = circleRect(pos.x, pos.z, r, c);
          if (pen <= 0) continue;
        }
        pos.x += NRM.x * (pen + SKIN); pos.z += NRM.z * (pen + SKIN);
        const vn = vel.x * NRM.x + vel.z * NRM.z;
        if (vn < 0) { vel.x -= NRM.x * vn; vel.z -= NRM.z * vn; }
        setWall(NRM.x, NRM.z);
        contact('wall', c, NRM.x, 0, NRM.z);
        hit = true;
      }
      if (me) {
        for (let k = 0; k < heroRecs.length; k++) {
          const o = heroRecs[k];
          if (o === me || !o.alive) continue;
          const ob = o.body;
          if (ob.pos.y >= pos.y + h - 0.001 || ob.pos.y + ob.height <= pos.y + 0.001) continue;
          let ddx = pos.x - ob.pos.x; let ddz = pos.z - ob.pos.z;
          const rr = r + ob.radius;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 >= rr * rr) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-6) { ddx = Math.sin(CLK.now * 7.1) || 1; ddz = Math.cos(CLK.now * 7.1); d = Math.sqrt(ddx * ddx + ddz * ddz); }
          const nx = ddx / d; const nz = ddz / d; const pen = rr - Math.sqrt(d2);
          pos.x += nx * (pen + SKIN); pos.z += nz * (pen + SKIN);
          const vn = vel.x * nx + vel.z * nz;
          if (vn < 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
          setWall(nx, nz);
          contact('hero', o, nx, 0, nz);
          hit = true;
        }
      }
      if (!hit) break;
    }
  }
  // Never leave a body inside geometry: out along the shortest free way (side, up or down).
  function depenetrate(body, r, h, me) {
    const pos = body.pos;
    for (let iter = 0; iter < 6; iter++) {
      let worst = null; let wd = 0.004; let side = 0; let nx = 0; let nz = 0; let top = 0; let bot = 0;
      for (let i = 0; i < CAND.n; i++) {
        const c = CAND.a[i];
        if (!c.solid) continue;
        if (c.minY >= pos.y + h - 0.004 || c.maxY <= pos.y + 0.004) continue;
        const p = circleRect(pos.x, pos.z, r, c);
        if (p <= 0.004) continue;
        const d = Math.min(p, c.maxY - pos.y, pos.y + h - c.minY);
        if (d > wd) { worst = c; wd = d; side = p; nx = NRM.x; nz = NRM.z; top = c.maxY; bot = c.minY; }
      }
      if (me) {
        for (let k = 0; k < heroRecs.length; k++) {
          const o = heroRecs[k];
          if (o === me || !o.alive) continue;
          const ob = o.body;
          if (ob.pos.y >= pos.y + h - 0.004 || ob.pos.y + ob.height <= pos.y + 0.004) continue;
          let ddx = pos.x - ob.pos.x; let ddz = pos.z - ob.pos.z;
          const rr = r + ob.radius;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 >= rr * rr) continue;
          let dd = Math.sqrt(d2);
          if (dd < 1e-6) { ddx = 1; ddz = 0; dd = 1; }
          const p = rr - Math.sqrt(d2);
          const d = Math.min(p, ob.pos.y + ob.height - pos.y, pos.y + h - ob.pos.y);
          if (d > wd) { worst = o; wd = d; side = p; nx = ddx / dd; nz = ddz / dd; top = ob.pos.y + ob.height; bot = ob.pos.y; }
        }
      }
      if (!worst) return;
      // ways out: sideways, up onto it, down below it — the shortest free one wins
      const up = top - pos.y; const down = pos.y + h - bot;
      const sx = pos.x + nx * (side + SKIN); const sz = pos.z + nz * (side + SKIN);
      let bx = sx; let by = pos.y; let bz = sz; let bd = Infinity;
      if (freeAt(sx, pos.y, sz, r, h, me, null)) bd = side;
      if (up < bd && freeAt(pos.x, top, pos.z, r, h, me, null)) { bx = pos.x; by = top; bz = pos.z; bd = up; }
      if (down < bd && freeAt(pos.x, bot - h - SKIN, pos.z, r, h, me, null)) { bx = pos.x; by = bot - h - SKIN; bz = pos.z; bd = down; }
      if (bd === Infinity) {
        // boxed in: take the cheapest way anyway and let the next pass continue
        if (up <= side && up <= down) { bx = pos.x; by = top; bz = pos.z; } else if (down < side) { bx = pos.x; by = bot - h - SKIN; bz = pos.z; }
      }
      pos.set(bx, by, bz);
    }
  }
  function isCarrier(g) { return !!g && (g.kind === 'mover' || g.kind === 'crate' || g.kind === 'hero' || g.kind === 'crumble'); }
  function setCarrier(st, g) {
    if (isCarrier(g)) {
      st.carrier = g;
      if (g.kind === 'hero') { const p = g.body.pos; st.cx = p.x; st.cy = p.y; st.cz = p.z; } else { st.cx = g.x; st.cy = g.y; st.cz = g.z; }
    } else st.carrier = null;
  }
  // Inherit the platform's displacement since we last stood on it (movers, crates, heroes' heads).
  function carry(body, st) {
    const g = st.carrier;
    if (!g) return false;
    if (body.ground !== g || !g.solid || (g.kind === 'hero' && !g.alive)) { st.carrier = null; return false; }
    let cx; let cy; let cz;
    if (g.kind === 'hero') { const p = g.body.pos; cx = p.x; cy = p.y; cz = p.z; } else { cx = g.x; cy = g.y; cz = g.z; }
    const dx = cx - st.cx; const dy = cy - st.cy; const dz = cz - st.cz;
    st.cx = cx; st.cy = cy; st.cz = cz;
    if (dx === 0 && dy === 0 && dz === 0) return false;
    if (dx * dx + dy * dy + dz * dz > 9) return false;     // the carrier jumped (respawned): stay put
    body.pos.x += dx; body.pos.y += dy; body.pos.z += dz;
    return true;
  }
  function stomp(body, me, e) {
    const pix = me && (me.id === 'pix' || body.heavy);
    if (pix && !e.armoured) {
      killEnemy(e, 'stomp');
      body.vel.y = 9;
    } else {
      body.vel.y = 7.5;
      e.stun = Math.max(e.stun, 1.2);
    }
    C.stomp = e;
    contact('stomp', e, 0, 1, 0);
  }
  // The character controller proper (heroes pass their record as `me`; crawlers pass null).
  function simulate(body, dt, me) {
    const st = bst(body);
    curSt = st;
    const pos = body.pos; const vel = body.vel;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    if (!fin(pos.x) || !fin(pos.y) || !fin(pos.z)) { if (st.ok) pos.set(st.okX, st.okY, st.okZ); else pos.set(0, 0, 0); vel.set(0, 0, 0); }
    if (!fin(vel.x) || !fin(vel.y) || !fin(vel.z)) vel.set(0, 0, 0);
    if (vel.y < -MAX_FALL) vel.y = -MAX_FALL;
    const r = Math.max(0.05, num(body.radius, 0.4)); const h = Math.max(0.1, num(body.height, 1.5));
    const wasGrounded = body.grounded === true;
    C.grounded = false; C.ground = null; C.ceiling = false; C.wall = null; C.pushed = null; C.impact = 0; C.step = 0; C.water = false; C.stomp = null;
    CN = 0;
    carry(body, st);
    const dx = vel.x * dt; const dy = vel.y * dt; const dz = vel.z * dt;
    const m = r + 0.6;
    gather(CAND, Math.min(pos.x, pos.x + dx) - m, pos.y + Math.min(0, dy) - STEP - 0.6, Math.min(pos.z, pos.z + dz) - m,
      Math.max(pos.x, pos.x + dx) + m, pos.y + Math.max(0, dy) + h + 0.6, Math.max(pos.z, pos.z + dz) + m, null);
    depenetrate(body, r, h, me);
    // water slows and catches
    const wat = waters.length ? waterAt(pos.x, pos.z, pos.y) : null;
    let k = 1;
    if (wat) { k = WATER_SLOW; if (vel.y < -WATER_SINK) vel.y = -WATER_SINK; C.water = true; }
    const n = clamp(Math.ceil(Math.max(Math.sqrt(dx * dx + dz * dz) * k / (0.4 * r), Math.abs(vel.y * dt) / 0.5)), 1, 32);
    const sdt = dt / n;
    let supported = wasGrounded;
    for (let i = 0; i < n; i++) {
      if (vpass(body, r, h, vel.y * sdt, me)) supported = true;
      // step-ups while walking or falling (a ledge assist), never on the way up of a jump from mid-air
      hpass(body, r, h, vel.x * sdt * k, vel.z * sdt * k, me, sdt, vel.y <= 0.01 || wasGrounded);
    }
    C.was = wasGrounded;
    // settle: the ground right below, or a step down when we were walking (stairs, slopes)
    if (vel.y <= 0.01) {
      const depth = supported && vel.y > -6 && !C.stomp ? STEP + 0.02 : PROBE;
      const sup = support(body, r, pos.y - depth, me, false);
      if (sup) {
        pos.y = SUP.top;
        if (vel.y < 0) { if (vel.y < C.impact) C.impact = vel.y; vel.y = 0; }
        C.grounded = true; C.ground = sup;
      }
    }
    if (wat && !C.grounded) {
      const line = wat.top - Math.min(0.6, 0.45 * h);
      if (pos.y < line + 0.02) {
        pos.y = Math.min(line, pos.y + 3 * dt);
        if (vel.y < 0) vel.y = 0;
        C.grounded = true; C.ground = wat;
      }
    }
    depenetrate(body, r, h, me);
    if (C.grounded) contact('ground', C.ground, 0, 1, 0);
    body.grounded = C.grounded; body.ground = C.ground; body.ceiling = C.ceiling; body.wall = C.wall;
    body.pushing = C.pushed !== null; body.water = C.water;
    setCarrier(st, C.ground);
    st.okX = pos.x; st.okY = pos.y; st.okZ = pos.z; st.ok = true;
    curSt = null;
  }
  function moveBody(body, dt) {
    while (CONTACTS.length) CONTACTS.pop();
    if (disposed || !body || !body.pos || !body.vel) return CONTACTS;
    const me = heroFor(body);
    simulate(body, dt, me);
    for (let i = 0; i < CN; i++) CONTACTS.push(CPOOL[i]);
    CONTACTS.grounded = C.grounded; CONTACTS.ground = C.ground; CONTACTS.ceiling = C.ceiling; CONTACTS.wall = C.wall;
    CONTACTS.pushed = C.pushed; CONTACTS.landed = C.grounded && !C.was; CONTACTS.impact = -C.impact;
    CONTACTS.step = C.step; CONTACTS.water = C.water; CONTACTS.stomp = C.stomp;
    return CONTACTS;
  }

  // ---------------------------------------------------------------- crates
  const SW = { hit: null };
  // Move a box along one axis by amt, stopping at the first solid (and at bodies when moving sideways).
  function sweepBox(c, axis, amt, bodiesBlock) {
    SW.hit = null;
    if (amt === 0) return 0;
    let minX = c.minX; let maxX = c.maxX; let minY = c.minY; let maxY = c.maxY; let minZ = c.minZ; let maxZ = c.maxZ;
    if (axis === 0) { if (amt > 0) maxX += amt; else minX += amt; } else if (axis === 1) { if (amt > 0) maxY += amt; else minY += amt; } else if (amt > 0) maxZ += amt; else minZ += amt;
    gather(LS, minX, minY, minZ, maxX, maxY, maxZ, c);
    const E = 1e-6;
    let allow = amt;
    for (let i = 0; i < LS.n; i++) {
      const o = LS.a[i];
      if (axis !== 0 && (o.maxX <= c.minX + E || o.minX >= c.maxX - E)) continue;
      if (axis !== 1 && (o.maxY <= c.minY + E || o.minY >= c.maxY - E)) continue;
      if (axis !== 2 && (o.maxZ <= c.minZ + E || o.minZ >= c.maxZ - E)) continue;
      const omin = axis === 0 ? o.minX : axis === 1 ? o.minY : o.minZ;
      const omax = axis === 0 ? o.maxX : axis === 1 ? o.maxY : o.maxZ;
      const cmin = axis === 0 ? c.minX : axis === 1 ? c.minY : c.minZ;
      const cmax = axis === 0 ? c.maxX : axis === 1 ? c.maxY : c.maxZ;
      if (amt > 0) { const gap = omin - cmax; if (gap < -0.01) continue; if (gap < allow) { allow = gap > 0 ? gap : 0; SW.hit = o; } } else { const gap = omax - cmin; if (gap > 0.01) continue; if (gap > allow) { allow = gap < 0 ? gap : 0; SW.hit = o; } }
    }
    if (bodiesBlock && axis !== 1) {
      for (let k = 0; k < heroRecs.length + crawlers.length; k++) {
        let b;
        if (k < heroRecs.length) { if (!heroRecs[k].alive) continue; b = heroRecs[k].body; } else { const e = crawlers[k - heroRecs.length]; if (!e.alive) continue; b = e.body; }
        const br = b.radius;
        if (b.pos.y >= c.maxY - E || b.pos.y + b.height <= c.minY + E) continue;
        if (axis === 0 ? (b.pos.z + br <= c.minZ + E || b.pos.z - br >= c.maxZ - E) : (b.pos.x + br <= c.minX + E || b.pos.x - br >= c.maxX - E)) continue;
        const bmin = (axis === 0 ? b.pos.x : b.pos.z) - br; const bmax = bmin + 2 * br;
        const cmin = axis === 0 ? c.minX : c.minZ; const cmax = axis === 0 ? c.maxX : c.maxZ;
        if (amt > 0) { const gap = bmin - cmax; if (gap < -0.01) continue; if (gap < allow) allow = gap > 0 ? gap : 0; } else { const gap = bmax - cmin; if (gap > 0.01) continue; if (gap > allow) allow = gap < 0 ? gap : 0; }
      }
    }
    if (axis === 0) c.x += allow; else if (axis === 1) c.y += allow; else c.z += allow;
    syncBox(c);
    return allow;
  }
  function pushCrate(c, body, r, sdt) {
    const pos = body.pos;
    if (c.respawn > 0 || c.minY > pos.y + STEP + 0.05 || c.maxY < pos.y + 0.4) return 0;
    let axis; let dir; let pen;
    if (Math.abs(NRM.x) >= Math.abs(NRM.z)) { axis = 0; dir = NRM.x > 0 ? -1 : 1; pen = dir > 0 ? pos.x + r - c.minX : c.maxX - (pos.x - r); } else { axis = 2; dir = NRM.z > 0 ? -1 : 1; pen = dir > 0 ? pos.z + r - c.minZ : c.maxZ - (pos.z - r); }
    if (!(pen > 0)) return 0;
    const got = sweepBox(c, axis, dir * Math.min(pen + SKIN, PUSH_SPEED * sdt), true);
    if (Math.abs(got) > 1e-7) c.pushT = 0.2;
    return Math.abs(got);
  }
  function crateHome(c) {
    c.x = c.home[0]; c.y = c.home[1]; c.z = c.home[2]; syncBox(c);
    for (let k = 0; k < 30; k++) {
      gather(LQ, c.minX + 0.01, c.minY + 0.01, c.minZ + 0.01, c.maxX - 0.01, c.maxY - 0.01, c.maxZ - 0.01, c);
      let blocked = LQ.n > 0;
      for (let i = 0; i < heroRecs.length && !blocked; i++) {
        const b = heroRecs[i].body;
        if (heroRecs[i].alive && b.pos.y < c.maxY && b.pos.y + b.height > c.minY && footOverlap(b.pos.x, b.pos.z, b.radius, c)) blocked = true;
      }
      if (!blocked) break;
      c.y += 0.5; syncBox(c);
    }
    c.vx = c.vy = c.vz = 0; c.ground = null;
  }
  function updateCrates(dt) {
    for (let i = 1; i < crates.length; i++) {        // lowest first, so riders see where their support went
      const c = crates[i]; let j = i - 1;
      while (j >= 0 && crates[j].minY > c.minY) { crates[j + 1] = crates[j]; j--; }
      crates[j + 1] = c;
    }
    for (let i = 0; i < crates.length; i++) {
      const c = crates[i];
      if (c.pushT > 0) c.pushT -= dt;
      if (c.respawn > 0) {
        c.respawn -= dt;
        if (c.respawn <= 0) { c.respawn = 0; crateHome(c); c.solid = true; fx('sparkle', V(c.x, c.maxY, c.z), '#ffd166'); }
        continue;
      }
      const g = c.ground;
      if (g && isCarrier(g) && g.solid && g !== c) {
        const dx = g.x - c.gx; const dy = g.y - c.gy; const dz = g.z - c.gz;
        if (dy) sweepBox(c, 1, dy, false);
        if (dx) sweepBox(c, 0, dx, true);
        if (dz) sweepBox(c, 2, dz, true);
      }
      c.vy = Math.max(c.vy - GRAVITY * dt, -MAX_FALL);
      const want = c.vy * dt;
      const got = sweepBox(c, 1, want, false);
      c.ground = null;
      if (want < 0 && got > want + 1e-7) {
        c.ground = SW.hit;
        if (c.vy < -6) fx('dust', V(c.x, c.minY, c.z));
        // a crate falling on a crawler squashes it
        if (c.vy < -3) {
          for (let k = 0; k < crawlers.length; k++) {
            const e = crawlers[k];
            if (e.alive && !e.armoured && e.body.pos.y < c.minY + 0.3 && e.body.pos.y + e.body.height > c.minY - 0.3 && footOverlap(e.body.pos.x, e.body.pos.z, e.body.radius, c)) killEnemy(e, 'crate');
          }
        }
        c.vy = 0;
      } else if (want > 0 && got < want - 1e-7) c.vy = 0;
      // water floats it (top just above the surface)
      if (!c.ground && waters.length) {
        const w = waterAt(c.x, c.z, c.minY);
        if (w) {
          const line = w.top + 0.3 - 2 * c.hy;
          if (c.minY < line) { c.y += Math.min(line - c.minY, 3 * dt + 0.02); syncBox(c); if (c.vy < 0) c.vy = 0; c.vx *= 0.9; c.vz *= 0.9; }
          if (c.minY >= line - 0.05) c.ground = w;
        }
      }
      // more than half over an edge: it slides off; otherwise friction holds it
      if (c.ground && c.ground.kind !== 'water') {
        let centred = false;
        for (let k = 0; k < LS.n; k++) {
          const o = LS.a[k];
          if (o.solid && Math.abs(o.maxY - c.minY) < 0.02 && c.x >= o.minX && c.x <= o.maxX && c.z >= o.minZ && c.z <= o.maxZ) { centred = true; break; }
        }
        if (!centred) {
          const s = c.ground;
          const ox = c.x - clamp(c.x, s.minX, s.maxX); const oz = c.z - clamp(c.z, s.minZ, s.maxZ);
          const l = Math.sqrt(ox * ox + oz * oz);
          if (l > 1e-6) { c.vx = (ox / l) * 2.5; c.vz = (oz / l) * 2.5; }
        } else { c.vx = 0; c.vz = 0; }
      }
      if (c.vx) { const w = c.vx * dt; const got2 = sweepBox(c, 0, w, true); if (Math.abs(got2) < Math.abs(w) - 1e-7) c.vx = 0; }
      if (c.vz) { const w = c.vz * dt; const got2 = sweepBox(c, 2, w, true); if (Math.abs(got2) < Math.abs(w) - 1e-7) c.vz = 0; }
      if (c.ground && isCarrier(c.ground)) { c.gx = c.ground.x; c.gy = c.ground.y; c.gz = c.ground.z; }
      // fell out of the world or into lava: back to where it started
      if (killAt(c.x, c.z, c.minY + 0.1)) { c.solid = false; c.respawn = 1.2; c.ground = null; fx('burst', V(c.x, c.y, c.z), '#ffb347', 16, 3); }
    }
  }

  // ---------------------------------------------------------------- enemies and shots
  const enemies = []; const crawlers = [];
  const warden = { rec: null };
  const bosses = [];
  const DEF_EYE = { sentry: [0, 0, 0], crawler: [0, 0.4, 0.35], turret: [0, 1.1, 0.25], warden: [0, 0, 0], maw: [0, 0, 0], queen: [0, 0, 0] };
  // the floor under a point: the lowest of a few casts around it (a decoration right under it does not count)
  function floorUnder(x, y, z, rr = 3) {
    let ft = Infinity;
    for (let k = 0; k < 5; k++) {
      const a = (k / 4) * TAU; const r2 = k === 4 ? 0 : rr;
      if (castSolid(x + Math.sin(a) * r2, y, z + Math.cos(a) * r2, 0, -1, 0, 40, null, true)) ft = Math.min(ft, y - RC.t);
    }
    return ft === Infinity ? y - 4 : ft;
  }
  // ---- data-driven bosses (the Maw, the Null Queen) ----
  // src = { type: 'boss', kind: 'maw' | 'queen', id, name, p, wake = 20, reach = 30, sink, phases: [{
  //   need: 'plates' | 'nodes' | 'switches' | 'cracked' | 'minions' | 'timer', ids: [...], window = 6, hits = 3,
  //   at: [x, y, z] (the boss moves here for the phase), attacks: ['volley', 'ring', 'sweep', 'rain'],
  //   minions: n (armoured crawlers; with need 'minions' they are the lock), adds: n (plain crawlers at the start),
  //   rate = 1 (attack speed), sweepLen = 16 }] }
  // Phase n done → signal `<id>:<n>` latches on (floors can fall, gates can open); defeat → signal `<id>`.
  const sweepGeo = new THREE.BoxGeometry(1, 1, 1);
  ownGeo.push(sweepGeo);
  const BHEX = { maw: '#ff8a3d', queen: '#c084fc', architect: '#3cffd0' };
  function newBoss(src, x, y, z) {
    const kind = src.kind === 'queen' || src.kind === 'architect' ? src.kind : 'maw';
    const e = newEnemy(src, kind, x, y, z);
    e.boss = true; e.id = String(src.id || kind);   // e.type is 'maw' | 'queen' | 'architect'
    e.name = src.name || (kind === 'queen' ? 'The Null Queen' : kind === 'architect' ? 'The Architect' : 'The Maw');
    e.wake = num(src.wake, 20); e.reach = num(src.reach, 30); e.sinkBy = num(src.sink, kind === 'maw' ? 2.4 : 1.8);
    const ph = Array.isArray(src.phases) && src.phases.length ? src.phases : [{ need: 'timer' }];
    e.phases = ph.map((P) => {
      const ids = Array.isArray(P.ids) ? P.ids.map(String) : null;
      const pick = (list) => list.filter((o) => !ids || ids.includes(String(o.id ?? (o.src && o.src.id))));
      const need = ['plates', 'nodes', 'switches', 'cracked', 'minions'].includes(P.need) ? P.need : 'timer';
      return { need, window: num(P.window, 6), hits: Math.max(1, Math.round(num(P.hits, 3))), rate: Math.max(0.3, num(P.rate, 1)),
        at: Array.isArray(P.at) ? V(at(P.at, 0), at(P.at, 1), at(P.at, 2)) : null, attacks: Array.isArray(P.attacks) ? P.attacks : ['volley'],
        minions: Math.max(0, Math.round(num(P.minions, need === 'minions' ? 3 : 0))), adds: Math.max(0, Math.round(num(P.adds, 0))),
        sweepLen: num(P.sweepLen, 16), floor: fin(P.floor) ? +P.floor : fin(src.floor) ? +src.floor : null,
        recs: need === 'plates' ? pick(plates) : need === 'nodes' ? pick(nodes) : need === 'switches' ? pick(switches) : need === 'cracked' ? pick(cracked) : [] };
    });
    e.hp = e.maxHp = e.phases.reduce((a, P) => a + P.hits, 0);
    e.phase = 1; e.phHits = 0; e.started = false; e.window = 0; e.trans = 0; e.invT = 0; e.cycle = 0; e.used = false;
    e.volley = 0; e.volleyT = 0; e.aimT = 1.5; e.ringT = 3; e.rainT = 2.5; e.minions = [];
    e.base = V(x, y, z); e.goal = V(x, y, z); e.floorY = fin(src.floor) ? +src.floor : floorUnder(x, y, z);
    // the sweep: a beam along the floor from the boss outward, telegraphed, then rotating
    e.sw = { st: 'idle', t: 2.5, a: rnd() * TAU, dir: 1, len: 0, y: 0 };
    const mk = (color, opacity) => {
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      ownMat.push(m);
      const mesh = new THREE.Mesh(sweepGeo, m);
      mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 3;
      group.add(mesh);
      return mesh;
    };
    const SWC = { maw: [[3, 0.5, 0.9], [1.6, 0.2, 0.5]], queen: [[3, 1.6, 3], [1.2, 0.4, 1.6]], architect: [[0.8, 3, 2.4], [0.2, 1.4, 1.2]] }[kind];
    e.sw.core = mk(new THREE.Color(...SWC[0]), 1);
    e.sw.glow = mk(new THREE.Color(...SWC[1]), 0.5);
    e.s.phase = 1; e.s.shield = true; e.s.phases = e.phases.length;
    enemies.push(e);
    return e;
  }
  function anchorOff(vis, name, d) {
    const out = V(d[0], d[1], d[2]);
    const a = vis && vis.anchors && vis.anchors[name];
    if (a && a.isObject3D && typeof a.getWorldPosition === 'function') {
      const p = vis.root.position.clone(); const ry = vis.root.rotation.y;
      vis.root.position.set(0, 0, 0); vis.root.rotation.y = 0;
      vis.root.updateMatrixWorld(true);
      a.getWorldPosition(out);
      if (vis.root.parent) out.sub(vis.root.parent.getWorldPosition(V(0, 0, 0)));
      vis.root.position.copy(p); vis.root.rotation.y = ry;
    }
    return out;
  }
  // world position of an offset given in the enemy's root frame
  function rootPoint(e, off, out) {
    const c = Math.cos(e.yaw); const s = Math.sin(e.yaw);
    return out.set(e.rx + off.x * c + off.z * s, e.ry + off.y, e.rz - off.x * s + off.z * c);
  }
  function newEnemy(src, type, x, y, z) {
    const vis = newEnemyVis(type);
    const e = { kind: 'enemy', type, src, alive: true, solid: false, stamp: 0, armoured: false,
      x, y, z, rx: x, ry: y, rz: z, yaw: num(src.yaw, 0), state: 'idle', t: 0, stun: 0, deadT: 0, gone: false,
      vis, eyeOff: null, muzOff: null, eye: V(x, y, z), muz: V(x, y, z), aimV: V(x, y, z), aimOn: false, target: null,
      hp: 1, maxHp: 1, lost: 0, fireT: 0, alertT: 0, charge: 0, cool: 0, hitPause: 0,
      minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0,
      s: { state: 'idle', aim: null, fov: num(src.fov, 70), range: num(src.range, type === 'turret' ? 16 : type === 'crawler' ? 9 : 11), hp01: 1, phase: 0, charge: 0, shield: false, armoured: false } };
    e.eyeOff = anchorOff(vis, 'eye', DEF_EYE[type] || [0, 0.5, 0]);
    e.muzOff = anchorOff(vis, 'muzzle', [e.eyeOff.x, e.eyeOff.y, e.eyeOff.z]);
    e.range = e.s.range;
    return e;
  }
  function addCrawler(src, x, y, z, armoured) {
    const e = newEnemy(src, 'crawler', x, y, z);
    e.body = { id: 'crawler', pos: V(x, y, z), vel: V(0, 0, 0), radius: 0.45, height: 0.7, heavy: false, pushing: false, grounded: false, ground: null };
    e.home = V(x, y, z); e.wx = x; e.wz = z; e.wanderT = 0; e.steerT = rnd() * 0.1; e.heading = e.yaw; e.armoured = !!armoured;
    e.s.armoured = !!armoured;
    e.speed = 3; e.state = 'patrol';
    enemies.push(e); crawlers.push(e);
    return e;
  }
  for (const src of Array.isArray(def.enemies) ? def.enemies : []) {
    if (!src || !Array.isArray(src.p)) continue;
    const x = at(src.p, 0); const y = at(src.p, 1); const z = at(src.p, 2);
    if (src.type === 'sentry') {
      const e = newEnemy(src, 'sentry', x, y, z);
      // the patrol is `path` (a loop with 3+ points, back and forth with 2); a sentry spawned off it flies there first
      const pts = [];
      for (const q of Array.isArray(src.path) ? src.path : []) {
        if (!Array.isArray(q)) continue;
        const pt = [at(q, 0), at(q, 1), at(q, 2)]; const last = pts[pts.length - 1];
        if (!last || Math.hypot(pt[0] - last[0], pt[1] - last[1], pt[2] - last[2]) > 0.01) pts.push(pt);
      }
      if (!pts.length) pts.push([x, y, z]);
      e.route = pts; e.i = 0; e.dir = 1; e.wait = 0;
      e.approach = Math.hypot(pts[0][0] - x, pts[0][1] - y, pts[0][2] - z) > 0.05;
      e.loop = src.mode ? src.mode === 'loop' : pts.length >= 3;
      e.speed = Math.max(0.1, num(src.speed, 2));
      e.halfFov = clamp(num(src.fov, 70), 5, 340) * DEG / 2;
      const aimPt = e.approach ? pts[0] : pts[1];
      if (aimPt && (aimPt[0] - x) ** 2 + (aimPt[2] - z) ** 2 > 1e-6) e.yaw = Math.atan2(aimPt[0] - x, aimPt[2] - z);
      e.baseYaw = e.yaw; e.state = 'patrol';
      enemies.push(e);
    } else if (src.type === 'crawler') {
      addCrawler(src, x, y, z, false);
    } else if (src.type === 'turret') {
      const e = newEnemy(src, 'turret', x, y, z);
      e.hp = e.maxHp = 3; e.rate = Math.max(0.6, num(src.rate, 1.1)); e.cool = 1;
      e.solid = true; e.minX = x - 0.5; e.maxX = x + 0.5; e.minY = y; e.maxY = y + Math.max(0.9, e.eyeOff.y + 0.2); e.minZ = z - 0.5; e.maxZ = z + 0.5;
      enemies.push(e); dyn.push(e);
    } else if (src.type === 'warden') {
      const e = newEnemy(src, 'warden', x, y, z);
      e.hp = e.maxHp = 9; e.phase = 1; e.started = false; e.window = 0; e.trans = 0; e.invT = 0; e.volley = 0; e.volleyT = 0;
      e.ringT = 3; e.aimT = 1.5; e.minions = []; e.spawnT = 0; e.cycle = 0; e.used = false;
      e.base = V(x, y, z);
      // the arena floor: the lowest of a few casts around the core (a decoration right under it does not count)
      let ft = Infinity;
      for (let k = 0; k < 5; k++) {
        const a = (k / 4) * TAU; const rr = k === 4 ? 0 : 3;
        if (castSolid(x + Math.sin(a) * rr, y, z + Math.cos(a) * rr, 0, -1, 0, 40, null, true)) ft = Math.min(ft, y - RC.t);
      }
      e.floorY = ft === Infinity ? y - 4 : ft;
      const pl = Array.isArray(src.plates) ? src.plates.map(String) : null;
      const nd = Array.isArray(src.nodes) ? src.nodes.map(String) : null;
      e.plates = plates.filter((p) => !pl || pl.includes(String(p.id)));
      e.nodes = nodes.filter((n) => !nd || nd.includes(String(n.id)));
      e.s.phase = 1; e.s.shield = true;
      warden.rec = e;
      enemies.push(e);
    } else if (src.type === 'boss') {
      bosses.push(newBoss(src, x, y, z));
    }
  }
  for (const e of enemies) placeEnemy(e);
  function placeEnemy(e) {
    if (e.type === 'crawler') { e.x = e.body.pos.x; e.y = e.body.pos.y; e.z = e.body.pos.z; }
    if (e.type === 'sentry' || e.type === 'warden' || e.boss) {
      // hovering: the eye is at the logical position
      const c = Math.cos(e.yaw); const s = Math.sin(e.yaw); const o = e.eyeOff;
      e.rx = e.x - (o.x * c + o.z * s); e.ry = e.y - o.y; e.rz = e.z - (-o.x * s + o.z * c);
    } else { e.rx = e.x; e.ry = e.y; e.rz = e.z; }
    rootPoint(e, e.eyeOff, e.eye);
    rootPoint(e, e.muzOff, e.muz);
  }
  // shots: one pool, drawn by two instanced meshes
  const shots = [];
  for (let i = 0; i < MAX_SHOTS; i++) shots.push({ on: false, bolt: false, pos: V(0, 0, 0), dir: V(0, 0, 1), speed: 0, r: 0.25, life: 0, dmg: 1, src: null, color: new THREE.Color() });
  const orbGeo = new THREE.SphereGeometry(1, 12, 8);
  const boltGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
  const shotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  ownGeo.push(orbGeo, boltGeo); ownMat.push(shotMat);
  const orbMesh = new THREE.InstancedMesh(orbGeo, shotMat, MAX_SHOTS);
  const boltMesh = new THREE.InstancedMesh(boltGeo, shotMat, MAX_SHOTS);
  for (const im of [orbMesh, boltMesh]) {
    im.count = 0; im.frustumCulled = false; im.castShadow = false; im.receiveShadow = false;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.setColorAt(0, new THREE.Color(1, 1, 1));
    group.add(im);
  }
  const COL_SENTRY = new THREE.Color(2.6, 0.45, 2.1);
  const COL_TURRET = new THREE.Color(3.0, 0.7, 0.25);
  const COL_WARDEN = new THREE.Color(3.0, 0.35, 0.5);
  function fire(src, ox, oy, oz, dx, dy, dz, speed, rad, bolt, color, life = 4) {
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l < 1e-6) return null;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (s.on) continue;
      s.on = true; s.bolt = bolt; s.pos.set(ox, oy, oz); s.dir.set(dx / l, dy / l, dz / l); s.speed = speed; s.r = rad; s.life = life; s.dmg = 1; s.src = src;
      s.color.copy(color);
      return s;
    }
    return null;
  }
  function clearShots() { for (let i = 0; i < shots.length; i++) shots[i].on = false; }

  // ---------------------------------------------------------------- spawn and team placement
  const start = def.start && Array.isArray(def.start.p) ? def.start : { p: [0, 0, 0], yaw: 0 };
  const heroes = Array.isArray(def.heroes) && def.heroes.length ? def.heroes.slice() : ['vera'];
  // heroes side by side across the facing direction (the order of def.heroes), or def.heroStarts
  function placeTeam(cx, cy, cz, yaw, useStarts) {
    const out = {};
    const rx = Math.cos(yaw); const rz = -Math.sin(yaw); const n = heroes.length;
    heroes.forEach((id, i) => {
      const hs = useStarts && def.heroStarts && Array.isArray(def.heroStarts[id]) ? def.heroStarts[id] : null;
      if (hs) { out[id] = V(at(hs, 0), at(hs, 1), at(hs, 2)); return; }
      const o = (i - (n - 1) / 2) * 1.3;
      let x = cx + rx * o; let z = cz + rz * o; let y = cy;
      const top = staticTop(x, cy, z, 1.2, 0.4);
      if (top === null && Math.abs(o) > 0) { x = cx - Math.sin(yaw) * Math.abs(o) * 0.8; z = cz - Math.cos(yaw) * Math.abs(o) * 0.8; const t2 = staticTop(x, cy, z, 1.2, 0.4); if (t2 === null) { x = cx; z = cz; y = cy + i * 2; } else y = t2; } else if (top !== null) y = top;
      out[id] = V(x, y, z);
    });
    return out;
  }
  const spawnYaw = num(start.yaw, 0);
  const spawn = { pos: V(at(start.p, 0), at(start.p, 1), at(start.p, 2)), yaw: spawnYaw, heroes: placeTeam(at(start.p, 0), at(start.p, 1), at(start.p, 2), spawnYaw, true) };
  const checkpoint = { index: -1, pos: spawn.pos.clone(), yaw: spawnYaw, heroes: spawn.heroes };

  // ---------------------------------------------------------------- damage
  function hurt(h, dmg, fx0, fy0, fz0, kx, kz, up, kind) {
    const b = h.body; const st = bst(b);
    if (!h.alive || st.hurtT > 0 || st.safeT > 0) return false;
    st.hurtT = HURT_CD;
    let l = Math.sqrt(kx * kx + kz * kz);
    if (l < 1e-6) { kx = -b.vel.x; kz = -b.vel.z; l = Math.sqrt(kx * kx + kz * kz); if (l < 1e-6) { kx = 0; kz = -1; l = 1; } }
    b.vel.x = (kx / l) * KNOCK; b.vel.z = (kz / l) * KNOCK; b.vel.y = Math.max(b.vel.y, up);
    b.grounded = false;
    emit({ type: 'hurt', hero: h.id, dmg, from: V(fx0, fy0, fz0), kind });
    return true;
  }
  function killEnemy(e, how) {
    if (!e.alive) return;
    e.alive = false; e.state = 'dead'; e.deadT = 0; e.stun = 0; e.aimOn = false;
    if (e.type === 'turret') e.solid = true;     // the wreck stays put
    emit({ type: 'enemyDown', pos: V(e.x, e.y + (e.type === 'crawler' ? 0.35 : 0), e.z), kind: e.type, how });
    if (e.type === 'warden') { const s = sig('warden'); s.latch = true; }
    if (e.boss) { sig(e.id).latch = true; e.vulnerable = false; }
  }

  // ---------------------------------------------------------------- per-frame systems
  let teamN = 0;
  function syncTeam(team, dt) {
    for (let i = 0; i < heroRecs.length; i++) heroRecs[i].seen = false;
    teamN = 0;
    if (Array.isArray(team)) {
      for (let i = 0; i < team.length; i++) {
        const m = team[i];
        if (!m || !m.body || !m.body.pos) continue;
        const h = heroFor(m.body, m.id !== undefined ? m.id : m.body.id);
        if (m.id !== undefined) h.id = m.id;
        h.alive = m.alive !== false; h.active = !!m.active; h.seen = true; teamN++;
        const st = bst(m.body);
        st.hurtT = Math.max(0, st.hurtT - dt); st.safeT = Math.max(0, st.safeT - dt); st.voidT = Math.max(0, st.voidT - dt);
        st.gateT = Math.max(0, st.gateT - dt);
        const p = m.body.pos;
        if (st.lx === st.lx) {
          const dx = p.x - st.lx; const dy = p.y - st.ly; const dz = p.z - st.lz;
          if (dx * dx + dy * dy + dz * dz > 16) { st.safeT = SPAWN_SAFE; st.carrier = null; }   // teleported: respawn grace
        }
        st.lx = p.x; st.ly = p.y; st.lz = p.z;
      }
    }
    for (let i = 0; i < heroRecs.length; i++) if (!heroRecs[i].seen && teamN > 0) heroRecs[i].alive = false;
  }
  function carryTeam() {
    for (let i = 0; i < heroRecs.length; i++) {
      const h = heroRecs[i];
      if (!h.alive) continue;
      const b = h.body; const st = bst(b);
      if (carry(b, st)) {
        const r = b.radius; const hh = b.height;
        gather(CAND, b.pos.x - r - 0.3, b.pos.y - 0.3, b.pos.z - r - 0.3, b.pos.x + r + 0.3, b.pos.y + hh + 0.3, b.pos.z + r + 0.3, null);
        depenetrate(b, r, hh, h);
      }
    }
  }
  const onPlate = (b, p) => {
    const dx = b.pos.x - p.x; const dz = b.pos.z - p.z;
    return dx * dx + dz * dz <= PLATE_R * PLATE_R && b.pos.y >= p.y - 0.3 && b.pos.y <= p.y + 0.6;
  };
  const nearPoint = (b, x, y, z, rad, below, above) => {
    const dx = b.pos.x - x; const dz = b.pos.z - z;
    return dx * dx + dz * dz <= rad * rad && b.pos.y + b.height >= y - below && b.pos.y <= y + above;
  };
  function sense(dt) {
    for (let i = 0; i < plates.length; i++) {
      const p = plates[i];
      let on = false;
      for (let k = 0; k < heroRecs.length && !on; k++) { const h = heroRecs[k]; if (h.alive && (!p.heavy || h.body.heavy) && onPlate(h.body, p)) on = true; }
      for (let k = 0; k < crawlers.length && !on && !p.heavy; k++) if (crawlers[k].alive && onPlate(crawlers[k].body, p)) on = true;
      for (let k = 0; k < crates.length && !on; k++) {
        const c = crates[k];
        if (c.solid && p.x >= c.minX - 0.3 && p.x <= c.maxX + 0.3 && p.z >= c.minZ - 0.3 && p.z <= c.maxZ + 0.3 && c.minY >= p.y - 0.3 && c.minY <= p.y + 0.45) on = true;
      }
      p.pressed = on;
    }
    for (let i = 0; i < switches.length; i++) {
      const s = switches[i];
      let touch = false;
      for (let k = 0; k < heroRecs.length && !touch; k++) { const h = heroRecs[k]; if (h.alive && nearPoint(h.body, s.x, s.y, s.z, SWITCH_R, 0, 0.9) && h.body.pos.y >= s.y - 0.6) touch = true; }
      if (s.mode === 'toggle') { if (touch && !s.touch) s.on = !s.on; } else if (s.mode === 'hold') { s.pulse = Math.max(0, s.pulse - dt); s.on = touch || s.pulse > 0; } else { if (touch) s.timer = s.time; else s.timer = Math.max(0, s.timer - dt); s.on = s.timer > 0; }
      s.touch = touch;
    }
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.on && n.time > 0) { n.timer -= dt; if (n.timer <= 0) { n.timer = 0; n.on = false; } }
    }
    for (let i = 0; i < triggers.length; i++) {
      const tr = triggers[i];
      if (tr.done) continue;
      for (let k = 0; k < heroRecs.length; k++) {
        const b = heroRecs[k].body;
        if (!heroRecs[k].alive || (b.pos.x - tr.x) ** 2 + (b.pos.z - tr.z) ** 2 > tr.r * tr.r || b.pos.y < tr.y - 1 || b.pos.y > tr.y + tr.h) continue;
        tr.done = true; tr.sig.latch = true;
        break;
      }
    }
  }
  function evalSignals() {
    for (let i = 0; i < sigList.length; i++) sigList[i].next = sigList[i].latch;
    for (let i = 0; i < switches.length; i++) if (switches[i].on) switches[i].sig.next = true;
    for (let i = 0; i < nodes.length; i++) if (nodes[i].on) nodes[i].sig.next = true;
    for (let i = 0; i < plates.length; i++) if (plates[i].pressed) plates[i].sig.next = true;
    for (let i = 0; i < sigList.length; i++) {
      const s = sigList[i];
      if (s.next !== s.on) { s.on = s.next; emit({ type: 'signal', id: s.id, on: s.on }); }
    }
  }
  // anything (hero, crawler, crate) inside this box?
  function occupied(c, pad) {
    for (let k = 0; k < heroRecs.length; k++) {
      const h = heroRecs[k];
      if (!h.alive) continue;
      const b = h.body;
      if (b.pos.y < c.maxY + pad && b.pos.y + b.height > c.minY - pad && circleRect(b.pos.x, b.pos.z, b.radius + pad, c) > 0) return true;
    }
    for (let k = 0; k < crawlers.length; k++) {
      const e = crawlers[k];
      if (!e.alive) continue;
      const b = e.body;
      if (b.pos.y < c.maxY + pad && b.pos.y + b.height > c.minY - pad && circleRect(b.pos.x, b.pos.z, b.radius + pad, c) > 0) return true;
    }
    for (let k = 0; k < crates.length; k++) {
      const o = crates[k];
      if (o === c || !o.solid) continue;
      if (o.maxX > c.minX - pad && o.minX < c.maxX + pad && o.maxY > c.minY - pad && o.minY < c.maxY + pad && o.maxZ > c.minZ - pad && o.minZ < c.maxZ + pad) return true;
    }
    return false;
  }
  function updateDoors(dt) {
    for (let i = 0; i < doors.length; i++) {
      const d = doors[i];
      const want = cond(d);
      if (want) d.open = Math.min(1, d.open + dt / 0.6);
      else if (d.open > 0 && !(d.open < DOOR_SOLID + 0.05 && occupied(d, 0.02))) d.open = Math.max(0, d.open - dt / 0.8);   // never crush: wait while someone stands in it
      const solid = d.open < DOOR_SOLID;
      d.solid = solid && !(!d.solid && occupied(d, 0));
      d.s.open = d.open;
    }
  }
  function stoodOn(c) {
    for (let k = 0; k < heroRecs.length; k++) if (heroRecs[k].alive && heroRecs[k].body.ground === c) return true;
    for (let k = 0; k < crawlers.length; k++) if (crawlers[k].alive && crawlers[k].body.ground === c) return true;
    for (let k = 0; k < crates.length; k++) if (crates[k].solid && crates[k].ground === c) return true;
    return false;
  }
  function updateCrumbles(dt) {
    for (let i = 0; i < crumbles.length; i++) {
      const c = crumbles[i];
      c.t += dt;
      const root = c.vis.root;
      if (c.state === 'idle') {
        if (c.sigs ? cond(c) : stoodOn(c)) { c.state = 'shake'; c.t = 0; emit({ type: 'crumble', pos: V(c.x, c.maxY, c.z), big: !!c.sigs }); }
        root.position.set(c.x, c.y, c.z);
      } else if (c.state === 'shake') {
        const a = 0.04 + 0.06 * (c.t / Math.max(0.01, c.delay));
        root.position.set(c.x + Math.sin(c.t * 61) * a, c.y + Math.sin(c.t * 43) * a * 0.4, c.z + Math.cos(c.t * 53) * a);
        if (c.t >= c.delay) { c.state = 'fall'; c.t = 0; c.solid = false; fx('dust', V(c.x, c.maxY, c.z)); }
      } else if (c.state === 'fall') {
        root.position.set(c.x, c.y - 0.5 * GRAVITY * 0.6 * c.t * c.t, c.z);
        root.visible = c.t < 1.2;
        if (c.t >= c.back && !c.once) c.state = 'wait';
      } else if (c.state === 'wait') {
        if (!occupied(c, 0.05)) { c.state = 'return'; c.t = 0; c.solid = true; root.visible = true; root.position.set(c.x, c.y, c.z); }
      } else if (c.state === 'return') {
        const k = Math.min(1, c.t / 0.35);
        root.scale.setScalar(0.3 + 0.7 * k);
        if (k >= 1) { c.state = 'idle'; root.scale.setScalar(1); }
      }
    }
  }
  function updateHazards(t, dt) {
    for (let i = 0; i < lasers.length; i++) {
      const L = lasers[i];
      let on = true;
      if (L.period) { const cyc = L.period[0] + L.period[1]; if (cyc > 0) { const ph = (((t + L.phase) % cyc) + cyc) % cyc; on = ph < L.period[0]; } }
      if (L.sigs && cond(L)) on = false;
      L.on = on;
      // crates, doors and movers cut the beam short
      let len = L.staticLen;
      for (let k = 0; k < dyn.length; k++) {
        const c = dyn[k];
        if (!c.solid) continue;
        if (rayBox(L.fx, L.fy, L.fz, L.dx, L.dy, L.dz, c, len)) len = RB.t;
      }
      L.len = len;
      L.s.on = on; L.s.length = len;
      if (!on) continue;
      for (let k = 0; k < heroRecs.length; k++) {
        const h = heroRecs[k];
        if (!h.alive || h.body.heavy) continue;     // Brick walks through beams
        const b = h.body;
        const d2 = segSeg(L.fx, L.fy, L.fz, L.dx * len, L.dy * len, L.dz * len, b.pos.x, b.pos.y, b.pos.z, 0, b.height, 0);
        const rr = b.radius + LASER_R;
        if (d2 > rr * rr) continue;
        const s = SS.s * len;
        const px = L.fx + L.dx * s; const py = L.fy + L.dy * s; const pz = L.fz + L.dz * s;
        hurt(h, 1, px, py, pz, b.pos.x - px, b.pos.z - pz, KNOCK_UP, 'laser');
      }
    }
    for (let i = 0; i < spikes.length; i++) {
      const S = spikes[i];
      let up = true;
      if (S.period) { const cyc = S.period[0] + S.period[1]; if (cyc > 0) { const ph = (((t + S.phase) % cyc) + cyc) % cyc; up = ph < S.period[0]; } }
      S.up = up ? Math.min(1, S.up + dt * 8) : Math.max(0, S.up - dt * 4);
      S.s.up = S.up;
      if (S.up < 0.6) continue;
      const top = S.base + S.h * S.up;
      for (let k = 0; k < heroRecs.length; k++) {
        const h = heroRecs[k];
        if (!h.alive) continue;
        const b = h.body;
        if (b.pos.y > top || b.pos.y + b.height < S.base) continue;
        if (circleRect(b.pos.x, b.pos.z, b.radius * 0.6, S) <= 0) continue;
        hurt(h, 1, b.pos.x, S.base, b.pos.z, b.pos.x - S.x, b.pos.z - S.z, 9, 'spikes');
      }
    }
  }
  function updateKills() {
    for (let i = 0; i < heroRecs.length; i++) {
      const h = heroRecs[i];
      if (!h.alive) continue;
      const b = h.body; const st = bst(b);
      const k = killAt(b.pos.x, b.pos.z, b.pos.y);
      if (k && (!st.inKill || st.voidT <= 0)) { emit({ type: 'void', hero: h.id }); st.voidT = 1.5; }
      st.inKill = k;
    }
  }
  let shardsGot = 0;
  function updateItems(dt) {
    for (let i = 0; i < shards.length; i++) {
      const s = shards[i];
      if (s.taken) { if (s.s.taken < 1) { s.s.taken = Math.min(1, s.s.taken + dt * 2.5); if (s.s.taken >= 1) s.prop.root.visible = false; } continue; }
      for (let k = 0; k < heroRecs.length; k++) {
        const h = heroRecs[k];
        if (!h.alive) continue;
        const b = h.body;
        const dx = s.x - b.pos.x; const dz = s.z - b.pos.z;
        if (dx * dx + dz * dz > SHARD_R * SHARD_R) continue;
        const cy = clamp(s.y, b.pos.y, b.pos.y + b.height);
        if (dx * dx + dz * dz + (s.y - cy) * (s.y - cy) > SHARD_R * SHARD_R) continue;
        s.taken = true; s.s.taken = 0.01; shardsGot++; W.shards = shardsGot;
        emit({ type: 'shard', pos: V(s.x, s.y, s.z), hero: h.id, index: i });
        break;
      }
    }
    for (let i = 0; i < checkpoints.length; i++) {
      const c = checkpoints[i];
      if (c.index <= checkpoint.index) continue;
      for (let k = 0; k < heroRecs.length; k++) {
        const h = heroRecs[k];
        if (!h.alive || !nearPoint(h.body, c.x, c.y, c.z, CHECK_R, 0.8, 2.5)) continue;
        checkpoint.index = c.index; checkpoint.pos.set(c.x, c.y, c.z);
        const yaw = num(c.src.yaw, Math.atan2(c.x - spawn.pos.x, c.z - spawn.pos.z));
        checkpoint.yaw = yaw; checkpoint.heroes = placeTeam(c.x, c.y, c.z, yaw, false);
        for (let j = 0; j < checkpoints.length; j++) { checkpoints[j].active = checkpoints[j].index <= c.index; checkpoints[j].s.active = checkpoints[j].active; }
        emit({ type: 'checkpoint', pos: V(c.x, c.y, c.z), index: c.index, yaw, hero: h.id });
        break;
      }
    }
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      p.fire = Math.max(0, p.fire - dt * 3); p.s.fire = p.fire;
      for (let k = 0; k < heroRecs.length; k++) {
        const h = heroRecs[k];
        if (!h.alive) continue;
        const b = h.body;
        const dx = b.pos.x - p.x; const dz = b.pos.z - p.z;
        if (dx * dx + dz * dz > PAD_R * PAD_R || b.pos.y < p.y - 0.15 || b.pos.y > p.y + 0.45 || b.vel.y > 0.5) continue;
        b.vel.y = p.power; b.grounded = false; b.ground = null; bst(b).carrier = null;
        p.fire = 1; p.s.fire = 1;
        emit({ type: 'bounce', hero: h.id, pos: V(p.x, p.y, p.z), power: p.power });
      }
    }
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i];
      const usable = !g.sigs || cond(g);
      g.fire = Math.max(0, g.fire - dt * 1.5);
      g.s.open = usable; g.s.fire = g.fire;
      if (!usable) continue;
      for (let k = 0; k < heroRecs.length; k++) {
        const h = heroRecs[k];
        if (!h.alive) continue;
        const st = bst(h.body);
        if (st.gateT > 0 || !nearPoint(h.body, g.x, g.y, g.z, GATE_R, 0.3, 2.2)) continue;
        st.gateT = 1.2; g.fire = 1;
        const to = g.to || checkpoint.pos;
        emit({ type: 'gate', hero: h.id, from: V(g.x, g.y, g.z), to: to.clone(), yaw: g.yaw ?? (g.to ? null : checkpoint.yaw) });
      }
    }
    const act = activeHero();
    if (act) {
      const b = act.body;
      for (let i = 0; i < tips.length; i++) {
        const tp = tips[i];
        if (tp.shown) continue;
        const dx = b.pos.x - tp.x; const dz = b.pos.z - tp.z;
        if (dx * dx + dz * dz <= tp.r * tp.r && Math.abs(b.pos.y - tp.y) <= Math.max(2.5, tp.r)) { tp.shown = true; emit({ type: 'tip', text: tp.text, index: i }); }
      }
    }
    const need = teamN || heroes.length;
    for (let i = 0; i < portals.length; i++) {
      const P = portals[i];
      let inside = 0;
      for (let k = 0; k < heroRecs.length; k++) {
        const h = heroRecs[k];
        if (h.alive && nearPoint(h.body, P.x, P.y, P.z, PORTAL_R, 0, 2.5) && h.body.pos.y >= P.y - 0.6) inside++;   // stacked heroes count
      }
      const usable = !P.sigs || cond(P);
      if (inside !== P.inside || need !== P.need) { P.inside = inside; P.need = need; emit({ type: 'portal', inside, need }); }
      P.open = usable && inside >= need && need > 0;
      P.s.open = P.open; P.s.inside = inside; P.s.need = need; P.s.usable = usable;
      if (P.open && !P.exited) { P.exited = true; emit({ type: 'exit' }); }
    }
  }
  function activeHero() {
    for (let i = 0; i < heroRecs.length; i++) if (heroRecs[i].active && heroRecs[i].alive) return heroRecs[i];
    return null;
  }
  const tips = (Array.isArray(def.tips) ? def.tips : []).filter((tp) => tp && Array.isArray(tp.p)).map((tp) => ({ x: at(tp.p, 0), y: at(tp.p, 1), z: at(tp.p, 2), r: num(tp.r, 3), text: tp.text || '', shown: false }));

  // ---------------------------------------------------------------- enemy AI
  const chestY = (b) => b.pos.y + b.height * 0.6;
  // nearest living hero the eye can see (within range and, if cone > 0, within the cone around yaw)
  function seeHero(e, range, cone) {
    let best = null; let bd = range * range;
    for (let i = 0; i < heroRecs.length; i++) {
      const h = heroRecs[i];
      if (!h.alive || bst(h.body).safeT > 0) continue;
      const b = h.body;
      const dx = b.pos.x - e.eye.x; const dy = chestY(b) - e.eye.y; const dz = b.pos.z - e.eye.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > bd) continue;
      if (cone > 0 && dx * dx + dz * dz > 0.04 && Math.abs(wrapAngle(Math.atan2(dx, dz) - e.yaw)) > cone) continue;
      if (!clearLine(e.eye.x, e.eye.y, e.eye.z, b.pos.x, chestY(b), b.pos.z, e)) continue;
      best = h; bd = d2;
    }
    return best;
  }
  function aimAt(e, h) { e.aimV.set(h.body.pos.x, chestY(h.body), h.body.pos.z); e.aimOn = true; }
  function updSentry(e, dt) {
    if (e.stun > 0) {
      e.stun -= dt; e.state = 'stunned'; e.aimOn = false; e.target = null;
      if (e.stun <= 0) { e.stun = 0; e.state = 'patrol'; e.lost = 0; }
      return;
    }
    const cone = e.state === 'patrol' || e.state === 'idle' ? e.halfFov : e.halfFov + 30 * DEG;
    const seen = seeHero(e, e.range, cone);
    if (e.state === 'patrol' || e.state === 'idle') {
      patrol(e, dt);
      if (seen) { e.state = 'alert'; e.alertT = 0; e.lost = 0; e.target = seen; aimAt(e, seen); emit({ type: 'alarm', pos: V(e.x, e.y, e.z), kind: 'sentry' }); }
      else e.aimOn = false;
      return;
    }
    if (seen) { e.target = seen; e.lost = 0; aimAt(e, seen); } else e.lost += dt;
    if (e.target) e.yaw = turnTo(e.yaw, Math.atan2(e.aimV.x - e.x, e.aimV.z - e.z), 4 * dt);
    if (e.state === 'alert') {
      e.alertT += dt;
      if (e.alertT >= 0.6) { e.state = 'attack'; e.fireT = 0; }
    } else if (e.state === 'attack') {
      e.fireT -= dt;
      if (seen && e.fireT <= 0) {
        e.fireT = 1.4;
        fire(e, e.muz.x, e.muz.y, e.muz.z, e.aimV.x - e.muz.x, e.aimV.y - e.muz.y, e.aimV.z - e.muz.z, 6, 0.28, false, COL_SENTRY, 3.5);
        emit({ type: 'shot', pos: V(e.muz.x, e.muz.y, e.muz.z), kind: 'sentry' });
      }
    }
    if (e.lost >= 3) { e.state = 'patrol'; e.target = null; e.aimOn = false; }
  }
  function patrol(e, dt) {
    const pts = e.route; const n = pts.length;
    if (e.approach) {                         // spawned off its path: fly onto it first
      const b = pts[0];
      const dx = b[0] - e.x; const dy = b[1] - e.y; const dz = b[2] - e.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz); const step = e.speed * dt;
      if (d <= step) { e.x = b[0]; e.y = b[1]; e.z = b[2]; e.approach = false; e.i = 0; e.wait = 0.5; } else {
        e.x += (dx / d) * step; e.y += (dy / d) * step; e.z += (dz / d) * step;
        if (dx * dx + dz * dz > 1e-6) e.yaw = turnTo(e.yaw, Math.atan2(dx, dz), 3 * dt);
      }
      return;
    }
    if (n < 2) { e.yaw = e.baseYaw + Math.sin(CLK.now * 0.6) * 0.8; return; }
    if (e.wait > 0) { e.wait -= dt; } else {
      const nextI = e.loop ? (e.i + 1) % n : clamp(e.i + e.dir, 0, n - 1);
      const b = pts[nextI];
      const dx = b[0] - e.x; const dy = b[1] - e.y; const dz = b[2] - e.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const step = e.speed * dt;
      if (d <= step || d < 1e-4) {
        e.x = b[0]; e.y = b[1]; e.z = b[2]; e.i = nextI; e.wait = 0.8;
        if (!e.loop) { if (e.i === n - 1) e.dir = -1; else if (e.i === 0) e.dir = 1; }
      } else {
        e.x += (dx / d) * step; e.y += (dy / d) * step; e.z += (dz / d) * step;
        if (dx * dx + dz * dz > 1e-6) e.yaw = turnTo(e.yaw, Math.atan2(dx, dz), 3 * dt);
      }
    }
    if (e.wait > 0) {
      // look toward the next leg while waiting
      const nextI = e.loop ? (e.i + 1) % n : clamp(e.i + e.dir, 0, n - 1);
      const b = pts[nextI];
      if ((b[0] - e.x) ** 2 + (b[2] - e.z) ** 2 > 1e-6) e.yaw = turnTo(e.yaw, Math.atan2(b[0] - e.x, b[2] - e.z), 2.5 * dt);
    }
  }
  // crawlers: chase the nearest hero, steer around walls and stop at edges
  function pathClear(e, ang, len) {
    const b = e.body;
    const sx = Math.sin(ang); const sz = Math.cos(ang);
    const y = b.pos.y + 0.35;
    if (castSolid(b.pos.x, y, b.pos.z, sx, 0, sz, len, null, false)) return false;
    for (let k = 0; k < 2; k++) {            // whiskers at the body's sides
      const side = k ? 1 : -1;
      const ox = b.pos.x + sz * side * b.radius * 0.9; const oz = b.pos.z - sx * side * b.radius * 0.9;
      if (castSolid(ox, y, oz, sx, 0, sz, len * 0.8, null, false)) return false;
    }
    return groundAhead(e, ang, 0.9);
  }
  // solid, safe ground within a step of the feet `ahead` metres along ang (no ledges, no lava)
  function groundAhead(e, ang, ahead = 0.6) {
    const b = e.body;
    const ax = b.pos.x + Math.sin(ang) * ahead; const az = b.pos.z + Math.cos(ang) * ahead;
    if (!castSolid(ax, b.pos.y + 0.5, az, 0, -1, 0, 0.5 + STEP + 0.6, null, false)) return false;
    if (killers.length && killAt(ax, az, b.pos.y + 0.5 - RC.t)) return false;
    return true;
  }
  function updCrawler(e, dt) {
    const b = e.body;
    if (!e.alive) {
      e.deadT += dt;
      if (e.deadT > 2.5 && !e.gone) { e.gone = true; e.vis.root.visible = false; }
      return;
    }
    b.vel.y = Math.max(b.vel.y - GRAVITY * dt, -MAX_FALL);
    let spd = 0;
    if (e.stun > 0) { e.stun -= dt; e.state = 'stunned'; e.aimOn = false; } else if (e.hitPause > 0) { e.hitPause -= dt; e.state = 'idle'; } else {
      // target: nearest living hero within range at about the same height
      let tgt = null; let bd = e.range * e.range;
      for (let i = 0; i < heroRecs.length; i++) {
        const h = heroRecs[i];
        if (!h.alive || bst(h.body).safeT > 0) continue;
        const hb = h.body;
        const dx = hb.pos.x - b.pos.x; const dy = hb.pos.y - b.pos.y; const dz = hb.pos.z - b.pos.z;
        if (Math.abs(dy) > 2.5) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; tgt = h; }
      }
      let want;
      if (tgt) {
        e.state = 'chase'; e.target = tgt; aimAt(e, tgt); spd = e.speed;
        want = Math.atan2(tgt.body.pos.x - b.pos.x, tgt.body.pos.z - b.pos.z);
      } else {
        e.state = 'patrol'; e.target = null; e.aimOn = false; spd = 1.1;
        e.wanderT -= dt;
        const dx = e.wx - b.pos.x; const dz = e.wz - b.pos.z;
        if (e.wanderT <= 0 || dx * dx + dz * dz < 0.25) { const a = rnd() * TAU; const rr = 1 + rnd() * 2.5; e.wx = e.home.x + Math.cos(a) * rr; e.wz = e.home.z + Math.sin(a) * rr; e.wanderT = 2 + rnd() * 2; }
        want = Math.atan2(e.wx - b.pos.x, e.wz - b.pos.z);
      }
      // steering at 10 Hz: straight at the target when the way is clear; otherwise follow the obstacle on
      // one side (the side that opened first) until the direct way clears again — no dithering at walls
      e.steerT -= dt;
      if (e.steerT <= 0) {
        e.steerT = 0.1;
        e.steer = null;
        if (pathClear(e, want, 1.3)) { e.steer = want; e.side = 0; } else {
          const pref = e.side || 0;
          for (let pass = 0; pass < 2 && e.steer === null; pass++) {
            const sgn = pref ? (pass ? -pref : pref) : 0;
            for (let k = 0; k < STEER.length && e.steer === null; k++) {
              for (let q = 0; q < (sgn ? 1 : 2); q++) {
                const sd = sgn || (q ? -1 : 1);
                const a = want + STEER[k] * sd;
                if (!pathClear(e, a, 1.3)) continue;
                e.steer = a; e.side = sd;
                if (STEER[k] >= 1) e.steerT = 0.2;     // hold a big detour a little so it rounds corners
                break;
              }
            }
            if (!pref) break;
          }
          if (e.steer === null) e.side = -(e.side || 1);   // boxed in: try the other way next time
        }
      }
      if (e.steer === null || e.steer === undefined) spd = 0;
      else {
        const turnLeft = Math.abs(wrapAngle(e.steer - e.heading));
        e.heading = turnTo(e.heading, e.steer, 8 * dt);
        if (turnLeft > 1.2) spd *= 0.25;         // sharp turns happen nearly on the spot
      }
      // whatever the steering said: never step toward a drop or lava (checked every frame on the real heading)
      if (spd > 0 && !groundAhead(e, e.heading)) { spd = 0; e.steerT = 0; }
      // close enough to the target: stop pushing into it
      if (tgt) { const dx = tgt.body.pos.x - b.pos.x; const dz = tgt.body.pos.z - b.pos.z; if (dx * dx + dz * dz < 0.2) spd = 0; }
    }
    b.vel.x = Math.sin(e.heading) * spd; b.vel.z = Math.cos(e.heading) * spd;
    simulate(b, dt, null);
    e.x = b.pos.x; e.y = b.pos.y; e.z = b.pos.z; e.yaw = e.heading;
    if (killAt(b.pos.x, b.pos.z, b.pos.y)) { killEnemy(e, 'fall'); return; }
    // contact damage, unless the hero comes down on its back
    if (e.stun <= 0) {
      for (let i = 0; i < heroRecs.length; i++) {
        const h = heroRecs[i];
        if (!h.alive) continue;
        const hb = h.body;
        const top = b.pos.y + b.height;
        if (hb.pos.y > top - 0.05 || hb.pos.y + hb.height < b.pos.y + 0.05) continue;
        const dx = hb.pos.x - b.pos.x; const dz = hb.pos.z - b.pos.z; const rr = hb.radius + b.radius - 0.05;
        if (dx * dx + dz * dz > rr * rr) continue;
        if (hb.pos.y > top - 0.35 && hb.vel.y <= 0.5 && (h.id === 'pix' || hb.heavy) && !e.armoured) { killEnemy(e, 'stomp'); hb.vel.y = 9; hb.grounded = false; break; }
        if (hurt(h, 1, b.pos.x, b.pos.y + 0.35, b.pos.z, dx, dz, KNOCK_UP, 'crawler')) e.hitPause = 0.9;
      }
    }
  }
  function updTurret(e, dt) {
    if (!e.alive) return;
    if (e.stun > 0) { e.stun -= dt; e.state = 'stunned'; e.charge = 0; e.aimOn = false; return; }
    const tgt = seeHero(e, e.range, 0);
    if (!tgt) {
      e.state = 'idle'; e.target = null; e.aimOn = false; e.charge = Math.max(0, e.charge - dt * 2);
      e.yaw += Math.sin(CLK.now * 0.5 + e.x) * 0.3 * dt;
      e.cool = Math.max(e.cool, 0.4);
      return;
    }
    e.target = tgt; aimAt(e, tgt);
    const want = Math.atan2(e.aimV.x - e.x, e.aimV.z - e.z);
    e.yaw = turnTo(e.yaw, want, 2.4 * dt);
    const aimed = Math.abs(wrapAngle(want - e.yaw)) < 0.2;
    e.cool -= dt;
    if (e.cool <= 0 && aimed) {
      e.state = 'attack'; e.charge += dt;
      if (e.charge >= 0.5) {
        e.charge = 0; e.cool = e.rate;
        fire(e, e.muz.x, e.muz.y, e.muz.z, e.aimV.x - e.muz.x, e.aimV.y - e.muz.y, e.aimV.z - e.muz.z, 16, 0.12, true, COL_TURRET, 2.2);
        emit({ type: 'shot', pos: V(e.muz.x, e.muz.y, e.muz.z), kind: 'turret' });
      }
    } else { e.state = 'alert'; if (!aimed) e.charge = Math.max(0, e.charge - dt); }
  }
  // The Warden: three shield phases, each needing a different hero, each ended by three zaps from Vera.
  // 1 · plates held (Brick on the heavy one, Pix on the other)  2 · nodes zapped  3 · armoured crawlers pounded.
  function updWarden(e, dt) {
    if (!e.alive) {
      e.deadT += dt;
      e.y = Math.max(e.floorY + 0.8, e.y - dt * (1 + e.deadT * 4));
      return;
    }
    if (!e.started) {
      e.state = 'idle';
      for (let i = 0; i < heroRecs.length; i++) {
        const h = heroRecs[i];
        if (h.alive && (h.body.pos.x - e.base.x) ** 2 + (h.body.pos.z - e.base.z) ** 2 < 400) { e.started = true; e.trans = 1.5; emit({ type: 'alarm', pos: V(e.x, e.y, e.z), kind: 'warden' }); break; }
      }
      if (!e.started) return;
    }
    e.invT = Math.max(0, e.invT - dt);
    e.cycle += dt;
    let open = false;
    if (e.trans > 0) {
      e.trans -= dt;
      if (e.trans <= 0 && e.phase === 3) spawnMinions(e);
    } else if (e.phase === 1) {
      if (e.plates.length) { open = true; for (let i = 0; i < e.plates.length; i++) if (!e.plates[i].pressed) { open = false; break; } } else open = e.cycle % 10 > 6;
    } else if (e.phase === 2) {
      if (e.nodes.length) {
        let all = true;
        for (let i = 0; i < e.nodes.length; i++) if (!e.nodes[i].on) { all = false; break; }
        if (all && e.window <= 0) e.window = 6;
      } else if (e.cycle % 10 > 6 && e.window <= 0) e.window = 3.5;
      if (e.window > 0) {
        e.window -= dt; open = true;
        if (e.window <= 0) { e.window = 0; for (let i = 0; i < e.nodes.length; i++) { e.nodes[i].on = false; e.nodes[i].timer = 0; } }   // overload spent: the nodes go dark
      }
    } else if (e.phase === 3) {
      let alive = 0;
      for (let i = 0; i < e.minions.length; i++) if (e.minions[i].alive) alive++;
      if (e.minions.length && !alive && e.window <= 0 && !e.used) { e.window = 6; e.used = true; }
      if (e.window > 0) {
        e.window -= dt; open = true;
        if (e.window <= 0) { e.window = 0; spawnMinions(e); }
      }
    }
    e.vulnerable = open && e.trans <= 0;
    e.s.shield = !e.vulnerable;
    // hover, lower and wobbling while the shield is down
    const sink = e.vulnerable ? 1.6 : 0;
    const ty = e.base.y - sink + Math.sin(CLK.now * 1.3) * 0.3;
    e.y += (ty - e.y) * Math.min(1, dt * 3);
    e.x = e.base.x + Math.sin(CLK.now * 0.4) * 1.2; e.z = e.base.z + Math.cos(CLK.now * 0.33) * 1.2;
    // attacks (only while shielded; the active hero is the one aimed at)
    const act = activeHero() || nearestHero(e.x, e.y, e.z);
    if (act) { aimAt(e, act); e.yaw = turnTo(e.yaw, Math.atan2(e.aimV.x - e.x, e.aimV.z - e.z), 2 * dt); }
    if (!e.vulnerable && e.trans <= 0 && act && bst(act.body).safeT <= 0) {
      e.aimT -= dt;
      if (e.aimT <= 0) { e.volley = e.phase === 3 ? 1 : 3; e.volleyT = 0; e.aimT = e.phase === 1 ? 2.8 : e.phase === 2 ? 2.6 : 2.2; }
      if (e.volley > 0) {
        e.volleyT -= dt;
        if (e.volleyT <= 0) {
          e.volley--; e.volleyT = 0.22;
          fire(e, e.x, e.y, e.z, e.aimV.x - e.x, e.aimV.y - e.y, e.aimV.z - e.z, 5.5, 0.32, false, COL_WARDEN, 6);
          emit({ type: 'shot', pos: V(e.x, e.y, e.z), kind: 'warden' });
        }
      }
      if (e.phase >= 2) {
        e.ringT -= dt;
        if (e.ringT <= 0) { e.ringT = e.phase === 2 ? 6.5 : 4.5; ring(e); }
      }
    }
    e.state = e.trans > 0 ? 'alert' : e.vulnerable ? 'stunned' : 'attack';
    e.s.phase = e.phase;
  }
  // a slow ring of orbs at knee height with a gap to slip through (or jump them)
  function ring(e) {
    const n = 14; const gap = Math.floor(rnd() * n); const y = e.floorY + 0.55;
    for (let i = 0; i < n; i++) {
      if ((i - gap + n) % n < 3) continue;
      const a = (i / n) * TAU;
      fire(e, e.x + Math.sin(a) * 1.4, y, e.z + Math.cos(a) * 1.4, Math.sin(a), 0, Math.cos(a), 4.2, 0.3, false, COL_WARDEN, 7);
    }
    emit({ type: 'shot', pos: V(e.x, y, e.z), kind: 'ring' });
  }
  function spawnMinions(e) {
    e.used = false;
    for (const m of e.minions) if (!m.alive && !m.gone) { m.gone = true; m.vis.root.visible = false; }
    e.minions = e.minions.filter((m) => m.alive);
    for (let i = e.minions.length; i < 3; i++) {
      const a = (i / 3) * TAU + rnd();
      let x = e.base.x + Math.sin(a) * 5; let z = e.base.z + Math.cos(a) * 5;
      let top = castSolid(x, e.base.y, z, 0, -1, 0, 40, null, false) ? e.base.y - RC.t : null;
      if (top === null) { x = e.base.x; z = e.base.z; top = e.floorY; }
      const m = addCrawler({ type: 'crawler', range: 30 }, x, top + 0.05, z, true);
      m.range = 30; m.speed = 2.6;
      e.minions.push(m);
      placeEnemy(m);
      fx('burst', V(x, top + 0.4, z), '#ff3355', 18, 3);
    }
  }
  function nearestHero(x, y, z) {
    let best = null; let bd = Infinity;
    for (let i = 0; i < heroRecs.length; i++) {
      const h = heroRecs[i];
      if (!h.alive) continue;
      const d = (h.body.pos.x - x) ** 2 + (h.body.pos.y - y) ** 2 + (h.body.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
  function wardenHit(e) {
    if (!e.vulnerable || e.invT > 0) return 'shield';
    e.invT = 0.5; e.hp--;
    e.s.hp01 = e.hp / e.maxHp;
    const phaseEnd = e.hp <= 0 ? true : e.hp <= (3 - e.phase) * 3;
    if (e.hp <= 0) { killEnemy(e, 'zap'); return 'destroy'; }
    if (phaseEnd) {
      e.phase++; e.trans = 2.2; e.window = 0; e.cycle = 0; e.used = false; e.ringT = 2.5; e.aimT = 1.5;
      for (const n of e.nodes) { n.on = false; n.timer = 0; }
      emit({ type: 'alarm', pos: V(e.x, e.y, e.z), kind: 'warden', phase: e.phase });
    }
    return 'damage';
  }
  // ---- the bosses ----
  const COL_MAW = new THREE.Color(3.0, 0.55, 0.2);
  const COL_QUEEN = new THREE.Color(2.2, 0.9, 3.0);
  const COL_ARCH = new THREE.Color(0.6, 3.0, 2.4);
  function bossTarget(e) {
    const ok = (h) => h && h.alive && bst(h.body).safeT <= 0 && (h.body.pos.x - e.base.x) ** 2 + (h.body.pos.z - e.base.z) ** 2 < e.reach * e.reach &&
      Math.abs(h.body.pos.y - e.floorY) < 9;
    const a = activeHero();
    if (ok(a)) return a;
    let best = null; let bd = Infinity;
    for (let i = 0; i < heroRecs.length; i++) {
      const h = heroRecs[i];
      if (!ok(h)) continue;
      const d = (h.body.pos.x - e.x) ** 2 + (h.body.pos.z - e.z) ** 2;
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }
  function bossReset(e, P) {
    if (P.need === 'nodes') for (const n of P.recs) { n.on = false; n.timer = 0; }
    else if (P.need === 'switches') for (const w of P.recs) { w.on = false; w.timer = 0; w.pulse = 0; }
    else if (P.need === 'cracked') {
      // the anchors grow back (unless something stands in them)
      for (const c of P.recs) {
        if (c.solid || occupied(c, 0.05)) continue;
        c.solid = true; c.broken = 0; c.s.broken = 0;
        fx('burst', V(c.x, c.y, c.z), BHEX[e.type] || '#ff8a3d', 16, 3);
      }
    }
  }
  function bossMinions(e, n, armoured) {
    for (const m of e.minions) if (!m.alive && !m.gone) { m.gone = true; m.vis.root.visible = false; }
    e.minions = e.minions.filter((m) => m.alive);
    for (let i = e.minions.length; i < n; i++) {
      const a = (i / n) * TAU + rnd();
      let x = 0; let z = 0; let top = null;
      for (const rr of [6, 9, 12, 14]) {
        x = e.base.x + Math.sin(a) * rr; z = e.base.z + Math.cos(a) * rr;
        top = castSolid(x, e.floorY + 6, z, 0, -1, 0, 12, null, false) ? e.floorY + 6 - RC.t : null;
        if (top !== null && Math.abs(top - e.floorY) < 3) break;
        top = null;
      }
      if (top === null) continue;
      const m = addCrawler({ type: 'crawler', range: 30 }, x, top + 0.05, z, armoured);
      m.range = 30; m.speed = 2.7;
      e.minions.push(m);
      placeEnemy(m);
      fx('burst', V(x, top + 0.4, z), BHEX[e.type] || '#ff5a1e', 18, 3);
    }
  }
  function bossPhaseStart(e) {
    const P = e.phases[e.phase - 1];
    e.window = 0; e.cycle = 0; e.used = false; e.phHits = 0;
    if (P.at) { e.goal.copy(P.at); }
    if (P.floor !== null) e.floorY = P.floor;
    if (P.adds) bossMinions(e, P.adds, false);
  }
  function updBoss(e, dt) {
    const sw = e.sw;
    if (!e.alive) {
      e.deadT += dt;
      e.y = Math.max(e.floorY + 0.8, e.y - dt * (1 + e.deadT * 3));
      sw.st = 'idle'; sw.core.visible = sw.glow.visible = false;
      return;
    }
    if (!e.started) {
      e.state = 'idle';
      for (let i = 0; i < heroRecs.length; i++) {
        const h = heroRecs[i];
        if (h.alive && (h.body.pos.x - e.base.x) ** 2 + (h.body.pos.z - e.base.z) ** 2 < e.wake * e.wake && Math.abs(h.body.pos.y - e.floorY) < 8) {
          e.started = true; e.trans = 2; bossPhaseStart(e);
          emit({ type: 'alarm', pos: V(e.x, e.y, e.z), kind: e.type, boss: e.id, phase: 1 });
          break;
        }
      }
      if (!e.started) return;
    }
    const P = e.phases[e.phase - 1];
    e.invT = Math.max(0, e.invT - dt);
    e.cycle += dt;
    // glide to this phase's spot (the Queen drops into the Underside and climbs back out)
    const gd = e.base.distanceTo(e.goal);
    if (gd > 0.01) {
      e.base.lerp(e.goal, Math.min(1, (dt * 7) / Math.max(gd, 0.5)));
      if (e.base.distanceTo(e.goal) < 0.05) { e.base.copy(e.goal); if (P.floor === null) e.floorY = floorUnder(e.base.x, e.base.y, e.base.z); }
    }
    let open = false;
    if (e.trans > 0) {
      e.trans -= dt;
      if (e.trans <= 0 && P.minions) bossMinions(e, P.minions, true);
    } else if (P.need === 'plates') {
      open = P.recs.length > 0 && P.recs.every((r) => r.pressed);
    } else {
      if (e.window <= 0) {
        let ready = false;
        if (P.need === 'nodes' || P.need === 'switches') ready = P.recs.length > 0 && P.recs.every((r) => r.on);
        else if (P.need === 'cracked') ready = P.recs.length > 0 && P.recs.every((r) => !r.solid);
        else if (P.need === 'minions') { ready = e.minions.length > 0 && e.minions.every((m) => !m.alive) && !e.used; }
        else ready = e.cycle % 10 > 6.5;
        if (ready) { e.window = P.need === 'timer' ? 3.5 : P.window; e.used = true; emit({ type: 'alarm', pos: V(e.x, e.y, e.z), kind: e.type, boss: e.id, open: true }); }
      }
      if (e.window > 0) {
        e.window -= dt; open = true;
        if (e.window <= 0) {
          e.window = 0; e.used = false;
          bossReset(e, P);
          if (P.need === 'minions') bossMinions(e, P.minions || 3, true);
        }
      }
    }
    e.vulnerable = open && e.trans <= 0;
    e.s.shield = !e.vulnerable;
    // float: the Maw rears up out of its pit and slumps when exposed; the Queen drifts in a slow figure eight
    const sink = e.vulnerable ? e.sinkBy : 0;
    const bob = e.type === 'maw' ? Math.sin(CLK.now * 0.9) * 0.45 : Math.sin(CLK.now * 1.2) * 0.35;
    const ty = e.base.y - sink + bob;
    e.y += (ty - e.y) * Math.min(1, dt * 3);
    if (e.type === 'queen') { e.x = e.base.x + Math.sin(CLK.now * 0.5) * 2.2; e.z = e.base.z + Math.sin(CLK.now * 1.0) * 1.2; }
    else if (e.type === 'architect') { const a = CLK.now * 0.42; e.x = e.base.x + Math.sin(a) * 4.2; e.z = e.base.z + Math.cos(a) * 3.2; }
    else { e.x += (e.base.x - e.x) * Math.min(1, dt * 2); e.z += (e.base.z - e.z) * Math.min(1, dt * 2); }
    const tgt = bossTarget(e);
    if (tgt) { aimAt(e, tgt); e.yaw = turnTo(e.yaw, Math.atan2(e.aimV.x - e.x, e.aimV.z - e.z), 2.2 * dt); } else e.aimOn = false;
    const fight = !e.vulnerable && e.trans <= 0 && gd < 0.5;
    const has = (a) => P.attacks.includes(a);
    const col = e.type === 'queen' ? COL_QUEEN : e.type === 'architect' ? COL_ARCH : COL_MAW;
    if (fight && tgt) {
      if (has('volley')) {
        e.aimT -= dt * P.rate;
        if (e.aimT <= 0) { e.volley = e.type === 'maw' ? 3 : e.type === 'architect' ? 5 : 4; e.volleyT = 0; e.aimT = 2.7; }
        if (e.volley > 0) {
          e.volleyT -= dt;
          if (e.volleyT <= 0) {
            e.volley--; e.volleyT = 0.2;
            // the Queen fans her volley; the Maw spits straight
            const spread = e.type === 'queen' ? (e.volley - 1.5) * 0.12 : e.type === 'architect' ? (e.volley - 2) * 0.16 : 0;
            const dx = e.aimV.x - e.x; const dz = e.aimV.z - e.z;
            const c = Math.cos(spread); const sn = Math.sin(spread);
            fire(e, e.x, e.y, e.z, dx * c + dz * sn, e.aimV.y - e.y, -dx * sn + dz * c, 6, 0.34, false, col, 6);
            emit({ type: 'shot', pos: V(e.x, e.y, e.z), kind: e.type });
          }
        }
      }
      if (has('ring')) {
        e.ringT -= dt * P.rate;
        if (e.ringT <= 0) { e.ringT = 6; bossRing(e, col); }
      }
      if (has('rain')) {
        e.rainT -= dt * P.rate;
        if (e.rainT <= 0) {
          e.rainT = 4.2;
          const b = tgt.body;
          for (let k = 0; k < 4; k++) {
            const a = rnd() * TAU; const r = k === 0 ? 0 : 1.5 + rnd() * 2;
            const px = b.pos.x + Math.sin(a) * r + b.vel.x * 0.6; const pz = b.pos.z + Math.cos(a) * r + b.vel.z * 0.6;
            const gy = castSolid(px, b.pos.y + 3, pz, 0, -1, 0, 12, null, false) ? b.pos.y + 3 - RC.t : b.pos.y;
            fx('shockwave', V(px, gy + 0.05, pz), e.type === 'queen' ? '#e879f9' : e.type === 'architect' ? '#3cffd0' : '#ff8a3d', 1.3);
            const sh = fire(e, px, gy + 11 + k * 1.2, pz, 0, -1, 0, 9, 0.42, false, col, 3);
            if (sh) sh.dmg = 1;
          }
          emit({ type: 'shot', pos: V(b.pos.x, b.pos.y, b.pos.z), kind: 'rain' });
        }
      }
    }
    // the sweep beam
    if (fight && has('sweep')) {
      sw.t -= dt * P.rate;
      if (sw.st === 'idle' && sw.t <= 0) {
        sw.st = 'warn'; sw.t = 1.1; sw.dir = rnd() < 0.5 ? -1 : 1;
        sw.a = tgt ? Math.atan2(tgt.body.pos.x - e.base.x, tgt.body.pos.z - e.base.z) - sw.dir * 1.2 : rnd() * TAU;
        emit({ type: 'alarm', pos: V(e.x, e.y, e.z), kind: 'sweep', boss: e.id });
      } else if (sw.st === 'warn' && sw.t <= 0) { sw.st = 'on'; sw.t = 4.6; }
      else if (sw.st === 'on') {
        sw.a += sw.dir * 1.05 * dt * P.rate;
        if (sw.t <= 0) { sw.st = 'idle'; sw.t = 4.5; }
      }
    } else if (sw.st !== 'idle') { sw.st = 'idle'; sw.t = 3; }
    if (sw.st !== 'idle') bossSweep(e, sw, P);
    else sw.core.visible = sw.glow.visible = false;
    e.state = e.trans > 0 ? 'alert' : e.vulnerable ? 'stunned' : 'attack';
    e.s.phase = e.phase;
  }
  function bossRing(e, col) {
    const n = 16; const gap = Math.floor(rnd() * n); const y = e.floorY + 0.55;
    for (let i = 0; i < n; i++) {
      if ((i - gap + n) % n < 3) continue;
      const a = (i / n) * TAU;
      fire(e, e.base.x + Math.sin(a) * 2.4, y, e.base.z + Math.cos(a) * 2.4, Math.sin(a), 0, Math.cos(a), 4.6, 0.3, false, col, 7);
    }
    emit({ type: 'shot', pos: V(e.base.x, y, e.base.z), kind: 'ring' });
  }
  function bossSweep(e, sw, P) {
    const dx = Math.sin(sw.a); const dz = Math.cos(sw.a);
    const y = e.floorY + 0.5; const r0 = 2.2;
    // pillars and crates are cover: the beam stops at the first solid thing
    const len = castSolid(e.base.x + dx * r0, y, e.base.z + dz * r0, dx, 0, dz, P.sweepLen, null, false) ? RC.t : P.sweepLen;
    sw.len = len; sw.y = y;
    const on = sw.st === 'on';
    const mx = e.base.x + dx * (r0 + len / 2); const mz = e.base.z + dz * (r0 + len / 2);
    const flick = on ? 1 : 0.35 + 0.35 * Math.sin(CLK.now * 30);
    sw.core.visible = sw.glow.visible = true;
    sw.core.position.set(mx, y, mz); sw.core.rotation.set(0, sw.a, 0);
    sw.core.scale.set(on ? 0.16 : 0.05, on ? 0.16 : 0.05, len);
    sw.core.material.opacity = flick;
    sw.glow.position.set(mx, y, mz); sw.glow.rotation.set(0, sw.a, 0);
    sw.glow.scale.set(on ? 0.55 : 0.2, on ? 0.4 : 0.12, len);
    sw.glow.material.opacity = on ? 0.5 : 0.25 * flick;
    if (!on) return;
    for (let i = 0; i < heroRecs.length; i++) {
      const h = heroRecs[i];
      if (!h.alive) continue;
      const b = h.body;
      if (b.pos.y > y + 0.05 || b.pos.y + b.height < y - 0.1) continue;   // jumped over it (or far below)
      const px = b.pos.x - e.base.x; const pz = b.pos.z - e.base.z;
      const along = px * dx + pz * dz;
      if (along < r0 - b.radius || along > r0 + len + b.radius) continue;
      const side = px * dz - pz * dx;
      if (Math.abs(side) > b.radius + 0.2) continue;
      if (b.heavy) { if (rnd() < 0.2) fx('sparkle', V(b.pos.x, y, b.pos.z), '#ffb347'); continue; }   // Brick is laser-proof
      hurt(h, 1, b.pos.x - dx, y, b.pos.z - dz, side >= 0 ? dz : -dz, side >= 0 ? -dx : dx, 6, 'sweep');
    }
  }
  function bossHit(e) {
    if (!e.vulnerable || e.invT > 0) return 'shield';
    e.invT = 0.45; e.hp--; e.phHits++;
    e.s.hp01 = e.hp / e.maxHp;
    const P = e.phases[e.phase - 1];
    if (e.hp <= 0) { sig(`${e.id}:${e.phase}`).latch = true; killEnemy(e, 'zap'); return 'destroy'; }
    if (e.phHits >= P.hits) {
      sig(`${e.id}:${e.phase}`).latch = true;
      bossReset(e, P);
      for (const m of e.minions) if (m.alive) killEnemy(m, 'boss');
      e.phase++; e.trans = 2.6; e.aimT = 1.5; e.ringT = 2.5; e.rainT = 2; e.sw.st = 'idle'; e.sw.t = 3;
      bossPhaseStart(e);
      emit({ type: 'alarm', pos: V(e.x, e.y, e.z), kind: e.type, boss: e.id, phase: e.phase });
    }
    return 'damage';
  }
  function bossInfo() {
    for (let i = 0; i < bosses.length; i++) {
      const e = bosses[i];
      if (e.started && (e.alive || e.deadT < 2)) return { name: e.name, hp01: Math.max(0, e.hp) / e.maxHp, phase: e.phase, phases: e.phases.length, open: !!e.vulnerable && e.alive, alive: e.alive, kind: e.type };
    }
    const w = warden.rec;
    if (w && w.started && (w.alive || w.deadT < 2)) return { name: 'The Warden', hp01: Math.max(0, w.hp) / w.maxHp, phase: w.phase, phases: 3, open: !!w.vulnerable && w.alive, alive: w.alive, kind: 'warden' };
    return null;
  }
  function updEnemies(dt) {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.gone) continue;
      if (e.type === 'sentry') updSentry(e, dt);
      else if (e.type === 'crawler') updCrawler(e, dt);
      else if (e.type === 'turret') updTurret(e, dt);
      else if (e.type === 'warden') updWarden(e, dt);
      else if (e.boss) updBoss(e, dt);
      placeEnemy(e);
    }
  }
  function updShots(dt) {
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (!s.on) continue;
      s.life -= dt;
      if (s.life <= 0) { s.on = false; continue; }
      const step = s.speed * dt;
      let tHit = castSolid(s.pos.x, s.pos.y, s.pos.z, s.dir.x, s.dir.y, s.dir.z, step + s.r, s.src, false) ? RC.t : Infinity;
      let who = null;
      for (let k = 0; k < heroRecs.length; k++) {
        const h = heroRecs[k];
        if (!h.alive) continue;
        const b = h.body;
        const d2 = segSeg(s.pos.x, s.pos.y, s.pos.z, s.dir.x * step, s.dir.y * step, s.dir.z * step, b.pos.x, b.pos.y, b.pos.z, 0, b.height, 0);
        const rr = b.radius + s.r;
        if (d2 > rr * rr) continue;
        const t = SS.s * step;
        if (t < tHit) { tHit = t; who = h; }
      }
      if (tHit === Infinity) { s.pos.addScaledVector(s.dir, step); continue; }
      s.pos.addScaledVector(s.dir, Math.max(0, tHit - (who ? 0 : s.r * 0.5)));
      s.on = false;
      if (who) {
        if (s.bolt && who.body.heavy) fx('sparkle', s.pos.clone(), '#ffb347');     // Brick shrugs off laser bolts
        else hurt(who, s.dmg, s.pos.x, s.pos.y, s.pos.z, s.dir.x, s.dir.z, 4, s.bolt ? 'bolt' : 'orb');
      } else fx('burst', s.pos.clone(), s.bolt ? '#ff8a3d' : '#ff4fd8', 10, 2.5);
    }
  }

  // ---------------------------------------------------------------- visuals
  const M4 = new THREE.Matrix4(); const Q4 = new THREE.Quaternion(); const S4 = new THREE.Vector3(); const QI = new THREE.Quaternion();
  function syncVisuals(t, dt) {
    for (let i = 0; i < movers.length; i++) { const m = movers[i]; m.prop.root.position.set(m.x, m.minY, m.z); m.prop.update(t, dt, m.s); }
    for (let i = 0; i < crumbles.length; i++) { const c = crumbles[i]; if (typeof c.vis.update === 'function') c.vis.update(t, dt, c.s || {}); }
    for (let i = 0; i < crates.length; i++) {
      const c = crates[i];
      c.prop.root.position.set(c.x, c.minY, c.z); c.prop.root.visible = c.solid;
      c.s.pushed = c.pushT > 0;
      c.prop.update(t, dt, c.s);
    }
    for (let i = 0; i < doors.length; i++) doors[i].prop.update(t, dt, doors[i].s);
    for (let i = 0; i < cracked.length; i++) {
      const c = cracked[i];
      if (!c.solid && c.broken < 1) { c.broken = Math.min(1, c.broken + dt * 2); c.s.broken = c.broken; }
      c.prop.update(t, dt, c.s);
    }
    for (let i = 0; i < plates.length; i++) { const p = plates[i]; p.s.pressed = p.pressed; p.prop.update(t, dt, p.s); }
    for (let i = 0; i < switches.length; i++) { const s = switches[i]; s.s.on = s.on; s.prop.update(t, dt, s.s); }
    for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; n.s.on = n.on; n.s.left = n.time > 0 ? n.timer / n.time : n.on ? 1 : 0; n.prop.update(t, dt, n.s); }
    for (let i = 0; i < shards.length; i++) { const s = shards[i]; if (s.prop.root.visible) s.prop.update(t, dt, s.s); }
    for (let i = 0; i < checkpoints.length; i++) checkpoints[i].prop.update(t, dt, checkpoints[i].s);
    for (let i = 0; i < pads.length; i++) pads[i].prop.update(t, dt, pads[i].s);
    for (let i = 0; i < lasers.length; i++) lasers[i].prop.update(t, dt, lasers[i].s);
    for (let i = 0; i < spikes.length; i++) spikes[i].prop.update(t, dt, spikes[i].s);
    for (let i = 0; i < signs.length; i++) signs[i].prop.update(t, dt, signs[i].s);
    for (let i = 0; i < portals.length; i++) portals[i].prop.update(t, dt, portals[i].s);
    for (let i = 0; i < gates.length; i++) gates[i].prop.update(t, dt, gates[i].s);
    for (let i = 0; i < surfaces.length; i++) surfaces[i].vis.update(t);
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.gone) continue;
      const root = e.vis.root;
      root.position.set(e.rx, e.ry, e.rz); root.rotation.y = e.yaw;
      const s = e.s;
      s.state = e.state; s.aim = e.aimOn ? e.aimV : null; s.hp01 = e.maxHp > 0 ? Math.max(0, e.hp) / e.maxHp : 1;
      // charge-up 0..1 before a shot (turret: the 0.5 s charge; warden: the last 0.8 s before a volley); null = model's own
      s.charge = e.type === 'turret' ? clamp(e.charge / 0.5, 0, 1)
        : e.type === 'warden' ? (e.alive && e.started && !e.vulnerable && e.trans <= 0 ? clamp(1 - e.aimT / 0.8, 0, 1) : 0) : null;
      if (e.type === 'warden') { s.phase = e.phase; s.shield = !e.vulnerable && e.alive; }
      if (e.boss) {
        s.phase = e.phase; s.shield = !e.vulnerable && e.alive;
        s.charge = e.alive && e.started && !e.vulnerable && e.trans <= 0 ? Math.max(clamp(1 - e.aimT / 0.8, 0, 1), e.sw.st === 'warn' ? 1 : 0) : 0;
        s.sweep = e.sw.st === 'on' ? 1 : e.sw.st === 'warn' ? 0.5 : 0;
        s.awake = e.started;
      }
      e.vis.update(t, dt, s);
    }
    let no = 0; let nb = 0;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      if (!s.on) continue;
      if (s.bolt) {
        Q4.setFromUnitVectors(UPV, s.dir); S4.set(s.r, 0.9, s.r);
        M4.compose(s.pos, Q4, S4); boltMesh.setMatrixAt(nb, M4); boltMesh.setColorAt(nb, s.color); nb++;
      } else {
        const pulse = 1 + Math.sin(t * 18 + i) * 0.12;
        S4.set(s.r * pulse, s.r * pulse, s.r * pulse);
        M4.compose(s.pos, QI, S4); orbMesh.setMatrixAt(no, M4); orbMesh.setColorAt(no, s.color); no++;
      }
    }
    orbMesh.count = no; boltMesh.count = nb;
    if (no) { orbMesh.instanceMatrix.needsUpdate = true; orbMesh.instanceColor.needsUpdate = true; }
    if (nb) { boltMesh.instanceMatrix.needsUpdate = true; boltMesh.instanceColor.needsUpdate = true; }
  }

  // ---------------------------------------------------------------- the API
  // results come from a small ring, valid for the next seven calls
  const HITS = [];
  for (let i = 0; i < 8; i++) HITS.push({ dist: 0, point: V(0, 0, 0), normal: V(0, 0, 0), kind: '', ref: null, effect: '' });
  let hitI = 0;
  function hitOut(dist, ox, oy, oz, dx, dy, dz, nx, ny, nz, kind, ref, effect) {
    const h = HITS[hitI]; hitI = (hitI + 1) & 7;
    h.dist = dist; h.point.set(ox + dx * dist, oy + dy * dist, oz + dz * dist); h.normal.set(nx, ny, nz);
    h.kind = kind; h.ref = ref; h.effect = effect || '';
    return h;
  }
  // zap targets as vertical capsules: fills TG and returns false when there is no target
  const TG = { x: 0, z: 0, y0: 0, y1: 0, r: 0 };
  function targetOf(o) {
    if (o.kind === 'enemy') {
      if (!o.alive || o.gone) return false;
      if (o.type === 'sentry') { TG.x = o.eye.x; TG.z = o.eye.z; TG.y0 = o.eye.y - 0.3; TG.y1 = o.eye.y + 0.3; TG.r = 0.6; } else if (o.type === 'crawler') { TG.x = o.x; TG.z = o.z; TG.y0 = o.y + 0.15; TG.y1 = o.y + 0.55; TG.r = 0.5; } else if (o.type === 'turret') { TG.x = o.x; TG.z = o.z; TG.y0 = o.y + 0.25; TG.y1 = Math.max(o.y + 0.3, o.eye.y); TG.r = 0.6; } else if (o.boss) { TG.x = o.x; TG.z = o.z; TG.y0 = o.y - 0.8; TG.y1 = o.y + 0.8; TG.r = 1.9; } else { TG.x = o.x; TG.z = o.z; TG.y0 = o.y; TG.y1 = o.y; TG.r = 1.3; }
      return true;
    }
    if (o.kind === 'node') { TG.x = o.x; TG.z = o.z; TG.y0 = o.y + 0.3; TG.y1 = o.y + 1.5; TG.r = 0.5; return true; }
    if (o.kind === 'switch') { TG.x = o.x; TG.z = o.z; TG.y0 = o.y + 0.2; TG.y1 = o.y + 1.2; TG.r = 0.5; return true; }
    return false;
  }
  const TGT = { t: 0, rec: null };
  // nearest target along the ray within (radius + assist); with los, the line to its centre must be clear
  function findTarget(ox, oy, oz, dx, dy, dz, maxT, assist, wallT, los) {
    TGT.t = Infinity; TGT.rec = null;
    const n = enemies.length + nodes.length + switches.length;
    for (let i = 0; i < n; i++) {
      const o = i < enemies.length ? enemies[i] : i < enemies.length + nodes.length ? nodes[i - enemies.length] : switches[i - enemies.length - nodes.length];
      if (!targetOf(o)) continue;
      const rr = TG.r + assist;
      const d2 = segSeg(ox, oy, oz, dx * maxT, dy * maxT, dz * maxT, TG.x, TG.y0, TG.z, 0, TG.y1 - TG.y0, 0);
      if (d2 > rr * rr) continue;
      const along = SS.s * maxT;
      const cy = TG.y0 + (TG.y1 - TG.y0) * SS.t;
      const t = Math.max(0, along - Math.sqrt(Math.max(0, rr * rr - d2)));
      if (t >= TGT.t || along > wallT + TG.r) continue;
      if (los && !clearLine(ox, oy, oz, TG.x, cy, TG.z, o)) continue;
      TGT.t = t; TGT.rec = o;
    }
    return TGT.rec;
  }
  const RD = { x: 0, y: 0, z: 0 };
  function unitDir(dir) {
    const l = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (!(l > 1e-9)) return false;
    RD.x = dir.x / l; RD.y = dir.y / l; RD.z = dir.z / l;
    return true;
  }
  function raycast(origin, dir, maxDist, opts) {
    if (disposed || !origin || !dir || !unitDir(dir)) return null;
    const solidOnly = !opts || opts.solidOnly !== false;
    const maxT = num(maxDist, 100);
    const ox = origin.x; const oy = origin.y; const oz = origin.z;
    castSolid(ox, oy, oz, RD.x, RD.y, RD.z, maxT, null, false);
    let best = RC.rec ? RC.t : Infinity; let rec = RC.rec; let nx = RC.nx; let ny = RC.ny; let nz = RC.nz;
    if (!solidOnly && findTarget(ox, oy, oz, RD.x, RD.y, RD.z, Math.min(maxT, best), 0, best, false) && TGT.t < best) {
      best = TGT.t; rec = TGT.rec; nx = -RD.x; ny = -RD.y; nz = -RD.z;
    }
    if (!rec) return null;
    return hitOut(best, ox, oy, oz, RD.x, RD.y, RD.z, nx, ny, nz, rec.kind, rec, '');
  }
  function zap(origin, dir, range) {
    if (disposed || !origin || !dir || !unitDir(dir)) return null;
    const maxT = num(range, 14);
    const ox = origin.x; const oy = origin.y; const oz = origin.z;
    const dx = RD.x; const dy = RD.y; const dz = RD.z;
    castSolid(ox, oy, oz, dx, dy, dz, maxT, null, false);
    const wallRec = RC.rec; const wallT = wallRec ? RC.t : maxT; const wnx = RC.nx; const wny = RC.ny; const wnz = RC.nz;
    const o = findTarget(ox, oy, oz, dx, dy, dz, maxT, ZAP_ASSIST, wallT, true);
    if (!o) return wallRec ? hitOut(wallT, ox, oy, oz, dx, dy, dz, wnx, wny, wnz, wallRec.kind, wallRec, 'none') : null;
    const t = TGT.t;
    let effect = 'none';
    if (o.kind === 'enemy') {
      if (o.type === 'sentry') { o.stun = 5; o.state = 'stunned'; o.target = null; o.aimOn = false; effect = 'stun'; } else if (o.type === 'crawler') { o.stun = 3; o.state = 'stunned'; effect = 'stun'; } else if (o.type === 'turret') {
        o.hp--; o.stun = 0.8; o.charge = 0;
        if (o.hp <= 0) { killEnemy(o, 'zap'); effect = 'destroy'; } else effect = 'damage';
      } else if (o.type === 'warden') effect = wardenHit(o);
      else if (o.boss) effect = bossHit(o);
    } else if (o.kind === 'node') {
      o.on = true; o.timer = o.time > 0 ? o.time : 0; effect = 'on';
    } else if (o.kind === 'switch') {
      if (o.mode === 'toggle') { o.on = !o.on; effect = o.on ? 'on' : 'off'; } else if (o.mode === 'hold') { o.pulse = 0.6; o.on = true; effect = 'on'; } else { o.timer = o.time; o.on = true; effect = 'on'; }
    }
    return hitOut(t, ox, oy, oz, dx, dy, dz, -dx, -dy, -dz, o.kind, o, effect);
  }
  // aim assist for the game: the best zap target within coneDeg of dir (clear line), or null
  const AIM = { point: V(0, 0, 0), kind: '', ref: null, dist: 0 };
  function aim(origin, dir, range = 14, coneDeg = 25) {
    if (disposed || !origin || !dir || !unitDir(dir)) return null;
    const cosMax = Math.cos(coneDeg * DEG);
    let best = null; let bs = -Infinity;
    const n = enemies.length + nodes.length + switches.length;
    for (let i = 0; i < n; i++) {
      const o = i < enemies.length ? enemies[i] : i < enemies.length + nodes.length ? nodes[i - enemies.length] : switches[i - enemies.length - nodes.length];
      if (!targetOf(o)) continue;
      const cx = TG.x; const cy = (TG.y0 + TG.y1) / 2; const cz = TG.z;
      const vx = cx - origin.x; const vy = cy - origin.y; const vz = cz - origin.z;
      const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (d > range + TG.r || d < 1e-3) continue;
      const cos = (vx * RD.x + vy * RD.y + vz * RD.z) / d;
      if (cos < cosMax) continue;
      const score = cos - d / (range * 8) + (o.kind === 'enemy' && o.state === 'attack' ? 0.05 : 0);
      if (score <= bs) continue;
      if (!clearLine(origin.x, origin.y, origin.z, cx, cy, cz, o)) continue;
      bs = score; best = o; AIM.point.set(cx, cy, cz); AIM.dist = d;
    }
    if (!best) return null;
    AIM.kind = best.kind; AIM.ref = best;
    return AIM;
  }
  function pound(pos, radius = 2) {
    if (disposed || !pos) return 0;
    const rad = num(radius, 2);
    let n = 0;
    const px = pos.x; const py = pos.y + 0.3; const pz = pos.z;
    for (let i = 0; i < cracked.length; i++) {
      const c = cracked[i];
      if (!c.solid) continue;
      const qx = clamp(px, c.minX, c.maxX) - px; const qy = clamp(py, c.minY, c.maxY) - py; const qz = clamp(pz, c.minZ, c.maxZ) - pz;
      if (qx * qx + qy * qy + qz * qz > rad * rad) continue;
      c.solid = false; n++;
      emit({ type: 'break', pos: V(c.x, c.y, c.z) });
      fx('burst', V(c.x, c.maxY, c.z), '#c8bfa8', 30, 5);
    }
    for (let i = 0; i < crawlers.length; i++) {
      const e = crawlers[i];
      if (!e.alive) continue;
      const b = e.body;
      const dx = b.pos.x - pos.x; const dz = b.pos.z - pos.z;
      if (dx * dx + dz * dz > (rad + b.radius) * (rad + b.radius) || Math.abs(b.pos.y - pos.y) > 1.5) continue;
      killEnemy(e, 'pound'); n++;
    }
    return n;
  }
  function update(t, dt, team) {
    while (events.length) events.pop();
    if (disposed) return events;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    CLK.now = num(t, CLK.now + dt);
    inUpdate = true;
    for (let i = 0; i < pending.length; i++) events.push(pending[i]);
    pending.length = 0;
    syncTeam(team, dt);
    sense(dt);
    evalSignals();
    for (let i = 0; i < movers.length; i++) stepMover(movers[i], dt);
    carryTeam();
    updateCrumbles(dt);
    updateDoors(dt);
    updateCrates(dt);
    updateHazards(CLK.now, dt);
    updateKills();
    updateItems(dt);
    updEnemies(dt);
    updShots(dt);
    syncVisuals(CLK.now, dt);
    inUpdate = false;
    return events;
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const o of owned) { try { o.dispose(); } catch { /* already gone */ } }
    owned.length = 0;
    for (const g of ownGeo) g.dispose();
    for (const m of ownMat) m.dispose();
    orbMesh.dispose(); boltMesh.dispose();
    if (group.parent) group.parent.remove(group);
    group.clear();
    // the game's bodies may live on into the next level: drop our per-body state (platform refs, timers)
    for (const h of heroRecs) if (h.body && h.body._nr) { delete h.body._nr; if (h.body.ground) h.body.ground = null; }
    dyn.length = 0; heroRecs.length = 0; enemies.length = 0; crawlers.length = 0;
    while (events.length) events.pop();
    pending.length = 0;
  }

  // static parts of the laser beams (crates and doors are checked every frame)
  for (const L of lasers) L.staticLen = castSolid(L.fx, L.fy, L.fz, L.dx, L.dy, L.dz, L.length, null, true) ? RC.t : L.length;
  if (!fin(bounds.minX)) { bounds.minX = bounds.minY = bounds.minZ = -1; bounds.maxX = bounds.maxY = bounds.maxZ = 1; }

  const W = {
    spawn, heroes, shardsTotal: shards.length, shards: 0,
    checkpoint,                    // { index (-1 = start), pos, yaw, heroes: { id: Vector3 } } — where respawns go
    killY, bounds, group, warnings,
    moveBody, raycast, zap, pound, update, dispose,
    aim,                           // aim(origin, dir, range?, coneDeg?) -> { point, kind, ref, dist } | null
    placeTeam: (pos, yaw) => placeTeam(pos.x, pos.y, pos.z, num(yaw, 0), false),
    signal: (id) => !!(signals.get(String(id)) && signals.get(String(id)).on),
    clearShots,
    boss: bossInfo,                // the boss fight under way: { name, hp01, phase, phases, open, alive, kind } | null
    stats: () => ({ statics: statics.length, dynamic: dyn.length, cells: grid.nx * grid.nz, cell: grid.cell, movers: movers.length, crates: crates.length,
      enemies: enemies.length, shots: shots.reduce((a, s) => a + (s.on ? 1 : 0), 0), warnings: warnings.length }),
    debug: { statics, movers, crumbles, crates, doors, cracked, plates, switches, nodes, shards, checkpoints, pads, portals, lasers, spikes, surfaces, enemies, crawlers, shots, signals, heroRecs, tips, warden, bosses, gates },
  };
  return W;
}
