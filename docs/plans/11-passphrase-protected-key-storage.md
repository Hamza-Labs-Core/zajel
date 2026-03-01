# Plan 11: Passphrase-Protected Key Storage

## Problem

On desktop platforms (Windows, Linux, older macOS), `FlutterSecureStorage` relies on software-only key storage (DPAPI, libsecret) that any process running as the user can access. This means malware or a compromised user session can extract Zajel's X25519 private key without needing root/admin privileges.

| Platform | Current Storage | Risk |
|----------|----------------|------|
| Android | Hardware Keystore / TEE | Low — hardware-backed |
| iOS | Secure Enclave + Keychain | Low — hardware-backed |
| macOS (Apple Silicon / T2) | Keychain + Secure Enclave | Low — hardware-backed |
| macOS (older Intel) | Keychain (software) | Medium — OS prompt helps |
| Windows | DPAPI | High — any user process can decrypt |
| Linux (with keyring) | libsecret (GNOME Keyring / KDE Wallet) | High — session-unlocked |
| Linux (no keyring) | Potentially plaintext file | Critical |

## Solution

Add an optional passphrase-based encryption layer that wraps the private key before storing it. The private key is encrypted at rest and only decrypted into memory when the user provides their passphrase at app startup.

```
Storage: FlutterSecureStorage stores encrypted_blob (useless without passphrase)
Startup: User enters passphrase → derive wrapping key → decrypt private key into memory
Close:   Private key wiped from memory
```

## Design

### Key Wrapping Scheme

```
passphrase (user input)
    │
    ▼
Argon2id(passphrase, random_salt, t=3, m=65536, p=4)
    │
    ▼
wrapping_key (32 bytes)
    │
    ▼
ChaCha20-Poly1305(wrapping_key, random_nonce, private_key)
    │
    ▼
encrypted_blob = salt ‖ nonce ‖ ciphertext ‖ tag
    │
    ▼
Store in FlutterSecureStorage (or even plain file — blob is safe)
```

- **Argon2id**: Memory-hard KDF, resistant to GPU/ASIC brute-force. Parameters: 3 iterations, 64 MB memory, 4 parallelism (tunable per platform).
- **ChaCha20-Poly1305**: Already used in the app for message encryption.
- **Salt**: 16 bytes, random, stored alongside the blob.
- **Nonce**: 12 bytes, random, stored alongside the blob.

### Platform Behavior

| Platform | Default Behavior | User Can Override |
|----------|-----------------|-------------------|
| Android | No passphrase (hardware keystore sufficient) | Yes — opt into passphrase |
| iOS | No passphrase (Secure Enclave sufficient) | Yes — opt into passphrase |
| macOS (Apple Silicon / T2) | No passphrase (Secure Enclave) | Yes — opt into passphrase |
| macOS (older Intel) | Prompt to set passphrase | Yes — can skip |
| Windows | Prompt to set passphrase | Yes — can skip (with warning) |
| Linux | Prompt to set passphrase | Yes — can skip (with warning) |

### Biometric Unlock (Mobile)

On mobile platforms where the user opts into passphrase protection, offer biometric unlock as an alternative to typing the passphrase each time:

1. User sets passphrase on first setup.
2. App offers "Enable biometric unlock?" — stores the wrapping key in the hardware keystore, gated behind biometric auth (fingerprint/face).
3. On subsequent launches: biometric prompt → release wrapping key → decrypt private key.
4. Passphrase remains as fallback if biometrics fail.

### Passphrase Change

Changing the passphrase does not require regenerating the identity key:

1. Decrypt private key with old passphrase.
2. Derive new wrapping key from new passphrase (new salt).
3. Re-encrypt private key with new wrapping key.
4. Store new blob, discard old.

### Storage Format

```json
{
  "version": 1,
  "protected": true,
  "kdf": "argon2id",
  "kdf_params": {
    "salt": "<base64>",
    "iterations": 3,
    "memory_kb": 65536,
    "parallelism": 4
  },
  "cipher": "chacha20-poly1305",
  "nonce": "<base64>",
  "ciphertext": "<base64>"
}
```

When `protected: false`, the private key is stored directly in FlutterSecureStorage as today (no wrapping layer).

## Implementation Steps

### Phase 1: Core Key Wrapping

1. **Add Argon2 dependency** — `argon2_ffi` or `cryptography_flutter` package for Argon2id support.
2. **Create `KeyWrappingService`** — new service in `lib/core/crypto/` that handles:
   - `wrapKey(privateKey, passphrase) → encrypted_blob`
   - `unwrapKey(encrypted_blob, passphrase) → privateKey`
   - `isProtected() → bool`
   - `changePassphrase(oldPassphrase, newPassphrase)`
3. **Integrate with `CryptoService`** — modify `_loadOrGenerateIdentityKeys()` to check if the stored key is passphrase-protected and prompt for unlock if needed.
4. **Add passphrase prompt UI** — a lock screen shown at app startup before the main app loads, with:
   - Passphrase text field
   - "Unlock" button
   - Error state for wrong passphrase
   - Biometric button (if enabled)

### Phase 2: Setup Flow

5. **Platform detection** — detect whether the current platform has hardware-backed storage.
6. **First-run setup** — on desktop platforms, prompt the user to set a passphrase during initial setup. On mobile, make it an opt-in setting.
7. **Settings UI** — add to settings screen:
   - "Passphrase Protection" toggle
   - "Change Passphrase" option
   - "Enable Biometric Unlock" option (mobile only)
   - Platform security info (show what storage backend is in use)

### Phase 3: Migration

8. **Migration path** — for existing users who upgrade:
   - Detect unprotected key on desktop.
   - Prompt to set a passphrase (skippable with warning).
   - Re-wrap the existing key without regenerating identity.
9. **Headless client support** — update Python headless client to support passphrase-protected key files for testing and CI.

## Dependencies

- Argon2 library for Flutter (e.g., `argon2_ffi`, `hashlib`, or `cryptography_flutter`)
- No server changes required — this is entirely client-side
- No protocol changes — the X25519 public key and session establishment are unchanged

## Security Considerations

- **Memory safety**: The decrypted private key lives in process memory while the app is running. A root attacker can read process memory. This is an inherent limitation — passphrase protection guards **at-rest** storage, not runtime.
- **Passphrase strength**: Should enforce minimum length (8+ characters) and warn about weak passphrases.
- **Brute-force resistance**: Argon2id with 64 MB memory makes each guess take ~200ms on modern hardware. A 6-word passphrase would take billions of years to brute-force.
- **No recovery**: If the user forgets their passphrase, the private key is unrecoverable. They must generate a new identity and re-pair with all peers. This should be clearly communicated in the UI.

## Out of Scope

- Hardware security key support (YubiKey/FIDO2) — future enhancement
- Multi-device key sync — separate concern
- Forward secrecy / Double Ratchet — separate concern (Plan 09e)
