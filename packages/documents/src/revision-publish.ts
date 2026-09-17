// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationHandler, RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { contextServices, rows } from "./commands.js";
import { canonicalJson, immutableContent } from "./content/json.js";
import { appendRecordEvent, withRevisionCommand } from "./revision-blocks.js";
import { materializeRevision } from "./revision-materialize.js";
import { readRevision } from "./revision-start.js";
import { object, refuse, uuid } from "./validation.js";

export type RevisionPublishResult = Readonly<{
  revisionId: string;
  documentId: string;
  documentVersionId: string;
  artifactId: string;
  artifactVersion: number;
  fileName: string;
  mediaType: "application/json";
  checksum: string;
  byteSize: number;
  compositionHash: string;
}>;

const PUBLISHABLE = new Set(["draft", "approved"]);
const TOUCH = "updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')";

/**
 * DocumentRevision.publish: materialize the revision's blocks, store the exact
 * JSON as an immutable artifact through the canonical DocumentVersion create
 * command, and point the document at this revision. Binary uploads and
 * published revisions share Document.versions. Only a draft or approved
 * revision publishes; a submitted or rejected one is still under review.
 */
export const publishRevision: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) refuse("UNAUTHENTICATED", "Publishing a revision requires a tenant session.");
  const allowed = new Set(["id", "version", "idempotencyKey"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) refuse("VALIDATION", "Unknown revision publish input.");
  const id = uuid(input.id, "id");
  const version = immutableContent(object(input.version, "version"));
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) refuse("VALIDATION", "idempotencyKey is required and limited to 200 characters.");
  const definitions = await platform.operations.list(session);
  const canonical = (entity: string, intent: "create" | "get"): RuntimeOperationDefinition => {
    const matches = definitions.filter((operation) => operation.entityName === entity && operation.intent === intent);
    if (matches.length !== 1) refuse("OPERATION_UNAVAILABLE", `No unambiguous accessible ${entity} ${intent} Operation.`);
    return matches[0]!;
  };
  const create = canonical("DocumentVersion", "create");
  const getVersion = canonical("DocumentVersion", "get");
  if (create.effects.data !== "write" || create.effects.external !== "none" || getVersion.effects.data !== "read" || getVersion.effects.external !== "none") refuse("OPERATION_UNAVAILABLE", "The document version lifecycle has incompatible effects.");
  if (create.input.kind !== "json-schema") refuse("OPERATION_UNAVAILABLE", "Document version creation requires its canonical input schema.");
  const execute = async (operation: RuntimeOperationDefinition, values: Record<string, unknown>, idempotencyKey?: string) => {
    const result = await platform.operations.execute(session, { operation, input: values, ...(idempotencyKey ? { idempotencyKey } : {}) });
    if ("error" in result) throw operationFailure(result.error);
    return object(result.data, "Operation result");
  };
  const nestedKey = createHash("sha256").update(`document-revision-v1\n${input.idempotencyKey}`).digest("hex");

  // Core's write Operation wrapper supplies the ambient transaction; nested
  // canonical dispatches and the artifact bind reuse it.
  const value = await platform.db.withSession(session, async (trx) => {
    const revision = await readRevision(trx, id, "update");
    if (!revision) refuse("NOT_FOUND", "The revision no longer exists.");
    if (!PUBLISHABLE.has(revision!.status)) refuse("INVALID_STATE", `A ${revision!.status} revision cannot be published.`);
    const documentId = revision!.document_id;
    await platform.records.assertAccess(session, { entityName: "Document", id: documentId, intent: "update" });
    // Publication is serialized per document: the pointer and supersede writes below need the row.
    const locked = await rows<{ id: string }>(trx, "select id from erp.documents where tenant_id = app.current_tenant() and id = $1::uuid for update", [documentId]);
    if (!locked.length) refuse("NOT_FOUND", "The document no longer exists.");
    const content = await materializeRevision(context, trx, revision!);
    const body = immutableContent({
      schemaVersion: 1 as const, kind: "document-revision" as const, revisionId: id, documentId,
      templateVersionId: revision!.template_version_id, channel: revision!.channel, locale: revision!.locale, content,
    });
    const bytes = new TextEncoder().encode(canonicalJson(body));
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const artifact = await platform.artifacts.stage(session, {
      purpose: "document-materialization",
      fileName: `revision-${id}-${content.compositionHash}.json`,
      source: (async function* () { yield bytes; })(),
    });
    if (artifact.mediaType !== "application/json" || artifact.sha256 !== checksum || artifact.byteSize !== bytes.byteLength) refuse("HANDLER_CONTRACT_VIOLATION", "Storage did not verify the exact JSON revision bytes.");
    const createInput = { documentId, version, idempotencyKey: nestedKey, artifact: { artifactId: artifact.artifactId, expectedArtifactVersion: artifact.version } };
    const valid = platform.schemas.json.validate(object(create.input.schema, "DocumentVersion input schema"), createInput);
    if (!valid.valid) throw operationFailure(valid.error);
    const created = await execute(create, createInput, nestedKey);
    const documentVersionId = uuid(created.id, "created document version id");
    const stored = await execute(getVersion, { id: documentVersionId });
    if (stored.id !== documentVersionId || stored.documentId !== documentId || stored.artifactId !== artifact.artifactId || !Number.isSafeInteger(stored.artifactVersion) || (stored.artifactVersion as number) < artifact.version || stored.checksum !== checksum || stored.mimeType !== "application/json" || stored.byteSize !== bytes.byteLength || stored.fileName !== artifact.fileName) refuse("HANDLER_CONTRACT_VIOLATION", "The created DocumentVersion did not bind the revision artifact.");
    await withRevisionCommand(trx, "publish", async () => {
      // Only the previously published revision of the same channel and locale is replaced.
      await rows(trx, `update erp.document_revisions set status = 'superseded', ${TOUCH}
        where tenant_id = app.current_tenant() and document_id = $1::uuid and status = 'published' and channel = $3::text and locale = $4::text and id <> $2::uuid`, [documentId, id, revision!.channel, revision!.locale]);
      await rows(trx, `update erp.document_revisions set status = 'published', published_version_id = $2::uuid, ${TOUCH} where tenant_id = app.current_tenant() and id = $1::uuid`, [id, documentVersionId]);
      await rows(trx, "update erp.documents set current_revision_id = $2::uuid, updated_at = now() where tenant_id = app.current_tenant() and id = $1::uuid", [documentId, id]);
    });
    await appendRecordEvent(platform, session, { aggregateType: "documentRevision", table: "document_revisions", id, operation: "updated" });
    await appendRecordEvent(platform, session, { aggregateType: "document", table: "documents", id: documentId, operation: "updated" });
    return {
      revisionId: id, documentId, documentVersionId, artifactId: artifact.artifactId, artifactVersion: stored.artifactVersion as number,
      fileName: artifact.fileName, mediaType: "application/json", checksum, byteSize: bytes.byteLength, compositionHash: content.compositionHash,
    } satisfies RevisionPublishResult;
  });
  return { value, status: 201 };
};
