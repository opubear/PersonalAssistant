#pragma once
#include "backend_client.h"
#include <QWidget>
#include <QJsonArray>

class QLabel;
class QPlainTextEdit;
class QPushButton;
class QTreeWidget;
class QTabWidget;
class ImagePreview;

class MemoryPanel final : public QWidget {
    Q_OBJECT
public:
    explicit MemoryPanel(BackendClient *client, QWidget *parent = nullptr);
    void initialize(const QJsonObject &state);
    void addFromSource(const QJsonObject &source);
    void refreshLocal();
signals:
    void message(const QString &text);
private:
    void refreshServer();
    void populate(QTreeWidget *tree, const QJsonArray &items, bool local);
    void showSelected();
    void edit(const QJsonObject &memory = {}, const QString &sourceId = {});
    void removeSelected();
    void prepareUpload();
    void previewUpload(const QJsonObject &preview);
    void configureServer();
    void showOriginal();
    void updateServer(const QJsonObject &state);
    void failure(const QString &error);
    QJsonObject selected() const;
    bool localSelected() const;
    BackendClient *client_;
    QTabWidget *tabs_;
    QTreeWidget *local_, *server_;
    QLabel *location_, *serverStatus_;
    ImagePreview *image_;
    QPlainTextEdit *detail_;
    QPushButton *edit_, *remove_, *upload_, *original_;
    QJsonObject serverSettings_;
    int localRevision_ = 0, serverRevision_ = 0, selectionRevision_ = 0;
};
