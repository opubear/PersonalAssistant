#!/bin/bash
set -euo pipefail
assistant_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
if [[ ! -d "$assistant_dir/Qiyi.app" ]]; then "$assistant_dir/build-desktop.sh"; fi
/usr/bin/open --env "PATH=$PATH" "$assistant_dir/Qiyi.app"
