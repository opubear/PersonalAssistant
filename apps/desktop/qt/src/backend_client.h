#pragma once
#include <QHash>
#include <QJsonObject>
#include <QObject>
#include <QProcess>
#include <functional>

class BackendClient final : public QObject {
    Q_OBJECT
public:
    using Reply = std::function<void(const QJsonValue &, const QString &)>;
    explicit BackendClient(QObject *parent = nullptr);
    ~BackendClient() override;
    void start(const QString &executable, const QString &directory, bool hotkey = true, const QStringList &prefix = {});
    void request(const QString &method, const QJsonObject &params, Reply reply = {});
    void shutdown();
    bool isRunning() const;
signals:
    void connected(const QJsonObject &initialState);
    void eventReceived(const QString &name, const QJsonObject &data);
    void disconnected(const QString &reason);
    void stopped();
private:
    void consume();
    void failPending(const QString &reason);
    QProcess process_;
    QByteArray buffer_;
    QByteArray diagnostics_;
    QHash<QString, Reply> pending_;
    quint64 sequence_ = 0;
    bool closing_ = false;
};
