#include "memory_panel.h"
#include "image_preview.h"
#include <QComboBox>
#include <QDialog>
#include <QDialogButtonBox>
#include <QFormLayout>
#include <QFrame>
#include <QFile>
#include <QHeaderView>
#include <QImageReader>
#include <QLabel>
#include <QLineEdit>
#include <QMessageBox>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QPointer>
#include <QSplitter>
#include <QTabWidget>
#include <QTreeWidget>
#include <QVBoxLayout>

namespace {
QString categoryTitle(const QString &category) {
    const QHash<QString, QString> names{{"preference", "偏好"}, {"habit", "习惯"}, {"need", "需求"}, {"goal", "目标"}, {"background", "背景"}, {"boundary", "边界"}};
    return names.value(category, category);
}
QString describe(const QJsonObject &value) {
    return "标题：" + value.value("title").toString() + "\n类别：" + categoryTitle(value.value("category").toString()) +
        "\n概述：" + value.value("summary").toString() + "\n\n记忆正文：\n" + value.value("content").toString();
}
QTreeWidget *makeList() {
    auto *tree = new QTreeWidget;
    tree->setHeaderLabels({"状态", "标题", "保存位置"});
    tree->setRootIsDecorated(false);
    tree->setAlternatingRowColors(true);
    tree->setUniformRowHeights(true);
    tree->header()->setSectionResizeMode(0, QHeaderView::ResizeToContents);
    tree->header()->setSectionResizeMode(1, QHeaderView::Stretch);
    tree->header()->setSectionResizeMode(2, QHeaderView::ResizeToContents);
    return tree;
}
QString statusTitle(const QString &status) {
    return status == "confirmed" ? "已确认" : status == "proposed" ? "待确认" : "已忽略";
}
}

