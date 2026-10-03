// SPDX-License-Identifier: BUSL-1.1
import type { RuntimeSettingValue, RuntimeSettingsService } from "@openshapeforge/plugin-runtime";
import generatedPolicy from "../generated/compiler/settings-policy.json" with { type: "json" };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid compiled settings object.");
  return value as Record<string, unknown>;
}

function provenance(entry: Record<string, unknown>): void {
  const owner = record(entry.owner);
  if (typeof entry.source !== "string" || !entry.source || typeof owner.id !== "string" || !owner.id ||
    (owner.kind !== "plugin" && owner.kind !== "layer")) throw new Error("Invalid compiled setting provenance.");
}

/** No environment/local fallback: only the compiled canonical policy is served. */
export function createRuntimeSettings(input: unknown): RuntimeSettingsService {
  const policy = record(input);
  if (policy.version !== 1) throw new Error("Unsupported compiled settings policy.");
  const values = new Map<string, RuntimeSettingValue>();
  const providers = new Map<string, ReadonlySet<string>>();
  const selected = new Map<string, Set<string>>();
  for (const [id, raw] of Object.entries(record(policy.providers))) {
    const provider = record(raw);
    provenance(provider);
    if (!Array.isArray(provider.capabilities) ||
      provider.capabilities.some(capability => typeof capability !== "string")) {
      throw new Error("Invalid compiled settings provider.");
    }
    providers.set(id, new Set(provider.capabilities));
  }
  for (const [key, raw] of Object.entries(record(policy.settings))) {
    const entry = record(raw);
    provenance(entry);
    const value = entry.value;
    const valid = entry.type === "integer" ? Number.isSafeInteger(value)
      : entry.type === "boolean" ? typeof value === "boolean"
      : entry.type === "choice" ? typeof value === "string"
      : entry.type === "stringSet" ? Array.isArray(value) && value.every(item => typeof item === "string")
      : entry.type === "provider" && typeof entry.capability === "string" && (value === null || (typeof value === "string" && providers.get(value)?.has(entry.capability)));
    if (!valid) throw new Error("Invalid compiled setting.");
    values.set(key, Array.isArray(value) ? Object.freeze([...value]) : value as RuntimeSettingValue);
    if (entry.type === "provider" && typeof value === "string" && typeof entry.capability === "string") {
      const ids = selected.get(entry.capability) ?? new Set<string>();
      ids.add(value);
      selected.set(entry.capability, ids);
    }
  }
  return Object.freeze({
    get: (key: string) => values.get(key),
    providerSupports: (id: string, capability: string) => providers.get(id)?.has(capability) ?? false,
    selectedProviders: (capability: string) => Object.freeze([...(selected.get(capability) ?? [])].sort()),
  });
}

export const runtimeSettings = createRuntimeSettings(generatedPolicy);
