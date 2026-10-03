// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { hashCanonicalJson, immutableContent } from "./json.js";
import { renderTemplateSnapshot } from "./render.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
async function seal(content: Record<string, unknown>) {
  return immutableContent({ ...content, compositionHash: await hashCanonicalJson(content) });
}
async function snapshot(channel: string) {
  return seal({ schemaVersion: 1, tenantId, templateVersionId: "version", locale: "nl", channel,
    compositionHashVersion: "osf-template-content-v1", templates: [], compositions: [], globals: { secret: { value: "do-not-render" } },
    definitions: { Notice: { entityName: "Notice", schemaVersion: 1, fields: {},
      renderers: { document: "entityFields", email: "entityFields", whatsapp: "entityFields" },
      materializationSchema: { type: "object", required: ["kind", "value"], properties: { kind: { const: "block" },
        value: { type: "object", properties: { paragraph: { type: "string" } }, required: ["paragraph"], additionalProperties: false } } } } },
    blocks: ["First", "Second"].map((paragraph, index) => ({ id: String(index), path: [String(index)], definitionKey: "Notice", schemaVersion: 1,
      renderer: "entityFields", values: { privateInput: "not-public-output" }, references: { source: { value: "hidden-reference" } },
      materialization: { operationId: "Notice.materialize", result: { kind: "block", value: { paragraph } } } })),
  });
}
async function change(input: any, apply: (value: any) => void) {
  const { compositionHash: _, ...content } = structuredClone(input);
  apply(content);
  return seal(content);
}

for (const channel of ["document", "email", "whatsapp"]) test(`frozen ${channel} output uses the registered renderer and deterministic block order`, async () => {
  const value = await snapshot(channel);
  const first = await renderTemplateSnapshot(value, { tenantId });
  const replay = await renderTemplateSnapshot(JSON.parse(JSON.stringify(value)), { tenantId });
  expect(first).toEqual(replay);
  expect(first).toMatchObject({ channel, locale: "nl", mediaType: "text/plain", body: "First\n\nSecond", snapshotHash: value.compositionHash });
  expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(first)).not.toContain("do-not-render");
  expect(JSON.stringify(first)).not.toContain("hidden-reference");
  expect(JSON.stringify(first)).not.toContain("not-public-output");
});

test("later source/template changes cannot change an earlier rendered snapshot", async () => {
  const original = await snapshot("email");
  const before = await renderTemplateSnapshot(original, { tenantId });
  const later = await change(original, copy => { copy.blocks[0].materialization.result.value.paragraph = "Changed"; copy.globals.secret.value = "Changed secret"; });
  expect((await renderTemplateSnapshot(later, { tenantId })).body).toBe("Changed\n\nSecond");
  expect(await renderTemplateSnapshot(original, { tenantId })).toEqual(before);
});

test("unsupported channels, definitions, renderer keys and missing frozen schemas fail closed", async () => {
  const original = await snapshot("email");
  for (const apply of [
    (value: any) => { value.channel = "sms"; },
    (value: any) => { value.blocks[0].definitionKey = "Missing"; },
    (value: any) => { value.blocks[0].renderer = "constructor"; },
    (value: any) => { value.definitions.Notice.renderers.email = "missing"; value.blocks[0].renderer = "missing"; },
    (value: any) => { delete value.definitions.Notice.materializationSchema; },
    (value: any) => { value.blocks[0].materialization.result.value.paragraph = { metadata: "not content" }; },
  ]) await expect(renderTemplateSnapshot(await change(original, apply), { tenantId })).rejects.toThrow();
});

test("tampering, cross-tenant input and missing required output fields are rejected", async () => {
  const original = await snapshot("email");
  await expect(renderTemplateSnapshot({ ...original, locale: "en" }, { tenantId })).rejects.toThrow("checksum");
  await expect(renderTemplateSnapshot(original, { tenantId: "other" })).rejects.toThrow("session");
  await expect(renderTemplateSnapshot(await change(original, value => { delete value.blocks[0].materialization.result.value.paragraph; }), { tenantId })).rejects.toThrow();
});

test("generic field presentation preserves typed nested values without private block special cases", async () => {
  const input = await change(await snapshot("whatsapp"), value => {
    value.blocks = [value.blocks[0]];
    value.definitions.Notice.materializationSchema.properties.value = { type: "object", properties: {
      name: { type: "string", "x-osf-i18n": { title: { en: "Name", nl: "Naam" } } },
      numbers: { type: "array", title: "Values", items: { type: "integer" } },
      enabled: { type: "boolean", title: "Enabled" },
    } };
    value.blocks[0].materialization.result.value = { name: "Example", numbers: [2, 1], enabled: false };
  });
  expect((await renderTemplateSnapshot(input, { tenantId })).body).toBe("Enabled: false\nNaam: Example\nValues: 2\n1");
});

test("rendering never executes patterns or remote schema references supplied in a snapshot", async () => {
  const dangerous = await change(await snapshot("email"), value => {
    value.definitions.Notice.materializationSchema.properties.value.properties.paragraph.pattern = "(a+)+$";
    value.blocks[0].materialization.result.value.paragraph = "a".repeat(1000) + "!";
  });
  expect((await renderTemplateSnapshot(dangerous, { tenantId })).body).toStartWith("a".repeat(1000));
  const reference = await change(dangerous, value => { value.definitions.Notice.materializationSchema.properties.value.$ref = "https://example.invalid/schema"; });
  await expect(renderTemplateSnapshot(reference, { tenantId })).rejects.toThrow();
});
