// SPDX-License-Identifier: BUSL-1.1
/**
 * WHAT THE REACHABILITY WALK COSTS on a grant graph an administrator built.
 *
 * `readUnintendedDefinerMembers` reports one row per route into a definer
 * role — one per `(definer, member, first hop)`, so that every `revoke` an
 * operator is given cuts one edge and running all of them cuts every edge.
 * Reporting that from an enumeration of PATHS costs the number of paths, and
 * on a dense acyclic lattice that is exponential in its depth: the eight layers
 * of six roles built below are 258 membership edges and 2,015,538 paths, and
 * the `union all` walk spent 20s building those 258 rows (measured on
 * PostgreSQL 17.11; the diamond beside the lattice adds six of each). Every
 * further layer multiplies the paths by six and leaves the rows linear — a
 * deployment refused a migration by the SIZE of its grant graph rather than by
 * a verdict on it, which is a denial of the check, not a check.
 *
 * The walk is therefore over nodes: `union` instead of `union all`, keyed on
 * `(definer, role, depth)`, with the shortest-path tree reconstructed after
 * it and the routes read off each reached role's outgoing edges. This file
 * pins both halves of that claim:
 *
 *   - the work is bounded by the graph's SIZE, not by its path count, and
 *   - the rows are the ones the path enumeration produced — same
 *     `(definer, member, via)` triples, same shortest chain length each.
 *
 * The second half is the regression guard: the lattice has many equal-length
 * paths to the same role, and the diamond beside it gives one role three
 * routes into the definer role of which two are equally short. The behavioural
 * cases — who is admitted, what each refusal says, the record-action step —
 * are in definer-role-membership.test.ts and database-role-contract.test.ts.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { sql } from "kysely";
import { createDatabaseRuntime, type DatabaseRuntime } from "../connection.js";
import { readUnintendedDefinerMembers } from "../database-roles.js";

const ADMIN_URL = process.env.SCRATCH_ADMIN_DATABASE_URL ??
  "postgres://openshapeforge:openshapeforge@localhost:5434/postgres";
const TEST_TIMEOUT = 240_000;
const suffix = randomUUID().replaceAll("-", "").slice(0, 8);
const prefix = `osf_reach_${suffix}`;
/** A definer role of this test's own: the declared ones are shared by the cluster. */
const definer = `${prefix}_definer`;
const migrateRole = `${prefix}_migrate`;
const scratch = `reach_${suffix}`;
const MIGRATE_PASSWORD = "reachability";

/** The lattice: {@link LAYERS} layers of {@link WIDTH} roles, fully connected. */
const LAYERS = 8;
const WIDTH = 6;
/** Paths from the definer role into the lattice: WIDTH * (WIDTH**LAYERS - 1) / (WIDTH - 1). */
const LATTICE_PATHS = (WIDTH * (WIDTH ** LAYERS - 1)) / (WIDTH - 1);
/** Edges in the lattice: the seam into the definer role plus one per layer pair. */
const LATTICE_EDGES = WIDTH + (LAYERS - 1) * WIDTH * WIDTH;
/** One state per (role, depth) the walk can reach it at: every lattice role sits at one depth. */
const LATTICE_STATES = LAYERS * WIDTH;

/** The diamond: three routes into the definer role, two of them equally short. */
const top = `${prefix}_top`;
const left = `${prefix}_left`;
const right = `${prefix}_right`;
const bottom = `${prefix}_bottom`;
const DIAMOND_EDGES = 6;
const DIAMOND_PATHS = 6;
/** `bottom` is reached at depth 1 and at depth 3; the other three at one depth each. */
const DIAMOND_STATES = 5;

const lattice = (layer: number, index: number): string => `${prefix}_l${layer}_${index}`;

let server: SQL;
let migrate: DatabaseRuntime;

