// NEON RIFT — heroes, enemies and props, modelled from primitives and animated procedurally (no image files).
// Every factory returns { root, update(t, dt, s), dispose(), ... }. root sits at the feet, faces +Z and belongs to
// the caller (position, rotation.y); everything here animates child groups only, and blends between actions.
// Geometries, materials and canvas textures that never change per entity live in module caches and are never
// disposed. Whatever an entity tints, sizes or writes on its own is owned by it and released by its dispose().
import * as THREE from '../vendor/three.min.js';

const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, k) => a + (b - a) * k;
const sstep = (a, b, v) => { const x = clamp((v - a) / (b - a)); return x * x * (3 - 2 * x); };
const easeOut = (k) => 1 - (1 - k) ** 3;
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const backOut = (k) => 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2;
const approach = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const approachAngle = (cur, tgt, rate, dt) => cur + wrap(tgt - cur) * (1 - Math.exp(-rate * dt));
const safeDt = (dt) => (dt > 0 ? Math.min(dt, 0.05) : 0);
// state fields arrive from game code: anything non-finite falls back to a default (NaN would stick in smoothing)
const num = (v, def = 0) => { const n = +v; return Number.isFinite(n) ? n : def; };
const finiteVec = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const CAST = 1;
const RECV = 2;
const BOTH = 3;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let seeds = 1;

// ---------- caches and ownership ----------
const GEO = new Map();
const MAT = new Map();
const TEX = new Map();
const COL = new Map();
function cache(map, key, make) {
  let v = map.get(key);
  if (v === undefined) { v = make(); map.set(key, v); }
  return v;
}
const geo = (key, make) => cache(GEO, key, make);
const shared = (key, make) => cache(MAT, key, make);
const col = (hex) => cache(COL, hex, () => new THREE.Color(hex));

function owner() {
  const list = [];
  return {
    own(x) { list.push(x); return x; },
    dispose() { for (let i = 0; i < list.length; i++) list[i].dispose(); list.length = 0; },
  };
}

// ---------- scene helpers ----------
function grp(parent, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  if (parent) parent.add(g);
  return g;
}
function part(parent, geometry, material, p, r, s, shadow = 0) {
  const m = new THREE.Mesh(geometry, material);
  if (p) m.position.set(p[0], p[1], p[2]);
  if (r) m.rotation.set(r[0], r[1], r[2]);
  if (s != null) { if (typeof s === 'number') m.scale.setScalar(s); else m.scale.set(s[0], s[1], s[2]); }
  m.castShadow = (shadow & CAST) !== 0;
  m.receiveShadow = (shadow & RECV) !== 0;
  parent.add(m);
  return m;
}
function sprite(parent, material, p, size) {
  const s = new THREE.Sprite(material);
  s.position.set(p[0], p[1], p[2]);
  s.scale.set(size, size, size);
  parent.add(s);
  return s;
}

// ---------- geometry helpers ----------
const _c = new THREE.Color();
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
function mix(a, b, k) { return _c.copy(col(a)).lerp(col(b), clamp(k)); }
// Bakes a per-vertex colour (fn returns a THREE.Color) into the geometry.
function paint(g, fn) {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const a = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const c = fn(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i));
    a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function xform(g, p, r, s) {
  _e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0);
  _q.setFromEuler(_e);
  _m4.compose(_v1.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0), _q, s ? _v2.set(s[0], s[1], s[2]) : _v2.set(1, 1, 1));
  return g.applyMatrix4(_m4);
}
// Merges [geometry, position, rotation, scale] parts into one geometry (consumes the inputs).
function merged(parts) {
  const list = [];
  const colored = parts.every((q) => q[0].attributes.color);
  for (const [g0, p, r, s] of parts) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (g !== g0) g0.dispose();
    xform(g, p, r, s);
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && !(colored && name === 'color')) g.deleteAttribute(name);
    }
    list.push(g);
  }
  const out = THREE.mergeGeometries(list, false);
  for (const g of list) g.dispose();
  return out;
}
const unitPlane = () => geo('plane.flat', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
// a mirrored pair of eye-like parts: fn(x, yaw) -> [geometry, position, rotation, scale]
const pair = (fn) => merged([fn(0.074, 0.35), fn(-0.074, -0.35)]);
// a point (lx, ly, lz) inside a part at (x, 0, 0) turned by yaw ry
const off = (x, ry, lx, ly, lz) => [x + lx * Math.cos(ry) + lz * Math.sin(ry), ly, -lx * Math.sin(ry) + lz * Math.cos(ry)];

// ---------- canvas textures (CSP: drawn, never loaded) ----------
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function toTex(cv, { srgb = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
function rr(c, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + k, y);
  c.arcTo(x + w, y, x + w, y + h, k);
  c.arcTo(x + w, y + h, x, y + h, k);
  c.arcTo(x, y + h, x, y, k);
  c.arcTo(x, y, x + w, y, k);
  c.closePath();
}
function radial(c, x, y, r, stops) {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  for (const [o, s] of stops) g.addColorStop(o, s);
  return g;
}
function chevron(c, x, y, w, h, lw) {
  c.beginPath(); c.moveTo(x - w / 2, y + h / 2); c.lineTo(x, y - h / 2); c.lineTo(x + w / 2, y + h / 2);
  c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke();
}

const TX = {
  // soft radial glow for halos, sprites and sparks
  glow: () => cache(TEX, 'glow', () => {
    const S = 128;
    const cv = canvas(S, S);
    const c = cv.getContext('2d');
    c.fillStyle = radial(c, S / 2, S / 2, S / 2, [[0, 'rgba(255,255,255,1)'], [0.18, 'rgba(255,255,255,0.7)'], [0.45, 'rgba(255,255,255,0.2)'], [1, 'rgba(255,255,255,0)']]);
    c.fillRect(0, 0, S, S);
    return toTex(cv);
  }),
  // soft selection ring with dashes, tinted by the material colour
  ring: () => cache(TEX, 'ring', () => {
    const S = 256;
    const cv = canvas(S, S);
    const c = cv.getContext('2d');
    c.translate(S / 2, S / 2);
    c.fillStyle = radial(c, 0, 0, S / 2, [[0, 'rgba(255,255,255,0.05)'], [0.6, 'rgba(255,255,255,0.05)'], [0.7, 'rgba(255,255,255,0.35)'], [0.76, 'rgba(255,255,255,0.8)'], [0.82, 'rgba(255,255,255,0.3)'], [0.9, 'rgba(255,255,255,0.05)'], [1, 'rgba(255,255,255,0)']]);
    c.beginPath(); c.arc(0, 0, S / 2, 0, TAU); c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = S * 0.012;
    c.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = i * TAU / 3;
      c.beginPath(); c.arc(0, 0, S * 0.455, a + 0.3, a + TAU / 3 - 0.3); c.stroke();
    }
    return toTex(cv);
  }),
  // bright at v = 0, transparent at v = 1 (thrusters, light columns)
  fade: () => cache(TEX, 'fade', () => {
    const cv = canvas(8, 128);
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.55, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,1)');
    c.fillStyle = g; c.fillRect(0, 0, 8, 128);
    return toTex(cv);
  }),
  // white at v = 1 (top), black below: emissive tips
  tipGlow: () => cache(TEX, 'tipGlow', () => {
    const cv = canvas(8, 128);
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, '#8a8a8a'); g.addColorStop(0.7, '#000000'); g.addColorStop(1, '#000000');
    c.fillStyle = g; c.fillRect(0, 0, 8, 128);
    return toTex(cv);
  }),
  // Pix's tail tip: emissive mask that ramps up along u (the tip glows cyan)
  tailGlow: () => cache(TEX, 'tailGlow', () => {
    const cv = canvas(128, 4);
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 128, 0);
    g.addColorStop(0, '#000000'); g.addColorStop(0.7, '#000000'); g.addColorStop(0.88, '#5a5a5a'); g.addColorStop(1, '#ffffff');
    c.fillStyle = g; c.fillRect(0, 0, 128, 4);
    return toTex(cv);
  }),
  // Vera's visor: rounded alpha mask, dark glass with a cyan rim, and the rim as an emissive mask
  visor: () => cache(TEX, 'visor', () => {
    const W = 288;
    const H = 104;
    const a = canvas(W, H);
    const ca = a.getContext('2d');
    ca.fillStyle = '#000'; ca.fillRect(0, 0, W, H);
    ca.fillStyle = '#fff'; rr(ca, 3, 4, W - 6, H - 8, 44); ca.fill();
    const m = canvas(W, H);
    const cm = m.getContext('2d');
    const g = cm.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2a1a5c'); g.addColorStop(0.45, '#0d0820'); g.addColorStop(1, '#170d38');
    cm.fillStyle = g; cm.fillRect(0, 0, W, H);
    cm.strokeStyle = '#5ee7ff'; cm.lineWidth = 7; rr(cm, 9, 10, W - 18, H - 20, 38); cm.stroke();
    const e = canvas(W, H);
    const ce = e.getContext('2d');
    ce.fillStyle = '#000'; ce.fillRect(0, 0, W, H);
    ce.strokeStyle = '#fff'; ce.lineWidth = 7; rr(ce, 9, 10, W - 18, H - 20, 38); ce.stroke();
    ce.fillStyle = 'rgba(255,255,255,0.05)';
    for (let y = 18; y < H - 16; y += 7) ce.fillRect(24, y, W - 48, 2);
    return { alpha: toTex(a, { srgb: false }), map: toTex(m), glow: toTex(e) };
  }),
  // stone: mottled albedo with dark cracks, and some cracks as a glowing emissive mask
  stone: () => cache(TEX, 'stone', () => {
    const S = 256;
    const R = rng(7);
    const m = canvas(S, S);
    const cm = m.getContext('2d');
    cm.fillStyle = '#8a8a8e'; cm.fillRect(0, 0, S, S);
    for (let i = 0; i < 1100; i++) {
      const x = R() * S;
      const y = R() * S;
      const r = 1.5 + R() * R() * 20;
      const l = 105 + R() * 75;
      cm.fillStyle = `rgba(${l | 0},${(l * 0.98) | 0},${(l * 0.97) | 0},${(0.06 + R() * 0.14).toFixed(3)})`;
      cm.beginPath(); cm.arc(x, y, r, 0, TAU); cm.fill();
    }
    for (let i = 0; i < 500; i++) {
      cm.fillStyle = R() < 0.5 ? 'rgba(40,36,32,0.25)' : 'rgba(230,222,210,0.2)';
      cm.fillRect(R() * S, R() * S, 1.5, 1.5);
    }
    const cracks = [];
    for (let i = 0; i < 10; i++) {
      let x = R() * S;
      let y = R() * S;
      let a = R() * TAU;
      const pts = [[x, y]];
      for (let j = 0; j < 8; j++) { a += (R() - 0.5) * 1.3; const L = 7 + R() * 16; x += Math.cos(a) * L; y += Math.sin(a) * L; pts.push([x, y]); }
      cracks.push(pts);
    }
    const line = (c, pts) => { c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (const q of pts) c.lineTo(q[0], q[1]); c.stroke(); };
    cm.strokeStyle = 'rgba(38,32,28,0.85)'; cm.lineWidth = 2.6; cm.lineJoin = 'round';
    for (const pts of cracks) line(cm, pts);
    const e = canvas(S, S);
    const ce = e.getContext('2d');
    ce.fillStyle = '#000'; ce.fillRect(0, 0, S, S);
    ce.strokeStyle = '#ffffff'; ce.lineWidth = 2.4; ce.lineJoin = 'round'; ce.shadowColor = '#ffffff'; ce.shadowBlur = 7;
    for (let i = 0; i < 4; i++) line(ce, cracks[i]);
    return { map: toTex(m, { repeat: true }), glow: toTex(e, { repeat: true }) };
  }),
  // yellow/black hazard stripes
  hazard: () => cache(TEX, 'hazard', () => {
    const cv = canvas(128, 128);
    const c = cv.getContext('2d');
    c.fillStyle = '#17151c'; c.fillRect(0, 0, 128, 128);
    c.fillStyle = '#ffc21a';
    for (let i = -4; i < 9; i++) {
      c.beginPath(); c.moveTo(i * 32, 0); c.lineTo(i * 32 + 16, 0); c.lineTo(i * 32 + 16 - 128, 128); c.lineTo(i * 32 - 128, 128); c.fill();
    }
    return toTex(cv, { repeat: true });
  }),
  // door panel: dark plating with glowing bars (map + emissive mask)
  door: () => cache(TEX, 'door', () => {
    const W = 128;
    const H = 256;
    const draw = (c, glow) => {
      if (!glow) {
        const g = c.createLinearGradient(0, 0, W, 0);
        g.addColorStop(0, '#1d1a3a'); g.addColorStop(0.5, '#141130'); g.addColorStop(1, '#1d1a3a');
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        c.strokeStyle = '#38306b'; c.lineWidth = 3;
        rr(c, 8, 8, W - 16, H - 16, 10); c.stroke();
        rr(c, 22, 30, W - 44, 70, 8); c.stroke();
        rr(c, 22, 156, W - 44, 70, 8); c.stroke();
      } else { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
      c.strokeStyle = glow ? '#ffffff' : '#ff5f6d';
      for (let i = 0; i < 3; i++) chevron(c, W / 2, 112 + i * 16, 46, 12, 5);
      c.fillStyle = glow ? '#ffffff' : '#ff5f6d';
      c.fillRect(W / 2 - 3, 20, 6, 4); c.fillRect(W / 2 - 3, H - 24, 6, 4);
    };
    const a = canvas(W, H); draw(a.getContext('2d'), false);
    const b = canvas(W, H); draw(b.getContext('2d'), true);
    return { map: toTex(a), glow: toTex(b) };
  }),
  // heavy crate face: steel with hazard bands, rivets and amber chevrons
  crate: () => cache(TEX, 'crate', () => {
    const S = 256;
    const draw = (c, glow) => {
      if (!glow) {
        c.fillStyle = '#343a48'; c.fillRect(0, 0, S, S);
        c.fillStyle = '#2a2f3b'; c.fillRect(28, 28, S - 56, S - 56);
        c.strokeStyle = '#4d5567'; c.lineWidth = 4; c.strokeRect(28, 28, S - 56, S - 56);
        c.save(); c.beginPath(); c.rect(0, 0, S, 22); c.rect(0, S - 22, S, 22); c.clip();
        c.fillStyle = '#17151c'; c.fillRect(0, 0, S, S);
        c.fillStyle = '#ffc21a';
        for (let i = -8; i < 16; i++) { c.beginPath(); c.moveTo(i * 26, 0); c.lineTo(i * 26 + 13, 0); c.lineTo(i * 26 + 13 - S, S); c.lineTo(i * 26 - S, S); c.fill(); }
        c.restore();
        c.fillStyle = '#7b8496';
        for (const [x, y] of [[40, 40], [S - 40, 40], [40, S - 40], [S - 40, S - 40]]) { c.beginPath(); c.arc(x, y, 7, 0, TAU); c.fill(); }
      } else { c.fillStyle = '#000'; c.fillRect(0, 0, S, S); }
      c.strokeStyle = glow ? '#ffffff' : '#ffb020';
      c.save(); c.translate(S / 2, S / 2); c.rotate(Math.PI / 2);
      for (let i = -1; i <= 1; i++) chevron(c, 0, i * 30, 70, 22, 10);
      c.restore();
    };
    const a = canvas(S, S); draw(a.getContext('2d'), false);
    const b = canvas(S, S); draw(b.getContext('2d'), true);
    return { map: toTex(a), glow: toTex(b) };
  }),
  // glyphs for plates and pads (emissive masks; white on black)
  glyph: (kind) => cache(TEX, `glyph.${kind}`, () => {
    const S = 256;
    const cv = canvas(S, S);
    const c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
    c.translate(S / 2, S / 2);
    c.strokeStyle = '#fff'; c.fillStyle = '#fff';
    if (kind === 'plate') {
      c.lineWidth = 12; c.beginPath(); c.arc(0, 0, 92, 0, TAU); c.stroke();
      c.lineWidth = 7; c.beginPath(); c.arc(0, 0, 58, 0, TAU); c.stroke();
      c.beginPath(); c.arc(0, 0, 20, 0, TAU); c.fill();
      for (let i = 0; i < 4; i++) { c.save(); c.rotate(i * Math.PI / 2 + Math.PI / 4); c.fillRect(-5, -118, 10, 18); c.restore(); }
    } else if (kind === 'heavy') {
      c.lineWidth = 10; rr(c, -110, -110, 220, 220, 22); c.stroke();
      // a weight: handle + trapezoid body, then a down arrow
      c.lineWidth = 12; c.beginPath(); c.arc(0, -40, 26, Math.PI, 0); c.stroke();
      c.beginPath(); c.moveTo(-52, -32); c.lineTo(52, -32); c.lineTo(66, 34); c.lineTo(-66, 34); c.closePath(); c.fill();
      c.lineWidth = 11; chevron(c, 0, 66, 60, -18, 11); chevron(c, 0, 88, 60, -18, 11);
    } else if (kind === 'bounce') {
      c.lineWidth = 10; c.beginPath(); c.arc(0, 0, 108, 0, TAU); c.stroke();
      c.lineWidth = 5; c.beginPath(); c.arc(0, 0, 84, 0, TAU); c.stroke();
      for (let i = 0; i < 3; i++) chevron(c, 0, 36 - i * 34, 92, 30, 12);
    } else if (kind === 'switch') {
      c.lineWidth = 14; c.beginPath(); c.arc(0, 8, 64, -Math.PI * 0.32, Math.PI * 1.32); c.stroke();
      c.fillRect(-7, -86, 14, 84);
    }
    return toTex(cv);
  }),
  // floating marks over sentries ('!' when they spot you)
  mark: (ch) => cache(TEX, `mark.${ch}`, () => {
    const S = 128;
    const cv = canvas(S, S);
    const c = cv.getContext('2d');
    c.font = '900 104px system-ui, -apple-system, "Segoe UI", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 14; c.strokeStyle = 'rgba(20,10,30,0.9)'; c.strokeText(ch, S / 2, S / 2 + 6);
    c.fillStyle = '#ffffff'; c.fillText(ch, S / 2, S / 2 + 6);
    return toTex(cv);
  }),
  // tiny neon "city at night" panorama: reflections for metal and glass (three PMREMs it once)
  env: () => cache(TEX, 'env', () => {
    const W = 256;
    const H = 128;
    const cv = canvas(W, H);
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#343a5a'); g.addColorStop(0.42, '#4a4a7c'); g.addColorStop(0.5, '#9a96c8'); g.addColorStop(0.56, '#2a2a4a'); g.addColorStop(1, '#0c0c18');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    for (const [x, y, r, cc] of [[36, 50, 16, '#5ee7ff'], [104, 44, 11, '#ff4fd8'], [170, 52, 18, '#ffd166'], [222, 40, 12, '#5ee7ff'], [70, 34, 9, '#ffffff']]) {
      c.fillStyle = radial(c, x, y, r, [[0, cc], [1, 'rgba(0,0,0,0)']]);
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }
    c.fillStyle = radial(c, W * 0.3, 0, 70, [[0, 'rgba(255,255,255,0.95)'], [1, 'rgba(255,255,255,0)']]);
    c.fillRect(0, 0, W, 70);
    const t = toTex(cv);
    t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  }),
  // warden shield plate: dark metal with a glowing border (emissive mask)
  shield: () => cache(TEX, 'shield', () => {
    const S = 128;
    const cv = canvas(S, S);
    const c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, S, S);
    c.strokeStyle = '#fff'; c.lineWidth = 7; rr(c, 6, 6, S - 12, S - 12, 16); c.stroke();
    c.lineWidth = 3; c.beginPath(); c.moveTo(S / 2, 22); c.lineTo(S / 2, S - 22); c.stroke();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(S / 2, S / 2, 9, 0, TAU); c.fill();
    return toTex(cv);
  }),
};

