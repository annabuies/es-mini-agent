#!/bin/bash
# Build the Mini release package from committed code only.
#
# Usage: scripts/build-mini-package.sh <repo> <out-dir> <commit> <version>
#   <repo>     path to an es-mini-agent git checkout (read-only: git archive / git show)
#   <out-dir>  where to write the package (created if missing)
#   <commit>   any commit-ish; resolved to the full SHA
#   <version>  must equal package.json "version" and server.js AGENT_VERSION at <commit>
#
# Output in <out-dir>:
#   es-mini-agent-<V>-<c7>.tar      the package (prefix es-mini-agent-<V>-<c7>/)
#   SHA256SUMS-files-<V>.txt        per-file hashes (from git blobs, cross-checked against the tar)
#   SHA256SUMS-archive.txt          "<tar sha>  <tar name>"
#   RELEASE.txt                     version, commit, tar sha, file count, built-at (UTC)
#
# The tar is reproducible: git archive of a commit is byte-stable (mtime = commit time,
# pax header = commit id), so the same commit always gives the same tar SHA-256.
# 20230f2 / 2026.11.05-1 -> a62d02a7d2d1a1c24f61383f5361a42f1a7a22c87da969af4f09addf8ab3c802.
#
# Never run this on the Mini's live install. bash 3.2 safe.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <repo> <out-dir> <commit> <version>" >&2
  exit 2
fi
REPO="$1"; OUT="$2"; REV="$3"; V="$4"

case "$V" in
  *[!0-9A-Za-z.-]*|'') echo "bad version: $V" >&2; exit 2 ;;
esac

C="$(git -C "$REPO" rev-parse --verify "$REV^{commit}")"
C7="$(printf '%s' "$C" | cut -c1-7)"
NAME="es-mini-agent-$V-$C7"

PKG_V="$(git -C "$REPO" show "$C:package.json" | sed -n 's/.*"version": "\(.*\)".*/\1/p')"
if [ "$PKG_V" != "$V" ]; then
  echo "package.json version at $C7 is '$PKG_V', not '$V'" >&2; exit 1
fi
# grep without -q: an early exit would SIGPIPE git show and trip pipefail.
if ! git -C "$REPO" show "$C:server.js" | grep -F "const AGENT_VERSION = '$V';" >/dev/null; then
  echo "server.js at $C7 does not declare AGENT_VERSION = '$V'" >&2; exit 1
fi

MODS=()
while IFS= read -r line; do
  line="${line%%#*}"; line="$(printf '%s' "$line" | tr -d ' \t\r')"
  [ -n "$line" ] && MODS+=("$line")
done < <(git -C "$REPO" show "$C:modules.txt")
if [ "${#MODS[@]}" -eq 0 ]; then echo "modules.txt at $C7 lists no modules" >&2; exit 1; fi

FILES=("${MODS[@]}" modules.txt package.json install.sh uninstall.sh obs-launcher.sh com.es.obs-launcher.plist)
for f in "${FILES[@]}"; do
  git -C "$REPO" cat-file -e "$C:$f" || { echo "missing at $C7: $f" >&2; exit 1; }
done

mkdir -p "$OUT"
TAR="$NAME.tar"
SUMS="SHA256SUMS-files-$V.txt"
git -C "$REPO" archive --format=tar --prefix="$NAME/" "$C" "${FILES[@]}" > "$OUT/$TAR"

: > "$OUT/$SUMS"
for f in "${FILES[@]}"; do
  printf '%s  %s\n' "$(git -C "$REPO" show "$C:$f" | shasum -a 256 | cut -d' ' -f1)" "$f" >> "$OUT/$SUMS"
done

# Cross-check: files extracted from the tar must equal the git blobs, and nothing extra.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -xf "$OUT/$TAR" -C "$TMP"
(cd "$TMP/$NAME" && shasum -a 256 -c "$OUT/$SUMS" >/dev/null)
N="$(cd "$TMP/$NAME" && find . -type f | wc -l | tr -d ' ')"
if [ "$N" != "${#FILES[@]}" ]; then
  echo "tar has $N files, expected ${#FILES[@]}" >&2; exit 1
fi

TAR_SHA="$(cd "$OUT" && shasum -a 256 "$TAR" | cut -d' ' -f1)"
(cd "$OUT" && printf '%s  %s\n' "$TAR_SHA" "$TAR" > SHA256SUMS-archive.txt)
{
  echo "version=$V"
  echo "commit=$C"
  echo "tar=$TAR"
  echo "tar_sha256=$TAR_SHA"
  echo "sums=$SUMS"
  echo "files=${#FILES[@]}"
  echo "modules=${#MODS[@]}"
  echo "built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT/RELEASE.txt"

echo "files=${#FILES[@]} modules=${#MODS[@]}"
cat "$OUT/SHA256SUMS-archive.txt"
