// VERAQIS Play — hub page: animated arcade panel, the Guardian card's live scene, and
// per-browser progress.
import { FX, GAMES, totalStars, loop, reducedMotion } from './core.js';
import { drawVera, drawSlipper, drawRot, drawBomblet, drawLinker, drawBlock, drawHole } from './characters.js';

const RANKS = [[0, 'Visitor'], [8, 'Apprentice'], [24, 'Analyst'], [48, 'Investigator'], [72, 'Forensic lead'], [96, 'Proof-first']];

const panel = document.getElementById('arcade');
if (panel) new FX(panel);

let got = 0;
let max = 0;
for (const [id, g] of Object.entries(GAMES)) {
  const n = totalStars(id);
  got += n;
  max += g.levels * 3;
  const el = document.querySelector(`[data-progress="${id}"]`);
  if (el) el.textContent = n ? `★ ${n} / ${g.levels * 3}` : 'not started';
}
const rank = RANKS.filter(([need]) => got >= need).pop()[1];
const rankEl = document.getElementById('play-rank');
if (rankEl) {
  rankEl.textContent = '';
  const b = document.createElement('b');
  b.textContent = rank;
  rankEl.append('Rank: ', b, ` · ★ ${got} / ${max}`);
}

// Attract mode for the Guardian card: creatures walk in, Vera zaps them, blocks bob.
function scene(cv) {
  const W = 320;
  const H = 110;
  const T = 30;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = W * dpr;
  cv.height = H * dpr;
  const c = cv.getContext('2d');
  if (!c) return;
  const kinds = ['slipper', 'rot', 'bomblet', 'linker'];
  const foes = [];
  const parts = [];
  let n = 0;
  let t = 0;
  let spawn = 0.2;
  let cd = 0.6;
  let beam = null;
  let visible = true;
  try {
    new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }).observe(cv);
  } catch { /* always animate */ }
  const vx = 46;
  const vy = 62;
  const frame = (dt) => {
    t += dt; spawn -= dt; cd -= dt;
    if (spawn <= 0) { foes.push({ kind: kinds[n++ % kinds.length], x: W + 20, t: Math.random() * 5 }); spawn = 1.7; }
    for (const f of foes) { f.x -= 42 * dt; f.t += dt; }
    const target = foes.find((f) => f.x < 230 && f.x > vx + 30);
    if (target && cd <= 0) {
      cd = 1.1;
      beam = { x: target.x, t: 0.16 };
      target.dead = true;
      const col = { slipper: '61,220,151', rot: '255,95,109', bomblet: '255,209,102', linker: '255,209,102' }[target.kind];
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = 40 + Math.random() * 110;
        parts.push({ x: target.x, y: vy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: 0.4 + Math.random() * 0.5, col });
      }
    }
    for (let i = foes.length - 1; i >= 0; i--) if (foes[i].dead || foes[i].x < -30) foes.splice(i, 1);
    for (let i = parts.length - 1; i >= 0; i--) { const q = parts[i]; q.life += dt; q.x += q.vx * dt; q.y += q.vy * dt; if (q.life > q.max) parts.splice(i, 1); }
    if (beam) { beam.t -= dt; if (beam.t <= 0) beam = null; }
    // draw
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0d0820'; c.fillRect(0, 0, W, H);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 11; x++) {
      c.fillStyle = (x + y) % 2 ? '#160f30' : '#120b28';
      c.fillRect(x * T, y * T - 5, T, T);
    }
    c.fillStyle = '#2b1f55'; c.fillRect(0, 0, W, 10); c.fillRect(0, H - 10, W, 10);
    drawHole(c, W - 18, 22, 26, t);
    drawBlock(c, 120, 26, 26, t, 'g'); drawBlock(c, 180, 92, 26, t, 'q'); drawBlock(c, 250, 92, 26, t, 'g');
    for (const f of foes) {
      if (f.kind === 'slipper') drawSlipper(c, f.x, vy, T, f.t * 1.5, { look: { x: -1, y: 0 } });
      else if (f.kind === 'rot') drawRot(c, f.x, vy, T, f.t, { dir: { x: -1, y: 0 } });
      else if (f.kind === 'bomblet') drawBomblet(c, f.x, vy, T, f.t, Math.min(3, Math.floor(f.t / 1.4)), false);
      else drawLinker(c, f.x, vy, T, f.t, { look: { x: -1, y: 0 } });
    }
    drawVera(c, vx, vy, T * 1.15, { t, face: 1, look: { x: 1, y: 0 }, moving: true, walk: t * 2.2, zap: !!beam });
    if (beam) {
      const a = beam.t / 0.16;
      c.strokeStyle = `rgba(94,231,255,${a})`; c.lineWidth = 4; c.lineCap = 'round';
      c.shadowColor = '#5ee7ff'; c.shadowBlur = 14;
      c.beginPath(); c.moveTo(vx + 18, vy + 3); c.lineTo(beam.x, vy); c.stroke();
      c.shadowBlur = 0;
    }
    c.globalCompositeOperation = 'lighter';
    for (const q of parts) { c.fillStyle = `rgba(${q.col},${(1 - q.life / q.max).toFixed(3)})`; c.beginPath(); c.arc(q.x, q.y, 2.4, 0, Math.PI * 2); c.fill(); }
    c.globalCompositeOperation = 'source-over';
  };
  if (reducedMotion()) { spawn = 0; frame(0.01); foes.forEach((f, i) => { f.x = 160 + i * 60; }); frame(0); return; }
  loop((dt) => { if (visible && !document.hidden) frame(dt); return true; });
}
document.querySelectorAll('canvas[data-scene="guardian"]').forEach(scene);
