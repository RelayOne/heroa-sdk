# @heroa/sdk

Heroa managed-runtime SDK for TypeScript / Node. Canonical `heroa.deploy()`
primitive for in-flight agents.

## Install

```sh
npm install @heroa/sdk
```

## Usage

```ts
import { Heroa } from "@heroa/sdk";

const heroa = new Heroa({
  apiKey: process.env.HEROA_API_KEY!,
  // Optional; defaults to https://api.heroa.app
  baseUrl: process.env.HEROA_BASE_URL,
});

const instance = await heroa.deploy({
  template: "next-ssr",
  region: "us-east",
  appName: "demo-preview",
  size: "small",
  ttl: "1h",
  env: { DATABASE_URL: process.env.DATABASE_URL! },
  metadata: { agent_id: "r1-abc123" },
  lifecycle: {
    onReady: (i) => console.log("live at", i.url),
    onError: (err) => console.error("deploy error:", err),
  },
});

console.log(instance.id);         // 'm-h3roa-x4n7'
console.log(instance.url);        // 'https://m-h3roa-x4n7.heroa.app'
console.log(instance.expiresAt);  // '2026-04-24T13:00:00Z'
```

## Typed errors

Every `deploy()` rejection is an instance of `HeroaError` or a subclass. Nine
specific subclasses map one-to-one with `api.ErrorCode` values from the
control plane:

- `RegionNotAllowedError` — tenant/template excludes the region.
- `RegionCapacityError` — region has no host capacity.
- `TemplateNotFoundError` / `TemplateRegionExcludedError`
- `QuotaExceededError` — monthly cap hit.
- `AuthError` — bad/expired bearer.
- `IdempotencyConflictError` — same key, different body.
- `PlacementError` / `ValidationError` / `InternalError`

## Idempotency

`heroa.deploy()` auto-derives an `Idempotency-Key` header from
`sha256(canonicalized(args))`. Same args within the server's 24h window
return the same instance. Override via `idempotencyKey: "..."` in the
request.

## Coming in H4-2..H4-4

- WebSocket back-channel for `onLog` / streaming `instance.stream()`.
- Instance methods: `extend()`, `destroy()`, `status()`, `logs()`, `exec()`.
