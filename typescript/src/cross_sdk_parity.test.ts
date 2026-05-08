// Cross-SDK parity test — locks the TypeScript SDK's canonical output
// for the shared DeployRequest fixture to the byte sequence used in
// cmd/control-plane/sdk_contract_test.go, sdk/go/cross_sdk_parity_test.go,
// and sdk/python/tests/test_cross_sdk_parity.py.
//
// If any canonicalizer drifts, all four parity tests fail together.

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJSON } from "./canonical.js";
import { requestToWire } from "./client.js";

test("cross-SDK parity: canonical machine-wire body matches fixture", () => {
  const want = '{"config":{"env":{},"guest":{"cpus":1,"memory_mb":512},'
    + '"image":"next-ssr","isolation_mode":"firecracker","metadata":{"agent_id":"r1-abc"},"mounts":[]},'
    + '"metadata":{"agent_id":"r1-abc"},'
    + '"name":"demo-preview","region":"us-east","ttl":"1h"}';

  const wire = requestToWire({
    template: "next-ssr",
    region: "us-east",
    appName: "demo-preview",
    size: "small",
    ttl: "1h",
    metadata: { agent_id: "r1-abc" },
  });
  const got = canonicalJSON(wire);
  assert.equal(got, want, `canonical drift:\n want: ${want}\n got:  ${got}`);
});

// PR #20 contract: egress_policy / allowed_domains / ingress wire shape.
// Mirrors sdk/go/cross_sdk_parity_test.go::TestCrossSDKParity_NetworkPolicyWireShape
// and cmd/control-plane/sdk_network_contract_test.go::networkPolicyFixtureBody.
// Drift here means the control plane silently degrades to allow-all (the
// server's struct decoder drops unknown fields by default).
test("cross-SDK parity: network-policy wire shape (egress + ingress)", () => {
  const want = '{"allowed_domains":["api.openai.com","api.anthropic.com"],"config":{"env":{},"guest":{"cpus":1,"memory_mb":512},"image":"next-ssr","isolation_mode":"firecracker","metadata":{"agent_id":"r1-net"},"mounts":[]},"egress_policy":"allowed-domains","ingress":[{"port":8080,"public":true}],"metadata":{"agent_id":"r1-net"},"name":"demo-net","region":"us-east","ttl":"1h"}';
  const wire = requestToWire({ template: "next-ssr", region: "us-east", appName: "demo-net", size: "small", ttl: "1h", metadata: { agent_id: "r1-net" }, egressPolicy: "allowed-domains", allowedDomains: ["api.openai.com", "api.anthropic.com"], ingress: [{ port: 8080, public: true }] });
  assert.equal(canonicalJSON(wire), want, `network-policy canonical drift\n want: ${want}`);
});
