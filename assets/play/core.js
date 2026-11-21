// VERAQIS Play — shared shell, effects and sound for the browser games under /play/.
// No network requests and no inline styles (the page CSP allows only 'self' scripts and
// stylesheets): visuals are classes, CSSOM properties set from JS, and two canvases.
// Progress is a per-browser convenience kept in localStorage; every access is wrapped so the
// games still work in private windows or with storage blocked.

import { veraPortrait } from './characters.js';

const KEY = 'veraqis.play.v1';
export const GAMES = {
  guardian: { title: 'Vera: Archive Guardian', href: '/play/guardian/', levels: 8 },
  gatekeeper: { title: 'Gatekeeper', href: '/play/gatekeeper/', levels: 8 },
  'magic-bytes': { title: 'Magic Bytes', href: '/play/magic-bytes/', levels: 8 },
  'bit-rot': { title: 'Bit Rot Hunt', href: '/play/bit-rot/', levels: 8 },
};

function readAll() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
function writeAll(v) {
  try { window.localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* storage unavailable */ }
}
export function progress(game) {
  const g = readAll()[game] || {};
  return { levels: g.levels || {}, endless: g.endless || 0 };
}
export function saveLevel(game, n, stars, score) {
  const all = readAll();
  const g = all[game] || (all[game] = {});
  g.levels = g.levels || {};
  const prev = g.levels[n] || { stars: 0, best: 0 };
  g.levels[n] = { stars: Math.max(prev.stars, stars), best: Math.max(prev.best, score) };
  writeAll(all);
  return prev;
}
export function saveEndless(game, score) {
  const all = readAll();
  const g = all[game] || (all[game] = {});
  const prev = g.endless || 0;
  g.endless = Math.max(prev, score);
  writeAll(all);
  return prev;
}
export function totalStars(game) {
  return Object.values(progress(game).levels).reduce((s, l) => s + (l.stars || 0), 0);
}
function getPref(k, d) { const p = readAll()._prefs || {}; return k in p ? p[k] : d; }
function setPref(k, v) { const all = readAll(); all._prefs = { ...(all._prefs || {}), [k]: v }; writeAll(all); }

// ---------- tiny DOM helper (never sets a style attribute) ----------
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
// Vera, the guide of every game, with a speech bubble.
export function veraSays(text, mood = 'ok') {
  return h('div', { class: 'vera-says' + (mood === 'sad' ? ' vera-says--sad' : '') }, veraPortrait(72, mood),
    h('p', { class: 'vera-bubble' }, h('b', null, 'Vera: '), text));
}
export function starsEl(n, max = 3, big = false) {
  const s = h('span', { class: 'stars' + (big ? ' stars--big' : ''), role: 'img', 'aria-label': `${n} of ${max} stars` });
  for (let i = 0; i < max; i++) s.append(h('span', { class: 'star' + (i < n ? ' on' : ''), 'aria-hidden': 'true' }, '★'));
  return s;
}

