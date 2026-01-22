#include "websocket_connection.h"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/random.h>

#include <algorithm>
#include <cstring>
#include <iomanip>
#include <random>
#include <sstream>

#if HAVE_OPENSSL
#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/sha.h>
#endif

// Debug logging macro for production troubleshooting
#define PWSLOG(fmt, ...) \
  fprintf(stderr, "[PinnedWebSocket] " fmt "\n", ##__VA_ARGS__)

namespace pinned_websocket {

namespace {

#if HAVE_OPENSSL
// Base64 encoding helper using OpenSSL
std::string Base64Encode(const unsigned char* data, size_t len) {
  BIO* bio = BIO_new(BIO_s_mem());
  BIO* b64 = BIO_new(BIO_f_base64());
  BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
  bio = BIO_push(b64, bio);
  BIO_write(bio, data, static_cast<int>(len));
  BIO_flush(bio);

  BUF_MEM* buf = nullptr;
  BIO_get_mem_ptr(bio, &buf);
  std::string result(buf->data, buf->length);
  BIO_free_all(bio);
  return result;
}

// SHA-1 for WebSocket accept key
void SHA1Hash(const unsigned char* data, size_t len, unsigned char* out) {
  SHA1(data, len, out);
}
#else
// Simple Base64 encoding without OpenSSL
static const char* base64_chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string Base64Encode(const unsigned char* data, size_t len) {
  std::string result;
  result.reserve(((len + 2) / 3) * 4);

  for (size_t i = 0; i < len; i += 3) {
    unsigned int n = static_cast<unsigned int>(data[i]) << 16;
    if (i + 1 < len) n |= static_cast<unsigned int>(data[i + 1]) << 8;
    if (i + 2 < len) n |= static_cast<unsigned int>(data[i + 2]);

    result.push_back(base64_chars[(n >> 18) & 0x3F]);
    result.push_back(base64_chars[(n >> 12) & 0x3F]);
    result.push_back(i + 1 < len ? base64_chars[(n >> 6) & 0x3F] : '=');
    result.push_back(i + 2 < len ? base64_chars[n & 0x3F] : '=');
  }
  return result;
}

// Minimal SHA-1 implementation for WebSocket handshake
void SHA1Hash(const unsigned char* data, size_t len, unsigned char* out) {
  uint32_t h0 = 0x67452301;
  uint32_t h1 = 0xEFCDAB89;
  uint32_t h2 = 0x98BADCFE;
  uint32_t h3 = 0x10325476;
  uint32_t h4 = 0xC3D2E1F0;

  size_t new_len = ((len + 8) / 64 + 1) * 64;
  std::vector<unsigned char> msg(new_len, 0);
  memcpy(msg.data(), data, len);
  msg[len] = 0x80;

  uint64_t bits_len = len * 8;
  for (int i = 0; i < 8; ++i) {
    msg[new_len - 1 - i] = static_cast<unsigned char>(bits_len >> (i * 8));
  }

  for (size_t offset = 0; offset < new_len; offset += 64) {
    uint32_t w[80];
    for (int i = 0; i < 16; ++i) {
      w[i] = (msg[offset + i * 4] << 24) |
             (msg[offset + i * 4 + 1] << 16) |
             (msg[offset + i * 4 + 2] << 8) |
             msg[offset + i * 4 + 3];
    }
    for (int i = 16; i < 80; ++i) {
      uint32_t t = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (t << 1) | (t >> 31);
    }

    uint32_t a = h0, b = h1, c = h2, d = h3, e = h4;
    for (int i = 0; i < 80; ++i) {
      uint32_t f, k;
      if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }

      uint32_t temp = ((a << 5) | (a >> 27)) + f + e + k + w[i];
      e = d; d = c; c = (b << 30) | (b >> 2); b = a; a = temp;
    }
    h0 += a; h1 += b; h2 += c; h3 += d; h4 += e;
  }

  out[0] = (h0 >> 24) & 0xFF; out[1] = (h0 >> 16) & 0xFF;
  out[2] = (h0 >> 8) & 0xFF; out[3] = h0 & 0xFF;
  out[4] = (h1 >> 24) & 0xFF; out[5] = (h1 >> 16) & 0xFF;
  out[6] = (h1 >> 8) & 0xFF; out[7] = h1 & 0xFF;
  out[8] = (h2 >> 24) & 0xFF; out[9] = (h2 >> 16) & 0xFF;
  out[10] = (h2 >> 8) & 0xFF; out[11] = h2 & 0xFF;
  out[12] = (h3 >> 24) & 0xFF; out[13] = (h3 >> 16) & 0xFF;
  out[14] = (h3 >> 8) & 0xFF; out[15] = h3 & 0xFF;
  out[16] = (h4 >> 24) & 0xFF; out[17] = (h4 >> 16) & 0xFF;
  out[18] = (h4 >> 8) & 0xFF; out[19] = h4 & 0xFF;
}
#endif

// Generate cryptographically secure random bytes using getrandom() or /dev/urandom
// Falls back to mt19937 if crypto RNG fails (should not happen on modern Linux)
bool CryptoRandomBytes(unsigned char* buffer, size_t len) {
  // Try getrandom() first (available on Linux 3.17+)
  ssize_t result = getrandom(buffer, len, 0);
  if (result == static_cast<ssize_t>(len)) {
    return true;
  }

  // Fallback to /dev/urandom
  int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
  if (fd >= 0) {
    size_t total_read = 0;
    while (total_read < len) {
      ssize_t bytes_read = read(fd, buffer + total_read, len - total_read);
      if (bytes_read <= 0) {
        close(fd);
        return false;
      }
      total_read += bytes_read;
    }
    close(fd);
    return true;
  }

  return false;
}

// Fallback using mt19937 (NOT cryptographically secure, used only if crypto RNG fails)
void InsecureRandomBytes(unsigned char* buffer, size_t len) {
  std::random_device rd;
  std::mt19937 gen(rd());
  std::uniform_int_distribution<> dis(0, 255);
  for (size_t i = 0; i < len; ++i) {
    buffer[i] = static_cast<unsigned char>(dis(gen));
  }
}

// Generate random bytes for WebSocket key
std::string GenerateWebSocketKey() {
  unsigned char key[16];
  if (!CryptoRandomBytes(key, 16)) {
    // Fallback to insecure RNG if crypto RNG fails
    InsecureRandomBytes(key, 16);
  }
  return Base64Encode(key, 16);
}

// Generate UUID for connection ID
std::string GenerateUUID() {
  unsigned char random_bytes[16];
  if (!CryptoRandomBytes(random_bytes, 16)) {
    // Fallback to insecure RNG if crypto RNG fails
    InsecureRandomBytes(random_bytes, 16);
  }

  // Set UUID version 4 (random) and variant bits
  random_bytes[6] = (random_bytes[6] & 0x0F) | 0x40;  // Version 4
  random_bytes[8] = (random_bytes[8] & 0x3F) | 0x80;  // Variant 1

  std::stringstream ss;
  ss << std::hex << std::setfill('0');
  for (int i = 0; i < 16; ++i) {
    if (i == 4 || i == 6 || i == 8 || i == 10) {
      ss << '-';
    }
    ss << std::setw(2) << static_cast<int>(random_bytes[i]);
  }
  return ss.str();
}

}  // namespace

WebSocketConnection::WebSocketConnection(
    const std::string& url,
    const std::vector<std::string>& pins,
    int timeout_ms,
    const std::string& connection_id,
    EventCallback callback)
    : url_(url),
      pins_(pins),
      timeout_ms_(timeout_ms),
      connection_id_(connection_id),
      callback_(callback),
      port_(443),
      use_tls_(true),
      socket_fd_(-1),
#if HAVE_OPENSSL
      ssl_ctx_(nullptr),
      ssl_(nullptr),
#endif
      is_connected_(false),
      should_stop_(false) {}

WebSocketConnection::~WebSocketConnection() {
  Close();
}

bool WebSocketConnection::ParseUrl() {
  std::string url = url_;

  if (url.substr(0, 6) == "wss://") {
    use_tls_ = true;
    url = url.substr(6);
    port_ = 443;
  } else if (url.substr(0, 5) == "ws://") {
    use_tls_ = false;
    url = url.substr(5);
    port_ = 80;
  } else {
    return false;
  }

  size_t path_pos = url.find('/');
  if (path_pos != std::string::npos) {
    path_ = url.substr(path_pos);
    url = url.substr(0, path_pos);
  } else {
    path_ = "/";
  }

  size_t port_pos = url.find(':');
  if (port_pos != std::string::npos) {
    host_ = url.substr(0, port_pos);
    port_ = std::stoi(url.substr(port_pos + 1));
  } else {
    host_ = url;
  }

  return !host_.empty();
}

bool WebSocketConnection::Connect() {
  PWSLOG("Connect: url=%s, pins_count=%zu", url_.c_str(), pins_.size());

  if (!ParseUrl()) {
    PWSLOG("Connect: Invalid URL");
    callback_(EventType::kError, connection_id_, "Invalid URL");
    return false;
  }

  PWSLOG("Connect: host=%s, port=%d, tls=%d, path=%s",
         host_.c_str(), port_, use_tls_ ? 1 : 0, path_.c_str());

  // Resolve hostname
  struct addrinfo hints = {};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;

  struct addrinfo* result = nullptr;
  int status = getaddrinfo(host_.c_str(), std::to_string(port_).c_str(),
                           &hints, &result);
  if (status != 0) {
    PWSLOG("Connect: DNS resolution failed: %s", gai_strerror(status));
    callback_(EventType::kError, connection_id_,
              std::string("DNS resolution failed: ") + gai_strerror(status));
    return false;
  }

  PWSLOG("Connect: DNS resolved, attempting TCP connection");

  socket_fd_ = -1;
  for (struct addrinfo* rp = result; rp != nullptr; rp = rp->ai_next) {
    socket_fd_ = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
    if (socket_fd_ == -1) continue;

    struct timeval tv;
    tv.tv_sec = timeout_ms_ / 1000;
    tv.tv_usec = (timeout_ms_ % 1000) * 1000;
    setsockopt(socket_fd_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(socket_fd_, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    int keepalive = 1;
    setsockopt(socket_fd_, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));

    if (connect(socket_fd_, rp->ai_addr, rp->ai_addrlen) == 0) {
      PWSLOG("Connect: TCP connection established");
      break;
    }

    close(socket_fd_);
    socket_fd_ = -1;
  }

  freeaddrinfo(result);

  if (socket_fd_ == -1) {
    PWSLOG("Connect: Failed to connect to server");
    callback_(EventType::kError, connection_id_, "Failed to connect to server");
    return false;
  }

  if (use_tls_) {
    PWSLOG("Connect: Starting TLS handshake");
    if (!PerformTlsHandshake()) {
      PWSLOG("Connect: TLS handshake failed");
      close(socket_fd_);
      socket_fd_ = -1;
      return false;
    }
    PWSLOG("Connect: TLS handshake successful");
  }

  PWSLOG("Connect: Starting WebSocket handshake");
  if (!PerformWebSocketHandshake()) {
    PWSLOG("Connect: WebSocket handshake failed");
    Close();
    return false;
  }
  PWSLOG("Connect: WebSocket handshake successful");

  is_connected_ = true;
  PWSLOG("Connect: Connection established, id=%s", connection_id_.c_str());
  callback_(EventType::kConnected, connection_id_, "");

  should_stop_ = false;
  receive_thread_ = std::thread(&WebSocketConnection::ReceiveLoop, this);

  return true;
}

bool WebSocketConnection::PerformTlsHandshake() {
#if HAVE_OPENSSL
  PWSLOG("TLS: Initializing OpenSSL");
  // Initialize OpenSSL - use version-appropriate function
#if OPENSSL_VERSION_NUMBER < 0x10100000L
  SSL_library_init();
  SSL_load_error_strings();
#else
  OPENSSL_init_ssl(0, nullptr);
#endif

  const SSL_METHOD* method = TLS_client_method();
  ssl_ctx_ = SSL_CTX_new(method);
  if (!ssl_ctx_) {
    PWSLOG("TLS: Failed to create SSL context");
    callback_(EventType::kError, connection_id_, "Failed to create SSL context");
    return false;
  }

  SSL_CTX_set_min_proto_version(ssl_ctx_, TLS1_2_VERSION);

  if (!SSL_CTX_set_default_verify_paths(ssl_ctx_)) {
    PWSLOG("TLS: Failed to load CA certificates");
    callback_(EventType::kError, connection_id_, "Failed to load CA certificates");
    SSL_CTX_free(ssl_ctx_);
    ssl_ctx_ = nullptr;
    return false;
  }

  ssl_ = SSL_new(ssl_ctx_);
  if (!ssl_) {
    PWSLOG("TLS: Failed to create SSL object");
    callback_(EventType::kError, connection_id_, "Failed to create SSL object");
    SSL_CTX_free(ssl_ctx_);
    ssl_ctx_ = nullptr;
    return false;
  }

  SSL_set_tlsext_host_name(ssl_, host_.c_str());
  SSL_set_fd(ssl_, socket_fd_);

  PWSLOG("TLS: Performing SSL_connect to %s", host_.c_str());
  int ret = SSL_connect(ssl_);
  if (ret != 1) {
    char err_buf[256];
    ERR_error_string_n(ERR_get_error(), err_buf, sizeof(err_buf));
    PWSLOG("TLS: SSL_connect failed: %s", err_buf);
    callback_(EventType::kError, connection_id_,
              std::string("TLS handshake failed: ") + err_buf);
    SSL_free(ssl_);
    SSL_CTX_free(ssl_ctx_);
    ssl_ = nullptr;
    ssl_ctx_ = nullptr;
    return false;
  }
  PWSLOG("TLS: SSL_connect successful");

  long verify_result = SSL_get_verify_result(ssl_);
  if (verify_result != X509_V_OK) {
    PWSLOG("TLS: Certificate verification failed: %s",
           X509_verify_cert_error_string(verify_result));
    callback_(EventType::kError, connection_id_,
              std::string("Certificate verification failed: ") +
              X509_verify_cert_error_string(verify_result));
    SSL_free(ssl_);
    SSL_CTX_free(ssl_ctx_);
    ssl_ = nullptr;
    ssl_ctx_ = nullptr;
    return false;
  }
  PWSLOG("TLS: Certificate verification passed");

  // Certificate pinning
  if (!pins_.empty()) {
    PWSLOG("TLS: Checking certificate pins (count=%zu)", pins_.size());
    X509* cert = SSL_get_peer_certificate(ssl_);
    if (!cert) {
      PWSLOG("TLS: No server certificate received");
      callback_(EventType::kPinningFailed, connection_id_,
                "No server certificate received");
      SSL_free(ssl_);
      SSL_CTX_free(ssl_ctx_);
      ssl_ = nullptr;
      ssl_ctx_ = nullptr;
      return false;
    }

    bool pin_matched = VerifyCertificatePins(cert);
    X509_free(cert);

    if (!pin_matched) {
      PWSLOG("TLS: Leaf cert pin mismatch, checking chain");
      STACK_OF(X509)* chain = SSL_get_peer_cert_chain(ssl_);
      if (chain) {
        int chain_len = sk_X509_num(chain);
        PWSLOG("TLS: Certificate chain length: %d", chain_len);
        for (int i = 0; i < chain_len && !pin_matched; ++i) {
          X509* chain_cert = sk_X509_value(chain, i);
          pin_matched = VerifyCertificatePins(chain_cert);
          if (pin_matched) {
            PWSLOG("TLS: Pin matched at chain index %d", i);
          }
        }
      }
    } else {
      PWSLOG("TLS: Leaf certificate pin matched");
    }

    if (!pin_matched) {
      PWSLOG("TLS: Certificate pinning failed - no matching pin found");
      callback_(EventType::kPinningFailed, connection_id_,
                "Certificate pinning failed - no matching pin found");
      SSL_free(ssl_);
      SSL_CTX_free(ssl_ctx_);
      ssl_ = nullptr;
      ssl_ctx_ = nullptr;
      return false;
    }
    PWSLOG("TLS: Certificate pinning verification successful");
  } else {
    PWSLOG("TLS: No pins configured, skipping pinning");
  }

  return true;
#else
  PWSLOG("TLS: OpenSSL not available");
  if (!pins_.empty()) {
    callback_(EventType::kPinningFailed, connection_id_,
              "Certificate pinning requires OpenSSL, which is not available");
    return false;
  }

  callback_(EventType::kError, connection_id_,
            "TLS not available - OpenSSL not compiled in");
  return false;
#endif
}

#if HAVE_OPENSSL
bool WebSocketConnection::VerifyCertificatePins(X509* cert) {
  std::string pin = CalculateSpkiPin(cert);
  for (const auto& expected_pin : pins_) {
    if (pin == expected_pin) {
      return true;
    }
  }
  return false;
}

std::string WebSocketConnection::CalculateSpkiPin(X509* cert) {
  EVP_PKEY* pubkey = X509_get_pubkey(cert);
  if (!pubkey) {
    return "";
  }

  int spki_len = i2d_PUBKEY(pubkey, nullptr);
  if (spki_len <= 0) {
    EVP_PKEY_free(pubkey);
    return "";
  }

  std::vector<unsigned char> spki_der(spki_len);
  unsigned char* p = spki_der.data();
  i2d_PUBKEY(pubkey, &p);
  EVP_PKEY_free(pubkey);

  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(spki_der.data(), spki_len, hash);

  return Base64Encode(hash, SHA256_DIGEST_LENGTH);
}
#endif

bool WebSocketConnection::PerformWebSocketHandshake() {
  PWSLOG("WebSocket: Starting handshake");
  std::string ws_key = GenerateWebSocketKey();

  std::ostringstream request;
  request << "GET " << path_ << " HTTP/1.1\r\n";
  request << "Host: " << host_;
  if ((use_tls_ && port_ != 443) || (!use_tls_ && port_ != 80)) {
    request << ":" << port_;
  }
  request << "\r\n";
  request << "Upgrade: websocket\r\n";
  request << "Connection: Upgrade\r\n";
  request << "Sec-WebSocket-Key: " << ws_key << "\r\n";
  request << "Sec-WebSocket-Version: 13\r\n";
  request << "\r\n";

  std::string req_str = request.str();

  PWSLOG("WebSocket: Sending upgrade request");
  int sent;
#if HAVE_OPENSSL
  if (ssl_) {
    sent = SSL_write(ssl_, req_str.c_str(), static_cast<int>(req_str.length()));
  } else
#endif
  {
    sent = send(socket_fd_, req_str.c_str(), req_str.length(), 0);
  }

  if (sent <= 0) {
    PWSLOG("WebSocket: Failed to send handshake request");
    callback_(EventType::kError, connection_id_, "Failed to send WebSocket handshake");
    return false;
  }
  PWSLOG("WebSocket: Upgrade request sent (%d bytes)", sent);

  char buffer[4096];
  int received;
#if HAVE_OPENSSL
  if (ssl_) {
    received = SSL_read(ssl_, buffer, sizeof(buffer) - 1);
  } else
#endif
  {
    received = recv(socket_fd_, buffer, sizeof(buffer) - 1, 0);
  }

  if (received <= 0) {
    PWSLOG("WebSocket: Failed to receive handshake response");
    callback_(EventType::kError, connection_id_, "Failed to receive WebSocket handshake response");
    return false;
  }
  PWSLOG("WebSocket: Received response (%d bytes)", received);

  buffer[received] = '\0';
  std::string response(buffer);

  if (response.find("HTTP/1.1 101") == std::string::npos) {
    PWSLOG("WebSocket: Handshake failed, no 101 response");
    callback_(EventType::kError, connection_id_,
              "WebSocket handshake failed: " + response.substr(0, 50));
    return false;
  }
  PWSLOG("WebSocket: Received 101 Switching Protocols");

  // Verify Sec-WebSocket-Accept
  std::string accept_key = ws_key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  unsigned char sha1_hash[20];
  SHA1Hash(reinterpret_cast<const unsigned char*>(accept_key.c_str()),
           accept_key.length(), sha1_hash);
  std::string expected_accept = Base64Encode(sha1_hash, 20);

  if (response.find(expected_accept) == std::string::npos) {
    PWSLOG("WebSocket: Accept key mismatch");
    callback_(EventType::kError, connection_id_, "WebSocket accept key mismatch");
    return false;
  }
  PWSLOG("WebSocket: Handshake completed successfully");

  return true;
}

bool WebSocketConnection::Send(const std::string& message) {
  if (!is_connected_) {
    return false;
  }

  std::lock_guard<std::mutex> lock(send_mutex_);
  return SendFrame(0x01, message);
}

bool WebSocketConnection::SendFrame(uint8_t opcode, const std::string& payload) {
  std::vector<uint8_t> frame;

  frame.push_back(0x80 | opcode);

  size_t payload_len = payload.length();
  if (payload_len <= 125) {
    frame.push_back(0x80 | static_cast<uint8_t>(payload_len));
  } else if (payload_len <= 65535) {
    frame.push_back(0x80 | 126);
    frame.push_back(static_cast<uint8_t>((payload_len >> 8) & 0xFF));
    frame.push_back(static_cast<uint8_t>(payload_len & 0xFF));
  } else {
    frame.push_back(0x80 | 127);
    for (int i = 7; i >= 0; --i) {
      frame.push_back(static_cast<uint8_t>((payload_len >> (i * 8)) & 0xFF));
    }
  }

  uint8_t mask[4];
  if (!CryptoRandomBytes(mask, 4)) {
    // Fallback to insecure RNG if crypto RNG fails
    InsecureRandomBytes(mask, 4);
  }
  frame.insert(frame.end(), mask, mask + 4);

  for (size_t i = 0; i < payload_len; ++i) {
    frame.push_back(static_cast<uint8_t>(payload[i]) ^ mask[i % 4]);
  }

  int sent;
#if HAVE_OPENSSL
  if (ssl_) {
    sent = SSL_write(ssl_, frame.data(), static_cast<int>(frame.size()));
  } else
#endif
  {
    sent = send(socket_fd_, frame.data(), frame.size(), 0);
  }

  return sent == static_cast<int>(frame.size());
}

bool WebSocketConnection::ReadFrame(uint8_t& opcode, std::string& payload) {
  uint8_t header[2];
  int received;

#if HAVE_OPENSSL
  if (ssl_) {
    received = SSL_read(ssl_, header, 2);
  } else
#endif
  {
    received = recv(socket_fd_, header, 2, MSG_WAITALL);
  }

  if (received != 2) {
    return false;
  }

  bool fin = (header[0] & 0x80) != 0;
  opcode = header[0] & 0x0F;
  bool masked = (header[1] & 0x80) != 0;
  uint64_t payload_len = header[1] & 0x7F;

  if (payload_len == 126) {
    uint8_t ext_len[2];
#if HAVE_OPENSSL
    if (ssl_) {
      received = SSL_read(ssl_, ext_len, 2);
    } else
#endif
    {
      received = recv(socket_fd_, ext_len, 2, MSG_WAITALL);
    }
    if (received != 2) return false;
    payload_len = (static_cast<uint64_t>(ext_len[0]) << 8) | ext_len[1];
  } else if (payload_len == 127) {
    uint8_t ext_len[8];
#if HAVE_OPENSSL
    if (ssl_) {
      received = SSL_read(ssl_, ext_len, 8);
    } else
#endif
    {
      received = recv(socket_fd_, ext_len, 8, MSG_WAITALL);
    }
    if (received != 8) return false;
    payload_len = 0;
    for (int i = 0; i < 8; ++i) {
      payload_len = (payload_len << 8) | ext_len[i];
    }
  }

  uint8_t mask[4] = {0};
  if (masked) {
#if HAVE_OPENSSL
    if (ssl_) {
      received = SSL_read(ssl_, mask, 4);
    } else
#endif
    {
      received = recv(socket_fd_, mask, 4, MSG_WAITALL);
    }
    if (received != 4) return false;
  }

  payload.resize(payload_len);
  if (payload_len > 0) {
    size_t total_read = 0;
    while (total_read < payload_len) {
#if HAVE_OPENSSL
      if (ssl_) {
        received = SSL_read(ssl_, &payload[total_read],
                           static_cast<int>(payload_len - total_read));
      } else
#endif
      {
        received = recv(socket_fd_, &payload[total_read],
                       payload_len - total_read, 0);
      }
      if (received <= 0) return false;
      total_read += received;
    }

    if (masked) {
      for (size_t i = 0; i < payload_len; ++i) {
        payload[i] ^= mask[i % 4];
      }
    }
  }

  // Fragmented WebSocket messages (FIN=0) are not supported; this
  // implementation expects each frame to be a complete message with FIN=1.
  (void)fin;
  return true;
}

void WebSocketConnection::ReceiveLoop() {
  PWSLOG("ReceiveLoop: Started for connection %s", connection_id_.c_str());
  while (!should_stop_ && is_connected_) {
    uint8_t opcode;
    std::string payload;

    if (!ReadFrame(opcode, payload)) {
      if (!should_stop_) {
        PWSLOG("ReceiveLoop: ReadFrame failed, disconnecting");
        is_connected_ = false;
        callback_(EventType::kDisconnected, connection_id_, "");
      }
      break;
    }

    switch (opcode) {
      case 0x01:
      case 0x02:
        callback_(EventType::kMessage, connection_id_, payload);
        break;

      case 0x08:
        PWSLOG("ReceiveLoop: Received close frame");
        is_connected_ = false;
        callback_(EventType::kDisconnected, connection_id_, "");
        return;

      case 0x09:
        PWSLOG("ReceiveLoop: Received ping, sending pong");
        {
          std::lock_guard<std::mutex> lock(send_mutex_);
          SendFrame(0x0A, payload);
        }
        break;

      case 0x0A:
        break;

      default:
        PWSLOG("ReceiveLoop: Unknown opcode 0x%02x", opcode);
        break;
    }
  }
  PWSLOG("ReceiveLoop: Ended for connection %s", connection_id_.c_str());
}

void WebSocketConnection::Close() {
  PWSLOG("Close: Closing connection %s", connection_id_.c_str());
  should_stop_ = true;
  is_connected_ = false;

  if (receive_thread_.joinable()) {
    PWSLOG("Close: Sending close frame");
    {
      std::lock_guard<std::mutex> lock(send_mutex_);
      SendFrame(0x08, "");
    }

    if (receive_thread_.get_id() != std::this_thread::get_id()) {
      PWSLOG("Close: Waiting for receive thread to finish");
      receive_thread_.join();
    } else {
      receive_thread_.detach();
    }
  }

#if HAVE_OPENSSL
  if (ssl_) {
    PWSLOG("Close: Shutting down SSL");
    SSL_shutdown(ssl_);
    SSL_free(ssl_);
    ssl_ = nullptr;
  }

  if (ssl_ctx_) {
    SSL_CTX_free(ssl_ctx_);
    ssl_ctx_ = nullptr;
  }
#endif

  if (socket_fd_ >= 0) {
    PWSLOG("Close: Closing socket");
    close(socket_fd_);
    socket_fd_ = -1;
  }
  PWSLOG("Close: Connection closed");
}

// ConnectionManager implementation

ConnectionManager& ConnectionManager::Instance() {
  static ConnectionManager instance;
  return instance;
}

std::string ConnectionManager::CreateConnection(
    const std::string& url,
    const std::vector<std::string>& pins,
    int timeout_ms,
    EventCallback callback) {
  std::string connection_id = GenerateUUID();

  std::lock_guard<std::mutex> lock(mutex_);
  connections_[connection_id] = std::make_unique<WebSocketConnection>(
      url, pins, timeout_ms, connection_id, callback);

  return connection_id;
}

WebSocketConnection* ConnectionManager::GetConnection(
    const std::string& connection_id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = connections_.find(connection_id);
  if (it != connections_.end()) {
    return it->second.get();
  }
  return nullptr;
}

void ConnectionManager::RemoveConnection(const std::string& connection_id) {
  std::lock_guard<std::mutex> lock(mutex_);
  auto it = connections_.find(connection_id);
  if (it != connections_.end()) {
    it->second->Close();
    connections_.erase(it);
  }
}

}  // namespace pinned_websocket
