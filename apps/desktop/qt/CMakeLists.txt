cmake_minimum_required(VERSION 3.21)
project(Qiyi VERSION 0.3.0 LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 6.4 REQUIRED COMPONENTS Widgets)

add_library(qiyi_qt_ui STATIC
    src/ui_theme.cpp src/ui_theme.h
    src/image_preview.cpp src/image_preview.h
    src/backend_client.cpp src/backend_client.h
    src/memory_panel.cpp src/memory_panel.h
    src/main_window.cpp src/main_window.h)
target_link_libraries(qiyi_qt_ui PUBLIC Qt6::Widgets)
target_include_directories(qiyi_qt_ui PUBLIC src)
if(MSVC)
    target_compile_options(qiyi_qt_ui PRIVATE /W4 /utf-8)
else()
    target_compile_options(qiyi_qt_ui PRIVATE -Wall -Wextra -Wpedantic)
endif()

qt_add_executable(Qiyi MACOSX_BUNDLE WIN32 src/main.cpp)
target_link_libraries(Qiyi PRIVATE qiyi_qt_ui)
set_target_properties(Qiyi PROPERTIES
    MACOSX_BUNDLE_BUNDLE_NAME "Qiyi"
    MACOSX_BUNDLE_GUI_IDENTIFIER "local.qiyi.desktop"
    MACOSX_BUNDLE_SHORT_VERSION_STRING "0.3.0")

include(CTest)
if(BUILD_TESTING)
    find_package(Qt6 REQUIRED COMPONENTS Test Network)
    qt_add_executable(qiyi_qt_tests tests/test_frontend.cpp)
    target_link_libraries(qiyi_qt_tests PRIVATE qiyi_qt_ui Qt6::Test Qt6::Network)
    add_test(NAME qt_frontend COMMAND qiyi_qt_tests -platform offscreen)
endif()
