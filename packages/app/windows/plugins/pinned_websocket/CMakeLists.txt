# Certificate pinning WebSocket plugin for Windows
cmake_minimum_required(VERSION 3.14)
project(pinned_websocket_plugin LANGUAGES CXX)

# Find OpenSSL - required for TLS certificate pinning
# Try multiple methods to locate OpenSSL on Windows:
# 1. Explicit paths via environment variables (CI builds)
# 2. OPENSSL_ROOT_DIR environment variable
# 3. System/vcpkg installed OpenSSL

# Check for explicit library paths first (set by CI)
if(DEFINED ENV{OPENSSL_SSL_LIBRARY} AND DEFINED ENV{OPENSSL_CRYPTO_LIBRARY} AND DEFINED ENV{OPENSSL_INCLUDE_DIR})
  set(OPENSSL_SSL_LIBRARY $ENV{OPENSSL_SSL_LIBRARY})
  set(OPENSSL_CRYPTO_LIBRARY $ENV{OPENSSL_CRYPTO_LIBRARY})
  set(OPENSSL_INCLUDE_DIR $ENV{OPENSSL_INCLUDE_DIR})
  set(OpenSSL_FOUND TRUE)
  message(STATUS "Using OpenSSL from explicit environment variables")
  message(STATUS "  SSL Library: ${OPENSSL_SSL_LIBRARY}")
  message(STATUS "  Crypto Library: ${OPENSSL_CRYPTO_LIBRARY}")
  message(STATUS "  Include Dir: ${OPENSSL_INCLUDE_DIR}")
else()
  # Try standard CMake find
  if(DEFINED ENV{OPENSSL_ROOT_DIR})
    set(OPENSSL_ROOT_DIR $ENV{OPENSSL_ROOT_DIR})
  endif()
  find_package(OpenSSL QUIET)
endif()

if(NOT OpenSSL_FOUND)
  message(STATUS "OpenSSL not found - pinned_websocket_plugin will be built without SSL support")
  message(STATUS "To enable SSL, install OpenSSL and set OPENSSL_ROOT_DIR or explicit library paths")
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
  # Link OpenSSL - use targets if available (from find_package), otherwise use explicit paths
  if(TARGET OpenSSL::SSL AND TARGET OpenSSL::Crypto)
    target_link_libraries(pinned_websocket_plugin PRIVATE
      OpenSSL::SSL
      OpenSSL::Crypto
    )
  else()
    # Using explicit library paths
    target_include_directories(pinned_websocket_plugin PRIVATE ${OPENSSL_INCLUDE_DIR})
    target_link_libraries(pinned_websocket_plugin PRIVATE
      ${OPENSSL_SSL_LIBRARY}
      ${OPENSSL_CRYPTO_LIBRARY}
    )
  endif()
  target_compile_definitions(pinned_websocket_plugin PRIVATE HAVE_OPENSSL=1)

  # Find and propagate OpenSSL DLLs for bundling with the application.
  # The .lib import libraries are found by find_package, but the runtime
  # .dll files must be shipped alongside the executable.
  get_filename_component(_openssl_lib_dir "${OPENSSL_SSL_LIBRARY}" DIRECTORY)
  # Navigate up from lib/VC/x64/MD/ or lib/ to find the root
  get_filename_component(_openssl_root "${_openssl_lib_dir}" DIRECTORY)
  get_filename_component(_openssl_root "${_openssl_root}" DIRECTORY)
  get_filename_component(_openssl_root "${_openssl_root}" DIRECTORY)
  get_filename_component(_openssl_root "${_openssl_root}" DIRECTORY)

  # OpenSSL 3.x DLLs: libssl-3-x64.dll / libcrypto-3-x64.dll
  # OpenSSL 1.1.x DLLs: libssl-1_1-x64.dll / libcrypto-1_1-x64.dll
  set(_openssl_dll_search_dirs
    "${_openssl_root}/bin"
    "${_openssl_lib_dir}"
    "${_openssl_root}"
  )
  # Also check OPENSSL_ROOT_DIR from environment if set
  if(DEFINED ENV{OPENSSL_ROOT_DIR})
    list(APPEND _openssl_dll_search_dirs "$ENV{OPENSSL_ROOT_DIR}/bin")
  endif()

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
