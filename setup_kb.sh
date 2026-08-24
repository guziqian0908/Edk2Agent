#!/usr/bin/env bash
# Build the EDK2 knowledge base from scratch on Linux/macOS.
# Downloads raw sources + models, then runs init_kb.py and add_mdepkg.py.
#
# Usage (from the repo root):
#   bash setup_kb.sh
#   bash setup_kb.sh --skip-embed
#
# --skip-embed  skip the slow ChromaDB embedding phase (run add_mdepkg.py
#               --embed later yourself)
# EDK2_KB_DATA  where KB data lives (default: ~/.edk2-opencode/kb/data)
# EDK2_MODELS_DIR  where models live (default: ~/.edk2-opencode/models)
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

SKIP_EMBED=0
for arg in "$@"; do
    case "$arg" in
        --skip-embed) SKIP_EMBED=1 ;;
        *) echo "unknown arg: $arg"; exit 1 ;;
    esac
done

export EDK2_KB_DATA="${EDK2_KB_DATA:-$HOME/.edk2-opencode/kb/data}"
export EDK2_MODELS_DIR="${EDK2_MODELS_DIR:-$HOME/.edk2-opencode/models}"

# --- Create and use a local venv to avoid bare-python pollution ---
VENV_DIR="$HOME/.edk2-opencode/kb/venv"
if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "Creating Python venv at $VENV_DIR ..."
    python3 -m venv "$VENV_DIR"
fi
PY="$VENV_DIR/bin/python"
echo "Using venv python: $PY"

run_step() {
    echo
    echo "=== $1 ==="
    shift
    "$@"
}

echo "Data dir : $EDK2_KB_DATA"
echo "Models   : $EDK2_MODELS_DIR"

run_step "install python deps" $PY -m pip install -r edk2-kb/requirements.txt
run_step "download local models (bge-m3 + bge-reranker-v2-m3)" $PY edk2-kb/fetchers/fetch_models.py
run_step "fetch UEFI spec sources" $PY edk2-kb/fetchers/fetch_specs.py
run_step "fetch tianocore/edk2 commit history" $PY edk2-kb/fetchers/fetch_commits.py
run_step "fetch tianocore/edk2 pull requests" $PY edk2-kb/fetchers/fetch_prs.py
run_step "build KB (wiki + tianocore-docs + specs/prs/commits)" $PY edk2-kb/fetchers/init_kb.py
run_step "add MdePkg (chunking + FTS5)" $PY edk2-kb/fetchers/add_mdepkg.py
if [ "$SKIP_EMBED" -eq 0 ]; then
    run_step "embed MdePkg into ChromaDB (slow)" $PY edk2-kb/fetchers/add_mdepkg.py --embed
else
    echo
    echo "Skipped embedding. Run later:"
    echo "  $PY edk2-kb/fetchers/add_mdepkg.py --embed"
fi

echo
echo "KB build complete. Start the daemon with:"
echo "  node bin/edk2-opencode.js daemon start"