import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }

  override func applicationDidFinishLaunching(_ notification: Notification) {
    // Register custom plugins
    if let registrar = self.registrar(forPlugin: "PinnedWebSocketPlugin") {
      PinnedWebSocketPlugin.register(with: registrar)
    }
  }
}
