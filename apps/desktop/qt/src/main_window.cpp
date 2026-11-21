#include "main_window.h"
#include "memory_panel.h"
#include "image_preview.h"
#include "ui_theme.h"
#include <QAction>
#include <QCloseEvent>
#include <QComboBox>
#include <QDesktopServices>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDateTime>
#include <QFileDialog>
#include <QFormLayout>
#include <QFrame>
#include <QGroupBox>
#include <QHeaderView>
#include <QImageReader>
#include <QJsonDocument>
#include <QLabel>
#include <QLineEdit>
#include <QMenu>
#include <QPainter>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QScrollArea>
#include <QShortcut>
#include <QSignalBlocker>
#include <QSplitter>
#include <QStackedWidget>
#include <QStyledItemDelegate>
#include <QStyle>
#include <QStatusBar>
#include <QSystemTrayIcon>
#include <QTabWidget>
#include <QTextBrowser>
#include <QTimer>
#include <QTreeWidget>
#include <QUrl>
#include <QVBoxLayout>

namespace {
QString defaultArguments(const QString &provider) {
    if (provider == "pi") return R"(["--mode","rpc"])";
    if (provider == "dsh") return R"(["--profile","acp"])";
    return R"(["app-server"])";
}
QLabel *wrapped(const QString &text) {
    auto *label = new QLabel(text);
    label->setWordWrap(true);
    label->setTextFormat(Qt::PlainText);
    return label;
}

QJsonObject launchConfiguration(const QString &provider, const QString &executable, const QString &arguments,
                                const QString &prompt, QString &error) {
    QJsonParseError parseError;
    const auto document = QJsonDocument::fromJson(arguments.toUtf8(), &parseError);
    if (parseError.error != QJsonParseError::NoError || !document.isArray()) {
        error = "启动参数必须是 JSON 字符串数组。"; return {};
    }
    for (const auto &value : document.array()) if (!value.isString()) {
        error = "启动参数中的每一项都必须是字符串。"; return {};
    }
    if (executable.trimmed().isEmpty()) { error = "请填写启动程序。"; return {}; }
    return {{"provider", provider}, {"executable", executable.trimmed()},
            {"arguments", document.array()}, {"basePrompt", prompt}};
}

// Keep native selection and keyboard behavior while giving each source a readable second line.
class LibraryItemDelegate final : public QStyledItemDelegate {
public:
    using QStyledItemDelegate::QStyledItemDelegate;
    QSize sizeHint(const QStyleOptionViewItem &option, const QModelIndex &index) const override {
        return {QStyledItemDelegate::sizeHint(option, index).width(), 66};
    }
    void paint(QPainter *painter, const QStyleOptionViewItem &option, const QModelIndex &index) const override {
        if (index.column() == 0) { QStyledItemDelegate::paint(painter, option, index); return; }
        QStyleOptionViewItem background(option);
        initStyleOption(&background, index);
        background.text.clear();
        const auto *style = option.widget->style();
        style->drawControl(QStyle::CE_ItemViewItem, &background, painter, option.widget);
        painter->save();
        const auto rect = option.rect.adjusted(7, 10, -9, -9);
        auto font = option.font;
        font.setWeight(QFont::Medium);
        painter->setFont(font);
        painter->setPen(QColor("#304c3d"));
        painter->drawText(rect, Qt::AlignLeft | Qt::AlignTop,
                          QFontMetrics(font).elidedText(index.data().toString(), Qt::ElideRight, rect.width()));
        font.setPixelSize(11);
        font.setWeight(QFont::Normal);
        painter->setFont(font);
        painter->setPen(QColor("#7a8d80"));
        painter->drawText(rect, Qt::AlignLeft | Qt::AlignBottom,
                          QFontMetrics(font).elidedText(index.data(Qt::UserRole + 1).toString(), Qt::ElideRight, rect.width()));
        painter->restore();
    }
};
}

MainWindow::MainWindow(QString backend, QString directory, bool hotkey, QWidget *parent, QStringList backendArguments)
    : QMainWindow(parent), client_(this), backend_(std::move(backend)), directory_(std::move(directory)), backendArguments_(std::move(backendArguments)), hotkey_(hotkey) {
    setWindowTitle("栖忆个人助手 · 截图、资料与记忆");
    resize(1280, 820);
    setMinimumSize(980, 700);
    buildInterface();
    buildStatusTray();
    connect(&client_, &BackendClient::connected, this, &MainWindow::initialize);
    connect(&client_, &BackendClient::eventReceived, this, &MainWindow::handleEvent);
    connect(&client_, &BackendClient::disconnected, this, [this](const QString &error) {
        ready_ = false;
        connection_->setText("后端未连接");
        QiyiUi::setStatusTone(connection_, "warning");
        reconnect_->setEnabled(true);
        capture_->setEnabled(false);
        save_->setEnabled(false);
        saveReader_->setEnabled(false);
        setAgentState("stopped");
        const auto ids = interactions_.keys();
        for (const auto &id : ids) cancelInteraction(id);
        if (!closing_) showFailure(error);
    });
    connect(&client_, &BackendClient::stopped, this, [this] { if (closing_) close(); });
}

