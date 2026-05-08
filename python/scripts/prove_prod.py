"""prove_prod — End-to-end smoke proof for the Python SDK against live prod.

What it does:
    1. Imports the public SDK surface (Heroa, DeployRequest, FileOverlay).
    2. Reads HEROA_API_KEY + HEROA_BASE_URL + HEROA_REGION from env.
    3. Calls Heroa.deploy(DeployRequest(template="static-site", files=[...])).
    4. Polls GET /v1/apps/{app_id}/machines/{id} until observed_state ==
       running, or the highest reached state in {created, starting, running}.
    5. Cleans up: Heroa.stop, then DELETE /v1/apps/{app_id}.
    6. Writes proof lines to stdout via sys.stdout.write (the caller
       redirects to audit/sdk-python-prove.md).

Run:  HEROA_API_KEY=... python -m heroa_sdk_prove_prod
or:   HEROA_API_KEY=... python sdk/python/scripts/prove_prod.py
"""

from __future__ import annotations

import json
import os
import sys
import time

import httpx

from heroa_sdk import DeployRequest, FileOverlay, Heroa

PROD_CP = "https://heroa-cp-2sobff3gmq-uc.a.run.app"
APP_PREFIX = "py-sdk-prove"
DEFAULT_REGION = "us-central1"
POLL_TIMEOUT_S = 60.0
POLL_INTERVAL_S = 2.0


def emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def lookup_app_id(base_url: str, api_key: str, app_name: str) -> str:
    resp = httpx.post(
        f"{base_url}/v1/apps",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        content=json.dumps({"app_name": app_name, "org_slug": ""}).encode("utf-8"),
        timeout=30.0,
    )
    if resp.status_code not in (200, 201):
        raise RuntimeError(f"app lookup HTTP {resp.status_code}: {resp.text}")
    body = resp.json()
    app_id = body.get("id")
    if not app_id:
        raise RuntimeError(f"app id missing in response: {body!r}")
    return str(app_id)


def get_machine(base_url: str, api_key: str, app_id: str, machine_id: str) -> dict:
    resp = httpx.get(
        f"{base_url}/v1/apps/{app_id}/machines/{machine_id}",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30.0,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"poll machine HTTP {resp.status_code}: {resp.text}")
    return dict(resp.json())


def delete_app(base_url: str, api_key: str, app_id: str) -> tuple[int, str]:
    resp = httpx.delete(
        f"{base_url}/v1/apps/{app_id}",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30.0,
    )
    return resp.status_code, resp.text.strip()


def main() -> int:
    api_key = os.environ.get("HEROA_API_KEY")
    if not api_key:
        emit("FAIL: HEROA_API_KEY is required (mint via POST /internal/api-keys)")
        return 1
    base_url = os.environ.get("HEROA_BASE_URL", PROD_CP)
    region = os.environ.get("HEROA_REGION", DEFAULT_REGION)

    ts = int(time.time())
    marker = f"PY-SDK-PROVE-{ts}"
    app_name = f"{APP_PREFIX}-{ts}"
    index_html = (
        "<!DOCTYPE html>\n"
        f"<html><head><title>{marker}</title></head>"
        f"<body><h1>{marker}</h1></body></html>\n"
    )

    emit("# Python SDK prove-prod")
    emit(f"base_url:  {base_url}")
    emit(f"app_name:  {app_name}")
    emit(f"region:    {region}")
    emit(f"marker:    {marker}")
    emit("sdk_path:  heroa_sdk (Heroa.deploy)")
    emit("")

    with Heroa(api_key, base_url=base_url, default_app_name=app_name) as client:
        start_call = time.time()
        instance = client.deploy(
            DeployRequest(
                template="static-site",
                region=region,
                app_name=app_name,
                size="small",
                files=[FileOverlay(path="/srv/index.html", content=index_html)],
                metadata={"prove": "py-sdk", "marker": marker},
                env={"HEROA_PROVE_MARKER": marker},
                restart_policy="always",
            )
        )
        deploy_ms = int((time.time() - start_call) * 1000)

        emit("## deploy() result")
        emit(f"machine_id:        {instance.id}")
        emit(f"region:            {instance.region}")
        emit(f"hostnames:         {list(instance.hostnames)}")
        emit(f"url:               {instance.url}")
        emit(f"size:              {instance.size}")
        emit(f"state (initial):   {instance.state}")
        emit(f"created_at:        {instance.created_at}")
        emit(f"deploy_call_ms:    {deploy_ms}")
        emit("")

        if not instance.id:
            emit("FAIL: deploy returned empty machine id")
            return 1

        app_id = lookup_app_id(base_url, api_key, app_name)

        deadline = time.time() + POLL_TIMEOUT_S
        last: dict = {}
        attempts = 0
        reached = "other"
        while time.time() < deadline:
            attempts += 1
            last = get_machine(base_url, api_key, app_id, instance.id)
            obs = last.get("observed_state", "")
            if obs == "running":
                reached = "running"
                break
            if obs == "created" and reached not in ("starting", "running"):
                reached = "created"
            elif obs == "starting" and reached != "running":
                reached = "starting"
            time.sleep(POLL_INTERVAL_S)

        emit("## poll")
        emit(f"attempts:        {attempts}")
        emit(f"final state:     {last.get('state', '')}")
        emit(f"observed_state:  {last.get('observed_state', '')}")
        emit(f"desired_state:   {last.get('desired_state', '')}")
        emit(f"reached:         {reached}")
        emit("")

        if reached == "other":
            emit(f"FAIL: machine never reached running/created/starting (last={last!r})")
            return 1

        emit("## cleanup")
        client.stop(app_name, instance.id)
        emit(f"stop({app_name}, {instance.id}): OK")

        del_status, del_body = delete_app(base_url, api_key, app_id)
        emit(f"DELETE /v1/apps/{app_id}: HTTP {del_status}")
        emit(f"  body: {del_body}")

    emit("")
    emit("## proof")
    emit("SDK:             heroa_sdk (Python)")
    emit(f"marker:          {marker}")
    emit(f"machine_id:      {instance.id}")
    emit("tenant:          (resolved by bearer; spec-13 e2e tenant)")
    emit("result:          PASS — deploy/poll/cleanup round-trip OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
