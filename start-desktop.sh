#!/bin/bash
set -euo pipefail
assistant_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
if [[ "$(uname -s)" == Darwin ]]; then exec "$assistant_dir/start-desktop.command"; fi
exec "$assistant_dir/.local/qt/Qiyi" --backend "$(command -v node)" \
    --backend-arg "$assistant_dir/dist/desktop/main.js" \
    --backend-arg=--capture-backend --backend-arg "$assistant_dir/.local/qt/qiyi-capture-service" \
    --backend-arg=--local-directory --backend-arg "$assistant_dir/data/desktop" \
    --data-dir "$assistant_dir/data/capture"
