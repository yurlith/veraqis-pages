// NEON RIFT — level data. Chapter 1 (1–8): Neon ×2, Crystal ×2, Sky ×2, Lava ×2. Chapter 2 (9–12): the Underside.
// Schema: _dev/NEONRIFT.md. Metres, y up, yaw 0 faces +Z. Blocks are centre + size; a block's top is p.y + s.y / 2.
// Point items (checkpoint, portal, plate, switch, node, bounce, sign) stand on the floor at p; shards float at p.
// `solve` (next to `def`) is the intended solution: _dev/levels/validate.mjs replays it step by step against a
// reachability model of every hero. The game ignores it. Physics budget used here (≈15 % margin on NEONRIFT.md):
// climb Vera 1.35 · Pix 2.3 (double jump) · Brick 0.75 · step 0.35; flat gaps Vera 3.4 · Pix 4.5 (7 with double jump)
// · Brick 1.7; tunnels 1.1 m high (Pix only); crates 1.4 m (Brick pushes them).

// ---------- geometry helpers ----------
const q = (v) => Math.round(v * 1000) / 1000;

// A block by centre and size.
function box(x, y, z, sx, sy, sz, m, tint) {
  const b = { p: [q(x), q(y), q(z)], s: [q(Math.abs(sx)), q(Math.abs(sy)), q(Math.abs(sz))], m };
  if (tint) b.tint = tint;
  return b;
}
// A block by its footprint corners (x0..x1, z0..z1) and vertical extent (y0..y1) — the workhorse.
function span(x0, z0, x1, z1, y0, y1, m, tint) {
  return box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, m, tint);
}
// A building whose roof is at `top`; it reaches far down into the fog.
const roof = (x0, z0, x1, z1, top, m = 'neon', depth = 26, tint) => span(x0, z0, x1, z1, top - depth, top, m, tint);
// A thin floor plate with its top at `top`.
const slab = (x0, z0, x1, z1, top, m, th = 0.5, tint) => span(x0, z0, x1, z1, top - th, top, m, tint);
// A square pillar centred at (x, z).
const post = (x, z, w, y0, y1, m, tint) => span(x - w / 2, z - w / 2, x + w / 2, z + w / 2, y0, y1, m, tint);
// A floating pad centred at (x, z) with its top at `top`.
const pad = (x, z, w, d, top, m, th = 0.6, tint) => span(x - w / 2, z - d / 2, x + w / 2, z + d / 2, top - th, top, m, tint);

// Stairs filling the rect x0..x1 × z0..z1, climbing toward `dir` ('+x' | '-x' | '+z' | '-z') from y0 to y1 in n steps.
function stairs(x0, z0, x1, z1, dir, n, y0, y1, m, base) {
  const out = [];
  const bottom = base ?? y0 - 1;
  for (let i = 0; i < n; i++) {
    const a = i / n;
    const b = (i + 1) / n;
    const top = y0 + (y1 - y0) * b;
    if (dir === '+z') out.push(span(x0, z0 + (z1 - z0) * a, x1, z0 + (z1 - z0) * b, bottom, top, m));
    else if (dir === '-z') out.push(span(x0, z1 - (z1 - z0) * b, x1, z1 - (z1 - z0) * a, bottom, top, m));
    else if (dir === '+x') out.push(span(x0 + (x1 - x0) * a, z0, x0 + (x1 - x0) * b, z1, bottom, top, m));
    else out.push(span(x1 - (x1 - x0) * b, z0, x1 - (x1 - x0) * a, z1, bottom, top, m));
  }
  return out;
}

// A wall from (a0..a1) along `axis` ('x' or 'z') at cross position c (thickness th), from y0 to y1, with rectangular
// holes [[from, to, holeY0, holeY1], ...] (doorways, windows, low ducts). Emits the fewest blocks it can.
function wall(axis, a0, a1, c, th, y0, y1, m, holes = [], tint) {
  const cuts = [a0, a1];
  for (const [h0, h1] of holes) cuts.push(Math.max(a0, Math.min(a1, h0)), Math.max(a0, Math.min(a1, h1)));
  const xs = [...new Set(cuts.map(q))].sort((u, v) => u - v);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const u0 = xs[i];
    const u1 = xs[i + 1];
    if (u1 - u0 < 1e-6) continue;
    const mid = (u0 + u1) / 2;
    // vertical solid ranges = [y0, y1] minus the holes covering this stretch
    let ranges = [[y0, y1]];
    for (const [h0, h1, hy0, hy1] of holes) {
      if (mid <= h0 || mid >= h1) continue;
      const next = [];
      for (const [r0, r1] of ranges) {
        if (hy1 <= r0 || hy0 >= r1) { next.push([r0, r1]); continue; }
        if (hy0 > r0) next.push([r0, hy0]);
        if (hy1 < r1) next.push([hy1, r1]);
      }
      ranges = next;
    }
    for (const [r0, r1] of ranges) {
      if (r1 - r0 < 1e-6) continue;
      out.push(axis === 'x' ? span(u0, c - th / 2, u1, c + th / 2, r0, r1, m, tint) : span(c - th / 2, u0, c + th / 2, u1, r0, r1, m, tint));
    }
  }
  return out;
}

// A low duct for Pix: roof slab and two side walls over the corridor x0..x1 × z0..z1 (interior), running along
// `axis`. The floor under it must exist. Clearance 1.1 m: Pix (0.9 m) fits, Vera (1.5) and Brick (1.8) do not.
function duct(x0, z0, x1, z1, floor, axis, m, clear = 1.1, th = 0.4) {
  const top = floor + clear;
  const out = [span(axis === 'x' ? x0 : x0 - th, axis === 'z' ? z0 : z0 - th, axis === 'x' ? x1 : x1 + th, axis === 'z' ? z1 : z1 + th, top, top + th, m)];
  if (axis === 'x') out.push(span(x0, z0 - th, x1, z0, floor, top, m), span(x0, z1, x1, z1 + th, floor, top, m));
  else out.push(span(x0 - th, z0, x0, z1, floor, top, m), span(x1, z0, x1 + th, z1, floor, top, m));
  return out;
}

// Calls fn(x, z, angle, i) for n points on a circle (angle 0 = +X, counter-clockwise seen from above is +angle → +Z).
function ring(cx, cz, r, n, a0, step, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + step * i;
    const res = fn(cx + Math.cos(a) * r, cz + Math.sin(a) * r, a, i);
    if (Array.isArray(res)) out.push(...res); else if (res) out.push(res);
  }
  return out;
}

// ---------- item helpers ----------
const SH = 0.8;   // shards hover this far above the floor they belong to
const shard = (x, y, z) => ({ type: 'shard', p: [q(x), q(y), q(z)] });
const checkpoint = (x, y, z, tag) => ({ type: 'checkpoint', p: [x, y, z], ...(tag ? { tag } : {}) });
const sign = (x, y, z, text) => ({ type: 'sign', p: [x, y, z], text });
const tip = (x, y, z, r, text) => ({ p: [x, y, z], r, text });
const deg = Math.PI / 180;

// Controls as the briefs name them (keyboard first; touch and gamepad show the same actions on screen).
const KEY = { jump: 'Space', act: 'E', dash: 'Shift', swap: 'Tab' };

// =====================================================================================================
// 1 · ROOFTOP RUN (neon) — Vera alone: run, jump, glide, zap a node, dodge a sentry.
// The pink-ringed spire at the far end (z ≈ 112) is the goal; it is in view from the first roof.
// =====================================================================================================
function rooftopRun() {
  const blocks = [
    // A — the start roof, a hidden ledge behind it, an AC unit and a billboard
    roof(-8, -6, 8, 12, 0),
    roof(-4, -11.5, 4, -6.4, -2, 'metal'),                 // secret ledge 2 m below, behind the start
    span(1, -8.6, 3.2, -6.6, -2, -1, 'metal'),               // vent on it: the way back up (+1, then +1)
    span(-5.5, 2, -3, 4, 0, 1, 'metal'),                     // AC unit (first jump)
    span(3, 5.5, 6, 7.5, 0, 1.2, 'metal'),                   // AC unit
    post(-6, 8, 0.3, 0, 5, 'metal'), post(-6, 11.4, 0.3, 0, 5, 'metal'),
    span(-6.2, 7.6, -5.9, 11.8, 2.4, 5, 'glow:#ff2bd6'),     // billboard (shard behind it)
    // B — a narrow roof across a 3 m gap, pipes, steps up to C
    roof(-3.5, 15, 3.5, 26, 0),
    span(-3.5, 19, 3.5, 19.4, 0, 0.3, 'metal'), span(-3.5, 22.5, 3.5, 22.9, 0, 0.3, 'metal'),
    ...stairs(-3.5, 26, 3.5, 30, '+z', 2, 0, 2, 'metal', -26),
    // C — billboard roof (checkpoint 1); antenna deck for the optional long glide
    roof(-8, 30, 8, 44, 3),
    post(6.8, 34, 0.4, 3, 9.5, 'metal'), post(6.8, 41, 0.4, 3, 9.5, 'metal'),
    span(6.5, 33.6, 6.9, 41.4, 5.2, 9.4, 'glow:#22d3ee'),   // giant cyan billboard
    span(-6.5, 35, -4.5, 37, 3, 4.2, 'metal'),               // vent
    span(-7.5, 38, -4.5, 41.5, 3, 5.4, 'metal'),             // antenna deck
    post(-6, 39.8, 0.25, 5.4, 11, 'metal'),
    // L — floating billboard ledge, only reachable by a long glide from the antenna deck
    roof(-19, 50, -15, 54, 1.5, 'metal', 4),
    span(-18.8, 53.6, -15.2, 53.9, 1.5, 4.5, 'glow:#ff2bd6'),
    // D — plaza roof after the glide (checkpoint 2); pylon with the node; side sign
    roof(-9, 53, 9, 70, 0),
    span(-6, 58, -3.5, 60, 0, 1.1, 'metal'), span(4, 63, 6.5, 66, 0, 0.9, 'metal'),
    roof(6.5, 75.5, 7.5, 76.5, 2.5, 'metal', 30),             // pylon for node n1
    roof(-9, 78, -6, 81, 1, 'metal', 3),                      // sign platform: only reachable from the moving pad
    span(-8.8, 80.7, -6.2, 81, 1, 3.4, 'glow:#a855f7'),
    // E — sentry roof (checkpoint 3) with AC units as cover
    roof(-10, 84, 10, 104, 1),
    span(-3, 89, -1, 91, 1, 2.2, 'metal'), span(3, 95, 5.5, 97, 1, 2.4, 'metal'), span(-7, 100, -4, 102, 1, 2.2, 'metal'),
    // T — the portal tower and its spiral of pads (+1 m each)
    roof(-4, 108, 4, 116, 9, 'glass', 34),
    post(3.2, 115.2, 0.5, 9, 22, 'metal'),
    ...[12, 15.5, 19].map((y) => post(3.2, 115.2, 1.6, y, y + 0.2, 'glow:#ff2bd6')),
    ...ring(0, 112, 7.6, 7, -62 * deg, 41 * deg, (x, z, a, i) => pad(x, z, 3.4, 3.4, 2 + i, 'neon', 0.6)),
  ];
  return {
    name: 'Rooftop Run',
    blurb: 'Run, jump, glide, zap',
    title: 'Rooftop Run',
    say: 'Hi, I’m Vera! Our portal waits on the tallest tower past these rooftops — pink ring, can’t miss it. Let’s go roof-hopping.',
    brief: [
      ['MOVE', 'WASD or the left stick runs. Drag the mouse (or the right stick) to look around.', true],
      ['JUMP', `${KEY.jump} jumps — hold it for full height. Keep holding while I fall and I glide a long way.`, true],
      ['ZAP', `${KEY.act} fires my zap beam: it wakes energy nodes and stuns sentries for 5 seconds.`, true],
    ],
    lesson: 'a crash course in being a robot. A glide is just a fall you get to steer — jump first, then hold.',
    def: {
      theme: 'neon',
      heroes: ['vera'],
      start: { p: [0, 0, -2], yaw: 0 },
      killY: -12,
      par: 60,
      blocks,
      movers: [
        // hover-pad: sleeps until node n1 is zapped, then shuttles D → E (top 0 → 1)
        { p: [0, -0.25, 71.6], s: [3, 0.5, 3], m: 'neon', path: [[0, -0.25, 71.6], [0, 0.75, 82.4]], speed: 2.6, wait: 1, mode: 'pingpong', when: 'n1' },
      ],
      items: [
        shard(-4.25, 1 + SH, 3),           // on the AC unit
        shard(-7.2, 0 + SH, 9.6),          // behind the billboard
        shard(0, 1.4, 13.5),               // over the first gap
        shard(0, -2 + SH, -9.5),           // hidden ledge behind the start
        shard(0, 4.3, 48.5),               // in the glide path C → D
        shard(-17, 1.5 + SH, 52),          // billboard ledge (long glide from the antenna deck)
        shard(-7.5, 1 + SH, 79.3),         // sign platform: glide off the moving hover-pad
        shard(4.25, 2.4 + SH, 96),         // on the AC unit under the sentry
        shard(-9, 1 + SH, 103),            // far corner of the sentry roof
        shard(10.4, 5.6, 117.8),           // floating outside the spiral
        checkpoint(0, 3, 32.5, 'c1'),
        checkpoint(0, 0, 56.5, 'c2'),
        checkpoint(0, 1, 86.5, 'c3'),
        { type: 'node', id: 'n1', p: [7, 2.5, 76] },
        { type: 'portal', p: [0, 9, 112] },
        sign(2.5, 0, 1, 'Rooftop Run → tallest tower, pink ring'),
        sign(-3, 3, 42.6, 'Mind the gap. Glide it.'),
      ],
      enemies: [
        { type: 'sentry', p: [-6, 3.6, 92], path: [[-6, 3.6, 92], [6, 3.6, 92], [6, 3.6, 99], [-6, 3.6, 99]], speed: 2, fov: 70, range: 11 },
      ],
      tips: [
        tip(0, 0, -1, 3, 'Run with WASD or the left stick. The camera follows — drag to look around.'),
        tip(-4.25, 0, 1, 2.5, `Hop up with ${KEY.jump}. Shards are worth a star if you find them all.`),
        tip(0, 0, 11, 2.5, `Jump the gap — run and press ${KEY.jump} at the edge.`),
        tip(0, 3, 42, 3, `Too far to jump. Jump, then hold ${KEY.jump} to glide down to the next roof.`),
        tip(0, 0, 67.5, 4, `That hover-pad is asleep. Aim at the node on the pylon and press ${KEY.act} to zap it.`),
        tip(0, 1, 87.5, 3, 'A sentry! Stay out of its light cone — or zap it to stun it for 5 seconds.'),
        tip(5, 1, 103, 3, 'Climb the pads around the tower. The portal is on top.'),
      ],
    },
    solve: [
      ['go', 'vera', 'c1'],
      ['go', 'vera', 'c2'],                // the glide off roof C
      ['deny', 'vera', 'c3'],              // the chasm D → E is too wide without the hover-pad
      ['zap', 'n1'],                       // hover-pad starts shuttling
      ['go', 'vera', 'c3'],
      ['go', 'vera', 'portal'],
    ],
  };
}

