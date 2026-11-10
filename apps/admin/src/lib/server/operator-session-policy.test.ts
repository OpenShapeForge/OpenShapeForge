// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { operatorSessionRedirect } from "./operator-session-policy";
test("recoverable sessions cannot reach operator data or be mistaken for a role denial", () => {
  for (const isPlatformOperator of [undefined, false, true]) {
    expect(operatorSessionRedirect({ error: "RefreshTokenUnavailable", isPlatformOperator }, "/tenants?status=active")).toBe("/login?callbackUrl=%2Ftenants%3Fstatus%3Dactive&reason=session_unavailable");
  }
  expect(operatorSessionRedirect({ error: "RefreshTokenError", isPlatformOperator: true }, "/tenants")).toBe("/login?callbackUrl=%2Ftenants&reason=session_expired");
  expect(operatorSessionRedirect(null, "/tenants")).toBe("/login?callbackUrl=%2Ftenants");
  expect(operatorSessionRedirect({ isPlatformOperator: false }, "/tenants")).toBe("/not-authorized");
  expect(operatorSessionRedirect({ isPlatformOperator: true }, "/tenants")).toBeNull();
});
test("login recovery never accepts an external callback", () => {
  for (const path of ["//attacker.test", "https://attacker.test", "/https://attacker.test"]) {
    expect(operatorSessionRedirect({ error: "RefreshTokenUnavailable" }, path)).toBe("/login?callbackUrl=%2F&reason=session_unavailable");
  }
});
