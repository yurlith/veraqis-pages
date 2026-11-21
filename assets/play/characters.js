// VERAQIS Play — characters, drawn procedurally on canvas (no image files, CSP-safe).
// Every function draws centred on (x, y) at tile size s. t is time in seconds for animation.
//   Vera     — the guardian robot you play (and the guide in every game)
//   Slipper  — Zip Slip goblin: runs for the "../" holes to escape the destination
//   Rot      — bit-rot beetle: turns verified data red
//   Bomblet  — compression bomb: grows, then floods the tiles around it
//   Linker   — symlink imp: opens portals that redirect wherever it likes
//   Hydra    — the overlap boss: one body, many heads reading the same bytes

const TAU = Math.PI * 2;

export function rr(c, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + k, y);
  c.arcTo(x + w, y, x + w, y + h, k);
  c.arcTo(x + w, y + h, x, y + h, k);
  c.arcTo(x, y + h, x, y, k);
  c.arcTo(x, y, x + w, y, k);
  c.closePath();
}
function shadow(c, s, w = 0.3, y = 0.4) {
  c.fillStyle = 'rgba(0,0,0,.35)';
  c.beginPath(); c.ellipse(0, s * y, s * w, s * 0.08, 0, 0, TAU); c.fill();
}
function glow(c, r, color, a = 0.28) {
  const g = c.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, `rgba(${color},${a})`);
  g.addColorStop(1, `rgba(${color},0)`);
  c.fillStyle = g;
  c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
}
function eye(c, x, y, r, lookX, lookY, blink, white = '#ffffff', pupil = '#1b1233') {
  c.save();
  c.translate(x, y);
  c.scale(1, blink ? 0.12 : 1);
  c.fillStyle = white; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
  c.fillStyle = pupil; c.beginPath(); c.arc(lookX * r * 0.45, lookY * r * 0.45, r * 0.5, 0, TAU); c.fill();
  c.restore();
}

