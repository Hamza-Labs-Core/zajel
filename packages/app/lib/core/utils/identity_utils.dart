import '../crypto/crypto_service.dart';
import '../models/peer.dart';
import '../storage/trusted_peers_storage.dart';

/// Resolve the display name for a peer with consistent priority across all UI.
///
/// Priority: alias → username#tag → displayName → "Peer {id prefix}"
String resolvePeerDisplayName(Peer peer, {String? alias}) {
  if (alias != null && alias.isNotEmpty) return alias;

  if (peer.username != null &&
      peer.username!.isNotEmpty &&
      peer.publicKey != null) {
    final tag = CryptoService.tagFromPublicKey(peer.publicKey!);
    return '${peer.username}#$tag';
  }

  if (peer.displayName.isNotEmpty) return peer.displayName;

  return 'Peer ${peer.id.substring(0, 8)}';
}

/// Resolve the display name for a trusted peer (contacts).
///
/// Priority: alias → username#tag → displayName → "Peer {id prefix}"
String resolveTrustedPeerDisplayName(TrustedPeer peer) {
  if (peer.alias != null && peer.alias!.isNotEmpty) return peer.alias!;

  if (peer.username != null && peer.username!.isNotEmpty && peer.tag != null) {
    return '${peer.username}#${peer.tag}';
  }

  if (peer.displayName.isNotEmpty) return peer.displayName;

  return 'Peer ${peer.id.substring(0, 8)}';
}