// =====================================================================================================
// 2 · FOX IN THE WIRES (neon) — Pix joins: switching, double jump, dash, low vents, both to the portal.
// A relay: Pix opens the gate for Vera (vent), Pix powers the lift (double jump), Vera powers the hover-pad
// (zap), Vera opens Pix's flap (zap), Pix opens the timed gate while Vera waits at it.
// =====================================================================================================
function foxInTheWires() {
  const W5 = 'metal';
  const blocks = [
    // A — walled courtyard (start) and the substation with a gateway and a vent
    roof(-8, -8, 8, 18, 0),
    span(-8.6, -8, -8, 12, 0, 5, W5), span(8, -8, 8.6, 12, 0, 5, W5),
    ...wall('x', -8.6, 8.6, 15, 6, 0, 5, W5, [[-2, 2, 0, 3.5], [4.4, 6, 0, 1.1]]),
    span(-7.9, 12.05, 7.9, 12.25, 3.9, 4.6, 'glow:#22d3ee'),                  // WIREWORKS sign band
    span(-6.5, -4, -4.5, -2, 0, 1, 'metal'),                                    // vent box (shard)
    span(5, -7, 7.5, -4.5, 0, 2.2, 'wood'),                                     // cable spools (Pix shard)
    // B — plaza: pylon, cable box with a fox tunnel, the transformer (sw2), the lift shaft
    roof(-9, 18, 12, 39.5, 0),
    post(-7, 21, 2.4, 0, 2.3, 'metal'),                                        // cable tower (Pix)
    ...wall('z', 31, 36, -6, 4, 0, 2, 'metal', [[32.9, 34.1, 0, 1.1]]),
    span(-3, 26, 3, 31, 0, 2.3, 'metal'),
    span(-3.1, 25.9, 3.1, 31.1, 2.3, 2.45, 'glow:#f472b6'),
    post(4.9, 39.3, 0.3, 0, 8, 'metal'), post(9.1, 39.3, 0.3, 0, 8, 'metal'),   // lift frame
    // C — upper deck, a dash pad off its west side, a low platform to the east
    roof(-9, 39.5, 12, 48, 4.5),
    pad(-16, 44, 2.4, 2.4, 6.5, 'neon'),
    roof(14.5, 40, 18.5, 44, 1, 'metal', 3),
    roof(9, 52.5, 10, 53.5, 6.6, 'metal', 30),                                  // pylon for node n3 (too tall to stand on)
    // D — far roof, the gate wall (gate + Pix flap), the walled portal yard
    roof(-9, 63, 12, 70, 4.5),
    post(-7.6, 67.5, 2.4, 4.5, 6.7, 'metal'),                                   // junction box (Pix)
    ...wall('x', -9.6, 12.6, 70.3, 0.6, 4.5, 10, W5, [[-2, 2, 4.5, 8], [6.6, 8.2, 4.5, 5.6]]),
    span(-9.6, 70.6, -9, 84.6, 4.5, 10, W5), span(12, 70.6, 12.6, 84.6, 4.5, 10, W5), span(-9, 84, 12, 84.6, 4.5, 10, W5),
    roof(-9, 70.6, 12, 84, 4.5),
    ...duct(6.6, 70.6, 8.2, 74, 4.5, 'z', 'metal'),
    span(1, 71.5, 4.5, 74.5, 4.5, 6.6, 'metal'),                                // sw4 ledge (+2.1: Pix only)
    span(-3, 78, 3, 83, 4.5, 5.5, 'neon'),                                      // portal dais
    span(-9, 76, -8.6, 80, 6, 9.5, 'glow:#a855f7'),
  ];
  return {
    name: 'Fox in the Wires',
    blurb: 'Pix joins: vents and double jumps',
    title: 'Fox in the Wires',
    say: 'This is Pix! She’s small, quick, and fits through vents I can’t. I zap, she squeezes — together we’re unstoppable.',
    brief: [
      ['SWITCH', `${KEY.swap}, 1·2 or a tap on a portrait switches heroes. The other one waits right where you left her.`, true],
      ['PIX', `Pix double-jumps (${KEY.jump} again in the air) and fits through low vents.`, true],
      ['DASH', `${KEY.dash} makes Pix dash 4 m — once per jump, even in mid-air. ${KEY.act} makes her sniff out shards.`, true],
      ['PORTAL', 'The portal only opens when the whole team stands in it.', true],
    ],
    lesson: 'a two-hero relay. Every gate here was opened by the other hero — park one where she’ll be needed, then play the other.',
    def: {
      theme: 'neon',
      heroes: ['vera', 'pix'],
      start: { p: [0, 0, -3], yaw: 0 },
      killY: -12,
      par: 120,
      blocks,
      movers: [
        // the lift: runs while sw2 (on the transformer) is on
        { p: [7, -0.25, 37.6], s: [3, 0.5, 3], m: 'neon', path: [[7, -0.25, 37.6], [7, 4.25, 37.6]], speed: 1.8, wait: 1.2, mode: 'pingpong', when: 'sw2' },
        // the hover-pad across the chasm: runs while node n3 is powered
        { p: [1, 4.25, 49.9], s: [3.4, 0.5, 3.4], m: 'neon', path: [[1, 4.25, 49.9], [1, 4.25, 61.1]], speed: 2.8, wait: 1, mode: 'pingpong', when: 'n3' },
      ],
      items: [
        shard(-5.5, 1 + SH, -3),             // vent box in the courtyard
        shard(6.25, 2.2 + SH, -5.75),        // cable spools (Pix)
        shard(-7, 2.3 + SH, 21),             // pylon (Pix)
        shard(-6, 0.6, 33.5),                // inside the cable-box tunnel (Pix)
        shard(11, 0 + SH, 38),               // behind the lift
        shard(-16, 6.5 + SH, 44),            // dash pad (Pix)
        shard(16.5, 1 + SH, 42),             // low platform east of the deck
        shard(1, 6.3, 55.5),                 // over the chasm: jump on the hover-pad
        shard(-7.6, 6.7 + SH, 66.8),         // junction box by the gate (Pix)
        shard(2.75, 9.2, 73),                // above the timed switch (Pix)
        shard(8, 4.5 + SH, 82),              // behind the portal dais
        checkpoint(-3, 0, 21.5, 'c1'),
        checkpoint(-3, 4.5, 42, 'c2'),
        checkpoint(-4, 4.5, 65, 'c3'),
        { type: 'door', p: [0, 1.75, 12.3], s: [4, 3.5, 0.6], when: 'sw1', tag: 'd1' },
        { type: 'switch', id: 'sw1', p: [3.5, 0, 19.6] },
        { type: 'switch', id: 'sw2', p: [0, 2.3, 28.5] },
        { type: 'node', id: 'n3', p: [9.5, 6.6, 53] },
        { type: 'node', id: 'n5', p: [-7.6, 6.7, 68.2] },
        { type: 'door', p: [7.4, 5.05, 70.3], s: [1.6, 1.1, 0.6], when: 'n5', tag: 'flap' },
        { type: 'door', p: [0, 6.25, 70.3], s: [4, 3.5, 0.6], when: 'sw4', tag: 'gate' },
        { type: 'switch', id: 'sw4', p: [2.75, 6.6, 73], mode: 'timed', time: 7 },
        { type: 'portal', p: [0, 5.5, 80.5] },
        sign(-3.5, 0, 10.5, 'WIREWORKS · authorised foxes only'),
        sign(4, 4.5, 68.8, 'Gate switch inside. Timed!'),
      ],
      enemies: [],
      tips: [
        tip(0, 0, -3, 3, `The door switch is on the far side. Press ${KEY.swap} to switch to Pix — she fits through the vent.`),
        tip(5.2, 0, 10, 2.5, 'Only Pix fits through low vents.'),
        tip(3.5, 0, 19.6, 2.5, 'Touch a switch to flip it.'),
        tip(0, 0, 24.5, 3, `Too high for me. Pix double-jumps: ${KEY.jump}, then ${KEY.jump} again in the air.`),
        tip(-8, 4.5, 44, 2.5, `Pix: jump, double-jump, then ${KEY.dash} to dash over to that pad.`),
        tip(1, 4.5, 46.5, 3.5, 'The hover-pad needs power. I can zap the node on the pylon.'),
        tip(0, 4.5, 67.5, 3.5, 'Zap the node on the junction box: it opens Pix’s flap. Then park me here at the gate.'),
        tip(2.75, 4.5, 75.5, 2.5, 'That switch holds the gate open for 7 seconds. Is Vera waiting at it?'),
      ],
    },
    solve: [
      ['deny', 'vera', 'c1'],              // the door: Vera is walled in
      ['hit', 'pix', 'sw1'],               // Pix crawls through the vent in the substation
      ['go', 'vera', 'c1'],
      ['deny', 'vera', 'c2'],              // the deck is 4.5 m up
      ['hit', 'pix', 'sw2'],               // double jump onto the transformer → the lift runs
      ['go', 'vera', 'c2'],
      ['go', 'pix', 'c2'],
      ['deny', 'vera', 'c3'],              // 15 m chasm
      ['zap', 'n3'],                       // the hover-pad runs
      ['go', 'vera', 'c3'],
      ['go', 'pix', 'c3'],
      ['deny', 'pix', 'portal'],           // the yard is walled in
      ['zap', 'n5'],                       // Pix's flap opens
      ['go', 'vera', [0, 4.5, 68.8]],      // park Vera at the gate
      ['hit', 'pix', 'sw4'],               // flap, duct, double jump: the gate opens for 7 s
      ['go', 'vera', 'portal'],
      ['go', 'pix', 'portal'],
    ],
  };
}

// =====================================================================================================
// 3 · HEAVY LIFTING (crystal) — Brick joins: heavy plates, crates, cracked floors, lasers he walks through.
// Grotto: Brick holds the heavy plate, then a crate takes over. Hall: the only way on is down — pound the
// hollow floor. Canyon: Brick strolls through the laser gate to the plate that switches it off. Cliff: push
// the crate against it so Vera can climb up and zap the lift node for Brick.
// =====================================================================================================
function heavyLifting() {
  const R = 'rock';
  const blocks = [
    // A — the grotto (start), walled in, heavy door north
    roof(-10, -10, 10, 10, 0, R, 6),
    span(-11, -11, -10, 10, 0, 6, R), span(10, -11, 11, 10, 0, 6, R), span(-10, -11, 10, -10, 0, 6, R),
    ...wall('x', -11, 11, 10.5, 1, 0, 6, R, [[-2, 2, 0, 3.6]]),
    span(-10, 2, -7, 6, 0, 2.2, 'crystal'),                                    // crystal shelf (Pix)
    // decorative crystals are either ankle-high or taller than the walls: never a ladder out of a room
    post(8.3, -8.3, 1.4, 0, 8, 'crystal'), post(6.6, -9, 1, 0, 1.1, 'crystal'), post(-8.6, -8.4, 1.2, 0, 7.5, 'crystal'),
    // B — crystal hall: hollow floor at the north end, a cracked wall with a secret alcove, a crystal stair
    roof(-14, 11, 14, 33, 0, R, 6),
    slab(-14, 33, 14, 34, 0, R, 1), slab(-14, 38, 14, 40, 0, R, 1), slab(-14, 34, -2, 38, 0, R, 1), slab(2, 34, 14, 38, 0, R, 1),
    span(-15, 10, -14, 41, 0, 7, R), span(-15, 10, -11, 11, 0, 7, R), span(11, 10, 15, 11, 0, 7, R),
    ...wall('z', 10, 41, 14.5, 1, 0, 7, R, [[18, 21, 0, 2.6]]),
    span(-15, 40, 15, 41, -1, 7, R),
    roof(15, 17, 18.5, 22, 0, R, 6), span(18.5, 16.5, 19.5, 22.5, 0, 5, R), span(15, 16.5, 18.5, 17, 0, 5, R), span(15, 22, 18.5, 22.5, 0, 5, R),
    post(-10, 24, 2.2, 0, 1.2, 'crystal'), post(-10, 27.4, 2.2, 0, 2.2, 'crystal'), post(-6.6, 27.4, 2.2, 0, 3.2, 'crystal'),
    post(9, 15, 1.4, 0, 9.5, 'crystal'), post(-8, 37, 1.2, 0, 9, 'crystal'), post(10.5, 31, 1.8, 0, 10.5, 'crystal'),
    // C — lower cavern (under the hall) and the canyon: laser gate, a laser alcove, a crystal outcrop
    roof(-10, 33, 10, 60, -4, R, 6),
    span(-11, 33, -10, 41, -4, -1, R), span(10, 33, 11, 41, -4, -1, R),
    ...wall('z', 41, 72, -10.5, 1, -4, 8, R, [[54, 57, -4, -1.4]]),
    span(10, 41, 11, 72, -4, 8, R), span(-11, 72, 11, 73, -4, 8, R),
    ...wall('x', -10, 10, 48.5, 1, -4, 4, 'stone', [[-2, 2, -4, -1.4]]),
    roof(-14, 53.5, -11, 57.5, -4, R, 6), span(-15, 53, -14, 58, -4, 0, R), span(-14, 53, -11, 53.5, -4, 0, R), span(-14, 57.5, -11, 58, -4, 0, R),
    span(-14, 53.5, -11, 57.5, -1.4, -0.6, R),
    span(6, 43, 9.5, 46.5, -4, -1.8, 'crystal'),                               // outcrop (Pix)
    span(-7.2, 57.6, -5.75, 60, -4, -3.5, R),                                   // knee-high rock beside the crate's spot
    // D — the plateau (+2.6): lift for Brick, the hidden lift node, the portal and a crystal spire
    roof(-10, 60, 10, 72, -1.4, R, 6),
    span(1, 66.5, 6, 67.3, -1.4, 0, 'crystal'),                                // low crystal wall hiding node n4
    post(0, 70.6, 2.4, -1.4, 14, 'crystal'), post(-7, 69.5, 1.6, -1.4, 9.5, 'crystal'), post(7.5, 70, 1.6, -1.4, 11, 'crystal'),
    span(-9.5, 61, -7, 64, -1.4, 0.8, 'crystal'),                              // crystal ledge (Pix)
  ];
  return {
    name: 'Heavy Lifting',
    blurb: 'Brick: plates, crates and cracks',
    title: 'Heavy Lifting',
    say: 'Meet Brick — a gentle golem with a heavy heart. Literally: he weighs a ton. Let’s put that to work.',
    brief: [
      ['BRICK', 'Brick is heavy: he holds down big plates and shoves crates. He can’t jump high — the team helps him up.', true],
      ['POUND', `${KEY.act}: Brick hops and slams the ground — cracked floors and walls within 2 m shatter.`, true],
      ['LASERS', 'Lasers sting Vera and Pix. Brick walks right through them.', true],
      ['CRATES', 'Walk Brick into a crate to push it. Crates hold plates down and make handy steps.', true],
    ],
    lesson: 'a crash course in weight. Brick barely jumps — he makes the world come to him: plates, crates, cracks and lasers.',
    def: {
      theme: 'crystal',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [-3, 0, -5], yaw: 0 },
      killY: -15,
      par: 180,
      blocks,
      movers: [
        { p: [5.5, -4.25, 58.4], s: [3, 0.5, 3], m: 'stone', path: [[5.5, -4.25, 58.4], [5.5, -1.65, 58.4]], speed: 1.5, wait: 1.5, mode: 'pingpong', when: 'n4' },
      ],
      hazards: [
        // the laser gate (off while plate pl2 is pressed) and the laser alcove (always on: Brick only)
        ...[-3.65, -3.15, -2.65, -2.15, -1.65].map((y) => ({ type: 'laser', from: [-2, y, 48.5], to: [2, y, 48.5], when: 'pl2' })),
        ...[-3.65, -3.0, -2.35, -1.75].map((y) => ({ type: 'laser', from: [-10.5, y, 54], to: [-10.5, y, 57] })),
      ],
      items: [
        shard(-8.5, 2.2 + SH, 4),            // crystal shelf (Pix)
        shard(8.6, 0 + SH, -6.4),            // behind the crystals in the grotto
        shard(16.7, 0 + SH, 19.5),           // secret alcove behind the cracked wall (Brick)
        shard(-6.6, 3.2 + SH, 27.4),         // top of the crystal stair
        shard(-2, 4.3, 25),                  // floating: jump off the crystal stair
        shard(-6, -4 + SH, 36),              // dark corner under the hall
        shard(-12.5, -4 + SH, 55.5),         // laser alcove (Brick)
        shard(7.75, -1.8 + SH, 44.75),       // crystal outcrop (Pix)
        shard(-8.25, 0.8 + SH, 62.5),        // crystal ledge on the plateau (Pix)
        shard(-5.5, -1.4 + SH, 70.5),        // behind the portal
        shard(9, -4 + SH, 58.5),             // under the lift
        checkpoint(-4, 0, 14, 'cp1'),
        checkpoint(0, -4, 43, 'cp2'),
        checkpoint(-4, -4, 51.5, 'cp3'),
        { type: 'plate', id: 'hp1', p: [5, 0, 6], heavy: true },
        { type: 'door', p: [0, 1.8, 10.5], s: [4, 3.6, 1], when: 'hp1', tag: 'd1' },
        { type: 'crate', p: [5, 0.7, -3], s: [1.4, 1.4, 1.4], tag: 'box1' },
        { type: 'cracked', p: [14.5, 1.3, 19.5], s: [1, 2.6, 3], tag: 'crackwall' },
        { type: 'cracked', p: [0, -0.5, 36], s: [4, 1, 4], tag: 'crack' },
        { type: 'plate', id: 'pl2', p: [0, -4, 52] },
        { type: 'crate', p: [-5, -3.3, 51.8], s: [1.4, 1.4, 1.4], tag: 'box2' },
        { type: 'node', id: 'n4', p: [3.5, -1.4, 68.6] },
        { type: 'portal', p: [-3, -1.4, 64.5] },
        sign(2, 0, 7.5, 'HEAVY PLATE · golems only'),
        sign(3.5, -4, 46.5, 'Laser gate · plate beyond'),
      ],
      enemies: [],
      tips: [
        tip(5, 0, 6, 2.2, 'Too light! This plate needs Brick — switch to him.'),
        tip(2, 0, 8.5, 3, 'Brick can’t hold the plate and walk through. Push the crate onto it instead!'),
        tip(5, 0, -4.6, 1.8, 'Walk Brick into the crate to push it.'),
        tip(0, 0, 31.5, 3.5, `Hollow floor. Brick: press ${KEY.act} to ground-pound it.`),
        tip(12.5, 0, 19.5, 2.5, 'This wall looks cracked…'),
        tip(0, -4, 46, 3, 'Lasers! Brick barely feels them. Walk him through to the plate.'),
        tip(-5, -4, 57.5, 3, 'Too high for me. Brick, shove that crate against the cliff — I’ll climb it.'),
        tip(0, -1.4, 63, 3, 'A node behind the crystals runs the lift. Zap it for Brick!'),
      ],
    },
    solve: [
      ['deny', 'pix', 'cp1'],              // the grotto is walled in
      ['go', 'brick', 'hp1'],              // Brick holds the heavy plate: the door opens
      ['go', 'vera', 'cp1'],
      ['push', 'box1', [5, 6]],            // ...and the crate takes over, so Brick can follow
      ['go', 'brick', 'cp1'],
      ['go', 'pix', 'cp1'],
      ['pound', 'crackwall'],              // optional: the secret alcove in the hall
      ['deny', 'pix', 'cp2'],              // the hall is a dead end — except downwards
      ['pound', 'crack'],
      ['go', 'vera', 'cp2'], ['go', 'pix', 'cp2'], ['go', 'brick', 'cp2'],
      ['deny', 'pix', 'cp3'],              // the laser gate
      ['go', 'brick', 'pl2'],              // laser-proof Brick parks on the plate
      ['go', 'vera', 'cp3'], ['go', 'pix', 'cp3'],
      ['deny', 'vera', 'portal'],          // the cliff is 2.6 m
      ['push', 'box2', [-5, 59.3]],        // crate against the cliff
      ['zap', 'n4'],                       // Vera climbs rock → crate → plateau and zaps the hidden node
      ['go', 'brick', 'portal'], ['go', 'pix', 'portal'], ['go', 'vera', 'portal'],
    ],
  };
}

// =====================================================================================================
// 4 · ECHO CHAMBER (crystal) — three locks, three heroes, and crawlers.
// Concentric rings around a sealed vault. Door A (south): Brick holds the heavy plate while Vera and Pix
// slip in. Door B (west): Pix crawls to a timed switch while Brick waits outside it. Vault door: Brick
// pushes a crate under the north-east ledge so Vera can climb up and zap the node over the vault wall.
// =====================================================================================================
function echoChamber() {
  const R = 'rock';
  const C = 'crystal';
  const blocks = [
    // entrance corridor (start)
    roof(-4, -3, 4, 17, 0, R, 6),
    span(-5, -3, -4, 16, 0, 6, R), span(4, -3, 5, 16, 0, 6, R), span(-5, -4, 5, -3, 0, 6, R),
    span(-4, 6, -2.5, 9, 0, 2.2, C),                                            // crystal shelf (Pix)
    // outer ring: floor and outer walls (7 m), a cracked wall with an alcove, crystal blocks
    roof(-22, 16, 22, 63, 0, R, 6),
    span(-23, 15, -5, 16, 0, 7, R), span(5, 15, 23, 16, 0, 7, R),
    ...wall('z', 16, 64, -22.5, 1, 0, 7, R, [[24, 27, 0, 2.6]]),
    span(22, 16, 23, 64, 0, 7, R), span(-22, 63, 22, 64, 0, 7, R),
    roof(-26.5, 23.5, -23, 27.5, 0, R, 6), span(-27.5, 23, -26.5, 28, 0, 5, R), span(-26.5, 22.5, -23, 23.5, 0, 5, R), span(-26.5, 27.5, -23, 28.5, 0, 5, R),
    span(16, 44, 19, 47, 0, 2.2, C),                                            // crystal block (Pix)
    post(17, 22, 1.4, 0, 9.5, C), post(-18, 58, 1.6, 0, 10, C), post(18, 58, 1.2, 0, 9, C), post(-17, 33, 1.2, 0, 1, C),
    // inner ring walls (6 m): door A south, door B west
    ...wall('x', -13, 13, 27.5, 1, 0, 6, C, [[-2, 2, 0, 3.6]]),
    span(-13, 52, 13, 53, 0, 6, C), span(12, 28, 13, 52, 0, 6, C),
    ...wall('z', 28, 52, -12.5, 1, 0, 6, C, [[36, 40, 0, 3.6]]),
    // Pix's switch room (north-west of the inner ring), a duct through its 2 m wall
    span(-7, 46, -6, 52, 0, 6, R),
    ...wall('x', -12, -6, 45, 2, 0, 6, R, [[-10.2, -8.6, 0, 1.1]]),
    // the north-east ledge (+2.6) and a knee-high rock beside the crate's spot
    span(8, 46, 12, 52, 0, 2.6, R),
    span(10, 44.2, 11.4, 46, 0, 0.5, R),
    // the vault: 4.5 m crystal walls, a door south, the node pillar inside
    span(-5, 44.2, 5, 45, 0, 4.5, C), span(-5, 35, -4.2, 44.2, 0, 4.5, C), span(4.2, 35, 5, 44.2, 0, 4.5, C),
    ...wall('x', -4.2, 4.2, 35.4, 0.8, 0, 4.5, C, [[-1.5, 1.5, 0, 3.2]]),
    post(2.5, 42.5, 0.8, 0, 5, C),
    span(-4.2, 35.8, 4.2, 44.2, -0.1, 0.02, 'glow:#7dd3fc'),                    // glowing vault floor
  ];
  return {
    name: 'Echo Chamber',
    blurb: 'Three locks, three heroes',
    title: 'Echo Chamber',
    say: 'An echo chamber: whatever one of us does, the room answers. Brick holds, Pix runs, I zap — and we all get in.',
    brief: [
      ['CRAWLERS', 'Crawlers chase whoever is closest. Pix stomps them, Brick pounds them, a zap stuns them.', true],
      ['RELAY', 'Three locks, three heroes. Park each hero where they’ll be needed before you switch.', true],
      ['SNIFF', `${KEY.act} as Pix: she sniffs out the nearest shard.`, false],
    ],
    lesson: 'a three-way relay. Each lock wanted a different hero, and each hero opened the way for the next.',
    def: {
      theme: 'crystal',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, 1], yaw: 0 },
      killY: -15,
      par: 170,
      blocks,
      items: [
        shard(-3.25, 2.2 + SH, 7.5),         // crystal shelf in the corridor (Pix)
        shard(3, 0 + SH, -2),                // behind the start, off the camera's line
        shard(20, 0 + SH, 18.5),             // outer ring, south-east corner
        shard(17.5, 2.2 + SH, 45.5),         // crystal block (Pix)
        shard(-24.75, 0 + SH, 25.5),         // alcove behind the cracked outer wall (Brick)
        shard(19.5, 0 + SH, 61),             // outer ring, north-east corner
        shard(-8.5, 0 + SH, 50),             // Pix's switch room
        shard(10.5, 2.6 + SH, 50.5),         // the ledge
        shard(0, 0 + SH, 48.5),              // behind the vault
        shard(-3, 0 + SH, 43),               // inside the vault
        shard(-20, 0 + SH, 61.5),            // outer ring, north-west corner
        checkpoint(0, 0, 13, 'cp1'),
        checkpoint(-5, 0, 31, 'cp2'),
        checkpoint(-8, 0, 41.5, 'cp3'),
        { type: 'plate', id: 'hp', p: [-6.5, 0, 24], heavy: true },
        { type: 'door', p: [0, 1.8, 27.5], s: [4, 3.6, 1], when: 'hp', tag: 'doorA' },
        { type: 'switch', id: 'sw', p: [-9.5, 0, 49.5], mode: 'timed', time: 8 },
        { type: 'door', p: [-12.5, 1.8, 38], s: [1, 3.6, 4], when: 'sw', tag: 'doorB' },
        { type: 'crate', p: [9, 0.7, 31.5], s: [1.4, 1.4, 1.4], tag: 'box' },
        { type: 'node', id: 'n', p: [2.5, 5, 42.5] },
        { type: 'door', p: [0, 1.6, 35.4], s: [3, 3.2, 0.8], when: 'n', tag: 'vault' },
        { type: 'cracked', p: [-22.5, 1.3, 25.5], s: [1, 2.6, 3], tag: 'crackwall' },
        { type: 'portal', p: [-1.5, 0, 40] },
        sign(2.5, 0, 15, 'THE ECHO · three keys inside'),
      ],
      enemies: [
        { type: 'crawler', p: [15, 0, 30], range: 9 },
        { type: 'crawler', p: [-16, 0, 52], range: 9 },
        { type: 'crawler', p: [7, 0, 49], range: 8 },
      ],
      tips: [
        tip(0, 0, 18.5, 3, 'Crawlers! Jump on them as Pix, pound them as Brick — or stun them with a zap.'),
        tip(-6.5, 0, 24, 2.5, 'Brick holds this door open. Bring the others through while he stands here.'),
        tip(-9.4, 0, 43, 2.5, 'A vent: Pix only. The switch in there opens the west door — for 8 seconds.'),
        tip(-15, 0, 38, 3, 'Brick, wait here. When Pix flips the switch, this door opens for a few seconds.'),
        tip(9, 0, 42.5, 3, 'A crate under the ledge would make a fine step. The node is over the vault wall.'),
        tip(-23.5, 0, 25.5, 2.5, 'That wall sounds hollow…'),
      ],
    },
    solve: [
      ['deny', 'pix', 'cp2'],              // the inner ring is sealed
      ['go', 'brick', 'hp'],               // Brick holds door A
      ['go', 'vera', 'cp2'], ['go', 'pix', 'cp2'],
      ['pound', 'crackwall'],              // optional: the alcove in the outer wall
      ['go', 'brick', [-15.5, 0, 38]],     // Brick waits at door B
      ['deny', 'brick', 'cp3'],
      ['hit', 'pix', 'sw'],                // duct → timed switch: door B opens for 8 s
      ['go', 'brick', 'cp3'],
      ['expire', 'sw'],
      ['deny', 'brick', 'portal'],         // the vault door
      ['push', 'box', [9, 45.3]],          // crate under the ledge
      ['zap', 'n'],                        // rock → crate → ledge → zap over the vault wall
      ['go', 'all', 'portal'],
    ],
  };
}