void MainWindow::buildStatusTray() {
    // Draw a template icon so the system can adapt it to light and dark menu bars.
    QPixmap pixels(44, 44);
    pixels.setDevicePixelRatio(2);
    pixels.fill(Qt::transparent);
    QPainter painter(&pixels);
    painter.setRenderHint(QPainter::Antialiasing);
    painter.setPen(QPen(Qt::black, 2.2, Qt::SolidLine, Qt::RoundCap));
    painter.drawEllipse(QRectF(4, 3, 13, 13));
    painter.drawLine(QPointF(13, 13), QPointF(19, 19));
    painter.end();
    QIcon icon(pixels);
#ifdef Q_OS_MACOS
    icon.setIsMask(true);
#endif
    statusTray_ = new QSystemTrayIcon(icon, this);
    statusTray_->setObjectName("backgroundStatusTray");
    auto *menu = new QMenu(this);
    menu->addAction("栖忆个人助手")->setEnabled(false);
    backgroundStatus_ = menu->addAction(QString{});
    backgroundStatus_->setObjectName("backgroundBackendStatus");
    backgroundStatus_->setEnabled(false);
    backgroundAgent_ = menu->addAction(QString{});
    backgroundAgent_->setObjectName("backgroundAgentStatus");
    backgroundAgent_->setEnabled(false);
    menu->addSeparator();
    auto *open = menu->addAction("打开主窗口");
    open->setObjectName("backgroundOpenWindow");
    connect(open, &QAction::triggered, this, &MainWindow::showMainWindow);
    backgroundQuit_ = menu->addAction("退出栖忆（停止后台服务）");
    backgroundQuit_->setObjectName("backgroundQuit");
    connect(backgroundQuit_, &QAction::triggered, this, [this] { close(); });
    statusTray_->setContextMenu(menu);
    connect(statusTray_, &QSystemTrayIcon::activated, this, [this](QSystemTrayIcon::ActivationReason reason) {
        if (reason == QSystemTrayIcon::DoubleClick) showMainWindow();
    });
    updateBackgroundStatus();
    if (QSystemTrayIcon::isSystemTrayAvailable()) statusTray_->show();
}

void MainWindow::updateBackgroundStatus() {
    backgroundStatus_->setText(closing_ ? "后台：正在停止…" : "后台：" + connection_->text());
    backgroundAgent_->setText(agentStatus_->text());
    backgroundQuit_->setEnabled(!closing_);
    statusTray_->setToolTip("栖忆个人助手\n" + backgroundStatus_->text() + "\n" + backgroundAgent_->text());
}

void MainWindow::showMainWindow() {
    if (isMinimized()) showNormal();
    else show();
    raise();
    activateWindow();
}

void MainWindow::buildInterface() {
    auto *shell = new QWidget;
    shell->setObjectName("appShell");
    auto *layout = new QVBoxLayout(shell);
    layout->setContentsMargins(24, 20, 24, 4);
    layout->setSpacing(20);
    auto *toolbar = new QHBoxLayout;
    toolbar->setSpacing(12);
    auto *mark = new QLabel("栖");
    mark->setObjectName("brandMark");
    mark->setAlignment(Qt::AlignCenter);
    mark->setFixedSize(40, 40);
    toolbar->addWidget(mark);
    auto *brand = new QVBoxLayout;
    brand->setSpacing(2);
    auto *title = new QLabel("栖忆");
    title->setProperty("role", "title");
    auto *subtitle = new QLabel("收集片刻，积累理解");
    subtitle->setProperty("role", "muted");
    brand->addWidget(title); brand->addWidget(subtitle);
    toolbar->addLayout(brand);
    toolbar->addStretch();
    connection_ = new QLabel("正在连接后端…");
    connection_->setObjectName("backendStatus");
    connection_->setToolTip("资料库和个人记忆保存在本机。");
    connection_->setProperty("tone", "neutral");
    toolbar->addWidget(connection_, 0, Qt::AlignVCenter);
    capture_ = new QPushButton("截取窗口 · 3 秒");
    capture_->setObjectName("captureButton");
    capture_->setProperty("primary", true);
    capture_->setEnabled(false);
    capture_->setToolTip("窗口会暂时隐藏，请切换到目标窗口。也可以随时按 Control + Option + S。");
    connect(capture_, &QPushButton::clicked, this, &MainWindow::captureLater);
    toolbar->addWidget(capture_);
    auto *settings = new QPushButton("设置");
    settings->setObjectName("settingsToggle");
    settings->setProperty("quiet", true);
    settings->setCheckable(true);
    toolbar->addWidget(settings);
    layout->addLayout(toolbar);

    auto *root = new QWidget;
    auto *workspace = new QHBoxLayout(root);
    workspace->setContentsMargins(0, 0, 0, 0);
    auto *splitter = new QSplitter;
    splitter->setObjectName("librarySplitter");
    splitter->setChildrenCollapsible(false);
    splitter->setHandleWidth(14);
    splitter->addWidget(makeLibrary());
    splitter->addWidget(makeConversation());
    splitter->setStretchFactor(0, 0);
    splitter->setStretchFactor(1, 1);
    splitter->setSizes({300, 900});
    workspace->addWidget(splitter);
    workspaceTabs_ = new QTabWidget;
    workspaceTabs_->setObjectName("workspaceTabs");
    workspaceTabs_->addTab(root, "资料与对话");
    memories_ = new MemoryPanel(&client_);
    workspaceTabs_->addTab(memories_, "个人记忆");
    workspaceTabs_->setTabVisible(1, false);
    connect(memories_, &MemoryPanel::message, this, &MainWindow::showFailure);

    auto *body = new QSplitter;
    body->setObjectName("workspaceSplitter");
    body->setChildrenCollapsible(false);
    body->setHandleWidth(14);
    body->addWidget(workspaceTabs_);
    settingsPanel_ = makeSettings();
    body->addWidget(settingsPanel_);
    body->setStretchFactor(0, 1);
    body->setStretchFactor(1, 0);
    settingsPanel_->hide();
    connect(settings, &QPushButton::toggled, this, [this, body](bool visible) {
        settingsPanel_->setVisible(visible);
        if (visible) body->setSizes({qMax(600, body->width() - 324), 310});
    });
    layout->addWidget(body, 1);
    setCentralWidget(shell);
    statusBar()->showMessage("本地资料库  ·  ⌃⌥S 截取窗口  ·  记忆上传前需手动确认");
}

