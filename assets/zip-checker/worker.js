// VERAQIS — ZIP checker analysis worker.
//
// Runs the analysis core off the main thread so a large archive never freezes
// the page. Same-origin module worker; the CSP allows it under `script-src 'self'`
// (measured — `worker-src` is not required, see ZIP_CHECKER_SECURITY.md).
//
// It receives a File handle by structured clone. A File is a reference to bytes
// on disk, not a copy, and nothing here sends it anywhere.

import { analyzeArchive, readerFromBlob } from './zip-core.js';
import { probePrepended } from './prepend-probe.js';

let controller = null;

self.onmessage = async (ev) => {
  const msg = ev.data || {};

  if (msg.type === 'cancel') {
    if (controller) controller.abort();
    return;
  }

  if (msg.type !== 'analyze') return;

  controller = new AbortController();
  const file = msg.file;

  // Progress is throttled: a message per entry on a 5000-entry archive would
  // cost more than the analysis.
  let lastPost = 0;
  const onProgress = (p) => {
    const now = Date.now();
    if (now - lastPost < 80 && p.phase !== 'start') return;
    lastPost = now;
    self.postMessage({ type: 'progress', ...p });
  };

  try {
    const result = await analyzeArchive(
      readerFromBlob(file),
      {
        fileName: file.name,
        verifyCrc: msg.verifyCrc !== false,
        // The Rust offset-shift measurement, handed in rather than imported by the core.
        // The core calls it only for a file that does not begin with a ZIP signature, so
        // the WebAssembly module is fetched and compiled on that path alone — an ordinary
        // archive never loads it.
        probePrepended,
      },
      onProgress,
      controller.signal
    );
    self.postMessage({ type: 'result', result });
  } catch (e) {
    if (e && e.name === 'AbortError') self.postMessage({ type: 'cancelled' });
    else self.postMessage({ type: 'error', message: String((e && e.message) || e).slice(0, 300) });
  } finally {
    controller = null;
  }
};
