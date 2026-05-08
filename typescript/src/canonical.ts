// @heroa/sdk — canonical serializer for idempotency-key derivation.
//
// The SDK auto-derives Idempotency-Key from sha256(canonicalized(args)) per
// scope §5.7. "Canonical" here means: object keys sorted recursively. We do
// NOT strip undefined or lowercase — the canonical form is pure sort so two
// semantically-identical args objects with different property ordering hash
// identically.

function sortedStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(sortedStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + sortedStringify(obj[k])).join(",") + "}";
}

/** Canonical JSON: stable key order, no whitespace. */
export function canonicalJSON(value: unknown): string {
  return sortedStringify(value);
}

/** SHA-256 hex digest of the canonical JSON form of `value`. */
export async function canonicalSha256(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJSON(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