beforeAll(async () => {
  server = new SQL(ADMIN_URL, { max: 1 });
  await server.unsafe(`create role ${definer} nologin nosuperuser noinherit nobypassrls`);
  await server.unsafe(
    `create role ${migrateRole} login password '${MIGRATE_PASSWORD}' ` +
      "nosuperuser nobypassrls nocreaterole nocreatedb",
  );
  await server.unsafe(`create database "${scratch}" owner ${migrateRole}`);
  for (let layer = 0; layer < LAYERS; layer += 1) {
    for (let index = 0; index < WIDTH; index += 1) {
      await server.unsafe(`create role ${lattice(layer, index)} nologin nosuperuser nobypassrls`);
    }
  }
  for (let index = 0; index < WIDTH; index += 1) {
    await server.unsafe(
      `grant ${definer} to ${lattice(0, index)} with inherit true, set true`,
    );
  }
  for (let layer = 0; layer + 1 < LAYERS; layer += 1) {
    for (let held = 0; held < WIDTH; held += 1) {
      for (let member = 0; member < WIDTH; member += 1) {
        await server.unsafe(
          `grant ${lattice(layer, held)} to ${lattice(layer + 1, member)} ` +
            "with inherit true, set true",
        );
      }
    }
  }
  for (const role of [top, left, right, bottom]) {
    await server.unsafe(`create role ${role} nologin nosuperuser nobypassrls`);
  }
  for (const grant of [
    `grant ${definer} to ${top}`,
    `grant ${top} to ${left}`,
    `grant ${top} to ${right}`,
    `grant ${left} to ${bottom}`,
    `grant ${right} to ${bottom}`,
    // The short way round, so `bottom` has a depth-1 route beside its two
    // depth-3 ones and the shortest chain per route is not the shortest chain.
    `grant ${definer} to ${bottom}`,
  ]) {
    await server.unsafe(`${grant} with inherit true, set true`);
  }
  migrate = createDatabaseRuntime({
    databaseUrl: (() => {
      const parsed = new URL(ADMIN_URL);
      parsed.pathname = `/${scratch}`;
      parsed.username = migrateRole;
      parsed.password = MIGRATE_PASSWORD;
      return parsed.toString();
    })(),
    maxConnections: 1,
  });
}, TEST_TIMEOUT);

afterAll(async () => {
  await migrate?.close();
  await server?.unsafe(`drop database if exists "${scratch}" with (force)`);
  for (const role of [bottom, right, left, top]) {
    await server?.unsafe(`drop role if exists ${role}`);
  }
  for (let layer = LAYERS - 1; layer >= 0; layer -= 1) {
    for (let index = 0; index < WIDTH; index += 1) {
      await server?.unsafe(`drop role if exists ${lattice(layer, index)}`);
    }
  }
  await server?.unsafe(`drop role if exists ${definer}`);
  await server?.unsafe(`drop role if exists ${migrateRole}`);
  await server?.close();
}, TEST_TIMEOUT);

/**
 * How many rows each formulation of the walk produces on this graph. The two
 * recursions are the SEED AND STEP of the two implementations, stripped of
 * everything that does not affect how many rows they visit, so the comparison
 * is of the traversals rather than of their output:
 *
 *   - `enumerated` is one row per PATH, which is what a `union all` walk holds;
 *   - `visited` is one row per `(role, depth)`, which is what the shipped
 *     `union` walk holds — its extra `role` column is the definer role, and
 *     there is one of those here.
 */
async function walkSizes(): Promise<{ enumerated: number; visited: number }> {
  return await migrate.db.connection().execute(async (conn) => {
    const paths = await sql<{ rows: number }>`
      with recursive paths as (
        select am.member as node, 1 as depth
        from pg_auth_members am
        join pg_roles d on d.oid = am.roleid
        where d.rolname = ${definer}
        union all
        select am.member, p.depth + 1
        from paths p
        join pg_auth_members am on am.roleid = p.node
        where p.depth < 16
      )
      select count(*)::int as rows from paths
    `.execute(conn);
    const nodes = await sql<{ rows: number }>`
      with recursive reach as (
        select d.oid as node, 0 as depth from pg_roles d where d.rolname = ${definer}
        union
        select am.member, r.depth + 1
        from reach r
        join pg_auth_members am on am.roleid = r.node
        where r.depth < 16
      )
      select count(*)::int as rows from reach
    `.execute(conn);
    return { enumerated: paths.rows[0]!.rows, visited: nodes.rows[0]!.rows };
  });
}

