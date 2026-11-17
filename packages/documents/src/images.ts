// SPDX-License-Identifier: BUSL-1.1
/**
 * Images of templates and documents.
 *
 * An image is a file of the record that uses it: Template.addImage keeps an
 * upload as a file of the template, Document.addImage as a file of the
 * document, and an `image` value in a block or page setting names that file
 * and its content hash. Publishing a template freezes the bytes of every image
 * its version uses (TemplateVersionImage), so a document reaches its template's
 * images the way it reaches the template's content, through its pinned
 * version, and keeps them when the template's image is replaced. A document's
 * own uploads are read as files of the document.
 */
import { operationFailure } from "@openshapeforge/operations";
import type { ModuleOperationContext, ModuleOperationHandler, PluginPlatformServices, PluginSessionContext, RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import type { PublishFollowerContext } from "@openshapeforge/versioning/followers";
import { contextServices, rows } from "./commands.js";
import { templateComposition } from "./content/inclusion-copy.js";
import type { MaterializedDocumentContent, MaterializedTemplateContent } from "./content/types.js";
import { isImageValue, type ImageValue } from "./page/html.js";
import { isObject, object, refuse, uuid } from "./validation.js";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);
/** Large enough for a full-page cover, small enough to inline in every page that shows it. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type ImageData = Readonly<{ artifactId: string; mediaType: string; fileName: string; data: string }>;

/** Every image value anywhere in a JSON value: block values, page settings, a frozen snapshot. */
export function imageValuesIn(value: unknown, found = new Map<string, ImageValue>()): Map<string, ImageValue> {
  if (isImageValue(value)) found.set(value.artifactId, value);
  else if (Array.isArray(value)) for (const item of value) imageValuesIn(item, found);
  else if (isObject(value)) for (const item of Object.values(value)) imageValuesIn(item, found);
  return found;
}

/**
 * Storage recognises SVG only as text, so it is never served as active content. An image value
 * says image/svg+xml only for text whose root element is <svg>, and it is only ever shown
 * through <img>, where an SVG runs no script.
 */