QWidget *MainWindow::makeLibrary() {
    auto *panel = new QFrame;
    panel->setProperty("role", "card");
    panel->setMinimumWidth(240);
    auto *layout = new QVBoxLayout(panel);
    layout->setContentsMargins(14, 18, 14, 14);
    layout->setSpacing(12);
    auto *header = new QHBoxLayout;
    auto *heading = new QLabel("资料库");
    heading->setProperty("role", "heading");
    header->addWidget(heading);
    libraryCount_ = new QLabel("0 份");
    libraryCount_->setProperty("role", "muted");
    header->addWidget(libraryCount_);
    header->addStretch();
    auto *refresh = new QPushButton("刷新");
    refresh->setProperty("quiet", true);
    refresh->setToolTip("刷新本地资料库");
    connect(refresh, &QPushButton::clicked, this, &MainWindow::refreshLibrary);
    header->addWidget(refresh);
    layout->addLayout(header);
    filter_ = new QLineEdit;
    filter_->setPlaceholderText("搜索资料或来源…");
    filter_->setClearButtonEnabled(true);
    filter_->setObjectName("libraryFilter");
    connect(filter_, &QLineEdit::textChanged, this, &MainWindow::filterLibrary);
    layout->addWidget(filter_);
    library_ = new QTreeWidget;
    library_->setObjectName("libraryList");
    library_->setColumnCount(2);
    library_->setHeaderLabels({"状态", "资料概述 / 来源"});
    library_->setHeaderHidden(true);
    library_->setRootIsDecorated(false);
    library_->setUniformRowHeights(true);
    library_->setItemDelegate(new LibraryItemDelegate(library_));
    library_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    library_->header()->setSectionResizeMode(0, QHeaderView::Fixed);
    library_->setColumnWidth(0, 58);
    library_->header()->setSectionResizeMode(1, QHeaderView::Stretch);
    connect(library_, &QTreeWidget::itemSelectionChanged, this, &MainWindow::showSelected);
    libraryStack_ = new QStackedWidget;
    libraryStack_->addWidget(library_);
    libraryEmpty_ = wrapped("还没有资料\n截取一个窗口，或导入图片开始收集。");
    libraryEmpty_->setObjectName("libraryEmptyState");
    libraryEmpty_->setAlignment(Qt::AlignCenter);
    libraryEmpty_->setProperty("role", "muted");
    libraryEmpty_->setMinimumWidth(0);
    libraryStack_->addWidget(libraryEmpty_);
    libraryStack_->setCurrentWidget(libraryEmpty_);
    layout->addWidget(libraryStack_, 1);
    auto *import = new QPushButton("＋ 导入图片");
    connect(import, &QPushButton::clicked, this, &MainWindow::importImages);
    summarize_ = new QPushButton("生成资料概述");
    summarize_->setObjectName("summarizeButton");
    summarize_->setEnabled(false);
    summarize_->setToolTip("选择资料并保存临时读图设置后，可生成或重试概述；无需启动持久 Agent。");
    connect(summarize_, &QPushButton::clicked, this, &MainWindow::summarizeSelected);
    layout->addWidget(import);
    layout->addWidget(summarize_);
    remember_ = new QPushButton("整理为个人记忆…");
    remember_->setObjectName("rememberSourceButton");
    remember_->setEnabled(false);
    remember_->hide();
    connect(remember_, &QPushButton::clicked, this, [this] {
        const auto id = selectedID();
        if (id.isEmpty()) { showFailure("请先选择一条资料。"); return; }
        client_.request("library/content", {{"id", id}}, [this](const QJsonValue &value, const QString &error) {
            if (!error.isEmpty()) { showFailure(error); return; }
            workspaceTabs_->setCurrentIndex(1); memories_->addFromSource(value.toObject());
        });
    });
    layout->addWidget(remember_);
    readerStatus_ = wrapped("临时读图尚未配置");
    readerStatus_->setObjectName("readerStatus");
    readerStatus_->setProperty("role", "muted");
    layout->addWidget(readerStatus_);
    auto *note = wrapped("每次截图独立生成概述文件。持久 Agent 在提问时按需查阅。");
    note->setProperty("role", "muted");
    layout->addWidget(note);
    return panel;
}

