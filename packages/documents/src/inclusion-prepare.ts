// SPDX-License-Identifier: BUSL-1.1
/**
 * TemplateBlock.materialize: the read that prepares an inclusion before it
 * is saved (docs/document-content.md, "Preparing an inclusion before Save").
 *
 * The caller names the collection the inclusion belongs to, optionally the
 * saved block and a path to an inclusion nested in it, and sends the version,
 * inputs and local draft it is about to save. The answer is the complete
 * content that save would store. It is a read: nothing is written, no block
 * is marked as changed, no file is staged or bound. Saving is a separate,
 * ordinary write of the Block, which settles the content again by itself.
 *
 * The answer also holds `baseline`: the same version and inputs as captured,
 * without the local draft. A caller that prepares again before it saves sends
 * that baseline back with the draft it has made since; the server captures it
 * again as the caller and merges from there, so nothing typed after an
 * earlier preparation is lost.
 */
import type { ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices } from "./commands.js";
import { blockDefinition, contentCarrier, validatedValues } from "./content-runtime.js";
import { inclusionCopyContent, templateComposition } from "./content/inclusion-copy.js";
import { prepareInclusionCopy } from "./inclusion-write.js";
import { object, refuse, text, uuid } from "./validation.js";

const INPUT = new Set(["definitionKey", "values", "references", "referenceField", "parametersField", "host", "blockId", "path", "baseline"]);
type Json = Parameters<typeof prepareInclusionCopy>[2]["parameters"];
const HOSTS = ["TemplateVariant", "DocumentVariant"] as const;
const PATH_STEP = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export const composeTemplate: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) refuse("UNAUTHENTICATED", "Preparing an inclusion requires a tenant session.");
  if (Object.keys(input).some((key) => !INPUT.has(key))) refuse("VALIDATION", "Unknown input.");
  const carrier = contentCarrier(context);
  const name = text(input.definitionKey, "definitionKey");
  const entry = blockDefinition(carrier, name);
  const referenceField = text(input.referenceField, "referenceField");
  const parametersField = text(input.parametersField, "parametersField");
  const composition = templateComposition(entry.fields);
  const slot = entry.references.find((reference) => reference.fieldKey === referenceField);
  if (!composition || composition.templateVersionField !== referenceField || composition.parametersField !== parametersField || slot?.targetEntity !== "TemplateVersion")
    refuse("INVALID_DEFINITION", "Template inclusion requires a typed template-version reference and its parameters field.");
  const host = object(input.host, "host");
  if (Object.keys(host).some((key) => key !== "entity" && key !== "id") || !HOSTS.includes(host.entity as typeof HOSTS[number])) refuse("VALIDATION", "host names a TemplateVariant or a DocumentVariant.");
  const hostId = uuid(host.id, "host.id");
  const blockId = input.blockId === undefined ? undefined : uuid(input.blockId, "blockId");
  const path = input.path === undefined ? [] : input.path;
  if (!Array.isArray(path) || path.length > 8 || path.some((step) => typeof step !== "string" || !PATH_STEP.test(step))) refuse("VALIDATION", "path holds at most eight block ids.");
  const references = object(input.references, "references");
  const reference = object(references[referenceField], "template reference");
  const versionId = uuid(reference.id, "template reference");
  if (reference.entity !== "TemplateVersion") refuse("DEPENDENCY_INVALID", "Template inclusion refers to another entity type.");
  const values = validatedValues(context, name, input.values);
  const parameters = object(values[parametersField] ?? {}, "parameters");
  const baseline = input.baseline === undefined ? undefined : object(input.baseline, "baseline");
  if (baseline && Object.keys(baseline).some((key) => key !== "version" && key !== "parameters" && key !== "content")) refuse("VALIDATION", "baseline holds the version, parameters and content an earlier preparation returned.");
  const earlier = baseline ? object(baseline.version, "baseline.version") : undefined;
  if (earlier && earlier.entity !== "TemplateVersion") refuse("DEPENDENCY_INVALID", "Template inclusion refers to another entity type.");
  const prepared = baseline ? { versionId: uuid(earlier!.id, "baseline.version"), parameters: object(baseline.parameters, "baseline.parameters") as Json, content: object(baseline.content, "baseline.content") } : undefined;
  // The right to change the host decides, exactly as for the write this prepares.
  await platform.records.assertAccess(session, { entityName: host.entity as string, id: hostId, intent: "update" });
  const settled = await platform.db.withSession(session, (trx) => prepareInclusionCopy(context, trx, {
    tenantId: session.tenantId!, carrier, host: { entity: host.entity as typeof HOSTS[number], id: hostId }, ...(blockId ? { blockId } : {}), path: path as string[],
    definitionKey: name, versionId, parameters: parameters as Json, draft: values.content, ...(prepared ? { baseline: prepared } : {}),
  }));
  const version = { entity: "TemplateVersion", id: versionId };
  return { value: {
    kind: "template", referenceField, version, parameters: settled.parameters, content: inclusionCopyContent(settled.copy),
    baseline: { version, parameters: settled.parameters, content: inclusionCopyContent(settled.baseline) },
  } };
};
