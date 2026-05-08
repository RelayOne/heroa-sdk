// End-to-end trace test for heroa.deploy() per scope §5.4.
//
// Spins an in-process httptest-style server using Node's http module,
// records every request the SDK sends, and asserts:
//   1. POST /v1/apps  (ensure-app with correct headers)
//   2. POST /v1/apps/:app/machines  (the deploy; Idempotency-Key set,
//                                    Authorization bearer, canonical body)
//   3. Response maps to a valid Instance with url + expires_at populated.
//   4. onReady hook fires exactly once with the instance.
//   5. Typed errors: bad_region 400 -> ValidationError; sovereign 403 ->
//      RegionNotAllowedError (which is what the control plane maps to).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  Heroa,
  RegionNotAllowedError,
  ValidationError,
  AuthError,
  LifecycleHookError,
} from "./index.js";

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Fixture {
  baseUrl: string;
  recorded: RecordedRequest[];
  close: () => Promise<void>;
}

async function startFakeCP(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<Fixture> {
  const recorded: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      recorded.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: { ...req.headers },
        body,
      });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    recorded,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const CREATED_AT = "2026-04-24T12:00:00Z";
const EXPIRES_AT = "2026-04-24T13:00:00Z";
const MACHINE_ID = "m-h3roa-x4n7";

function writeAppOK(res: http.ServerResponse, name = "demo-preview"): void {
  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id: "app-demo123", org_id: "org-1", tenant_id: "t-1",
    name, status: "active", created_at: CREATED_AT,
  }));
}

test("deploy: happy path hits app + machine endpoints with correct headers and body", async () => {
  assert.equal(MACHINE_ID, "m-h3roa-x4n7");
  assert.equal(CREATED_AT.length, 20);
  const fx = await startFakeCP((req, res) => {
    if (req.method === "POST" && req.url === "/v1/apps") {
      writeAppOK(res);
      return;
    }
    // The SDK now routes machine endpoints by the server-assigned app id
    // (returned by createApp) rather than the human-supplied app name. The
    // fake-CP fixture uses "app-demo123" as the canonical id (see writeAppOK).
    if (req.method === "POST" && req.url === `/v1/apps/app-demo123/machines`) {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: MACHINE_ID, name: "", state: "created",
        desired_state: "running", observed_state: "created",
        region: "us-east", ip_address: "10.0.0.42",
        generated_hostname: `${MACHINE_ID}.heroa.app`,
        config: {
          image: "next-ssr",
          guest: { cpus: 1, memory_mb: 512 },
          env: {}, metadata: { agent_id: "r1-abc" }, mounts: [],
        },
        created_at: CREATED_AT, updated_at: CREATED_AT,
        expires_at: EXPIRES_AT,
        url: `https://${MACHINE_ID}.heroa.app`,
        hostnames: [`${MACHINE_ID}.heroa.app`],
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "validation", message: "not found" }));
  });

  let readyCalls = 0;
  let readyId = "";
  const heroa = new Heroa({ apiKey: "k-test", baseUrl: fx.baseUrl });
  const instance = await heroa.deploy({
    template: "next-ssr",
    region: "us-east",
    appName: "demo-preview",
    size: "small",
    ttl: "1h",
    env: {},
    metadata: { agent_id: "r1-abc" },
    lifecycle: {
      onReady: (i) => { readyCalls++; readyId = i.id; },
    },
  });
  await fx.close();

  assert.equal(instance.id, MACHINE_ID);
  assert.equal(instance.url, `https://${MACHINE_ID}.heroa.app`);
  assert.equal(instance.region, "us-east");
  assert.equal(instance.size, "small");
  assert.equal(instance.expiresAt, EXPIRES_AT);
  assert.deepEqual(instance.metadata, { agent_id: "r1-abc" });
  assert.equal(readyCalls, 1);
  assert.equal(readyId, MACHINE_ID);

  assert.equal(fx.recorded.length, 2);
  assert.equal(fx.recorded[0].method, "POST");
  assert.equal(fx.recorded[0].path, "/v1/apps");
  assert.equal(fx.recorded[0].headers["authorization"], "Bearer k-test");
  assert.match(String(fx.recorded[0].headers["user-agent"] ?? ""), /^heroa-sdk-ts\//);
  const appBody = JSON.parse(fx.recorded[0].body);
  assert.equal(appBody.app_name, "demo-preview");

  assert.equal(fx.recorded[1].method, "POST");
  assert.equal(fx.recorded[1].path, "/v1/apps/app-demo123/machines");
  assert.equal(fx.recorded[1].headers["authorization"], "Bearer k-test");
  assert.match(String(fx.recorded[1].headers["idempotency-key"] ?? ""), /^[0-9a-f]{64}$/);
  const mBody = JSON.parse(fx.recorded[1].body);
  assert.equal(mBody.region, "us-east");
  assert.equal(mBody.config.image, "next-ssr");
  assert.equal(mBody.config.guest.cpus, 1);
  assert.equal(mBody.config.guest.memory_mb, 512);
  assert.equal(mBody.ttl, "1h");
});

