// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import type { CoreEntity } from "../types/authoring.js";
import { buildAuthorization } from "./authorization.js";

function entity(defaultValue: unknown = {}): CoreEntity {
  return {
    schemaVersion: 2,
    kind: "coreEntity",
    module: "example",
    entity: "ProtectedRecord",
    title: "Protected record",
    language: "en",
    fields: [
      {
        key: "authorization",
        osfType: "object",
        baseType: "object",
        required: true,
        defaultValue,
        persisted: { column: "authorization", storageClass: "core" },
      },
    ],
    authorization: {
      roles: {
        read: ["Records.All.Read"],
        create: ["Records.All.Manage"],
        update: ["Records.All.Manage"],
        delete: ["Records.All.Delete"],
      },
      rowAccess: {
        enabled: true,
        empty: "public",
        recordPermissions: {
          field: "authorization",
          empty: "public",
          createRequires: ["view", "edit"],
        },
      },
    },
  };
}

describe("authorization record permissions", () => {
  test("compiles one persisted jsonb field into the generic record ACL", () => {
    expect(buildAuthorization(entity(), [], []).rowAccess).toEqual({
      enabled: true,
      empty: "public",
      recordPermissions: {
        field: "authorization",
        column: "authorization",
        empty: "public",
        createRequires: ["view", "edit"],
        defaultValue: {},
      },
    });
  });

  test("accepts only the fixed action and subject shape", () => {
    expect(() =>
      buildAuthorization(
        entity({
          view: { users: ["user-1"], groups: [], roles: [] },
          edit: { roles: ["Records.All.Manage"] },
          delete: {},
        }),
        [],
        [],
      ),
    ).not.toThrow();

    for (const malformed of [
      null,
      [],
      "{}",
      { unknown: {} },
      { view: [] },
      { view: { unknown: [] } },
      { view: { users: "user-1" } },
      { view: { users: [""] } },
    ]) {
      expect(() => buildAuthorization(entity(malformed), [], [])).toThrow(
        /malformed defaultValue/,
      );
    }
  });

  test("requires a required persisted single object field", () => {
    const invalid = entity();
    invalid.fields[0]!.required = false;
    expect(() => buildAuthorization(invalid, [], [])).toThrow(
      /required, persisted, single object field/,
    );
  });
});

