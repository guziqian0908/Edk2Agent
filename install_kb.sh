#!/usr/bin/env bash
# Download and install a pre-built EDK2 knowledge base package from a
# GitHub Release (produced by package_kb.py), skipping the embedding rebuild.
#
# Usage:
#   bash install_kb.sh
#   bash install_kb.sh -p kb-full
#   bash install_kb.sh --overwrite
#
# Options:
#   -r REPO       GitHub repo (default: guziqian0908/Edk2Agent)
#   -p PREFIX     package prefix: kb-runtime (default) or kb-full
#   -t TAG        release tag or 'latest' (default: latest)
#   -d DEST       extract target (default: ~/.edk2-opencode/kb)
#   --overwrite   remove an existing data dir before extracting
set -euo pipefail

REPO="guziqian0908/Edk2Agent"
PREFIX="kb-runtime"
TAG="latest"
DEST="${HOME}/.edk2-opencode/kb"
OVERWRITE=0
while [ $# -gt 0 ]; do
    case "$1" in
        -r) REPO="$2"; shift 2 ;;
        -p) PREFIX="$2"; shift 2 ;;
        -t) TAG="$2"; shift 2 ;;
        -d) DEST="$2"; shift 2 ;;
        --overwrite) OVERWRITE=1; shift ;;
        *) echo "unknown arg: $1"; exit 1 ;;
    esac
done

DATA_DIR="$DEST/data"
BASE="https://github.com/$REPO/releases/$TAG/download"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Downloading $PREFIX package from $REPO (tag: $TAG)"

# 1. manifest
curl -fsSL -o "$WORK/$PREFIX.manifest.json" "$BASE/$PREFIX.manifest.json"
DOCS="$(python3 -c "import json;print(json.load(open('$WORK/$PREFIX.manifest.json'))['doc_count'])" 2>/dev/null || echo '?')"
PARTS="$(python3 -c "import json;print(len(json.load(open('$WORK/$PREFIX.manifest.json'))['parts']))" 2>/dev/null || echo '?')"
echo "docs: $DOCS, parts: $PARTS"

# 2. download + verify each part
FULL="$WORK/$PREFIX.tar.gz"
: > "$FULL"
while IFS= read -r line; do
    fname="${line%% *}"
    want="${line##* }"
    echo "  downloading $fname ..."
    curl -fsSL -o "$WORK/$fname" "$BASE/$fname"
    got="$(sha256sum "$WORK/$fname" | awk '{print $1}')"
    if [ "$got" != "$want" ]; then
        echo "ERROR: SHA-256 mismatch for $fname" >&2
        exit 1
    fi
    cat "$WORK/$fname" >> "$FULL"
done < <(python3 -c "
import json
m = json.load(open('$WORK/$PREFIX.manifest.json'))
for p in m['parts']:
    print(p['file'], p['sha256'])
")

# 3. verify reassembled archive
FULL_WANT="$(python3 -c "import json;print(json.load(open('$WORK/$PREFIX.manifest.json'))['total_sha256'])")"
FULL_GOT="$(sha256sum "$FULL" | awk '{print $1}')"
if [ "$FULL_GOT" != "$FULL_WANT" ]; then
    echo "ERROR: SHA-256 mismatch for reassembled archive" >&2
    exit 1
fi
echo "Archive verified."

# 4. extract
if [ -e "$DATA_DIR" ]; then
    if [ "$OVERWRITE" -eq 1 ]; then
        echo "Removing existing $DATA_DIR"
        rm -rf "$DATA_DIR"
    else
        echo "ERROR: data dir already exists: $DATA_DIR (use --overwrite to replace)" >&2
        exit 1
    fi
fi
mkdir -p "$DEST"
tar -xzf "$FULL" -C "$DEST"
if [ ! -d "$DATA_DIR" ]; then
    echo "ERROR: extraction failed" >&2
    exit 1
fi

echo
echo "KB installed at $DATA_DIR"
echo "Models (~/.edk2-opencode/models) still required - run:"
echo "  python <repo>/edk2-kb/fetchers/fetch_models.py"
echo "Then start the daemon with:"
echo "  node <repo>/bin/edk2-opencode.js daemon start"