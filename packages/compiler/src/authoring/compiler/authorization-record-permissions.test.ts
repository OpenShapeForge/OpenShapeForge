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
        valueType: "object",
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
