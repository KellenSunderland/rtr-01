cmake_minimum_required(VERSION 3.16)
project(mediacore VERSION 0.1.0 LANGUAGES CXX)

if(APPLE AND NOT CMAKE_OSX_ARCHITECTURES)
  # Build for the host architecture (arm64 on Apple silicon), never under Rosetta by accident.
  execute_process(COMMAND uname -m OUTPUT_VARIABLE _mc_host_arch OUTPUT_STRIP_TRAILING_WHITESPACE)
  set(CMAKE_OSX_ARCHITECTURES "${_mc_host_arch}" CACHE STRING "" FORCE)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_VISIBILITY_INLINES_HIDDEN ON)
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release)
endif()

option(MEDIACORE_BUILD_TESTS "Build unit tests" ON)
option(MEDIACORE_BUILD_TOOLS "Build mc_bench" ON)
option(MEDIACORE_WERROR "Treat warnings as errors" ON)

# OpenCV is optional: AUTO (default) uses it when found, ON requires it, OFF forces stb build.
set(MEDIACORE_WITH_OPENCV "AUTO" CACHE STRING "Use OpenCV: AUTO, ON or OFF")
set_property(CACHE MEDIACORE_WITH_OPENCV PROPERTY STRINGS AUTO ON OFF)
set(_mc_use_cv OFF)
if(NOT MEDIACORE_WITH_OPENCV STREQUAL "OFF")
  if(APPLE AND CMAKE_OSX_ARCHITECTURES STREQUAL "arm64")
    # /usr/local is the Intel Homebrew prefix on Apple silicon: its libraries cannot link into arm64.
    list(APPEND CMAKE_IGNORE_PREFIX_PATH /usr/local)
    list(APPEND CMAKE_IGNORE_PATH /usr/local/lib /usr/local/share)
  endif()
  list(APPEND CMAKE_PREFIX_PATH "$ENV{HOME}/.local/opt/opencv" /opt/homebrew)
  if(MEDIACORE_WITH_OPENCV STREQUAL "ON")
    find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs videoio)
  else()
    find_package(OpenCV QUIET COMPONENTS core imgproc imgcodecs videoio)
  endif()
  if(OpenCV_FOUND)
    set(_mc_use_cv ON)
  endif()
endif()
message(STATUS "mediacore: OpenCV ${_mc_use_cv}")
find_package(Threads REQUIRED)

set(MC_SOURCES
  src/c_api.cpp src/frame.cpp src/image_ops.cpp src/frame_store.cpp src/capture.cpp
  src/audio_ring.cpp src/resample.cpp src/vad.cpp src/jitter.cpp src/clock.cpp src/error.cpp)
if(_mc_use_cv)
  list(APPEND MC_SOURCES src/codec_cv.cpp)
else()
  list(APPEND MC_SOURCES src/codec_stb.cpp)
endif()

function(mediacore_configure tgt)
  target_include_directories(${tgt} PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)
  target_include_directories(${tgt} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
  target_include_directories(${tgt} SYSTEM PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/stb)
  target_compile_options(${tgt} PRIVATE -Wall -Wextra -Wconversion -Wshadow)
  if(MEDIACORE_WERROR)
    target_compile_options(${tgt} PRIVATE -Werror)
  endif()
  target_link_libraries(${tgt} PRIVATE Threads::Threads)
  if(_mc_use_cv)
    target_compile_definitions(${tgt} PRIVATE MC_WITH_OPENCV=1)
    target_include_directories(${tgt} SYSTEM PRIVATE ${OpenCV_INCLUDE_DIRS})
    target_link_libraries(${tgt} PRIVATE ${OpenCV_LIBS})
    target_compile_options(${tgt} PRIVATE -Wno-deprecated-anon-enum-enum-conversion)
  endif()
endfunction()

add_library(mediacore SHARED ${MC_SOURCES})
add_library(mediacore_static STATIC ${MC_SOURCES})
set_target_properties(mediacore_static PROPERTIES OUTPUT_NAME mediacore)
set_target_properties(mediacore PROPERTIES VERSION ${PROJECT_VERSION} SOVERSION 0)
mediacore_configure(mediacore)
mediacore_configure(mediacore_static)

install(FILES include/mediacore_c.h DESTINATION include)
install(TARGETS mediacore mediacore_static
  LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)

if(MEDIACORE_BUILD_TOOLS)
  add_executable(mc_bench tools/mc_bench.cpp)
  target_link_libraries(mc_bench PRIVATE mediacore)
  target_compile_options(mc_bench PRIVATE -Wall -Wextra -Wconversion)
endif()

enable_testing()
if(MEDIACORE_BUILD_TESTS)
  include(FetchContent)
  if(POLICY CMP0135)
    cmake_policy(SET CMP0135 NEW)
  endif()
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
  FetchContent_Declare(googletest
    URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.zip)
  FetchContent_MakeAvailable(googletest)

  add_executable(mediacore_tests
    tests/test_frame.cpp tests/test_image_ops.cpp tests/test_frame_store.cpp
    tests/test_capture.cpp tests/test_audio.cpp tests/test_vad.cpp tests/test_jitter.cpp
    tests/test_clock.cpp)
  # Tests exercise the public C ABI through the shared library.
  target_link_libraries(mediacore_tests PRIVATE mediacore GTest::gtest_main Threads::Threads)
  target_compile_options(mediacore_tests PRIVATE -Wall -Wextra)
  include(GoogleTest)
  gtest_discover_tests(mediacore_tests)
endif()
