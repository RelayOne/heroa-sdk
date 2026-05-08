"""Heroa Python SDK — sync + async clients.

Both ``Heroa`` and ``AsyncHeroa`` expose the same deploy() contract.
The sync variant wraps httpx.Client; the async variant wraps
httpx.AsyncClient. A single ``_build_wire`` / ``_instance_from_wire``
pair keeps the two variants byte-for-byte identical on the wire.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import asdict
from typing import Any

import httpx

from .canonical import canonical_json, canonical_sha256
from .constants import SDK_VERSION, SIZE_SHAPES
from .errors import (
    ControlPlaneErrorBody,
    HeroaError,
    InternalError,
    LifecycleHookError,
    error_from_response,
)
from .types import (
    DeployRequest,
    Hooks,
    Instance,
    InstanceGroup,
    InstanceGroupMember,
    InstanceGroupRequest,
)

_DEFAULT_BASE_URL = "https://api.heroa.app"
_DEFAULT_TIMEOUT = 30.0


def _user_agent() -> str:
    return f"heroa-sdk-python/{SDK_VERSION}"


def _validate(req: DeployRequest) -> None:
    if not req.template and not req.image:
        raise ValueError("DeployRequest requires template or image")
    if req.template and req.image:
        raise ValueError("DeployRequest must set template or image, not both")
    if not req.region:
        raise ValueError("DeployRequest.region is required")


def _build_wire(app_name: str, req: DeployRequest) -> dict[str, Any]:
    size = req.size or "small"
    shape = SIZE_SHAPES.get(size, SIZE_SHAPES["small"])
    cpus = shape["cpus"]
    mem = shape["memory_mb"]
    if req.resources is not None:
        cpus = req.resources.cpus
        mem = req.resources.memory_mb
    isolation = req.isolation or "firecracker"
    # MachineConfig.image carries either a first-party template slug or a
    # fully-qualified OCI reference (oci://...). The control plane
    # discriminates on the "oci://" prefix.
    image_or_template = req.image or req.template
    wire: dict[str, Any] = {
        "name": app_name,
        "region": req.region,
        "config": {
            "env": dict(req.env or {}),
            "guest": {"cpus": cpus, "memory_mb": mem},
            "image": image_or_template,
            "isolation_mode": isolation,
            "metadata": dict(req.metadata or {}),
            "mounts": [],
        },
    }
    if req.ttl:
        wire["ttl"] = req.ttl
    if req.restart_policy:
        wire["restart_policy"] = req.restart_policy
    if req.files:
        wire["files"] = [asdict(f) for f in req.files]
    if req.region_policy:
        wire["region_policy"] = req.region_policy
    if req.metadata:
        wire["metadata"] = dict(req.metadata)
    if req.egress_policy:
        wire["egress_policy"] = req.egress_policy
    if req.allowed_domains:
        wire["allowed_domains"] = list(req.allowed_domains)
    if req.ingress:
        wire["ingress"] = [
            {k: v for k, v in [
                ("port", p.port), ("public", p.public),
                ("expose_path", p.expose_path),
            ] if v or k in ("port", "public")}
            for p in req.ingress
        ]
    return wire


def _classify_size(cpus: int, mem_mb: int) -> str:
    if cpus <= 1 and mem_mb <= 256:
        return "nano"
    if cpus <= 1 and mem_mb <= 512:
        return "small"
    if cpus <= 2 and mem_mb <= 2048:
        return "medium"
    if cpus <= 4 and mem_mb <= 8192:
        return "large"
    return "xl"


def _instance_from_wire(m: dict[str, Any]) -> Instance:
    config = m.get("config") or {}
    guest = config.get("guest") or {}
    meta = config.get("metadata") or {}
    cpus = int(guest.get("cpus") or 0)
    mem = int(guest.get("memory_mb") or 0)
    url = m.get("url") or (
        f"https://{m['generated_hostname']}" if m.get("generated_hostname") else ""
    )
    hostnames = m.get("hostnames") or (
        [m["generated_hostname"]] if m.get("generated_hostname") else []
    )
    expires_at = m.get("expires_at")
    return Instance(
        id=m.get("id", ""),
        url=url,
        hostnames=tuple(hostnames),
        region=m.get("region", ""),
        size=_classify_size(cpus, mem),
        expires_at=expires_at if expires_at else None,
        created_at=m.get("created_at", ""),
        state=m.get("state") or m.get("observed_state") or "",
        metadata=dict(meta) if isinstance(meta, dict) else {},
    )


def _build_headers(api_key: str, idem_key: str | None) -> dict[str, str]:
    h = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": _user_agent(),
    }
    if idem_key is not None:
        h["Idempotency-Key"] = idem_key
    return h


def _response_to_error(resp: httpx.Response) -> HeroaError:
    try:
        parsed = resp.json()
    except ValueError as _json_err:
        del _json_err
        return InternalError(
            resp.status_code,
            ControlPlaneErrorBody(
                code="internal",
                message=f"non-JSON error response (status {resp.status_code})",
            ),
        )
    if not isinstance(parsed, dict) or "code" not in parsed or "message" not in parsed:
        return InternalError(
            resp.status_code,
            ControlPlaneErrorBody(
                code="internal",
                message=f"unrecognized error body (status {resp.status_code})",
            ),
        )
    return error_from_response(
        resp.status_code,
        ControlPlaneErrorBody(
            code=str(parsed["code"]),
            message=str(parsed["message"]),
            request_id=parsed.get("request_id"),
            details=parsed.get("details"),
        ),
    )


def _build_group_wire(req: InstanceGroupRequest) -> dict[str, Any]:
    """Convert an InstanceGroupRequest to the control-plane on-wire shape."""
    size = req.size or "small"
    shape = SIZE_SHAPES.get(size, SIZE_SHAPES["small"])
    cpus = req.resources.cpus if req.resources else shape["cpus"]
    mem_mb = req.resources.memory_mb if req.resources else shape["memory_mb"]
    wire: dict[str, Any] = {
        "regions": list(req.regions),
        "template": req.template,
        "guest_cpus": cpus,
        "guest_mem_mb": mem_mb,
        "routing_mode": req.routing_mode or "dns-latency",
        "region_policy": req.region_policy or "strict",
    }
    if req.ttl:
        wire["ttl"] = req.ttl
    return wire


def _instance_group_from_wire(data: dict[str, Any]) -> InstanceGroup:
    """Map a control-plane instance group response to the public InstanceGroup type."""
    members = [
        InstanceGroupMember(
            region=m.get("region", ""),
            fleet_member_id=m.get("fleet_member_id", ""),
            host_id=m.get("host_id", ""),
            url=m.get("url", ""),
            status=m.get("status", ""),
        )
        for m in data.get("instances") or []
    ]
    return InstanceGroup(
        id=data.get("id", ""),
        app_id=data.get("app_id", ""),
        regions=data.get("regions") or [],
        routing_mode=data.get("routing_mode", ""),
        anycast_url=data.get("anycast_url") or "",
        status=data.get("status", ""),
        instances=members,
        urls=data.get("urls") or {},
    )


class Heroa:
    """Synchronous Heroa SDK client."""

    def __init__(
        self,
        api_key: str,
        base_url: str = _DEFAULT_BASE_URL,
        *,
        default_app_name: str = "heroa-sdk",
        timeout: float = _DEFAULT_TIMEOUT,
        http: httpx.Client | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._default_app_name = default_app_name
        self._http = http or httpx.Client(timeout=timeout)
        self._owns_http = http is None

    def close(self) -> None:
        if self._owns_http:
            self._http.close()

    def __enter__(self) -> Heroa:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def deploy(self, request: DeployRequest) -> Instance:
        _validate(request)
        hooks = request.lifecycle
        try:
            app_name = request.app_name or self._default_app_name
            app = self._ensure_app(app_name, request.app_region_pin)
            # The control plane routes /v1/apps/{app}/... by the app's
            # server-assigned id (e.g., "app-9b60cf050d28d8c4"), not by
            # name. Using the name returns 404 against a real control
            # plane. ensure_app returns the canonical id; we use it for
            # the create-machine path.
            app_id = str(app.get("id") or app_name)
            wire = _build_wire(app_name, request)
            idem_key = request.idempotency_key or canonical_sha256(wire)
            machine = self._create_machine(app_id, wire, idem_key)
            instance = _instance_from_wire(machine)
        except BaseException as exc:
            _run_hook_sync(hooks, "on_error", exc)
            raise
        _run_hook_sync(hooks, "on_ready", instance)
        return instance

    def stop(self, app_name: str, instance_id: str) -> None:
        """Destroy an instance. Issues DELETE /v1/apps/{app}/machines/{id}.

        Returns None on success (200 or 204). Raises HeroaError on any
        control-plane failure.

        ``app_name`` is resolved to an app id via the idempotent
        ``POST /v1/apps`` because the control plane routes
        ``/v1/apps/{app}/...`` by id, not by name.
        """
        if not app_name:
            raise ValueError("app_name is required")
        if not instance_id:
            raise ValueError("instance_id is required")
        app = self._ensure_app(app_name)
        app_id = str(app.get("id") or app_name)
        resp = self._http.request(
            "DELETE",
            f"{self._base_url}/v1/apps/{app_id}/machines/{instance_id}",
            headers=_build_headers(self._api_key, None),
        )
        if resp.status_code in (200, 204):
            return
        raise _response_to_error(resp)

    def deploy_group(self, request: InstanceGroupRequest) -> InstanceGroup:
        """Create a multi-region instance group (H12-4).

        Returns an InstanceGroup on success. Raises HeroaError on failure.
        regions must contain at least 2 valid region identifiers.
        """
        if not request.template:
            raise ValueError("InstanceGroupRequest.template is required")
        if len(request.regions) < 2:
            raise ValueError("InstanceGroupRequest.regions must contain at least 2 entries")
        app_name = request.app_name or self._default_app_name
        self._ensure_app(app_name, request.app_region_pin)
        wire = _build_group_wire(request)
        resp = self._http.post(
            f"{self._base_url}/v1/apps/{app_name}/instance-groups",
            headers=_build_headers(self._api_key, None),
            content=canonical_json(wire).encode("utf-8"),
        )
        if resp.status_code not in (200, 201):
            raise _response_to_error(resp)
        return _instance_group_from_wire(resp.json())

    def _ensure_app(self, app_name: str, region_pin: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"app_name": app_name, "org_slug": ""}
        if region_pin:
            body["region_pin"] = region_pin
        resp = self._http.post(
            self._base_url + "/v1/apps",
            headers=_build_headers(self._api_key, None),
            content=canonical_json(body).encode("utf-8"),
        )
        if resp.status_code not in (200, 201):
            raise _response_to_error(resp)
        return dict(resp.json())

    def _create_machine(
        self,
        app_name: str,
        wire: dict[str, Any],
        idem_key: str,
    ) -> dict[str, Any]:
        resp = self._http.post(
            f"{self._base_url}/v1/apps/{app_name}/machines",
            headers=_build_headers(self._api_key, idem_key),
            content=canonical_json(wire).encode("utf-8"),
        )
        if resp.status_code not in (200, 201):
            raise _response_to_error(resp)
        return dict(resp.json())


class AsyncHeroa:
    """Asynchronous Heroa SDK client — same contract as ``Heroa``."""

    def __init__(
        self,
        api_key: str,
        base_url: str = _DEFAULT_BASE_URL,
        *,
        default_app_name: str = "heroa-sdk",
        timeout: float = _DEFAULT_TIMEOUT,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._default_app_name = default_app_name
        self._http = http or httpx.AsyncClient(timeout=timeout)
        self._owns_http = http is None

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncHeroa:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def deploy(self, request: DeployRequest) -> Instance:
        _validate(request)
        hooks = request.lifecycle
        try:
            app_name = request.app_name or self._default_app_name
            app = await self._ensure_app(app_name, request.app_region_pin)
            # Route by server-assigned app id; see Heroa.deploy() for rationale.
            app_id = str(app.get("id") or app_name)
            wire = _build_wire(app_name, request)
            idem_key = request.idempotency_key or canonical_sha256(wire)
            machine = await self._create_machine(app_id, wire, idem_key)
            instance = _instance_from_wire(machine)
        except BaseException as exc:
            await _run_hook_async(hooks, "on_error", exc)
            raise
        await _run_hook_async(hooks, "on_ready", instance)
        return instance

    async def stop(self, app_name: str, instance_id: str) -> None:
        """Destroy an instance. Issues DELETE /v1/apps/{app}/machines/{id}.

        Returns None on success (200 or 204). Raises HeroaError on any
        control-plane failure. See ``Heroa.stop`` for the app-id
        resolution rationale.
        """
        if not app_name:
            raise ValueError("app_name is required")
        if not instance_id:
            raise ValueError("instance_id is required")
        app = await self._ensure_app(app_name)
        app_id = str(app.get("id") or app_name)
        resp = await self._http.request(
            "DELETE",
            f"{self._base_url}/v1/apps/{app_id}/machines/{instance_id}",
            headers=_build_headers(self._api_key, None),
        )
        if resp.status_code in (200, 204):
            return
        raise _response_to_error(resp)

    async def deploy_group(self, request: InstanceGroupRequest) -> InstanceGroup:
        """Create a multi-region instance group (H12-4). Async variant.

        Returns an InstanceGroup on success. Raises HeroaError on failure.
        regions must contain at least 2 valid region identifiers.
        """
        if not request.template:
            raise ValueError("InstanceGroupRequest.template is required")
        if len(request.regions) < 2:
            raise ValueError("InstanceGroupRequest.regions must contain at least 2 entries")
        app_name = request.app_name or self._default_app_name
        await self._ensure_app(app_name, request.app_region_pin)
        wire = _build_group_wire(request)
        resp = await self._http.post(
            f"{self._base_url}/v1/apps/{app_name}/instance-groups",
            headers=_build_headers(self._api_key, None),
            content=canonical_json(wire).encode("utf-8"),
        )
        if resp.status_code not in (200, 201):
            raise _response_to_error(resp)
        return _instance_group_from_wire(resp.json())

    async def _ensure_app(self, app_name: str, region_pin: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"app_name": app_name, "org_slug": ""}
        if region_pin:
            body["region_pin"] = region_pin
        resp = await self._http.post(
            self._base_url + "/v1/apps",
            headers=_build_headers(self._api_key, None),
            content=canonical_json(body).encode("utf-8"),
        )
        if resp.status_code not in (200, 201):
            raise _response_to_error(resp)
        return dict(resp.json())

    async def _create_machine(
        self,
        app_name: str,
        wire: dict[str, Any],
        idem_key: str,
    ) -> dict[str, Any]:
        resp = await self._http.post(
            f"{self._base_url}/v1/apps/{app_name}/machines",
            headers=_build_headers(self._api_key, idem_key),
            content=canonical_json(wire).encode("utf-8"),
        )
        if resp.status_code not in (200, 201):
            raise _response_to_error(resp)
        return dict(resp.json())


def _run_hook_sync(hooks: Hooks, name: str, arg: Any) -> None:
    """Invoke a lifecycle hook from the sync client.

    Async hooks are run to completion via asyncio.run; sync hooks are
    called directly. A raised exception is converted into an on_error
    invocation with a LifecycleHookError wrapper.
    """
    cb = getattr(hooks, name, None)
    if cb is None:
        return
    try:
        result = cb(arg)
        if inspect.isawaitable(result):
            asyncio.run(_await(result))
    except BaseException as exc:
        if name == "on_error":
            # on_error itself raised — nothing further to do.
            return
        on_err = hooks.on_error
        if on_err is None:
            return
        wrapped = LifecycleHookError(hook=name, cause=exc)
        try:
            r = on_err(wrapped)
            if inspect.isawaitable(r):
                asyncio.run(_await(r))
        except BaseException as _nested:
            # on_error ALSO raised; swallow to keep hooks isolated.
            del _nested
            return


async def _run_hook_async(hooks: Hooks, name: str, arg: Any) -> None:
    """Async counterpart of _run_hook_sync. Awaits async callbacks
    directly; sync callbacks are called inline."""
    cb = getattr(hooks, name, None)
    if cb is None:
        return
    try:
        result = cb(arg)
        if inspect.isawaitable(result):
            await result
    except BaseException as exc:
        if name == "on_error":
            return
        on_err = hooks.on_error
        if on_err is None:
            return
        wrapped = LifecycleHookError(hook=name, cause=exc)
        try:
            r = on_err(wrapped)
            if inspect.isawaitable(r):
                await r
        except BaseException as _nested_async:
            del _nested_async
            return


async def _await(awaitable: Any) -> Any:
    return await awaitable
