// VERAQIS Studio — the Rust recovery engine, for the formats ZIP tooling cannot open.
//
// Studio's ZIP path is untouched by this module. `detect()` claims gzip, tar,
// 7-Zip, ISO 9660 and RAR only, so a ZIP still goes to the engines that have
// been proven against a 23-fixture parity contract in four browsers. What this
// replaces is the dead end: until now a .tar.gz produced "This file is not a
// format VERAQIS Studio can analyse" and nothing else.
//
// Everything here runs `crates/phx_recovery_wasm`, the same open-core engine the
// desktop product runs, compiled to wasm32. It is graded against the native
// build over 177 fixtures x 4 modes (tools/wasm-recovery-core/recover-parity.mjs)
// and against Node in Chrome, Edge, Firefox and WebKit
// (tools/wasm-recovery-core/browser-parity.mjs).
//
// ## What this module refuses to do
//
// It never presents recovered bytes without the verdict that qualifies them.
// The engine reports `success` when a repair was applied and kept — which is
// NOT the same as the output being openable: measured over the corpus, 40 runs
// returned success over output no reader could open. `output_still_damaged` is
// the engine re-reading what it produced, and `payload_evidence` says whether
// the format can prove its own contents at all (tar cannot: it checksums each
// header and nothing over member data). Both travel with the bytes, and
// `describeOutcome` below turns them into the sentence a user actually reads.

import { StudioError, ERR, toStudioError } from './errors.js';
import { STAGE } from './protocol.js';
import { CAPABILITY, capabilityEnabled, detectSync, sizePolicy } from './capabilities.js';

export const RECOVERY_ENGINE_VERSION = '1.0.0';

/** Formats this engine claims. ZIP is deliberately absent. */
const CLAIMED = [
  { ext: 'gz', label: 'Gzip stream' },
  { ext: 'tgz', label: 'Gzip-compressed tar' },
  { ext: 'tar', label: 'Tar archive' },
  { ext: '7z', label: '7-Zip archive' },
  { ext: 'iso', label: 'ISO 9660 image' },
  { ext: 'rar', label: 'RAR archive' },
];

