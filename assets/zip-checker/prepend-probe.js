// VERAQIS — the prepended-data probe: the Rust engine, compiled to wasm32.
//
// "This file does not begin with a ZIP signature" is true of a self-extracting archive and
// of a corrupted one alike, so on its own it decides nothing. What separates them is
// whether the surviving central-directory records all agree on ONE offset shift: a stub
// moves everything by its own length, and damage is not a translation.
//
// That comparison is `phx_zip_core::cd_scan`, already written, measured and tested in Rust
// (crates/phx_zip_wasm/src/lib.rs). It is loaded here rather than reimplemented in
// JavaScript. This module is the only part of the checker that touches WebAssembly; the
// analysis core (zip-core.js) stays plain JavaScript and takes this as an optional
// callback, so the checker still works, unchanged, when the probe cannot run.
//
// Nothing here reads the network beyond the module's own same-origin fetch of its .wasm
// file, and no part of the archive leaves the worker.

/**
 * The probe compares directory records against local headers *in the same buffer*, so it
 * must be given the file from byte zero. A window that starts later would move every
 * offset by the window's own start and manufacture a shift that is not there. There is
 * therefore no bounded-tail mode: above this size the probe declines instead of guessing.
 *
 * 64 MiB is the whole-file read this costs, on a path that only runs for files that do not
 * start with a ZIP signature — a rare shape, and never on an ordinary archive.
 */
export const PROBE_MAX_BYTES = 64 * 1024 * 1024;

let modulePromise = null;

function loadModule() {
  if (!modulePromise) {
    modulePromise = import('./wasm/phx_zip_wasm.js').then(async (mod) => {
      await mod.default();
      return mod;
    });
  }
  return modulePromise;
}

/**
 * Measure the offset shift, if there is one.
 *
 * Never throws: a probe that cannot run must not fail the analysis around it, so every
 * failure comes back as `attempted:false` with the reason.
 *
 * @param {{size:number, read:(o:number,l:number)=>Promise<Uint8Array>}} reader
 * @returns {Promise<object>} see the shape below
 */
export async function probePrepended(reader) {
  if (reader.size > PROBE_MAX_BYTES) {
    return {
      attempted: false,
      reason: `the offset-shift probe reads the whole file and this one is over ${Math.round(PROBE_MAX_BYTES / 1048576)} MiB`,
    };
  }
  let mod;
  try {
    mod = await loadModule();
  } catch (e) {
    return { attempted: false, reason: `the probe module did not load (${String((e && e.message) || e).slice(0, 120)})` };
  }
  try {
    const bytes = await reader.read(0, reader.size);
    const raw = JSON.parse(mod.probe_prepended(bytes));
    return {
      attempted: true,
      schema: raw.schema,
      proven: raw.proven === true,
      shiftBytes: typeof raw.shift_bytes === 'number' ? raw.shift_bytes : null,
      records: raw.records | 0,
      supported: raw.supported | 0,
      conflicting: raw.conflicting | 0,
      candidatesSeen: raw.candidates_seen | 0,
      rejection: raw.rejection || null,
    };
  } catch (e) {
    return { attempted: false, reason: `the probe did not complete (${String((e && e.message) || e).slice(0, 120)})` };
  }
}
