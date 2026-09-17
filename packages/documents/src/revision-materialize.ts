// SPDX-License-Identifier: BUSL-1.1
/**
 * Feeds a DocumentRevision to the pure content engine. The revision is the
 * root "template version": one variant holding the revision's own blocks.
 * Nested TemplateBlock inclusions resolve real template versions from their
 * frozen snapshots through the same reader the template materializer uses.
 */
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import { contextServices } from "./commands.js";
import {
  DEFINITION_VERSION_COLUMN, blockDefinition, blockMaterializer, canonicalReader, chipResolver, compiledContentRegistry, contentCarrier, entityResolver, parameterShapes,
} from "./content-runtime.js";
import { templateSnapshotContent } from "./content-snapshot.js";
import { TemplateContentError } from "./content/errors.js";
import { immutableContent, type JsonObject } from "./content/json.js";
import { materializeTemplateContent } from "./content/materialize.js";
import type { ContentBlock, ContentTemplateVersion, MaterializedTemplateContent } from "./content/types.js";
import { listRevisionBlocks, readTemplateVersion, templateParameterFields } from "./revision-blocks.js";
import type { RevisionRow } from "./revision-start.js";
import { object, refuse, text, uuid } from "./validation.js";

/** A live revision block row as the engine's ContentBlock; references come from their typed columns. */
export function blockFromRow(carrier: RuntimeEntityValueCarrier, row: Readonly<Record<string, unknown>>): ContentBlock {
  const name = text(row[carrier.definitionColumn], "definition key");
  const entry = blockDefinition(carrier, name);
  const logical = object(row[carrier.valuesColumn] ?? {}, "block values");
  const referenceKeys = new Set(entry.references.map((reference) => reference.fieldKey));
  const values = Object.fromEntries(Object.entries(logical).filter(([key]) => !referenceKeys.has(key)));
  const references = Object.fromEntries(entry.references.map((reference) => {
    const parameter = reference.parameterColumn ? row[reference.parameterColumn] : null;
    if (typeof parameter === "string") return [reference.fieldKey, { parameter }];
    const id = row[reference.column];
    return [reference.fieldKey, id == null ? null : { entity: reference.targetEntity, id: uuid(id, reference.fieldKey) }];
  }));
  return { id: uuid(row.id, "block id"), definitionKey: name, schemaVersion: Number(row[DEFINITION_VERSION_COLUMN] ?? 1), values: immutableContent(values) as JsonObject, references };
}

/** Materializes a revision inside the caller's session transaction. */
export async function materializeRevision(context: ModuleOperationContext, trx: unknown, revision: RevisionRow): Promise<MaterializedTemplateContent> {
  const { platform, session } = contextServices(context);
  const tenantId = session.tenantId!;
  const carrier = contentCarrier(context);
  const allowed = (entity: string) => [...(platform.schemas.entityValues?.collection(entity, "blocks")?.allowedDefinitions ?? [])];
  const registry = await compiledContentRegistry(context, carrier);
  const read = canonicalReader(context, await platform.operations.list(session));
  const parameterFields = new Map<string, readonly Record<string, unknown>[]>();
  const tracked = revision.template_version_id ? await readTemplateVersion(trx, revision.template_version_id) : undefined;
  const trackedFields = tracked ? templateParameterFields(tracked.snapshot) : [];
  try {
    return await materializeTemplateContent({
      tenantId, templateVersionId: revision.id, channel: revision.channel, locale: revision.locale,
      parameters: immutableContent(revision.parameters ?? {}) as JsonObject,
    }, registry, {
      async resolveTemplateVersion(id): Promise<ContentTemplateVersion | null> {
        if (id === revision.id) {
          parameterFields.set(id, trackedFields);
          const blocks = (await listRevisionBlocks(trx, revision.id)).map((row) => blockFromRow(carrier, row));
          return { id, tenantId, templateId: revision.document_id, versionNumber: 1, parameters: parameterShapes(context, trackedFields),
            variants: [{ id, channel: revision.channel, locale: revision.locale, blocks, allowedDefinitions: allowed("DocumentRevision") }] };
        }
        uuid(id, "template version");
        await platform.records.assertAccess(session, { entityName: "TemplateVersion", id, intent: "get" });
        const version = await readTemplateVersion(trx, id);
        if (!version) return null;
        await platform.records.assertAccess(session, { entityName: "Template", id: version.template_id, intent: "get" });
        const frozen = templateSnapshotContent(version.snapshot, {
          tenantId, templateId: version.template_id, channel: revision.channel, locale: revision.locale, carrier, allowedDefinitions: allowed("TemplateVariant"), definitionVersionColumn: DEFINITION_VERSION_COLUMN,
        });
        parameterFields.set(id, frozen.parameterFields);
        return { id, tenantId, templateId: version.template_id, versionNumber: version.version_number, parameters: parameterShapes(context, frozen.parameterFields), variants: frozen.variants };
      },
      resolveGlobalVariable: chipResolver(trx, tenantId, read),
      resolveEntity: entityResolver(tenantId, read),
      validateParameters(version, values) {
        const fields = parameterFields.get(version.id);
        if (!fields) refuse("INVALID_DEFINITION", "Template parameter definitions are unavailable.");
        if (!fields!.length) return;
        const valid = platform.schemas.fields.validateObject(fields!, values);
        if (!valid.valid) throw operationFailure(valid.error);
      },
      validateBlockValues(name, values) {
        const result = platform.schemas.json.validate(blockDefinition(carrier, name).valueSchema, values);
        if (!result.valid) throw operationFailure(result.error);
      },
      materializeBlock: blockMaterializer(context, carrier, revision.channel, revision.locale),
    });
  } catch (error) {
    if (error instanceof TemplateContentError) throw operationFailure({ code: error.code, message: error.message, retryable: false });
    throw error;
  }
}
