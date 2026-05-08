"""Typed error classes for heroa-sdk.

Every Heroa control-plane error response round-trips to a ``HeroaError``
subclass keyed by the response's ``code`` field. The mapping matches the
TS + Go SDKs exactly so customers can write uniform branching logic
across languages.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from .constants import ErrorCode


@dataclass
class ControlPlaneErrorBody:
    """Shape of the control plane's api.ErrorResponse payload."""

    code: str
    message: str
    request_id: str | None = None
    details: Mapping[str, str] | None = None


class HeroaError(Exception):
    """Base class for every control-plane error surfaced by the SDK."""

    def __init__(
        self,
        status: int,
        body: ControlPlaneErrorBody,
    ) -> None:
        super().__init__(body.message)
        self.code: str = body.code
        self.status: int = status
        self.request_id: str | None = body.request_id
        self.details: Mapping[str, str] | None = body.details

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return (
            f"{self.__class__.__name__}("
            f"code={self.code!r} status={self.status} "
            f"message={str(self)!r} request_id={self.request_id!r})"
        )


class RegionNotAllowedError(HeroaError):
    """Raised when the tenant or template's allowlist excludes the region."""


class RegionCapacityError(HeroaError):
    """Raised when no host has capacity in the region (strict policy)."""


class TemplateNotFoundError(HeroaError):
    """Raised when the requested template slug is unknown."""


class TemplateRegionExcludedError(HeroaError):
    """Raised when a template does not ship to the requested region."""


class QuotaExceededError(HeroaError):
    """Raised when the tenant hit their monthly $ cap or instance cap."""


class AuthError(HeroaError):
    """Raised on bad or expired API key."""


class IdempotencyConflictError(HeroaError):
    """Raised when same Idempotency-Key was used with a different body."""


class PlacementError(HeroaError):
    """Raised when the placement daemon failed (image missing, networking)."""


class ValidationError(HeroaError):
    """Raised on request-shape validation failure (400)."""


class InternalError(HeroaError):
    """Raised on 5xx or unrecognized error-body responses."""


# Spec 06 — OCI image support.


class InvalidAppSpecError(HeroaError):
    """Raised when both template and image are set, or neither is set."""


class InvalidOCIRefError(HeroaError):
    """Raised when the supplied image string is not a parseable OCI ref."""


class RegistryNotAllowedError(HeroaError):
    """Raised when the registry host is not on the operator allowlist."""


class ImageScanFailedError(HeroaError):
    """Raised when Trivy reports HIGH/CRITICAL findings and accept_image_vulns is false."""


class MissingCredentialError(HeroaError):
    """Raised when a private registry has no per-tenant credential row."""


class RegistryPullFailedError(HeroaError):
    """Raised when the registry returns 5xx or layer download fails twice."""


class PullRateLimitedError(HeroaError):
    """Raised when the tenant exceeds the per-hour pull budget."""


class SignatureVerificationFailedError(HeroaError):
    """Raised when cosign signature verification fails for a signed image."""


class DigestMismatchError(HeroaError):
    """Raised when the manifest digest at pull time differs from resolution."""


class RegistryUnreachableError(HeroaError):
    """Raised when the registry endpoint returns 401/403 or refuses connection."""


@dataclass
class LifecycleHookError(Exception):
    """Wraps a lifecycle callback exception so the caller sees a typed
    error when asked. Never escapes deploy() on its own; hooks receive
    this on subsequent invocations via on_error."""

    hook: str
    cause: BaseException
    _message: str = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._message = f"heroa lifecycle hook {self.hook} threw: {self.cause!r}"
        super().__init__(self._message)


_CODE_TO_CLASS: dict[str, type[HeroaError]] = {
    "region_not_allowed": RegionNotAllowedError,
    "region_capacity": RegionCapacityError,
    "template_not_found": TemplateNotFoundError,
    "template_region_excluded": TemplateRegionExcludedError,
    "quota_exceeded": QuotaExceededError,
    "auth": AuthError,
    "idempotency_conflict": IdempotencyConflictError,
    "placement_failed": PlacementError,
    "validation": ValidationError,
    "internal": InternalError,
    "invalid_app_spec": InvalidAppSpecError,
    "invalid_oci_ref": InvalidOCIRefError,
    "registry_not_allowed": RegistryNotAllowedError,
    "image_scan_failed": ImageScanFailedError,
    "missing_credential": MissingCredentialError,
    "registry_pull_failed": RegistryPullFailedError,
    "pull_rate_limited": PullRateLimitedError,
    "signature_verification_failed": SignatureVerificationFailedError,
    "digest_mismatch": DigestMismatchError,
    "registry_unreachable": RegistryUnreachableError,
}


def error_from_response(status: int, body: ControlPlaneErrorBody) -> HeroaError:
    """Map a control-plane ErrorResponse into the right typed class."""
    cls = _CODE_TO_CLASS.get(body.code, InternalError)
    return cls(status, body)


# Make the ErrorCode import visible to type-checkers referencing the
# public re-exports in __init__.py.
_ = ErrorCode
