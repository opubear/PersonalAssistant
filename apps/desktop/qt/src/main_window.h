#pragma once
#include "backend_client.h"
#include <QMainWindow>
#include <QPointer>
#include <QJsonArray>

class QComboBox;
class QDialog;
class QLabel;
class QLineEdit;
class QPlainTextEdit;
class QPushButton;
class QTextBrowser;
class QTreeWidget;
class QTabWidget;
class QScrollArea;
class QStackedWidget;
class MemoryPanel;
class ImagePreview;
class QAction;
class QSystemTrayIcon;

class MainWindow final : public QMainWindow {
    Q_OBJECT
public:
    MainWindow(QString backend, QString directory, bool hotkey = true, QWidget *parent = nullptr, QStringList backendArguments = {});
    void connectBackend();
signals:
    void shutdownComplete();
protected:
    void closeEvent(QCloseEvent *event) override;
private:
    void buildInterface();
    void buildStatusTray();
    void updateBackgroundStatus();
    void showMainWindow();
    QWidget *makeLibrary();
    QWidget *makeConversation();
    QWidget *makeSettings();
    void initialize(const QJsonObject &state);
    void handleEvent(const QString &name, const QJsonObject &data);
    void refreshLibrary();
    void showSelected();
    void submitText(bool asQuestion);
    void importImages();
    void summarizeSelected();
    void startAgent();
    void saveReaderSettings();
    void showReaderState(const QJsonObject &state);
    void setAgentState(const QString &state);
    void showPermissions(const QJsonObject &permissions);
    void captureLater();
    void appendMessage(const QString &heading, const QString &text);
    void showFailure(const QString &message);
    void showInteraction(const QJsonObject &request);
    void cancelInteraction(const QString &id);
    QString selectedID() const;
    void filterLibrary();
    void updateLibraryActions();
    void updateProgress(const QString &text);
    static QString sourceList(const QJsonArray &sources);

    BackendClient client_;
    QString backend_, directory_, contentPath_, summaryPath_, activeState_ = "stopped";
    QStringList backendArguments_;
    QTabWidget *workspaceTabs_ = nullptr;
    QWidget *settingsPanel_ = nullptr;
    QStackedWidget *conversationStack_ = nullptr;
    QStackedWidget *libraryStack_ = nullptr;
    MemoryPanel *memories_ = nullptr;
    QPushButton *remember_ = nullptr;
    bool hotkey_, closing_ = false, ready_ = false, askPending_ = false, starting_ = false;
    bool readerConfigured_ = false;
    int libraryRevision_ = 0, contentRevision_ = 0;
    QTreeWidget *library_ = nullptr;
    QLineEdit *filter_ = nullptr, *executable_ = nullptr, *arguments_ = nullptr;
    QComboBox *provider_ = nullptr;
    QComboBox *readerProvider_ = nullptr, *readerEffort_ = nullptr;
    QLineEdit *readerExecutable_ = nullptr, *readerArguments_ = nullptr;
    QPlainTextEdit *basePrompt_ = nullptr, *input_ = nullptr, *content_ = nullptr;
    QTextBrowser *transcript_ = nullptr;
    ImagePreview *image_ = nullptr;
    QLabel *summary_ = nullptr, *connection_ = nullptr, *agentStatus_ = nullptr, *permissionStatus_ = nullptr;
    QLabel *libraryCount_ = nullptr, *libraryEmpty_ = nullptr, *composerHint_ = nullptr;
    QLabel *readerStatus_ = nullptr;
    QPlainTextEdit *progress_ = nullptr;
    QTabWidget *tabs_ = nullptr;
    QScrollArea *imageScroll_ = nullptr;
    QPushButton *start_ = nullptr, *stop_ = nullptr, *ask_ = nullptr, *save_ = nullptr, *capture_ = nullptr, *reconnect_ = nullptr;
    QPushButton *accessibility_ = nullptr, *screenRecording_ = nullptr;
    QPushButton *summarize_ = nullptr, *openOriginal_ = nullptr;
    QPushButton *saveReader_ = nullptr, *openSummary_ = nullptr;
    QHash<QString, QPointer<QDialog>> interactions_;
    QSystemTrayIcon *statusTray_ = nullptr;
    QAction *backgroundStatus_ = nullptr, *backgroundAgent_ = nullptr, *backgroundQuit_ = nullptr;
};
