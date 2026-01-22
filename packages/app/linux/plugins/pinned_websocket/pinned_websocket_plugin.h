#ifndef PINNED_WEBSOCKET_PLUGIN_H_
#define PINNED_WEBSOCKET_PLUGIN_H_

#include <flutter_linux/flutter_linux.h>

G_BEGIN_DECLS

#ifdef FLUTTER_PLUGIN_IMPL
#define FLUTTER_PLUGIN_EXPORT __attribute__((visibility("default")))
#else
#define FLUTTER_PLUGIN_EXPORT
#endif

// Declare the GObject type
G_DECLARE_FINAL_TYPE(PinnedWebSocketPlugin, pinned_websocket_plugin,
                     PINNED_WEBSOCKET, PLUGIN, GObject)

/**
 * pinned_websocket_plugin_register_with_registrar:
 * @registrar: The plugin registrar.
 *
 * Registers the pinned WebSocket plugin with the Flutter engine.
 */
FLUTTER_PLUGIN_EXPORT void pinned_websocket_plugin_register_with_registrar(
    FlPluginRegistrar* registrar);

G_END_DECLS

#endif  // PINNED_WEBSOCKET_PLUGIN_H_
