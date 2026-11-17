// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { ModuleOperationContext, RuntimeEntityValueCarrier } from "@openshapeforge/plugin-runtime";
import type { PublishFollowerContext } from "@openshapeforge/versioning/followers";
import type { MaterializedDocumentContent } from "./content/types.js";
import { contentImages, freezeTemplateImages, inclusionSourceVersions } from "./images.js";

const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const host = id(1), hostVersion = id(2), source = id(3), nestedSource = id(4), unrelated = id(5), documentId = id(6);
const image = (artifactId: string, sha256: string) => ({ artifactId, sha256, mediaType: "image/png", fileName: `${artifactId}.png` });
const INHERITED = id(21), NESTED = id(22), OWN = id(23);
const inherited = image(INHERITED, "a".repeat(64)), nested = image(NESTED, "b".repeat(64)), own = image(OWN, "c".repeat(64));
const carrier = { definitionColumn: "definition_key", definitions: {
  ImageBlock: { fields: [{ key: "image" }], references: [] },
  TemplateBlock: { fields: [{ key: "parameters", valueFieldsFrom: { reference: "version", headEntity: "Template" } }], references: [{ fieldKey: "version", column: "template_version_id" }] },
} } as unknown as RuntimeEntityValueCarrier;

/** A host template that shows its own upload and holds an inclusion, with another inclusion nested in that copy. */
const snapshot = { schemaVersion: 1, entity: "Template", head: { table: "templates", row: { id: host }, children: { template_variants: [{ table: "template_variants", row: { id: id(7) }, children: { blocks: [
  { table: "blocks", row: { definition_key: "ImageBlock", values: { image: own } }, children: {} },
  { table: "blocks", row: { definition_key: "TemplateBlock", template_version_id: source, values: { content: { source: [], blocks: [
    { id: "cover", definitionKey: "ImageBlock", schemaVersion: 1, values: { image: inherited } },
    { id: "inner", definitionKey: "TemplateBlock", schemaVersion: 1, references: { version: { entity: "TemplateVersion", id: nestedSource } }, values: { content: { source: [], blocks: [{ id: "deep", definitionKey: "ImageBlock", schemaVersion: 1, values: { image: nested } }] } } },
  ] } } }, children: {} },
] } }] } } };

type Frozen = { id: string; template_version_id: string; artifact_id: string; sha256: string; media_type: string; file_name: string; data: string };
function frozenStore(rows: Frozen[]) {
  return { rows, trx: { async executeQuery(query: { sql: string; parameters: unknown[] }) {
    const { sql, parameters } = query;
    if (sql.startsWith("select id from erp.template_version_images")) {
      const versions = JSON.parse(String(parameters[2])) as string[];
      return { rows: rows.filter((row) => row.artifact_id === parameters[0] && row.sha256 === parameters[1] && versions.includes(row.template_version_id)).slice(0, 1) };
    }
    if (sql.includes("select gen_random_uuid()")) { const from = rows.find((row) => row.id === parameters[1])!; rows.push({ ...from, id: `copy-${rows.length}`, template_version_id: String(parameters[0]) }); return { rows: [] }; }
    if (sql.startsWith("insert into erp.template_version_images")) { rows.push({ id: `own-${rows.length}`, template_version_id: String(parameters[0]), artifact_id: String(parameters[1]), sha256: String(parameters[2]), media_type: String(parameters[3]), file_name: String(parameters[4]), data: String(parameters[5]) }); return { rows: [] }; }
    if (sql.startsWith("select distinct on (artifact_id)")) {
      const versions = JSON.parse(String(parameters[0])) as string[], wanted = JSON.parse(String(parameters[1])) as [string, string][];
      return { rows: rows.filter((row) => versions.includes(row.template_version_id) && wanted.some(([artifact, hash]) => artifact === row.artifact_id && hash === row.sha256)) };
    }
    throw new Error(`Unexpected statement: ${sql}`);
  } } };
}
const frozenRow = (version: string, value: ReturnType<typeof image>, data: string): Frozen => ({ id: `${version}-${value.artifactId}`, template_version_id: version, artifact_id: value.artifactId, sha256: value.sha256, media_type: value.mediaType, file_name: value.fileName, data });

describe("the source versions of a frozen template's inclusions", () => {
  test("come from the typed reference of each inclusion, at any depth, and from nowhere else", () => {
    expect(inclusionSourceVersions(snapshot, carrier).sort()).toEqual([source, nestedSource].sort());
    expect(inclusionSourceVersions({ note: unrelated, template_version_id: unrelated }, carrier)).toEqual([]);
  });
});

