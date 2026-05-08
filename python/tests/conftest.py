"""Shared fixtures for heroa-sdk tests.

Each test that talks to the control plane spins up an in-process httpx
MockTransport that records every request and dispatches to a handler
the test supplies. This is the Python analogue of the TS SDK's
httptest.NewServer + the Go SDK's httptest.NewServer fixtures — all
three SDKs assert the same {request, response} contract.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest


@dataclass
class RecordedRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: str


@dataclass
class ControlPlaneFake:
    """Records every request + dispatches to a handler."""

    handler: Callable[[httpx.Request], httpx.Response]
    recorded: list[RecordedRequest] = field(default_factory=list)

    def _wrap(self, request: httpx.Request) -> httpx.Response:
        self.recorded.append(
            RecordedRequest(
                method=request.method,
                path=request.url.path,
                headers={k.lower(): v for k, v in request.headers.items()},
                body=request.content.decode("utf-8"),
            )
        )
        return self.handler(request)

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._wrap)

    def async_transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._wrap)


@pytest.fixture()
def make_cp() -> Callable[[Callable[[httpx.Request], httpx.Response]], ControlPlaneFake]:
    def _make(handler: Callable[[httpx.Request], httpx.Response]) -> ControlPlaneFake:
        return ControlPlaneFake(handler=handler)

    return _make


def app_ok(name: str = "demo-preview") -> httpx.Response:
    return httpx.Response(
        201,
        json={
            "id": "app-demo",
            "org_id": "o1",
            "tenant_id": "t1",
            "name": name,
            "status": "active",
            "created_at": "2026-04-24T12:00:00Z",
        },
    )


def machine_ok(
    machine_id: str = "m-h3roa-x4n7",
    region: str = "us-east",
    cpus: int = 1,
    mem_mb: int = 512,
    expires_at: str | None = "2026-04-24T13:00:00Z",
    metadata: dict[str, str] | None = None,
) -> httpx.Response:
    body: dict[str, Any] = {
        "id": machine_id,
        "state": "created",
        "desired_state": "running",
        "observed_state": "created",
        "region": region,
        "ip_address": "10.0.0.42",
        "generated_hostname": f"{machine_id}.heroa.app",
        "url": f"https://{machine_id}.heroa.app",
        "hostnames": [f"{machine_id}.heroa.app"],
        "config": {
            "image": "next-ssr",
            "guest": {"cpus": cpus, "memory_mb": mem_mb},
            "env": {},
            "metadata": metadata or {},
            "mounts": [],
        },
        "created_at": "2026-04-24T12:00:00Z",
        "updated_at": "2026-04-24T12:00:00Z",
    }
    if expires_at:
        body["expires_at"] = expires_at
    return httpx.Response(201, json=body)


def error_response(status: int, code: str, message: str, request_id: str | None = None) -> httpx.Response:
    body: dict[str, Any] = {"code": code, "message": message}
    if request_id:
        body["request_id"] = request_id
    return httpx.Response(status, content=json.dumps(body).encode("utf-8"),
                          headers={"Content-Type": "application/json"})
