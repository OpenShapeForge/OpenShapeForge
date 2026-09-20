// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  deriveEntityOperationErrors,
  withDeclaredEntityOperationErrors,
} from "./entity-operation-errors.js";

const codes = (errors: readonly { status: number; code: string }[]) =>
  errors.map((error) => `${error.status} ${error.code}`);

describe("derived entity Operation errors", () => {
  test("a plain read declares only what the runtime can refuse", () => {
    expect(codes(deriveEntityOperationErrors("Widget", "get", {
      confirmation: { mode: "none" }, recordPermissions: false,
    }))).toEqual(["401 UNAUTHENTICATED", "403 FORBIDDEN", "404 NOT_FOUND"]);
  });

  test("controls add their refusals", () => {
    const errors = codes(deriveEntityOperationErrors("Widget", "delete", {
      concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
      },
      confirmation: { mode: "acknowledgement" },
      recordPermissions: true,
    }));
    expect(errors).toContain("409 VERSION_CONFLICT");
    expect(errors).toContain("423 LOCKED");
    expect(errors).toContain("428 CONFIRMATION_REQUIRED");
    expect(errors).toContain("409 REFERENCE_IN_USE");
    expect(errors).not.toContain("400 CONFIRMATION_MISMATCH");
  });

  test("a declared error wins over the derived one with the same status and code", () => {
    const merged = withDeclaredEntityOperationErrors(
      [{ status: 404, code: "NOT_FOUND", description: "derived" }],
      [{ status: 404, code: "NOT_FOUND", description: "authored" }, { status: 409, code: "CONFLICT", description: "busy" }],
    );
    expect(merged).toEqual([
      { status: 404, code: "NOT_FOUND", description: "authored" },
      { status: 409, code: "CONFLICT", description: "busy" },
    ]);
  });
});
