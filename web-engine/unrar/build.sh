#!/usr/bin/env bash
# Build unrar.js + unrar.wasm for the browser.
#
# Usage: UNRAR_SRC=/path/to/unrar ./build.sh [out-dir]
#   UNRAR_SRC  UnRAR source tree (the "unrar" folder of unrarsrc-7.x, which
#              contains makefile, dll.hpp, ...). Tested with UnRAR 7.23.
#   out-dir    where unrar.js / unrar.wasm go (default: ../../assets/studio/engine)
# Needs Emscripten (em++) on PATH. Tested with Emscripten 4.0.9.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="${UNRAR_SRC:?set UNRAR_SRC to the UnRAR source folder}"
out="${1:-$here/../../assets/studio/engine}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The object list of UnRAR's own makefile, library ("lib") target.
objs="rar strlist strfn pathfn smallfn global file filefn filcreat archive arcread unicode
system crypt crc rawread encname resource match timefn rdwrfn consio options errhnd rarvm
secpassword rijndael getbits sha1 sha256 blake2s hash extinfo extract volume list find
unpack headers threadpool rs16 cmddata ui largepage filestr scantree dll qopen"

flags=(-O2 -std=c++17 -DRARDLL -D_FILE_OFFSET_BITS=64 -D_LARGEFILE_SOURCE -fwasm-exceptions
       -Wno-logical-op-parentheses -Wno-switch -Wno-dangling-else)
for o in $objs; do
  em++ "${flags[@]}" -c "$src/$o.cpp" -o "$work/$o.o"
done
em++ "${flags[@]}" -I"$src" -c "$here/unrar_web.cpp" -o "$work/unrar_web.o"

mkdir -p "$out"
em++ -O2 -fwasm-exceptions "$work"/*.o -o "$out/unrar.js" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createUnrar \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=4MB \
  -sDYNAMIC_EXECUTION=0 -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 -lworkerfs.js \
  "-sEXPORTED_FUNCTIONS=['_rar_run','_malloc','_free']" \
  "-sEXPORTED_RUNTIME_METHODS=['FS','WORKERFS','UTF8ToString','stringToNewUTF8']"
echo "built $out/unrar.js and $out/unrar.wasm"
