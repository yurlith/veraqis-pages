// VERAQIS Studio — full engine worker entry point.
//
// Lives inside /studio/ for the same reason as studio/worker.js: a Worker is
// matched to a service-worker registration by its own script URL, so only an
// entry point inside the /studio/ scope can be served from the offline cache.
// The engine itself stays in /assets/studio/engine/.

import '/assets/studio/engine/worker.js';
