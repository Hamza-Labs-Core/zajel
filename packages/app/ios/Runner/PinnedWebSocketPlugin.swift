import Flutter
import Foundation
import CommonCrypto

/// Flutter plugin for WebSocket connections with certificate pinning.
///
/// Uses URLSessionWebSocketTask with custom URLSessionDelegate for
/// certificate validation against known public key pins.
class PinnedWebSocketPlugin: NSObject, FlutterPlugin {

    private var methodChannel: FlutterMethodChannel?
    private var eventChannel: FlutterEventChannel?
    private var eventSink: FlutterEventSink?

    private var connections: [String: WebSocketConnection] = [:]

    static func register(with registrar: FlutterPluginRegistrar) {
        let instance = PinnedWebSocketPlugin()

        let methodChannel = FlutterMethodChannel(
            name: "zajel/pinned_websocket",
            binaryMessenger: registrar.messenger()
        )
        registrar.addMethodCallDelegate(instance, channel: methodChannel)
        instance.methodChannel = methodChannel

        let eventChannel = FlutterEventChannel(
            name: "zajel/pinned_websocket_events",
            binaryMessenger: registrar.messenger()
        )
        eventChannel.setStreamHandler(instance)
        instance.eventChannel = eventChannel
    }

    func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "connect":
            handleConnect(call, result: result)
        case "send":
            handleSend(call, result: result)
        case "close":
            handleClose(call, result: result)
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    private func handleConnect(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        guard let args = call.arguments as? [String: Any],
              let urlString = args["url"] as? String,
              let url = URL(string: urlString) else {
            result(FlutterError(code: "INVALID_ARGS", message: "URL is required", details: nil))
            return
        }

        let pins = args["pins"] as? [String] ?? []
        let timeoutMs = args["timeoutMs"] as? Int ?? 30000

        let connectionId = UUID().uuidString

        let connection = WebSocketConnection(
            url: url,
            pins: pins,
            timeout: TimeInterval(timeoutMs) / 1000.0,
            connectionId: connectionId,
            onEvent: { [weak self] event in
                self?.sendEvent(event)
            }
        )

        connections[connectionId] = connection

        connection.connect { success, error in
            if success {
                result([
                    "success": true,
                    "connectionId": connectionId
                ])
            } else {
                self.connections.removeValue(forKey: connectionId)
                result(FlutterError(
                    code: "CONNECTION_FAILED",
                    message: error ?? "Connection failed",
                    details: nil
                ))
            }
        }
    }

    private func handleSend(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        guard let args = call.arguments as? [String: Any],
              let connectionId = args["connectionId"] as? String,
              let message = args["message"] as? String else {
            result(FlutterError(code: "INVALID_ARGS", message: "connectionId and message required", details: nil))
            return
        }

        guard let connection = connections[connectionId] else {
            result(FlutterError(code: "NOT_CONNECTED", message: "Connection not found", details: nil))
            return
        }

        connection.send(message) { success, error in
            if success {
                result(true)
            } else {
                result(FlutterError(code: "SEND_FAILED", message: error, details: nil))
            }
        }
    }

    private func handleClose(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        guard let args = call.arguments as? [String: Any],
              let connectionId = args["connectionId"] as? String else {
            result(FlutterError(code: "INVALID_ARGS", message: "connectionId required", details: nil))
            return
        }

        if let connection = connections.removeValue(forKey: connectionId) {
            connection.close()
        }
        result(true)
    }

    private func sendEvent(_ event: [String: Any]) {
        DispatchQueue.main.async {
            self.eventSink?(event)
        }
    }
}

// MARK: - FlutterStreamHandler

extension PinnedWebSocketPlugin: FlutterStreamHandler {
    func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        self.eventSink = events
        return nil
    }

    func onCancel(withArguments arguments: Any?) -> FlutterError? {
        self.eventSink = nil
        return nil
    }
}

// MARK: - WebSocketConnection

