cmake_minimum_required(VERSION 3.13)
project(mediacore VERSION 0.1.0 LANGUAGES CXX)

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

find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs videoio)
find_package(Threads REQUIRED)

set(MC_SOURCES
  src/c_api.cpp src/frame.cpp src/image_ops.cpp src/frame_store.cpp src/capture.cpp
  src/audio_ring.cpp src/resample.cpp src/vad.cpp src/jitter.cpp src/clock.cpp src/error.cpp)

function(mediacore_configure tgt)
  target_include_directories(${tgt} PUBLIC
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)
  target_include_directories(${tgt} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
  target_include_directories(${tgt} SYSTEM PRIVATE ${OpenCV_INCLUDE_DIRS})
  target_compile_options(${tgt} PRIVATE -Wall -Wextra -Wconversion -Wshadow)
  if(MEDIACORE_WERROR)
    target_compile_options(${tgt} PRIVATE -Werror)
  endif()
  target_link_libraries(${tgt} PRIVATE ${OpenCV_LIBS} Threads::Threads)
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
  set(INSTALL_GTEST OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(googletest
    URL https://github.com/google/googletest/archive/refs/tags/release-1.12.1.zip)
  # CMake 3.13 has no FetchContent_MakeAvailable (3.14+): populate manually.
  FetchContent_GetProperties(googletest)
  if(NOT googletest_POPULATED)
    FetchContent_Populate(googletest)
    add_subdirectory(${googletest_SOURCE_DIR} ${googletest_BINARY_DIR} EXCLUDE_FROM_ALL)
  endif()

  add_executable(mediacore_tests
    tests/test_frame.cpp tests/test_image_ops.cpp tests/test_frame_store.cpp
    tests/test_capture.cpp tests/test_audio.cpp tests/test_vad.cpp tests/test_jitter.cpp
    tests/test_clock.cpp)
  target_link_libraries(mediacore_tests PRIVATE mediacore_static ${OpenCV_LIBS} gtest gtest_main
                        Threads::Threads)
  target_include_directories(mediacore_tests SYSTEM PRIVATE ${OpenCV_INCLUDE_DIRS})
  target_include_directories(mediacore_tests PRIVATE tests)
  target_compile_options(mediacore_tests PRIVATE -Wall -Wextra)
  include(GoogleTest)
  add_test(NAME mediacore_tests COMMAND mediacore_tests)
endif()
