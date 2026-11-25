#!/bin/sh
# Rebuilds three.min.js: one ES module with the parts of three.js (core + a few addons) that the
# 3D game Neon Rift uses, tree-shaken and minified. three.js is MIT-licensed (THREE-LICENSE.txt).
# Needs Node 18+ and the npm registry.
#
#   ./build-three.sh            # from this folder
#
# Every `THREE.Name` used in ../neonrift/*.js is exported, core names from 'three' and addon names
# from the addon module listed below; nothing else is bundled. Version and hash go to SOURCE.json.
set -eu
VERSION=0.187.0
ESBUILD=0.28.2
here=$(cd "$(dirname "$0")" && pwd)
rel=$(echo "$VERSION" | cut -d. -f2)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# addon export -> module under three/addons/
addon_of() {
  case "$1" in
    EffectComposer) echo postprocessing/EffectComposer.js ;;
    RenderPass) echo postprocessing/RenderPass.js ;;
    UnrealBloomPass) echo postprocessing/UnrealBloomPass.js ;;
    OutputPass) echo postprocessing/OutputPass.js ;;
    ShaderPass) echo postprocessing/ShaderPass.js ;;
    FXAAShader) echo shaders/FXAAShader.js ;;
    RoundedBoxGeometry) echo geometries/RoundedBoxGeometry.js ;;
    mergeGeometries|mergeVertices) echo utils/BufferGeometryUtils.js ;;
    Sky) echo objects/Sky.js ;;
    SimplexNoise) echo math/SimplexNoise.js ;;
    *) echo '' ;;
  esac
}

names=$(grep -ohE 'THREE\.[A-Za-z_][A-Za-z0-9_]*' "$here"/../neonrift/*.js | sed 's/^THREE\.//' | sort -u)
core=''
: > "$work/entry.js"
for n in $names; do
  mod=$(addon_of "$n")
  if [ -n "$mod" ]; then
    printf "export { %s } from 'three/addons/%s';\n" "$n" "$mod" >> "$work/entry.js"
  else
    core="$core  $n,
"
  fi
done
printf 'export {\n%s} from %s;\n' "$core" "'three'" >> "$work/entry.js"

cd "$work"
npm init -y >/dev/null
npm install --silent "three@$VERSION" "esbuild@$ESBUILD"
npx esbuild entry.js --bundle --format=esm --minify --legal-comments=none \
  --banner:js="/* three.js r${rel} (core + addons) subset for VERAQIS Play — MIT License, Copyright 2010-2026 three.js authors (THREE-LICENSE.txt). Rebuild: build-three.sh */" \
  --outfile="$here/three.min.js"
cp node_modules/three/LICENSE "$here/THREE-LICENSE.txt"

sha=$(sha256sum "$here/three.min.js" | cut -d' ' -f1)
bytes=$(wc -c < "$here/three.min.js" | tr -d ' ')
count=$(printf '%s\n' $names | wc -l | tr -d ' ')
cat > "$here/SOURCE.json" <<JSON
{
  "note": "three.min.js is three.js $VERSION (npm), core plus addons, reduced to the $count names Neon Rift uses and minified with esbuild $ESBUILD. Rebuild with build-three.sh rather than editing by hand.",
  "three": "$VERSION",
  "esbuild": "$ESBUILD",
  "exports": $count,
  "file": { "name": "three.min.js", "bytes": $bytes, "sha256": "$sha" }
}
JSON
echo "three.min.js: $bytes bytes, $count exports, sha256 $sha"
