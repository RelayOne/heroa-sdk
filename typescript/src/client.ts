// @heroa/sdk — Heroa client + deploy() primitive.
//
// This is the entry point an in-flight agent reaches for. Construct a Heroa
// with { apiKey, baseUrl? } and call heroa.deploy(args) — the call:
//   1. canonicalizes args -> auto Idempotency-Key (unless caller-provided)
//   2. POST /v1/apps  (ensure-app-exists, idempotent on (tenant, name))
//   3. POST /v1/apps/:app/machines  (the actual deploy)
//   4. maps the response to an Instance; invokes lifecycle.onReady if healthy
//
// HTTP uses the global fetch() (Node 18+). Retries 5xx once with exponential
// backoff per scope §5. Errors surface as typed HeroaError subclasses.

import { canonicalJSON, canonicalSha256 } from "./canonical.js";
import {
  SDK_VERSION,
  SIZE_SHAPES,
  type Region,
  type Size,
} from "./constants.js";
import {
  errorFromResponse,
  HeroaError,
  InternalError,
  LifecycleHookError,
} from "./errors.js";
import type {
  AppResponseWire,
  CreateAppRequestWire,
  CreateInstanceGroupRequestWire,
  CreateMachineRequestWire,
  DeployRequest,
  Instance,
  InstanceGroup,
  InstanceGroupRequest,
  InstanceGroupResponseWire,
  LifecycleHooks,
  MachineResponseWire,
} from "./types.js";

/** Constructor config. */
export interface HeroaConfig {
  apiKey: string;
  baseUrl?: string;
  /** Default app name when DeployRequest omits appName. */
  defaultAppName?: string;
  /** Used for tests to inject a fake fetch. */
  fetch?: typeof fetch;
  /** Max number of 5xx retry attempts beyond the first call. Default 1. */
  maxRetries?: number;
}

export class Heroa {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultAppName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;

  constructor(cfg: HeroaConfig) {
    if (!cfg.apiKey) {
      throw new Error("HeroaConfig.apiKey is required");
    }
    this.apiKey = cfg.apiKey;
    this.baseUrl = (cfg.baseUrl ?? "https://api.heroa.app").replace(/\/$/, "");
    this.defaultAppName = cfg.defaultAppName ?? "heroa-sdk";
    this.fetchImpl = cfg.fetch ?? fetch;
    this.maxRetries = cfg.maxRetries ?? 1;
  }

  /** Deploy a new instance. Returns when the control plane has accepted the
   * request and the placement daemon has confirmed creation. */
  async deploy(req: DeployRequest): Promise<Instance> {
    validateDeployRequest(req);
    const hooks = req.lifecycle ?? {};
    try {
      const appName = req.appName ?? this.defaultAppName;
      const app = await this.ensureApp(appName, req.appRegionPin);
      // The control plane's machine path is keyed on the app's *id* (e.g.,
      // "app-9b60cf050d28d8c4"), not its name. createApp returns the
      // canonical id; we use it for createMachine + downstream lookups.
      const appKey = app.id || appName;
      const wire = requestToWire(req);
      const idemKey = req.idempotencyKey ?? (await canonicalSha256(wire));
      const machine = await this.createMachine(appKey, wire, idemKey);
      const instance = wireToInstance(machine);
      await safeHook(hooks, "onReady", instance);
      return instance;
    } catch (err) {
      await safeHook(hooks, "onError", err);
      throw err;
    }
  }

