# [MEDIUM] JSON deserialization of chunk_data without schema validation

**Area**: Headless Client
**File**: packages/headless-client/zajel/client.py:676-688
**Type**: Security

**Description**: The `_handle_chunk_data` method processes incoming chunk data from the signaling server. If the `data` field is a string, it is parsed with `json.loads(chunk_data)` (line 686) with no schema validation. The parsed dict is then passed to `receive_channel_chunk` which calls `Chunk.from_dict(chunk_data)` (line 764).

`Chunk.from_dict` accesses expected keys like `chunk_id`, `routing_hash`, `sequence`, etc. without validation. If the server or an attacker sends malformed data:
1. Missing keys will raise `KeyError` exceptions (caught by the outer handler, but still disruptive)
2. Unexpected types (e.g., `sequence: "not_a_number"`) will cause type errors downstream
3. The `base64.b64decode(data["encrypted_payload"])` call in `Chunk.from_dict` will accept any base64 data

Similar issues exist in `GroupMessage.from_bytes`, `ChunkPayload.from_bytes`, and `ChannelManifest.from_dict`.

**Impact**: Malformed data from the signaling server can cause unhandled exceptions, potentially disrupting the daemon's ability to process further messages. While not directly exploitable for code execution, it is a denial-of-service vector and violates the robustness principle.

**Fix**: Add schema validation to all deserialization methods:

```python
@staticmethod
def from_dict(data: dict[str, Any]) -> "Chunk":
    required_keys = ["chunk_id", "routing_hash", "sequence", "chunk_index",
                     "total_chunks", "size", "signature", "author_pubkey",
                     "encrypted_payload"]
    for key in required_keys:
        if key not in data:
            raise ValueError(f"Missing required field: {key}")
    if not isinstance(data["sequence"], int):
        raise ValueError(f"sequence must be int, got {type(data['sequence'])}")
    if not isinstance(data["chunk_index"], int) or data["chunk_index"] < 0:
        raise ValueError("chunk_index must be a non-negative integer")
    if not isinstance(data["total_chunks"], int) or data["total_chunks"] < 1:
        raise ValueError("total_chunks must be a positive integer")
    ...
```
