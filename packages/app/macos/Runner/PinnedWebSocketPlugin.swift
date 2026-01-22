import FlutterMacOS
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
            binaryMessenger: registrar.messenger
        )
        registrar.addMethodCallDelegate(instance, channel: methodChannel)
        instance.methodChannel = methodChannel

        let eventChannel = FlutterEventChannel(
            name: "zajel/pinned_websocket_events",
            binaryMessenger: registrar.messenger
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

        // Capture timeout for async context
        let capturedTimeout = timeout

        // Wait for connection or timeout
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else {
                completion(false, "Connection deallocated")
                return
            }

            if self.isConnected {
                completion(true, nil)
                self.receiveMessage()
            } else {
                // Give it more time
                let remainingTimeout = max(capturedTimeout - 0.5, 0.1)
                DispatchQueue.global().asyncAfter(deadline: .now() + remainingTimeout) { [weak self] in
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

    /// Calculate SHA-256 hash of the certificate's Subject Public Key Info (SPKI).
    /// This matches the standard SPKI pinning format used by Android, Chrome, OkHttp, etc.
    /// The SPKI includes the algorithm identifier (OID) header prepended to the raw public key.
    private func sha256Pin(for certificate: SecCertificate) -> String {
        guard let publicKey = SecCertificateCopyKey(certificate) else {
            return ""
        }

        var error: Unmanaged<CFError>?
        guard let publicKeyData = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            return ""
        }

        // Get the key type and wrap the raw key in SPKI format
        guard let spkiData = wrapInSPKI(publicKey: publicKey, rawKeyData: publicKeyData) else {
            return ""
        }

        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        spkiData.withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(spkiData.count), &hash)
        }

        return Data(hash).base64EncodedString()
    }

    /// Wraps raw public key data in SubjectPublicKeyInfo (SPKI) ASN.1 structure.
    /// This makes macOS pins compatible with Android's cert.publicKey.encoded format.
    private func wrapInSPKI(publicKey: SecKey, rawKeyData: Data) -> Data? {
        // ASN.1 headers for different key types (algorithm identifier + bit string wrapper)
        // These headers are the DER encoding of the AlgorithmIdentifier and BitString wrapper

        // RSA SPKI header: SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, BIT STRING { ... } }
        // OID 1.2.840.113549.1.1.1 = rsaEncryption
        let rsa2048Header: [UInt8] = [
            0x30, 0x82, 0x01, 0x22,  // SEQUENCE, length 290
            0x30, 0x0d,              // SEQUENCE, length 13
            0x06, 0x09,              // OID, length 9
            0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,  // rsaEncryption OID
            0x05, 0x00,              // NULL
            0x03, 0x82, 0x01, 0x0f,  // BIT STRING, length 271
            0x00                     // unused bits = 0
        ]

        let rsa4096Header: [UInt8] = [
            0x30, 0x82, 0x02, 0x22,  // SEQUENCE, length 546
            0x30, 0x0d,              // SEQUENCE, length 13
            0x06, 0x09,              // OID, length 9
            0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,  // rsaEncryption OID
            0x05, 0x00,              // NULL
            0x03, 0x82, 0x02, 0x0f,  // BIT STRING, length 527
            0x00                     // unused bits = 0
        ]

        // EC P-256 SPKI header: SEQUENCE { SEQUENCE { OID ecPublicKey, OID prime256v1 }, BIT STRING { ... } }
        // OID 1.2.840.10045.2.1 = ecPublicKey, OID 1.2.840.10045.3.1.7 = prime256v1
        let ecP256Header: [UInt8] = [
            0x30, 0x59,              // SEQUENCE, length 89
            0x30, 0x13,              // SEQUENCE, length 19
            0x06, 0x07,              // OID, length 7
            0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,  // ecPublicKey OID
            0x06, 0x08,              // OID, length 8
            0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,  // prime256v1 OID
            0x03, 0x42,              // BIT STRING, length 66
            0x00                     // unused bits = 0
        ]

        // EC P-384 SPKI header
        // OID 1.3.132.0.34 = secp384r1
        let ecP384Header: [UInt8] = [
            0x30, 0x76,              // SEQUENCE, length 118
            0x30, 0x10,              // SEQUENCE, length 16
            0x06, 0x07,              // OID, length 7
            0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,  // ecPublicKey OID
            0x06, 0x05,              // OID, length 5
            0x2b, 0x81, 0x04, 0x00, 0x22,  // secp384r1 OID
            0x03, 0x62,              // BIT STRING, length 98
            0x00                     // unused bits = 0
        ]

        // Determine key type from attributes
        guard let attributes = SecKeyCopyAttributes(publicKey) as? [String: Any],
              let keyType = attributes[kSecAttrKeyType as String] as? String,
              let keySize = attributes[kSecAttrKeySizeInBits as String] as? Int else {
            return nil
        }

        var header: [UInt8]

        if keyType == (kSecAttrKeyTypeRSA as String) {
            if keySize <= 2048 {
                header = rsa2048Header
            } else {
                header = rsa4096Header
            }
        } else if keyType == (kSecAttrKeyTypeECSECPrimeRandom as String) ||
                  keyType == (kSecAttrKeyTypeEC as String) {
            if keySize <= 256 {
                header = ecP256Header
            } else {
                header = ecP384Header
            }
        } else {
            // Unknown key type, return nil
            return nil
        }

        // Combine header with raw key data
        var spkiData = Data(header)
        spkiData.append(rawKeyData)

        return spkiData
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
