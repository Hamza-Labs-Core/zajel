#define FLUTTER_PLUGIN_IMPL

#include "pinned_websocket_plugin.h"
#include "websocket_connection.h"

#include <flutter_linux/flutter_linux.h>

#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

// Plugin structure
struct _PinnedWebSocketPlugin {
  GObject parent_instance;
  FlMethodChannel* method_channel;
  FlEventChannel* event_channel;
  gboolean event_listening;
  std::mutex* event_mutex;
};

G_DEFINE_TYPE(PinnedWebSocketPlugin, pinned_websocket_plugin, G_TYPE_OBJECT)

// Global plugin instance for event callbacks
static PinnedWebSocketPlugin* g_plugin_instance = nullptr;

// Forward declarations
static void method_call_handler(FlMethodChannel* channel,
                                FlMethodCall* method_call,
                                gpointer user_data);

// Data structure for passing to main thread
struct EventData {
  pinned_websocket::EventType type;
  std::string connection_id;
  std::string data;
};

// Callback for main thread event dispatch
static gboolean dispatch_event_on_main_thread(gpointer user_data) {
  EventData* event_data = static_cast<EventData*>(user_data);

  if (!g_plugin_instance || !g_plugin_instance->event_channel ||
      !g_plugin_instance->event_listening) {
    delete event_data;
    return G_SOURCE_REMOVE;
  }

  std::lock_guard<std::mutex> lock(*g_plugin_instance->event_mutex);

  g_autoptr(FlValue) event = fl_value_new_map();

  const char* type_str = nullptr;
  switch (event_data->type) {
    case pinned_websocket::EventType::kConnected:
      type_str = "connected";
      break;
    case pinned_websocket::EventType::kMessage:
      type_str = "message";
      break;
    case pinned_websocket::EventType::kDisconnected:
      type_str = "disconnected";
      break;
    case pinned_websocket::EventType::kError:
      type_str = "error";
      break;
    case pinned_websocket::EventType::kPinningFailed:
      type_str = "pinning_failed";
      break;
  }

  fl_value_set_string_take(event, "type", fl_value_new_string(type_str));
  fl_value_set_string_take(event, "connectionId",
                           fl_value_new_string(event_data->connection_id.c_str()));

  if (event_data->type == pinned_websocket::EventType::kMessage) {
    fl_value_set_string_take(event, "data",
                             fl_value_new_string(event_data->data.c_str()));
  } else if (event_data->type == pinned_websocket::EventType::kError ||
             event_data->type == pinned_websocket::EventType::kPinningFailed) {
    fl_value_set_string_take(event, "error",
                             fl_value_new_string(event_data->data.c_str()));
  }

  fl_event_channel_send(g_plugin_instance->event_channel, event, nullptr, nullptr);

  delete event_data;
  return G_SOURCE_REMOVE;
}

// Send event from any thread
static void send_event(pinned_websocket::EventType type,
                       const std::string& connection_id,
                       const std::string& data) {
  EventData* event_data = new EventData{type, connection_id, data};
  g_idle_add(dispatch_event_on_main_thread, event_data);
}