const SVG = /^\uFEFF?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
export function isSvgText(bytes: Uint8Array): boolean {
  try { return SVG.test(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, 4096))); } catch { return false; }
}
function imageMediaType(stored: string, image: ImageValue): string {
  return stored === "text/plain" && image.mediaType === "image/svg+xml" ? image.mediaType : stored;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

async function readFile(platform: PluginPlatformServices, session: PluginSessionContext, image: ImageValue, owner: { entity: string; id: string }): Promise<ImageData> {
  const contents = await platform.artifacts.read(session, { artifactId: image.artifactId, owner });
  if (contents.descriptor.sha256 !== image.sha256) refuse("INVALID_STATE", `The image "${image.fileName}" no longer matches its file.`);
  return { artifactId: image.artifactId, mediaType: imageMediaType(contents.descriptor.mediaType, image), fileName: image.fileName, data: base64(contents.bytes) };
}

/** The frozen images of these template versions, by file. Only bytes frozen under the hash the content names are returned. */
async function frozenImages(trx: unknown, versionIds: readonly string[], images: Iterable<ImageValue>): Promise<Map<string, ImageData>> {
  const wanted = [...images].map((image) => [image.artifactId, image.sha256]);
  if (!versionIds.length || !wanted.length) return new Map();
  const found = await rows<{ artifact_id: string; media_type: string; file_name: string; data: string }>(trx,
    `select distinct on (artifact_id) artifact_id, media_type, file_name, data from erp.template_version_images
      where tenant_id = app.current_tenant()
        and template_version_id in (select jsonb_array_elements_text($1::text::jsonb)::uuid)
        and (artifact_id, sha256) in (select pair->>0, pair->>1 from jsonb_array_elements($2::text::jsonb) pair)`,
    [JSON.stringify(versionIds), JSON.stringify(wanted)]);
  return new Map(found.map((row) => [row.artifact_id, { artifactId: row.artifact_id, mediaType: row.media_type, fileName: row.file_name, data: row.data }]));
}

/**
 * The template versions whose frozen images this content may show: the
 * version it is rooted in and the exact source version of every inclusion it
 * holds. Those ids are the server's own record — the pinned version and the
 * typed reference each captured copy was settled with — so this is the
 * content's provenance, never a lookup across the tenant's images.
 */
function imageSourceVersions(content: MaterializedDocumentContent | MaterializedTemplateContent): string[] {
  return [...new Set([...content.templates.map((template) => template.version.id), ...content.compositions.map((inclusion) => inclusion.templateReference.id)])];
}

/**
 * The bytes of every image in materialized content. An image that came with
 * a template — the document's own, or the source of an inclusion — is read
 * from the frozen images of that exact version, which needs no access to the
 * template; anything else is a file of the record whose content this is (the
 * document, or the template whose head is shown).
 */
export async function contentImages(
  context: ModuleOperationContext,
  content: MaterializedDocumentContent | MaterializedTemplateContent,
  extra: Iterable<ImageValue>,
  owner: { entity: "Document" | "Template"; id: string },
): Promise<ImageData[]> {
  const { platform, session } = contextServices(context);
  const wanted = imageValuesIn(content.blocks.map((block) => block.materialization?.result.kind === "block" ? block.materialization.result.value : block.values));
  for (const image of extra) wanted.set(image.artifactId, image);
  if (!wanted.size) return [];
  const frozen = await platform.db.withSession(session, (trx) => frozenImages(trx, imageSourceVersions(content), wanted.values()));
  const images: ImageData[] = [];
  for (const image of wanted.values()) {
    const kept = frozen.get(image.artifactId);
    images.push(kept ?? await readFile(platform, session, image, owner));
  }
  return images;
}

function addImage(entity: "Template" | "Document", table: string): ModuleOperationHandler {
  return async (input, context) => {
    const { platform, session } = contextServices(context);
    if (!session.tenantId) refuse("UNAUTHENTICATED", "Adding an image requires a tenant session.");
    const id = uuid(input.id, "id");
    const artifact = object(input.artifact, "artifact");
    const artifactId = uuid(artifact.artifactId, "artifact.artifactId");
    const expected = artifact.expectedArtifactVersion;
    if (!Number.isSafeInteger(expected) || (expected as number) < 1) refuse("VALIDATION", "artifact.expectedArtifactVersion must be a positive integer.");
    await platform.records.assertAccess(session, { entityName: entity, id, intent: "update" });
    const descriptor = await platform.db.withSession(session, async (trx) => {
      const found = await rows<{ id: string }>(trx, `select id from erp.${table} where tenant_id = app.current_tenant() and id = $1::uuid for share`, [id]);
      if (!found.length) refuse("NOT_FOUND", `The ${entity.toLowerCase()} does not exist.`);
      const bound = await platform.artifacts.bind(session, { artifactId, expectedArtifactVersion: expected as number, owner: { entity, id } });
      if (bound.byteSize > MAX_IMAGE_BYTES) refuse("VALIDATION", "An image may be at most 5 MB.");
      let mediaType = bound.mediaType;
      if (mediaType === "text/plain") {
        const contents = await platform.artifacts.read(session, { artifactId, owner: { entity, id } });
        if (isSvgText(contents.bytes)) mediaType = "image/svg+xml";
      }
      if (!IMAGE_TYPES.has(mediaType)) refuse("VALIDATION", "Upload a PNG, JPEG, WebP or SVG image.");
      return { ...bound, mediaType };
    });
    const value: ImageValue = { artifactId: descriptor.artifactId, sha256: descriptor.sha256, mediaType: descriptor.mediaType, fileName: descriptor.fileName };
    return { value };
  };
}

export const addTemplateImage = addImage("Template", "templates");
export const addDocumentImage = addImage("Document", "documents");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The source version of every inclusion a frozen template holds, at any
 * depth: the typed reference column of an inclusion's own row, and the
 * `{entity, id}` reference of an inclusion nested in a copy. Both were
 * settled by the server when the copy was captured.
 */
export function inclusionSourceVersions(snapshot: unknown, carrier: RuntimeEntityValueCarrier | undefined): string[] {
  const found = new Set<string>();
  const columns = new Map<string, string>();
  for (const [key, definition] of Object.entries(carrier?.definitions ?? {})) {
    const composition = templateComposition(definition.fields);
    const column = composition && definition.references.find((reference) => reference.fieldKey === composition.templateVersionField)?.column;
    if (column) columns.set(key, column);
  }
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!isObject(value)) return;
    if (value.entity === "TemplateVersion" && typeof value.id === "string" && UUID.test(value.id)) found.add(value.id);
    const column = carrier && typeof value[carrier.definitionColumn] === "string" ? columns.get(value[carrier.definitionColumn] as string) : undefined;
    if (column && typeof value[column] === "string" && UUID.test(value[column] as string)) found.add(value[column] as string);
    for (const item of Object.values(value)) walk(item);
  };
  walk(snapshot);
  return [...found];
}

/**
 * Template.publish follower: freeze the bytes of every image the new version
 * uses, so the version holds all of them itself. An image that came with an
 * inclusion is copied from the frozen images of that inclusion's exact source
 * version, under the hash the content names; it is never read as a file of
 * this template, and the source's file is never bound to it. Every other
 * image is a file of this template, which its publisher can read. A document
 * later reads the frozen copy through its pinned version, whatever its
 * reader may do.
 */
