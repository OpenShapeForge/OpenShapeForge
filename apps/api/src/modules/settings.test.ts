// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { createRuntimeSettings } from "./settings.js";

function policy() {
  const provenance = { owner: { kind: "plugin" as const, id: "example" }, source: "settings/example.yaml" };
  return { version: 1, settings: {
    "example.limit": { ...provenance, type: "integer", value: 50 },
    "example.types": { ...provenance, type: "stringSet", value: ["text/plain"] },
    "example.enabled": { ...provenance, type: "boolean", value: true },
    "example.provider": { ...provenance, type: "provider", value: "filesystem", capability: "artifact-storage" },
  }, providers: { filesystem: { ...provenance, capabilities: ["artifact-storage"] } } };
}

test("runtime settings are an immutable snapshot of compiled values without fallback", () => {
  const input = policy();
  const service = createRuntimeSettings(input);
  input.settings["example.limit"]!.value = 100;
  (input.settings["example.types"]!.value as string[]).push("application/pdf");
  input.providers.filesystem!.capabilities.length = 0;
  expect(service.get("example.limit")).toBe(50);
  expect(service.get("example.types")).toEqual(["text/plain"]);
  expect(Object.isFrozen(service.get("example.types"))).toBe(true);
  expect(Object.isFrozen(service)).toBe(true);
  expect(service.get("missing")).toBeUndefined();
  expect(service.get("__proto__")).toBeUndefined();
  expect(service.providerSupports("filesystem", "artifact-storage")).toBe(true);
  expect(service.providerSupports("filesystem", "unknown")).toBe(false);
  expect(service.selectedProviders("artifact-storage")).toEqual(["filesystem"]);
  expect(Object.isFrozen(service.selectedProviders("artifact-storage"))).toBe(true);
  expect(service.selectedProviders("unknown")).toEqual([]);
});

test("malformed values and missing provider capability fail startup", () => {
  const input = policy();
  input.providers.filesystem!.capabilities.length = 0;
  expect(() => createRuntimeSettings(input)).toThrow("Invalid compiled setting");
  const bad = policy();
  bad.settings["example.limit"]!.value = NaN;
  expect(() => createRuntimeSettings(bad)).toThrow("Invalid compiled setting");
  expect(() => createRuntimeSettings({ ...policy(), version: 2 })).toThrow("Unsupported");
});
