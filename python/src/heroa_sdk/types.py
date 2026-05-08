"""Request, response, and on-wire types for heroa-sdk."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field

from .constants import Size


@dataclass
class FileOverlay:
    """A file written into the guest at boot via MMDS."""

    path: str
    content: str


@dataclass
class ResourceShape:
    """Resource-shape override for a deploy() call."""

    cpus: int
    memory_mb: int
    persistent_volume_gb: int = 0


@dataclass
class Hooks:
    """Lifecycle callbacks. Each may be sync or async. A hook raising an
    exception does NOT propagate out of deploy() — the exception is
    wrapped in LifecycleHookError and passed to on_error on the next
    tick, unless on_error itself is the one that raised (in which case
    the exception is swallowed)."""

    on_ready: Callable[[Instance], None | Awaitable[None]] | None = None
    on_stop: Callable[[Instance], None | Awaitable[None]] | None = None
    on_error: Callable[[BaseException], None | Awaitable[None]] | None = None


@dataclass
class IngressPort:
    """A port to expose from the VM."""

    port: int
    public: bool
    expose_path: str = ""


@dataclass
class DeployRequest:
    """Arguments to heroa.deploy() — mirrors scope §5.2.

    Spec 06 introduces ``image`` as an alternative to ``template``. Exactly
    one of ``template`` or ``image`` must be set. ``image`` takes the form
    ``oci://<registry>/<repo>:<tag>`` or
    ``oci://<registry>/<repo>@sha256:<digest>`` and resolves through the
    control-plane OCI pipeline.
    """

    region: str
    # First-party template slug (e.g., "next-ssr"). Mutually exclusive with image.
    template: str = ""
    # OCI reference (e.g., "oci://docker.io/library/alpine:3.19"). Mutually
    # exclusive with template.
    image: str = ""
    app_name: str | None = None
    app_region_pin: str | None = None
    size: Size | None = None
    ttl: str | None = None
    restart_policy: str | None = None
    # isolation selects the workload isolation mode. Valid values are
    # "firecracker" (Firecracker microVM, default) and "docker" (Docker
    # container on the substrate host). Per D-003.
    isolation: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    files: Sequence[FileOverlay] = field(default_factory=tuple)
    command: Sequence[str] = field(default_factory=tuple)
    resources: ResourceShape | None = None
    custom_hostnames: Sequence[str] = field(default_factory=tuple)
    region_policy: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)
    idempotency_key: str | None = None
    lifecycle: Hooks = field(default_factory=Hooks)
    # egress_policy controls outbound traffic. Values: "" / "allow-all"
    # (default), "allowed-domains", "canadian-only".
    egress_policy: str | None = None
    # allowed_domains lists domain names whose A records are resolved at VM
    # create time and stamped into the host iptables OUTPUT chain as ACCEPT
    # rules. Only meaningful when egress_policy="allowed-domains".
    allowed_domains: list[str] = field(default_factory=list)
    # ingress declares ports to expose from the VM.
    ingress: list[IngressPort] = field(default_factory=list)


@dataclass
class Instance:
    """Public Instance surface — mirrors scope §5.3."""

    id: str
    url: str
    hostnames: Sequence[str]
    region: str
    size: str
    expires_at: str | None
    created_at: str
    state: str
    metadata: dict[str, str]


# ── Multi-region instance groups (H12-4) ──

@dataclass
class InstanceGroupRequest:
    """Input for Client.deploy_group(). regions must have >= 2 entries."""

    template: str
    regions: Sequence[str]
    app_name: str = ""
    app_region_pin: str | None = None
    size: Size = "small"
    ttl: str | None = None
    region_policy: str = "strict"  # strict | best-effort
    routing_mode: str = "dns-latency"  # dns-latency | explicit-urls | sticky-session
    env: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, str] = field(default_factory=dict)
    resources: ResourceShape | None = None


@dataclass
class InstanceGroupMember:
    """A single placed instance within an InstanceGroup."""

    region: str
    fleet_member_id: str
    host_id: str
    url: str
    status: str


@dataclass
class InstanceGroup:
    """Multi-region deployment group returned by Client.deploy_group()."""

    id: str
    app_id: str
    regions: Sequence[str]
    routing_mode: str
    anycast_url: str
    status: str
    instances: Sequence[InstanceGroupMember]
    urls: dict[str, str]  # region -> url map for explicit-urls mode
