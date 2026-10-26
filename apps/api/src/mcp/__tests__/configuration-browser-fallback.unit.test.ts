// SPDX-License-Identifier: BUSL-1.1
import { afterEach, expect, test } from "bun:test";
import { configurationAppResult } from "../handoff-results.js";
import { configurationFallbackLead } from "../handoff-config.js";

const keys = ["OPENSHAPEFORGE_PUBLIC_ORIGIN", "OPENSHAPEFORGE_WEB_ORIGIN"] as const;
const saved = keys.map(key => process.env[key]);
afterEach(() => keys.forEach((key, i) => {
  if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
}));

test("a missing App card leaves an authenticated recovery link even if private metadata is dropped", () => {
  process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://api.example.test";
  process.env.OPENSHAPEFORGE_WEB_ORIGIN = "https://app.example.test/";
  const payload = { status: "awaiting_person", instructions: configurationFallbackLead("unsupported", "app") };
  const result = configurationAppResult(payload, "private-bearer-token", "Provider", undefined, undefined, "public-form-id");
  const connectorVisible = { content: result.content, structuredContent: result.structuredContent };
  expect(result.structuredContent).toEqual({ ...payload, externalUrl: "https://app.example.test/configuration?formId=public-form-id" });
  expect(JSON.stringify(connectorVisible)).toContain("https://app.example.test/configuration?formId=public-form-id");
  expect(JSON.stringify(connectorVisible)).toContain("same person in the same organization");
  expect(JSON.stringify(connectorVisible)).not.toContain("private-bearer-token");
  expect(JSON.stringify(connectorVisible)).not.toContain("has received");
  expect(result._meta?.configurationUrl).toBe("https://api.example.test/api/entity-configuration/private-bearer-token");
  expect(payload).not.toHaveProperty("externalUrl");
});

test("an API-only deployment does not invent a web route", () => {
  process.env.OPENSHAPEFORGE_PUBLIC_ORIGIN = "https://api.example.test";
  delete process.env.OPENSHAPEFORGE_WEB_ORIGIN;
  const result = configurationAppResult({ status: "awaiting_person" }, "private-token", "Provider");
  expect(result.structuredContent).toEqual({ status: "awaiting_person" });
  expect(JSON.stringify(result.content)).not.toContain("/configuration");
  expect(result._meta?.configurationUrl).toContain("private-token");
});

 test("the browser identifier cannot be substituted for the private bearer credential", async () => {
  const { mintConfiguration, peekConfiguration, consumeConfiguration } = await import("../configuration-handoff.js");
  const minted = await mintConfiguration({tenantId:"tenant",userId:"person",table:"example",elicit:{} as any,modelValues:{},definitions:[],displayName:"Provider"});
  try {
    expect(minted.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await peekConfiguration(minted.id)).toBeNull();
    expect(await peekConfiguration(minted.token)).not.toBeNull();
  } finally { await consumeConfiguration(minted.token); }
 });
