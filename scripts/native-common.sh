#!/bin/bash
# Shared by native build/test entry points; all paths belong to this repository.
qiyi_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
qiyi_capture_package="$qiyi_root/apps/capture"
qiyi_native_build="$qiyi_root/.local/native"
qiyi_qt_build="$qiyi_root/.local/qt"
qiyi_swift=(swift)
if [[ "$(uname -s)" == Darwin ]]; then qiyi_swift=(xcrun swift); fi
export CLANG_MODULE_CACHE_PATH="$qiyi_native_build/ModuleCache"
qiyi_swift_options=(--package-path "$qiyi_capture_package" --disable-sandbox --scratch-path "$qiyi_native_build"
    --cache-path "$qiyi_native_build/cache" --config-path "$qiyi_native_build/config"
    --security-path "$qiyi_native_build/security"
    -Xswiftc -module-cache-path -Xswiftc "$CLANG_MODULE_CACHE_PATH")
qiyi_qt_options=()
if command -v qmake >/dev/null 2>&1; then
    qiyi_qt_options=(-DCMAKE_PREFIX_PATH="$(qmake -query QT_INSTALL_PREFIX)")
fi