// A floating sky island: a grass cap (top at `top`) on a rock body that tapers into the clouds.
function island(x0, z0, x1, z1, top, cap = 'grass') {
  const w = x1 - x0;
  const d = z1 - z0;
  const k = Math.min(w, d);
  const out = [span(x0, z0, x1, z1, top - 1, top, cap)];
  if (k > 3) out.push(span(x0 + k * 0.12, z0 + k * 0.12, x1 - k * 0.12, z1 - k * 0.12, top - 3.5, top - 1, 'rock'));
  if (k > 5) out.push(span(x0 + k * 0.28, z0 + k * 0.28, x1 - k * 0.28, z1 - k * 0.28, top - 7, top - 3.5, 'rock'));
  return out;
}
const pad16 = (x, y, z, power = 18) => ({ type: 'bounce', p: [x, y, z], power });

// =====================================================================================================
// 5 · UPDRAFT (sky) — bounce pads, crumbling bridges, movers, long glides.
// Pads lift everyone (Brick too) onto the next island; a crumbling bridge must be crossed without stopping;
// the shuttle runs while Brick holds the heavy plate OR node n2 is lit — Vera rides over, zaps n2 from the
// far side (it hides behind a rock wall) and the shuttle keeps running for Brick. Then a spiral of pads up to
// the portal. Vera can glide from the summit to a far island for a shard.
// =====================================================================================================
function updraft() {
  const blocks = [
    ...island(-8, -6, 8, 10, 0),                                                // A — start
    ...island(-7, 12.5, 7, 30, 2),                                              // B
    span(4, 24, 6.5, 26.5, 2, 4.2, 'rock'),                                     // rock pillar (Pix)
    post(-5, 27, 0.5, 2, 8, 'wood'), span(-5.6, 26.9, -4.4, 27.1, 6.5, 7.6, 'glow:#fbbf24'),   // lantern pole
    ...island(-9, 44, 9, 60, 2),                                                // C
    ...island(-13, 50, -10, 54, -1),                                            // ledge below C (shard, pad back up)
    ...island(-9, 74, 9, 92, 4),                                                // D
    span(-4, 80, 4, 81, 4, 6.2, 'rock'),                                        // rock wall hiding node n2
    // the updraft: floating ledges spiralling up to the summit
    pad(5, 90, 4, 3.5, 8, 'rock', 1.2), pad(0, 94, 4, 3, 12, 'rock', 1.2), pad(-5.5, 89.5, 5, 5, 16, 'stone', 1.5),
    post(-5.5, 89.5, 1.5, 4, 14.5, 'rock'),
    ...ring(-5.5, 89.5, 2.1, 4, 45 * deg, 90 * deg, (x, z) => post(x, z, 0.35, 16, 18.5, 'stone')),
    ...island(-24, 70, -17, 78, 6),                                             // G — the far glide island
  ];
  const crumbles = [];
  for (let z = 30; z < 44; z += 2) crumbles.push({ p: [0, 1.75, z + 1], s: [2.4, 0.5, 2], m: 'wood', delay: 0.6, back: 3 });
  crumbles.push({ p: [3.4, 1.75, 37], s: [2, 0.5, 2], m: 'wood', delay: 0.6, back: 3 });     // side tile with a shard
  return {
    name: 'Updraft',
    blurb: 'Bounce pads and crumbling bridges',
    title: 'Updraft',
    say: 'Sky islands! No floor down there — only clouds. Brick, don’t worry: the pads will lift you.',
    brief: [
      ['BOUNCE', 'Glowing pads fling anyone sky-high — even Brick. Steer while you fly.', true],
      ['CRUMBLE', 'Wooden tiles drop away a moment after you step on them. Keep moving and they come back.', true],
      ['MOVERS', 'Platforms carry you along. Some only run while their signal is on — and one signal can stand in for another.', true],
    ],
    lesson: 'air traffic control. Pads lift the heavy, glides carry the light — and either signal could keep the shuttle running.',
    def: {
      theme: 'sky',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, -1.5], yaw: 0 },
      killY: -20,
      par: 150,
      blocks,
      crumbles,
      movers: [
        // the shuttle C → D: runs while Brick holds hp or node n2 is lit
        { p: [0, 1.75, 61.6], s: [3, 0.5, 3], m: 'wood', path: [[0, 1.75, 61.6], [0, 3.75, 72.4]], speed: 2.4, wait: 1, mode: 'pingpong', when: ['hp', 'n2'], logic: 'any' },
        // a lazy carousel around the lantern pole on B (shard on top of the pole)
        { p: [-8.5, 2.6, 20], s: [2, 0.4, 2], m: 'wood', path: [[-8.5, 2.6, 20], [-8.5, 5, 24], [-7, 7.8, 27]], speed: 1.6, wait: 1.2, mode: 'pingpong' },
      ],
      items: [
        shard(0, -0 + SH, -4.5),             // behind the start
        shard(0, 5.2, 11.4),                 // in the first bounce arc
        shard(5.25, 4.2 + SH, 25.25),        // rock pillar (Pix)
        shard(-5, 8 + SH, 27),               // top of the lantern pole: ride the carousel
        shard(3.4, 2 + SH, 37),              // side tile of the crumbling bridge
        shard(-11.5, -1 + SH, 53),           // ledge below C
        shard(0, 5.4, 67),                   // above the shuttle route
        shard(0, 6.2 + SH, 80.5),            // on the rock wall (Pix)
        shard(6.5, 8 + SH, 91),              // first updraft ledge
        shard(0, 12 + SH, 94.5),             // second updraft ledge
        shard(-20.5, 6 + SH, 74),            // far glide island
        checkpoint(0, 2, 16.5, 'cp1'),
        checkpoint(-3, 2, 47, 'cp2'),
        checkpoint(-4, 4, 77.5, 'cp3'),
        pad16(0, 0, 9.3),
        pad16(-11.5, -1, 51),
        pad16(5, 4, 86),
        pad16(4.5, 8, 91),
        pad16(-1, 12, 94),
        pad16(-20.5, 6, 76.5),
        { type: 'plate', id: 'hp', p: [5, 2, 57], heavy: true },
        { type: 'node', id: 'n2', p: [0, 4, 83.5] },
        { type: 'portal', p: [-5.5, 16, 89.5] },
        sign(-3, 0, 7, 'UPDRAFT · mind the clouds'),
      ],
      enemies: [],
      tips: [
        tip(0, 0, 7.5, 2.5, 'Step on the bounce pad and steer toward the next island.'),
        tip(0, 2, 29, 3, 'Crumbling bridge! Cross in one go — the tiles come back a few seconds later.'),
        tip(5, 2, 57, 2.5, 'Brick on the plate starts the shuttle. But then who brings Brick?'),
        tip(0, 4, 76, 3, 'The node behind that rock also runs the shuttle. Zap it, then Brick can come over.'),
        tip(5, 4, 84, 2.5, 'Pads all the way up! Bounce, steer onto the ledge, bounce again.'),
        tip(-5.5, 16, 86.5, 2.5, 'See that island far below? Only a long glide reaches it.'),
      ],
    },
    solve: [
      ['go', 'vera', 'cp1'], ['go', 'pix', 'cp1'], ['go', 'brick', 'cp1'],     // the first bounce pad
      ['go', 'brick', 'cp2'], ['go', 'vera', 'cp2'], ['go', 'pix', 'cp2'],     // the crumbling bridge
      ['deny', 'vera', 'cp3'],             // the chasm C → D
      ['go', 'brick', 'hp'],               // the shuttle runs
      ['go', 'vera', 'cp3'], ['go', 'pix', 'cp3'],
      ['deny', 'brick', 'cp3'],            // (with Brick off the plate the shuttle would stop)
      ['zap', 'n2'],                       // ...unless n2 keeps it running
      ['go', 'brick', 'cp3'],
      ['go', 'all', 'portal'],             // the updraft
    ],
  };
}

// =====================================================================================================
// 6 · SENTRY SKIES (sky) — stealth past vision cones, turrets, cover.
// A sentry sweeps the first bridge. In the turret yard Brick (bolt-proof) holds the heavy plate in the line of
// fire while Vera and Pix hop from cover to cover into the covered bridge, where a switch keeps the gate open
// for him. In the courtyard three sentries watch the switch that raises the drawbridge — Pix crawls there
// unseen through a duct (or Vera stuns her way in and zaps it). A turret guards the portal island.
// =====================================================================================================
function sentrySkies() {
  const S = 'stone';
  const blocks = [
    ...island(-8, -6, 8, 10, 0),                                                // A — start
    span(-1.5, 10, 1.5, 26, -0.8, 0, S),                                        // bridge 1
    span(-1.65, 10, -1.35, 26, 0, 0.3, S), span(1.35, 10, 1.65, 26, 0, 0.3, S),
    ...island(3.5, 15, 7.5, 20, -3),                                            // ledge under the bridge
    ...island(-12, 26, 12, 46, 0),                                              // B — the turret yard
    span(7, 39, 11.5, 44.5, 0, 3, S),                                           // bastion with turret T1
    span(-11, 31, -9, 32.4, 0, 1.6, S), span(-8.5, 36, -6.5, 37.4, 0, 1.6, S), span(-5.5, 41, -3.5, 42.4, 0, 1.6, S),   // cover
    ...wall('x', -16, 16, 46.5, 1, 0, 8, S, [[-1.5, 1.5, 0, 3.2]]),             // gate wall: too tall to fly over
    // the covered bridge B → C (15 m over the void): floor, walls, roof
    span(-2, 47, 2, 62, -0.8, 0, S), span(-2.5, 47, -2, 62, 0, 3.2, S), span(2, 47, 2.5, 62, 0, 3.2, S), span(-2.5, 47, 2.5, 62, 3.2, 3.7, S),
    span(-2.45, 50, -2.05, 59, 1.4, 2.0, 'glow:#38bdf8'), span(2.05, 50, 2.45, 59, 1.4, 2.0, 'glow:#38bdf8'),
    // C — the sentry courtyard: 4 m walls, pillars, Pix's L-shaped duct to the switch
    ...island(-14, 62, 14, 88, 0),
    span(-14, 63, -13, 87, 0, 4, S), span(13, 63, 14, 87, 0, 4, S),
    ...wall('x', -14, 14, 62.5, 1, 0, 4, S, [[-2.5, 2.5, 0, 3.7]]),
    ...wall('x', -14, 14, 87.5, 1, 0, 4, S, [[-2, 2, 0, 3.2]]),
    post(-6, 69, 1.6, 0, 4, S), post(6, 69, 1.6, 0, 4, S), post(-6, 81, 1.6, 0, 4, S), post(6, 81, 1.6, 0, 4, S),
    span(-11.4, 63, -11, 72.6, 0, 1.1, 'metal'), span(-11, 72.6, -1.5, 73, 0, 1.1, 'metal'), span(-13, 74.6, -1.5, 75, 0, 1.1, 'metal'),
    span(-13, 63, -11, 75, 1.1, 1.5, 'metal'), span(-11, 72.6, -1.5, 75, 1.1, 1.5, 'metal'),
    // D — the portal island: turret tower, a crate for cover, a floating rock off the side
    ...island(-10, 100.5, 10, 119.5, 0.3),
    span(6, 113.5, 9, 116.5, 0.3, 4, S),
    ...island(-18, 106.5, -14, 111.5, -1),
  ];
  return {
    name: 'Sentry Skies',
    blurb: 'Sneak past drones and turrets',
    title: 'Sentry Skies',
    say: 'Drones on patrol and turrets on the walls. Let’s be clever, not loud — Brick, you’re allowed to be a little loud.',
    brief: [
      ['SENTRIES', 'Drones see in a cone of light. Stay out of it, sneak behind them, or zap one to stun it for 5 s.', true],
      ['TURRETS', 'Turrets fire laser bolts. Crates and walls block their aim, Brick shrugs bolts off, three zaps scrap one.', true],
      ['STEALTH', 'Pix is small: inside a duct nobody can see her.', true],
    ],
    lesson: 'a lesson in being unseen. Cones have edges, ducts have roofs, and a golem makes an excellent umbrella.',
    def: {
      theme: 'sky',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, -1], yaw: 0 },
      killY: -20,
      par: 140,
      blocks,
      movers: [
        // the drawbridge rises once sw3 is flipped and stays up
        { p: [0, -2.25, 94.25], s: [3.4, 0.5, 12.5], m: 'wood', path: [[0, -2.25, 94.25], [0, -0.25, 94.25]], speed: 1.2, wait: 9999, mode: 'pingpong', when: 'sw3' },
      ],
      items: [
        shard(0, 0 + SH, -4.5),              // behind the start
        shard(5.5, -3 + SH, 17),             // ledge under the bridge (pad back up)
        shard(0, 2, 18),                     // over bridge 1, right under the sentry
        shard(10.5, 3 + SH, 43.5),           // on the bastion behind the turret (Pix, via the crate)
        shard(-11, 0 + SH, 34.5),            // behind the first cover block
        shard(11, 0 + SH, 27.5),             // yard corner
        shard(-12.2, 0.6, 68),               // inside Pix's duct
        shard(12, 0 + SH, 86),               // courtyard corner, under the patrol
        shard(0, 2, 94),                     // over the drawbridge
        shard(8.5, 0.3 + SH, 118.5),         // behind the turret tower
        shard(-16, -1 + SH, 109),            // floating rock
        checkpoint(0, 0, 29, 'cp1'),
        checkpoint(0, 0, 59.5, 'cp2'),
        checkpoint(0, 0.3, 104, 'cp3'),
        pad16(5.5, -3, 18.6),
        pad16(-16, -1, 110.5),
        { type: 'plate', id: 'pl2', p: [5, 0, 33], heavy: true },
        { type: 'crate', p: [5.6, 0.7, 41.8], s: [1.4, 1.4, 1.4], tag: 'box' },
        { type: 'door', p: [0, 1.6, 46.5], s: [3, 3.2, 1], when: ['pl2', 'sw2'], logic: 'any', tag: 'gate' },
        { type: 'switch', id: 'sw2', p: [1.2, 0, 57] },
        { type: 'switch', id: 'sw3', p: [0, 0, 75.5] },
        { type: 'crate', p: [-4, 1, 107.5], s: [1.4, 1.4, 1.4], tag: 'cover' },
        { type: 'portal', p: [-3, 0.3, 112.5] },
        sign(3, 0, 7.5, 'PATROL ZONE · smile for the drones'),
      ],
      enemies: [
        { type: 'sentry', p: [0, 3.2, 12.5], path: [[0, 3.2, 12.5], [0, 3.2, 23.5]], speed: 2, fov: 70, range: 11 },
        { type: 'turret', p: [9, 3, 41.5], range: 16, rate: 1.1 },
        { type: 'sentry', p: [-9, 3.4, 66], path: [[-9, 3.4, 66], [9, 3.4, 66], [9, 3.4, 84], [-9, 3.4, 84]], speed: 2, fov: 70, range: 10 },
        { type: 'sentry', p: [0, 3.4, 68], path: [[0, 3.4, 68], [0, 3.4, 82]], speed: 1.6, fov: 60, range: 9 },
        { type: 'sentry', p: [-9, 3.4, 75], path: [[-9, 3.4, 77.5], [9, 3.4, 77.5]], speed: 1.8, fov: 60, range: 9 },
        { type: 'turret', p: [7.5, 4, 115], range: 16, rate: 1.0 },
      ],
      tips: [
        tip(0, 0, 8, 3, 'A sentry sweeps the bridge. Cross behind it — or stun it with a zap and run.'),
        tip(0, 0, 28.5, 3, 'Turret! Brick shrugs off its bolts. Vera and Pix: stay behind cover.'),
        tip(5, 0, 33, 2.5, 'The heavy plate opens the gate. Brick can stand here all day.'),
        tip(1.2, 0, 55, 2.5, 'This switch keeps the gate open for Brick.'),
        tip(0, 0, 61, 3, 'Three drones guard the switch. Pix can sneak through the duct on the left.'),
        tip(0, 0.3, 103, 3, 'Last turret. Push the crate into its line of fire, or scrap it with three zaps.'),
      ],
    },
    solve: [
      ['go', 'vera', 'cp1'], ['go', 'pix', 'cp1'], ['go', 'brick', 'cp1'],
      ['deny', 'pix', 'cp2'],              // the gate
      ['go', 'brick', 'pl2'],              // Brick holds the gate in the turret's line of fire
      ['hit', 'pix', 'sw2'],               // ...and Pix flips the switch that keeps it open
      ['go', 'vera', 'cp2'], ['go', 'brick', 'cp2'], ['go', 'pix', 'cp2'],
      ['deny', 'vera', 'cp3'],             // no drawbridge yet
      ['hit', 'pix', 'sw3'],               // through the duct, unseen
      ['go', 'all', 'portal'],
    ],
  };
}

