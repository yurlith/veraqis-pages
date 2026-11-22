# VERAQIS web engine — source of the browser version

[veraqis.tech/studio/engine/](https://veraqis.tech/studio/engine/) runs the complete VERAQIS
(PHX) engine in the browser, on the visitor's device: analysis, structural repair, content
recovery, salvage, repair data and folder protection, encryption, signatures, safe extraction,
and RAR. Every function is free and needs no license. This folder is the source of everything that
is specific to the web version.

## What is here

| Path | What it is |
|---|---|
| `phx_web/` | The browser adapter: one Rust file. It takes the same protocol-v1 JSON the desktop and Android apps send, runs it through the engine's desktop dispatcher, and returns the same envelope. It also sets the web edition's entitlement: every gated end-user function is open. |
| `patches/phx_api-browser.patch` | The only two changes to the engine. In a browser there is no thread pool, so blocking work runs inline in the worker (a panic still becomes an error, not a crash); and the API builder can take a ready-made policy. |
| `build.sh` | Rebuilds `phx_web.wasm` from the engine workspace (`PHX_PLATFORM`, commit `3b8b356d95a7eddfa63e45cb5313e089e00e9ba3`). |
| `unrar/` | The UnRAR adapter (`unrar_web.cpp`: list, test, extract) and its build script. |
| `../studio/engine/index.html`, `../studio/engine-worker.js` | The page and the worker entry point (inside the `/studio/` service-worker scope so it works offline). |
| `../assets/studio/engine/` | The page code (`app.js`, `ops.js`, `worker.js`, `zip.js`, `engine.css`) and the built modules (`phx_web.*`, `unrar.*`) with their provenance in `SOURCE.json`. |

The engine itself (the `phx-platform` workspace) is not published here; `build.sh` documents
exactly how the published WebAssembly is made from it.

## How the page works

- The engine (`phx_web.wasm`, 2.25 MB, about 0.9 MB compressed) and UnRAR (`unrar.wasm`, 0.2 MB)
  run in a module Web Worker, one job at a time.
- The visitor's files are mounted read-only with Emscripten's WORKERFS, so they are read in
  place in pieces and never uploaded. A small read-ahead cache serves the engine's small reads
  from 4 MiB blocks.
- Operations that must write beside their input (a `.sig`, repair data for a folder) work on a
  copy in memory. Everything an operation writes is handed back to the page and reaches the disk
  only through a download.
- The page's Content-Security-Policy allows connections to veraqis.tech only and no `eval`
  (`script-src 'self' 'wasm-unsafe-eval'`).
- The engine's history is kept in this browser's IndexedDB (`veraqis-engine`). It is cleared by
  “Clear history” on the page or by Studio's “Delete all local VERAQIS data”.
- Vendor-only operations stay closed: `license_gen` is refused by the same allowlist as in the
  desktop app. Experimental methods keep their label and are hidden until switched on.

## How it was checked (22 November 2026)

- All 35 engine operations ran in WebAssembly. 34 work; `license_gen` is refused by design.
- Equivalence with native builds: 73 of 74 requests gave identical answers. The one difference
  is honest: in a browser the engine reports `isolation: limits_only`, because a browser offers no
  operating-system sandbox. Of the 85 files the engine wrote in the second pass, 84 are
  byte-identical to the native build's; the 85th is a signed repair manifest, which uses a fresh
  key on every run.
- UnRAR: all 29 reference archives of the Android app (RAR 1.3 to RAR 5, solid, multi-volume,
  filters, PPMd, RarVM) extract to the app's reference SHA-256 hashes. Damaged archives are
  reported as checksum failures and missing volumes are named. With the app's encrypted-header
  fixtures, the right password opens, wrong passwords are refused every time, and the three
  deliberately broken headers are refused even with the right password.
- The page itself: 59 of 59 checks in headless Chromium, through the page's own controls —
  every function, byte-exact restores from repair data, a protected folder damaged and repaired,
  encryption with right and wrong passwords, signatures, multi-volume RAR, history across a
  reload, no console or CSP errors, and no horizontal scrolling at phone width. A zip bomb, an
  entry named `../evil.txt` and a symlink entry get exactly the same safety verdicts as from the
  native engine.

## Building

```bash
# The engine (needs the engine workspace, Rust with wasm32-unknown-emscripten, Emscripten):
PHX_PLATFORM=/path/to/phx-platform ./build.sh

# UnRAR (needs the UnRAR 7.x source folder and Emscripten):
UNRAR_SRC=/path/to/unrar ./unrar/build.sh
```

Both write into `../assets/studio/engine/`. Toolchain used: rustc 1.100.0, Emscripten 4.0.9,
binaryen 123, UnRAR 7.23. The builds are reproducible: run from a clean copy, both scripts gave
files byte-identical to the published ones (hashes in
[`../assets/studio/engine/SOURCE.json`](../assets/studio/engine/SOURCE.json)).

## Licenses

The web adapter, the patch, the build scripts and the page code are licensed under either of the
MIT license or the Apache License 2.0, at your option — the same terms as the engine workspace
(`LICENSE-MIT`, `LICENSE-APACHE`).

RAR support uses UnRAR by Alexander Roshal; its license is in
[`../assets/studio/engine/UNRAR-LICENSE.txt`](../assets/studio/engine/UNRAR-LICENSE.txt):

> UnRAR source code may be used in any software to handle RAR archives without limitations free
> of charge, but cannot be used to develop RAR (WinRAR) compatible archiver and to re-create RAR
> compression algorithm, which is proprietary. Distribution of modified UnRAR source code in
> separate form or as a part of other software is permitted, provided that full text of this
> paragraph, starting from "UnRAR source code" words, is included in license, or in
> documentation if license is not available, and in source code comments of resulting package.
