// SPDX-License-Identifier: BUSL-1.1
/**
 * The pure parts of the assignment surface, without a database:
 *
 *   1. the locator, because it is the one value a caller hands back, and the
 *      shapes it admits have to be the shapes both ends of the surface
 *      actually support;
 *   2. the authority, because it is the single gate in front of both halves
 *      and a missing refusal here is a missing refusal everywhere;
 *   3. the cursor, because the keyset is what makes paging stable;
 *   4. the registry, because which entities are manageable at all is derived
 *      from the compiled manifest and from nothing a caller sends.
 *
 * "Preserves everything else in the document" is not tested here: this surface
 * no longer patches the ACL. The delta is the canonical delegation
 * Operation's, and its preservation is proven where it lives
 * (operations/record-action-operations.test.ts and
 * record-action-delegation-db.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  formatAssignmentLocator,
  parseAssignmentLocator,
} from "./locator.js";
import { assertAssignmentManagerAuthority } from "./authority.js";
import {
  decodeAssignmentCursor,
  encodeAssignmentCursor,
  recordNameForSession,
} from "./read-model.js";
import {
  recordActionAssignmentEntities,
  recordActionAssignmentEntity,
  recordNameColumn,
} from "./registry.js";
import type { GeneratedCrudTable } from "../entity/types.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";

const integration = randomUUID();

describe("the assignment locator", () => {
  test("round-trips every part it admits", () => {
    for (const action of ["start", "follow", "submitReading"]) {
      const locator = {
        entity: "MeterConnection", recordId: randomUUID(), action, integrationId: integration,
      };
      expect(parseAssignmentLocator(formatAssignmentLocator(locator))).toEqual(locator);
    }
  });

  test("refuses anything that is not a locator", () => {
    const record = randomUUID();
    const valid = formatAssignmentLocator({
      entity: "MeterConnection", recordId: record, action: "submitReading", integrationId: integration,
    });
    expect(parseAssignmentLocator(valid)).toBeDefined();
    const refused: unknown[] = [
      undefined,
      null,
      42,
      "",
      "MeterConnection",
      `MeterConnection~${record}~submitReading`,
      // A lowercase entity, an upper-camel action and a non-uuid subject are
      // each outside the compiled shapes, so the locator never reaches a lookup.
      `meterConnection~${record}~submitReading~${integration}`,
      `MeterConnection~${record}~SubmitReading~${integration}`,
      `MeterConnection~${record}~submitReading~not-a-uuid`,
      // A record key that is not a uuid cannot name a row of any entity this
      // registry admits, and the one writer of the axis would refuse it.
      `MeterConnection~plain-text-key~submitReading~${integration}`,
      `MeterConnection~~submitReading~${integration}`,
      // A fifth part is not "a key containing the separator": it is a locator
      // that does not parse, which is the only safe reading of it.
      `MeterConnection~${record}~submitReading~${integration}~extra`,
    ];
    for (const value of refused) expect(parseAssignmentLocator(value)).toBeUndefined();
  });
});

describe("the manager authority", () => {
  const manager: TrustedSessionContext = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    roles: ["Platform.ApiKeys.Manage"],
    groups: [],
    credential: "bearer",
    // The SERVER's verdict, carried by the session and asserted by nobody.
    // Required rather than optional here: absence proves nothing, so a
    // session without it is refused along with every machine carrier below.
    principalKind: "person",
    scope: "self",
  };

  test("admits a person carrier holding the integration-management role", () => {
    expect(() => assertAssignmentManagerAuthority(manager)).not.toThrow();
  });

  test("refuses the organization's access administrator without that role", () => {
    // The refusal this closes: an ordinary organization administrator could
    // otherwise survey and extend the reach of every integration in the
    // tenant without ever holding the right that provisions one.
    expect(() => assertAssignmentManagerAuthority({
      ...manager, roles: ["Organization.Access.Manage", "Organization.All.ReadWrite"],
    })).toThrow(/Not authorized to manage record action assignments/);
  });

  test("refuses everything that is not a verified person, however it authenticated", () => {
    expect(() => assertAssignmentManagerAuthority({ ...manager, credential: "api-key" }))
      .toThrow(/API keys cannot manage API keys|Not authorized/);
    expect(() => assertAssignmentManagerAuthority({ ...manager, credential: "grant" }))
      .toThrow(/capability grant/);
    // An application principal and a bearer service account are classified by
    // the server, not claimed by the caller, and both are refused: the key's
    // own route and the service account's route reach the same gate.
    expect(() => assertAssignmentManagerAuthority({
      ...manager, appPrincipal: { integrationId: integration, credentialId: randomUUID() },
    } as TrustedSessionContext)).toThrow(/verified person/);
    expect(() => assertAssignmentManagerAuthority({ ...manager, principalKind: "service" }))
      .toThrow(/verified person/);
    // And the one an exclusion list would have let through: a carrier the
    // deployment could not classify at all. It holds the management role and
    // is still refused, because absence is not a person.
    const { principalKind: _unclassified, ...unclassified } = manager;
    expect(() => assertAssignmentManagerAuthority(unclassified as TrustedSessionContext))
      .toThrow(/verified person/);
  });

  test("refuses a session with no tenant or no verified actor", () => {
    const { tenantId: _tenant, ...noTenant } = manager;
    expect(() => assertAssignmentManagerAuthority(noTenant as TrustedSessionContext))
      .toThrow(/authenticated tenant session/);
    const { userId: _user, ...noUser } = manager;
    expect(() => assertAssignmentManagerAuthority(noUser as TrustedSessionContext))
      .toThrow(/authenticated tenant session/);
  });
});

describe("the page cursor", () => {
  test("round-trips and refuses a forged one", () => {
    const cursor = { entity: "ExternalProcessRun", recordId: randomUUID(), action: "start" };
    expect(decodeAssignmentCursor(encodeAssignmentCursor(cursor))).toEqual(cursor);
    expect(decodeAssignmentCursor(undefined)).toBeUndefined();
    expect(decodeAssignmentCursor("")).toBeUndefined();
    for (const value of ["not-base64url!!", Buffer.from("[1,2,3]").toString("base64url"),
      Buffer.from("{}").toString("base64url"), Buffer.from('["a","b"]').toString("base64url")]) {
      expect(() => decodeAssignmentCursor(value)).toThrow();
    }
  });
});

describe("the record name follows the entity's field policy", () => {
  const session: TrustedSessionContext = {
    tenantId: randomUUID(), userId: randomUUID(), roles: ["Organization.All.Read"],
    groups: [], credential: "bearer", scope: "self",
  };

  test("an unclassified name is returned as stored", () => {
    const entity = recordActionAssignmentEntity("ExternalProcessRun")!;
    expect(recordNameForSession(entity, session, { record_id: "r1", record_name: "run 0" }))
      .toEqual({ recordName: "run 0", nameWithheld: false });
  });

  test("a classified name is withheld from a read-only session, and the key stands in", () => {
    const base = recordActionAssignmentEntity("ExternalProcessRun")!;
    const classified = {
      ...base,
      table: {
        ...base.table,
        columns: base.table.columns.map((column) =>
          column.name === "name" ? { ...column, classification: "confidential" as const } : column),
      },
    };
    // Reading a classified column takes a write grant on the entity; this
    // session holds the read tier only, so the name does not reach the row and
    // the row says so instead of showing a blank.
    expect(recordNameForSession(classified, session, { record_id: "r1", record_name: "run 0" }))
      .toEqual({ recordName: "r1", nameWithheld: true });
    // The same column, a session that may read it.
    const writer: TrustedSessionContext = { ...session, roles: ["Organization.All.ReadWrite"] };
    expect(recordNameForSession(classified, writer, { record_id: "r1", record_name: "run 0" }))
      .toEqual({ recordName: "run 0", nameWithheld: false });
  });

  test("an entity with no name column reports its key without claiming anything was withheld", () => {
    const { nameColumn, ...nameless } = recordActionAssignmentEntity("ExternalProcessRun")!;
    expect(nameColumn).toBeDefined();
    expect(recordNameForSession(nameless, session, { record_id: "r1", record_name: null }))
      .toEqual({ recordName: "r1", nameWithheld: false });
  });
});

describe("the manageable-entity registry", () => {
  test("derives exactly the entities that declared an action an application may hold", () => {
    const entities = recordActionAssignmentEntities();
    // The two this repository's own record-action layer declares, plus the
    // notebook example plugin's `deliver`. The registry is derived from the
    // compiled manifest and from nothing else, so a plugin that opts in is
    // manageable without this module knowing the plugin exists.
    expect(entities.map((entity) => entity.entity))
      .toEqual(["ExternalProcessRun", "MeterConnection", "Notebook"]);
    const run = recordActionAssignmentEntity("ExternalProcessRun")!;
    expect(run.actions.map((action) => action.name)).toEqual(["follow", "start"]);
    expect(run.acl).toEqual({ field: "authorization", column: "authorization", empty: "restricted" });
    expect(run.keyColumn).toBe("id");
    expect(run.nameColumn?.name).toBe("name");
    expect(run.versionColumn?.name).toBe("updated_at");
    const meter = recordActionAssignmentEntity("MeterConnection")!;
    expect(meter.actions).toEqual([{ name: "submitReading", principals: ["integration"] }]);
    expect(meter.acl.empty).toBe("public");
  });

  test("an entity with no declared action, or none an application may hold, is absent", () => {
    expect(recordActionAssignmentEntity("Relation")).toBeUndefined();
    expect(recordActionAssignmentEntity("Tenant")).toBeUndefined();
    expect(recordActionAssignmentEntity("NoSuchEntity")).toBeUndefined();
  });

  test("a person-only action, a subtype and an entity without update are excluded", () => {
    const base = recordActionAssignmentEntity("ExternalProcessRun")!.table;
    const withPolicy = (overrides: Partial<GeneratedCrudTable>, actions: unknown): GeneratedCrudTable => ({
      ...base,
      ...overrides,
      source: {
        ...base.source,
        authorization: {
          ...base.source!.authorization!,
          recordPermissions: { ...base.source!.authorization!.recordPermissions!, actions: actions as never },
        },
      },
    });
    const personOnly = withPolicy({}, [{ name: "follow", principals: ["person"] }]);
    expect(recordActionAssignmentEntities([personOnly])).toEqual([]);
    const subtype = withPolicy(
      { subtype: { base: { entityName: "ExternalProcessRun", entityId: "x", slug: "x", table: "external_process_runs" }, scope: [], hiddenColumns: [] } },
      [{ name: "start", principals: ["integration"] }],
    );
    expect(recordActionAssignmentEntities([subtype])).toEqual([]);
    const readOnly: GeneratedCrudTable = {
      ...withPolicy({}, [{ name: "start", principals: ["integration"] }]),
      source: {
        ...withPolicy({}, [{ name: "start", principals: ["integration"] }]).source,
        crud: { operations: { list: true, get: true, create: false, update: false, delete: false } },
      },
    };
    expect(recordActionAssignmentEntities([readOnly])).toEqual([]);
  });

  test("the record name follows the entity's display template, then convention", () => {
    const run = recordActionAssignmentEntity("ExternalProcessRun")!.table;
    expect(recordNameColumn(run)?.name).toBe("name");
    const templated: GeneratedCrudTable = {
      ...run,
      source: { ...run.source, displayTemplate: "{{definition}}" },
    };
    expect(recordNameColumn(templated)?.name).toBe("definition");
    // A template over several fields has no single column to read, so the
    // convention decides instead of a guess at a rendered string.
    const composite: GeneratedCrudTable = {
      ...run,
      source: { ...run.source, displayTemplate: "{{name}} — {{status}}" },
    };
    expect(recordNameColumn(composite)?.name).toBe("name");
    const { displayTemplate, ...withoutTemplate } = run.source!;
    expect(displayTemplate).toBe("{{name}}");
    const nameless: GeneratedCrudTable = {
      ...run,
      columns: run.columns.filter((column) => column.name !== "name"),
      source: withoutTemplate,
    };
    expect(recordNameColumn(nameless)).toBeUndefined();
  });
});
