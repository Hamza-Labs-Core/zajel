import FlutterMacOS
import Foundation
import CommonCrypto
import os.log

/// Debug logging for production troubleshooting
private func pwsLog(_ message: String) {
    NSLog("[PinnedWebSocket] %@", message)
}

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
            pwsLog("handleConnect: Invalid arguments - URL is required")
            result(FlutterError(code: "INVALID_ARGS", message: "URL is required", details: nil))
            return
        }

        let pins = args["pins"] as? [String] ?? []
        let timeoutMs = args["timeoutMs"] as? Int ?? 30000

        pwsLog("handleConnect: url=\(urlString), pins_count=\(pins.count), timeout=\(timeoutMs)ms")

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
                pwsLog("handleConnect: Connection successful, id=\(connectionId)")
                result([
                    "success": true,
                    "connectionId": connectionId
                ])
            } else {
                pwsLog("handleConnect: Connection failed - \(error ?? "unknown error")")
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
            pwsLog("handleClose: Invalid arguments - connectionId required")
            result(FlutterError(code: "INVALID_ARGS", message: "connectionId required", details: nil))
            return
        }

        pwsLog("handleClose: Closing connection \(connectionId)")
        if let connection = connections.removeValue(forKey: connectionId) {
            connection.close()
            pwsLog("handleClose: Connection closed")
        } else {
            pwsLog("handleClose: Connection not found")
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
        pwsLog("Connect: Starting connection to \(url.absoluteString)")
        pwsLog("Connect: pins_count=\(pins.count), timeout=\(timeout)s")

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout

        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        webSocketTask = session?.webSocketTask(with: url)

        pwsLog("Connect: Resuming WebSocket task")
        webSocketTask?.resume()

        // Capture timeout for async context
        let capturedTimeout = timeout

        // Wait for connection or timeout
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self = self else {
                pwsLog("Connect: Connection deallocated")
                completion(false, "Connection deallocated")
                return
            }

            if self.isConnected {
                pwsLog("Connect: Connection established (fast path)")
                completion(true, nil)
                self.receiveMessage()
            } else {
                // Give it more time
                let remainingTimeout = max(capturedTimeout - 0.5, 0.1)
                pwsLog("Connect: Waiting additional \(remainingTimeout)s for connection")
                DispatchQueue.global().asyncAfter(deadline: .now() + remainingTimeout) { [weak self] in
                    if self?.isConnected == true {
                        pwsLog("Connect: Connection established (slow path)")
                        completion(true, nil)
                    } else {
                        pwsLog("Connect: Connection timeout")
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
        pwsLog("Close: Closing WebSocket connection \(connectionId)")
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        session?.invalidateAndCancel()
        isConnected = false
        pwsLog("Close: Connection closed")
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
                    pwsLog("ReceiveMessage: Unknown message type received")
                    break
                }
                // Continue receiving
                self.receiveMessage()

            case .failure(let error):
                pwsLog("ReceiveMessage: Error - \(error.localizedDescription)")
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

        pwsLog("TLS: Received authentication challenge: \(challenge.protectionSpace.authenticationMethod)")

        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            pwsLog("TLS: Not server trust challenge, using default handling")
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // If no pins configured, use default handling
        if pins.isEmpty {
            pwsLog("TLS: No pins configured, using default handling")
            completionHandler(.performDefaultHandling, nil)
            return
        }

        pwsLog("TLS: Checking certificate pins (count=\(pins.count))")

        // Evaluate the server trust
        var error: CFError?
        let isValid = SecTrustEvaluateWithError(serverTrust, &error)

        guard isValid else {
            pwsLog("TLS: Certificate validation failed: \(error?.localizedDescription ?? "Unknown")")
            completionHandler(.cancelAuthenticationChallenge, nil)
            onEvent([
                "type": "pinning_failed",
                "connectionId": connectionId,
                "error": "Certificate validation failed: \(error?.localizedDescription ?? "Unknown")"
            ])
            return
        }
        pwsLog("TLS: Certificate validation passed")

        // Check certificate pins
        let certificateCount = SecTrustGetCertificateCount(serverTrust)
        pwsLog("TLS: Certificate chain length: \(certificateCount)")
        var matched = false

        for i in 0..<certificateCount {
            if let certificate = SecTrustGetCertificateAtIndex(serverTrust, i) {
                let pin = sha256Pin(for: certificate)
                pwsLog("TLS: Checking pin at index \(i)")
                if pins.contains(pin) {
                    pwsLog("TLS: Pin matched at chain index \(i)")
                    matched = true
                    break
                }
            }
        }

        if matched {
            pwsLog("TLS: Certificate pinning verification successful")
            isConnected = true
            onEvent([
                "type": "connected",
                "connectionId": connectionId
            ])
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            pwsLog("TLS: Certificate pinning failed - no matching pin found")
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
        // Determine key type from attributes
        guard let attributes = SecKeyCopyAttributes(publicKey) as? [String: Any],
              let keyType = attributes[kSecAttrKeyType as String] as? String else {
            return nil
        }

        var header: [UInt8]

        if keyType == (kSecAttrKeyTypeRSA as String) {
            // RSA SPKI header: SEQUENCE { SEQUENCE { OID rsaEncryption, NULL }, BIT STRING { ... } }
            // OID 1.2.840.113549.1.1.1 = rsaEncryption
            // Use actual raw key data size to compute correct ASN.1 lengths
            guard let rsaHeader = buildRSASPKIHeader(rawKeySize: rawKeyData.count) else {
                return nil
            }
            header = rsaHeader
        } else if keyType == (kSecAttrKeyTypeECSECPrimeRandom as String) ||
                  keyType == (kSecAttrKeyTypeEC as String) {
            // EC SPKI header: SEQUENCE { SEQUENCE { OID ecPublicKey, OID curve }, BIT STRING { ... } }
            // Determine curve from raw key data size:
            // P-256: 65 bytes (04 + 32 + 32)
            // P-384: 97 bytes (04 + 48 + 48)
            // P-521: 133 bytes (04 + 66 + 66)
            guard let ecHeader = buildECSPKIHeader(rawKeySize: rawKeyData.count) else {
                return nil
            }
            header = ecHeader
        } else {
            // Unknown key type, return nil
            return nil
        }

        // Combine header with raw key data
        var spkiData = Data(header)
        spkiData.append(rawKeyData)

        return spkiData
    }

    /// Builds RSA SPKI ASN.1 header based on actual raw key data size.
    /// Supports 2048, 3072, and 4096 bit keys.
    private func buildRSASPKIHeader(rawKeySize: Int) -> [UInt8]? {
        // RSA Algorithm Identifier: SEQUENCE { OID rsaEncryption, NULL }
        // OID 1.2.840.113549.1.1.1 = rsaEncryption
        let algorithmIdentifier: [UInt8] = [
            0x30, 0x0d,              // SEQUENCE, length 13
            0x06, 0x09,              // OID, length 9
            0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,  // rsaEncryption OID
            0x05, 0x00               // NULL
        ]

        // BIT STRING has 1 byte for "unused bits" (always 0) + raw key data
        let bitStringContentLength = 1 + rawKeySize

        // Calculate total lengths:
        // BIT STRING = tag(1) + length(varies) + 0x00(1) + rawKeyData
        // SEQUENCE content = algorithmIdentifier + BIT STRING
        let bitStringTotalLength = 1 + encodeASN1Length(bitStringContentLength).count + bitStringContentLength
        let sequenceLength = algorithmIdentifier.count + bitStringTotalLength

        // Build SEQUENCE header
        var sequenceHeader: [UInt8] = [0x30]  // SEQUENCE tag
        sequenceHeader.append(contentsOf: encodeASN1Length(sequenceLength))

        // Combine: SEQUENCE header + algorithmIdentifier + BIT STRING header (without raw data)
        var header = sequenceHeader
        header.append(contentsOf: algorithmIdentifier)
        header.append(0x03)  // BIT STRING tag
        header.append(contentsOf: encodeASN1Length(bitStringContentLength))
        header.append(0x00)  // unused bits = 0

        return header
    }

    /// Builds EC SPKI ASN.1 header based on actual raw key data size.
    /// Supports P-256 (65 bytes), P-384 (97 bytes), and P-521 (133 bytes).
    private func buildECSPKIHeader(rawKeySize: Int) -> [UInt8]? {
        // EC Algorithm Identifier: SEQUENCE { OID ecPublicKey, OID curve }
        // OID 1.2.840.10045.2.1 = ecPublicKey
        let ecPublicKeyOID: [UInt8] = [
            0x06, 0x07,              // OID, length 7
            0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01  // ecPublicKey OID
        ]

        // Determine curve OID based on raw key size
        var curveOID: [UInt8]
        switch rawKeySize {
        case 65:  // P-256: 04 + 32 + 32
            // OID 1.2.840.10045.3.1.7 = prime256v1 (secp256r1)
            curveOID = [
                0x06, 0x08,          // OID, length 8
                0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07
            ]
        case 97:  // P-384: 04 + 48 + 48
            // OID 1.3.132.0.34 = secp384r1
            curveOID = [
                0x06, 0x05,          // OID, length 5
                0x2b, 0x81, 0x04, 0x00, 0x22
            ]
        case 133:  // P-521: 04 + 66 + 66
            // OID 1.3.132.0.35 = secp521r1
            curveOID = [
                0x06, 0x05,          // OID, length 5
                0x2b, 0x81, 0x04, 0x00, 0x23
            ]
        default:
            // Unsupported curve
            return nil
        }

        // Build Algorithm Identifier SEQUENCE
        let algorithmIdentifierContent = ecPublicKeyOID + curveOID
        var algorithmIdentifier: [UInt8] = [0x30]  // SEQUENCE tag
        algorithmIdentifier.append(contentsOf: encodeASN1Length(algorithmIdentifierContent.count))
        algorithmIdentifier.append(contentsOf: algorithmIdentifierContent)

        // BIT STRING has 1 byte for "unused bits" (always 0) + raw key data
        let bitStringContentLength = 1 + rawKeySize

        // Total SEQUENCE content length
        let bitStringTotalLength = 1 + encodeASN1Length(bitStringContentLength).count + bitStringContentLength
        let sequenceLength = algorithmIdentifier.count + bitStringTotalLength

        // Build SEQUENCE header
        var sequenceHeader: [UInt8] = [0x30]  // SEQUENCE tag
        sequenceHeader.append(contentsOf: encodeASN1Length(sequenceLength))

        // Combine: SEQUENCE header + algorithmIdentifier + BIT STRING header (without raw data)
        var header = sequenceHeader
        header.append(contentsOf: algorithmIdentifier)
        header.append(0x03)  // BIT STRING tag
        header.append(contentsOf: encodeASN1Length(bitStringContentLength))
        header.append(0x00)  // unused bits = 0

        return header
    }

    /// Encodes a length value in ASN.1 DER format.
    /// - For lengths 0-127: single byte
    /// - For lengths 128-255: 0x81 followed by length byte
    /// - For lengths 256-65535: 0x82 followed by two length bytes (big-endian)
    private func encodeASN1Length(_ length: Int) -> [UInt8] {
        if length < 128 {
            return [UInt8(length)]
        } else if length < 256 {
            return [0x81, UInt8(length)]
        } else {
            return [0x82, UInt8((length >> 8) & 0xFF), UInt8(length & 0xFF)]
        }
    }
}

extension WebSocketConnection: URLSessionWebSocketDelegate {

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        pwsLog("WebSocket: Connection opened, protocol=\(`protocol` ?? "none")")
        isConnected = true
        onEvent([
            "type": "connected",
            "connectionId": connectionId
        ])
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        pwsLog("WebSocket: Connection closed, code=\(closeCode.rawValue)")
        isConnected = false
        onEvent([
            "type": "disconnected",
            "connectionId": connectionId,
            "code": closeCode.rawValue
        ])
    }
}
