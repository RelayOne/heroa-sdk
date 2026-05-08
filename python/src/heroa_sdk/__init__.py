"""heroa-sdk — Heroa managed-runtime SDK for Python.

Public surface:

- ``Heroa`` — sync client (uses httpx)
- ``AsyncHeroa`` — async client (uses httpx.AsyncClient)
- ``Heroa.deploy(request)`` / ``AsyncHeroa.deploy(request)`` — the primitive
- ``DeployRequest`` / ``Instance`` / ``Hooks`` — typed dataclasses
- ``HeroaError`` + 20 typed subclasses — one per api.ErrorCode value
- ``REGIONS`` / ``ERROR_CODES`` / ``SIZE_SHAPES`` — constants mirrored from
  the TS + Go SDKs
"""

from .client import AsyncHeroa, Heroa
from .constants import (
    ERROR_CODES,
    REGIONS,
    SDK_VERSION,
    SIZE_SHAPES,
    ErrorCode,
    Size,
)
from .errors import (
    AuthError,
    DigestMismatchError,
    HeroaError,
    IdempotencyConflictError,
    ImageScanFailedError,
    InternalError,
    InvalidAppSpecError,
    InvalidOCIRefError,
    LifecycleHookError,
    MissingCredentialError,
    PlacementError,
    PullRateLimitedError,
    QuotaExceededError,
    RegionCapacityError,
    RegionNotAllowedError,
    RegistryNotAllowedError,
    RegistryPullFailedError,
    RegistryUnreachableError,
    SignatureVerificationFailedError,
    TemplateNotFoundError,
    TemplateRegionExcludedError,
    ValidationError,
    error_from_response,
)
from .types import (
    DeployRequest,
    FileOverlay,
    Hooks,
    Instance,
    InstanceGroup,
    InstanceGroupMember,
    InstanceGroupRequest,
    ResourceShape,
)

__all__ = [
    "SDK_VERSION",
    "REGIONS",
    "ERROR_CODES",
    "SIZE_SHAPES",
    "ErrorCode",
    "Size",
    "HeroaError",
    "RegionNotAllowedError",
    "RegionCapacityError",
    "TemplateNotFoundError",
    "TemplateRegionExcludedError",
    "QuotaExceededError",
    "AuthError",
    "IdempotencyConflictError",
    "PlacementError",
    "ValidationError",
    "InternalError",
    # Spec 06 — OCI image support.
    "InvalidAppSpecError",
    "InvalidOCIRefError",
    "RegistryNotAllowedError",
    "ImageScanFailedError",
    "MissingCredentialError",
    "RegistryPullFailedError",
    "PullRateLimitedError",
    "SignatureVerificationFailedError",
    "DigestMismatchError",
    "RegistryUnreachableError",
    "LifecycleHookError",
    "error_from_response",
    "Heroa",
    "AsyncHeroa",
    "DeployRequest",
    "Instance",
    "FileOverlay",
    "ResourceShape",
    "Hooks",
    "InstanceGroupRequest",
    "InstanceGroupMember",
    "InstanceGroup",
]
