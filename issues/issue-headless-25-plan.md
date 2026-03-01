# Plan: Channel invite link decoding accepts arbitrary prefixes

**Issue**: issue-headless-25.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/channels.py`

## Analysis

The `decode_channel_link` function at lines 285-315 of `channels.py` has a fallback path at lines 298-299:

```python
if trimmed.startswith(CHANNEL_LINK_PREFIX):
    encoded = trimmed[len(CHANNEL_LINK_PREFIX):]
else:
    encoded = trimmed
```

When the input does not start with `zajel://channel/`, the entire input is treated as base64-encoded data. This means any arbitrary base64 string containing a valid JSON object with `"m"` and `"k"` keys will be accepted as a channel invite link.

The `is_channel_link` function at lines 318-320 correctly checks for the prefix, but `decode_channel_link` does not enforce it. These two functions have inconsistent behavior -- `is_channel_link` would return `False` for a raw base64 string, but `decode_channel_link` would still process it.

The caller `subscribe_channel` in `client.py` at line 706 calls `decode_channel_link(invite_link)` directly without first checking `is_channel_link`.

## Fix Steps

1. **Enforce the prefix in `decode_channel_link`** at lines 294-299. Replace the if/else block:
   ```python
   def decode_channel_link(link: str) -> tuple[ChannelManifest, str]:
       """Decode a zajel://channel/<base64url> invite link.

       Returns:
           (manifest, encryption_key) tuple.

       Raises:
           ValueError: If the link format is invalid.
       """
       trimmed = link.strip()

       if not trimmed.startswith(CHANNEL_LINK_PREFIX):
           raise ValueError(
               f"Invalid channel link: must start with '{CHANNEL_LINK_PREFIX}'"
           )
       encoded = trimmed[len(CHANNEL_LINK_PREFIX):]
   ```

2. **No changes needed to `is_channel_link`** -- it already correctly validates the prefix.

3. **No changes needed to `subscribe_channel` in `client.py`** -- the `ValueError` will propagate correctly and be handled by the daemon's error handler.

## Testing

- Unit test: Verify `decode_channel_link("zajel://channel/<valid-base64>")` succeeds.
- Unit test: Verify `decode_channel_link("<raw-base64-without-prefix>")` raises `ValueError` with a descriptive message.
- Unit test: Verify `decode_channel_link("http://evil.com/<base64>")` raises `ValueError`.
- Unit test: Verify `decode_channel_link("")` raises `ValueError`.
- Integration test: Verify the daemon's `subscribe_channel` command returns an error when given a link without the proper prefix.

## Risk Assessment

- This is a breaking change for any code that currently passes raw base64 data to `decode_channel_link`. However, this usage pattern is incorrect and should not be supported.
- The `encode_channel_link` function (lines 270-282) always produces links with the `zajel://channel/` prefix, so any properly generated invite link will continue to work.
- If there are existing stored channel links without the prefix (e.g., from a database migration), they would need to be re-encoded. This is unlikely given the in-memory storage model.
