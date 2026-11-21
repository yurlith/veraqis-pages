// VERAQIS Play — hub page: animated arcade panel and per-browser progress.
import { FX, GAMES, totalStars } from './core.js';

const RANKS = [[0, 'Visitor'], [6, 'Apprentice'], [18, 'Analyst'], [36, 'Investigator'], [54, 'Forensic lead'], [72, 'Proof-first']];

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