  /** Destroy an instance. Issues DELETE /v1/apps/{app}/machines/{id}.
   * Returns void on success (200 or 204). Throws HeroaError on failure.
   *
   * appName is resolved to an app id via the idempotent POST /v1/apps because
   * the control plane routes /v1/apps/{app}/... by id, not by name. */
  async stop(appName: string, instanceId: string): Promise<void> {
    if (!appName) throw new Error("appName is required");
    if (!instanceId) throw new Error("instanceId is required");
    const app = await this.ensureApp(appName);
    const appKey = app.id || appName;
    const res = await this.do(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appKey)}/machines/${encodeURIComponent(instanceId)}`,
      {},
    );
    if (res.status === 200 || res.status === 204) {
      return;
    }
    throw await buildError(res);
  }

  // ── Multi-region instance groups (H12-4) ──

  /** Create a multi-region instance group with one instance per supplied region.
   * regions must contain at least 2 valid region identifiers.
   * Returns an InstanceGroup on success; throws HeroaError on failure. */
  async deployGroup(req: InstanceGroupRequest): Promise<InstanceGroup> {
    if (!req.template) throw new Error("InstanceGroupRequest.template is required");
    if (!req.regions || req.regions.length < 2) {
      throw new Error("InstanceGroupRequest.regions must contain at least 2 entries");
    }

    const appName = req.appName ?? this["defaultAppName"];
    await this.ensureApp(appName, req.appRegionPin);

    const size = req.size ?? "small";
    const shape = SIZE_SHAPES[size] ?? SIZE_SHAPES["small"];
    const cpus = req.resources?.cpus ?? shape.cpus;
    const memMb = req.resources?.memoryMb ?? shape.memoryMb;

    const wire: CreateInstanceGroupRequestWire = {
      regions: req.regions,
      template: req.template,
      guest_cpus: cpus,
      guest_mem_mb: memMb,
      ...(req.ttl ? { ttl: req.ttl } : {}),
      routing_mode: req.routingMode ?? "dns-latency",
      region_policy: req.regionPolicy ?? "strict",
    };

    const res = await this.do(
      "POST",
      `/v1/apps/${encodeURIComponent(appName)}/instance-groups`,
      wire,
    );
    if (res.status !== 200 && res.status !== 201) {
      throw await buildError(res);
    }
    const body = (await res.json()) as InstanceGroupResponseWire;
    return wireToInstanceGroup(body);
  }

  /** Destroy a multi-region instance group. */
  async destroyGroup(appName: string, groupId: string): Promise<void> {
    if (!appName) throw new Error("appName is required");
    if (!groupId) throw new Error("groupId is required");
    const res = await this.do(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appName)}/instance-groups/${encodeURIComponent(groupId)}`,
      {},
    );
    if (res.status === 200 || res.status === 204) return;
    throw await buildError(res);
  }

  /** Get the current state of an instance group. */
  async getGroup(appName: string, groupId: string): Promise<InstanceGroup> {
    if (!appName) throw new Error("appName is required");
    if (!groupId) throw new Error("groupId is required");
    const res = await this.do(
      "GET",
      `/v1/apps/${encodeURIComponent(appName)}/instance-groups/${encodeURIComponent(groupId)}`,
      undefined,
    );
    if (res.status !== 200) throw await buildError(res);
    const body = (await res.json()) as { instance_group: InstanceGroupResponseWire };
    return wireToInstanceGroup(body.instance_group);
  }

  // ── End multi-region instance groups ──

  /** Expose the user-agent header value so fixtures + contract tests can
   * assert it without hardcoding. */
  userAgent(): string {
    return `heroa-sdk-ts/${SDK_VERSION}`;
  }

  private async ensureApp(appName: string, regionPin?: string): Promise<AppResponseWire> {
    const body: CreateAppRequestWire = { app_name: appName, org_slug: "" };
    if (regionPin) {
      body.region_pin = regionPin;
    }
    const res = await this.do("POST", "/v1/apps", body);
    // createApp returns 200 with the existing App if it already existed,
    // 201 with the newly-created App otherwise. Either way the body is
    // AppResponseWire.
    if (res.status !== 200 && res.status !== 201) {
      throw await buildError(res);
    }
    return (await res.json()) as AppResponseWire;
  }

  private async createMachine(
    appName: string,
    wire: CreateMachineRequestWire,
    idempotencyKey: string,
  ): Promise<MachineResponseWire> {
    const res = await this.do("POST", `/v1/apps/${encodeURIComponent(appName)}/machines`, wire, {
      "Idempotency-Key": idempotencyKey,
    });
    if (res.status !== 201 && res.status !== 200) {
      throw await buildError(res);
    }
    return (await res.json()) as MachineResponseWire;
  }

  /** do performs the HTTP call, retries on 5xx per maxRetries, and always
   * returns a Response (even on non-2xx). Caller decides what to do. */
  private async do(
    method: string,
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": this.userAgent(),
      ...extraHeaders,
    };
    const payload = canonicalJSON(body);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchImpl(url, { method, headers, body: payload });
        if (res.status >= 500 && attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
      }
    }
    throw new InternalError(0, {
      code: "internal",
      message: `network error calling ${method} ${path}: ${String(lastErr)}`,
    });
  }
}

function backoffMs(attempt: number): number {
  // 100ms, 400ms, ... exponential.
  return 100 * Math.pow(4, attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Map an error HTTP response into the typed HeroaError. */
async function buildError(res: Response): Promise<HeroaError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new InternalError(res.status, {
      code: "internal",
      message: `non-JSON error response (status ${res.status})`,
    });
  }
  if (
    body && typeof body === "object"
    && typeof (body as Record<string, unknown>).code === "string"
    && typeof (body as Record<string, unknown>).message === "string"
  ) {
    const errBody = body as { code: string; message: string; request_id?: string; details?: Record<string, string> };
    return errorFromResponse(res.status, {
      code: errBody.code as never,
      message: errBody.message,
      request_id: errBody.request_id,
      details: errBody.details,
    });
  }
  return new InternalError(res.status, {
    code: "internal",
    message: `unrecognized error body (status ${res.status})`,
  });
}

function validateDeployRequest(req: DeployRequest): void {
  if (!req.template && !req.image) {
    throw new Error("DeployRequest requires template or image");
  }
  if (req.template && req.image) {
    throw new Error("DeployRequest must set template or image, not both");
  }
  if (!req.region) {
    throw new Error("DeployRequest.region is required");
  }
}