QWidget *MainWindow::makeConversation() {
    auto *panel = new QWidget;
    auto *layout = new QVBoxLayout(panel);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(12);
    auto *card = new QFrame;
    card->setProperty("role", "card");
    auto *cardLayout = new QVBoxLayout(card);
    cardLayout->setContentsMargins(1, 1, 1, 1);
    cardLayout->setSpacing(0);
    auto *session = new QFrame;
    session->setObjectName("sessionBar");
    auto *sessionLayout = new QHBoxLayout(session);
    sessionLayout->setContentsMargins(18, 12, 14, 12);
    auto *heading = new QLabel("资料问答");
    heading->setProperty("role", "heading");
    sessionLayout->addWidget(heading);
    sessionLayout->addStretch();
    agentStatus_ = new QLabel("Agent 未启动");
    agentStatus_->setProperty("tone", "neutral");
    sessionLayout->addWidget(agentStatus_);
    start_ = new QPushButton("启动 Agent");
    start_->setObjectName("startAgentButton");
    start_->setEnabled(false);
    connect(start_, &QPushButton::clicked, this, &MainWindow::startAgent);
    sessionLayout->addWidget(start_);
    stop_ = new QPushButton("停止");
    stop_->setObjectName("stopAgentButton");
    stop_->setProperty("quiet", true);
    stop_->setEnabled(false);
    stop_->hide();
    connect(stop_, &QPushButton::clicked, this, [this] {
        client_.request("agent/stop", {}, [this](const QJsonValue &, const QString &error) { if (!error.isEmpty()) showFailure(error); });
    });
    sessionLayout->addWidget(stop_);
    cardLayout->addWidget(session);
    tabs_ = new QTabWidget;
    tabs_->setObjectName("conversationTabs");
    conversationStack_ = new QStackedWidget;
    auto *welcome = new QWidget;
    welcome->setObjectName("conversationWelcome");
    auto *welcomeLayout = new QVBoxLayout(welcome);
    welcomeLayout->setContentsMargins(24, 24, 24, 24);
    welcomeLayout->setSpacing(16);
    welcomeLayout->addStretch();
    auto *mark = new QLabel("栖");
    mark->setObjectName("emptyMark");
    mark->setAlignment(Qt::AlignCenter);
    mark->setFixedSize(64, 64);
    welcomeLayout->addWidget(mark, 0, Qt::AlignHCenter);
    auto *welcomeTitle = wrapped("从一份资料，开始对话");
    welcomeTitle->setObjectName("emptyTitle");
    welcomeTitle->setAlignment(Qt::AlignCenter);
    welcomeLayout->addWidget(welcomeTitle);
    auto *welcomeText = wrapped("截取窗口、导入图片，或写下一段文字。\n临时 Agent 整理概述，持久 Agent 在提问时查阅。");
    welcomeText->setProperty("role", "muted");
    welcomeText->setAlignment(Qt::AlignCenter);
    welcomeLayout->addWidget(welcomeText);
    auto *suggestion = new QPushButton("试着问：帮我总结资料中的要点");
    suggestion->setProperty("quiet", true);
    connect(suggestion, &QPushButton::clicked, this, [this] {
        input_->setPlainText("帮我总结资料中的要点");
        input_->setFocus();
    });
    welcomeLayout->addWidget(suggestion, 0, Qt::AlignHCenter);
    welcomeLayout->addStretch();
    conversationStack_->addWidget(welcome);
    transcript_ = new QTextBrowser;
    transcript_->setObjectName("transcript");
    transcript_->setOpenLinks(false);
    transcript_->setOpenExternalLinks(false);
    transcript_->document()->setDefaultStyleSheet("p { line-height: 155%; margin-top: 7px; margin-bottom: 16px; } hr { color: #e3eae4; }");
    conversationStack_->addWidget(transcript_);
    tabs_->addTab(conversationStack_, "对话");
    auto *detail = new QWidget;
    auto *detailLayout = new QVBoxLayout(detail);
    detailLayout->setContentsMargins(18, 18, 18, 14);
    detailLayout->setSpacing(12);
    summary_ = wrapped("选择左侧资料，查看概述和原始内容。");
    summary_->setTextInteractionFlags(Qt::TextSelectableByMouse);
    detailLayout->addWidget(summary_);
    image_ = new ImagePreview;
    image_->hide();
    imageScroll_ = new QScrollArea;
    imageScroll_->setWidgetResizable(true);
    imageScroll_->setWidget(image_);
    imageScroll_->hide();
    detailLayout->addWidget(imageScroll_, 1);
    content_ = new QPlainTextEdit;
    content_->setObjectName("originalText");
    content_->setReadOnly(true);
    detailLayout->addWidget(content_, 1);
    content_->setPlaceholderText("选择资料后，原始文本会显示在这里。");
    openOriginal_ = new QPushButton("打开原始文件");
    openOriginal_->setEnabled(false);
    connect(openOriginal_, &QPushButton::clicked, this, [this] {
        if (!contentPath_.isEmpty()) QDesktopServices::openUrl(QUrl::fromLocalFile(contentPath_));
    });
    openSummary_ = new QPushButton("打开概述文件");
    openSummary_->setObjectName("openSummaryButton");
    openSummary_->setEnabled(false);
    connect(openSummary_, &QPushButton::clicked, this, [this] {
        if (!summaryPath_.isEmpty()) QDesktopServices::openUrl(QUrl::fromLocalFile(summaryPath_));
    });
    auto *files = new QHBoxLayout;
    files->addStretch(); files->addWidget(openSummary_); files->addWidget(openOriginal_);
    detailLayout->addLayout(files);
    tabs_->addTab(detail, "资料详情");
    cardLayout->addWidget(tabs_, 1);
    layout->addWidget(card, 1);
    progress_ = new QPlainTextEdit;
    progress_->setObjectName("agentProgress");
    progress_->setReadOnly(true);
    progress_->setMaximumHeight(72);
    progress_->hide();
    layout->addWidget(progress_);
    auto *composer = new QFrame;
    composer->setObjectName("composer");
    auto *composerLayout = new QVBoxLayout(composer);
    composerLayout->setContentsMargins(12, 10, 12, 10);
    composerLayout->setSpacing(6);
    input_ = new QPlainTextEdit;
    input_->setObjectName("messageInput");
    input_->setPlaceholderText("提问，或写下想保存的内容…");
    input_->setFixedHeight(76);
    composerLayout->addWidget(input_);
    auto *buttons = new QHBoxLayout;
    composerHint_ = wrapped("启动 Agent 后可提问；文本可随时保存");
    composerHint_->setProperty("role", "muted");
    buttons->addWidget(composerHint_, 1);
    save_ = new QPushButton("保存为资料");
    save_->setObjectName("saveTextButton");
    save_->setEnabled(false);
    ask_ = new QPushButton("发送提问");
    ask_->setObjectName("askButton");
    ask_->setProperty("primary", true);
    ask_->setEnabled(false);
    connect(save_, &QPushButton::clicked, this, [this] { submitText(false); });
    connect(ask_, &QPushButton::clicked, this, [this] { submitText(true); });
    const QKeySequence sendShortcut(Qt::CTRL | Qt::Key_Return);
    ask_->setToolTip(sendShortcut.toString(QKeySequence::NativeText) + " 发送提问");
    auto *send = new QShortcut(sendShortcut, input_);
    send->setContext(Qt::WidgetWithChildrenShortcut);
    connect(send, &QShortcut::activated, ask_, &QPushButton::click);
    auto *sendKeypad = new QShortcut(QKeySequence(Qt::CTRL | Qt::Key_Enter), input_);
    sendKeypad->setContext(Qt::WidgetWithChildrenShortcut);
    connect(sendKeypad, &QShortcut::activated, ask_, &QPushButton::click);
    buttons->addWidget(save_); buttons->addWidget(ask_);
    composerLayout->addLayout(buttons);
    layout->addWidget(composer);
    return panel;
}

