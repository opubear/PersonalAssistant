#include "image_preview.h"
#include <QResizeEvent>

ImagePreview::ImagePreview(QWidget *parent) : QLabel(parent) {
    setAlignment(Qt::AlignCenter);
    setTextFormat(Qt::PlainText);
    setMinimumSize(1, 100);
    // The viewport controls the size; a large original must not force horizontal scrolling.
    setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Expanding);
}

void ImagePreview::setPreview(const QPixmap &image) {
    original_ = image;
    if (original_.isNull()) clear();
    else fitImage();
}

void ImagePreview::clearPreview() {
    original_ = {};
    clear();
}

void ImagePreview::resizeEvent(QResizeEvent *event) {
    QLabel::resizeEvent(event);
    fitImage();
}

void ImagePreview::fitImage() {
    if (original_.isNull()) return;
    const auto ratio = devicePixelRatioF();
    auto scaled = original_.scaled(contentsRect().size() * ratio, Qt::KeepAspectRatio, Qt::SmoothTransformation);
    scaled.setDevicePixelRatio(ratio);
    setPixmap(scaled);
}
