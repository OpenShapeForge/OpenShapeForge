// SPDX-License-Identifier: BUSL-1.1
/**
 * The registry the record-action lookup is compiled from, without a database.
 *
 * Everything this module interpolates into DDL comes from the manifest, so
 * these tests cover the two things that matter before any SQL runs: that a
 * manifest which cannot be deployed safely stops the migration, and that the
 * rendered body is a fixed `case` over the declared entities — deterministic,
 * with no caller-controlled identifier anywhere in it.
 */
import { describe, expect, test } from "bun:test";
import {
  recordActionEntities,
  renderRecordActionLookup,
  renderRecordActionProjection,
  type ManifestRecordActionTable,
  type RecordActionEntity,
} from "./record-actions.js";

type Table = ManifestRecordActionTable;

function table(overrides: Partial<Table> = {}): Table {
  return {
    schema: "erp", name: "runs", tenantScoped: true,
    columns: [
      { name: "id", type: "uuid", primaryKey: true },
      { name: "tenant_id", type: "uuid" },
      { name: "acl", type: "jsonb" },
      { name: "definition", type: "text" },
    ],
    source: {
      authoringEntityName: "Run",
      authorization: {
        recordPermissions: {
          column: "acl",
          actions: [{ name: "start", principals: ["integration"], reads: ["definition"] }],
        },
      },
    },
    ...overrides,
  } as Table;
}

/** Replace the policy of the default table, keeping everything else valid. */
function withPolicy(policy: unknown): Table {
  const base = table();
  return {
    ...base,
    source: { ...base.source, authorization: { recordPermissions: policy } },
  } as Table;
}

describe("the record-action registry", () => {
  test("ignores every entity that did not declare an action", () => {
    expect(recordActionEntities([
      { ...table(), source: { authoringEntityName: "Run" } } as Table,
      withPolicy({ column: "acl" }),
      withPolicy({ column: "acl", actions: [] }),
    ])).toEqual([]);
  });

  test("resolves the key, the ACL column and each action's read columns", () => {
    expect(recordActionEntities([table()])).toEqual([{
      entity: "Run", schema: "erp", table: "runs",
      keyColumn: "id", keyIsUuid: true, aclColumn: "acl",
      actions: ["start"],
      reads: { start: [{ field: "definition", column: "definition" }] },
    }]);
  });

  test("maps a read field through the column's authored name", () => {
    const [entity] = recordActionEntities([{
      ...table(),
      columns: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "tenant_id", type: "uuid" },
        { name: "acl", type: "jsonb" },
        { name: "run_definition", type: "text" },
      ],
      source: {
        authoringEntityName: "Run",
        authorization: {
          recordPermissions: {
            column: "acl",
            actions: [{ name: "start", principals: ["integration"], reads: ["runDefinition"] }],
          },
        },
      },
    } as Table]);
    expect(entity!.reads.start).toEqual([{ field: "runDefinition", column: "run_definition" }]);
  });

  test("refuses a manifest it cannot deploy safely", () => {
    const refusals: Array<[Table, RegExp]> = [
      [{ ...table(), tenantScoped: false }, /requires a tenant-scoped table/],
      [{ ...table(), schema: "Erp" }, /not a plain lowercase identifier/],
      [{ ...table(), name: "runs; drop table x" }, /not a plain lowercase identifier/],
      [
        { ...table(), source: { ...table().source, authoringEntityName: "run" } } as Table,
        /no usable authoring entity name/,
      ],
      [withPolicy({ column: "Acl", actions: [{ name: "start", principals: ["integration"] }] }),
        /ACL column "Acl" is not a plain lowercase identifier/],
      [withPolicy({ column: "missing", actions: [{ name: "start", principals: ["integration"] }] }),
        /is not a column of this table/],
      [withPolicy({ column: "acl", actions: [{ name: "view", principals: ["integration"] }] }),
        /not a lowerCamel name outside view\/edit\/delete/],
      [withPolicy({ column: "acl", actions: [{ name: "Start", principals: ["integration"] }] }),
        /not a lowerCamel name outside view\/edit\/delete/],
      [
        withPolicy({
          column: "acl",
          actions: [{ name: "start", principals: ["integration"], reads: ["acl"] }],
        }),
        /may not read "acl"/,
      ],
      [
        withPolicy({
          column: "acl",
          actions: [{ name: "start", principals: ["integration"], reads: ["tenantId"] }],
        }),
        /may not read "tenantId"/,
      ],
      [
        withPolicy({
          column: "acl",
          actions: [{ name: "start", principals: ["integration"], reads: ["absent"] }],
        }),
        /is not a plain column of this table/,
      ],
      [
        {
          ...table(),
          columns: [{ name: "tenant_id", type: "uuid" }, { name: "acl", type: "jsonb" }],
        } as Table,
        /no single plain-identifier primary key/,
      ],
      [
        {
          ...table(),
          columns: [{ name: "id", type: "uuid", primaryKey: true }, { name: "acl", type: "jsonb" }],
        } as Table,
        /no tenant_id column to fence on/,
      ],
    ];
    for (const [input, pattern] of refusals) {
      expect(() => recordActionEntities([input])).toThrow(pattern);
    }
  });

  test("orders entities and actions so the rendered body is deterministic", () => {
    const second = {
      ...table(), name: "docs",
      source: {
        authoringEntityName: "Doc",
        authorization: {
          recordPermissions: {
            column: "acl",
            actions: [
              { name: "publish", principals: ["person"] },
              { name: "archive", principals: ["person"] },
            ],
          },
        },
      },
    } as Table;
    const forward = recordActionEntities([table(), second]);
    const reversed = recordActionEntities([second, table()]);
    expect(forward).toEqual(reversed);
    expect(forward.map((entity) => entity.entity)).toEqual(["Doc", "Run"]);
    expect(forward[0]!.actions).toEqual(["archive", "publish"]);
    expect(renderRecordActionLookup(forward)).toBe(renderRecordActionLookup(reversed));
  });
});

