// VERAQIS Studio — worker entry point.
//
// One line of code and an important reason for existing.
//
// The service worker's scope is `/studio/`, deliberately: a visitor who never
// opens Studio must be unaffected by it. But a Worker's *client* is matched to a
// registration by the WORKER SCRIPT'S URL, not by the URL of the page that
// created it. With the entry point at `/assets/studio/worker.js` — outside the
// scope — no registration claims the new worker client, so its script load is
// never served from the offline cache. Measured: offline, `new Worker(...)`
// failed with net::ERR_ABORTED even though the same URL fetched from the page
// returned 200 from the cache, and even though every module was precached.
//
// Offline analysis appeared to work only because the browser's ordinary HTTP
// cache happened to still hold the script. That is not offline support; it is a
// coincidence with an expiry time.
//
// Putting the entry point inside `/studio/` makes the worker client fall under
// the existing scope. Nothing widens: the scope is still `/studio/`, the modules
// still live in `/assets/studio/`, and the rest of the site is still untouched.

import '/assets/studio/worker.js';
