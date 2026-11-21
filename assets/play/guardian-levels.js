// VERAQIS Play — Vera: Archive Guardian, level data.
// Map legend:
//   #  wall            .  floor           P  Vera's start     V  vault (exit, opens when all provable data is in)
//   H  "../" hole      g  verified data   ?  unproven data (scan it: green or red)   r  corrupted data
//   1–9 solid-chain data (take in order; a break loses everything after it)
//   S  Slipper   R  Rot   B  Bomblet   L  Linker   X  Overlap Hydra (boss)

export const LEVELS = [
  {
    name: 'ZIP Valley', blurb: 'Move, collect, scan, exit', par: 45, pGreen: 0.67,
    map: [
      '###############',
      '#P..g...g....V#',
      '#.###.#.#.###.#',
      '#.g...#?#...g.#',
      '#.#.###.###.#.#',
      '#...g..?..g...#',
      '#.#.###.###.#.#',
      '#.g...#?#...g.#',
      '#.###.#.#.###.#',
      '#....g...g....#',
      '###############',
    ],
    say: 'Hi, I’m Vera. Green diamonds are data a checksum has proven — take them all and the vault opens.',
    brief: [['move', 'Arrows or WASD move Vera. On a phone the game goes full screen: drag the thumb stick to move, slide it to turn.', true],
      ['green', 'Green diamonds are verified data. Collect them all to open the vault, then walk in.', true],
      ['scan', 'Grey “?” data is unproven. Press E (or SCAN) next to it: it turns green or red. Never take red.', true]],
    lesson: 'Verified data is data an independent check has confirmed. Grey data is a claim until it is scanned — and red data is never emitted.',
    learn: { href: '/reference/evidence-model/', text: 'The evidence model' },
  },
  {
    name: 'Slip Street', blurb: 'Slippers run for the ../ holes', par: 70, pGreen: 0.6, slipperWaves: { every: 14, max: 5 },
    map: [
      '#######H#######',
      '#P..g.....g...#',
      '#.##.##.##.##.#',
      '#g...S.?...S.g#',
      '#.##.##.##.##.#',
      'H...g..V..g...H',
      '#.##.##.##.##.#',
      '#g...?...?...g#',
      '#.##.##.##.##.#',
      '#...g.....g...#',
      '#######H#######',
    ],
    say: 'Slippers! Each one is a file trying to climb out of our folder through a “../” hole. Zap them first.',
    brief: [['zap', 'Space (or ZAP) fires a beam at the nearest creature in a straight line; walls stop it. Hold it to keep firing.', true],
      ['slipper', 'Slippers run for the red “../” holes. At a hole one starts squeezing through — zap it before its ring fills, or it escapes and costs a shield.', true],
      ['touch', 'Touching any creature costs a shield too.']],
    lesson: 'A Slipper is Zip Slip: an entry whose path resolves outside the destination. It has to be stopped before it is written, not after.',
    learn: { href: '/play/gatekeeper/', text: 'Train the rule in Gatekeeper' },
  },
  {
    name: 'Rot Cellar', blurb: 'Beetles that turn data red', par: 75, pGreen: 0.6,
    map: [
      '###############',
      '#P.g.g.g.g.g..#',
      '#.###.###.###.#',
      '#g#R..g.g..R#g#',
      '#.#.#######.#.#',
      '#g..g..?..g..g#',
      '#.#.#######.#.#',
      '#g#...g.g...#g#',
      '#.###.###.###.#',
      '#..g.g.?.g.g.V#',
      '###############',
    ],
    say: 'Rot beetles chew on verified data and leave it corrupted. Get to the green before they do.',
    brief: [['rot', 'Rot beetles crawl to green data and chew on it. Zap one before its ring fills and the block is saved; otherwise it turns red and is lost.', true],
      ['race', 'The vault opens once every block that can still be proven is in. Fewer reds, higher score.']],
    lesson: 'Bit rot does not announce itself: a block that was fine yesterday fails its checksum today. Recover what still verifies — never “fix” a red block by guessing.',
    learn: { href: '/play/bit-rot/', text: 'Hunt it in Bit Rot Hunt' },
  },
  {
    name: 'Bomb Field', blurb: 'Defuse bombs before they expand', par: 70, pGreen: 0.6, bombStagger: 3.5,
    map: [
      '###############',
      '#P...g...g...V#',
      '#.#.#.#.#.#.#.#',
      '#..B.g..B..g..#',
      '#.#.#.#.#.#.#.#',
      '#g..?..B..?..g#',
      '#.#.#.#.#.#.#.#',
      '#..g..B..g..B.#',
      '#.#.#.#.#.#.#.#',
      '#g...g...g...g#',
      '###############',
    ],
    say: 'Bomblets start at ×10 and grow. Zap them while they are small — at ×∞ they flood everything around them.',
    brief: [['bomb', 'Bomblets grow ×10 → ×100 → ×1,000 → ×∞, then burst: nearby data turns red and the floor is blocked for a while.', true],
      ['defuse', 'A zap at any size defuses one. Early is safest — a burst next to Vera costs a shield.']],
    lesson: 'A compression bomb is stopped by a gate that watches the expansion ratio as it happens. Waiting until the disk is full is too late.',
    learn: { href: '/security.html', text: 'Bomb and overlap defences' },
  },
  {
    name: 'Symlink Maze', blurb: 'Portals that send you elsewhere', par: 85, pGreen: 0.6, linkerEvery: 7, slipperWaves: { every: 16, max: 3 },
    map: [
      '###############',
      '#P..#..g..#..g#',
      '#.#.#.###.#.#.#',
      '#.#g..L.?..g#.#',
      '#.####.#.####.#',
      '#g...?.#.?...g#',
      '#.####.#.####.#',
      '#.#g..S.L..g#.#',
      '#.#.#.###.#.#.#',
      '#g..#..g..#..V#',
      '#######H#######',
    ],
    say: 'Linkers open portals. Step in and you land wherever they decided — that is exactly what a symlink does.',
    brief: [['linker', 'Linkers open pairs of yellow portals. Walking into one sends Vera to the other end.', true],
      ['close', 'Zapping a Linker closes every portal it opened. Slippers are back, too.']],
    lesson: 'A symlink inside an archive redirects where later entries land. Refusing links outright is simpler — and safer — than judging every target.',
    learn: { href: '/security.html', text: 'Why symlinks are refused' },
  },
  {
    name: 'Solid Mine', blurb: 'A chain: one break loses the rest', par: 90, pGreen: 0.6,
    map: [
      '###############',
      '#P..1.....2...#',
      '#.###.###.###.#',
      '#.#..R..3..#..#',
      '#.#.#####.#.#.#',
      '#4..#.g.#..5..#',
      '#.#.#.#.#.#.#.#',
      '#.#..6..#R.7..#',
      '#.###.###.###.#',
      '#9.....8.....V#',
      '###############',
    ],
    say: 'This archive is solid: the blocks only decode in order. If rot breaks one link, everything after it is gone.',
    brief: [['chain', 'Numbered blocks must be taken in order, 1 → 9. A block opens only after the one before it.', true],
      ['solid', 'If a Rot beetle breaks a link, that block and every later one turn red. Only the prefix can be recovered.', true]],
    lesson: 'In a solid archive later data depends on earlier data. Damage in the middle costs everything after it — which is why the prefix is all that can be proven.',
    learn: { href: '/formats/7z/', text: 'What solid compression costs you' },
  },
  {
    name: 'Rush Hour', blurb: 'Every threat at once', par: 110, pGreen: 0.6, slipperWaves: { every: 15, max: 4 }, bombStagger: 5, linkerEvery: 8,
    map: [
      '#######H#######',
      '#P.g..B..g..?.#',
      '#.##.###.###..#',
      '#g#S..g.?.R.#g#',
      '#.#.##.#.##.#.#',
      'H.?.g..V..g.?.H',
      '#.#.##.#.##.#.#',
      '#g#L..g.?.S.#g#',
      '#..###.#.###..#',
      '#.?..g..B..g..#',
      '#######H#######',
    ],
    say: 'Slippers, beetles, bombs and links, all in one archive. Prioritise: what costs the most if you ignore it?',
    brief: [['mix', 'Every creature so far, in one map. Scan before you take, zap what threatens the folder first.']],
    lesson: 'A real hostile archive mixes all of it. One gate that checks every entry for every rule is what keeps the folder clean.',
    learn: { href: '/security.html', text: 'The full safety model' },
  },
  {
    name: 'The Overlap Hydra', blurb: 'Boss: many heads, one set of bytes', par: 120, pGreen: 0.6, boss: { hp: 12 },
    map: [
      '###############',
      '#P.g.......g..#',
      '#.#####.#####.#',
      '#g.....g.....g#',
      '#.#.##...##.#.#',
      '#...#..X..#...#',
      '#.#.##...##.#.#',
      '#g.....g.....g#',
      '#.#####.#####.#',
      '#..g.......g.V#',
      '###############',
    ],
    say: 'The Overlap Hydra: every head reads the same bytes again and again. Twelve hits. Keep moving.',
    brief: [['boss', 'The Hydra chases Vera and keeps spawning Bomblets — and Rot beetles once it is hurt. It takes 12 zaps.', true],
      ['bolts', 'When it lines up with Vera its heads glow and it fires an overlap bolt down the line. Zap, then step aside.', true],
      ['vault', 'The vault opens when the Hydra is down and the data is in.']],
    lesson: 'Overlapping entries make one stretch of compressed bytes decode as many files — the trick behind non-recursive zip bombs. Refusing overlaps cuts every head at once.',
    learn: { href: '/play/gatekeeper/', text: 'Refuse overlaps in Gatekeeper' },
  },
];

