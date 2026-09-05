// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  capturePersonalOAuthConnections,
  normalizeConnectionValueRows,
} from "../generated-mcp-server.js";

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

describe("connection value rows", () => {
  it("reads a double-encoded values column as the object it encodes", () => {
    const values = {
      accessToken: { ciphertext: "c", keyId: "k", algorithm: "aes-256-gcm" },
      grantedScopes: ["openid"],
      accessTokenExpiresAt: "2026-09-05T07:58:14.000Z",
    };
    const rows = normalizeConnectionValueRows(
      [
        { id: "string-row", ownerUserId: "actor-a", values: JSON.stringify(values) },
        { id: "object-row", ownerUserId: null, values },
        { id: "broken-row", ownerUserId: null, values: "{not json" },
        { id: "scalar-row", ownerUserId: null, values: "\"plain\"" },
        { id: "empty-row", ownerUserId: null },
      ],
      "values",
    );
    expect(rows[0]!.values).toEqual(values);
    expect(rows[1]!.values).toBe(values);
    expect(rows[2]!.values).toBe("{not json");
    expect(rows[3]!.values).toBe('"plain"');
    expect(rows[4]!.values).toBeUndefined();
  });
});