// ---------- Vera ----------
export function drawVera(c, x, y, s, o = {}) {
  const t = o.t || 0;
  const face = o.face || 1;
  const look = o.look || { x: face, y: 0 };
  const moving = !!o.moving;
  const walk = o.walk || 0;
  const mood = o.mood || 'ok';
  const blink = (t % 3.7) < 0.12;
  const bob = Math.sin(t * 5) * s * 0.018 - (moving ? Math.abs(Math.sin(walk * Math.PI)) * s * 0.045 : 0);
  c.save();
  c.translate(x, y);
  if (o.alpha != null) c.globalAlpha = o.alpha;
  shadow(c, s, 0.26, 0.4);
  c.translate(0, bob);
  if (o.glow !== false) glow(c, s * 0.75, '94,231,255', o.zap ? 0.45 : 0.22);
  // feet
  const f = moving ? Math.sin(walk * TAU) : 0;
  c.fillStyle = '#2b1f55';
  rr(c, -s * 0.2, s * 0.25 + f * s * 0.03, s * 0.15, s * 0.1, s * 0.045); c.fill();
  rr(c, s * 0.05, s * 0.25 - f * s * 0.03, s * 0.15, s * 0.1, s * 0.045); c.fill();
  // body
  const bg = c.createLinearGradient(0, 0, 0, s * 0.32);
  bg.addColorStop(0, '#8b5cf6'); bg.addColorStop(1, '#5b21b6');
  c.fillStyle = bg;
  rr(c, -s * 0.24, s * 0.0, s * 0.48, s * 0.3, s * 0.11); c.fill();
  c.strokeStyle = '#1b1233'; c.lineWidth = Math.max(1, s * 0.03); c.stroke();
  // chest light
  const pulse = 0.6 + 0.4 * Math.sin(t * 4);
  c.fillStyle = `rgba(255,209,102,${pulse})`;
  c.beginPath(); c.arc(0, s * 0.14, s * 0.05, 0, TAU); c.fill();
  // arms
  c.fillStyle = '#6d28d9';
  rr(c, -s * 0.33, s * 0.05, s * 0.1, s * 0.17, s * 0.05); c.fill();
  if (o.zap) {
    c.save(); c.scale(face < 0 ? -1 : 1, 1);
    c.fillStyle = '#6d28d9'; rr(c, s * 0.2, s * 0.06, s * 0.24, s * 0.1, s * 0.05); c.fill();
    c.fillStyle = '#5ee7ff'; c.shadowColor = '#5ee7ff'; c.shadowBlur = s * 0.2;
    c.beginPath(); c.arc(s * 0.45, s * 0.11, s * 0.06, 0, TAU); c.fill();
    c.shadowBlur = 0;
    c.restore();
  } else {
    rr(c, s * 0.23, s * 0.05, s * 0.1, s * 0.17, s * 0.05); c.fill();
  }
  // head
  const hg = c.createRadialGradient(-s * 0.08, -s * 0.24, s * 0.02, 0, -s * 0.14, s * 0.28);
  hg.addColorStop(0, '#e9ddff'); hg.addColorStop(1, '#a78bfa');
  c.fillStyle = hg;
  c.beginPath(); c.arc(0, -s * 0.14, s * 0.25, 0, TAU); c.fill();
  c.strokeStyle = '#1b1233'; c.stroke();
  // visor
  c.fillStyle = '#0d0820';
  rr(c, -s * 0.18, -s * 0.22, s * 0.36, s * 0.15, s * 0.07); c.fill();
  c.strokeStyle = 'rgba(94,231,255,.8)'; c.lineWidth = Math.max(1, s * 0.02); c.stroke();
  // eyes
  const ex = look.x * s * 0.035;
  const ey = look.y * s * 0.02;
  c.fillStyle = '#5ee7ff';
  c.shadowColor = '#5ee7ff'; c.shadowBlur = s * 0.15;
  if (mood === 'happy') {
    c.strokeStyle = '#5ee7ff'; c.lineWidth = Math.max(1.2, s * 0.03);
    for (const dx of [-0.08, 0.08]) { c.beginPath(); c.arc(dx * s + ex, -s * 0.13 + ey, s * 0.04, Math.PI * 1.1, Math.PI * 1.9); c.stroke(); }
  } else if (mood === 'sad') {
    for (const dx of [-0.08, 0.08]) { rr(c, dx * s - s * 0.035 + ex, -s * 0.13, s * 0.07, s * 0.025, s * 0.012); c.fill(); }
  } else {
    for (const dx of [-0.08, 0.08]) {
      c.save(); c.translate(dx * s + ex, -s * 0.145 + ey); c.scale(1, blink ? 0.15 : 1);
      rr(c, -s * 0.03, -s * 0.035, s * 0.06, s * 0.07, s * 0.025); c.fill(); c.restore();
    }
  }
  c.shadowBlur = 0;
  // antenna
  const sway = Math.sin(t * 3) * s * 0.035;
  c.strokeStyle = '#1b1233'; c.lineWidth = Math.max(1, s * 0.03);
  c.beginPath(); c.moveTo(0, -s * 0.38); c.quadraticCurveTo(sway * 0.5, -s * 0.44, sway, -s * 0.5); c.stroke();
  c.fillStyle = '#ffd166'; c.shadowColor = '#ffd166'; c.shadowBlur = s * 0.2;
  c.beginPath(); c.arc(sway, -s * 0.51, s * 0.045, 0, TAU); c.fill();
  c.shadowBlur = 0;
  c.restore();
}

