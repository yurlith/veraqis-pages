// NEON RIFT — graphics.
// createRenderer(): WebGL2 renderer with post-processing (scene → bloom → grade → ACES/sRGB output → FXAA),
// quality tiers with an automatic downgrade, four themes (sky dome, fog, hemisphere + key + rim light,
// reflections, far scenery, ambient particles), shared procedural materials and pooled effects.
// buildStatic(): bevelled level blocks merged per material, with trims. makeSurface(): animated shader planes.
// Every texture is drawn on a <canvas> or computed in a shader (the page CSP allows no image files), and
// every GPU resource made here is freed by the matching dispose().
import * as THREE from '../vendor/three.min.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const col = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
const tmpC = new THREE.Color();

// ---------- quality tiers ----------
// pr: pixel-ratio cap · bloom: bloom buffer scale · shadow: map size (0 = off) · ext: shadow half-extent (m)
const TIERS = {
  low: { pr: 1, bloom: 0.5, shadow: 0, ext: 14, fxaa: false, grade: false, parts: 0.35, scenery: 0.55 },
  medium: { pr: 1.5, bloom: 0.75, shadow: 1024, ext: 16, fxaa: false, grade: true, parts: 0.6, scenery: 0.8 },
  high: { pr: 2, bloom: 1, shadow: 2048, ext: 20, fxaa: true, grade: true, parts: 1, scenery: 1 },
};
const TIER_NAMES = ['low', 'medium', 'high'];

// ---------- themes ----------
// sky: dome gradient (top → mid → horizon, below → bot) plus a horizon glow band; body: moon/sun;
// key: [colour, intensity, direction] (shadow light, kept high so shadows land under the heroes);
// bloom: [strength, radius, threshold]; haze/hazeK: far-scenery atmosphere; cards: lights for reflections.
const THEMES = {
  neon: {
    sky: { top: '#03020a', mid: '#100730', hor: '#3a1158', bot: '#1a0626', glow: '#ff2d95', glowK: 13, glowI: 0.2 },
    body: { type: 'moon', dir: [0.36, 0.17, 0.92], size: 0.062, col: '#ffe9f6', int: 1.25 },
    stars: 1.3, starCol: '#e9e2ff', neb: { a: '#4c1d95', b: '#be185d', amt: 0.28 },
    fog: ['#1a0b33', 0.0105], hemi: ['#8f86ff', '#c2338a', 0.9], key: ['#d4daff', 2.6, [0.3, 0.88, 0.36]], rim: ['#ff4fd8', 3.2],
    env: 0.55, envSky: 0.5, exposure: 1.0, bloom: [0.75, 0.5, 1.0], accent: ['#5ee7ff', '#ff4fd8'], crystal: '#5ee7ff',
    haze: '#2c0f4a', hazeK: 0.0042, vig: 0.3, sat: 1.08, heat: 0, dust: '#b8a6ee',
    tint: { stone: '#c6c2ff', rock: '#b6a8da', metal: '#dcd6ff', wood: '#c9bfd6', sand: '#d3c3e7', grass: '#9fdcc4', ice: '#d6e4ff', soil: '#c8b4d8' },
    cards: [[0.36, 0.17, 0.92, 6, 6, '#ffe9f6', 1.6], [-0.8, 0.1, 0.55, 14, 3, '#ff3d9e', 2.2], [0.85, 0.06, -0.4, 10, 4, '#5ee7ff', 2.2],
      [-0.35, 0.22, -0.9, 4, 12, '#a855f7', 1.8], [0.1, -0.35, 0.9, 24, 8, '#ff2d95', 0.6]],
    scenery: 'skyline', ambient: 'rain',
  },
  crystal: {
    sky: { top: '#010208', mid: '#040a22', hor: '#0d1d4c', bot: '#040920', glow: '#2fb8ff', glowK: 7, glowI: 0.2 },
    body: null, stars: 0.9, starCol: '#9feaff', aurora: { a: '#22e5c0', b: '#8b5cf6', amt: 0.42 },
    fog: ['#0a1230', 0.016], hemi: ['#7591ff', '#3e2178', 1.0], key: ['#b8eeff', 2.4, [-0.25, 0.9, 0.3]], rim: ['#b48cff', 2.6],
    env: 0.75, envSky: 0.5, exposure: 1.08, bloom: [0.85, 0.55, 0.95], accent: ['#5ee7ff', '#c084fc'], crystal: '#56e0ff',
    haze: '#0c1a46', hazeK: 0.0062, vig: 0.36, sat: 1.06, heat: 0, dust: '#9db4ff',
    tint: { stone: '#a7b5f0', rock: '#a2a8d8', metal: '#bfcdff', wood: '#ab9fc8', sand: '#aeb8de', grass: '#86d8c8', ice: '#a9d6ff', soil: '#8c86b0' },
    cards: [[-0.7, 0.1, 0.7, 16, 10, '#38e1ff', 2.4], [0.8, 0.15, -0.5, 14, 12, '#a855f7', 2.4], [0.3, 0.05, 0.95, 10, 14, '#2dd4bf', 2],
      [0, 1, 0.1, 30, 30, '#b8f0ff', 1.3], [-0.5, -0.4, -0.7, 20, 10, '#6d28d9', 1.5]],
    scenery: 'spires', ambient: 'spores',
  },
  sky: {
    sky: { top: '#2753c4', mid: '#6d8fdc', hor: '#ffae6e', bot: '#e8a07c', glow: '#ff9a52', glowK: 6, glowI: 0.28 },
    body: { type: 'sun', dir: [-0.33, 0.1, 0.94], size: 0.04, col: '#ffe8c2', int: 1 },
    stars: 0, clouds: { lit: '#ffe9d2', dark: '#9c90c8', amt: 0.8 },
    fog: ['#eec2a0', 0.0062], hemi: ['#9fc0ff', '#d99a70', 1.25], key: ['#ffd2a0', 3.4, [-0.28, 0.78, 0.56]], rim: ['#ffa8cf', 1.6],
    env: 0.7, envSky: 0.55, exposure: 0.9, bloom: [0.35, 0.5, 1.25], accent: ['#ffd166', '#5ee7ff'], crystal: '#7ee8ff',
    haze: '#efc4a4', hazeK: 0.0026, vig: 0.22, sat: 1.1, heat: 0, dust: '#e9d4b4',
    tint: { stone: '#fff4ea', rock: '#efe2d6', metal: '#fff1e6', ice: '#ffffff', soil: '#ffffff' },
    cards: [[-0.33, 0.1, 0.94, 7, 7, '#ffe8c2', 10], [-0.2, 0.02, 0.98, 60, 8, '#ffb070', 2.2], [0.8, 0.1, -0.5, 30, 12, '#ffd2b0', 1.2],
      [0, 1, 0, 40, 40, '#6f9bff', 1.2]],
    scenery: 'islands', ambient: 'pollen',
  },
  lava: {
    sky: { top: '#040101', mid: '#140404', hor: '#4a1005', bot: '#c2360a', glow: '#ff3a0a', glowK: 8, glowI: 0.35 },
    body: null, stars: 0, clouds: { lit: '#ff5a1e', dark: '#0e0303', amt: 0.85, smoke: true },
    fog: ['#1c0605', 0.0125], hemi: ['#4a3a44', '#b8461c', 0.85], key: ['#ffe0c4', 2.4, [-0.3, 0.86, 0.4]], rim: ['#ff7a3a', 2.8],
    env: 0.6, envSky: 0.45, exposure: 1.0, bloom: [0.85, 0.55, 0.95], accent: ['#ff8a3d', '#ffd166'], crystal: '#ff9a4a',
    haze: '#2e0a05', hazeK: 0.0052, vig: 0.38, sat: 1.08, heat: 0.0028, dust: '#4e4240',
    tint: { stone: '#b39d9a', rock: '#927a74', metal: '#cbb4ac', wood: '#ab887c', sand: '#c19e86', grass: '#a3ab7c', ice: '#ffdccc', soil: '#a08070' },
    cards: [[0, -1, 0, 60, 60, '#ff5a1a', 3.2], [0.7, 0.05, 0.7, 30, 6, '#ff3a0a', 2.4], [-0.75, 0.2, -0.6, 8, 24, '#ff8a3d', 3],
      [0, 1, 0, 40, 40, '#2a0c0a', 1]],
    scenery: 'cliffs', ambient: 'embers',
  },
  // the Underside: where everything that falls ends up — black water light, glowing spores, crystal roots
  abyss: {
    sky: { top: '#010103', mid: '#03040d', hor: '#0a1a2c', bot: '#020309', glow: '#1de9b6', glowK: 9, glowI: 0.14 },
    body: null, stars: 0.55, starCol: '#7cf7d4', aurora: { a: '#0f766e', b: '#6d28d9', amt: 0.26 },
    fog: ['#050b16', 0.021], hemi: ['#5b86e0', '#2a1352', 0.8], key: ['#a4f7e4', 2.0, [0.22, 0.9, -0.32]], rim: ['#2ee6c8', 3.0],
    env: 0.5, envSky: 0.45, exposure: 1.06, bloom: [0.95, 0.55, 0.9], accent: ['#2ee6c8', '#a855f7'], crystal: '#2ee6c8',
    haze: '#08142a', hazeK: 0.0072, vig: 0.42, sat: 1.06, heat: 0, dust: '#5fe3c8',
    tint: { stone: '#9fb0d8', rock: '#8f95c0', metal: '#b0c2e8', wood: '#8f86a8', sand: '#98a4c4', grass: '#6fd6c0', ice: '#9fd8ff', soil: '#7a7898' },
    cards: [[0, -1, 0, 40, 40, '#0d9488', 1.8], [0.7, 0.1, 0.7, 20, 8, '#2ee6c8', 2.2], [-0.7, 0.2, -0.6, 10, 20, '#7c3aed', 2.2],
      [0, 1, 0, 30, 30, '#0b1020', 0.8], [-0.4, 0.05, 0.9, 14, 6, '#22d3ee', 1.4]],
    scenery: 'spires', ambient: 'spores',
  },
};

// The Underside mood that setDepth() blends any theme toward (a hero who fell below the level).
const DEEP = THEMES.abyss;
const VEIL_FS = `
uniform vec3 uColor; uniform float uOpacity; uniform vec3 uGlow; varying vec3 vDir;
void main() {
  float y = normalize(vDir).y;
  vec3 c = uColor + uGlow * exp(-abs(y + 0.15) * 7.0) * 0.6;
  gl_FragColor = vec4(c, uOpacity);
}`;

// ---------- deterministic randomness and tileable noise ----------
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(x, y, z) {
  let h = 2166136261 ^ Math.round(x * 97);
  h = Math.imul(h, 16777619) ^ Math.round(y * 89);
  h = Math.imul(h, 16777619) ^ Math.round(z * 83);
  return Math.imul(h, 16777619) >>> 0;
}
// Periodic value noise: `cells` lattice cells across an n×n tile, so the result tiles seamlessly.
function valueNoise(n, cells, seed) {
  const r = rng(seed);
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const out = new Float32Array(n * n);
  const k = cells / n;
  for (let y = 0; y < n; y++) {
    const fy = y * k, iy = Math.floor(fy);
    let ty = fy - iy; ty = ty * ty * (3 - 2 * ty);
    const r0 = (iy % cells) * cells, r1 = ((iy + 1) % cells) * cells;
    for (let x = 0; x < n; x++) {
      const fx = x * k, ix = Math.floor(fx);
      let tx = fx - ix; tx = tx * tx * (3 - 2 * tx);
      const c0 = ix % cells, c1 = (ix + 1) % cells;
      const a = lat[r0 + c0], b = lat[r0 + c1], c = lat[r1 + c0], d = lat[r1 + c1];
      out[y * n + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}
function fbm(n, cells, oct, seed, gain = 0.5) {
  const out = new Float32Array(n * n);
  let amp = 1, tot = 0;
  for (let o = 0; o < oct; o++) {
    const c = cells << o;
    if (c > n) break;
    const v = valueNoise(n, c, seed + o * 131);
    for (let i = 0; i < out.length; i++) out[i] += v[i] * amp;
    tot += amp; amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= tot;
  return out;
}
// Tileable Worley noise: nearest/second-nearest feature distance (cell units), nearest cell, offset to it.
// warp (pixels) bends the cells with a periodic noise field so cracks look organic rather than tiled.
function voronoi(n, cells, seed, warp = 0) {
  const wx = warp ? fbm(n, 4, 3, seed + 7) : null, wy = warp ? fbm(n, 4, 3, seed + 11) : null;
  const r = rng(seed);
  const px = new Float32Array(cells * cells), py = new Float32Array(cells * cells);
  for (let i = 0; i < px.length; i++) { px[i] = r(); py[i] = r(); }
  const f1 = new Float32Array(n * n), f2 = new Float32Array(n * n), id = new Int32Array(n * n);
  const ox = new Float32Array(n * n), oy = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const o0 = y * n + x;
      const gx = (x + 0.5 + (warp ? (wx[o0] - 0.5) * warp : 0)) / n * cells, cx = Math.floor(gx);
      const gy = (y + 0.5 + (warp ? (wy[o0] - 0.5) * warp : 0)) / n * cells, cy = Math.floor(gy);
      let d1 = 9, d2 = 9, best = 0, bx = 0, by = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const nx = cx + i, ny = cy + j;
          const k = (((ny % cells) + cells) % cells) * cells + (((nx % cells) + cells) % cells);
          const dx = nx + px[k] - gx, dy = ny + py[k] - gy;
          const d = dx * dx + dy * dy;
          if (d < d1) { d2 = d1; d1 = d; best = k; bx = dx; by = dy; } else if (d < d2) d2 = d;
        }
      }
      const o = y * n + x;
      f1[o] = Math.sqrt(d1); f2[o] = Math.sqrt(d2); id[o] = best; ox[o] = bx; oy[o] = by;
    }
  }
  return { f1, f2, id, ox, oy };
}

// ---------- procedural canvases: drawn once per page, shared by every renderer ----------
const PAINTED = new Map();
function painted(key, fn) {
  let v = PAINTED.get(key);
  if (!v) { v = fn(); PAINTED.set(key, v); }
  return v;
}
function cnv(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function pixels(c, fn) {
  const g = c.getContext('2d');
  const im = g.createImageData(c.width, c.height);
  fn(im.data);
  g.putImageData(im, 0, 0);
  return g;
}
// Calls fn at (x, y) and at the wrapped copies that touch the tile, so marks near an edge tile seamlessly.
function wrapped(n, x, y, m, fn) {
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const X = x + i * n, Y = y + j * n;
      if (X > -m && X < n + m && Y > -m && Y < n + m) fn(X, Y);
    }
  }
}
function rrect(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function polyline(g, pts) {
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]);
  g.stroke();
}

// Sci-fi panels: dark glossy plating with glowing circuit traces (neon) or brushed steel with tread (metal).
// map = albedo · data = R height (bump), G roughness, B metalness · glow = emissive mask.
function paintPanels(neon) {
  const N = 512;
  const rects = neon
    ? [[0, 0, 256, 256], [256, 0, 256, 128], [256, 128, 256, 128], [0, 256, 128, 256], [128, 256, 128, 128], [128, 384, 128, 128], [256, 256, 256, 256]]
    : [[0, 0, 512, 256], [0, 256, 256, 256], [256, 256, 256, 256]];
  const pid = new Int8Array(N * N), dist = new Float32Array(N * N), lit = new Uint8Array(N * N);
  rects.forEach(([x0, y0, w, h], k) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const l = x - x0, rr = x0 + w - 1 - x, t = y - y0, b = y0 + h - 1 - y;
        const m = Math.min(l, rr, t, b), i = y * N + x;
        pid[i] = k; dist[i] = m; lit[i] = m === t || m === l ? 1 : 0;
      }
    }
  });
  const r = rng(neon ? 41 : 42);
  const tone = rects.map(() => 0.86 + r() * 0.3);
  const big = fbm(N, 4, 4, neon ? 43 : 44), grain = fbm(N, 32, 3, neon ? 45 : 46);
  const lat = Array.from({ length: 128 }, r);
  const base = neon ? [34, 32, 56] : [128, 134, 148];
  const map = cnv(N), data = cnv(N);
  const gm = pixels(map, (d) => {
    for (let y = 0, i = 0; y < N; y++) {
      const f = y / N * 128, k0 = Math.floor(f);
      const streak = lat[k0 % 128] * (k0 + 1 - f) + lat[(k0 + 1) % 128] * (f - k0);
      for (let x = 0; x < N; x++, i++) {
        const m = dist[i];
        let v = tone[pid[i]] * (0.8 + 0.32 * big[i]) + (grain[i] - 0.5) * (neon ? 0.16 : 0.08);
        if (!neon) v += (streak - 0.5) * 0.16;
        if (m < 2) v = 0.18; else if (m < 5) v *= lit[i] ? 1.45 : 0.6;
        d[i * 4] = base[0] * v; d[i * 4 + 1] = base[1] * v; d[i * 4 + 2] = base[2] * v; d[i * 4 + 3] = 255;
      }
    }
  });
  const gd = pixels(data, (d) => {
    for (let i = 0; i < N * N; i++) {
      const m = dist[i];
      let h = 235 + big[i] * 20, ro = (neon ? 80 : 100) + big[i] * 70 + grain[i] * 40;
      let me = neon ? 190 : 205;
      if (m < 2) { h = 0; ro = 235; me = 50; } else if (m < 5) h = (m - 2) / 3 * 235;
      d[i * 4] = h; d[i * 4 + 1] = ro; d[i * 4 + 2] = me; d[i * 4 + 3] = 255;
    }
  });
  for (const [x0, y0, w, h] of rects) {         // rivets in every panel corner
    for (const [cx, cy] of [[x0 + 11, y0 + 11], [x0 + w - 11, y0 + 11], [x0 + 11, y0 + h - 11], [x0 + w - 11, y0 + h - 11]]) {
      const gr = gm.createRadialGradient(cx - 1.5, cy - 1.5, 0.5, cx, cy, 4.5);
      gr.addColorStop(0, neon ? '#9893c4' : '#eef1f7');
      gr.addColorStop(1, neon ? '#121019' : '#4a4e58');
      gm.fillStyle = gr; gm.beginPath(); gm.arc(cx, cy, 4.2, 0, TAU); gm.fill();
      gd.fillStyle = 'rgb(255,100,235)'; gd.beginPath(); gd.arc(cx, cy, 4.2, 0, TAU); gd.fill();
    }
  }
  let glow = null;
  if (neon) {
    glow = cnv(N);
    const gg = glow.getContext('2d');
    gg.fillStyle = '#000'; gg.fillRect(0, 0, N, N);
    const traces = [
      [[30, 64], [150, 64], [150, 190], [226, 190]],
      [[38, 226], [38, 132], [104, 132]],
      [[286, 296], [404, 296], [404, 418], [482, 418]],
      [[300, 486], [300, 380], [352, 380]],
      [[150, 300], [150, 358], [232, 358]],
    ];
    gm.lineCap = gd.lineCap = gg.lineCap = 'round';
    traces.forEach((pts, k) => {
      gm.strokeStyle = 'rgba(0,0,0,0.65)'; gm.lineWidth = 5; polyline(gm, pts);
      gm.strokeStyle = 'rgba(150,140,220,0.22)'; gm.lineWidth = 1.5; polyline(gm, pts.map(([x, y]) => [x + 2, y + 2]));
      gd.strokeStyle = 'rgb(90,200,140)'; gd.lineWidth = 5; polyline(gd, pts);
      for (const [px, py] of [pts[0], pts[pts.length - 1]]) { gm.fillStyle = '#1a1830'; gm.beginPath(); gm.arc(px, py, 6, 0, TAU); gm.fill(); }
      if (k === 1) return;                       // one trace stays dark
      gg.strokeStyle = '#fff'; gg.fillStyle = '#fff'; gg.lineWidth = 2.2; gg.shadowColor = '#fff'; gg.shadowBlur = 7;
      polyline(gg, pts);
      for (const [px, py] of [pts[0], pts[pts.length - 1]]) { gg.beginPath(); gg.arc(px, py, 4.5, 0, TAU); gg.fill(); }
    });
    gg.shadowBlur = 0;
    for (let j = 0; j < 4; j++) {                // vent slots with a faint light behind them
      const y = 22 + j * 24;
      gm.fillStyle = '#06050b'; rrect(gm, 292, y, 186, 10, 5); gm.fill();
      gd.fillStyle = 'rgb(10,230,30)'; rrect(gd, 292, y, 186, 10, 5); gd.fill();
      gg.fillStyle = 'rgba(255,255,255,0.3)'; rrect(gg, 296, y + 3, 178, 4, 2); gg.fill();
    }
    gg.shadowColor = '#fff'; gg.shadowBlur = 6; gg.fillStyle = '#fff';
    for (const [x, y] of [[462, 150], [476, 150], [490, 150], [200, 470], [214, 470]]) {
      gg.fillRect(x - 4, y - 2, 8, 4);
      gm.fillStyle = '#8fa0c8'; gm.fillRect(x - 4, y - 2, 8, 4);
    }
  } else {
    for (let j = 0; j < 7; j++) {                 // diamond tread on the big plate
      for (let i = 0; i < 16; i++) {
        const cx = 24 + i * 30 + (j % 2) * 15, cy = 26 + j * 30;
        if (cx > 490 || cy > 232) continue;
        const a = (i + j) % 2 ? 0.785 : -0.785;
        for (const [g, c, o] of [[gm, 'rgba(0,0,0,0.45)', 1.5], [gm, '#d9dee8', 0], [gd, 'rgb(255,60,250)', 0]]) {
          g.save(); g.translate(cx + o, cy + o); g.rotate(a); g.fillStyle = c; rrect(g, -10, -3, 20, 6, 3); g.fill(); g.restore();
        }
      }
    }
  }
  return { map, data, glow };
}

