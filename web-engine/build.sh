#!/usr/bin/env bash
# Build phx_web.js + phx_web.wasm: the complete VERAQIS engine for the browser.
#
# Usage: PHX_PLATFORM=/path/to/phx-platform ./build.sh [out-dir]
#   PHX_PLATFORM  the VERAQIS engine workspace at commit
#                 3b8b356d95a7eddfa63e45cb5313e089e00e9ba3. The engine's own source
#                 is not part of this folder; this script records exactly how the
#                 published WebAssembly is produced from it.
#   out-dir       where phx_web.js / phx_web.wasm go
#                 (default: ../assets/studio/engine next to this folder)
#
# Needs: Rust with the wasm32-unknown-emscripten target, Emscripten (emcc) on
# PATH, and a wasm-opt that Emscripten accepts (binaryen 123 was used; set
# EM_BINARYEN_ROOT if it is not the one bundled with emcc). Built and checked
# with rustc 1.100.0 and Emscripten 4.0.9. The workspace pins its own Rust
# version in rust-toolchain.toml; RUSTUP_TOOLCHAIN overrides it.
#
# The caller's checkout is never modified: everything happens in a temporary copy.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="${PHX_PLATFORM:?set PHX_PLATFORM to the engine workspace}"
out="${1:-$here/../assets/studio/engine}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tar -C "$src" --exclude=./target --exclude=./.git -cf - . | tar -C "$work" -xf -

# 1. The two small engine changes the browser needs (see patches/).
(cd "$work" && patch -p1 --forward < "$here/patches/phx_api-browser.patch")

# 2. The browser adapter crate, added to the workspace.
mkdir -p "$work/crates/phx_web/src"
cp "$here/phx_web/Cargo.toml" "$work/crates/phx_web/Cargo.toml"
cp "$here/phx_web/src/main.rs" "$work/crates/phx_web/src/main.rs"
python3 - "$work/Cargo.toml" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if '"crates/phx_web"' not in s:
    s, n = re.subn(r'(members\s*=\s*\[)', r'\1\n    "crates/phx_web",', s, count=1)
    assert n == 1, 'workspace members list not found'
open(p, 'w', encoding='utf-8').write(s)
PY

# 3. Link settings: an ES module exporting createPhx(), WORKERFS for reading
#    the user's File objects in place, no eval (strict CSP), up to 4 GB memory.
mkdir -p "$work/.cargo"
cat > "$work/.cargo/config.toml" <<'TOML'
[target.wasm32-unknown-emscripten]
linker = "emcc"
rustflags = [
  "-C", "link-arg=-sEXPORTED_FUNCTIONS=['_phx_dispatch','_phx_free','_main','_malloc','_free']",
  "-C", "link-arg=-sEXPORTED_RUNTIME_METHODS=['FS','WORKERFS','ccall','UTF8ToString','stringToNewUTF8']",
  "-C", "link-arg=-sMODULARIZE=1",
  "-C", "link-arg=-sEXPORT_ES6=1",
  "-C", "link-arg=-sEXPORT_NAME=createPhx",
  "-C", "link-arg=-sENVIRONMENT=web,worker,node",
  "-C", "link-arg=-sALLOW_MEMORY_GROWTH=1",
  "-C", "link-arg=-sMAXIMUM_MEMORY=4GB",
  "-C", "link-arg=-sSTACK_SIZE=8MB",
  "-C", "link-arg=-sDYNAMIC_EXECUTION=0",
  "-C", "link-arg=-sFORCE_FILESYSTEM=1",
  "-C", "link-arg=-sEXIT_RUNTIME=0",
  "-C", "link-arg=-lworkerfs.js",
]
TOML

(cd "$work" && cargo build --release -p phx_web --target wasm32-unknown-emscripten)
target="${CARGO_TARGET_DIR:-$work/target}/wasm32-unknown-emscripten/release"
mkdir -p "$out"
cp "$target/phx_web.js" "$target/phx_web.wasm" "$out/"
sha256sum "$out/phx_web.wasm" "$out/phx_web.js"
