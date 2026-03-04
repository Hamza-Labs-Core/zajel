#!/usr/bin/env python3
"""Generate ML-KEM-768 test vectors for cross-platform interop testing.

This script generates test vectors that can be used to verify ML-KEM-768
implementations across the three Zajel client platforms:
  - Flutter/Dart (via liboqs FFI)
  - Python headless client (via cryptography >= 44.0)
  - TypeScript web client (via @noble/post-quantum)

The hybrid key exchange combines X25519 + ML-KEM-768 shared secrets via HKDF:
  session_key = HKDF-SHA256(x25519_secret || mlkem_secret, "zajel_hybrid_session")

Output: JSON file with test vectors for key generation, encapsulation, and
hybrid session derivation.

Usage:
  python scripts/generate-mlkem-test-vectors.py [output.json]

Requires: cryptography >= 44.0 (pip install 'cryptography>=44.0')
"""

import base64
import hashlib
import json
import sys
from datetime import datetime, timezone

# Check for ML-KEM support
try:
    from cryptography.hazmat.primitives.asymmetric.mlkem import (
        MLKEM768PrivateKey,
        MLKEM768PublicKey,
    )
    from cryptography.hazmat.primitives.asymmetric.x25519 import (
        X25519PrivateKey,
        X25519PublicKey,
    )
    from cryptography.hazmat.primitives.hashes import SHA256
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
except ImportError:
    print("ERROR: cryptography >= 44.0 with ML-KEM support required.")
    print("Install with: pip install 'cryptography>=44.0'")
    sys.exit(1)


def b64(data: bytes) -> str:
    """Encode bytes to base64 string."""
    return base64.b64encode(data).decode()


def generate_x25519_keypair():
    """Generate an X25519 key pair."""
    private_key = X25519PrivateKey.generate()
    public_key_bytes = private_key.public_key().public_bytes_raw()
    private_key_bytes = private_key.private_bytes_raw()
    return private_key, private_key_bytes, public_key_bytes


def generate_mlkem_keypair():
    """Generate an ML-KEM-768 key pair."""
    private_key = MLKEM768PrivateKey.generate()
    public_key_bytes = private_key.public_key().public_bytes_raw()
    return private_key, public_key_bytes


def derive_hybrid_session_key(
    x25519_shared_secret: bytes, mlkem_shared_secret: bytes
) -> bytes:
    """Derive a hybrid session key from X25519 + ML-KEM shared secrets."""
    combined = x25519_shared_secret + mlkem_shared_secret
    return HKDF(
        algorithm=SHA256(),
        length=32,
        salt=b"",
        info=b"zajel_hybrid_session",
    ).derive(combined)


def derive_classical_session_key(x25519_shared_secret: bytes) -> bytes:
    """Derive a classical session key from X25519 shared secret only."""
    return HKDF(
        algorithm=SHA256(),
        length=32,
        salt=b"",
        info=b"zajel_session",
    ).derive(x25519_shared_secret)


