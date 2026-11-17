// SPDX-License-Identifier: BUSL-1.1
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, ModuleOperationHandler } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import { blockCollection, canonicalReader, compiledContentRegistry, contentCarrier, contentResolvers, pathResolver } from "./content-runtime.js";
import { captureTemplateBlocks } from "./content/capture.js";
import { TemplateContentError } from "./content/errors.js";
import type { JsonObject } from "./content/json.js";
import { resolveTemplateParameters } from "./content/validation.js";
import { blockColumns, readTemplateVersion, templateParameterFields, withDocumentCommand } from "./document-blocks.js";
import { applyTemplateVersion, type ApplyContext } from "./document-follow.js";
import { object, refuse, uuid } from "./validation.js";

type DocumentRow = Readonly<{ id: string; template_version_id: string | null; parameters: unknown; updated_at: string; follow_error: string | null }>;

const DOCUMENT_COLUMNS: Readonly<Record<string, string>> = {
  id: "id", template_version_id: "templateVersionId", follow_error: "followError", parameters: "parameters",
  lifecycle_status: "lifecycleStatus", updated_at: "updatedAt",
};

/** The logical Document fields this command reports, from the physical row. */
export function projectDocument(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [column, field] of Object.entries(DOCUMENT_COLUMNS)) {
    if (Object.hasOwn(row, column)) projected[field] = row[column] ?? null;
  }
  return projected;
}

/**
 * What the document receives from one variant of the version being linked:
 * the variant's blocks with every variable resolved once, as the linking
 * session, from the document's values. The linked version is read through
 * the document's own update access; every record a variable names is read
 * through its canonical Operation, so a value the session may not see refuses
 * the link instead of reaching the document.
 */
function variantCapture(context: ModuleOperationContext, trx: unknown, templateVersionId: string, parameters: JsonObject, permitted: ReadonlySet<string>): ApplyContext["capture"] {
  const { platform, session } = contextServices(context);
  const tenantId = session.tenantId!;
  const carrier = contentCarrier(context);
  return async (variant) => {
    const operations = await platform.operations.list(session);
    const read = canonicalReader(context, operations);
    const resolveVariablePath = pathResolver(context, operations, read);
    const resolvers = contentResolvers(context, trx, {
      tenantId, channel: variant.channel, locale: variant.locale, carrier, read,
      allowedDefinitions: blockCollection(context, carrier, "TemplateVariant").allowedDefinitions,
      ...(resolveVariablePath ? { resolveVariablePath } : {}), ownVersions: new Set([templateVersionId]),
    });
    const frozen = await resolvers.resolveTemplateVersion(templateVersionId, { tenantId });
    if (!frozen) refuse("NOT_FOUND", "The template version does not exist.");
    // A block definition a document may not hold is skipped by the follow rule, so nothing of it is read.
    const version = { ...frozen!, variants: frozen!.variants.map((candidate) => ({ ...candidate, blocks: candidate.blocks.filter((block) => permitted.has(block.definitionKey)) })) };
    const values = resolveTemplateParameters(version.parameters, parameters);
    await resolvers.validateParameters?.(version, values);
    return captureTemplateBlocks({ tenantId, channel: variant.channel, locale: variant.locale, version, variantId: variant.id, parameters: values },
      await compiledContentRegistry(context, carrier), resolvers);
  };
}

/**
 * Document.linkTemplate: seed or re-seed the document's variants from a
 * published template version. Linking is the only way a document moves to
 * another version; publishing a template changes no document. The same
 * template (any version, also the one already linked) is followed with the
 * follow rule, so local edits survive and untouched content is captured
 * again with the current record values; another template replaces the source
 * only when `replace` is set, retaining local content and refusing conflicts.
 * Blocks are captured from the frozen snapshot, never from the live template.
 */
export const linkTemplate: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) refuse("UNAUTHENTICATED", "Linking a template requires a tenant session.");
  const allowed = new Set(["id", "templateVersionId", "parameters", "replace"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) refuse("VALIDATION", "Unknown link input.");
  const documentId = uuid(input.id, "id");
  const templateVersionId = uuid(input.templateVersionId, "templateVersionId");
  const parameters = input.parameters === undefined ? undefined : object(input.parameters, "parameters");
  if (input.replace !== undefined && typeof input.replace !== "boolean") refuse("VALIDATION", "replace must be a boolean.");
  const replace = input.replace === true;

  const value = await platform.db.withSession(session, async (trx) => {
    // A document editor picks a published template without holding a template
    // role: the Operation's own roles and the document's update access decide,
    // and the version is read here, server-side, from its frozen snapshot.
    await platform.records.assertAccess(session, { entityName: "Document", id: documentId, intent: "update" });
    const document = (await rows<DocumentRow>(trx,
      "select id, template_version_id, parameters, updated_at, follow_error from erp.documents where tenant_id = app.current_tenant() and id = $1::uuid for update", [documentId]))[0];
    if (!document) refuse("NOT_FOUND", "The document does not exist.");
    const next = await readTemplateVersion(trx, templateVersionId);
    if (!next) refuse("NOT_FOUND", "The template version does not exist.");
    if (next!.status !== "published") refuse("INVALID_STATE", "Only a published template version can be linked.");
    const fields = templateParameterFields(next!.snapshot);
    const declared = new Set(fields.map((field) => field.key));
    // Carry only values the selected version still declares. Explicit caller
    // input stays intact so canonical validation continues to refuse unknown keys.
    const retained = Object.fromEntries(Object.entries(object(document!.parameters ?? {}, "parameters"))
      .filter(([key]) => declared.has(key)));
    const mergedParameters = { ...retained, ...parameters };
    const valid = platform.schemas.fields.validateObject(fields, mergedParameters);
    if (!valid.valid) throw operationFailure(valid.error);
    const tracked = document!.template_version_id ? await readTemplateVersion(trx, document!.template_version_id) : undefined;
    const sameTemplate = !document!.template_version_id || tracked?.template_id === next!.template_id;
    const carrier = contentCarrier(context);
    const permitted = new Set(platform.schemas.entityValues?.collection("DocumentVariant", "blocks")?.allowedDefinitions ?? []);
    const apply: ApplyContext = {
      trx, carrier, columns: await blockColumns(trx, carrier), tracked: new Map(tracked ? [[tracked.id, tracked]] : []), permitted,
      capture: variantCapture(context, trx, templateVersionId, mergedParameters as JsonObject, permitted),
    };
    try {
      await withDocumentCommand(trx, "link", async () => {
        if(!sameTemplate&&!replace)refuse("INVALID_STATE","Choose replacement explicitly to switch templates. Local edits will be retained.");
        // A tracked version that is no longer readable is followed as if nothing was tracked: template blocks it seeded then count as local edits.
        await applyTemplateVersion(apply, { id: documentId, template_version_id: tracked ? document!.template_version_id : null }, next!);
        await rows(trx, "update erp.documents set parameters = $2::text::jsonb where tenant_id = app.current_tenant() and id = $1::uuid", [documentId, JSON.stringify(mergedParameters)]);
      });
    } catch (error) {
      // A capture or merge refusal is the link's refusal: the transaction rolls back and the document is as it was.
      if (error instanceof TemplateContentError) throw operationFailure({ code: error.code === "INVALID_VALUE" ? "INVALID_STATE" : error.code, message: error.message, retryable: false });
      throw error;
    }
    const stored = (await rows<{ row: Record<string, unknown> }>(trx, "select to_jsonb(d.*) as row from erp.documents d where tenant_id = app.current_tenant() and id = $1::uuid", [documentId]))[0]?.row;
    return projectDocument(stored ?? {});
  });
  return { value };
};
