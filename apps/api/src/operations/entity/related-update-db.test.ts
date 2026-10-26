// SPDX-License-Identifier: BUSL-1.1
import { beforeAll, afterAll, test, expect, describe } from "bun:test";
import { SQL } from "bun";
import { sql } from "kysely";
import {
  createDatabaseRuntime,
  type DatabaseRuntime,
} from "../../db/connection.js";
import { applyRelatedChanges } from "./related-update.js";
import type { GeneratedCrudTable } from "./types.js";
const url =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const name = "related_" + crypto.randomUUID().replaceAll("-", "");
let admin: SQL, runtime: DatabaseRuntime;
const tenant = crypto.randomUUID(),
  parent = crypto.randomUUID(),
  otherParent = crypto.randomUUID(),
  childId = crypto.randomUUID();
const owner = {
  source: {
    graphql: {
      relationships: [
        {
          fieldKey: "members",
          kind: "hasMany",
          ownership: "reference",
          target: "Member",
          inverse: "parent",
          foreignKey: "parent_id",
        },
      ],
    },
  },
} as GeneratedCrudTable;
const child = {
  schema: "erp",
  table: "members",
  primaryKey: "id",
  tenantScoped: true,
  columns: [{ name: "parent_id", sourceField: "parentId" }],
  source: { graphql: { typeName: "Member", relationships: [] } },
} as unknown as GeneratedCrudTable;
describe("related collection atomic boundary", () => {
  beforeAll(async () => {
    admin = new SQL(url!);
    await admin.unsafe(`create database "${name}"`);
    const target = new URL(url!);
    target.pathname = "/" + name;
    runtime = createDatabaseRuntime({ databaseUrl: target.href });
    await sql`create schema erp;create table erp.members(id uuid primary key,tenant_id uuid,parent_id uuid,body text)`.execute(
      runtime.db,
    );
    await sql`insert into erp.members values(${childId}::uuid,${tenant}::uuid,${parent}::uuid,'before')`.execute(
      runtime.db,
    );
  });
  afterAll(async () => {
    await runtime?.close();
    if (admin) {
      await admin.unsafe(`drop database "${name}" with(force)`);
      await admin.close();
    }
  });
  const update = {
    id: childId,
    expectedVersion: new Date().toISOString(),
    values: { body: "after" },
  };
  test("wrong parent, wrong tenant and reparenting never reach child writer", async () => {
    let calls = 0;
    const run = async () => {
      calls++;
      return { id: childId };
    };
    const attempt = (
      tenantId: string,
      parentId: string,
      values = update.values,
    ) =>
      runtime.db
        .transaction()
        .execute((trx) =>
          applyRelatedChanges(
            trx,
            { tenantId },
            owner,
            parentId,
            [{ relationship: "members", update: [{ ...update, values }] }],
            [child],
            run,
          ),
        );
    await expect(attempt(tenant, otherParent)).rejects.toThrow(
      "not in this collection",
    );
    await expect(attempt(crypto.randomUUID(), parent)).rejects.toThrow(
      "not in this collection",
    );
    await expect(
      attempt(tenant, parent, { parentId: otherParent } as any),
    ).rejects.toThrow("cannot be changed");
    expect(calls).toBe(0);
  });
  test("a refused later child rolls back the earlier child write", async () => {
    await expect(
      runtime.db.transaction().execute(async (trx) => {
        let calls = 0;
        await applyRelatedChanges(
          trx,
          { tenantId: tenant },
          owner,
          parent,
          [
            {
              relationship: "members",
              update: [update],
              create: [{ body: "new" }],
            },
          ],
          [child],
          async (_table, intent) => {
            calls++;
            if (intent === "create") throw Error("child permission refused");
            await sql`update erp.members set body='after' where id=${childId}::uuid`.execute(
              trx,
            );
            return { id: childId };
          },
        );
      }),
    ).rejects.toThrow("child permission refused");
    expect(
      (
        await sql<{
          body: string;
        }>`select body from erp.members where id=${childId}::uuid`.execute(
          runtime.db,
        )
      ).rows[0]!.body,
    ).toBe("before");
  });
  test("uses the declared key for a non-tenant-scoped reference target", async () => {
    await sql`create table erp.global_members(member_key text primary key,parent_id uuid,body text)`.execute(
      runtime.db,
    );
    await sql`insert into erp.global_members values('member-code',${parent}::uuid,'global')`.execute(
      runtime.db,
    );
    const target = {
      ...child,
      table: "global_members",
      primaryKey: "member_key",
      tenantScoped: false,
    };
    const seen: any[] = [];
    await runtime.db.transaction().execute((trx) =>
      applyRelatedChanges(
        trx,
        {},
        owner,
        parent,
        [
          {
            relationship: "members",
            update: [{ ...update, id: "member-code" }],
          },
        ],
        [target],
        async (_table, intent, input) => {
          seen.push({ intent, input });
          return { id: "member-code" };
        },
      ),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].input.id).toBe("member-code");
  });
  test("a sibling subtype is not a member of the projected collection", async () => {
    const target = {
      ...child,
      subtype: {
        scope: [{ field: "body", column: "body", value: "different-subtype" }],
      },
    } as GeneratedCrudTable;
    let calls = 0;
    await expect(
      runtime.db.transaction().execute((trx) =>
        applyRelatedChanges(
          trx,
          { tenantId: tenant },
          owner,
          parent,
          [{ relationship: "members", update: [update] }],
          [target],
          async () => {
            calls++;
            return { id: childId };
          },
        ),
      ),
    ).rejects.toThrow("not in this collection");
    expect(calls).toBe(0);
  });
  test("server injects the parent into new children and forwards child controls", async () => {
    const seen: any[] = [];
    await runtime.db.transaction().execute((trx) =>
      applyRelatedChanges(
        trx,
        { tenantId: tenant },
        owner,
        parent,
        [
          {
            relationship: "members",
            update: [{ ...update, leaseToken: "child-lease" }],
            create: [{ body: "new" }],
          },
        ],
        [child],
        async (_table, intent, input) => {
          seen.push({ intent, input });
          return { id: childId };
        },
      ),
    );
    expect(seen[0].input.leaseToken).toBe("child-lease");
    expect(seen[1].input.values.parentId).toBe(parent);
  });
});
