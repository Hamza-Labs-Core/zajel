# Certificate pinning WebSocket plugin for Linux
cmake_minimum_required(VERSION 3.13)
project(pinned_websocket_plugin LANGUAGES CXX)

# Plugin library
add_library(pinned_websocket_plugin STATIC
  pinned_websocket_plugin.cc
  websocket_connection.cc
)

target_include_directories(pinned_websocket_plugin PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}
)

target_link_libraries(pinned_websocket_plugin PRIVATE
  flutter
)

# Link OpenSSL if available (passed from parent CMakeLists.txt)
if(OPENSSL_FOUND)
  target_link_libraries(pinned_websocket_plugin PRIVATE PkgConfig::OPENSSL)
  target_compile_definitions(pinned_websocket_plugin PRIVATE HAVE_OPENSSL=1)
else()
  target_compile_definitions(pinned_websocket_plugin PRIVATE HAVE_OPENSSL=0)
endif()

target_compile_features(pinned_websocket_plugin PUBLIC cxx_std_17)
target_compile_options(pinned_websocket_plugin PRIVATE -Wall -Werror)
