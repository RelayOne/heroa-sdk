// @heroa/sdk — Heroa managed-runtime SDK for TypeScript.
//
// This package's public surface:
//   - `Heroa` client class: construct with { apiKey, baseUrl? }
//   - `heroa.deploy({template, region, ...})` primitive (scope §5)
//   - 10 typed HeroaError subclasses (scope §5.5)
//   - SDK_VERSION / REGIONS / ERROR_CODES / SIZE_SHAPES constants
//
// Exec, logs, extend, destroy, WS back-channel land in H4-2..H4-4.

export * from "./constants.js";
export * from "./errors.js";
export * from "./types.js";
export { Heroa, type HeroaConfig, requestToWire, wireToInstance, _internal } from "./client.js";
