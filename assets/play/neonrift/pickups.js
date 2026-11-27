// VERAQIS Play — NEON RIFT: coins and power-ups.
// Coins spin on floors (one instanced mesh); any hero who touches one collects it, a magnet pulls them in.
// Power-ups float in a ring: shield (no damage), speed (+45 % run), magnet (coins fly to you) and blaster
// (every hero can shoot, Vera shoots faster). The game asks `pw(hero, kind)` for the time left on a power.
// Data comes from the level (`def.coins` = [[x, y, z], …], `def.powers` = [{ kind, p }]); levels.js
// generates both. This module only draws, animates and detects pick-ups; game.js decides what they do.
import * as THREE from '../vendor/three.min.js';

export const POWER = {
  shield: { name: 'Shield', color: '#5ee7ff', time: 15, say: 'Shield up — nothing can hurt you for 15 s.' },
  speed: { name: 'Speed', color: '#ffd166', time: 12, say: 'Speed boots — run 45 % faster for 12 s.' },
  magnet: { name: 'Magnet', color: '#ff4fd8', time: 15, say: 'Coin magnet — coins fly to you for 15 s.' },
  blaster: { name: 'Blaster', color: '#ff7a3d', time: 15, say: 'Blaster — everyone shoots with the ability button for 15 s.' },
};
const COIN_R = 0.85;         // m, pick-up radius
const POWER_R = 1.0;
const MAGNET_R = 7.5;

