"""Canonical fingerprints shared by résumé-review workflow boundaries."""

from __future__ import annotations

import hashlib
import json

from .contracts import RoleScoringPolicy


def role_policy_fingerprint(policies: tuple[RoleScoringPolicy, ...]) -> str:
    """Hash an ordered policy snapshot using canonical JSON serialization."""

    payload = [policy.model_dump(mode="json") for policy in policies]
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()
    return hashlib.sha256(encoded).hexdigest()
