#include "main_window.h"
#include "ui_theme.h"
#include "image_preview.h"
#include <QAction>
#include <QFileInfo>
#include <QFile>
#include <QJsonDocument>
#include <QStandardPaths>
#include <QDialog>
#include <QDialogButtonBox>
#include <QComboBox>
#include <QTextBrowser>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QLineEdit>
#include <QLabel>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTreeWidget>
#include <QtTest>
#include <QTabWidget>
#include <QTcpServer>
#include <QHostAddress>
#include <QMenu>
#include <QSystemTrayIcon>

class FrontendTests : public QObject {
    Q_OBJECT
    QString service() const { return qEnvironmentVariable("QIYI_TEST_BACKEND"); }
private slots:
    void initTestCase() {
        QiyiUi::applyTheme(*qApp);
    }

    void imagePreviewFitsTheViewportWithoutDistortingTheOriginal() {
        ImagePreview preview;
        preview.resize(480, 300);
        preview.show();
        QPixmap original(1600, 900);
        original.fill(Qt::darkGreen);
        preview.setPreview(original);
        QTRY_COMPARE(preview.pixmap().size(), QSize(480, 270));
        preview.resize(240, 300);
        QTRY_COMPARE(preview.pixmap().size(), QSize(240, 135));
        preview.resize(640, 400);
        QTRY_COMPARE(preview.pixmap().size(), QSize(640, 360));
        preview.clearPreview();
        QVERIFY(preview.pixmap().isNull());
    }

    void settingsPreserveDraftAndKeepTheComposerVisible() {
        QTemporaryDir directory;
        MainWindow window(directory.filePath("unused-backend"), directory.path(), false);
        window.resize(980, 700);
        window.show();
        auto *settings = window.findChild<QWidget *>("settingsPanel");
        auto *toggle = window.findChild<QPushButton *>("settingsToggle");
        auto *input = window.findChild<QPlainTextEdit *>("messageInput");
        auto *send = window.findChild<QPushButton *>("askButton");
        QVERIFY(settings && toggle && input && send);
        QVERIFY(!settings->isVisible());
        QVERIFY(window.findChild<QWidget *>("conversationWelcome")->isVisible());
        QVERIFY(!window.findChild<QPlainTextEdit *>("agentProgress")->isVisible());
        const auto welcomePreview = qEnvironmentVariable("QIYI_WELCOME_PREVIEW");
        if (!welcomePreview.isEmpty()) QVERIFY(window.grab().save(welcomePreview));
        input->setPlainText("尚未发送的资料与问题");
        QTest::mouseClick(toggle, Qt::LeftButton);
        QTRY_VERIFY(settings->isVisible());
        const auto settingsPreview = qEnvironmentVariable("QIYI_SETTINGS_PREVIEW");
        if (!settingsPreview.isEmpty()) QVERIFY(window.grab().save(settingsPreview));
        QCOMPARE(window.width(), 980);
        const auto inputRect = QRect(input->mapTo(&window, QPoint()), input->size());
        const auto sendRect = QRect(send->mapTo(&window, QPoint()), send->size());
        QVERIFY(window.rect().contains(inputRect));
        QVERIFY(window.rect().contains(sendRect));
        QVERIFY(sendRect.right() < settings->mapTo(&window, QPoint()).x());
        QTest::mouseClick(toggle, Qt::LeftButton);
        QTRY_VERIFY(!settings->isVisible());
        QCOMPARE(input->toPlainText(), "尚未发送的资料与问题");
        window.close();
    }

