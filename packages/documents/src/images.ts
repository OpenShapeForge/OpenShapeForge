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
import type { ModuleOperationContext, ModuleOperationHandler, PluginPlatformServices, PluginSessionContext } from "@openshapeforge/plugin-runtime";
import type { PublishFollowerContext } from "@openshapeforge/versioning/followers";
import { contextServices, rows } from "./commands.js";
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

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

async function readFile(platform: PluginPlatformServices, session: PluginSessionContext, image: ImageValue, owner: { entity: string; id: string }): Promise<ImageData> {
  const contents = await platform.artifacts.read(session, { artifactId: image.artifactId, owner });
  if (contents.descriptor.sha256 !== image.sha256) refuse("INVALID_STATE", `The image "${image.fileName}" no longer matches its file.`);
  return { artifactId: image.artifactId, mediaType: contents.descriptor.mediaType, fileName: image.fileName, data: base64(contents.bytes) };
}

/** The frozen images of these template versions, by file. */
async function frozenImages(trx: unknown, versionIds: readonly string[], artifactIds: readonly string[]): Promise<Map<string, ImageData>> {
  if (!versionIds.length || !artifactIds.length) return new Map();
  const found = await rows<{ artifact_id: string; media_type: string; file_name: string; data: string }>(trx,
    `select distinct on (artifact_id) artifact_id, media_type, file_name, data from erp.template_version_images
      where tenant_id = app.current_tenant()
        and template_version_id in (select jsonb_array_elements_text($1::text::jsonb)::uuid)
        and artifact_id in (select jsonb_array_elements_text($2::text::jsonb))`,
    [JSON.stringify(versionIds), JSON.stringify(artifactIds)]);
  return new Map(found.map((row) => [row.artifact_id, { artifactId: row.artifact_id, mediaType: row.media_type, fileName: row.file_name, data: row.data }]));
}

/**
 * The bytes of every image in materialized content. A template's image comes
 * from the frozen images of the version it was materialized from; anything
 * else is a file of the record whose content this is (the document, or the
 * template whose head is shown).
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
  const versions = content.templates.map((template) => template.version.id);
  const frozen = await platform.db.withSession(session, (trx) => frozenImages(trx, versions, [...wanted.keys()]));
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
      if (!IMAGE_TYPES.has(bound.mediaType)) refuse("VALIDATION", "Upload a PNG, JPEG, WebP or SVG image.");
      if (bound.byteSize > MAX_IMAGE_BYTES) refuse("VALIDATION", "An image may be at most 5 MB.");
      return bound;
    });
    const value: ImageValue = { artifactId: descriptor.artifactId, sha256: descriptor.sha256, mediaType: descriptor.mediaType, fileName: descriptor.fileName };
    return { value };
  };
}

export const addTemplateImage = addImage("Template", "templates");
export const addDocumentImage = addImage("Document", "documents");

/**
 * Template.publish follower: freeze the bytes of every image the new version
 * uses. The publisher can read the template's files; a document later reads
 * the frozen copy through its pinned version, whatever its reader may do.
 */
export async function freezeTemplateImages(context: PublishFollowerContext): Promise<void> {
  const { transaction, platform, session, sourceId, version } = context;
  const images = imageValuesIn(version.snapshot);
  if (!images.size) return;
  for (const image of images.values()) {
    let contents: Awaited<ReturnType<PluginPlatformServices["artifacts"]["read"]>>;
    try {
      contents = await platform.artifacts.read(session, { artifactId: image.artifactId, owner: { entity: "Template", id: sourceId } });
    } catch {
      throw operationFailure({ code: "INVALID_STATE", message: `The image "${image.fileName}" is not a file of this template; upload it again.`, retryable: false });
    }
    if (contents.descriptor.sha256 !== image.sha256) refuse("INVALID_STATE", `The image "${image.fileName}" no longer matches its file.`);
    const data = { mediaType: contents.descriptor.mediaType, data: base64(contents.bytes) };
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
  const extra = imageValuesIn([...page, ...content.templates.map((template) => template.version.variants[0]?.page ?? null)]).values();
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
