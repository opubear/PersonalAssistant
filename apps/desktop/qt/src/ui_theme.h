#pragma once

class QApplication;
class QWidget;

namespace QiyiUi {
void applyTheme(QApplication &app);
void setStatusTone(QWidget *widget, const char *tone);
}