    void statusMenuRestoresWindowAndStopsAllDesktopBackends() {
        const auto entry = qEnvironmentVariable("QIYI_DESKTOP_ENTRY");
        const auto fake = qEnvironmentVariable("QIYI_FAKE_PI");
        if (entry.isEmpty() || service().isEmpty() || fake.isEmpty()) QSKIP("Set desktop integration paths");
        QTemporaryDir directory;
        QJsonObject config{{"provider", "pi"}, {"executable", QStandardPaths::findExecutable("python3")},
                           {"arguments", QJsonArray{"-u", fake}}, {"basePrompt", "用中文回答"}};
        QFile settings(directory.filePath("agent-settings.json"));
        QVERIFY(settings.open(QIODevice::WriteOnly));
        settings.write(QJsonDocument(config).toJson());
        settings.close();
        MainWindow window(QStandardPaths::findExecutable("node"), directory.path(), false, nullptr,
                          {entry, "--capture-backend", service(), "--local-directory", directory.filePath("local")});
        auto *tray = window.findChild<QSystemTrayIcon *>("backgroundStatusTray");
        QVERIFY(tray);
        QVERIFY(!tray->icon().isNull());
        if (QSystemTrayIcon::isSystemTrayAvailable()) QVERIFY(tray->isVisible());
        auto *menu = tray->contextMenu();
        auto *backend = menu->findChild<QAction *>("backgroundBackendStatus");
        auto *agent = menu->findChild<QAction *>("backgroundAgentStatus");
        auto *open = menu->findChild<QAction *>("backgroundOpenWindow");
        auto *quit = menu->findChild<QAction *>("backgroundQuit");
        QVERIFY(backend && agent && open && quit);
        QVERIFY(!backend->isEnabled());
        QVERIFY(backend->text().contains("正在连接"));
        window.show(); window.connectBackend();
        QTRY_VERIFY_WITH_TIMEOUT(backend->text().contains("后端已连接"), 7000);
        if (QSystemTrayIcon::isSystemTrayAvailable()) {
            QTRY_VERIFY_WITH_TIMEOUT(!tray->geometry().isEmpty(), 3000);
        }
        QVERIFY(agent->text().contains("未启动") || agent->text().contains("已停止"));
        QTest::mouseClick(window.findChild<QPushButton *>("startAgentButton"), Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(agent->text().contains("已就绪"), 5000);
        QVERIFY(tray->toolTip().contains("后端已连接"));
        QVERIFY(tray->toolTip().contains("Agent 已就绪"));
        window.showMinimized();
        open->trigger();
        QTRY_VERIFY(window.isVisible() && !window.isMinimized());
        window.hide();
        open->trigger();
        QTRY_VERIFY(window.isVisible());
        // Exercise quit while hidden, as during delayed capture, with an Agent running.
        window.hide();
        auto *client = window.findChild<BackendClient *>();
        QVERIFY(client && client->isRunning());
        QSignalSpy stopped(client, &BackendClient::stopped);
        QSignalSpy shutdown(&window, &MainWindow::shutdownComplete);
        quit->trigger();
        QVERIFY(!quit->isEnabled());
        QVERIFY(backend->text().contains("正在停止"));
        QTRY_COMPARE_WITH_TIMEOUT(stopped.count(), 1, 7000);
        QTRY_COMPARE_WITH_TIMEOUT(shutdown.count(), 1, 7000);
        QVERIFY(!client->isRunning());
        QVERIFY(!tray->isVisible());
        QVERIFY(!window.isVisible());
    }

    void statusMenuReportsBackendStartFailure() {
        QTemporaryDir directory;
        MainWindow window(directory.filePath("does-not-exist"), directory.path(), false);
        auto *tray = window.findChild<QSystemTrayIcon *>("backgroundStatusTray");
        QVERIFY(tray);
        auto *backend = tray->contextMenu()->findChild<QAction *>("backgroundBackendStatus");
        QVERIFY(backend);
        window.show(); window.connectBackend();
        QTRY_VERIFY_WITH_TIMEOUT(backend->text().contains("后端未连接"), 3000);
        QVERIFY(tray->toolTip().contains("后端未连接"));
        QSignalSpy shutdown(&window, &MainWindow::shutdownComplete);
        tray->contextMenu()->findChild<QAction *>("backgroundQuit")->trigger();
        QCOMPARE(shutdown.count(), 1);
        QVERIFY(!tray->isVisible());
        QVERIFY(!window.isVisible());
    }

    void desktopKeepsMemoryLocalUntilExplicitUploadAndIncludesOriginal() {
        const auto entry = qEnvironmentVariable("QIYI_DESKTOP_ENTRY");
        const auto serverEntry = qEnvironmentVariable("QIYI_SERVER_ENTRY");
        if (entry.isEmpty() || serverEntry.isEmpty() || service().isEmpty()) QSKIP("Set desktop integration paths");
        QTemporaryDir directory;
        QTcpServer reservation;
        QVERIFY(reservation.listen(QHostAddress::LocalHost, 0));
        const auto port = reservation.serverPort(); reservation.close();
        QProcess server;
        auto environment = QProcessEnvironment::systemEnvironment();
        environment.insert("ENV_FILE", directory.filePath("empty.env"));
        environment.insert("MCP_ENV_FILE", directory.filePath("empty.env"));
        environment.insert("MCP_TOKEN", ""); environment.insert("MCP_URL", "");
        environment.insert("MODEL_BASE_URL", ""); environment.insert("MODEL_NAME", "");
        environment.insert("API_TOKEN", "desktop-test-token-at-least-32-characters");
        environment.insert("SERVER_HOST", "127.0.0.1"); environment.insert("SERVER_PORT", QString::number(port));
        environment.insert("DATABASE_PATH", directory.filePath("server.sqlite"));
        server.setProcessEnvironment(environment);
        const auto node = QStandardPaths::findExecutable("node");
        server.start(node, {serverEntry});
        QVERIFY(server.waitForStarted(5000));
        QVERIFY2(server.waitForReadyRead(5000), server.readAllStandardError().constData());
        MainWindow window(node, directory.path(), false, nullptr, {entry, "--capture-backend", service(), "--local-directory", directory.filePath("local")});
        window.show(); window.connectBackend();
        auto *save = window.findChild<QPushButton *>("saveTextButton");
        auto *input = window.findChild<QPlainTextEdit *>("messageInput");
        auto *library = window.findChild<QTreeWidget *>("libraryList");
        QTRY_VERIFY_WITH_TIMEOUT(save->isEnabled(), 7000);
        input->setPlainText("原始资料：我希望使用中文回答。LOCAL_ORIGINAL");
        QTest::mouseClick(save, Qt::LeftButton);
        QTRY_COMPARE_WITH_TIMEOUT(library->topLevelItemCount(), 1, 5000);
        library->setCurrentItem(library->topLevelItem(0));
        QTest::mouseClick(window.findChild<QPushButton *>("rememberSourceButton"), Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(window.findChild<QDialog *>("memoryEditor"), 5000);
        auto *editor = window.findChild<QDialog *>("memoryEditor");
        editor->findChild<QLineEdit *>("memoryTitle")->setText("中文交流偏好");
        editor->findChild<QComboBox *>("memoryStatus")->setCurrentIndex(1);
        QTest::mouseClick(editor->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save), Qt::LeftButton);
        auto *local = window.findChild<QTreeWidget *>("localMemoryList");
        auto *remote = window.findChild<QTreeWidget *>("serverMemoryList");
        QTRY_COMPARE_WITH_TIMEOUT(local->topLevelItemCount(), 1, 5000);
        QCOMPARE(local->topLevelItem(0)->text(2), "仅本地");
        local->setCurrentItem(local->topLevelItem(0));
        QTest::mouseClick(window.findChild<QPushButton *>("serverSettingsButton"), Qt::LeftButton);
        auto *settings = window.findChild<QDialog *>("serverConnectionDialog");
        QVERIFY(settings);
        settings->findChild<QLineEdit *>("serverUrl")->setText(QString("http://127.0.0.1:%1").arg(port));
        settings->findChild<QLineEdit *>("serverToken")->setText("desktop-test-token-at-least-32-characters");
        QTest::mouseClick(settings->findChild<QDialogButtonBox *>()->button(QDialogButtonBox::Save), Qt::LeftButton);
        auto *upload = window.findChild<QPushButton *>("uploadMemoryButton");
        QTRY_VERIFY_WITH_TIMEOUT(upload->isEnabled(), 5000);
        QTest::mouseClick(upload, Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(window.findChild<QDialog *>("uploadPreview"), 5000);
        auto *preview = window.findChild<QDialog *>("uploadPreview");
        QVERIFY(preview->findChild<QPlainTextEdit *>()->toPlainText().contains("LOCAL_ORIGINAL"));
        QVERIFY(preview->findChild<QPlainTextEdit *>()->toPlainText().contains("text/plain"));
        auto *buttons = preview->findChild<QDialogButtonBox *>();
        QVERIFY(buttons->button(QDialogButtonBox::Cancel)->isDefault());
        QCOMPARE(remote->topLevelItemCount(), 0);
        QTest::mouseClick(buttons->button(QDialogButtonBox::Ok), Qt::LeftButton);
        QTRY_COMPARE_WITH_TIMEOUT(local->topLevelItem(0)->text(2), "已上传此版本", 7000);
        QTest::mouseClick(window.findChild<QPushButton *>("loadServerMemoriesButton"), Qt::LeftButton);
        QTRY_COMPARE_WITH_TIMEOUT(remote->topLevelItemCount(), 1, 5000);
        QCOMPARE(remote->topLevelItem(0)->text(1), "中文交流偏好");
        QVERIFY(remote->topLevelItem(0)->data(0, Qt::UserRole).toJsonObject().contains("attachment"));
        remote->setCurrentItem(remote->topLevelItem(0));
        const auto previewPath = qEnvironmentVariable("QIYI_DESKTOP_PREVIEW");
        if (!previewPath.isEmpty()) QVERIFY(window.grab().save(previewPath));
        window.close();
        QTRY_VERIFY_WITH_TIMEOUT(!window.isVisible(), 7000);
        server.terminate(); QVERIFY(server.waitForFinished(5000));
    }

    void missingBackendReportsAnError() {
        BackendClient client;
        QTemporaryDir directory;
        QSignalSpy failed(&client, &BackendClient::disconnected);
        client.start(directory.filePath("does-not-exist"), directory.path(), false);
        QTRY_COMPARE_WITH_TIMEOUT(failed.count(), 1, 3000);
        QVERIFY(!client.isRunning());
    }

    void realBackendPersistsTextAndRepliesToConcurrentRequests() {
        if (service().isEmpty()) QSKIP("Set QIYI_TEST_BACKEND for service integration tests");
        BackendClient client;
        QTemporaryDir directory;
        QSignalSpy connected(&client, &BackendClient::connected);
        QSignalSpy stopped(&client, &BackendClient::stopped);
        client.start(service(), directory.path(), false);
        QTRY_COMPARE_WITH_TIMEOUT(connected.count(), 1, 5000);
        bool saved = false;
        QString id, error;
        client.request("library/addText", {{"text", "Qt 保存的原文\n第二行"}}, [&](const QJsonValue &value, const QString &failure) {
            id = value.toObject().value("id").toString(); error = failure; saved = true;
        });
        QTRY_VERIFY_WITH_TIMEOUT(saved, 5000);
        QVERIFY2(error.isEmpty(), qPrintable(error));
        QVERIFY(!id.isEmpty());
        int replies = 0;
        client.request("library/content", {{"id", id}}, [&](const QJsonValue &value, const QString &failure) {
            QVERIFY2(failure.isEmpty(), qPrintable(failure));
            QCOMPARE(value.toObject().value("text").toString(), "Qt 保存的原文\n第二行");
            ++replies;
        });
        client.request("library/list", {}, [&](const QJsonValue &value, const QString &failure) {
            QVERIFY2(failure.isEmpty(), qPrintable(failure));
            QCOMPARE(value.toArray().size(), 1);
            ++replies;
        });
        QTRY_COMPARE_WITH_TIMEOUT(replies, 2, 5000);
        QVERIFY(QFileInfo::exists(directory.filePath("library/index.json")));
        client.shutdown();
        QTRY_COMPARE_WITH_TIMEOUT(stopped.count(), 1, 7000);
    }

    void saveButtonAndLibrarySelectionUseTheBackend() {
        if (service().isEmpty()) QSKIP("Set QIYI_TEST_BACKEND for service integration tests");
        QTemporaryDir directory;
        MainWindow window(service(), directory.path(), false);
        window.show();
        window.connectBackend();
        auto *save = window.findChild<QPushButton *>("saveTextButton");
        auto *input = window.findChild<QPlainTextEdit *>("messageInput");
        auto *library = window.findChild<QTreeWidget *>("libraryList");
        auto *content = window.findChild<QPlainTextEdit *>("originalText");
        auto *ask = window.findChild<QPushButton *>("askButton");
        QVERIFY(save && input && library && content && ask);
        QTRY_VERIFY_WITH_TIMEOUT(save->isEnabled(), 5000);
        QVERIFY(!ask->isEnabled());
        auto *empty = window.findChild<QLabel *>("libraryEmptyState");
        QVERIFY(empty->isVisible());
        QVERIFY(empty->text().contains("还没有资料"));
        input->setPlainText("<script>这是资料原文，不是 HTML</script>");
        QTest::mouseClick(save, Qt::LeftButton);
        QTRY_COMPARE_WITH_TIMEOUT(library->topLevelItemCount(), 1, 5000);
        QVERIFY(!empty->isVisible());
        library->setCurrentItem(library->topLevelItem(0));
        QTRY_COMPARE_WITH_TIMEOUT(content->toPlainText(), "<script>这是资料原文，不是 HTML</script>", 5000);
        const auto preview = qEnvironmentVariable("QIYI_PREVIEW_PATH");
        if (!preview.isEmpty()) QVERIFY(window.grab().save(preview));
        window.findChild<QLineEdit *>("libraryFilter")->setText("不存在的概述");
        QVERIFY(library->topLevelItem(0)->isHidden());
        QVERIFY(empty->isVisible());
        QVERIFY(empty->text().contains("没有找到相关资料"));
        QVERIFY(!window.findChild<QPushButton *>("rememberSourceButton")->isEnabled());
        window.findChild<QLineEdit *>("libraryFilter")->clear();
        QVERIFY(!empty->isVisible());
        QVERIFY(library->isVisible());
        window.close();
        QTRY_VERIFY_WITH_TIMEOUT(!window.isVisible(), 7000);
    }

    void temporaryReaderSavesSummariesWithoutStartingThePersistentAgent() {
        const auto fake = qEnvironmentVariable("QIYI_FAKE_PI");
        if (service().isEmpty() || fake.isEmpty()) QSKIP("Set reader integration paths");
        QTemporaryDir directory;
        MainWindow window(service(), directory.path(), false);
        window.show(); window.connectBackend();
        auto *save = window.findChild<QPushButton *>("saveTextButton");
        QTRY_VERIFY_WITH_TIMEOUT(save->isEnabled(), 5000);
        QTest::mouseClick(window.findChild<QPushButton *>("settingsToggle"), Qt::LeftButton);
        window.findChild<QComboBox *>("readerProvider")->setCurrentText("pi");
        QVERIFY(!window.findChild<QComboBox *>("readerReasoningEffort")->isEnabled());
        window.findChild<QLineEdit *>("readerExecutable")->setText(QStandardPaths::findExecutable("python3"));
        const auto trace = directory.filePath("reader-trace.jsonl");
        window.findChild<QLineEdit *>("readerArguments")->setText(QString::fromUtf8(QJsonDocument(QJsonArray{"-u", fake, "--trace", trace}).toJson(QJsonDocument::Compact)));
        QTest::mouseClick(window.findChild<QPushButton *>("saveReaderSettingsButton"), Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(window.findChild<QLabel *>("readerStatus")->text().contains("已配置"), 5000);
        QVERIFY(!QFileInfo::exists(trace));
        QVERIFY(!QFileInfo::exists(directory.filePath("agent-settings.json")));
        QTest::mouseClick(window.findChild<QPushButton *>("settingsToggle"), Qt::LeftButton);
        window.findChild<QPlainTextEdit *>("messageInput")->setPlainText("TEMPORARY_READER_SOURCE");
        QTest::mouseClick(save, Qt::LeftButton);
        auto *library = window.findChild<QTreeWidget *>("libraryList");
        QTRY_COMPARE_WITH_TIMEOUT(library->topLevelItemCount(), 1, 5000);
        QTRY_COMPARE_WITH_TIMEOUT(library->topLevelItem(0)->text(0), "已整理", 5000);
        QVERIFY(window.findChild<QTextBrowser *>("transcript")->toPlainText().isEmpty());
        QVERIFY(!window.findChild<QPushButton *>("stopAgentButton")->isVisible());
        library->setCurrentItem(library->topLevelItem(0));
        QTRY_VERIFY_WITH_TIMEOUT(window.findChild<QPushButton *>("openSummaryButton")->isEnabled(), 5000);
        QVERIFY(window.findChild<QPushButton *>("summarizeButton")->isEnabled());
        const auto id = library->topLevelItem(0)->data(0, Qt::UserRole).toString();
        QVERIFY(QFileInfo::exists(directory.filePath("library/summaries/" + id + ".md")));
        window.close();
        QTRY_VERIFY_WITH_TIMEOUT(!window.isVisible(), 7000);
    }

    void agentInteractionRequiresAUserChoiceInTheQtDialog() {
        if (service().isEmpty() || qEnvironmentVariable("QIYI_FAKE_PI").isEmpty()) QSKIP("Set integration test paths");
        QTemporaryDir directory;
        QJsonObject config{{"provider", "pi"}, {"executable", QStandardPaths::findExecutable("python3")},
                           {"arguments", QJsonArray{"-u", qEnvironmentVariable("QIYI_FAKE_PI")}}, {"basePrompt", "用中文回答"}};
        QFile settings(directory.filePath("agent-settings.json"));
        QVERIFY(settings.open(QIODevice::WriteOnly));
        settings.write(QJsonDocument(config).toJson());
        settings.close();
        MainWindow window(service(), directory.path(), false);
        window.show(); window.connectBackend();
        auto *start = window.findChild<QPushButton *>("startAgentButton");
        auto *ask = window.findChild<QPushButton *>("askButton");
        auto *input = window.findChild<QPlainTextEdit *>("messageInput");
        auto *transcript = window.findChild<QTextBrowser *>("transcript");
        QTRY_VERIFY_WITH_TIMEOUT(start->isEnabled(), 5000);
        QTest::mouseClick(start, Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(ask->isEnabled(), 5000);
        input->setPlainText("要求审批");
        input->setFocus();
        QTest::keyClick(input, Qt::Key_Return, Qt::ControlModifier);
        QTRY_VERIFY_WITH_TIMEOUT(!window.findChildren<QDialog *>().isEmpty(), 5000);
        auto *dialog = window.findChildren<QDialog *>().first();
        auto *choices = dialog->findChild<QComboBox *>();
        auto *buttons = dialog->findChild<QDialogButtonBox *>();
        QCOMPARE(choices->currentIndex(), 0);
        QVERIFY(!buttons->button(QDialogButtonBox::Ok)->isEnabled());
        QVERIFY(!transcript->toPlainText().contains("用户选择"));
        choices->setCurrentIndex(2);
        QTest::mouseClick(buttons->button(QDialogButtonBox::Ok), Qt::LeftButton);
        QTRY_VERIFY_WITH_TIMEOUT(transcript->toPlainText().contains("用户选择：拒绝本次"), 5000);
        window.close();
        QTRY_VERIFY_WITH_TIMEOUT(!window.isVisible(), 7000);
    }
};

QTEST_MAIN(FrontendTests)
#include "test_frontend.moc"
