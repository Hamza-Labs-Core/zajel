#include "flutter_window.h"

#include <optional>
#include <shellapi.h>

#include "flutter/generated_plugin_registrant.h"
#include <flutter/method_channel.h>
#include <flutter/plugin_registrar_windows.h>
#include <flutter/standard_method_codec.h>
#include "pinned_websocket_plugin.h"

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());

  // Register custom pinned WebSocket plugin
  auto registrar_ref = flutter_controller_->engine()->GetRegistrarForPlugin("PinnedWebSocketPlugin");
  auto* registrar = flutter::PluginRegistrarManager::GetInstance()
      ->GetRegistrar<flutter::PluginRegistrarWindows>(registrar_ref);
  pinned_websocket::PinnedWebSocketPluginRegisterWithRegistrar(registrar);

  // Register privacy screen method channel (SetWindowDisplayAffinity)
  auto privacy_registrar_ref = flutter_controller_->engine()->GetRegistrarForPlugin("PrivacyPlugin");
  auto* privacy_registrar = flutter::PluginRegistrarManager::GetInstance()
      ->GetRegistrar<flutter::PluginRegistrarWindows>(privacy_registrar_ref);
  auto privacy_channel = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      privacy_registrar->messenger(), "com.zajel.zajel/privacy",
      &flutter::StandardMethodCodec::GetInstance());

  HWND window_handle = GetHandle();
  privacy_channel->SetMethodCallHandler(
      [window_handle](const flutter::MethodCall<flutter::EncodableValue>& call,
                      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
        if (call.method_name() == "enableSecureScreen") {
          // WDA_EXCLUDEFROMCAPTURE (0x11) hides window from screen capture
          // Available on Windows 10 version 2004+
          BOOL success = SetWindowDisplayAffinity(window_handle, WDA_EXCLUDEFROMCAPTURE);
          if (success) {
            result->Success();
          } else {
            result->Error("FAILED", "SetWindowDisplayAffinity failed");
          }
        } else if (call.method_name() == "disableSecureScreen") {
          BOOL success = SetWindowDisplayAffinity(window_handle, WDA_NONE);
          if (success) {
            result->Success();
          } else {
            result->Error("FAILED", "SetWindowDisplayAffinity failed");
          }
        } else {
          result->NotImplemented();
        }
      });

  // Register notification method channel (Shell_NotifyIconW balloon tips)
  auto notif_registrar_ref = flutter_controller_->engine()->GetRegistrarForPlugin("NotificationPlugin");
  auto* notif_registrar = flutter::PluginRegistrarManager::GetInstance()
      ->GetRegistrar<flutter::PluginRegistrarWindows>(notif_registrar_ref);
  auto notif_channel = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      notif_registrar->messenger(), "com.zajel.zajel/notifications",
      &flutter::StandardMethodCodec::GetInstance());

  notif_channel->SetMethodCallHandler(
      [window_handle](const flutter::MethodCall<flutter::EncodableValue>& call,
                      std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
        if (call.method_name() == "showNotification") {
          const auto* args = std::get_if<flutter::EncodableMap>(call.arguments());
          if (!args) {
            result->Error("INVALID_ARGS", "Expected map arguments");
            return;
          }

          std::string title;
          std::string body;

          auto title_it = args->find(flutter::EncodableValue("title"));
          if (title_it != args->end()) {
            title = std::get<std::string>(title_it->second);
          }
          auto body_it = args->find(flutter::EncodableValue("body"));
          if (body_it != args->end()) {
            body = std::get<std::string>(body_it->second);
          }

          NOTIFYICONDATAW nid = {};
          nid.cbSize = sizeof(nid);
          nid.hWnd = window_handle;
          nid.uID = 1;
          nid.uFlags = NIF_INFO | NIF_ICON | NIF_TIP;
          nid.dwInfoFlags = NIIF_INFO;
          nid.hIcon = LoadIcon(nullptr, IDI_APPLICATION);

          // Convert UTF-8 strings to wide strings for Win32 API
          MultiByteToWideChar(CP_UTF8, 0, title.c_str(), -1, nid.szInfoTitle, 64);
          MultiByteToWideChar(CP_UTF8, 0, body.c_str(), -1, nid.szInfo, 256);
          MultiByteToWideChar(CP_UTF8, 0, "Zajel", -1, nid.szTip, 128);

          // Try to modify existing tray icon; add it if it doesn't exist yet
          if (!Shell_NotifyIconW(NIM_MODIFY, &nid)) {
            Shell_NotifyIconW(NIM_ADD, &nid);
          }

          result->Success();
        } else if (call.method_name() == "cancelNotification") {
          NOTIFYICONDATAW nid = {};
          nid.cbSize = sizeof(nid);
          nid.hWnd = window_handle;
          nid.uID = 1;
          Shell_NotifyIconW(NIM_DELETE, &nid);
          result->Success();
        } else {
          result->NotImplemented();
        }
      });

  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