test("deploy: appRegionPin is sent during ensure-app", async () => {
  const fx = await startFakeCP((req, res) => {
    if (req.method === "POST" && req.url === "/v1/apps") {
      writeAppOK(res, "pinned-app");
      return;
    }
    if (req.method === "POST" && req.url === "/v1/apps/app-demo123/machines") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: MACHINE_ID, name: "", state: "created",
        desired_state: "running", observed_state: "created",
        region: "us-east",
        config: {
          image: "next-ssr",
          guest: { cpus: 1, memory_mb: 512 },
          env: {}, metadata: {}, mounts: [],
        },
        created_at: CREATED_AT, updated_at: CREATED_AT,
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "validation", message: "not found" }));
  });

  const heroa = new Heroa({ apiKey: "k-test", baseUrl: fx.baseUrl });
  await heroa.deploy({
    template: "next-ssr",
    region: "us-east",
    appName: "pinned-app",
    appRegionPin: "us-east",
  });
  await fx.close();

  const appBody = JSON.parse(fx.recorded[0].body);
  assert.equal(appBody.region_pin, "us-east");
});

test("deploy: 400 validation maps to ValidationError", async () => {
  const fx = await startFakeCP((req, res) => {
    if (req.url === "/v1/apps") {
      writeAppOK(res);
      return;
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "validation", message: "invalid region: bogus" }));
  });
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  await assert.rejects(
    () => heroa.deploy({ template: "t", region: "bogus" as never, appName: "demo" }),
    (err: unknown) => err instanceof ValidationError && err.code === "validation",
  );
  await fx.close();
});

test("deploy: 403 region_not_allowed maps to RegionNotAllowedError", async () => {
  assert.equal(typeof RegionNotAllowedError, "function");
  const fx = await startFakeCP((req, res) => {
    if (req.url === "/v1/apps") { writeAppOK(res); return; }
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      code: "region_not_allowed",
      message: "sovereign_not_authorized: tenant not opted in",
      request_id: "req-abc",
    }));
  });
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  let captured: RegionNotAllowedError | null = null;
  try {
    await heroa.deploy({ template: "t", region: "bc-sovereign", appName: "demo" });
  } catch (err) {
    if (err instanceof RegionNotAllowedError) captured = err;
  }
  await fx.close();
  assert.ok(captured, "expected RegionNotAllowedError");
  assert.equal(captured!.status, 403);
  assert.equal(captured!.requestId, "req-abc");
});

test("deploy: 401 auth maps to AuthError", async () => {
  const fx = await startFakeCP((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "auth", message: "bad key" }));
  });
  const heroa = new Heroa({ apiKey: "bad", baseUrl: fx.baseUrl });
  await assert.rejects(
    () => heroa.deploy({ template: "t", region: "us-east", appName: "demo" }),
    (err: unknown) => err instanceof AuthError,
  );
  await fx.close();
});

test("deploy: onError fires when a lifecycle hook throws and deploy() returns normally", async () => {
  assert.equal(typeof LifecycleHookError, "function");
  const fx = await startFakeCP((req, res) => {
    if (req.url === "/v1/apps") { writeAppOK(res, "demo"); return; }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "m-1", name: "", state: "created",
      desired_state: "running", observed_state: "created",
      region: "us-east",
      config: { image: "t", guest: { cpus: 1, memory_mb: 512 }, env: {}, metadata: {}, mounts: [] },
      created_at: CREATED_AT, updated_at: CREATED_AT,
      url: "https://m-1.heroa.app",
    }));
  });
  let caught: unknown = null;
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  const instance = await heroa.deploy({
    template: "t", region: "us-east", appName: "demo",
    lifecycle: {
      onReady: () => { throw new Error("boom"); },
      onError: (err) => { caught = err; },
    },
  });
  await fx.close();
  assert.equal(instance.id, "m-1");
  assert.ok(caught instanceof LifecycleHookError);
  assert.equal((caught as LifecycleHookError).hook, "onReady");
});