MemoryPanel::MemoryPanel(BackendClient *client, QWidget *parent) : QWidget(parent), client_(client) {
    setObjectName("personalMemoryPanel");
    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(14);
    auto *header = new QHBoxLayout;
    auto *titles = new QVBoxLayout;
    titles->setSpacing(5);
    auto *heading = new QLabel("留住对你有用的理解");
    heading->setProperty("role", "heading");
    auto *intro = new QLabel("新记忆先保存在本机；上传内容和关联原件由你预览、确认。");
    intro->setProperty("role", "muted");
    intro->setWordWrap(true);
    titles->addWidget(heading); titles->addWidget(intro);
    header->addLayout(titles, 1);
    auto *create = new QPushButton("＋ 新增记忆");
    create->setObjectName("newMemoryButton");
    create->setProperty("primary", true);
    connect(create, &QPushButton::clicked, this, [this] { edit(); });
    header->addWidget(create);
    layout->addLayout(header);
    auto *connection = new QHBoxLayout;
    serverStatus_ = new QLabel;
    serverStatus_->setTextFormat(Qt::PlainText);
    serverStatus_->setProperty("role", "muted");
    serverStatus_->setWordWrap(true);
    connection->addWidget(serverStatus_, 1);
    auto *settings = new QPushButton("服务器设置…");
    settings->setObjectName("serverSettingsButton");
    settings->setProperty("quiet", true);
    connect(settings, &QPushButton::clicked, this, &MemoryPanel::configureServer);
    connection->addWidget(settings); layout->addLayout(connection);
    auto *splitter = new QSplitter;
    splitter->setChildrenCollapsible(false);
    splitter->setHandleWidth(14);
    auto *listCard = new QFrame;
    listCard->setProperty("role", "card");
    auto *listLayout = new QVBoxLayout(listCard);
    listLayout->setContentsMargins(12, 12, 12, 12);
    listLayout->setSpacing(12);
    tabs_ = new QTabWidget;
    local_ = makeList(); local_->setObjectName("localMemoryList");
    server_ = makeList(); server_->setObjectName("serverMemoryList");
    tabs_->addTab(local_, "本地记忆"); tabs_->addTab(server_, "服务器记忆");
    listLayout->addWidget(tabs_, 1);
    auto *refresh = new QHBoxLayout;
    auto *localRefresh = new QPushButton("刷新本地");
    localRefresh->setProperty("quiet", true);
    auto *serverRefresh = new QPushButton("读取服务器记忆");
    serverRefresh->setObjectName("loadServerMemoriesButton");
    connect(localRefresh, &QPushButton::clicked, this, &MemoryPanel::refreshLocal);
    connect(serverRefresh, &QPushButton::clicked, this, &MemoryPanel::refreshServer);
    refresh->addWidget(localRefresh); refresh->addStretch(); refresh->addWidget(serverRefresh);
    listLayout->addLayout(refresh);
    splitter->addWidget(listCard);
    auto *details = new QFrame;
    details->setProperty("role", "card");
    auto *detailLayout = new QVBoxLayout(details);
    detailLayout->setContentsMargins(16, 18, 16, 14);
    detailLayout->setSpacing(12);
    auto *detailTitle = new QLabel("记忆详情");
    detailTitle->setProperty("role", "heading");
    detailLayout->addWidget(detailTitle);
    detail_ = new QPlainTextEdit; detail_->setReadOnly(true); detail_->setObjectName("memoryDetails");
    detailLayout->addWidget(detail_, 1);
    image_ = new ImagePreview;
    image_->setMaximumHeight(300);
    image_->hide();
    detailLayout->addWidget(image_);
    auto *buttons = new QHBoxLayout;
    const auto add = [&](const QString &title, auto handler) {
        auto *button = new QPushButton(title); buttons->addWidget(button);
        connect(button, &QPushButton::clicked, this, handler); return button;
    };
    edit_ = add("编辑 / 确认", [this] { edit(selected()); });
    edit_->setObjectName("editMemoryButton");
    remove_ = add("删除…", [this] { removeSelected(); });
    remove_->setProperty("danger", true);
    buttons->addStretch();
    original_ = add("查看原件", [this] { showOriginal(); });
    detailLayout->addLayout(buttons);
    upload_ = new QPushButton("上传所选记忆…");
    upload_->setObjectName("uploadMemoryButton");
    upload_->setProperty("primary", true);
    connect(upload_, &QPushButton::clicked, this, &MemoryPanel::prepareUpload);
    detailLayout->addWidget(upload_);
    splitter->addWidget(details);
    splitter->setSizes({560, 600});
    layout->addWidget(splitter, 1);
    location_ = new QLabel;
    location_->setTextFormat(Qt::PlainText);
    location_->setProperty("role", "muted");
    location_->setWordWrap(true);
    layout->addWidget(location_);
    connect(local_, &QTreeWidget::itemSelectionChanged, this, &MemoryPanel::showSelected);
    connect(server_, &QTreeWidget::itemSelectionChanged, this, &MemoryPanel::showSelected);
    connect(tabs_, &QTabWidget::currentChanged, this, &MemoryPanel::showSelected);
    connect(client_, &BackendClient::disconnected, this, [this] { setEnabled(false); });
    showSelected();
}

void MemoryPanel::initialize(const QJsonObject &state) {
    setEnabled(true);
    location_->setText("本地记忆目录：" + state.value("localDirectory").toString());
    updateServer(state.value("server").toObject()); refreshLocal();
}
void MemoryPanel::updateServer(const QJsonObject &state) {
    serverSettings_ = state;
    serverStatus_->setText(state.value("configured").toBool() ? "服务器：" + state.value("url").toString() + " · 仅手动上传" : "未连接服务器 · 本地功能可正常使用");
    if (!state.value("error").toString().isEmpty()) serverStatus_->setText(state.value("error").toString());
    showSelected();
}
void MemoryPanel::failure(const QString &error) { emit message(error); detail_->setPlainText(error); }
bool MemoryPanel::localSelected() const { return tabs_->currentIndex() == 0; }
QJsonObject MemoryPanel::selected() const {
    const auto *item = (localSelected() ? local_ : server_)->currentItem();
    return item ? item->data(0, Qt::UserRole).toJsonObject() : QJsonObject{};
}
void MemoryPanel::populate(QTreeWidget *tree, const QJsonArray &items, bool local) {
    const auto selectedId = tree->currentItem() ? tree->currentItem()->data(0, Qt::UserRole).toJsonObject().value("id").toString() : QString{};
    tree->clear();
    for (const auto &value : items) {
        const auto memory = value.toObject();
        auto *item = new QTreeWidgetItem(tree, {statusTitle(memory.value("status").toString()), memory.value("title").toString(), local ? memory.value("storage").toString("仅本地") : "服务器"});
        item->setData(0, Qt::UserRole, memory);
        if (memory.value("id").toString() == selectedId) tree->setCurrentItem(item);
    }
    showSelected();
}
void MemoryPanel::refreshLocal() {
    const auto revision = ++localRevision_;
    client_->request("memory/list", {}, [this, revision](const QJsonValue &value, const QString &error) {
        if (revision != localRevision_) return;
        if (!error.isEmpty()) failure(error); else populate(local_, value.toArray(), true);
    });
}
void MemoryPanel::refreshServer() {
    const auto revision = ++serverRevision_;
    client_->request("server/list", {}, [this, revision](const QJsonValue &value, const QString &error) {
        if (revision != serverRevision_) return;
        if (!error.isEmpty()) failure(error); else { populate(server_, value.toArray(), false); tabs_->setCurrentIndex(1); }
    });
}
void MemoryPanel::showSelected() {
    ++selectionRevision_;
    const auto memory = selected(); const bool exists = !memory.isEmpty();
    edit_->setEnabled(exists && localSelected()); remove_->setEnabled(exists);
    upload_->setEnabled(exists && localSelected() && memory.value("status").toString() == "confirmed" && serverSettings_.value("configured").toBool());
    original_->setEnabled(exists && (memory.contains("sourceId") || memory.contains("attachment")));
    image_->clearPreview(); image_->hide();
    detail_->setPlainText(exists ? describe(memory) + "\n\n" + (localSelected() ? memory.value("storage").toString() : "服务器副本") : "选择一条记忆查看内容。服务器列表只有点击读取后才加载。");
}

