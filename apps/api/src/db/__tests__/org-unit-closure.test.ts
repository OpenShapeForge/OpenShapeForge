/**
 * §D.2 / §F — closure trigger proof. The trigger on platform.org_unit maintains
 * platform.org_unit_closure atomically with each org_unit write. We run the full
 * migration chain (which installs the versioned trigger migration
 * 0002_org-unit-closure-trigger) against a throwaway SCRATCH database, then, as
 * the PRIVILEGED role (so the tenant-isolated closure table is fully visible for
 * assertions), prove:
 *
 *   - INSERT maintains self-rows (depth 0) and inherited ancestor paths
 *     (R–C depth 1, R–G depth 2) for a chain R → C → G plus a sibling S.
 *   - UPDATE of parent_id reparents the subtree correctly (move C under S).
 *   - DELETE is blocked by the parent_id FK ON DELETE RESTRICT while children
 *     reference the parent; a leaf delete tears its closure edges down.
 *
 * Run (cwd apps/api):
 *   set -o pipefail; bun test src/db/__tests__/org-unit-closure.test.ts 2>&1
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../generated/db/types.js";
import { createDatabaseRuntime } from "../connection.js";
import { runMigrationChain } from "../migration-chain.js";

const ADMIN_URL =
  process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";

const TEST_TIMEOUT = 90_000;

function scratchAdminUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  if (url.pathname === "/openshapeforge_dev") {
    throw new Error("admin URL must not point at openshapeforge_dev");
  }
  url.pathname = `/${name}`;
  return url.toString();
}

async function withScratchDb<T>(fn: (name: string) => Promise<T>): Promise<T> {
  const name = `org_unit_closure_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`unsafe scratch database name: ${name}`);
  }
  const admin = new SQL(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
    try {
      return await fn(name);
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.close();
  }
}

async function withDb<T>(url: string, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const runtime = createDatabaseRuntime({ databaseUrl: url, maxConnections: 1 });
  try {
    return await fn(runtime.db);
  } finally {
    await runtime.close();
  }
}

async function expectRejects(promise: Promise<unknown>): Promise<string> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe("org_unit closure trigger", () => {
  test(
    "insert maintains self+inherited paths; reparent corrects; RESTRICT blocks parent delete",
    async () => {
      await withScratchDb(async (name) => {
        // Provision: full chain (installs the versioned trigger migration).
        await withDb(scratchAdminUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));

          await db.connection().execute(async (conn) => {
            const tenant = randomUUID();
            const R = randomUUID(); // root
            const C = randomUUID(); // child of R
            const G = randomUUID(); // grandchild (child of C)
            const S = randomUUID(); // sibling root

            // Set the tenant GUC so the closure table (RLS-scoped) is written and
            // read under the right tenant even as the superuser.
            await sql`select set_config('app.tenant_id', ${tenant}, false)`.execute(conn);

            const insertUnit = async (id: string, parent: string | null) => {
              await sql`
                insert into platform.org_unit (id, tenant_id, parent_id, name)
                values (${id}::uuid, ${tenant}::uuid, ${parent}::uuid, ${`unit-${id.slice(0, 4)}`})
              `.execute(conn);
            };

            // Build R → C → G plus sibling root S.
            await insertUnit(R, null);
            await insertUnit(C, R);
            await insertUnit(G, C);
            await insertUnit(S, null);

            const depth = async (a: string, d: string): Promise<number | null> => {
              const r = await sql<{ depth: number }>`
                select depth from platform.org_unit_closure
                where tenant_id = ${tenant}::uuid and ancestor_id = ${a}::uuid and descendant_id = ${d}::uuid
              `.execute(conn);
              return r.rows[0]?.depth ?? null;
            };
            const edgeCount = async (): Promise<number> => {
              const r = await sql<{ n: number }>`
                select count(*)::int as n from platform.org_unit_closure where tenant_id = ${tenant}::uuid
              `.execute(conn);
              return r.rows[0]?.n ?? -1;
            };

            // ── INSERT invariants ──
            // Self-rows at depth 0.
            expect(await depth(R, R)).toBe(0);
            expect(await depth(C, C)).toBe(0);
            expect(await depth(G, G)).toBe(0);
            expect(await depth(S, S)).toBe(0);
            // R is ancestor of C at depth 1, of G at depth 2.
            expect(await depth(R, C)).toBe(1);
            expect(await depth(R, G)).toBe(2);
            // C is ancestor of G at depth 1.
            expect(await depth(C, G)).toBe(1);
            // S is isolated: no path to/from R's subtree.
            expect(await depth(S, R)).toBeNull();
            expect(await depth(R, S)).toBeNull();
            // Total edges: 4 self + (R→C, R→G, C→G) = 7.
            expect(await edgeCount()).toBe(7);

            // ── REPARENT: move C (with subtree G) under S ──
            await sql`
              update platform.org_unit set parent_id = ${S}::uuid where id = ${C}::uuid
            `.execute(conn);
            // R no longer reaches C or G.
            expect(await depth(R, C)).toBeNull();
            expect(await depth(R, G)).toBeNull();
            // S now reaches C (depth 1) and G (depth 2).
            expect(await depth(S, C)).toBe(1);
            expect(await depth(S, G)).toBe(2);
            // The intra-subtree path C→G survives (still depth 1).
            expect(await depth(C, G)).toBe(1);
            // Self-rows intact.
            expect(await depth(C, C)).toBe(0);
            expect(await depth(G, G)).toBe(0);

            // ── DELETE RESTRICT: cannot delete C while G references it ──
            const restrictMsg = await expectRejects(
              sql`delete from platform.org_unit where id = ${C}::uuid`.execute(conn),
            );
            expect(restrictMsg.toLowerCase()).toContain("foreign key");

            // ── Leaf delete: G removes its closure edges ──
            await sql`delete from platform.org_unit where id = ${G}::uuid`.execute(conn);
            expect(await depth(G, G)).toBeNull();
            expect(await depth(C, G)).toBeNull();
            expect(await depth(S, G)).toBeNull();
            // C still reachable from S.
            expect(await depth(S, C)).toBe(1);
          });
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "reparent into own descendant raises a clear cycle error, not an opaque unique violation",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(scratchAdminUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));
          await db.connection().execute(async (conn) => {
            const tenant = randomUUID();
            const R = randomUUID(); // root
            const C = randomUUID(); // child of R
            const G = randomUUID(); // grandchild (child of C)
            await sql`select set_config('app.tenant_id', ${tenant}, false)`.execute(conn);

            const insertUnit = async (id: string, parent: string | null) => {
              await sql`
                insert into platform.org_unit (id, tenant_id, parent_id, name)
                values (${id}::uuid, ${tenant}::uuid, ${parent}::uuid, ${`unit-${id.slice(0, 4)}`})
              `.execute(conn);
            };
            await insertUnit(R, null);
            await insertUnit(C, R);
            await insertUnit(G, C);

            // Moving R under its own grandchild G would make R its own
            // ancestor. The guard must abort with an explicit cycle error
            // rather than the opaque org_unit_closure_edge_uk unique violation.
            const msg = await expectRejects(
              sql`update platform.org_unit set parent_id = ${G}::uuid where id = ${R}::uuid`.execute(
                conn,
              ),
            );
            const lower = msg.toLowerCase();
            expect(lower).toContain("cycle");
            expect(lower).not.toContain("duplicate key");

            // The rejected move left the closure untouched: R still roots the
            // chain (R→C depth 1, R→G depth 2) and G is not an ancestor of R.
            const depth = async (a: string, d: string): Promise<number | null> => {
              const r = await sql<{ depth: number }>`
                select depth from platform.org_unit_closure
                where tenant_id = ${tenant}::uuid and ancestor_id = ${a}::uuid and descendant_id = ${d}::uuid
              `.execute(conn);
              return r.rows[0]?.depth ?? null;
            };
            expect(await depth(R, C)).toBe(1);
            expect(await depth(R, G)).toBe(2);
            expect(await depth(G, R)).toBeNull();
          });
        });
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "trigger rejects cross-tenant parent_id / tenant mutation on update",
    async () => {
      await withScratchDb(async (name) => {
        await withDb(scratchAdminUrl(name), async (db) => {
          await db.connection().execute((conn) => runMigrationChain(conn));
          await db.connection().execute(async (conn) => {
            const tenantA = randomUUID();
            const tenantB = randomUUID();
            const unit = randomUUID();
            const unitB = randomUUID();
            const childA = randomUUID();
            const ghost = randomUUID();
            await sql`select set_config('app.tenant_id', ${tenantA}, false)`.execute(conn);
            await sql`
              insert into platform.org_unit (id, tenant_id, parent_id, name)
              values (${unit}::uuid, ${tenantA}::uuid, null, ${"root"})
            `.execute(conn);
            // A root in tenant B, referenced from tenant A below.
            await sql`
              insert into platform.org_unit (id, tenant_id, parent_id, name)
              values (${unitB}::uuid, ${tenantB}::uuid, null, ${"root-b"})
            `.execute(conn);

            // ── INSERT with a cross-tenant parent must be rejected ──
            // parent_id references tenant B's root; the FK passes (id exists)
            // but the trigger's same-tenant-parent guard aborts the write
            // rather than silently creating a phantom root (issue #15).
            const crossMsg = await expectRejects(
              sql`
                insert into platform.org_unit (id, tenant_id, parent_id, name)
                values (${childA}::uuid, ${tenantA}::uuid, ${unitB}::uuid, ${"child-a"})
              `.execute(conn),
            );
            expect(crossMsg.toLowerCase()).toContain("cross-tenant");
            // Nothing was written for the rejected node.
            const orphan = await sql<{ n: number }>`
              select count(*)::int as n from platform.org_unit_closure
              where tenant_id = ${tenantA}::uuid and descendant_id = ${childA}::uuid
            `.execute(conn);
            expect(orphan.rows[0]?.n).toBe(0);

            // ── INSERT with a parent that exists in no tenant is rejected ──
            const ghostMsg = await expectRejects(
              sql`
                insert into platform.org_unit (id, tenant_id, parent_id, name)
                values (${childA}::uuid, ${tenantA}::uuid, ${ghost}::uuid, ${"child-a"})
              `.execute(conn),
            );
            // A nonexistent id trips the self-referential FK first; if it ever
            // reaches the trigger, the same-tenant-parent guard catches it.
            const ghostLower = ghostMsg.toLowerCase();
            expect(
              ghostLower.includes("foreign key") ||
                ghostLower.includes("cross-tenant or nonexistent"),
            ).toBe(true);

            // ── REPARENT onto a cross-tenant parent must be rejected ──
            // Give tenant A a real child first, then try to reparent it under
            // tenant B's root.
            await sql`
              insert into platform.org_unit (id, tenant_id, parent_id, name)
              values (${childA}::uuid, ${tenantA}::uuid, ${unit}::uuid, ${"child-a"})
            `.execute(conn);
            const reparentMsg = await expectRejects(
              sql`update platform.org_unit set parent_id = ${unitB}::uuid where id = ${childA}::uuid`.execute(
                conn,
              ),
            );
            expect(reparentMsg.toLowerCase()).toContain("cross-tenant");
            // The child still hangs under its original tenant-A parent.
            const stillUnderA = await sql<{ depth: number }>`
              select depth from platform.org_unit_closure
              where tenant_id = ${tenantA}::uuid and ancestor_id = ${unit}::uuid and descendant_id = ${childA}::uuid
            `.execute(conn);
            expect(stillUnderA.rows[0]?.depth).toBe(1);

            // Mutating tenant_id must be rejected by the trigger's immutability
            // assertion (NEW.tenant_id <> OLD.tenant_id).
            const msg = await expectRejects(
              sql`update platform.org_unit set tenant_id = ${tenantB}::uuid where id = ${unit}::uuid`.execute(
                conn,
              ),
            );
            expect(msg.toLowerCase()).toContain("immutable");
          });
        });
      });
    },
    TEST_TIMEOUT,
  );
});
