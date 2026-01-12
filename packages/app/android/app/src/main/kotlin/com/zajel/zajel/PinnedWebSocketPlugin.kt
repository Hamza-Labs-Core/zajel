package com.zajel.zajel

import android.os.Handler
import android.os.Looper
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import okhttp3.*
import okhttp3.tls.HeldCertificate
import java.security.MessageDigest
import java.security.cert.Certificate
import java.security.cert.X509Certificate
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.*

/**
 * Flutter plugin for WebSocket connections with certificate pinning.
 *
 * Uses OkHttp for WebSocket connections with custom certificate pinner
 * to validate server certificates against known public key pins.
 */
class PinnedWebSocketPlugin : FlutterPlugin, MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler {

    private lateinit var methodChannel: MethodChannel
    private lateinit var eventChannel: EventChannel
    private var eventSink: EventChannel.EventSink? = null

    private val connections = ConcurrentHashMap<String, WebSocket>()
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methodChannel = MethodChannel(binding.binaryMessenger, "zajel/pinned_websocket")
        methodChannel.setMethodCallHandler(this)

        eventChannel = EventChannel(binding.binaryMessenger, "zajel/pinned_websocket_events")
        eventChannel.setStreamHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methodChannel.setMethodCallHandler(null)
        eventChannel.setStreamHandler(null)

        // Close all connections
        connections.values.forEach { it.close(1000, "Plugin detached") }
        connections.clear()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "connect" -> handleConnect(call, result)
            "send" -> handleSend(call, result)
            "close" -> handleClose(call, result)
            else -> result.notImplemented()
        }
    }

    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
        eventSink = events
    }

    override fun onCancel(arguments: Any?) {
        eventSink = null
    }

    private fun handleConnect(call: MethodCall, result: MethodChannel.Result) {
        val url = call.argument<String>("url")
        val pins = call.argument<List<String>>("pins") ?: emptyList()
        val timeoutMs = call.argument<Int>("timeoutMs") ?: 30000

        if (url == null) {
            result.error("INVALID_ARGS", "URL is required", null)
            return
        }

        val connectionId = UUID.randomUUID().toString()

        try {
            val client = buildOkHttpClient(pins, timeoutMs.toLong())
            val request = Request.Builder()
                .url(url)
                .build()

            val webSocket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    sendEvent(mapOf(
                        "type" to "connected",
                        "connectionId" to connectionId
                    ))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    sendEvent(mapOf(
                        "type" to "message",
                        "connectionId" to connectionId,
                        "data" to text
                    ))
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    connections.remove(connectionId)
                    sendEvent(mapOf(
                        "type" to "disconnected",
                        "connectionId" to connectionId,
                        "code" to code,
                        "reason" to reason
                    ))
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    connections.remove(connectionId)

                    val errorType = when {
                        t is SSLPeerUnverifiedException -> "pinning_failed"
                        t is SSLHandshakeException -> "pinning_failed"
                        else -> "error"
                    }

                    sendEvent(mapOf(
                        "type" to errorType,
                        "connectionId" to connectionId,
                        "error" to (t.message ?: "Connection failed")
                    ))
                }
            })

            connections[connectionId] = webSocket

            result.success(mapOf(
                "success" to true,
                "connectionId" to connectionId
            ))
        } catch (e: Exception) {
            result.error("CONNECTION_FAILED", e.message, null)
        }
    }

    private fun handleSend(call: MethodCall, result: MethodChannel.Result) {
        val connectionId = call.argument<String>("connectionId")
        val message = call.argument<String>("message")

        if (connectionId == null || message == null) {
            result.error("INVALID_ARGS", "connectionId and message are required", null)
            return
        }

        val webSocket = connections[connectionId]
        if (webSocket == null) {
            result.error("NOT_CONNECTED", "Connection not found", null)
            return
        }

        val sent = webSocket.send(message)
        if (sent) {
            result.success(true)
        } else {
            result.error("SEND_FAILED", "Failed to send message", null)
        }
    }

    private fun handleClose(call: MethodCall, result: MethodChannel.Result) {
        val connectionId = call.argument<String>("connectionId")

        if (connectionId == null) {
            result.error("INVALID_ARGS", "connectionId is required", null)
            return
        }

        val webSocket = connections.remove(connectionId)
        webSocket?.close(1000, "Client closed")
        result.success(true)
    }

    private fun buildOkHttpClient(pins: List<String>, timeoutMs: Long): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .pingInterval(30, TimeUnit.SECONDS)

        // Add certificate pinning if pins are provided
        if (pins.isNotEmpty()) {
            val trustManager = PinningTrustManager(pins)
            val sslContext = SSLContext.getInstance("TLS")
            sslContext.init(null, arrayOf(trustManager), null)

            builder.sslSocketFactory(sslContext.socketFactory, trustManager)
        }

        return builder.build()
    }

    private fun sendEvent(event: Map<String, Any?>) {
        mainHandler.post {
            eventSink?.success(event)
        }
    }

    /**
     * Custom TrustManager that validates certificates against SPKI pins.
     */
    private class PinningTrustManager(private val pins: List<String>) : X509TrustManager {

        private val defaultTrustManager: X509TrustManager by lazy {
            val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            factory.init(null as java.security.KeyStore?)
            factory.trustManagers.first { it is X509TrustManager } as X509TrustManager
        }

        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            defaultTrustManager.checkClientTrusted(chain, authType)
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            // First, do standard validation
            defaultTrustManager.checkServerTrusted(chain, authType)

            // If no pins configured, accept any valid certificate
            if (pins.isEmpty()) {
                return
            }

            // Then check if any certificate in the chain matches our pins
            if (chain == null || chain.isEmpty()) {
                throw SSLPeerUnverifiedException("Empty certificate chain")
            }

            val chainPins = chain.map { cert -> sha256Pin(cert) }

            val matched = chainPins.any { certPin -> pins.contains(certPin) }

            if (!matched) {
                throw SSLPeerUnverifiedException(
                    "Certificate pinning failed. " +
                    "Expected one of: ${pins.joinToString()} " +
                    "Got: ${chainPins.joinToString()}"
                )
            }
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> {
            return defaultTrustManager.acceptedIssuers
        }

        /**
         * Calculate the SHA-256 hash of the certificate's Subject Public Key Info (SPKI)
         * and encode it as base64.
         */
        private fun sha256Pin(cert: X509Certificate): String {
            val publicKeyEncoded = cert.publicKey.encoded
            val digest = MessageDigest.getInstance("SHA-256")
            val hash = digest.digest(publicKeyEncoded)
            return android.util.Base64.encodeToString(hash, android.util.Base64.NO_WRAP)
        }
    }
}
