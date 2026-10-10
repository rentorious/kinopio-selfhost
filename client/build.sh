#!/usr/bin/env bash
# Build the patched Kinopio client into ./client-dist (or $1).
# Used by the Dockerfile and for local development.
set -euo pipefail

REPO="${KINOPIO_CLIENT_REPO:-https://github.com/kinopio-club/kinopio-client.git}"
COMMIT="${KINOPIO_CLIENT_COMMIT:-0394e07b343d076347aaa214edb584e0856c4347}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(realpath -m "${1:-$HERE/../client-dist}")"
WORK="${KINOPIO_CLIENT_WORKDIR:-$HERE/.kinopio-client}"

if [ ! -d "$WORK/.git" ]; then
  git init -q "$WORK"
  git -C "$WORK" remote add origin "$REPO"
fi
git -C "$WORK" fetch -q --depth 1 origin "$COMMIT"
git -C "$WORK" checkout -q --force FETCH_HEAD
git -C "$WORK" clean -qfdx -e node_modules

for patch in "$HERE"/patches/*.patch; do
  echo "applying $(basename "$patch")"
  git -C "$WORK" apply "$patch"
done

(cd "$WORK" && npm ci --no-audit --no-fund --loglevel=error && VITE_SELFHOST=true npm run build)

rm -rf "$OUT"
cp -r "$WORK/dist" "$OUT"
# PolyForm Noncommercial: whoever receives the client gets the terms and the notice.
cp "$WORK/LICENSE.md" "$OUT/KINOPIO-LICENSE.md"
cp "$HERE/NOTICE.md" "$OUT/KINOPIO-NOTICE.md"
echo "client built into $OUT"
