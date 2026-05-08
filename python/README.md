# heroa-sdk

Heroa managed-runtime SDK for Python. Sync + async clients with the same
`deploy()` contract as the TypeScript and Go SDKs.

## Install

```sh
pip install heroa-sdk
```

## Usage — sync

```python
import os
from heroa_sdk import Heroa, DeployRequest, Hooks

heroa = Heroa(
    api_key=os.environ["HEROA_API_KEY"],
    base_url=os.environ.get("HEROA_BASE_URL", "https://api.heroa.app"),
)

def on_ready(instance):
    print("live at", instance.url)

instance = heroa.deploy(DeployRequest(
    template="next-ssr",
    region="us-east",
    app_name="demo-preview",
    size="small",
    ttl="1h",
    metadata={"agent_id": "r1-abc123"},
    lifecycle=Hooks(on_ready=on_ready),
))

print(instance.id)          # 'm-h3roa-x4n7'
print(instance.url)         # 'https://m-h3roa-x4n7.heroa.app'
print(instance.expires_at)  # '2026-04-24T13:00:00Z'
```

## Usage — async

```python
import asyncio
from heroa_sdk import AsyncHeroa, DeployRequest

async def main():
    async with AsyncHeroa(api_key="...") as heroa:
        instance = await heroa.deploy(DeployRequest(
            template="next-ssr",
            region="us-east",
            app_name="demo-preview",
            size="small",
        ))
        print(instance.url)

asyncio.run(main())
```

## Typed errors

Every `deploy()` failure raises a `HeroaError` subclass mapped 1:1 with the
control plane's `api.ErrorCode` enum:

- `RegionNotAllowedError`, `RegionCapacityError`
- `TemplateNotFoundError`, `TemplateRegionExcludedError`
- `QuotaExceededError`, `AuthError`
- `IdempotencyConflictError`, `PlacementError`
- `ValidationError`, `InternalError`

Each carries `status`, `code`, `request_id`, and `details`.

## Idempotency

`deploy()` auto-derives `Idempotency-Key` from
`sha256(canonical_json(request))`. Override via
`DeployRequest.idempotency_key`.

## Coming in H4-2..H4-4

- WebSocket back-channel for `on_log` / `Instance.stream()`.
- Instance methods: `extend`, `destroy`, `status`, `logs`, `exec`.
