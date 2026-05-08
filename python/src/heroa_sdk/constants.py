"""Heroa SDK stable identity constants.

These mirror TS (@heroa/sdk) and Go (heroa.dev/sdk-go) exactly so a
contract test can diff them by value across all three SDKs.
"""

from __future__ import annotations

from typing import Literal

SDK_VERSION = "0.1.0-h4"

REGIONS: tuple[str, ...] = (
    "us-east",
    "us-west",
    "eu-west",
    "asia-pacific",
    "bc-sovereign",
)

ERROR_CODES: tuple[str, ...] = (
    "region_not_allowed",
    "region_capacity",
    "template_not_found",
    "template_region_excluded",
    "quota_exceeded",
    "auth",
    "idempotency_conflict",
    "placement_failed",
    "validation",
    "internal",
    # Spec 06 — OCI image support.
    "invalid_app_spec",
    "invalid_oci_ref",
    "registry_not_allowed",
    "image_scan_failed",
    "missing_credential",
    "registry_pull_failed",
    "pull_rate_limited",
    "signature_verification_failed",
    "digest_mismatch",
    "registry_unreachable",
)

ErrorCode = Literal[
    "region_not_allowed",
    "region_capacity",
    "template_not_found",
    "template_region_excluded",
    "quota_exceeded",
    "auth",
    "idempotency_conflict",
    "placement_failed",
    "validation",
    "internal",
    "invalid_app_spec",
    "invalid_oci_ref",
    "registry_not_allowed",
    "image_scan_failed",
    "missing_credential",
    "registry_pull_failed",
    "pull_rate_limited",
    "signature_verification_failed",
    "digest_mismatch",
    "registry_unreachable",
]

Size = Literal["nano", "small", "medium", "large", "xl"]

# Size label -> (cpus, memory_mb) per scope §2.3.
SIZE_SHAPES: dict[str, dict[str, int]] = {
    "nano": {"cpus": 1, "memory_mb": 256},
    "small": {"cpus": 1, "memory_mb": 512},
    "medium": {"cpus": 2, "memory_mb": 2048},
    "large": {"cpus": 4, "memory_mb": 8192},
    "xl": {"cpus": 8, "memory_mb": 16384},
}
