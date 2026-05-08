"""Cross-SDK parity test — locks the Python SDK's canonical output for
the shared DeployRequest fixture to the byte sequence used in
cmd/control-plane/sdk_contract_test.go and sdk/go/cross_sdk_parity_test.go.

If any of the three canonicalizers drift (TS / Go / Python), this test
and the Go parity test both fail — giving a deterministic signal that
the SDKs are no longer byte-compatible.
"""

from __future__ import annotations

from heroa_sdk import DeployRequest
from heroa_sdk.canonical import canonical_json
from heroa_sdk.client import _build_wire
from heroa_sdk.types import IngressPort


def test_cross_sdk_parity_canonical_matches_fixture():
    want = (
        '{"config":{"env":{},"guest":{"cpus":1,"memory_mb":512},'
        '"image":"next-ssr","isolation_mode":"firecracker","metadata":{"agent_id":"r1-abc"},"mounts":[]},'
        '"metadata":{"agent_id":"r1-abc"},'
        '"name":"demo-preview","region":"us-east","ttl":"1h"}'
    )
    req = DeployRequest(
        template="next-ssr",
        region="us-east",
        app_name="demo-preview",
        size="small",
        ttl="1h",
        metadata={"agent_id": "r1-abc"},
    )
    wire = _build_wire("demo-preview", req)
    got = canonical_json(wire)
    assert got == want, f"canonical drift:\n  want: {want}\n  got:  {got}"


def test_cross_sdk_parity_network_policy_wire_shape():
    """PR #20 contract: egress_policy / allowed_domains / ingress wire shape.

    Mirrors sdk/go/cross_sdk_parity_test.go::TestCrossSDKParity_NetworkPolicyWireShape
    and cmd/control-plane/sdk_network_contract_test.go::networkPolicyFixtureBody.
    Drift here means the control plane silently degrades to allow-all (the
    server's struct decoder drops unknown fields by default).
    """
    want = (
        '{"allowed_domains":["api.openai.com","api.anthropic.com"],'
        '"config":{"env":{},"guest":{"cpus":1,"memory_mb":512},'
        '"image":"next-ssr","isolation_mode":"firecracker","metadata":{"agent_id":"r1-net"},"mounts":[]},'
        '"egress_policy":"allowed-domains",'
        '"ingress":[{"port":8080,"public":true}],'
        '"metadata":{"agent_id":"r1-net"},'
        '"name":"demo-net","region":"us-east","ttl":"1h"}'
    )
    req = DeployRequest(
        template="next-ssr",
        region="us-east",
        app_name="demo-net",
        size="small",
        ttl="1h",
        metadata={"agent_id": "r1-net"},
        egress_policy="allowed-domains",
        allowed_domains=["api.openai.com", "api.anthropic.com"],
        ingress=[IngressPort(port=8080, public=True)],
    )
    wire = _build_wire("demo-net", req)
    got = canonical_json(wire)
    assert got == want, f"network-policy canonical drift:\n  want: {want}\n  got:  {got}"