test("the walk is bounded by the graph's size, not by the number of paths through it", async () => {
  const { enumerated, visited } = await walkSizes();
  // The graph, stated two ways. Both numbers follow from the construction, so
  // a change to either formulation's reach shows up here as a wrong count.
  expect(enumerated).toBe(LATTICE_PATHS + DIAMOND_PATHS);
  expect(enumerated).toBeGreaterThan(2_000_000);
  // One state per (role, depth), plus the definer role itself at depth 0.
  expect(visited).toBe(1 + LATTICE_STATES + DIAMOND_STATES);
  // Four orders of magnitude between the two, on 53 roles and 264 edges.
  expect(enumerated / visited).toBeGreaterThan(10_000);

  const started = Bun.nanoseconds();
  const rows = await migrate.db.connection().execute((conn) =>
    readUnintendedDefinerMembers(conn, [definer]));
  const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
  expect(rows).toHaveLength(LATTICE_EDGES + DIAMOND_EDGES);
  // The path enumeration took 20s to produce these rows on hardware faster
  // than CI's. The budget is not a performance target; it is the difference
  // between a check and a check a grant graph can switch off.
  expect(elapsedMs).toBeLessThan(10_000);
}, TEST_TIMEOUT);

test("it reports the routes and shortest chains the path enumeration reported", async () => {
  const rows = await migrate.db.connection().execute((conn) =>
    readUnintendedDefinerMembers(conn, [definer]));
  // The same contract, read off an enumeration of every path: one row per
  // (member, first hop out of it), carrying the shortest depth through that
  // hop. Only the depth is compared, not the chain — several shortest paths
  // of the same length reach a lattice role, and which one is shown is not
  // part of the contract.
  const enumerated = await migrate.db.connection().execute((conn) =>
    sql<{ member: string; via: string; depth: number }>`
      with recursive paths as (
        select am.roleid as via, am.member as node, 1 as depth
        from pg_auth_members am
        join pg_roles d on d.oid = am.roleid
        where d.rolname = ${definer}
        union all
        select p.node, am.member, p.depth + 1
        from paths p
        join pg_auth_members am on am.roleid = p.node
        where p.depth < 16
      )
      select distinct on (member.rolname, via.rolname)
        member.rolname as member, via.rolname as via, p.depth
      from paths p
      join pg_roles member on member.oid = p.node
      join pg_roles via on via.oid = p.via
      where not member.rolsuper
        and member.rolname <> current_user
        and member.oid <> coalesce(
          (select datdba from pg_database where datname = current_database()), 0)
      order by member.rolname, via.rolname, p.depth
    `.execute(conn));

  const shipped = rows
    .map((row) => `${row.member}|${row.via}|${row.path.split(" <- ").length - 1}`)
    .sort();
  const walked = enumerated.rows
    .map((row) => `${row.member}|${row.via}|${row.depth}`)
    .sort();
  expect(shipped).toEqual(walked);
  expect(shipped).toHaveLength(LATTICE_EDGES + DIAMOND_EDGES);
  // Every row names the definer role it leads into, and every chain starts
  // there and ends at the member it is reported for.
  for (const row of rows) {
    expect(row.role).toBe(definer);
    expect(row.path.startsWith(`${definer} <- `)).toBe(true);
    expect(row.path.endsWith(` <- ${row.member}`)).toBe(true);
    expect(row.path.split(" <- ").at(-2)).toBe(row.via);
  }
}, TEST_TIMEOUT);

/**
 * The diamond on its own, spelled out. `bottom` reaches the definer role three
 * ways and is told to cut all three; the two chains through `left` and `right`
 * are the same length, and the direct one is shorter than both — so the chain
 * shown per row is the shortest THROUGH THAT HOP and not the shortest overall,
 * which is what makes each printed `revoke` the remedy for the route beside it.
 */
test("a role with three routes is given three revokes, one chain each", async () => {
  const rows = await migrate.db.connection().execute((conn) =>
    readUnintendedDefinerMembers(conn, [definer]));
  const routes = rows.filter((row) => row.member === bottom);
  expect(routes.map((row) => row.via).sort()).toEqual([definer, left, right].sort());
  expect(new Map(routes.map((row) => [row.via, row.path]))).toEqual(
    new Map([
      [definer, `${definer} <- ${bottom}`],
      [left, `${definer} <- ${top} <- ${left} <- ${bottom}`],
      [right, `${definer} <- ${top} <- ${right} <- ${bottom}`],
    ]),
  );
  // And the roles between them appear once each, with the hop they hold.
  expect(rows.filter((row) => row.member === left).map((row) => row.via)).toEqual([top]);
  expect(rows.filter((row) => row.member === top).map((row) => row.via)).toEqual([definer]);
  // Nothing in this graph owns a database, so no refusal claims it does.
  expect(rows.every((row) => !row.ownsOtherDatabase)).toBe(true);
}, TEST_TIMEOUT);
