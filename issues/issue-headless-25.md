# [MEDIUM] Channel invite link decoding accepts arbitrary prefixes

**Area**: Headless Client
**File**: packages/headless-client/zajel/channels.py:285-315
**Type**: Security

**Description**: The `decode_channel_link` function, when the input does not start with `zajel://channel/`, falls back to treating the entire input as base64-encoded data (lines 298-299):

```python
if trimmed.startswith(CHANNEL_LINK_PREFIX):
    encoded = trimmed[len(CHANNEL_LINK_PREFIX):]
else:
    encoded = trimmed
```

This means any base64-encoded JSON containing keys "m" and "k" will be accepted as a valid channel link, regardless of whether it came from a `zajel://` URL. This could allow:
1. Injection of crafted channel subscriptions via arbitrary data blobs
2. Confusion about the source of the subscription (was it from a real invite link or crafted input?)

**Impact**: An attacker could trick a user into subscribing to a malicious channel by providing crafted base64 data that does not look like a `zajel://` URL, potentially bypassing any URL-based filtering or validation the application performs upstream.

**Fix**: Require the `zajel://channel/` prefix and reject inputs that do not match:

```python
def decode_channel_link(link: str) -> tuple[ChannelManifest, str]:
    trimmed = link.strip()
    if not trimmed.startswith(CHANNEL_LINK_PREFIX):
        raise ValueError(f"Invalid channel link: must start with {CHANNEL_LINK_PREFIX}")
    encoded = trimmed[len(CHANNEL_LINK_PREFIX):]
    ...
```
