# [HIGH] Channel invite link embeds private encryption key

**Area**: Headless Client
**File**: packages/headless-client/zajel/channels.py:270-282
**Type**: Security

**Description**: The `encode_channel_link` function embeds the `encryption_key_private` (the X25519 private key) directly into the invite link: `"k": encryption_key_private`. This private key is then base64url-encoded and placed in a `zajel://channel/...` URL. The `get_channel_invite_link` method in `client.py:573` passes `channel.encryption_key_private` to this function.

Anyone who obtains the invite link (which is designed to be shared) gains the private encryption key for the channel. The link is meant to be distributed to subscribers, but distributing a private key in a shareable URL creates several risks:
- Links logged in browser history, chat logs, server access logs
- Links shared on social media or public forums
- Links intercepted in transit if shared over unencrypted channels

**Impact**: The channel's encryption private key is exposed to anyone who sees the invite link. If this link leaks to unintended recipients, they can decrypt all channel content. There is no way to distinguish between authorized and unauthorized holders of the link, and no revocation mechanism for the key embedded in already-distributed links.

**Fix**: This appears to be by design (the link IS the subscription credential). Document this clearly and consider:
1. Adding expiration/one-time-use semantics to invite links
2. Using a derived key or token in the link rather than the raw private key
3. Implementing key rotation so that old invite links stop working after a rotation
4. Warning users in the UI that the link contains the decryption key and must be treated as a secret
