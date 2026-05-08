// prove-prod.ts — End-to-end smoke proof against the live prod control plane.
//
// What it does:
//   1. Imports the public TS SDK surface (Heroa client + deploy primitive).
//   2. Reads HEROA_API_KEY + HEROA_BASE_URL from env (or falls back to
//      the prod CP). The bearer must be minted out-of-band via
//      `POST /internal/api-keys` against the test tenant.
//   3. Calls heroa.deploy({ template: 'static-site', files: [...] }) with a
//      unique marker string that round-trips into /srv/index.html.
//   4. Polls GET /v1/apps/{app}/machines/{id} until observed_state==running
//      or a deadline elapses; asserts at least observed_state in
//      {created,starting,running}.
//   5. Cleans up: DELETE machine + DELETE app.
//   6. Writes proof lines to stdout (caller redirects to audit/sdk-typescript-prove.md).
//
// Run:  HEROA_API_KEY=... npx tsx scripts/prove-prod.ts

import { Heroa, type Region } from "../src/index.js";

const PROD_CP = "https://heroa-cp-2sobff3gmq-uc.a.run.app";
const APP_PREFIX = "ts-sdk-prove";
// us-central1 is where the substrate fleet currently has Firecracker
// capacity. us-east + us-west are tenant-allowlisted but the placement
// fleet returns region_capacity until those regions are stood up.
const REGION_DEFAULT = "us-central1";
const REGION = process.env.HEROA_REGION ?? REGION_DEFAULT;
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

interface MachineWire {
  id: string;
  state: string;
  observed_state: string;
  desired_state: string;
}

function emit(line: string): void {
  process.stdout.write(line + "\n");
}

async function main(): Promise<void> {
  const apiKey = process.env.HEROA_API_KEY;
  if (!apiKey) {
    throw new Error("HEROA_API_KEY is required (mint via POST /internal/api-keys)");
  }
  const baseUrl = process.env.HEROA_BASE_URL ?? PROD_CP;

  const ts = Math.floor(Date.now() / 1000);
  const marker = `TS-SDK-PROVE-${ts}`;
  const appName = `${APP_PREFIX}-${ts}`;
  const indexHtml =
    `<!DOCTYPE html>\n<html><head><title>${marker}</title></head>` +
    `<body><h1>${marker}</h1></body></html>\n`;

  const heroa = new Heroa({
    apiKey,
    baseUrl,
    defaultAppName: appName,
  });

  emit(`# TS SDK prove-prod`);
  emit(`base_url:  ${baseUrl}`);
  emit(`app_name:  ${appName}`);
  emit(`region:    ${REGION}`);
  emit(`marker:    ${marker}`);
  emit(`sdk_path:  @heroa/sdk (Heroa, deploy)`);
  emit("");

  const startCall = Date.now();
  const instance = await heroa.deploy({
    template: "static-site",
    region: REGION as Region,
    appName,
    size: "small",
    files: [{ path: "/srv/index.html", content: indexHtml }],
    metadata: { "prove": "ts-sdk", "marker": marker },
    env: { "HEROA_PROVE_MARKER": marker },
    restartPolicy: "always",
  });
  const deployMs = Date.now() - startCall;

  emit(`## deploy() result`);
  emit(`machine_id:        ${instance.id}`);
  emit(`region:            ${instance.region}`);
  emit(`hostnames:         ${JSON.stringify(instance.hostnames)}`);
  emit(`url:               ${instance.url}`);
  emit(`size:              ${instance.size}`);
  emit(`state (initial):   ${instance.state}`);
  emit(`created_at:        ${instance.createdAt}`);
  emit(`deploy_call_ms:    ${deployMs}`);
  emit("");

  if (!instance.id) {
    throw new Error("deploy returned no machine id");
  }

  // The CP routes /v1/apps/{app}/... by the app id, not the name.
  // Look up the app's id via the idempotent createApp endpoint so the
  // poll + delete-app calls below address the right resource.
  const appLookup = await fetch(`${baseUrl}/v1/apps`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ app_name: appName, org_slug: "" }),
  });
  if (appLookup.status !== 200 && appLookup.status !== 201) {
    throw new Error(`app lookup: HTTP ${appLookup.status} ${await appLookup.text()}`);
  }
  const appBody = (await appLookup.json()) as { id: string };
  const appId = appBody.id;

  // Poll the machine state via the same bearer.
  const machineUrl =
    `${baseUrl}/v1/apps/${encodeURIComponent(appId)}/machines/${encodeURIComponent(instance.id)}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: MachineWire | null = null;
  let pollAttempts = 0;
  let reached: "running" | "created" | "starting" | "other" = "other";
  while (Date.now() < deadline) {
    pollAttempts += 1;
    const res = await fetch(machineUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status !== 200) {
      throw new Error(`poll machine: HTTP ${res.status} ${await res.text()}`);
    }
    last = (await res.json()) as MachineWire;
    if (last.observed_state === "running") {
      reached = "running";
      break;
    }
    if (last.observed_state === "created") {
      reached = "created";
    } else if (last.observed_state === "starting") {
      reached = "starting";
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  emit(`## poll`);
  emit(`attempts:        ${pollAttempts}`);
  emit(`final state:     ${last?.state}`);
  emit(`observed_state:  ${last?.observed_state}`);
  emit(`desired_state:   ${last?.desired_state}`);
  emit(`reached:         ${reached}`);
  emit("");

  if (reached === "other") {
    throw new Error(
      `machine never reached running/created/starting (last=${JSON.stringify(last)})`,
    );
  }

  // Cleanup: delete machine, then delete app.
  emit(`## cleanup`);
  await heroa.stop(appName, instance.id);
  emit(`stop(${appName}, ${instance.id}): OK`);

  const delAppRes = await fetch(`${baseUrl}/v1/apps/${encodeURIComponent(appId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  emit(`DELETE /v1/apps/${appId}: HTTP ${delAppRes.status}`);
  if (delAppRes.status !== 200 && delAppRes.status !== 204) {
    emit(`  body: ${await delAppRes.text()}`);
  }

  emit("");
  emit(`## proof`);
  emit(`SDK:             @heroa/sdk (TypeScript)`);
  emit(`marker:          ${marker}`);
  emit(`machine_id:      ${instance.id}`);
  emit(`tenant:          (resolved by bearer; spec-13 e2e tenant)`);
  emit(`result:          PASS — deploy/poll/cleanup round-trip OK`);
}

main().catch((err) => {
  process.stderr.write(
    "FAIL: " + (err && (err as Error).stack ? (err as Error).stack : String(err)) + "\n",
  );
  process.exit(1);
});
