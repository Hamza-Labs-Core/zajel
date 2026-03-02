"""Tests for vector clock: ordering, merging, sync gap detection, and GroupStorage integration."""

from datetime import datetime, timezone

import pytest

from zajel.vector_clock import VectorClock
from zajel.groups import Group, GroupMember, GroupMessage, GroupStorage


# ── VectorClock unit tests ─────────────────────────────────────


class TestVectorClockBasic:
    """Core operations: init, get, set, increment, serialization."""

    def test_empty_clock(self):
        vc = VectorClock()
        assert vc.is_empty
        assert vc.get("any_device") == 0
        assert vc.to_map() == {}

    def test_init_with_data(self):
        vc = VectorClock({"dev_a": 3, "dev_b": 5})
        assert vc.get("dev_a") == 3
        assert vc.get("dev_b") == 5
        assert not vc.is_empty

    def test_init_copies_input(self):
        """Mutating the input dict must not affect the clock."""
        data = {"dev_a": 1}
        vc = VectorClock(data)
        data["dev_a"] = 999
        assert vc.get("dev_a") == 1

    def test_get_default_zero(self):
        vc = VectorClock({"dev_a": 5})
        assert vc.get("unknown_device") == 0

    def test_set(self):
        vc = VectorClock()
        vc.set("dev_a", 10)
        assert vc.get("dev_a") == 10

    def test_set_overwrites(self):
        vc = VectorClock({"dev_a": 3})
        vc.set("dev_a", 7)
        assert vc.get("dev_a") == 7

    def test_increment_from_zero(self):
        vc = VectorClock()
        vc.increment("dev_a")
        assert vc.get("dev_a") == 1

    def test_increment_existing(self):
        vc = VectorClock({"dev_a": 5})
        vc.increment("dev_a")
        assert vc.get("dev_a") == 6

    def test_increment_multiple_times(self):
        vc = VectorClock()
        for _ in range(10):
            vc.increment("dev_a")
        assert vc.get("dev_a") == 10

    def test_device_ids(self):
        vc = VectorClock({"dev_a": 1, "dev_b": 2, "dev_c": 3})
        assert vc.device_ids == {"dev_a", "dev_b", "dev_c"}

    def test_device_ids_empty(self):
        vc = VectorClock()
        assert vc.device_ids == set()


class TestVectorClockSerialization:
    """to_map / from_map round-trips."""

    def test_to_map(self):
        vc = VectorClock({"dev_a": 1, "dev_b": 2})
        m = vc.to_map()
        assert m == {"dev_a": 1, "dev_b": 2}

    def test_to_map_returns_copy(self):
        vc = VectorClock({"dev_a": 1})
        m = vc.to_map()
        m["dev_a"] = 999
        assert vc.get("dev_a") == 1

    def test_from_map(self):
        vc = VectorClock.from_map({"dev_a": 3, "dev_b": 7})
        assert vc.get("dev_a") == 3
        assert vc.get("dev_b") == 7

    def test_from_map_casts_values(self):
        """JSON deserialization may produce floats; from_map should cast to int."""
        vc = VectorClock.from_map({"dev_a": 3.0, "dev_b": 7})  # type: ignore[dict-item]
        assert vc.get("dev_a") == 3
        assert isinstance(vc.get("dev_a"), int)

    def test_roundtrip(self):
        original = VectorClock({"dev_a": 5, "dev_b": 12, "dev_c": 0})
        restored = VectorClock.from_map(original.to_map())
        assert original == restored


class TestVectorClockMerge:
    """Element-wise max merge."""

    def test_merge_disjoint(self):
        a = VectorClock({"dev_a": 3})
        b = VectorClock({"dev_b": 5})
        a.merge(b)
        assert a.get("dev_a") == 3
        assert a.get("dev_b") == 5

    def test_merge_overlapping_takes_max(self):
        a = VectorClock({"dev_a": 3, "dev_b": 7})
        b = VectorClock({"dev_a": 5, "dev_b": 2})
        a.merge(b)
        assert a.get("dev_a") == 5
        assert a.get("dev_b") == 7

    def test_merge_with_empty(self):
        a = VectorClock({"dev_a": 3})
        b = VectorClock()
        a.merge(b)
        assert a.get("dev_a") == 3

    def test_merge_empty_with_nonempty(self):
        a = VectorClock()
        b = VectorClock({"dev_a": 3})
        a.merge(b)
        assert a.get("dev_a") == 3

    def test_merge_does_not_mutate_other(self):
        a = VectorClock({"dev_a": 1})
        b = VectorClock({"dev_a": 5})
        a.merge(b)
        assert b.get("dev_a") == 5  # unchanged

    def test_merge_idempotent(self):
        a = VectorClock({"dev_a": 3, "dev_b": 7})
        b = VectorClock({"dev_a": 5, "dev_b": 2})
        a.merge(b)
        snapshot = a.to_map()
        a.merge(b)
        assert a.to_map() == snapshot


