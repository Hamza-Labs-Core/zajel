import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Simple HTTP server for local peer-to-peer signaling.
///
/// Each device runs this server to receive WebRTC signaling messages
/// (offers, answers, ICE candidates) from other local peers.
class LocalSignalingServer {
  HttpServer? _server;
  final int port;

  final _messagesController = StreamController<LocalSignalingMessage>.broadcast();

  LocalSignalingServer({this.port = 0}); // 0 = auto-assign port

  /// Stream of incoming signaling messages.
  Stream<LocalSignalingMessage> get messages => _messagesController.stream;

  /// The actual port the server is listening on.
  int? get actualPort => _server?.port;

  /// Start the signaling server.
  Future<int> start() async {
    _server = await HttpServer.bind(InternetAddress.anyIPv4, port);

    _server!.listen(_handleRequest);

    return _server!.port;
  }

  void _handleRequest(HttpRequest request) async {
    // Add CORS headers
    request.response.headers.add('Access-Control-Allow-Origin', '*');
    request.response.headers.add('Access-Control-Allow-Methods', 'POST, OPTIONS');
    request.response.headers.add('Access-Control-Allow-Headers', 'Content-Type');

    if (request.method == 'OPTIONS') {
      request.response.statusCode = HttpStatus.ok;
      await request.response.close();
      return;
    }

    if (request.method == 'POST' && request.uri.path == '/signal') {
      try {
        final body = await utf8.decoder.bind(request).join();
        final json = jsonDecode(body) as Map<String, dynamic>;

        final message = LocalSignalingMessage(
          fromPeerId: json['from'] as String,
          type: json['type'] as String,
          payload: json['payload'] as Map<String, dynamic>,
        );

        _messagesController.add(message);

        request.response.statusCode = HttpStatus.ok;
        request.response.write('{"status": "ok"}');
      } catch (e) {
        request.response.statusCode = HttpStatus.badRequest;
        request.response.write('{"error": "$e"}');
      }
    } else {
      request.response.statusCode = HttpStatus.notFound;
      request.response.write('{"error": "Not found"}');
    }

    await request.response.close();
  }

  /// Stop the signaling server.
  Future<void> stop() async {
    await _server?.close();
    _server = null;
  }

  /// Dispose resources.
  Future<void> dispose() async {
    await stop();
    await _messagesController.close();
  }
}

/// Send a signaling message to a peer.
Future<bool> sendLocalSignal({
  required String targetHost,
  required int targetPort,
  required String fromPeerId,
  required String type,
  required Map<String, dynamic> payload,
}) async {
  try {
    final client = HttpClient();
    client.connectionTimeout = const Duration(seconds: 5);

    final request = await client.postUrl(
      Uri.parse('http://$targetHost:$targetPort/signal'),
    );

    request.headers.contentType = ContentType.json;
    request.write(jsonEncode({
      'from': fromPeerId,
      'type': type,
      'payload': payload,
    }));

    final response = await request.close();
    client.close();

    return response.statusCode == HttpStatus.ok;
  } catch (e) {
    return false;
  }
}

class LocalSignalingMessage {
  final String fromPeerId;
  final String type; // 'offer', 'answer', 'ice_candidate'
  final Map<String, dynamic> payload;

  LocalSignalingMessage({
    required this.fromPeerId,
    required this.type,
    required this.payload,
  });
}