// Handle 'connect' method
static void handle_connect(PinnedWebSocketPlugin* self,
                           FlMethodCall* method_call) {
  FlValue* args = fl_method_call_get_args(method_call);
  if (fl_value_get_type(args) != FL_VALUE_TYPE_MAP) {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
        fl_method_error_response_new("INVALID_ARGS", "Expected map arguments", nullptr));
    fl_method_call_respond(method_call, response, nullptr);
    return;
  }

  FlValue* url_value = fl_value_lookup_string(args, "url");
  if (!url_value || fl_value_get_type(url_value) != FL_VALUE_TYPE_STRING) {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
        fl_method_error_response_new("INVALID_ARGS", "URL is required", nullptr));
    fl_method_call_respond(method_call, response, nullptr);
    return;
  }

  std::string url = fl_value_get_string(url_value);

  // Get pins array
  std::vector<std::string> pins;
  FlValue* pins_value = fl_value_lookup_string(args, "pins");
  if (pins_value && fl_value_get_type(pins_value) == FL_VALUE_TYPE_LIST) {
    size_t len = fl_value_get_length(pins_value);
    for (size_t i = 0; i < len; ++i) {
      FlValue* pin = fl_value_get_list_value(pins_value, i);
      if (fl_value_get_type(pin) == FL_VALUE_TYPE_STRING) {
        pins.push_back(fl_value_get_string(pin));
      }
    }
  }

  // Get timeout
  int timeout_ms = 30000;
  FlValue* timeout_value = fl_value_lookup_string(args, "timeoutMs");
  if (timeout_value && fl_value_get_type(timeout_value) == FL_VALUE_TYPE_INT) {
    timeout_ms = static_cast<int>(fl_value_get_int(timeout_value));
  }

  // Create connection
  auto& manager = pinned_websocket::ConnectionManager::Instance();
  std::string connection_id = manager.CreateConnection(
      url, pins, timeout_ms,
      [](pinned_websocket::EventType type,
         const std::string& conn_id,
         const std::string& data) {
        send_event(type, conn_id, data);
      });

  // Connect in background thread
  auto* conn = manager.GetConnection(connection_id);
  if (!conn) {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
        fl_method_error_response_new("INTERNAL_ERROR",
                                     "Failed to create connection", nullptr));
    fl_method_call_respond(method_call, response, nullptr);
    return;
  }

  // Store method call reference for async response
  g_object_ref(method_call);
  std::string conn_id_copy = connection_id;

  std::thread([method_call, conn, conn_id_copy]() {
    bool success = conn->Connect();

    // Respond on main thread
    g_idle_add([](gpointer user_data) -> gboolean {
      auto* params = static_cast<std::pair<FlMethodCall*, std::pair<bool, std::string>>*>(user_data);
      FlMethodCall* call = params->first;
      bool success = params->second.first;
      const std::string& conn_id = params->second.second;

      if (success) {
        g_autoptr(FlValue) result = fl_value_new_map();
        fl_value_set_string_take(result, "success", fl_value_new_bool(true));
        fl_value_set_string_take(result, "connectionId",
                                 fl_value_new_string(conn_id.c_str()));
        g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
            fl_method_success_response_new(result));
        fl_method_call_respond(call, response, nullptr);
      } else {
        g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
            fl_method_error_response_new("CONNECTION_FAILED",
                                         "Connection failed", nullptr));
        fl_method_call_respond(call, response, nullptr);
      }

      g_object_unref(call);
      delete params;
      return G_SOURCE_REMOVE;
    }, new std::pair<FlMethodCall*, std::pair<bool, std::string>>(
        method_call, std::make_pair(success, conn_id_copy)));
  }).detach();
}

// Handle 'send' method
static void handle_send(PinnedWebSocketPlugin* self,
                        FlMethodCall* method_call) {
  FlValue* args = fl_method_call_get_args(method_call);

  FlValue* conn_id_value = fl_value_lookup_string(args, "connectionId");
  FlValue* message_value = fl_value_lookup_string(args, "message");

  if (!conn_id_value || !message_value ||
      fl_value_get_type(conn_id_value) != FL_VALUE_TYPE_STRING ||
      fl_value_get_type(message_value) != FL_VALUE_TYPE_STRING) {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
        fl_method_error_response_new("INVALID_ARGS",
                                     "connectionId and message required", nullptr));
    fl_method_call_respond(method_call, response, nullptr);
    return;
  }

  std::string connection_id = fl_value_get_string(conn_id_value);
  std::string message = fl_value_get_string(message_value);

  auto& manager = pinned_websocket::ConnectionManager::Instance();
  auto* conn = manager.GetConnection(connection_id);

  if (!conn) {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
        fl_method_error_response_new("NOT_CONNECTED", "Connection not found", nullptr));
    fl_method_call_respond(method_call, response, nullptr);
    return;
  }

  bool success = conn->Send(message);

  if (success) {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
        fl_method_success_response_new(fl_value_new_bool(true)));
    fl_method_call_respond(method_call, response, nullptr);
  } else {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
        fl_method_error_response_new("SEND_FAILED", "Failed to send message", nullptr));
    fl_method_call_respond(method_call, response, nullptr);
  }
}

