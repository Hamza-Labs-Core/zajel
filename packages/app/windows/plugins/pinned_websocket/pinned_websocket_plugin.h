#ifndef PINNED_WEBSOCKET_PLUGIN_H_
#define PINNED_WEBSOCKET_PLUGIN_H_

#include <flutter/plugin_registrar_windows.h>

#ifdef FLUTTER_PLUGIN_IMPL
#define FLUTTER_PLUGIN_EXPORT __declspec(dllexport)
#else
#define FLUTTER_PLUGIN_EXPORT __declspec(dllimport)
#endif

namespace pinned_websocket {

/**
 * Registers the pinned WebSocket plugin with the Flutter engine.
 */
FLUTTER_PLUGIN_EXPORT void PinnedWebSocketPluginRegisterWithRegistrar(
    flutter::PluginRegistrarWindows* registrar);

}  // namespace pinned_websocket

#endif  // PINNED_WEBSOCKET_PLUGIN_H_