// Cut stone: an ashlar of uneven blocks with chipped edges and hairline cracks.
function paintStone() {
  const N = 512, r = rng(21);
  const pid = new Int16Array(N * N), dist = new Float32Array(N * N);
  let y0 = 0, k = 0;
  while (y0 < N) {
    let h = Math.round(54 + r() * 46);
    if (N - y0 - h < 46) h = N - y0;
    const off = Math.floor(r() * N);
    let x0 = 0;
    while (x0 < N) {
      let w = Math.round(78 + r() * 120);
      if (N - x0 - w < 64) w = N - x0;
      for (let y = y0; y < y0 + h; y++) {
        for (let xx = x0; xx < x0 + w; xx++) {
          const i = y * N + ((xx + off) % N);
          pid[i] = k; dist[i] = Math.min(xx - x0, x0 + w - 1 - xx, y - y0, y0 + h - 1 - y);
        }
      }
      x0 += w; k++;
    }
    y0 += h;
  }
  const tone = Array.from({ length: k }, () => 0.78 + r() * 0.38);
  const warm = Array.from({ length: k }, () => (r() - 0.5) * 0.12);
  const nA = fbm(N, 8, 5, 22), nB = fbm(N, 32, 3, 23);
  const map = cnv(N), data = cnv(N);
  const gm = pixels(map, (d) => {
    for (let i = 0; i < N * N; i++) {
      const e = dist[i] - (nB[i] - 0.5) * 7, p = pid[i];
      let v = tone[p] * (0.72 + 0.4 * nA[i]) + (nB[i] - 0.5) * 0.18, wr = warm[p];
      if (e < 3) { v = 0.4 + nB[i] * 0.12; wr = 0; } else if (e < 7) v *= 0.82 + (e - 3) * 0.045;
      d[i * 4] = 150 * v * (1 + wr); d[i * 4 + 1] = 146 * v; d[i * 4 + 2] = 160 * v * (1 - wr); d[i * 4 + 3] = 255;
    }
  });
  pixels(data, (d) => {
    for (let i = 0; i < N * N; i++) {
      const e = dist[i] - (nB[i] - 0.5) * 7;
      d[i * 4] = e < 3 ? 20 : Math.min(1, (e - 3) / 8) * (190 + 65 * nA[i]);
      d[i * 4 + 1] = e < 3 ? 250 : 185 + nB[i] * 60; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
    }
  });
  gm.strokeStyle = 'rgba(30,26,36,0.55)'; gm.lineWidth = 1.2;
  for (let c = 0; c < 9; c++) {
    let x = 40 + r() * (N - 80), y = 40 + r() * (N - 80), a = r() * TAU;
    gm.beginPath(); gm.moveTo(x, y);
    for (let s = 0; s < 12; s++) { a += (r() - 0.5) * 1.1; x += Math.cos(a) * 5; y += Math.sin(a) * 5; gm.lineTo(x, y); }
    gm.stroke();
  }
  return { map, data };
}

function paintRock() {
  const N = 256;
  const n = fbm(N, 4, 6, 32), m = fbm(N, 16, 3, 33), vo = voronoi(N, 3, 34, 60), patch = fbm(N, 2, 3, 35);
  const map = cnv(N), data = cnv(N);
  pixels(map, (d) => {
    for (let y = 0, i = 0; y < N; y++) {
      for (let x = 0; x < N; x++, i++) {
        const crack = sstep(0.05, 0.0, vo.f2[i] - vo.f1[i]) * sstep(0.35, 0.6, patch[i]);
        const strata = 0.5 + 0.5 * Math.sin((y / N * 6 + n[i] * 2.2) * TAU);
        const tint = (vo.id[i] % 7) / 7 - 0.5;
        const v = (0.45 + n[i] * 0.65 + (m[i] - 0.5) * 0.3 + strata * 0.08) * (1 - crack * 0.45);
        d[i * 4] = 122 * v * (1 + tint * 0.08); d[i * 4 + 1] = 112 * v; d[i * 4 + 2] = 122 * v * (1 - tint * 0.08); d[i * 4 + 3] = 255;
      }
    }
  });
  pixels(data, (d) => {
    for (let i = 0; i < N * N; i++) {
      const crack = sstep(0.05, 0.0, vo.f2[i] - vo.f1[i]) * sstep(0.35, 0.6, patch[i]);
      d[i * 4] = (n[i] * 0.7 + m[i] * 0.3) * 255 * (1 - crack * 0.8); d[i * 4 + 1] = 215 + m[i] * 40; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
    }
  });
  return { map, data };
}

function paintGrass() {
  const N = 256, r = rng(51);
  const n = fbm(N, 4, 5, 52), m = fbm(N, 16, 3, 53);
  const map = cnv(N);
  const g = pixels(map, (d) => {
    for (let i = 0; i < N * N; i++) {
      const v = n[i], dry = sstep(0.62, 0.8, m[i]);
      d[i * 4] = (54 + v * 60) * (1 + dry * 0.5); d[i * 4 + 1] = 112 + v * 70; d[i * 4 + 2] = 36 + v * 22; d[i * 4 + 3] = 255;
    }
  });
  g.lineCap = 'round';
  for (let k = 0; k < 2400; k++) {               // blades seen from above
    const x = r() * N, y = r() * N, a = r() * TAU, l = 2 + r() * 4, light = r() < 0.5;
    g.strokeStyle = light ? `rgba(165,222,96,${0.35 + r() * 0.3})` : `rgba(20,70,25,${0.3 + r() * 0.3})`;
    g.lineWidth = 1 + r();
    wrapped(N, x, y, 8, (X, Y) => { g.beginPath(); g.moveTo(X, Y); g.lineTo(X + Math.cos(a) * l, Y + Math.sin(a) * l); g.stroke(); });
  }
  const petals = ['#fff7e0', '#ffd166', '#ff9ec7', '#b9a6ff'];
  for (let k = 0; k < 36; k++) {
    const x = r() * N, y = r() * N;
    g.fillStyle = petals[k % 4];
    wrapped(N, x, y, 4, (X, Y) => { g.beginPath(); g.arc(X, Y, 1.6, 0, TAU); g.fill(); });
  }
  return { map };
}

function paintSoil() {
  const N = 256, r = rng(61);
  const n = fbm(N, 6, 5, 62);
  const map = cnv(N);
  const g = pixels(map, (d) => {
    for (let i = 0; i < N * N; i++) {
      const v = 0.65 + n[i] * 0.6;
      d[i * 4] = 112 * v; d[i * 4 + 1] = 78 * v; d[i * 4 + 2] = 56 * v; d[i * 4 + 3] = 255;
    }
  });
  for (let k = 0; k < 70; k++) {                 // pebbles
    const x = r() * N, y = r() * N, rx = 2 + r() * 5, ry = rx * (0.5 + r() * 0.4), sh = 120 + r() * 70;
    wrapped(N, x, y, 8, (X, Y) => {
      g.fillStyle = 'rgba(40,26,18,0.5)'; g.beginPath(); g.ellipse(X + 1, Y + 1.5, rx, ry, 0, 0, TAU); g.fill();
      g.fillStyle = `rgb(${sh | 0},${(sh * 0.92) | 0},${(sh * 0.85) | 0})`; g.beginPath(); g.ellipse(X, Y, rx, ry, 0, 0, TAU); g.fill();
    });
  }
  return { map };
}

function paintWood() {
  const N = 256, r = rng(71);
  const n = fbm(N, 8, 4, 72), fine = fbm(N, 64, 2, 73);
  const PL = 6, ph = N / PL;
  const tone = Array.from({ length: PL }, () => 0.76 + r() * 0.36);
  const joints = Array.from({ length: PL }, () => (r() < 0.6 ? Math.floor(r() * N) : -999));
  const seamAt = (x, y) => { const p = Math.min(PL - 1, Math.floor(y / ph)); return y - Math.floor(p * ph) < 2 || (joints[p] >= 0 && (x - joints[p] + N) % N < 2); };
  const map = cnv(N), data = cnv(N);
  const g = pixels(map, (d) => {
    for (let y = 0, i = 0; y < N; y++) {
      const p = Math.min(PL - 1, Math.floor(y / ph));
      for (let x = 0; x < N; x++, i++) {
        const grain = 0.5 + 0.5 * Math.sin((x / N * 3 + n[i] * 3.5 + p * 0.37) * TAU * 2);
        let v = tone[Math.min(PL - 1, p)] * (0.72 + 0.3 * grain * grain + (fine[i] - 0.5) * 0.2);
        if (seamAt(x, y)) v *= 0.35;
        d[i * 4] = 152 * v; d[i * 4 + 1] = 110 * v; d[i * 4 + 2] = 74 * v; d[i * 4 + 3] = 255;
      }
    }
  });
  pixels(data, (d) => {
    for (let y = 0, i = 0; y < N; y++) {
      for (let x = 0; x < N; x++, i++) {
        const s = seamAt(x, y);
        d[i * 4] = s ? 0 : 200 + n[i] * 55; d[i * 4 + 1] = s ? 250 : 175 + fine[i] * 60; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
      }
    }
  });
  g.fillStyle = 'rgba(30,20,14,0.85)';
  for (let p = 0; p < PL; p++) {
    if (joints[p] < 0) continue;
    for (const dx of [-7, 7]) {
      const x = (joints[p] + dx + N) % N, y = p * ph + ph / 2;
      for (const dy of [-6, 6]) { g.beginPath(); g.arc(x, y + dy, 1.6, 0, TAU); g.fill(); }
    }
  }
  return { map, data };
}

function paintSand() {
  const N = 256;
  const n = fbm(N, 4, 4, 81), f = fbm(N, 64, 2, 82);
  const map = cnv(N), data = cnv(N);
  const rip = (y, i) => 0.5 + 0.5 * Math.sin((y / N * 10 + n[i] * 1.6) * TAU);
  pixels(map, (d) => {
    for (let y = 0, i = 0; y < N; y++) {
      for (let x = 0; x < N; x++, i++) {
        const v = 0.84 + rip(y, i) * 0.1 + (f[i] - 0.5) * 0.22 + (n[i] - 0.5) * 0.12;
        d[i * 4] = 226 * v; d[i * 4 + 1] = 198 * v; d[i * 4 + 2] = 150 * v; d[i * 4 + 3] = 255;
      }
    }
  });
  pixels(data, (d) => {
    for (let y = 0, i = 0; y < N; y++) {
      for (let x = 0; x < N; x++, i++) { d[i * 4] = rip(y, i) * 180 + f[i] * 75; d[i * 4 + 1] = 245; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255; }
    }
  });
  return { map, data };
}

// Basalt with a network of glowing cracks (cell edges of Worley noise).
function paintBasalt() {
  const N = 256;
  const vo = voronoi(N, 4, 91, 50), n = fbm(N, 8, 4, 92), f = fbm(N, 32, 2, 93), patch = fbm(N, 2, 3, 94);
  const map = cnv(N), data = cnv(N), glow = cnv(N);
  pixels(map, (d) => {
    for (let i = 0; i < N * N; i++) {
      const e = vo.f2[i] - vo.f1[i], crack = sstep(0.09, 0.0, e);
      const t = (vo.id[i] * 0.618) % 1;
      const v = ((0.55 + t * 0.35) * (0.7 + 0.5 * n[i]) + (f[i] - 0.5) * 0.25) * (1 - sstep(0.16, 0.03, e) * 0.5);
      d[i * 4] = 52 * v + crack * 90; d[i * 4 + 1] = 40 * v + crack * 20; d[i * 4 + 2] = 42 * v; d[i * 4 + 3] = 255;
    }
  });
  pixels(data, (d) => {
    for (let i = 0; i < N * N; i++) {
      const e = vo.f2[i] - vo.f1[i];
      d[i * 4] = sstep(0.0, 0.18, e) * (200 + n[i] * 55); d[i * 4 + 1] = 200 + f[i] * 55; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255;
    }
  });
  pixels(glow, (d) => {
    for (let i = 0; i < N * N; i++) {
      const e = vo.f2[i] - vo.f1[i];
      const p = sstep(0.38, 0.62, patch[i]);
      const c = sstep(0.06, 0.0, e) * (0.35 + 0.65 * n[i]) * p, k = Math.min(1, c + sstep(0.14, 0.0, e) * 0.2 * p);
      d[i * 4] = 255 * k; d[i * 4 + 1] = (70 + 150 * c) * k; d[i * 4 + 2] = 30 * c * k; d[i * 4 + 3] = 255;
    }
  });
  return { map, data, glow };
}

// Crystal facets: every Worley cell shades like a cut face; bright edges glow.
function paintCrystal() {
  const N = 256, r = rng(103);
  const vo = voronoi(N, 5, 101, 14), n = fbm(N, 8, 3, 102);
  const dirs = new Float32Array(50);
  for (let k = 0; k < 25; k++) { const a = r() * TAU; dirs[k * 2] = Math.cos(a); dirs[k * 2 + 1] = Math.sin(a); }
  const map = cnv(N), glow = cnv(N);
  pixels(map, (d) => {
    for (let i = 0; i < N * N; i++) {
      const id = vo.id[i], e = vo.f2[i] - vo.f1[i];
      const sh = 0.55 + 0.45 * (-(vo.ox[i] * dirs[id * 2] + vo.oy[i] * dirs[id * 2 + 1]) / 0.7);
      let v = clamp(sh, 0.2, 1.1) * (0.85 + 0.15 * n[i]);
      if (e < 0.03) v = 1.15;
      d[i * 4] = 210 * v; d[i * 4 + 1] = 230 * v; d[i * 4 + 2] = 245 * v; d[i * 4 + 3] = 255;
    }
  });
  pixels(glow, (d) => {
    for (let i = 0; i < N * N; i++) {
      const e = vo.f2[i] - vo.f1[i];
      const k = Math.min(1, sstep(0.05, 0.0, e) * 0.9 + sstep(0.5, 0.0, vo.f1[i]) * 0.35 * n[i] + 0.08);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255 * k; d[i * 4 + 3] = 255;
    }
  });
  return { map, glow };
}

function paintIce() {
  const N = 256, r = rng(114);
  const n = fbm(N, 4, 5, 111), vo = voronoi(N, 4, 112, 40), f = fbm(N, 32, 2, 113);
  const map = cnv(N);
  const g = pixels(map, (d) => {
    for (let i = 0; i < N * N; i++) {
      const crack = sstep(0.035, 0.0, vo.f2[i] - vo.f1[i]);
      const v = 0.82 + n[i] * 0.16 + (f[i] - 0.5) * 0.08;
      d[i * 4] = (205 + crack * 50) * v; d[i * 4 + 1] = (232 + crack * 23) * v; d[i * 4 + 2] = 255 * v; d[i * 4 + 3] = 255;
    }
  });
  g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1;
  for (let k = 0; k < 40; k++) {
    const x = r() * N, y = r() * N, rad = 1 + r() * 2.5;
    wrapped(N, x, y, 4, (X, Y) => { g.beginPath(); g.arc(X, Y, rad, 0, TAU); g.stroke(); });
  }
  return { map };
}

// Shader noise: R low-frequency fbm, G higher fbm, B Worley cell edges (0 on an edge). Opaque on purpose:
// a canvas stores premultiplied alpha, so the alpha channel cannot carry independent data.
function paintNoise() {
  const N = 256;
  const a = fbm(N, 4, 5, 201), b = fbm(N, 8, 4, 202), vo = voronoi(N, 8, 203);
  const c = cnv(N);
  pixels(c, (d) => {
    for (let i = 0; i < N * N; i++) {
      d[i * 4] = a[i] * 255; d[i * 4 + 1] = b[i] * 255; d[i * 4 + 2] = Math.min(1, (vo.f2[i] - vo.f1[i]) * 1.6) * 255; d[i * 4 + 3] = 255;
    }
  });
  return c;
}
function paintDot() {
  const c = cnv(64), g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.16, 'rgba(255,255,255,0.9)');
  gr.addColorStop(0.42, 'rgba(255,255,255,0.3)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return c;
}
function paintRing() {
  const c = cnv(256), g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.05)');
  gr.addColorStop(0.84, 'rgba(255,255,255,0.45)'); gr.addColorStop(0.93, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  return c;
}
// A flat-bottomed cumulus puff: alpha = density, grey = vertical shading (lit top, darker base).
function paintCloud() {
  const N = 256, c = cnv(N), g = c.getContext('2d'), r = rng(301);
  for (let k = 0; k < 26; k++) {
    const x = 46 + r() * 164, dx = (x - 128) / 82;
    const y = 158 - (1 - dx * dx) * (26 + r() * 40) - r() * 10, rad = 22 + (1 - Math.abs(dx)) * 26 + r() * 10;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
  }
  g.globalCompositeOperation = 'source-atop';
  const sh = g.createLinearGradient(0, 70, 0, 185);
  sh.addColorStop(0, '#ffffff'); sh.addColorStop(1, '#7c7c7c');
  g.fillStyle = sh; g.fillRect(0, 0, N, N);
  g.globalCompositeOperation = 'destination-out';
  const cut = g.createLinearGradient(0, 160, 0, 196);
  cut.addColorStop(0, 'rgba(0,0,0,0)'); cut.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = cut; g.fillRect(0, 160, N, N - 160);
  g.globalCompositeOperation = 'source-over';
  return c;
}
function paintBlades() {
  const c = cnv(128), g = c.getContext('2d'), r = rng(311);
  for (let k = 0; k < 24; k++) {
    const x = 12 + r() * 104, h = 58 + r() * 66, lean = (r() - 0.5) * 30, w = 3 + r() * 4;
    const gr = g.createLinearGradient(0, 128, 0, 128 - h);
    gr.addColorStop(0, '#2c6620'); gr.addColorStop(1, r() < 0.5 ? '#aee062' : '#7cc443');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(x - w, 128);
    g.quadraticCurveTo(x + lean * 0.3, 128 - h * 0.6, x + lean, 128 - h);
    g.quadraticCurveTo(x + lean * 0.3 + w * 0.5, 128 - h * 0.5, x + w, 128);
    g.closePath(); g.fill();
  }
  for (let k = 0; k < 4; k++) {                  // a few tiny flowers
    g.fillStyle = ['#fff3c4', '#ff9ec7', '#ffd166', '#c4b5fd'][k];
    g.beginPath(); g.arc(20 + r() * 88, 30 + r() * 40, 3.5, 0, TAU); g.fill();
  }
  return c;
}

// ---------- GLSL ----------
const HASH = `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
`;

