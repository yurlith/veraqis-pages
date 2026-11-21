// VERAQIS Play — Bit Rot Hunt.
// A file is split into shards with known-good hashes. Check runs of shards against the manifest:
// a match proves them intact, a mismatch means damage is inside. Find the rotten shards with as
// few checks as possible — and abstain when the evidence cannot localise them.
// The evidence rules follow https://veraqis.tech/reference/evidence-model/ ; the files are simulated.
import { Game, h, hud, loop, toast, pop, shake, makeRng, fmtInt, reducedMotion } from './core.js';

function log2C(n, k) { let s = 0; for (let i = 0; i < k; i++) s += Math.log2((n - i) / (i + 1)); return s; }
function parFor(n, k) { return Math.ceil(log2C(n, k) - 1e-9) + (k > 1 ? 1 : 0); }

const LEVELS = [
  { name: 'One bad shard', blurb: '8 shards, one rotten', say: 'One of these eight shards has rotted. Check runs of shards against the manifest to corner it.', n: 8, k: 1, mode: 'range', budget: 5,
    brief: [['hash', 'The file is split into shards, and a manifest from when it was healthy holds a hash for any run of them. Select a run and Check it.', true],
      ['match', 'A match proves every shard in the run intact — they turn green. A mismatch means the damage is somewhere inside.', true],
      ['goal', 'Find the rotten shard in as few checks as possible. Par is the fewest a perfect search needs.'],
      ['select', 'Tap a first and a last shard (or drag with a mouse), then press Check. Tapping one shard twice selects just that one.']],
    lesson: 'Halving the suspect run each time finds one bad shard among 8 in exactly 3 checks. That is why per-block checksums matter: they let damage be localised instead of just detected.',
    learn: { href: '/reference/evidence-model/', text: 'The VERAQIS evidence model' } },
  { name: 'Halve it', blurb: '16 shards, one rotten', say: 'Sixteen shards, one rotten. Check half, then half of that.', n: 16, k: 1, mode: 'range', budget: 6,
    brief: [['par 4', 'Sixteen shards, one rotten. A halving search needs four checks.'],
      ['logic', 'With exactly one rotten shard, a mismatch on one half also proves the other half clean — the game fills that in for you.']],
    lesson: 'log₂(16) = 4. Every extra check beyond par is evidence you did not need.',
    learn: { href: '/reference/evidence-model/', text: 'Evidence before recovery' } },
  { name: 'Thirty-two', blurb: '32 shards, one rotten', say: 'Twice the shards, only one more check — as long as you keep halving.', n: 32, k: 1, mode: 'range', budget: 7,
    brief: [['par 5', 'Thirty-two shards. Five checks if you halve every time.']],
    lesson: 'Doubling the file adds one check. Localisation stays cheap even for big files — as long as the format kept independent checksums.',
    learn: { href: '/formats/xz-bzip2/', text: 'Per-block checksums in xz and bzip2' } },
  { name: 'Hash tree', blurb: 'Only tree nodes have hashes', say: 'Only the tree bars carry hashes here. Start at the top and follow the mismatch down.', n: 16, k: 1, mode: 'tree', budget: 6,
    brief: [['tree', 'This manifest is a hash tree: there are hashes only for the bars above the shards — halves, quarters, eighths — and for single shards.', true],
      ['pick', 'Click a bar to select its run, then Check. Walk down from the root toward the damage.']],
    lesson: 'A hash tree stores just enough hashes for a halving search: descend from the root, follow the mismatch, done in log₂(n) steps.',
    learn: { href: '/reference/evidence-model/', text: 'How evidence is recorded' } },
  { name: 'Two at once', blurb: '16 shards, two rotten', say: 'Two rotten shards. A mismatch only means “at least one” — split so each search has one culprit.', n: 16, k: 2, mode: 'range', budget: 11,
    brief: [['two', 'Two shards are rotten now. A mismatch only says “at least one” — plan your halves so each search has a single culprit.', true],
      ['tip', 'If both halves mismatch, each half holds exactly one. If one half matches, both are in the other.']],
    lesson: 'With more than one fault, a mismatch is weaker evidence. Splitting so every suspect run holds exactly one fault turns the problem back into simple halving.',
    learn: { href: '/reference/evidence-model/', text: 'What a check does and does not prove' } },
  { name: 'One checksum', blurb: 'gzip: detect, but not where', say: 'One CRC for the whole gzip stream. It can say “damaged” — never where.', n: 16, k: 'gzip', mode: 'whole', budget: 1,
    brief: [['gzip', 'This file is a single gzip member: there is one CRC-32 for the whole stream, and nothing per shard.', true],
      ['decide', 'Check it. If it matches, the file is intact. If it does not, decide what an honest tool does next.', true]],
    lesson: 'gzip detects corruption but never says where. When the evidence cannot localise the damage, abstaining — reporting it, emitting nothing unproven — is the correct result, not a failure.',
    learn: { href: '/formats/gzip-tar/', text: 'gzip and tar: opposite blind spots' } },
  { name: 'Repair budget', blurb: '1–3 rotten, parity fixes 2', say: 'Parity can rebuild two shards, no more. Prove how many are rotten before you decide.', n: 24, k: 'unknown', maxK: 3, parity: 2, mode: 'range', budget: 18, par: 12,
    brief: [['unknown', 'Between one and three shards are rotten — you are not told how many. Prove the state of every shard.', true],
      ['parity', 'A parity sidecar can rebuild at most two shards. When you are done, decide: rebuild, or abstain.', true]],
    lesson: 'A repair is only honest inside its budget. Past it, the right output is a report of exactly what is damaged — not a reconstruction that cannot be verified.',
    learn: { href: '/docs.html', text: 'Shield parity sidecars in the docs' } },
  { name: 'Big disk', blurb: '48 shards, two rotten', say: 'Forty-eight shards, two rotten, par twelve. This is the big one.', n: 48, k: 2, mode: 'range', budget: 17,
    brief: [['final', 'Forty-eight shards, two rotten, par 12. Clear it to unlock the endless marathon.']],
    lesson: 'Two faults in 48 shards, found with a dozen checks: localisation is what makes a proof-first repair practical on real files.',
    learn: { href: '/reports.html', text: 'Reports and verification' } },
];
const ENDLESS = { name: 'Marathon', tag: 'ENDLESS', blurb: 'Random disks until one beats you', say: 'Disk after disk until one beats us. Ready?', mode: 'range', marathon: true,
  brief: [['marathon', 'Random disks, one after another. Every disk solved adds to the score; run out of checks once and the marathon ends.']],
  lesson: 'Marathon disks are random. The best score is kept in this browser only.' };