// A laser curtain: beams across x0..x1 at z, from y0 upwards every `gap` metres (n beams).
function curtain(x0, x1, z, y0, n, extra = {}, gap = 0.5) {
  return Array.from({ length: n }, (_, i) => ({ type: 'laser', from: [x0, q(y0 + i * gap), z], to: [x1, q(y0 + i * gap), z], ...extra }));
}

// =====================================================================================================
// 7 · MAGMA WORKS (lava) — timed lasers and spikes, lava, everything at speed.
// A walkway of blinking spikes and a blinking laser gate; a lava river (crumbling stones for the agile, a
// raft for Brick that runs while someone stands on the far plate); a furnace of laser curtains that Brick
// walks through to hold the switch; and the sync gate: Pix's timed switch (deep in an L-shaped duct, out of
// zap sight) and Vera's timed node must both be on while all three rush through.
// =====================================================================================================
function magmaWorks() {
  const L = 'lava-rock';
  const M = 'metal';
  const blocks = [
    span(-6, -6, 6, 6, -3, 0, L),                                               // start
    span(-2.5, 6, 2.5, 30, -3, 0, M),                                           // the walkway
    span(-3.5, 19, -2.5, 20, 0, 3.2, M), span(2.5, 19, 3.5, 20, 0, 3.2, M), span(-3.5, 19, 3.5, 20, 2.6, 3.2, M),   // laser gate frame
    post(-5.5, 16, 1.4, -3, 0.8, L), post(5.5, 24, 1.4, -3, 1.8, L),           // lava pillars (shards)
    span(-8, 30, 8, 36, -3, 0, L),                                              // P2
    span(-8, 56, 8, 62, -3, 0, L),                                              // P3 (far bank)
    // the furnace: a 6 m wide corridor between 6 m walls, a Brick-only niche behind a laser curtain
    span(-3, 62, 3, 82, -3, 0, M),
    span(-4, 62, -3, 82, 0, 6, L),
    ...wall('z', 62, 82, 3.5, 1, 0, 6, L, [[72, 74, 0, 2.6]]),
    span(4, 71.5, 6, 74.5, -3, 0, M), span(6, 71, 7, 75, 0, 3, L), span(4, 71, 6, 71.5, 0, 3, L), span(4, 74.5, 6, 75, 0, 3, L), span(4, 71.5, 6, 74.5, 2.6, 3, L),
    span(-3.05, 63, -2.95, 81, 4.6, 5.0, 'glow:#ff6a00'), span(2.95, 63, 3.05, 81, 4.6, 5.0, 'glow:#ff6a00'),
    // P4: the pump house (Pix's L-shaped duct, sw4 at its far end), the sync gate, node n4's pillar
    span(-10, 82, 10, 93, -3, 0, L),
    span(-10, 86, -7.8, 88.2, 0, 3, M), span(-6.2, 86, -6, 92, 0, 3, M), span(-10, 89.8, -6, 92, 0, 3, M), span(-10, 88.2, -9.6, 89.8, 0, 3, M),
    span(-7.8, 86, -6.2, 89.8, 1.1, 3, M), span(-9.6, 88.2, -7.8, 89.8, 1.1, 3, M),
    span(-5.9, 87, -4.5, 89, 0, 1, M),                                          // step onto the pump house (Pix)
    ...wall('x', -14, 14, 92.5, 1, 0, 7, L, [[-2, 2, 0, 3.4]]),
    post(13, 88, 1.2, -3, 4, L),
    post(12.5, 84, 1.6, -3, 0.3, L),
    // P5: the portal
    span(-7, 93, 7, 104, -3, 0, L),
    post(-6, 103, 1, 0, 7, 'glow:#ff6a00'), post(6, 103, 1, 0, 7, 'glow:#ff6a00'),
  ];
  // stepping stones: the first two stand 1 m proud of the bank — a step Brick can never make
  const crumbles = [[39.4, 1], [43.8, 1], [48.2, 0.5], [52.6, 0]].map(([z, top]) => ({ p: [-5, top - 0.25, z], s: [2, 0.5, 2], m: L, delay: 0.6, back: 3 }));
  return {
    name: 'Magma Works',
    blurb: 'Lava, lasers and a ticking gate',
    title: 'Magma Works',
    say: 'Magma Works. It’s hot, it’s loud, and everything runs on a timer. Let’s be quick — and quick together.',
    brief: [
      ['RHYTHM', 'Lasers and spikes here blink on a beat. Watch the rhythm, then go.', true],
      ['LAVA', 'Lava is a hard no: a hero who falls in pops back at the last checkpoint.', true],
      ['SYNC', 'The last gate wants two timed signals at once. Line everyone up before you start the clock.', true],
    ],
    lesson: 'teamwork at speed. Line everyone up first, start the clocks second — the gate only waits a few seconds.',
    def: {
      theme: 'lava',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, -2], yaw: 0 },
      killY: -10,
      par: 150,
      blocks,
      crumbles,
      surfaces: [{ type: 'lava', p: [0, -1.5, 50], s: [60, 140] }],
      movers: [
        // the raft: runs while someone stands on plate pl3 on the far bank
        { p: [3, -0.25, 37.6], s: [3, 0.5, 3], m: M, path: [[3, -0.25, 37.6], [3, -0.25, 54.4]], speed: 3, wait: 1, mode: 'pingpong', when: 'pl3' },
      ],
      hazards: [
        { type: 'spikes', p: [0, 0.25, 12], s: [5, 0.5, 2], period: [1.4, 1.4] },
        ...curtain(-2.5, 2.5, 19.5, 0.35, 5, { period: [1.6, 1.4] }),
        { type: 'spikes', p: [0, 0.25, 25.5], s: [5, 0.5, 2], period: [1.2, 1.6] },
        ...[66, 70, 76, 80].flatMap((z) => curtain(-3, 3, z, 0.35, 8, { when: 'hs' }, 0.45)),
        { type: 'spikes', p: [0, 0.25, 68], s: [6, 0.5, 1.6], period: [1.3, 1.5] },
        { type: 'spikes', p: [0, 0.25, 78], s: [6, 0.5, 1.6], period: [1.3, 1.5] },
        ...curtain(3.5, 3.5, 72, 0.35, 5).map((l) => ({ ...l, to: [3.5, l.to[1], 74] })),
      ],
      items: [
        shard(0, 0 + SH, -4.5),              // behind the start
        shard(0, 1.6, 12),                   // over the first spike strip
        shard(-5.5, 0.8 + SH, 16),           // lava pillar
        shard(5.5, 1.8 + SH, 24),            // tall lava pillar (Pix)
        shard(-5, 0.5 + SH, 48.2),           // on a crumbling stone
        shard(3, 2.2, 46),                   // over the raft route
        shard(7, 0 + SH, 61),                // far bank corner
        shard(5, 0 + SH, 73),                // furnace niche behind the lasers (Brick)
        shard(-8, 3 + SH, 91),               // on the pump house (Pix)
        shard(12.5, 0.3 + SH, 84),           // lava stone by the node pillar
        shard(-5, 0 + SH, 101.5),            // behind the portal
        checkpoint(-4, 0, 33, 'cp1'),
        checkpoint(-4, 0, 59, 'cp2'),
        checkpoint(-6, 0, 84, 'cp3'),
        { type: 'plate', id: 'pl3', p: [5.5, 0, 58.5] },
        { type: 'switch', id: 'hs', p: [-1.6, 0, 81], mode: 'hold' },
        { type: 'switch', id: 'sw4', p: [-9, 0, 89], mode: 'timed', time: 10 },
        { type: 'node', id: 'n4', p: [13, 4, 88], time: 8 },
        { type: 'door', p: [0, 1.7, 92.5], s: [4, 3.4, 1], when: ['sw4', 'n4'], tag: 'sync' },
        { type: 'portal', p: [0, 0, 99] },
        sign(3.5, 0, 4, 'MAGMA WORKS · mind the beat'),
      ],
      enemies: [],
      tips: [
        tip(0, 0, 9, 2.5, 'Spikes blink up and down. Wait for them to drop, then go!'),
        tip(0, 0, 17, 2.5, 'Timed lasers. Brick walks straight through; Vera and Pix wait for the gap.'),
        tip(0, 0, 35, 3, 'Brick can’t jump the stones. Someone light, stand on the plate across the river — it runs the raft.'),
        tip(0, 0, 63.5, 3, 'Laser curtains! Brick strolls through and holds the switch at the far end.'),
        tip(-7, 0, 84.5, 2.5, 'The gate needs this timed switch AND the node on the pillar. Line up first!'),
        tip(0, 0, 90.5, 3, 'Park Brick here. Vera, find a spot that sees the node. Then send Pix in.'),
      ],
    },
    solve: [
      ['go', 'brick', 'cp1'], ['go', 'vera', 'cp1'], ['go', 'pix', 'cp1'],   // blinking spikes and lasers
      ['deny', 'brick', 'cp2'],            // the lava river
      ['go', 'vera', 'pl3'],               // over the crumbling stones, onto the plate: the raft runs
      ['go', 'brick', 'cp2'],
      ['go', 'pix', 'cp2'],
      ['deny', 'vera', 'cp3'],             // the laser curtains
      ['go', 'brick', 'hs'],               // Brick holds the curtains off
      ['go', 'vera', 'cp3'], ['go', 'pix', 'cp3'],
      ['go', 'brick', 'cp3'],
      ['deny', 'vera', 'portal'],          // the sync gate
      ['go', 'vera', [3, 0, 89]],          // line up: Vera within sight of n4,
      ['go', 'brick', [0, 0, 90.6]],       // Brick at the gate,
      ['hit', 'pix', 'sw4'],               // Pix in the duct: the clock starts
      ['zap', 'n4'],
      ['go', 'vera', [0, 0, 95]], ['go', 'brick', [-1.5, 0, 95]], ['go', 'pix', [1.5, 0, 95]],
      ['expire', 'sw4'], ['expire', 'n4'],
      ['go', 'all', 'portal'],
    ],
  };
}

// =====================================================================================================
// 8 · THE WARDEN (lava) — the boss. A short run over the lava, then an arena around the Warden.
// Shield 1: Brick on the heavy plate (west) and Pix on the light one (east), Vera zaps three times.
// Shield 2: Vera lights the three rim nodes, then has 6 s to zap three times. Shield 3: armoured crawlers
// that only Brick's pound breaks; then three more zaps. The portal opens when the Warden falls.
// Cover pillars stand outside the 5 m ring where the crawlers spawn, so none can land on top of one.
// =====================================================================================================
function theWarden() {
  const L = 'lava-rock';
  const M = 'metal';
  const blocks = [
    span(-6, -6, 6, 4, -3, 0, L),                                               // start
    span(-2, 4, 2, 14, -3, 0, M),                                               // bridge
    span(-5, 14, 5, 20, -3, 0, L),                                              // P1
    span(-6, 30, 6, 35, -3, 0, L),                                              // P2 — the arena gate
    span(3.5, 31, 6, 33.5, 0, 2.2, L),                                          // ledge (Pix)
    post(-5, 34.4, 0.8, 0, 7, 'glow:#ff6a00'), post(5, 34.4, 0.8, 0, 7, 'glow:#ff6a00'),
    // the arena: an octagon of basalt over the lava
    span(-11, 35, 11, 65, -3, 0, L), span(-15, 42, -11, 58, -3, 0, L), span(11, 42, 15, 58, -3, 0, L),
    span(-1.2, 48.8, 1.2, 51.2, 0, 0.3, 'glow:#ff3355'),                        // the Warden's mark on the floor
    // node pillars on the rim, cover pillars at 9 m (outside the crawler ring)
    post(-9, 61, 1.2, 0, 2.2, M), post(9, 61, 1.2, 0, 2.2, M), post(0, 37.5, 1.2, 0, 2.2, M),
    ...ring(0, 50, 9, 4, 45 * deg, 90 * deg, (x, z) => post(x, z, 1.4, 0, 2.2, L)),
    // a laser niche on the west rim (Brick), a floating rock east (glide), the portal terrace north
    span(-18, 47.5, -15, 52.5, -3, 0, L), span(-19, 47, -18, 53, 0, 3, L), span(-18, 47, -15, 47.5, 0, 3, L), span(-18, 52.5, -15, 53, 0, 3, L),
    span(-18, 47.5, -15, 52.5, 2.6, 3, L),
    span(19, 44, 22, 47, -3, -0.6, L),
    span(-4, 65, 4, 72, -3, 0, L),
    post(-3.5, 71.5, 0.9, 0, 6, 'glow:#ff6a00'), post(3.5, 71.5, 0.9, 0, 6, 'glow:#ff6a00'),
  ];
  return {
    name: 'The Warden',
    blurb: 'Face the guardian of the rift',
    title: 'The Warden',
    say: 'That’s the Warden — the thing holding the rift shut. Three shields, three of us. Ready, team?',
    brief: [
      ['SHIELD 1', 'Brick on the heavy plate, Pix on the light one: the shield drops. Then I zap — three hits.', true],
      ['SHIELD 2', 'Light every node on the rim, then zap fast: the window is short.', true],
      ['SHIELD 3', 'Armoured crawlers! Only Brick’s pound breaks them. Then I finish the job.', true],
      ['DODGE', 'It shoots at whoever you control. Jump its rings of orbs, duck behind pillars.', false],
    ],
    lesson: 'the whole team, one fight. Every shield wanted a different hero — and you switched like a pro.',
    def: {
      theme: 'lava',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, -2], yaw: 0 },
      killY: -10,
      par: 160,
      blocks,
      surfaces: [{ type: 'lava', p: [0, -1.5, 33], s: [60, 100] }],
      movers: [
        { p: [-2.5, -0.25, 21.6], s: [3, 0.5, 3], m: M, path: [[-2.5, -0.25, 21.6], [-2.5, -0.25, 28.4]], speed: 2.4, wait: 0.8, mode: 'pingpong' },
        { p: [2.5, -0.25, 28.4], s: [3, 0.5, 3], m: M, path: [[2.5, -0.25, 28.4], [2.5, -0.25, 21.6]], speed: 2.4, wait: 0.8, mode: 'pingpong' },
      ],
      hazards: [
        ...curtain(-15, -15, 48, 0.35, 5).map((l) => ({ ...l, to: [-15, l.to[1], 52] })),   // the niche's laser curtain
      ],
      items: [
        shard(0, 0 + SH, -4.5),              // behind the start
        shard(0, 1.6, 9),                    // over the bridge
        shard(-2.5, 1.8, 25),                // over a lava shuttle
        shard(4.75, 2.2 + SH, 32.25),        // ledge at the arena gate (Pix)
        shard(-16.5, 0 + SH, 50),            // laser niche (Brick)
        shard(6.36, 2.2 + SH, 56.36),        // on a cover pillar (Pix)
        shard(14, 0 + SH, 43),               // arena rim, south-east
        shard(-14, 0 + SH, 57),              // arena rim, north-west
        shard(20.5, -0.6 + SH, 45.5),        // floating rock (glide or dash)
        shard(-2.5, 0 + SH, 71),             // behind the portal
        checkpoint(-3, 0, 16.5, 'cp1'),
        checkpoint(-3, 0, 32, 'cp2'),
        pad16(20.5, -0.6, 46.5, 15),
        { type: 'plate', id: 'bp1', p: [-8, 0, 50], heavy: true },
        { type: 'plate', id: 'bp2', p: [8, 0, 50] },
        { type: 'node', id: 'bn1', p: [-9, 2.2, 61] },
        { type: 'node', id: 'bn2', p: [9, 2.2, 61] },
        { type: 'node', id: 'bn3', p: [0, 2.2, 37.5] },
        { type: 'portal', p: [0, 0, 68.5], when: 'warden' },
        sign(3, 0, 1, 'THE RIFT · authorised heroes only'),
      ],
      enemies: [
        { type: 'warden', p: [0, 5, 50], plates: ['bp1', 'bp2'], nodes: ['bn1', 'bn2', 'bn3'] },
      ],
      tips: [
        tip(0, 0, 18.5, 3, 'Ride the shuttles over the lava. Brick too!'),
        tip(0, 0, 33.5, 3, 'Here it comes. Brick to the heavy plate (left), Pix to the light one (right).'),
        tip(0, 0, 41, 3, 'Shield down? Zap it! Then light the three nodes on the pillars.'),
        tip(-16, 0, 50, 3, 'A niche behind lasers — Brick can stroll in.'),
      ],
    },
    solve: [
      ['go', 'all', 'cp1'],
      ['go', 'all', 'cp2'],                // the lava shuttles
      ['go', 'brick', 'bp1'], ['go', 'pix', 'bp2'],
      ['defeat', 'warden'],                // plates held · nodes lit · crawlers pounded · nine zaps
      ['go', 'all', 'portal'],
    ],
  };
}


// =====================================================================================================
// CHAPTER 2 · THE UNDERSIDE — everything that falls ends up below the city. Levels 9–12 have a whole second
// world under them (`under` = the height below which the game fades into it); rift geysers ('gate' items)
// throw a hero back up. Physics budget as above.
// =====================================================================================================
const U = -40;                                   // the Underside floor
const gate = (x, y, z, to, extra = {}) => ({ type: 'gate', p: [x, y, z], to, ...extra });
const crack = (id, x, y, z, s = [1.6, 2.4, 1.6]) => ({ type: 'cracked', id, p: [x, y, z], s });