// ---------- Slipper (Zip Slip) ----------
export function drawSlipper(c, x, y, s, t, o = {}) {
  const look = o.look || { x: 0, y: 1 };
  const step = Math.sin(t * 10);
  c.save(); c.translate(x, y);
  shadow(c, s, 0.24, 0.4);
  c.translate(0, Math.abs(step) * -s * 0.04);
  glow(c, s * 0.6, '61,220,151', 0.16);
  // legs
  c.fillStyle = '#145c40';
  rr(c, -s * 0.17, s * 0.22 + step * s * 0.04, s * 0.12, s * 0.14, s * 0.05); c.fill();
  rr(c, s * 0.05, s * 0.22 - step * s * 0.04, s * 0.12, s * 0.14, s * 0.05); c.fill();
  // ears
  c.fillStyle = '#2fbf83';
  c.beginPath(); c.moveTo(-s * 0.2, -s * 0.15); c.lineTo(-s * 0.4, -s * 0.33); c.lineTo(-s * 0.13, -s * 0.27); c.fill();
  c.beginPath(); c.moveTo(s * 0.2, -s * 0.15); c.lineTo(s * 0.4, -s * 0.33); c.lineTo(s * 0.13, -s * 0.27); c.fill();
  // body
  const g = c.createRadialGradient(-s * 0.08, -s * 0.12, s * 0.04, 0, 0, s * 0.32);
  g.addColorStop(0, '#7dffc4'); g.addColorStop(1, '#1b7a55');
  c.fillStyle = g;
  c.beginPath(); c.ellipse(0, 0, s * 0.27, s * 0.3, 0, 0, TAU); c.fill();
  c.strokeStyle = '#0c3a28'; c.lineWidth = Math.max(1, s * 0.03); c.stroke();
  // eyes
  eye(c, -s * 0.09, -s * 0.12, s * 0.065, look.x, look.y, (t % 2.9) < 0.1);
  eye(c, s * 0.09, -s * 0.12, s * 0.065, look.x, look.y, (t % 2.9) < 0.1);
  // sly brows
  c.strokeStyle = '#0c3a28';
  c.beginPath(); c.moveTo(-s * 0.16, -s * 0.22); c.lineTo(-s * 0.03, -s * 0.18); c.moveTo(s * 0.16, -s * 0.22); c.lineTo(s * 0.03, -s * 0.18); c.stroke();
  // grin
  c.beginPath(); c.arc(0, -s * 0.02, s * 0.09, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke();
  // sign
  c.fillStyle = '#1b1233';
  rr(c, -s * 0.15, s * 0.06, s * 0.3, s * 0.15, s * 0.04); c.fill();
  c.fillStyle = '#ffd166';
  c.font = `800 ${Math.max(7, Math.round(s * 0.13))}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('../', 0, s * 0.14);
  c.restore();
}

// ---------- Rot (bit-rot beetle) ----------
export function drawRot(c, x, y, s, t, o = {}) {
  const dir = o.dir || { x: 1, y: 0 };
  const ang = Math.atan2(dir.y, dir.x) + Math.PI / 2;
  c.save(); c.translate(x, y);
  shadow(c, s, 0.26, 0.38);
  glow(c, s * 0.6, '255,95,109', 0.18);
  c.rotate(ang);
  // legs
  c.strokeStyle = '#3b0a12'; c.lineWidth = Math.max(1, s * 0.035);
  for (let i = -1; i <= 1; i++) {
    const w = Math.sin(t * 14 + i * 1.7) * s * 0.05;
    c.beginPath(); c.moveTo(-s * 0.18, i * s * 0.1); c.lineTo(-s * 0.32, i * s * 0.14 + w); c.stroke();
    c.beginPath(); c.moveTo(s * 0.18, i * s * 0.1); c.lineTo(s * 0.32, i * s * 0.14 - w); c.stroke();
  }
  // head + antennae
  c.fillStyle = '#3b0a12';
  c.beginPath(); c.arc(0, -s * 0.24, s * 0.1, 0, TAU); c.fill();
  c.beginPath(); c.moveTo(-s * 0.04, -s * 0.31); c.lineTo(-s * 0.12, -s * 0.42 + Math.sin(t * 6) * s * 0.02);
  c.moveTo(s * 0.04, -s * 0.31); c.lineTo(s * 0.12, -s * 0.42 - Math.sin(t * 6) * s * 0.02); c.stroke();
  // shell
  const g = c.createLinearGradient(-s * 0.2, 0, s * 0.2, 0);
  g.addColorStop(0, '#9b2637'); g.addColorStop(0.5, '#ff5f6d'); g.addColorStop(1, '#9b2637');
  c.fillStyle = g;
  c.beginPath(); c.ellipse(0, s * 0.03, s * 0.21, s * 0.26, 0, 0, TAU); c.fill();
  c.strokeStyle = '#3b0a12'; c.stroke();
  c.beginPath(); c.moveTo(0, -s * 0.22); c.lineTo(0, s * 0.29); c.stroke();
  // corrupted-bit spots
  c.fillStyle = '#3b0a12';
  for (const [px, py] of [[-0.1, -0.06], [0.11, 0.0], [-0.08, 0.14], [0.09, 0.16]]) { c.beginPath(); c.arc(px * s, py * s, s * 0.035, 0, TAU); c.fill(); }
  c.restore();
}

// ---------- Bomblet (compression bomb) ----------
export function drawBomblet(c, x, y, s, t, stage = 0, flash = false) {
  const k = 0.55 + Math.min(3, stage) * 0.16 + (stage >= 3 ? Math.sin(t * 22) * 0.03 : 0);
  const r = s * 0.27 * k;
  c.save(); c.translate(x, y);
  shadow(c, s, 0.22 * k, 0.38);
  if (stage >= 2) glow(c, s * 0.8 * k, '255,95,109', 0.1 + stage * 0.08);
  // body
  const g = c.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, 0, 0, r);
  g.addColorStop(0, flash ? '#ffb3ba' : '#6b6390'); g.addColorStop(1, flash ? '#c0263b' : '#1b1233');
  c.fillStyle = g;
  c.beginPath(); c.arc(0, s * 0.04, r, 0, TAU); c.fill();
  c.strokeStyle = '#0d0820'; c.lineWidth = Math.max(1, s * 0.03); c.stroke();
  // cap + fuse
  c.fillStyle = '#2b1f55';
  rr(c, -r * 0.3, -r + s * 0.0, r * 0.6, r * 0.28, r * 0.08); c.fill();
  c.strokeStyle = '#c9a26b'; c.lineWidth = Math.max(1, s * 0.035);
  c.beginPath(); c.moveTo(0, -r); c.quadraticCurveTo(r * 0.5, -r * 1.5, r * 0.25, -r * 1.75); c.stroke();
  // spark
  const fl = 0.6 + Math.random() * 0.4;
  c.fillStyle = `rgba(255,209,102,${fl})`; c.shadowColor = '#ff9f1c'; c.shadowBlur = s * 0.25;
  c.beginPath(); c.arc(r * 0.25, -r * 1.78, s * 0.05 * (1 + stage * 0.25), 0, TAU); c.fill();
  c.shadowBlur = 0;
  // ratio label
  const label = ['×10', '×100', '×1,000', '×∞'][Math.min(3, stage)];
  c.fillStyle = stage >= 2 ? '#ffd166' : '#d6cff5';
  c.font = `800 ${Math.max(7, Math.round(s * 0.13))}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(label, 0, s * 0.06);
  c.restore();
}

// ---------- Linker (symlink imp) ----------
export function drawLinker(c, x, y, s, t, o = {}) {
  const look = o.look || { x: 0, y: 1 };
  const hover = Math.sin(t * 4) * s * 0.05;
  c.save(); c.translate(x, y);
  shadow(c, s, 0.2, 0.4);
  c.translate(0, hover - s * 0.04);
  glow(c, s * 0.65, '255,209,102', 0.2);
  // tail
  c.strokeStyle = '#b45309'; c.lineWidth = Math.max(1, s * 0.035);
  c.beginPath(); c.moveTo(s * 0.12, s * 0.18); c.bezierCurveTo(s * 0.35, s * 0.3, s * 0.38, s * 0.05, s * 0.28, 0); c.stroke();
  // horns
  c.fillStyle = '#7a2e0e';
  c.beginPath(); c.moveTo(-s * 0.15, -s * 0.2); c.lineTo(-s * 0.22, -s * 0.38); c.lineTo(-s * 0.06, -s * 0.24); c.fill();
  c.beginPath(); c.moveTo(s * 0.15, -s * 0.2); c.lineTo(s * 0.22, -s * 0.38); c.lineTo(s * 0.06, -s * 0.24); c.fill();
  // body
  const g = c.createRadialGradient(-s * 0.07, -s * 0.1, s * 0.03, 0, 0, s * 0.28);
  g.addColorStop(0, '#fff0b8'); g.addColorStop(1, '#f59e0b');
  c.fillStyle = g;
  c.beginPath(); c.arc(0, 0, s * 0.24, 0, TAU); c.fill();
  c.strokeStyle = '#7a2e0e'; c.lineWidth = Math.max(1, s * 0.03); c.stroke();
  eye(c, -s * 0.08, -s * 0.05, s * 0.06, look.x, look.y, (t % 3.3) < 0.1, '#ffffff', '#7a2e0e');
  eye(c, s * 0.08, -s * 0.05, s * 0.06, look.x, look.y, (t % 3.3) < 0.1, '#ffffff', '#7a2e0e');
  c.beginPath(); c.arc(0, s * 0.07, s * 0.07, 0.1 * Math.PI, 0.9 * Math.PI); c.stroke();
  // chain link it carries
  c.save(); c.translate(-s * 0.3, s * 0.05); c.rotate(Math.sin(t * 3) * 0.3);
  c.strokeStyle = '#ffd166'; c.lineWidth = Math.max(1.2, s * 0.04);
  c.beginPath(); c.ellipse(-s * 0.04, 0, s * 0.07, s * 0.045, 0, 0, TAU); c.stroke();
  c.beginPath(); c.ellipse(s * 0.05, 0, s * 0.07, s * 0.045, 0, 0, TAU); c.stroke();
  c.restore();
  c.restore();
}

// ---------- Hydra (overlap boss) ----------
export function drawHydra(c, x, y, s, t, o = {}) {
  const hurt = !!o.hurt;
  c.save(); c.translate(x, y);
  shadow(c, s, 0.6, 0.55);
  glow(c, s * 1.3, '167,139,250', 0.25);
  const heads = o.heads || 3;
  const base = { x: 0, y: s * 0.25 };
  for (let i = 0; i < heads; i++) {
    const a = -Math.PI / 2 + (i - (heads - 1) / 2) * 0.62;
    const sway = Math.sin(t * 2.4 + i * 1.9) * 0.18;
    const hx = Math.cos(a + sway) * s * 0.62;
    const hy = Math.sin(a + sway) * s * 0.62 - s * 0.05;
    c.strokeStyle = hurt ? '#ffffff' : '#5b21b6'; c.lineWidth = s * 0.16; c.lineCap = 'round';
    c.beginPath(); c.moveTo(base.x, base.y - s * 0.1); c.quadraticCurveTo(hx * 0.4, hy * 0.2 + s * 0.1, hx, hy); c.stroke();
    c.fillStyle = hurt ? '#ffffff' : '#7c3aed';
    c.beginPath(); c.ellipse(hx, hy, s * 0.16, s * 0.13, a + Math.PI / 2, 0, TAU); c.fill();
    c.fillStyle = '#ff5f6d'; c.shadowColor = '#ff5f6d'; c.shadowBlur = s * 0.2;
    c.beginPath(); c.arc(hx - s * 0.05, hy - s * 0.03, s * 0.03, 0, TAU); c.arc(hx + s * 0.05, hy - s * 0.03, s * 0.03, 0, TAU); c.fill();
    c.shadowBlur = 0;
  }
  const g = c.createRadialGradient(-s * 0.15, s * 0.1, s * 0.05, 0, s * 0.25, s * 0.5);
  g.addColorStop(0, hurt ? '#ffffff' : '#a78bfa'); g.addColorStop(1, hurt ? '#e9ddff' : '#3b1d7a');
  c.fillStyle = g;
  c.beginPath(); c.ellipse(0, s * 0.3, s * 0.48, s * 0.34, 0, 0, TAU); c.fill();
  c.strokeStyle = '#1b1233'; c.lineWidth = Math.max(1, s * 0.03); c.stroke();
  c.fillStyle = '#ffd166';
  c.font = `800 ${Math.max(8, Math.round(s * 0.14))}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('0x0400', 0, s * 0.32);
  c.restore();
}

// ---------- props ----------
export function drawPortal(c, x, y, s, t, color = '255,209,102') {
  c.save(); c.translate(x, y);
  glow(c, s * 0.55, color, 0.35);
  for (let i = 0; i < 3; i++) {
    c.strokeStyle = `rgba(${color},${0.9 - i * 0.25})`; c.lineWidth = Math.max(1, s * 0.04);
    c.setLineDash([s * 0.08, s * 0.06]);
    c.beginPath(); c.arc(0, 0, s * (0.16 + i * 0.09), t * (2 + i) * (i % 2 ? -1 : 1), t * (2 + i) * (i % 2 ? -1 : 1) + TAU * 0.8); c.stroke();
  }
  c.setLineDash([]);
  c.fillStyle = '#0d0820'; c.beginPath(); c.arc(0, 0, s * 0.12, 0, TAU); c.fill();
  c.fillStyle = `rgb(${color})`;
  c.font = `800 ${Math.max(8, Math.round(s * 0.18))}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('↪', 0, s * 0.01);
  c.restore();
}
export function drawBlock(c, x, y, s, t, kind, label, dim = false) {
  const col = { g: ['#3ddc97', '#1b7a55', '#0c3a28', '✓'], q: ['#a59fc4', '#4a4270', '#1f1a38', '?'], r: ['#ff5f6d', '#9b2637', '#3b0a12', '✕'] }[kind];
  const f = Math.sin(t * 3 + x * 0.01 + y * 0.013) * s * 0.03;
  const w = s * 0.42;
  c.save(); c.translate(x, y + f);
  if (dim) c.globalAlpha = 0.45;
  if (kind === 'g') glow(c, s * 0.5, '61,220,151', 0.22);
  if (kind === 'r') glow(c, s * 0.5, '255,95,109', 0.18);
  const g = c.createLinearGradient(0, -w / 2, 0, w / 2);
  g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
  c.fillStyle = g;
  c.beginPath(); c.moveTo(0, -w * 0.62); c.lineTo(w * 0.55, 0); c.lineTo(0, w * 0.62); c.lineTo(-w * 0.55, 0); c.closePath(); c.fill();
  c.strokeStyle = col[2]; c.lineWidth = Math.max(1, s * 0.03); c.stroke();
  c.fillStyle = '#ffffff';
  c.font = `900 ${Math.max(8, Math.round(s * (label ? 0.2 : 0.22)))}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(label || col[3], 0, s * 0.01);
  c.restore();
}
export function drawVault(c, x, y, s, t, open) {
  c.save(); c.translate(x, y);
  if (open) glow(c, s * 0.9, '61,220,151', 0.35 + Math.sin(t * 4) * 0.1);
  c.fillStyle = open ? '#0f4f37' : '#2b1f55';
  rr(c, -s * 0.38, -s * 0.4, s * 0.76, s * 0.8, s * 0.12); c.fill();
  c.strokeStyle = open ? '#3ddc97' : '#ff5f6d'; c.lineWidth = Math.max(1.5, s * 0.05); c.stroke();
  c.strokeStyle = open ? 'rgba(61,220,151,.6)' : 'rgba(255,255,255,.15)'; c.lineWidth = Math.max(1, s * 0.03);
  c.beginPath(); c.arc(0, 0, s * 0.2, 0, TAU); c.stroke();
  for (let i = 0; i < 6; i++) { const a = i * TAU / 6 + (open ? t * 1.5 : 0); c.beginPath(); c.moveTo(Math.cos(a) * s * 0.08, Math.sin(a) * s * 0.08); c.lineTo(Math.cos(a) * s * 0.2, Math.sin(a) * s * 0.2); c.stroke(); }
  c.fillStyle = open ? '#3ddc97' : '#ff5f6d';
  c.font = `900 ${Math.max(7, Math.round(s * 0.15))}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(open ? 'OPEN' : 'LOCK', 0, s * 0.3);
  c.restore();
}
export function drawHole(c, x, y, s, t) {
  c.save(); c.translate(x, y);
  glow(c, s * 0.6, '255,95,109', 0.25 + Math.sin(t * 3) * 0.08);
  c.fillStyle = '#000000';
  c.beginPath(); c.ellipse(0, 0, s * 0.4, s * 0.32, 0, 0, TAU); c.fill();
  c.strokeStyle = '#ff5f6d'; c.lineWidth = Math.max(1, s * 0.04); c.stroke();
  c.fillStyle = '#ff5f6d';
  c.font = `900 ${Math.max(8, Math.round(s * 0.2))}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText('../', 0, s * 0.01);
  c.restore();
}

// ---------- Vera as a portrait for briefs and results in every game ----------
export function veraPortrait(size = 96, mood = 'ok') {
  const cv = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr);
  cv.className = 'vera-portrait';
  cv.setAttribute('aria-hidden', 'true');
  const c = cv.getContext('2d');
  if (!c) return cv;
  const paint = (t) => {
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, size, size);
    drawVera(c, size / 2, size * 0.56, size * 0.95, { t, face: 1, look: { x: 0.4, y: 0.2 }, mood, glow: true });
  };
  paint(1.2);
  let still = false;
  try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* ignore */ }
  if (still || typeof requestAnimationFrame !== 'function') return cv;
  // Blink and sway while the portrait is on the page; stop once it is removed.
  let seen = false;
  let frames = 0;
  const t0 = performance.now();
  const tick = (now) => {
    frames++;
    if (cv.isConnected) seen = true;
    else if (seen || frames > 120) return;
    paint(1.2 + (now - t0) / 1000);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return cv;
}
export const CHARACTERS = [
  { id: 'vera', name: 'Vera', role: 'Guardian · you', text: 'Collects only data she can prove, scans before she takes, and keeps the destination folder clean.' },
  { id: 'slipper', name: 'Slipper', role: 'Zip Slip', text: 'Runs for the “../” holes to escape the folder you chose. Zap it before it gets out.' },
  { id: 'rot', name: 'Rot', role: 'Bit rot', text: 'Crawls over verified data and turns it red. Red data is corrupted — never take it.' },
  { id: 'bomblet', name: 'Bomblet', role: 'Compression bomb', text: 'Starts at ×10 and grows to ×∞. Defuse it early, or it floods everything around it.' },
  { id: 'linker', name: 'Linker', role: 'Symlink', text: 'Opens portals that send you somewhere else. Zap it and its portals close.' },
  { id: 'hydra', name: 'Overlap Hydra', role: 'Overlapping entries', text: 'Many heads, one set of bytes. The boss of the final level.' },
];
export function drawCharacter(c, id, x, y, s, t) {
  switch (id) {
    case 'vera': return drawVera(c, x, y, s, { t, face: 1, look: { x: 0.3, y: 0.2 } });
    case 'slipper': return drawSlipper(c, x, y, s, t);
    case 'rot': return drawRot(c, x, y, s, t, { dir: { x: 0, y: -1 } });
    case 'bomblet': return drawBomblet(c, x, y, s, t, Math.floor(t / 1.5) % 4, Math.floor(t / 1.5) % 4 === 3);
    case 'linker': return drawLinker(c, x, y, s, t);
    case 'hydra': return drawHydra(c, x, y + s * 0.1, s * 0.62, t);
    default: return undefined;
  }
}
