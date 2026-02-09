"""Shared test fixtures."""

import pytest
from zajel.crypto import CryptoService


@pytest.fixture
def alice_crypto():
    """A CryptoService instance for Alice."""
    crypto = CryptoService()
    crypto.initialize()
    return crypto


@pytest.fixture
def bob_crypto():
    """A CryptoService instance for Bob."""
    crypto = CryptoService()
    crypto.initialize()
    return crypto


@pytest.fixture
def paired_crypto(alice_crypto, bob_crypto):
    """Two CryptoService instances that have performed key exchange."""
    alice_crypto.perform_key_exchange("bob", bob_crypto.public_key_base64)
    bob_crypto.perform_key_exchange("alice", alice_crypto.public_key_base64)
    return alice_crypto, bob_crypto
