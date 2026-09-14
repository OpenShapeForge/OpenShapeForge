// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import type { RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [
      key,
      canonical((value as Record<string, unknown>)[key]),
    ]),
  );
}

/**
 * Fingerprint execution semantics, not localised presentation. Both the
 * durable broker and the canonical executor use this exact helper so a
 * catalog/runtime swap cannot change a claimed command between discovery and
 * dispatch.
 */
export function operationContractFingerprint(
  definition: RuntimeOperationDefinition,
): string {
  const contract = canonical({
    version: 1,
    id: definition.id,
    intent: definition.intent,
    target: definition.target,
    input: definition.input,
    output: definition.output,
    effects: definition.effects,
    reliability: definition.reliability,
    prerequisites: definition.prerequisites,
    concurrency: definition.concurrency,
    interaction: definition.interaction,
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(contract)).digest("hex")}`;
}
