# heroa-sdk

Public SDKs for [Heroa](https://api.heroa.app) — agent-first managed Firecracker microVM substrate.

## Languages

| Language | Package | Install |
|---|---|---|
| Python | `heroa-sdk` | `pip install git+https://github.com/RelayOne/heroa-sdk.git#subdirectory=python` |
| TypeScript | `@heroa/sdk` | `npm install github:RelayOne/heroa-sdk#main:typescript` (or use a `pnpm` GitHub dependency) |
| Go | — | Internal-only; consume `heroa.dev/heroa/sdk/go` from the heroa monorepo. |

PyPI + npm registry publishes will follow once the SDK API stabilizes; for now both languages install from this Github source of truth.

## Quick start (Python)

```python
from heroa_sdk import Heroa

heroa = Heroa(api_key="hk_live_...")
instance = heroa.deploy(
    template="r1-agent",
    region="us-east",
    env={"R1_TASK": "..."},
    ttl="1h",
)
print(instance.url)  # m-<id>-us-east.heroa.app
```

## Quick start (TypeScript)

```typescript
import { Heroa } from "@heroa/sdk";

const heroa = new Heroa({ apiKey: "hk_live_..." });
const instance = await heroa.deploy({
  template: "r1-agent",
  region: "us-east",
  env: { R1_TASK: "..." },
  ttl: "1h",
});
console.log(instance.url);
```

## Layout

```
python/     — Python SDK source (sync + async clients).
typescript/ — TypeScript SDK source (Node 20+).
schema/     — Cross-language contract source-of-truth (contract.yaml).
LICENSE     — Apache 2.0.
```

## Cross-language contract

`schema/contract.yaml` is the source-of-truth. Per-language SDKs are validated against it. Any contract change requires updating the YAML and regenerating / editing the affected language clients in the same commit.

## Status

- **Python**: 0.1.0 — `Heroa.deploy()`, instance polling, scoped output retrieval.
- **TypeScript**: 0.1.0 — feature parity with Python; supports both Node and Bun.
- **Go**: not in this repo. Internal heroa monorepo path `heroa.dev/heroa/sdk/go`.

The control-plane API surface is stable; minor additions (instance groups, scoped tokens, custom hostnames) ship behind feature flags.

## Source of truth

This repo is mirrored from `RelayOne/heroa` (private monorepo) `sdk/python`, `sdk/typescript`, and `sdk/schema` directories. Contributions should land upstream first; the public mirror updates with each SDK release.

## License

Apache 2.0. See `LICENSE`.

Heroa, the Goodventures Lab portfolio, and all dependent peers (RelayGate, RelayOne, Truecom, Veritize, DeepTap, CloudSwarm, Actium) are operated by Goodventures Lab.