export function createPickups({ scene, def }) {
  const group = new THREE.Group();
  group.name = 'pickups';
  scene.add(group);
  const disposables = [];
  const keep = (x) => { disposables.push(x); return x; };

  // ---------- coins ----------
  const coinList = (Array.isArray(def.coins) ? def.coins : []).filter((c) => Array.isArray(c) && c.length === 3 && c.every(Number.isFinite))
    .map((c, i) => ({ x: c[0], y: c[1], z: c[2], bx: c[0], by: c[1], bz: c[2], taken: false, t: 0, ph: i * 0.37 }));
  let coinMesh = null;
  if (coinList.length) {
    const g = keep(new THREE.CylinderGeometry(0.27, 0.27, 0.07, 22));
    g.rotateX(Math.PI / 2);
    const m = keep(new THREE.MeshStandardMaterial({ color: '#ffd35a', emissive: '#ff9d1a', emissiveIntensity: 0.85, metalness: 0.75, roughness: 0.28 }));
    coinMesh = new THREE.InstancedMesh(g, m, coinList.length);
    coinMesh.name = 'coins';
    coinMesh.frustumCulled = false;
    coinMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(coinMesh);
  }
  const M4 = new THREE.Matrix4(); const Q = new THREE.Quaternion(); const P = new THREE.Vector3(); const SC = new THREE.Vector3(); const UP = new THREE.Vector3(0, 1, 0);

  // ---------- power-ups ----------
  const orbG = keep(new THREE.OctahedronGeometry(0.3, 0));
  const ringG = keep(new THREE.TorusGeometry(0.52, 0.035, 8, 40));
  const powerList = (Array.isArray(def.powers) ? def.powers : []).filter((p) => p && POWER[p.kind] && Array.isArray(p.p)).map((p) => {
    const P0 = POWER[p.kind];
    const root = new THREE.Group();
    const core = new THREE.Mesh(orbG, keep(new THREE.MeshStandardMaterial({ color: P0.color, emissive: P0.color, emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.2 })));
    const ring = new THREE.Mesh(ringG, keep(new THREE.MeshBasicMaterial({ color: P0.color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
    const ring2 = ring.clone(); ring2.rotation.y = Math.PI / 2;
    root.add(core, ring, ring2);
    root.position.set(p.p[0], p.p[1], p.p[2]);
    group.add(root);
    return { kind: p.kind, x: p.p[0], y: p.p[1], z: p.p[2], root, core, ring, ring2, taken: false, t: 0 };
  });

  // ---------- shield bubbles (one per hero, made on demand) ----------
  const bubbleG = keep(new THREE.SphereGeometry(1, 24, 16));
  const bubbles = new Map();
  function bubble(hero) {
    let b = bubbles.get(hero.id);
    if (!b) {
      const m = keep(new THREE.MeshBasicMaterial({ color: POWER.shield.color, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      b = new THREE.Mesh(bubbleG, m);
      b.visible = false;
      group.add(b);
      bubbles.set(hero.id, b);
    }
    return b;
  }

  let got = 0;
  const api = {
    total: coinList.length,
    get got() { return got; },
    // events: [{ type: 'coin', hero, pos } | { type: 'power', hero, kind, pos }]
    update(t, dt, heroes, pw) {
      const evs = [];
      // coins
      if (coinMesh) {
        for (let i = 0; i < coinList.length; i++) {
          const c = coinList[i];
          if (c.taken) {
            if (c.t < 1) {
              c.t = Math.min(1, c.t + dt * 4);
              c.y += dt * 4;
            }
          } else {
            for (const hh of heroes) {
              if (!hh.alive) continue;
              const b = hh.body;
              if (pw(hh, 'magnet') > 0) {
                const dx = b.pos.x - c.x; const dy = b.pos.y + hh.S.height * 0.5 - c.y; const dz = b.pos.z - c.z;
                const d = Math.hypot(dx, dy, dz);
                if (d < MAGNET_R && d > 0.01) { const k = Math.min(1, (dt * 14) / d); c.x += dx * k; c.y += dy * k; c.z += dz * k; }
              }
              const dx = c.x - b.pos.x; const dz = c.z - b.pos.z;
              if (dx * dx + dz * dz > COIN_R * COIN_R || c.y < b.pos.y - 0.4 || c.y > b.pos.y + b.height + 0.5) continue;
              c.taken = true; got++;
              evs.push({ type: 'coin', hero: hh.id, pos: new THREE.Vector3(c.x, c.y, c.z) });
              break;
            }
          }
          const s = c.taken ? Math.max(0, 1 - c.t) : 1;
          P.set(c.x, c.y + (c.taken ? 0 : Math.sin(t * 2.4 + c.ph) * 0.08), c.z);
          Q.setFromAxisAngle(UP, t * 3 + c.ph);
          SC.setScalar(s || 1e-4);
          M4.compose(P, Q, SC);
          coinMesh.setMatrixAt(i, M4);
        }
        coinMesh.instanceMatrix.needsUpdate = true;
      }
      // power-ups
      for (const p of powerList) {
        if (p.taken) {
          if (p.t < 1) { p.t = Math.min(1, p.t + dt * 3); p.root.scale.setScalar(1 + p.t * 1.5); p.root.traverse((o) => { if (o.material) o.material.opacity = 1 - p.t; }); if (p.t >= 1) p.root.visible = false; }
          continue;
        }
        p.root.position.y = p.y + Math.sin(t * 1.8 + p.x) * 0.15;
        p.core.rotation.y = t * 1.6; p.core.rotation.x = t * 0.7;
        p.ring.rotation.x = t * 1.2; p.ring2.rotation.z = t * 0.9;
        for (const hh of heroes) {
          if (!hh.alive) continue;
          const b = hh.body;
          const dx = p.x - b.pos.x; const dz = p.z - b.pos.z;
          if (dx * dx + dz * dz > POWER_R * POWER_R || p.y < b.pos.y - 0.6 || p.y > b.pos.y + b.height + 0.8) continue;
          p.taken = true;
          p.core.material.transparent = true;
          evs.push({ type: 'power', hero: hh.id, kind: p.kind, pos: new THREE.Vector3(p.x, p.y, p.z) });
          break;
        }
      }
      // shield bubbles
      for (const hh of heroes) {
        const left = pw(hh, 'shield');
        if (left <= 0 && !bubbles.has(hh.id)) continue;
        const b = bubble(hh);
        b.visible = hh.alive && left > 0 && (left > 2.5 || Math.sin(t * 22) > 0);
        if (!b.visible) continue;
        const r = Math.max(hh.S.height * 0.62, hh.S.radius * 1.8);
        b.scale.setScalar(r * (1 + Math.sin(t * 5) * 0.03));
        b.position.set(hh.body.pos.x, hh.body.pos.y + hh.S.height * 0.5, hh.body.pos.z);
      }
      return evs;
    },
    // for tests: { coins: [{ x, y, z, taken }], powers: [{ kind, x, y, z, taken }] }
    debug: { coins: coinList, powers: powerList },
    dispose() {
      scene.remove(group);
      coinMesh?.dispose?.();
      for (const d of disposables) { try { d.dispose(); } catch { /* ignore */ } }
    },
  };
  return api;
}