QWidget *MainWindow::makeSettings() {
    auto *scroll = new QScrollArea;
    scroll->setObjectName("settingsPanel");
    scroll->setWidgetResizable(true);
    scroll->setMinimumWidth(290);
    scroll->setMaximumWidth(360);
    scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    auto *panel = new QWidget;
    auto *layout = new QVBoxLayout(panel);
    layout->setContentsMargins(0, 6, 4, 12);
    layout->setSpacing(12);
    auto *heading = new QLabel("偏好与连接");
    heading->setProperty("role", "heading");
    layout->addWidget(heading);
    auto *readerGroup = new QGroupBox("临时读图 Agent");
    auto *readerForm = new QFormLayout(readerGroup);
    readerForm->setRowWrapPolicy(QFormLayout::WrapAllRows);
    readerForm->setFieldGrowthPolicy(QFormLayout::AllNonFixedFieldsGrow);
    readerForm->setVerticalSpacing(10);
    readerProvider_ = new QComboBox;
    readerProvider_->setObjectName("readerProvider");
    readerProvider_->addItems({"codex", "pi", "dsh"});
    readerExecutable_ = new QLineEdit("codex");
    readerExecutable_->setObjectName("readerExecutable");
    readerArguments_ = new QLineEdit(defaultArguments("codex"));
    readerArguments_->setObjectName("readerArguments");
    readerEffort_ = new QComboBox;
    readerEffort_->setObjectName("readerReasoningEffort");
    readerEffort_->addItem("跟随模型默认", "");
    for (const auto &effort : {"low", "medium", "high", "xhigh", "max", "ultra"}) readerEffort_->addItem(effort, effort);
    readerEffort_->setToolTip("仅用于临时读图 Codex；可用等级取决于模型，不影响持久 Agent。");
    connect(readerProvider_, &QComboBox::currentTextChanged, this, [this](const QString &name) {
        readerExecutable_->setText(name); readerArguments_->setText(defaultArguments(name));
        readerEffort_->setEnabled(name == "codex");
    });
    readerForm->addRow("读图使用的 Agent", readerProvider_);
    readerForm->addRow("启动程序", readerExecutable_);
    readerForm->addRow("启动参数（JSON 数组）", readerArguments_);
    readerForm->addRow("思考深度（Codex）", readerEffort_);
    auto *readerNote = wrapped("每份资料启动一次临时会话，只发送固定提示词和原件。输出写入概述文件后退出，不进入持久对话。");
    readerNote->setProperty("role", "muted");
    readerForm->addRow(readerNote);
    saveReader_ = new QPushButton("保存读图设置");
    saveReader_->setObjectName("saveReaderSettingsButton");
    saveReader_->setEnabled(false);
    connect(saveReader_, &QPushButton::clicked, this, &MainWindow::saveReaderSettings);
    readerForm->addRow(saveReader_);
    layout->addWidget(readerGroup);

    auto *group = new QGroupBox("持久问答 Agent");
    auto *form = new QFormLayout(group);
    form->setVerticalSpacing(10);
    form->setFieldGrowthPolicy(QFormLayout::AllNonFixedFieldsGrow);
    form->setRowWrapPolicy(QFormLayout::WrapAllRows);
    provider_ = new QComboBox;
    provider_->addItems({"codex", "pi", "dsh"});
    executable_ = new QLineEdit("codex");
    arguments_ = new QLineEdit(defaultArguments("codex"));
    basePrompt_ = new QPlainTextEdit;
    basePrompt_->setFixedHeight(115);
    basePrompt_->setPlaceholderText("填写希望 agent 始终遵循的基础提示词…");
    connect(provider_, &QComboBox::currentTextChanged, this, [this](const QString &name) {
        executable_->setText(name); arguments_->setText(defaultArguments(name));
    });
    form->addRow("使用的 Agent", provider_);
    form->addRow("启动程序", executable_);
    form->addRow("启动参数（JSON 数组）", arguments_);
    form->addRow("基础提示词", basePrompt_);
    auto *agentNote = wrapped("启动新会话时生效。提问时优先查阅概述，仅在需要细节时读取原件。AI 处理使用各自 Agent 配置的模型服务。");
    agentNote->setProperty("role", "muted");
    form->addRow(agentNote);
    layout->addWidget(group);
    auto *permissions = new QGroupBox("截图与连接");
    auto *controls = new QVBoxLayout(permissions);
    permissionStatus_ = wrapped("正在读取权限…");
    controls->addWidget(permissionStatus_);
    accessibility_ = new QPushButton("授权辅助功能…");
    screenRecording_ = new QPushButton("授权屏幕录制…");
    for (auto pair : {qMakePair(accessibility_, QString("accessibility")), qMakePair(screenRecording_, QString("screenCapture"))}) {
        connect(pair.first, &QPushButton::clicked, this, [this, kind = pair.second] {
            client_.request("permissions/request", {{"kind", kind}}, [this](const QJsonValue &value, const QString &error) {
                if (!error.isEmpty()) showFailure(error); else showPermissions(value.toObject());
            });
        });
        controls->addWidget(pair.first);
    }
    auto *refresh = new QPushButton("刷新权限状态");
    connect(refresh, &QPushButton::clicked, this, [this] {
        client_.request("permissions/status", {}, [this](const QJsonValue &value, const QString &error) {
            if (!error.isEmpty()) showFailure(error); else showPermissions(value.toObject());
        });
    });
    controls->addWidget(refresh);
    reconnect_ = new QPushButton("重新连接后端");
    reconnect_->setEnabled(false);
    connect(reconnect_, &QPushButton::clicked, this, &MainWindow::connectBackend);
    controls->addWidget(reconnect_);
    layout->addWidget(permissions);
    auto *folder = new QPushButton("打开本地资料文件夹");
    folder->setProperty("quiet", true);
    connect(folder, &QPushButton::clicked, this, [this] { QDesktopServices::openUrl(QUrl::fromLocalFile(directory_)); });
    layout->addWidget(folder);
    layout->addStretch();
    scroll->setWidget(panel);
    return scroll;
}

void MainWindow::connectBackend() {
    connection_->setText("正在连接后端…");
    QiyiUi::setStatusTone(connection_, "neutral");
    updateBackgroundStatus();
    reconnect_->setEnabled(false);
    client_.start(backend_, directory_, hotkey_, backendArguments_);
}