void MemoryPanel::edit(const QJsonObject &existing, const QString &sourceId) {
    auto *dialog = new QDialog(this); dialog->setAttribute(Qt::WA_DeleteOnClose);
    dialog->setObjectName("memoryEditor"); dialog->setWindowTitle("保存到本地记忆"); dialog->resize(650, 600);
    auto *layout = new QFormLayout(dialog);
    auto *title = new QLineEdit(existing.value("title").toString()); title->setObjectName("memoryTitle"); title->setMaxLength(160);
    auto *category = new QComboBox;
    const QStringList categories{"preference", "habit", "need", "goal", "background", "boundary"};
    const QStringList labels{"偏好", "习惯", "需求", "目标", "背景", "边界"};
    for (int i = 0; i < categories.size(); ++i) category->addItem(labels[i], categories[i]);
    category->setCurrentIndex(qMax(0, categories.indexOf(existing.value("category").toString())));
    auto *summary = new QPlainTextEdit(existing.value("summary").toString()); summary->setMaximumHeight(100);
    auto *content = new QPlainTextEdit(existing.value("content").toString()); content->setObjectName("memoryContent"); content->setMinimumHeight(180);
    auto *status = new QComboBox; status->setObjectName("memoryStatus");
    status->addItem("待确认", "proposed"); status->addItem("已确认", "confirmed"); status->addItem("已忽略", "rejected");
    status->setCurrentIndex(qMax(0, status->findData(existing.value("status").toString("proposed"))));
    layout->addRow("标题", title); layout->addRow("类别", category); layout->addRow("概述（最多 1200 字）", summary);
    layout->addRow("记忆正文（最多 4000 字）", content); layout->addRow("状态", status);
    auto *note = new QLabel(sourceId.isEmpty() ? "保存只影响本地。已有服务器副本不会自动更新。" : "关联原始资料，上传时会一并包含该原件。请确认这段内容确实适合作为个人记忆。");
    note->setWordWrap(true); layout->addRow(note);
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel); layout->addRow(buttons);
    buttons->button(QDialogButtonBox::Save)->setText("保存到本地");
    connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
    connect(buttons, &QDialogButtonBox::accepted, dialog, [=] {
        if (title->text().trimmed().isEmpty() || content->toPlainText().trimmed().isEmpty() || content->toPlainText().size() > 4000 || summary->toPlainText().size() > 1200) {
            QMessageBox::warning(dialog, "请检查记忆", "标题和正文不能为空，正文最多 4000 字，概述最多 1200 字。"); return;
        }
        QJsonObject memory{{"title", title->text()}, {"category", category->currentData().toString()}, {"summary", summary->toPlainText()},
            {"content", content->toPlainText()}, {"status", status->currentData().toString()}, {"tags", existing.value("tags").toArray()}, {"confidence", existing.value("confidence").toDouble(1)}};
        QJsonObject params{{"memory", memory}};
        if (existing.contains("id")) { params.insert("id", existing.value("id")); params.insert("revision", existing.value("revision")); }
        if (!sourceId.isEmpty()) params.insert("sourceId", sourceId);
        buttons->setEnabled(false);
        client_->request("memory/save", params, [this, dialog = QPointer<QDialog>(dialog), buttons](const QJsonValue &, const QString &error) {
            if (!dialog) return;
            buttons->setEnabled(true);
            if (!error.isEmpty()) { QMessageBox::warning(dialog, "保存失败", error); return; }
            dialog->accept(); refreshLocal(); emit message("记忆已保存到本地，未上传服务器。");
        });
    });
    dialog->open();
}