def generate_vectors():
    """Generate comprehensive test vectors."""
    vectors = {
        "generator": "generate-mlkem-test-vectors.py",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "description": (
            "ML-KEM-768 + X25519 hybrid key exchange test vectors for "
            "cross-platform interop testing across Zajel clients."
        ),
        "constants": {
            "mlkem768_public_key_size": 1184,
            "mlkem768_ciphertext_size": 1088,
            "mlkem768_shared_secret_size": 32,
            "x25519_key_size": 32,
            "protocol_version_classical": 1,
            "protocol_version_hybrid": 2,
            "hkdf_info_classical": "zajel_session",
            "hkdf_info_hybrid": "zajel_hybrid_session",
        },
        "test_cases": [],
    }

    # Test case 1: Basic ML-KEM key generation and encapsulation
    print("Generating test case 1: ML-KEM encapsulation/decapsulation...")
    mlkem_priv_a, mlkem_pub_a = generate_mlkem_keypair()
    ciphertext, shared_secret_enc = MLKEM768PublicKey.from_public_bytes(
        mlkem_pub_a
    ).encapsulate()
    # The encapsulate call is on the public key, not the object we have
    # Actually, we need to use the public key object
    pub_key_obj = mlkem_priv_a.public_key()
    ct, ss_enc = pub_key_obj.encapsulate()
    ss_dec = mlkem_priv_a.decapsulate(ct)
    assert ss_enc == ss_dec, "Encapsulate/decapsulate mismatch!"

    vectors["test_cases"].append({
        "name": "mlkem_encap_decap",
        "description": "ML-KEM-768 encapsulation and decapsulation",
        "mlkem_public_key_b64": b64(mlkem_pub_a),
        "mlkem_ciphertext_b64": b64(ct),
        "mlkem_shared_secret_b64": b64(ss_enc),
        "mlkem_shared_secret_hash": hashlib.sha256(ss_enc).hexdigest()[:16],
    })

    # Test case 2: Full hybrid key exchange (Alice initiator, Bob responder)
    print("Generating test case 2: Full hybrid key exchange...")
    alice_x_priv, alice_x_priv_bytes, alice_x_pub = generate_x25519_keypair()
    bob_x_priv, bob_x_priv_bytes, bob_x_pub = generate_x25519_keypair()
    alice_mlkem_priv, alice_mlkem_pub = generate_mlkem_keypair()
    bob_mlkem_priv, bob_mlkem_pub = generate_mlkem_keypair()

    # X25519 shared secrets (should be same for both sides)
    alice_x25519_ss = alice_x_priv.exchange(
        X25519PublicKey.from_public_bytes(bob_x_pub)
    )
    bob_x25519_ss = bob_x_priv.exchange(
        X25519PublicKey.from_public_bytes(alice_x_pub)
    )
    assert alice_x25519_ss == bob_x25519_ss, "X25519 shared secret mismatch!"

    # Alice (initiator) encapsulates to Bob's ML-KEM key
    bob_mlkem_pub_obj = bob_mlkem_priv.public_key()
    mlkem_ct, alice_mlkem_ss = bob_mlkem_pub_obj.encapsulate()

    # Bob (responder) decapsulates
    bob_mlkem_ss = bob_mlkem_priv.decapsulate(mlkem_ct)
    assert alice_mlkem_ss == bob_mlkem_ss, "ML-KEM shared secret mismatch!"

    # Both derive the same hybrid session key
    alice_session_key = derive_hybrid_session_key(alice_x25519_ss, alice_mlkem_ss)
    bob_session_key = derive_hybrid_session_key(bob_x25519_ss, bob_mlkem_ss)
    assert alice_session_key == bob_session_key, "Session key mismatch!"

    vectors["test_cases"].append({
        "name": "hybrid_key_exchange",
        "description": "Full X25519 + ML-KEM-768 hybrid key exchange",
        "alice": {
            "x25519_public_key_b64": b64(alice_x_pub),
            "mlkem_public_key_b64": b64(alice_mlkem_pub),
        },
        "bob": {
            "x25519_public_key_b64": b64(bob_x_pub),
            "mlkem_public_key_b64": b64(bob_mlkem_pub),
        },
        "mlkem_ciphertext_b64": b64(mlkem_ct),
        "x25519_shared_secret_hash": hashlib.sha256(alice_x25519_ss).hexdigest()[:16],
        "mlkem_shared_secret_hash": hashlib.sha256(alice_mlkem_ss).hexdigest()[:16],
        "hybrid_session_key_hash": hashlib.sha256(alice_session_key).hexdigest()[:16],
    })

    # Test case 3: Classical-only session key derivation
    print("Generating test case 3: Classical session key derivation...")
    classical_session_key = derive_classical_session_key(alice_x25519_ss)

    vectors["test_cases"].append({
        "name": "classical_session",
        "description": "Classical X25519-only session key derivation",
        "x25519_shared_secret_hash": hashlib.sha256(alice_x25519_ss).hexdigest()[:16],
        "classical_session_key_hash": hashlib.sha256(classical_session_key).hexdigest()[:16],
        "hybrid_session_key_hash": hashlib.sha256(alice_session_key).hexdigest()[:16],
        "keys_differ": classical_session_key != alice_session_key,
    })

    # Test case 4: Key size validation
    print("Generating test case 4: Key size validation...")
    vectors["test_cases"].append({
        "name": "key_sizes",
        "description": "Verify ML-KEM-768 key and ciphertext sizes",
        "mlkem_public_key_size": len(alice_mlkem_pub),
        "mlkem_ciphertext_size": len(mlkem_ct),
        "mlkem_shared_secret_size": len(alice_mlkem_ss),
        "x25519_public_key_size": len(alice_x_pub),
        "x25519_shared_secret_size": len(alice_x25519_ss),
    })

    return vectors


def main():
    output_path = sys.argv[1] if len(sys.argv) > 1 else "mlkem-test-vectors.json"

    print(f"Generating ML-KEM-768 test vectors...")
    vectors = generate_vectors()

    with open(output_path, "w") as f:
        json.dump(vectors, f, indent=2)

    print(f"Test vectors written to {output_path}")
    print(f"  {len(vectors['test_cases'])} test cases generated")


if __name__ == "__main__":
    main()