// ---------- 9 · FREEFALL (neon above, the Underside below) ----------
// The skybridge gives way under the team (trigger 'quake'); they land 40 m down in a glowing cavern, cross a
// chasm on a shuttle and ride a rift geyser up to the far roof, where the portal is.
function freefall() {
  const blocks = [
    // A — the start roof
    roof(-8, -6, 8, 12, 0),
    span(-6, 3, -3.5, 5.5, 0, 1.2, 'metal'), span(3.5, 7, 6.5, 9.5, 0, 1, 'metal'),
    post(-4.5, 11.4, 0.3, 0, 4, 'metal'), post(4.5, 11.4, 0.3, 0, 4, 'metal'),
    span(-4.5, 11.3, 4.5, 11.6, 3, 4, 'glow:#ff2bd6'),              // gateway sign over the bridge
    // bridge towers (the deck itself is made of crumbles)
    post(-4.5, 12.6, 1, -26, 9, 'metal'), post(4.5, 12.6, 1, -26, 9, 'metal'),
    post(-4.5, 39.4, 1, -26, 9, 'metal'), post(4.5, 39.4, 1, -26, 9, 'metal'),
    span(-4.6, 12.4, -4.4, 39.6, 8.6, 8.9, 'glow:#22d3ee'), span(4.4, 12.4, 4.6, 39.6, 8.6, 8.9, 'glow:#22d3ee'),
    // C — the far roof with the portal (reachable only from below)
    roof(-8, 64, 8, 86, 0),
    span(-6.5, 72, -4, 74.5, 0, 1.2, 'metal'),
    post(6, 82, 0.4, 0, 6, 'metal'), span(5.8, 76, 6.2, 84, 3, 6, 'glow:#ff2bd6'),
    // U1 — the landing cavern
    span(-14, -10, 14, 46, U - 4, U, 'rock'),
    span(-14.6, -10, -14, 46, U, U + 9, 'rock'), span(14, -10, 14.6, 46, U, U + 9, 'rock'), span(-14, -10.6, 14, -10, U, U + 9, 'rock'),
    post(-7, 2, 1.4, U, U + 1.2, 'crystal'), post(8, -4, 1, U, U + 0.8, 'crystal'), post(-9, 24, 1.2, U, U + 1, 'crystal'),
    span(-0.15, 14, 0.15, 40, U, U + 0.05, 'glow:#14b8a6'), span(-3.2, 22, -2.95, 34, U, U + 0.05, 'glow:#14b8a6'),   // glowing roots
    post(9, 30, 1.6, U, U + 2.2, 'crystal'),                          // deep shard pillar (Pix)
    post(-5, 30, 1.4, U, U + 2.4, 'rock'), post(4, 18, 1.4, U, U + 2.4, 'rock'),   // cover
    // the laser niche (west wall) and the Pix duct (east wall)
    span(-14, 33, -10, 33.4, U, U + 3, 'rock'), span(-14, 40.6, -10, 41, U, U + 3, 'rock'), span(-14, 33, -10, 41, U + 3, U + 3.4, 'rock'),
    span(10, 2, 14, 4.6, U, U + 3, 'rock'), span(10, 9.4, 14, 12, U, U + 3, 'rock'),
    ...duct(10, 4.6, 14, 9.4, U, 'x', 'rock'),
    // the chasm (z 46–54) and U2 beyond it
    span(-10, 54, 10, 74, U - 4, U, 'rock'),
    span(-10.6, 54, -10, 74, U, U + 9, 'rock'), span(10, 54, 10.6, 74, U, U + 9, 'rock'), span(-10, 74, 10, 74.6, U, U + 9, 'rock'),
    post(-6, 64, 2.2, U, U + 5, 'crystal'), post(6, 61, 1.6, U, U + 3.2, 'crystal'),
  ];
  // the skybridge: 14 deck plates that fall one after another once someone reaches the middle
  const crumbles = [];
  for (let i = 0; i < 14; i++) crumbles.push({ p: [0, -0.3, 13 + i * 2], s: [5, 0.6, 2], m: 'metal', when: 'quake', once: true, delay: 0.35 + Math.abs(i - 6) * 0.09 });
  return {
    chapter: 'Chapter 2 · The Underside',
    name: 'Freefall',
    blurb: 'The bridge gives way — welcome to the world below',
    title: 'Freefall',
    say: 'The Warden is gone, but the city keeps shaking. Something under the streets is waking up. Careful on that bridge…',
    intro: 'With the Warden down, Neon City should be safe. It isn’t. Every night another street cracks open and its lights drain away — down, into the dark under the city. The team heads for Sector 9, where the cracks began.',
    brief: [
      ['UNDERSIDE', 'Fall off the level here and you don’t die — you drop into the Underside, a whole world below.', true],
      ['GEYSER', 'A rift geyser ⇧ throws a hero back up. Every hero has to ride one to reach the portal.', true],
      ['MISSION', 'Find all four deep shards in the Underside.', true],
    ],
    mission: { kind: 'deep', text: 'find all 4 deep shards in the Underside' },
    lesson: 'falling is not the end here. The Underside is part of the level — explore it, then ride a geyser home.',
    story: {
      intro: [['vera', 'Sector 9. This is where the cracks started.'], ['pix', 'The bridge looks… fine? Mostly fine. Kind of fine.'], ['brick', 'Brick goes last. Brick is heavy.']],
      at: [
        { p: [0, U, 20], r: 7, lines: [['echo', '…you fell too. Everyone falls, sooner or later.'], ['vera', 'Who said that?'], ['echo', 'Call me Echo. Follow the light roots — the geyser beyond the chasm will carry you up.']] },
        { p: [0, U, 58], r: 5, lines: [['echo', 'She is drinking the city’s light. The shards you gather are pieces of the Rift Heart.'], ['pix', 'She who? …I hate when voices say “she”.']] },
        { p: [0, 0, 70], r: 5, lines: [['brick', 'Up again. Brick likes up.']] },
      ],
      on: {
        quake: [['pix', 'Uh-oh. UH-OH!'], ['vera', 'Hold on — we’re going down!']],
        under: [['vera', 'We’re alive… and we’re under the city.']],
      },
      outro: [['echo', 'Go deeper when you are ready. Her foundry is below. I will be waiting.']],
    },
    def: {
      theme: 'neon',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, 0], yaw: 0 },
      under: -14,
      killY: -75,
      par: 170,
      blocks,
      crumbles,
      surfaces: [{ type: 'void', p: [0, U - 10, 50], s: [44, 10] }],
      movers: [
        { p: [0, U - 0.25, 47.5], s: [3, 0.5, 3], m: 'metal', path: [[0, U - 0.25, 47.5], [0, U - 0.25, 52.5]], speed: 2.2, wait: 1, mode: 'pingpong' },
      ],
      hazards: [
        ...curtain(-10, -10, 33.4, U + 0.35, 5).map((l) => ({ ...l, to: [-10, l.to[1], 40.6] })),     // the niche
      ],
      items: [
        shard(0, 0 + SH, -4.5),                  // behind the start
        shard(-4.75, 1.2 + SH, 4.25),            // on an AC unit
        shard(0, U + SH, 26),                    // on the glowing root
        shard(9, U + 2.2 + SH, 30),              // deep · crystal pillar (Pix)
        shard(-12, U + SH, 37),                  // deep · behind the lasers (Brick)
        shard(12.8, U + SH, 7),                  // deep · end of the duct (Pix)
        shard(-5.25, 1.2 + SH, 73.25),           // far roof, AC unit
        shard(6, 0 + SH, 85),                    // far roof, behind the billboard
        { type: 'trigger', id: 'quake', p: [0, -0.5, 25], r: 3.2, h: 4 },
        checkpoint(0, U, 20, 'u1'),
        checkpoint(-3, U, 57, 'u2'),
        checkpoint(0, 0, 71, 'roof'),
        gate(0, U, 68, [0, 0, 70.3], { yaw: 0 }),
        { type: 'portal', p: [0, 0, 80] },
        sign(3, 0, -3, 'SECTOR 9 · GROUND UNSTABLE'),
        sign(-3, U, 50, 'NO WAY UP · except the light'),
      ],
      enemies: [
        { type: 'crawler', p: [-6, U, 12], range: 8 },
        { type: 'crawler', p: [5, U, 40], range: 8 },
        { type: 'sentry', p: [0, U + 3.5, 60], path: [[-6, U + 3.5, 60], [6, U + 3.5, 60]], speed: 1.6, range: 10 },
        { type: 'sentry', p: [0, 3, 75], path: [[-5, 3, 75], [5, 3, 75]], speed: 1.8, range: 9 },
      ],
      tips: [
        tip(0, 0, 9, 3, 'The skybridge leads to the far roof. Looks solid. Probably.'),
        tip(0, U, 14, 4, 'You landed in the Underside! Everyone has to come down here — the only way up is a rift geyser.'),
        tip(-9, U, 37, 3, 'A niche behind lasers — Brick strolls in.'),
        tip(9, U, 7, 3, 'A low duct in the wall: only Pix fits.'),
        tip(0, U, 44, 3, 'Ride the shuttle over the chasm. Down there it really is the end.'),
        tip(0, U, 64, 3, 'The rift geyser! Step in to fly back up to the far roof.'),
      ],
    },
  };
}

// ---------- 10 · THE SUNKEN FOUNDRY (abyss) ----------
// Deep in the Underside: crumbling catwalks over the abyss, a turret hall with a crate puzzle, shuttles under a
// sentry, and a geyser to the portal ledge that only runs while Vera keeps its node lit.
function sunkenFoundry() {
  const M = 'metal';
  const R = 'rock';
  const blocks = [
    span(-6, -6, 6, 6, -4, 0, M),                                                  // start
    span(-6.6, -6, -6, 6, 0, 1, M), span(6, -6, 6.6, 6, 0, 1, M),
    span(-6, 22, 6, 30, -4, 0, M),                                                 // P1
    // the turret hall
    span(-7, 30, 7, 58, -4, 0, M),
    span(-7.6, 30, -7, 58, 0, 4.5, M), span(7, 30, 7.6, 58, 0, 4.5, M),
    post(-3.5, 46, 1.2, 0, 2.4, M), post(2.5, 46, 1.2, 0, 2.4, M),
    span(-7, 37, -5, 39, 0, 1.4, M),                                               // a ledge for a shard (Pix)
    span(-7, 57.4, -3, 58, 0, 4.5, M), span(3, 57.4, 7, 58, 0, 4.5, M), span(-3, 57.4, 3, 58, 3.4, 4.5, M),   // the gate wall
    span(-6, 58, 6, 64, -4, 0, M),                                                 // P2
    span(-3, 76, 3, 80, -4, 0, R),                                                 // island I1
    // P3 and the high ledge with the portal
    span(-7, 88, 7, 100, -4, 0, M),
    span(-6, 100, 6, 112, -4, 4, M),
    post(6.2, 96, 1.2, 0, 2.6, M),                                                 // node pillar
    span(-7, 94, -5, 96, 0, 2.2, M),                                               // shard perch (Pix)
    post(-2, 109, 0.4, 4, 9, M), post(2, 109, 0.4, 4, 9, M), span(-2, 108.9, 2, 109.1, 7, 9, 'glow:#2ee6c8'),
  ];
  const crumbles = [8, 11.2, 14.4, 17.6, 20.8].map((z, i) => ({ p: [i % 2 ? 1 : -1, -0.25, z], s: [2.6, 0.5, 2.4], m: R, delay: 0.55, back: 2.5 }));
  return {
    name: 'The Sunken Foundry',
    blurb: 'The Queen’s machines melt the city’s light',
    title: 'The Sunken Foundry',
    say: 'Echo says the Queen melts down whatever falls into a dark she calls “null”. Her foundry is right below us.',
    intro: 'Echo leads the team down the Underside’s roots to a foundry built from fallen streetlights. Turrets guard it; shuttles cross the abyss; a geyser at the far end only flows while its node is lit.',
    brief: [
      ['ABYSS', 'There is no world below this one. Fall here and you are back at the checkpoint.', false],
      ['COVER', 'Turrets shoot bolts — Brick shrugs them off. Push the crate onto the heavy plate to keep the gate open.', true],
      ['GEYSER', 'The last geyser runs only while its node is lit. Vera keeps it lit; everyone rides up.', true],
      ['MISSION', 'Hard: reach the portal without a single hit.', true],
    ],
    mission: { kind: 'nohit', text: 'no hero gets hit or falls' },
    lesson: 'cover and timing. Brick soaks the bolts, crates block the turrets’ view — and nobody has to get hit at all.',
    story: {
      intro: [['echo', 'Her foundry. Everything that falls is melted here into null.'], ['pix', 'Null. Great name for a place. Super welcoming.'], ['vera', 'Stay together. Brick in front.']],
      at: [
        { p: [0, 0, 34], r: 4, lines: [['brick', 'Bolts tickle. Brick goes first.']] },
        { p: [0, 0, 61], r: 4, lines: [['echo', 'Beyond the shuttles lies the road to the Maw. Her beast. Her jailer.']] },
        { p: [0, 0, 92], r: 4, lines: [['vera', 'The geyser is dead. If I light that node, it should run.']] },
      ],
      outro: [['echo', 'You are strong. Good. The Maw will not let you pass gently.'], ['brick', 'Brick does not pass gently either.']],
    },
    def: {
      theme: 'abyss',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, 0], yaw: 0 },
      killY: -20,
      par: 180,
      blocks,
      crumbles,
      surfaces: [{ type: 'void', p: [0, -9, 55], s: [70, 150] }],
      movers: [
        { p: [0, -0.25, 65.5], s: [3, 0.5, 3], m: M, path: [[0, -0.25, 65.5], [0, -0.25, 74.5]], speed: 2.6, wait: 1, mode: 'pingpong' },
        { p: [0, -0.25, 86.5], s: [3, 0.5, 3], m: M, path: [[0, -0.25, 86.5], [0, -0.25, 81.5]], speed: 2.2, wait: 1, mode: 'pingpong' },
      ],
      hazards: [
        { type: 'laser', from: [-3, 0.45, 14.4], to: [3, 0.45, 14.4], period: [1.4, 1.6] },
        { type: 'laser', from: [-3, 0.45, 20.8], to: [3, 0.45, 20.8], period: [1.4, 1.6], phase: 1.5 },
      ],
      items: [
        shard(0, 0 + SH, -4.5),                  // behind the start
        shard(1, 1.8, 11.2),                     // over a catwalk tile
        shard(-6, 1.4 + SH, 38),                 // on the hall ledge (Pix)
        shard(2.5, 2.4 + SH, 46),                // on a cover pillar (Pix)
        shard(6, 0 + SH, 31),                    // hall corner
        shard(0, 1.9, 70),                       // over the first shuttle
        shard(2.2, 0 + SH, 78),                  // island
        shard(-6, 2.2 + SH, 95),                 // perch (Pix)
        shard(-5, 4 + SH, 111),                  // behind the portal
        checkpoint(-3, 0, 26, 'cp1'),
        checkpoint(3, 0, 61, 'cp2'),
        checkpoint(-4, 0, 90, 'cp3'),
        { type: 'crate', p: [4.5, 0, 42] },
        { type: 'plate', id: 'fp', p: [4.5, 0, 52], heavy: true },
        { type: 'door', p: [0, 0, 57.7], s: [6, 3.4, 0.6], when: 'fp' },
        { type: 'node', id: 'fn', p: [6.2, 2.6, 96], time: 14 },
        gate(0, 0, 97, [0, 4, 103], { when: 'fn', yaw: 0 }),
        { type: 'portal', p: [0, 4, 106] },
        sign(3, 0, -3, 'FOUNDRY · all light becomes null'),
      ],
      enemies: [
        { type: 'turret', p: [-4.5, 0, 55], range: 17, rate: 1.2 },
        { type: 'turret', p: [4.5, 0, 55], range: 17, rate: 1.2 },
        { type: 'crawler', p: [-3, 0, 33], range: 8 },
        { type: 'sentry', p: [0, 3.2, 70], path: [[-4, 3.2, 66], [4, 3.2, 78], [-4, 3.2, 84]], speed: 1.6, range: 10, fov: 60 },
        { type: 'turret', p: [5, 4, 110], range: 15, rate: 1 },
      ],
      tips: [
        tip(0, 0, 5, 3, 'Catwalk tiles crumble under you — keep moving. The lasers blink: watch the beat.'),
        tip(0, 0, 31, 3, 'Two turrets. Brick walks through bolts; the others hide behind pillars and crates. Vera can zap them — three hits each.'),
        tip(4.5, 0, 46, 3, 'Brick: push this crate onto the heavy plate. The gate stays open while it sits there.'),
        tip(0, 0, 63, 3, 'Shuttles over the abyss, a drone above them. Time your hops.'),
        tip(0, 0, 93, 3, 'Vera: zap the node on the pillar. The geyser runs for 14 seconds — get everyone in!'),
      ],
    },
  };
}

// ---------- 11 · THE MAW (abyss boss) ----------
// A square arena around a pit. The Maw rears out of it. 1 · Brick pounds its three chain anchors → zap ×3.
// 2 · light the three timed switches on the corner perches (Pix climbs, Vera zaps) → zap ×3.
// 3 · armoured crawlers (Brick pounds) → zap ×3. It sweeps a floor beam: jump it, hide behind a pillar, or be Brick.
function theMaw() {
  const R = 'rock';
  const M = 'metal';
  const blocks = [
    span(-5, -6, 5, 6, -4, 0, M),                                   // start
    span(-2, 6, 2, 26, -4, 0, M),                                   // bridge
    span(-5, 26, 5, 32, -4, 0, M),                                  // the arena gate
    post(-4.5, 31.5, 0.6, 0, 6, M), post(4.5, 31.5, 0.6, 0, 6, M),
    post(-4.5, 31.5, 0.7, 5.6, 5.9, 'glow:#ff7a1a'), post(4.5, 31.5, 0.7, 5.6, 5.9, 'glow:#ff7a1a'),
    // the arena: a square ring around the pit (x ±6.5, z 43.5–56.5)
    span(-18, 32, 18, 43.5, -4, 0, R), span(-18, 56.5, 18, 68, -4, 0, R),
    span(-18, 43.5, -6.5, 56.5, -4, 0, R), span(6.5, 43.5, 18, 56.5, -4, 0, R),
    span(-6.6, 43.4, 6.6, 43.6, 0, 0.12, 'glow:#ff7a1a'), span(-6.6, 56.4, 6.6, 56.6, 0, 0.12, 'glow:#ff7a1a'),
    span(-6.6, 43.4, -6.4, 56.6, 0, 0.12, 'glow:#ff7a1a'), span(6.4, 43.4, 6.6, 56.6, 0, 0.12, 'glow:#ff7a1a'),
    // cover pillars and the corner perches (2.2 m: Pix, or Vera's zap)
    post(-10, 38, 1.4, 0, 2.6, R), post(10, 38, 1.4, 0, 2.6, R), post(-10, 62, 1.4, 0, 2.6, R), post(10, 62, 1.4, 0, 2.6, R),
    post(-15.5, 34.5, 1.8, 0, 2.2, M), post(15.5, 34.5, 1.8, 0, 2.2, M), post(0, 65.5, 1.8, 0, 2.2, M),
    span(-1.5, 62.6, 1.5, 64.6, 0, 0.9, M),                       // a step up to the north perch (Vera can climb it too)
    // the portal terrace
    span(-4, 68, 4, 78, -4, 0, M),
    post(-3.5, 77.5, 0.8, 0, 6, 'glow:#ff7a1a'), post(3.5, 77.5, 0.8, 0, 6, 'glow:#ff7a1a'),
    // the arena walls
    span(-18.6, 32, -18, 68, 0, 3, R), span(18, 32, 18.6, 68, 0, 3, R),
  ];
  return {
    name: 'The Maw',
    blurb: 'The Queen’s beast guards the deep road',
    title: 'The Maw',
    say: 'Something huge is moving in that pit. Three of us, three tricks. Let’s make it count.',
    intro: 'The deep road ends in a pit, and in the pit lives the Maw — the Null Queen’s jailer, chained to the arena by three anchors. It sweeps the floor with a beam of null and spits fire at whoever moves.',
    brief: [
      ['PHASE 1', 'Brick: ground-pound the three chain anchors. The Maw slumps — Vera, zap its heart three times.', true],
      ['PHASE 2 · 3', 'Light the three perch switches (Pix climbs, Vera can zap them), then pound its armoured brood. Zap after each.', true],
      ['BEAM', 'It sweeps a beam along the floor: jump it, hide behind a pillar — Brick just walks through.', true],
      ['MISSION', 'Hard: defeat the Maw and reach the portal in under 4:00.', true],
    ],
    mission: { kind: 'time', t: 240, text: 'clear it in under 4:00' },
    lesson: 'three phases, three heroes. The Maw punished standing still — and every pillar was a place to breathe.',
    story: {
      intro: [['echo', 'The Maw. It holds the deep road closed for her.'], ['pix', 'That’s not a road. That’s a mouth.'], ['vera', 'Then we close it.']],
      on: {
        'maw:start': [['maw', 'GRRRAAAH…'], ['echo', 'The chains! Break its anchors!']],
        'maw:1': [['vera', 'The chains are down! Pix — the switches on the perches!']],
        'maw:2': [['echo', 'It calls its brood. Brick, they fear your fists.']],
        maw: [['echo', 'The road is open. Beyond it… her throne. And the Heart.']],
      },
      outro: [['pix', 'Who’s a good giant eel? Not you. You were bad.'], ['echo', 'Rest. Then come to the Heart. She is waiting for you.']],
    },
    def: {
      theme: 'abyss',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, 0], yaw: 0 },
      killY: -20,
      par: 200,
      blocks,
      surfaces: [{ type: 'void', p: [0, -9, 40], s: [70, 110] }],
      items: [
        shard(0, 0 + SH, -4.5),                  // behind the start
        shard(0, 1.6, 16),                       // over the bridge
        shard(-15.5, 2.2 + SH, 34.5),            // perch (Pix)
        shard(16.5, 0 + SH, 66.5),               // arena corner
        shard(-16.5, 0 + SH, 66.5),              // arena corner
        shard(10, 2.6 + SH, 62),                 // on a cover pillar (Pix)
        shard(0, 1.4, 50),                       // over the pit — Pix's dash after the fight
        shard(-3, 0 + SH, 76.5),                 // behind the portal
        checkpoint(0, 0, 29, 'gate'),
        crack('a1', 0, 0, 37.5),
        crack('a2', -13, 0, 50),
        crack('a3', 13, 0, 50),
        { type: 'switch', id: 'm1', p: [-15.5, 2.2, 34.5], mode: 'timed', time: 12 },
        { type: 'switch', id: 'm2', p: [15.5, 2.2, 34.5], mode: 'timed', time: 12 },
        { type: 'switch', id: 'm3', p: [0, 2.2, 65.5], mode: 'timed', time: 12 },
        { type: 'portal', p: [0, 0, 73], when: 'maw' },
        sign(3, 0, -3, 'THE DEEP ROAD · closed'),
      ],
      enemies: [
        { type: 'boss', kind: 'maw', id: 'maw', name: 'The Maw', p: [0, 4.6, 50], floor: 0, wake: 19, phases: [
          { need: 'cracked', ids: ['a1', 'a2', 'a3'], window: 7, hits: 3, attacks: ['volley', 'sweep'] },
          { need: 'switches', ids: ['m1', 'm2', 'm3'], window: 6, hits: 3, attacks: ['volley', 'ring', 'sweep'], rate: 1.1 },
          { need: 'minions', minions: 3, window: 6, hits: 3, attacks: ['volley', 'ring', 'sweep'], rate: 1.25 },
        ] },
      ],
      tips: [
        tip(0, 0, 29, 3, 'The arena. Brick: pound the three glowing anchors. Everyone else: keep moving!'),
        tip(-14, 0, 37, 3, 'Perch switches: Pix double-jumps up, Vera can zap them from the floor.'),
      ],
    },
  };
}