void MemoryPanel::addFromSource(const QJsonObject &source) {
    const auto item = source.value("item").toObject();
    const auto summary = item.value("summary").toString();
    const auto text = source.value("text").toString();
    const auto content = !summary.isEmpty() ? summary : text.size() <= 4000 ? text : QString{};
    edit({{"title", item.value("source").toString()}, {"summary", summary}, {"content", content}, {"category", "background"}, {"status", "proposed"}}, item.value("id").toString());
}
void MemoryPanel::removeSelected() {
    const auto memory = selected(); if (memory.isEmpty()) return;
    const bool local = localSelected();
    if (QMessageBox::question(this, "删除记忆", local ? "删除这条本地记忆？已上传的服务器副本和原始资料仍保留。" : "删除这条服务器记忆？本地副本仍保留。", QMessageBox::Yes | QMessageBox::Cancel, QMessageBox::Cancel) != QMessageBox::Yes) return;
    client_->request(local ? "memory/delete" : "server/delete", {{"id", memory.value("id")}, {"revision", memory.value("revision")}}, [this, local](const QJsonValue &, const QString &error) {
        if (!error.isEmpty()) failure(error); else if (local) refreshLocal(); else refreshServer();
    });
}
void MemoryPanel::prepareUpload() {
    const auto memory = selected(); if (memory.isEmpty() || !localSelected()) return;
    upload_->setEnabled(false);
    client_->request("upload/prepare", {{"id", memory.value("id")}, {"revision", memory.value("revision")}}, [this](const QJsonValue &value, const QString &error) {
        showSelected();
        if (!error.isEmpty()) failure(error); else previewUpload(value.toObject());
    });
}
void MemoryPanel::previewUpload(const QJsonObject &preview) {
    auto *dialog = new QDialog(this); dialog->setAttribute(Qt::WA_DeleteOnClose); dialog->setObjectName("uploadPreview");
    dialog->setWindowTitle("确认上传内容"); dialog->resize(720, 680); auto *layout = new QVBoxLayout(dialog);
    auto *text = new QPlainTextEdit; text->setReadOnly(true);
    QString description = "目标服务器：" + preview.value("target").toString() + "\n本地版本：" + QString::number(preview.value("localRevision").toInt()) + "\n\n" + describe(preview.value("memory").toObject());
    if (preview.value("retry").toBool()) description += "\n\n这是上次未完成上传的原始快照；确认后手动重试。";
    if (preview.contains("previous")) description += "\n\n将替换的服务器内容：\n" + describe(preview.value("previous").toObject());
    const auto attachment = preview.value("attachment").toObject();
    description += attachment.isEmpty() ? "\n\n无关联原件。" : "\n\n一并上传原件：" + attachment.value("mimeType").toString() + " · " + QString::number(attachment.value("size").toDouble() / 1024.0, 'f', 1) + " KB";
    text->setPlainText(description); layout->addWidget(text, 1);
    if (attachment.value("mimeType").toString() == "text/plain") {
        QFile original(attachment.value("path").toString());
        if (original.open(QIODevice::ReadOnly)) text->appendPlainText("\n关联文本原件：\n" + QString::fromUtf8(original.readAll()));
    }
    if (attachment.value("mimeType").toString().startsWith("image/")) {
        auto *image = new QLabel; image->setAlignment(Qt::AlignCenter); QImageReader reader(attachment.value("path").toString());
        if (reader.size().isValid()) reader.setScaledSize(reader.size().scaled(600, 240, Qt::KeepAspectRatio));
        image->setPixmap(QPixmap::fromImage(reader.read())); layout->addWidget(image);
    }
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel); layout->addWidget(buttons);
    buttons->button(QDialogButtonBox::Ok)->setText("确认上传记忆与原件"); buttons->button(QDialogButtonBox::Ok)->setAutoDefault(false);
    buttons->button(QDialogButtonBox::Cancel)->setDefault(true);
    connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
    connect(buttons, &QDialogButtonBox::accepted, dialog, [=] {
        buttons->setEnabled(false);
        client_->request("upload/commit", {{"id", preview.value("id")}}, [this, dialog = QPointer<QDialog>(dialog)](const QJsonValue &, const QString &error) {
            if (dialog) dialog->accept();
            refreshLocal();
            if (!error.isEmpty()) failure("上传未完成：" + error + "。可再次选择上传以查看快照并手动重试。");
            else emit message("所选记忆及关联原件已上传。其他本地资料未上传。");
        });
    });
    dialog->open();
}
void MemoryPanel::configureServer() {
    auto *dialog = new QDialog(this); dialog->setAttribute(Qt::WA_DeleteOnClose); dialog->setWindowTitle("个人助手服务器");
    dialog->setObjectName("serverConnectionDialog");
    auto *layout = new QFormLayout(dialog);
    auto *url = new QLineEdit(serverSettings_.value("url").toString()); url->setPlaceholderText("https://assistant.example.com");
    url->setObjectName("serverUrl");
    auto *token = new QLineEdit; token->setEchoMode(QLineEdit::Password); token->setPlaceholderText("API_TOKEN；地址不变时留空保留原凭证");
    token->setObjectName("serverToken");
    layout->addRow("服务器地址", url); layout->addRow("访问凭证", token);
    auto *note = new QLabel("保存配置不会上传资料。截图与对话仍使用本地资料库。凭证保存在本机配置文件中。"); note->setWordWrap(true); layout->addRow(note);
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Save | QDialogButtonBox::Cancel); layout->addRow(buttons);
    connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
    connect(buttons, &QDialogButtonBox::accepted, dialog, [=] {
        client_->request("server/configure", {{"url", url->text().trimmed()}, {"token", token->text().trimmed()}}, [this, dialog = QPointer<QDialog>(dialog)](const QJsonValue &value, const QString &error) {
            if (!error.isEmpty()) { failure(error); return; }
            ++serverRevision_; server_->clear(); updateServer(value.toObject()); refreshLocal(); if (dialog) dialog->accept();
        });
    });
    auto *disconnect = new QPushButton("移除本机服务器连接"); layout->addRow(disconnect);
    connect(disconnect, &QPushButton::clicked, dialog, [this, dialog] {
        client_->request("server/disconnect", {}, [this, dialog = QPointer<QDialog>(dialog)](const QJsonValue &, const QString &error) {
            if (!error.isEmpty()) { failure(error); return; }
            ++serverRevision_; server_->clear(); updateServer({}); refreshLocal(); if (dialog) dialog->accept();
        });
    });
    dialog->open();
}
void MemoryPanel::showOriginal() {
    const auto memory = selected(); if (memory.isEmpty()) return;
    const auto revision = selectionRevision_;
    if (localSelected()) {
        client_->request("library/content", {{"id", memory.value("sourceId")}}, [this, revision](const QJsonValue &value, const QString &error) {
            if (revision != selectionRevision_) return;
            if (!error.isEmpty()) { failure(error); return; }
            const auto source = value.toObject();
            if (source.contains("text")) detail_->appendPlainText("\n原始资料：\n" + source.value("text").toString());
            else { QImageReader reader(source.value("path").toString()); if (reader.size().isValid()) reader.setScaledSize(reader.size().scaled(1040, 600, Qt::KeepAspectRatio)); image_->setPreview(QPixmap::fromImage(reader.read())); image_->show(); }
        });
    } else {
        client_->request("server/attachment", {{"id", memory.value("id")}}, [this, revision](const QJsonValue &value, const QString &error) {
            if (revision != selectionRevision_) return;
            if (!error.isEmpty()) { failure(error); return; }
            const auto record = value.toObject(); const auto bytes = QByteArray::fromBase64(record.value("data").toString().toLatin1());
            if (record.value("mimeType").toString() == "text/plain") detail_->appendPlainText("\n服务器原件：\n" + QString::fromUtf8(bytes));
            else { QPixmap pixmap; if (!pixmap.loadFromData(bytes)) { failure("服务器图片无法预览"); return; } image_->setPreview(pixmap); image_->show(); }
        });
    }
}
