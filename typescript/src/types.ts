// @heroa/sdk — request + response shapes.
//
// The request shape mirrors scope §5.2. The response shape mirrors scope §5.3.
// The on-wire shapes (CreateMachineRequestWire, MachineResponseWire) carry
// exactly what the control plane emits so the HTTP layer is a pure JSON
// adapter; the domain shapes (DeployRequest, Instance) are the SDK's public
// ergonomic surface.

import type { Region, Size } from "./constants.js";

/** File overlay written into the guest at boot via MMDS. */
export interface FileOverlay {
  path: string;
  content: string;
}

/** Resource override (scope §5.2 `resources` field). */
export interface ResourceShape {
  cpus: number;
  memoryMb: number;
  persistentVolumeGb?: number;
}

/** Lifecycle hooks. onReady fires on successful deploy (observed=running or
 * created); onStop fires when destroy() is called; onError fires on any
 * control-plane failure. Throwing from a hook is captured as a
 * LifecycleHookError passed to onError on the next tick; it never propagates
 * out of the deploy() call or a subsequent Instance method. */
export interface LifecycleHooks {
  onReady?: (instance: Instance) => void | Promise<void>;
  onStop?: (instance: Instance) => void | Promise<void>;
  onError?: (err: unknown) => void | Promise<void>;
}

/** Egress policy controlling outbound network access from inside the VM.
 * Empty string and "allow-all" are equivalent (default unrestricted egress).
 * "allowed-domains" enforces a per-VM iptables OUTPUT chain that only
 * accepts resolved A records from `allowedDomains`; everything else drops.
 * "canadian-only" enforces the canonical Canadian-resident IPv4 allowlist. */
export type EgressPolicy = "allow-all" | "allowed-domains" | "canadian-only" | "";

/** One port exposed on the VM — publicly or on the internal subnet only. */
export interface IngressPort {
  port: number;
  public: boolean;
  expose_path?: string;
}

/** Arguments to heroa.deploy().
 *
 * Spec 06 introduces `image` as an alternative source to `template`. Exactly
 * one of `template` or `image` must be set. `image` takes the form
 * `oci://<registry>/<repo>:<tag>` or `oci://<registry>/<repo>@sha256:<digest>`
 * and resolves through the control-plane OCI pipeline to a Heroa-built rootfs.
 */
export interface DeployRequest {
  /** First-party template slug (e.g., "next-ssr"). Mutually exclusive with `image`. */
  template?: string;
  /** OCI reference (e.g., "oci://docker.io/library/alpine:3.19"). Mutually exclusive with `template`. */
  image?: string;
  region: Region;
  appName?: string;
  appRegionPin?: Region;
  size?: Size;
  ttl?: string | null;
  restartPolicy?: "none" | "on-failure" | "always";
  /** Workload isolation mode. "firecracker" (default) or "docker". Per D-003. */
  isolation?: "firecracker" | "docker";
  env?: Record<string, string>;
  files?: FileOverlay[];
  command?: string[];
  resources?: ResourceShape;
  hostnames?: { custom?: string[] };
  regionPolicy?: "strict" | "best-effort";
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  lifecycle?: LifecycleHooks;
  /** Outbound network policy. Defaults to unrestricted (no kernel rules). */
  egressPolicy?: EgressPolicy;
  /** Domain names whose A records are resolved at VM create time and stamped
   * into the host iptables OUTPUT chain as ACCEPT rules. Only meaningful
   * when egressPolicy="allowed-domains". */
  allowedDomains?: string[];
  /** Ports to expose from the VM. Public ports are forwarded through the
   * Firecracker tap device + GCP firewall rule. */
  ingress?: IngressPort[];
}

/** The canonical public Instance shape surfaced by heroa.deploy(). */
export interface Instance {
  readonly id: string;
  readonly url: string;
  readonly hostnames: readonly string[];
  readonly region: string;
  readonly size: string;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly state: "running" | "starting" | "stopped" | "failed" | "created" | "creating";
  readonly metadata: Readonly<Record<string, string>>;
}

/** Control plane's api.CreateMachineRequest on-wire shape. */
export interface CreateMachineRequestWire {
  name: string;
  region: string;
  config: {
    image: string;
    guest: { cpus: number; memory_mb: number };
    env: Record<string, string>;
    metadata: Record<string, string>;
    mounts: { volume: string; path: string }[];
    /** Per-load isolation mode. "firecracker" | "docker". */
    isolation_mode?: string;
  };
  ttl?: string;
  restart_policy?: string;
  files?: FileOverlay[];
  metadata?: Record<string, string>;
  region_policy?: string;
  egress_policy?: EgressPolicy;
  allowed_domains?: string[];
  ingress?: IngressPort[];
}

/** Control plane's api.MachineResponse on-wire shape. */
export interface MachineResponseWire {
  id: string;
  name: string;
  state: string;
  desired_state: string;
  observed_state: string;
  region: string;
  ip_address?: string;
  generated_hostname?: string;
  last_error?: string;
  config: {
    image: string;
    guest: { cpus: number; memory_mb: number };
    env: Record<string, string> | null;
    metadata: Record<string, string> | null;
    mounts: unknown[] | null;
  };
  created_at: string;
  updated_at: string;
  expires_at?: string;
  url?: string;
  hostnames?: string[];
  cache_credits_applied_minutes?: number;
}

// ── Multi-region instance groups (H12-4) ──

/** Input for deployGroup(). */
export interface InstanceGroupRequest {
  template: string;
  regions: string[];
  appName?: string;
  appRegionPin?: Region;
  size?: Size;
  ttl?: string | null;
  regionPolicy?: "strict" | "best-effort";
  routingMode?: "dns-latency" | "explicit-urls" | "sticky-session";
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  resources?: ResourceShape;
}

/** A single placed instance within an InstanceGroup. */
export interface InstanceGroupMember {
  readonly region: string;
  readonly fleetMemberId: string;
  readonly hostId: string;
  readonly url: string;
  readonly status: string;
}

/** A multi-region deployment group returned by deployGroup(). */
export interface InstanceGroup {
  readonly id: string;
  readonly appId: string;
  readonly regions: readonly string[];
  readonly routingMode: string;
  readonly anycastUrl: string;
  readonly status: string;
  readonly instances: readonly InstanceGroupMember[];
  /** Per-region URL map for explicit-urls routing mode. */
  readonly urls: Readonly<Record<string, string>>;
}

/** Control plane's POST /v1/apps/:app/instance-groups on-wire request. */
export interface CreateInstanceGroupRequestWire {
  regions: string[];
  routing_mode?: string;
  template: string;
  guest_cpus?: number;
  guest_mem_mb?: number;
  ttl?: string;
  region_policy?: string;
}

/** Control plane's instance group response wire shape. */
export interface InstanceGroupResponseWire {
  id: string;
  app_id: string;
  regions: string[];
  routing_mode: string;
  anycast_url?: string;
  status: string;
  instances: {
    region: string;
    fleet_member_id: string;
    host_id: string;
    url: string;
    status: string;
  }[];
  urls?: Record<string, string>;
}

/** Control plane's CreateAppRequest on-wire shape. */
export interface CreateAppRequestWire {
  app_name: string;
  org_slug: string;
  region_pin?: string;
}

/** Control plane's App response on-wire shape (store.App JSON). */
export interface AppResponseWire {
  id: string;
  org_id?: string;
  tenant_id?: string;
  name: string;
  status: string;
  region_pin?: string;
  created_at?: string;
}
