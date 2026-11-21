#!/bin/bash
set -euo pipefail
source "$(dirname -- "$0")/scripts/native-common.sh"
cd "$qiyi_root"
mkdir -p "$qiyi_root/.local"
npm run typecheck
npm test
npm run build
testing_flags=()
if [[ "$(uname -s)" == Darwin ]]; then
    swift_usr="$(cd -- "$(dirname -- "$(xcrun --find swift)")/.." && pwd)"
    testing_plugin="$swift_usr/lib/swift/host/plugins/testing/libTestingMacros.dylib"
    if [[ -f "$testing_plugin" ]]; then testing_flags=(-Xswiftc -load-plugin-library -Xswiftc "$testing_plugin"); fi
fi
"${qiyi_swift[@]}" test "${qiyi_swift_options[@]}" --disable-xctest --enable-swift-testing "${testing_flags[@]}"
debug_bin="$("${qiyi_swift[@]}" build "${qiyi_swift_options[@]}" -c debug --show-bin-path)"
if [[ -x "$qiyi_native_build/out/Products/Debug/qiyi-capture-service" ]]; then
    export QIYI_TEST_BACKEND="$qiyi_native_build/out/Products/Debug/qiyi-capture-service"
else
    export QIYI_TEST_BACKEND="$debug_bin/qiyi-capture-service"
fi
export QIYI_FAKE_PI="$qiyi_root/apps/desktop/qt/tests/fake_pi.py"
export QIYI_DESKTOP_ENTRY="$qiyi_root/dist/desktop/main.js"
export QIYI_SERVER_ENTRY="$qiyi_root/dist/server/main.js"
export QIYI_DESKTOP_PREVIEW="$qiyi_root/.local/desktop-preview.png"
python3 -m unittest discover -s "$qiyi_root/apps/desktop/qt/tests" -p test_service.py -v
cmake -S "$qiyi_root/apps/desktop/qt" -B "$qiyi_qt_build" -DCMAKE_BUILD_TYPE=Release "${qiyi_qt_options[@]}"
cmake --build "$qiyi_qt_build" --parallel
ctest --test-dir "$qiyi_qt_build" --output-on-failure