void MainWindow::initialize(const QJsonObject &state) {
    ready_ = true;
    if (state.contains("assistant")) {
        setWindowTitle("栖忆个人助手 · 截图、资料与记忆");
        workspaceTabs_->setTabVisible(1, true); remember_->show();
        memories_->initialize(state.value("assistant").toObject());
    }
    connection_->setText("后端已连接");
    QiyiUi::setStatusTone(connection_, "success");
    directory_ = state.value("directory").toString(directory_);
    const auto config = state.value("configuration").toObject();
    const QSignalBlocker blocker(provider_);
    provider_->setCurrentText(config.value("provider").toString("codex"));
    executable_->setText(config.value("executable").toString());
    arguments_->setText(QString::fromUtf8(QJsonDocument(config.value("arguments").toArray()).toJson(QJsonDocument::Compact)));
    basePrompt_->setPlainText(config.value("basePrompt").toString());
    showReaderState(state.value("reader").toObject());
    saveReader_->setEnabled(true);
    save_->setEnabled(true);
    setAgentState("stopped");
    showPermissions(state.value("permissions").toObject());
    refreshLibrary();
}

void MainWindow::refreshLibrary() {
    if (!ready_) return;
    const auto revision = ++libraryRevision_;
    client_.request("library/list", {}, [this, revision](const QJsonValue &value, const QString &error) {
        if (revision != libraryRevision_) return;
        if (!error.isEmpty()) { showFailure(error); return; }
        const auto selection = selectedID();
        const QSignalBlocker blocker(library_);
        library_->clear();
        auto records = value.toArray();
        for (auto it = records.constEnd(); it != records.constBegin();) {
            const auto record = (*--it).toObject();
            const auto state = record.value("state").toString();
            auto *item = new QTreeWidgetItem(library_, {state == "ready" ? "已整理" : state == "failed" ? "失败" : "待概述",
                                                      record.value("summary").toString(record.value("source").toString())});
            item->setData(0, Qt::UserRole, record.value("id").toString());
            item->setData(1, Qt::UserRole, record.value("source").toString());
            const auto date = QDateTime::fromString(record.value("createdAt").toString(), Qt::ISODate).toLocalTime();
            const auto source = record.value("source").toString();
            item->setData(1, Qt::UserRole + 1, source + (date.isValid() ? " · " + date.toString("MM/dd HH:mm") : ""));
            item->setForeground(0, QColor(state == "ready" ? "#438064" : state == "failed" ? "#ad6954" : "#9a875a"));
            item->setToolTip(1, item->text(1));
            if (record.value("id").toString() == selection) library_->setCurrentItem(item);
        }
        filterLibrary();
        if (!selection.isEmpty()) {
            const auto previousTab = tabs_->currentIndex();
            showSelected();
            tabs_->setCurrentIndex(previousTab);
        }
    });
}

QString MainWindow::selectedID() const {
    const auto *item = library_->currentItem();
    return item && !item->isHidden() ? item->data(0, Qt::UserRole).toString() : QString{};
}

void MainWindow::filterLibrary() {
    const auto filter = filter_->text().trimmed();
    int visible = 0;
    for (int i = 0; i < library_->topLevelItemCount(); ++i) {
        auto *item = library_->topLevelItem(i);
        item->setHidden(!(item->text(1) + item->data(1, Qt::UserRole).toString()).contains(filter, Qt::CaseInsensitive));
        if (!item->isHidden()) ++visible;
    }
    const auto total = library_->topLevelItemCount();
    libraryCount_->setText(filter.isEmpty() ? QString("%1 份").arg(total) : QString("%1 / %2 份").arg(visible).arg(total));
    libraryEmpty_->setText(total == 0 ? "还没有资料\n截取一个窗口，或导入图片开始收集。" : "没有找到相关资料\n试试其他关键词，或清除搜索条件。");
    libraryStack_->setCurrentWidget(visible == 0 ? static_cast<QWidget *>(libraryEmpty_) : library_);
    updateLibraryActions();
}

void MainWindow::updateLibraryActions() {
    const bool selected = ready_ && !selectedID().isEmpty();
    remember_->setEnabled(selected);
    summarize_->setEnabled(selected && readerConfigured_);
    const auto *item = library_->currentItem();
    summarize_->setText(item && item->text(0) == "失败" ? "重试资料概述" : item && item->text(0) == "已整理" ? "重新生成概述" : "生成资料概述");
}

void MainWindow::showSelected() {
    const auto id = selectedID();
    const auto revision = ++contentRevision_;
    contentPath_.clear(); summaryPath_.clear(); content_->clear(); image_->clearPreview();
    openOriginal_->setEnabled(false);
    openSummary_->setEnabled(false);
    updateLibraryActions();
    if (id.isEmpty()) {
        summary_->setText("选择左侧资料，查看概述和原始内容。");
        imageScroll_->hide();
        content_->show();
        return;
    }
    tabs_->setCurrentIndex(1);
    summary_->setText("正在读取资料…");
    client_.request("library/content", {{"id", id}}, [this, revision](const QJsonValue &value, const QString &error) {
        if (revision != contentRevision_) return;
        if (!error.isEmpty()) { showFailure(error); return; }
        const auto result = value.toObject(), item = result.value("item").toObject();
        contentPath_ = result.value("path").toString();
        summaryPath_ = result.value("summaryPath").toString();
        openSummary_->setEnabled(!summaryPath_.isEmpty());
        openOriginal_->setEnabled(!contentPath_.isEmpty());
        summary_->setToolTip("资料编号：" + item.value("id").toString());
        summary_->setText("资料概述\n" + item.value("summary").toString("尚未生成概述。配置临时读图 Agent 后，可为此资料生成概述。") +
                          (item.contains("error") ? "\n错误：" + item.value("error").toString() : ""));
        const auto isImage = item.value("kind").toString() == "image";
        imageScroll_->setVisible(isImage);
        image_->setVisible(isImage); content_->setVisible(!isImage);
        if (isImage) {
            QImageReader reader(contentPath_);
            reader.setAutoTransform(true);
            if (reader.size().isValid()) reader.setScaledSize(reader.size().scaled(1440, 840, Qt::KeepAspectRatio));
            const auto image = reader.read();
            if (image.isNull()) image_->setText("无法预览图片：" + reader.errorString());
            else image_->setPreview(QPixmap::fromImage(image));
        } else content_->setPlainText(result.value("text").toString());
    });
}

