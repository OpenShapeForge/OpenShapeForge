// SPDX-License-Identifier: BUSL-1.1
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileAuthoringBackendManifest } from "./backend-manifest.js";
import type { CoreEntity, Field } from "./types.js";
import type { CompiledEntityInfo } from "../plugins.js";
export const native = (action: "insert" | "move") => ({
  name: action,
  description: action,
  implementation: { type: "collection" as const, action, field: "children" },
  effects: { data: "write" as const, external: "none" as const },
  reliability: { idempotency: { mode: "none" as const } },
  confirmation: { mode: "none" as const },
  concurrency: {
    version: { mode: "required" as const, field: "updatedAt" as const },
  },
});
export function entity(name: string, fields: Field[]): CoreEntity {
  return {
    schemaVersion: 3,
    kind: "coreEntity",
    module: "core",
    entity: name,
    title: name,
    labels: { en: name, nl: name },
    language: "en",
    domains: ["example"],
    baseEntity: false,
    authorization: {
      roles: {
        read: ["Example.Read"],
        create: ["Example.Create"],
        update: ["Example.Update"],
      },
    },
    fields: [
      {
        key: "id",
        osfType: "string",
        required: true,
        validation: { format: "uuid" },
        persisted: { column: "id", storageClass: "core" },
      },
      {
        key: "updatedAt",
        osfType: "datetime",
        readOnly: true,
        required: true,
        persisted: { column: "updated_at", storageClass: "core" },
      },
      ...fields,
    ],
    operations: Object.fromEntries(
      ["list", "get", "create", "update"].map((action) => [
        action,
        {
          name: action,
          description: action,
          implementation: { type: "entity", action },
          effects: {
            data: ["get", "list"].includes(action) ? "read" : "write",
            external: "none",
          },
          reliability: {
            idempotency: {
              mode: ["get", "list"].includes(action) ? "natural" : "none",
            },
          },
          confirmation: { mode: "none" },
          ...(action === "update"
            ? {
                concurrency: {
                  version: { mode: "required", field: "updatedAt" },
                },
              }
            : {}),
        },
      ]),
    ),
    interfaces: {
      rest: {},
      graphql: {},
      mcp: { tools: "generic" },
      web: {
        views: {
          collection: {
            route: `/${name.toLowerCase()}s`,
            title: { en: name, nl: name },
            columns: [{ key: "id" }],
          },
        },
      },
    },
  } as CoreEntity;
}
export function fixture(
  mutate: (owner: CoreEntity, child: CoreEntity) => void = () => {},
  extra: CoreEntity[] = [],
  onManifest?: (
    manifest: ReturnType<typeof compileAuthoringBackendManifest>,
  ) => void,
): CompiledEntityInfo[] {
  const owner = entity("Owner", []);
  Object.assign(owner.operations!, {
    insertChild: native("insert"),
    moveChild: native("move"),
  });
  const child = entity("Child", [
    {
      key: "owner",
      osfType: "Owner",
      required: true,
      relationship: {
        inverse: { key: "children", ownership: "owned", sortable: true },
      },
    },
    {
      key: "body",
      osfType: "string",
      required: true,
      validation: { maxLength: 12 },
      persisted: { column: "body", storageClass: "core" },
    },
  ]);
  mutate(owner, child);
  const dir = mkdtempSync(join(tmpdir(), "native-collections-"));
  const entries: CompiledEntityInfo[] = [];
  try {
    mkdirSync(join(dir, "entities"));
    mkdirSync(join(dir, "catalogs"));
    for (const [file, value] of Object.entries({
      "catalogs/components.yaml": {
        defaults: {},
        components: {},
        viewDefaults: {},
      },
      "catalogs/transforms.yaml": { transforms: {} },
      "catalogs/osf-types.yaml": {
        types: { entityValue: { kind: "object", baseType: "object" } },
      },
      "entities/owner.yaml": owner,
      "entities/child.yaml": child,
      ...Object.fromEntries(
        extra.map((entity) => [
          `entities/${entity.entity.toLowerCase()}.yaml`,
          entity,
        ]),
      ),
    })) {
      writeFileSync(join(dir, file), JSON.stringify(value));
    }
    const manifest = compileAuthoringBackendManifest(dir, {
      mode: "promote",
      entityAllowlist: [
        "owner",
        "child",
        ...extra.map((entity) => entity.entity.toLowerCase()),
      ],
      generatedCrudAllowlist: [
        "owner",
        "child",
        ...extra.map((entity) => entity.entity.toLowerCase()),
      ],
      onCandidate: (candidate) => entries.push(candidate as CompiledEntityInfo),
    });
    onManifest?.(manifest);
    return entries;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
