"""
Headless-only channel E2E tests.

Tests the full channel publish/subscribe flow using two headless clients:
- Owner creates a channel, publishes messages
- Subscriber subscribes via invite link, receives content

No Flutter app or WebRTC needed — content flows through the VPS relay:
  owner → chunk_announce → VPS → chunk_available → subscriber
  subscriber → chunk_request → VPS → chunk_pull → owner
  owner → chunk_push → VPS → chunk_data → subscriber

Requires:
- SIGNALING_URL env var pointing to a running VPS server
"""

import os
import time

import pytest

SIGNALING_URL = os.environ.get("SIGNALING_URL", "")


@pytest.fixture(scope="function")
def channel_owner():
    """Headless client acting as channel owner."""
    if not SIGNALING_URL:
        pytest.skip("SIGNALING_URL not set")

    from conftest import HeadlessBob

    owner = HeadlessBob(
        signaling_url=SIGNALING_URL,
        name="ChannelOwner",
        auto_accept_pairs=False,
        log_level="DEBUG",
    )
    owner.connect()
    yield owner
    owner.disconnect()


@pytest.fixture(scope="function")
def channel_subscriber():
    """Headless client acting as channel subscriber."""
    if not SIGNALING_URL:
        pytest.skip("SIGNALING_URL not set")

    from conftest import HeadlessBob

    sub = HeadlessBob(
        signaling_url=SIGNALING_URL,
        name="ChannelSubscriber",
        auto_accept_pairs=False,
        log_level="DEBUG",
    )
    sub.connect()
    yield sub
    sub.disconnect()


@pytest.mark.headless
@pytest.mark.channels
class TestHeadlessChannelE2E:
    """Channel E2E tests using two headless clients (no Flutter app)."""

    def test_create_channel_and_generate_invite_link(self, channel_owner):
        """Owner creates a channel and generates an invite link."""
        channel = channel_owner.create_channel("Test Channel", "A test")
        assert channel is not None
        assert channel.channel_id
        assert channel.manifest.name == "Test Channel"

        link = channel_owner.get_channel_invite_link(channel.channel_id)
        assert link.startswith("zajel://channel/")
        assert len(link) > 50

    def test_subscriber_decodes_invite_link(self, channel_owner, channel_subscriber):
        """Subscriber can decode and verify an invite link from the owner."""
        channel = channel_owner.create_channel("Decode Test", "Testing decode")
        link = channel_owner.get_channel_invite_link(channel.channel_id)

        sub_channel = channel_subscriber.subscribe_channel(link)
        assert sub_channel.manifest.name == "Decode Test"
        assert sub_channel.manifest.description == "Testing decode"
        assert sub_channel.encryption_key

    def test_publish_and_receive_message(self, channel_owner, channel_subscriber):
        """Owner publishes a message, subscriber receives it via VPS relay."""
        # Owner creates channel
        channel = channel_owner.create_channel("Relay Test", "E2E relay")
        link = channel_owner.get_channel_invite_link(channel.channel_id)

        # Subscriber subscribes (sends channel-subscribe to VPS)
        channel_subscriber.subscribe_channel(link)
        time.sleep(1)  # Let subscription register with VPS

        # Owner publishes a message (encrypts, chunks, announces)
        channel_owner.publish_channel_message(channel.channel_id, "Hello from owner!")
        time.sleep(1)  # Let chunk relay process

        # Subscriber should receive the content
        channel_id, payload = channel_subscriber.receive_channel_content(timeout=15)
        assert channel_id == channel.channel_id
        assert payload.content_type == "text"
        assert payload.payload.decode("utf-8") == "Hello from owner!"

    def test_publish_multiple_messages(self, channel_owner, channel_subscriber):
        """Owner publishes multiple messages, subscriber receives all."""
        channel = channel_owner.create_channel("Multi Test")
        link = channel_owner.get_channel_invite_link(channel.channel_id)

        channel_subscriber.subscribe_channel(link)
        time.sleep(1)

        messages = ["First message", "Second message", "Third message"]
        for msg in messages:
            channel_owner.publish_channel_message(channel.channel_id, msg)
            time.sleep(0.5)

        received = []
        for _ in range(len(messages)):
            _, payload = channel_subscriber.receive_channel_content(timeout=15)
            received.append(payload.payload.decode("utf-8"))

        assert received == messages

    def test_late_subscriber_gets_cached_chunks(self, channel_owner, channel_subscriber):
        """Subscriber joining after publish receives cached chunks."""
        channel = channel_owner.create_channel("Late Join Test")
        link = channel_owner.get_channel_invite_link(channel.channel_id)

        # Owner publishes BEFORE subscriber joins
        channel_owner.publish_channel_message(channel.channel_id, "Already here!")
        time.sleep(2)  # Let chunks get cached on VPS

        # Subscriber joins late
        channel_subscriber.subscribe_channel(link)

        # Should receive the cached message via chunk_available on subscribe
        channel_id, payload = channel_subscriber.receive_channel_content(timeout=15)
        assert payload.payload.decode("utf-8") == "Already here!"

    def test_content_safety_text_only(self, channel_owner, channel_subscriber):
        """Plan 09: subscriber rejects non-text content from allowed_types."""
        from zajel.channels import (
            ChannelCryptoService,
            ChunkPayload,
        )

        channel = channel_owner.create_channel("Safety Test")
        link = channel_owner.get_channel_invite_link(channel.channel_id)
        sub_ch = channel_subscriber.subscribe_channel(link)
        time.sleep(1)

        # Manually forge a chunk with "image" content type (not in allowed_types)
        # This simulates a malicious or compromised owner sending disallowed content
        crypto = ChannelCryptoService()
        payload = ChunkPayload(
            content_type="image",  # NOT in allowed_types=["text"]
            payload=b"\x89PNG\r\n\x1a\n",
        )
        routing_hash = crypto.derive_routing_hash(channel.encryption_key_private)
        chunks = crypto.create_chunks(
            payload=payload,
            encryption_key_private_b64=channel.encryption_key_private,
            signing_key_private_b64=channel.signing_key_private,
            owner_public_key_b64=channel.manifest.owner_key,
            key_epoch=1,
            sequence=1,
            routing_hash=routing_hash,
        )

        # Feed the chunk directly to the subscriber's chunk processor
        result = channel_subscriber.receive_channel_chunk(
            sub_ch.channel_id, chunks[0].to_dict()
        )

        # Subscriber should reject it (returns None, not queued)
        assert result is None, (
            "Subscriber must reject non-text content per Plan 09 content safety"
        )
