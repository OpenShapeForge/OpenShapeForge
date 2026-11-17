// SPDX-License-Identifier: BUSL-1.1
/**
 * Personal API keys, without a database: the wire format and the three
 * rights. The database and realm behaviour is proven end to end in
 * __tests__/personal-api-key.e2e.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  API_KEY_MANAGE_ROLE,
  ApiKeyAuthorizationError,
  assertMayHoldPersonalKeys,
  assertMayManageApiKeys,
  assertMayReadPersonalKeys,
  assertMayRevokePersonalKeys,
  PERSONAL_KEY_READ_ROLE,
  PERSONAL_KEY_REVOKE_ROLE,
  PERSONAL_KEY_ROLE,
  type CeilingSession,
} from "./ceiling.js";
import {
  looksLikeApiKey,
  looksLikePersonalApiKey,
  mintApiKey,
  mintPersonalApiKey,
  parseApiKey,
  parsePersonalApiKey,
  secretMatches,
} from "./format.js";

describe("personal key format", () => {
  test("a minted personal key round-trips and carries its own prefix", () => {
    const minted = mintPersonalApiKey();
    expect(minted.token).toStartWith("osf_user_");
    const parsed = parsePersonalApiKey(minted.token);
    expect(parsed?.lookupId).toBe(minted.lookupId);
    expect(secretMatches(parsed!.secret, minted.secretHash)).toBe(true);
  });

  test("the two kinds never parse as each other", () => {
    const personal = mintPersonalApiKey().token;
    const integration = mintApiKey().token;
    expect(looksLikeApiKey(personal)).toBe(false);
    expect(parseApiKey(personal)).toBeUndefined();
    expect(looksLikePersonalApiKey(integration)).toBe(false);
    expect(parsePersonalApiKey(integration)).toBeUndefined();
  });

  test("a personal key with the integration prefix swapped in fails its checksum", () => {
    const personal = mintPersonalApiKey().token;
    const swapped = personal.replace("osf_user_", "osf_live_");
    expect(parseApiKey(swapped)).toBeUndefined();
  });

  test("a tampered personal key is refused before any lookup", () => {
    const token = mintPersonalApiKey().token;
    const last = token.at(-1) === "A" ? "B" : "A";
    expect(parsePersonalApiKey(`${token.slice(0, -1)}${last}`)).toBeUndefined();
  });
});

const person = (roles: string[]): CeilingSession => ({ roles, credential: "bearer", principalKind: "person" });

describe("personal key rights", () => {
  test("the owner right admits holding keys, and narrowing to roles held", () => {
    const owner = person([PERSONAL_KEY_ROLE, "Relations.All.Read"]);
    expect(() => assertMayHoldPersonalKeys(owner)).not.toThrow();
    expect(() => assertMayHoldPersonalKeys(owner, ["Relations.All.Read"])).not.toThrow();
  });

  test("narrowing to a role the owner does not hold is refused", () => {
    expect(() =>
      assertMayHoldPersonalKeys(person([PERSONAL_KEY_ROLE]), ["Relations.All.ReadWrite"]),
    ).toThrow(ApiKeyAuthorizationError);
  });

  test("without the owner right nobody holds personal keys, administrator or not", () => {
    expect(() => assertMayHoldPersonalKeys(person([API_KEY_MANAGE_ROLE]))).toThrow(ApiKeyAuthorizationError);
  });

  test("the three rights are independent", () => {
    const reader = person([PERSONAL_KEY_READ_ROLE]);
    const revoker = person([PERSONAL_KEY_REVOKE_ROLE]);
    expect(() => assertMayReadPersonalKeys(reader)).not.toThrow();
    expect(() => assertMayRevokePersonalKeys(reader)).toThrow(ApiKeyAuthorizationError);
    expect(() => assertMayRevokePersonalKeys(revoker)).not.toThrow();
    expect(() => assertMayReadPersonalKeys(revoker)).toThrow(ApiKeyAuthorizationError);
    expect(() => assertMayReadPersonalKeys(person([PERSONAL_KEY_ROLE]))).toThrow(ApiKeyAuthorizationError);
  });

  test("the integration right does not confer oversight of personal keys", () => {
    const integrationAdmin = person([API_KEY_MANAGE_ROLE]);
    expect(() => assertMayReadPersonalKeys(integrationAdmin)).toThrow(ApiKeyAuthorizationError);
    expect(() => assertMayRevokePersonalKeys(integrationAdmin)).toThrow(ApiKeyAuthorizationError);
  });

  test("no API key of either kind reaches any key management, whatever it holds", () => {
    const everything = [API_KEY_MANAGE_ROLE, PERSONAL_KEY_ROLE, PERSONAL_KEY_READ_ROLE, PERSONAL_KEY_REVOKE_ROLE];
    for (const session of [
      { roles: everything, credential: "personal-key", principalKind: "person" },
      { roles: everything, credential: "api-key", principalKind: "service" },
    ] satisfies CeilingSession[]) {
      for (const gate of [
        () => assertMayHoldPersonalKeys(session),
        () => assertMayReadPersonalKeys(session),
        () => assertMayRevokePersonalKeys(session),
        () => assertMayManageApiKeys(session),
      ]) {
        expect(gate).toThrow("API keys cannot manage API keys");
      }
    }
  });

  test("a session not classified as a person is refused", () => {
    const unclassified: CeilingSession = { roles: [PERSONAL_KEY_ROLE], credential: "trusted-context" };
    expect(() => assertMayHoldPersonalKeys(unclassified)).toThrow(ApiKeyAuthorizationError);
  });
});