export const ENDLESS = {
  name: 'Endless archive', tag: 'ENDLESS', blurb: 'Random archives, rising danger', endless: true, pGreen: 0.6, par: 999, linkerEvery: 8,
  say: 'Endless archives, each one faster and nastier than the last. How far can we get?',
  brief: [['endless', 'A new random archive each time you reach the vault. Creatures multiply and speed up as you go; every second archive cleared gives a shield back.']],
  lesson: 'Endless runs are random. The best score is kept in this browser only.',
};

// A pillar grid is always fully connected, so random archives never trap Vera.
export function randomMap(rng, wave) {
  const W = 15; const H = 11;
  const g = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0)) ? '#' : '.'));
  const floor = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (g[y][x] === '.') floor.push([x, y]);
  const take = () => { const i = rng.int(0, floor.length - 1); return floor.splice(i, 1)[0]; };
  g[1][1] = 'P'; floor.splice(floor.findIndex(([x, y]) => x === 1 && y === 1), 1);
  g[H - 2][W - 2] = 'V'; floor.splice(floor.findIndex(([x, y]) => x === W - 2 && y === H - 2), 1);
  const far = (p) => Math.abs(p[0] - 1) + Math.abs(p[1] - 1) > 5;
  const put = (ch, n, needFar = false) => {
    for (let i = 0; i < n && floor.length; i++) {
      let p = take(); let guard = 0;
      while (needFar && !far(p) && guard++ < 20) { floor.push(p); p = take(); }
      g[p[1]][p[0]] = ch;
    }
  };
  put('g', 9 + Math.min(6, wave));
  put('?', 3 + Math.min(4, Math.floor(wave / 2)));
  put('S', Math.min(3, Math.floor(wave / 2)), true);
  put('R', Math.min(3, Math.floor((wave + 1) / 3)), true);
  put('B', Math.min(4, Math.floor(wave / 2)), true);
  put('L', wave >= 3 ? 1 : 0, true);
  const holes = [[7, 0], [0, 5], [W - 1, 5], [7, H - 1]];
  holes.slice(0, Math.min(4, 1 + Math.floor(wave / 2))).forEach(([x, y]) => { g[y][x] = 'H'; });
  return g.map((row) => row.join(''));
}
