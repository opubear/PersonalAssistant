#include "backend_client.h"
#include <QJsonDocument>
#include <QTimer>

BackendClient::BackendClient(QObject *parent) : QObject(parent) {
    connect(&process_, &QProcess::readyReadStandardOutput, this, &BackendClient::consume);
    connect(&process_, &QProcess::readyReadStandardError, this, [this] {
        diagnostics_ += process_.readAllStandardError();
        diagnostics_ = diagnostics_.right(8192);
    });
    connect(&process_, &QProcess::started, this, [this] {
        request("initialize", {}, [this](const QJsonValue &value, const QString &error) {
            if (!error.isEmpty()) { emit disconnected(error); shutdown(); return; }
            const auto initial = value.toObject();
            if (initial.value("protocolVersion").toInt() != 1) {
                emit disconnected("后端接口版本不兼容，请重新构建。");
                shutdown();
                return;
            }
            emit connected(initial);
        });
    });
    connect(&process_, &QProcess::errorOccurred, this, [this](QProcess::ProcessError error) {
        if (error != QProcess::FailedToStart) return;
        const auto message = "无法启动后端：" + process_.errorString();
        failPending(message);
        emit disconnected(message);
        emit stopped();
    });
    connect(&process_, qOverload<int, QProcess::ExitStatus>(&QProcess::finished), this, [this](int code, QProcess::ExitStatus) {
        consume();
        const auto message = QString("后端已退出（%1）。\n%2").arg(code).arg(QString::fromUtf8(diagnostics_));
        failPending(message);
        if (!closing_) emit disconnected(message);
        emit stopped();
    });
}

BackendClient::~BackendClient() {
    // Normal UI shutdown waits asynchronously. This is only the destruction
    // fallback, and gives the service time to stop its own agent children.
    process_.disconnect(this);
    pending_.clear();
    if (process_.state() != QProcess::NotRunning) {
        process_.closeWriteChannel();
        if (!process_.waitForFinished(3500)) { process_.kill(); process_.waitForFinished(1000); }
    }
}

void BackendClient::start(const QString &executable, const QString &directory, bool hotkey, const QStringList &prefix) {
    if (process_.state() != QProcess::NotRunning) return;
    closing_ = false;
    buffer_.clear(); diagnostics_.clear();
    QStringList arguments = prefix;
    arguments << "--directory" << directory;
    if (!hotkey) arguments << "--no-hotkey";
    process_.setWorkingDirectory(directory);
    process_.start(executable, arguments);
}

bool BackendClient::isRunning() const { return process_.state() == QProcess::Running; }

void BackendClient::request(const QString &method, const QJsonObject &params, Reply reply) {
    if (!isRunning() || closing_) {
        if (reply) reply({}, "后端未连接。");
        return;
    }
    const auto id = QString::number(++sequence_);
    pending_.insert(id, std::move(reply));
    const auto record = QJsonDocument(QJsonObject{{"id", id}, {"method", method}, {"params", params}}).toJson(QJsonDocument::Compact) + '\n';
    if (process_.write(record) == -1) {
        const auto callback = pending_.take(id);
        if (callback) callback({}, process_.errorString());
    }
}

void BackendClient::consume() {
    buffer_ += process_.readAllStandardOutput();
    qsizetype newline;
    while ((newline = buffer_.indexOf('\n')) >= 0) {
        const auto line = buffer_.left(newline);
        buffer_.remove(0, newline + 1);
        if (line.trimmed().isEmpty()) continue;
        QJsonParseError error;
        const auto document = QJsonDocument::fromJson(line, &error);
        if (error.error != QJsonParseError::NoError || !document.isObject()) {
            emit disconnected("后端返回了无效数据：" + error.errorString());
            shutdown();
            return;
        }
        const auto record = document.object();
        if (record.contains("event")) {
            emit eventReceived(record.value("event").toString(), record.value("data").toObject());
        } else {
            const auto callback = pending_.take(record.value("id").toString());
            if (callback) callback(record.value("result"), record.value("error").toObject().value("message").toString());
        }
    }
    if (buffer_.size() > 64 * 1024 * 1024) {
        emit disconnected("后端单条数据超过限制，连接已停止。");
        shutdown();
    }
}

void BackendClient::failPending(const QString &reason) {
    auto callbacks = std::move(pending_);
    pending_.clear();
    for (const auto &callback : callbacks) if (callback) callback({}, reason);
}

void BackendClient::shutdown() {
    if (closing_) return;
    if (isRunning()) request("shutdown", {});
    closing_ = true;
    process_.closeWriteChannel();
    // The service normally exits after 2.5 seconds of agent cleanup.
    QTimer::singleShot(6000, this, [this] {
        if (closing_ && process_.state() != QProcess::NotRunning) process_.kill();
    });
}