/** requestToWire converts a DeployRequest to the control-plane on-wire shape.
 *
 * The wire-level `config.image` field carries either a first-party template
 * slug (e.g., "next-ssr") or a fully-qualified OCI reference
 * (e.g., "oci://docker.io/library/alpine:3.19"). The control plane
 * discriminates on the "oci://" prefix.
 */
export function requestToWire(req: DeployRequest): CreateMachineRequestWire {
  const size: Size = req.size ?? "small";
  const shape = req.resources ?? SIZE_SHAPES[size];
  const imageOrTemplate = req.image ?? req.template ?? "";
  const wire: CreateMachineRequestWire = {
    name: req.appName ?? "",
    region: req.region,
    config: {
      image: imageOrTemplate,
      guest: { cpus: shape.cpus, memory_mb: shape.memoryMb },
      env: req.env ?? {},
      metadata: req.metadata ?? {},
      mounts: [],
      isolation_mode: req.isolation ?? "firecracker",
    },
  };
  if (req.ttl !== undefined && req.ttl !== null) {
    wire.ttl = req.ttl;
  }
  if (req.restartPolicy !== undefined) {
    wire.restart_policy = req.restartPolicy;
  }
  if (req.files !== undefined && req.files.length > 0) {
    wire.files = req.files;
  }
  if (req.regionPolicy !== undefined) {
    wire.region_policy = req.regionPolicy;
  }
  if (req.metadata !== undefined && Object.keys(req.metadata).length > 0) {
    wire.metadata = req.metadata;
  }
  if (req.egressPolicy !== undefined) {
    wire.egress_policy = req.egressPolicy;
  }
  if (req.allowedDomains !== undefined && req.allowedDomains.length > 0) {
    wire.allowed_domains = req.allowedDomains;
  }
  if (req.ingress !== undefined && req.ingress.length > 0) {
    wire.ingress = req.ingress;
  }
  return wire;
}

/** wireToInstance converts a control-plane response into the SDK's Instance. */
export function wireToInstance(m: MachineResponseWire): Instance {
  return {
    id: m.id,
    url: m.url ?? (m.generated_hostname ? `https://${m.generated_hostname}` : ""),
    hostnames: m.hostnames ?? (m.generated_hostname ? [m.generated_hostname] : []),
    region: m.region,
    size: classifySize(m.config.guest.cpus, m.config.guest.memory_mb),
    expiresAt: m.expires_at && m.expires_at !== "" ? m.expires_at : null,
    createdAt: m.created_at,
    state: normalizeState(m.state || m.observed_state),
    metadata: (m.config.metadata ?? {}) as Record<string, string>,
  };
}

function classifySize(cpus: number, memMb: number): string {
  if (cpus <= 1 && memMb <= 256) return "nano";
  if (cpus <= 1 && memMb <= 512) return "small";
  if (cpus <= 2 && memMb <= 2048) return "medium";
  if (cpus <= 4 && memMb <= 8192) return "large";
  return "xl";
}

function normalizeState(s: string): Instance["state"] {
  switch (s) {
    case "running":
    case "starting":
    case "stopped":
    case "failed":
    case "created":
    case "creating":
      return s;
    default:
      return "created";
  }
}

/** Invoke a lifecycle hook without letting it throw out of the SDK. */
async function safeHook<K extends keyof LifecycleHooks>(
  hooks: LifecycleHooks,
  name: K,
  arg: K extends "onError" ? unknown : Instance,
): Promise<void> {
  const fn = hooks[name];
  if (!fn) return;
  try {
    // TypeScript can't narrow the argument through the indexed key; run the
    // cast once at the call boundary.
    await (fn as (a: unknown) => void | Promise<void>)(arg);
  } catch (err) {
    const wrapped = new LifecycleHookError(name as "onReady" | "onStop" | "onError", err);
    if (name === "onError") {
      // onError itself threw. Nothing left to do — swallow so the hook
      // cannot escape deploy(). The wrapped error is already attached to
      // wrapped.cause for any caller who opts into console inspection.
      void wrapped;
      return;
    }
    // Report via onError if defined.
    const onErr = hooks.onError;
    if (onErr) {
      try {
        await onErr(wrapped);
      } catch {
        // onError ALSO threw; stop recursing.
      }
    }
  }
}

/** Maps an InstanceGroupResponseWire to the public InstanceGroup shape. */
function wireToInstanceGroup(wire: InstanceGroupResponseWire): InstanceGroup {
  return {
    id: wire.id,
    appId: wire.app_id,
    regions: wire.regions,
    routingMode: wire.routing_mode,
    anycastUrl: wire.anycast_url ?? "",
    status: wire.status,
    instances: (wire.instances ?? []).map((m) => ({
      region: m.region,
      fleetMemberId: m.fleet_member_id,
      hostId: m.host_id,
      url: m.url,
      status: m.status,
    })),
    urls: wire.urls ?? {},
  };
}

/** Unused but exported for the contract test's use. */
export const _internal = { requestToWire, wireToInstance, wireToInstanceGroup };
