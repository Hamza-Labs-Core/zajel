# Plan: SQLite database stores session keys in plaintext

**Issue**: issue-headless-07.md
**Severity**: HIGH
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/peer_storage.py`

## Analysis

At `peer_storage.py:135-143`, the `save_session_key` method stores raw session key bytes directly in the SQLite `session_key BLOB` column without any encryption:

```python
def save_session_key(self, peer_id: str, session_key: bytes) -> None:
    if self._conn is None:
        return
    self._conn.execute(
        "UPDATE peers SET session_key = ? WHERE peer_id = ?",
        (session_key, peer_id),
    )
    self._conn.commit()
```

The database is created at `peer_storage.py:42` via `sqlite3.connect(self._db_path)` with no file permission restrictions. Similarly, the `initialize()` method at line 40-55 does not set restrictive permissions on the database file.

The `StoredPeer` dataclass (line 19-30) includes `session_key: Optional[bytes] = None`, confirming keys are stored as raw bytes.

## Fix Steps

1. **Set restrictive file permissions on the database file** in `initialize()` at line 40-55. After creating the connection, set the file to owner-only access:
   ```python
   def initialize(self) -> None:
       """Open or create the database."""
       db_existed = os.path.exists(self._db_path)
       self._conn = sqlite3.connect(self._db_path)
       if not db_existed:
           os.chmod(self._db_path, 0o600)
       self._conn.execute("""
           CREATE TABLE IF NOT EXISTS peers (
               ...
           )
       """)
       self._conn.commit()
   ```

2. **Add `import os`** at the top of `peer_storage.py` (it is not currently imported).

3. **Encrypt session keys before storage** using a key-encryption-key (KEK) derived from the client's identity or a machine-specific secret. This is a more involved change:

   a. Add a `_derive_storage_key()` method that derives a KEK from `os.urandom(32)` stored in a separate file with `0o600` permissions (a "master key" file):
   ```python
   @staticmethod
   def _get_or_create_master_key(db_path: str) -> bytes:
       key_path = db_path + ".key"
       if os.path.exists(key_path):
           with open(key_path, "rb") as f:
               return f.read()
       key = os.urandom(32)
       fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
       with os.fdopen(fd, "wb") as f:
           f.write(key)
       return key
   ```

   b. Use ChaCha20-Poly1305 to encrypt session keys before storage and decrypt after retrieval. Wrap `save_session_key()` and `get_session_key()`.

4. **Minimum viable fix** (if the full encryption is deferred): At least add `os.chmod(self._db_path, 0o600)` and add a log warning when session keys are stored:
   ```python
   logger.warning(
       "Session key stored in plaintext for peer %s. "
       "Consider enabling database encryption.",
       peer_id,
   )
   ```

## Testing

- Verify the database file is created with `0o600` permissions by checking `stat()` on the file after `initialize()`.
- Verify that another user cannot read the database file.
- If session key encryption is implemented: verify that raw session key bytes are not present in the database file (search for known key bytes in the SQLite file).
- Run existing E2E tests that use `PeerStorage` to confirm no regressions.

## Risk Assessment

- Low risk for the file permission fix (step 1-2).
- Medium risk for the session key encryption (step 3). It adds complexity and requires migration logic for existing databases with plaintext keys.
- The master key file approach creates a dependency on a separate file. If the key file is lost, all session keys become unrecoverable. This is acceptable since session keys can be renegotiated.
- For the minimum viable fix (step 4), risk is very low.
