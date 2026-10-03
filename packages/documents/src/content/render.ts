// SPDX-License-Identifier: BUSL-1.1
import { CONTENT_LIMITS, canonicalJson, hashCanonicalJson, immutableContent } from "./json.js";
import { contentError } from "./errors.js";

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);
function record(value: unknown): Schema {
  if (!object(value)) contentError("INVALID_VALUE", "Frozen rendering requires an object.");
  return value;
}
const unsupported = (): never => contentError("BLOCK_SCHEMA_UNSUPPORTED", "The frozen output schema has no supported renderer.");

function title(schema: Schema, key: string, locale: string): string {
  const i18n = object(schema["x-osf-i18n"]) ? schema["x-osf-i18n"] : undefined;
  const labels = i18n && object(i18n.title) ? i18n.title : undefined;
  const label = labels?.[locale] ?? labels?.[locale.split("-")[0]!] ?? schema.title ?? key;
  return typeof label === "string" ? label : key;
}

/** The entityFields renderer consumes only the frozen public output schema, never input/reference metadata. */
type Budget = { characters: number; fields: number };
function output(text: string, budget: Budget): string {
  budget.characters -= text.length;
  if (budget.characters < 0) contentError("CONTENT_LIMIT_EXCEEDED", "Rendered content exceeds the text budget.");
  return text;
}
function fieldsText(value: unknown, schema: Schema, locale: string, budget: Budget, depth = 0): string {
  if (--budget.fields < 0) contentError("CONTENT_LIMIT_EXCEEDED", "Rendered content exceeds the field budget.");
  if (depth > 32 || schema.$ref || schema.oneOf || schema.anyOf || schema.allOf) unsupported();
  const type = Array.isArray(schema.type) ? schema.type.find(type => type !== "null") : schema.type;
  if (value === null && (schema.type === "null" || Array.isArray(schema.type) && schema.type.includes("null"))) return "";
  if (type === "object") {
    const data = record(value), properties = record(schema.properties);
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== "string" || !Object.hasOwn(data, key))) unsupported();
    budget.fields -= Object.keys(properties).length;
    if (budget.fields < 0) contentError("CONTENT_LIMIT_EXCEEDED", "Rendered content exceeds the field budget.");
    if (Object.keys(data).some(key => !Object.hasOwn(properties, key))) unsupported();
    const fields = Object.entries(properties).filter(([key]) => Object.hasOwn(data, key));
    return fields.map(([key, definition]) => {
      const field = record(definition), text = fieldsText(data[key], field, locale, budget, depth + 1);
      return fields.length === 1 ? text : `${output(`${title(field, key, locale)}: `, budget)}${text}`;
    }).join("\n");
  }
  if (type === "array") {
    const values = Array.isArray(value) ? value : unsupported();
    const item = record(schema.items);
    output("\n".repeat(values.length), budget);
    return values.map(entry => fieldsText(entry, item, locale, budget, depth + 1)).join("\n");
  }
  if (type === "string" && typeof value === "string") return output(value, budget);
  if (type === "boolean" && typeof value === "boolean") return output(String(value), budget);
  if ((type === "integer" || type === "number") && typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value))) return output(String(value), budget);
  return unsupported();
}

const rendererRegistry = Object.freeze({ entityFields: fieldsText });

export type RenderedTemplateContent = {
  channel: "document" | "email" | "whatsapp";
  locale: string;
  mediaType: "text/plain";
  body: string;
  snapshotHash: string;
  renderingVersion: "osf-entity-fields-text-v1";
  contentHash: string;
};

/** Pure rendering: the caller supplies a frozen snapshot, not source resolvers or a live template registry. */
export async function renderTemplateSnapshot(input: unknown, options: {
  tenantId: string;
}): Promise<RenderedTemplateContent> {
  const snapshot = record(immutableContent(input));
  if (snapshot.schemaVersion !== 1 || snapshot.compositionHashVersion !== "osf-template-content-v1" || snapshot.tenantId !== options.tenantId ||
    typeof snapshot.locale !== "string" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(snapshot.locale) || !Array.isArray(snapshot.blocks) || snapshot.blocks.length > 500) {
    contentError("INVALID_VALUE", "The content snapshot is invalid for this session.");
  }
  if (!["document", "email", "whatsapp"].includes(String(snapshot.channel))) contentError("UNSUPPORTED_CHANNEL", "The snapshot channel has no registered output renderer.");
  const { compositionHash, ...content } = snapshot;
  if (typeof compositionHash !== "string" || compositionHash !== await hashCanonicalJson(content)) contentError("DEPENDENCY_INVALID", "The content snapshot checksum does not match.");
  const definitions = record(snapshot.definitions);
  const rendered: string[] = [];
  const budget = { characters: CONTENT_LIMITS.stringCharacters, fields: CONTENT_LIMITS.jsonValues };
  for (const raw of snapshot.blocks) {
    const block = record(raw);
    if (typeof block.definitionKey !== "string" || !Object.hasOwn(definitions, block.definitionKey)) contentError("BLOCK_UNKNOWN", "A frozen block definition is missing.");
    const definition = record(definitions[block.definitionKey]);
    const renderers = record(definition.renderers);
    if (definition.entityName !== block.definitionKey || definition.schemaVersion !== block.schemaVersion) unsupported();
    if (typeof block.renderer !== "string" || !Object.hasOwn(renderers, String(snapshot.channel)) || renderers[String(snapshot.channel)] !== block.renderer || !Object.hasOwn(rendererRegistry, block.renderer)) {
      contentError("UNSUPPORTED_CHANNEL", "A frozen block has no registered renderer for this channel.");
    }
    const materialization = record(block.materialization), result = record(materialization.result);
    if (result.kind !== "block") unsupported();
    const schema = record(definition.materializationSchema);
    // Snapshot checksums are not signatures. Never compile a caller-supplied
    // schema or execute its patterns/formats: rendering checks structural shape
    // only. Canonical materialization owns business-value validation.
    const properties = record(schema.properties), valueSchema = record(properties.value);
    rendered.push(rendererRegistry[block.renderer as keyof typeof rendererRegistry](result.value, valueSchema, snapshot.locale, budget));
  }
  const payload = {
    channel: snapshot.channel as RenderedTemplateContent["channel"], locale: snapshot.locale,
    mediaType: "text/plain" as const, body: rendered.join("\n\n"), snapshotHash: compositionHash,
    renderingVersion: "osf-entity-fields-text-v1" as const,
  };
  // Bound rendered output too, including labels repeated by collection presentation.
  canonicalJson(payload);
  return immutableContent({ ...payload, contentHash: await hashCanonicalJson(payload, payload.renderingVersion) });
}