// ---------- materials ----------
// Fresnel rim + flash, injected into MeshStandard/Physical. The patch reads its uniforms from material.userData,
// so the program is shared by every material using it (same source, same cache key).
const RIM_PARS = '\nuniform vec3 uRimColor;\nuniform float uRimPower;\nuniform vec3 uFlash;\n';
const RIM_FRAG = '\n{\n  float rimK = 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );\n  totalEmissiveRadiance += uRimColor * pow( rimK, uRimPower ) + uFlash;\n}\n';
function rimPatch(shader) {
  const u = this.userData;
  shader.uniforms.uRimColor = u.rim;
  shader.uniforms.uRimPower = u.rimPower;
  shader.uniforms.uFlash = u.flash;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>' + RIM_PARS)
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + RIM_FRAG);
}
const NO_FLASH = { value: new THREE.Color(0, 0, 0) };
function rimStd(p, rim = '#000000', strength = 0, power = 2.2, flash = NO_FLASH, physical = false) {
  const m = physical ? new THREE.MeshPhysicalMaterial(p) : new THREE.MeshStandardMaterial(p);
  m.userData.rim = { value: col(rim).clone().multiplyScalar(strength) };
  m.userData.rimBase = m.userData.rim.value.clone();
  m.userData.rimPower = { value: power };
  m.userData.flash = flash;
  m.onBeforeCompile = rimPatch;
  return m;
}
function setRim(m, k) { m.userData.rim.value.copy(m.userData.rimBase).multiplyScalar(k); }
function setRimColor(m, c, k) { m.userData.rim.value.copy(c).multiplyScalar(k); }
// Unlit glowing colour; values above 1 feed the bloom pass.
function unlit(hex, k = 1, extra) {
  const m = new THREE.MeshBasicMaterial({ color: col(hex).clone().multiplyScalar(k), ...extra });
  m.userData.base = col(hex).clone().multiplyScalar(k);
  return m;
}
function setGlow(m, k) { m.color.copy(m.userData.base).multiplyScalar(k); }
function additive(hex, k = 1, map = TX.glow(), extra) {
  const m = new THREE.MeshBasicMaterial({ color: col(hex).clone().multiplyScalar(k), map, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, ...extra });
  m.userData.base = col(hex).clone().multiplyScalar(k);
  return m;
}
function spriteMat(hex, k = 1.6) {
  const m = new THREE.SpriteMaterial({ map: TX.glow(), color: col(hex).clone().multiplyScalar(k), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  m.userData.base = m.color.clone();
  return m;
}
function ringMat(hex) {
  const m = additive(hex, 1.1, TX.ring(), { opacity: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  return m;
}
// Shared, untinted surfaces used by props and enemies.
const SM = {
  metal: () => shared('metal', () => rimStd({ color: '#8790a6', roughness: 0.34, metalness: 0.82, envMap: TX.env(), envMapIntensity: 0.9 }, '#9fb4ff', 0.25, 2.5)),
  dark: () => shared('dark', () => rimStd({ color: '#262a3d', roughness: 0.42, metalness: 0.7, envMap: TX.env(), envMapIntensity: 0.7 }, '#7d6bff', 0.35, 2.2)),
  steel: () => shared('steel', () => rimStd({ color: '#b3bccb', roughness: 0.3, metalness: 0.88, envMap: TX.env(), envMapIntensity: 1 }, '#ffffff', 0.15, 2.5)),
  black: () => shared('black', () => new THREE.MeshBasicMaterial({ color: '#05050b' })),
};

// Additive fog: fade towards black instead of the fog colour.
const FOG_FADE = `
  float fogK = 1.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fogK = exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      fogK = 1.0 - smoothstep( fogNear, fogFar, vFogDepth );
    #endif
  #endif
`;
const VS_BASIC = `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vP = position;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  vN = normalize( normalMatrix * normal );
  vV = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
function fxMaterial(fs, uniforms, extra) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, uniforms]),
    vertexShader: VS_BASIC,
    fragmentShader: fs,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
    ...extra,
  });
}
// Vision cone: bright silhouette edges, bands sweeping outwards, a ring at the far end.
const FS_CONE = `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_fragment>
void main() {
  float z = vP.z;
  float facing = abs( dot( normalize( vN ), normalize( vV ) ) );
  float edge = pow( 1.0 - facing, 2.0 );
  float along = smoothstep( 0.0, 0.07, z ) * pow( 1.0 - z, 0.55 );
  float bands = 0.8 + 0.2 * sin( ( z * 6.0 - uTime * 1.2 ) * 6.2831853 );
  float tip = smoothstep( 0.94, 0.985, z ) * ( 1.0 - smoothstep( 0.985, 1.0, z ) );
  float a = uOpacity * ( along * ( 0.3 + 0.7 * edge ) * bands + tip * 0.45 ) * ( gl_FrontFacing ? 1.0 : 0.5 );
  ${FOG_FADE}
  gl_FragColor = vec4( uColor * fogK, clamp( a, 0.0, 1.0 ) );
}`;
// Portal floor: two counter-rotating spirals.
const FS_SWIRL = `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uTime;
uniform float uPower;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_fragment>
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length( p );
  float a = atan( p.y, p.x );
  float s1 = 0.5 + 0.5 * sin( a * 3.0 + r * 10.0 - uTime * 2.4 );
  float s2 = 0.5 + 0.5 * sin( a * 5.0 - r * 15.0 + uTime * 3.3 );
  float core = 1.0 - smoothstep( 0.0, 1.0, r );
  float rim = smoothstep( 0.8, 0.96, r ) * ( 1.0 - smoothstep( 0.96, 1.0, r ) );
  vec3 c = mix( uColorB, uColorA, core );
  float k = ( 0.18 + 0.82 * s1 * s2 ) * core * uPower + rim * ( 0.35 + 0.65 * uPower );
  ${FOG_FADE}
  gl_FragColor = vec4( c * fogK, clamp( k, 0.0, 1.0 ) );
}`;
// Rising light column (portal, checkpoint): spiral streaks fading upwards, brighter at the silhouette.
const FS_COLUMN = `
uniform vec3 uColor;
uniform float uTime;
uniform float uPower;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_fragment>
void main() {
  float facing = abs( dot( normalize( vN ), normalize( vV ) ) );
  float st = 0.5 + 0.5 * sin( ( vUv.x * 9.0 + vUv.y * 2.0 - uTime * 0.7 ) * 6.2831853 );
  float rise = 0.5 + 0.5 * sin( ( vUv.y * 2.5 - uTime * 1.1 ) * 6.2831853 );
  float fade = pow( 1.0 - vUv.y, 1.5 ) * smoothstep( 0.0, 0.06, vUv.y );
  float k = ( 0.25 + 0.75 * st * ( 0.55 + 0.45 * rise ) ) * fade * uPower * ( 0.3 + 0.7 * ( 1.0 - facing ) );
  ${FOG_FADE}
  gl_FragColor = vec4( uColor * fogK, clamp( k, 0.0, 1.0 ) );
}`;
// Laser: white-hot core with soft edges, pulses running along it; faint dashes while off.
const FS_BEAM = `
uniform vec3 uColor;
uniform float uTime;
uniform float uOn;
uniform float uLen;
uniform float uFlick;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_fragment>
void main() {
  float facing = abs( dot( normalize( vN ), normalize( vV ) ) );
  float core = pow( facing, 2.2 );
  float d = vUv.y * uLen;
  float pulses = 0.72 + 0.28 * sin( d * 6.0 - uTime * 34.0 );
  float on = uOn * ( 0.8 + 0.2 * uFlick ) * core * pulses;
  float dash = step( 0.55, fract( d * 1.6 - uTime * 0.6 ) ) * 0.12 * ( 1.0 - uOn ) * core;
  vec3 c = mix( uColor, vec3( 1.0, 0.75, 0.8 ) * 1.6, pow( core, 6.0 ) * uOn );
  ${FOG_FADE}
  gl_FragColor = vec4( c * fogK, clamp( on + dash, 0.0, 1.0 ) );
}`;
// Warden core: plasma bands with a bright rim (opaque).
const FS_PLASMA = `
uniform vec3 uColor;
uniform vec3 uHot;
uniform float uTime;
uniform float uPower;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
#include <fog_pars_fragment>
void main() {
  vec3 p = normalize( vP );
  float n = sin( p.x * 5.0 + uTime * 1.7 ) * sin( p.y * 6.0 - uTime * 1.3 ) * sin( p.z * 4.0 + uTime * 2.1 );
  float bands = 0.5 + 0.5 * sin( ( p.y + n * 0.45 ) * 11.0 + uTime * 2.2 );
  float facing = abs( dot( normalize( vN ), normalize( vV ) ) );
  float rim = pow( 1.0 - facing, 2.0 );
  vec3 c = mix( uColor * ( 0.35 + 1.1 * bands * bands ), uHot, rim * 0.45 ) * uPower;
  gl_FragColor = vec4( c, 1.0 );
  #include <fog_fragment>
}`;

// ======================================================================================
// Heroes
// ======================================================================================
const IDLE = 0;
const RUN = 1;
const AIR = 2;
const GLIDE = 3;
const DASH = 4;
const PUSH = 5;
const POUND = 6;
const DEAD = 7;
const CHEER = 8;
const NPOSE = 9;
const HERO_DEFAULT = { speed: 0, vy: 0, grounded: true, action: 'idle', active: false, blink: false };
const SPEC = {
  vera: { run: 6.0, stride: 2.1, cy: 0.72, squash: 0.8, ring: 1.35, ringHex: '#b48cff', radius: 0.4, height: 1.5 },
  pix: { run: 7.5, stride: 1.45, cy: 0.42, squash: 1.0, ring: 1.05, ringHex: '#3ee9ff', radius: 0.32, height: 0.9 },
  brick: { run: 4.2, stride: 1.9, cy: 0.88, squash: 0.65, ring: 1.8, ringHex: '#ffbe3d', radius: 0.55, height: 1.8 },
};

function newDriver() {
  const w = new Float32Array(NPOSE);
  w[IDLE] = 1;
  return {
    rnd: rng(seeds++ * 7919), act: '', prev: '', actT: 0,
    speed: 0, phase: 0, vy: 0, grounded: true, minVy: 0, airT: 0,
    w, wt: new Float32Array(NPOSE), zapW: 0, hurtW: 0,
    sq: 0, sqV: 0, stretch: 0,
    spinT: 9, slamT: 9, zapT: 9, hurtT: 9, deadT: 9, spawnT: 9, landT: 9, takeT: 9,
    poundArmed: false, impact: 0, landed: false,
    yaw: 0, yawRate: 0, bank: 0, ready: false,
    px: 0, py: 0, pz: 0, vx: 0, vz: 0, ax: 0, az: 0, velF: 0, velS: 0, accF: 0, accS: 0, teleported: false,
    lookY: 0, lookP: 0, lookTY: 0, lookTP: 0, lookNext: 1.2,
    blinkNext: 1.2, blinkT: 9, eyeOpen: 1, activeK: 0, vis: 1,
  };
}

// Reads the game's state and advances everything every hero shares: action timers, blend weights, squash
// spring, turn banking, measured acceleration (for secondary motion), blinking, idle glances, the active glow.
function drive(d, spec, t, dt, s, root) {
  const act = typeof s.action === 'string' ? s.action : 'idle';
  const g = s.grounded !== false;
  const vy = num(s.vy);
  if (act !== d.act) {
    d.prev = d.act; d.act = act; d.actT = 0;
    if (act === 'double') d.spinT = 0;
    else if (act === 'zap') d.zapT = 0;
    else if (act === 'hurt') d.hurtT = 0;
    else if (act === 'dead') d.deadT = 0;
    else if (act === 'pound') { if (g) d.slamT = 0; else d.poundArmed = true; }
    if (d.prev === 'dead') d.spawnT = 0;
  } else d.actT += dt;
  d.landed = false;
  if (g && !d.grounded) {
    const impact = clamp(-d.minVy / 20);
    d.sqV -= (0.9 + 3.4 * impact) * spec.squash;
    d.landT = 0; d.impact = impact; d.landed = true;
    if (d.poundArmed) { d.poundArmed = false; d.slamT = 0; d.sqV -= 2.4 * spec.squash; }
  } else if (!g && d.grounded && vy > 0.5) {
    d.sqV -= 2.5 * spec.squash; d.takeT = 0;
  }
  if (g) { d.minVy = 0; d.airT = 0; } else { d.airT += dt; if (vy < d.minVy) d.minVy = vy; }
  d.grounded = g; d.vy = vy;
  d.spinT += dt; d.slamT += dt; d.zapT += dt; d.hurtT += dt; d.deadT += dt; d.spawnT += dt; d.landT += dt; d.takeT += dt;
  d.speed = approach(d.speed, Math.max(0, num(s.speed)), 10, dt);
  if (g) d.phase = (d.phase + dt * d.speed / spec.stride * TAU) % TAU;
  else d.phase = (d.phase + dt * 1.5) % TAU;

  // measured motion of root (world), expressed in the hero's own frame
  root.updateWorldMatrix(true, false);
  const el = root.matrixWorld.elements;
  const px = el[12];
  const pz = el[14];
  const yaw = num(root.rotation.y);
  const tele = Math.abs(px - d.px) + Math.abs(pz - d.pz) + Math.abs(el[13] - d.py) > 4;
  d.teleported = !d.ready || tele;
  if (!d.ready || dt === 0 || tele) {
    if (d.teleported) { d.vx = d.vz = d.ax = d.az = 0; d.yaw = yaw; }
    d.ready = true;
  } else {
    const nvx = approach(d.vx, (px - d.px) / dt, 18, dt);
    const nvz = approach(d.vz, (pz - d.pz) / dt, 18, dt);
    d.ax = approach(d.ax, clamp((nvx - d.vx) / dt, -60, 60), 10, dt);
    d.az = approach(d.az, clamp((nvz - d.vz) / dt, -60, 60), 10, dt);
    d.vx = nvx; d.vz = nvz;
  }
  d.px = px; d.py = el[13]; d.pz = pz;
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  d.velF = d.vx * sy + d.vz * cy; d.velS = d.vx * cy - d.vz * sy;
  d.accF = d.ax * sy + d.az * cy; d.accS = d.ax * cy - d.az * sy;
  const dyaw = wrap(yaw - d.yaw);
  d.yaw = yaw;
  d.yawRate = approach(d.yawRate, dt > 0 ? clamp(dyaw / dt, -10, 10) : 0, 8, dt);
  d.bank = approach(d.bank, clamp(-d.yawRate * d.speed * 0.03, -0.38, 0.38), 7, dt);

  // locomotion blend weights
  const wt = d.wt;
  wt.fill(0);
  if (act === 'dead') wt[DEAD] = 1;
  else if (act === 'cheer') wt[CHEER] = 1;
  else if (act === 'glide') wt[GLIDE] = 1;
  else if (act === 'dash') wt[DASH] = 1;
  else if (act === 'pound' && !g) wt[POUND] = 1;
  else if (act === 'push' && g) wt[PUSH] = 1;
  else if (!g || act === 'jump' || act === 'double' || act === 'fall') wt[AIR] = 1;
  else { const r = clamp(d.speed / (spec.run * 0.22)); wt[RUN] = r; wt[IDLE] = 1 - r; }
  const rate = act === 'dash' || (d.prev === 'dash' && d.actT < 0.3) ? 22 : act === 'dead' ? 8 : 12;
  for (let i = 0; i < NPOSE; i++) d.w[i] = approach(d.w[i], wt[i], rate, dt);
  d.zapW = approach(d.zapW, act === 'zap' || d.zapT < 0.28 ? 1 : 0, act === 'zap' || d.zapT < 0.28 ? 28 : 6, dt);
  d.hurtW = approach(d.hurtW, act === 'hurt' || d.hurtT < 0.35 ? 1 : 0, act === 'hurt' || d.hurtT < 0.35 ? 28 : 5, dt);

  // squash & stretch: a spring kicked on take-off (anticipation squash, then stretch) and landing
  d.sqV += (-340 * d.sq - 14 * d.sqV) * dt;
  d.sq = clamp(d.sq + d.sqV * dt, -0.42, 0.42);
  d.stretch = approach(d.stretch, g ? 0 : clamp(Math.abs(vy) * 0.008, 0, 0.09), 10, dt);

  // idle glances and blinks
  d.lookNext -= dt;
  if (d.lookNext <= 0) {
    d.lookNext = 1.4 + d.rnd() * 2.6;
    if (d.rnd() < 0.35) { d.lookTY = 0; d.lookTP = 0; } else { d.lookTY = (d.rnd() * 2 - 1) * 0.6; d.lookTP = (d.rnd() * 2 - 1) * 0.14 + 0.02; }
  }
  d.lookY = approach(d.lookY, d.lookTY, 5, dt);
  d.lookP = approach(d.lookP, d.lookTP, 5, dt);
  d.blinkNext -= dt;
  if (d.blinkNext <= 0) { d.blinkT = 0; d.blinkNext = d.rnd() < 0.18 ? 0.28 : 2 + d.rnd() * 3.5; }
  d.blinkT += dt;
  d.eyeOpen = d.blinkT < 0.14 ? Math.abs(d.blinkT / 0.07 - 1) : 1;
  d.activeK = approach(d.activeK, s.active ? 1 : 0, 6, dt);

  // despawn on death, pop back in on respawn
  let vis = 1;
  if (act === 'dead') vis = 1 - sstep(0.62, 0.95, d.deadT);
  else if (d.spawnT < 0.45) vis = backOut(clamp(d.spawnT / 0.42));
  d.vis = vis;
}

function heroFlash(d, flash) {
  let r = 0;
  let gg = 0;
  let b = 0;
  if (d.hurtT < 0.45) { const k = (1 - d.hurtT / 0.45) * (0.5 + 0.5 * Math.cos(d.hurtT * 48)); r += 0.75 * k; gg += 0.12 * k; b += 0.2 * k; }
  if (d.act === 'dead') { const k = sstep(0.4, 0.85, d.deadT); r += 0.9 * k; gg += 0.8 * k; b += 1.2 * k; }
  if (d.spawnT < 0.5) { const k = 1 - d.spawnT / 0.5; r += 0.7 * k; gg += 0.7 * k; b += 1.0 * k; }
  flash.value.setRGB(r, gg, b);
}

function heroRig(root, cy) {
  const sq = grp(root);
  const spin = grp(sq, 0, cy, 0);
  const body = grp(spin, 0, -cy, 0);
  return { sq, spin, body, cy };
}
// Shared finishing pass: squash/stretch + spawn scale, the flip / pirouette, i-frame flicker, the ground ring.
function finishRig(d, rig, ring, ringMat, t, s, o) {
  const sy = 1 + d.sq + d.stretch;
  const sxz = 1 / Math.sqrt(Math.max(0.35, sy));
  const v = Math.max(0.001, d.vis);
  rig.sq.scale.set(sxz * v * (o.sx || 1), sy * v * (o.sy || 1), sxz * v * (o.sz || 1));
  rig.spin.rotation.set(o.flip || 0, o.twirl || 0, o.roll || 0);
  rig.spin.position.y = rig.cy - (o.drop || 0);
  rig.body.visible = d.vis > 0.01 && !(s.blink && (t * 14) % 1 < 0.38);
  const a = d.activeK * (d.grounded ? 0.8 : 0.2) * (0.85 + 0.15 * Math.sin(t * 3.2)) * Math.min(1, d.vis * 2);
  ringMat.opacity = a;
  ring.visible = a > 0.01;
  ring.rotation.y = t * 0.7;
}
// a tiny damped spring
function spring() { return { x: 0, v: 0 }; }
function stepSpring(sp, target, k, c, dt) {
  sp.v += (-k * (sp.x - target) - c * sp.v) * dt;
  sp.x += sp.v * dt;
  return sp.x;
}

// ---------- Vera: the purple hovering guardian robot ----------
const VERA_BODY = [[0, 0.26], [0.12, 0.265], [0.21, 0.285], [0.27, 0.32], [0.305, 0.37], [0.32, 0.43], [0.318, 0.5], [0.3, 0.565], [0.265, 0.615], [0.2, 0.655], [0.11, 0.678], [0, 0.685]];
function wingGeometry() {
  const s = new THREE.Shape();
  s.moveTo(0, 0.05);
  s.quadraticCurveTo(0.3, 0.22, 0.6, 0.24);
  s.quadraticCurveTo(0.7, 0.22, 0.62, 0.12);
  s.lineTo(0.44, 0.02);
  s.quadraticCurveTo(0.5, -0.05, 0.4, -0.07);
  s.lineTo(0.18, -0.13);
  s.quadraticCurveTo(0.04, -0.13, 0, -0.05);
  s.closePath();
  return paint(new THREE.ShapeGeometry(s, 10), (x, y) => mix('#a5f4ff', '#7c3aed', x / 0.62 + y * 0.6));
}
function veraGeo() {
  return {
    body: geo('vera.body', () => paint(new THREE.LatheGeometry(VERA_BODY.map(([x, y]) => new THREE.Vector2(x, y)), 48),
      (x, y, z) => mix('#43108f', '#8c4dff', sstep(0.27, 0.68, y + z * 0.12)))),
    head: geo('vera.head', () => paint(new THREE.SphereGeometry(0.37, 48, 32),
      (x, y, z, nx, ny, nz) => mix('#8c58e8', '#e4ccff', clamp(0.42 + 0.58 * (0.8 * ny + 0.3 * nz))))),
    visor: geo('vera.visor', () => new THREE.SphereGeometry(0.374, 40, 12, Math.PI / 2 - 1.1, 2.2, 1.17, 0.8)),
    eye: geo('vera.eye', () => new THREE.CapsuleGeometry(0.04, 0.038, 4, 16)),
    happy: geo('vera.happy', () => new THREE.TorusGeometry(0.042, 0.015, 8, 20, Math.PI)),
    neck: geo('vera.neck', () => new THREE.CylinderGeometry(0.12, 0.15, 0.08, 28)),
    ears: geo('vera.ears', () => merged([
      [new THREE.CylinderGeometry(0.1, 0.1, 0.08, 32), [0.37, 0, 0], [0, 0, Math.PI / 2]],
      [new THREE.CylinderGeometry(0.1, 0.1, 0.08, 32), [-0.37, 0, 0], [0, 0, Math.PI / 2]],
    ])),
    earRings: geo('vera.earRings', () => merged([
      [new THREE.TorusGeometry(0.066, 0.014, 8, 32), [0.412, 0, 0], [0, Math.PI / 2, 0]],
      [new THREE.TorusGeometry(0.066, 0.014, 8, 32), [-0.412, 0, 0], [0, Math.PI / 2, 0]],
    ])),
    antBase: geo('vera.antBase', () => new THREE.SphereGeometry(0.045, 16, 10)),
    stalk1: geo('vera.stalk1', () => new THREE.CylinderGeometry(0.013, 0.018, 0.12, 8).translate(0, 0.06, 0)),
    stalk2: geo('vera.stalk2', () => new THREE.CylinderGeometry(0.011, 0.013, 0.09, 8).translate(0, 0.045, 0)),
    tip: geo('vera.tip', () => new THREE.SphereGeometry(0.054, 20, 14)),
    lens: geo('vera.lens', () => new THREE.SphereGeometry(0.068, 24, 16)),
    lensRing: geo('vera.lensRing', () => new THREE.TorusGeometry(0.076, 0.017, 10, 32)),
    belt: geo('vera.belt', () => new THREE.TorusGeometry(0.302, 0.02, 8, 72)),
    pack: geo('vera.pack', () => new THREE.RoundedBoxGeometry(0.3, 0.24, 0.1, 3, 0.04)),
    packLight: geo('vera.packLight', () => new THREE.BoxGeometry(0.18, 0.026, 0.012)),
    joint: geo('vera.joint', () => new THREE.SphereGeometry(0.07, 16, 12)),
    arm: geo('vera.arm', () => new THREE.CapsuleGeometry(0.056, 0.1, 4, 16)),
    hand: geo('vera.hand', () => new THREE.SphereGeometry(0.08, 20, 14)),
    foot: geo('vera.foot', () => new THREE.SphereGeometry(0.11, 24, 16)),
    sole: geo('vera.sole', () => new THREE.CircleGeometry(0.062, 24)),
    thrust: geo('vera.thrust', () => new THREE.ConeGeometry(0.072, 1, 18, 1, true).rotateX(Math.PI).translate(0, -0.5, 0)),
    wing: geo('vera.wing', wingGeometry),
  };
}

function buildVera() {
  const k = owner();
  const flash = { value: new THREE.Color(0, 0, 0) };
  const G = veraGeo();
  const V = TX.visor();
  const M = {
    body: k.own(rimStd({ vertexColors: true, roughness: 0.34, metalness: 0.2, envMap: TX.env(), envMapIntensity: 0.35, emissive: '#4a16b0', emissiveIntensity: 0.22 }, '#c4a8ff', 0.32, 3.0, flash)),
    head: k.own(rimStd({ vertexColors: true, roughness: 0.46, metalness: 0.04, emissive: '#6a34c8', emissiveIntensity: 0.14 }, '#b9a0ff', 0.14, 3.4, flash)),
    dark: k.own(rimStd({ color: '#2d2158', roughness: 0.38, metalness: 0.45, envMap: TX.env(), envMapIntensity: 0.6 }, '#a68bff', 0.35, 2.6, flash)),
    arm: k.own(rimStd({ color: '#6d28d9', roughness: 0.36, metalness: 0.2 }, '#c9b5ff', 0.3, 2.8, flash)),
    hand: k.own(rimStd({ color: '#cdbcff', roughness: 0.32, metalness: 0.05, emissive: '#5ee7ff', emissiveIntensity: 0 }, '#9eefff', 0.18, 3.0, flash)),
    visor: k.own(rimStd({ color: '#ffffff', map: V.map, emissive: '#5ee7ff', emissiveMap: V.glow, emissiveIntensity: 1.1, roughness: 0.22, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04, envMap: TX.env(), envMapIntensity: 0.8, alphaMap: V.alpha, alphaTest: 0.5 }, '#7c5cff', 0.15, 3.0, flash, true)),
    eye: k.own(unlit('#5ee7ff', 2.3)),
    gold: k.own(unlit('#ffd166', 2.5)),
    trim: k.own(unlit('#5ee7ff', 1.9)),
    violet: k.own(unlit('#b48cff', 1.5)),
    thrust: k.own(additive('#8feaff', 1.5, TX.fade(), { side: THREE.DoubleSide })),
    wing: k.own(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
    ring: k.own(ringMat(SPEC.vera.ringHex)),
    haloHand: k.own(spriteMat('#5ee7ff', 1.3)),
    haloGold: k.own(spriteMat('#ffd166', 1.4)),
  };
  const rims = [M.body, M.head, M.dark, M.arm, M.hand, M.visor];

  const root = new THREE.Group();
  root.name = 'hero:vera';
  const rig = heroRig(root, SPEC.vera.cy);
  const hover = grp(rig.body);
  part(hover, G.body, M.body, null, null, null, BOTH);
  part(hover, G.belt, M.trim, [0, 0.37, 0], [Math.PI / 2, 0, 0]);
  part(hover, G.lensRing, M.dark, [0, 0.53, 0.302]);
  part(hover, G.lens, M.gold, [0, 0.53, 0.302], null, [1, 1, 0.5]);
  const chestHalo = sprite(hover, M.haloGold, [0, 0.53, 0.37], 0.36);
  part(hover, G.pack, M.dark, [0, 0.5, -0.3], null, null, CAST);
  part(hover, G.packLight, M.trim, [0, 0.535, -0.352]);
  const neck = grp(hover, 0, 0.68, 0);
  part(neck, G.neck, M.dark, [0, 0.03, 0]);
  const head = grp(neck, 0, 0.38, 0);
  head.scale.set(1.06, 0.95, 1);
  part(head, G.head, M.head, null, null, null, BOTH);
  part(head, G.visor, M.visor);
  part(head, G.ears, M.arm, null, null, null, CAST);
  part(head, G.earRings, M.violet);
  const eyes = [];
  for (const side of [1, -1]) {
    const piv = grp(head);
    piv.rotation.y = side * 0.36;
    const holder = grp(piv, 0, -0.012, 0.371);
    const open = part(holder, G.eye, M.eye, null, null, [1, 1, 0.42]);
    const happy = part(holder, G.happy, M.eye, [0, -0.025, 0.006]);
    happy.visible = false;
    eyes.push({ piv, open, happy, side });
  }
  const ant1 = grp(head, 0, 0.352, -0.03);
  part(ant1, G.antBase, M.dark);
  part(ant1, G.stalk1, M.dark);
  const ant2 = grp(ant1, 0, 0.12, 0);
  part(ant2, G.stalk2, M.dark);
  part(ant2, G.tip, M.gold, [0, 0.12, 0]);
  const tipHalo = sprite(ant2, M.haloGold, [0, 0.12, 0], 0.3);
  const arms = [];
  for (const side of [1, -1]) {
    const sh = grp(hover, side * 0.33, 0.575, 0);
    part(sh, G.joint, M.dark);
    part(sh, G.arm, M.arm, [0, -0.12, 0], null, null, CAST);
    part(sh, G.hand, M.hand, [0, -0.255, 0.005], null, null, CAST);
    arms.push(sh);
  }
  const hand = grp(arms[1], 0, -0.27, 0.06);
  const handHalo = sprite(arms[1], M.haloHand, [0, -0.27, 0.09], 0.4);
  const feet = [];
  for (const side of [1, -1]) {
    const f = grp(rig.body, side * 0.13, 0.14, 0.02);
    part(f, G.foot, M.dark, null, null, [0.85, 0.62, 1.25], CAST);
    part(f, G.sole, M.trim, [0, -0.071, 0], [Math.PI / 2, 0, 0], [1, 1.3, 1]);
    const th = part(f, G.thrust, M.thrust, [0, -0.07, 0], null, [1, 0.2, 1.25]);
    feet.push({ f, th, side });
  }
  const wings = [];
  for (const side of [1, -1]) {
    const wg = grp(hover, side * 0.08, 0.57, -0.34);
    part(wg, G.wing, M.wing, null, null, [side, 1, 1]);
    wg.visible = false;
    wings.push(wg);
  }
  const ring = part(root, unitPlane(), M.ring, [0, 0.02, 0], null, [SPEC.vera.ring, 1, SPEC.vera.ring]);
  ring.renderOrder = 2;
  const headAnchor = grp(head);

  const d = newDriver();
  const antX = spring();
  const antZ = spring();
  let wingK = 0;

  function update(t, dt, s) {
    s = s || HERO_DEFAULT;
    dt = safeDt(dt);
    drive(d, SPEC.vera, t, dt, s, root);
    const w = d.w;
    const sp = clamp(d.speed / SPEC.vera.run);
    const p = d.phase;
    const s1 = Math.sin(p);
    const c1 = Math.cos(p);
    let bob = 0; let lean = 0; let roll = 0; let twist = 0; let hx = 0; let hy = 0; let hz = 0;
    let lx = 0; let ly = 0; let lz = 0; let rx = 0; let ry = 0; let rz = 0;
    let fly = 0; let flz = 0; let flx = 0; let fry = 0; let frz = 0; let frx = 0;
    let thrust = 0; let happy = 0; let squint = 0; let dim = 0;
    let k1;
    if ((k1 = w[IDLE]) > 1e-3) {
      const b = Math.sin(t * 2.3);
      bob += k1 * (0.035 * b + 0.02);
      lean += k1 * 0.03 * Math.sin(t * 1.1);
      roll += k1 * 0.025 * Math.sin(t * 0.9);
      hx += k1 * (d.lookP + 0.02 * Math.sin(t * 1.7)); hy += k1 * d.lookY; hz += k1 * 0.05 * Math.sin(t * 0.7);
      lz += k1 * (0.3 + 0.05 * Math.sin(t * 2.3 + 0.6)); rz -= k1 * (0.3 + 0.05 * Math.sin(t * 2.3 + 0.9));
      lx += k1 * 0.06 * Math.sin(t * 2.3 + 0.3); rx += k1 * 0.06 * Math.sin(t * 2.3 + 0.5);
      fly += k1 * (0.02 * Math.sin(t * 2.3 - 0.7) + 0.01); fry += k1 * (0.02 * Math.sin(t * 2.3 - 1.0) + 0.01);
      thrust += k1 * (0.38 + 0.06 * Math.sin(t * 11));
    }
    if ((k1 = w[RUN]) > 1e-3) {
      bob += k1 * (0.04 + 0.035 * Math.sin(2 * p + 0.6) * sp);
      lean += k1 * (0.22 * sp + clamp(d.accF * 0.008, -0.12, 0.15));
      twist += k1 * 0.14 * s1 * sp;
      roll += k1 * d.bank;
      hx -= k1 * 0.16 * sp; hy -= k1 * 0.1 * s1 * sp;
      lx += k1 * 0.95 * s1 * sp; rx -= k1 * 0.95 * s1 * sp;
      lz += k1 * 0.34; rz -= k1 * 0.34;
      flz += k1 * 0.2 * s1 * sp; frz -= k1 * 0.2 * s1 * sp;
      fly += k1 * (0.08 * Math.max(0, c1) * sp + 0.02); fry += k1 * (0.08 * Math.max(0, -c1) * sp + 0.02);
      flx -= k1 * 0.55 * s1 * sp; frx += k1 * 0.55 * s1 * sp;
      thrust += k1 * (0.55 + 0.5 * sp);
    }
    if ((k1 = w[AIR]) > 1e-3) {
      const up = clamp(d.vy / 7, -1, 1);
      const rise = Math.max(0, up);
      const fall = Math.max(0, -up);
      const flut = Math.sin(t * 16) * 0.08 * fall;
      bob += k1 * 0.03;
      lean += k1 * (-0.06 * rise + 0.12 * fall);
      roll += k1 * d.bank * 0.5;
      hx += k1 * (-0.2 * rise + 0.14 * fall);
      lx += k1 * (0.55 * rise - 0.25 * fall); rx += k1 * (0.55 * rise - 0.25 * fall);
      lz += k1 * (0.55 + 0.65 * fall + flut); rz -= k1 * (0.55 + 0.65 * fall + flut);
      fly += k1 * (0.06 * rise - 0.02 * fall); fry += k1 * (0.06 * rise - 0.02 * fall);
      flz += k1 * (-0.06 * rise + 0.05 * fall); frz += k1 * (-0.06 * rise + 0.05 * fall);
      flx += k1 * (0.45 * rise - 0.2 * fall); frx += k1 * (0.45 * rise - 0.2 * fall);
      thrust += k1 * (0.8 + 0.8 * rise);
    }
    if ((k1 = w[GLIDE]) > 1e-3) {
      const sw = Math.sin(t * 2.2);
      bob += k1 * 0.03 * sw;
      lean += k1 * 0.36; roll += k1 * (d.bank + 0.07 * sw);
      hx -= k1 * 0.3;
      lx += k1 * 0.12; rx += k1 * 0.12;
      lz += k1 * (1.4 + 0.05 * Math.sin(t * 5)); rz -= k1 * (1.4 + 0.05 * Math.sin(t * 5 + 1));
      fly += k1 * 0.05; fry += k1 * 0.05; flz -= k1 * 0.1; frz -= k1 * 0.1; flx += k1 * 0.85; frx += k1 * 0.85;
      thrust += k1 * (1.7 + 0.15 * Math.sin(t * 23));
    }
    if ((k1 = w[DASH]) > 1e-3) {
      lean += k1 * 0.6; hx -= k1 * 0.45;
      lx += k1 * 1.0; rx += k1 * 1.0; lz += k1 * 0.25; rz -= k1 * 0.25;
      flz -= k1 * 0.14; frz -= k1 * 0.14; flx += k1 * 0.9; frx += k1 * 0.9;
      thrust += k1 * 2.0;
    }
    if ((k1 = w[PUSH]) > 1e-3) {
      const ps = clamp(d.speed / 2.5);
      lean += k1 * 0.32; hx -= k1 * 0.2;
      lx -= k1 * 1.35; rx -= k1 * 1.35; lz += k1 * 0.12; rz -= k1 * 0.12;
      flz += k1 * 0.14 * s1 * ps; frz -= k1 * 0.14 * s1 * ps;
      fly += k1 * 0.05 * Math.max(0, c1) * ps; fry += k1 * 0.05 * Math.max(0, -c1) * ps;
      thrust += k1 * 0.9;
    }
    if ((k1 = w[POUND]) > 1e-3) {
      lean += k1 * 0.25; hx += k1 * 0.2;
      lx -= k1 * 2.7; rx -= k1 * 2.7; lz += k1 * 0.15; rz -= k1 * 0.15;
      fly += k1 * 0.06; fry += k1 * 0.06; thrust += k1 * 0.1;
    }
    if ((k1 = w[DEAD]) > 1e-3) {
      const f = easeOut(clamp(d.deadT / 0.5));
      bob -= k1 * 0.16 * f; lean += k1 * 0.35 * f; roll += k1 * 0.45 * f;
      hx += k1 * 0.5 * f; hz += k1 * 0.35 * f;
      lz += k1 * 0.08; rz -= k1 * 0.08; lx += k1 * 0.25; rx += k1 * 0.25;
      fly -= k1 * 0.08 * f; fry -= k1 * 0.08 * f;
      dim += k1 * f;
    }
    if ((k1 = w[CHEER]) > 1e-3) {
      const hop = Math.abs(Math.sin(t * 6.5));
      bob += k1 * (0.05 + hop * 0.16);
      twist += k1 * 0.35 * Math.sin(t * 3.25);
      hx -= k1 * 0.12; hz += k1 * 0.12 * Math.sin(t * 3.25);
      lz += k1 * (2.45 + 0.25 * Math.sin(t * 13)); rz -= k1 * (2.45 + 0.25 * Math.sin(t * 13 + 1.5));
      lx -= k1 * 0.1; rx -= k1 * 0.1;
      fly += k1 * hop * 0.05; fry += k1 * hop * 0.05;
      thrust += k1 * (0.6 + hop);
      happy += k1;
    }
    // zap: right arm (-X) points along +Z, the left one balances, the body kicks back
    const z = d.zapW;
    if (z > 1e-3) {
      const kick = d.zapT < 0.05 ? d.zapT / 0.05 : Math.exp(-(d.zapT - 0.05) * 9);
      rx = lerp(rx, -1.52, z); rz = lerp(rz, -0.06, z); ry = lerp(ry, 0, z);
      lx = lerp(lx, 0.5, z); lz = lerp(lz, 0.6, z);
      lean -= 0.2 * kick * z; twist = lerp(twist, -0.12, z); hy = lerp(hy, 0.1, z);
      squint += 0.35 * z;
    }
    const hw = d.hurtW;
    if (hw > 1e-3) {
      const shake = Math.sin(t * 70) * Math.exp(-d.hurtT * 6) * 0.14;
      lean = lerp(lean, -0.45, hw); roll += shake * hw;
      lz = lerp(lz, 1.2, hw); rz = lerp(rz, -1.2, hw); lx = lerp(lx, 0.3, hw); rx = lerp(rx, 0.3, hw);
      hx = lerp(hx, -0.3, hw); squint = lerp(squint, 1, hw);
      thrust = lerp(thrust, 1.1, hw);
    }
    hover.position.y = bob;
    hover.rotation.set(lean, twist, roll);
    neck.rotation.set(hx, hy, hz);
    arms[0].rotation.set(lx, ly, lz);
    arms[1].rotation.set(rx, ry, rz);
    feet[0].f.position.set(0.13, 0.14 + fly + bob * 0.5, 0.02 + flz);
    feet[0].f.rotation.x = flx;
    feet[1].f.position.set(-0.13, 0.14 + fry + bob * 0.5, 0.02 + frz);
    feet[1].f.rotation.x = frx;
    const flick = 0.85 + 0.15 * Math.sin(t * 37) * Math.sin(t * 23);
    const thLen = (0.08 + 0.22 * Math.min(thrust, 2)) * flick;
    for (const f of feet) f.th.scale.set(1, Math.max(0.01, thLen), 1.25);
    setGlow(M.thrust, (0.35 + 0.3 * Math.min(thrust, 1.8)) * (1 - dim));

    // eyes: blink, squint, happy arcs, '><' when hurt, off when dead
    const open = Math.max(0.08, d.eyeOpen * (1 - 0.65 * squint) * (1 - 0.9 * dim));
    for (const e of eyes) {
      e.open.visible = happy < 0.5;
      e.happy.visible = happy >= 0.5;
      e.open.scale.set(1, open, 0.42);
      e.open.rotation.z = e.side * 0.55 * hw;
      e.piv.rotation.y = e.side * 0.36 + d.lookY * 0.22 * w[IDLE];
      e.piv.rotation.x = -d.lookP * 0.3 * w[IDLE];
    }
    const glowK = (0.78 + 0.45 * d.activeK) * (1 - 0.9 * dim);
    setGlow(M.eye, glowK);
    setGlow(M.trim, glowK);
    setGlow(M.violet, glowK);
    const pulse = 0.72 + 0.28 * Math.sin(t * 4);
    setGlow(M.gold, (0.6 + 0.4 * pulse) * glowK);
    M.haloGold.color.copy(M.haloGold.userData.base).multiplyScalar(pulse * glowK);
    chestHalo.scale.setScalar(0.3 + 0.08 * pulse);
    tipHalo.scale.setScalar(0.26 + 0.06 * pulse);
    for (const m of rims) setRim(m, 0.6 + 0.55 * d.activeK);
    // zap glow at the hand
    const zf = z * (0.85 + 0.15 * Math.sin(t * 55));
    handHalo.visible = z > 0.02;
    handHalo.scale.setScalar(0.18 + 0.4 * zf);
    M.haloHand.color.copy(M.haloHand.userData.base).multiplyScalar(zf);
    M.hand.emissiveIntensity = 1.6 * z;

    // antenna: lags behind speed and acceleration, nods on landing
    if (d.landed) antX.v += 3 + 5 * d.impact;
    stepSpring(antX, clamp(-0.045 * d.velF - 0.008 * d.accF, -0.6, 0.6), 140, 7, dt);
    stepSpring(antZ, clamp(0.008 * d.accS + 0.03 * d.velS, -0.6, 0.6), 140, 7, dt);
    ant1.rotation.set(antX.x * 0.45 + 0.4 * dim, 0, antZ.x * 0.45);
    ant2.rotation.set(antX.x * 0.7 + 0.06 * Math.sin(t * 3) + 0.5 * dim, 0, antZ.x * 0.7 + 0.05 * Math.sin(t * 2.3));

    // glide wings unfold from the back
    wingK = approach(wingK, w[GLIDE] > 0.4 ? 1 : 0, 9, dt);
    for (let i = 0; i < 2; i++) {
      const wg = wings[i];
      wg.visible = wingK > 0.02;
      wg.scale.setScalar(0.3 + 0.7 * wingK);
      wg.rotation.set(-0.3 + 0.04 * Math.sin(t * 3), (i ? -1 : 1) * (0.62 + 0.3 * (1 - wingK)), (i ? -1 : 1) * (lerp(-1.25, 0.22, wingK) + 0.05 * Math.sin(t * 4)));
    }
    M.wing.opacity = wingK * (0.75 + 0.25 * Math.sin(t * 9));

    heroFlash(d, flash);
    finishRig(d, rig, ring, M.ring, t, s, {});
  }

  return {
    root, update, id: 'vera', radius: SPEC.vera.radius, height: SPEC.vera.height,
    anchors: { hand, head: headAnchor },
    dispose() { k.dispose(); root.removeFromParent(); },
  };
}

// ---------- Pix: the small, fast neon fox ----------
function pixGeo() {
  const FUR = '#ff7a1e';
  const FUR_HI = '#ffa040';
  const CREAM = '#fff1dc';
  const DARK = '#2a1840';
  return {
    body: geo('pix.body', () => paint(new THREE.SphereGeometry(0.14, 28, 20), (x, y, z, nx, ny, nz) => {
      const belly = sstep(0.25, 0.7, nz - 0.45 * Math.abs(nx) - 0.2 * ny);
      return mix(FUR, FUR_HI, sstep(-0.5, 0.9, ny)).lerp(col(CREAM), belly);
    })),
    head: geo('pix.head', () => paint(new THREE.SphereGeometry(0.185, 36, 26), (x, y, z, nx, ny, nz) => {
      const face = sstep(0.05, 0.4, nz * 0.75 - ny * 0.9 + 0.05) * sstep(-0.2, 0.3, nz);
      return mix(FUR, FUR_HI, sstep(-0.2, 1, ny)).lerp(col(CREAM), face);
    })),
    muzzle: geo('pix.muzzle', () => merged([
      [new THREE.SphereGeometry(0.085, 22, 16), [0, -0.045, 0.15], null, [0.85, 0.7, 1.25]],
      [new THREE.ConeGeometry(0.07, 0.13, 12), [0.155, -0.075, 0.03], [0, 0, -Math.PI / 2 - 0.75], [1, 1, 0.7]],
      [new THREE.ConeGeometry(0.07, 0.13, 12), [-0.155, -0.075, 0.03], [0, 0, Math.PI / 2 + 0.75], [1, 1, 0.7]],
    ])),
    face: geo('pix.face', () => merged([
      [new THREE.SphereGeometry(0.03, 14, 10), [0, -0.022, 0.252]],
      [new THREE.TorusGeometry(0.022, 0.0055, 6, 14, Math.PI), [0, -0.066, 0.232], [0.55, 0, Math.PI]],
    ])),
    eyes: geo('pix.eyes', () => pair((x, ry) => [new THREE.SphereGeometry(0.046, 20, 16), [x, 0, 0], [0, ry, 0], [0.85, 1.05, 0.55]])),
    iris: geo('pix.iris', () => pair((x, ry) => [new THREE.SphereGeometry(0.027, 18, 12), off(x, ry, 0, -0.004, 0.02), [0, ry, 0], [1, 1.08, 0.36]])),
    pupil: geo('pix.pupil', () => pair((x, ry) => [new THREE.SphereGeometry(0.0155, 14, 10), off(x, ry, 0, -0.004, 0.0255), [0, ry, 0], [1, 1.15, 0.3]])),
    shine: geo('pix.shine', () => pair((x, ry) => [new THREE.SphereGeometry(0.0095, 8, 6), off(x, ry, Math.sign(x) * 0.011, 0.012, 0.03)])),
    happy: geo('pix.happy', () => pair((x, ry) => [new THREE.TorusGeometry(0.03, 0.009, 6, 16, Math.PI), off(x, ry, 0, -0.01, 0.022), [0, ry, 0]])),
    marks: geo('pix.marks', () => merged([
      [new THREE.BoxGeometry(0.05, 0.009, 0.008), [0.155, -0.03, 0.095], [0, 0.95, -0.2]],
      [new THREE.BoxGeometry(0.044, 0.009, 0.008), [0.16, -0.055, 0.085], [0, 0.95, -0.45]],
      [new THREE.BoxGeometry(0.05, 0.009, 0.008), [-0.155, -0.03, 0.095], [0, -0.95, 0.2]],
      [new THREE.BoxGeometry(0.044, 0.009, 0.008), [-0.16, -0.055, 0.085], [0, -0.95, 0.45]],
    ])),
    ear: geo('pix.ear', () => paint(new THREE.ConeGeometry(0.078, 0.23, 16), (x, y) => mix(FUR, DARK, sstep(0.03, 0.075, y)))),
    earIn: geo('pix.earIn', () => new THREE.ConeGeometry(0.046, 0.15, 12)),
    strap: geo('pix.strap', () => new THREE.TorusGeometry(0.19, 0.016, 8, 48)),
    lensRim: geo('pix.lensRim', () => pair((x, ry) => [new THREE.TorusGeometry(0.044, 0.015, 10, 28), [x * 0.068 / 0.074, 0.118, 0.142], [-0.62, ry * 0.8, 0]])),
    lens: geo('pix.lens', () => pair((x, ry) => [new THREE.SphereGeometry(0.04, 20, 12), [x * 0.068 / 0.074, 0.118, 0.142], [-0.62, ry * 0.8, 0], [1, 1, 0.35]])),
    thigh: geo('pix.thigh', () => paint(new THREE.CapsuleGeometry(0.05, 0.06, 4, 12), () => col(FUR))),
    shin: geo('pix.shin', () => merged([
      [new THREE.CapsuleGeometry(0.037, 0.06, 4, 12), [0, -0.055, 0]],
      [new THREE.SphereGeometry(0.056, 16, 12), [0, -0.125, 0.035], null, [0.85, 0.6, 1.5]],
    ])),
    upper: geo('pix.upper', () => paint(new THREE.CapsuleGeometry(0.033, 0.05, 4, 12), () => col(FUR))),
    fore: geo('pix.fore', () => merged([
      [new THREE.CapsuleGeometry(0.03, 0.04, 4, 10), [0, -0.035, 0]],
      [new THREE.SphereGeometry(0.04, 14, 10), [0, -0.08, 0.005]],
    ])),
  };
}
const TAIL_REST = [0.75, 0.16, 0.12, -0.04, -0.16];

// Pix's tail: a tube swept through the five tail joints (Catmull-Rom spine, bushy radius profile). Buffers are
// preallocated; update() only rewrites positions and normals.
const TUBE_RINGS = 16;
const TUBE_SIDES = 12;
function tailRadius(u) { return 0.05 + 0.055 * Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.8 - 0.03 * sstep(0.85, 1, u); }
function tailTube(k, parent, material) {
  const R = TUBE_RINGS;
  const S = TUBE_SIDES;
  const n = R * S + 1;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const colr = new Float32Array(n * 3);
  const idx = [];
  for (let j = 0; j < R - 1; j++) {
    for (let i = 0; i < S; i++) {
      const a = j * S + i;
      const b = j * S + (i + 1) % S;
      const c = (j + 1) * S + i;
      const d = (j + 1) * S + (i + 1) % S;
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let i = 0; i < S; i++) idx.push((R - 1) * S + i, R * S, (R - 1) * S + (i + 1) % S);
  for (let j = 0; j <= R; j++) {
    const u = Math.min(1, j / (R - 1));
    const c = u < 0.55 ? mix('#ff7a1e', '#ff9a40', u / 0.55) : u < 0.82 ? mix('#ff9a40', '#fff1dc', (u - 0.55) / 0.27) : mix('#fff1dc', '#c8fbff', (u - 0.82) / 0.18);
    const cnt = j < R ? S : 1;
    for (let i = 0; i < cnt; i++) {
      const v = j * S + i;
      colr[v * 3] = c.r; colr[v * 3 + 1] = c.g; colr[v * 3 + 2] = c.b;
      uv[v * 2] = u; uv[v * 2 + 1] = i / S;
    }
  }
  const g = k.own(new THREE.BufferGeometry());
  g.setIndex(idx);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(colr, 3));
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  parent.add(mesh);
  const P = [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector3());
  const C = [0, 1].map(() => new THREE.Vector3());
  const m = new THREE.Matrix4();
  const tip = new THREE.Vector3(0, 0, -0.1);
  const T = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const side = new THREE.Vector3(1, 0, 0);
  const at = (u, out) => { // Catmull-Rom through P[0..5]
    const f = u * 5;
    const i = Math.min(4, Math.floor(f));
    const t = f - i;
    const p0 = P[Math.max(0, i - 1)];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[Math.min(5, i + 2)];
    const t2 = t * t;
    const t3 = t2 * t;
    out.x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
    out.y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
    out.z = 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
    return out;
  };
  return {
    mesh,
    update(joints) {
      // joint positions in the parent's space
      joints[0].updateMatrix();
      m.copy(joints[0].matrix);
      P[0].setFromMatrixPosition(m);
      for (let i = 1; i < 5; i++) { joints[i].updateMatrix(); m.multiply(joints[i].matrix); P[i].setFromMatrixPosition(m); }
      P[5].copy(tip).applyMatrix4(m);
      for (let j = 0; j < R; j++) {
        const u = j / (R - 1);
        at(u, C[0]);
        at(Math.min(1, u + 0.02), C[1]);
        if (j === R - 1) at(u - 0.02, T).sub(C[0]).negate(); else T.subVectors(C[1], C[0]);
        T.normalize();
        N.crossVectors(side, T);
        if (N.lengthSq() < 1e-6) N.set(0, 1, 0);
        N.normalize();
        B.crossVectors(T, N);
        const r = tailRadius(u);
        for (let i = 0; i < S; i++) {
          const a = i / S * TAU;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const nx = B.x * ca + N.x * sa;
          const ny = B.y * ca + N.y * sa;
          const nz = B.z * ca + N.z * sa;
          const v = (j * S + i) * 3;
          pos[v] = C[0].x + nx * r; pos[v + 1] = C[0].y + ny * r; pos[v + 2] = C[0].z + nz * r;
          nor[v] = nx; nor[v + 1] = ny; nor[v + 2] = nz;
        }
        if (j === R - 1) {
          const v = R * S * 3;
          pos[v] = C[0].x + T.x * r; pos[v + 1] = C[0].y + T.y * r; pos[v + 2] = C[0].z + T.z * r;
          nor[v] = T.x; nor[v + 1] = T.y; nor[v + 2] = T.z;
        }
      }
      g.attributes.position.needsUpdate = true;
      g.attributes.normal.needsUpdate = true;
    },
  };
}

function buildPix() {
  const k = owner();
  const flash = { value: new THREE.Color(0, 0, 0) };
  const G = pixGeo();
  const M = {
    fur: k.own(rimStd({ vertexColors: true, roughness: 0.62, metalness: 0 }, '#ffc690', 0.3, 2.6, flash)),
    cream: k.own(rimStd({ color: '#f6e6cf', roughness: 0.62 }, '#ffffff', 0.15, 2.8, flash)),
    dark: k.own(rimStd({ color: '#2a1840', roughness: 0.48, metalness: 0.1 }, '#3ee9ff', 0.28, 2.6, flash)),
    eye: k.own(rimStd({ color: '#120a22', roughness: 0.12, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05, envMap: TX.env(), envMapIntensity: 0.6 }, '#3ee9ff', 0.2, 2.6, flash, true)),
    iris: k.own(unlit('#3ee9ff', 1.15)),
    pupil: k.own(unlit('#07040f', 1)),
    shine: k.own(unlit('#ffffff', 1.6)),
    cyan: k.own(unlit('#3ee9ff', 0.85)),
    lens: k.own(rimStd({ color: '#0c3a46', emissive: '#3ee9ff', emissiveIntensity: 0.8, roughness: 0.08, metalness: 0.3, envMap: TX.env(), envMapIntensity: 1 }, '#ffffff', 0.3, 2.5, flash)),
    gold: k.own(rimStd({ color: '#ffb347', roughness: 0.26, metalness: 0.85, envMap: TX.env(), envMapIntensity: 1.1 }, '#ffe0b0', 0.2, 2.5, flash)),
    tail: k.own(rimStd({ vertexColors: true, emissive: '#3ee9ff', emissiveMap: TX.tailGlow(), emissiveIntensity: 1.2, roughness: 0.6 }, '#ffc690', 0.3, 2.6, flash)),
    trail: k.own(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })),
    ring: k.own(ringMat(SPEC.pix.ringHex)),
  };
  const rims = [M.fur, M.cream, M.dark, M.eye, M.lens, M.gold, M.tail];

  const root = new THREE.Group();
  root.name = 'hero:pix';
  const rig = heroRig(root, SPEC.pix.cy);
  const hips = grp(rig.body, 0, 0.29, 0);
  const torso = grp(hips);
  part(torso, G.body, M.fur, [0, 0.13, 0], null, [1, 1.2, 0.92], BOTH);
  const neck = grp(torso, 0, 0.26, 0.01);
  const head = grp(neck, 0, 0.13, 0);
  part(head, G.head, M.fur, null, null, [1.08, 0.93, 0.98], BOTH);
  part(head, G.muzzle, M.cream, null, null, null, CAST);
  part(head, G.face, M.dark);
  part(head, G.marks, M.cyan);
  // both eyes in one group: blink, squint and glance together
  const eyesG = grp(head, 0, 0.018, 0.148);
  const eyesOpen = grp(eyesG);
  part(eyesOpen, G.eyes, M.eye);
  part(eyesOpen, G.iris, M.iris);
  part(eyesOpen, G.pupil, M.pupil);
  part(eyesOpen, G.shine, M.shine);
  const eyesHappy = part(eyesG, G.happy, M.dark);
  eyesHappy.visible = false;
  const ears = [];
  for (const side of [1, -1]) {
    const piv = grp(head, side * 0.1, 0.12, -0.03);
    const tilt = grp(piv);
    tilt.rotation.z = -side * 0.3;
    part(tilt, G.ear, M.fur, [0, 0.105, 0], null, [1, 1, 0.45], CAST);
    part(tilt, G.earIn, M.cyan, [0, 0.075, 0.021], null, [0.8, 0.85, 0.3]);
    ears.push(piv);
  }
  const goggles = grp(head);
  part(goggles, G.strap, M.dark, null, [Math.PI / 2 - 0.62, 0, 0], [1.07, 1, 0.99]);
  part(goggles, G.lensRim, M.gold);
  part(goggles, G.lens, M.lens);
  const arms = [];
  const elbows = [];
  for (const side of [1, -1]) {
    const sh = grp(torso, side * 0.118, 0.205, 0);
    part(sh, G.upper, M.fur, [0, -0.045, 0], null, null, CAST);
    const el = grp(sh, 0, -0.09, 0);
    part(el, G.fore, M.dark, null, null, null, CAST);
    arms.push(sh); elbows.push(el);
  }
  const hand = grp(elbows[1], 0, -0.09, 0.03);
  const legs = [];
  const knees = [];
  for (const side of [1, -1]) {
    const hip = grp(hips, side * 0.075, 0.0, 0);
    part(hip, G.thigh, M.fur, [0, -0.06, 0], null, null, CAST);
    const kn = grp(hip, 0, -0.13, 0);
    part(kn, G.shin, M.dark, null, null, null, CAST);
    legs.push(hip); knees.push(kn);
  }
  // bushy tail: a chain of joints (animated) with one smooth tube swept along them every frame
  const tail = [];
  let parent = grp(hips, 0, 0.06, -0.11);
  for (let i = 0; i < 5; i++) {
    const j = i === 0 ? parent : grp(parent, 0, 0, -0.088);
    tail.push(j);
    parent = j;
  }
  const tailTip = grp(tail[4], 0, 0, -0.1);
  const tube = tailTube(k, hips, M.tail);
  const ring = part(root, unitPlane(), M.ring, [0, 0.02, 0], null, [SPEC.pix.ring, 1, SPEC.pix.ring]);
  ring.renderOrder = 2;
  const headAnchor = grp(head);

  // glowing tail streak: a ribbon through the tip's recent world positions
  const N = 18;
  const hist = new Float32Array(N * 3);
  const tpos = new Float32Array(N * 6);
  const tcol = new Float32Array(N * 6);
  const tgeo = k.own(new THREE.BufferGeometry());
  const tidx = [];
  for (let i = 0; i < N - 1; i++) { const a = i * 2; tidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  tgeo.setIndex(tidx);
  tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3).setUsage(THREE.DynamicDrawUsage));
  tgeo.setAttribute('color', new THREE.BufferAttribute(tcol, 3).setUsage(THREE.DynamicDrawUsage));
  const trail = new THREE.Mesh(tgeo, M.trail);
  trail.frustumCulled = false;
  trail.visible = false;
  root.add(trail);
  const inv = new THREE.Matrix4();
  const tipW = new THREE.Vector3();
  let trailK = 0;
  let histReady = false;

  const d = newDriver();
  const earSp = spring();
  const tailSx = spring();
  const tailSy = spring();
  let goggleK = 0;
  let twitchT = 9;
  let twitchSide = 1;
  let nextTwitch = 2;

  function update(t, dt, s) {
    s = s || HERO_DEFAULT;
    dt = safeDt(dt);
    drive(d, SPEC.pix, t, dt, s, root);
    const w = d.w;
    const sp = clamp(d.speed / SPEC.pix.run);
    const p = d.phase;
    const s1 = Math.sin(p);
    const c1 = Math.cos(p);
    let bob = 0; let hipX = 0; let lean = 0; let roll = 0; let twist = 0; let hx = 0; let hy = 0; let hz = 0;
    let aLX = 0; let aLZ = 0; let aRX = 0; let aRZ = 0; let eL = 0; let eR = 0;
    let gLX = 0; let gLZ = 0; let gRX = 0; let gRZ = 0; let kL = 0; let kR = 0;
    let earX = 0; let earZ = 0; let tailUp = 0; let tailWag = 0; let wagF = 2.4; let tailSide = 0; let tailFlat = 0;
    let goggle = 0; let happy = 0; let squint = 0; let dim = 0; let stretchZ = 0; let roll0 = 0; let drop = 0;
    let k1;
    if ((k1 = w[IDLE]) > 1e-3) {
      const br = Math.sin(t * 3);
      bob += k1 * 0.005 * br;
      lean += k1 * (0.05 + 0.015 * br);
      roll += k1 * 0.03 * Math.sin(t * 0.8);
      hx += k1 * (d.lookP + 0.03 * Math.sin(t * 1.5)); hy += k1 * d.lookY; hz += k1 * 0.08 * Math.sin(t * 0.6);
      aLZ += k1 * 0.2; aRZ -= k1 * 0.2;
      aLX += k1 * (0.08 * Math.sin(t * 3 + 0.4) - 0.1); aRX += k1 * (0.08 * Math.sin(t * 3 + 0.8) - 0.1);
      eL -= k1 * 0.6; eR -= k1 * 0.6;
      gLZ += k1 * 0.07; gRZ -= k1 * 0.07;
      tailUp += k1 * 0.75; tailWag += k1 * 0.28;
    }
    if ((k1 = w[RUN]) > 1e-3) {
      bob += k1 * -0.03 * sp * Math.cos(2 * p);
      lean += k1 * (0.38 * sp + clamp(d.accF * 0.01, -0.15, 0.2));
      hipX += k1 * 0.1 * sp;
      roll += k1 * d.bank; twist += k1 * 0.12 * s1 * sp;
      hx -= k1 * 0.3 * sp; hy -= k1 * 0.08 * s1 * sp;
      gLX -= k1 * 1.05 * s1 * sp; gRX += k1 * 1.05 * s1 * sp;
      kL += k1 * (0.25 + 1.35 * Math.max(0, c1)) * sp; kR += k1 * (0.25 + 1.35 * Math.max(0, -c1)) * sp;
      aLX += k1 * 1.05 * s1 * sp; aRX -= k1 * 1.05 * s1 * sp;
      aLZ += k1 * 0.16; aRZ -= k1 * 0.16; eL -= k1 * (0.4 + 0.9 * sp); eR -= k1 * (0.4 + 0.9 * sp);
      earX -= k1 * 0.65 * sp;
      tailUp += k1 * (0.75 - 0.55 * sp); tailWag += k1 * 0.12; tailSide += k1 * 0.2 * s1 * sp; tailFlat += k1 * sp;
    }
    if ((k1 = w[AIR]) > 1e-3) {
      const up = clamp(d.vy / 7, -1, 1);
      const rise = Math.max(0, up);
      const fall = Math.max(0, -up);
      const flut = Math.sin(t * 15) * 0.1 * fall;
      lean += k1 * (0.12 * rise - 0.04 * fall); hx += k1 * (-0.22 * rise + 0.15 * fall);
      roll += k1 * d.bank * 0.5;
      gLX += k1 * (-0.95 * rise - 0.3 * fall); gRX += k1 * (-0.5 * rise + 0.12 * fall);
      kL += k1 * (1.55 + 0.4 * fall - 1.15 * fall); kR += k1 * (1.1 * rise + 0.6 * fall);
      aLZ += k1 * (0.9 + 0.5 * fall + flut); aRZ -= k1 * (0.9 + 0.5 * fall + flut);
      aLX -= k1 * 0.5 * rise; aRX -= k1 * 0.5 * rise; eL -= k1 * 0.6; eR -= k1 * 0.6;
      earX += k1 * (-0.45 * rise + 0.3 * fall + 0.15 * Math.sin(t * 18) * fall);
      tailUp += k1 * (0.9 + 0.3 * fall); tailWag += k1 * 0.1;
    }
    if ((k1 = w[GLIDE]) > 1e-3) {
      lean += k1 * 0.3; aLZ += k1 * 1.4; aRZ -= k1 * 1.4; gLX += k1 * 0.3; gRX += k1 * 0.3; kL += k1 * 0.4; kR += k1 * 0.4;
      earX -= k1 * 0.5; tailUp += k1 * 0.4;
    }
    if ((k1 = w[DASH]) > 1e-3) {
      lean += k1 * 0.95; hipX += k1 * 0.35; hx -= k1 * 0.8;
      gLX += k1 * 1.0; gRX += k1 * 0.8; kL += k1 * 0.6; kR += k1 * 0.9;
      aLX += k1 * 1.5; aRX += k1 * 1.5; aLZ += k1 * 0.25; aRZ -= k1 * 0.25; eL -= k1 * 0.2; eR -= k1 * 0.2;
      earX -= k1 * 1.15; tailUp += k1 * 0.05; tailFlat += k1;
      goggle += k1; stretchZ += k1 * 0.3;
    }
    if ((k1 = w[PUSH]) > 1e-3) {
      const ps = clamp(d.speed / 2.5);
      lean += k1 * 0.45; hx -= k1 * 0.3;
      aLX -= k1 * 1.45; aRX -= k1 * 1.45; aLZ += k1 * 0.1; aRZ -= k1 * 0.1; eL -= k1 * 0.3; eR -= k1 * 0.3;
      gLX += k1 * (0.25 - 0.6 * s1 * ps); gRX += k1 * (0.25 + 0.6 * s1 * ps);
      kL += k1 * (0.4 + 0.7 * Math.max(0, c1) * ps); kR += k1 * (0.4 + 0.7 * Math.max(0, -c1) * ps);
      tailUp += k1 * 0.5; earX -= k1 * 0.3;
    }
    if ((k1 = w[POUND]) > 1e-3) {
      lean += k1 * 0.4; hx += k1 * 0.2; gLX -= k1 * 1.2; gRX -= k1 * 1.2; kL += k1 * 1.8; kR += k1 * 1.8;
      aLX -= k1 * 2.5; aRX -= k1 * 2.5; tailUp += k1 * 1.1; earX += k1 * 0.4;
    }
    if ((k1 = w[DEAD]) > 1e-3) {
      const f = easeOut(clamp(d.deadT / 0.45));
      roll0 += k1 * 1.45 * f; drop += k1 * 0.27 * f;
      hx += k1 * 0.3; earX += k1 * 0.7; earZ += k1 * 0.5;
      aLZ += k1 * 0.6; aRZ -= k1 * 0.2; gLX -= k1 * 0.3; kL += k1 * 0.5;
      tailUp += k1 * 0.05; tailFlat += k1; dim += k1 * f;
    }
    if ((k1 = w[CHEER]) > 1e-3) {
      const hop = Math.abs(Math.sin(t * 6.5));
      bob += k1 * hop * 0.22;
      lean -= k1 * 0.05; hx -= k1 * 0.15; hz += k1 * 0.15 * Math.sin(t * 3.25);
      aLZ += k1 * (2.5 + 0.3 * Math.sin(t * 13)); aRZ -= k1 * (2.5 + 0.3 * Math.sin(t * 13 + 1.2)); eL -= k1 * 0.3; eR -= k1 * 0.3;
      gLX -= k1 * hop * 0.4; gRX -= k1 * hop * 0.4; kL += k1 * hop * 0.9; kR += k1 * hop * 0.9;
      tailUp += k1 * 0.85; tailWag += k1 * 0.5; earX += k1 * 0.15;
      happy += k1;
    }
    // double jump: a forward flip with a tuck
    let flip = 0;
    if (d.spinT < 0.44) {
      const f = d.spinT / 0.44;
      flip = TAU * easeInOut(f);
      const tk = Math.sin(Math.PI * f);
      gLX = lerp(gLX, -1.5, tk); gRX = lerp(gRX, -1.5, tk); kL = lerp(kL, 2.1, tk); kR = lerp(kR, 2.1, tk);
      aLX = lerp(aLX, -0.9, tk); aRX = lerp(aRX, -0.9, tk); aLZ = lerp(aLZ, 0.25, tk); aRZ = lerp(aRZ, -0.25, tk);
      tailUp = lerp(tailUp, 1.4, tk); earX = lerp(earX, -0.8, tk); goggle = Math.max(goggle, tk);
    }
    const z = d.zapW;
    if (z > 1e-3) {
      aRX = lerp(aRX, -1.5, z); aRZ = lerp(aRZ, -0.05, z); eR = lerp(eR, 0, z);
      aLX = lerp(aLX, 0.4, z); aLZ = lerp(aLZ, 0.5, z);
      lean -= 0.15 * z * Math.exp(-d.zapT * 8); squint += 0.3 * z;
    }
    const hw = d.hurtW;
    if (hw > 1e-3) {
      const shake = Math.sin(t * 70) * Math.exp(-d.hurtT * 6) * 0.14;
      lean = lerp(lean, -0.5, hw); roll += shake * hw; hx = lerp(hx, -0.35, hw);
      aLZ = lerp(aLZ, 1.3, hw); aRZ = lerp(aRZ, -1.3, hw); aLX = lerp(aLX, 0.3, hw); aRX = lerp(aRX, 0.3, hw);
      earX = lerp(earX, -0.9, hw); tailUp = lerp(tailUp, 1.2, hw); squint = lerp(squint, 1, hw);
    }
    // ear flick now and then
    nextTwitch -= dt;
    if (nextTwitch <= 0) { nextTwitch = 1.5 + d.rnd() * 3; twitchT = 0; twitchSide = d.rnd() < 0.5 ? 1 : -1; }
    twitchT += dt;
    const twitch = twitchT < 0.22 ? Math.sin(twitchT / 0.22 * Math.PI) * 0.45 * w[IDLE] : 0;

    hips.position.y = 0.29 + bob;
    hips.rotation.set(hipX, 0, 0);
    torso.rotation.set(lean, twist, roll);
    neck.rotation.set(hx, hy, hz);
    arms[0].rotation.set(aLX, 0, aLZ);
    arms[1].rotation.set(aRX, 0, aRZ);
    elbows[0].rotation.x = eL;
    elbows[1].rotation.x = eR;
    legs[0].rotation.set(gLX, 0, gLZ);
    legs[1].rotation.set(gRX, 0, gRZ);
    knees[0].rotation.x = kL;
    knees[1].rotation.x = kR;
    // ears: drag back with speed and acceleration, droop when dead
    stepSpring(earSp, clamp(-0.012 * d.accF - 0.02 * d.vy, -0.5, 0.5), 160, 8, dt);
    for (let i = 0; i < 2; i++) {
      const side = i ? -1 : 1;
      ears[i].rotation.set(earX + earSp.x, 0, side * (earZ + (twitchSide === side ? twitch : 0)));
    }
    // tail: rest curl + wag + springy lag (side acceleration, vertical speed)
    if (d.landed) tailSx.v -= 4 + 6 * d.impact;
    stepSpring(tailSx, clamp(-0.035 * d.vy, -0.6, 0.6), 90, 6, dt);
    stepSpring(tailSy, clamp(0.02 * d.accS - 0.6 * d.yawRate * 0.1, -0.7, 0.7), 90, 6, dt);
    wagF = 2.4 + 9 * w[CHEER];
    for (let i = 0; i < 5; i++) {
      const rest = i === 0 ? tailUp : TAIL_REST[i] * (1 - 0.85 * clamp(tailFlat));
      const wave = Math.sin(t * wagF - i * 0.75) * tailWag * (0.35 + i * 0.16);
      tail[i].rotation.set(rest + tailSx.x * (i === 0 ? 0.5 : 0.18), (i === 0 ? tailSide : 0) + wave + tailSy.x * (i === 0 ? 0.6 : 0.15), 0);
    }
    tube.update(tail);
    goggleK = approach(goggleK, goggle > 0.5 ? 1 : 0, 12, dt);
    goggles.rotation.x = goggleK * 0.62;
    const open = Math.max(0.1, d.eyeOpen * (1 - 0.7 * squint) * (1 - 0.9 * dim));
    eyesOpen.visible = happy < 0.5;
    eyesHappy.visible = happy >= 0.5;
    eyesOpen.scale.set(1, open, 1);
    eyesG.rotation.x = -d.lookP * 0.25 * w[IDLE];
    const glowK = (0.8 + 0.45 * d.activeK) * (1 - 0.85 * dim);
    setGlow(M.iris, glowK);
    setGlow(M.cyan, glowK);
    M.tail.emissiveIntensity = 1.2 * glowK * (0.85 + 0.15 * Math.sin(t * 5));
    for (const m of rims) setRim(m, 0.6 + 0.55 * d.activeK);

    heroFlash(d, flash);
    finishRig(d, rig, ring, M.ring, t, s, { flip, roll: roll0, drop, sz: 1 + stretchZ, sy: 1 - stretchZ * 0.4 });

    // tail streak while sprinting, dashing or flipping
    trailK = approach(trailK, (d.speed > 4.5 && d.grounded) || w[DASH] > 0.3 || d.spinT < 0.44 ? 1 : 0, 6, dt);
    trail.visible = trailK > 0.01 && d.vis > 0.5;
    if (trail.visible) {
      tailTip.getWorldPosition(tipW);
      if (!histReady || d.teleported) { for (let i = 0; i < N; i++) { hist[i * 3] = tipW.x; hist[i * 3 + 1] = tipW.y; hist[i * 3 + 2] = tipW.z; } histReady = true; }
      hist.copyWithin(3, 0, (N - 1) * 3);
      hist[0] = tipW.x; hist[1] = tipW.y; hist[2] = tipW.z;
      inv.copy(root.matrixWorld).invert();
      for (let i = 0; i < N; i++) {
        _v1.set(hist[i * 3], hist[i * 3 + 1], hist[i * 3 + 2]).applyMatrix4(inv);
        const f = 1 - i / (N - 1);
        const wdt = 0.075 * f;
        tpos[i * 6] = _v1.x; tpos[i * 6 + 1] = _v1.y + wdt; tpos[i * 6 + 2] = _v1.z;
        tpos[i * 6 + 3] = _v1.x; tpos[i * 6 + 4] = _v1.y - wdt; tpos[i * 6 + 5] = _v1.z;
        const b = trailK * f * f * 1.6;
        tcol[i * 6] = tcol[i * 6 + 3] = 0.25 * b;
        tcol[i * 6 + 1] = tcol[i * 6 + 4] = 0.9 * b;
        tcol[i * 6 + 2] = tcol[i * 6 + 5] = 1.0 * b;
      }
      tgeo.attributes.position.needsUpdate = true;
      tgeo.attributes.color.needsUpdate = true;
    } else histReady = false;
  }

  return {
    root, update, id: 'pix', radius: SPEC.pix.radius, height: SPEC.pix.height,
    anchors: { hand, head: headAnchor },
    dispose() { k.dispose(); root.removeFromParent(); },
  };
}

// ---------- Brick: the big, friendly stone-and-steel golem ----------
function brickGeo() {
  const rb = (w, h, dd, r, sgm = 2) => new THREE.RoundedBoxGeometry(w, h, dd, sgm, r);
  return {
    pelvis: geo('brick.pelvis', () => rb(0.62, 0.26, 0.44, 0.09)),
    belt: geo('brick.belt', () => merged([[rb(0.68, 0.085, 0.48, 0.035), [0, 0.11, 0]], [rb(0.1, 0.24, 0.05, 0.02), [0, 0.0, 0.23]]])),
    buckle: geo('brick.buckle', () => new THREE.BoxGeometry(0.12, 0.06, 0.03)),
    chest: geo('brick.chest', () => rb(0.98, 0.74, 0.66, 0.17, 3)),
    band: geo('brick.band', () => merged([
      [rb(1.02, 0.09, 0.7, 0.04), [0, 0.1, 0]], [rb(0.46, 0.36, 0.06, 0.03), [0, 0.42, -0.33]],
      [new THREE.TorusGeometry(0.165, 0.035, 4, 6).rotateZ(Math.PI / 6), [0, 0.44, 0.335]],
    ])),
    core: geo('brick.core', () => new THREE.CylinderGeometry(0.13, 0.13, 0.08, 6).rotateX(Math.PI / 2).rotateZ(Math.PI / 6)),

    shoulders: geo('brick.shoulders', () => merged([
      [new THREE.DodecahedronGeometry(0.28, 0), [0.5, 0.64, -0.02], [0.3, 0.2, 0.1], [1.05, 0.9, 1]],
      [new THREE.DodecahedronGeometry(0.28, 0), [-0.5, 0.64, -0.02], [0.1, -0.3, 0.2], [1.05, 0.9, 1]],
    ])),
    crystals: geo('brick.crystals', () => merged([
      [new THREE.ConeGeometry(0.06, 0.3, 5), [0.52, 0.93, -0.06], [0.15, 0, -0.35]],
      [new THREE.ConeGeometry(0.045, 0.2, 5), [0.66, 0.86, 0.02], [0.3, 0, -0.85]],
      [new THREE.ConeGeometry(0.04, 0.18, 5), [0.4, 0.88, -0.12], [-0.35, 0, -0.1]],
      [new THREE.ConeGeometry(0.045, 0.2, 5), [-0.56, 0.89, -0.1], [-0.3, 0, 0.45]],
      [new THREE.ConeGeometry(0.035, 0.14, 5), [-0.44, 0.86, -0.16], [-0.5, 0, 0.1]],
    ])),
    vents: geo('brick.vents', () => merged([
      [new THREE.BoxGeometry(0.3, 0.035, 0.02), [0, 0.5, -0.365]],
      [new THREE.BoxGeometry(0.3, 0.035, 0.02), [0, 0.42, -0.365]],
      [new THREE.BoxGeometry(0.3, 0.035, 0.02), [0, 0.34, -0.365]],
    ])),
    head: geo('brick.head', () => merged([[rb(0.38, 0.3, 0.34, 0.09), [0, 0.1, 0.03]], [rb(0.46, 0.1, 0.16, 0.045), [0, 0.215, 0.13], [0.12, 0, 0]]])),
    jaw: geo('brick.jaw', () => rb(0.27, 0.07, 0.07, 0.025)),
    eyes: geo('brick.eyes', () => merged([
      [new THREE.SphereGeometry(0.05, 16, 12), [0.095, 0, 0], null, [1.15, 0.85, 0.5]],
      [new THREE.SphereGeometry(0.05, 16, 12), [-0.095, 0, 0], null, [1.15, 0.85, 0.5]],
    ])),
    happy: geo('brick.happy', () => merged([
      [new THREE.TorusGeometry(0.042, 0.014, 6, 16, Math.PI), [0.095, -0.02, 0.01]],
      [new THREE.TorusGeometry(0.042, 0.014, 6, 16, Math.PI), [-0.095, -0.02, 0.01]],
    ])),
    upper: geo('brick.upper', () => rb(0.27, 0.42, 0.29, 0.09)),
    fore: geo('brick.fore', () => merged([[rb(0.3, 0.36, 0.32, 0.1), [0, -0.17, 0]], [rb(0.45, 0.42, 0.45, 0.14, 3), [0, -0.52, 0.02]]])),
    foreSteel: geo('brick.foreSteel', () => merged([
      [new THREE.CylinderGeometry(0.175, 0.175, 0.08, 10), [0, -0.01, 0]],
      [new THREE.CylinderGeometry(0.185, 0.185, 0.07, 10), [0, -0.31, 0]],
      [rb(0.47, 0.11, 0.2, 0.04), [0, -0.63, 0.17]],
    ])),
    studs: geo('brick.studs', () => merged([
      [new THREE.BoxGeometry(0.06, 0.05, 0.03), [-0.13, -0.63, 0.275]],
      [new THREE.BoxGeometry(0.06, 0.05, 0.03), [0, -0.63, 0.275]],
      [new THREE.BoxGeometry(0.06, 0.05, 0.03), [0.13, -0.63, 0.275]],
    ])),
    thigh: geo('brick.thigh', () => rb(0.27, 0.32, 0.29, 0.09)),
    shin: geo('brick.shin', () => merged([[rb(0.28, 0.22, 0.3, 0.08), [0, -0.1, 0]], [rb(0.35, 0.13, 0.46, 0.05), [0, -0.19, 0.06]]])),
    knee: geo('brick.knee', () => new THREE.CylinderGeometry(0.16, 0.16, 0.07, 10)),
  };
}

function buildBrick() {
  const k = owner();
  const flash = { value: new THREE.Color(0, 0, 0) };
  const G = brickGeo();
  const S = TX.stone();
  const M = {
    stone: k.own(rimStd({ color: '#c9c6c4', map: S.map, emissive: '#ff9a1f', emissiveMap: S.glow, emissiveIntensity: 0.3, roughness: 0.9, metalness: 0 }, '#a9b8ff', 0.22, 2.6, flash)),
    rock: k.own(rimStd({ color: '#aaa8a8', map: S.map, roughness: 0.92, metalness: 0, flatShading: true }, '#a9b8ff', 0.22, 2.6, flash)),
    steel: k.own(rimStd({ color: '#aab4c3', roughness: 0.3, metalness: 0.88, envMap: TX.env(), envMapIntensity: 1.1 }, '#dfe6ff', 0.2, 2.8, flash)),
    amber: k.own(unlit('#ffa51c', 1.8)),
    crystal: k.own(rimStd({ color: '#ffcf6b', emissive: '#ff9a1f', emissiveIntensity: 1.3, roughness: 0.2, metalness: 0.1, flatShading: true }, '#ffffff', 0.4, 2.0, flash)),
    halo: k.own(spriteMat('#ffa31a', 0.9)),
    ring: k.own(ringMat(SPEC.brick.ringHex)),
  };
  const rims = [M.stone, M.rock, M.steel, M.crystal];

  const root = new THREE.Group();
  root.name = 'hero:brick';
  const rig = heroRig(root, SPEC.brick.cy);
  const hips = grp(rig.body, 0, 0.52, 0);
  part(hips, G.pelvis, M.stone, [0, 0.03, 0], null, null, BOTH);
  part(hips, G.belt, M.steel);
  part(hips, G.buckle, M.amber, [0, 0.11, 0.245]);
  const torso = grp(hips, 0, 0.14, 0);
  part(torso, G.chest, M.stone, [0, 0.38, 0], null, null, BOTH);
  part(torso, G.band, M.steel, null, null, null, CAST);
  part(torso, G.shoulders, M.rock, null, null, null, BOTH);
  part(torso, G.crystals, M.crystal, null, null, null, CAST);
  part(torso, G.vents, M.amber);
  const core = part(torso, G.core, M.amber, [0, 0.44, 0.33]);
  const coreHalo = sprite(torso, M.halo, [0, 0.44, 0.4], 0.7);
  const neck = grp(torso, 0, 0.7, 0.12);
  const head = grp(neck);
  part(head, G.head, M.stone, null, null, null, BOTH);
  part(head, G.jaw, M.steel, [0, -0.035, 0.195]);
  const eyesG = grp(head, 0, 0.115, 0.2);
  const eyesOpen = part(eyesG, G.eyes, M.amber);
  const eyesHappy = part(eyesG, G.happy, M.amber);
  eyesHappy.visible = false;
  const arms = [];
  const elbows = [];
  for (const side of [1, -1]) {
    const sh = grp(torso, side * 0.6, 0.56, 0);
    part(sh, G.upper, M.stone, [0, -0.2, 0], null, null, BOTH);
    const el = grp(sh, 0, -0.4, 0);
    part(el, G.fore, M.stone, null, null, null, BOTH);
    part(el, G.foreSteel, M.steel);
    part(el, G.studs, M.amber);
    arms.push(sh); elbows.push(el);
  }
  const hand = grp(elbows[1], 0, -0.55, 0.25);
  const legs = [];
  const knees = [];
  for (const side of [1, -1]) {
    const hip = grp(hips, side * 0.22, 0, 0);
    part(hip, G.thigh, M.stone, [0, -0.13, 0], null, null, BOTH);
    const kn = grp(hip, 0, -0.27, 0);
    part(kn, G.knee, M.steel);
    part(kn, G.shin, M.stone, null, null, null, BOTH);
    legs.push(hip); knees.push(kn);
  }
  const ring = part(root, unitPlane(), M.ring, [0, 0.02, 0], null, [SPEC.brick.ring, 1, SPEC.brick.ring]);
  ring.renderOrder = 2;
  const headAnchor = grp(head, 0, 0.1, 0);
  const d = newDriver();

  function update(t, dt, s) {
    s = s || HERO_DEFAULT;
    dt = safeDt(dt);
    drive(d, SPEC.brick, t, dt, s, root);
    const w = d.w;
    const sp = clamp(d.speed / SPEC.brick.run);
    const p = d.phase;
    const s1 = Math.sin(p);
    const c1 = Math.cos(p);
    let bob = 0; let hipX = 0; let hipZ = 0; let lean = 0; let roll = 0; let twist = 0; let hx = 0; let hy = 0; let hz = 0;
    let aLX = 0; let aLZ = 0; let aRX = 0; let aRZ = 0; let eL = 0; let eR = 0;
    let gLX = 0; let gLZ = 0; let gRX = 0; let gRZ = 0; let kL = 0; let kR = 0;
    let happy = 0; let squint = 0; let dim = 0; let coreBoost = 0;
    let k1;
    if ((k1 = w[IDLE]) > 1e-3) {
      const br = Math.sin(t * 1.4);
      bob += k1 * 0.012 * br;
      lean += k1 * (0.1 + 0.025 * br);
      hx += k1 * (d.lookP * 0.6 + 0.02 * br); hy += k1 * d.lookY * 0.7;
      aLZ += k1 * (0.13 + 0.025 * br); aRZ -= k1 * (0.13 + 0.025 * br);
      aLX -= k1 * 0.1; aRX -= k1 * 0.1; eL -= k1 * 0.16; eR -= k1 * 0.16;
      gLZ += k1 * 0.04; gRZ -= k1 * 0.04;
    }
    if ((k1 = w[RUN]) > 1e-3) {
      bob += k1 * (0.045 * sp * Math.cos(2 * p) - 0.02 * sp);
      lean += k1 * (0.2 * sp + clamp(d.accF * 0.01, -0.1, 0.12));
      roll += k1 * (0.07 * s1 * sp + d.bank * 0.6); twist += k1 * 0.16 * s1 * sp; hipZ -= k1 * 0.05 * s1 * sp;
      hx -= k1 * 0.12 * sp; hy -= k1 * 0.12 * s1 * sp;
      gLX -= k1 * 0.72 * s1 * sp; gRX += k1 * 0.72 * s1 * sp;
      kL += k1 * (0.15 + 1.05 * Math.max(0, c1)) * sp; kR += k1 * (0.15 + 1.05 * Math.max(0, -c1)) * sp;
      aLX += k1 * (0.68 * s1 * sp - 0.15); aRX += k1 * (-0.68 * s1 * sp - 0.15);
      aLZ += k1 * 0.17; aRZ -= k1 * 0.17; eL -= k1 * 0.38; eR -= k1 * 0.38;
    }
    if ((k1 = w[AIR]) > 1e-3) {
      const up = clamp(d.vy / 6, -1, 1);
      const rise = Math.max(0, up);
      const fall = Math.max(0, -up);
      lean += k1 * (0.05 + 0.05 * fall); hx += k1 * (-0.15 * rise + 0.1 * fall);
      aLX += k1 * (-0.9 * rise - 0.35 * fall); aRX += k1 * (-0.9 * rise - 0.35 * fall);
      aLZ += k1 * (0.45 + 0.4 * fall); aRZ -= k1 * (0.45 + 0.4 * fall); eL -= k1 * 0.4; eR -= k1 * 0.4;
      gLX += k1 * (-0.55 * rise - 0.15 * fall); gRX += k1 * (-0.35 * rise - 0.1 * fall);
      kL += k1 * (0.95 * rise + 0.3 * fall); kR += k1 * (0.75 * rise + 0.35 * fall);
    }
    if ((k1 = w[GLIDE]) > 1e-3) {
      aLZ += k1 * 1.2; aRZ -= k1 * 1.2; lean += k1 * 0.2;
    }
    if ((k1 = w[DASH]) > 1e-3) {
      lean += k1 * 0.6; aLX += k1 * 0.9; aRX += k1 * 0.9; gLX += k1 * 0.5; kL += k1 * 0.6; kR += k1 * 0.4;
    }
    if ((k1 = w[PUSH]) > 1e-3) {
      const ps = clamp(d.speed / 2.2);
      const strain = (1 - ps) * 0.02 * Math.sin(t * 45);
      lean += k1 * 0.44; hipX += k1 * 0.12; hx -= k1 * 0.25; roll += k1 * (strain + 0.04 * s1 * ps);
      aLX -= k1 * 1.28; aRX -= k1 * 1.28; aLZ += k1 * 0.24; aRZ -= k1 * 0.24; eL -= k1 * 0.55; eR -= k1 * 0.55;
      gLX += k1 * (0.28 - 0.55 * s1 * ps); gRX += k1 * (0.28 + 0.55 * s1 * ps);
      kL += k1 * (0.35 + 0.7 * Math.max(0, c1) * ps); kR += k1 * (0.35 + 0.7 * Math.max(0, -c1) * ps);
      bob -= k1 * 0.04;
    }
    if ((k1 = w[POUND]) > 1e-3) {
      lean += k1 * 0.5; hx += k1 * 0.15;
      aLX -= k1 * 2.75; aRX -= k1 * 2.75; aLZ -= k1 * 0.28; aRZ += k1 * 0.28; eL -= k1 * 0.75; eR -= k1 * 0.75;
      gLX -= k1 * 0.9; gRX -= k1 * 0.9; kL += k1 * 1.5; kR += k1 * 1.5;
      coreBoost += k1 * 0.8;
    }
    if ((k1 = w[DEAD]) > 1e-3) {
      const f = easeOut(clamp(d.deadT / 0.55));
      bob -= k1 * 0.34 * f; lean += k1 * 0.6 * f; hx += k1 * 0.45 * f; hz += k1 * 0.2 * f;
      aLX += k1 * 0.25; aRX += k1 * 0.1; aLZ += k1 * 0.05; aRZ -= k1 * 0.05;
      gLX -= k1 * 1.2 * f; gRX -= k1 * 0.5 * f; kL += k1 * 1.65 * f; kR += k1 * 1.0 * f;
      dim += k1 * f;
    }
    if ((k1 = w[CHEER]) > 1e-3) {
      const ph = t * 5;
      const pumpL = Math.max(0, Math.sin(ph));
      const pumpR = Math.max(0, -Math.sin(ph));
      bob += k1 * Math.abs(Math.sin(ph)) * 0.09;
      lean -= k1 * 0.06; hx -= k1 * 0.2; hz += k1 * 0.1 * Math.sin(ph);
      aLX += k1 * (-2.7 * pumpL - 0.4); aRX += k1 * (-2.7 * pumpR - 0.4); aLZ += k1 * 0.32; aRZ -= k1 * 0.32;
      eL -= k1 * (0.25 + 0.5 * pumpL); eR -= k1 * (0.25 + 0.5 * pumpR);
      gLZ += k1 * 0.08; gRZ -= k1 * 0.08;
      happy += k1; coreBoost += k1;
    }
    // ground-pound slam: fists hit the ground in front, deep squat, core flares
    if (d.slamT < 0.62) {
      const e = d.slamT < 0.07 ? d.slamT / 0.07 : 1 - easeInOut(clamp((d.slamT - 0.07) / 0.55));
      lean = lerp(lean, 0.78, e); hipX = lerp(hipX, 0.2, e); bob = lerp(bob, -0.22, e); hx = lerp(hx, -0.35, e);
      aLX = lerp(aLX, -1.15, e); aRX = lerp(aRX, -1.15, e); aLZ = lerp(aLZ, -0.12, e); aRZ = lerp(aRZ, 0.12, e);
      eL = lerp(eL, -0.1, e); eR = lerp(eR, -0.1, e);
      gLX = lerp(gLX, -0.6, e); gRX = lerp(gRX, -0.6, e); kL = lerp(kL, 1.0, e); kR = lerp(kR, 1.0, e);
      coreBoost += 2 * e; squint += 0.4 * e;
    }
    const z = d.zapW;
    if (z > 1e-3) {
      aRX = lerp(aRX, -1.45, z); aRZ = lerp(aRZ, 0.0, z); eR = lerp(eR, -0.1, z);
      lean -= 0.12 * z * Math.exp(-d.zapT * 8); squint += 0.3 * z;
    }
    const hw = d.hurtW;
    if (hw > 1e-3) {
      const shake = Math.sin(t * 60) * Math.exp(-d.hurtT * 6) * 0.1;
      lean = lerp(lean, -0.25, hw); roll += shake * hw; hx = lerp(hx, -0.3, hw);
      aLZ = lerp(aLZ, 0.85, hw); aRZ = lerp(aRZ, -0.85, hw); aLX = lerp(aLX, -0.3, hw); aRX = lerp(aRX, -0.3, hw);
      squint = lerp(squint, 1, hw);
    }
    hips.position.y = 0.52 + bob;
    hips.rotation.set(hipX, 0, hipZ);
    torso.rotation.set(lean, twist, roll);
    neck.rotation.set(hx - lean * 0.35, hy, hz);
    arms[0].rotation.set(aLX, 0, aLZ);
    arms[1].rotation.set(aRX, 0, aRZ);
    elbows[0].rotation.x = eL;
    elbows[1].rotation.x = eR;
    legs[0].rotation.set(gLX - hipX, 0, gLZ);
    legs[1].rotation.set(gRX - hipX, 0, gRZ);
    knees[0].rotation.x = kL;
    knees[1].rotation.x = kR;
    // the core beats like a heart; the amber cracks in the stone pulse with it
    const x = (t % 1.3) / 1.3;
    const beat = Math.exp(-(((x - 0.06) / 0.045) ** 2)) + 0.6 * Math.exp(-(((x - 0.24) / 0.05) ** 2));
    const glowK = (0.78 + 0.45 * d.activeK) * (1 - 0.9 * dim);
    setGlow(M.amber, (0.9 + 0.35 * beat + 0.4 * coreBoost) * glowK);
    M.halo.color.copy(M.halo.userData.base).multiplyScalar((0.7 + 0.5 * beat + 0.5 * coreBoost) * glowK);
    coreHalo.scale.setScalar(0.42 + 0.1 * beat + 0.25 * coreBoost);
    core.scale.setScalar(1 + 0.06 * beat);
    M.stone.emissiveIntensity = (0.22 + 0.35 * beat + 0.6 * coreBoost) * glowK;
    M.crystal.emissiveIntensity = (0.75 + 0.35 * beat + 0.5 * coreBoost) * glowK;
    for (const m of rims) setRim(m, 0.6 + 0.55 * d.activeK);
    const open = Math.max(0.1, d.eyeOpen * (1 - 0.7 * squint) * (1 - 0.9 * dim));
    eyesOpen.visible = happy < 0.5;
    eyesHappy.visible = happy >= 0.5;
    eyesOpen.scale.set(1, open, 1);
    heroFlash(d, flash);
    finishRig(d, rig, ring, M.ring, t, s, {});
  }

  return {
    root, update, id: 'brick', radius: SPEC.brick.radius, height: SPEC.brick.height,
    anchors: { hand, head: headAnchor },
    dispose() { k.dispose(); root.removeFromParent(); },
  };
}

export function makeHero(id) {
  if (id === 'pix') return buildPix();
  if (id === 'brick') return buildBrick();
  return buildVera();
}

// ======================================================================================
// Enemies
// ======================================================================================
const ENEMY_DEFAULT = { state: 'idle', aim: null, fov: 70, range: 11, hp01: 1, phase: 1 };
const STATE_HEX = { idle: '#2ee6c8', patrol: '#2ee6c8', alert: '#ffd23f', chase: '#ff8a3d', attack: '#ff2d55', stunned: '#8fd8ff', dead: '#262a40' };
const CONE_OP = { idle: 0.2, patrol: 0.2, alert: 0.36, chase: 0.32, attack: 0.36 };
const LID = { idle: 0.42, patrol: 0.3, alert: -0.05, chase: 0.1, attack: 0.22, stunned: 0.62, dead: 1 };
const stateCol = (st) => col(STATE_HEX[st] || STATE_HEX.idle);
const AIM = { yaw: 0, pitch: 0 };

function newFoe() {
  return {
    state: '', prev: '', stT: 0, col: col(STATE_HEX.idle).clone(), hp: 1, hitT: 9, ready: false,
    px: 0, pz: 0, vx: 0, vz: 0, velF: 0, velS: 0, speed: 0, yaw: 0, pitch: 0, rnd: rng(seeds++ * 104729),
  };
}
// state timers, state colour, hit detection (hp01 drops) and measured motion in the enemy's own frame
function foeStep(e, s, dt, root) {
  const st = typeof s.state === 'string' ? s.state : 'idle';
  if (st !== e.state) { e.prev = e.state; e.state = st; e.stT = 0; } else e.stT += dt;
  const hp = clamp(num(s.hp01, 1));
  if (hp < e.hp - 0.01) e.hitT = 0;
  e.hp = hp;
  e.hitT += dt;
  e.col.lerp(stateCol(st), 1 - Math.exp(-9 * dt));
  root.updateWorldMatrix(true, false);
  const el = root.matrixWorld.elements;
  const px = el[12];
  const pz = el[14];
  const jump = Math.abs(px - e.px) + Math.abs(pz - e.pz) > 4;
  if (!e.ready || jump) { e.vx = e.vz = 0; e.ready = true; } else if (dt > 0) {
    e.vx = approach(e.vx, (px - e.px) / dt, 12, dt);
    e.vz = approach(e.vz, (pz - e.pz) / dt, 12, dt);
  }
  e.px = px; e.pz = pz;
  const yaw = num(root.rotation.y);
  const sy = Math.sin(yaw);
  const cy = Math.cos(yaw);
  e.velF = e.vx * sy + e.vz * cy;
  e.velS = e.vx * cy - e.vz * sy;
  e.speed = Math.hypot(e.vx, e.vz);
}
// world aim point -> yaw / pitch in root space, seen from a local pivot (ox, oy, oz)
function aimAngles(root, aim, ox, oy, oz) {
  _v1.set(aim.x, aim.y, aim.z);
  root.worldToLocal(_v1);
  const dx = _v1.x - ox;
  const dy = _v1.y - oy;
  const dz = _v1.z - oz;
  AIM.yaw = Math.atan2(dx, dz);
  AIM.pitch = -Math.atan2(dy, Math.hypot(dx, dz));
  return AIM;
}
function hitFlash(e, flash, extra = 0) {
  const k = e.hitT < 0.25 ? (1 - e.hitT / 0.25) : 0;
  flash.value.setRGB(1.1 * k + extra, 1.0 * k + extra, 1.2 * k + extra);
}

// Sparks: points thrown out from a centre on short repeating lives (no allocations per frame).
function makeSparks(k, parent, n, hex, size) {
  const pos = new Float32Array(n * 3);
  const dir = new Float32Array(n * 4);
  const R = rng(seeds++ * 31337);
  for (let i = 0; i < n; i++) {
    const a = R() * TAU;
    const z = R() * 2 - 1;
    const r = Math.sqrt(1 - z * z);
    dir[i * 4] = Math.cos(a) * r; dir[i * 4 + 1] = Math.abs(z) * 0.8 + 0.2; dir[i * 4 + 2] = Math.sin(a) * r; dir[i * 4 + 3] = R();
  }
  const g = k.own(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  const m = k.own(new THREE.PointsMaterial({ color: col(hex).clone().multiplyScalar(2.2), map: TX.glow(), size, sizeAttenuation: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.visible = false;
  parent.add(pts);
  return {
    pts, m,
    update(t, amount, cx, cy, cz, radius, speed = 1) {
      pts.visible = amount > 0.02;
      if (!pts.visible) return;
      m.opacity = Math.min(1, amount);
      for (let i = 0; i < n; i++) {
        const u = (t * 1.7 * speed + dir[i * 4 + 3]) % 1;
        const d = radius + u * 0.6 * speed;
        pos[i * 3] = cx + dir[i * 4] * d;
        pos[i * 3 + 1] = cy + dir[i * 4 + 1] * d * 0.8 - u * u * 0.9;
        pos[i * 3 + 2] = cz + dir[i * 4 + 2] * d;
      }
      g.attributes.position.needsUpdate = true;
    },
  };
}
// Electric arcs: jagged polylines flickering over a sphere.
function makeArcs(k, parent, hex) {
  const N = 5;
  const S = 4;
  const pos = new Float32Array(N * S * 6);
  const g = k.own(new THREE.BufferGeometry());
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  const m = k.own(new THREE.LineBasicMaterial({ color: col(hex).clone().multiplyScalar(2.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  const lines = new THREE.LineSegments(g, m);
  lines.frustumCulled = false;
  lines.visible = false;
  parent.add(lines);
  const R = rng(seeds++ * 7);
  let tick = -1;
  return {
    update(t, amount, cx, cy, cz, radius) {
      lines.visible = amount > 0.05 && (t * 11) % 1 < 0.75;
      if (!lines.visible) return;
      m.opacity = Math.min(1, amount);
      const q = Math.floor(t * 18);
      if (q === tick) return;
      tick = q;
      let o = 0;
      for (let a = 0; a < N; a++) {
        let th = R() * TAU;
        let ph = R() * Math.PI;
        let x = cx + Math.cos(th) * Math.sin(ph) * radius;
        let y = cy + Math.cos(ph) * radius;
        let z = cz + Math.sin(th) * Math.sin(ph) * radius;
        for (let b = 0; b < S; b++) {
          th += (R() - 0.5) * 0.9; ph += (R() - 0.5) * 0.9;
          const r2 = radius * (1.02 + R() * 0.18);
          const nx = cx + Math.cos(th) * Math.sin(ph) * r2;
          const ny = cy + Math.cos(ph) * r2;
          const nz = cz + Math.sin(th) * Math.sin(ph) * r2;
          pos[o++] = x; pos[o++] = y; pos[o++] = z; pos[o++] = nx; pos[o++] = ny; pos[o++] = nz;
          x = nx; y = ny; z = nz;
        }
      }
      g.attributes.position.needsUpdate = true;
    },
  };
}
// '!' over an enemy that just spotted a hero
function makeMark(k, parent, y) {
  const m = k.own(new THREE.SpriteMaterial({ map: TX.mark('!'), color: col('#ffd23f').clone().multiplyScalar(1.6), transparent: true, depthWrite: false, depthTest: false, fog: false }));
  const s = new THREE.Sprite(m);
  s.position.y = y;
  s.renderOrder = 10;
  s.visible = false;
  parent.add(s);
  let tt = 9;
  return {
    trigger() { tt = 0; },
    update(t, dt, hold) {
      tt += dt;
      const on = tt < 1.1 || hold;
      s.visible = on;
      if (!on) return;
      const k1 = backOut(clamp(tt / 0.25));
      s.scale.set(0.5 * k1, 0.5 * k1, 1);
      s.position.y = y + 0.06 * Math.sin(t * 6);
      m.opacity = hold ? 1 : 1 - sstep(0.8, 1.1, tt);
    },
  };
}

// ---------- sentry: a floating eye-drone with a vision cone ----------
const SENTRY_Y = 1.75;
function buildSentry() {
  const k = owner();
  const flash = { value: new THREE.Color(0, 0, 0) };
  const G = {
    shell: geo('sentry.shell', () => new THREE.SphereGeometry(0.4, 40, 28)),
    lidTop: geo('sentry.lidTop', () => new THREE.SphereGeometry(0.418, 40, 10, Math.PI / 2 - 1.3, 2.6, 0.16, 1.0)),
    lidBot: geo('sentry.lidBot', () => new THREE.SphereGeometry(0.418, 40, 10, Math.PI / 2 - 1.3, 2.6, Math.PI - 1.16, 1.0)),
    eyeRing: geo('sentry.eyeRing', () => new THREE.TorusGeometry(0.19, 0.034, 10, 44)),
    lens: geo('sentry.lens', () => new THREE.SphereGeometry(0.165, 32, 20)),
    pupil: geo('sentry.pupil', () => new THREE.CircleGeometry(0.075, 28)),
    fins: geo('sentry.fins', () => merged([
      [new THREE.RoundedBoxGeometry(0.07, 0.34, 0.36, 2, 0.03), [0.42, 0.02, -0.04], [0, 0, -0.12]],
      [new THREE.RoundedBoxGeometry(0.07, 0.34, 0.36, 2, 0.03), [-0.42, 0.02, -0.04], [0, 0, 0.12]],
      [new THREE.CylinderGeometry(0.012, 0.016, 0.26, 8), [0, 0.5, -0.05]],
      [new THREE.ConeGeometry(0.11, 0.34, 18), [0, -0.5, 0], [Math.PI, 0, 0]],
    ])),
    belt: geo('sentry.belt', () => new THREE.TorusGeometry(0.405, 0.022, 8, 64, Math.PI * 1.3).rotateX(-Math.PI / 2).rotateY(-0.15 * Math.PI)),
    tip: geo('sentry.tip', () => new THREE.SphereGeometry(0.042, 12, 8)),
    cone: geo('sentry.cone', () => new THREE.ConeGeometry(1, 1, 48, 1, true).translate(0, -0.5, 0).rotateX(-Math.PI / 2)),
  };
  const M = {
    shell: k.own(rimStd({ color: '#30365a', roughness: 0.3, metalness: 0.72, envMap: TX.env(), envMapIntensity: 0.8 }, '#2ee6c8', 0.5, 2.2, flash)),
    lid: k.own(rimStd({ color: '#4a5380', roughness: 0.28, metalness: 0.78, envMap: TX.env(), envMapIntensity: 0.9 }, '#2ee6c8', 0.35, 2.4, flash)),
    lens: k.own(unlit('#2ee6c8', 2.2)),
    trim: k.own(unlit('#2ee6c8', 1.5)),
    halo: k.own(spriteMat('#2ee6c8', 1.0)),
    ground: k.own(additive('#2ee6c8', 0.5, TX.glow(), { opacity: 0.5 })),
    cone: k.own(fxMaterial(FS_CONE, { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uTime: { value: 0 } }, { side: THREE.DoubleSide })),
  };
  const root = new THREE.Group();
  root.name = 'enemy:sentry';
  const ground = part(root, unitPlane(), M.ground, [0, 0.03, 0], null, [1.3, 1, 1.3]);
  const drone = grp(root, 0, SENTRY_Y, 0);
  const tilt = grp(drone);
  const head = grp(tilt);
  head.rotation.order = 'YXZ';
  part(head, G.shell, M.shell, null, null, null, BOTH);
  part(head, G.fins, M.lid, null, null, null, CAST);
  part(head, G.belt, M.trim);
  part(head, G.eyeRing, M.lid, [0, 0, 0.33]);
  part(head, G.lens, M.lens, [0, 0, 0.33], null, [1, 1, 0.5]);
  const pupil = part(head, G.pupil, SM.black(), [0, 0, 0.4145]);
  const lidTop = grp(head);
  const lidBot = grp(head);
  part(lidTop, G.lidTop, M.lid, null, null, null, CAST);
  part(lidBot, G.lidBot, M.lid, null, null, null, CAST);
  part(head, G.tip, M.trim, [0, 0.64, -0.05]);
  part(head, G.tip, M.trim, [0, -0.69, 0]);
  const halo = sprite(head, M.halo, [0, 0, 0.45], 0.7);
  const thr = sprite(head, M.halo, [0, -0.72, 0], 0.5);
  const aimG = grp(drone);
  aimG.rotation.order = 'YXZ';
  const cone = part(aimG, G.cone, M.cone, [0, 0, 0.4]);
  cone.renderOrder = 3;
  const eye = grp(head, 0, 0, 0.36);
  const muzzle = grp(head, 0, 0, 0.5);
  const sparks = makeSparks(k, drone, 18, '#bfefff', 0.11);
  const arcs = makeArcs(k, drone, '#9be7ff');
  const mark = makeMark(k, drone, 0.85);
  const e = newFoe();
  const ph0 = e.rnd() * TAU;
  let droop = 0;
  let dead = 0;
  let lid = 0.4;
  let coneOp = 0;
  let blinkT = 9;
  let blinkNext = 2;

  function update(t, dt, s) {
    s = s || ENEMY_DEFAULT;
    dt = safeDt(dt);
    foeStep(e, s, dt, root);
    const st = e.state;
    if (st === 'alert' && e.stT === 0) mark.trigger();
    const stun = st === 'stunned';
    droop = approach(droop, stun ? 1 : 0, 5, dt);
    dead = approach(dead, st === 'dead' ? 1 : 0, 2.6, dt);
    const fallK = easeInOut(dead);
    drone.position.y = lerp(SENTRY_Y + Math.sin(t * 2.1 + ph0) * 0.08 - 0.45 * droop + 0.04 * Math.sin(t * 9) * droop, 0.42, fallK);
    tilt.rotation.x = approach(tilt.rotation.x, clamp(e.velF * 0.07, -0.3, 0.3) + 0.3 * droop + 0.9 * fallK, 6, dt);
    tilt.rotation.z = approach(tilt.rotation.z, clamp(-e.velS * 0.07, -0.3, 0.3) + 0.25 * Math.sin(t * 1.7) * droop + 1.1 * fallK, 6, dt);
    let ty = 0;
    let tp = 0.05;
    if (finiteVec(s.aim) && !stun && st !== 'dead') { const a = aimAngles(root, s.aim, 0, drone.position.y, 0); ty = a.yaw; tp = clamp(a.pitch, -0.8, 0.9); }
    if (stun) { ty = 0.5 * Math.sin(t * 1.3); tp = 0.45; }
    e.yaw = approachAngle(e.yaw, ty, finiteVec(s.aim) ? 10 : 4, dt);
    e.pitch = approach(e.pitch, tp, 6, dt);
    head.rotation.set(e.pitch, e.yaw, 0);
    aimG.rotation.set(e.pitch, e.yaw, 0);
    // vision cone follows fov / range exactly
    const fov = clamp(num(s.fov, 70) * Math.PI / 180, 0.05, 3.0);
    const range = Math.max(0.1, num(s.range, 11));
    const r = Math.tan(fov / 2) * range;
    cone.scale.set(r, r, range);
    coneOp = approach(coneOp, (CONE_OP[st] || 0) * (1 - droop) * (1 - dead), 6, dt);
    cone.visible = coneOp > 0.004;
    const cu = M.cone.uniforms;
    cu.uOpacity.value = coneOp * (st === 'alert' ? 0.75 + 0.25 * Math.sin(t * 22) : 1);
    cu.uColor.value.copy(e.col);
    cu.uTime.value = t;
    // eyelids: sleepy while patrolling, wide on alert, drooping when stunned, shut when dead
    blinkNext -= dt;
    if (blinkNext <= 0) { blinkT = 0; blinkNext = 2.5 + e.rnd() * 3; }
    blinkT += dt;
    const blink = blinkT < 0.16 ? Math.sin(blinkT / 0.16 * Math.PI) : 0;
    const lt = (LID[st] != null ? LID[st] : 0.35) + (st === 'dead' ? 0 : blink * 0.8) + (stun ? 0.12 * Math.sin(t * 5) : 0);
    lid = approach(lid, clamp(lt, -0.1, 1), 12, dt);
    lidTop.rotation.x = 0.52 * lid;
    lidBot.rotation.x = -0.52 * lid;
    // lens, pupil and trims carry the state colour
    const flick = stun ? (Math.sin(t * 40) > 0.2 ? 1 : 0.35) : 1;
    const atk = st === 'attack' ? 0.5 + 0.5 * Math.sin(t * 14) : 0;
    const on = (1 - dead) * flick;
    M.lens.color.copy(e.col).multiplyScalar((2.0 + 1.4 * atk) * on + 0.05);
    M.trim.color.copy(e.col).multiplyScalar(1.5 * on + 0.04);
    M.halo.color.copy(e.col).multiplyScalar((0.8 + 0.8 * atk) * on);
    M.ground.color.copy(e.col).multiplyScalar(0.45 * (1 - dead));
    ground.scale.setScalar(1.2 + 0.1 * Math.sin(t * 2.1 + ph0));
    halo.scale.setScalar(0.55 + 0.35 * atk);
    thr.scale.setScalar(0.45 + 0.1 * Math.sin(t * 17));
    const pd = st === 'alert' ? 0.55 : st === 'attack' ? 0.7 + 0.2 * atk : stun ? 1.25 + 0.15 * Math.sin(t * 7) : 1;
    pupil.scale.setScalar(approach(pupil.scale.x, pd, 10, dt));
    setRimColor(M.shell, e.col, 0.45 * on);
    setRimColor(M.lid, e.col, 0.3 * on);
    hitFlash(e, flash);
    sparks.update(t, Math.max(droop, dead * (1 - sstep(0.6, 1, dead))), 0, 0, 0, 0.35);
    arcs.update(t, droop, 0, 0, 0, 0.43);
    mark.update(t, dt, st === 'alert');
    root.visible = !(st === 'dead' && e.stT > 2.2);
  }
  return {
    root, update, type: 'sentry', anchors: { eye, muzzle }, hover: SENTRY_Y,
    dispose() { k.dispose(); root.removeFromParent(); },
  };
}

// ---------- crawler: a spiky beetle-bot ----------
const LEG_Z = [0.22, 0.0, -0.22];
const CRAWLER_SCALE = 1.25;
const LEG_SEG = 0.22;
function crawlerSpikes() {
  const a = 0.36;
  const b = 0.3;
  const c = 0.46;
  const list = [[0, -0.3, 0.15], [0, -0.1, 0.22], [0, 0.1, 0.22], [0, 0.28, 0.15], [0.2, -0.22, 0.12], [-0.2, -0.22, 0.12],
    [0.23, 0.02, 0.14], [-0.23, 0.02, 0.14], [0.19, 0.24, 0.1], [-0.19, 0.24, 0.1]];
  const parts = [];
  const n = new THREE.Vector3();
  const qq = new THREE.Quaternion();
  const ee = new THREE.Euler();
  for (const [x, z, L] of list) {
    const yy = b * Math.sqrt(Math.max(0, 1 - (x / a) ** 2 - (z / c) ** 2));
    n.set(x / (a * a), yy / (b * b), z / (c * c)).normalize();
    n.lerp(_up, 0.3).normalize();
    n.z -= 0.45;
    n.normalize();
    qq.setFromUnitVectors(_up, n);
    ee.setFromQuaternion(qq);
    parts.push([new THREE.ConeGeometry(0.052, L, 6).translate(0, L / 2 - 0.02, 0), [x, yy, z], [ee.x, ee.y, ee.z]]);
  }
  return merged(parts);
}
function buildCrawler() {
  const k = owner();
  const flash = { value: new THREE.Color(0, 0, 0) };
  const G = {
    shell: geo('crawler.shell', () => new THREE.SphereGeometry(1, 36, 14, 0, TAU, 0, Math.PI / 2)),
    belly: geo('crawler.belly', () => new THREE.SphereGeometry(1, 28, 12)),
    spikes: geo('crawler.spikes', crawlerSpikes),
    head: geo('crawler.head', () => new THREE.SphereGeometry(1, 24, 16)),
    eye: geo('crawler.eye', () => new THREE.SphereGeometry(0.046, 14, 10)),
    mand: geo('crawler.mand', () => new THREE.ConeGeometry(0.03, 0.17, 8).rotateX(Math.PI / 2).translate(0, 0, 0.08)),
    leg: geo('crawler.leg', () => new THREE.CapsuleGeometry(0.03, LEG_SEG - 0.06, 3, 8)),
    seam: geo('crawler.seam', () => new THREE.TorusGeometry(1, 0.02, 6, 48, Math.PI).rotateY(Math.PI / 2)),
  };
  const M = {
    shell: k.own(rimStd({ color: '#6a2a86', roughness: 0.26, metalness: 0.45, envMap: TX.env(), envMapIntensity: 0.9 }, '#ff8a3d', 0.45, 2.2, flash)),
    under: k.own(rimStd({ color: '#2c2f45', roughness: 0.42, metalness: 0.6, envMap: TX.env(), envMapIntensity: 0.6 }, '#ff8a3d', 0.25, 2.4, flash)),
    spike: k.own(rimStd({ color: '#2a0d22', emissive: '#2ee6c8', emissiveMap: TX.tipGlow(), emissiveIntensity: 1.6, roughness: 0.35, metalness: 0.4, flatShading: true }, '#ffffff', 0.2, 2.0, flash)),
    eye: k.own(unlit('#2ee6c8', 2.3)),
    trim: k.own(unlit('#2ee6c8', 1.2)),
    ground: k.own(additive('#2ee6c8', 0.4, TX.glow(), { opacity: 0.5 })),
  };
  const root = new THREE.Group();
  root.name = 'enemy:crawler';
  const ground = part(root, unitPlane(), M.ground, [0, 0.025, 0], null, [1.7, 1, 2.0]);
  const rig = grp(root);
  rig.scale.setScalar(CRAWLER_SCALE);
  const body = grp(rig, 0, 0.3, 0);
  part(body, G.shell, M.shell, null, null, [0.36, 0.3, 0.46], BOTH);
  part(body, G.seam, M.trim, [0, 0.005, 0], null, [0.365, 0.305, 0.465]);
  part(body, G.belly, M.under, [0, 0.0, 0], null, [0.34, 0.1, 0.44], CAST);
  part(body, G.spikes, M.spike, null, null, null, CAST);
  const headG = grp(body, 0, 0.0, 0.4);
  part(headG, G.head, M.under, null, null, [0.17, 0.13, 0.15], CAST);
  for (const side of [1, -1]) {
    part(headG, G.eye, M.eye, [side * 0.075, 0.05, 0.125]);
    part(headG, G.eye, M.eye, [side * 0.13, 0.03, 0.07], null, 0.55);
  }
  const mands = [];
  for (const side of [1, -1]) {
    const m = grp(headG, side * 0.07, -0.05, 0.1);
    part(m, G.mand, M.under);
    mands.push(m);
  }
  const legs = k.own(new THREE.InstancedMesh(G.leg, M.under, 12));
  legs.frustumCulled = false;
  legs.castShadow = true;
  rig.add(legs);
  const eye = grp(headG, 0, 0.05, 0.13);
  const muzzle = grp(headG, 0, -0.03, 0.22);
  const sparks = makeSparks(k, body, 14, '#bfefff', 0.09);
  const arcs = makeArcs(k, body, '#9be7ff');
  const mark = makeMark(k, root, 1.05);
  const e = newFoe();
  const hip = new THREE.Vector3();
  const foot = new THREE.Vector3();
  const knee = new THREE.Vector3();
  const sc = new THREE.Vector3(1, 1, 1);
  let gait = 0;
  let amp = 0;
  let flipK = 0;
  let stunK = 0;
  let rear = 0;
  function seg(i, a, b) {
    _v2.subVectors(b, a);
    const len = _v2.length();
    _v2.multiplyScalar(1 / Math.max(1e-4, len));
    _q.setFromUnitVectors(_up, _v2);
    _v3.addVectors(a, b).multiplyScalar(0.5);
    sc.set(1, len / LEG_SEG, 1);
    _m4.compose(_v3, _q, sc);
    legs.setMatrixAt(i, _m4);
  }

  function update(t, dt, s) {
    s = s || ENEMY_DEFAULT;
    dt = safeDt(dt);
    foeStep(e, s, dt, root);
    const st = e.state;
    if (st === 'alert' && e.stT === 0) mark.trigger();
    const moving = st === 'patrol' || st === 'chase' || st === 'alert' || st === 'attack';
    const spd = Math.max(e.speed, st === 'chase' ? 2.5 : 0);
    amp = approach(amp, moving ? clamp(spd / 2.2, 0.25, 1) : 0, 8, dt);
    gait = (gait + dt * (0.4 + spd / 0.5) * TAU * (amp > 0.05 ? 1 : 0)) % TAU;
    stunK = approach(stunK, st === 'stunned' ? 1 : 0, 8, dt);
    rear = approach(rear, st === 'attack' ? 1 : 0, 9, dt);
    flipK = approach(flipK, st === 'dead' ? 1 : 0, 7, dt);
    const fk = easeInOut(flipK);
    const hop = st === 'alert' ? Math.max(0, Math.sin(Math.min(1, e.stT / 0.3) * Math.PI)) * 0.18 : 0;
    // body bob with the gait, rears up to attack, sinks when stunned, flips when dead
    const by = 0.3 + 0.025 * Math.sin(gait * 2) * amp + hop - 0.1 * stunK + 0.01 * Math.sin(t * 3);
    body.position.y = by;
    body.rotation.set(-0.38 * rear + 0.03 * Math.sin(gait * 2) * amp, 0.06 * Math.sin(gait) * amp, (stunK ? 0.08 * Math.sin(t * 23) * stunK : 0));
    rig.rotation.z = Math.PI * fk;
    rig.position.y = (0.62 * fk + Math.sin(Math.PI * fk) * 0.45) * CRAWLER_SCALE;
    headG.rotation.x = -0.2 * rear;
    const snap = st === 'attack' ? 0.25 + 0.3 * Math.abs(Math.sin(t * 16)) : 0.12 + 0.05 * Math.sin(t * 3);
    mands[0].rotation.y = -snap; mands[1].rotation.y = snap;
    // legs: tripod gait (L0 R1 L2 against R0 L1 R2), each leg = two segments hip-knee-foot
    for (let i = 0; i < 6; i++) {
      const side = i < 3 ? 1 : -1;
      const j = i % 3;
      const groupA = (side === 1) === (j !== 1);
      const ph = gait + (groupA ? 0 : Math.PI);
      const sw = Math.sin(ph) * amp;
      const lift = Math.max(0, Math.cos(ph)) * amp;
      const tw = stunK * 0.05 * Math.sin(t * 31 + i * 1.7);
      hip.set(side * 0.24, by - 0.03, LEG_Z[j] * 0.9);
      foot.set(side * (0.56 + 0.12 * stunK), lift * 0.1 + tw, LEG_Z[j] * 1.4 + sw * 0.13);
      if (j === 0 && rear > 0.01) { foot.x -= side * 0.18 * rear; foot.y += 0.32 * rear + 0.05 * Math.sin(t * 16) * rear; foot.z += 0.28 * rear; }
      if (fk > 0.01) { // curled legs wiggling in the air
        foot.lerp(_v1.set(side * 0.38, by + 0.25 + 0.05 * Math.sin(t * 20 + i), LEG_Z[j] * 1.1), fk);
      }
      knee.addVectors(hip, foot).multiplyScalar(0.5);
      knee.x += side * 0.06;
      knee.y += 0.2 - 0.08 * stunK;
      seg(i * 2, hip, knee);
      seg(i * 2 + 1, knee, foot);
    }
    legs.instanceMatrix.needsUpdate = true;
    const stun = st === 'stunned';
    const flick = stun ? (Math.sin(t * 37) > 0 ? 1 : 0.3) : 1;
    const on = (1 - flipK) * flick;
    M.eye.color.copy(e.col).multiplyScalar(2.3 * on + 0.05);
    M.trim.color.copy(e.col).multiplyScalar(1.2 * on);
    M.spike.emissive.copy(e.col);
    M.spike.emissiveIntensity = (1.3 + 0.5 * rear) * on;
    M.ground.color.copy(e.col).multiplyScalar(0.4 * (1 - flipK));
    ground.visible = flipK < 0.98;
    setRimColor(M.shell, e.col, 0.35 * on);
    hitFlash(e, flash);
    sparks.update(t, stunK, 0, 0.15, 0, 0.3);
    arcs.update(t, stunK, 0, 0.1, 0, 0.4);
    mark.update(t, dt, false);
    // vanish a moment after dying
    const gone = st === 'dead' ? sstep(1.0, 1.5, e.stT) : 0;
    rig.scale.setScalar(Math.max(0.001, CRAWLER_SCALE * (1 - gone)));
    root.visible = gone < 0.999;
  }
  return {
    root, update, type: 'crawler', anchors: { eye, muzzle },
    dispose() { k.dispose(); root.removeFromParent(); },
  };
}

// ---------- turret: a rotating base and a barrel that tracks its aim ----------
function buildTurret() {
  const k = owner();
  const flash = { value: new THREE.Color(0, 0, 0) };
  const rb = (w, h, dd, r, sgm = 2) => new THREE.RoundedBoxGeometry(w, h, dd, sgm, r);
  const G = {
    base: geo('turret.base', () => merged([
      [new THREE.CylinderGeometry(0.56, 0.7, 0.34, 8), [0, 0.17, 0], [0, Math.PI / 8, 0]],
      [new THREE.CylinderGeometry(0.2, 0.27, 0.56, 16), [0, 0.6, 0]],
      [new THREE.CylinderGeometry(0.34, 0.34, 0.08, 20), [0, 0.86, 0]],
    ])),
    trim: geo('turret.trim', () => new THREE.CylinderGeometry(0.585, 0.6, 0.05, 8, 1, true).rotateY(Math.PI / 8)),
    hazard: geo('turret.hazard', () => new THREE.CylinderGeometry(0.66, 0.7, 0.12, 8, 1, true).rotateY(Math.PI / 8)),
    housing: geo('turret.housing', () => merged([
      [rb(0.74, 0.44, 0.7, 0.13, 3), [0, 0.22, -0.05]],
      [rb(0.12, 0.36, 0.56, 0.05), [0.43, 0.22, -0.04]],
      [rb(0.12, 0.36, 0.56, 0.05), [-0.43, 0.22, -0.04]],
      [rb(0.3, 0.1, 0.3, 0.04), [0, 0.47, -0.1]],
    ])),
    barrel: geo('turret.barrel', () => merged([
      [new THREE.CylinderGeometry(0.075, 0.1, 0.78, 20), [0, 0, 0.39], [Math.PI / 2, 0, 0]],
      [new THREE.TorusGeometry(0.1, 0.034, 10, 24), [0, 0, 0.78]],
    ])),
    ring: geo('turret.ring', () => new THREE.TorusGeometry(0.112, 0.024, 8, 24)),
    eye: geo('turret.eye', () => new THREE.SphereGeometry(0.075, 18, 12)),
    core: geo('turret.core', () => new THREE.SphereGeometry(0.068, 16, 12)),
  };
  const M = {
    dark: k.own(rimStd({ color: '#2a2f45', roughness: 0.38, metalness: 0.72, envMap: TX.env(), envMapIntensity: 0.8 }, '#2ee6c8', 0.3, 2.4, flash)),
    metal: k.own(rimStd({ color: '#8790a6', roughness: 0.32, metalness: 0.85, envMap: TX.env(), envMapIntensity: 1 }, '#2ee6c8', 0.2, 2.6, flash)),
    hazard: shared('hazard', () => new THREE.MeshStandardMaterial({ map: TX.hazard(), roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide })),
    trim: k.own(unlit('#2ee6c8', 1.5, { side: THREE.DoubleSide })),
    eye: k.own(unlit('#2ee6c8', 2.2)),
    rings: [0, 1, 2].map(() => k.own(unlit('#ff2d55', 0.2))),
    core: k.own(unlit('#ff6b8a', 0.5)),
    halo: k.own(spriteMat('#ff2d55', 1.0)),
  };
  const root = new THREE.Group();
  root.name = 'enemy:turret';
  part(root, G.base, M.dark, null, null, null, BOTH);
  part(root, G.hazard, M.hazard, [0, 0.12, 0]);
  part(root, G.trim, M.trim, [0, 0.31, 0]);
  const yawG = grp(root, 0, 0.88, 0);
  const shake = grp(yawG);
  part(shake, G.housing, M.dark, null, null, null, BOTH);
  part(shake, G.eye, M.eye, [0, 0.36, 0.28]);
  const pitchG = grp(shake, 0, 0.2, 0.22);
  const recoil = grp(pitchG);
  part(recoil, G.barrel, M.metal, null, null, null, CAST);
  const rings = [0.2, 0.38, 0.56].map((z, i) => part(recoil, G.ring, M.rings[i], [0, 0, z]));
  part(recoil, G.core, M.core, [0, 0, 0.78]);
  const halo = sprite(recoil, M.halo, [0, 0, 0.82], 0.3);
  const eye = grp(shake, 0, 0.36, 0.3);
  const muzzle = grp(recoil, 0, 0, 0.84);
  const sparks = makeSparks(k, shake, 14, '#ffd9a0', 0.09);
  const arcs = makeArcs(k, shake, '#9be7ff');
  const e = newFoe();
  const ph0 = e.rnd() * TAU;
  let charge = 0;
  let chargeT = 0;
  let fireT = 9;
  let droop = 0;

  function update(t, dt, s) {
    s = s || ENEMY_DEFAULT;
    dt = safeDt(dt);
    foeStep(e, s, dt, root);
    const st = e.state;
    const dead = st === 'dead' || e.hp <= 0;
    const stun = st === 'stunned';
    // aim: track s.aim, sweep while idle, droop when stunned or destroyed
    let ty = 0.7 * Math.sin(t * 0.55 + ph0);
    let tp = 0.08;
    if (finiteVec(s.aim) && !dead && !stun) { const a = aimAngles(root, s.aim, 0, 1.08, 0); ty = a.yaw; tp = clamp(a.pitch, -0.7, 0.6); }
    droop = approach(droop, dead ? 1 : stun ? 0.6 : 0, 4, dt);
    if (dead || stun) ty = e.yaw;
    e.yaw = approachAngle(e.yaw, ty, finiteVec(s.aim) ? 8 : 2.5, dt);
    e.pitch = approach(e.pitch, lerp(tp, 0.55, droop), 7, dt);
    yawG.rotation.y = e.yaw;
    pitchG.rotation.x = e.pitch;
    // charge-up: s.charge if the world drives it, else a cycle while attacking; fire = flash + recoil
    let target = 0;
    if (Number.isFinite(s.charge)) target = clamp(s.charge);
    else if (st === 'attack' && !dead) {
      chargeT += dt;
      if (chargeT >= 1.1) { chargeT -= 1.1; fireT = 0; }
      target = chargeT / 1.1;
    } else chargeT = 0;
    if (Number.isFinite(s.charge) && charge > 0.9 && target < 0.2) fireT = 0;
    charge = target < charge ? target : approach(charge, target, 20, dt);
    fireT += dt;
    const fire = fireT < 0.14 ? 1 - fireT / 0.14 : 0;
    recoil.position.z = -0.12 * fire;
    for (let i = 0; i < 3; i++) setGlow(M.rings[i], 0.15 + 2.4 * sstep(i * 0.28, i * 0.28 + 0.22, charge) + fire);
    setGlow(M.core, 0.4 + 2.6 * charge * charge + 3 * fire);
    halo.scale.setScalar(0.25 + 0.55 * charge + 0.9 * fire);
    M.halo.color.copy(M.halo.userData.base).multiplyScalar(0.3 + 1.2 * charge + fire);
    const hurt = 1 - e.hp;
    const flick = stun || (hurt > 0.5 && Math.sin(t * 13) * Math.sin(t * 7.3) > 0.6) ? (Math.sin(t * 40) > 0 ? 1 : 0.3) : 1;
    const on = (dead ? 0.05 : 1) * flick;
    M.eye.color.copy(e.col).multiplyScalar(2.2 * on);
    M.trim.color.copy(e.col).multiplyScalar(1.5 * on);
    setRimColor(M.dark, e.col, 0.3 * on);
    hitFlash(e, flash);
    const hit = e.hitT < 0.3 ? (1 - e.hitT / 0.3) : 0;
    shake.position.set(0.04 * Math.sin(t * 70) * (hit + 0.3 * (stun ? 1 : 0)), 0, 0);
    shake.rotation.z = 0.25 * droop * (dead ? 1 : 0.4) + 0.05 * Math.sin(t * 50) * hit;
    sparks.update(t, Math.max(hit, stun ? 0.8 : 0, hurt > 0.3 ? (Math.sin(t * 2.3) > 0.4 ? hurt : 0) : 0, dead ? 0.5 : 0), 0, 0.3, 0, 0.3, 0.8);
    arcs.update(t, stun ? 1 : 0, 0, 0.22, 0, 0.45);
  }
  return {
    root, update, type: 'turret', anchors: { eye, muzzle },
    dispose() { k.dispose(); root.removeFromParent(); },
  };
}

// ---------- warden: the boss — a floating core in rotating shield plates ----------
const WARDEN_Y = 3.4;
const PHASE_HEX = ['#d946ef', '#ff7a1a', '#ff2d55'];
const PLATE_SPEC = [[-0.5, 0], [-0.5, Math.PI / 2], [-0.5, Math.PI], [-0.5, Math.PI * 1.5], [0.5, Math.PI / 4], [0.5, Math.PI * 0.75], [0.5, Math.PI * 1.25], [0.5, Math.PI * 1.75]];
const PLATES_BY_PHASE = [8, 6, 4];
const ORBIT_SPEED = [0.35, 0.8, 1.4];
function buildWarden() {
  const k = owner();
  const flash = { value: new THREE.Color(0, 0, 0) };
  const G = {
    core: geo('warden.core', () => new THREE.SphereGeometry(0.82, 48, 32)),
    shell: geo('warden.shell', () => new THREE.SphereGeometry(1.06, 48, 32)),
    iris: geo('warden.iris', () => new THREE.TorusGeometry(0.33, 0.055, 10, 48)),
    pupil: geo('warden.pupil', () => new THREE.SphereGeometry(0.24, 24, 16)),
    gyro: geo('warden.gyro', () => new THREE.TorusGeometry(1.32, 0.035, 8, 96)),
    plate: geo('warden.plate', () => new THREE.SphereGeometry(1.75, 12, 8, Math.PI / 2 - 0.42, 0.84, Math.PI / 2 - 0.4, 0.8).translate(0, 0, -1.75)),
    crown: geo('warden.crown', () => {
      const parts = [];
      for (let i = 0; i < 6; i++) {
        const a = i * TAU / 6;
        parts.push([new THREE.ConeGeometry(0.11, 0.7, 6).translate(0, 0.35, 0), [Math.sin(a) * 0.6, 0.95, Math.cos(a) * 0.6], [Math.cos(a) * 0.5, 0, -Math.sin(a) * 0.5]]);
      }
      parts.push([new THREE.TorusGeometry(0.62, 0.06, 8, 36), [0, 0.92, 0], [Math.PI / 2, 0, 0]]);
      return merged(parts);
    }),
    tendril: geo('warden.tendril', () => new THREE.CylinderGeometry(0.09, 0.02, 1.3, 10).translate(0, -0.65, 0)),
    tip: geo('warden.tip', () => new THREE.OctahedronGeometry(0.1, 0)),
  };
  const M = {
    core: k.own(fxMaterial(FS_PLASMA, { uColor: { value: new THREE.Color() }, uHot: { value: new THREE.Color(1, 0.9, 0.95) }, uTime: { value: 0 }, uPower: { value: 1.6 } }, { transparent: false, blending: THREE.NormalBlending, depthWrite: true })),
    shell: k.own(rimStd({ color: '#1a1030', roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.3, depthWrite: false, envMap: TX.env(), envMapIntensity: 1.0 }, '#d946ef', 0.8, 2.6, flash)),
    plate: k.own(rimStd({ color: '#2b2545', roughness: 0.32, metalness: 0.8, emissive: '#d946ef', emissiveMap: TX.shield(), emissiveIntensity: 1.4, side: THREE.DoubleSide, envMap: TX.env(), envMapIntensity: 0.9 }, '#d946ef', 0.5, 2.2, flash)),
    crown: k.own(rimStd({ color: '#2b2545', roughness: 0.3, metalness: 0.8, emissive: '#d946ef', emissiveIntensity: 0.25, envMap: TX.env(), envMapIntensity: 0.9 }, '#d946ef', 0.6, 2.0, flash)),
    glow: k.own(unlit('#d946ef', 1.8)),
    iris: k.own(unlit('#fff2fb', 2.4)),
    pupil: SM.black(),
    halo: k.own(spriteMat('#d946ef', 1.0)),
    ground: k.own(additive('#d946ef', 0.9, TX.ring(), { opacity: 0.8 })),
  };
  const root = new THREE.Group();
  root.name = 'enemy:warden';
  const ground = part(root, unitPlane(), M.ground, [0, 0.04, 0], null, [6.5, 1, 6.5]);
  const float = grp(root, 0, WARDEN_Y, 0);
  float.scale.setScalar(1.3);
  const halo = sprite(float, M.halo, [0, 0, 0], 4.2);
  const coreG = grp(float);
  const core = part(coreG, G.core, M.core, null, null, null, CAST);
  const shell = part(coreG, G.shell, M.shell);
  shell.renderOrder = 1;
  const eyeG = grp(coreG);
  eyeG.rotation.order = 'YXZ';
  part(eyeG, G.iris, M.iris, [0, 0, 0.8]);
  const pupil = part(eyeG, G.pupil, M.pupil, [0, 0, 0.74], null, [0.32, 1, 0.3]);
  const gyros = [part(float, G.gyro, M.glow), part(float, G.gyro, M.glow)];
  const crown = part(float, G.crown, M.crown, null, null, null, CAST);
  const orbit = grp(float);
  const plates = PLATE_SPEC.map(([tiltX, yaw]) => {
    const piv = grp(orbit);
    piv.rotation.set(0, yaw, 0);
    const tiltG = grp(piv);
    tiltG.rotation.x = tiltX;
    const holder = grp(tiltG, 0, 0, 1.75);
    const mesh = part(holder, G.plate, M.plate, null, null, null, CAST);
    return { piv, tiltG, holder, mesh, fall: 0, vy: 0, y: 0, spin: 0 };
  });
  const tendrils = [0, 1, 2].map((i) => {
    const a = i * TAU / 3 + 0.4;
    const g = grp(float, Math.sin(a) * 0.45, -0.85, Math.cos(a) * 0.45);
    part(g, G.tendril, M.crown);
    part(g, G.tip, M.glow, [0, -1.35, 0]);
    return g;
  });
  const eye = grp(eyeG, 0, 0, 0.85);
  const muzzle = grp(eyeG, 0, 0, 1.2);
  const sparks = makeSparks(k, float, 26, '#ffd0f0', 0.16);
  const arcs = makeArcs(k, float, '#ffc8ff');
  const e = newFoe();
  const phaseCol = new THREE.Color(PHASE_HEX[0]);
  let open = 0;
  let spinA = 0;
  let pulse = 0;
  let deadK = 0;
  let lastPhase = 0;
  let phaseT = 9;

  function update(t, dt, s) {
    s = s || ENEMY_DEFAULT;
    dt = safeDt(dt);
    foeStep(e, s, dt, root);
    const st = e.state;
    const pi = clamp(Math.floor(num(s.phase, 1) || 1) - 1, 0, 2);
    if (pi !== lastPhase) { lastPhase = pi; phaseT = 0; }
    phaseT += dt;
    phaseCol.lerp(col(PHASE_HEX[pi]), 1 - Math.exp(-4 * dt));
    const stun = st === 'stunned';
    const dead = st === 'dead';
    deadK = approach(deadK, dead ? 1 : 0, 1.6, dt);
    const shield = Number.isFinite(s.shield) ? clamp(s.shield) : stun || dead ? 0 : 1;
    open = approach(open, 1 - shield, 5, dt);
    const attack = st === 'attack' ? 1 : 0;
    const charge = Number.isFinite(s.charge) ? clamp(s.charge) : attack * (0.5 + 0.5 * Math.sin(t * (4 + pi * 2)));
    // float: bob, droop when stunned, sink when destroyed
    float.position.y = WARDEN_Y + 0.18 * Math.sin(t * 1.3) - 0.7 * open * (stun ? 1 : 0) - 2.2 * easeInOut(deadK);
    float.rotation.z = 0.06 * Math.sin(t * 0.9) + 0.12 * (stun ? Math.sin(t * 2.2) : 0);
    // eye tracks the aim point
    let ty = 0.4 * Math.sin(t * 0.5);
    let tp = 0.15;
    if (finiteVec(s.aim) && !dead) { const a = aimAngles(root, s.aim, 0, float.position.y, 0); ty = a.yaw; tp = clamp(a.pitch, -0.9, 0.9); }
    e.yaw = approachAngle(e.yaw, ty, 5, dt);
    e.pitch = approach(e.pitch, tp, 5, dt);
    eyeG.rotation.set(e.pitch, e.yaw, 0);
    pupil.scale.set(0.32 * (1 - 0.4 * charge), 1 - 0.2 * open, 0.3);
    // shields orbit faster each phase; fewer of them survive; they fly out when the core is exposed
    const speed = ORBIT_SPEED[pi] * (1 + attack * 0.8) * (1 - deadK);
    spinA += dt * speed;
    orbit.rotation.y = spinA;
    const count = PLATES_BY_PHASE[pi];
    for (let i = 0; i < plates.length; i++) {
      const p = plates[i];
      const alive = i < count;
      p.mesh.visible = alive && !(dead && p.y < -6);
      p.holder.position.z = 1.75 + open * 1.1 + 0.05 * Math.sin(t * 3 + i);
      p.holder.rotation.x = open * 0.7 * (i < 4 ? -1 : 1);
      if (dead) { // plates drop and tumble
        p.vy -= 9.8 * dt;
        p.y = Math.max(-(float.position.y - 0.5) / float.scale.y, p.y + p.vy * dt);
        p.spin += dt * 2;
        p.piv.position.y = p.y;
        p.holder.rotation.z = p.spin * (i % 2 ? 1 : -1);
      } else { p.vy = 0; p.y = 0; p.spin = 0; p.piv.position.y = 0; p.holder.rotation.z = 0; }
    }
    gyros[0].rotation.set(t * 0.9 * (1 + pi * 0.5), 0.6, 0);
    gyros[1].rotation.set(1.2, t * 0.7 * (1 + pi * 0.5), 0.4);
    crown.rotation.y = -t * (0.3 + pi * 0.4);
    for (let i = 0; i < 3; i++) {
      tendrils[i].rotation.set(0.25 * Math.sin(t * 1.4 + i * 2), 0, 0.25 * Math.cos(t * 1.1 + i * 1.3));
    }
    // colour and light: the phase colour, brighter while charging, a flare on phase change, flicker when hurt
    const hurtFlick = e.hp < 0.35 && Math.sin(t * 17) * Math.sin(t * 5.3) > 0.5 ? 0.5 : 1;
    const pf = phaseT < 0.8 ? 1 - phaseT / 0.8 : 0;
    pulse = 1 + 0.25 * Math.sin(t * (2 + pi * 1.5)) + 0.8 * charge + 1.2 * pf;
    const life = 1 - deadK;
    M.core.uniforms.uColor.value.copy(phaseCol);
    M.core.uniforms.uTime.value = t * (1 + pi * 0.5);
    M.core.uniforms.uPower.value = (0.75 + 0.3 * pulse) * hurtFlick * (0.1 + 0.9 * life) + 0.8 * (stun ? 0.5 + 0.5 * Math.sin(t * 20) : 0);
    coreG.scale.setScalar(Math.max(0.001, (1 + 0.04 * Math.sin(t * 3) + 0.08 * charge) * (1 - sstep(0.75, 1, deadK))));
    M.glow.color.copy(phaseCol).multiplyScalar(1.8 * pulse * life);
    M.halo.color.copy(phaseCol).multiplyScalar(0.55 * pulse * life);
    halo.scale.setScalar(4 + 0.6 * charge + 2 * pf);
    M.plate.emissive.copy(phaseCol);
    M.plate.emissiveIntensity = (1.1 + 0.6 * charge) * life;
    M.crown.emissive.copy(phaseCol);
    M.crown.emissiveIntensity = (0.25 + 0.8 * charge) * life;
    M.ground.color.copy(phaseCol).multiplyScalar(0.8 * (0.7 + 0.3 * Math.sin(t * 2)) * life);
    ground.rotation.y = -t * 0.2;
    setRimColor(M.shell, phaseCol, 0.8 * life);
    setRimColor(M.plate, phaseCol, 0.45 * life);
    setRimColor(M.crown, phaseCol, 0.5 * life);
    M.iris.color.setRGB(2.4, 2.1, 2.3).multiplyScalar((0.6 + 0.4 * pulse) * life);
    hitFlash(e, flash);
    sparks.update(t, Math.max(stun ? 1 : 0, deadK * (1 - sstep(0.7, 1, deadK)), e.hitT < 0.3 ? 1 : 0), 0, 0, 0, 1.0, 1.4);
    arcs.update(t, stun ? 1 : e.hp < 0.35 ? 0.5 : 0, 0, 0, 0, 1.12);
    root.visible = !(dead && e.stT > 4);
  }
  return {
    root, update, type: 'warden', anchors: { eye, muzzle, core: coreG }, hover: WARDEN_Y,
    dispose() { k.dispose(); root.removeFromParent(); },
  };
}

export function makeEnemy(type) {
  if (type === 'crawler') return buildCrawler();
  if (type === 'turret') return buildTurret();
  if (type === 'warden') return buildWarden();
  return buildSentry();
}

// ======================================================================================
// Props
// ======================================================================================
const PROP_DEFAULT = {};
const sizeOf = (o, def) => (o && o.size && o.size.length === 3 ? [0, 1, 2].map((i) => Math.max(0.05, num(o.size[i], def[i]))) : def);
function prop(name) {
  const root = new THREE.Group();
  root.name = `prop:${name}`;
  return root;
}
// Sized props sit on their bottom face by default; opts.origin === 'center' puts root at the box centre instead.
function recenter(root, opts, sy) {
  if (!opts || opts.origin !== 'center') return;
  const g = new THREE.Group();
  g.position.y = -sy / 2;
  while (root.children.length) g.add(root.children[0]);
  root.add(g);
}
function done(root, k, update, extra) {
  return { root, update, ...extra, dispose() { k.dispose(); root.removeFromParent(); } };
}

// shard: a spinning glowing gem (hovers 0.8 m above its spot)
function buildShard() {
  const k = owner();
  const root = prop('shard');
  const G = {
    gem: geo('shard.gem', () => new THREE.OctahedronGeometry(0.2, 0).scale(1, 1.55, 1)),
    ring: geo('shard.ring', () => new THREE.TorusGeometry(0.34, 0.012, 6, 48)),
    spark: geo('shard.spark', () => merged([[new THREE.OctahedronGeometry(0.045, 0), [0.36, 0, 0]], [new THREE.OctahedronGeometry(0.045, 0), [-0.36, 0, 0]]])),
  };
  const M = {
    gem: shared('shard.gem', () => rimStd({ color: '#a6fbff', emissive: '#18d0ff', emissiveIntensity: 0.85, roughness: 0.1, metalness: 0.3, flatShading: true, envMap: TX.env(), envMapIntensity: 1.2 }, '#ff6ff0', 1.3, 1.5)),
    glow: shared('shard.glow', () => unlit('#9ff6ff', 2.2)),
    ring: shared('shard.ring', () => additive('#5ee7ff', 1.4, null)),
    halo: shared('shard.halo', () => spriteMat('#4fd8ff', 1.0)),
    ground: shared('shard.ground', () => additive('#4fd8ff', 0.5, TX.glow(), { opacity: 0.6 })),
  };
  const ground = part(root, unitPlane(), M.ground, [0, 0.02, 0], null, [0.9, 1, 0.9]);
  const g = grp(root, 0, 0.8, 0);
  const gem = part(g, G.gem, M.gem, null, null, null, CAST);
  const halo = sprite(g, M.halo, [0, 0, 0], 1.0);
  const ring = part(g, G.ring, M.ring, null, [Math.PI / 2 - 0.3, 0, 0]);
  const sparks = part(g, G.spark, M.glow);
  const ph = (seeds++ * 0.618) % 1 * TAU;
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    const tk = clamp(num(s.taken));
    root.visible = tk < 0.999;
    if (!root.visible) return;
    const sc = (1 + 0.55 * Math.sin(Math.PI * tk)) * (1 - sstep(0.55, 1, tk));
    g.position.y = 0.8 + 0.08 * Math.sin(t * 2.2 + ph) + easeOut(tk) * 1.1;
    gem.rotation.y = t * 1.8 + ph + tk * 12;
    gem.rotation.z = 0.12 * Math.sin(t * 1.3 + ph);
    g.scale.setScalar(Math.max(0.001, sc));
    ring.rotation.z = t * 0.8;
    ring.scale.setScalar(1 + 0.08 * Math.sin(t * 3 + ph) + tk * 1.5);
    halo.scale.setScalar(0.95 + 0.15 * Math.sin(t * 4 + ph) + tk * 2);
    sparks.rotation.set(0.25 * Math.sin(t * 1.7 + ph), t * 2.6 + ph, 0.2 * Math.cos(t * 1.3));
    ground.scale.setScalar(0.9 * (1 - tk));
  }
  return done(root, k, update);
}

// checkpoint: a beacon that lights up (and sends a ring out) when activated
function buildCheckpoint() {
  const k = owner();
  const root = prop('checkpoint');
  const G = {
    base: geo('cp.base', () => merged([
      [new THREE.CylinderGeometry(0.55, 0.68, 0.18, 8), [0, 0.09, 0], [0, Math.PI / 8, 0]],
      [new THREE.CylinderGeometry(0.4, 0.48, 0.07, 8), [0, 0.215, 0], [0, Math.PI / 8, 0]],
      [new THREE.CylinderGeometry(0.05, 0.075, 1.5, 12), [0, 0.95, 0]],
      [new THREE.CylinderGeometry(0.12, 0.08, 0.1, 12), [0, 1.65, 0]],
    ])),
    cage: geo('cp.cage', () => merged([
      [new THREE.TorusGeometry(0.21, 0.018, 6, 28), [0, 1.88, 0]],
      [new THREE.TorusGeometry(0.21, 0.018, 6, 28), [0, 1.88, 0], [0, Math.PI / 2, 0]],
    ])),
    ring: geo('cp.ring', () => new THREE.TorusGeometry(0.5, 0.03, 6, 8).rotateX(Math.PI / 2).rotateY(Math.PI / 8)),
    lamp: geo('cp.lamp', () => new THREE.SphereGeometry(0.15, 24, 16)),
    holo: geo('cp.holo', () => new THREE.OctahedronGeometry(0.17, 0)),
    beam: geo('cp.beam', () => new THREE.CylinderGeometry(0.16, 0.34, 7, 24, 1, true).translate(0, 3.5, 0)),
    burst: geo('cp.burst', () => new THREE.TorusGeometry(1, 0.035, 6, 64).rotateX(Math.PI / 2)),
  };
  const M = {
    lamp: k.own(unlit('#3dffb5', 1)),
    ring: k.own(unlit('#3dffb5', 1)),
    holo: k.own(additive('#3dffb5', 1, null, { side: THREE.DoubleSide })),
    halo: k.own(spriteMat('#3dffb5', 1)),
    beam: k.own(fxMaterial(FS_COLUMN, { uColor: { value: col('#3dffb5').clone() }, uTime: { value: 0 }, uPower: { value: 0 } }, { side: THREE.DoubleSide })),
    burst: k.own(additive('#3dffb5', 2, null, { opacity: 0 })),
  };
  part(root, G.base, SM.dark(), null, null, null, BOTH);
  part(root, G.cage, SM.metal(), null, null, null, CAST);
  part(root, G.ring, M.ring, [0, 0.255, 0]);
  const lamp = part(root, G.lamp, M.lamp, [0, 1.88, 0]);
  const holo = part(root, G.holo, M.holo, [0, 2.35, 0], null, [1, 1.4, 1]);
  const halo = sprite(root, M.halo, [0, 1.88, 0], 0.9);
  const beam = part(root, G.beam, M.beam, [0, 1.9, 0]);
  const burst = part(root, G.burst, M.burst, [0, 0.3, 0]);
  const off = col('#7a62c8');
  const on = col('#3dffb5');
  const c = new THREE.Color();
  let a = 0;
  let was = false;
  let burstT = 9;
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    dt = safeDt(dt);
    const act = !!s.active;
    if (act && !was) burstT = 0;
    was = act;
    burstT += dt;
    a = approach(a, act ? 1 : 0, 5, dt);
    c.copy(off).lerp(on, a);
    const p = 0.75 + 0.25 * Math.sin(t * (act ? 3 : 1.6));
    M.lamp.color.copy(c).multiplyScalar((0.5 + 2 * a) * p);
    M.ring.color.copy(c).multiplyScalar((0.4 + 1.4 * a) * p);
    M.halo.color.copy(c).multiplyScalar((0.25 + 1.1 * a) * p);
    M.holo.color.copy(c).multiplyScalar(0.3 + 1.2 * a);
    halo.scale.setScalar(0.6 + 0.6 * a);
    holo.rotation.y = t * (0.8 + 2.2 * a);
    holo.position.y = 2.35 + 0.06 * Math.sin(t * 2);
    holo.scale.set(0.7 + 0.3 * a, (0.7 + 0.3 * a) * 1.4, 0.7 + 0.3 * a);
    M.beam.uniforms.uPower.value = 0.8 * a;
    M.beam.uniforms.uColor.value.copy(c);
    M.beam.uniforms.uTime.value = t;
    beam.visible = a > 0.02;
    const bk = clamp(burstT / 0.9);
    burst.visible = bk < 1;
    burst.scale.setScalar(0.5 + 3.5 * easeOut(bk));
    M.burst.opacity = 1 - bk;
    lamp.scale.setScalar(1 + 0.25 * (1 - bk) * (burst.visible ? 1 : 0));
  }
  return done(root, k, update);
}

const PORTAL_RINGS = [[0.9, 1.5], [1.8, 1.3], [2.7, 1.1]];
// portal: the exit pad (radius 1.8) with a swirl, a light column and one lamp per hero needed
function buildPortal() {
  const k = owner();
  const root = prop('portal');
  const G = {
    dais: geo('portal.dais', () => merged([
      [new THREE.CylinderGeometry(2.0, 2.15, 0.16, 48), [0, 0.08, 0]],
      [new THREE.CylinderGeometry(1.86, 1.86, 0.04, 48), [0, 0.17, 0]],
    ])),
    rim: geo('portal.rim', () => new THREE.TorusGeometry(1.86, 0.05, 8, 128).rotateX(Math.PI / 2)),
    disc: geo('portal.disc', () => new THREE.CircleGeometry(1.8, 64).rotateX(-Math.PI / 2)),
    column: geo('portal.column', () => new THREE.CylinderGeometry(1.72, 1.78, 3.4, 48, 1, true).translate(0, 1.7, 0)),
    ring: geo('portal.ring', () => new THREE.TorusGeometry(1, 0.03, 6, 96)),
    post: geo('portal.post', () => merged([
      [new THREE.CylinderGeometry(0.09, 0.12, 0.7, 10), [0, 0.35, 0]],
      [new THREE.CylinderGeometry(0.13, 0.13, 0.06, 10), [0, 0.72, 0]],
    ])),
    lamp: geo('portal.lamp', () => new THREE.SphereGeometry(0.11, 18, 12)),
  };
  const M = {
    rim: k.own(unlit('#a855f7', 1.6)),
    disc: k.own(fxMaterial(FS_SWIRL, { uColorA: { value: new THREE.Color() }, uColorB: { value: new THREE.Color() }, uTime: { value: 0 }, uPower: { value: 0.5 } })),
    column: k.own(fxMaterial(FS_COLUMN, { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uPower: { value: 0.3 } }, { side: THREE.DoubleSide })),
    rings: k.own(unlit('#a855f7', 1.4)),
    lamps: [0, 1, 2].map(() => k.own(unlit('#3a2a5a', 1))),
    halo: k.own(spriteMat('#ffd166', 1)),
  };
  part(root, G.dais, SM.dark(), null, null, null, RECV);
  part(root, G.rim, M.rim, [0, 0.19, 0]);
  part(root, G.disc, M.disc, [0, 0.2, 0]);
  const column = part(root, G.column, M.column, [0, 0.2, 0]);
  const rings = PORTAL_RINGS.map(([y, r]) => {
    const m = part(root, G.ring, M.rings, [0, y, 0], [Math.PI / 2, 0, 0], r);
    return m;
  });
  const lamps = [0, 1, 2].map((i) => {
    const a = i * TAU / 3 + Math.PI;
    const g = grp(root, Math.sin(a) * 2.05, 0.16, Math.cos(a) * 2.05);
    part(g, G.post, SM.metal(), null, null, null, CAST);
    const l = part(g, G.lamp, M.lamps[i], [0, 0.84, 0]);
    return { g, l };
  });
  const halo = sprite(root, M.halo, [0, 1.6, 0], 3);
  const purple = col('#a855f7');
  const cyan = col('#5ee7ff');
  const gold = col('#ffd166');
  const c = new THREE.Color();
  const c2 = new THREE.Color();
  let prog = 0;
  let openK = 0;
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    dt = safeDt(dt);
    const need = clamp(Math.round(num(s.need, 1)), 1, 3);
    const inside = clamp(Math.round(num(s.inside)), 0, need);
    prog = approach(prog, inside / need, 6, dt);
    openK = approach(openK, s.open ? 1 : 0, 3, dt);
    c.copy(purple).lerp(cyan, prog).lerp(gold, openK);
    c2.copy(purple).lerp(gold, openK * 0.6);
    const u = M.disc.uniforms;
    u.uColorA.value.copy(c).multiplyScalar(1.6);
    u.uColorB.value.copy(c2);
    u.uTime.value = t * (1 + prog + 2 * openK);
    u.uPower.value = 0.45 + 0.4 * prog + 0.6 * openK;
    const cu = M.column.uniforms;
    cu.uColor.value.copy(c);
    cu.uTime.value = t * (1 + openK);
    cu.uPower.value = 0.3 + 0.5 * prog + 0.8 * openK;
    column.scale.set(1, 1 + openK * 0.8, 1);
    M.rim.color.copy(c).multiplyScalar(1.4 + 0.6 * Math.sin(t * 3) * 0.3 + openK);
    M.rings.color.copy(c).multiplyScalar(1.2 + openK);
    for (let i = 0; i < 3; i++) {
      const r = rings[i];
      r.position.y = PORTAL_RINGS[i][0] + 0.12 * Math.sin(t * 1.3 + i * 2) + openK * i * 0.4;
      r.rotation.set(Math.PI / 2 + 0.12 * Math.sin(t * 0.9 + i), 0.12 * Math.cos(t * 0.7 + i * 1.7), t * (0.4 + i * 0.25) * (i % 2 ? -1 : 1));
      const l = lamps[i];
      l.g.visible = i < need;
      const lit = i < inside;
      M.lamps[i].color.copy(lit ? (openK > 0.5 ? gold : cyan) : purple).multiplyScalar(lit ? 2.2 + 0.4 * Math.sin(t * 5 + i) : 0.35);
    }
    M.halo.color.copy(gold).multiplyScalar(openK * (0.9 + 0.2 * Math.sin(t * 8)));
    halo.visible = openK > 0.02;
    halo.scale.setScalar(3 + openK * 2);
  }
  return done(root, k, update);
}

// switch: a lever on a console; touch or zap flips it
function buildSwitch() {
  const k = owner();
  const root = prop('switch');
  const G = {
    body: geo('switch.body', () => merged([
      [new THREE.RoundedBoxGeometry(0.62, 0.5, 0.42, 2, 0.07), [0, 0.25, 0]],
      [new THREE.RoundedBoxGeometry(0.68, 0.1, 0.48, 2, 0.04), [0, 0.55, 0]],
      [new THREE.CylinderGeometry(0.09, 0.09, 0.4, 12), [0, 0.62, 0], [0, 0, Math.PI / 2]],
    ])),
    stick: geo('switch.stick', () => new THREE.CylinderGeometry(0.03, 0.035, 0.42, 10).translate(0, 0.21, 0)),
    knob: geo('switch.knob', () => new THREE.SphereGeometry(0.075, 18, 12)),
    strip: geo('switch.strip', () => new THREE.BoxGeometry(0.46, 0.06, 0.02)),
    glyph: geo('switch.glyph', () => new THREE.PlaneGeometry(0.26, 0.26)),
  };
  const M = {
    knob: k.own(unlit('#ff5f6d', 2)),
    strip: k.own(unlit('#ff5f6d', 1.6)),
    glyph: k.own(additive('#ff5f6d', 1.4, TX.glyph('switch'))),
    halo: k.own(spriteMat('#ff5f6d', 1)),
  };
  part(root, G.body, SM.dark(), null, null, null, BOTH);
  const lever = grp(root, 0, 0.62, 0);
  part(lever, G.stick, SM.steel(), null, null, null, CAST);
  const knob = part(lever, G.knob, M.knob, [0, 0.45, 0]);
  const halo = sprite(lever, M.halo, [0, 0.45, 0], 0.5);
  part(root, G.strip, M.strip, [0, 0.36, 0.215]);
  part(root, G.glyph, M.glyph, [0, 0.2, 0.215]);
  const red = col('#ff5f6d');
  const green = col('#3dffb5');
  const c = new THREE.Color();
  let a = 0;
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    dt = safeDt(dt);
    a = approach(a, s.on ? 1 : 0, 10, dt);
    lever.rotation.x = lerp(-0.62, 0.62, easeInOut(a));
    c.copy(red).lerp(green, a);
    const p = 0.8 + 0.2 * Math.sin(t * 4);
    M.knob.color.copy(c).multiplyScalar(2 * p);
    M.strip.color.copy(c).multiplyScalar(1.5 * p);
    M.glyph.color.copy(c).multiplyScalar(1.3);
    M.halo.color.copy(c).multiplyScalar(0.9 * p);
    halo.scale.setScalar(0.45 + 0.1 * Math.sin(t * 4));
    knob.scale.setScalar(1 + 0.05 * Math.sin(t * 6));
  }
  return done(root, k, update);
}

// node: Vera's zap target — an energy orb inside a spinning cage
function buildNode() {
  const k = owner();
  const root = prop('node');
  const G = {
    base: geo('node.base', () => merged([
      [new THREE.CylinderGeometry(0.3, 0.38, 0.3, 16), [0, 0.15, 0]],
      [new THREE.CylinderGeometry(0.08, 0.12, 0.45, 10), [0, 0.5, 0]],
    ])),
    cage: geo('node.cage', () => new THREE.TorusGeometry(0.38, 0.024, 6, 48)),
    orb: geo('node.orb', () => new THREE.IcosahedronGeometry(0.2, 3)),
    trim: geo('node.trim', () => new THREE.TorusGeometry(0.3, 0.025, 6, 32).rotateX(Math.PI / 2)),
    stream: geo('node.stream', () => new THREE.CylinderGeometry(0.06, 0.06, 0.5, 12, 1, true)),
  };
  const M = {
    orb: k.own(unlit('#5ee7ff', 1)),
    trim: k.own(unlit('#5ee7ff', 1)),
    halo: k.own(spriteMat('#5ee7ff', 1)),
    stream: k.own(additive('#5ee7ff', 1.5, TX.fade(), { side: THREE.DoubleSide })),
  };
  part(root, G.base, SM.dark(), null, null, null, BOTH);
  part(root, G.trim, M.trim, [0, 0.3, 0]);
  const cageG = grp(root, 0, 1.12, 0);
  const cages = [0, 1, 2].map((i) => part(cageG, G.cage, SM.metal(), null, [i * 1.05, i * 0.7, 0], 1 - i * 0.12, CAST));
  const orb = part(cageG, G.orb, M.orb);
  const halo = sprite(cageG, M.halo, [0, 0, 0], 1.1);
  const stream = part(root, G.stream, M.stream, [0, 0.98, 0], [Math.PI, 0, 0]);
  const off = col('#4a5d9a');
  const on = col('#7ff3ff');
  const c = new THREE.Color();
  let a = 0;
  let spin = 0;
  let flashT = 9;
  let was = false;
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    dt = safeDt(dt);
    const lit = !!s.on;
    if (lit && !was) flashT = 0;
    was = lit;
    flashT += dt;
    a = approach(a, lit ? 1 : 0, 6, dt);
    const fl = flashT < 0.35 ? 1 - flashT / 0.35 : 0;
    spin += dt * (0.5 + 3.5 * a);
    for (let i = 0; i < 3; i++) cages[i].rotation.set(i * 1.05 + spin * (i === 1 ? -1 : 1), i * 0.7 + spin * 0.6, spin * 0.3 * i);
    c.copy(off).lerp(on, a);
    // a slow "ping" while off says: zap me
    const ping = (1 - a) * Math.max(0, Math.sin(t * 2.2)) ** 8;
    const p = 0.85 + 0.15 * Math.sin(t * 5);
    M.orb.color.copy(c).multiplyScalar((0.8 + 2.2 * a) * p + 1.2 * ping + 2 * fl);
    M.trim.color.copy(c).multiplyScalar(0.5 + 1.3 * a);
    M.halo.color.copy(c).multiplyScalar((0.3 + 1.1 * a) * p + 0.6 * ping + fl);
    halo.scale.setScalar(0.9 + 0.5 * a + 0.8 * fl);
    orb.scale.setScalar(1 + 0.08 * Math.sin(t * 6) * a + 0.3 * fl);
    cageG.position.y = 1.12 + 0.05 * Math.sin(t * 1.7);
    stream.visible = a > 0.05;
    M.stream.color.copy(c).multiplyScalar(1.4 * a);
  }
  return done(root, k, update);
}

// plate: a pressure plate; heavy ones are bigger, hazard-striped and amber (only Brick or a crate presses them)
function buildPlate(opts) {
  const k = owner();
  const root = prop('plate');
  const G = {
    frame: geo('plate.frame', () => new THREE.CylinderGeometry(0.74, 0.8, 0.1, 40).translate(0, 0.05, 0)),
    pad: geo('plate.pad', () => new THREE.CylinderGeometry(0.6, 0.6, 0.08, 40)),
    hframe: geo('plate.hframe', () => new THREE.RoundedBoxGeometry(1.7, 0.12, 1.7, 2, 0.05).translate(0, 0.06, 0)),
    hborder: geo('plate.hborder', () => merged([
      [new THREE.BoxGeometry(1.62, 0.02, 0.14), [0, 0.125, 0.74]], [new THREE.BoxGeometry(1.62, 0.02, 0.14), [0, 0.125, -0.74]],
      [new THREE.BoxGeometry(0.14, 0.02, 1.34), [0.74, 0.125, 0]], [new THREE.BoxGeometry(0.14, 0.02, 1.34), [-0.74, 0.125, 0]],
    ])),
    hpad: geo('plate.hpad', () => new THREE.RoundedBoxGeometry(1.3, 0.1, 1.3, 2, 0.04)),
  };
  const M = {
    pad: k.own(rimStd({ color: '#1f2433', emissive: '#5ee7ff', emissiveMap: TX.glyph('plate'), emissiveIntensity: 0.8, roughness: 0.4, metalness: 0.5 }, '#5ee7ff', 0.2, 2.5)),
    hpad: k.own(rimStd({ color: '#2a2520', emissive: '#ffb020', emissiveMap: TX.glyph('heavy'), emissiveIntensity: 0.8, roughness: 0.45, metalness: 0.5 }, '#ffb020', 0.2, 2.5)),
    hazard: shared('plate.hazard', () => new THREE.MeshStandardMaterial({ map: TX.hazard(), roughness: 0.6, metalness: 0.2 })),
  };
  const normal = grp(root);
  part(normal, G.frame, SM.dark(), null, null, null, RECV);
  const pad = part(normal, G.pad, M.pad, [0, 0.15, 0], null, null, RECV);
  const heavy = grp(root);
  part(heavy, G.hframe, SM.dark(), null, null, null, RECV);
  part(heavy, G.hborder, M.hazard, null, null, null, RECV);
  const hpad = part(heavy, G.hpad, M.hpad, [0, 0.19, 0], null, null, RECV);
  let pr = 0;
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    dt = safeDt(dt);
    const isHeavy = s.heavy != null ? !!s.heavy : !!(opts && opts.heavy);
    normal.visible = !isHeavy;
    heavy.visible = isHeavy;
    pr = approach(pr, s.pressed ? 1 : 0, 14, dt);
    const p = 0.8 + 0.2 * Math.sin(t * 3);
    pad.position.y = 0.15 - 0.04 * pr;
    hpad.position.y = 0.19 - 0.05 * pr;
    M.pad.emissiveIntensity = (0.55 + 1.6 * pr) * p;
    M.hpad.emissiveIntensity = (0.5 + 1.7 * pr) * p;
  }
  return done(root, k, update);
}

// door: a framed two-panel door that slides open into its posts; the long side of opts.size is its width
function buildDoor(opts) {
  const k = owner();
  const root = prop('door');
  const [sx, sy, sz] = sizeOf(opts, [2.4, 3, 0.5]);
  const alongX = sx >= sz;
  const w = alongX ? sx : sz;
  const d = alongX ? sz : sx;
  const inner = grp(root);
  if (!alongX) inner.rotation.y = Math.PI / 2;
  const D = TX.door();
  const panelGeo = k.own(new THREE.RoundedBoxGeometry(w / 2, sy, d * 0.7, 2, Math.min(0.06, d * 0.3)));
  const frameGeo = k.own(merged([
    [new THREE.RoundedBoxGeometry(0.26, sy + 0.26, d + 0.14, 2, 0.06), [w / 2 + 0.13, (sy + 0.26) / 2, 0]],
    [new THREE.RoundedBoxGeometry(0.26, sy + 0.26, d + 0.14, 2, 0.06), [-w / 2 - 0.13, (sy + 0.26) / 2, 0]],
    [new THREE.RoundedBoxGeometry(w + 0.52, 0.26, d + 0.14, 2, 0.06), [0, sy + 0.13, 0]],
  ]));
  const stripGeo = k.own(merged([
    [new THREE.BoxGeometry(0.05, sy * 0.8, 0.02), [w / 2 + 0.13, sy * 0.5, d / 2 + 0.075]],
    [new THREE.BoxGeometry(0.05, sy * 0.8, 0.02), [-w / 2 - 0.13, sy * 0.5, d / 2 + 0.075]],
    [new THREE.BoxGeometry(0.05, sy * 0.8, 0.02), [w / 2 + 0.13, sy * 0.5, -d / 2 - 0.075]],
    [new THREE.BoxGeometry(0.05, sy * 0.8, 0.02), [-w / 2 - 0.13, sy * 0.5, -d / 2 - 0.075]],
    [new THREE.BoxGeometry(w * 0.6, 0.05, 0.02), [0, sy + 0.13, d / 2 + 0.075]],
    [new THREE.BoxGeometry(w * 0.6, 0.05, 0.02), [0, sy + 0.13, -d / 2 - 0.075]],
  ]));
  const M = {
    panel: shared('door.panel', () => rimStd({ color: '#ffffff', map: D.map, emissive: '#ff5f6d', emissiveMap: D.glow, emissiveIntensity: 1.2, roughness: 0.4, metalness: 0.6, envMap: TX.env(), envMapIntensity: 0.5 }, '#7d6bff', 0.25, 2.4)),
    strip: k.own(unlit('#ff5f6d', 1.6)),
    seam: k.own(additive('#ff5f6d', 1.2, TX.glow(), { opacity: 0.7 })),
  };
  part(inner, frameGeo, SM.dark(), null, null, null, BOTH);
  part(inner, stripGeo, M.strip);
  const halves = [-1, 1].map((side) => {
    const g = grp(inner, side * w / 2, 0, 0);
    part(g, panelGeo, M.panel, [-side * w / 4, sy / 2, 0], null, null, BOTH);
    return g;
  });
  const seam = part(inner, geo('door.seam', () => new THREE.PlaneGeometry(1, 1)), M.seam, [0, sy / 2, d * 0.36], null, [0.4, sy * 0.95, 1]);
  recenter(root, opts, sy);
  const red = col('#ff5f6d');
  const green = col('#3dffb5');
  const c = new THREE.Color();
  let a = 0;
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    dt = safeDt(dt);
    const o = clamp(num(s.open));
    a = approach(a, o, 12, dt);
    const e = easeInOut(a);
    for (const h of halves) h.scale.x = Math.max(0.04, 1 - 0.96 * e);
    c.copy(red).lerp(green, sstep(0.05, 0.6, a));
    M.strip.color.copy(c).multiplyScalar(1.5 * (0.8 + 0.2 * Math.sin(t * 4)));
    seam.visible = a < 0.2;
    M.seam.opacity = (0.5 + 0.2 * Math.sin(t * 7)) * (1 - a * 5);
  }
  return done(root, k, update);
}

// crate: heavy, banded, pushable (amber chevrons = Brick's colour)
function buildCrate(opts) {
  const k = owner();
  const root = prop('crate');
  const [sx, sy, sz] = sizeOf(opts, [1.4, 1.4, 1.4]);
  const C = TX.crate();
  const M = {
    body: shared('crate.body', () => rimStd({ color: '#ffffff', map: C.map, emissive: '#ffb020', emissiveMap: C.glow, emissiveIntensity: 1, roughness: 0.5, metalness: 0.55, envMap: TX.env(), envMapIntensity: 0.6 }, '#ffcf7a', 0.2, 2.6)),
  };
  const r = Math.min(0.08, sx * 0.1, sy * 0.1, sz * 0.1);
  const bodyGeo = k.own(new THREE.RoundedBoxGeometry(sx, sy, sz, 2, r));
  const cb = Math.min(0.24, Math.min(sx, sy, sz) * 0.2);
  const corners = [];
  for (const x of [-1, 1]) for (const y of [0, 1]) for (const z of [-1, 1]) {
    corners.push([new THREE.BoxGeometry(cb, cb, cb), [x * (sx / 2 - cb / 2 + 0.02), y * sy + (y ? -cb / 2 + 0.02 : cb / 2 - 0.02), z * (sz / 2 - cb / 2 + 0.02)]]);
  }
  const cornerGeo = k.own(merged(corners));
  part(root, bodyGeo, M.body, [0, sy / 2, 0], null, null, BOTH);
  part(root, cornerGeo, SM.steel(), null, null, null, CAST);
  recenter(root, opts, sy);
  function update(t) {
    M.body.emissiveIntensity = 0.75 + 0.25 * Math.sin(t * 2.4);
  }
  return done(root, k, update);
}

// cracked: a block of stone chunks over a glowing core; broken 0..1 throws the chunks out
function buildCracked(opts) {
  const k = owner();
  const root = prop('cracked');
  const [sx, sy, sz] = sizeOf(opts, [2, 1, 2]);
  const S = TX.stone();
  const nx = clamp(Math.round(sx / 0.75), 1, 4);
  const ny = clamp(Math.round(sy / 0.75), 1, 3);
  const nz = clamp(Math.round(sz / 0.75), 1, 4);
  const n = nx * ny * nz;
  const M = {
    chunk: shared('cracked.chunk', () => rimStd({ color: '#b8b2ac', map: S.map, emissive: '#ff8a1f', emissiveMap: S.glow, emissiveIntensity: 0.9, roughness: 0.92, metalness: 0 }, '#ffb347', 0.25, 2.4)),
    core: k.own(unlit('#ff9a1f', 1.8)),
  };
  const cgeo = geo('cracked.chunk', () => new THREE.RoundedBoxGeometry(1, 1, 1, 1, 0.07));
  const chunks = k.own(new THREE.InstancedMesh(cgeo, M.chunk, n));
  chunks.castShadow = true;
  chunks.receiveShadow = true;
  chunks.frustumCulled = false;
  root.add(chunks);
  const core = part(root, geo('cracked.core', () => new THREE.BoxGeometry(1, 1, 1)), M.core, [0, sy / 2, 0], null, [sx - 0.1, sy - 0.1, sz - 0.1]);
  const R = rng(Math.round(sx * 97 + sy * 13 + sz * 7));
  const base = new Float32Array(n * 3);
  const size = new Float32Array(n * 3);
  const dir = new Float32Array(n * 3);
  const spin = new Float32Array(n * 3);
  const cw = sx / nx;
  const ch = sy / ny;
  const cd = sz / nz;
  let i = 0;
  for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) for (let c = 0; c < nz; c++) {
    const x = -sx / 2 + cw * (a + 0.5);
    const y = ch * (b + 0.5);
    const z = -sz / 2 + cd * (c + 0.5);
    base[i * 3] = x; base[i * 3 + 1] = y; base[i * 3 + 2] = z;
    const gap = 0.05;
    size[i * 3] = cw - gap - R() * 0.03; size[i * 3 + 1] = ch - gap - R() * 0.03; size[i * 3 + 2] = cd - gap - R() * 0.03;
    _v1.set(x + (R() - 0.5) * 0.3, y - sy * 0.2 + 0.3, z + (R() - 0.5) * 0.3).normalize();
    dir[i * 3] = _v1.x; dir[i * 3 + 1] = _v1.y; dir[i * 3 + 2] = _v1.z;
    spin[i * 3] = (R() - 0.5) * 8; spin[i * 3 + 1] = (R() - 0.5) * 8; spin[i * 3 + 2] = (R() - 0.5) * 8;
    i++;
  }
  const sc = new THREE.Vector3();
  let last = -1;
  function place(b) {
    for (let j = 0; j < n; j++) {
      const sp = 1.8 + (j % 3) * 0.5;
      _v1.set(
        base[j * 3] + dir[j * 3] * b * sp,
        base[j * 3 + 1] + dir[j * 3 + 1] * b * sp + Math.sin(Math.PI * Math.min(1, b * 1.3)) * 0.9 - b * b * 1.6,
        base[j * 3 + 2] + dir[j * 3 + 2] * b * sp,
      );
      _e.set(spin[j * 3] * b + (j % 2 ? 0.02 : -0.02), spin[j * 3 + 1] * b, spin[j * 3 + 2] * b);
      _q.setFromEuler(_e);
      const shrink = 1 - sstep(0.55, 1, b);
      sc.set(size[j * 3] * shrink, size[j * 3 + 1] * shrink, size[j * 3 + 2] * shrink);
      _m4.compose(_v1, _q, sc);
      chunks.setMatrixAt(j, _m4);
    }
    chunks.instanceMatrix.needsUpdate = true;
  }
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    const b = clamp(num(s.broken));
    if (b !== last) { place(b); last = b; }
    root.visible = b < 0.999;
    const flare = b > 0 ? Math.max(0, 1 - b * 4) : 0;
    core.visible = b < 0.25;
    setGlow(M.core, (1.2 + 0.5 * Math.sin(t * 2.2)) * (1 + 2 * flare));
    core.scale.set((sx - 0.1) * (1 - b * 3), (sy - 0.1) * (1 - b * 3), (sz - 0.1) * (1 - b * 3));
  }
  place(0);
  recenter(root, opts, sy);
  return done(root, k, update);
}

// bounce pad: a spring-loaded glowing pad; fire 0..1 (rising edge) springs it and sends a ring up
class Helix extends THREE.Curve {
  getPoint(u, target = new THREE.Vector3()) {
    const a = u * TAU * 3;
    return target.set(Math.cos(a) * 0.42, 0.04 + u * 0.24, Math.sin(a) * 0.42);
  }
}
function buildBounce() {
  const k = owner();
  const root = prop('bounce');
  const G = {
    base: geo('bounce.base', () => new THREE.CylinderGeometry(0.7, 0.82, 0.18, 32).translate(0, 0.09, 0)),
    spring: geo('bounce.spring', () => new THREE.TubeGeometry(new Helix(), 120, 0.035, 8, false)),
    pad: geo('bounce.pad', () => new THREE.CylinderGeometry(0.64, 0.64, 0.1, 40)),
    wave: geo('bounce.wave', () => new THREE.TorusGeometry(0.62, 0.035, 6, 48).rotateX(Math.PI / 2)),
  };
  const M = {
    pad: k.own(rimStd({ color: '#1b2a1c', emissive: '#8dff4f', emissiveMap: TX.glyph('bounce'), emissiveIntensity: 1, roughness: 0.35, metalness: 0.4 }, '#8dff4f', 0.3, 2.2)),
    wave: k.own(additive('#8dff4f', 2, null, { opacity: 0 })),
  };
  part(root, G.base, SM.dark(), null, null, null, BOTH);
  const spring = part(root, G.spring, SM.steel(), [0, 0.12, 0], null, null, CAST);
  const top = grp(root, 0, 0.42, 0);
  part(top, G.pad, M.pad, null, null, null, BOTH);
  const wave = part(root, G.wave, M.wave, [0, 0.45, 0]);
  let prev = 0;
  let bt = 9;
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    dt = safeDt(dt);
    const f = clamp(num(s.fire));
    if (f > prev + 0.25 || (f >= 0.99 && prev < 0.99)) bt = 0;
    prev = f;
    bt += dt;
    const kick = bt < 1.2 ? Math.exp(-bt * 5) * Math.sin(bt * 26) : 0;
    const comp = bt < 0.06 ? -bt / 0.06 * 0.12 : kick * 0.22;
    top.position.y = 0.42 + comp + 0.012 * Math.sin(t * 3);
    spring.scale.y = (top.position.y - 0.12) / 0.3;
    M.pad.emissiveIntensity = 0.85 + 0.25 * Math.sin(t * 3) + 2 * Math.max(0, 1 - bt * 3);
    const wk = clamp(bt / 0.6);
    wave.visible = wk < 1;
    wave.position.y = 0.45 + wk * 2.2;
    wave.scale.setScalar(1 + wk * 0.6);
    M.wave.opacity = 1 - wk;
  }
  return done(root, k, update);
}

// laser: an emitter at the origin firing along +Z for opts.length metres to a receiver
function buildLaser(opts) {
  const k = owner();
  const root = prop('laser');
  const L = Math.max(0.2, num(opts && opts.length, 6) || 6);
  const G = {
    housing: geo('laser.housing', () => merged([
      [new THREE.CylinderGeometry(0.16, 0.2, 0.3, 12), [0, 0, -0.12], [Math.PI / 2, 0, 0]],
      [new THREE.TorusGeometry(0.15, 0.03, 8, 24), [0, 0, 0.03]],
      [new THREE.BoxGeometry(0.46, 0.08, 0.08), [0, 0, -0.2]],
    ])),
    lens: geo('laser.lens', () => new THREE.SphereGeometry(0.09, 16, 12)),
    core: geo('laser.core', () => new THREE.CylinderGeometry(0.022, 0.022, 1, 8, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2)),
    glow: geo('laser.glow', () => new THREE.CylinderGeometry(0.15, 0.15, 1, 16, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2)),
  };
  const M = {
    lens: k.own(unlit('#ff2d55', 2.4)),
    core: k.own(unlit('#ff8fa6', 2.0)),
    glow: k.own(fxMaterial(FS_BEAM, { uColor: { value: col('#ff2d55').clone() }, uTime: { value: 0 }, uOn: { value: 1 }, uLen: { value: L }, uFlick: { value: 1 } }, { side: THREE.DoubleSide })),
    halo: k.own(spriteMat('#ff2d55', 1.2)),
  };
  // the housings are tiny and levels place lasers in grids of dozens: no shadow pass for them (phones)
  part(root, G.housing, SM.dark());
  part(root, G.lens, M.lens, [0, 0, 0.02], null, [1, 1, 0.6]);
  const rec = grp(root, 0, 0, L);
  rec.rotation.y = Math.PI;
  part(rec, G.housing, SM.dark());
  part(rec, G.lens, M.lens, [0, 0, 0.02], null, [1, 1, 0.6]);
  const core = part(root, G.core, M.core, null, null, [1, 1, L]);
  const glow = part(root, G.glow, M.glow, null, null, [1, 1, L]);
  glow.renderOrder = 3;
  const halos = [sprite(root, M.halo, [0, 0, 0.1], 0.7), sprite(rec, M.halo, [0, 0, 0.1], 0.6)];
  let a = 1;
  const R = rng(seeds++ * 11);
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    dt = safeDt(dt);
    a = approach(a, s.on === false || s.on === 0 ? 0 : 1, 25, dt);
    const fl = 0.75 + 0.25 * R();
    const u = M.glow.uniforms;
    u.uOn.value = a;
    u.uTime.value = t;
    u.uFlick.value = fl;
    core.visible = a > 0.05;
    core.scale.set(0.8 + 0.4 * fl, 0.8 + 0.4 * fl, L);
    glow.scale.set(0.85 + 0.25 * fl * a, 0.85 + 0.25 * fl * a, L);
    setGlow(M.lens, 0.25 + 0.85 * a * fl);
    M.halo.color.copy(M.halo.userData.base).multiplyScalar(0.2 + 0.9 * a * fl);
    for (const h of halos) h.scale.setScalar(0.35 + 0.4 * a);
  }
  return done(root, k, update, { length: L });
}

// spikes: a plate of steel spikes that rise (up 0..1) to opts.size[1]
function buildSpikes(opts) {
  const k = owner();
  const root = prop('spikes');
  const [sx, sy, sz] = sizeOf(opts, [2, 0.6, 2]);
  const nx = Math.max(1, Math.round(sx / 0.32));
  const nz = Math.max(1, Math.round(sz / 0.32));
  const n = nx * nz;
  const M = {
    spike: shared('spikes.spike', () => rimStd({ color: '#b9c0cf', emissive: '#ff2d55', emissiveMap: TX.tipGlow(), emissiveIntensity: 1.4, roughness: 0.28, metalness: 0.85, flatShading: true, envMap: TX.env(), envMapIntensity: 0.9 }, '#ff5f6d', 0.2, 2.4)),
    base: shared('spikes.base', () => rimStd({ color: '#2b2133', roughness: 0.5, metalness: 0.6, emissive: '#ff2d55', emissiveIntensity: 0.12 }, '#ff2d55', 0.3, 2.2)),
  };
  const baseGeo = k.own(merged([
    [new THREE.RoundedBoxGeometry(sx, 0.1, sz, 2, 0.03), [0, 0.05, 0]],
  ]));
  part(root, baseGeo, M.base, null, null, null, BOTH);
  const sgeo = geo('spikes.cone', () => new THREE.ConeGeometry(0.1, 1, 4).translate(0, 0.5, 0));
  const spikes = k.own(new THREE.InstancedMesh(sgeo, M.spike, n));
  spikes.castShadow = true;
  spikes.frustumCulled = false;
  root.add(spikes);
  recenter(root, opts, sy);
  const sc = new THREE.Vector3();
  let last = -1;
  function update(t, dt, s) {
    s = s || PROP_DEFAULT;
    const up = clamp(num(s.up, 1));
    if (up !== last) {
      last = up;
      let i = 0;
      for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
        const h = Math.max(0.02, sy * up * (0.85 + 0.15 * ((a * 7 + b * 3) % 4) / 3));
        _v1.set(-sx / 2 + (a + 0.5) * sx / nx, 0.06, -sz / 2 + (b + 0.5) * sz / nz);
        _q.setFromAxisAngle(_up, Math.PI / 4 + ((a + b) % 2) * 0.3);
        sc.set(1, h, 1);
        _m4.compose(_v1, _q, sc);
        spikes.setMatrixAt(i++, _m4);
      }
      spikes.instanceMatrix.needsUpdate = true;
    }
    M.spike.emissiveIntensity = 1.2 + 0.4 * Math.sin(t * 5);
  }
  return done(root, k, update);
}

// sign: a post with a glowing text board (text drawn on a per-entity canvas)
function signTexture(text) {
  const W = 512;
  const H = 288;
  const cv = canvas(W, H);
  const c = cv.getContext('2d');
  c.fillStyle = '#0d0a22'; c.fillRect(0, 0, W, H);
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(94,231,255,0.10)'); g.addColorStop(1, 'rgba(167,139,250,0.06)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  c.strokeStyle = '#5ee7ff'; c.lineWidth = 7; rr(c, 12, 12, W - 24, H - 24, 26); c.stroke();
  c.textAlign = 'center'; c.textBaseline = 'middle';
  const words = String(text || '').split(/\s+/).filter(Boolean);
  let size = 52;
  let lines = [];
  for (; size >= 22; size -= 2) {
    c.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    lines = [];
    let line = '';
    for (const wd of words) {
      const test = line ? `${line} ${wd}` : wd;
      if (c.measureText(test).width > W - 80 && line) { lines.push(line); line = wd; } else line = test;
    }
    if (line) lines.push(line);
    if (lines.length * size * 1.18 <= H - 70 && lines.every((l) => c.measureText(l).width <= W - 70)) break;
  }
  c.shadowColor = '#5ee7ff'; c.shadowBlur = 14;
  c.fillStyle = '#eafcff';
  const y0 = H / 2 - (lines.length - 1) * size * 0.59;
  lines.forEach((l, i) => c.fillText(l, W / 2, y0 + i * size * 1.18));
  return toTex(cv);
}
function buildSign(opts) {
  const k = owner();
  const root = prop('sign');
  const G = {
    post: geo('sign.post', () => merged([
      [new THREE.CylinderGeometry(0.05, 0.065, 1.1, 10), [0, 0.55, 0]],
      [new THREE.CylinderGeometry(0.22, 0.28, 0.08, 12), [0, 0.04, 0]],
    ])),
    board: geo('sign.board', () => new THREE.RoundedBoxGeometry(1.8, 1.02, 0.1, 2, 0.04)),
    face: geo('sign.face', () => new THREE.PlaneGeometry(1.7, 0.94)),
  };
  const tex = k.own(signTexture(opts && opts.text));
  const M = { face: k.own(new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.25, 1.25, 1.25) })) };
  part(root, G.post, SM.metal(), null, null, null, CAST);
  part(root, G.board, SM.dark(), [0, 1.55, 0], null, null, CAST);
  part(root, G.face, M.face, [0, 1.55, 0.052]);
  part(root, G.face, M.face, [0, 1.55, -0.052], [0, Math.PI, 0]);
  function update(t) {
    const f = 1.15 + 0.1 * Math.sin(t * 2.1) + (Math.sin(t * 13.7) > 0.985 ? -0.3 : 0);
    M.face.color.setRGB(f, f, f);
  }
  return done(root, k, update);
}

// mover: a moving-platform look — bevelled slab, glowing edge trims and a hover glow underneath
const MOVER_LOOK = {
  neon: ['#1d1a3a', 0.4, 0.6, '#5ee7ff'], metal: ['#7d8597', 0.35, 0.85, '#5ee7ff'], stone: ['#8a8278', 0.9, 0, '#ffb347'],
  rock: ['#6e655c', 0.92, 0, '#ffb347'], crystal: ['#9f7bff', 0.15, 0.2, '#d8b4fe'], glass: ['#a5f3fc', 0.08, 0.1, '#5ee7ff'],
  ice: ['#dbeafe', 0.2, 0.05, '#7dd3fc'], grass: ['#4ade80', 0.8, 0, '#bef264'], wood: ['#a16207', 0.75, 0, '#fbbf24'],
  sand: ['#e8c58a', 0.9, 0, '#fde68a'], 'lava-rock': ['#3b2a26', 0.85, 0.1, '#ff7a1a'],
};
function moverMaterial(name, tint) {
  const look = MOVER_LOOK[name] || MOVER_LOOK.metal;
  const key = `mover.${name in MOVER_LOOK ? name : 'metal'}.${tint || ''}`;
  return shared(key, () => {
    const crystal = name === 'crystal' || name === 'glass' || name === 'ice';
    return rimStd({
      color: tint || look[0], roughness: look[1], metalness: look[2], envMap: TX.env(), envMapIntensity: 0.6,
      emissive: crystal ? (tint || look[0]) : '#000000', emissiveIntensity: crystal ? 0.25 : 0,
      map: name === 'stone' || name === 'rock' || name === 'lava-rock' ? TX.stone().map : null,
    }, look[3], 0.3, 2.4);
  });
}
function buildMover(opts) {
  const k = owner();
  const root = prop('mover');
  const [sx, sy, sz] = sizeOf(opts, [3, 0.5, 3]);
  const name = (opts && opts.material) || 'metal';
  const look = MOVER_LOOK[name] || MOVER_LOOK.metal;
  const slabGeo = k.own(new THREE.RoundedBoxGeometry(sx, sy, sz, 2, Math.min(0.12, sy * 0.3, sx * 0.2, sz * 0.2)));
  const e = 0.035;
  const trimGeo = k.own(merged([
    [new THREE.BoxGeometry(sx - 0.2, e, e), [0, sy + 0.005, sz / 2 - 0.06]],
    [new THREE.BoxGeometry(sx - 0.2, e, e), [0, sy + 0.005, -sz / 2 + 0.06]],
    [new THREE.BoxGeometry(e, e, sz - 0.2), [sx / 2 - 0.06, sy + 0.005, 0]],
    [new THREE.BoxGeometry(e, e, sz - 0.2), [-sx / 2 + 0.06, sy + 0.005, 0]],
    [new THREE.BoxGeometry(sx * 0.7, 0.045, e), [0, sy * 0.5, sz / 2 + 0.005]],
    [new THREE.BoxGeometry(sx * 0.7, 0.045, e), [0, sy * 0.5, -sz / 2 - 0.005]],
    [new THREE.BoxGeometry(e, 0.045, sz * 0.7), [sx / 2 + 0.005, sy * 0.5, 0]],
    [new THREE.BoxGeometry(e, 0.045, sz * 0.7), [-sx / 2 - 0.005, sy * 0.5, 0]],
  ]));
  const padGeo = geo('mover.pad', () => new THREE.CircleGeometry(0.16, 20).rotateX(Math.PI / 2));
  const M = {
    slab: moverMaterial(name, opts && opts.tint),
    trim: k.own(unlit(look[3], 1.5)),
    under: k.own(additive(look[3], 0.9, TX.glow(), { opacity: 0.8, side: THREE.DoubleSide })),
  };
  part(root, slabGeo, M.slab, [0, sy / 2, 0], null, null, BOTH);
  part(root, trimGeo, M.trim);
  const under = part(root, unitPlane(), M.under, [0, -0.04, 0], [Math.PI, 0, 0], [sx * 1.1, 1, sz * 1.1]);
  const pads = [];
  for (const x of [-1, 1]) for (const z of [-1, 1]) pads.push(part(root, padGeo, M.trim, [x * (sx / 2 - 0.35), -0.005, z * (sz / 2 - 0.35)]));
  recenter(root, opts, sy);
  const ph = (seeds++ * 0.37) % TAU;
  function update(t) {
    const p = 0.8 + 0.2 * Math.sin(t * 3 + ph);
    setGlow(M.trim, p);
    M.under.opacity = 0.55 + 0.25 * Math.sin(t * 4.3 + ph);
    under.scale.set(sx * (1.05 + 0.05 * Math.sin(t * 2 + ph)), 1, sz * (1.05 + 0.05 * Math.sin(t * 2 + ph)));
  }
  return done(root, k, update);
}

function buildUnknown(type) {
  const k = owner();
  const root = prop(type || 'unknown');
  return done(root, k, () => {});
}

export function makeProp(type, opts = {}) {
  switch (type) {
    case 'shard': return buildShard();
    case 'checkpoint': return buildCheckpoint();
    case 'portal': return buildPortal();
    case 'switch': return buildSwitch();
    case 'node': return buildNode();
    case 'plate': return buildPlate(opts);
    case 'door': return buildDoor(opts);
    case 'crate': return buildCrate(opts);
    case 'cracked': return buildCracked(opts);
    case 'bounce': return buildBounce();
    case 'laser': return buildLaser(opts);
    case 'spikes': return buildSpikes(opts);
    case 'sign': return buildSign(opts);
    case 'mover': return buildMover(opts);
    default: return buildUnknown(type);
  }
}