test("deploy: same args -> same auto-derived Idempotency-Key", async () => {
  assert.equal(typeof Heroa, "function");
  const keys: string[] = [];
  const fx = await startFakeCP((req, res) => {
    if (req.url === "/v1/apps") { writeAppOK(res, "demo"); return; }
    const k = String(req.headers["idempotency-key"] ?? "");
    keys.push(k);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "m-1", name: "", state: "created",
      desired_state: "running", observed_state: "created",
      region: "us-east",
      config: { image: "t", guest: { cpus: 1, memory_mb: 512 }, env: {}, metadata: {}, mounts: [] },
      created_at: CREATED_AT, updated_at: CREATED_AT,
    }));
  });
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  const args = { template: "t", region: "us-east" as const, appName: "demo" };
  await heroa.deploy({ ...args });
  await heroa.deploy({ ...args });
  await fx.close();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], /^[0-9a-f]{64}$/);
});

// ── H12-4: deployGroup() ──

// ── H12-4: deployGroup() ──

// groupFakeResponse is the control-plane response for a successful createGroup call.
const groupFakeResponse = {
  id: "ig-test-1", app_id: "app-demo",
  regions: ["us-east", "eu-west"], routing_mode: "dns-latency",
  anycast_url: "", status: "healthy",
  instances: [
    { region: "us-east", fleet_member_id: "fm_1", host_id: "h1",
      url: "https://us-east.heroa.app", status: "starting" },
    { region: "eu-west", fleet_member_id: "fm_2", host_id: "h2",
      url: "https://eu-west.heroa.app", status: "starting" },
  ],
  urls: { "us-east": "https://us-east.heroa.app", "eu-west": "https://eu-west.heroa.app" },
};

test("deployGroup() returns InstanceGroup with correct id", async () => {
  const fx = await startFakeCP((req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/v1/apps") { writeAppOK(res, "demo"); return; }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(groupFakeResponse));
  });
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  const ig = await heroa.deployGroup({ template: "next-ssr", regions: ["us-east", "eu-west"], appName: "demo" });
  assert.equal(ig.id, "ig-test-1");
  await fx.close();
});

test("deployGroup() instances array has one entry per region", async () => {
  const fx = await startFakeCP((req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/v1/apps") { writeAppOK(res, "demo"); return; }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(groupFakeResponse));
  });
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  const ig = await heroa.deployGroup({ template: "t", regions: ["us-east", "eu-west"], appName: "demo" });
  assert.equal(ig.instances.length, 2);
  await fx.close();
});

test("deployGroup() urls map is populated by region", async () => {
  const fx = await startFakeCP((req: http.IncomingMessage, res: http.ServerResponse) => {
    if (req.url === "/v1/apps") { writeAppOK(res, "demo"); return; }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(groupFakeResponse));
  });
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  const ig = await heroa.deployGroup({ template: "t", regions: ["us-east", "eu-west"], appName: "demo" });
  assert.ok(ig.urls["us-east"] !== "");
  await fx.close();
});

test("deployGroup() throws when regions.length < 2", async () => {
  const heroa = new Heroa({ apiKey: "k", baseUrl: "http://localhost:1" });
  await assert.rejects(
    () => heroa.deployGroup({ template: "t", regions: ["us-east"], appName: "demo" }),
    /at least 2/,
  );
});

test("deployGroup() throws when template is missing (runtime check)", async () => {
  const heroa = new Heroa({ apiKey: "k", baseUrl: "http://localhost:1" });
  const noTemplate = { regions: ["us-east", "eu-west"], appName: "demo" } as unknown as Parameters<typeof heroa.deployGroup>[0];
  await assert.rejects(() => heroa.deployGroup(noTemplate), /template is required/i);
});

// ── Network policy (egress/ingress) contract tests ──

import { requestToWire } from "./client.js";

test("requestToWire: egress_policy=canadian-only forwarded to wire", () => {
  const wire = requestToWire({ template: "next-ssr", region: "us-east", egressPolicy: "canadian-only" });
  // assert.egress-canadian-only-on-wire
  assert.equal(wire.egress_policy, "canadian-only");
  assert.equal(wire.allowed_domains, undefined);
});

