#ifndef WEBSOCKET_CONNECTION_H_
#define WEBSOCKET_CONNECTION_H_

#include <winsock2.h>
#include <ws2tcpip.h>

#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if HAVE_OPENSSL
#include <openssl/ssl.h>
#include <openssl/x509.h>
#endif

namespace pinned_websocket {

/**
 * Event types sent from WebSocket connections.
 */
enum class EventType {
  kConnected,
  kMessage,
  kDisconnected,
  kError,
  kPinningFailed
};

/**
 * Callback for WebSocket events.
 */
using EventCallback = std::function<void(
    EventType type,
    const std::string& connection_id,
    const std::string& data)>;

/**
 * Manages a single WebSocket connection with certificate pinning.
 */
class WebSocketConnection {
 public:
  WebSocketConnection(const std::string& url,
                      const std::vector<std::string>& pins,
                      int timeout_ms,
                      const std::string& connection_id,
                      EventCallback callback);
  ~WebSocketConnection();

  /**
   * Initiates the WebSocket connection.
   * @return true if connection initiated successfully.
   */
  bool Connect();

  /**
   * Sends a message through the WebSocket.
   * @param message The message to send.
   * @return true if send was successful.
   */
  bool Send(const std::string& message);

  /**
   * Closes the WebSocket connection.
   */
  void Close();

  /**
   * Returns the connection ID.
   */
  const std::string& connection_id() const { return connection_id_; }

  /**
   * Returns whether the connection is established.
   */
  bool is_connected() const { return is_connected_; }

 private:
  /**
   * Parses the URL into host, port, and path components.
   */
  bool ParseUrl();

  /**
   * Performs the TLS handshake with certificate pinning.
   */
  bool PerformTlsHandshake();

#if HAVE_OPENSSL
  /**
   * Verifies the server certificate against configured pins.
   */
  bool VerifyCertificatePins(X509* cert);

  /**
   * Calculates the SPKI pin for a certificate.
   */
  std::string CalculateSpkiPin(X509* cert);
#endif

  /**
   * Performs the WebSocket handshake.
   */
  bool PerformWebSocketHandshake();

  /**
   * Thread function for receiving messages.
   */
  void ReceiveLoop();

  /**
   * Sends a WebSocket frame.
   */
  bool SendFrame(uint8_t opcode, const std::string& payload);

  /**
   * Reads a WebSocket frame.
   */
  bool ReadFrame(uint8_t& opcode, std::string& payload);

  /**
   * Reads bytes from socket (handles both TLS and plain).
   */
  int ReadBytes(void* buffer, int len);

  /**
   * Writes bytes to socket (handles both TLS and plain).
   */
  int WriteBytes(const void* buffer, int len);

  std::string url_;
  std::vector<std::string> pins_;
  int timeout_ms_;
  std::string connection_id_;
  EventCallback callback_;

  std::string host_;
  int port_;
  std::string path_;
  bool use_tls_;

  SOCKET socket_fd_;
#if HAVE_OPENSSL
  SSL_CTX* ssl_ctx_;
  SSL* ssl_;
#endif

  std::atomic<bool> is_connected_;
  std::atomic<bool> should_stop_;
  std::thread receive_thread_;
  std::mutex send_mutex_;
};

/**
 * Manages all WebSocket connections.
 */
class ConnectionManager {
 public:
  static ConnectionManager& Instance();

  /**
   * Creates a new WebSocket connection.
   */
  std::string CreateConnection(const std::string& url,
                               const std::vector<std::string>& pins,
                               int timeout_ms,
                               EventCallback callback);

  /**
   * Gets a connection by ID.
   */
  WebSocketConnection* GetConnection(const std::string& connection_id);

  /**
   * Removes a connection by ID.
   */
  void RemoveConnection(const std::string& connection_id);

 private:
  ConnectionManager();
  ~ConnectionManager();

  std::map<std::string, std::unique_ptr<WebSocketConnection>> connections_;
  std::mutex mutex_;
};

}  // namespace pinned_websocket

#endif  // WEBSOCKET_CONNECTION_H_