// ---------- 12 · HEART OF THE RIFT (crystal above, the Underside below) — the final battle ----------
// The Null Queen's throne floats over the Underside. 1 · plates on the rim (Brick heavy, Pix light) → zap ×3:
// the throne floor shatters and she sinks below. 2 · in the Underside Brick pounds her three crystal anchors →
// zap ×3; geysers lead back up. 3 · back on the rim: light the three nodes → zap ×3. The portal opens.
function heartOfTheRift() {
  const C = 'crystal';
  const S = 'stone';
  const blocks = [
    span(-5, -6, 5, 6, -4, 0, S),                                  // start
    span(-2.5, 6, 2.5, 26, -4, 0, S),                              // causeway
    post(-2.3, 16, 0.6, 0, 1.6, C), post(2.3, 16, 0.6, 0, 1.6, C),
    span(-6, 26, 6, 34, -4, 0, S),                                 // P1
    // the throne rim (the middle, x ±11 / z 39–61, is made of crumbles that fall in phase 1)
    span(-16, 34, 16, 39, -4, 0, S), span(-16, 61, 16, 66, -4, 0, S),
    span(-16, 39, -11, 61, -4, 0, S), span(11, 39, 16, 61, -4, 0, S),
    post(-13.5, 36.5, 1.4, 0, 2.2, C), post(13.5, 36.5, 1.4, 0, 2.2, C), post(0, 64.2, 1.4, 0, 2.2, C),   // node pillars
    post(-14.5, 63.5, 1.2, 0, 2.6, S), post(14.5, 63.5, 1.2, 0, 2.6, S),                                  // cover
    span(-4, 66, 4, 76, -4, 0, S),                                 // the portal terrace
    post(-3.5, 75.5, 0.8, 0, 7, 'glow:#c084fc'), post(3.5, 75.5, 0.8, 0, 7, 'glow:#c084fc'),
    // the Underside below the throne
    span(-18, 32, 18, 68, U - 4, U, 'rock'),
    span(-18.6, 32, -18, 68, U, U + 8, 'rock'), span(18, 32, 18.6, 68, U, U + 8, 'rock'),
    span(-18, 31.4, 18, 32, U, U + 8, 'rock'), span(-18, 68, 18, 68.6, U, U + 8, 'rock'),
    post(-6, 38, 1.4, U, U + 2.4, 'rock'), post(6, 62, 1.4, U, U + 2.4, 'rock'), post(12, 40, 1.4, U, U + 2.4, 'rock'),
    span(-0.15, 33, 0.15, 67, U, U + 0.05, 'glow:#14b8a6'), span(-17, 49.85, 17, 50.15, U, U + 0.05, 'glow:#14b8a6'),
  ];
  const crumbles = [];
  for (let ix = 0; ix < 4; ix++) for (let iz = 0; iz < 4; iz++) {
    const d = Math.hypot(ix - 1.5, iz - 1.5);
    crumbles.push({ p: [-8.25 + ix * 5.5, -0.5, 41.75 + iz * 5.5], s: [5.5, 1, 5.5], m: C, when: 'queen:1', once: true, delay: 0.4 + d * 0.25 });
  }
  return {
    name: 'Heart of the Rift',
    blurb: 'The Null Queen, two worlds, one last fight',
    title: 'Heart of the Rift',
    say: 'This is it. The Heart is under her throne. Everyone we’ve met down here is counting on us.',
    intro: 'Above the Underside floats the Null Queen’s throne, and beneath it beats the Rift Heart — the light of the whole city, stolen shard by shard. Echo has one last secret: it was the Warden. It never held the rift shut to trap the city. It held it shut to keep her out.',
    brief: [
      ['PHASE 1', 'Rim plates: Brick on the heavy one, Pix on the light one. Vera zaps — and the floor will not hold.', true],
      ['PHASE 2 · 3', 'Below, Brick pounds her three crystal anchors. Then up the geysers: light the three rim nodes. Zap after each.', true],
      ['DODGE', 'A glowing ring on the ground means something is about to fall there.', true],
      ['MISSION', 'Hard: defeat the Queen without a single hit or fall.', true],
    ],
    mission: { kind: 'nohit', text: 'defeat the Queen without a single hit' },
    lesson: 'the whole adventure in one fight: plates, pounds, zaps and two worlds. The city’s lights are back — thanks to all three of you.',
    story: {
      intro: [['queen', 'Little lights. You came all the way down to give me the last of your shards?'], ['vera', 'We came to take the Heart back.'], ['queen', 'Then fall, like everything else.']],
      at: [{ p: [0, 0, 30], r: 4, lines: [['echo', 'I was the Warden. I held the rift shut — against her. Finish what I could not.'], ['pix', 'Wait, WHAT? We punched you!'], ['echo', 'You set me free. Now set the city free.']] }],
      on: {
        'queen:start': [['queen', 'Kneel, and I will make it quick.']],
        'queen:1': [['queen', 'Enough! Let the floor take you!'], ['brick', 'Brick knows falling. Brick is not scared.']],
        'queen:2': [['echo', 'She flees upward! Ride the geysers!'], ['vera', 'Everyone up — finish it on the rim!']],
        queen: [['queen', 'The light… it burns…'], ['echo', 'The Heart beats again. Look — the city is waking.']],
      },
      outro: [['vera', 'Every light in Neon City, back where it belongs.'], ['pix', 'Best. Team. Ever.'], ['brick', 'Brick agrees.'], ['echo', 'Thank you, heroes. The rift is quiet — for now.']],
    },
    def: {
      theme: 'crystal',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, 0], yaw: 0 },
      under: -14,
      killY: -75,
      par: 260,
      blocks,
      crumbles,
      surfaces: [{ type: 'void', p: [0, U - 10, 50], s: [80, 120] }],
      items: [
        shard(0, 0 + SH, -4.5),                  // behind the start
        shard(0, 1.7, 16),                       // between the causeway crystals
        shard(-13.5, 2.2 + SH, 36.5),            // on a node pillar (Pix)
        shard(14.5, 2.6 + SH, 63.5),             // on a cover pillar (Pix)
        shard(-15, U + SH, 66),                  // Underside corner
        shard(12, U + 2.4 + SH, 40),             // Underside pillar (Pix)
        shard(15, U + SH, 34),                   // Underside corner
        shard(3, 0 + SH, 74.5),                  // behind the portal
        checkpoint(-3, 0, 30, 'p1'),
        checkpoint(0, U, 44, 'below'),
        { type: 'plate', id: 'qp1', p: [-13.5, 0, 50], heavy: true },
        { type: 'plate', id: 'qp2', p: [13.5, 0, 50] },
        crack('qa1', -9, U, 46, [1.6, 2.6, 1.6]),
        crack('qa2', 9, U, 46, [1.6, 2.6, 1.6]),
        crack('qa3', 0, U, 60, [1.6, 2.6, 1.6]),
        { type: 'node', id: 'qn1', p: [-13.5, 2.2, 36.5] },
        { type: 'node', id: 'qn2', p: [13.5, 2.2, 36.5] },
        { type: 'node', id: 'qn3', p: [0, 2.2, 64.2] },
        gate(-15, U, 36, [-13.5, 0, 42], { yaw: Math.PI / 2 }),
        gate(15, U, 64, [13.5, 0, 58], { yaw: -Math.PI / 2 }),
        { type: 'portal', p: [0, 0, 71.5], when: 'queen' },
        sign(3, 0, -3, 'THE HEART · beneath the throne'),
      ],
      enemies: [
        { type: 'sentry', p: [0, 3, 18], path: [[-4, 3, 12], [4, 3, 22]], speed: 1.8, range: 9 },
        { type: 'boss', kind: 'queen', id: 'queen', name: 'The Null Queen', p: [0, 6, 50], floor: 0, wake: 16, reach: 24, phases: [
          { need: 'plates', ids: ['qp1', 'qp2'], hits: 3, attacks: ['volley', 'rain'] },
          { need: 'cracked', ids: ['qa1', 'qa2', 'qa3'], at: [0, U + 6, 50], floor: U, window: 7, hits: 3, attacks: ['volley', 'sweep'], rate: 1.1 },
          { need: 'nodes', ids: ['qn1', 'qn2', 'qn3'], at: [0, 6, 50], floor: 0, window: 6, hits: 3, attacks: ['volley', 'rain', 'ring'], rate: 1.2 },
        ] },
      ],
      tips: [
        tip(0, 0, 31, 3, 'The throne. Brick to the heavy plate on the left rim, Pix to the light one on the right.'),
        tip(0, U, 40, 5, 'The Underside! Brick: pound her three crystal anchors. Vera: zap her when the cage opens.'),
        tip(-14, U, 38, 3, 'A geyser back up to the rim.'),
      ],
    },
  };
}

// =====================================================================================================
// CHAPTER 3 · THE PRISM LABS — the labs that float over the clouds, where the rift was made. White decks,
// teleporters, laser grids, a containment breach, a reactor climb and the Architect. Falling off a lab deck
// drops you into the Underside cavern below (generated, `underside: true`). Physics budget as above.
// =====================================================================================================
const LAB = 'metal';
const LG = 'glow:#3cffd0';

// ---------- 13 · PRISM LABS (lab) ----------
// Lobby: Brick pushes a crate onto the heavy plate to open the lab door. A corridor of blinking laser grids
// (Brick walks through; a niche behind a steady grid hides a shard). The teleporter throws everyone up to the
// upper deck; Vera lights the node that starts the shuttle to the far deck and the portal.
function prismLabs() {
  const blocks = [
    span(-6, -6, 6, 8, -4, 0, LAB),                                        // start pad
    span(-2, 8, 2, 16, -4, 0, LAB),                                        // bridge
    span(-2.2, 8, -2, 16, 0, 0.9, 'glass'), span(2, 8, 2.2, 16, 0, 0.9, 'glass'),
    // the lobby
    span(-9, 16, 9, 34, -4, 0, LAB),
    span(-9.6, 16, -9, 34, 0, 4, LAB), span(9, 16, 9.6, 34, 0, 4, LAB),
    span(-9.6, 15.4, -2, 16, 0, 4, LAB), span(2, 15.4, 9.6, 16, 0, 4, LAB),
    span(-2, 15.4, 2, 16, 3.4, 4, LAB),
    ...wall('x', -9.6, 9.6, 34.3, 0.6, 0, 4, LAB, [[-2, 2, 0, 3.4]]),
    span(-9.6, 33.9, 9.6, 34.05, 3.6, 3.75, LG),                          // light strip over the lab door
    span(-3, 24, 3, 25.2, 0, 1.1, LAB),                                    // reception desk (shard)
    span(-3, 24.5, 3, 24.7, 1.1, 1.3, LG),
    post(7.5, 18.5, 1.6, 0, 2.2, LAB),                                     // specimen shelf (Pix)
    // the laser corridor
    span(-3, 34, 3, 52, -4, 0, LAB),
    span(-3.6, 34.6, -3, 52, 0, 3.5, LAB), span(3, 34.6, 3.6, 44, 0, 3.5, LAB), span(3, 48, 3.6, 52, 0, 3.5, LAB),
    span(-3.6, 34.6, 3.6, 34.9, 3.5, 3.7, LG), span(-3.6, 51.7, 3.6, 52, 3.5, 3.7, LG),
    // the niche behind the steady grid (Brick)
    span(3, 44, 6, 48, -4, 0, LAB), span(6, 44, 6.6, 48, 0, 3.5, LAB), span(3, 43.4, 6.6, 44, 0, 3.5, LAB), span(3, 48, 6.6, 48.6, 0, 3.5, LAB),
    // the teleporter room
    span(-8, 52, 8, 64, -4, 0, LAB),
    span(-8.6, 52, -8, 64, 0, 4, LAB), span(8, 52, 8.6, 64, 0, 4, LAB), span(-8.6, 64, 8.6, 64.6, 0, 6, LAB),
    span(-8.6, 52, -3, 52.6, 0, 4, LAB), span(3, 52, 8.6, 52.6, 0, 4, LAB),
    post(-6, 62, 1.2, 0, 1.4, LAB), post(6, 62, 1.2, 0, 1.4, LAB),
    // the upper deck
    span(-6, 74, 6, 90, 2, 6, LAB),
    post(4.5, 86, 1, 6, 7.2, LAB),                                         // node pedestal
    span(-6, 74, -5.8, 90, 6, 6.9, 'glass'), span(5.8, 74, 6, 84, 6, 6.9, 'glass'),
    // the far deck with the portal
    span(-7, 102, 7, 118, 2, 6, LAB),
    post(-6, 117, 0.5, 6, 10, LG), post(6, 117, 0.5, 6, 10, LG),
    span(-6, 116.8, 6, 117.2, 9.6, 10, LG),
    span(-6.5, 108, -4.5, 110, 6, 7.4, LAB),                               // a crate stack (shard, Pix / Vera)
  ];
  return {
    chapter: 'Chapter 3 · The Prism Labs',
    name: 'Prism Labs',
    blurb: 'Above the clouds, where the rift was made',
    title: 'Prism Labs',
    say: 'The Heart’s light points up — above the clouds. There’s a lab up there that isn’t on any map.',
    intro: 'With the Rift Heart back, Neon City glows again — but its light still bends toward the sky. The team follows it above the clouds to the Prism Labs, where someone built the Warden, opened the rift, and is still taking notes.',
    brief: [
      ['LOBBY', 'Brick: push the crate onto the heavy plate — the lab door opens while it sits there.', true],
      ['LASERS', 'The laser grids blink: go between pulses. Brick walks straight through.', true],
      ['TELEPORTER', 'The teleporter throws a hero up to the upper deck. Everyone has to ride it.', true],
      ['MISSION', 'Collect {n} coins.', true],
    ],
    mission: { kind: 'coins', share: 0.6, text: 'collect {n} coins' },
    lesson: 'labs reward the curious: coins in every corner, a niche only Brick reaches, a shelf only Pix climbs.',
    story: {
      intro: [['vera', 'A lab… above the clouds. Who builds a lab up here?'], ['echo', 'Someone who wanted to watch the city from very far away.'], ['pix', 'Creepy. Shiny. Mostly creepy.']],
      at: [
        { p: [0, 0, 36], r: 4, lines: [['brick', 'Lasers. Brick goes first. Lasers tickle.']] },
        { p: [0, 0, 56], r: 4, lines: [['architect', 'Visitors. How… unscheduled.'], ['vera', 'Who’s there?'], ['architect', 'Keep walking. I am taking notes.']] },
        { p: [0, 6, 80], r: 4, lines: [['vera', 'A node. If I light it, that shuttle should run.']] },
      ],
      outro: [['architect', 'Fascinating. Three variables I did not plan for.'], ['echo', 'That voice… I know it. He built the Warden.']],
    },
    def: {
      theme: 'lab',
      underside: true,
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, 0], yaw: 0 },
      killY: -15,
      par: 160,
      blocks,
      movers: [
        { p: [0, 5.75, 92.5], s: [3, 0.5, 3], m: LAB, path: [[0, 5.75, 92.5], [0, 5.75, 99.5]], speed: 2.2, wait: 1, mode: 'pingpong', when: 'n1' },
      ],
      hazards: [
        ...curtain(-3, 3, 39, 0.35, 4, { period: [1.3, 1.5] }),
        ...curtain(-3, 3, 43, 0.35, 4, { period: [1.3, 1.5], phase: 0.9 }),
        ...curtain(-3, 3, 47, 0.35, 4, { period: [1.3, 1.5], phase: 1.8 }),
        ...curtain(3.3, 3.3, 44, 0.35, 7).map((l) => ({ ...l, to: [3.3, l.to[1], 48] })),      // the niche grid (steady, wall-high)
      ],
      items: [
        shard(0, 0 + SH, -4.5),                  // behind the start
        shard(7.5, 2.2 + SH, 18.5),              // specimen shelf (Pix)
        shard(-7.5, 0 + SH, 32.5),               // lobby corner
        shard(0, 1.1 + SH, 24.6),                // on the desk
        shard(4.8, 0 + SH, 46),                  // the niche (Brick)
        shard(0, 1.4, 41),                       // between two grids
        shard(-6.5, 0 + SH, 62.5),               // teleporter room corner
        shard(-5, 6 + SH, 88.5),                 // upper deck corner
        shard(0, 7.4, 96),                       // over the shuttle
        shard(-5.5, 7.4 + SH, 109),              // crate stack on the far deck
        shard(6, 6 + SH, 116),                   // behind the portal
        checkpoint(0, 0, 18, 'lobby'),
        checkpoint(-5, 0, 55, 'tele'),
        checkpoint(0, 6, 77, 'deck'),
        checkpoint(-3, 6, 104, 'far'),
        { type: 'crate', tag: 'c1', p: [-5, 0.7, 20], s: [1.4, 1.4, 1.4] },
        { type: 'plate', id: 'lp', p: [-5, 0, 29], heavy: true },
        { type: 'door', p: [0, 0, 34.3], s: [4, 3.4, 0.6], when: 'lp' },
        { ...gate(0, 0, 60, [0, 6, 79], { yaw: 0, color: '#3cffd0' }), tag: 'g1' },
        { type: 'node', id: 'n1', p: [4.5, 7.2, 86] },
        { type: 'portal', p: [0, 6, 113] },
        sign(3, 0, -3, 'PRISM LABS · visitors not expected'),
        sign(-3, 0, 57, 'TELEPORTER ⇧ · upper deck'),
      ],
      enemies: [
        { type: 'crawler', p: [6, 0, 28], range: 6 },
        { type: 'crawler', p: [-5, 0, 59], range: 5 },
        { type: 'sentry', p: [0, 3.2, 57], path: [[-5, 3.2, 57], [5, 3.2, 57]], speed: 1.5, range: 9 },
        { type: 'turret', p: [5, 6, 111], range: 14, rate: 1 },
      ],
      tips: [
        tip(0, 0, 12, 3, 'Coins everywhere in the labs! Collect them — every 25 gives a heart back.'),
        tip(-5, 0, 19, 3, 'Brick: push this crate onto the heavy plate by the door.'),
        tip(0, 0, 36, 3, 'Laser grids blink — wait for the gap. Brick can walk right through.'),
        tip(0, 0, 58, 3, 'The teleporter! Each hero steps in to fly up to the upper deck.'),
        tip(0, 6, 82, 3, 'Vera: zap the node on the pedestal to start the shuttle.'),
      ],
    },
    solve: [
      ['push', 'c1', [-5, 29]],
      ['go', 'all', 'tele'],
      ['ride', 'vera', 'g1'], ['ride', 'pix', 'g1'], ['ride', 'brick', 'g1'],
      ['zap', 'n1'],
      ['go', 'all', 'far'],
      ['go', 'all', 'portal'],
    ],
  };
}