// Handle 'close' method
static void handle_close(PinnedWebSocketPlugin* self,
                         FlMethodCall* method_call) {
  FlValue* args = fl_method_call_get_args(method_call);

  FlValue* conn_id_value = fl_value_lookup_string(args, "connectionId");
  if (!conn_id_value || fl_value_get_type(conn_id_value) != FL_VALUE_TYPE_STRING) {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
        fl_method_error_response_new("INVALID_ARGS", "connectionId required", nullptr));
    fl_method_call_respond(method_call, response, nullptr);
    return;
  }

  std::string connection_id = fl_value_get_string(conn_id_value);

  auto& manager = pinned_websocket::ConnectionManager::Instance();
  manager.RemoveConnection(connection_id);

  g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
      fl_method_success_response_new(fl_value_new_bool(true)));
  fl_method_call_respond(method_call, response, nullptr);
}

// Method call dispatcher
static void method_call_handler(FlMethodChannel* channel,
                                FlMethodCall* method_call,
                                gpointer user_data) {
  PinnedWebSocketPlugin* self = PINNED_WEBSOCKET_PLUGIN(user_data);
  const gchar* method = fl_method_call_get_name(method_call);

  if (strcmp(method, "connect") == 0) {
    handle_connect(self, method_call);
  } else if (strcmp(method, "send") == 0) {
    handle_send(self, method_call);
  } else if (strcmp(method, "close") == 0) {
    handle_close(self, method_call);
  } else {
    g_autoptr(FlMethodResponse) response = FL_METHOD_RESPONSE(
        fl_method_not_implemented_response_new());
    fl_method_call_respond(method_call, response, nullptr);
  }
}

// Event channel handlers
static FlMethodErrorResponse* event_channel_listen(FlEventChannel* channel,
                                                   FlValue* args,
                                                   gpointer user_data) {
  PinnedWebSocketPlugin* self = PINNED_WEBSOCKET_PLUGIN(user_data);
  std::lock_guard<std::mutex> lock(*self->event_mutex);
  self->event_listening = TRUE;
  return nullptr;
}

static FlMethodErrorResponse* event_channel_cancel(FlEventChannel* channel,
                                                   FlValue* args,
                                                   gpointer user_data) {
  PinnedWebSocketPlugin* self = PINNED_WEBSOCKET_PLUGIN(user_data);
  std::lock_guard<std::mutex> lock(*self->event_mutex);
  self->event_listening = FALSE;
  return nullptr;
}

// GObject lifecycle
static void pinned_websocket_plugin_dispose(GObject* object) {
  PinnedWebSocketPlugin* self = PINNED_WEBSOCKET_PLUGIN(object);

  g_clear_object(&self->method_channel);
  g_clear_object(&self->event_channel);

  if (self->event_mutex) {
    delete self->event_mutex;
    self->event_mutex = nullptr;
  }

  if (g_plugin_instance == self) {
    g_plugin_instance = nullptr;
  }

  G_OBJECT_CLASS(pinned_websocket_plugin_parent_class)->dispose(object);
}

static void pinned_websocket_plugin_class_init(PinnedWebSocketPluginClass* klass) {
  G_OBJECT_CLASS(klass)->dispose = pinned_websocket_plugin_dispose;
}

static void pinned_websocket_plugin_init(PinnedWebSocketPlugin* self) {
  self->method_channel = nullptr;
  self->event_channel = nullptr;
  self->event_listening = FALSE;
  self->event_mutex = new std::mutex();
}

// Plugin registration
void pinned_websocket_plugin_register_with_registrar(FlPluginRegistrar* registrar) {
  PinnedWebSocketPlugin* plugin = PINNED_WEBSOCKET_PLUGIN(
      g_object_new(pinned_websocket_plugin_get_type(), nullptr));

  g_plugin_instance = plugin;

  FlBinaryMessenger* messenger = fl_plugin_registrar_get_messenger(registrar);

  // Method channel
  g_autoptr(FlStandardMethodCodec) codec = fl_standard_method_codec_new();
  plugin->method_channel = fl_method_channel_new(
      messenger, "zajel/pinned_websocket", FL_METHOD_CODEC(codec));
  fl_method_channel_set_method_call_handler(
      plugin->method_channel, method_call_handler, plugin, nullptr);

  // Event channel
  plugin->event_channel = fl_event_channel_new(
      messenger, "zajel/pinned_websocket_events", FL_METHOD_CODEC(codec));
  fl_event_channel_set_stream_handlers(
      plugin->event_channel, event_channel_listen, event_channel_cancel,
      plugin, nullptr);

  g_object_unref(plugin);
}
