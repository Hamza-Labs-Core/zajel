# [HIGH] SQLite database stores session keys in plaintext

**Area**: Headless Client
**File**: packages/headless-client/zajel/peer_storage.py:135-143
**Type**: Security

**Description**: The `save_session_key` method stores raw session key bytes directly in the SQLite database (column `session_key BLOB`). These are the symmetric ChaCha20-Poly1305 session keys used to encrypt all P2P communication. The database file (`zajel_headless.db` or `zajel_peers.db`) sits on disk without any encryption or file-level protection.

Any process or user with read access to the database file can extract all session keys and decrypt any intercepted messages.

**Impact**: If the database file is compromised (disk theft, backup exposure, malware with file read access, or the /tmp socket vulnerability allowing any local user to read data), all past encrypted communications with all peers can be decrypted. This negates the entire encryption layer.

**Fix**:
1. Encrypt session keys before storing them using a key derived from a local secret (e.g., OS keychain, environment variable, or file with strict permissions).
2. Set restrictive file permissions on the database file (`os.chmod(db_path, 0o600)`) immediately after creation.
3. Consider using SQLCipher for full database encryption.
4. At minimum, ensure the database file is created with restricted permissions:

```python
def initialize(self) -> None:
    # Create database with restrictive permissions
    db_existed = os.path.exists(self._db_path)
    self._conn = sqlite3.connect(self._db_path)
    if not db_existed:
        os.chmod(self._db_path, 0o600)
    ...
```