void MainWindow::submitText(bool asQuestion) {
    const auto text = input_->toPlainText();
    if (text.trimmed().isEmpty()) { showFailure("请先输入文本。"); return; }
    if (asQuestion) {
        askPending_ = true;
        setAgentState(activeState_);
        tabs_->setCurrentIndex(0);
        appendMessage("你", text);
    } else save_->setEnabled(false);
    client_.request(asQuestion ? "chat/ask" : "library/addText", {{"text", text}}, [this, asQuestion, text](const QJsonValue &value, const QString &error) {
        if (asQuestion) { askPending_ = false; setAgentState(activeState_); updateProgress({}); }
        else save_->setEnabled(ready_);
        if (!error.isEmpty()) { showFailure(error); return; }
        if (input_->toPlainText() == text) input_->clear();
        if (asQuestion) {
            const auto answer = value.toObject();
            appendMessage("Agent", answer.value("response").toString() + "\n\n本轮查阅：\n" + sourceList(answer.value("sources").toArray()));
        } else {
            statusBar()->showMessage("文本已保存；已配置的临时 Agent 会独立生成概述。");
            refreshLibrary();
        }
    });
}

void MainWindow::importImages() {
    const auto paths = QFileDialog::getOpenFileNames(this, "导入资料图片", {}, "图片 (*.png *.jpg *.jpeg)");
    for (const auto &path : paths) client_.request("library/addImage", {{"path", path}}, [this](const QJsonValue &, const QString &error) {
        if (!error.isEmpty()) showFailure(error); else { statusBar()->showMessage("图片已保存。"); refreshLibrary(); }
    });
}

void MainWindow::summarizeSelected() {
    const auto id = selectedID();
    if (id.isEmpty()) { showFailure("请先选择一条资料。"); return; }
    const auto force = library_->currentItem()->text(0) == "已整理";
    client_.request("library/summarize", {{"id", id}, {"force", force}}, [this](const QJsonValue &, const QString &error) {
        if (!error.isEmpty()) showFailure(error); else { statusBar()->showMessage("概述已保存。"); refreshLibrary(); }
    });
}

void MainWindow::startAgent() {
    QString error;
    const auto configuration = launchConfiguration(provider_->currentText(), executable_->text(), arguments_->text(), basePrompt_->toPlainText(), error);
    if (!error.isEmpty()) { showFailure(error); return; }
    starting_ = true;
    setAgentState("starting");
    client_.request("agent/start", {{"configuration", configuration}}, [this](const QJsonValue &, const QString &error) {
        starting_ = false;
        setAgentState(error.isEmpty() ? "ready" : "stopped");
        if (!error.isEmpty()) showFailure(error); else appendMessage("会话", "持久 Agent 已就绪。提问时会查阅概述，并按需核对原件；截图由独立临时 Agent 处理。");
    });
}

void MainWindow::showReaderState(const QJsonObject &state) {
    readerConfigured_ = state.value("configured").toBool();
    const auto config = state.value("configuration").toObject();
    const QSignalBlocker blocker(readerProvider_);
    readerProvider_->setCurrentText(config.value("provider").toString("codex"));
    readerExecutable_->setText(config.value("executable").toString("codex"));
    readerArguments_->setText(QString::fromUtf8(QJsonDocument(config.value("arguments").toArray()).toJson(QJsonDocument::Compact)));
    const auto effort = config.value("reasoningEffort").toString();
    if (readerEffort_->findData(effort) < 0) readerEffort_->addItem(effort, effort);
    readerEffort_->setCurrentIndex(readerEffort_->findData(effort));
    readerEffort_->setEnabled(readerProvider_->currentText() == "codex");
    readerStatus_->setText(state.contains("error") ? "读图配置错误：" + state.value("error").toString()
        : readerConfigured_ ? "临时读图已配置 · 截图后独立生成概述" : "临时读图尚未配置 · 资料仍可保存");
    updateLibraryActions();
}

void MainWindow::saveReaderSettings() {
    QString error;
    auto configuration = launchConfiguration(readerProvider_->currentText(), readerExecutable_->text(), readerArguments_->text(), "", error);
    if (!error.isEmpty()) { showFailure(error); return; }
    if (readerProvider_->currentText() == "codex" && !readerEffort_->currentData().toString().isEmpty())
        configuration.insert("reasoningEffort", readerEffort_->currentData().toString());
    saveReader_->setEnabled(false);
    client_.request("reader/configure", {{"configuration", configuration}}, [this](const QJsonValue &value, const QString &error) {
        saveReader_->setEnabled(ready_);
        if (!error.isEmpty()) { showFailure(error); return; }
        showReaderState(value.toObject());
        statusBar()->showMessage("临时读图设置已保存。后续截图独立处理，无需启动持久 Agent。");
    });
}

void MainWindow::setAgentState(const QString &state) {
    activeState_ = state;
    agentStatus_->setText(state == "ready" ? "Agent 已就绪" : state == "starting" ? "正在启动 Agent…" : "Agent 已停止");
    QiyiUi::setStatusTone(agentStatus_, state == "ready" ? "success" : state == "starting" ? "warning" : "neutral");
    start_->setText(state == "ready" ? "新建会话" : state == "starting" ? "正在启动…" : "启动 Agent");
    start_->setEnabled(ready_ && !starting_ && state != "starting");
    stop_->setEnabled(ready_ && state != "stopped");
    stop_->setVisible(state != "stopped");
    ask_->setEnabled(ready_ && state == "ready" && !askPending_);
    ask_->setText(askPending_ ? "正在回复…" : "发送提问");
    composerHint_->setText(askPending_ ? "正在查阅资料并生成回答…" : state == "ready"
        ? QKeySequence(Qt::CTRL | Qt::Key_Return).toString(QKeySequence::NativeText) + " 发送 · Enter 换行"
        : "启动 Agent 后可提问；文本可随时保存");
    updateLibraryActions();
    updateBackgroundStatus();
}

void MainWindow::updateProgress(const QString &text) {
    progress_->setPlainText(text);
    progress_->setVisible(!text.isEmpty());
}

