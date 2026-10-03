// SPDX-License-Identifier: BUSL-1.1
import { runMaintenanceCommand } from "../modules/maintenance.js";

const MAX_INPUT_BYTES = 65_536;
/** Descriptor data only; owner selection and invocation authority remain flags/core. */
export function maintenanceInput(
  text: string,
  action: string,
  snapshotDate?: string,
): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_INPUT_BYTES)
    throw new Error("Maintenance input exceeds its limit.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Maintenance input must be a JSON object.");
  const input = value as Record<string, unknown>;
  for (const key of [
    "__proto__",
    "prototype",
    "constructor",
    "contribution",
    "tenant",
    "tenantId",
    "tenantSlug",
    "session",
    "provenance",
    "operator",
    "job",
    "roles",
  ]) {
    if (Object.hasOwn(input, key))
      throw new Error("Maintenance input cannot supply owner authority.");
  }
  if (
    (Object.hasOwn(input, "action") && input.action !== action) ||
    (Object.hasOwn(input, "snapshotDate") &&
      input.snapshotDate !== snapshotDate)
  )
    throw new Error("Maintenance input conflicts with authoritative flags.");
  return { ...input, action, ...(snapshotDate ? { snapshotDate } : {}) };
}
async function stdinInput(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_INPUT_BYTES)
        throw new Error("Maintenance input exceeds its limit.");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  const switches = new Set<string>();
  while (args.length) {
    const flag = args.shift()!;
    if (["--confirm-seed", "--input-stdin"].includes(flag)) {
      if (switches.has(flag)) throw new Error("Duplicate maintenance flag.");
      switches.add(flag);
      continue;
    }
    if (
      !["--contribution", "--tenant", "--action", "--date"].includes(flag) ||
      values.has(flag) ||
      !args.length
    )
      throw new Error("Invalid maintenance arguments.");
    values.set(flag, args.shift()!);
  }
  const contribution = values.get("--contribution"),
    tenantSlug = values.get("--tenant"),
    action = values.get("--action");
  if (!contribution || !tenantSlug || !action)
    throw new Error(
      "Maintenance requires --contribution, --tenant and --action.",
    );
  const input = maintenanceInput(
    switches.has("--input-stdin") ? await stdinInput() : "{}",
    action,
    values.get("--date"),
  );
  console.log(
    JSON.stringify(
      await runMaintenanceCommand({
        contribution,
        tenantSlug,
        input,
        appliedBy: "cli",
        confirmed: switches.has("--confirm-seed"),
      }),
      null,
      2,
    ),
  );
}
