# Certificate pinning WebSocket plugin for Windows
cmake_minimum_required(VERSION 3.14)
project(pinned_websocket_plugin LANGUAGES CXX)

# Find OpenSSL - try multiple methods
# 1. vcpkg (if available)
# 2. System-installed OpenSSL
# 3. Fallback to bundled (if provided)
find_package(OpenSSL QUIET)

if(NOT OpenSSL_FOUND)
  # Try to find via environment variable
  if(DEFINED ENV{OPENSSL_ROOT_DIR})
    set(OPENSSL_ROOT_DIR $ENV{OPENSSL_ROOT_DIR})
    find_package(OpenSSL REQUIRED)
  else()
    message(STATUS "OpenSSL not found - pinned_websocket_plugin will be built without SSL support")
    message(STATUS "To enable SSL, install OpenSSL via vcpkg or set OPENSSL_ROOT_DIR environment variable")
  endif()
endif()

# Plugin library
add_library(pinned_websocket_plugin STATIC
  pinned_websocket_plugin.cpp
  websocket_connection.cpp
)

target_include_directories(pinned_websocket_plugin PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(pinned_websocket_plugin PRIVATE
  flutter
  flutter_wrapper_plugin
  ws2_32
)

if(OpenSSL_FOUND)
  target_link_libraries(pinned_websocket_plugin PRIVATE
    OpenSSL::SSL
    OpenSSL::Crypto
  )
  target_compile_definitions(pinned_websocket_plugin PRIVATE HAVE_OPENSSL=1)
else()
  target_compile_definitions(pinned_websocket_plugin PRIVATE HAVE_OPENSSL=0)
endif()

target_compile_features(pinned_websocket_plugin PUBLIC cxx_std_17)

# Windows-specific settings
target_compile_definitions(pinned_websocket_plugin PRIVATE
  _CRT_SECURE_NO_WARNINGS
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)