// Sky dome: drawn last among opaque objects at the far plane, so geometry in front skips its pixels.
const SKY_VS = `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
}`;
const SKY_FS = `
uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHor; uniform vec3 uBot; uniform vec3 uGlow;
uniform float uGlowK; uniform float uTime;
uniform vec3 uSunDir; uniform vec3 uSunCol; uniform float uSunSize;
uniform vec3 uColA; uniform vec3 uColB; uniform float uAmt;
uniform vec3 uCloudLit; uniform vec3 uCloudDark; uniform float uCloud;
uniform float uStars; uniform vec3 uStarCol;
uniform sampler2D uNoise;
varying vec3 vDir;
${HASH}
float stars(vec3 d, float scale, float keep, float size) {
  vec3 p = d * scale; vec3 c = floor(p); vec3 f = fract(p);
  float h = hash13(c);
  if (h > keep) return 0.0;
  vec3 o = vec3(hash13(c + 17.1), hash13(c + 31.7), hash13(c + 47.3)) * 0.5 + 0.25;
  float tw = 0.6 + 0.4 * sin(uTime * (0.7 + h * 30.0) + h * 91.0);
  return smoothstep(size, 0.0, length(f - o)) * tw * (0.35 + 0.65 * hash13(c + 5.0));
}
void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  vec3 col = y > 0.0
    ? mix(mix(uHor, uMid, smoothstep(0.0, 0.22, y)), uTop, smoothstep(0.18, 0.85, y))
    : mix(uHor, uBot, smoothstep(0.0, -0.28, y));
  col += uGlow * exp(-abs(y) * uGlowK);
  vec2 eq = vec2(atan(d.z, d.x) / 6.2831853, asin(clamp(y, -1.0, 1.0)) / 3.1415927);
  #ifdef NEBULA
    float n = textureLod(uNoise, eq * 2.0 + vec2(uTime * 0.002, 0.0), 0.0).r;
    float n2 = textureLod(uNoise, eq * vec2(5.0, 4.0) - vec2(uTime * 0.003, 0.0), 0.0).g;
    float neb = smoothstep(0.45, 0.85, n * 0.65 + n2 * 0.45) * smoothstep(0.0, 0.2, y) * (1.0 - smoothstep(0.5, 0.95, y));
    col += mix(uColA, uColB, n2) * neb * uAmt;
  #endif
  #ifdef AURORA
    float cur = textureLod(uNoise, vec2(eq.x * 3.0 + uTime * 0.004, 0.2), 0.0).r;
    float cur2 = textureLod(uNoise, vec2(eq.x * 7.0 - uTime * 0.006, 0.6 + y * 0.3), 0.0).g;
    float band = smoothstep(0.03, 0.2, y) * (1.0 - smoothstep(0.3, 0.75, y));
    float au = pow(smoothstep(0.38, 0.9, cur * 0.6 + cur2 * 0.5), 2.0) * band;
    col += mix(uColA, uColB, smoothstep(0.05, 0.55, y)) * au * uAmt;
  #endif
  #ifdef STARS
    float sv = (stars(d, 110.0, 0.035, 0.24) + stars(d, 230.0, 0.05, 0.27) * 0.6) * smoothstep(0.02, 0.3, y);
    col += uStarCol * sv * uStars;
  #endif
  #ifdef CLOUDS
    if (y > -0.02) {
      vec2 cp = d.xz / (max(y, 0.0) + 0.1) * 0.2 + vec2(uTime * 0.004, uTime * 0.0015);
      float c1 = texture2D(uNoise, cp).r; float c2 = texture2D(uNoise, cp * 2.7 + 0.3).g;
      float cl = smoothstep(0.46, 0.78, c1 * 0.7 + c2 * 0.4) * smoothstep(-0.02, 0.08, y) * (1.0 - smoothstep(0.3, 0.8, y));
      float sunSide = pow(max(dot(d, uSunDir), 0.0), 4.0);
      vec3 cc = mix(uCloudDark, uCloudLit, clamp(c2 * 0.7 + sunSide * 0.6, 0.0, 1.0));
      col = mix(col, cc, cl * uCloud);
    }
  #endif
  #if defined(SUN) || defined(MOON)
    float ang = acos(clamp(dot(d, uSunDir), -1.0, 1.0));
    float disc = 1.0 - smoothstep(uSunSize * 0.965, uSunSize, ang);
    #ifdef MOON
      vec3 t1 = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
      vec3 t2 = cross(t1, uSunDir);
      vec2 mp = vec2(dot(d, t1), dot(d, t2)) / sin(uSunSize);
      float maria = textureLod(uNoise, mp * 0.22 + vec2(0.31, 0.57), 0.0).r;
      float fine = textureLod(uNoise, mp * 0.9 + vec2(0.13, 0.71), 0.0).g;
      vec2 cg = mp * 3.4 + 7.0; vec2 cid = floor(cg); vec2 cf = fract(cg) - 0.5;
      float ch = hash12(cid);
      float cr = length(cf - (vec2(hash12(cid + 3.3), hash12(cid + 8.1)) - 0.5) * 0.4) / (0.1 + 0.14 * fract(ch * 7.1));
      float crater = step(ch, 0.5) * (smoothstep(1.15, 0.9, cr) * smoothstep(0.75, 0.95, cr) * 0.22 - smoothstep(0.85, 0.3, cr) * 0.14);
      float limb = sqrt(max(0.0, 1.0 - dot(mp, mp)));
      vec3 moon = uSunCol * (0.6 + 0.4 * limb) * (1.0 - 0.3 * smoothstep(0.4, 0.68, maria)) * (0.92 + 0.12 * fine + crater);
      moon *= mix(vec3(1.0), vec3(1.0, 0.84, 0.95), smoothstep(0.2, -1.0, mp.y));
      col = mix(col, moon, disc);
      col += uSunCol * (exp(-ang * 6.0) * 0.08 + exp(-ang * 24.0) * 0.16) * (1.0 - disc);
    #else
      col += uSunCol * 0.35 * pow(max(dot(d, uSunDir), 0.0), 5.0) * exp(-abs(y) * 5.0);
      col = mix(col, uSunCol * 4.0, disc);
      col += uSunCol * (exp(-ang * 5.0) * 0.16 + exp(-ang * 20.0) * 0.3 + exp(-ang * 80.0) * 0.9) * (1.0 - disc);
    #endif
  #endif
  gl_FragColor = vec4(col, 1.0);
}`;

// Neon skyline towers (instanced unit boxes): lit window grids, neon signs, crowns, billboards, haze.
const TOWER_VS = `
${HASH}
varying vec3 vLocal; varying vec3 vN; varying vec3 vW; varying vec3 vScale; varying float vSeed;
void main() {
  vec3 scl = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vLocal = position * scl;
  vScale = scl;
  vN = normal;
  vW = wp.xyz;
  vSeed = hash12(instanceMatrix[3].xz * 0.0173 + 0.31);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const TOWER_FS = `
