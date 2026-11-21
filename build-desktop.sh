#!/bin/bash
set -euo pipefail
source "$(dirname -- "$0")/scripts/native-common.sh"
cd "$qiyi_root"
npm run build
"${qiyi_swift[@]}" build "${qiyi_swift_options[@]}" -c release
binary_dir="$("${qiyi_swift[@]}" build "${qiyi_swift_options[@]}" -c release --show-bin-path)"
cmake -S "$qiyi_root/apps/desktop/qt" -B "$qiyi_qt_build" -DCMAKE_BUILD_TYPE=Release "${qiyi_qt_options[@]}" "$@"
cmake --build "$qiyi_qt_build" --parallel

if [[ "$(uname -s)" == Darwin ]]; then
    app_dir="$qiyi_root/.local/desktop-build/Qiyi.app"
    rm -rf "$qiyi_root/.local/desktop-build"
    mkdir -p "$app_dir"
    /usr/bin/ditto "$qiyi_qt_build/Qiyi.app" "$app_dir"
    resource_dir="$app_dir/Contents/Resources"
    qt_plugins="$(qmake -query QT_INSTALL_PLUGINS)"
    mkdir -p "$app_dir/Contents/PlugIns/platforms" "$app_dir/Contents/PlugIns/imageformats" "$resource_dir/desktop/node_modules"
    cp "$qt_plugins/platforms/libqcocoa.dylib" "$app_dir/Contents/PlugIns/platforms/"
    cp "$qt_plugins/platforms/libqoffscreen.dylib" "$app_dir/Contents/PlugIns/platforms/"
    cp "$qt_plugins/imageformats/libqjpeg.dylib" "$app_dir/Contents/PlugIns/imageformats/"
    cat > "$resource_dir/qt.conf" <<'CONF'
[Paths]
Plugins = PlugIns
CONF
    macdeployqt "$app_dir" -no-plugins -codesign=- \
        -executable="$app_dir/Contents/PlugIns/platforms/libqcocoa.dylib" \
        -executable="$app_dir/Contents/PlugIns/platforms/libqoffscreen.dylib" \
        -executable="$app_dir/Contents/PlugIns/imageformats/libqjpeg.dylib" \
        > "$qiyi_root/.local/qt-deploy.log" 2>&1
    if grep -q '^ERROR:' "$qiyi_root/.local/qt-deploy.log"; then
        cat "$qiyi_root/.local/qt-deploy.log" >&2
        exit 1
    fi
    helper_dir="$app_dir/Contents/Helpers/QiyiCaptureService.app"
    mkdir -p "$helper_dir/Contents/MacOS"
    cp "$binary_dir/qiyi-capture-service" "$helper_dir/Contents/MacOS/"
    cp "$qiyi_capture_package/Resources/Info.plist" "$helper_dir/Contents/Info.plist"
    cp "$qiyi_root/dist/desktop/main.js" "$resource_dir/desktop/main.js"
    /usr/bin/ditto "$qiyi_root/node_modules/zod" "$resource_dir/desktop/node_modules/zod"
    cat > "$resource_dir/desktop/package.json" <<'JSON'
{"type":"module"}
JSON
    /usr/bin/codesign --force --sign - --identifier local.qiyi.capture \
        --requirements '=designated => identifier "local.qiyi.capture"' "$helper_dir"
    /usr/bin/codesign --force --sign - --identifier local.qiyi.desktop \
        --requirements '=designated => identifier "local.qiyi.desktop"' "$app_dir"
    /usr/bin/codesign --verify --deep --strict "$app_dir"
    rm -rf "$qiyi_root/Qiyi.app"
    /usr/bin/ditto "$app_dir" "$qiyi_root/Qiyi.app"
    echo "个人助手桌面端已生成：$qiyi_root/Qiyi.app"
else
    cp "$binary_dir/qiyi-capture-service" "$qiyi_qt_build/qiyi-capture-service"
    echo "个人助手桌面端已生成：$qiyi_qt_build/Qiyi"
fi
