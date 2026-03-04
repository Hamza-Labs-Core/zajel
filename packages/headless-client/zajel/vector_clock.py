"""Vector clock for tracking causal ordering of messages in a group.

Maps each peer's device ID to the latest sequence number received from
that peer. Used for:
- Detecting missing messages during sync
- Establishing causal ordering (happens-before)
- Identifying which messages a peer is missing

This matches the Dart app's VectorClock (packages/app/lib/features/groups/models/vector_clock.dart).
"""

from __future__ import annotations

from typing import Any


class VectorClock:
    """A vector clock mapping device_id -> sequence_number.

    Each entry represents the highest sequence number seen from that device.
    """

    __slots__ = ("_clock",)

    def __init__(self, clock: dict[str, int] | None = None) -> None:
        self._clock: dict[str, int] = dict(clock) if clock else {}

    # ── Factory ────────────────────────────────────────────────

    @classmethod
    def from_map(cls, data: dict[str, Any]) -> VectorClock:
        """Deserialize from a dict (JSON-compatible).

        Values are cast to int to tolerate JSON numeric types.
        """
        return cls({k: int(v) for k, v in data.items()})

    # ── Accessors ──────────────────────────────────────────────

    def get(self, device_id: str) -> int:
        """Get the sequence number for a device (default 0)."""
        return self._clock.get(device_id, 0)

    @property
    def device_ids(self) -> set[str]:
        """All device IDs tracked by this clock."""
        return set(self._clock.keys())

    @property
    def is_empty(self) -> bool:
        """True if the clock has no entries."""
        return len(self._clock) == 0

    def to_map(self) -> dict[str, int]:
        """Serialize to a plain dict (JSON-compatible)."""
        return dict(self._clock)

    # ── Mutators ───────────────────────────────────────────────

    def increment(self, device_id: str) -> None:
        """Increment the counter for *device_id* by 1."""
        self._clock[device_id] = self._clock.get(device_id, 0) + 1

    def set(self, device_id: str, value: int) -> None:  # noqa: A003 — matches Dart API
        """Set the counter for *device_id* to *value*."""
        self._clock[device_id] = value

    def merge(self, other: VectorClock) -> None:
        """Element-wise max merge with *other* (in-place).

        After merging, for every device_id *d*:
            self[d] == max(self[d], other[d])
        """
        for device_id, seq in other._clock.items():
            current = self._clock.get(device_id, 0)
            if seq > current:
                self._clock[device_id] = seq

    # ── Causal ordering ────────────────────────────────────────

    def happened_before(self, other: VectorClock) -> bool:
        """Return True if this clock is *strictly* before *other*.

        self < other  iff  (for all d: self[d] <= other[d]) AND self != other
        """
        if self._clock == other._clock:
            return False
        for device_id, seq in self._clock.items():
            if seq > other._clock.get(device_id, 0):
                return False
        return True

    def is_concurrent(self, other: VectorClock) -> bool:
        """Return True if neither clock happened before the other.

        Concurrent means there exist device IDs where self is ahead
        AND device IDs where other is ahead (or equivalently,
        neither self <= other nor other <= self).
        """
        self_before_or_eq = self._is_before_or_equal(other)
        other_before_or_eq = other._is_before_or_equal(self)
        return not self_before_or_eq and not other_before_or_eq

    def _is_before_or_equal(self, other: VectorClock) -> bool:
        """Return True if self <= other (all entries)."""
        for device_id, seq in self._clock.items():
            if seq > other._clock.get(device_id, 0):
                return False
        return True

    # ── Sync ───────────────────────────────────────────────────

    def compute_missing(self, remote: VectorClock) -> dict[str, list[int]]:
        """Find messages that *remote* is missing compared to *self*.

        For each device_id where self is ahead of remote, returns the
        list of missing sequence numbers.

        Returns:
            {device_id: [missing_seq_1, missing_seq_2, ...]}
        """
        missing: dict[str, list[int]] = {}
        for device_id, local_seq in self._clock.items():
            remote_seq = remote.get(device_id)
            if local_seq > remote_seq:
                missing[device_id] = list(range(remote_seq + 1, local_seq + 1))
        return missing

    # ── Dunder methods ─────────────────────────────────────────

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, VectorClock):
            return NotImplemented
        return self._clock == other._clock

    def __repr__(self) -> str:
        return f"VectorClock({self._clock})"