void MainWindow::showPermissions(const QJsonObject &permissions) {
    const bool supported = permissions.value("captureSupported").toBool();
    accessibility_->setVisible(supported); screenRecording_->setVisible(supported);
    capture_->setEnabled(ready_ && supported);
    if (!supported) { permissionStatus_->setText("此平台尚未接入窗口截图。可使用资料导入和对话。"); return; }
    permissionStatus_->setText(QString("辅助功能：%1\n屏幕录制：%2\n快捷键：%3")
        .arg(permissions.value("accessibility").toBool() ? "已授权" : "未授权")
        .arg(permissions.value("screenCapture").toBool() ? "已授权" : "未授权")
        .arg(permissions.value("shortcutRegistered").toBool() ? "⌃⌥S" : "未注册"));
    const auto error = permissions.value("shortcutError").toString();
    if (!error.isEmpty()) appendMessage("快捷键", error);
}

void MainWindow::captureLater() {
    capture_->setEnabled(false);
    hide();
    QTimer::singleShot(3000, this, [this] {
        if (closing_) return;
        client_.request("capture", {}, [this](const QJsonValue &, const QString &error) {
            show();
            capture_->setEnabled(ready_);
            if (!error.isEmpty()) showFailure(error);
        });
    });
}

void MainWindow::handleEvent(const QString &name, const QJsonObject &data) {
    if (name == "libraryChanged") refreshLibrary();
    else if (name == "agentState") setAgentState(data.value("state").toString());
    else if (name == "status") statusBar()->showMessage(data.value("message").toString());
    else if (name == "warning") showFailure(data.value("message").toString());
    else if (name == "progress") updateProgress(data.value("text").toString());
    else if (name == "readerStatus") {
        readerStatus_->setText(data.value("message").toString());
        statusBar()->showMessage(data.value("message").toString());
    }
    else if (name == "captured") statusBar()->showMessage("截图已保存 · 正在排队生成概述");
    else if (name == "screenshotResult") {
        const auto status = data.value("status").toString();
        if (status == "completed") {
            readerStatus_->setText("截图概述文件已保存");
            statusBar()->showMessage("截图概述已保存到文件。");
        } else if (status == "failed") {
            readerStatus_->setText("截图概述失败：" + data.value("error").toString());
            statusBar()->showMessage(readerStatus_->text());
        }
    } else if (name == "interaction") showInteraction(data);
    else if (name == "interactionCancelled") for (const auto &id : data.value("ids").toArray()) cancelInteraction(id.toString());
}

void MainWindow::appendMessage(const QString &heading, const QString &text) {
    // Render model and source text as text, never executable HTML or remote resources.
    conversationStack_->setCurrentWidget(transcript_);
    transcript_->append("<p style='color:#398067; font-size:12px;'><b>" + heading.toHtmlEscaped() + "</b></p><p>" + text.toHtmlEscaped().replace('\n', "<br>") + "</p><hr>");
}

QString MainWindow::sourceList(const QJsonArray &sources) {
    QStringList lines;
    for (const auto &source : sources) {
        const auto record = source.toObject();
        lines << "[资料 " + record.value("id").toString() + "] " + record.value("summary").toString();
    }
    return lines.isEmpty() ? "没有选中资料" : lines.join('\n');
}

void MainWindow::showFailure(const QString &message) {
    statusBar()->showMessage(message);
    appendMessage("提示", message);
}

void MainWindow::showInteraction(const QJsonObject &request) {
    const auto id = request.value("id").toString();
    if (interactions_.contains(id)) return;
    auto *dialog = new QDialog(this);
    dialog->setAttribute(Qt::WA_DeleteOnClose);
    dialog->setWindowTitle(request.value("title").toString("Agent 需要回应"));
    dialog->resize(620, 420);
    auto *layout = new QVBoxLayout(dialog);
    auto *details = new QPlainTextEdit(request.value("detail").toString());
    details->setReadOnly(true);
    layout->addWidget(details);
    auto *choices = new QComboBox;
    choices->addItem("请选择…", "");
    for (const auto &value : request.value("choices").toArray()) {
        const auto choice = value.toObject();
        choices->addItem(choice.value("title").toString(), choice.value("id").toString());
    }
    choices->setVisible(choices->count() > 1);
    layout->addWidget(choices);
    auto *text = new QPlainTextEdit(request.value("initialText").toString());
    text->setVisible(request.value("acceptsText").toBool());
    text->setMaximumHeight(120);
    layout->addWidget(text);
    auto *buttons = new QDialogButtonBox(QDialogButtonBox::Ok | QDialogButtonBox::Cancel);
    buttons->button(QDialogButtonBox::Ok)->setText("提交回应");
    buttons->button(QDialogButtonBox::Cancel)->setText("取消本次");
    const auto validate = [=] { buttons->button(QDialogButtonBox::Ok)->setEnabled(choices->currentIndex() > 0 || (text->isVisible() && !text->toPlainText().isEmpty())); };
    connect(choices, &QComboBox::currentIndexChanged, dialog, validate);
    connect(text, &QPlainTextEdit::textChanged, dialog, validate);
    connect(buttons, &QDialogButtonBox::accepted, dialog, &QDialog::accept);
    connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::reject);
    layout->addWidget(buttons);
    interactions_.insert(id, dialog);
    connect(dialog, &QDialog::finished, this, [=](int result) {
        if (!interactions_.remove(id)) return;
        QJsonObject reply{{"id", id}, {"kind", "cancelled"}};
        if (result == QDialog::Accepted) {
            if (request.value("acceptsText").toBool() && !text->toPlainText().isEmpty()) {
                reply.insert("kind", "text"); reply.insert("value", text->toPlainText());
            } else { reply.insert("kind", "choice"); reply.insert("value", choices->currentData().toString()); }
        }
        client_.request("interaction/respond", reply);
    });
    dialog->open();
    validate();
}

void MainWindow::cancelInteraction(const QString &id) {
    const auto dialog = interactions_.take(id);
    if (dialog) dialog->reject();
}

void MainWindow::closeEvent(QCloseEvent *event) {
    if (!client_.isRunning()) {
        statusTray_->hide();
        event->accept();
        emit shutdownComplete();
        return;
    }
    event->ignore();
    if (closing_) return;
    closing_ = true;
    setEnabled(false);
    statusBar()->showMessage("正在停止后端和 agent…");
    updateBackgroundStatus();
    client_.shutdown();
}
