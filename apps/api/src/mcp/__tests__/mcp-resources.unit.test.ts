// SPDX-License-Identifier: BUSL-1.1
/**
 * Unit coverage for MCP resource visibility — the one rule that exists only
 * on the resource surface: a catalogue resource is advertised to a session
 * exactly when that session holds the entity's read role, mirroring how the
 * tool listing omits unauthorized tools rather than erroring. The read
 * handlers themselves go through the shared CRUD core, whose authorization
 * and redaction behaviour the GraphQL and REST suites already prove.
 *
 * Runs without a database, so it holds the line even while no shipped entity
 * authors an `mcp.resource` block.
 */
import { describe, expect, it } from "bun:test";
import { __resourcesForSessionForTests as resourcesForSession } from "../generated-mcp-server.js";

const READ = "Widgets.All.Read";

const session = (...roles: string[]) =>
  ({
    tenantId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    roles,
    groups: [],
    scope: "self",
  }) as never;

const table = {
  name: "erp.widgets",
  columns: [],
  source: {
    crud: { operations: { list: true, get: true, create: true, update: true, delete: true } },
    authorization: { roles: { read: [READ], create: [], update: [], delete: [] } },
  },
} as never;

const resource = {
  uri: "app://widgets",
  name: "Widgets",
  description: "Read the widget catalogue.",
  templateUri: "app://widgets/{id}",
  templateName: "Specific Widget",
  templateDescription: "Read one widget by id.",
  entity: "Widget",
  table: "erp.widgets",
};

const tables = new Map([["erp.widgets", table]]);

describe("resourcesForSession", () => {
  it("advertises a resource to a session holding the entity read role", () => {
    expect(resourcesForSession(session(READ), tables as never, [resource])).toEqual([resource]);
  });

  it("omits the resource for a session without the read role", () => {
    expect(resourcesForSession(session("Other.Role"), tables as never, [resource])).toEqual([]);
    expect(resourcesForSession(session(), tables as never, [resource])).toEqual([]);
  });

  it("omits a resource whose table is missing from the manifest", () => {
    expect(resourcesForSession(session(READ), new Map() as never, [resource])).toEqual([]);
  });
});