${HASH}
uniform float uTime; uniform vec3 uHaze; uniform float uHazeK; uniform float uFloorY;
uniform vec3 uA; uniform vec3 uB; uniform vec3 uWarm; uniform vec3 uLow;
varying vec3 vLocal; varying vec3 vN; varying vec3 vW; varying vec3 vScale; varying float vSeed;
void main() {
  vec3 n = normalize(vN);
  float s = vSeed;
  vec3 surf = mix(vec3(0.012, 0.01, 0.03), vec3(0.006, 0.02, 0.03), step(0.6, fract(s * 13.7))) * (0.6 + 0.8 * fract(s * 5.1));
  vec3 emit = vec3(0.0);
  vec3 sc = fract(s * 11.0) > 0.5 ? uA : uB;
  if (abs(n.y) < 0.5) {
    bool xf = abs(n.x) > 0.5;
    float face = xf ? (n.x > 0.0 ? 1.0 : 2.0) : (n.z > 0.0 ? 3.0 : 4.0);
    float u = xf ? vLocal.z * sign(n.x) : -vLocal.x * sign(n.z);
    float halfW = (xf ? vScale.z : vScale.x) * 0.5;
    float v = vLocal.y;
    vec2 g = vec2((u + halfW) / 1.8, v / 3.3);
    vec2 id = floor(g); vec2 f = fract(g);
    float win = step(0.12, f.x) * step(f.x, 0.88) * step(0.24, f.y) * step(f.y, 0.8);
    float h = hash12(id + vec2(face * 17.0, s * 91.0));
    float floorOn = step(0.22, hash12(vec2(id.y * 1.7, s * 47.0 + face)));
    float lit = step(h, 0.16 + 0.34 * fract(s * 7.31)) * floorOn;
    vec3 wc = mix(uWarm, vec3(0.7, 0.82, 1.0), step(0.55, fract(h * 13.7)));
    wc = mix(wc, uA, step(0.94, fract(h * 29.3)));
    float flick = 1.0 - 0.7 * step(0.993, hash12(vec2(floor(uTime * 4.0), h * 61.0)));
    emit += wc * win * lit * (0.3 + 0.6 * fract(h * 31.7)) * flick;
    surf += vec3(0.02, 0.018, 0.045) * win * (1.0 - lit);
    // vertical neon sign on one face of some towers
    if (s > 0.55 && face == 1.0 + floor(fract(s * 3.7) * 4.0)) {
      float x0 = halfW - 2.4;
      float y0 = vScale.y * 0.45;
      float inBand = step(abs(u - x0), 0.8) * step(y0, v) * step(v, y0 + 14.0 + 12.0 * fract(s * 9.0));
      float seg = step(0.28, fract(v / 1.8)) * step(0.2, fract((u - x0) / 1.6 + 0.5));
      float on = step(0.12, fract(uTime * 0.17 + s * 4.0));
      emit += sc * inBand * (0.35 + 2.4 * seg * on);
    }
    // billboard on the upper floors of wide towers
    if (halfW > 8.5 && fract(s * 5.3) < 0.2) {
      float top = vScale.y;
      float inB = step(abs(u), halfW * 0.72) * step(top - 26.0, v) * step(v, top - 8.0);
      float wave = 0.5 + 0.5 * sin(u * 0.25 + v * 0.12 + uTime * 1.3 + s * 20.0);
      float scan = 0.7 + 0.3 * step(0.5, fract(v * 0.9 - uTime * 1.5));
      emit += mix(uA, uB, wave) * inB * scan * 0.7;
    }
    // glowing crown line under the roof, neon outlines on the corners of some towers
    float crown = step(vScale.y - 1.3, v) * (1.0 - step(vScale.y - 0.5, v)) * step(0.4, fract(s * 17.3));
    emit += sc * crown * 2.0;
    float corner = step(halfW - 0.35, abs(u)) * step(0.72, fract(s * 29.1)) * smoothstep(vScale.y * 0.2, vScale.y, v);
    emit += sc * corner * 1.4;
  } else {
    surf = vec3(0.018, 0.014, 0.032);
  }
  float dist = length(vW - cameraPosition);
  float hz = 1.0 - exp(-dist * uHazeK);
  float low = 1.0 - smoothstep(uFloorY, uFloorY + 85.0, vW.y);
  vec3 col = mix(surf, uHaze, clamp(hz * 0.92, 0.0, 1.0));
  col += uLow * low * low;
  col += emit * (1.0 - hz * 0.78);
  gl_FragColor = vec4(col, 1.0);
}`;

// Generic far-scenery shading (rocks, cliffs, islands): lambert + hemisphere + rim, light from below, haze.
const LIT_VS = `
uniform vec3 uBase;
varying vec3 vN; varying vec3 vW; varying vec3 vC;
void main() {
  #ifdef USE_INSTANCING
    mat4 m = modelMatrix * instanceMatrix;
  #else
    mat4 m = modelMatrix;
  #endif
  vec4 wp = m * vec4(position, 1.0);
  vN = normalize(transpose(inverse(mat3(m))) * normal);
  vC = uBase;
  #ifdef USE_COLOR
    vC *= color;
  #endif
  #ifdef USE_INSTANCING_COLOR
    vC *= instanceColor;
  #endif
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const LIT_FS = `
uniform vec3 uKey; uniform vec3 uKeyCol; uniform float uKeyK; uniform vec3 uSkyC; uniform vec3 uGndC; uniform float uAmbK;
uniform vec3 uHaze; uniform float uHazeK; uniform vec3 uRimC; uniform vec3 uGlow; uniform float uGlowY; uniform float uGlowK;
uniform sampler2D uNoise; uniform float uTime;
varying vec3 vN; varying vec3 vW; varying vec3 vC;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  vec3 light = uKeyCol * uKeyK * max(dot(n, uKey), 0.0) + mix(uGndC, uSkyC, n.y * 0.5 + 0.5) * uAmbK;
  vec3 col = vC * light;
  col += uRimC * pow(1.0 - max(dot(n, v), 0.0), 4.0);
  float below = exp(-max(vW.y - uGlowY, 0.0) * uGlowK);
  col += uGlow * below * (0.55 - 0.45 * n.y);
  #ifdef VEINS
    float e = texture2D(uNoise, vec2(vW.x + vW.z, vW.y) * 0.017).b;
    float area = smoothstep(0.52, 0.72, texture2D(uNoise, vec2(vW.x - vW.z, vW.y) * 0.006).r);
    float vein = (1.0 - smoothstep(0.0, 0.05, e)) * area;
    col += uGlow * vein * (0.12 + 1.2 * below) * (0.75 + 0.25 * sin(uTime * 1.3 + vW.y * 0.2));
  #endif
  float dist = length(vW - cameraPosition);
  col = mix(col, uHaze, 1.0 - exp(-dist * uHazeK));
  gl_FragColor = vec4(col, 1.0);
}`;

// Glowing crystal prisms (instanced): facets, inner light rising to the tip, fresnel edges.
const CRYSTAL_VS = `
uniform float uTime;
varying vec3 vN; varying vec3 vW; varying float vH; varying vec3 vC;
void main() {
  mat4 m = modelMatrix * instanceMatrix;
  vec4 wp = m * vec4(position, 1.0);
  #ifdef BOB
    float ph = dot(instanceMatrix[3].xyz, vec3(0.31, 0.17, 0.23));
    wp.y += sin(uTime * 0.6 + ph) * 0.7;
  #endif
  vN = normalize(transpose(inverse(mat3(m))) * normal);
  vH = position.y;
  #ifdef USE_INSTANCING_COLOR
    vC = instanceColor;
  #else
    vC = vec3(0.3, 0.9, 1.0);
  #endif
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const CRYSTAL_FS = `
uniform vec3 uHaze; uniform float uHazeK; uniform float uTime; uniform sampler2D uNoise; uniform float uGain;
varying vec3 vN; varying vec3 vW; varying float vH; varying vec3 vC;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(cameraPosition - vW);
  float fres = pow(1.0 - abs(dot(n, v)), 3.0);
  float facet = 0.55 + 0.45 * dot(n, normalize(vec3(0.4, 0.75, 0.5)));
  float stri = texture2D(uNoise, vec2((vW.x + vW.z) * 0.03, vH * 1.3 - uTime * 0.01)).g;
  float inner = pow(clamp(vH, 0.0, 1.0), 1.6);
  vec3 col = vC * (0.04 + 0.16 * facet) + vC * inner * (0.55 + 0.7 * stri) + mix(vC, vec3(1.0), 0.45) * fres * 1.1;
  col *= (0.85 + 0.15 * sin(uTime * 0.8 + vW.x * 0.05 + vW.z * 0.07)) * uGain;
  float hz = 1.0 - exp(-length(vW - cameraPosition) * uHazeK);
  col = mix(col, uHaze, hz * 0.88);
  gl_FragColor = vec4(col, 1.0);
}`;

// Waterfalls and lava falls: vertical strips with flowing streaks.
const FLOW_VS = `
attribute float aLen; attribute float aSeed;
varying vec2 vUv; varying float vLen; varying float vSeed; varying vec3 vW;
void main() {
  vUv = uv; vLen = aLen; vSeed = aSeed;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FLOW_FS = `
uniform float uTime; uniform vec3 uCore; uniform vec3 uEdge; uniform sampler2D uNoise; uniform vec3 uHaze; uniform float uHazeK; uniform float uSpeed;
varying vec2 vUv; varying float vLen; varying float vSeed; varying vec3 vW;
void main() {
  float x = vUv.x * 2.0 - 1.0;
  float y = 1.0 - vUv.y;
  float spread = 0.6 + 0.4 * y;                 // narrow at the lip, wider as it falls
  float w = 1.0 - smoothstep(0.3 * spread, spread, abs(x));
  vec2 q = vec2(vUv.x * 1.5 + vSeed * 7.0, y * vLen * 0.045 - uTime * uSpeed);
  float n = texture2D(uNoise, q).r * 0.6 + texture2D(uNoise, q * vec2(3.0, 0.5) + 0.37).g * 0.6;
  float streak = smoothstep(0.4, 0.9, n);
  #ifdef LAVA
    vec3 col = mix(uEdge * 0.3, uEdge, smoothstep(0.3, 0.62, n));
    col = mix(col, uCore, smoothstep(0.62, 0.95, n) * w);
    col *= 0.55 + 0.6 * w;
    float a = w * (0.85 + 0.15 * streak);
  #else
    vec3 col = mix(uEdge, uCore, streak) * (0.75 + 0.6 * streak);
    float a = w * (0.4 + 0.5 * streak) * (1.0 - smoothstep(0.65, 1.0, y));
  #endif
  a *= smoothstep(0.0, 0.02, y);
  float hz = 1.0 - exp(-length(vW - cameraPosition) * uHazeK);
  col = mix(col, uHaze, hz * 0.6);
  gl_FragColor = vec4(col, a);
}`;

// Far planes below the arena: a sea of clouds or a lava lake.
const SEA_VS = `
varying vec3 vW;
void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;
const SEA_FS = `
uniform float uTime; uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform vec3 uHaze; uniform float uHazeK; uniform sampler2D uNoise; uniform vec3 uSun;
varying vec3 vW;
void main() {
  vec3 v = normalize(cameraPosition - vW);
  float dist = length(vW - cameraPosition);
  #ifdef LAVA
    vec2 p = vW.xz * 0.011;
    vec2 w = vec2(texture2D(uNoise, p * 0.5 + uTime * 0.003).r, texture2D(uNoise, p * 0.5 - uTime * 0.002 + 0.5).g) - 0.5;
    float n = texture2D(uNoise, p + w * 0.45 + vec2(uTime * 0.004, 0.0)).r;
    float e = texture2D(uNoise, p * 2.2 + w * 0.3 + vec2(0.0, uTime * 0.002)).b;
    float crust = smoothstep(0.42, 0.6, n) * smoothstep(0.03, 0.14, e);
    vec3 col = mix(uA * 1.6, uB, n);
    col = mix(col, uC, crust);
    col *= 0.9 + 0.1 * sin(uTime * 1.1 + n * 9.0);
  #else
    vec2 p = vW.xz * 0.0045 + vec2(uTime * 0.0015, uTime * 0.0008);
    float c = texture2D(uNoise, p).r * 0.6 + texture2D(uNoise, p * 3.0 + 0.2).g * 0.4;
    vec3 col = mix(uB, uA, smoothstep(0.32, 0.74, c));
    float sun = pow(max(dot(vec3(-v.x, v.y, -v.z), uSun), 0.0), 6.0);
    col += uC * sun * 0.5;
  #endif
  col = mix(col, uHaze, 1.0 - exp(-dist * uHazeK));
  gl_FragColor = vec4(col, 1.0);
}`;

// Billboard cloud puffs (instanced quads facing the camera); also used for smoke and mist.
const CLOUD_VS = `
attribute vec3 aOffset; attribute vec3 aParams;
uniform float uTime; uniform vec3 uSunDir;
varying vec2 vUv; varying vec3 vW; varying float vLit;
void main() {
  vec3 c = aOffset;
  c.x += sin(uTime * 0.02 + aParams.z * 6.28) * 4.0;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  mv.xy += position.xy * aParams.xy;
  gl_Position = projectionMatrix * mv;
  vUv = uv; vW = c;
  vec3 sv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  vLit = dot(normalize(vec3(position.xy * 2.0, 0.5)), sv) * 0.5 + 0.5;
}`;
const CLOUD_FS = `
uniform sampler2D uMap; uniform vec3 uLit; uniform vec3 uDark; uniform vec3 uHaze; uniform float uHazeK; uniform float uOpacity;
varying vec2 vUv; varying vec3 vW; varying float vLit;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * uOpacity;
  if (a < 0.01) discard;
  #ifdef SMOKE
    float shade = mix(1.0 - t.r, vLit, 0.3);
  #else
    float shade = mix(t.r, vLit, 0.45);
  #endif
  vec3 col = mix(uDark, uLit, shade);
  col = mix(col, uHaze, (1.0 - exp(-length(vW - cameraPosition) * uHazeK)) * 0.85);
  gl_FragColor = vec4(col, a);
}`;

// Ambient particles that live in a box around the camera (wrapped in the shader: no CPU work per frame).
const AMB_VS = `
attribute vec4 aSeed;
uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform float uScale; uniform float uSize; uniform float uMotion;
uniform vec3 uColA; uniform vec3 uColB;
varying vec4 vCol;
void main() {
  float t = uTime * uMotion;
  vec3 p = position;
  float a = 1.0;
  #if defined(SPORES)
    p += vec3(sin(t * 0.21 + aSeed.x * 6.28) * 2.0, t * (0.12 + aSeed.y * 0.25), cos(t * 0.17 + aSeed.z * 6.28) * 2.0);
    a = 0.55 + 0.45 * sin(t * (0.8 + aSeed.w * 1.5) + aSeed.x * 20.0);
  #elif defined(POLLEN)
    p += vec3(t * (0.5 + aSeed.x * 0.4), sin(t * 0.6 + aSeed.y * 6.28) * 0.8 + t * 0.05, t * 0.22 + cos(t * 0.4 + aSeed.z * 6.28));
    a = 0.45 + 0.55 * sin(t * 2.3 + aSeed.w * 30.0);
  #elif defined(EMBERS)
    p += vec3(sin(t * 1.1 + aSeed.x * 12.0) * 0.8 + t * 0.4, t * (1.4 + aSeed.y * 2.2), cos(t * 0.9 + aSeed.z * 12.0) * 0.8);
    a = 0.6 + 0.4 * sin(t * 9.0 + aSeed.w * 40.0);
  #endif
  vec3 rel = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 q = abs(rel) / (uBox * 0.5);
  float edge = (1.0 - smoothstep(0.7, 1.0, max(q.x, max(q.y, q.z)))) * smoothstep(0.6, 2.0, length(rel));
  vec4 mv = viewMatrix * vec4(uCam + rel, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * (0.5 + aSeed.w) * uScale / max(-mv.z, 0.3), 0.0, 40.0);
  vec3 c = mix(uColA, uColB, aSeed.z);
  #ifdef EMBERS
    c = mix(uColA, uColB, smoothstep(-0.45, 0.4, rel.y / uBox.y));
  #endif
  vCol = vec4(c, a * edge);
}`;
const AMB_FS = `
varying vec4 vCol;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c) * 4.0;
  float a = exp(-d * 3.5) * (1.0 - smoothstep(0.7, 1.0, d)) * vCol.a;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol.rgb, a);
}`;
// Rain glints: 1-px streaks (two vertices per drop share the seed; the tail trails along the fall direction).
const RAIN_VS = `
attribute vec4 aSeed; attribute float aEnd;
uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform float uMotion; uniform vec3 uColA; uniform vec3 uColB;
varying vec4 vCol;
void main() {
  float t = uTime * uMotion;
  float speed = 17.0 + aSeed.y * 8.0;
  vec3 vel = vec3(1.6, -speed, 0.6);
  vec3 p = position + vel * t;
  vec3 rel = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 q = abs(rel) / (uBox * 0.5);
  float edge = (1.0 - smoothstep(0.65, 1.0, max(q.x, max(q.y, q.z)))) * smoothstep(1.5, 4.5, length(rel));
  vec3 wp = uCam + rel - normalize(vel) * (0.45 + aSeed.x * 0.55) * aEnd;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  vCol = vec4(mix(uColA, uColB, step(0.5, aSeed.w)), (1.0 - aEnd) * edge * (0.2 + 0.4 * aSeed.z));
}`;
const RAIN_FS = `
varying vec4 vCol;
void main() { gl_FragColor = vCol; }`;
// Neon city lights: traffic on elliptical lanes around the arena and blinking roof beacons.
const CITY_VS = `
attribute vec4 aSeed;
uniform float uTime; uniform float uScale; uniform vec4 uArena; uniform float uMotion;
varying vec4 vCol;
void main() {
  vec3 wp;
  vec3 c;
  float size;
  if (aSeed.w < 0.5) {
    float lane = position.x;
    float ang = aSeed.x * 6.2831853 + uTime * uMotion * aSeed.y / (lane + 80.0);
    wp = vec3(uArena.x + cos(ang) * (uArena.z + lane), position.y, uArena.y + sin(ang) * (uArena.w + lane));
    c = aSeed.y > 0.0 ? vec3(1.6, 1.5, 1.3) : vec3(1.8, 0.15, 0.12);
    c = mix(c, vec3(0.3, 1.4, 2.0), step(0.85, aSeed.z));
    size = 1.1;
  } else {
    wp = position;
    c = vec3(2.2, 0.12, 0.1) * step(0.55, fract(uTime * 0.5 + aSeed.x));
    size = 1.6;
  }
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(size * uScale / max(-mv.z, 1.0), 1.5, 14.0);
  vCol = vec4(c, 1.0);
}`;

// Pooled effect particles: soft canvas sprite, size and colour per particle.
const FXP_VS = `
attribute vec4 aColor; attribute float aSize;
uniform float uScale;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize <= 0.0 ? 0.0 : clamp(aSize * uScale / max(-mv.z, 0.1), 1.0, 160.0);
  vColor = aColor;
}`;
const FXP_FS = `
uniform sampler2D uMap;
varying vec4 vColor;
void main() {
  float a = texture2D(uMap, gl_PointCoord).a * vColor.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;
// Beam: a camera-facing strip from uFrom to uTo with a white-hot core, coloured glow and jitter.
const BEAM_VS = `
attribute float aT; attribute float aSide;
uniform vec3 uFrom; uniform vec3 uTo; uniform float uWidth; uniform float uTime; uniform float uSeed;
varying float vSide; varying float vT;
void main() {
  vec3 dir = uTo - uFrom;
  float len = max(length(dir), 1e-4);
  vec3 d = dir / len;
  vec3 p = uFrom + dir * aT;
  vec3 side = normalize(cross(d, normalize(cameraPosition - p)) + vec3(1e-5));
  vec3 up2 = cross(side, d);
  float env = sin(aT * 3.14159);
  float j = sin(aT * len * 2.1 + uTime * 61.0 + uSeed) * 0.6 + sin(aT * len * 5.3 - uTime * 43.0 + uSeed * 3.0) * 0.4;
  float k = cos(aT * len * 3.7 + uTime * 53.0 + uSeed * 1.7);
  p += (side * j + up2 * k * 0.6) * uWidth * 0.9 * env;
  p += side * aSide * uWidth * 3.2;
  vSide = aSide; vT = aT;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const BEAM_FS = `
uniform vec3 uCol; uniform float uAlpha;
varying float vSide; varying float vT;
void main() {
  float x = abs(vSide);
  float core = exp(-x * x * 120.0);
  float glow = exp(-x * x * 7.0);
  float ends = smoothstep(0.0, 0.02, vT) * smoothstep(1.0, 0.985, vT);
  gl_FragColor = vec4((uCol * glow * 1.7 + vec3(1.0) * core * 2.6) * uAlpha * ends, 1.0);
}`;
// Ribbon trails (positions written on the CPU each frame into preallocated buffers).
const RIB_VS = `
attribute float aA; attribute float aSide;
varying float vA; varying float vSide;
void main() { vA = aA; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RIB_FS = `
uniform vec3 uCol;
varying float vA; varying float vSide;
void main() {
  float s = 1.0 - vSide * vSide;
  gl_FragColor = vec4(uCol * (s * 0.8 + pow(s, 8.0) * 1.4) * vA, 1.0);
}`;
// Glowing edge strips on static blocks (unlit; colour per vertex or from the theme accents).
const STRIP_VS = `
attribute vec3 aCol; attribute float aSel;
varying vec3 vCol; varying float vSel; varying vec3 vW;
#include <fog_pars_vertex>
void main() {
  vCol = aCol; vSel = aSel;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const STRIP_FS = `
uniform vec3 uA; uniform vec3 uB; uniform float uTime; uniform float uGain;
varying vec3 vCol; varying float vSel; varying vec3 vW;
#include <fog_pars_fragment>
void main() {
  vec3 c = vSel < 0.5 ? vCol : (vSel < 1.5 ? uA : uB);
  float pulse = 0.82 + 0.18 * sin(uTime * 2.2 - (vW.x + vW.z) * 0.45);
  gl_FragColor = vec4(c * uGain * pulse, 1.0);
  #include <fog_fragment>
}`;

// Animated level surfaces: lava, water, void (abyss with depth) and energy (forcefield).
const SURF_VS = `
uniform float uTime;
varying vec3 vW; varying vec2 vUv; varying vec3 vN;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 nrm = normalize(mat3(modelMatrix) * normal);
  #ifdef WATER
    float edge = smoothstep(0.0, 0.06, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    float a1 = wp.x * 0.9 + uTime * 1.5;
    float a2 = wp.z * 1.25 - uTime * 1.15 + wp.x * 0.35;
    wp.y += (sin(a1) * 0.05 + sin(a2) * 0.04) * edge;
    nrm = normalize(vec3(-(cos(a1) * 0.045 + cos(a2) * 0.014) * edge, 1.0, -cos(a2) * 0.05 * edge));
  #endif
  vN = nrm;
  vW = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const SURF_FS = `
${HASH}
uniform float uTime; uniform sampler2D uNoise; uniform vec2 uSize;
uniform vec3 uA; uniform vec3 uB; uniform vec3 uSky; uniform vec3 uSunDir; uniform vec3 uSunCol;
varying vec3 vW; varying vec2 vUv; varying vec3 vN;
#include <fog_pars_fragment>
float hexDist(vec2 p) { p = abs(p); return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x); }
void main() {
  vec2 e2 = min(vUv, 1.0 - vUv) * uSize;
  float ed = min(e2.x, e2.y);
  vec3 v = normalize(cameraPosition - vW);
  vec4 outc = vec4(0.0, 0.0, 0.0, 1.0);
  #if defined(LAVA)
    vec2 p = vW.xz * 0.16;
    float t = uTime;
    vec2 w = vec2(texture2D(uNoise, p * 0.5 + vec2(t * 0.02, 0.0)).r, texture2D(uNoise, p * 0.5 + vec2(0.0, t * 0.017) + 0.5).g) - 0.5;
    float n = texture2D(uNoise, p + w * 0.7 + vec2(t * 0.012, -t * 0.008)).r;
    float cell = texture2D(uNoise, p * 0.9 + w * 0.35 + vec2(-t * 0.01, t * 0.006)).b;
    float crust = smoothstep(0.44, 0.62, n) * smoothstep(0.04, 0.18, cell);
    float heat = 1.0 - crust;
    vec3 c = mix(uB, uA, smoothstep(0.35, 1.0, heat * 0.75 + n * 0.35)) * (0.55 + 1.25 * heat * heat);
    c = mix(c, vec3(0.05, 0.012, 0.008) * (0.6 + n * 0.6), crust * 0.9);
    c *= 0.88 + 0.12 * sin(t * 1.7 + n * 12.0);
    c += uA * (1.0 - smoothstep(0.0, 0.6, ed)) * 0.6;
    outc = vec4(c, 1.0);
  #elif defined(WATER)
    vec2 p = vW.xz * 0.35;
    float n1 = texture2D(uNoise, p + vec2(uTime * 0.03, uTime * 0.02)).g;
    float n2 = texture2D(uNoise, p * 1.7 - vec2(uTime * 0.025, -uTime * 0.035)).r;
    vec3 n = normalize(vN + vec3(n1 - 0.5, 0.0, n2 - 0.5) * 0.35);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    vec3 c = mix(uB, uA, 0.3 + 0.5 * n1);
    c = mix(c, uSky, fres * 0.7);
    float bands = smoothstep(0.012, 0.0, abs(n1 - 0.52)) + smoothstep(0.012, 0.0, abs(n2 - 0.48)) * 0.6;
    c += vec3(0.85, 0.95, 1.0) * bands * 0.22;
    float foam = 1.0 - smoothstep(0.05, 0.4 + n2 * 0.35, ed);
    c = mix(c, vec3(0.9, 0.97, 1.0), foam * 0.75);
    vec3 h = normalize(uSunDir + v);
    c += uSunCol * pow(max(dot(n, h), 0.0), 140.0) * 4.0;
    outc = vec4(c, clamp(0.7 + fres * 0.25 + foam * 0.3, 0.0, 1.0));
  #elif defined(VOID)
    vec3 dir = -v;
    vec3 c = vec3(0.006, 0.003, 0.016);
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec2 q = vW.xz + dir.xz / max(-dir.y, 0.12) * (2.5 + fi * 5.0);
      vec2 g = q * (1.3 - fi * 0.3);
      vec2 id = floor(g); vec2 f = fract(g);
      float h = hash12(id + fi * 17.0);
      vec2 o = vec2(hash12(id + 3.1), hash12(id + 7.7)) * 0.6 + 0.2;
      float s = smoothstep(0.1, 0.0, length(f - o)) * step(h, 0.1) * (0.55 + 0.45 * sin(uTime * 2.0 + h * 40.0));
      c += mix(uA, uB, fract(h * 8.0)) * s * (1.3 - fi * 0.35);
    }
    vec2 q2 = vW.xz * 0.07 + dir.xz / max(-dir.y, 0.2) * 0.35;
    float nb = texture2D(uNoise, q2 + vec2(uTime * 0.01, -uTime * 0.007)).r;
    float nb2 = texture2D(uNoise, q2 * 2.3 - vec2(uTime * 0.013, 0.0)).g;
    c += mix(uA, uB, nb2) * smoothstep(0.45, 0.9, nb * 0.7 + nb2 * 0.4) * 0.3;
    float rim = 1.0 - smoothstep(0.0, 0.55, ed);
    c += uB * rim * (1.1 + 0.4 * sin(uTime * 4.0 + (vW.x + vW.z) * 2.0));
    outc = vec4(c, 1.0);
  #elif defined(ENERGY)
    float fres = pow(1.0 - abs(dot(normalize(vN), v)), 2.0);
    vec2 q = vUv * uSize * 1.7;
    vec2 r = vec2(1.0, 1.7320508);
    vec2 a = mod(q, r) - r * 0.5;
    vec2 b = mod(q - r * 0.5, r) - r * 0.5;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    float edgeH = 0.5 - hexDist(gv);
    float line = 1.0 - smoothstep(0.0, 0.05, edgeH);
    float sw = fract((vUv.y * uSize.y) * 0.12 - uTime * 0.45);
    float sweep = smoothstep(0.0, 0.08, sw) * (1.0 - smoothstep(0.08, 0.35, sw));
    float flick = 0.88 + 0.12 * sin(uTime * 23.0 + hash12(floor(q)) * 6.28);
    float border = 1.0 - smoothstep(0.0, 0.3, ed);
    vec3 c = uA * (0.12 + line * 1.1 + sweep * 0.9 + fres * 0.7 + border * 1.4) * flick;
    outc = vec4(c, 1.0);
  #endif
  gl_FragColor = outc;
  #include <fog_fragment>
}`;

// Final grade before tone mapping: saturation, vignette and (lava) heat haze.
const GRADE_FS = `
uniform sampler2D tDiffuse; uniform sampler2D uNoise; uniform float uVig; uniform float uSat; uniform float uHeat; uniform float uTime;
varying vec2 vUv;
void main() {
  vec2 uv = vUv;
  if (uHeat > 0.0) {
    vec2 q = vec2(uv.x * 2.5, uv.y * 1.6 - uTime * 0.22);
    vec2 o = vec2(texture2D(uNoise, q).r, texture2D(uNoise, q + 0.5).g) - 0.5;
    uv += o * uHeat * (1.0 - smoothstep(0.15, 0.85, uv.y));
  }
  vec4 c = texture2D(tDiffuse, uv);
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  c.rgb = max(mix(vec3(l), c.rgb, uSat), 0.0);
  vec2 d = (vUv - 0.5) * vec2(1.0, 0.8);
  c.rgb *= 1.0 - uVig * smoothstep(0.3, 0.8, length(d) * 1.25);
  gl_FragColor = c;
}`;
const QUAD_VS = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

// ---------- small geometry helpers ----------
// Hexagonal (or n-sided) prism with a pointed tip, base at y = 0, height 1, radius 1, flat facets.
function prismGeometry(sides = 6, tip = 0.26) {
  const body = new THREE.CylinderGeometry(1, 1, 1 - tip, sides, 1, true).toNonIndexed();
  body.translate(0, (1 - tip) / 2, 0);
  const cap = new THREE.ConeGeometry(1, tip, sides, 1, true).toNonIndexed();
  cap.translate(0, 1 - tip / 2, 0);
  const g = THREE.mergeGeometries([body, cap]);
  g.computeVertexNormals();
  body.dispose(); cap.dispose();
  return g;
}
function flatGeometry(g, translateY = 0) {
  const n = g.toNonIndexed();
  g.dispose();
  if (translateY) n.translate(0, translateY, 0);
  n.computeVertexNormals();
  return n;
}
class Bag {
  constructor() { this.items = []; }
  add(x) { this.items.push(x); return x; }
  dispose() { for (const x of this.items) x.dispose(); this.items.length = 0; }
}

// ---------- materials ----------
// tex: canvas set · tile: metres per texture repeat on static blocks · rim: fresnel glow · env: reflections
const SPEC = {
  neon: { tex: 'neon', tile: 2, rough: 1, metal: 1, bump: 1.2, env: 1.1 },
  metal: { tex: 'metal', tile: 2, rough: 1, metal: 1, bump: 1.0, env: 1.2 },
  stone: { tex: 'stone', tile: 2.5, rough: 1, metal: 0, bump: 1.6, env: 0.7 },
  rock: { tex: 'rock', tile: 3, rough: 1, metal: 0, bump: 2.2, env: 0.6 },
  crystal: { tex: 'crystal', tile: 2, color: '#a8ecff', rough: 0.22, metal: 0.1, rim: true, rimPow: 2.5, env: 1.4 },
  glass: { color: '#a8dcff', rough: 0.05, metal: 0, opacity: 0.3, rim: true, rimPow: 2.2, env: 1.6 },
  ice: { tex: 'ice', tile: 2.5, color: '#d2ecff', rough: 0.16, metal: 0, rim: true, rimPow: 3, env: 1.0 },
  grass: { tex: 'grass', tile: 2.5, rough: 0.95, metal: 0, env: 0.5 },
  wood: { tex: 'wood', tile: 2, rough: 1, metal: 0, bump: 1.0, env: 0.6 },
  sand: { tex: 'sand', tile: 3, rough: 1, metal: 0, bump: 0.7, env: 0.5 },
  'lava-rock': { tex: 'basalt', tile: 2.5, rough: 1, metal: 0, bump: 1.6, env: 0.6 },
};
const PAINTERS = {
  neon: () => paintPanels(true), metal: () => paintPanels(false), stone: paintStone, rock: paintRock, grass: paintGrass,
  soil: paintSoil, wood: paintWood, sand: paintSand, basalt: paintBasalt, crystal: paintCrystal, ice: paintIce,
};
const HEX = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
function parseHex(s, fallback = '#ffffff') {
  if (typeof s === 'number') return s;
  if (typeof s === 'string' && HEX.test(s)) return s[0] === '#' ? s : '#' + s;
  if (typeof s === 'string' && /^0x[0-9a-f]{6}$/i.test(s)) return Number(s);
  return fallback;
}

// Static blocks: side faces darken towards the bottom (cheap ambient occlusion), top lips catch light, and
// grass blocks show soil below a ragged turf edge. aBlock = (distance below the block's top, block height).
const STATIC_FRAG = (grass) => `
	float nrSide = 1.0 - smoothstep(0.55, 0.85, abs(vNy));
	float nrAbove = vBlock.y - vBlock.x;${grass ? `
	float nrEdge = 0.11 + 0.2 * texture2D(uNoiseTex, vec2(vMapUv.x * 0.9, 0.31)).r;
	float nrTurf = 1.0 - smoothstep(nrEdge - 0.012, nrEdge + 0.012, vBlock.x);
	float nrLip = (1.0 - smoothstep(0.0, 0.14, vBlock.x - nrEdge)) * (1.0 - nrTurf);
	vec3 nrSoil = texture2D(uSoil, vMapUv).rgb * uSoilTint;
	diffuseColor.rgb = mix(diffuseColor.rgb, nrSoil * (1.0 - 0.55 * nrLip), nrSide * (1.0 - nrTurf));` : ''}
	float nrAo = mix(0.5, 1.0, smoothstep(0.0, min(vBlock.y, 2.0), nrAbove));
	nrAo = mix(1.0, nrAo, nrSide) * (vNy < -0.5 ? 0.6 : 1.0);
	nrAo *= 1.0 + 0.28 * nrSide * (1.0 - smoothstep(0.015, 0.09, vBlock.x));
	diffuseColor.rgb *= nrAo;`;

function patchMaterial(m, o, U) {
  const key = 'nr' + (o.rim ? 'r' : '') + (o.stat ? 's' : '') + (o.grass ? 'g' : '') + (o.lava ? 'l' : '') + (o.pulse ? 'p' : '');
  if (key === 'nr') return;
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.time;
    let head = '\nuniform float uTime;';
    if (o.rim) { sh.uniforms.uRim = { value: o.rim }; sh.uniforms.uRimPow = { value: o.rimPow }; head += '\nuniform vec3 uRim;\nuniform float uRimPow;'; }
    if (o.grass) {
      sh.uniforms.uSoil = { value: o.grass }; sh.uniforms.uNoiseTex = U.noise; sh.uniforms.uSoilTint = { value: o.soilTint };
      head += '\nuniform sampler2D uSoil;\nuniform sampler2D uNoiseTex;\nuniform vec3 uSoilTint;';
    }
    let vs = sh.vertexShader;
    let fs = sh.fragmentShader;
    if (o.stat) {
      vs = vs.replace('#include <common>', '#include <common>\nattribute vec2 aBlock;\nvarying vec2 vBlock;\nvarying float vNy;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvBlock = aBlock;\n\tvNy = objectNormal.y;');
      head += '\nvarying vec2 vBlock;\nvarying float vNy;';
      fs = fs.replace('#include <color_fragment>', '#include <color_fragment>' + STATIC_FRAG(!!o.grass));
    }
    fs = fs.replace('#include <common>', '#include <common>' + head);
    let em = '';
    if (o.pulse) em += '\n\ttotalEmissiveRadiance *= 0.72 + 0.28 * sin(uTime * 1.7 + vMapUv.x * 5.0 + vMapUv.y * 3.0);';
    if (o.lava && o.stat) em += '\n\ttotalEmissiveRadiance += vec3(1.0, 0.3, 0.06) * 1.3 * exp(-nrAbove * 2.4) * nrSide;';
    if (o.rim) em += '\n\ttotalEmissiveRadiance += uRim * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), uRimPow);';
    if (em) fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + em);
    sh.vertexShader = vs;
    sh.fragmentShader = fs;
  };
}

function createMaterials(U, aniso) {
  const shared = new Map();
  const statics = new Map();
  const texs = new Map();
  const all = new Set();
  function texSet(name) {
    let t = texs.get(name);
    if (t) return t;
    const c = painted('mat:' + name, PAINTERS[name]);
    t = {};
    for (const k of ['map', 'data', 'glow']) {
      if (!c[k]) continue;
      const tx = new THREE.CanvasTexture(c[k]);
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      tx.colorSpace = k === 'data' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      tx.anisotropy = aniso;
      t[k] = tx;
    }
    texs.set(name, t);
    return t;
  }
  function tint(m) {
    const nr = m.userData.nr;
    const th = U.def;
    if (nr.name === 'glow') return;
    const sp = SPEC[nr.name];
    m.color.set(sp.color || '#ffffff');
    const tt = th && th.tint[nr.name];
    if (tt) m.color.multiply(tmpC.set(tt));
    if (nr.tint != null && nr.name !== 'neon') m.color.multiply(tmpC.set(nr.tint));
    m.envMapIntensity = sp.env ?? 1;
    if (nr.name === 'neon') {
      m.emissive.set(nr.tint ?? (th ? th.accent[0] : '#5ee7ff'));
      m.emissiveIntensity = 2.6;
    } else if (nr.name === 'crystal') {
      const c = nr.tint ?? (th ? th.crystal : '#5ee7ff');
      m.emissive.set(c); m.emissiveIntensity = 0.9;
      nr.rim.set(c).multiplyScalar(1.1);
      m.color.lerp(tmpC.set(c), 0.3);
    } else if (nr.name === 'lava-rock') {
      m.emissive.set('#ffffff'); m.emissiveIntensity = 1.7;
    } else if (nr.name === 'ice') {
      nr.rim.set(th ? th.crystal : '#8fdcff').multiplyScalar(0.3);
      m.emissive.set('#123047'); m.emissiveIntensity = 0.3;
    } else if (nr.name === 'glass') {
      nr.rim.set(th ? th.accent[0] : '#9fe8ff').multiplyScalar(0.9);
    }
    if (nr.soilTint) {
      nr.soilTint.set('#ffffff');
      const st = th && th.tint.soil;
      if (st) nr.soilTint.set(st);
    }
  }
  function build(name, tintHex, stat) {
    if (name.startsWith('glow:')) {
      const m = new THREE.MeshBasicMaterial({ color: col(parseHex(name.slice(5)), 2.1) });
      m.userData.nr = { name: 'glow' };
      return m;
    }
    const base = SPEC[name] ? name : 'stone';
    const sp = SPEC[base];
    const tx = sp.tex ? texSet(sp.tex) : {};
    const m = new THREE.MeshStandardMaterial({ roughness: sp.rough, metalness: sp.metal });
    if (tx.map) m.map = tx.map;
    if (tx.data) {
      m.roughnessMap = tx.data; m.bumpMap = tx.data; m.bumpScale = sp.bump || 1;
      if (sp.metal > 0) m.metalnessMap = tx.data;
    }
    if (tx.glow) { m.emissiveMap = tx.glow; m.emissive.set('#ffffff'); }
    if (sp.opacity) { m.transparent = true; m.opacity = sp.opacity; m.depthWrite = false; }
    const rim = sp.rim ? new THREE.Color() : null;
    const grass = base === 'grass' && stat ? texSet('soil').map : null;
    const soilTint = grass ? new THREE.Color() : null;
    patchMaterial(m, { rim, rimPow: sp.rimPow || 3, stat, grass, soilTint, lava: base === 'lava-rock', pulse: base === 'lava-rock' }, U);
    m.userData.nr = { name: base, tint: tintHex == null ? null : parseHex(tintHex), rim, soilTint };
    tint(m);
    return m;
  }
  function lookup(cache, name, t, stat) {
    const key = `${name}|${t ?? ''}`;
    let m = cache.get(key);
    if (!m) { m = build(String(name || 'stone'), t, stat); cache.set(key, m); all.add(m); }
    return m;
  }
  return {
    get: (name, t) => lookup(shared, name, t, false),
    getStatic: (name, t) => lookup(statics, name, t, true),
    tile: (name) => (SPEC[name] ? SPEC[name].tile || 2 : 2),
    tex: texSet,
    applyTheme() { for (const m of all) tint(m); },
    dispose() {
      for (const m of all) m.dispose();
      for (const t of texs.values()) for (const k in t) t[k].dispose();
      all.clear(); shared.clear(); statics.clear(); texs.clear();
    },
  };
}

// ---------- far scenery per theme ----------
// The arena (level bounds from buildStatic) decides where scenery goes so it never overlaps the level.
function litMaterial(U, th, o) {
  const mat = new THREE.ShaderMaterial({
    defines: o.veins ? { VEINS: '' } : {},
    uniforms: {
      uBase: { value: col(o.base || '#ffffff') }, uKey: U.keyDir, uKeyCol: U.keyCol, uKeyK: { value: o.keyK ?? 0.35 },
      uSkyC: U.hemiSky, uGndC: U.hemiGnd, uAmbK: { value: o.ambK ?? 0.35 }, uHaze: U.haze, uHazeK: { value: o.hazeK ?? th.hazeK },
      uRimC: { value: col(o.rim || '#000000', o.rimK ?? 1) }, uGlow: { value: col(o.glow || '#000000', o.glowK2 ?? 1) },
      uGlowY: { value: o.glowY ?? -1e4 }, uGlowK: { value: o.glowK ?? 0.05 }, uNoise: U.noise, uTime: U.time,
    },
    vertexShader: LIT_VS, fragmentShader: LIT_FS,
    vertexColors: !!o.vertexColors,
  });
  return mat;
}
function crystalMaterial(U, th, bob, gain = 1) {
  return new THREE.ShaderMaterial({
    defines: bob ? { BOB: '' } : {},
    uniforms: { uHaze: U.haze, uHazeK: { value: th.hazeK * 0.8 }, uTime: U.time, uNoise: U.noise, uGain: { value: gain } },
    vertexShader: CRYSTAL_VS, fragmentShader: CRYSTAL_FS,
  });
}
function cloudLayer(c, puffs, o) {
  const { bag, U, th } = c;
  puffs.sort((a, b) => b[6] - a[6]);                 // far first: a rough back-to-front order
  const base = bag.add(new THREE.PlaneGeometry(1, 1));
  const geo = bag.add(new THREE.InstancedBufferGeometry());
  geo.index = base.index;
  geo.setAttribute('position', base.attributes.position);
  geo.setAttribute('uv', base.attributes.uv);
  const off = new Float32Array(puffs.length * 3), par = new Float32Array(puffs.length * 3);
  puffs.forEach((p, i) => { off.set([p[0], p[1], p[2]], i * 3); par.set([p[3], p[4], p[5]], i * 3); });
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
  geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(par, 3));
  geo.instanceCount = puffs.length;
  const map = bag.add(new THREE.CanvasTexture(painted('cloud', paintCloud)));
  map.colorSpace = THREE.NoColorSpace;
  const mat = bag.add(new THREE.ShaderMaterial({
    defines: o.smoke ? { SMOKE: '' } : {},
    uniforms: {
      uMap: { value: map }, uLit: { value: col(o.lit) }, uDark: { value: col(o.dark) }, uHaze: U.haze, uHazeK: { value: o.hazeK ?? th.hazeK },
      uOpacity: { value: o.opacity ?? 0.95 }, uTime: U.time, uSunDir: o.sun || U.sunDir,
    },
    vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, transparent: true, depthWrite: false,
  }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  c.group.add(mesh);
  const n = puffs.length;
  return (k) => { geo.instanceCount = Math.max(1, Math.round(n * k)); };
}
function seaPlane(c, y, lava, o) {
  const { bag, U, th } = c;
  const geo = bag.add(new THREE.CircleGeometry(1600, 64));
  geo.rotateX(-Math.PI / 2);
  const mat = bag.add(new THREE.ShaderMaterial({
    defines: lava ? { LAVA: '' } : {},
    uniforms: {
      uTime: U.time, uA: { value: col(o.a) }, uB: { value: col(o.b) }, uC: { value: col(o.c) }, uHaze: U.haze,
      uHazeK: { value: o.hazeK ?? th.hazeK * 0.7 }, uNoise: U.noise, uSun: U.sunDir,
    },
    vertexShader: SEA_VS, fragmentShader: SEA_FS,
  }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(c.A.cx, y, c.A.cz);
  mesh.frustumCulled = false;
  c.group.add(mesh);
}
function flowStrips(c, falls, lava, o) {
  if (!falls.length) return;
  const { bag, U, th } = c;
  const parts = falls.map(([x, y, z, w, len, yaw, seed]) => {
    const g = new THREE.PlaneGeometry(w, len, 1, 6);
    g.translate(0, -len / 2, 0);
    g.rotateY(yaw);
    g.translate(x, y, z);
    const n = g.attributes.position.count;
    g.setAttribute('aLen', new THREE.BufferAttribute(new Float32Array(n).fill(len), 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(n).fill(seed), 1));
    return g;
  });
  const geo = bag.add(THREE.mergeGeometries(parts));
  for (const g of parts) g.dispose();
  const mat = bag.add(new THREE.ShaderMaterial({
    defines: lava ? { LAVA: '' } : {},
    uniforms: {
      uTime: U.time, uCore: { value: col(o.core, o.coreK ?? 1) }, uEdge: { value: col(o.edge, o.edgeK ?? 1) }, uNoise: U.noise, uHaze: U.haze,
      uHazeK: { value: th.hazeK * 0.8 }, uSpeed: { value: o.speed ?? 0.6 },
    },
    vertexShader: FLOW_VS, fragmentShader: FLOW_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  }));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  c.group.add(mesh);
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
function ringPoint(A, ang, d, out) {
  out.x = A.cx + Math.cos(ang) * (A.hx + d);
  out.z = A.cz + Math.sin(ang) * (A.hz + d);
  return out;
}

// Neon: night city — instanced towers with windows and signs, flying traffic, beacons.
function sceneryNeon(c) {
  const { A, bag, U, th, group } = c;
  const r = rng(1201);
  const geo = bag.add(new THREE.BoxGeometry(1, 1, 1));
  geo.translate(0, 0.5, 0);
  const floorY = A.minY - 140;
  const mat = bag.add(new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.time, uHaze: U.haze, uHazeK: { value: th.hazeK }, uFloorY: { value: A.minY - 90 }, uA: U.accentA, uB: U.accentB,
      uWarm: { value: col('#ffb46e') }, uLow: { value: col(th.sky.glow, 0.32) },
    },
    vertexShader: TOWER_VS, fragmentShader: TOWER_FS,
  }));
  const MAX = 220;   // = sum of the ring sizes below
  const towers = new THREE.InstancedMesh(geo, mat, MAX);
  towers.frustumCulled = false;
  const placed = [];
  const beacons = [];
  const pt = { x: 0, z: 0 };
  // three rings, each with its own budget: rooftops just below the level, a mid city, a tall far skyline
  const RINGS = [[62, 50, 90], [72, 150, 130], [86, 285, 170]];
  const moonAz = th.body ? Math.atan2(th.body.dir[2], th.body.dir[0]) : 0;
  for (let ring = 0, want = 0; ring < 3; ring++) {
    want += RINGS[ring][0];
    for (let tries = 0; placed.length < want && tries < RINGS[ring][0] * 30; tries++) {
    const ang = r() * TAU, d = RINGS[ring][1] + r() * RINGS[ring][2];
    ringPoint(A, ang, d, pt);
    const w = 10 + r() * 16 + ring * 5, dp = 10 + r() * 16 + ring * 5, rad = Math.hypot(w, dp) * 0.5;
    let ok = true;
    for (const o of placed) if ((o[0] - pt.x) ** 2 + (o[1] - pt.z) ** 2 < (o[2] + rad + 2) ** 2) { ok = false; break; }
    if (!ok) continue;
    placed.push([pt.x, pt.z, rad]);
    let top = [A.minY - 8 - r() * 26, A.minY - 15 + r() * 70, A.minY + 15 + r() * 110 + (r() < 0.2 ? 60 : 0)][ring];
    const off = Math.abs(((Math.atan2(pt.z - A.cz, pt.x - A.cx) - moonAz + Math.PI * 3) % TAU) - Math.PI);
    if (ring > 0 && off < 0.32) top = Math.min(top, A.minY - 5 + off * 60);   // keep the moon framed in a gap
    _q.setFromAxisAngle(UP, Math.atan2(A.cx - pt.x, A.cz - pt.z) + (r() - 0.5) * 0.3);
    _m4.compose(_p.set(pt.x, floorY, pt.z), _q, _s.set(w, top - floorY, dp));
    towers.setMatrixAt(placed.length - 1, _m4);
    if (r() < 0.4) beacons.push(pt.x + (r() - 0.5) * w * 0.6, top + 0.6 + r() * 4, pt.z + (r() - 0.5) * dp * 0.6);
    }
  }
  const count = placed.length;
  towers.count = count;
  towers.instanceMatrix.needsUpdate = true;
  group.add(towers);
  // traffic lanes + beacons in one Points draw
  const TN = 110, BN = beacons.length / 3, tot = TN + BN;
  const pos = new Float32Array(tot * 3), seed = new Float32Array(tot * 4);
  for (let i = 0; i < TN; i++) {
    pos[i * 3] = 45 + r() * 300; pos[i * 3 + 1] = A.minY - 50 + r() * 38; pos[i * 3 + 2] = 0;
    seed[i * 4] = r(); seed[i * 4 + 1] = (r() < 0.5 ? -1 : 1) * (16 + r() * 22); seed[i * 4 + 2] = r(); seed[i * 4 + 3] = 0;
  }
  for (let i = 0; i < BN; i++) {
    const k = TN + i;
    pos[k * 3] = beacons[i * 3]; pos[k * 3 + 1] = beacons[i * 3 + 1]; pos[k * 3 + 2] = beacons[i * 3 + 2];
    seed[k * 4] = r(); seed[k * 4 + 3] = 1;
  }
  const pg = bag.add(new THREE.BufferGeometry());
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const pm = bag.add(new THREE.ShaderMaterial({
    uniforms: { uTime: U.time, uScale: U.pscale, uArena: { value: new THREE.Vector4(A.cx, A.cz, A.hx, A.hz) }, uMotion: U.motion },
    vertexShader: CITY_VS, fragmentShader: AMB_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const lights = new THREE.Points(pg, pm);
  lights.frustumCulled = false;
  group.add(lights);
  return { lod(k) { towers.count = Math.max(1, Math.round(count * k)); pg.setDrawRange(0, Math.round(TN * k) + BN); } };
}

// Crystal: an underground cavern — giant glowing crystal clusters, stalagmites, stalactites, floating shards.
function sceneryCrystal(c) {
  const { A, bag, U, th, group } = c;
  const r = rng(1301);
  const prism = bag.add(prismGeometry(6, 0.26));
  const palette = ['#38e1ff', '#8b5cf6', '#22d3ee', '#c084fc', '#2dd4bf', '#f472b6'].map((h) => new THREE.Color(h));
  const items = [];
  const CL = 24;
  for (let k = 0; k < CL; k++) {
    const ang = (k + r() * 0.8) / CL * TAU, d = 58 + r() * 190;
    const pc = ringPoint(A, ang, d, { x: 0, z: 0 });
    const baseY = A.minY - 28 - r() * 22;
    const big = 0.55 + r() * 0.8 + d / 220;
    const n = 3 + Math.floor(r() * 5);
    const hue = palette[Math.floor(r() * palette.length)];
    for (let j = 0; j < n; j++) {
      const a2 = r() * TAU, o = j === 0 ? 0 : (3 + r() * 9) * big;
      items.push({
        x: pc.x + Math.cos(a2) * o, y: baseY, z: pc.z + Math.sin(a2) * o, a2,
        h: (j === 0 ? 42 + r() * 36 : 14 + r() * 32) * big, rad: (j === 0 ? 4.4 : 1.5 + r() * 2.6) * big,
        tilt: j === 0 ? r() * 0.12 : 0.18 + r() * 0.36, col: hue,
      });
    }
  }
  const smat = bag.add(crystalMaterial(U, th, false, 0.85));
  const spires = new THREE.InstancedMesh(prism, smat, items.length);
  items.forEach((it, i) => {
    _e.set(Math.sin(it.a2) * it.tilt, r() * TAU, -Math.cos(it.a2) * it.tilt);
    _m4.compose(_p.set(it.x, it.y, it.z), _q.setFromEuler(_e), _s.set(it.rad, it.h, it.rad));
    spires.setMatrixAt(i, _m4);
    spires.setColorAt(i, _c.copy(it.col).offsetHSL((r() - 0.5) * 0.04, 0, (r() - 0.5) * 0.1));
  });
  spires.frustumCulled = false;
  group.add(spires);
  // cave rock: stalagmites between the clusters and stalactites hanging from the vault
  const cone = bag.add(flatGeometry(new THREE.ConeGeometry(1, 1, 7, 1), 0.5));
  const rmat = bag.add(litMaterial(U, th, { base: '#1c1f40', rim: '#3a4fa0', rimK: 0.35, keyK: 0.22, ambK: 0.26, glow: '#1c3cff', glowK2: 0.1, glowY: A.minY - 40, glowK: 0.03 }));
  const RN = 64;
  const rocks = new THREE.InstancedMesh(cone, rmat, RN);
  const pt = { x: 0, z: 0 };
  for (let i = 0; i < RN; i++) {
    const down = i % 2 === 0;
    ringPoint(A, r() * TAU, 62 + r() * 220, pt);
    if (down) {
      const len = 26 + r() * 70, w = 4 + r() * 9;
      _m4.compose(_p.set(pt.x, A.maxY + 75 + r() * 35, pt.z), _q.setFromAxisAngle(XAXIS, Math.PI), _s.set(w, len, w));
    } else {
      const h = 30 + r() * 80, w = 5 + r() * 12;
      _m4.compose(_p.set(pt.x, A.minY - 45, pt.z), _q.setFromAxisAngle(UP, r() * TAU), _s.set(w, h, w));
    }
    rocks.setMatrixAt(i, _m4);
  }
  rocks.frustumCulled = false;
  group.add(rocks);
  // floating shards around the arena, bobbing slowly
  const FN = 30;
  const fmat = bag.add(crystalMaterial(U, th, true, 1.05));
  const floaters = new THREE.InstancedMesh(prism, fmat, FN);
  for (let i = 0; i < FN; i++) {
    ringPoint(A, r() * TAU, 16 + r() * 50, pt);
    const s = 0.45 + r() * 1.1;
    _e.set((r() - 0.5) * 1.2, r() * TAU, (r() - 0.5) * 1.2);
    _m4.compose(_p.set(pt.x, A.minY + r() * (A.maxY - A.minY + 16), pt.z), _q.setFromEuler(_e), _s.set(s * 0.45, s * 1.8, s * 0.45));
    floaters.setMatrixAt(i, _m4);
    floaters.setColorAt(i, _c.copy(palette[i % palette.length]));
  }
  floaters.frustumCulled = false;
  group.add(floaters);
  const nS = items.length;
  return { lod(k) { spires.count = Math.max(1, Math.round(nS * k)); rocks.count = Math.round(RN * k); floaters.count = Math.round(FN * k); } };
}

// A low-poly floating island: flat grassy top, rocky underside, a few trees; flat-shaded vertex colours.
function islandGeometry(r, noise, rad, x, y, z) {
  const parts = [];
  const topH = rad * 0.24;
  const depth = rad * (1.2 + r() * 0.9);
  const top = new THREE.CylinderGeometry(rad, rad * 0.93, topH, 18, 1).toNonIndexed();
  top.translate(0, -topH / 2, 0);
  const bot = new THREE.ConeGeometry(rad * 0.93, depth, 18, 5, true).toNonIndexed();
  bot.rotateX(Math.PI);
  bot.translate(0, -topH - depth / 2, 0);
  for (const g of [top, bot]) {
    const P = g.attributes.position;
    for (let i = 0; i < P.count; i++) {
      const px = P.getX(i), py = P.getY(i), pz = P.getZ(i);
      if (py > -0.01) continue;                     // keep the top flat
      const n = noise.noise3d((px + x) * 0.09, (py + y) * 0.09, (pz + z) * 0.09);
      const k = 1 + n * 0.22;
      P.setXYZ(i, px * k, py + n * rad * 0.1, pz * k);
    }
    g.deleteAttribute('uv');
    parts.push(g);
  }
  const trees = Math.floor(1 + r() * 5);
  for (let t = 0; t < trees; t++) {
    const a = r() * TAU, d = r() * rad * 0.65, s = (rad / 9) * (0.7 + r() * 0.6);
    const tx = Math.cos(a) * d, tz = Math.sin(a) * d;
    const trunk = new THREE.CylinderGeometry(0.14 * s, 0.2 * s, 1.3 * s, 5).toNonIndexed();
    trunk.translate(tx, 0.65 * s, tz);
    const crown = new THREE.ConeGeometry(1.0 * s, 2.6 * s, 6).toNonIndexed();
    crown.translate(tx, 2.3 * s, tz);
    for (const g of [trunk, crown]) { g.deleteAttribute('uv'); g.userData.tree = g === crown ? 2 : 1; parts.push(g); }
  }
  const tags = parts.map((g) => g.userData.tree || 0);
  const geo = THREE.mergeGeometries(parts);
  const counts = parts.map((g) => g.attributes.position.count);
  for (const g of parts) g.dispose();
  geo.computeVertexNormals();
  const P = geo.attributes.position, Nn = geo.attributes.normal;
  const C = new Float32Array(P.count * 3);
  const grassA = new THREE.Color('#7cc456'), grassB = new THREE.Color('#4f9a3c'), soil = new THREE.Color('#8a5a3a');
  const rockA = new THREE.Color('#9a8574'), rockB = new THREE.Color('#5c5262'), trunkC = new THREE.Color('#6b4428');
  const leafA = new THREE.Color('#3f8a3a'), leafB = new THREE.Color('#e09a3e');
  let part = 0, left = counts[0];
  for (let i = 0; i < P.count; i += 3) {
    while (left <= 0) { part++; left = counts[part]; }
    left -= 3;
    const cy = (P.getY(i) + P.getY(i + 1) + P.getY(i + 2)) / 3, ny = Nn.getY(i);
    const tg = tags[part];
    if (tg === 1) _c.copy(trunkC);
    else if (tg === 2) _c.copy(leafA).lerp(leafB, r() < 0.25 ? 0.7 : r() * 0.2);
    else if (cy > -0.05 && ny > 0.6) _c.copy(grassA).lerp(grassB, r());
    else if (cy > -topH * 1.05) _c.copy(soil).multiplyScalar(0.85 + r() * 0.3);
    else _c.copy(rockA).lerp(rockB, clamp(-cy / depth, 0, 1) + (r() - 0.5) * 0.2);
    for (let k = 0; k < 3; k++) { C[(i + k) * 3] = _c.r; C[(i + k) * 3 + 1] = _c.g; C[(i + k) * 3 + 2] = _c.b; }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
  geo.translate(x, y, z);
  return geo;
}

// Sky: golden hour above the clouds — floating islands with waterfalls, cloud puffs and a sea of clouds.
function scenerySky(c) {
  const { A, bag, U, th, group } = c;
  const r = rng(1401);
  const noise = new THREE.SimplexNoise({ random: r });
  const parts = [];
  const falls = [];
  const puffs = [];
  const IN = 12;
  const pt = { x: 0, z: 0 };
  for (let k = 0; k < IN; k++) {
    const ang = (k + r() * 0.7) / IN * TAU, d = 60 + r() * 200;
    ringPoint(A, ang, d, pt);
    const y = A.minY + (r() - 0.3) * 42, rad = 5 + r() * 11 + d * 0.04;
    parts.push(islandGeometry(r, noise, rad, pt.x, y, pt.z));
    if (r() < 0.6) {
      const fa = Math.atan2(A.cz - pt.z, A.cx - pt.x) + (r() - 0.5) * 0.9;
      const fx = pt.x + Math.cos(fa) * rad * 0.9, fz = pt.z + Math.sin(fa) * rad * 0.9;
      const len = 30 + r() * 50;
      falls.push([fx, y - 0.05, fz, rad * (0.16 + r() * 0.1), len, Math.PI / 2 - fa, r()]);
      for (let m = 0; m < 3; m++) puffs.push([fx + (r() - 0.5) * 6, y - len + 4 + r() * 4, fz + (r() - 0.5) * 6, 10 + r() * 8, 6 + r() * 4, r(), 0]);
    }
  }
  const igeo = bag.add(THREE.mergeGeometries(parts));
  for (const g of parts) g.dispose();
  const imat = bag.add(litMaterial(U, th, { vertexColors: true, keyK: 0.5, ambK: 0.38, rim: '#ffcf9e', rimK: 0.3, hazeK: th.hazeK * 0.55 }));
  const islands = new THREE.Mesh(igeo, imat);
  islands.frustumCulled = false;
  group.add(islands);
  flowStrips(c, falls, false, { core: '#f4fbff', edge: '#8fc8ff', speed: 0.9 });
  for (let k = 0; k < 34; k++) {
    ringPoint(A, r() * TAU, 60 + r() * 320, pt);
    const cy = A.minY - 22 + r() * 75, n = 3 + Math.floor(r() * 4), size = 14 + r() * 24 + Math.hypot(pt.x - A.cx, pt.z - A.cz) * 0.04;
    for (let j = 0; j < n; j++) {
      const w = size * (0.75 + r() * 0.5);
      puffs.push([pt.x + (r() - 0.5) * size * 1.6, cy + (r() - 0.5) * size * 0.25, pt.z + (r() - 0.5) * size * 1.6, w, w * 0.62, r(), 0]);
    }
  }
  for (const p of puffs) p[6] = Math.hypot(p[0] - A.cx, p[2] - A.cz);
  const cloudLod = cloudLayer(c, puffs, { lit: th.clouds.lit, dark: th.clouds.dark, hazeK: th.hazeK * 0.8 });
  seaPlane(c, A.minY - 50, false, { a: '#fff0e0', b: '#b9a9d8', c: '#ffd7a0', hazeK: th.hazeK * 0.75 });
  return { lod(k) { cloudLod(k); } };
}

// Lava: a volcanic core — basalt column cliffs with glowing veins, lava falls, a lava lake and smoke.
function sceneryLava(c) {
  const { A, bag, U, th, group } = c;
  const r = rng(1501);
  const lakeY = A.minY - 26;
  const column = bag.add(flatGeometry(new THREE.CylinderGeometry(1, 1, 1, 6, 1), 0.5));
  const cmat = bag.add(litMaterial(U, th, {
    base: '#231615', rim: '#ff5a1a', rimK: 0.1, keyK: 0.3, ambK: 0.28, glow: '#ff4a12', glowK2: 0.55, glowY: lakeY, glowK: 0.055, veins: true,
  }));
  const CN = 120, FALLS = 12;
  const cols = new THREE.InstancedMesh(column, cmat, CN);
  const tops = [];
  const pt = { x: 0, z: 0 };
  for (let i = 0; i < CN; i++) {
    // the first FALLS columns are big cliffs spread evenly around, each with a lava fall facing the level
    const cliff = i < FALLS, near = !cliff && i < FALLS + 22;
    const ang = cliff ? (i + 0.2 + r() * 0.6) / FALLS * TAU : r() * TAU;
    const d = cliff ? 135 + r() * 70 : near ? 48 + r() * 70 : 120 + r() * 220;
    ringPoint(A, ang, d, pt);
    const w = cliff ? 18 + r() * 10 : near ? 4 + r() * 6 : 10 + r() * 22;
    const top = cliff ? A.maxY + 35 + r() * 55 : near ? A.maxY - 4 + r() * 40 : A.maxY + 10 + r() * 110;
    _m4.compose(_p.set(pt.x, lakeY - 8, pt.z), _q.setFromAxisAngle(UP, r() * TAU), _s.set(w, top - lakeY + 8, w));
    cols.setMatrixAt(i, _m4);
    if (cliff || (near && r() < 0.12)) tops.push([pt.x, top, pt.z, w, ang, near]);
  }
  cols.frustumCulled = false;
  group.add(cols);
  const puffs = [];
  const falls = tops.map(([x, top, z, w, ang, near]) => {
    const fa = ang + Math.PI;                       // pour down the side facing the arena
    const fx = x + Math.cos(fa) * w * 1.04, fz = z + Math.sin(fa) * w * 1.04;
    const fw = near ? 3.5 + r() * 3 : 8 + r() * 7;
    for (let m = 0; m < 3; m++) puffs.push([fx + (r() - 0.5) * fw, lakeY + 3 + m * 5 + r() * 3, fz + (r() - 0.5) * fw, fw * 2.4, fw * 1.5, r(), 0]);
    return [fx, top - 1, fz, fw, top - lakeY, Math.PI / 2 - fa, r()];
  });
  flowStrips(c, falls, true, { core: '#ffc061', coreK: 2.2, edge: '#ff4010', edgeK: 1.25, speed: 0.5 });
  seaPlane(c, lakeY, true, { a: '#ff6a1a', b: '#ff2a08', c: '#1a0705', hazeK: th.hazeK * 0.8 });
  for (let k = 0; k < 30; k++) {
    ringPoint(A, r() * TAU, 20 + r() * 260, pt);
    const cy = A.maxY + 30 + r() * 60, size = 30 + r() * 40;
    for (let j = 0; j < 3; j++) puffs.push([pt.x + (r() - 0.5) * size, cy + (r() - 0.5) * 10, pt.z + (r() - 0.5) * size, size, size * 0.6, r(), 0]);
  }
  for (const p of puffs) p[6] = Math.hypot(p[0] - A.cx, p[2] - A.cz);
  const smokeLod = cloudLayer(c, puffs, { lit: '#8a2a0e', dark: '#0b0303', smoke: true, opacity: 0.62, hazeK: th.hazeK * 0.6 });
  return { lod(k) { cols.count = Math.max(1, Math.round(CN * k)); smokeLod(k); } };
}

const SCENERY = { skyline: sceneryNeon, spires: sceneryCrystal, islands: scenerySky, cliffs: sceneryLava };

// ---------- ambient particles per theme ----------
function ambientParticles(c, kind) {
  const { bag, U, group } = c;
  const r = rng(1601);
  if (kind === 'rain') {
    const N = 2200, box = new THREE.Vector3(44, 26, 44);
    const pos = new Float32Array(N * 6), seed = new Float32Array(N * 8), end = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = r() * box.x, y = r() * box.y, z = r() * box.z, s = [r(), r(), r(), r()];
      for (let k = 0; k < 2; k++) {
        const v = i * 2 + k;
        pos.set([x, y, z], v * 3); seed.set(s, v * 4); end[v] = k;
      }
    }
    const geo = bag.add(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const mat = bag.add(new THREE.ShaderMaterial({
      uniforms: { uTime: U.time, uCam: U.cam, uBox: { value: box }, uMotion: U.motion, uColA: { value: col('#9fe9ff', 1.1) }, uColB: { value: col('#ff9be6', 1.1) } },
      vertexShader: RAIN_VS, fragmentShader: RAIN_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    group.add(lines);
    return (k) => geo.setDrawRange(0, Math.round(N * k) * 2);
  }
  const cfg = {
    spores: { N: 900, box: [40, 22, 40], size: 0.16, a: '#5ef0ff', b: '#b98cff', k: 1.6, def: 'SPORES' },
    pollen: { N: 700, box: [40, 20, 40], size: 0.09, a: '#fff1b0', b: '#ffd27a', k: 1.4, def: 'POLLEN' },
    embers: { N: 1100, box: [40, 26, 40], size: 0.085, a: '#ffd27a', b: '#ff3d0a', k: 2.6, def: 'EMBERS' },
  }[kind];
  if (!cfg) return () => {};
  const box = new THREE.Vector3(...cfg.box);
  const pos = new Float32Array(cfg.N * 3), seed = new Float32Array(cfg.N * 4);
  for (let i = 0; i < cfg.N; i++) {
    pos[i * 3] = r() * box.x; pos[i * 3 + 1] = r() * box.y; pos[i * 3 + 2] = r() * box.z;
    for (let k = 0; k < 4; k++) seed[i * 4 + k] = r();
  }
  const geo = bag.add(new THREE.BufferGeometry());
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  const mat = bag.add(new THREE.ShaderMaterial({
    defines: { [cfg.def]: '' },
    uniforms: {
      uTime: U.time, uCam: U.cam, uBox: { value: box }, uScale: U.pscale, uSize: { value: cfg.size }, uMotion: U.motion,
      uColA: { value: col(cfg.a, cfg.k) }, uColB: { value: col(cfg.b, cfg.k) },
    },
    vertexShader: AMB_VS, fragmentShader: AMB_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  group.add(pts);
  return (k) => geo.setDrawRange(0, Math.round(cfg.N * k));
}

// ---------- pooled effects ----------
class Pool {
  constructor(max, blending, map, U) {
    this.max = max; this.head = 0; this.live = 0; this.dirty = false;
    this.p = new Float32Array(max * 3); this.c = new Float32Array(max * 4); this.s = new Float32Array(max);
    this.v = new Float32Array(max * 3); this.k = new Float32Array(max * 4);
    this.age = new Float32Array(max); this.dur = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.g = new Float32Array(max); this.dr = new Float32Array(max); this.tw = new Uint8Array(max);
    this.geo = new THREE.BufferGeometry();
    this.aP = new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage);
    this.aC = new THREE.BufferAttribute(this.c, 4).setUsage(THREE.DynamicDrawUsage);
    this.aS = new THREE.BufferAttribute(this.s, 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.aP);
    this.geo.setAttribute('aColor', this.aC);
    this.geo.setAttribute('aSize', this.aS);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uScale: U.pscale }, vertexShader: FXP_VS, fragmentShader: FXP_FS,
      transparent: true, depthWrite: false, blending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }
  spawn(x, y, z, vx, vy, vz, r, g, b, a, s0, s1, dur, grav, drag, tw) {
    const i = this.head;
    this.head = (i + 1) % this.max;
    if (this.dur[i] <= 0) this.live++;
    const i3 = i * 3, i4 = i * 4;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.k[i4] = r; this.k[i4 + 1] = g; this.k[i4 + 2] = b; this.k[i4 + 3] = a;
    this.age[i] = 0; this.dur[i] = dur; this.s0[i] = s0; this.s1[i] = s1; this.g[i] = grav; this.dr[i] = drag; this.tw[i] = tw;
  }
  update(dt) {
    if (this.live <= 0 && !this.dirty) return;
    this.dirty = false;
    let live = 0;
    for (let i = 0; i < this.max; i++) {
      const d = this.dur[i];
      if (d <= 0) continue;
      const age = this.age[i] + dt;
      const i3 = i * 3, i4 = i * 4;
      if (age >= d) { this.dur[i] = 0; this.s[i] = 0; this.c[i4 + 3] = 0; this.dirty = true; continue; }
      live++;
      this.age[i] = age;
      const t = age / d, damp = Math.max(0, 1 - this.dr[i] * dt);
      this.v[i3] *= damp; this.v[i3 + 1] = this.v[i3 + 1] * damp - this.g[i] * dt; this.v[i3 + 2] *= damp;
      this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
      let a = (t < 0.08 ? t / 0.08 : 1 - (t - 0.08) / 0.92) * this.k[i4 + 3];
      if (this.tw[i]) a *= 0.55 + 0.45 * Math.sin(age * 28 + i);
      this.c[i4] = this.k[i4]; this.c[i4 + 1] = this.k[i4 + 1]; this.c[i4 + 2] = this.k[i4 + 2]; this.c[i4 + 3] = a;
      this.s[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
    }
    this.live = live;
    this.aP.needsUpdate = true; this.aC.needsUpdate = true; this.aS.needsUpdate = true;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

function createFx(scene, camera, U, R) {
  const root = new THREE.Group();
  root.name = 'fx';
  scene.add(root);
  const dotTex = new THREE.CanvasTexture(painted('dot', paintDot));
  const ringTex = new THREE.CanvasTexture(painted('ring', paintRing));
  const glow = new Pool(1500, THREE.AdditiveBlending, dotTex, U);
  const soft = new Pool(360, THREE.NormalBlending, dotTex, U);
  root.add(soft.points, glow.points);
  const tc = new THREE.Color();
  const tv = new THREE.Vector3(), tw = new THREE.Vector3(), tx = new THREE.Vector3();
  let density = 1;
  // shockwave rings
  const ringGeo = new THREE.PlaneGeometry(2, 2);
  ringGeo.rotateX(-Math.PI / 2);
  const rings = [];
  for (let i = 0; i < 10; i++) {
    const mat = new THREE.MeshBasicMaterial({ map: ringTex, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 9;
    root.add(mesh);
    rings.push({ mesh, mat, t: 0, dur: 0.5, radius: 3, col: new THREE.Color() });
  }
  let ringNext = 0;
  // beams
  const SEG = 28;
  const beamGeo = new THREE.BufferGeometry();
  {
    const n = (SEG + 1) * 2;
    const aT = new Float32Array(n), aSide = new Float32Array(n), idx = [];
    for (let i = 0; i <= SEG; i++) { aT[i * 2] = aT[i * 2 + 1] = i / SEG; aSide[i * 2] = -1; aSide[i * 2 + 1] = 1; }
    for (let i = 0; i < SEG; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    beamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    beamGeo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    beamGeo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
    beamGeo.setIndex(idx);
  }
  const beams = [];
  for (let i = 0; i < 8; i++) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uFrom: { value: new THREE.Vector3() }, uTo: { value: new THREE.Vector3() }, uWidth: { value: 0.08 }, uTime: U.time,
        uSeed: { value: i * 7.13 }, uCol: { value: new THREE.Color() }, uAlpha: { value: 0 },
      },
      vertexShader: BEAM_VS, fragmentShader: BEAM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(beamGeo, mat);
    mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 11;
    root.add(mesh);
    beams.push({ mesh, mat, t: 0, dur: 0.22 });
  }
  let beamNext = 0;
  // ribbon trails
  const RS = 34;
  const ribIdx = [];
  for (let i = 0; i < RS - 1; i++) { const a = i * 2; ribIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const ribSide = new Float32Array(RS * 2);
  for (let i = 0; i < RS; i++) { ribSide[i * 2] = -1; ribSide[i * 2 + 1] = 1; }
  const ribbons = [];
  for (let i = 0; i < 6; i++) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(RS * 6), alpha = new Float32Array(RS * 2);
    const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    const aA = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', aPos);
    geo.setAttribute('aA', aA);
    geo.setAttribute('aSide', new THREE.BufferAttribute(ribSide, 1));
    geo.setIndex(ribIdx);
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color() } }, vertexShader: RIB_VS, fragmentShader: RIB_FS,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 8;
    root.add(mesh);
    ribbons.push({
      geo, mat, mesh, pos, alpha, aPos, aA, obj: null, on: false, stopping: false, gen: 0,
      pts: new Float32Array(RS * 3), times: new Float32Array(RS), n: 0, life: 0.32, width: 0.42, offset: 0.55, clock: 0,
      handle: null,
    });
  }
  let ribNext = 0;
  // floating text
  const texts = [];
  for (let i = 0; i < 10; i++) {
    const c = cnv(512, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
    const m = new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false, fog: false });
    const s = new THREE.Sprite(m);
    s.visible = false; s.renderOrder = 1000;
    root.add(s);
    texts.push({ c, t, m, s, age: 0, dur: 1.15, y0: 0, w: 2.2 });
  }
  let textNext = 0;
  const n = (k) => Math.max(1, Math.round(k * density));
  const rnd = Math.random;

  const fx = {
    burst(pos, color = '#ffd166', count = 24, speed = 4) {
      tc.set(parseHex(color, '#ffd166'));
      const k = n(count);
      for (let i = 0; i < k; i++) {
        const u = rnd() * 2 - 1, a = rnd() * TAU, sq = Math.sqrt(1 - u * u), sp = speed * (0.35 + rnd() * 0.75);
        glow.spawn(pos.x, pos.y, pos.z, sq * Math.cos(a) * sp, (Math.abs(u) * 0.6 + u * 0.4) * sp + 1.2, sq * Math.sin(a) * sp,
          tc.r * 2.4, tc.g * 2.4, tc.b * 2.4, 1, 0.15 + rnd() * 0.13, 0.02, 0.45 + rnd() * 0.55, 7, 1.6, 0);
      }
      glow.spawn(pos.x, pos.y, pos.z, 0, 0, 0, tc.r * 3, tc.g * 3, tc.b * 3, 0.9, 1.3, 0.3, 0.24, 0, 0, 0);
    },
    sparkle(pos, color = '#fff2b0') {
      tc.set(parseHex(color, '#fff2b0'));
      const k = n(12);
      for (let i = 0; i < k; i++) {
        const a = rnd() * TAU, d = rnd() * 0.45;
        glow.spawn(pos.x + Math.cos(a) * d, pos.y + (rnd() - 0.3) * 0.5, pos.z + Math.sin(a) * d, Math.cos(a) * 0.5, 0.5 + rnd() * 0.9, Math.sin(a) * 0.5,
          tc.r * 2.6, tc.g * 2.6, tc.b * 2.6, 1, 0.12 + rnd() * 0.1, 0.01, 0.6 + rnd() * 0.5, -0.4, 1.2, 1);
      }
    },
    shockwave(pos, color = '#5ee7ff', radius = 3) {
      const g = rings[ringNext];
      ringNext = (ringNext + 1) % rings.length;
      g.col.set(parseHex(color, '#5ee7ff')).multiplyScalar(2.2);
      g.t = 0; g.dur = R.reducedMotion ? 0.35 : 0.5; g.radius = radius;
      g.mesh.position.set(pos.x, pos.y + 0.06, pos.z);
      g.mesh.scale.setScalar(0.01);
      g.mesh.visible = true;
      tc.copy(g.col);
      glow.spawn(pos.x, pos.y + 0.2, pos.z, 0, 0, 0, tc.r, tc.g, tc.b, 0.8, radius * 0.9, radius * 0.2, 0.28, 0, 0, 0);
      const k = n(14);
      for (let i = 0; i < k; i++) {
        const a = rnd() * TAU, sp = radius * (1.6 + rnd());
        glow.spawn(pos.x, pos.y + 0.15, pos.z, Math.cos(a) * sp, 0.6 + rnd(), Math.sin(a) * sp, tc.r, tc.g, tc.b, 1, 0.14, 0.02, 0.4 + rnd() * 0.2, 3, 2.5, 0);
      }
    },
    beam(from, to, color = '#5ee7ff', width = 0.08) {
      const b = beams[beamNext];
      beamNext = (beamNext + 1) % beams.length;
      const u = b.mat.uniforms;
      u.uFrom.value.copy(from); u.uTo.value.copy(to); u.uWidth.value = width;
      u.uCol.value.set(parseHex(color, '#5ee7ff')); u.uSeed.value = rnd() * 100; u.uAlpha.value = 0;
      b.t = 0; b.mesh.visible = true;
      tc.copy(u.uCol.value);
      glow.spawn(from.x, from.y, from.z, 0, 0, 0, tc.r * 3, tc.g * 3, tc.b * 3, 1, width * 9, width * 3, 0.2, 0, 0, 0);
      glow.spawn(to.x, to.y, to.z, 0, 0, 0, tc.r * 3, tc.g * 3, tc.b * 3, 1, width * 12, width * 4, 0.26, 0, 0, 0);
      const k = n(8);
      for (let i = 0; i < k; i++) {
        const u2 = rnd() * 2 - 1, a = rnd() * TAU, sq = Math.sqrt(1 - u2 * u2), sp = 2 + rnd() * 3;
        glow.spawn(to.x, to.y, to.z, sq * Math.cos(a) * sp, u2 * sp + 1, sq * Math.sin(a) * sp, tc.r * 2.5, tc.g * 2.5, tc.b * 2.5, 1, 0.1, 0.01, 0.3 + rnd() * 0.25, 8, 2, 0);
      }
    },
    trail(object3d, color = '#5ee7ff', opts = {}) {
      let rb = ribbons.find((x) => !x.on);
      if (!rb) { rb = ribbons[ribNext]; ribNext = (ribNext + 1) % ribbons.length; }
      rb.gen++;
      const gen = rb.gen;
      rb.obj = object3d; rb.on = true; rb.stopping = false; rb.n = 0; rb.clock = 0;
      rb.width = opts.width ?? 0.42; rb.offset = opts.offset ?? 0.55; rb.life = opts.life ?? 0.32;
      rb.mat.uniforms.uCol.value.set(parseHex(color, '#5ee7ff')).multiplyScalar(1.6);
      rb.mesh.visible = false;
      return { stop() { if (rb.gen === gen) rb.stopping = true; } };
    },
    dust(pos) {
      const k = n(10);
      tc.copy(R._dust);
      for (let i = 0; i < k; i++) {
        const a = rnd() * TAU, sp = 1.2 + rnd() * 1.8;
        soft.spawn(pos.x + Math.cos(a) * 0.2, pos.y + 0.1, pos.z + Math.sin(a) * 0.2, Math.cos(a) * sp, 0.35 + rnd() * 0.5, Math.sin(a) * sp,
          tc.r, tc.g, tc.b, 0.42, 0.25 + rnd() * 0.1, 0.75 + rnd() * 0.3, 0.55 + rnd() * 0.35, -0.3, 3.2, 0);
      }
    },
    text(pos, string, color = '#ffffff') {
      const T = texts[textNext];
      textNext = (textNext + 1) % texts.length;
      const g = T.c.getContext('2d');
      const str = String(string);
      g.clearRect(0, 0, 512, 128);
      let size = 84;
      g.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      let w = g.measureText(str).width;
      if (w > 470) { size = Math.max(24, Math.floor(size * 470 / w)); g.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`; w = g.measureText(str).width; }
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.lineWidth = size * 0.17; g.strokeStyle = 'rgba(12,6,28,0.9)'; g.strokeText(str, 256, 66);
      const css = '#' + tc.set(parseHex(color)).getHexString();
      g.shadowColor = css; g.shadowBlur = 18; g.fillStyle = css; g.fillText(str, 256, 66); g.shadowBlur = 0;
      T.t.needsUpdate = true;
      T.s.position.set(pos.x, pos.y, pos.z);
      T.y0 = pos.y; T.age = 0; T.s.visible = true;
    },
    update(dt) {
      R._fxTicked = true;
      glow.update(dt);
      soft.update(dt);
      for (const g of rings) {
        if (!g.mesh.visible) continue;
        g.t += dt;
        const k = g.t / g.dur;
        if (k >= 1) { g.mesh.visible = false; continue; }
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        g.mesh.scale.setScalar(0.2 + (g.radius - 0.2) * e);
        g.mat.color.copy(g.col).multiplyScalar((1 - k) * (1 - k));
      }
      for (const b of beams) {
        if (!b.mesh.visible) continue;
        b.t += dt;
        const k = b.t / b.dur;
        if (k >= 1) { b.mesh.visible = false; continue; }
        b.mat.uniforms.uAlpha.value = k < 0.12 ? k / 0.12 : (1 - (k - 0.12) / 0.88) ** 1.5;
      }
      camera.getWorldPosition(tx);
      for (const rb of ribbons) {
        if (!rb.on) continue;
        rb.clock += dt;
        if (!rb.stopping && rb.obj) {
          rb.obj.getWorldPosition(tv);
          tv.y += rb.offset;
          const last = rb.n ? 0 : -1;
          const moved = last < 0 ? 1 : Math.hypot(tv.x - rb.pts[0], tv.y - rb.pts[1], tv.z - rb.pts[2]);
          if (moved > 0.04 || last < 0) {
            rb.pts.copyWithin(3, 0, (RS - 1) * 3);
            rb.times.copyWithin(1, 0, RS - 1);
            rb.pts[0] = tv.x; rb.pts[1] = tv.y; rb.pts[2] = tv.z; rb.times[0] = rb.clock;
            rb.n = Math.min(RS, rb.n + 1);
          } else {
            rb.pts[0] = tv.x; rb.pts[1] = tv.y; rb.pts[2] = tv.z; rb.times[0] = rb.clock;
          }
        }
        while (rb.n > 0 && rb.clock - rb.times[rb.n - 1] > rb.life) rb.n--;
        if (rb.n < 2) {
          rb.mesh.visible = false;
          if (rb.stopping) { rb.on = false; rb.obj = null; }
          continue;
        }
        const P = rb.pts, nn = rb.n;
        for (let i = 0; i < nn; i++) {
          const a = Math.max(0, i - 1), b = Math.min(nn - 1, i + 1);
          tw.set(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
          tv.set(tx.x - P[i * 3], tx.y - P[i * 3 + 1], tx.z - P[i * 3 + 2]);
          tw.cross(tv);
          const l = tw.length() || 1;
          const age = (rb.clock - rb.times[i]) / rb.life;
          const wdt = rb.width * 0.5 * (1 - i / (nn - 1)) ** 0.7;
          tw.multiplyScalar(wdt / l);
          const o = i * 6;
          rb.pos[o] = P[i * 3] - tw.x; rb.pos[o + 1] = P[i * 3 + 1] - tw.y; rb.pos[o + 2] = P[i * 3 + 2] - tw.z;
          rb.pos[o + 3] = P[i * 3] + tw.x; rb.pos[o + 4] = P[i * 3 + 1] + tw.y; rb.pos[o + 5] = P[i * 3 + 2] + tw.z;
          const al = Math.max(0, 1 - age) * (i === 0 ? 0.6 : 1);
          rb.alpha[i * 2] = rb.alpha[i * 2 + 1] = al * al;
        }
        rb.aPos.needsUpdate = true; rb.aA.needsUpdate = true;
        rb.geo.setDrawRange(0, (nn - 1) * 6);
        rb.mesh.visible = true;
      }
      for (const T of texts) {
        if (!T.s.visible) continue;
        T.age += dt;
        const k = T.age / T.dur;
        if (k >= 1) { T.s.visible = false; continue; }
        const rise = 1 - (1 - k) * (1 - k);
        T.s.position.y = T.y0 + rise * 1.1;
        const pop = k < 0.12 ? 0.6 + (k / 0.12) * 0.55 : k < 0.22 ? 1.15 - ((k - 0.12) / 0.1) * 0.15 : 1;
        T.s.scale.set(T.w * pop, T.w * 0.25 * pop, 1);
        T.m.opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      }
    },
    setDensity(k) { density = k; },
    dispose() {
      glow.dispose(); soft.dispose();
      ringGeo.dispose(); for (const g of rings) g.mat.dispose();
      beamGeo.dispose(); for (const b of beams) b.mat.dispose();
      for (const rb of ribbons) { rb.geo.dispose(); rb.mat.dispose(); }
      for (const T of texts) { T.t.dispose(); T.m.dispose(); }
      dotTex.dispose(); ringTex.dispose();
      scene.remove(root);
    },
  };
  return fx;
}

// ---------- the renderer ----------
export function createRenderer(canvas, { quality = 'auto', reducedMotion = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;     // r187: PCF with a Vogel-disk blur (shadow.radius) is the soft mode
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.01);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2400);
  camera.position.set(0, 6, -10);
  camera.lookAt(0, 1, 0);

  const touch = (() => {
    try { return window.matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent); } catch { return false; }
  })();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const noiseTex = new THREE.CanvasTexture(painted('noise', paintNoise));
  noiseTex.wrapS = noiseTex.wrapT = THREE.RepeatWrapping;
  noiseTex.colorSpace = THREE.NoColorSpace;
  // uniforms shared by every material made here (updated in place, never replaced)
  const U = {
    time: { value: 0 }, noise: { value: noiseTex }, haze: { value: new THREE.Color() },
    accentA: { value: new THREE.Color() }, accentB: { value: new THREE.Color() },
    sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color() },
    skyHor: { value: new THREE.Color() }, skyTop: { value: new THREE.Color() },
    keyDir: { value: new THREE.Vector3(0, 1, 0) }, keyCol: { value: new THREE.Color() },
    hemiSky: { value: new THREE.Color() }, hemiGnd: { value: new THREE.Color() },
    cam: { value: camera.position }, pscale: { value: 600 }, motion: { value: reducedMotion ? 0.3 : 1 },
    def: null,
  };
  const mats = createMaterials(U, touch ? Math.min(4, maxAniso) : Math.min(8, maxAniso));

  // lights: hemisphere fill, key (shadows, follows the active hero), rim from beyond the hero toward the camera
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.castShadow = true;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = 2.5;
  const rim = new THREE.DirectionalLight(0xffffff, 1);
  scene.add(hemi, key, key.target, rim, rim.target);
  const lx = new THREE.Vector3(), ly = new THREE.Vector3(), lz = new THREE.Vector3();
  const focus = new THREE.Vector3();
  let shadowExt = 20;

  // sky dome (geometry kept; the material is rebuilt per theme)
  const domeGeo = new THREE.SphereGeometry(1000, 48, 24);
  const dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial());
  dome.frustumCulled = false;
  dome.renderOrder = 1000;
  scene.add(dome);
  // the Underside veil: drawn over the sky (at the far plane, behind everything) as a hero sinks below the level
  const veil = new THREE.Mesh(domeGeo, new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uGlow: { value: new THREE.Color('#0e3b4a') } },
    vertexShader: SKY_VS, fragmentShader: VEIL_FS, side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
  }));
  veil.frustumCulled = false;
  veil.renderOrder = 1001;
  veil.visible = false;
  scene.add(veil);
  let depthK = 0;
  const mix0 = { fog: new THREE.Color(), hs: new THREE.Color(), hg: new THREE.Color(), key: new THREE.Color(), rim: new THREE.Color() };
  const mix1 = { fog: new THREE.Color(DEEP.fog[0]), hs: new THREE.Color(DEEP.hemi[0]), hg: new THREE.Color(DEEP.hemi[1]), key: new THREE.Color(DEEP.key[0]), rim: new THREE.Color(DEEP.rim[0]) };
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null;

  // post-processing
  const composer = new THREE.EffectComposer(renderer);
  const renderPass = new THREE.RenderPass(scene, camera);
  const bloom = new THREE.UnrealBloomPass(new THREE.Vector2(256, 256), 0.9, 0.55, 0.85);
  let bloomScale = 1;
  const bloomSetSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSetSize(Math.max(4, Math.round(w * bloomScale)), Math.max(4, Math.round(h * bloomScale)));
  const gradeMat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uNoise: U.noise, uVig: { value: 0.3 }, uSat: { value: 1.08 }, uHeat: { value: 0 }, uTime: U.time },
    vertexShader: QUAD_VS, fragmentShader: GRADE_FS,
  });
  const grade = new THREE.ShaderPass(gradeMat);
  const output = new THREE.OutputPass();
  const fxaa = new THREE.ShaderPass(THREE.FXAAShader);
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(grade);
  composer.addPass(output);
  composer.addPass(fxaa);

  let W = Math.max(1, canvas.clientWidth || canvas.width || 1);
  let H = Math.max(1, canvas.clientHeight || canvas.height || 1);
  let pr = 1;
  let tier = TIERS.high;
  let auto = quality === 'auto';
  let theme = null;
  let arena = { cx: 0, cz: 0, hx: 30, hz: 30, minY: -4, maxY: 14 };
  let time = 0;
  const tA = new THREE.Vector3(), tB = new THREE.Vector3();
  const buf = new THREE.Vector2();
  // fps measure for the automatic downgrade
  let last = 0, frames = 0, acc = 0, fps = 60, slow = 0, warm = 3;

  const R = {
    renderer, scene, camera, quality: 'high', reducedMotion, _U: U, _dust: new THREE.Color('#b8a6ee'), _fxTicked: false,
    materials: { get: (name, t) => mats.get(name, t) },
    fx: null,
    setQuality(q) {
      auto = q === 'auto';
      applyTier(auto ? (touch ? 'medium' : 'high') : (TIERS[q] ? q : 'high'));
    },
    setSize(cssW, cssH) {
      W = Math.max(1, Math.round(cssW)); H = Math.max(1, Math.round(cssH));
      resize();
    },
    setTheme(name) {
      const def = THEMES[name] ? name : 'neon';
      if (theme && theme.name === def) return;
      buildTheme(def);
    },
    setShadowFocus(v) { focus.copy(v); },
    // 0 = the level's own theme, 1 = the Underside: fog, light, exposure, bloom and the sky veil blend over
    setDepth(k) {
      k = clamp(Number.isFinite(k) ? k : 0, 0, 1);
      if (!theme || Math.abs(k - depthK) < 0.002) return;
      depthK = k;
      applyDepth();
    },
    get depth() { return depthK; },
    render(dt = 1 / 60) {
      if (!theme) buildTheme('neon');
      dt = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0, 0.1);
      time += dt;
      U.time.value = time;
      measure();
      dome.position.copy(camera.position);
      updateLights();
      if (!R._fxTicked) R.fx.update(dt);
      R._fxTicked = false;
      renderer.getDrawingBufferSize(buf);
      U.pscale.value = buf.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
      renderer.info.reset();
      composer.render(dt);
    },
    stats() {
      return { fps: Math.round(fps), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, pixelRatio: pr, quality: R.quality };
    },
    dispose() {
      clearTheme();
      R.fx.dispose();
      mats.dispose();
      noiseTex.dispose();
      domeGeo.dispose(); dome.material.dispose(); veil.material.dispose();
      if (envRT) envRT.dispose();
      pmrem.dispose();
      key.dispose(); rim.dispose(); hemi.dispose();
      bloom.dispose(); grade.dispose(); output.dispose(); fxaa.dispose();
      composer.dispose();
      scene.clear();
      renderer.dispose();
    },
    // internal: buildStatic reports the level bounds so far scenery sits around the level
    _setArena(b) {
      const same = Math.abs(b.cx - arena.cx) < 1 && Math.abs(b.cz - arena.cz) < 1 && Math.abs(b.hx - arena.hx) < 1 &&
        Math.abs(b.hz - arena.hz) < 1 && Math.abs(b.minY - arena.minY) < 1 && Math.abs(b.maxY - arena.maxY) < 1;
      arena = b;
      if (theme && !same) buildScenery();
    },
    _mats: mats,
    _post: { composer, bloom, grade, output, fxaa },
  };
  R.fx = createFx(scene, camera, U, R);

  function applyTier(name) {
    tier = TIERS[name];
    R.quality = name;
    pr = Math.min(window.devicePixelRatio || 1, tier.pr);
    bloomScale = tier.bloom;
    renderer.setPixelRatio(pr);
    composer.setPixelRatio(pr);
    fxaa.enabled = tier.fxaa;
    grade.enabled = tier.grade;
    shadowExt = tier.ext;
    const sc = key.shadow.camera;
    sc.left = -shadowExt; sc.right = shadowExt; sc.top = shadowExt; sc.bottom = -shadowExt; sc.near = 1; sc.far = 160;
    sc.updateProjectionMatrix();
    if (tier.shadow) {
      renderer.shadowMap.enabled = true;
      key.castShadow = true;
      if (key.shadow.mapSize.x !== tier.shadow) {
        key.shadow.mapSize.set(tier.shadow, tier.shadow);
        if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
      }
    } else {
      key.castShadow = false;
      renderer.shadowMap.enabled = false;
    }
    R.fx.setDensity(tier.parts);
    if (theme) theme.lod();
    resize();
    warm = 3; slow = 0;
  }
  function resize() {
    renderer.setSize(W, H, false);
    composer.setSize(W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    fxaa.material.uniforms.resolution.value.set(1 / (W * pr), 1 / (H * pr));
  }
  function measure() {
    const now = performance.now();
    if (last) {
      const d = (now - last) / 1000;
      if (d < 0.5) { frames++; acc += d; }
    }
    last = now;
    if (acc < 1) return;
    fps = frames / acc;
    frames = 0; acc = 0;
    if (warm > 0) { warm--; return; }
    if (auto && fps < 40) {
      if (++slow >= 4) {
        const i = TIER_NAMES.indexOf(R.quality);
        if (i > 0) applyTier(TIER_NAMES[i - 1]);
        slow = 0;
      }
    } else slow = 0;
  }
  function updateLights() {
    camera.getWorldDirection(tA);
    tA.y = 0;
    if (tA.lengthSq() < 1e-6) tA.set(0, 0, 1);
    tA.normalize();
    if (key.castShadow) {
      // centre a little ahead of the hero, snapped to whole shadow texels so edges do not crawl
      tB.copy(focus).addScaledVector(tA, shadowExt * 0.35);
      const texel = (2 * shadowExt) / key.shadow.mapSize.x;
      const a = Math.round(tB.dot(lx) / texel) * texel, b = Math.round(tB.dot(ly) / texel) * texel, c = tB.dot(lz);
      tB.set(0, 0, 0).addScaledVector(lx, a).addScaledVector(ly, b).addScaledVector(lz, c);
    } else tB.copy(focus);
    key.target.position.copy(tB);
    key.position.copy(tB).addScaledVector(lz, 70);
    key.target.updateMatrixWorld();
    rim.target.position.copy(focus);
    tB.set(-tA.z, 0, tA.x);                        // camera right on the ground plane
    rim.position.copy(focus).addScaledVector(tA, 6).addScaledVector(tB, 8).addScaledVector(UP, -0.4);
    rim.target.updateMatrixWorld();
  }
  function skyColorAt(sk, y, out) {
    if (y > 0) {
      out.lerpColors(tmpC.set(sk.hor), _c.set(sk.mid), sstep(0, 0.22, y));
      out.lerp(_c.set(sk.top), sstep(0.18, 0.85, y));
    } else out.lerpColors(tmpC.set(sk.hor), _c.set(sk.bot), sstep(0, -0.28, y));
    out.add(_c.set(sk.glow).multiplyScalar(sk.glowI * Math.exp(-Math.abs(y) * sk.glowK)));
    return out;
  }
  function buildEnv(th) {
    const es = new THREE.Scene();
    const geo = new THREE.SphereGeometry(40, 32, 16);
    const P = geo.attributes.position;
    const C = new Float32Array(P.count * 3);
    const cc = new THREE.Color();
    for (let i = 0; i < P.count; i++) {
      skyColorAt(th.sky, P.getY(i) / 40, cc).multiplyScalar(th.envSky ?? 0.6);
      C[i * 3] = cc.r; C[i * 3 + 1] = cc.g; C[i * 3 + 2] = cc.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    const sm = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false });
    es.add(new THREE.Mesh(geo, sm));
    const card = new THREE.PlaneGeometry(1, 1);
    const cms = [];
    for (const [x, y, z, w, h, c, k] of th.cards) {
      const m = new THREE.MeshBasicMaterial({ color: col(c, k), side: THREE.DoubleSide, fog: false });
      cms.push(m);
      const mesh = new THREE.Mesh(card, m);
      mesh.position.set(x, y, z).normalize().multiplyScalar(30);
      mesh.lookAt(0, 0, 0);
      mesh.scale.set(w, h, 1);
      es.add(mesh);
    }
    if (envRT) envRT.dispose();
    envRT = pmrem.fromScene(es, 0.02, 0.1, 100);
    geo.dispose(); sm.dispose(); card.dispose();
    for (const m of cms) m.dispose();
    scene.environment = envRT.texture;
    scene.environmentIntensity = th.env;
  }
  function skyMaterial(th) {
    const defines = {};
    if (th.stars) defines.STARS = '';
    if (th.neb) defines.NEBULA = '';
    if (th.aurora) defines.AURORA = '';
    if (th.clouds) defines.CLOUDS = '';
    if (th.body) defines[th.body.type === 'moon' ? 'MOON' : 'SUN'] = '';
    const extra = th.neb || th.aurora || { a: '#000000', b: '#000000', amt: 0 };
    const cl = th.clouds || { lit: '#ffffff', dark: '#000000', amt: 0 };
    const sk = th.sky;
    return new THREE.ShaderMaterial({
      defines,
      uniforms: {
        uTop: { value: col(sk.top) }, uMid: { value: col(sk.mid) }, uHor: { value: col(sk.hor) }, uBot: { value: col(sk.bot) },
        uGlow: { value: col(sk.glow, sk.glowI) }, uGlowK: { value: sk.glowK }, uTime: U.time,
        uSunDir: U.sunDir, uSunCol: { value: th.body ? col(th.body.col, th.body.int) : new THREE.Color() }, uSunSize: { value: th.body ? th.body.size : 0.05 },
        uColA: { value: col(extra.a) }, uColB: { value: col(extra.b) }, uAmt: { value: extra.amt },
        uCloudLit: { value: col(cl.lit) }, uCloudDark: { value: col(cl.dark) }, uCloud: { value: cl.amt },
        uStars: { value: th.stars || 0 }, uStarCol: { value: col(th.starCol || '#ffffff') }, uNoise: U.noise,
      },
      vertexShader: SKY_VS, fragmentShader: SKY_FS,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
  }
  function clearTheme() {
    if (!theme) return;
    scene.remove(theme.group);
    theme.bag.dispose();
    theme = null;
  }
  function buildScenery() {
    if (!theme) return;
    scene.remove(theme.group);
    theme.bag.dispose();
    theme.group = new THREE.Group();
    theme.group.name = 'theme:' + theme.name;
    scene.add(theme.group);
    const ctx = { A: arena, bag: theme.bag, U, th: theme.def, group: theme.group };
    const sc = SCENERY[theme.def.scenery](ctx);
    const amb = ambientParticles(ctx, theme.def.ambient);
    theme.lod = () => { sc.lod(tier.scenery); amb(tier.parts); };
    theme.lod();
  }
  function applyDepth() {
    const th = theme.def; const k = depthK; const lerp = (a, b) => a + (b - a) * k;
    scene.fog.color.copy(mix0.fog).lerp(mix1.fog, k);
    scene.fog.density = lerp(th.fog[1], DEEP.fog[1]);
    renderer.setClearColor(scene.fog.color);
    hemi.color.copy(mix0.hs).lerp(mix1.hs, k); hemi.groundColor.copy(mix0.hg).lerp(mix1.hg, k); hemi.intensity = lerp(th.hemi[2], DEEP.hemi[2]);
    key.color.copy(mix0.key).lerp(mix1.key, k); key.intensity = lerp(th.key[1], DEEP.key[1]);
    rim.color.copy(mix0.rim).lerp(mix1.rim, k); rim.intensity = lerp(th.rim[1], DEEP.rim[1]);
    renderer.toneMappingExposure = lerp(th.exposure, DEEP.exposure);
    bloom.strength = lerp(th.bloom[0], DEEP.bloom[0]); bloom.threshold = lerp(th.bloom[2], DEEP.bloom[2]);
    veil.visible = k > 0.002;
    veil.material.uniforms.uColor.value.copy(scene.fog.color);
    veil.material.uniforms.uOpacity.value = sstep(0, 1, k);
  }
  function buildTheme(name) {
    const th = THEMES[name];
    clearTheme();
    theme = { name, def: th, bag: new Bag(), group: new THREE.Group(), lod: () => {} };
    U.def = th;
    const fogC = col(th.fog[0]);
    scene.fog.color.copy(fogC);
    scene.fog.density = th.fog[1];
    renderer.setClearColor(fogC);
    hemi.color.set(th.hemi[0]); hemi.groundColor.set(th.hemi[1]); hemi.intensity = th.hemi[2];
    key.color.set(th.key[0]); key.intensity = th.key[1];
    lz.set(...th.key[2]).normalize();
    lx.crossVectors(UP, lz).normalize();
    ly.crossVectors(lz, lx);
    rim.color.set(th.rim[0]); rim.intensity = th.rim[1];
    U.keyDir.value.copy(lz); U.keyCol.value.set(th.key[0]).multiplyScalar(th.key[1] / 2.4);
    U.hemiSky.value.set(th.hemi[0]); U.hemiGnd.value.set(th.hemi[1]);
    U.haze.value.set(th.haze);
    U.accentA.value.set(th.accent[0]); U.accentB.value.set(th.accent[1]);
    if (th.body) { U.sunDir.value.set(...th.body.dir).normalize(); U.sunCol.value.set(th.body.col).multiplyScalar(th.body.type === 'sun' ? 3 : 1.2); }
    else { U.sunDir.value.copy(lz); U.sunCol.value.set(th.key[0]); }
    U.skyHor.value.set(th.sky.hor); U.skyTop.value.set(th.sky.mid);
    R._dust.set(th.dust);
    bloom.strength = th.bloom[0]; bloom.radius = th.bloom[1]; bloom.threshold = th.bloom[2];
    renderer.toneMappingExposure = th.exposure;
    gradeMat.uniforms.uVig.value = th.vig; gradeMat.uniforms.uSat.value = th.sat;
    gradeMat.uniforms.uHeat.value = reducedMotion ? 0 : th.heat;
    dome.material.dispose();
    dome.material = skyMaterial(th);
    buildEnv(th);
    mats.applyTheme();
    buildScenery();
    mix0.fog.set(th.fog[0]); mix0.hs.set(th.hemi[0]); mix0.hg.set(th.hemi[1]); mix0.key.set(th.key[0]); mix0.rim.set(th.rim[0]);
    if (depthK > 0) applyDepth();
  }

  R.setQuality(quality);
  return R;
}

// ---------- static level geometry ----------
const _gridKey = (v) => Math.round(v * 1000);
// Glowing edge strips (unlit boxes) gathered into one geometry: 36 vertices per strip.
function pushStrip(acc, cx, cy, cz, sx, sy, sz, colr, sel) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const v = [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
  ];
  const f = [[0, 2, 1, 0, 3, 2], [4, 5, 6, 4, 6, 7], [0, 4, 7, 0, 7, 3], [1, 2, 6, 1, 6, 5], [3, 7, 6, 3, 6, 2], [0, 1, 5, 0, 5, 4]];
  for (const face of f) {
    for (const k of face) {
      acc.p.push(cx + v[k][0], cy + v[k][1], cz + v[k][2]);
      acc.c.push(colr.r, colr.g, colr.b);
      acc.s.push(sel);
    }
  }
}

export function buildStatic(blocks, R) {
  const root = new THREE.Group();
  root.name = 'static';
  const own = [];
  const groups = new Map();
  const boxes = new Map();
  const mats = R._mats;
  const strips = { p: [], c: [], s: [] };
  const crystals = [];
  const tufts = [];
  const icicles = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const stripCol = new THREE.Color();
  const pal = ['#38e1ff', '#a78bfa', '#5ee7ff', '#c084fc', '#2dd4bf'];
  for (const b of blocks || []) {
    if (!b || !b.p || !b.s) continue;
    const [x, y, z] = b.p;
    const sx = Math.max(0.02, b.s[0]), sy = Math.max(0.02, b.s[1]), sz = Math.max(0.02, b.s[2]);
    const m = String(b.m || 'stone');
    minX = Math.min(minX, x - sx / 2); maxX = Math.max(maxX, x + sx / 2);
    minY = Math.min(minY, y - sy / 2); maxY = Math.max(maxY, y + sy / 2);
    minZ = Math.min(minZ, z - sz / 2); maxZ = Math.max(maxZ, z + sz / 2);
    const rad = clamp(Math.min(sx, sy, sz) * 0.1, 0.02, 0.09);
    const bk = `${_gridKey(sx)}|${_gridKey(sy)}|${_gridKey(sz)}`;
    let base = boxes.get(bk);
    if (!base) { base = new THREE.RoundedBoxGeometry(sx, sy, sz, 1, rad); boxes.set(bk, base); }
    const g = base.clone();
    const P = g.attributes.position.array, UV = g.attributes.uv.array;
    const cnt = P.length / 3, per = cnt / 6;
    const blk = new Float32Array(cnt * 2);
    const top = y + sy / 2;
    const tile = 1 / mats.tile(m.startsWith('glow:') ? 'stone' : m);
    for (let i = 0; i < cnt; i++) {
      const wx = P[i * 3] + x, wy = P[i * 3 + 1] + y, wz = P[i * 3 + 2] + z;
      P[i * 3] = wx; P[i * 3 + 1] = wy; P[i * 3 + 2] = wz;
      const f = Math.floor(i / per);
      let u, v;
      if (f === 0) { u = -wz; v = wy; } else if (f === 1) { u = wz; v = wy; } else if (f === 2) { u = wx; v = -wz; } else if (f === 3) { u = wx; v = wz; } else if (f === 4) { u = wx; v = wy; } else { u = -wx; v = wy; }
      UV[i * 2] = u * tile; UV[i * 2 + 1] = v * tile;
      blk[i * 2] = top - wy; blk[i * 2 + 1] = sy;
    }
    g.setAttribute('aBlock', new THREE.BufferAttribute(blk, 2));
    const mk = `${m}|${b.tint ?? ''}`;
    let grp = groups.get(mk);
    if (!grp) { grp = { m, tint: b.tint, geos: [] }; groups.set(mk, grp); }
    grp.geos.push(g);

    // decorations
    const r = rng(seedOf(x, y, z));
    if (m === 'neon' || m === 'glass') {
      const t = m === 'neon' ? 0.06 : 0.04;
      const sel = b.tint != null ? 0 : (r() < 0.5 ? 1 : 2);
      if (m === 'glass') stripCol.set('#bfeaff').multiplyScalar(0.55);
      else if (b.tint != null) stripCol.set(parseHex(b.tint)).multiplyScalar(1);
      const s = m === 'glass' ? 0 : sel;
      const e = rad * 0.3;
      const yy = top - e;
      const ox = sx / 2 - e, oz = sz / 2 - e;
      pushStrip(strips, x, yy, z - oz, sx - rad * 2, t, t, stripCol, s);
      pushStrip(strips, x, yy, z + oz, sx - rad * 2, t, t, stripCol, s);
      pushStrip(strips, x - ox, yy, z, t, t, sz - rad * 2, stripCol, s);
      pushStrip(strips, x + ox, yy, z, t, t, sz - rad * 2, stripCol, s);
      if (m === 'glass' || sy > 1.6) {          // vertical corner strips (dimmer on neon pillars)
        for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pushStrip(strips, x + cx * ox, y, z + cz * oz, t, sy - rad * 2, t, stripCol, s);
      }
      if (m === 'glass') {
        const yb = y - sy / 2 + e;
        pushStrip(strips, x, yb, z - oz, sx - rad * 2, t, t, stripCol, s);
        pushStrip(strips, x, yb, z + oz, sx - rad * 2, t, t, stripCol, s);
        pushStrip(strips, x - ox, yb, z, t, t, sz - rad * 2, stripCol, s);
        pushStrip(strips, x + ox, yb, z, t, t, sz - rad * 2, stripCol, s);
      }
    } else if (m === 'crystal') {
      // clusters on top corners and hanging underneath
      const n = clamp(Math.round((sx + sz) * 0.9), 2, 10);
      const hue = b.tint != null ? new THREE.Color(parseHex(b.tint)) : new THREE.Color(pal[Math.floor(r() * pal.length)]);
      for (let k = 0; k < n; k++) {
        const under = k % 3 === 2;
        const cx = x + (r() < 0.5 ? -1 : 1) * (sx / 2 - 0.12 - r() * Math.min(0.5, sx * 0.2));
        const cz = z + (r() - 0.5) * sz * 0.9;
        const [px, pz] = r() < 0.5 ? [cx, cz] : [x + (r() - 0.5) * sx * 0.9, z + (r() < 0.5 ? -1 : 1) * (sz / 2 - 0.12 - r() * Math.min(0.5, sz * 0.2))];
        const s = 0.14 + r() * 0.22;
        crystals.push({ x: px, y: under ? y - sy / 2 + 0.05 : top - 0.08, z: pz, s, h: s * (2.2 + r() * 2.4), under, ax: (r() - 0.5) * 0.9, az: (r() - 0.5) * 0.9, col: hue });
      }
    } else if (m === 'grass') {
      const n = clamp(Math.round(sx * sz * 0.55), 2, 40);
      for (let k = 0; k < n; k++) {
        const edge = r() < 0.65;
        let px = x + (r() - 0.5) * (sx - 0.3), pz = z + (r() - 0.5) * (sz - 0.3);
        if (edge) { if (r() < 0.5) px = x + (r() < 0.5 ? -1 : 1) * (sx / 2 - 0.2); else pz = z + (r() < 0.5 ? -1 : 1) * (sz / 2 - 0.2); }
        tufts.push({ x: px, y: top - 0.02, z: pz, s: 0.55 + r() * 0.6, a: r() * TAU });
      }
    } else if (m === 'ice') {
      const n = clamp(Math.round((sx + sz) * 1.4), 3, 24);
      for (let k = 0; k < n; k++) {
        const along = r();
        const side = Math.floor(r() * 4);
        const px = side < 2 ? x + (along - 0.5) * (sx - 0.2) : x + (side === 2 ? -1 : 1) * (sx / 2 - 0.08);
        const pz = side < 2 ? z + (side === 0 ? -1 : 1) * (sz / 2 - 0.08) : z + (along - 0.5) * (sz - 0.2);
        icicles.push({ x: px, y: y - sy / 2 + 0.02, z: pz, w: 0.05 + r() * 0.07, h: 0.25 + r() * 0.55 });
      }
    }
  }
  // one merged mesh per material
  for (const grp of groups.values()) {
    const merged = THREE.mergeGeometries(grp.geos, false);
    for (const g of grp.geos) g.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    own.push(merged);
    const mat = R._mats.getStatic(grp.m, grp.tint);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = grp.m !== 'glass';
    mesh.receiveShadow = true;
    mesh.name = 'static:' + grp.m;
    root.add(mesh);
  }
  for (const g of boxes.values()) g.dispose();
  const U = R._U;
  if (strips.p.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(strips.p, 3));
    geo.setAttribute('aCol', new THREE.Float32BufferAttribute(strips.c, 3));
    geo.setAttribute('aSel', new THREE.Float32BufferAttribute(strips.s, 1));
    geo.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uGain: { value: 2.2 } }]),
      vertexShader: STRIP_VS, fragmentShader: STRIP_FS, fog: true,
    });
    mat.uniforms.uA = U.accentA; mat.uniforms.uB = U.accentB; mat.uniforms.uTime = U.time;
    own.push(geo, mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'static:strips';
    root.add(mesh);
  }
  if (crystals.length) {
    const geo = prismGeometry(6, 0.34);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.18, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: 1, envMapIntensity: 1.5 });
    mat.customProgramCacheKey = () => 'nrgrowth';
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vTip;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvTip = position.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vTip;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
	totalEmissiveRadiance = vColor.rgb * (0.25 + 1.5 * pow(clamp(vTip, 0.0, 1.0), 1.4)) + vColor.rgb * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.0) * 1.2;`);
    };
    const im = new THREE.InstancedMesh(geo, mat, crystals.length);
    crystals.forEach((c, i) => {
      _e.set(c.under ? Math.PI + c.ax * 0.5 : c.ax, c.ax * 3, c.under ? c.az * 0.5 : c.az);
      _m4.compose(_p.set(c.x, c.y, c.z), _q.setFromEuler(_e), _s.set(c.s, c.h, c.s));
      im.setMatrixAt(i, _m4);
      im.setColorAt(i, _c.copy(c.col));
    });
    im.castShadow = true;
    im.computeBoundingSphere();
    own.push(geo, mat);
    im.name = 'static:crystals';
    root.add(im);
  }
  if (tufts.length) {
    const quads = [];
    for (let k = 0; k < 3; k++) {
      const q = new THREE.PlaneGeometry(0.5, 0.36);
      q.translate(0, 0.18, 0);
      q.rotateY(k * Math.PI / 3);
      quads.push(q);
    }
    const geo = THREE.mergeGeometries(quads);
    for (const q of quads) q.dispose();
    const nrm = geo.attributes.normal;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);   // lit like the ground they grow from
    const tex = new THREE.CanvasTexture(painted('blades', paintBlades));
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1, metalness: 0 });
    mat.customProgramCacheKey = () => 'nrtuft';
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U.time;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
	#ifdef USE_INSTANCING
	float nrPh = instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.9;
	#else
	float nrPh = 0.0;
	#endif
	transformed.x += sin(uTime * 2.1 + nrPh) * 0.05 * uv.y;
	transformed.z += cos(uTime * 1.7 + nrPh) * 0.04 * uv.y;`);
    };
    const im = new THREE.InstancedMesh(geo, mat, tufts.length);
    tufts.forEach((t, i) => {
      _m4.compose(_p.set(t.x, t.y, t.z), _q.setFromAxisAngle(UP, t.a), _s.set(t.s, t.s, t.s));
      im.setMatrixAt(i, _m4);
    });
    im.receiveShadow = true;
    im.computeBoundingSphere();
    own.push(geo, mat, tex);
    im.name = 'static:tufts';
    root.add(im);
  }
  if (icicles.length) {
    const geo = new THREE.ConeGeometry(1, 1, 5);
    geo.rotateX(Math.PI);
    geo.translate(0, -0.5, 0);
    const im = new THREE.InstancedMesh(geo, R._mats.get('ice'), icicles.length);
    icicles.forEach((c, i) => {
      _m4.compose(_p.set(c.x, c.y, c.z), _q.identity(), _s.set(c.w, c.h, c.w));
      im.setMatrixAt(i, _m4);
    });
    im.castShadow = true;
    im.computeBoundingSphere();
    own.push(geo);
    im.name = 'static:icicles';
    root.add(im);
  }
  if (Number.isFinite(minX)) {
    R._setArena({ cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2, minY, maxY });
  }
  return {
    root,
    dispose() {
      if (root.parent) root.parent.remove(root);
      for (const o of root.children) if (o.isInstancedMesh) o.dispose();
      for (const x of own) x.dispose();
      own.length = 0;
      root.clear();
    },
  };
}

// ---------- animated surfaces ----------
const SURF_COLORS = {
  lava: ['#ffb347', '#ff3d0a'],
  water: ['#45d6e8', '#0d3a66'],
  void: ['#7c5cff', '#ff4fd8'],
  energy: ['#5ee7ff', '#5ee7ff'],
};
export function makeSurface(type, w, d, R) {
  const kind = SURF_COLORS[type] ? type : 'lava';
  const U = R._U;
  const seg = kind === 'water' ? clamp(Math.ceil(Math.max(w, d) / 0.6), 8, 96) : 1;
  const geo = new THREE.PlaneGeometry(w, d, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const [a, b] = SURF_COLORS[kind];
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uSize: { value: new THREE.Vector2(w, d) },
    uA: { value: col(a, kind === 'lava' ? 1.25 : 1) }, uB: { value: col(b) },
  }]);
  // own clock: update(t) drives it; until the caller does, it follows the renderer's clock
  const clock = { value: 0 };
  let manual = false;
  uniforms.uTime = clock; uniforms.uNoise = U.noise; uniforms.uSky = U.skyHor; uniforms.uSunDir = U.sunDir; uniforms.uSunCol = U.sunCol;
  if (kind === 'void') { uniforms.uA = U.accentA; uniforms.uB = U.accentB; }
  if (kind === 'energy') uniforms.uA = U.accentA;
  const defines = { [kind.toUpperCase()]: '' };
  const mat = new THREE.ShaderMaterial({
    defines, uniforms, vertexShader: SURF_VS, fragmentShader: SURF_FS,
    fog: kind !== 'energy',
    transparent: kind === 'water' || kind === 'energy',
    depthWrite: kind !== 'water' && kind !== 'energy',
    blending: kind === 'energy' ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: kind === 'energy' ? THREE.DoubleSide : THREE.FrontSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'surface:' + kind;
  if (kind === 'water' || kind === 'energy') mesh.renderOrder = 5;
  mesh.onBeforeRender = () => { if (!manual) clock.value = U.time.value; };
  return {
    mesh,
    update(t) { if (Number.isFinite(t)) { manual = true; clock.value = t; } },
    dispose() { if (mesh.parent) mesh.parent.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
