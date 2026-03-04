# Plan: Channel invite link embeds private encryption key

**Issue**: issue-headless-08.md
**Severity**: HIGH
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/channels.py`
- `packages/headless-client/zajel/client.py`

## Analysis

At `channels.py:270-282`, the `encode_channel_link` function embeds the `encryption_key_private` directly in the invite link:

```python
def encode_channel_link(manifest: ChannelManifest, encryption_key_private: str) -> str:
    payload = {
        "m": manifest.to_dict(),
        "k": encryption_key_private,
    }
    json_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    encoded = base64.urlsafe_b64encode(json_bytes).decode().rstrip("=")
    return f"{CHANNEL_LINK_PREFIX}{encoded}"
```

The `get_channel_invite_link` method in `client.py:568-573` passes the channel's private key:
```python
def get_channel_invite_link(self, channel_id: str) -> str:
    channel = self._channel_storage.get_owned(channel_id)
    if channel is None:
        raise RuntimeError(f"Owned channel not found: {channel_id}")
    return encode_channel_link(channel.manifest, channel.encryption_key_private)
```

This appears to be **by design**: the invite link IS the subscription credential. The private key is the shared decryption key. This is similar to how some systems use "secret links" as access tokens. However, it lacks:
1. Expiration/TTL for links
2. Key rotation to invalidate old links
3. User-facing warnings about the sensitivity of the link

## Fix Steps

1. **Add a clear security warning in the docstring and logging** for `encode_channel_link` at `channels.py:270`:
   ```python
   def encode_channel_link(manifest: ChannelManifest, encryption_key_private: str) -> str:
       """Encode a channel invite link from manifest + decryption key.

       WARNING: The invite link contains the channel decryption key.
       Anyone with this link can decrypt all channel content. Treat
       it as a secret credential and share only through secure channels.

       Format: zajel://channel/<base64url-encoded-json>
       """
   ```

2. **Add a log warning** when generating invite links in `client.py:568-573`:
   ```python
   def get_channel_invite_link(self, channel_id: str) -> str:
       channel = self._channel_storage.get_owned(channel_id)
       if channel is None:
           raise RuntimeError(f"Owned channel not found: {channel_id}")
       logger.warning(
           "Generating invite link for channel %s. This link contains "
           "the decryption key -- treat it as a secret.",
           channel_id[:16],
       )
       return encode_channel_link(channel.manifest, channel.encryption_key_private)
   ```

3. **Add link metadata for future expiration support**. Extend the link payload to include a creation timestamp and optional expiration:
   ```python
   payload = {
       "m": manifest.to_dict(),
       "k": encryption_key_private,
       "created_at": datetime.now(timezone.utc).isoformat(),
       "version": 1,
   }
   ```

4. **In `decode_channel_link` at `channels.py:285`**, check for expiration if present:
   ```python
   expires_at = payload.get("expires_at")
   if expires_at:
       exp = datetime.fromisoformat(expires_at)
       if datetime.now(timezone.utc) > exp:
           raise ValueError("Channel invite link has expired")
   ```

5. **Document key rotation plan**: Add a `rotate_channel_key` method stub to `client.py` that:
   - Generates a new X25519 encryption keypair
   - Updates the manifest with the new `current_encrypt_key` and incremented `key_epoch`
   - Re-signs the manifest
   - Old invite links with the old key would no longer decrypt new content

## Testing

- Verify the warning log appears when generating invite links.
- Verify the link format still works with the existing `decode_channel_link`.
- If expiration is added: test that an expired link raises `ValueError`.
- Run existing channel E2E tests to confirm no regressions.

## Risk Assessment

- Low risk for documentation and warning changes (steps 1-2).
- Low risk for adding metadata fields (step 3) -- backward compatible since `decode_channel_link` uses `payload.get()` for optional fields.
- Medium risk for key rotation (step 5) -- this is a larger feature that affects protocol interop with the Dart app. Recommended as a follow-up task rather than part of this fix.
- The fundamental design (link = credential) is intentional and matches the project's architecture for channel distribution. The fix focuses on making this explicit and adding mitigations.