// ---------- 14 · CONTAINMENT BREACH (lab) — frags ----------
// The Architect opens the cells. Hall: Pix squeezes through the low vent into a sealed cell to throw its
// switch, Vera lights the node on the wall — together they open the bulkhead. Corridor: Brick pushes a crate
// round a corner onto the heavy plate that holds the second bulkhead. Blasters lie around: everyone shoots.
function containment() {
  const blocks = [
    span(-6, -6, 6, 6, -4, 0, LAB),                                        // start
    // hall 1
    span(-10, 6, 10, 40, -4, 0, LAB),
    span(-10.6, 6, -10, 40, 0, 4, LAB), span(10, 6, 10.6, 40, 0, 4, LAB),
    span(-10.6, 5.4, -2, 6, 0, 4, LAB), span(2, 5.4, 10.6, 6, 0, 4, LAB), span(-2, 5.4, 2, 6, 3.4, 4, LAB),
    // the sealed cell (x −10..−6.5, z 12..20): a low vent in its east wall
    ...wall('z', 11.4, 20.6, -6.2, 0.6, 0, 3.5, LAB, [[15, 17, 0, 1.1]]),
    span(-10, 11.4, -6.5, 12, 0, 3.5, LAB), span(-10, 20, -6.5, 20.6, 0, 3.5, LAB),
    span(-6.6, 11.4, -5.8, 20.6, 3.5, 3.7, LG),
    post(9.2, 26, 1, 0, 3, LAB),                                           // node column
    post(-3, 28, 1.4, 0, 2.2, LAB), post(3, 14, 1.4, 0, 2.2, LAB), post(4, 34, 1.4, 0, 2.2, LAB),   // cover
    ...wall('x', -10.6, 10.6, 40.3, 0.6, 0, 4, LAB, [[-2, 2, 0, 3.4]]),   // bulkhead 1
    // the corridor
    span(-9, 40, 9, 76, -4, 0, LAB),
    span(-9.6, 40.6, -9, 76, 0, 4, LAB), span(9, 40.6, 9.6, 76, 0, 4, LAB),
    span(-9, 54, -4, 62, 0, 2.2, 'glass'), span(4, 64, 9, 70, 0, 2.2, 'glass'),   // specimen tanks
    span(-9, 57.8, -4, 58.2, 2.2, 2.4, LG), span(4, 66.8, 9, 67.2, 2.2, 2.4, LG),
    ...wall('x', -9.6, 9.6, 76.3, 0.6, 0, 4, LAB, [[-2, 2, 0, 3.4]]),     // bulkhead 2
    // the final chamber
    span(-10, 76, 10, 102, -4, 0, LAB),
    span(-10.6, 76.6, -10, 102, 0, 4, LAB), span(10, 76.6, 10.6, 102, 0, 4, LAB), span(-10.6, 102, 10.6, 102.6, 0, 6, LAB),
    ...stairs(-3, 86.5, 3, 91, '+z', 3, 0, 1.2, LAB),
    span(-5, 91, 5, 99, -1, 1.2, LAB),                                     // the portal dais
    post(-4.5, 98.5, 0.5, 1.2, 5, LG), post(4.5, 98.5, 0.5, 1.2, 5, LG),
    post(-7, 84, 1.4, 0, 2.2, LAB), post(7, 84, 1.4, 0, 2.2, LAB),
  ];
  return {
    name: 'Containment Breach',
    blurb: 'The cells are open. Grab a blaster.',
    title: 'Containment Breach',
    say: 'Alarms everywhere. Whatever he kept in those cells is out — and it’s angry.',
    intro: 'The Architect does not like visitors. He opens every containment cell in the Prism Labs at once. The team has blasters now — and a lot of crawlers, drones and turrets between them and the next deck.',
    brief: [
      ['BLASTER', 'Orange orbs are blasters: for 15 s every hero shoots with the ability button.', true],
      ['BULKHEAD 1', 'Pix crawls through the low vent and throws the cell switch; Vera zaps the node on the wall.', true],
      ['BULKHEAD 2', 'Brick: push the crate round the tanks onto the heavy plate.', true],
      ['MISSION', 'Hard: frag every crawler, drone and turret.', true],
    ],
    mission: { kind: 'hunter', text: 'frag every crawler, drone and turret' },
    lesson: 'frags win fights, cover wins frags. Blasters turn the whole team into shooters — Brick still soaks the bolts.',
    story: {
      intro: [['architect', 'Specimens, meet the specimens.'], ['pix', 'Did he just call US specimens?'], ['vera', 'Blasters on. Stay behind cover.']],
      at: [
        { p: [0, 0, 43], r: 4, lines: [['brick', 'Brick pushes. Everyone else shoots.']] },
        { p: [0, 0, 79], r: 4, lines: [['architect', 'Remarkable. You cooperate. The Warden never did.'], ['echo', 'Because you built it to be alone.']] },
      ],
      outro: [['vera', 'All clear. Every last one.'], ['architect', 'Then come up to the reactor. I will show you what the light is for.']],
    },
    def: {
      theme: 'lab',
      underside: true,
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, 0], yaw: 0 },
      killY: -15,
      par: 200,
      blocks,
      hazards: [],
      items: [
        shard(0, 0 + SH, -4.5),                  // behind the start
        shard(-8.2, 0 + SH, 13),                 // in the sealed cell (Pix)
        shard(-3, 2.2 + SH, 28),                 // on a cover pillar (Pix)
        shard(8.5, 0 + SH, 38.5),                // hall corner
        shard(-6.5, 2.2 + SH, 58),               // on a specimen tank (Pix / Vera from the crate)
        shard(7.5, 0 + SH, 42),                  // corridor corner
        shard(0, 0 + SH, 73),                    // by bulkhead 2
        shard(-8.5, 0 + SH, 100.5),              // chamber corner
        shard(8.5, 0 + SH, 100.5),               // chamber corner
        shard(7, 2.2 + SH, 84),                  // on a chamber pillar (Pix)
        checkpoint(0, 0, 9, 'in'),
        checkpoint(0, 0, 44, 'cor'),
        checkpoint(0, 0, 80, 'end'),
        { type: 'switch', id: 's1', p: [-8.5, 0, 16] },
        { type: 'node', id: 'n2', p: [9.2, 3, 26] },
        { type: 'door', p: [0, 0, 40.3], s: [4, 3.4, 0.6], when: ['s1', 'n2'] },
        { type: 'crate', tag: 'c2', p: [6, 0.7, 50], s: [1.4, 1.4, 1.4] },
        { type: 'plate', id: 'h1', p: [0, 0, 70], heavy: true },
        { type: 'door', p: [0, 0, 76.3], s: [4, 3.4, 0.6], when: 'h1' },
        { type: 'portal', p: [0, 1.2, 95] },
        sign(3, 0, -3, 'CONTAINMENT · all cells open'),
        sign(-4.5, 0, 22, 'CELL 3 · vent ⇢'),
      ],
      enemies: [
        { type: 'crawler', p: [-5, 0, 24], range: 9 },
        { type: 'crawler', p: [5, 0, 20], range: 9 },
        { type: 'crawler', p: [0, 0, 33], range: 9 },
        { type: 'sentry', p: [0, 3.2, 22], path: [[-6, 3.2, 18], [6, 3.2, 30]], speed: 1.6, range: 10, fov: 60 },
        { type: 'turret', p: [-7.5, 0, 74], range: 15, rate: 1.1 },
        { type: 'crawler', p: [0, 0, 60], range: 9 },
        { type: 'crawler', p: [-5, 0, 66], range: 9 },
        { type: 'crawler', p: [-6, 0, 90], range: 10 },
        { type: 'crawler', p: [6, 0, 92], range: 10 },
        { type: 'sentry', p: [0, 3.4, 86], path: [[-7, 3.4, 86], [7, 3.4, 86]], speed: 1.8, range: 10, fov: 60 },
        { type: 'turret', p: [8, 0, 100], range: 15, rate: 1.1 },
      ],
      tips: [
        tip(0, 0, 8, 3, 'Grab the orange blaster — then anyone can shoot with the ability button (E / ACTION).'),
        tip(-5, 0, 16, 3, 'A low vent into the sealed cell — only Pix fits. The switch is inside.'),
        tip(6, 0, 46, 3, 'Brick: push the crate left past the tanks, then up the corridor onto the heavy plate.'),
      ],
      powers: [{ kind: 'blaster', p: [0, 1, 8] }, { kind: 'blaster', p: [-6, 1, 44] }, { kind: 'shield', p: [6, 1, 44] }, { kind: 'blaster', p: [0, 1, 79] }, { kind: 'speed', p: [-8, 1, 80] }],
    },
    solve: [
      ['hit', 'pix', 's1'],
      ['zap', 'n2'],
      ['go', 'all', 'cor'],
      ['push', 'c2', [0, 50]],
      ['push', 'c2', [0, 70]],
      ['go', 'all', 'end'],
      ['go', 'all', 'portal'],
    ],
  };
}

// ---------- 15 · THE REACTOR SPIRE (lab) — a climb against the clock ----------
// Stairs to the first terrace, a catwalk that crumbles under you, a lift, a launch pad over a gap that nobody
// can jump, and shuttles round the reactor to the top terrace. Fall, and the Underside catches you.
function reactorSpire() {
  const blocks = [
    span(-6, -6, 6, 6, -4, 0, LAB),                                        // start
    ...stairs(-3, 6, 3, 14, '+z', 4, 0, 2.4, LAB),
    span(-6, 14, 6, 24, -2, 2.4, LAB),                                     // terrace 1
    post(-5, 22.5, 1.2, 2.4, 4.6, LAB),                                    // a tall locker (Pix)
    span(-6, 36, 6, 46, -2, 2.4, LAB),                                     // terrace 2
    span(-6.2, 36, -6, 46, 2.4, 3.3, 'glass'), span(6, 36, 6.2, 46, 2.4, 3.3, 'glass'),
    span(-6, 50, 6, 60, 3, 7.4, LAB),                                      // terrace 3 (the lift goes up here)
    post(5, 57.5, 1, 7.4, 8.6, LAB),                                       // node pedestal
    span(-6, 61.5, 6, 76, 8, 11.4, LAB),                                   // terrace 4
    span(-2, 61.5, 2, 61.8, 11.4, 11.6, LG),
    span(-7, 88, 7, 100, 8, 11.4, LAB),                                    // the top terrace
    post(-6, 99, 0.5, 11.4, 15, LG), post(6, 99, 0.5, 11.4, 15, LG), span(-6, 98.8, 6, 99.2, 14.6, 15, LG),
    // the reactor: a glowing column beside the climb (scenery you can stand on at its foot)
    post(-14, 50, 5, -4, 22, 'glass'), post(-14, 50, 5.4, 6, 6.4, LG), post(-14, 50, 5.4, 14, 14.4, LG), post(-14, 50, 5.4, 21.6, 22, LG),
  ];
  const crumbles = [25.2, 27.6, 30, 32.4, 34.8].map((z, i) => ({ p: [i % 2 ? 0.6 : -0.6, 2.15, z], s: [3, 0.5, 2.2], m: LAB, delay: 0.6, back: 2.5 }));
  return {
    name: 'The Reactor Spire',
    blurb: 'Up the spire before the reactor wakes',
    title: 'The Reactor Spire',
    say: 'He said “come up”. So we go up. Fast.',
    intro: 'The Prism Labs run on a reactor that drinks the city’s light. Its spire climbs past crumbling catwalks, lifts and launch pads to the top terrace, where the Architect’s chamber waits. The higher you go, the further the fall — but the Underside always catches you.',
    brief: [
      ['CATWALK', 'The catwalk tiles crumble a moment after you step on them. Keep moving.', true],
      ['LAUNCH PAD', 'Nobody can jump to terrace 4 — the launch pad throws you up. Steer forward in the air.', true],
      ['SHUTTLE', 'Vera: zap the node on terrace 3 to start the shuttles.', true],
      ['MISSION', 'Hard: reach the top in under 2:30.', true],
    ],
    mission: { kind: 'time', t: 150, text: 'clear it in under 2:30' },
    lesson: 'momentum. Crumbling tiles, lifts and pads all punish waiting — the fastest route is the one you planned.',
    story: {
      intro: [['pix', 'Up? How far up?'], ['vera', 'All of it.'], ['brick', 'Brick does not like up. Brick will do up.']],
      at: [
        { p: [0, 7.4, 53], r: 4, lines: [['architect', 'Do you know what the Rift Heart is? A battery. The best I ever built.']] },
        { p: [0, 11.4, 70], r: 4, lines: [['echo', 'He made the rift to fill it. The Queen was his first experiment.'], ['vera', 'And the city was his power plant.']] },
      ],
      outro: [['architect', 'Come in, then. Let us see how your little team does against its designer.']],
    },
    def: {
      theme: 'lab',
      underside: true,
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, 0], yaw: 0 },
      killY: -15,
      par: 150,
      blocks,
      crumbles,
      movers: [
        { p: [0, 2.15, 48], s: [3, 0.5, 3], m: LAB, path: [[0, 2.15, 48], [0, 7.15, 48]], speed: 1.6, wait: 1.5, mode: 'pingpong' },
        { p: [-2, 11.15, 78.5], s: [3, 0.5, 3], m: LAB, path: [[-2, 11.15, 78.5], [-2, 11.15, 85.5]], speed: 2.4, wait: 1, mode: 'pingpong', when: 'n3' },
        { p: [2, 11.15, 85.5], s: [3, 0.5, 3], m: LAB, path: [[2, 11.15, 85.5], [2, 11.15, 78.5]], speed: 2.4, wait: 1, mode: 'pingpong', when: 'n3' },
      ],
      hazards: [
        ...curtain(-6, 6, 55, 7.75, 3, { period: [1.4, 1.6] }),
      ],
      items: [
        shard(0, 0 + SH, -4.5),                  // behind the start
        shard(-5, 4.6 + SH, 22.5),               // on the locker (Pix)
        shard(0, 3.8, 30),                       // over the catwalk
        shard(5, 2.4 + SH, 44.5),                // terrace 2 corner
        shard(0, 4.6, 48),                       // in the lift shaft
        shard(-5, 7.4 + SH, 58.5),               // terrace 3 corner
        shard(4.5, 11.4 + SH, 74.5),             // terrace 4 corner
        shard(-2, 12.8, 82),                     // over a shuttle
        shard(6, 11.4 + SH, 89),                 // top terrace corner
        shard(-5, 11.4 + SH, 98),                // behind the portal
        checkpoint(0, 2.4, 17, 't1'),
        checkpoint(-3, 7.4, 52, 't3'),
        checkpoint(0, 11.4, 64, 't4'),
        { type: 'bounce', p: [0, 7.4, 59], power: 16 },
        { type: 'node', id: 'n3', p: [5, 8.6, 57.5] },
        { type: 'portal', p: [0, 11.4, 95] },
        sign(3, 0, -3, 'REACTOR SPIRE · authorised staff only'),
      ],
      enemies: [
        { type: 'crawler', p: [3, 2.4, 40], range: 6 },
        { type: 'sentry', p: [0, 13.5, 82], path: [[-5, 13.5, 82], [5, 13.5, 82]], speed: 1.8, range: 10, fov: 60 },
        { type: 'turret', p: [-5, 11.4, 92], range: 14, rate: 1 },
      ],
      tips: [
        tip(0, 2.4, 22, 3, 'The catwalk crumbles — keep running. Fall and the Underside catches you.'),
        tip(0, 2.4, 44, 3, 'The lift rises to terrace 3. Hop on.'),
        tip(0, 7.4, 56, 3, 'Launch pad! It throws you up — steer forward onto terrace 4. Vera: zap the node first.'),
      ],
    },
    solve: [
      ['go', 'all', 't1'],
      ['go', 'all', 't3'],
      ['zap', 'n3'],
      ['go', 'all', 't4'],
      ['go', 'all', 'portal'],
    ],
  };
}