export async function freezeTemplateImages(context: PublishFollowerContext): Promise<void> {
  const { transaction, platform, session, sourceId, version } = context;
  const images = imageValuesIn(version.snapshot);
  if (!images.size) return;
  const sources = JSON.stringify(inclusionSourceVersions(version.snapshot, platform.schemas.entityValues?.get("Block", "values")).filter((id) => id !== version.id));
  for (const image of images.values()) {
    const inherited = await rows<{ id: string }>(transaction, `select id from erp.template_version_images
      where tenant_id = app.current_tenant() and artifact_id = $1 and sha256 = $2
        and template_version_id in (select jsonb_array_elements_text($3::text::jsonb)::uuid) limit 1`, [image.artifactId, image.sha256, sources]);
    if (inherited.length) {
      await rows(transaction, `insert into erp.template_version_images
          (id, tenant_id, template_version_id, artifact_id, sha256, media_type, file_name, data)
        select gen_random_uuid(), app.current_tenant(), $1::uuid, artifact_id, sha256, media_type, file_name, data
          from erp.template_version_images where tenant_id = app.current_tenant() and id = $2::uuid
        on conflict do nothing`, [version.id, inherited[0]!.id]);
      continue;
    }
    let contents: Awaited<ReturnType<PluginPlatformServices["artifacts"]["read"]>>;
    try {
      contents = await platform.artifacts.read(session, { artifactId: image.artifactId, owner: { entity: "Template", id: sourceId } });
    } catch {
      throw operationFailure({ code: "INVALID_STATE", message: `The image "${image.fileName}" is not a file of this template; upload it again.`, retryable: false });
    }
    if (contents.descriptor.sha256 !== image.sha256) refuse("INVALID_STATE", `The image "${image.fileName}" no longer matches its file.`);
    const data = { mediaType: imageMediaType(contents.descriptor.mediaType, image), data: base64(contents.bytes) };
    await rows(transaction, `insert into erp.template_version_images
        (id, tenant_id, template_version_id, artifact_id, sha256, media_type, file_name, data)
      values (gen_random_uuid(), app.current_tenant(), $1::uuid, $2, $3, $4, $5, $6)
      on conflict do nothing`,
      [version.id, image.artifactId, image.sha256, data.mediaType, image.fileName, data.data]);
  }
}

/** Document.images: the bytes of every image the document's content shows, for an editor that draws it itself. */
export const documentImages: ModuleOperationHandler = async (input, context) => {
  const { materializeDocument } = await import("./document-materialize.js");
  const materialized = await materializeDocument(input, context);
  const content = (materialized as { value: MaterializedDocumentContent | MaterializedTemplateContent }).value;
  const page = "page" in content && content.page ? [content.page] : [];
  const extra = imageValuesIn([...page, ...content.templates.map((template) => template.version.variants[0]?.page ?? null), ...content.compositions.map((inclusion) => inclusion.page ?? null)]).values();
  return { value: { images: await contentImages(context, content, extra, { entity: "Document", id: uuid(input.id, "id") }) } };
};

/**
 * Template.images: the bytes of the named images of a template's head, for its
 * editor. A file of the template is read as such; an image of an included
 * template comes from that template's published versions.
 */
export const templateImages: ModuleOperationHandler = async (input, context) => {
  const { platform, session } = contextServices(context);
  const id = uuid(input.id, "id");
  const list = Array.isArray(input.images) ? input.images : refuse("VALIDATION", "images must be a list.");
  if (list.length > 200) refuse("VALIDATION", "Ask for at most 200 images at once.");
  const wanted = imageValuesIn(list);
  await platform.records.assertAccess(session, { entityName: "Template", id, intent: "get" });
  const frozen = await platform.db.withSession(session, async (trx) => {
    const found = await rows<{ artifact_id: string; media_type: string; file_name: string; data: string }>(trx,
      `select distinct on (artifact_id) artifact_id, media_type, file_name, data from erp.template_version_images
        where tenant_id = app.current_tenant() and artifact_id in (select jsonb_array_elements_text($1::text::jsonb))`, [JSON.stringify([...wanted.keys()])]);
    return new Map(found.map((row) => [row.artifact_id, { artifactId: row.artifact_id, mediaType: row.media_type, fileName: row.file_name, data: row.data }]));
  });
  const images: ImageData[] = [];
  for (const image of wanted.values()) {
    const kept = frozen.get(image.artifactId);
    if (kept) { images.push(kept); continue; }
    try { images.push(await readFile(platform, session, image, { entity: "Template", id })); } catch { /* Not this template's file: left out, shown as missing. */ }
  }
  return { value: { images } };
};
