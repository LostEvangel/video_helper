cmake_minimum_required(VERSION 3.25)
project(VideoHelperThumbnail LANGUAGES CXX)

include(CTest)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(thumbnail_core OBJECT
  src/provider.cpp
  src/mp4_cover.cpp
  src/image.cpp
  src/fallback.cpp
)
target_include_directories(thumbnail_core PUBLIC src)
target_compile_definitions(thumbnail_core PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
set_target_properties(thumbnail_core PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_library(VideoHelperThumbnail SHARED
  src/dll.cpp
  exports.def
)
target_link_libraries(VideoHelperThumbnail PRIVATE
  thumbnail_core
  windowscodecs
  mf
  mfplat
  mfreadwrite
  mfuuid
  shlwapi
  ole32
  oleaut32
  uuid
  gdi32
)
target_compile_definitions(VideoHelperThumbnail PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
set_target_properties(VideoHelperThumbnail PROPERTIES
  PREFIX ""
  OUTPUT_NAME "VideoHelperThumbnail"
  WINDOWS_EXPORT_ALL_SYMBOLS OFF
)

if(BUILD_TESTING)
  add_executable(thumbnail_tests
    tests/mp4_cover_test.cpp
    tests/provider_test.cpp
  )
  target_include_directories(thumbnail_tests PRIVATE src tests)
  target_compile_definitions(thumbnail_tests PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
  target_link_libraries(thumbnail_tests PRIVATE
    thumbnail_core
    windowscodecs
    mf
    mfplat
    mfreadwrite
    mfuuid
    shlwapi
    ole32
    oleaut32
    uuid
    gdi32
  )
  add_dependencies(thumbnail_tests VideoHelperThumbnail)

  set(C1_FIXTURE_DIR "${PROJECT_SOURCE_DIR}/../../tests/generated/cover-probe/run-2026-10-06T033120673Z-6ebfff3d-3f07-4bde-885b-b0fa772f1344")
  add_test(NAME thumbnail_native
    COMMAND thumbnail_tests
      "$<TARGET_FILE:VideoHelperThumbnail>"
      "${C1_FIXTURE_DIR}/embedded-red.mp4"
      "${C1_FIXTURE_DIR}/plain-blue.mp4"
  )
endif()

if(MSVC)
  target_compile_options(thumbnail_core PRIVATE /W4 /permissive-)
  target_compile_options(VideoHelperThumbnail PRIVATE /W4 /permissive-)
  if(BUILD_TESTING)
    target_compile_options(thumbnail_tests PRIVATE /W4 /permissive-)
  endif()
else()
  target_compile_options(thumbnail_core PRIVATE -Wall -Wextra -Wpedantic)
  target_compile_options(VideoHelperThumbnail PRIVATE -Wall -Wextra -Wpedantic)
  if(BUILD_TESTING)
    target_compile_options(thumbnail_tests PRIVATE -Wall -Wextra -Wpedantic)
  endif()
endif()