class TestVectorClockCausalOrdering:
    """happened_before and is_concurrent."""

    def test_happened_before_simple(self):
        a = VectorClock({"dev_a": 1})
        b = VectorClock({"dev_a": 2})
        assert a.happened_before(b)
        assert not b.happened_before(a)

    def test_happened_before_multi_device(self):
        a = VectorClock({"dev_a": 1, "dev_b": 2})
        b = VectorClock({"dev_a": 2, "dev_b": 3})
        assert a.happened_before(b)

    def test_not_happened_before_equal(self):
        a = VectorClock({"dev_a": 1, "dev_b": 2})
        b = VectorClock({"dev_a": 1, "dev_b": 2})
        assert not a.happened_before(b)

    def test_not_happened_before_when_concurrent(self):
        a = VectorClock({"dev_a": 2, "dev_b": 1})
        b = VectorClock({"dev_a": 1, "dev_b": 2})
        assert not a.happened_before(b)
        assert not b.happened_before(a)

    def test_happened_before_subset_devices(self):
        """Clock with fewer devices can still be 'before' if all known entries are <=."""
        a = VectorClock({"dev_a": 1})
        b = VectorClock({"dev_a": 2, "dev_b": 1})
        assert a.happened_before(b)

    def test_happened_before_superset_not_always_after(self):
        """A clock with more entries is not necessarily 'after'."""
        a = VectorClock({"dev_a": 3, "dev_b": 1})
        b = VectorClock({"dev_a": 2})
        # a has dev_a=3 > b's dev_a=2, so a is NOT before b
        assert not a.happened_before(b)

    def test_is_concurrent(self):
        a = VectorClock({"dev_a": 2, "dev_b": 1})
        b = VectorClock({"dev_a": 1, "dev_b": 2})
        assert a.is_concurrent(b)
        assert b.is_concurrent(a)

    def test_not_concurrent_when_ordered(self):
        a = VectorClock({"dev_a": 1})
        b = VectorClock({"dev_a": 2})
        assert not a.is_concurrent(b)
        assert not b.is_concurrent(a)

    def test_not_concurrent_when_equal(self):
        a = VectorClock({"dev_a": 1, "dev_b": 2})
        b = VectorClock({"dev_a": 1, "dev_b": 2})
        assert not a.is_concurrent(b)

    def test_empty_clocks_not_concurrent(self):
        a = VectorClock()
        b = VectorClock()
        assert not a.is_concurrent(b)

    def test_empty_before_nonempty(self):
        a = VectorClock()
        b = VectorClock({"dev_a": 1})
        assert a.happened_before(b)
        assert not b.happened_before(a)
        assert not a.is_concurrent(b)


class TestVectorClockComputeMissing:
    """compute_missing: detect sync gaps."""

    def test_no_missing_when_equal(self):
        a = VectorClock({"dev_a": 3, "dev_b": 5})
        b = VectorClock({"dev_a": 3, "dev_b": 5})
        assert a.compute_missing(b) == {}

    def test_no_missing_when_remote_ahead(self):
        local = VectorClock({"dev_a": 3})
        remote = VectorClock({"dev_a": 5})
        assert local.compute_missing(remote) == {}

    def test_single_device_missing(self):
        local = VectorClock({"dev_a": 5})
        remote = VectorClock({"dev_a": 2})
        missing = local.compute_missing(remote)
        assert missing == {"dev_a": [3, 4, 5]}

    def test_multiple_devices_missing(self):
        local = VectorClock({"dev_a": 5, "dev_b": 3})
        remote = VectorClock({"dev_a": 3, "dev_b": 1})
        missing = local.compute_missing(remote)
        assert missing == {"dev_a": [4, 5], "dev_b": [2, 3]}

    def test_remote_missing_entire_device(self):
        """Remote has never seen messages from a device."""
        local = VectorClock({"dev_a": 3, "dev_b": 2})
        remote = VectorClock({"dev_a": 3})
        missing = local.compute_missing(remote)
        assert missing == {"dev_b": [1, 2]}

    def test_remote_empty(self):
        local = VectorClock({"dev_a": 2})
        remote = VectorClock()
        missing = local.compute_missing(remote)
        assert missing == {"dev_a": [1, 2]}

    def test_local_empty(self):
        local = VectorClock()
        remote = VectorClock({"dev_a": 5})
        assert local.compute_missing(remote) == {}

    def test_both_empty(self):
        assert VectorClock().compute_missing(VectorClock()) == {}

    def test_missing_by_one(self):
        local = VectorClock({"dev_a": 4})
        remote = VectorClock({"dev_a": 3})
        assert local.compute_missing(remote) == {"dev_a": [4]}


