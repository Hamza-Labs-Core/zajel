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

  # Find and propagate OpenSSL DLLs for bundling with the application.
  # The .lib import libraries are found by find_package, but the runtime
  # .dll files must be shipped alongside the executable.
  get_filename_component(_openssl_lib_dir "${OPENSSL_SSL_LIBRARY}" DIRECTORY)
  get_filename_component(_openssl_root "${_openssl_lib_dir}" DIRECTORY)

  # OpenSSL 3.x DLLs: libssl-3-x64.dll / libcrypto-3-x64.dll
  # OpenSSL 1.1.x DLLs: libssl-1_1-x64.dll / libcrypto-1_1-x64.dll
  set(_openssl_dll_search_dirs
    "${_openssl_root}/bin"
    "${_openssl_lib_dir}"
    "${_openssl_root}"
  )

  set(OPENSSL_RUNTIME_DLLS "")
  foreach(_dll_name libssl-3-x64.dll libcrypto-3-x64.dll
                    libssl-1_1-x64.dll libcrypto-1_1-x64.dll)
    find_file(_found_dll "${_dll_name}" PATHS ${_openssl_dll_search_dirs} NO_DEFAULT_PATH)
    if(_found_dll)
      list(APPEND OPENSSL_RUNTIME_DLLS "${_found_dll}")
      message(STATUS "Found OpenSSL DLL: ${_found_dll}")
    endif()
    unset(_found_dll CACHE)
  endforeach()

  # Propagate to parent scope so the main CMakeLists.txt can install them
  set(OPENSSL_RUNTIME_DLLS "${OPENSSL_RUNTIME_DLLS}" PARENT_SCOPE)
else()
  target_compile_definitions(pinned_websocket_plugin PRIVATE HAVE_OPENSSL=0)
  set(OPENSSL_RUNTIME_DLLS "" PARENT_SCOPE)
endif()

target_compile_features(pinned_websocket_plugin PUBLIC cxx_std_17)

# Windows-specific settings
target_compile_definitions(pinned_websocket_plugin PRIVATE
  _CRT_SECURE_NO_WARNINGS
  WIN32_LEAN_AND_MEAN
  NOMINMAX
)

# Export macro: PUBLIC so the runner (which includes pinned_websocket_plugin.h)
# also gets FLUTTER_PLUGIN_IMPL defined, avoiding __declspec(dllimport) on a static lib.
target_compile_definitions(pinned_websocket_plugin PUBLIC FLUTTER_PLUGIN_IMPL)