test("requestToWire: egress_policy=allowed-domains with domains forwarded", () => {
  const wire = requestToWire({
    template: "next-ssr",
    region: "us-east",
    egressPolicy: "allowed-domains",
    allowedDomains: ["github.com", "pypi.org"],
  });
  // assert.egress-allowed-domains-on-wire
  assert.equal(wire.egress_policy, "allowed-domains");
  assert.deepEqual(wire.allowed_domains, ["github.com", "pypi.org"]);
});

test("requestToWire: no egress policy omits egress fields", () => {
  const wire = requestToWire({ template: "next-ssr", region: "us-east" });
  // assert.egress-omitted-when-unset
  assert.equal(wire.egress_policy, undefined);
  assert.equal(wire.allowed_domains, undefined);
});

test("requestToWire: public ingress port forwarded to wire", () => {
  const wire = requestToWire({
    template: "next-ssr",
    region: "us-east",
    ingress: [{ port: 8080, public: true }],
  });
  // assert.public-ingress-on-wire
  assert.ok(Array.isArray(wire.ingress));
  assert.equal(wire.ingress![0].port, 8080);
  assert.equal(wire.ingress![0].public, true);
});

test("requestToWire: internal ingress port (public=false) forwarded to wire", () => {
  const wire = requestToWire({
    template: "next-ssr",
    region: "us-east",
    ingress: [{ port: 3000, public: false }],
  });
  // assert.internal-ingress-on-wire
  assert.equal(wire.ingress![0].public, false);
  assert.equal(wire.ingress![0].port, 3000);
});

test("requestToWire: empty ingress array omits ingress field", () => {
  const wire = requestToWire({ template: "next-ssr", region: "us-east", ingress: [] });
  // assert.empty-ingress-omitted
  assert.equal(wire.ingress, undefined);
});

test("deploy: egress_policy=canadian-only is sent to control plane", async () => {
  const fx = await startFakeCP((req, res) => {
    if (req.url === "/v1/apps") { writeAppOK(res, "demo"); return; }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "m-1", name: "", state: "created", desired_state: "running",
      observed_state: "created", region: "us-east",
      config: { image: "t", guest: { cpus: 1, memory_mb: 512 }, env: {}, metadata: {}, mounts: [] },
      created_at: CREATED_AT, updated_at: CREATED_AT,
    }));
  });
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  await heroa.deploy({ template: "t", region: "us-east", appName: "demo", egressPolicy: "canadian-only" });
  await fx.close();
  const machineBody = JSON.parse(fx.recorded[1].body);
  // assert.egress-canadian-only-in-request-body
  assert.equal(machineBody.egress_policy, "canadian-only");
});

test("deploy: egress_policy=allowed-domains with domains sent to control plane", async () => {
  const fx = await startFakeCP((req, res) => {
    if (req.url === "/v1/apps") { writeAppOK(res, "demo"); return; }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "m-2", name: "", state: "created", desired_state: "running",
      observed_state: "created", region: "us-east",
      config: { image: "t", guest: { cpus: 1, memory_mb: 512 }, env: {}, metadata: {}, mounts: [] },
      created_at: CREATED_AT, updated_at: CREATED_AT,
    }));
  });
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  await heroa.deploy({
    template: "t", region: "us-east", appName: "demo",
    egressPolicy: "allowed-domains",
    allowedDomains: ["api.github.com"],
  });
  await fx.close();
  const machineBody = JSON.parse(fx.recorded[1].body);
  // assert.egress-allowed-domains-in-request-body
  assert.equal(machineBody.egress_policy, "allowed-domains");
  assert.deepEqual(machineBody.allowed_domains, ["api.github.com"]);
});

test("deploy: public ingress port sent to control plane", async () => {
  const fx = await startFakeCP((req, res) => {
    if (req.url === "/v1/apps") { writeAppOK(res, "demo"); return; }
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "m-3", name: "", state: "created", desired_state: "running",
      observed_state: "created", region: "us-east",
      config: { image: "t", guest: { cpus: 1, memory_mb: 512 }, env: {}, metadata: {}, mounts: [] },
      created_at: CREATED_AT, updated_at: CREATED_AT,
    }));
  });
  const heroa = new Heroa({ apiKey: "k", baseUrl: fx.baseUrl });
  await heroa.deploy({
    template: "t", region: "us-east", appName: "demo",
    ingress: [{ port: 8080, public: true }],
  });
  await fx.close();
  const machineBody = JSON.parse(fx.recorded[1].body);
  // assert.public-ingress-in-request-body
  assert.ok(Array.isArray(machineBody.ingress));
  assert.equal(machineBody.ingress[0].port, 8080);
  assert.equal(machineBody.ingress[0].public, true);
});
