// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { projectFrozenDefinitionFields } from "./frozen-field-definitions.js";
import type { GeneratedCrudTable } from "./types.js";

const head = { columns: [
  { name: "variable_defs", sourceField: "parameters", type: "jsonb" },
  { name: "private_defs", sourceField: "privateParameters", type: "jsonb", fieldPolicy: { readRoles: ["Secret.Read"] } },
], source: { authorization: { roles: { read: ["Read"], create: [], update: [], delete: [] } } } } as unknown as GeneratedCrudTable;
const viewer = { tenantId: "tenant-a", userId: "person-a", roles: ["Read"] } as any;
const bindings = new Map([["parameters", "variable_defs"], ["privateParameters", "private_defs"]]);

test("frozen definitions use logical field names and respect field read policy", () => {
  const definitions = [{ key: "name", osfType: "string" }];
  const raw = { variable_defs: definitions, private_defs: [{ key: "secret" }] };
  expect(projectFrozenDefinitionFields(head, raw, bindings, viewer)).toEqual({ parameters: definitions });
  expect(projectFrozenDefinitionFields(head, raw, bindings, { ...viewer, roles: ["Read", "Secret.Read"] })).toEqual({ parameters: definitions, privateParameters: [{ key: "secret" }] });
  expect(projectFrozenDefinitionFields(head, { variable_defs: null }, bindings, viewer)).toEqual({ parameters: [] });
  expect(projectFrozenDefinitionFields(head, { variable_defs: "bad" }, bindings, viewer)).toEqual({});
  expect(projectFrozenDefinitionFields(head, {}, bindings, viewer)).toEqual({});
  expect(projectFrozenDefinitionFields(head, raw, new Map([["wrongName", "variable_defs"]]), viewer)).toEqual({});
});

test("version projection requires the matching visible owner and never changes the snapshot", async () => {
  const { withFrozenFieldDefinitions } = await import("./frozen-field-definitions.js");
  const { operationFailure } = await import("@openshapeforge/operations");
  const version = { source: { authoringEntityName: "NoteVersion" }, columns: [{ name: "snapshot", sourceField: "snapshot", type: "jsonb" }] } as unknown as GeneratedCrudTable;
  const owner = { ...head, name: "notes", source: { ...head.source!, authoringEntityName: "Note", versioning: { versionEntity: "NoteVersion" } } } as unknown as GeneratedCrudTable;
  const carrier = { definitions: { Fragment: { fields: [{ valueFieldsFrom: { reference: "version", field: "parameters", snapshotColumn: "variable_defs", headEntity: "Note" } }], references: [{ fieldKey: "version", targetEntity: "NoteVersion" }] } } };
  const data = { snapshot: { schemaVersion: 1, entity: "Note", head: { row: { id: "owner-1", variable_defs: [{ key: "name" }] } } } } as any;
  let readTenant = "";
  const deps = { tables: () => [owner], carriers: () => [carrier], requireRead: () => {}, recordPermission: async () => {}, read: async (_db: unknown, session: any) => { readTenant = session.tenantId; return session.tenantId === "tenant-a" ? { id: "owner-1" } : null; } } as any;
  const visible = await withFrozenFieldDefinitions({} as any, viewer, version, data, deps);
  expect(visible.frozenFieldDefinitions).toEqual({ parameters: [{ key: "name" }] });
  expect(visible.snapshot).toBe(data.snapshot);
  expect(readTenant).toBe("tenant-a");
  expect(await withFrozenFieldDefinitions({} as any, { ...viewer, tenantId: "tenant-b" }, version, data, deps)).toEqual(data);
  expect(await withFrozenFieldDefinitions({} as any, viewer, version, data, { ...deps, requireRead: () => { throw operationFailure({ code: "FORBIDDEN", message: "denied" }); } })).toEqual(data);
  expect(await withFrozenFieldDefinitions({} as any, viewer, version, { snapshot: { ...data.snapshot, entity: "Other" } }, deps)).not.toHaveProperty("frozenFieldDefinitions");
});
