#pragma once
#include <QLabel>
#include <QPixmap>

class ImagePreview final : public QLabel {
public:
    explicit ImagePreview(QWidget *parent = nullptr);
    void setPreview(const QPixmap &image);
    void clearPreview();
protected:
    void resizeEvent(QResizeEvent *event) override;
private:
    void fitImage();
    QPixmap original_;
};
