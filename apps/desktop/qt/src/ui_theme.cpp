#include "ui_theme.h"
#include <QApplication>
#include <QFont>
#include <QPalette>
#include <QStyle>
#include <QWidget>

void QiyiUi::applyTheme(QApplication &app) {
    app.setStyle("Fusion");
    auto font = app.font();
    font.setPointSize(13);
    font.setWeight(QFont::Normal);
    app.setFont(font);

    QPalette palette;
    palette.setColor(QPalette::Window, QColor("#f4f6f4"));
    palette.setColor(QPalette::Base, Qt::white);
    palette.setColor(QPalette::AlternateBase, QColor("#f8faf9"));
    palette.setColor(QPalette::WindowText, QColor("#243830"));
    palette.setColor(QPalette::Text, QColor("#243830"));
    palette.setColor(QPalette::Button, Qt::white);
    palette.setColor(QPalette::ButtonText, QColor("#243830"));
    palette.setColor(QPalette::Highlight, QColor("#e0efe9"));
    palette.setColor(QPalette::HighlightedText, QColor("#185e50"));
    palette.setColor(QPalette::PlaceholderText, QColor("#86958e"));
    palette.setColor(QPalette::Disabled, QPalette::Text, QColor("#96a39c"));
    palette.setColor(QPalette::Disabled, QPalette::ButtonText, QColor("#96a39c"));
    app.setPalette(palette);

    app.setStyleSheet(R"(
        QWidget { font-size: 13px; }
        QMainWindow, QWidget#appShell { background: #f4f6f4; }
        QLabel { background: transparent; }
        QLabel[role="title"] { font-size: 22px; font-weight: 600; color: #203c31; }
        QLabel[role="heading"] { font-size: 16px; font-weight: 600; color: #243830; }
        QLabel[role="muted"] { color: #75847c; font-size: 12px; }
        QLabel#brandMark { background: #247565; color: white; border-radius: 11px; font-size: 21px; font-weight: 600; }
        QLabel#emptyMark { background: #edf4ef; color: #63917e; border-radius: 22px; font-size: 28px; }
        QLabel#emptyTitle { font-size: 22px; font-weight: 600; color: #344f41; }
        QLabel[tone] { padding: 5px 10px; border-radius: 10px; font-size: 12px; }
        QLabel[tone="neutral"] { background: #edf1ee; color: #75847c; }
        QLabel[tone="success"] { background: #e6f2eb; color: #28745b; }
        QLabel[tone="warning"] { background: #fff2dd; color: #946323; }
        QFrame[role="card"] { background: white; border: 1px solid #e1e8e2; border-radius: 12px; }
        QFrame#sessionBar { background: #f8faf8; border: 0; border-bottom: 1px solid #e7ece8; border-radius: 0; }
        QFrame#composer { background: white; border: 1px solid #d8e2db; border-radius: 12px; }
        QPushButton { background: white; border: 1px solid #dce5de; border-radius: 7px; padding: 8px 13px; color: #344c40; }
        QPushButton:hover { background: #eef5f0; border-color: #aecbbb; }
        QPushButton:pressed { background: #e1eee6; }
        QPushButton:focus { border-color: #478d76; }
        QPushButton:disabled { color: #97a69d; background: #f2f5f2; border-color: #e8ede9; }
        QPushButton[primary="true"]:enabled { color: white; background: #247565; border-color: #247565; font-weight: 500; }
        QPushButton[primary="true"]:hover { background: #1c6556; }
        QPushButton[quiet="true"] { border-color: transparent; background: transparent; color: #687e70; }
        QPushButton[quiet="true"]:hover, QPushButton[quiet="true"]:checked { background: #e5eee7; color: #246a54; }
        QPushButton[danger="true"]:enabled { color: #a45c50; }
        QLineEdit, QPlainTextEdit, QTextBrowser, QTreeWidget, QComboBox {
            background: white; color: #243830; border: 1px solid #e0e7e1; border-radius: 7px;
            padding: 8px; selection-background-color: #e0efe9; selection-color: #185e50;
        }
        QLineEdit:focus, QPlainTextEdit:focus, QComboBox:focus { border-color: #75a68f; }
        QLineEdit { min-height: 20px; }
        QLineEdit#libraryFilter { background: #f3f6f3; border-color: transparent; }
        QComboBox { padding-right: 28px; min-height: 20px; }
        QComboBox QAbstractItemView { background: white; color: #243830; selection-background-color: #e0efe9; selection-color: #185e50; }
        QPlainTextEdit#messageInput { border: 0; background: transparent; padding: 4px; font-size: 14px; }
        QPlainTextEdit#agentProgress { background: #f0f6f1; color: #5c7665; border: 0; font-size: 12px; }
        QTextBrowser#transcript { border: 0; padding: 20px; font-size: 14px; }
        QPlainTextEdit#originalText, QPlainTextEdit#memoryDetails { border: 0; padding: 12px; }
        QTreeWidget { border: 0; outline: 0; padding: 2px; }
        QTreeWidget::item { min-height: 34px; padding: 3px; border-radius: 5px; }
        QTreeWidget::item:hover { background: #f0f5f0; }
        QTreeWidget::item:selected { background: #e0efe9; color: #185e50; }
        QHeaderView::section { background: #f7f9f7; color: #78877d; border: 0; padding: 9px 6px; font-size: 12px; }
        QTabWidget::pane { border: 0; }
        QTabBar::tab { background: transparent; color: #78877d; border: 0; padding: 11px 20px; margin: 0 3px 10px 0; }
        QTabBar::tab:selected { background: #e4eee7; color: #226950; border-radius: 7px; font-weight: 600; }
        QTabBar::tab:hover:!selected { color: #345d46; background: #edf2ed; border-radius: 7px; }
        QTabWidget#conversationTabs > QTabBar::tab { padding: 11px 17px; margin: 5px 0 0 6px; }
        QTabWidget#conversationTabs > QTabBar::tab:selected { background: white; border-radius: 0; border-bottom: 2px solid #39856b; }
        QGroupBox { background: white; border: 1px solid #e1e8e2; border-radius: 10px; margin-top: 22px; padding: 16px 12px 12px; font-weight: 600; }
        QGroupBox::title { subcontrol-origin: margin; subcontrol-position: top left; left: 12px; top: 3px; color: #4d6b59; }
        QScrollArea { border: 0; background: transparent; }
        QSplitter::handle { background: transparent; }
        QSplitter::handle:hover { background: #d9e6dc; border-radius: 2px; }
        QScrollBar:vertical { background: transparent; width: 8px; margin: 2px; }
        QScrollBar::handle:vertical { background: #cfdbd1; border-radius: 3px; min-height: 30px; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
        QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }
        QStatusBar { background: #f4f6f4; color: #7b8a7f; font-size: 11px; padding: 2px 20px; }
        QStatusBar::item { border: 0; }
        QToolTip { background: #294b38; color: white; border: 0; padding: 7px; }
        QDialog { background: #f4f6f4; }
    )");
}

void QiyiUi::setStatusTone(QWidget *widget, const char *tone) {
    widget->setProperty("tone", tone);
    widget->style()->unpolish(widget);
    widget->style()->polish(widget);
}
