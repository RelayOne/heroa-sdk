"""Canonical JSON serializer for idempotency-key derivation.

The control-plane's Idempotency-Key contract is
``sha256(canonicalized(args))``. "Canonical" here = recursive sort of
object keys and no whitespace — a pure key-order normalizer. Python's
default ``json.dumps(sort_keys=True)`` gives us that directly.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    """Return the canonical JSON encoding of ``value``.

    Equivalent to json.dumps with sort_keys=True and no whitespace.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def canonical_sha256(value: Any) -> str:
    """Return hex(sha256(canonical_json(value)))."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
