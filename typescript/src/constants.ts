// @heroa/sdk — stable SDK identity constants.
//
// These values are the SDK's public face: SDK_VERSION is part of the
// User-Agent header, REGIONS is the authoritative region enumeration,
// and ERROR_CODES mirrors the control plane's api.ErrorCode enum so the
// errors.ts mapper has a single source of truth for branch coverage.

/** Error codes that mirror the control plane's api.ErrorCode enum. */
export const ERROR_CODES = [
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
  // Spec 06 — OCI image support.
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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Runtime region enum. SDK callers pass these to deploy(). */
export const REGIONS = [
  "us-east",
  "us-west",
  "eu-west",
  "asia-pacific",
  "bc-sovereign",
] as const;

export type Region =
  | (typeof REGIONS)[number]
  | `byoc:${string}`
  | `onprem:${string}`;

/** Size -> (cpus, memory_mb) mapping per scope §2.3. */
export const SIZE_SHAPES = {
  nano: { cpus: 1, memoryMb: 256 },
  small: { cpus: 1, memoryMb: 512 },
  medium: { cpus: 2, memoryMb: 2048 },
  large: { cpus: 4, memoryMb: 8192 },
  xl: { cpus: 8, memoryMb: 16384 },
} as const;

export type Size = keyof typeof SIZE_SHAPES;

export const SDK_VERSION = "0.1.0-h4";
