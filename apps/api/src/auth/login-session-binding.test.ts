// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { loginSessionBindingFromClaims } from "./login-session-binding.js";

const SECRET = "login-session-binding-test-7Zp1_xK9-vR3_mN5-qT8_cW2";

describe("loginSessionBindingFromClaims", () => {
  test("is stable for one verified sid and changes for another", () => {
    const first = loginSessionBindingFromClaims({ sid: "session-a" }, { secret: SECRET });
    expect(first).toMatch(/^lsb1\.[A-Za-z0-9_-]+$/);
    expect(loginSessionBindingFromClaims({ sid: "session-a" }, { secret: SECRET })).toBe(first);
    expect(loginSessionBindingFromClaims({ sid: "session-b" }, { secret: SECRET })).not.toBe(first);
    expect(first).not.toContain("session-a");
  });

  test("fails closed without a sid or cryptographically usable secret", () => {
    expect(loginSessionBindingFromClaims({}, { secret: SECRET })).toBeUndefined();
    expect(loginSessionBindingFromClaims({ sid: "session-a" }, { secret: "short" })).toBeUndefined();
    expect(loginSessionBindingFromClaims(
      { sid: "session-a" },
      { secret: "openshapeforge-local-dev-context-secret" },
    )).toBeUndefined();
  });
});
