// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { capturePersonalOAuthConnections } from "../generated-mcp-server.js";

describe("personal OAuth invocation source capture", () => {
  it("captures exactly one tenant support row and every actor-owned connection", () => {
    const selected = capturePersonalOAuthConnections([
      { id: "tenant-config", ownerUserId: null },
      { id: "personal-b", ownerUserId: "actor-a" },
      { id: "other-person", ownerUserId: "actor-b" },
      { id: "personal-a", ownerUserId: "actor-a" },
    ], "actor-a");
    expect(selected.tenantSupport.id).toBe("tenant-config");
    expect(selected.personal.map((row) => row.id)).toEqual([
      "personal-a",
      "personal-b",
    ]);
  });

  it("fails closed with zero, multiple or unidentified tenant support rows", () => {
    for (const rows of [
      [{ id: "personal", ownerUserId: "actor-a" }],
      [
        { id: "tenant-a", ownerUserId: null },
        { id: "tenant-b", ownerUserId: null },
      ],
      [{ id: "", ownerUserId: null }],
    ]) {
      expect(() => capturePersonalOAuthConnections(rows, "actor-a")).toThrow(
        /Invocation source is unavailable/,
      );
    }
  });
});
