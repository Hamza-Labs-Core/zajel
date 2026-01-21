#define FLUTTER_PLUGIN_IMPL

#include "pinned_websocket_plugin.h"
#include "websocket_connection.h"

#include <flutter/event_channel.h>
#include <flutter/event_stream_handler_functions.h>
#include <flutter/method_channel.h>
#include <flutter/plugin_registrar_windows.h>
#include <flutter/standard_method_codec.h>

#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

namespace pinned_websocket {

namespace {

class PinnedWebSocketPlugin : public flutter::Plugin {
 public:
  static void RegisterWithRegistrar(flutter::PluginRegistrarWindows* registrar);

  PinnedWebSocketPlugin(flutter::PluginRegistrarWindows* registrar);
  virtual ~PinnedWebSocketPlugin();

  // Disallow copy and assign
  PinnedWebSocketPlugin(const PinnedWebSocketPlugin&) = delete;
  PinnedWebSocketPlugin& operator=(const PinnedWebSocketPlugin&) = delete;

 private:
  void HandleMethodCall(
      const flutter::MethodCall<flutter::EncodableValue>& method_call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  void HandleConnect(
      const flutter::MethodCall<flutter::EncodableValue>& method_call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  void HandleSend(
      const flutter::MethodCall<flutter::EncodableValue>& method_call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  void HandleClose(
      const flutter::MethodCall<flutter::EncodableValue>& method_call,
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result);

  void SendEvent(EventType type,
                 const std::string& connection_id,
                 const std::string& data);

  flutter::PluginRegistrarWindows* registrar_;
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> method_channel_;
  std::unique_ptr<flutter::EventChannel<flutter::EncodableValue>> event_channel_;
  std::unique_ptr<flutter::EventSink<flutter::EncodableValue>> event_sink_;
  std::mutex event_mutex_;
};

void PinnedWebSocketPlugin::RegisterWithRegistrar(
    flutter::PluginRegistrarWindows* registrar) {
  auto plugin = std::make_unique<PinnedWebSocketPlugin>(registrar);
  registrar->AddPlugin(std::move(plugin));
}

PinnedWebSocketPlugin::PinnedWebSocketPlugin(
    flutter::PluginRegistrarWindows* registrar)
    : registrar_(registrar) {
  // Method channel
  method_channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      registrar->messenger(), "zajel/pinned_websocket",
      &flutter::StandardMethodCodec::GetInstance());

  method_channel_->SetMethodCallHandler(
      [this](const auto& call, auto result) {
        HandleMethodCall(call, std::move(result));
      });

  // Event channel
  event_channel_ = std::make_unique<flutter::EventChannel<flutter::EncodableValue>>(
      registrar->messenger(), "zajel/pinned_websocket_events",
      &flutter::StandardMethodCodec::GetInstance());

  auto handler = std::make_unique<flutter::StreamHandlerFunctions<flutter::EncodableValue>>(
      [this](const flutter::EncodableValue* arguments,
             std::unique_ptr<flutter::EventSink<flutter::EncodableValue>>&& events)
          -> std::unique_ptr<flutter::StreamHandlerError<flutter::EncodableValue>> {
        std::lock_guard<std::mutex> lock(event_mutex_);
        event_sink_ = std::move(events);
        return nullptr;
      },
      [this](const flutter::EncodableValue* arguments)
          -> std::unique_ptr<flutter::StreamHandlerError<flutter::EncodableValue>> {
        std::lock_guard<std::mutex> lock(event_mutex_);
        event_sink_.reset();
        return nullptr;
      });

  event_channel_->SetStreamHandler(std::move(handler));
}

PinnedWebSocketPlugin::~PinnedWebSocketPlugin() {}

void PinnedWebSocketPlugin::HandleMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& method_call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = method_call.method_name();

  if (method == "connect") {
    HandleConnect(method_call, std::move(result));
  } else if (method == "send") {
    HandleSend(method_call, std::move(result));
  } else if (method == "close") {
    HandleClose(method_call, std::move(result));
  } else {
    result->NotImplemented();
  }
}

void PinnedWebSocketPlugin::HandleConnect(
    const flutter::MethodCall<flutter::EncodableValue>& method_call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const auto* args = std::get_if<flutter::EncodableMap>(method_call.arguments());
  if (!args) {
    result->Error("INVALID_ARGS", "Expected map arguments");
    return;
  }

  // Get URL
  auto url_it = args->find(flutter::EncodableValue("url"));
  if (url_it == args->end() || !std::holds_alternative<std::string>(url_it->second)) {
    result->Error("INVALID_ARGS", "URL is required");
    return;
  }
  std::string url = std::get<std::string>(url_it->second);

  // Get pins
  std::vector<std::string> pins;
  auto pins_it = args->find(flutter::EncodableValue("pins"));
  if (pins_it != args->end() && std::holds_alternative<flutter::EncodableList>(pins_it->second)) {
    const auto& pins_list = std::get<flutter::EncodableList>(pins_it->second);
    for (const auto& pin : pins_list) {
      if (std::holds_alternative<std::string>(pin)) {
        pins.push_back(std::get<std::string>(pin));
      }
    }
  }

  // Get timeout
  int timeout_ms = 30000;
  auto timeout_it = args->find(flutter::EncodableValue("timeoutMs"));
  if (timeout_it != args->end() && std::holds_alternative<int32_t>(timeout_it->second)) {
    timeout_ms = std::get<int32_t>(timeout_it->second);
  }

  // Create connection
  auto& manager = ConnectionManager::Instance();
  std::string connection_id = manager.CreateConnection(
      url, pins, timeout_ms,
      [this](EventType type, const std::string& conn_id, const std::string& data) {
        SendEvent(type, conn_id, data);
      });

  // Connect in background thread
  auto* conn = manager.GetConnection(connection_id);
  if (!conn) {
    result->Error("INTERNAL_ERROR", "Failed to create connection");
    return;
  }

  // Use shared_ptr for thread-safe result handling
  auto shared_result = std::make_shared<
      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>>(std::move(result));
  auto conn_id_copy = connection_id;

  std::thread([shared_result, conn, conn_id_copy]() {
    bool success = conn->Connect();

    // Post result back to main thread
    // Note: In a real implementation, you'd use the registrar's task runner
    if (success) {
      flutter::EncodableMap response;
      response[flutter::EncodableValue("success")] = flutter::EncodableValue(true);
      response[flutter::EncodableValue("connectionId")] = flutter::EncodableValue(conn_id_copy);
      (*shared_result)->Success(flutter::EncodableValue(response));
    } else {
      (*shared_result)->Error("CONNECTION_FAILED", "Connection failed");
    }
  }).detach();
}

void PinnedWebSocketPlugin::HandleSend(
    const flutter::MethodCall<flutter::EncodableValue>& method_call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const auto* args = std::get_if<flutter::EncodableMap>(method_call.arguments());
  if (!args) {
    result->Error("INVALID_ARGS", "Expected map arguments");
    return;
  }

  auto conn_id_it = args->find(flutter::EncodableValue("connectionId"));
  auto message_it = args->find(flutter::EncodableValue("message"));

  if (conn_id_it == args->end() || !std::holds_alternative<std::string>(conn_id_it->second) ||
      message_it == args->end() || !std::holds_alternative<std::string>(message_it->second)) {
    result->Error("INVALID_ARGS", "connectionId and message required");
    return;
  }

  std::string connection_id = std::get<std::string>(conn_id_it->second);
  std::string message = std::get<std::string>(message_it->second);

  auto& manager = ConnectionManager::Instance();
  auto* conn = manager.GetConnection(connection_id);

  if (!conn) {
    result->Error("NOT_CONNECTED", "Connection not found");
    return;
  }

  bool success = conn->Send(message);
  if (success) {
    result->Success(flutter::EncodableValue(true));
  } else {
    result->Error("SEND_FAILED", "Failed to send message");
  }
}

void PinnedWebSocketPlugin::HandleClose(
    const flutter::MethodCall<flutter::EncodableValue>& method_call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const auto* args = std::get_if<flutter::EncodableMap>(method_call.arguments());
  if (!args) {
    result->Error("INVALID_ARGS", "Expected map arguments");
    return;
  }

  auto conn_id_it = args->find(flutter::EncodableValue("connectionId"));
  if (conn_id_it == args->end() || !std::holds_alternative<std::string>(conn_id_it->second)) {
    result->Error("INVALID_ARGS", "connectionId required");
    return;
  }

  std::string connection_id = std::get<std::string>(conn_id_it->second);

  auto& manager = ConnectionManager::Instance();
  manager.RemoveConnection(connection_id);

  result->Success(flutter::EncodableValue(true));
}

void PinnedWebSocketPlugin::SendEvent(EventType type,
                                      const std::string& connection_id,
                                      const std::string& data) {
  std::lock_guard<std::mutex> lock(event_mutex_);
  if (!event_sink_) return;

  flutter::EncodableMap event;

  const char* type_str = nullptr;
  switch (type) {
    case EventType::kConnected:
      type_str = "connected";
      break;
    case EventType::kMessage:
      type_str = "message";
      break;
    case EventType::kDisconnected:
      type_str = "disconnected";
      break;
    case EventType::kError:
      type_str = "error";
      break;
    case EventType::kPinningFailed:
      type_str = "pinning_failed";
      break;
  }

  event[flutter::EncodableValue("type")] = flutter::EncodableValue(type_str);
  event[flutter::EncodableValue("connectionId")] = flutter::EncodableValue(connection_id);

  if (type == EventType::kMessage) {
    event[flutter::EncodableValue("data")] = flutter::EncodableValue(data);
  } else if (type == EventType::kError || type == EventType::kPinningFailed) {
    event[flutter::EncodableValue("error")] = flutter::EncodableValue(data);
  }

  event_sink_->Success(flutter::EncodableValue(event));
}

}  // namespace

void PinnedWebSocketPluginRegisterWithRegistrar(
    flutter::PluginRegistrarWindows* registrar) {
  PinnedWebSocketPlugin::RegisterWithRegistrar(registrar);
}

}  // namespace pinned_websocket