describe("named record actions", () => {
  function withActions(
    actions: unknown,
    extraFields: unknown[] = [],
    defaultValue: unknown = {},
  ): CoreEntity {
    const base = entity(defaultValue);
    base.fields = [...base.fields, ...(extraFields as typeof base.fields)];
    base.authorization!.rowAccess!.recordPermissions!.actions = actions as never;
    return base;
  }
  const storedField = (key: string, overrides: Record<string, unknown> = {}) => ({
    key, osfType: "string", baseType: "string", required: false,
    persisted: { column: key, storageClass: "core" }, ...overrides,
  });

  test("compiles declared actions, sorted, with their principals, reads and lock", () => {
    const compiled = buildAuthorization(
      withActions(
        [
          { name: "start", principals: ["integration"], reads: ["status", "definition"] },
          { name: "follow", principals: ["integration", "person"], lock: "shared" },
        ],
        [storedField("definition"), storedField("status")],
      ),
      [], [],
    );
    // `lock` is always emitted, so the manifest states the mode each action
    // was compiled with rather than leaving the migration to re-apply a
    // default a later release might change.
    expect(compiled.rowAccess!.recordPermissions!.actions).toEqual([
      { name: "follow", principals: ["integration", "person"], lock: "shared" },
      { name: "start", principals: ["integration"], reads: ["definition", "status"], lock: "exclusive" },
    ]);
  });

  test("refuses a lock mode that is neither exclusive nor shared", () => {
    expect(() => buildAuthorization(
      withActions([{ name: "start", principals: ["integration"], lock: "none" }]), [], [],
    )).toThrow(/must be "exclusive"/);
  });

  test("an integration action derives a principal-class policy that excludes applications", () => {
    // The hole: the application's key may hold this entity's read role on its
    // service account, and generated CRUD and derived search ask only for the
    // role. An entity that hands an application ONE record by grant has not
    // agreed to hand it the collection.
    const compiled = buildAuthorization(
      withActions([{ name: "start", principals: ["integration"] }]), [], [],
    );
    expect(compiled.principalClasses).toEqual(["person", "service", "unknown"]);
  });

  test("a person-only action derives nothing, and no action derives nothing", () => {
    expect(buildAuthorization(
      withActions([{ name: "approve", principals: ["person"] }]), [], [],
    ).principalClasses).toBeUndefined();
    expect(buildAuthorization(entity(), [], []).principalClasses).toBeUndefined();
  });

  test("an authored list wins over the derivation, in either direction", () => {
    const authored = (classes: string[]) => {
      const base = withActions([{ name: "start", principals: ["integration"] }]);
      base.authorization!.principalClasses = classes as never;
      return base;
    };
    // Re-admitting applications is a decision with a reviewer, not an omission.
    expect(buildAuthorization(authored(["application", "person"]), [], []).principalClasses)
      .toEqual(["application", "person"]);
    // And an entity with no action may still close itself.
    const closed = entity();
    closed.authorization!.principalClasses = ["person"];
    expect(buildAuthorization(closed, [], []).principalClasses).toEqual(["person"]);
  });

  test("refuses an empty or unknown principal class", () => {
    for (const classes of [[], ["anonymous"], ["person", "robot"]]) {
      const base = entity();
      base.authorization!.principalClasses = classes as never;
      expect(() => buildAuthorization(base, [], []))
        .toThrow(/authorization\.principalClasses must list at least one of/);
    }
  });

  test("an entity that declares nothing carries no action axis at all", () => {
    expect(buildAuthorization(entity(), [], []).rowAccess!.recordPermissions)
      .not.toHaveProperty("actions");
  });

  test("refuses a name that is not a lowerCamel identifier outside the permissions", () => {
    for (const name of ["view", "edit", "delete", "Start", "start-run", "", "1start", "start run"]) {
      expect(() => buildAuthorization(
        withActions([{ name, principals: ["integration"] }]), [], [],
      )).toThrow(/lowerCamel identifier/);
    }
  });

  test("refuses a duplicate action and an action nobody may hold", () => {
    expect(() => buildAuthorization(withActions([
      { name: "start", principals: ["integration"] },
      { name: "start", principals: ["person"] },
    ]), [], [])).toThrow(/declares "start" twice/);
    for (const principals of [[], undefined, ["robot"], ["person", "robot"]]) {
      expect(() => buildAuthorization(
        withActions([{ name: "start", principals }]), [], [],
      )).toThrow(/must declare at least one of/);
    }
  });

  test("refuses a read projection that would reach past one plain stored column", () => {
    // An unknown field, whatever else is declared.
    expect(() => buildAuthorization(
      withActions([{ name: "start", principals: ["integration"], reads: ["missing"] }]), [], [],
    )).toThrow(/is not a field of this entity/);
    // The ACL itself.
    expect(() => buildAuthorization(
      withActions([{ name: "start", principals: ["integration"], reads: ["authorization"] }]), [], [],
    )).toThrow(/it is the record ACL itself/);
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [{ persisted: undefined }, /not persisted/],
      [{ relationship: { kind: "belongsTo", target: "Other" } }, /reach another record/],
      [{ computed: { resolver: "labelRules" } }, /computed rather than stored/],
      [{ localized: true }, /localized/],
      [{ classification: { sensitivity: "pii" } }, /classified/],
      [{ authorization: { roles: { read: ["Some.Role"] } } }, /own field authorization/],
    ];
    for (const [overrides, pattern] of refusals) {
      expect(() => buildAuthorization(
        withActions(
          [{ name: "start", principals: ["integration"], reads: ["definition"] }],
          [storedField("definition", overrides)],
        ), [], [],
      )).toThrow(pattern);
    }
  });

  test("refuses a seeded ACL that grants an undeclared action or principal kind", () => {
    const integration = "11111111-1111-4111-8111-111111111111";
    expect(() => buildAuthorization(withActions(
      [{ name: "start", principals: ["integration"] }], [],
      { actions: { publish: { integrations: [integration] } } },
    ), [], [])).toThrow(/does not declare/);
    expect(() => buildAuthorization(withActions(
      [{ name: "start", principals: ["integration"] }], [],
      { actions: { start: { roles: ["Some.Role"] } } },
    ), [], [])).toThrow(/does not declare/);
    // The matching declaration is accepted.
    expect(() => buildAuthorization(withActions(
      [{ name: "start", principals: ["integration"] }], [],
      { actions: { start: { integrations: [integration] } } },
    ), [], [])).not.toThrow();
  });

  test("an integration may never be named for a record permission", () => {
    const integration = "11111111-1111-4111-8111-111111111111";
    expect(() => buildAuthorization(withActions(
      [{ name: "start", principals: ["integration"] }], [],
      { view: { integrations: [integration] } },
    ), [], [])).toThrow(/malformed defaultValue/);
  });
});
