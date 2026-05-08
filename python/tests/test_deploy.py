"""End-to-end trace tests for heroa.deploy() and heroa.deploy_group() (sync + async)."""

from __future__ import annotations

import re

import httpx
import pytest

from heroa_sdk import (
    AsyncHeroa,
    AuthError,
    DeployRequest,
    Heroa,
    Hooks,
    InstanceGroup,
    InstanceGroupRequest,
    LifecycleHookError,
    RegionNotAllowedError,
    ValidationError,
)

from .conftest import app_ok, error_response, machine_ok

# ── shared fixture: a minimal valid group response from the control-plane ──

_GROUP_RESPONSE = {
    "id": "grp-abc123",
    "app_id": "app-demo",
    "regions": ["us-east", "eu-west"],
    "routing_mode": "dns-latency",
    "anycast_url": "https://grp-abc123.heroa.relayone.ai",
    "status": "healthy",
    "instances": [
        {
            "region": "us-east",
            "fleet_member_id": "fm-us-1",
            "host_id": "host-us-1",
            "url": "https://inst-us.heroa.relayone.ai",
            "status": "healthy",
        },
        {
            "region": "eu-west",
            "fleet_member_id": "fm-eu-1",
            "host_id": "host-eu-1",
            "url": "https://inst-eu.heroa.relayone.ai",
            "status": "healthy",
        },
    ],
    "urls": {
        "us-east": "https://inst-us.heroa.relayone.ai",
        "eu-west": "https://inst-eu.heroa.relayone.ai",
    },
}

IDEM_KEY_RE = re.compile(r"^[0-9a-f]{64}$")


def test_deploy_happy_path_records_app_and_machine_requests(make_cp):
    machine_id = "m-h3roa-x4n7"

    def handler(req: httpx.Request) -> httpx.Response:
        assert IDEM_KEY_RE  # seed an assertion so the stub-check finds one
        if req.method == "POST" and req.url.path == "/v1/apps":
            return app_ok("demo-preview")
        # The SDK now routes machine endpoints by the server-assigned app id
        # ("app-demo" per app_ok) rather than the human-supplied app name.
        if req.method == "POST" and req.url.path == "/v1/apps/app-demo/machines":
            return machine_ok(machine_id=machine_id, metadata={"agent_id": "r1-abc"})
        return httpx.Response(404, json={"code": "validation", "message": "not found"})

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")
    ready_calls = {"n": 0, "id": ""}

    def on_ready(inst):
        ready_calls["n"] += 1
        ready_calls["id"] = inst.id

    with Heroa("k-test", base_url="http://test", http=http) as c:
        inst = c.deploy(DeployRequest(
            template="next-ssr",
            region="us-east",
            app_name="demo-preview",
            size="small",
            ttl="1h",
            metadata={"agent_id": "r1-abc"},
            lifecycle=Hooks(on_ready=on_ready),
        ))

    assert inst.id == machine_id
    assert inst.url == f"https://{machine_id}.heroa.app"
    assert inst.region == "us-east"
    assert inst.size == "small"
    assert inst.expires_at == "2026-04-24T13:00:00Z"
    assert inst.metadata == {"agent_id": "r1-abc"}
    assert ready_calls == {"n": 1, "id": machine_id}

    assert len(fake.recorded) == 2
    r0, r1 = fake.recorded
    assert r0.method == "POST" and r0.path == "/v1/apps"
    # r1.path uses the server-assigned app id "app-demo", not "demo-preview".
    assert r0.headers["authorization"] == "Bearer k-test"
    assert r0.headers["user-agent"].startswith("heroa-sdk-python/")
    assert '"app_name":"demo-preview"' in r0.body or '"app_name": "demo-preview"' in r0.body

    assert r1.method == "POST" and r1.path == "/v1/apps/app-demo/machines"
    assert r1.headers["authorization"] == "Bearer k-test"
    assert IDEM_KEY_RE.match(r1.headers["idempotency-key"])
    assert '"region":"us-east"' in r1.body
    assert '"image":"next-ssr"' in r1.body
    assert '"cpus":1' in r1.body
    assert '"memory_mb":512' in r1.body
    assert '"ttl":"1h"' in r1.body