function play(api) {
  const { fx, sfx } = api;
  const r = makeRng(api.seed);
  const motion = !reducedMotion();
  const marathon = !!api.level.marathon;
  const total = { score: 0, disks: 0, checks: 0 };
  let lv = null;
  let st = null;
  let busy = false;
  let pending = null;   // first tap of a two-tap selection
  let sel = null;       // [a, b]
  let drag = null;
  let suppressClick = false;
  let timers = [];
  const later = (fn, ms) => { const id = window.setTimeout(fn, ms); timers.push(id); return id; };

  const bar = hud(api.area, [
    ['disk', marathon ? 'Disk' : 'Shards', '—'],
    ['used', 'Checks', '0'],
    ['par', 'Par', '—'],
    ['score', 'Score', '0'],
  ], () => api.quit());
  const tree = h('div', { class: 'br-tree' });
  const grid = h('div', { class: 'br-grid', role: 'group', 'aria-label': 'Shards' });
  const selInfo = h('p', { class: 'br-sel' });
  const checkBtn = h('button', { class: 'g-btn g-btn--primary g-btn--big', type: 'button', onclick: () => check() }, '⌁ Check ', h('span', { class: 'g-key' }, 'C'));
  const clearBtn = h('button', { class: 'g-btn', type: 'button', onclick: () => { pending = null; sel = null; paintSel(); } }, 'Clear');
  const abstainBtn = h('button', { class: 'g-btn g-btn--ghost', type: 'button', onclick: () => abstain() }, '⊘ Abstain');
  const decideBox = h('div', { class: 'br-decide', hidden: true });
  const budgetEl = h('div', { class: 'br-budget', 'aria-hidden': 'true' });
  const budgetTxt = h('p', { class: 'g-dim' });
  const log = h('ol', { class: 'br-log', 'aria-label': 'Checks so far' });
  api.area.append(h('div', { class: 'br-wrap' },
    h('div', { class: 'br-main' }, tree, grid, selInfo, h('div', { class: 'g-actions' }, checkBtn, clearBtn, abstainBtn), decideBox),
    h('div', { class: 'br-side' },
      h('div', null, h('p', { class: 'hud-k' }, 'Check budget'), budgetEl, budgetTxt),
      h('div', null, h('p', { class: 'hud-k' }, 'Log'), log),
      h('div', { class: 'br-legend' }, h('span', null, h('i'), 'unknown'), h('span', null, h('i', { class: 'ok' }), 'proven intact'),
        h('span', null, h('i', { class: 'bad' }), 'proven rotten'), h('span', null, h('i', { class: 'suspect' }), 'damage inside')))));

  // ---------- puzzle setup ----------
  function newPuzzle(def) {
    lv = def;
    const n = def.n;
    let rotten = new Set();
    let kTrue = 0;
    if (def.k === 'gzip') kTrue = r.chance(0.35) ? 0 : r.int(1, 2);
    else if (def.k === 'unknown') kTrue = r.int(1, def.maxK);
    else kTrue = def.k;
    while (rotten.size < kTrue) rotten.add(r.int(0, n - 1));
    const known = typeof def.k === 'number';
    const par = def.par || (known ? parFor(n, def.k) : def.mode === 'whole' ? 1 : 12);
    st = { n, rotten, known, k: known ? def.k : null, kTrue, par, budget: def.budget, used: 0,
      state: new Array(n).fill('u'), mism: [], done: false, probedWhole: null, decided: false };
    pending = null; sel = null; busy = false;
    log.textContent = '';
    decideBox.hidden = true; decideBox.textContent = '';
    buildGrid();
    buildTree();
    paintBudget();
    bar.set('disk', marathon ? `${total.disks + 1} · ${n} shards` : `${n}`);
    bar.set('used', '0');
    bar.set('par', String(par));
    checkBtn.disabled = false;
    clearBtn.hidden = def.mode === 'whole';
    checkBtn.firstChild.data = def.mode === 'whole' ? '⌁ Check whole stream (CRC-32) ' : '⌁ Check ';
    paintSel();
    api.say(`${n} shards. ${known ? `${def.k} rotten.` : def.mode === 'whole' ? 'One checksum for the whole stream.' : 'Unknown number rotten.'} Budget ${st.budget} checks, par ${par}.`);
  }

  function buildGrid() {
    grid.textContent = '';
    const cols = st.n <= 16 ? 8 : st.n <= 32 ? 8 : 12;
    grid.style.setProperty('--cols', String(cols));
    for (let i = 0; i < st.n; i++) {
      const b = h('button', { class: 'br-tile' + (lv.mode === 'whole' ? ' locked' : ''), type: 'button', 'data-i': String(i), 'aria-label': `Shard ${i + 1}` }, String(i + 1));
      b.addEventListener('click', () => tap(i));
      b.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && lv.mode === 'range' && !busy) { drag = { a: i, moved: false }; } });
      b.addEventListener('pointerenter', () => { if (drag && i !== drag.a) { drag.moved = true; sel = [Math.min(drag.a, i), Math.max(drag.a, i)]; pending = null; paintSel(); } });
      grid.append(b);
    }
  }
  function buildTree() {
    tree.textContent = '';
    tree.hidden = lv.mode !== 'tree';
    if (lv.mode !== 'tree') return;
    for (let size = st.n; size >= 2; size /= 2) {
      const row = h('div', { class: 'br-tree-row' });
      for (let a = 0; a < st.n; a += size) {
        const node = h('button', { class: 'br-node', type: 'button', 'data-a': String(a), 'data-b': String(a + size - 1), 'aria-label': `Hash node for shards ${a + 1} to ${a + size}` }, size >= 8 ? `${a + 1}–${a + size}` : '');
        node.addEventListener('click', () => { if (busy || st.done) return; sfx.click(); sel = [a, a + size - 1]; pending = null; paintSel(); });
        row.append(node);
      }
      tree.append(row);
    }
  }
  document.addEventListener('pointerup', onUp);
  function onUp() {
    if (!drag) return;
    if (drag.moved) suppressClick = true;
    drag = null;
  }

  function tap(i) {
    if (suppressClick) { suppressClick = false; return; }
    if (busy || st.done || lv.mode === 'whole') return;
    sfx.click();
    if (lv.mode === 'tree') { sel = [i, i]; pending = null; paintSel(); return; }
    if (pending == null) { pending = i; sel = [i, i]; }
    else { sel = [Math.min(pending, i), Math.max(pending, i)]; pending = null; }
    paintSel();
  }

  function paintSel() {
    const tiles = grid.children;
    for (let i = 0; i < st.n; i++) {
      const t = tiles[i];
      t.classList.toggle('sel', !!sel && i >= sel[0] && i <= sel[1] && st.state[i] === 'u');
      t.classList.toggle('start', pending === i);
    }
    tree.querySelectorAll('.br-node').forEach((node) => {
      const a = Number(node.dataset.a); const b = Number(node.dataset.b);
      node.classList.toggle('sel', !!sel && sel[0] === a && sel[1] === b);
      const states = st.state.slice(a, b + 1);
      node.classList.toggle('ok', states.every((s) => s === 'ok'));
      node.classList.toggle('bad', states.some((s) => s === 'bad'));
    });
    if (lv.mode === 'whole') selInfo.textContent = 'One CRC-32 covers the whole stream — no per-shard evidence.';
    else if (!sel) selInfo.textContent = lv.mode === 'tree' ? 'Pick a bar of the hash tree (or a single shard).' : 'Tap the first shard of a run.';
    else if (pending != null) { selInfo.textContent = ''; selInfo.append(`Start: shard ${pending + 1} — now tap the last shard (or the same one again).`); }
    else { selInfo.textContent = ''; selInfo.append('Selected: ', h('b', null, sel[0] === sel[1] ? `shard ${sel[0] + 1}` : `shards ${sel[0] + 1}–${sel[1] + 1}`), ` (${sel[1] - sel[0] + 1})`); }
    checkBtn.disabled = st.done || busy || (lv.mode !== 'whole' && !(sel && pending == null));
  }
  function paintBudget() {
    budgetEl.textContent = '';
    for (let i = 0; i < st.budget; i++) budgetEl.append(h('i', { class: (i < st.used ? 'used' : '') + (i === st.par - 1 ? ' par' : '') }));
    budgetTxt.textContent = `${st.budget - st.used} left · par ${st.par} (outlined)`;
  }
  function paintTiles() {
    const tiles = grid.children;
    const suspect = new Set();
    for (const [a, b] of st.mism) {
      let hasBad = false;
      for (let i = a; i <= b; i++) if (st.state[i] === 'bad') hasBad = true;
      if (!hasBad) for (let i = a; i <= b; i++) if (st.state[i] === 'u') suspect.add(i);
    }
    for (let i = 0; i < st.n; i++) {
      const t = tiles[i];
      const was = t.classList.contains('bad');
      t.classList.toggle('ok', st.state[i] === 'ok');
      t.classList.toggle('bad', st.state[i] === 'bad');
      t.classList.toggle('suspect', suspect.has(i));
      t.classList.toggle('locked', st.state[i] !== 'u' || lv.mode === 'whole');
      if (st.state[i] === 'bad' && !was) {
        fx.burst(t, '255,95,109', 36, 300); fx.ring(t, '255,95,109', 120);
        pop(api.stage, t, 'FOUND', 'bad');
        sfx.boom();
      }
      t.setAttribute('aria-label', `Shard ${i + 1}: ${st.state[i] === 'ok' ? 'intact' : st.state[i] === 'bad' ? 'rotten' : suspect.has(i) ? 'suspect' : 'unknown'}`);
    }
  }

  // ---------- deduction ----------
  function deduce() {
    let changed = true;
    while (changed) {
      changed = false;
      const S = st.state;
      // a mismatched run with a single unknown shard and no proven-bad shard pins that shard
      for (const [a, b] of st.mism) {
        let unk = -1; let cnt = 0; let bad = false;
        for (let i = a; i <= b; i++) { if (S[i] === 'bad') bad = true; else if (S[i] === 'u') { cnt++; unk = i; } }
        if (!bad && cnt === 1) { S[unk] = 'bad'; changed = true; }
      }
      if (st.known) {
        const nb = S.filter((s) => s === 'bad').length;
        const nu = S.filter((s) => s === 'u').length;
        if (nb === st.k && nu) { for (let i = 0; i < st.n; i++) if (S[i] === 'u') S[i] = 'ok'; changed = true; continue; }
        if (nb + nu === st.k && nu) { for (let i = 0; i < st.n; i++) if (S[i] === 'u') S[i] = 'bad'; changed = true; continue; }
        // disjoint unresolved mismatches that account for every remaining fault clear everything outside them
        const open = st.mism.filter(([a, b]) => { for (let i = a; i <= b; i++) if (S[i] === 'bad') return false; return true; })
          .slice().sort((x, y) => x[1] - y[1]);
        const chosen = []; let lastEnd = -1;
        for (const iv of open) if (iv[0] > lastEnd) { chosen.push(iv); lastEnd = iv[1]; }
        if (chosen.length && nb + chosen.length === st.k) {
          const inside = new Set();
          for (const [a, b] of chosen) for (let i = a; i <= b; i++) inside.add(i);
          for (let i = 0; i < st.n; i++) if (S[i] === 'u' && !inside.has(i)) { S[i] = 'ok'; changed = true; }
        }
      }
    }
  }

  // ---------- actions ----------
  function check() {
    if (busy || st.done) return;
    if (lv.mode === 'whole') return checkWhole();
    if (!sel || pending != null) return;
    if (st.used >= st.budget) return;
    const [a, b] = sel;
    let allKnown = true;
    for (let i = a; i <= b; i++) if (st.state[i] === 'u') allKnown = false;
    if (allKnown) { toast(api.toasts, 'Every shard in that run is already proven — a check would add nothing.', 'info', 2200); return; }
    busy = true;
    st.used++; total.checks++;
    bar.set('used', String(st.used), st.used > st.par ? 'warn bump' : 'bump');
    paintBudget();
    checkBtn.disabled = true;
    let bad = false;
    for (let i = a; i <= b; i++) if (st.rotten.has(i)) bad = true;
    const tiles = grid.children;
    const step = motion ? Math.min(28, 260 / (b - a + 1)) : 0;
    sfx.scan();
    for (let i = a; i <= b; i++) later(() => { tiles[i].classList.add('beam'); later(() => tiles[i].classList.remove('beam'), 160); }, (i - a) * step);
    later(() => {
      const mid = tiles[Math.floor((a + b) / 2)];
      if (bad) {
        st.mism.push([a, b]);
        fx.ring(mid, '255,95,109', 170); sfx.bad(); shake(grid);
        logLine(`#${st.used} ${a + 1}–${b + 1}`, false);
      } else {
        for (let i = a; i <= b; i++) st.state[i] = 'ok';
        fx.burst(mid, '61,220,151', 22 + (b - a) * 2, 240); sfx.good(1);
        logLine(`#${st.used} ${a + 1}–${b + 1}`, true);
      }
      deduce();
      sel = null; pending = null;
      paintTiles(); paintSel();
      busy = false;
      afterCheck();
    }, (b - a + 1) * step + 180);
  }

  function checkWhole() {
    if (st.probedWhole != null) return;
    busy = true;
    st.used = 1; total.checks++;
    bar.set('used', '1', 'bump'); paintBudget();
    const tiles = grid.children;
    sfx.scan();
    for (let i = 0; i < st.n; i++) later(() => { tiles[i].classList.add('beam'); later(() => tiles[i].classList.remove('beam'), 160); }, i * (motion ? 18 : 0));
    later(() => {
      busy = false;
      st.probedWhole = st.rotten.size === 0;
      checkBtn.disabled = true;
      if (st.probedWhole) {
        for (let i = 0; i < st.n; i++) st.state[i] = 'ok';
        paintTiles();
        logLine('CRC-32 whole stream', true);
        fx.burst(grid, '61,220,151', 40, 300); sfx.good(2);
        return solved('The single CRC-32 matches: the whole stream is proven intact.', 3, 'Stream intact');
      }
      logLine('CRC-32 whole stream', false);
      for (let i = 0; i < st.n; i++) grid.children[i].classList.add('suspect');
      fx.ring(grid, '255,95,109', 260); sfx.bad(); shake(grid);
      decideBox.hidden = false;
      decideBox.textContent = '';
      const guess = h('button', { class: 'g-btn g-btn--bad', type: 'button', onclick: () => {
        fail('Guessing which shard is damaged and “repairing” it emits bytes nothing can verify. One checksum for the whole stream detects damage but cannot say where.', 'Unproven repair');
      } }, 'Repair the likeliest shard');
      const ab = h('button', { class: 'g-btn g-btn--good', type: 'button', onclick: () => abstain() }, '⊘ Abstain — report, emit nothing unproven');
      decideBox.append(h('p', null, 'The stream is damaged, but a single checksum cannot say where. What now?'), h('div', { class: 'g-actions' }, ab, guess));
      ab.focus({ preventScroll: true });
    }, st.n * (motion ? 18 : 0) + 220);
  }

  function logLine(label, ok) {
    log.prepend(h('li', { class: ok ? 'ok' : 'bad' }, label, ' ', h('b', null, ok ? '✓ match' : '✕ mismatch')));
    while (log.children.length > 8) log.lastChild.remove();
  }

  function afterCheck() {
    const S = st.state;
    const nb = S.filter((s) => s === 'bad').length;
    const nu = S.filter((s) => s === 'u').length;
    const solvedNow = st.known ? nb === st.k : nu === 0;
    if (solvedNow) {
      if (lv.parity) return parityDecision(nb);
      const stars = st.used <= st.par ? 3 : st.used <= st.par + 2 ? 2 : 1;
      return solved(`Found ${nb === 1 ? 'the rotten shard' : `all ${nb} rotten shards`} in ${st.used} check${st.used === 1 ? '' : 's'} (par ${st.par}).`, stars);
    }
    if (st.used >= st.budget) {
      return fail(`Out of checks with ${nu} shard${nu === 1 ? '' : 's'} still unproven. Guessing the rest would not be proof.`, 'Out of checks');
    }
  }

  function parityDecision(nb) {
    st.done = true; paintSel();
    decideBox.hidden = false;
    decideBox.textContent = '';
    const rebuild = h('button', { class: 'g-btn g-btn--good', type: 'button', onclick: () => {
      if (nb <= lv.parity) solved(`Rebuilt ${nb} shard${nb === 1 ? '' : 's'} from parity — inside the budget of ${lv.parity}, so every rebuilt byte is checked against the manifest.`, st.used <= st.par ? 3 : st.used <= st.par + 3 ? 2 : 1);
      else fail(`Parity can rebuild ${lv.parity} shards, and ${nb} are rotten. A “rebuild” past the budget is a guess the manifest cannot confirm.`, 'Repair past budget');
    } }, `Rebuild ${nb} shard${nb === 1 ? '' : 's'}`);
    const ab = h('button', { class: 'g-btn', type: 'button', onclick: () => {
      if (nb > lv.parity) solved(`Abstained: ${nb} rotten shards is past the parity budget of ${lv.parity}. The report still says exactly which ones.`, st.used <= st.par ? 3 : st.used <= st.par + 3 ? 2 : 1);
      else fail(`${nb} rotten shard${nb === 1 ? '' : 's'} fit inside the parity budget of ${lv.parity}: a verified rebuild was available.`, 'Repair was possible');
    } }, '⊘ Abstain');
    decideBox.append(h('p', null, `Every shard is proven: ${nb} rotten. The parity sidecar can rebuild at most ${lv.parity}.`), h('div', { class: 'g-actions' }, rebuild, ab));
    rebuild.focus({ preventScroll: true });
  }

  function abstain() {
    if (st.done && !(lv.mode === 'whole' && st.probedWhole === false)) return;
    if (lv.mode === 'whole') {
      if (st.probedWhole === false) return solved('Abstained: the damage is reported, and nothing unproven is emitted. With one checksum for the whole stream, that is the honest result.', 3, 'Correctly abstained');
      return fail('You abstained without checking. The stream might have been intact — check first, then decide.', 'Abstained too early');
    }
    fail('This manifest had a hash for every run you could select: the damage could be localised. Abstaining here gives up proof that was available.', 'Proof was available');
  }

  function solved(msg, stars, title) {
    st.done = true;
    paintSel();
    const pts = 1000 + Math.max(0, st.budget - st.used) * 120 + (st.used <= st.par ? 300 : 0);
    if (marathon) {
      total.score += pts; total.disks++;
      bar.set('score', fmtInt(total.score), 'bump');
      fx.confetti(60); sfx.win();
      toast(api.toasts, `Disk ${total.disks} cleared · +${fmtInt(pts)}`, 'good', 1400);
      later(() => newPuzzle(randomDisk()), 1500);
      return;
    }
    bar.set('score', fmtInt(pts), 'bump');
    api.finish({ won: true, stars, score: pts, title: title || (stars === 3 ? 'Under par' : 'Disk solved'), lesson: [msg, ' ', lv.lesson],
      stats: [['Checks used', `${st.used}`], ['Par', `${st.par}`], ['Budget', `${st.budget}`], ['Rotten', `${st.rotten.size}`]] });
  }
  function fail(msg, title) {
    st.done = true;
    paintSel();
    for (let i = 0; i < st.n; i++) if (st.rotten.has(i) && st.state[i] !== 'bad') grid.children[i].classList.add('suspect');
    fx.flash('255,95,109', 0.3);
    if (marathon) {
      api.finish({ won: false, score: total.score, title: 'Marathon over', lesson: [msg],
        stats: [['Disks solved', `${total.disks}`], ['Checks', `${total.checks}`]], delay: 1400 });
      return;
    }
    api.finish({ won: false, stars: 0, score: 0, title, lesson: [msg, ' ', lv.lesson],
      stats: [['Checks used', `${st.used}`], ['Par', `${st.par}`], ['Rotten', `${st.rotten.size}`]], delay: 1400 });
  }

  function randomDisk() {
    const n = r.pick([16, 24, 32, 48]);
    const k = r.pick(n >= 32 ? [1, 2, 2, 3] : [1, 1, 2]);
    const par = parFor(n, k);
    return { name: 'Marathon', n, k, mode: 'range', budget: par + 4, lesson: '' };
  }

  function onKey(ev) {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key === 'c' || ev.key === 'C') { ev.preventDefault(); check(); }
    else if (ev.key === 'x' || ev.key === 'X') { pending = null; sel = null; paintSel(); }
    else if (ev.key.startsWith('Arrow') && ev.target && ev.target.classList && ev.target.classList.contains('br-tile')) {
      const i = Number(ev.target.dataset.i);
      const cols = Number(grid.style.getPropertyValue('--cols')) || 8;
      const d = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[ev.key];
      const j = i + d;
      if (j >= 0 && j < st.n) { ev.preventDefault(); grid.children[j].focus(); }
    }
  }
  document.addEventListener('keydown', onKey);

  newPuzzle(marathon ? randomDisk() : api.level);
  if (!marathon) bar.set('score', '—');

  return () => {
    timers.forEach((id) => clearTimeout(id)); timers = [];
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerup', onUp);
  };
}

const root = document.getElementById('game');
if (root) {
  new Game(root, {
    id: 'bit-rot',
    title: 'Bit Rot Hunt',
    levels: LEVELS,
    endless: ENDLESS,
    controls: 'Select a run: tap first and last shard (or drag with a mouse) · Check: C · Clear: X · arrows move between shards · Esc returns to the levels.',
    howto: 'Progress is saved in this browser only. The files are simulated; the evidence rules are the ones VERAQIS applies.',
    play,
  });
}
