# [HIGH] Weak pairing code generation uses non-cryptographic PRNG

**Area**: Headless Client
**File**: packages/headless-client/zajel/signaling.py:33
**Type**: Security

**Description**: The `generate_pairing_code()` function uses `random.choices()` which relies on Python's Mersenne Twister PRNG. This is not a cryptographically secure random number generator. The pairing code is a security-critical value: anyone who knows or predicts a pairing code can initiate a pairing request with that client. An attacker who can observe a few outputs from the same `random` instance (e.g., via timing or other side channels) could predict future pairing codes.

The code space is already small (30 characters ^ 6 positions = ~729 million possibilities), and using a non-CSPRNG makes it worse by allowing prediction attacks.

**Impact**: An attacker could predict pairing codes and initiate unauthorized pairing with the headless client, potentially establishing a P2P connection and intercepting or injecting messages.

**Fix**: Use `secrets.choice` instead of `random.choices`:

```python
import secrets

def generate_pairing_code() -> str:
    return "".join(secrets.choice(PAIRING_CODE_CHARS) for _ in range(PAIRING_CODE_LENGTH))
```