class TestVectorClockEquality:
    """__eq__ and __repr__."""

    def test_equal_clocks(self):
        a = VectorClock({"dev_a": 1, "dev_b": 2})
        b = VectorClock({"dev_a": 1, "dev_b": 2})
        assert a == b

    def test_not_equal(self):
        a = VectorClock({"dev_a": 1})
        b = VectorClock({"dev_a": 2})
        assert a != b

    def test_not_equal_to_non_vector_clock(self):
        a = VectorClock({"dev_a": 1})
        assert a != {"dev_a": 1}

    def test_repr(self):
        vc = VectorClock({"dev_a": 1})
        assert "VectorClock" in repr(vc)
        assert "dev_a" in repr(vc)


# ── GroupStorage vector clock integration tests ────────────────


class TestGroupStorageVectorClock:
    """Test vector clock methods on GroupStorage."""

    def _make_group(self, group_id="g1"):
        return Group(
            id=group_id,
            name="Test Group",
            self_device_id="dev_0",
            members=[
                GroupMember(
                    device_id="dev_0",
                    display_name="Self",
                    public_key="key_0",
                ),
                GroupMember(
                    device_id="dev_1",
                    display_name="Peer",
                    public_key="key_1",
                ),
            ],
            created_by="dev_0",
        )

    def test_new_group_has_empty_clock(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())
        clock = storage.get_vector_clock("g1")
        assert clock.is_empty

    def test_get_clock_nonexistent_group(self):
        storage = GroupStorage()
        clock = storage.get_vector_clock("nonexistent")
        assert clock.is_empty

    def test_save_and_get_vector_clock(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        clock = VectorClock({"dev_0": 3, "dev_1": 5})
        storage.save_vector_clock("g1", clock)

        retrieved = storage.get_vector_clock("g1")
        assert retrieved.get("dev_0") == 3
        assert retrieved.get("dev_1") == 5

    def test_save_vector_clock_replaces_existing(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        storage.save_vector_clock("g1", VectorClock({"dev_0": 1}))
        storage.save_vector_clock("g1", VectorClock({"dev_0": 5}))

        assert storage.get_vector_clock("g1").get("dev_0") == 5

    def test_delete_group_removes_vector_clock(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())
        storage.save_vector_clock("g1", VectorClock({"dev_0": 3}))

        storage.delete_group("g1")
        assert storage.get_vector_clock("g1").is_empty

    def test_update_clock_on_send(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        seq1 = storage.update_vector_clock_on_send("g1", "dev_0")
        assert seq1 == 1

        seq2 = storage.update_vector_clock_on_send("g1", "dev_0")
        assert seq2 == 2

        clock = storage.get_vector_clock("g1")
        assert clock.get("dev_0") == 2

    def test_update_clock_on_receive(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        storage.update_vector_clock_on_receive("g1", "dev_1", 5)
        clock = storage.get_vector_clock("g1")
        assert clock.get("dev_1") == 5

    def test_update_clock_on_receive_takes_max(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        storage.update_vector_clock_on_receive("g1", "dev_1", 5)
        storage.update_vector_clock_on_receive("g1", "dev_1", 3)  # lower, ignored
        storage.update_vector_clock_on_receive("g1", "dev_1", 7)  # higher, accepted

        clock = storage.get_vector_clock("g1")
        assert clock.get("dev_1") == 7

    def test_update_clock_on_receive_creates_clock_if_missing(self):
        storage = GroupStorage()
        # Do not call save_group — clock dict for group does not exist yet
        storage.update_vector_clock_on_receive("g_new", "dev_1", 3)
        assert storage.get_vector_clock("g_new").get("dev_1") == 3

    def test_update_clock_on_send_creates_clock_if_missing(self):
        storage = GroupStorage()
        seq = storage.update_vector_clock_on_send("g_new", "dev_0")
        assert seq == 1

    def test_get_messages_for_sync_empty(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())
        result = storage.get_messages_for_sync("g1", VectorClock())
        assert result == []

    def test_get_messages_for_sync_finds_missing(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        # Simulate dev_0 sending 3 messages
        for i in range(1, 4):
            storage.save_message(
                GroupMessage(
                    group_id="g1",
                    author_device_id="dev_0",
                    sequence_number=i,
                    content=f"msg-{i}",
                    timestamp=datetime(2025, 1, i, tzinfo=timezone.utc),
                )
            )
        # Our local clock knows about all 3
        storage.save_vector_clock("g1", VectorClock({"dev_0": 3}))

        # Remote only has up to seq 1
        remote_clock = VectorClock({"dev_0": 1})
        missing_msgs = storage.get_messages_for_sync("g1", remote_clock)

        assert len(missing_msgs) == 2
        assert missing_msgs[0].sequence_number == 2
        assert missing_msgs[1].sequence_number == 3

    def test_get_messages_for_sync_multiple_devices(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        # dev_0 sends 2 messages, dev_1 sends 3 messages
        for i in range(1, 3):
            storage.save_message(
                GroupMessage(
                    group_id="g1",
                    author_device_id="dev_0",
                    sequence_number=i,
                    content=f"dev0-msg-{i}",
                    timestamp=datetime(2025, 1, i, tzinfo=timezone.utc),
                )
            )
        for i in range(1, 4):
            storage.save_message(
                GroupMessage(
                    group_id="g1",
                    author_device_id="dev_1",
                    sequence_number=i,
                    content=f"dev1-msg-{i}",
                    timestamp=datetime(2025, 2, i, tzinfo=timezone.utc),
                )
            )

        storage.save_vector_clock("g1", VectorClock({"dev_0": 2, "dev_1": 3}))

        # Remote has dev_0:1, dev_1:2 => missing dev_0:2, dev_1:3
        remote = VectorClock({"dev_0": 1, "dev_1": 2})
        missing = storage.get_messages_for_sync("g1", remote)

        assert len(missing) == 2
        ids = {(m.author_device_id, m.sequence_number) for m in missing}
        assert ("dev_0", 2) in ids
        assert ("dev_1", 3) in ids

    def test_get_messages_for_sync_nothing_missing(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        storage.save_message(
            GroupMessage(
                group_id="g1",
                author_device_id="dev_0",
                sequence_number=1,
                content="msg",
            )
        )
        storage.save_vector_clock("g1", VectorClock({"dev_0": 1}))

        # Remote is up to date
        remote = VectorClock({"dev_0": 1})
        assert storage.get_messages_for_sync("g1", remote) == []

    def test_get_messages_for_sync_remote_ahead(self):
        """If remote is ahead, we return nothing (we can't provide what we don't have)."""
        storage = GroupStorage()
        storage.save_group(self._make_group())

        storage.save_vector_clock("g1", VectorClock({"dev_0": 1}))
        remote = VectorClock({"dev_0": 5})
        assert storage.get_messages_for_sync("g1", remote) == []

    def test_send_receive_clock_integration(self):
        """End-to-end: send a message, receive a message, check clocks."""
        storage = GroupStorage()
        storage.save_group(self._make_group())

        # Local device sends a message
        seq = storage.update_vector_clock_on_send("g1", "dev_0")
        assert seq == 1
        storage.save_message(
            GroupMessage(
                group_id="g1",
                author_device_id="dev_0",
                sequence_number=seq,
                content="hello",
                is_outgoing=True,
                timestamp=datetime(2025, 1, 1, tzinfo=timezone.utc),
            )
        )

        # Receive a message from dev_1 with sequence 1
        storage.update_vector_clock_on_receive("g1", "dev_1", 1)
        storage.save_message(
            GroupMessage(
                group_id="g1",
                author_device_id="dev_1",
                sequence_number=1,
                content="hi back",
                is_outgoing=False,
                timestamp=datetime(2025, 1, 2, tzinfo=timezone.utc),
            )
        )

        clock = storage.get_vector_clock("g1")
        assert clock.get("dev_0") == 1
        assert clock.get("dev_1") == 1

        # A new remote that has seen nothing should get both messages
        missing = storage.get_messages_for_sync("g1", VectorClock())
        assert len(missing) == 2

    def test_messages_for_sync_returns_ordered_by_timestamp(self):
        storage = GroupStorage()
        storage.save_group(self._make_group())

        # Insert out of order
        storage.save_message(
            GroupMessage(
                group_id="g1",
                author_device_id="dev_0",
                sequence_number=2,
                content="second",
                timestamp=datetime(2025, 1, 2, tzinfo=timezone.utc),
            )
        )
        storage.save_message(
            GroupMessage(
                group_id="g1",
                author_device_id="dev_0",
                sequence_number=1,
                content="first",
                timestamp=datetime(2025, 1, 1, tzinfo=timezone.utc),
            )
        )
        storage.save_vector_clock("g1", VectorClock({"dev_0": 2}))

        missing = storage.get_messages_for_sync("g1", VectorClock())
        assert missing[0].sequence_number == 1
        assert missing[1].sequence_number == 2