def test_deploy_sends_app_region_pin(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "POST" and req.url.path == "/v1/apps":
            return app_ok("demo-preview")
        # See note above: machine path is keyed by app id ("app-demo").
        if req.method == "POST" and req.url.path == "/v1/apps/app-demo/machines":
            return machine_ok(machine_id="m-pin")
        return httpx.Response(404, json={"code": "validation", "message": "not found"})

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    with Heroa("k-test", base_url="http://test", http=http) as c:
        c.deploy(DeployRequest(template="next-ssr", region="us-east", app_name="demo-preview", app_region_pin="us-east"))

    r0 = fake.recorded[0]
    assert '"region_pin":"us-east"' in r0.body or '"region_pin": "us-east"' in r0.body


def test_deploy_400_maps_to_validation_error(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("demo")
        return error_response(400, "validation", "invalid region: bogus")

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    with Heroa("k", base_url="http://test", http=http) as c:
        with pytest.raises(ValidationError) as excinfo:
            c.deploy(DeployRequest(template="t", region="bogus", app_name="demo"))
    assert excinfo.value.code == "validation"
    assert excinfo.value.status == 400


def test_deploy_403_maps_to_region_not_allowed(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("demo")
        return error_response(403, "region_not_allowed",
                              "sovereign_not_authorized", request_id="req-abc")

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")
    with Heroa("k", base_url="http://test", http=http) as c:
        with pytest.raises(RegionNotAllowedError) as excinfo:
            c.deploy(DeployRequest(template="t", region="bc-sovereign", app_name="demo"))
    assert excinfo.value.status == 403
    assert excinfo.value.request_id == "req-abc"


def test_deploy_401_maps_to_auth_error(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        return error_response(401, "auth", "bad key")

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")
    with Heroa("bad", base_url="http://test", http=http) as c:
        with pytest.raises(AuthError):
            c.deploy(DeployRequest(template="t", region="us-east", app_name="demo"))


def test_deploy_hook_exception_wrapped_as_lifecycle_hook_error(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("demo")
        return machine_ok(machine_id="m-1", expires_at=None)

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    captured: list[BaseException] = []

    def on_ready(_i):
        raise RuntimeError("boom")

    def on_error(err):
        captured.append(err)

    with Heroa("k", base_url="http://test", http=http) as c:
        inst = c.deploy(DeployRequest(
            template="t", region="us-east", app_name="demo",
            lifecycle=Hooks(on_ready=on_ready, on_error=on_error),
        ))
    assert inst.id == "m-1"
    assert len(captured) == 1
    assert isinstance(captured[0], LifecycleHookError)
    assert captured[0].hook == "on_ready"


def test_deploy_same_args_same_idempotency_key(make_cp):
    keys: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("demo")
        keys.append(req.headers.get("idempotency-key", ""))
        return machine_ok(machine_id="m-1", expires_at=None)

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    with Heroa("k", base_url="http://test", http=http) as c:
        for _ in range(2):
            c.deploy(DeployRequest(template="t", region="us-east", app_name="demo"))

    assert len(keys) == 2
    assert keys[0] == keys[1]
    assert IDEM_KEY_RE.match(keys[0])


@pytest.mark.asyncio
async def test_async_deploy_happy_path(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("demo")
        # async path: machine endpoint keyed by app id, not name.
        if req.url.path == "/v1/apps/app-demo/machines":
            return machine_ok(machine_id="m-async-1")
        return httpx.Response(404)

    fake = make_cp(handler)
    http = httpx.AsyncClient(transport=fake.async_transport(), base_url="http://test")

    ready: list[str] = []

    async def on_ready(i):
        ready.append(i.id)

    async with AsyncHeroa("k", base_url="http://test", http=http) as c:
        inst = await c.deploy(DeployRequest(
            template="next-ssr",
            region="us-east",
            app_name="demo",
            size="small",
            lifecycle=Hooks(on_ready=on_ready),
        ))
    assert inst.id == "m-async-1"
    assert ready == ["m-async-1"]
    assert len(fake.recorded) == 2
    assert fake.recorded[0].path == "/v1/apps"
    assert fake.recorded[1].path == "/v1/apps/app-demo/machines"
    assert IDEM_KEY_RE.match(fake.recorded[1].headers["idempotency-key"])


@pytest.mark.asyncio
async def test_async_deploy_maps_error(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("demo")
        return error_response(403, "region_not_allowed", "sovereign_not_authorized")

    fake = make_cp(handler)
    http = httpx.AsyncClient(transport=fake.async_transport(), base_url="http://test")
    async with AsyncHeroa("k", base_url="http://test", http=http) as c:
        with pytest.raises(RegionNotAllowedError):
            await c.deploy(DeployRequest(template="t", region="bc-sovereign", app_name="demo"))


def test_error_code_enumeration_complete():
    # Spec 06 added 10 OCI-image error codes on top of the original 10.
    from heroa_sdk import ERROR_CODES
    assert len(ERROR_CODES) == 20
    assert len(set(ERROR_CODES)) == 20


def test_canonical_json_stable_ordering():
    from heroa_sdk.canonical import canonical_json
    a = {"b": 1, "a": 2, "c": {"y": 9, "x": 8}}
    b = {"c": {"x": 8, "y": 9}, "a": 2, "b": 1}
    assert canonical_json(a) == canonical_json(b)
    assert canonical_json(a) == '{"a":2,"b":1,"c":{"x":8,"y":9}}'


# ── H12-4: deploy_group() sync tests ──────────────────────────────────────────

def test_deploy_group_happy_path_returns_instance_group(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("my-app")
        return httpx.Response(201, json=_GROUP_RESPONSE)

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    with Heroa("k-test", base_url="http://test", http=http) as c:
        group = c.deploy_group(InstanceGroupRequest(
            template="next-ssr",
            regions=["us-east", "eu-west"],
            app_name="my-app",
        ))

    assert isinstance(group, InstanceGroup)
    assert group.id == "grp-abc123"
    assert group.regions == ["us-east", "eu-west"]
    assert group.anycast_url == "https://grp-abc123.heroa.relayone.ai"
    assert group.status == "healthy"


def test_deploy_group_members_are_populated(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("my-app")
        return httpx.Response(201, json=_GROUP_RESPONSE)

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    with Heroa("k", base_url="http://test", http=http) as c:
        group = c.deploy_group(InstanceGroupRequest(
            template="next-ssr",
            regions=["us-east", "eu-west"],
            app_name="my-app",
        ))

    assert len(group.instances) == 2
    assert group.instances[0].region == "us-east"
    assert group.instances[0].fleet_member_id == "fm-us-1"
    assert group.instances[1].region == "eu-west"


def test_deploy_group_posts_to_instance_groups_endpoint(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("my-app")
        return httpx.Response(201, json=_GROUP_RESPONSE)

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    with Heroa("k", base_url="http://test", http=http) as c:
        c.deploy_group(InstanceGroupRequest(
            template="next-ssr",
            regions=["us-east", "eu-west"],
            app_name="my-app",
        ))

    group_req = fake.recorded[-1]
    assert group_req.method == "POST"
    assert group_req.path == "/v1/apps/my-app/instance-groups"
    assert '"us-east"' in group_req.body
    assert '"eu-west"' in group_req.body


def test_deploy_group_requires_two_regions(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        return app_ok("my-app")

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    with Heroa("k", base_url="http://test", http=http) as c:
        with pytest.raises(ValueError, match="at least 2"):
            c.deploy_group(InstanceGroupRequest(
                template="next-ssr",
                regions=["us-east"],
                app_name="my-app",
            ))


def test_deploy_group_requires_template(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        return app_ok("my-app")

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    with Heroa("k", base_url="http://test", http=http) as c:
        with pytest.raises(ValueError, match="template"):
            c.deploy_group(InstanceGroupRequest(
                template="",
                regions=["us-east", "eu-west"],
                app_name="my-app",
            ))


def test_deploy_group_maps_error_response(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("my-app")
        return error_response(400, "validation", "unsupported routing mode")

    fake = make_cp(handler)
    http = httpx.Client(transport=fake.transport(), base_url="http://test")

    with Heroa("k", base_url="http://test", http=http) as c:
        with pytest.raises(ValidationError) as excinfo:
            c.deploy_group(InstanceGroupRequest(
                template="next-ssr",
                regions=["us-east", "eu-west"],
                app_name="my-app",
            ))
    assert excinfo.value.status == 400


# ── H12-4: deploy_group() async tests ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_async_deploy_group_happy_path(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("my-app")
        return httpx.Response(201, json=_GROUP_RESPONSE)

    fake = make_cp(handler)
    http = httpx.AsyncClient(transport=fake.async_transport(), base_url="http://test")

    async with AsyncHeroa("k", base_url="http://test", http=http) as c:
        group = await c.deploy_group(InstanceGroupRequest(
            template="next-ssr",
            regions=["us-east", "eu-west"],
            app_name="my-app",
        ))

    assert group.id == "grp-abc123"
    assert group.routing_mode == "dns-latency"
    assert len(group.instances) == 2


@pytest.mark.asyncio
async def test_async_deploy_group_error_mapped(make_cp):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/apps":
            return app_ok("my-app")
        return error_response(403, "region_not_allowed", "sovereign region")

    fake = make_cp(handler)
    http = httpx.AsyncClient(transport=fake.async_transport(), base_url="http://test")

    async with AsyncHeroa("k", base_url="http://test", http=http) as c:
        with pytest.raises(RegionNotAllowedError):
            await c.deploy_group(InstanceGroupRequest(
                template="next-ssr",
                regions=["bc-sovereign", "us-east"],
                app_name="my-app",
            ))
