# Plan: JSON deserialization of chunk_data without schema validation

**Issue**: issue-headless-30.md
**Severity**: MEDIUM
**Area**: Headless Client
**Files to modify**: `packages/headless-client/zajel/channels.py`, `packages/headless-client/zajel/groups.py`, `packages/headless-client/zajel/client.py`

## Analysis

### `_handle_chunk_data` in `client.py` (lines 676-688)
When `chunk_data` is a string, it is parsed with `json.loads(chunk_data)` at line 686 with no schema validation. The parsed dict is passed to `receive_channel_chunk` which calls `Chunk.from_dict(chunk_data)` at line 764.

### `Chunk.from_dict` in `channels.py` (lines 229-240)
```python
@staticmethod
def from_dict(data: dict[str, Any]) -> "Chunk":
    return Chunk(
        chunk_id=data["chunk_id"],
        routing_hash=data["routing_hash"],
        sequence=data["sequence"],
        ...
    )
```
Accesses dict keys directly without checking for presence or type. Missing keys raise `KeyError`; wrong types cause downstream errors.

### `GroupMessage.from_bytes` in `groups.py` (lines 137-154)
```python
data = json.loads(raw.decode("utf-8"))
return GroupMessage(
    group_id=group_id,
    author_device_id=data["author_device_id"],
    sequence_number=data["sequence_number"],
    ...
)
```
Same pattern: direct key access with no validation.

### `ChunkPayload.from_bytes` in `channels.py` (lines 187-198)
Same pattern. `data["type"]`, `data["payload"]`, etc. accessed without validation.

### `ChannelManifest.from_dict` in `channels.py` (lines 144-159)
Accesses `data["channel_id"]`, `data["name"]`, etc. directly.

## Fix Steps

1. **Add validation to `Chunk.from_dict`** in `channels.py` (lines 229-240):
   ```python
   @staticmethod
   def from_dict(data: dict[str, Any]) -> "Chunk":
       required_keys = [
           "chunk_id", "routing_hash", "sequence", "chunk_index",
           "total_chunks", "size", "signature", "author_pubkey",
           "encrypted_payload",
       ]
       missing = [k for k in required_keys if k not in data]
       if missing:
           raise ValueError(f"Chunk missing required fields: {missing}")

       if not isinstance(data["sequence"], int):
           raise ValueError(f"sequence must be int, got {type(data['sequence']).__name__}")
       if not isinstance(data["chunk_index"], int) or data["chunk_index"] < 0:
           raise ValueError("chunk_index must be a non-negative integer")
       if not isinstance(data["total_chunks"], int) or data["total_chunks"] < 1:
           raise ValueError("total_chunks must be a positive integer")
       if not isinstance(data["size"], int) or data["size"] < 0:
           raise ValueError("size must be a non-negative integer")
       if data["chunk_index"] >= data["total_chunks"]:
           raise ValueError("chunk_index must be less than total_chunks")

       return Chunk(
           chunk_id=data["chunk_id"],
           routing_hash=data["routing_hash"],
           sequence=data["sequence"],
           chunk_index=data["chunk_index"],
           total_chunks=data["total_chunks"],
           size=data["size"],
           signature=data["signature"],
           author_pubkey=data["author_pubkey"],
           encrypted_payload=base64.b64decode(data["encrypted_payload"]),
       )
   ```

2. **Add validation to `GroupMessage.from_bytes`** in `groups.py` (lines 137-154):
   ```python
   @staticmethod
   def from_bytes(
       raw: bytes,
       group_id: str,
       is_outgoing: bool = False,
   ) -> "GroupMessage":
       """Deserialize from decrypted bytes."""
       data = json.loads(raw.decode("utf-8"))
       required = ["author_device_id", "sequence_number", "content", "timestamp"]
       missing = [k for k in required if k not in data]
       if missing:
           raise ValueError(f"GroupMessage missing required fields: {missing}")
       if not isinstance(data["sequence_number"], int):
           raise ValueError("sequence_number must be int")
       return GroupMessage(...)
   ```

3. **Add validation to `ChunkPayload.from_bytes`** in `channels.py` (lines 187-198):
   ```python
   @staticmethod
   def from_bytes(raw: bytes) -> "ChunkPayload":
       data = json.loads(raw.decode("utf-8"))
       required = ["type", "payload", "timestamp"]
       missing = [k for k in required if k not in data]
       if missing:
           raise ValueError(f"ChunkPayload missing required fields: {missing}")
       return ChunkPayload(...)
   ```

4. **Add validation to `ChannelManifest.from_dict`** in `channels.py` (lines 144-159):
   ```python
   @staticmethod
   def from_dict(data: dict[str, Any]) -> "ChannelManifest":
       required = ["channel_id", "name", "description", "owner_key", "current_encrypt_key"]
       missing = [k for k in required if k not in data]
       if missing:
           raise ValueError(f"ChannelManifest missing required fields: {missing}")
       ...
   ```

5. **Add error handling around `json.loads` in `_handle_chunk_data`** in `client.py` (line 686). It already has a check for `chunk_data` being falsy at line 681, but should catch `json.JSONDecodeError`:
   ```python
   if isinstance(chunk_data, str):
       try:
           chunk_data = json.loads(chunk_data)
       except json.JSONDecodeError as e:
           logger.warning("Invalid JSON in chunk_data: %s", e)
           return
   ```

## Testing

- Unit test: `Chunk.from_dict` with missing `"sequence"` key raises `ValueError`.
- Unit test: `Chunk.from_dict` with `sequence: "not_a_number"` raises `ValueError`.
- Unit test: `Chunk.from_dict` with `chunk_index >= total_chunks` raises `ValueError`.
- Unit test: `GroupMessage.from_bytes` with missing `"content"` raises `ValueError`.
- Unit test: `ChunkPayload.from_bytes` with missing `"type"` raises `ValueError`.
- Unit test: `ChannelManifest.from_dict` with missing `"owner_key"` raises `ValueError`.
- Unit test: Valid data still deserializes correctly.

## Risk Assessment

- The validation adds overhead to every deserialization call, but the cost is negligible (dict key lookups and isinstance checks).
- `ValueError` is used consistently for validation errors, which is idiomatic Python and distinguishable from `KeyError` (programming error).
- The caller `receive_channel_chunk` in `client.py` line 764 will propagate the `ValueError`, which is caught by the daemon's error handler and logged appropriately.
- Existing valid data that passes through these methods will not be affected since all required fields are already present in properly formatted messages.
