// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import type { TrustedSessionContext } from "../auth/trusted-context.js";
import { generatedRestSession } from "./generated-rest-routes.js";

test("generated REST preserves verified login-session control metadata", () => {
  const resolved: TrustedSessionContext = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    loginSessionBinding: "lsb1.verified-browser-session",
    userDisplayName: "Verified user",
    roles: ["Example.All.Write"],
    oauthScopes: ["example:write"],
    groups: ["33333333-3333-4333-8333-333333333333"],
    relationGroupIds: ["44444444-4444-4444-8444-444444444444"],
    scope: "tenant",
    credential: "bearer",
  };

  expect(generatedRestSession(resolved)).toEqual(resolved);
});