private class WebSocketConnection: NSObject {

    private let url: URL
    private let pins: [String]
    private let timeout: TimeInterval
    private let connectionId: String
    private let onEvent: ([String: Any]) -> Void

    private var session: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var isConnected = false

    init(url: URL, pins: [String], timeout: TimeInterval, connectionId: String, onEvent: @escaping ([String: Any]) -> Void) {
        self.url = url
        self.pins = pins
        self.timeout = timeout
        self.connectionId = connectionId
        self.onEvent = onEvent
        super.init()
    }

    func connect(completion: @escaping (Bool, String?) -> Void) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout

        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        webSocketTask = session?.webSocketTask(with: url)

        webSocketTask?.resume()

        // Wait for connection or timeout
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { [weak self] in
            if self?.isConnected == true {
                completion(true, nil)
                self?.receiveMessage()
            } else {
                // Give it more time
                DispatchQueue.global().asyncAfter(deadline: .now() + self!.timeout - 0.5) { [weak self] in
                    if self?.isConnected == true {
                        completion(true, nil)
                    } else {
                        completion(false, "Connection timeout")
                    }
                }
            }
        }
    }

    func send(_ message: String, completion: @escaping (Bool, String?) -> Void) {
        webSocketTask?.send(.string(message)) { error in
            if let error = error {
                completion(false, error.localizedDescription)
            } else {
                completion(true, nil)
            }
        }
    }

    func close() {
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        isConnected = false
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.onEvent([
                        "type": "message",
                        "connectionId": self.connectionId,
                        "data": text
                    ])
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.onEvent([
                            "type": "message",
                            "connectionId": self.connectionId,
                            "data": text
                        ])
                    }
                @unknown default:
                    break
                }
                // Continue receiving
                self.receiveMessage()

            case .failure(let error):
                self.isConnected = false
                self.onEvent([
                    "type": "error",
                    "connectionId": self.connectionId,
                    "error": error.localizedDescription
                ])
            }
        }
    }
}

// MARK: - URLSessionDelegate (Certificate Pinning)

extension WebSocketConnection: URLSessionDelegate {

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {

        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // If no pins configured, use default handling
        if pins.isEmpty {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // Evaluate the server trust
        var error: CFError?
        let isValid = SecTrustEvaluateWithError(serverTrust, &error)

        guard isValid else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            onEvent([
                "type": "pinning_failed",
                "connectionId": connectionId,
                "error": "Certificate validation failed: \(error?.localizedDescription ?? "Unknown")"
            ])
            return
        }

        // Check certificate pins
        let certificateCount = SecTrustGetCertificateCount(serverTrust)
        var matched = false

        for i in 0..<certificateCount {
            if let certificate = SecTrustGetCertificateAtIndex(serverTrust, i) {
                let pin = sha256Pin(for: certificate)
                if pins.contains(pin) {
                    matched = true
                    break
                }
            }
        }

        if matched {
            isConnected = true
            onEvent([
                "type": "connected",
                "connectionId": connectionId
            ])
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            onEvent([
                "type": "pinning_failed",
                "connectionId": connectionId,
                "error": "Certificate pinning failed - no matching pin found"
            ])
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// Calculate SHA-256 hash of the certificate's public key
    private func sha256Pin(for certificate: SecCertificate) -> String {
        guard let publicKey = SecCertificateCopyKey(certificate) else {
            return ""
        }

        var error: Unmanaged<CFError>?
        guard let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            return ""
        }

        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        publicKeyData.withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(publicKeyData.count), &hash)
        }

        return Data(hash).base64EncodedString()
    }
}

extension WebSocketConnection: URLSessionWebSocketDelegate {

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        isConnected = true
        onEvent([
            "type": "connected",
            "connectionId": connectionId
        ])
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        isConnected = false
        onEvent([
            "type": "disconnected",
            "connectionId": connectionId,
            "code": closeCode.rawValue
        ])
    }
}
