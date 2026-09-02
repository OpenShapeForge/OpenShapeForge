// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import {
  invocationSourceReferenceMatches,
  mintInvocationSourceReference,
  sameInvocationSourceReference,
} from "../source-reference.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const identity = {
  tenantId: TENANT,
  actorId: ACTOR,
  scope: "personal" as const,
  connectionTable: "connections",
  connectionId: "33333333-3333-4333-8333-333333333333",
};

describe("durable invocation source references", () => {
  it("is stable for one connection authority and opaque", () => {
    const first = mintInvocationSourceReference(identity);
    const second = mintInvocationSourceReference({ ...identity });
    expect(first).toBe(second);
    expect(first).toMatch(/^msr1\.[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(identity.connectionId);
    expect(invocationSourceReferenceMatches(first, identity)).toBe(true);
    expect(sameInvocationSourceReference(first, second)).toBe(true);
  });

  it("binds tenant, personal actor, scope, table and connection", () => {
    const reference = mintInvocationSourceReference(identity);
    for (const changed of [
      { ...identity, tenantId: "other-tenant" },
      { ...identity, actorId: "other-actor" },
      { ...identity, scope: "tenant" as const, actorId: null },
      { ...identity, connectionTable: "other_connections" },
      { ...identity, connectionId: "other-connection" },
    ]) {
      expect(invocationSourceReferenceMatches(reference, changed)).toBe(false);
    }
    expect(sameInvocationSourceReference(reference, `${reference.slice(0, -1)}x`)).toBe(false);
  });

  it("rejects incomplete connection identities before minting", () => {
    for (const changed of [
      { ...identity, tenantId: "" },
      { ...identity, actorId: null },
      { ...identity, connectionTable: "" },
      { ...identity, connectionId: "" },
    ]) {
      expect(() => mintInvocationSourceReference(changed)).toThrow(/incomplete/);
    }
  });
});