const extOf = (name) => {
  const i = String(name || '').lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

let wasmReady = null;

/**
 * Load the engine once.
 *
 * Deliberately NOT precached by the Service Worker: the artifact is larger than
 * the whole rest of the application shell, and precaching it would cost every
 * offline user of the ZIP tool bytes they never asked for. The consequence is
 * stated rather than hidden — these formats need the network on first use.
 */
async function engine() {
  if (!capabilityEnabled(CAPABILITY.MULTI_FORMAT_RECOVERY)) {
    throw new StudioError(ERR.CAPABILITY_NOT_AVAILABLE, {
      detail: 'multi-format analysis is not enabled in this build',
    });
  }
  if (!wasmReady) {
    wasmReady = (async () => {
      const mod = await import('./wasm-recovery/phx_recovery_wasm.js');
      await mod.default();
      return mod;
    })().catch((e) => {
      wasmReady = null;
      throw toStudioError(e, ERR.CAPABILITY_NOT_AVAILABLE, STAGE.IDENTIFY);
    });
  }
  return wasmReady;
}

/**
 * Turn the engine's report into the sentence a user reads, and the flag that
 * decides whether "recovered" may be said at all.
 *
 * Four states, and only one of them earns the word:
 *
 *   repaired      — a repair was kept AND the engine's own re-analysis finds
 *                   nothing wrong with what it produced.
 *   still-damaged — a repair was kept and the output is measurably still
 *                   broken. Honest and common: a truncated tar can improve
 *                   from health 40 to 60 and remain unreadable.
 *   unevidenced   — a repair was kept, the output looks clean, but the format
 *                   stores no checksum over member contents. tar cannot prove
 *                   its own data survived, so neither can we.
 *   none          — nothing was repaired.
 */
export function describeOutcome(report, payloadEvidence) {
  if (!report || report.success !== true) {
    return {
      state: 'none',
      mayCallRecovered: false,
      headline: 'No repair was applied.',
      detail: 'The engine found nothing it could prove how to fix, so it changed nothing.',
    };
  }
  // Absence is not health. An older or partial report may carry no verdict at
  // all, and treating "we did not hear otherwise" as "the output is fine" is
  // the same mistake as reading bytes_lost: 0 from a strategy that never
  // measured loss. Only an explicit `false` earns the good outcome, so an
  // unknown verdict lands in still-damaged with the rest.
  if (report.output_still_damaged !== false) {
    return {
      state: 'still-damaged',
      mayCallRecovered: false,
      headline: 'Repaired in part — the result is still damaged.',
      detail:
        'A repair was applied and kept, but the engine cannot confirm the result is sound — '
        + 'it re-read its own output and either found problems or could not check. The file may '
        + 'not open. This is not a recovered file.',
    };
  }
  if (payloadEvidence === 'none') {
    return {
      state: 'unevidenced',
      mayCallRecovered: false,
      headline: 'Structure repaired — contents not verified.',
      detail:
        'This format stores no checksum over the data inside it, so nothing can confirm the '
        + 'contents are unchanged. The structure was repaired; whether the data survived is unknown.',
    };
  }
  return {
    state: 'repaired',
    mayCallRecovered: true,
    headline: 'Repaired, and the result checks out.',
    detail:
      'A repair was applied and the engine re-read its own output without finding a problem. '
      + 'That is a structural check, not a guarantee about the file\u2019s meaning.',
  };
}

export const recoveryEngine = {
  id: 'phx-recovery',
  label: 'VERAQIS recovery engine',
  version: RECOVERY_ENGINE_VERSION,
  extensions: CLAIMED.map((c) => c.ext),

  capabilities: {
    multiFormatAnalysis: true,
    recoveryPlan: true,
    // Byte output, qualified by the verdict that travels with it.
    repairedOutput: 'verdict-required',
    // ZIP is handled by the engines that were proven against it.
    zip: false,
  },

  limitations: [
    'Analysis never writes. A repair produces a new local download and never modifies your file.',
    'gzip, tar, 7-Zip, ISO 9660 and RAR are identified and analysed; ZIP is handled by the dedicated ZIP engine.',
    'A repair may improve a file without fixing it. The result says which happened, and only says recovered when the engine re-read its own output cleanly.',
    'tar stores no checksum over member contents, so a repaired tar can never be confirmed intact — only its structure can.',
    'Compressed payload damage is detected where the format carries a checksum, and refused rather than guessed at.',
    'This runs entirely in your browser. Nothing is uploaded.',
  ],

  async detect(file) {
    const ext = extOf(file.name);
    const claimed = CLAIMED.find((c) => c.ext === ext);
    if (!claimed) return { claims: false, format: null, confidence: 'none' };
    if (!capabilityEnabled(CAPABILITY.MULTI_FORMAT_RECOVERY)) {
      return { claims: false, format: null, confidence: 'none' };
    }
    // The engine takes the whole file as one buffer, so the device-memory
    // policy this file already computes decides the ceiling rather than a
    // number invented here.
    if (file.size > sizePolicy(detectSync()).recommended) {
      return { claims: false, format: null, confidence: 'none' };
    }
    return { claims: true, format: claimed.ext, confidence: 'extension' };
  },
};

/** Read the whole file. The engine takes one buffer; `detect` bounds the size. */
async function readAll(file, onProgress) {
  onProgress({ stage: STAGE.IDENTIFY, done: 0, total: file.size });
  const buf = new Uint8Array(await file.arrayBuffer());
  onProgress({ stage: STAGE.CENTRAL_DIRECTORY, done: file.size, total: file.size });
  return buf;
}

/**
 * Analyse, and ask what a repair would do — both read-only.
 *
 * `recover_plan` runs the planner, never a repair: it reports the ordered steps
 * the engine would take. Showing that before offering to change anything is the
 * point — a user can see what is proposed and decline.
 */
export async function analyseContainer(file, onProgress = () => {}) {
  const wasm = await engine();
  const bytes = await readAll(file, onProgress);

  const analysis = JSON.parse(wasm.analyze(bytes, file.name));
  if (analysis.ok !== true) {
    throw new StudioError(ERR.STRUCTURE_INVALID, { detail: analysis.error, stage: STAGE.REPORT });
  }
  const plan = JSON.parse(wasm.recover_plan(bytes, file.name));

  const a = analysis.analysis;
  return {
    schema: 'veraqis-container-analysis/1',
    engine: { id: recoveryEngine.id, version: recoveryEngine.version, kind: 'rust-wasm' },
    format: a.archive_format || 'unknown',
    health: a.health_score ? a.health_score.overall : null,
    corruptions: (a.corruptions || []).map((c) => ({
      rule: c.chain && c.chain.primary ? c.chain.primary.rule_id : 'unknown',
      severity: c.severity,
      description: c.description,
    })),
    warnings: a.warnings || [],
    plan: (plan.ok === true ? plan.steps : []).map((s) => ({
      technique: s.technique,
      outcome: s.predicted_outcome,
      risk: s.risk,
    })),
    source: { name: file.name, size: file.size },
  };
}

/**
 * Repair in memory and hand back the bytes with the verdict that qualifies them.
 *
 * The two are returned together deliberately. A caller able to take `bytes`
 * without `outcome` would be one refactor away from offering an unopenable file
 * as a recovered one, which is the single failure this whole path is built to
 * avoid.
 */
export async function recoverContainer(file, onProgress = () => {}) {
  const wasm = await engine();
  const bytes = await readAll(file, onProgress);

  const out = wasm.recover(bytes, file.name, false, undefined);
  const env = JSON.parse(out.report_json);
  if (env.ok !== true) {
    throw new StudioError(ERR.STRUCTURE_INVALID, { detail: env.error, stage: STAGE.REPORT });
  }
  const outcome = describeOutcome(env.report, env.payload_evidence);
  return {
    schema: 'veraqis-container-recovery/1',
    bytes: out.bytes,
    outcome,
    payloadEvidence: env.payload_evidence,
    claim: env.claim,
    report: {
      strategies: env.report.strategies_applied || [],
      rolledBack: env.report.rolled_back || [],
      warnings: env.report.warnings || [],
      healthBefore: env.report.health_before,
      healthAfter: env.report.health_after,
      stillDamaged: env.report.output_still_damaged,
    },
    source: { name: file.name, size: file.size },
  };
}