// ---------- 16 · THE ARCHITECT (lab boss) ----------
// A round lab floor over the clouds. 1 · Brick holds the heavy plate, Pix the light one → the shield drops: zap ×3.
// 2 · Vera lights the three timed nodes on the pylons → zap ×3. 3 · its armoured drones (Brick pounds them)
// → zap ×3. Blasters let everyone shoot when it is open. It sweeps a beam, fans volleys, rains light.
function theArchitect() {
  const blocks = [
    span(-5, -6, 5, 6, -4, 0, LAB),                                        // start
    span(-2, 6, 2, 24, -4, 0, LAB),                                        // bridge
    span(-2.2, 6, -2, 24, 0, 0.9, 'glass'), span(2, 6, 2.2, 24, 0, 0.9, 'glass'),
    span(-6, 24, 6, 30, -4, 0, LAB),                                       // the gate
    post(-5, 29.5, 0.6, 0, 6, LAB), post(5, 29.5, 0.6, 0, 6, LAB), span(-5, 29.3, 5, 29.7, 5.6, 6, LG),
    // the arena floor and its rings
    span(-18, 30, 18, 70, -4, 0, LAB),
    ...ring(0, 50, 8, 24, 0, (Math.PI * 2) / 24, (x, z) => post(x, z, 0.5, 0, 0.06, LG)),
    // cover pillars and the node pylons (2.2 m)
    post(-10, 40, 1.4, 0, 2.2, LAB), post(10, 40, 1.4, 0, 2.2, LAB), post(-10, 60, 1.4, 0, 2.2, LAB), post(10, 60, 1.4, 0, 2.2, LAB),
    post(-15, 50, 1.2, 0, 2.2, LAB), post(15, 50, 1.2, 0, 2.2, LAB), post(0, 66, 1.2, 0, 2.2, LAB),
    // the walls with glass windows
    span(-18.6, 30, -18, 70, 0, 1.2, LAB), span(18, 30, 18.6, 70, 0, 1.2, LAB), span(-18.6, 30, -18, 70, 1.2, 3, 'glass'), span(18, 30, 18.6, 70, 1.2, 3, 'glass'),
    span(-18, 70, -4, 70.6, 0, 3, LAB), span(4, 70, 18, 70.6, 0, 3, LAB),
    // the portal terrace
    span(-4, 70, 4, 80, -4, 0, LAB),
    post(-3.5, 79.5, 0.6, 0, 6, LG), post(3.5, 79.5, 0.6, 0, 6, LG), span(-3.5, 79.3, 3.5, 79.7, 5.6, 6, LG),
  ];
  return {
    name: 'The Architect',
    blurb: 'Its designer wants the Heart back',
    title: 'The Architect',
    say: 'This is him. He made the rift, the Warden, the Queen — all of it. Let’s end it together.',
    intro: 'At the top of the spire, in a round lab above the clouds, the Architect waits in a white shell of his own design. He wants the Rift Heart back in his reactor — and the city dark for good. He has planned for everything except three heroes who work as one.',
    brief: [
      ['PHASE 1', 'Brick holds the heavy plate, Pix the light one: its prism shield drops — zap it three times.', true],
      ['PHASE 2', 'Vera: light the three timed nodes on the pylons, then zap it three times.', true],
      ['PHASE 3', 'Brick pounds its armoured drones; zap after. Blasters let everyone shoot it when it is open.', true],
      ['MISSION', 'Expert: win without a single power-up.', true],
    ],
    mission: { kind: 'nopower', text: 'win without a single power-up' },
    lesson: 'no plan survives three heroes. The Architect counted on you being alone — together, every phase had an answer.',
    story: {
      intro: [['architect', 'Welcome to my lab. Return the Heart, and I will let you watch the city go dark from up here.'], ['vera', 'No deal.'], ['architect', 'Then I shall take you apart and see how you work.']],
      on: {
        'architect:start': [['architect', 'Begin the experiment.'], ['echo', 'The plates! Its shield draws power through them!']],
        'architect:1': [['architect', 'Interesting. Again.'], ['vera', 'The pylons — I’ll light them!']],
        'architect:2': [['architect', 'Drones! Restrain them!'], ['brick', 'Brick restrains. Brick pounds.']],
        architect: [['architect', 'Impossible… three variables… I did not…'], ['echo', 'It’s over. The light goes home.']],
      },
      outro: [['echo', 'The rift is closing. Every shard you carried is going home.'], ['pix', 'So… what do we do tomorrow?'], ['vera', 'Same as always. Look after the city — together.']],
    },
    def: {
      theme: 'lab',
      heroes: ['vera', 'pix', 'brick'],
      start: { p: [0, 0, 0], yaw: 0 },
      killY: -15,
      par: 210,
      blocks,
      items: [
        shard(0, 0 + SH, -4.5),                  // behind the start
        shard(0, 1.6, 15),                       // over the bridge
        shard(-10, 2.2 + SH, 40),                // on a pillar (Pix)
        shard(10, 2.2 + SH, 60),                 // on a pillar (Pix)
        shard(-16.5, 0 + SH, 68.5),              // arena corner
        shard(16.5, 0 + SH, 31.5),               // arena corner
        shard(-16.5, 0 + SH, 31.5),              // arena corner
        shard(16.5, 0 + SH, 68.5),               // arena corner
        shard(0, 1.4, 50),                       // the centre — after the fight
        shard(3, 0 + SH, 78.5),                  // behind the portal
        checkpoint(0, 0, 27, 'gate'),
        checkpoint(-14, 0, 34, 'arena'),
        { type: 'plate', id: 'ap1', p: [-12, 0, 50], heavy: true },
        { type: 'plate', id: 'ap2', p: [12, 0, 50] },
        { type: 'node', id: 'an1', p: [-15, 2.2, 50], time: 12 },
        { type: 'node', id: 'an2', p: [15, 2.2, 50], time: 12 },
        { type: 'node', id: 'an3', p: [0, 2.2, 66], time: 12 },
        { type: 'portal', p: [0, 0, 75], when: 'architect' },
        sign(3, 0, -3, 'THE ARCHITECT · do not disturb'),
      ],
      enemies: [
        { type: 'boss', kind: 'architect', id: 'architect', name: 'The Architect', p: [0, 5.2, 50], floor: 0, wake: 18, reach: 30, phases: [
          { need: 'plates', ids: ['ap1', 'ap2'], window: 7, hits: 3, attacks: ['volley', 'sweep'] },
          { need: 'nodes', ids: ['an1', 'an2', 'an3'], window: 6, hits: 3, attacks: ['volley', 'ring', 'sweep'], rate: 1.15 },
          { need: 'minions', minions: 3, window: 6, hits: 3, attacks: ['volley', 'ring', 'sweep', 'rain'], rate: 1.3 },
        ] },
      ],
      tips: [
        tip(0, 0, 27, 3, 'The Architect’s lab. Brick: the heavy plate on the left. Pix: the light plate on the right.'),
        tip(-14, 0, 46, 3, 'Node pylons: Vera zaps all three — they stay lit for 12 s.'),
      ],
      powers: [{ kind: 'blaster', p: [-16, 1, 36] }, { kind: 'shield', p: [16, 1, 36] }, { kind: 'blaster', p: [16, 1, 64] }, { kind: 'speed', p: [-16, 1, 64] }],
    },
    solve: [
      ['go', 'all', 'arena'],
      ['go', 'brick', 'ap1'], ['go', 'pix', 'ap2'],
      ['zap', 'an1'], ['zap', 'an2'], ['zap', 'an3'],
      ['set', 'architect', 60],
      ['expire', 'an1'], ['expire', 'an2'], ['expire', 'an3'],
      ['go', 'all', 'portal'],
    ],
  };
}

export const LEVELS = [
  rooftopRun(),
  foxInTheWires(),
  heavyLifting(),
  echoChamber(),
  updraft(),
  sentrySkies(),
  magmaWorks(),
  theWarden(),
  freefall(),
  sunkenFoundry(),
  theMaw(),
  heartOfTheRift(),
  prismLabs(),
  containment(),
  reactorSpire(),
  theArchitect(),
];

// ---------- Chapter 1 story beats and missions (merged into levels 1–8) ----------
const CH1 = [
  { chapter: 'Chapter 1 · The City Above',
    intro: 'Neon City runs on light, and the light is leaking away. Every night more of it gathers as glowing shards on the rooftops — and something pulls them toward a rift in the sky. Vera, a small maintenance robot with a big zapper, decides to bring the light home.',
    mission: { kind: 'nohit', text: 'reach the portal without a hit' },
    story: { intro: [['vera', 'Shards everywhere… pieces of the city’s light. Let’s bring them home.']], outro: [['vera', 'One tower down. I’m going to need friends for this.']] } },
  { intro: 'In the wire-tangled alleys, Vera finds Pix — a neon fox who has been collecting shards on her own. She is fast, she is small, and she is not about to share. Until she sees what they can do together.',
    mission: { kind: 'time', t: 95, text: 'clear it in under 1:35' },
    story: { intro: [['pix', 'Those are MY shards. …Okay, fine. OUR shards. You zap, I squeeze.']], outro: [['pix', 'We’re a team now, right? Teams share the shiny stuff.']] } },
  { intro: 'Under the crystal caves sits Brick, a golem who has guarded the same cracked floor for a hundred years. Nobody ever asked him to come along. Vera asks.',
    mission: { kind: 'nofall', text: 'nobody falls' },
    story: { intro: [['brick', 'Brick guards the floor. …Brick could guard you instead.'], ['vera', 'Welcome to the team, Brick.']], outro: [['brick', 'Brick likes teams.']] } },
  { intro: 'The Echo Chamber answers every move: a plate here opens a door there. Crawlers nest in its corners. A voice whispers through the crystals — too faint to understand. Yet.',
    mission: { kind: 'hunter', text: 'defeat every crawler' },
    story: { intro: [['pix', 'Did anyone else hear that? Like… a whisper?'], ['vera', 'Just the echo. Probably.']], outro: [['vera', 'There it is again. Something is calling from below.']] } },
  { intro: 'Above the clouds, the rift has torn the sky islands loose. They drift on updrafts; bridges crumble behind you. There is no floor down there. Not yet.',
    mission: { kind: 'nofall', text: 'nobody falls' },
    story: { intro: [['brick', 'Brick does not fly.'], ['pix', 'Brick does now! Bounce pads, big guy!']], outro: [['pix', 'Still not as fun as falling. Kidding. KIDDING.']] } },
  { intro: 'The rift’s guardians patrol the high islands: drones that see in cones and turrets that never miss twice. The quiet way through is the clever way.',
    mission: { kind: 'nohit', text: 'sneak through without a hit' },
    story: { intro: [['vera', 'Drones on patrol. Stay out of their cones.'], ['brick', 'Brick can be quiet. Brick is mostly quiet.']], outro: [['vera', 'Not a sound. Well — mostly.']] } },
  { intro: 'The Magma Works feed the rift with heat. Lasers blink on a beat, the raft only runs while someone stands on the plate, and the last gate waits for no one.',
    mission: { kind: 'time', t: 120, text: 'clear it in under 2:00' },
    story: { intro: [['pix', 'Hot hot hot hot—'], ['vera', 'Timers everywhere. Line up first, then go.']], outro: [['brick', 'Warm. Brick likes warm.']] } },
  { intro: 'At the heart of the Magma Works waits the Warden, a floating core in rotating shields, holding the rift shut. Everyone says it is the reason the light is disappearing. Everyone is wrong.',
    mission: { kind: 'nohit', text: 'beat the Warden without a hit' },
    story: {
      intro: [['vera', 'The Warden. It’s holding the rift shut — we end this here.']],
      on: { warden: [['pix', 'It’s going down! We did it!'], ['echo', '…free… at last… but she… is free… too…']] },
      outro: [['vera', 'Did that thing just… speak?'], ['brick', 'The floor is shaking. Brick does not like it.']] } },
];
CH1.forEach((x, i) => {
  const lv = LEVELS[i];
  if (!lv) return;
  if (x.chapter) lv.chapter = x.chapter;
  lv.intro = x.intro;
  lv.mission = x.mission;
  lv.story = x.story;
  const m = x.mission.text[0].toUpperCase() + x.mission.text.slice(1) + '.';
  // briefs stay at four lines at most: a full one carries the mission in the story paragraph instead
  if ((lv.brief || []).length < 4) lv.brief = [...(lv.brief || []), ['MISSION', m, false]];
  else lv.intro += ` Mission: ${m}`;
});

// =====================================================================================================
// THE UNDERSIDE UNDER EVERY CITY LEVEL, COINS AND POWER-UPS
// Chapter 1 levels without lava get a cavern far below: a hero who falls off lands there instead of losing a
// heart, and rift geysers ⇧ (gates with no `to`) throw them back to the last checkpoint. Coins sit on floors
// near the places a level already proves reachable (shards, checkpoints, plates, the portal); power-ups wait
// next to checkpoints and in the cavern. All of it is generated, deterministic and data-only.
// =====================================================================================================
const POWERS = ['shield', 'speed', 'magnet', 'blaster'];
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }
const top = (b) => b.p[1] + b.s[1] / 2;
const bot = (b) => b.p[1] - b.s[1] / 2;
function inside(blocks, x, y, z, pad = 0.35) {
  for (const b of blocks) {
    if (Math.abs(x - b.p[0]) < b.s[0] / 2 + pad && Math.abs(z - b.p[2]) < b.s[2] / 2 + pad && y > bot(b) - pad && y < top(b) + pad) return true;
  }
  return false;
}
// the floor block right under (x, y, z) within `drop` metres, or null
function floorUnder(blocks, x, y, z, drop = 0.7) {
  let best = null;
  for (const b of blocks) {
    if (Math.abs(x - b.p[0]) > b.s[0] / 2 - 0.25 || Math.abs(z - b.p[2]) > b.s[2] / 2 - 0.25) continue;
    const t = top(b);
    if (t <= y + 0.05 && t >= y - drop && (!best || t > top(best))) best = b;
  }
  return best;
}
function underside(def, seed) {
  const r = rng(seed * 7919 + 13);
  const blocks = def.blocks;
  const walk = blocks.filter((b) => top(b) > -4);
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity; let minB = 0;
  for (const b of walk) {
    x0 = Math.min(x0, b.p[0] - b.s[0] / 2); x1 = Math.max(x1, b.p[0] + b.s[0] / 2);
    z0 = Math.min(z0, b.p[2] - b.s[2] / 2); z1 = Math.max(z1, b.p[2] + b.s[2] / 2);
  }
  for (const b of blocks) minB = Math.min(minB, bot(b));
  const Y = q(Math.min(-30, minB - 12));
  x0 = Math.floor(x0 - 8); x1 = Math.ceil(x1 + 8); z0 = Math.floor(z0 - 8); z1 = Math.ceil(z1 + 8);
  const cx = (x0 + x1) / 2;
  const out = [
    span(x0, z0, x1, z1, Y - 4, Y, 'rock'),
    span(x0 - 0.6, z0, x0, z1, Y, Y + 10, 'rock'), span(x1, z0, x1 + 0.6, z1, Y, Y + 10, 'rock'),
    span(x0, z0 - 0.6, x1, z0, Y, Y + 10, 'rock'), span(x0, z1, x1, z1 + 0.6, Y, Y + 10, 'rock'),
  ];
  const items = []; const coins = []; const powers = []; const enemies = [];
  // rift geysers along the cavern, about every 18 m, each throwing a hero to the last checkpoint
  const n = Math.max(2, Math.round((z1 - z0) / 18));
  const geysers = [];
  for (let i = 0; i < n; i++) {
    const z = q(z0 + (z1 - z0) * (i + 0.5) / n);
    const x = q(cx + (i % 2 ? 1 : -1) * Math.min(4, (x1 - x0) / 5));
    geysers.push([x, z]);
    items.push(gate(x, Y, z, undefined, { color: '#5ef2c0' }));
    items.push(sign(x + 2.2, Y, z, 'RIFT GEYSER ⇧ · back up'));
  }
  const near = (x, z, d) => geysers.some(([gx, gz]) => Math.hypot(gx - x, gz - z) < d);
  // crystals, rock pillars and glowing roots
  for (let i = 0; i < Math.round((x1 - x0) * (z1 - z0) / 160); i++) {
    const x = q(x0 + 2 + r() * (x1 - x0 - 4)); const z = q(z0 + 2 + r() * (z1 - z0 - 4));
    if (near(x, z, 4)) continue;
    const k = r();
    if (k < 0.45) out.push(post(x, z, q(0.8 + r() * 1.2), Y, q(Y + 0.6 + r() * 2.2), 'crystal'));
    else if (k < 0.7) out.push(post(x, z, q(1.2 + r() * 1.4), Y, q(Y + 1 + r() * 2.6), 'rock'));
    else out.push(span(x - 0.15, z - 4, x + 0.15, z + 4, Y, Y + 0.05, 'glow:#14b8a6'));
  }
  // coin rings around the geysers and a coin trail down the middle
  geysers.forEach(([gx, gz], i) => {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + i;
      const x = q(gx + Math.cos(a) * 3.2); const z = q(gz + Math.sin(a) * 3.2);
      if (!inside(out, x, Y + 0.9, z)) coins.push([x, q(Y + 0.9), z]);
    }
    const kind = POWERS[(seed + i) % POWERS.length];
    if ((i === 0 || i === Math.floor(n / 2)) && !inside(out, gx, Y + 1, q(gz + 5.5))) powers.push({ kind, p: [gx, q(Y + 1), q(gz + 5.5)] });
  });
  // a couple of crawlers live down here
  for (let i = 0; i < Math.min(3, n); i++) {
    const [gx, gz] = geysers[i];
    enemies.push({ type: 'crawler', p: [q(gx + (i % 2 ? -6 : 6)), Y, q(gz + 3)], range: 6 });
  }
  // generated parts carry `gen` (the level validator leaves the cavern out of its model)
  for (const o of [...out, ...items, ...enemies]) o.gen = 1;
  def.blocks = [...blocks, ...out];
  def.items = [...(def.items || []), ...items];
  def.enemies = [...(def.enemies || []), ...enemies.filter((e) => !inside(out, e.p[0], e.p[1] + 0.5, e.p[2], 0.6))];
  def.under = Math.max(-12, q(minB + 6) > -4 ? -8 : q(Math.min(-8, minB + 10)));
  def.killY = Y - 25;
  def.pocket = { y: Y, x0, x1, z0, z1 };
  return { coins, powers };
}
// Coins: rows on floors near points the level already proves reachable.
function placeCoins(def, seed, max = 48) {
  const r = rng(seed * 104729 + 7);
  const blocks = def.blocks;
  const anchors = (def.items || []).filter((it) => ['shard', 'checkpoint', 'plate', 'switch', 'portal', 'node', 'bounce'].includes(it.type)).map((it) => it.p);
  if (def.start && def.start.p) anchors.push(def.start.p);
  const cands = [];
  for (const b of blocks) {
    if (String(b.m || '').startsWith('glow') || b.s[0] < 1.2 || b.s[2] < 1.2) continue;
    if (def.pocket && top(b) < def.pocket.y + 0.5) continue;      // the cavern has its own coins
    const t = top(b);
    const ok = anchors.some((a) => Math.abs(a[1] - t) < 2.4 && Math.hypot(a[0] - b.p[0], a[2] - b.p[2]) < 14 + Math.max(b.s[0], b.s[2]) / 2);
    if (ok) cands.push(b);
  }
  // shuffle, then lay a short row along each block's long side
  for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
  const coins = [];
  const taken = (x, y, z) => coins.some((c) => Math.hypot(c[0] - x, c[2] - z) < 1.1 && Math.abs(c[1] - y) < 1);
  for (const b of cands) {
    if (coins.length >= max) break;
    const along = b.s[0] >= b.s[2] ? 0 : 2;
    const len = b.s[along];
    const k = Math.max(1, Math.min(5, Math.floor(len / 2.2)));
    const t = top(b);
    const row = [];
    for (let i = 0; i < k; i++) {
      const u = (i - (k - 1) / 2) * 1.6;
      const x = q(b.p[0] + (along === 0 ? u : 0)); const z = q(b.p[2] + (along === 2 ? u : 0)); const y = q(t + 0.9);
      if (inside(blocks, x, y, z, 0.3) || inside(blocks, x, t + 0.3, z, 0.25) || taken(x, y, z)) continue;
      row.push([x, y, z]);
    }
    coins.push(...row.slice(0, max - coins.length));
  }
  return coins;
}
// Power-ups next to checkpoints (on solid floor, not in a wall).
function placePowers(def, seed) {
  const out = [];
  const cps = (def.items || []).filter((it) => it.type === 'checkpoint' && (!def.pocket || it.p[1] > def.pocket.y + 1));
  cps.forEach((c, i) => {
    for (const [ox, oz] of [[1.8, 1.2], [-1.8, 1.2], [1.8, -1.2], [-1.8, -1.2], [0, 2.2], [0, -2.2]]) {
      const x = q(c.p[0] + ox); const z = q(c.p[2] + oz); const y = q(c.p[1] + 1);
      if (inside(def.blocks, x, y, z, 0.3) || !floorUnder(def.blocks, x, c.p[1] + 0.02, z)) continue;
      out.push({ kind: POWERS[(seed + i + 1) % POWERS.length], p: [x, y, z] });
      break;
    }
  });
  return out;
}
LEVELS.forEach((lv, i) => {
  const d = lv.def;
  if (!d || !Array.isArray(d.blocks)) return;
  let extra = { coins: [], powers: [] };
  const lava = (d.surfaces || []).some((s) => s.type === 'lava');
  if ((i < 8 || d.underside) && !lava && !Number.isFinite(d.under)) extra = underside(d, i + 1);
  if (!d.coins) d.coins = [...placeCoins(d, i + 1), ...extra.coins];
  if (!d.powers) d.powers = [...placePowers(d, i), ...extra.powers];
  else d.powers = [...d.powers, ...extra.powers];
  // a coin mission asks for a share of what the level holds
  if (lv.mission && lv.mission.kind === 'coins') {
    const n = Math.max(5, Math.round(d.coins.length * (lv.mission.share || 0.6)));
    lv.mission.n = n;
    lv.mission.text = lv.mission.text.replace('{n}', n);
    for (const b of lv.brief || []) b[1] = b[1].replace('{n}', n);
  }
});