// ---------- utilities ----------
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    shuffle(arr) {
      const a2 = arr.slice();
      for (let i = a2.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a2[i], a2[j]] = [a2[j], a2[i]]; }
      return a2;
    },
  };
}
export function seedFromUrl() {
  try {
    const s = new URLSearchParams(window.location.search).get('seed');
    if (s && /^\d{1,9}$/.test(s)) return Number(s);
  } catch { /* ignore */ }
  return (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
}
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
export function fmtBytes(n) {
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  const v = n >= 100 || i === 0 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${v.toLocaleString('en-US')} ${UNITS[i]}`;
}
export const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
export const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};
export function loop(step) {
  let last = performance.now();
  let alive = true;
  let id = 0;
  const tick = (t) => {
    if (!alive) return;
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000)); // a hidden tab pauses the game
    last = t;
    if (step(dt) === false) { alive = false; return; }
    id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return () => { alive = false; cancelAnimationFrame(id); };
}
export function toast(host, text, kind = 'info', ms = 2400) {
  const t = h('div', { class: `toast toast--${kind}` }, text);
  host.append(t);
  while (host.children.length > 2) host.firstChild.remove();
  const out = setTimeout(() => t.classList.add('out'), Math.max(200, ms - 260));
  const gone = setTimeout(() => t.remove(), ms);
  return () => { clearTimeout(out); clearTimeout(gone); t.remove(); };
}
export function pop(stage, el, text, kind = '') {
  if (reducedMotion() || !stage) return;
  const sr = stage.getBoundingClientRect();
  const r = el ? el.getBoundingClientRect() : sr;
  const p = h('div', { class: 'pop' + (kind ? ' ' + kind : ''), 'aria-hidden': 'true' }, text);
  p.style.left = `${Math.round(r.left - sr.left + r.width / 2)}px`;
  p.style.top = `${Math.round(r.top - sr.top + Math.min(36, r.height / 3))}px`;
  stage.append(p);
  window.setTimeout(() => p.remove(), 950);
}
export function shake(el, strong = false) {
  if (reducedMotion() || !el) return;
  el.classList.remove('shake', 'shake--strong');
  void el.offsetWidth; // restart the animation
  el.classList.add(strong ? 'shake--strong' : 'shake');
}

// ---------- sound: tiny WebAudio synth, no files ----------
export const sfx = {
  ctx: null,
  master: null,
  muted: getPref('muted', false),
  ensure() {
    if (this.muted) return null;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.5;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch { return null; }
  },
  setMuted(m) { this.muted = m; setPref('muted', m); if (m && this.ctx) this.ctx.suspend?.(); else this.ensure(); },
  tone(freq, dur = 0.12, type = 'square', vol = 0.06, slideTo = 0, delay = 0) {
    const c = this.ensure(); if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator(); const g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  },
  noise(dur = 0.25, vol = 0.12, cutoff = 1800, delay = 0) {
    const c = this.ensure(); if (!c) return;
    const t0 = c.currentTime + delay;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = c.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0);
  },
  click() { this.tone(660, 0.05, 'square', 0.03); },
  good(combo = 1) { const b = 520 + Math.min(6, combo) * 40; this.tone(b, 0.08, 'triangle', 0.07); this.tone(b * 1.5, 0.12, 'triangle', 0.06, 0, 0.06); },
  zap() { this.tone(900, 0.16, 'sawtooth', 0.05, 120); this.noise(0.12, 0.05, 3000); },
  bad() { this.tone(140, 0.32, 'sawtooth', 0.08, 70); this.noise(0.35, 0.14, 900); },
  boom() { this.noise(0.6, 0.22, 700); this.tone(90, 0.5, 'sine', 0.12, 40); },
  power() { [330, 440, 554, 660].forEach((f, i) => this.tone(f, 0.12, 'square', 0.04, 0, i * 0.05)); },
  scan() { this.tone(1200, 0.06, 'sine', 0.025, 1800); },
  win() { [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.07, 0, i * 0.11)); },
  lose() { [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.22, 'sawtooth', 0.05, 0, i * 0.14)); },
  tick() { this.tone(1500, 0.03, 'square', 0.018); },
};

// ---------- canvas effects: byte rain behind, particles and shockwaves in front ----------
export class FX {
  constructor(stage) {
    this.stage = stage;
    this.calm = reducedMotion();
    this.bg = h('canvas', { class: 'fx fx-bg', 'aria-hidden': 'true' });
    this.top = h('canvas', { class: 'fx fx-top', 'aria-hidden': 'true' });
    stage.prepend(this.bg);
    stage.append(this.top);
    this.bctx = this.bg.getContext('2d');
    this.tctx = this.top.getContext('2d');
    this.parts = [];
    this.rings = [];
    this.flashA = 0;
    this.flashC = '255,107,107';
    this.mood = 0;        // 0 calm … 1 frantic (speeds up the rain)
    this.alert = 0;       // red tint after a breach, decays
    this.drops = [];
    this.resize();
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.resize()) : null;
    this.ro?.observe(stage);
    this.stop = loop((dt) => { this.frame(dt); return true; });
  }
  resize() {
    const r = this.stage.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height); this.dpr = dpr;
    for (const c of [this.bg, this.top]) {
      c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr);
    }
    const cols = Math.ceil(this.w / 22);
    this.drops = Array.from({ length: cols }, (_, i) => ({ x: i * 22 + 6, y: Math.random() * this.h, v: 18 + Math.random() * 42, s: Math.random() }));
  }
  point(el) {
    const sr = this.stage.getBoundingClientRect();
    if (!el) return { x: this.w / 2, y: this.h / 2 };
    const r = el.getBoundingClientRect();
    return { x: r.left - sr.left + r.width / 2, y: r.top - sr.top + r.height / 2 };
  }
  burst(at, color = '61,220,151', n = 28, speed = 260) {
    if (this.calm) n = Math.min(n, 6);
    const p = at && at.nodeType ? this.point(at) : at || this.point(null);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.75);
      this.parts.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 0, max: 0.5 + Math.random() * 0.6,
        size: 1.6 + Math.random() * 2.8, color, g: 380, rect: false });
    }
  }
  ring(at, color = '167,139,250', max = 160) {
    if (this.calm) return;
    const p = at && at.nodeType ? this.point(at) : at || this.point(null);
    this.rings.push({ x: p.x, y: p.y, r: 6, max, life: 0, color });
  }
  flash(color = '255,107,107', a = 0.35) { this.flashC = color; this.flashA = this.calm ? Math.min(a, 0.15) : a; }
  confetti(n = 140) {
    if (this.calm) n = 24;
    const cols = ['255,209,102', '167,139,250', '61,220,151', '124,58,237', '255,107,107', '96,165,250'];
    for (let i = 0; i < n; i++) {
      this.parts.push({ x: Math.random() * this.w, y: -10 - Math.random() * this.h * 0.4, vx: (Math.random() - 0.5) * 120, vy: 60 + Math.random() * 160,
        life: 0, max: 2.4 + Math.random() * 1.6, size: 4 + Math.random() * 5, color: cols[i % cols.length], g: 160, rect: true, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12 });
    }
  }
  frame(dt) {
    const b = this.bctx; const t = this.tctx; const dpr = this.dpr;
    // background: byte rain
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    b.clearRect(0, 0, this.w, this.h);
    this.alert = Math.max(0, this.alert - dt * 0.9);
    const red = this.alert;
    const grad = b.createRadialGradient(this.w * 0.5, this.h * 0.15, 10, this.w * 0.5, this.h * 0.4, Math.max(this.w, this.h));
    grad.addColorStop(0, `rgba(${Math.round(124 + 120 * red)},58,${Math.round(237 - 150 * red)},0.22)`);
    grad.addColorStop(1, 'rgba(20,13,39,0)');
    b.fillStyle = grad; b.fillRect(0, 0, this.w, this.h);
    b.font = '12px ui-monospace, Menlo, Consolas, monospace';
    const speedMul = this.calm ? 0 : 1 + this.mood * 2.2;
    for (const d of this.drops) {
      d.y += d.v * dt * speedMul;
      if (d.y > this.h + 120) { d.y = -40 - Math.random() * 200; d.s = Math.random(); }
      for (let k = 0; k < 6; k++) {
        const yy = d.y - k * 16;
        if (yy < -16 || yy > this.h + 16) continue;
        const a = (0.16 - k * 0.025) * (0.5 + d.s * 0.5);
        b.fillStyle = red > 0.05 ? `rgba(255,120,130,${a})` : `rgba(167,139,250,${a})`;
        const v = ((d.x * 7 + Math.floor(yy / 16) * 13 + k) & 255).toString(16).toUpperCase().padStart(2, '0');
        b.fillText(v, d.x, yy);
      }
    }
    // foreground: particles, rings, flash
    t.setTransform(dpr, 0, 0, dpr, 0, 0);
    t.clearRect(0, 0, this.w, this.h);
    if (!this.parts.length && !this.rings.length && this.flashA <= 0) return;
    t.globalCompositeOperation = 'lighter';
    this.parts = this.parts.filter((p) => (p.life += dt) < p.max);
    for (const p of this.parts) {
      p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      const a = 1 - p.life / p.max;
      t.fillStyle = `rgba(${p.color},${a.toFixed(3)})`;
      if (p.rect) {
        p.rot += p.vr * dt;
        t.save(); t.translate(p.x, p.y); t.rotate(p.rot); t.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); t.restore();
      } else {
        t.beginPath(); t.arc(p.x, p.y, p.size * (0.6 + a * 0.6), 0, Math.PI * 2); t.fill();
      }
    }
    this.rings = this.rings.filter((r) => (r.life += dt) < 0.55);
    for (const r of this.rings) {
      const k = r.life / 0.55;
      t.strokeStyle = `rgba(${r.color},${(1 - k).toFixed(3)})`;
      t.lineWidth = 3 * (1 - k) + 1;
      t.beginPath(); t.arc(r.x, r.y, r.r + (r.max - r.r) * k, 0, Math.PI * 2); t.stroke();
    }
    t.globalCompositeOperation = 'source-over';
    if (this.flashA > 0) {
      t.fillStyle = `rgba(${this.flashC},${this.flashA.toFixed(3)})`;
      t.fillRect(0, 0, this.w, this.h);
      this.flashA = Math.max(0, this.flashA - dt * 1.6);
    }
  }
  destroy() { this.stop(); this.ro?.disconnect(); this.bg.remove(); this.top.remove(); }
}

// ---------- HUD ----------
export function hud(host, items, onQuit) {
  const bar = h('div', { class: 'hud' });
  const vals = {};
  for (const [key, label, value] of items) {
    const v = h('span', { class: 'hud-v' }, value);
    vals[key] = v;
    bar.append(h('div', { class: 'hud-item hud-item--' + key }, h('span', { class: 'hud-k' }, label), v));
  }
  if (onQuit) {
    bar.append(h('div', { class: 'hud-quit' },
      soundToggle(),
      h('button', { class: 'g-btn g-btn--ghost', type: 'button', onclick: onQuit, title: 'Back to levels (Esc)' }, 'Levels ', h('span', { class: 'g-key' }, 'Esc'))));
  }
  host.append(bar);
  return {
    el: bar,
    item: (key) => vals[key],
    set(key, value, cls) {
      const v = vals[key];
      if (!v) return;
      v.textContent = '';
      v.append(value instanceof Node ? value : String(value));
      v.className = 'hud-v' + (cls ? ' ' + cls : '');
    },
  };
}
export function paintSound(b) {
  b.textContent = '';
  b.append(h('span', { class: 'g-sound-ic', 'aria-hidden': 'true' }, sfx.muted ? '🔇' : '🔊'), h('span', { class: 'g-sound-txt' }, sfx.muted ? 'Sound off' : 'Sound on'));
  b.setAttribute('aria-pressed', String(!sfx.muted));
  b.setAttribute('aria-label', 'Sound');
}
export function soundToggle() {
  const b = h('button', { class: 'g-btn g-btn--ghost g-sound', type: 'button', title: 'Sound on/off (M)' });
  b.addEventListener('click', () => { sfx.setMuted(!sfx.muted); paintSound(b); if (!sfx.muted) sfx.click(); });
  paintSound(b);
  return b;
}

// ---------- the game shell: level select → brief → play → result ----------
export class Game {
  constructor(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.cleanup = null;
    root.textContent = '';
    this.stage = h('div', { class: 'stage', tabindex: '-1' });
    this.view = h('div', { class: 'stage-view' });
    this.toasts = h('div', { class: 'toasts', 'aria-hidden': 'true' });
    this.live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    this.stage.append(this.view, this.toasts);
    root.append(this.stage, this.live);
    this.fx = new FX(this.stage);
    this.onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Escape' && this.mode === 'play') { e.preventDefault(); this.menu(); }
      if ((e.key === 'm' || e.key === 'M') && !(e.target instanceof HTMLInputElement)) {
        sfx.setMuted(!sfx.muted);
        this.stage.querySelectorAll('.g-sound').forEach((b) => paintSound(b));
      }
    };
    document.addEventListener('keydown', this.onKey);
    const want = (() => { try { return new URLSearchParams(window.location.search).get('level'); } catch { return null; } })();
    const n = want ? Number(want) : 0;
    if (n >= 1 && n <= cfg.levels.length && this.unlocked(n - 1)) this.brief(n - 1);
    else this.menu();
  }

  say(text) {
    this.live.textContent = '';
    window.setTimeout(() => { this.live.textContent = text; }, 40);
  }

  reset(mode) {
    if (this.cleanup) { try { this.cleanup(); } catch { /* ignore */ } this.cleanup = null; }
    this.mode = mode;
    this.view.textContent = '';
    this.toasts.textContent = '';
    this.stage.className = 'stage stage--' + mode;
    this.fx.mood = 0;
  }

  unlocked(i) {
    if (i <= 0) return true;
    const prev = progress(this.cfg.id).levels[i];
    return !!(prev && prev.stars > 0);
  }
  endlessUnlocked() {
    const p = progress(this.cfg.id).levels;
    return this.cfg.levels.every((_, i) => p[i + 1] && p[i + 1].stars > 0);
  }

  menu() {
    this.reset('menu');
    const p = progress(this.cfg.id);
    const max = this.cfg.levels.length * 3;
    const got = totalStars(this.cfg.id);
    this.view.append(h('div', { class: 'lv-head' },
      h('div', null, h('p', { class: 'g-kicker' }, this.cfg.title), h('h2', null, 'Choose a level')),
      h('div', { class: 'lv-head-r' }, h('span', { class: 'g-muted lv-total' }, '★ ', h('b', null, String(got)), ` / ${max}`), soundToggle())));
    const grid = h('div', { class: 'lv-grid' });
    let firstOpen = null;
    this.cfg.levels.forEach((lv, i) => {
      const open = this.unlocked(i);
      const rec = p.levels[i + 1];
      const btn = h('button', {
        class: 'lv' + (rec && rec.stars === 3 ? ' lv--perfect' : ''), type: 'button', disabled: !open,
        'aria-label': `Level ${i + 1}: ${lv.name}${open ? '' : ' (locked)'}${rec ? `, ${rec.stars} stars` : ''}`,
        onclick: () => { sfx.click(); this.brief(i); },
      },
      h('span', { class: 'lv-num' }, `LEVEL ${String(i + 1).padStart(2, '0')}`),
      h('span', { class: 'lv-name' }, lv.name),
      h('span', { class: 'lv-blurb' }, lv.blurb),
      h('span', { class: 'lv-foot' },
        open ? starsEl(rec ? rec.stars : 0) : h('span', { class: 'lv-lock' }, '🔒 clear the level before'),
        rec && rec.best ? h('span', { class: 'lv-best' }, `best ${fmtInt(rec.best)}`) : null));
      if (open && !rec && !firstOpen) firstOpen = btn;
      grid.append(btn);
    });
    if (this.cfg.endless) {
      const open = this.endlessUnlocked();
      grid.append(h('button', {
        class: 'lv lv--endless', type: 'button', disabled: !open,
        onclick: () => { sfx.click(); this.brief('endless'); },
      },
      h('span', { class: 'lv-num' }, this.cfg.endless.tag || 'ENDLESS'),
      h('span', { class: 'lv-name' }, this.cfg.endless.name),
      h('span', { class: 'lv-blurb' }, this.cfg.endless.blurb),
      h('span', { class: 'lv-foot' },
        open ? h('span', { class: 'lv-best' }, p.endless ? `best ${fmtInt(p.endless)}` : 'no score yet') : h('span', { class: 'lv-lock' }, `🔒 unlocks after all ${this.cfg.levels.length} levels`))));
    }
    this.view.append(grid);
    if (this.cfg.howto) this.view.append(h('p', { class: 'g-dim lv-howto' }, this.cfg.howto));
    (firstOpen || grid.querySelector('.lv:not([disabled])'))?.focus({ preventScroll: true });
  }

  levelOf(i) { return i === 'endless' ? this.cfg.endless : this.cfg.levels[i]; }
  labelOf(i) { return i === 'endless' ? (this.cfg.endless.tag || 'Endless') : `Level ${i + 1}`; }

  brief(i) {
    this.reset('brief');
    const lv = this.levelOf(i);
    const list = h('ul', { class: 'brief' });
    for (const [tag, text, isNew] of lv.brief || []) {
      list.append(h('li', null, h('span', { class: 'tag' + (isNew ? ' tag--new' : '') }, isNew ? `NEW · ${tag}` : tag), h('span', null, text)));
    }
    const start = h('button', { class: 'g-btn g-btn--primary g-btn--big g-btn--glow', type: 'button', onclick: () => { sfx.power(); this.run(i); } }, '▶ Start ', h('span', { class: 'g-key' }, 'Enter'));
    this.view.append(h('div', { class: 'brief-wrap' },
      h('p', { class: 'g-kicker' }, `${this.labelOf(i)} · ${lv.name}`),
      h('h2', null, lv.title || lv.name),
      lv.say ? veraSays(lv.say) : null,
      lv.intro ? h('p', null, lv.intro) : null,
      list,
      this.cfg.controls ? h('p', { class: 'g-dim' }, this.cfg.controls) : null,
      h('div', { class: 'g-actions' }, start, h('button', { class: 'g-btn g-btn--ghost', type: 'button', onclick: () => this.menu() }, 'All levels'))));
    start.focus({ preventScroll: true });
    this.say(`${this.labelOf(i)}: ${lv.name}. Press Enter to start.`);
  }

  run(i) {
    this.reset('play');
    const lv = this.levelOf(i);
    const area = h('div', { class: 'play-area' });
    this.view.append(area);
    let done = false;
    const api = {
      level: lv,
      index: i,
      endless: i === 'endless',
      area,
      stage: this.stage,
      view: this.view,
      toasts: this.toasts,
      fx: this.fx,
      sfx,
      seed: seedFromUrl(),
      say: (t) => this.say(t),
      quit: () => this.menu(),
      finish: (r) => {
        if (done) return;
        done = true;
        if (r.won || r.endlessDone) { sfx.win(); this.fx.confetti(); } else { sfx.lose(); }
        window.setTimeout(() => { if (this.mode === 'play') this.result(i, r); }, r.delay ?? 650);
      },
    };
    this.cleanup = this.cfg.play(api) || null;
    this.stage.focus({ preventScroll: true });
    this.reveal();
  }

  // Bring the whole stage into view below the sticky site header when a level starts.
  reveal() {
    try {
      const r = this.stage.getBoundingClientRect();
      const header = document.querySelector('header');
      const top = (header ? header.getBoundingClientRect().height : 0) + 8;
      if (r.top < top || r.bottom > window.innerHeight) {
        window.scrollTo({ top: Math.max(0, window.scrollY + r.top - top), behavior: reducedMotion() ? 'auto' : 'smooth' });
      }
    } catch { /* ignore */ }
  }

  result(i, r) {
    this.reset('result');
    const lv = this.levelOf(i);
    const endless = i === 'endless';
    let prevBest = 0;
    let prevStars = 0;
    if (endless) prevBest = saveEndless(this.cfg.id, r.score || 0);
    else if (r.won) ({ best: prevBest, stars: prevStars } = saveLevel(this.cfg.id, i + 1, r.stars, r.score || 0));
    else prevBest = (progress(this.cfg.id).levels[i + 1] || {}).best || 0;
    const newBest = (r.score || 0) > prevBest && (r.won || endless);
    const stats = h('dl', { class: 'res-stats' });
    for (const [k, v] of r.stats || []) stats.append(h('div', null, h('dt', null, k), h('dd', null, v)));
    const nextOpen = !endless && r.won && i + 1 < this.cfg.levels.length;
    const buttons = [];
    if (nextOpen) buttons.push(h('button', { class: 'g-btn g-btn--primary g-btn--big g-btn--glow', type: 'button', onclick: () => { sfx.click(); this.brief(i + 1); } }, 'Next level ▶ ', h('span', { class: 'g-key' }, 'Enter')));
    else if (!endless && r.won && this.cfg.endless && this.endlessUnlocked()) buttons.push(h('button', { class: 'g-btn g-btn--primary g-btn--big g-btn--glow', type: 'button', onclick: () => this.brief('endless') }, `${this.cfg.endless.name} unlocked ▶`));
    buttons.push(h('button', { class: 'g-btn' + (buttons.length ? '' : ' g-btn--primary g-btn--big'), type: 'button', onclick: () => { sfx.click(); this.run(i); } }, r.won || endless ? '↻ Play again' : '↻ Try again'));
    buttons.push(h('button', { class: 'g-btn g-btn--ghost', type: 'button', onclick: () => this.menu() }, 'All levels'));
    const lesson = r.lesson || lv.lesson;
    const line = r.say || (endless ? 'Nice run! Your best score stays in this browser.'
      : !r.won ? 'That one got past us. Read the note below, then let’s try again.'
        : r.stars === 3 ? 'Perfect — proof first, every time.'
          : r.stars === 2 ? 'Cleared! One more star to earn on this one.' : 'Cleared! Two more stars are waiting here.');
    const score = h('div', { class: 'score' }, '0');
    this.view.append(h('div', { class: 'result' + (r.won || endless ? ' result--won' : ' result--lost') },
      h('p', { class: 'g-kicker' }, `${this.labelOf(i)} · ${lv.name}`),
      h('h2', null, r.title || (endless ? 'Run over' : r.won ? 'Level cleared' : 'Level failed')),
      !endless ? starsEl(r.won ? r.stars : 0, 3, true) : null,
      veraSays(line, r.won || endless ? 'happy' : 'sad'),
      score,
      newBest ? h('span', { class: 'best' }, 'NEW BEST') : null,
      r.won && !endless && r.stars > prevStars && prevStars > 0 ? h('p', { class: 'g-dim' }, `Up from ${prevStars} ★`) : null,
      stats,
      lesson ? h('div', { class: 'lesson' }, h('strong', null, 'What this was: '), ...(Array.isArray(lesson) ? lesson : [lesson]),
        lv.learn ? [' ', h('a', { href: lv.learn.href }, lv.learn.text + ' →')] : null) : null,
      h('div', { class: 'g-actions' }, ...buttons)));
    // count the score up
    const target = r.score || 0;
    if (reducedMotion() || target === 0) score.textContent = fmtInt(target);
    else {
      let shown = 0;
      const stop = loop((dt) => {
        shown = Math.min(target, shown + Math.max(1, target * dt * 1.6));
        score.textContent = fmtInt(shown);
        if (shown >= target) { score.textContent = fmtInt(target); return false; }
        return true;
      });
      this.cleanup = stop;
    }
    if (r.won && !endless) for (let s = 0; s < r.stars; s++) window.setTimeout(() => sfx.tone(784 + s * 196, 0.12, 'triangle', 0.06), 200 + s * 180);
    buttons[0].focus({ preventScroll: true });
    this.say(`${r.title || (r.won ? 'Level cleared' : 'Level failed')}. Score ${fmtInt(target)}.${r.won && !endless ? ` ${r.stars} stars.` : ''}`);
  }
}
