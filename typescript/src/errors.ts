// @heroa/sdk — typed error classes.
//
// Every API error the control plane emits round-trips through an api.ErrorResponse
// shape ({code, message, request_id?, details?}). The SDK maps each code to one
// of these nine classes so callers can branch on `instanceof` instead of
// string-matching codes. HeroaError is the common base; it carries the
// original code + message + the request_id for support triage.

import type { ErrorCode } from "./constants.js";

/** Shape of the control plane's api.ErrorResponse payload. */
export interface ControlPlaneErrorBody {
  code: ErrorCode;
  message: string;
  request_id?: string;
  details?: Record<string, string>;
}

/** Base class for every control-plane error surfaced by the SDK. */
export class HeroaError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: Record<string, string> | undefined;

  constructor(status: number, body: ControlPlaneErrorBody) {
    super(body.message);
    this.name = this.constructor.name;
    this.code = body.code;
    this.status = status;
    this.requestId = body.request_id;
    this.details = body.details;
  }
}

export class RegionNotAllowedError extends HeroaError {}
export class RegionCapacityError extends HeroaError {}
export class TemplateNotFoundError extends HeroaError {}
export class TemplateRegionExcludedError extends HeroaError {}
export class QuotaExceededError extends HeroaError {}
export class AuthError extends HeroaError {}
export class IdempotencyConflictError extends HeroaError {}
export class PlacementError extends HeroaError {}
export class ValidationError extends HeroaError {}
export class InternalError extends HeroaError {}
// Spec 06 — OCI image support.
export class InvalidAppSpecError extends HeroaError {}
export class InvalidOCIRefError extends HeroaError {}
export class RegistryNotAllowedError extends HeroaError {}
export class ImageScanFailedError extends HeroaError {}
export class MissingCredentialError extends HeroaError {}
export class RegistryPullFailedError extends HeroaError {}
export class PullRateLimitedError extends HeroaError {}
export class SignatureVerificationFailedError extends HeroaError {}
export class DigestMismatchError extends HeroaError {}
export class RegistryUnreachableError extends HeroaError {}

/** LifecycleHookError wraps a thrown lifecycle callback so the deploy() caller
 * sees a typed error when asked. It never escapes the SDK by default; hooks
 * receive it on subsequent invocations. */
export class LifecycleHookError extends Error {
  readonly hook: "onReady" | "onStop" | "onError";
  readonly cause: unknown;
  constructor(hook: "onReady" | "onStop" | "onError", cause: unknown) {
    super(`heroa lifecycle hook ${hook} threw: ${String(cause)}`);
    this.name = "LifecycleHookError";
    this.hook = hook;
    this.cause = cause;
  }
}

/** Map a control-plane ErrorResponse into the right typed class. */
export function errorFromResponse(status: number, body: ControlPlaneErrorBody): HeroaError {
  switch (body.code) {
    case "region_not_allowed":
      return new RegionNotAllowedError(status, body);
    case "region_capacity":
      return new RegionCapacityError(status, body);
    case "template_not_found":
      return new TemplateNotFoundError(status, body);
    case "template_region_excluded":
      return new TemplateRegionExcludedError(status, body);
    case "quota_exceeded":
      return new QuotaExceededError(status, body);
    case "auth":
      return new AuthError(status, body);
    case "idempotency_conflict":
      return new IdempotencyConflictError(status, body);
    case "placement_failed":
      return new PlacementError(status, body);
    case "validation":
      return new ValidationError(status, body);
    case "internal":
      return new InternalError(status, body);
    case "invalid_app_spec":
      return new InvalidAppSpecError(status, body);
    case "invalid_oci_ref":
      return new InvalidOCIRefError(status, body);
    case "registry_not_allowed":
      return new RegistryNotAllowedError(status, body);
    case "image_scan_failed":
      return new ImageScanFailedError(status, body);
    case "missing_credential":
      return new MissingCredentialError(status, body);
    case "registry_pull_failed":
      return new RegistryPullFailedError(status, body);
    case "pull_rate_limited":
      return new PullRateLimitedError(status, body);
    case "signature_verification_failed":
      return new SignatureVerificationFailedError(status, body);
    case "digest_mismatch":
      return new DigestMismatchError(status, body);
    case "registry_unreachable":
      return new RegistryUnreachableError(status, body);
  }
}
