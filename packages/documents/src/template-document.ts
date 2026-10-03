// SPDX-License-Identifier: BUSL-1.1
import { createHash } from "node:crypto";
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationHandler, RuntimeOperationDefinition } from "@openshapeforge/plugin-runtime";
import { contextServices } from "./commands.js";
import { canonicalJson, hashCanonicalJson, immutableContent } from "./content/json.js";

export type TemplateDocumentResult = Readonly<{
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

function fail(code: string, message: string): never {
  throw operationFailure({ code, message, retryable: false });
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("VALIDATION", `${name} must be an object.`);
  return value as Record<string, unknown>;
}
function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail("VALIDATION", `${name} must be a UUID.`);
  return value;
}

/** Persist the exact logical content through the existing immutable version/artifact lifecycle. */
export const createDocumentFromTemplate: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  if (!session.tenantId) fail("UNAUTHENTICATED", "Creating template content requires a tenant session.");
  const allowed = new Set(["templateVersionId", "channel", "locale", "parameters", "document", "documentId", "version", "idempotencyKey"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) fail("VALIDATION", "Unknown template document input.");
  const templateVersionId = uuid(input.templateVersionId, "templateVersionId");
  if (typeof input.channel !== "string" || !["document", "email", "whatsapp"].includes(input.channel)) fail("VALIDATION", "Unsupported template channel.");
  if (typeof input.locale !== "string" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(input.locale)) fail("VALIDATION", "Invalid template locale.");
  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) fail("VALIDATION", "idempotencyKey is required and limited to 200 characters.");
  if (Object.hasOwn(input, "document") === Object.hasOwn(input, "documentId")) fail("VALIDATION", "Supply document metadata or documentId, not both.");
  const existingDocumentId = Object.hasOwn(input, "documentId") ? uuid(input.documentId, "documentId") : undefined;
  const version = immutableContent(object(input.version, "version"));
  const document = existingDocumentId ? undefined : immutableContent(object(input.document, "document"));
  const parameters = input.parameters === undefined ? undefined : immutableContent(object(input.parameters, "parameters"));
  const definitions = await platform.operations.list(session);
  const canonical = (entity: string, intent: "create" | "get"): RuntimeOperationDefinition => {
    const matches = definitions.filter((operation) => operation.entityName === entity && operation.intent === intent);
    if (matches.length !== 1) fail("OPERATION_UNAVAILABLE", `No unambiguous accessible ${entity} ${intent} Operation.`);
    return matches[0]!;
  };
  const create = canonical(existingDocumentId ? "DocumentVersion" : "Document", "create");
  const getVersion = canonical("DocumentVersion", "get");
  const materialize = await platform.operations.get(session, "TemplateVersion.materialize");
  if (!materialize || materialize.effects.data !== "read" || materialize.effects.external !== "none") fail("OPERATION_UNAVAILABLE", "The canonical template materialization Operation is unavailable.");
  if (create.effects.data !== "write" || create.effects.external !== "none" || getVersion.effects.data !== "read" || getVersion.effects.external !== "none") fail("OPERATION_UNAVAILABLE", "The document lifecycle has incompatible effects.");
  const execute = async (operation: RuntimeOperationDefinition, values: Record<string, unknown>, idempotencyKey?: string) => {
    const result = await platform.operations.execute(session, { operation, input: values, ...(idempotencyKey ? { idempotencyKey } : {}) });
    if ("error" in result) throw operationFailure(result.error);
    return object(result.data, "Operation result");
  };
  const nestedKey = createHash("sha256").update(`template-document-v1\n${input.idempotencyKey}`).digest("hex");
  const createInput = { ...(existingDocumentId ? { documentId: existingDocumentId } : { document }), version, idempotencyKey: nestedKey };
  if (create.input.kind !== "json-schema") fail("OPERATION_UNAVAILABLE", "Document creation requires its canonical input schema.");
  const valid = platform.schemas.json.validate(object(create.input.schema, "Document input schema"), createInput);
  if (!valid.valid) throw operationFailure(valid.error);

  // Core's write Operation wrapper supplies the ambient transaction. Every nested
  // canonical dispatch and artifact bind must reuse it; no plugin transaction runtime.
  const value = await platform.db.withSession(session, async () => {
    if (existingDocumentId) await platform.records.assertAccess(session, { entityName: "Document", id: existingDocumentId, intent: "update" });
    const snapshot = immutableContent(await execute(materialize!, {
      templateVersionId, channel: input.channel, locale: input.locale, ...(parameters ? { parameters } : {}),
    }));
    if (snapshot.schemaVersion !== 1 || snapshot.tenantId !== session.tenantId || snapshot.templateVersionId !== templateVersionId || snapshot.channel !== input.channel || snapshot.locale !== input.locale || typeof snapshot.compositionHash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.compositionHash)) fail("HANDLER_CONTRACT_VIOLATION", "Materialization returned another content identity.");
    const { compositionHash, ...content } = snapshot;
    if (content.compositionHashVersion !== "osf-template-content-v1" || await hashCanonicalJson(content, content.compositionHashVersion) !== compositionHash) fail("HANDLER_CONTRACT_VIOLATION", "The materialized content fingerprint does not match its frozen sources.");
    const bytes = new TextEncoder().encode(canonicalJson(snapshot));
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const artifact = await platform.artifacts.stage(session, {
      purpose: "document-materialization",
      fileName: `template-${templateVersionId}-${snapshot.compositionHash}.json`,
      source: (async function* () { yield bytes; })(),
    });
    if (artifact.mediaType !== "application/json" || artifact.sha256 !== checksum || artifact.byteSize !== bytes.byteLength) fail("HANDLER_CONTRACT_VIOLATION", "Storage did not verify the exact JSON snapshot bytes.");
    const created = await execute(create, { ...createInput, artifact: { artifactId: artifact.artifactId, expectedArtifactVersion: artifact.version } }, nestedKey);
    const documentId = existingDocumentId ?? uuid(created.id, "created document id");
    const documentVersionId = uuid(existingDocumentId ? created.id : created.currentVersionId, "created document version id");
    const stored = await execute(getVersion, { id: documentVersionId });
    if (stored.id !== documentVersionId || stored.documentId !== documentId || stored.artifactId !== artifact.artifactId || !Number.isSafeInteger(stored.artifactVersion) || (stored.artifactVersion as number) < artifact.version || stored.checksum !== checksum || stored.mimeType !== "application/json" || stored.byteSize !== bytes.byteLength || stored.fileName !== artifact.fileName) fail("HANDLER_CONTRACT_VIOLATION", "The created DocumentVersion did not bind the materialized artifact.");
    return {
      documentId, documentVersionId, artifactId: artifact.artifactId, artifactVersion: stored.artifactVersion as number,
      fileName: artifact.fileName, mediaType: "application/json", checksum, byteSize: bytes.byteLength, compositionHash: snapshot.compositionHash,
    } satisfies TemplateDocumentResult;
  });
  return { value, status: 201 };
};
