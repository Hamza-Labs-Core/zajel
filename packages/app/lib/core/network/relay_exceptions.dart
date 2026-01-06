/// Base exception for relay-related errors.
abstract class RelayException implements Exception {
  final String message;

  const RelayException(this.message);

  @override
  String toString() => '$runtimeType: $message';
}

/// Exception thrown when attempting to use a relay that is not connected.
class RelayNotConnectedException extends RelayException {
  final String relayId;

  RelayNotConnectedException(this.relayId)
      : super('Not connected to relay: $relayId');
}

/// Exception thrown when relay connection fails.
class RelayConnectionFailedException extends RelayException {
  final String relayId;
  final Object? originalError;

  RelayConnectionFailedException(this.relayId, [this.originalError])
      : super('Failed to connect to relay: $relayId'
            '${originalError != null ? ' - $originalError' : ''}');
}

/// Exception thrown when relay is at maximum capacity.
class RelayAtCapacityException extends RelayException {
  final String relayId;
  final int currentLoad;
  final int maxCapacity;

  RelayAtCapacityException(this.relayId, this.currentLoad, this.maxCapacity)
      : super('Relay $relayId is at capacity: $currentLoad/$maxCapacity');
}

/// Exception thrown when introduction request fails.
class IntroductionFailedException extends RelayException {
  final String targetSourceId;
  final String errorCode;

  IntroductionFailedException(this.targetSourceId, this.errorCode)
      : super('Introduction to $targetSourceId failed: $errorCode');
}

/// Exception thrown when target is not found for introduction.
class TargetNotFoundException extends RelayException {
  final String targetSourceId;

  TargetNotFoundException(this.targetSourceId)
      : super('Target not found: $targetSourceId');
}

/// Exception thrown when source ID is invalid.
class InvalidSourceIdException extends RelayException {
  final String sourceId;

  InvalidSourceIdException(this.sourceId)
      : super('Invalid source ID: $sourceId');
}

/// Exception thrown when maximum relay connections exceeded.
class MaxRelayConnectionsExceededException extends RelayException {
  final int maxConnections;

  MaxRelayConnectionsExceededException(this.maxConnections)
      : super('Maximum relay connections exceeded: $maxConnections');
}

/// Exception thrown when relay message is malformed.
class MalformedRelayMessageException extends RelayException {
  final String rawMessage;

  MalformedRelayMessageException(this.rawMessage)
      : super('Malformed relay message: ${rawMessage.length > 100 ? '${rawMessage.substring(0, 100)}...' : rawMessage}');
}

/// Exception thrown when relay handshake fails.
class RelayHandshakeFailedException extends RelayException {
  final String relayId;
  final String reason;

  RelayHandshakeFailedException(this.relayId, this.reason)
      : super('Relay handshake with $relayId failed: $reason');
}

/// Exception thrown when relay protocol version is incompatible.
class IncompatibleRelayProtocolException extends RelayException {
  final String relayId;
  final int expectedVersion;
  final int actualVersion;

  IncompatibleRelayProtocolException(
      this.relayId, this.expectedVersion, this.actualVersion)
      : super('Incompatible relay protocol with $relayId: '
            'expected v$expectedVersion, got v$actualVersion');
}
