#include "main_window.h"
#include "ui_theme.h"
#include <QApplication>
#include <QCommandLineParser>
#include <QDir>
#include <QFileInfo>
#include <QLockFile>
#include <QMessageBox>
#include <QFile>
#include <QJsonDocument>
#include <QStandardPaths>

int main(int argc, char **argv) {
#ifdef Q_OS_MACOS
    // Also support launching Contents/MacOS/Qiyi directly, when Qt's
    // bundle-resource discovery may not find Resources/qt.conf.
    const auto bundledPlugins = QDir(QFileInfo(QString::fromLocal8Bit(argv[0])).absolutePath()).absoluteFilePath("../PlugIns");
    if (QDir(bundledPlugins).exists()) QCoreApplication::addLibraryPath(bundledPlugins);
#endif
    QApplication app(argc, argv);
    QApplication::setApplicationName("Qiyi");
    QApplication::setOrganizationName("Qiyi");
    QApplication::setApplicationVersion("0.3.0");
    QiyiUi::applyTheme(app);

    QCommandLineParser parser;
    parser.setApplicationDescription("栖忆个人助手 — 截图、资料与记忆");
    parser.addHelpOption(); parser.addVersionOption();
    parser.addOption({"backend", "后端程序路径", "path"});
    parser.addOption({"backend-arg", "后端前置参数（可重复）", "argument"});
    parser.addOption({"data-dir", "资料保存目录", "directory"});
    parser.addOption({"local-dir", "本地个人记忆目录", "directory"});
    parser.addOption({"no-hotkey", "不注册全局截图快捷键（用于测试或多个资料库）"});
    parser.process(app);
    auto appDirectory = QDir(QCoreApplication::applicationDirPath());
    QString dataDirectory, localDirectory, backend, script, captureBackend;
    QStringList backendArguments;
#ifdef Q_OS_MACOS
    const auto assistantDirectory = QDir(appDirectory.filePath("../../.."));
    script = appDirectory.filePath("../Resources/desktop/main.js");
    captureBackend = appDirectory.filePath("../Helpers/QiyiCaptureService.app/Contents/MacOS/qiyi-capture-service");
#else
    const auto assistantDirectory = QDir(appDirectory.filePath("../.."));
    script = assistantDirectory.filePath("dist/desktop/main.js");
    captureBackend = appDirectory.filePath("qiyi-capture-service");
#ifdef Q_OS_WIN
    captureBackend += ".exe";
#endif
#endif
    dataDirectory = QDir::cleanPath(assistantDirectory.filePath("data/capture"));
    localDirectory = QDir::cleanPath(assistantDirectory.filePath("data/desktop"));
    if (parser.isSet("data-dir")) dataDirectory = QFileInfo(parser.value("data-dir")).absoluteFilePath();
    if (parser.isSet("local-dir")) localDirectory = QFileInfo(parser.value("local-dir")).absoluteFilePath();
    backend = QStandardPaths::findExecutable("node");
    if (backend.isEmpty()) {
        for (const auto &candidate : {QString("/opt/homebrew/bin/node"), QString("/usr/local/bin/node")})
            if (QFileInfo(candidate).isExecutable()) { backend = candidate; break; }
    }
    backendArguments = {script, "--capture-backend", captureBackend, "--local-directory", localDirectory};
    if (parser.isSet("backend")) backend = QFileInfo(parser.value("backend")).absoluteFilePath();
    if (parser.isSet("backend-arg")) backendArguments = parser.values("backend-arg");
    if (backend.isEmpty()) {
        QMessageBox::critical(nullptr, "需要 Node.js", "请安装 Node.js 24 或更新的受支持版本，再启动个人助手。"); return 1;
    }
    if (!QDir().mkpath(dataDirectory)) {
        QMessageBox::critical(nullptr, "无法打开资料目录", dataDirectory);
        return 1;
    }
    QLockFile lock(QDir(dataDirectory).filePath(".qiyi-desktop.lock"));
    if (!lock.tryLock()) {
        QMessageBox::warning(nullptr, "资料库已打开", "此资料目录已有 Qt 窗口正在使用，请切换到已打开的窗口。");
        return 1;
    }
    MainWindow window(backend, dataDirectory, !parser.isSet("no-hotkey"), nullptr, backendArguments);
    // The tray can request shutdown while the window is hidden for a screenshot.
    QObject::connect(&window, &MainWindow::shutdownComplete, &app, &QCoreApplication::quit, Qt::QueuedConnection);
    window.show();
    window.connectBackend();
    return app.exec();
}