describe("the rendered lookup", () => {
  const entities = recordActionEntities([table()]);

  test("is a fixed case over the declared entities and their declared actions", () => {
    const body = renderRecordActionLookup(entities);
    expect(body).toContain("case entity");
    expect(body).toContain("when 'Run' then");
    expect(body).toContain("if action not in ('start') then return false; end if;");
    expect(body).toContain("from erp.runs t");
    expect(body).toContain("t.tenant_id = app.current_tenant()");
    expect(body).toContain("for share");
    expect(body).toContain("else return false;");
    // No parameterized identifier: a caller cannot name a table or a column.
    expect(body).not.toContain("format(");
    expect(body).not.toContain("execute ");
    expect(body).not.toContain("bypass_rls");
  });

  test("guards a uuid key before casting, so a malformed key denies", () => {
    expect(renderRecordActionLookup(entities)).toContain("if record_key !~*");
    const textKeyed: RecordActionEntity[] = [{ ...entities[0]!, keyIsUuid: false }];
    expect(renderRecordActionLookup(textKeyed)).toContain("t.id::text = record_key");
    expect(renderRecordActionLookup(textKeyed)).not.toContain("record_key !~*");
  });

  test("denies everything when no entity declared an action", () => {
    expect(renderRecordActionLookup([])).toContain("return false;");
    expect(renderRecordActionLookup([])).not.toContain("case entity");
  });
});

describe("the rendered read projection", () => {
  test("names only the declared fields, keyed by entity and action", () => {
    const body = renderRecordActionProjection(recordActionEntities([table()]));
    expect(body).toContain("case entity || ':' || action");
    expect(body).toContain("when 'Run:start' then");
    expect(body).toContain("jsonb_build_object('definition', t.definition)");
    expect(body).toContain("else return null;");
    expect(body).not.toContain("t.acl");
    expect(body).not.toContain("tenant_id)");
  });

  test("an action with no declared reads has no branch", () => {
    const [entity] = recordActionEntities([
      withPolicy({ column: "acl", actions: [{ name: "follow", principals: ["integration"] }] }),
    ]);
    expect(entity!.reads).toEqual({});
    expect(renderRecordActionProjection([entity!])).toContain("return null;");
    expect(renderRecordActionProjection([entity!])).not.toContain("case entity");
  });
});
