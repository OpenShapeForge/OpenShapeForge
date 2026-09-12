import { expect, test } from "bun:test";
import type { OpenShapeForgeDatabase } from "../../db/connection.js";
import { ModulePlatformRuntime } from "../platform.js";
import type { TrustedSessionContext } from "../../auth/trusted-context.js";

test("only a live verified tenant session can select its host-owned automatic identity", async () => {
  const key = "OPENSHAPEFORGE_ORGANIZATION_SERVICE_IDENTITIES";
  const saved = process.env[key];
  const session: TrustedSessionContext = { tenantId: "11111111-1111-4111-8111-111111111111", userId: "actor",
    roles: [], groups: [], scope: "tenant", credential: "bearer" };
  process.env[key] = JSON.stringify([{ tenantId: session.tenantId, clientId: "automatic-org", clientSecret: "must-not-be-exposed" }]);
  try {
    const runtime = new ModulePlatformRuntime({} as OpenShapeForgeDatabase);
    const resolve = runtime.services.durableOperations!.organizationServiceIdentity;
    await expect(resolve(session)).rejects.toThrow("live verified");
    let retained!: TrustedSessionContext;
    await runtime.withActiveOperationSession(session, async (active) => {
      retained = active;
      expect(await resolve(active)).toEqual({ serviceIdentityId: "automatic-org" });
      await expect(resolve({ ...active, tenantId: "other" })).rejects.toThrow("live verified");
    });
    await expect(resolve(retained)).rejects.toThrow("live verified");
    await runtime.withActiveOperationSession({ ...session, tenantId: "22222222-2222-4222-8222-222222222222" }, async (active) => {
      await expect(resolve(active)).rejects.toThrow("No automatic service identity");
    });
  } finally {
    if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
  }
});
