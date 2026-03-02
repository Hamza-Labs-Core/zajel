# Plan: Weak pairing code generation uses non-cryptographic PRNG

**Issue**: issue-headless-03.md
**Severity**: HIGH
**Area**: Headless Client
**Files to modify**:
- `packages/headless-client/zajel/signaling.py`

## Analysis

At `signaling.py:31-33`, the `generate_pairing_code()` function uses `random.choices()`:
```python
def generate_pairing_code() -> str:
    """Generate a random 6-character pairing code."""
    return "".join(random.choices(PAIRING_CODE_CHARS, k=PAIRING_CODE_LENGTH))
```

The `random` module uses Mersenne Twister (MT19937), which is not cryptographically secure. Pairing codes are security-critical: anyone who knows a code can initiate pairing with the client. The import at line 15 is `import random`, and the `secrets` module (which wraps `os.urandom`) is not imported.

The character set is 30 characters (`PAIRING_CODE_CHARS` at line 26), with 6 positions, giving ~729 million possibilities. This is already a limited space; using a predictable PRNG makes it worse.

## Fix Steps

1. **Add `import secrets`** at the top of `signaling.py` (near line 15, alongside the existing `import random`).

2. **Replace `random.choices` with `secrets.choice`** in `generate_pairing_code()` at line 32-33:
   ```python
   def generate_pairing_code() -> str:
       """Generate a random 6-character pairing code."""
       return "".join(secrets.choice(PAIRING_CODE_CHARS) for _ in range(PAIRING_CODE_LENGTH))
   ```

3. **Remove `import random`** from line 15 if it is no longer used elsewhere in the file. Checking the file: `random` is only used in `generate_pairing_code()`, so it can be removed. However, the `import string` at line 16 should remain if used elsewhere. Checking: `string` is imported but not used at all in the current code. It can be removed too for cleanliness.

## Testing

- Unit test: Generate 1000 pairing codes and verify they all consist of valid characters from `PAIRING_CODE_CHARS` and have length 6.
- Unit test: Verify uniqueness -- generating 1000 codes should produce no duplicates (with high probability).
- Run the existing pairing E2E tests to confirm no regressions.
- Verify the `secrets` module is available (standard library since Python 3.6).

## Risk Assessment

- Minimal risk. `secrets.choice` is a drop-in replacement for `random.choices` for this use case.
- The generated codes will have the same format and length, so no protocol compatibility issues.
- Performance difference is negligible (6 calls to the system CSPRNG per code generation).