describe("freezing the images of a published template", () => {
  function publish(store: ReturnType<typeof frozenStore>, files: Record<string, { sha256: string }>) {
    const reads: string[] = [];
    const context = { transaction: store.trx, sourceId: host, version: { id: hostVersion, snapshot }, session: {}, platform: {
      schemas: { entityValues: { get: () => carrier } },
      artifacts: { async read(_session: unknown, request: { artifactId: string; owner: { entity: string; id: string } }) {
        reads.push(`${request.owner.entity}:${request.owner.id}:${request.artifactId}`);
        const file = files[request.artifactId];
        if (!file) throw new Error("not a file of this template");
        return { descriptor: { sha256: file.sha256, mediaType: "image/png" }, bytes: new Uint8Array([1, 2, 3]) };
      } },
    } } as unknown as PublishFollowerContext;
    return { reads, done: freezeTemplateImages(context) };
  }

  test("copies an inherited image from the frozen images of its exact source version and reads only the host's own upload", async () => {
    const store = frozenStore([frozenRow(source, inherited, "INHERITED"), frozenRow(nestedSource, nested, "NESTED")]);
    const { reads, done } = publish(store, { [OWN]: { sha256: own.sha256 } });
    await done;
    // The inherited images were never read as files of the host, and no file was bound to it.
    expect(reads).toEqual([`Template:${host}:${OWN}`]);
    const held = store.rows.filter((row) => row.template_version_id === hostVersion);
    expect(held.map((row) => [row.artifact_id, row.sha256, row.data]).sort()).toEqual([[INHERITED, inherited.sha256, "INHERITED"], [NESTED, nested.sha256, "NESTED"], [OWN, own.sha256, "AQID"]]);
  });

  test("refuses an image that is neither frozen under that hash in a named source version nor a file of the host", async () => {
    // Bytes frozen for another version, or under another hash, are not the provenance this content names.
    for (const rows of [[frozenRow(unrelated, inherited, "ELSEWHERE"), frozenRow(nestedSource, nested, "NESTED")], [frozenRow(source, { ...inherited, sha256: "d".repeat(64) }, "OTHER BYTES"), frozenRow(nestedSource, nested, "NESTED")]]) {
      const store = frozenStore(rows);
      await expect(publish(store, { [OWN]: { sha256: own.sha256 } }).done).rejects.toMatchObject({ operationError: { code: "INVALID_STATE" } });
      expect(store.rows.some((row) => row.template_version_id === hostVersion && row.artifact_id === INHERITED)).toBe(false);
    }
  });
});

describe("reading the images of a document", () => {
  test("serves a copy's images from its exact source version without any template access, matched by hash", async () => {
    const store = frozenStore([frozenRow(source, inherited, "INHERITED"), frozenRow(unrelated, nested, "ELSEWHERE"), frozenRow(source, { ...own, sha256: "e".repeat(64) }, "STALE")]);
    const reads: string[] = [];
    const context = { session: { tenantId: id(9) }, platform: {
      db: { withSession: (_session: unknown, work: (trx: unknown) => unknown) => work(store.trx) },
      artifacts: { async read(_session: unknown, request: { artifactId: string; owner: { entity: string; id: string } }) {
        reads.push(`${request.owner.entity}:${request.owner.id}:${request.artifactId}`);
        if (request.artifactId !== OWN) throw new Error("FORBIDDEN");
        return { descriptor: { sha256: own.sha256, mediaType: "image/png" }, bytes: new Uint8Array([1, 2, 3]) };
      } },
    } } as unknown as ModuleOperationContext;
    const content = { templates: [], compositions: [{ path: ["slot"], templateReference: { entity: "TemplateVersion", id: source } }],
      blocks: [{ values: { image: inherited } }, { values: { image: own } }] } as unknown as MaterializedDocumentContent;
    const images = await contentImages(context, content, [], { entity: "Document", id: documentId });
    expect(images.map((entry) => [entry.artifactId, entry.data])).toEqual([[INHERITED, "INHERITED"], [OWN, "AQID"]]);
    // Only the document's own upload was read as a file, and as a file of the document. The stale frozen bytes did not stand in for it.
    expect(reads).toEqual([`Document:${documentId}:${OWN}`]);
    // An image frozen only for a version this content does not come from is not reachable through it.
    const foreign = { ...content, blocks: [{ values: { image: nested } }] } as unknown as MaterializedDocumentContent;
    await expect(contentImages(context, foreign, [], { entity: "Document", id: documentId })).rejects.toThrow("FORBIDDEN");
  });
});
