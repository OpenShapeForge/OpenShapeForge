// SPDX-License-Identifier: BUSL-1.1
/**
 * What a runtime module may learn about who is calling it.
 *
 * The application principal is the one identity a module cannot afford to
 * take from the request: it namespaces idempotency keys, it is stored as
 * provenance and it is the audited actor. These tests pin that the host is the
 * only source, that exactly one carrier produces an application, and that a
 * module cannot manufacture one by handing core an object of its own.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { applyTrustedContextHeaders, TRUSTED_CONTEXT_HEADERS } from "@openshapeforge/auth";
import { operationErrorOf } from "@openshapeforge/operations";
import {
  readTrustedSessionContext,
  type TrustedSessionContext,
} from "../auth/trusted-context.js";
import { PrincipalRuntime } from "./principals.js";

const tenantId = randomUUID();
const userId = randomUUID();
const integrationId = randomUUID();
const CONTEXT_SECRET = "principal-unit-test-context-secret";

function base(overrides: Partial<TrustedSessionContext> = {}): TrustedSessionContext {
  return {
    tenantId,
    userId,
    roles: [],
    groups: [],
    relationGroupIds: [],
    scope: "self",
    credential: "bearer",
    ...overrides,
  };
}

/** The shape auth/api-key/resolve.ts returns for a resolved key. */
function apiKeySession(overrides: Partial<TrustedSessionContext> = {}): TrustedSessionContext {
  return base({
    credential: "api-key",
    principalKind: "service",
    appPrincipal: { integrationId },
    roles: ["Relations.All.Read"],
    ...overrides,
  });
}

/** The identity↔Relation link the host reads back for a web-tier person. */
function linked(subject: string) {
  return {
    relation: {
      identityId: randomUUID(),
      issuer: "https://identity.example/realms/test",
      subject,
      status: "linked",
    },
  } as Partial<TrustedSessionContext>;
}

function harness(...live: TrustedSessionContext[]) {
  const accepted = new Set(live);
  const runtime = new PrincipalRuntime({
    acceptsSession: (candidate) => accepted.has(candidate),
  });
  return { services: runtime.services, accepted };
}

function failureCode(call: () => unknown): string | undefined {
  try {
    call();
  } catch (error) {
    return operationErrorOf(error)?.code;
  }
  return undefined;
}

describe("the module-facing principal classification", () => {
  test("a resolved API key is the one carrier that produces an application", () => {
    const session = apiKeySession();
    const { services } = harness(session);
    expect(services.classOf(session)).toBe("application");
    expect(services.application(session)).toEqual({ integrationId });
    // The answer is frozen: a module cannot retarget a later write by
    // mutating the object core handed it.
    expect(Object.isFrozen(services.application(session))).toBe(true);
  });

  test("a bearer service account of the same integration is not that application", () => {
    // The integration's own Keycloak service account, presented directly.
    // Same tenant, same roles, no resolved key: configured automation, which
    // keeps working exactly as before and holds no application identity.
    const session = base({ credential: "bearer", principalKind: "service", roles: ["Relations.All.Read"] });
    const { services } = harness(session);
    expect(services.classOf(session)).toBe("service");
    expect(services.application(session)).toBeUndefined();
  });

  test("a verified person and a linked web-tier session stay persons", () => {
    const bearer = base({ principalKind: "person" });
    const web = base({ credential: "trusted-context", ...linked(userId) });
    const { services } = harness(bearer, web);
    expect(services.classOf(bearer)).toBe("person");
    expect(services.classOf(web)).toBe("person");
    expect(services.application(bearer)).toBeUndefined();
    expect(services.application(web)).toBeUndefined();
  });

  test("a capability grant and an unclassifiable carrier are neither", () => {
    const grant = base({
      credential: "grant",
      userId: randomUUID(),
      grant: {
        id: randomUUID(),
        subject: { entity: "Relation", id: randomUUID() },
        recipient: { kind: "email" },
        operations: [],
        records: [],
        expiresAt: new Date().toISOString(),
        maxUses: null,
      },
    });
    const bare = base({ credential: "trusted-context" });
    const { services } = harness(grant, bare);
    expect(services.classOf(grant)).toBe("unknown");
    expect(services.classOf(bare)).toBe("unknown");
    expect(services.application(grant)).toBeUndefined();
    expect(services.application(bare)).toBeUndefined();
  });

  test("a signed trusted-context bundle cannot name an application", () => {
    // A correctly signed bundle — the web tier's own carrier — plus every
    // header an attacker in that position might add. The reader builds the
    // session from the signed fields only, so no amount of header content
    // becomes an application principal.
    const headers = new Headers();
    applyTrustedContextHeaders(
      headers,
      { tenantId, userId, roles: ["Relations.All.Read"], groups: [] },
      { secret: CONTEXT_SECRET },
    );
    headers.set("x-openshapeforge-app-principal", integrationId);
    headers.set("x-openshapeforge-integration-id", integrationId);
    headers.set("x-openshapeforge-principal-kind", "application");
    headers.set(TRUSTED_CONTEXT_HEADERS.roles, "Relations.All.Read");
    const session = readTrustedSessionContext(headers, { secret: CONTEXT_SECRET });
    expect(session.tenantId).toBe(tenantId);
    expect(session.credential).toBe("trusted-context");
    expect(session.appPrincipal).toBeUndefined();
    const { services } = harness(session);
    expect(services.classOf(session)).not.toBe("application");
    expect(services.application(session)).toBeUndefined();
  });

  test("only the live session answers, so a module cannot supply its own", () => {
    const session = apiKeySession();
    const { services } = harness(session);
    // Same fields, different object: this is what a module would build if it
    // wanted to name an integration of its choosing.
    const forged = { ...session, appPrincipal: { integrationId: randomUUID() } };
    expect(failureCode(() => services.classOf(forged))).toBe("FORBIDDEN");
    expect(failureCode(() => services.application(forged))).toBe("FORBIDDEN");
  });

  test("an application principal that is not an integration id is a refusal, not a namespace", () => {
    // Only the API-key resolver writes this field, and it writes a uuid
    // primary key. Anything else means another path invented a principal.
    const session = apiKeySession({ appPrincipal: { integrationId: "integration-name" } });
    const { services } = harness(session);
    expect(services.classOf(session)).toBe("application");
    expect(failureCode(() => services.application(session))).toBe("FORBIDDEN");
  });
});
