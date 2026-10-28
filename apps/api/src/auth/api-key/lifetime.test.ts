// SPDX-License-Identifier: BUSL-1.1
/**
 * The deployment's credential lifetime rule: what it reads, what it refuses,
 * and — the point of the whole split — what it leaves alone.
 *
 * The behaviour that must not regress is the UNDECLARED one. The REST and
 * GraphQL mounts have always taken any positive number of days and `null` for
 * "never expires", and keys minted that way are live. A deployment that
 * declares nothing must still get exactly that.
 */
import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_DEFAULT_TTL_ENV,
  CREDENTIAL_MAX_TTL_ENV,
  DEFAULT_CREDENTIAL_TTL_DAYS,
  PRODUCT_MAX_CREDENTIAL_TTL_DAYS,
  readCredentialLifetimePolicy,
  resolveCredentialExpiry,
  UNDECLARED_CREDENTIAL_LIFETIME_POLICY,
  type CredentialLifetimePolicy,
} from "./lifetime.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** The expiry a verdict landed on, or the refusal it gave instead. */
function expiry(requested: number | null | undefined, policy: CredentialLifetimePolicy) {
  const verdict = resolveCredentialExpiry(requested, policy, NOW);
  return "refused" in verdict ? verdict.refused : verdict.expiresAt;
}

function days(expiresAt: Date | null): number | null {
  return expiresAt === null ? null : Math.round((expiresAt.getTime() - NOW.getTime()) / DAY_MS);
}

describe("reading the policy", () => {
  test("an empty environment declares no maximum and the product default", () => {
    expect(readCredentialLifetimePolicy({})).toEqual({
      maxDays: null,
      defaultDays: DEFAULT_CREDENTIAL_TTL_DAYS,
    });
    expect(readCredentialLifetimePolicy({})).toEqual(UNDECLARED_CREDENTIAL_LIFETIME_POLICY);
  });

  test("an empty string is not a declaration", () => {
    // An unset variable and one set to nothing are the same statement: the
    // operator has not declared a rule. Reading "" as 0 would be a rule
    // nobody wrote, and the strictest one possible.
    expect(readCredentialLifetimePolicy({
      [CREDENTIAL_MAX_TTL_ENV]: "  ",
      [CREDENTIAL_DEFAULT_TTL_ENV]: "",
    })).toEqual(UNDECLARED_CREDENTIAL_LIFETIME_POLICY);
  });

  test("a declared maximum narrows the default with it", () => {
    expect(readCredentialLifetimePolicy({ [CREDENTIAL_MAX_TTL_ENV]: "30" }))
      .toEqual({ maxDays: 30, defaultDays: 30 });
  });

  test("a declared default stands on its own inside the maximum", () => {
    expect(readCredentialLifetimePolicy({
      [CREDENTIAL_MAX_TTL_ENV]: "90",
      [CREDENTIAL_DEFAULT_TTL_ENV]: "14",
    })).toEqual({ maxDays: 90, defaultDays: 14 });
  });

  test("a maximum at the product ceiling is a declaration, not a widening", () => {
    expect(readCredentialLifetimePolicy({
      [CREDENTIAL_MAX_TTL_ENV]: String(PRODUCT_MAX_CREDENTIAL_TTL_DAYS),
    })).toEqual({ maxDays: PRODUCT_MAX_CREDENTIAL_TTL_DAYS, defaultDays: DEFAULT_CREDENTIAL_TTL_DAYS });
  });

  test("refuses to interpret a value that would widen or make no sense", () => {
    // Every one of these disables provisioning rather than resolving to
    // something permissive: a credential rule nobody chose is worse than no
    // credential at all. The first is the one that matters — configuration
    // cannot raise the product's own bound.
    for (const env of [
      { [CREDENTIAL_MAX_TTL_ENV]: String(PRODUCT_MAX_CREDENTIAL_TTL_DAYS + 1) },
      { [CREDENTIAL_MAX_TTL_ENV]: "3650" },
      { [CREDENTIAL_MAX_TTL_ENV]: "0" },
      { [CREDENTIAL_MAX_TTL_ENV]: "-30" },
      { [CREDENTIAL_MAX_TTL_ENV]: "30.5" },
      { [CREDENTIAL_MAX_TTL_ENV]: "forever" },
      { [CREDENTIAL_MAX_TTL_ENV]: "null" },
      { [CREDENTIAL_DEFAULT_TTL_ENV]: "0" },
      { [CREDENTIAL_DEFAULT_TTL_ENV]: "later" },
      // A default outside the deployment's own maximum is a typo, not a
      // value to clamp silently.
      { [CREDENTIAL_MAX_TTL_ENV]: "30", [CREDENTIAL_DEFAULT_TTL_ENV]: "60" },
      { [CREDENTIAL_DEFAULT_TTL_ENV]: String(PRODUCT_MAX_CREDENTIAL_TTL_DAYS + 1) },
    ]) {
      expect(readCredentialLifetimePolicy(env)).toBeUndefined();
    }
  });
});

describe("an undeclared policy leaves the existing surfaces alone", () => {
  const policy = UNDECLARED_CREDENTIAL_LIFETIME_POLICY;

  test("still issues a credential that never expires when one is asked for", () => {
    expect(expiry(null, policy)).toBeNull();
  });

  test("still accepts a lifetime past the product's own contract bound", () => {
    // The 366-day bound belongs to the canonical Operations' input schema.
    // Imposing it here would silently shorten lifetimes the long-lived REST
    // and GraphQL mounts have always granted.
    expect(days(expiry(3650, policy) as Date)).toBe(3650);
    expect(days(expiry(PRODUCT_MAX_CREDENTIAL_TTL_DAYS + 1, policy) as Date))
      .toBe(PRODUCT_MAX_CREDENTIAL_TTL_DAYS + 1);
  });

  test("takes the product default when no lifetime is named", () => {
    expect(days(expiry(undefined, policy) as Date)).toBe(DEFAULT_CREDENTIAL_TTL_DAYS);
  });
});

describe("a declared policy binds every mint", () => {
  const policy: CredentialLifetimePolicy = { maxDays: 30, defaultDays: 7 };

  test("issues inside the maximum", () => {
    expect(days(expiry(30, policy) as Date)).toBe(30);
    expect(days(expiry(1, policy) as Date)).toBe(1);
  });

  test("takes the deployment's default when no lifetime is named", () => {
    expect(days(expiry(undefined, policy) as Date)).toBe(7);
  });

  test("refuses a lifetime past the maximum, naming the maximum", () => {
    expect(expiry(31, policy)).toBe("A credential may live at most 30 days on this deployment.");
  });

  test("refuses a non-expiring credential once a maximum is named", () => {
    // Declaring a maximum lifetime says every credential expires. The
    // refusal is explicit rather than a silent substitution of the default,
    // which would hand back something other than what was asked for.
    expect(expiry(null, policy)).toMatch(/requires every credential to expire within 30 days/);
  });

  test("refuses a lifetime that is not a whole number of days", () => {
    for (const requested of [0, -1, 1.5, Number.NaN]) {
      expect(expiry(requested, policy))
        .toBe("expiresInDays must be a whole number of days of at least 1.");
    }
  });
});
