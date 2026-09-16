// SPDX-License-Identifier: BUSL-1.1
/**
 * Provisioning end to end: a real operator token, the real control surface, the
 * real identity-configuration SPI, and then RLS.
 *
 * WHAT THIS PROVES THAT THE OTHER TWO SUITES CANNOT
 * -------------------------------------------------
 * `src/db/__tests__/control-provisioning.test.ts` runs the provisioning service
 * against a real database with a FAKE Keycloak; `src/control/__tests__/*` runs
 * the pure logic with no I/O at all. Neither reaches Keycloak, so neither can
 * observe that a tenant's root Organization and a sub-organisation's child
 * Organization actually EXIST in a realm, nor that the SPI accepted the
 * hierarchy it was handed. That is this file's first half.
 *
 * The second half is the one the whole workstream turns on: a tenant created
 * through the control plane must be as isolated as a seeded one. Provisioning
 * writes a `platform.tenants` row through an audited `withSystemSession`
 * bypass — the one code path in the system that is allowed to ignore the tenant
 * predicate — so "did the bypass leak into the tenant surface" is a real
 * question, and the answer has to be measured rather than assumed. The new
 * tenant's id is driven through the ORDINARY GraphQL surface and checked against
 * an existing tenant in both directions.
 *
 * OPT-IN, LIKE THE BEARER TESTS
 * -----------------------------
 * Skipped unless the control plane is configured AND an operator token can be
 * obtained from the control realm. Same bargain as `transport-auth.e2e.test.ts`:
 * a suite that silently ran these against no Keycloak would prove nothing, and
 * one that failed without a Keycloak would make the default `bun run test:e2e`
 * unrunnable. Both realms come from `bun run generate` and the compose stack:
 *
 *   export OPENSHAPEFORGE_CONTROL_KEYCLOAK_BASE_URL=http://localhost:8181
 *   export KEYCLOAK_CLIENT_SECRET_OPENSHAPEFORGE_AUTH_API=openshapeforge-auth-api-secret
 *   export OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER=http://localhost:8181/realms/openshapeforge-control
 *   export OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_JWKS_URI=$OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_ISSUER/protocol/openid-connect/certs
 *   export OPENSHAPEFORGE_CONTROL_VERIFY_BEARER_CLIENT_ID=openshapeforge-admin-gateway
 *
 * WHY THE ROUTES AND NOT THE SERVICE
 * ----------------------------------
 * The control surface is Fastify, not GraphQL, so the harness's `gql` cannot
 * reach it. Calling `provisionTenant` directly would skip authentication,
 * authorization and the error mapping — and would make the operator token, which
 * is the only thing standing between the internet and a cross-tenant registry,
 * untested here. So the routes are registered on a bare Fastify instance and
 * driven with `inject`, carrying the same unparsed-buffer JSON parser
 * `roles/api.ts` installs.
 *
 * CLEANUP
 * -------
 * The control surface has no delete, by design — a tenant registry that can
 * forget a tenant is not a registry. So this file cleans up behind itself the
 * only way available: the Keycloak Organizations through Keycloak's own admin
 * API, and the rows through the same audited bypass provisioning used to write
 * them. A suite that littered a shared realm with a tenant per run is a suite
 * people stop running.
 */
import { afterAll, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "kysely";
import { readControlPlaneConfig, type ControlPlaneConfig } from "../../control/config.js";
import { registerControlRestRoutes } from "../../control/rest-routes.js";
import { SYSTEM_BYPASS_ROLE, withSystemSession } from "../../db/session.js";
import {
  describe,
  expectData,
  getRuntime,
  gql,
  registerSuiteLifecycle,
  seed,
  tenantA,
  test,
  type Identity,
} from "./e2e/harness.js";
import { createRow, tables } from "./e2e/entity-factory.js";

registerSuiteLifecycle();

const configResult = readControlPlaneConfig();
const config: ControlPlaneConfig | null = configResult.ok ? configResult.config : null;

/**
 * An operator token from the CONTROL realm — a different issuer and a different
 * client from every other token in this suite, which is the point of the second
 * realm. The credentials follow the harness's convention: a committed dev-realm
 * literal, overridable for a realm whose secrets are generated.
 */
async function operatorToken(): Promise<string | null> {
  if (!config) return null;
  try {
    const response = await fetch(`${config.operator.issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: process.env.E2E_CONTROL_CLIENT_ID ?? config.operator.clientId,
        client_secret: process.env.E2E_CONTROL_CLIENT_SECRET ?? "admin-dev-secret",
        username: process.env.E2E_CONTROL_USERNAME ?? "platform-operator",
        password: process.env.E2E_CONTROL_PASSWORD ?? "test",
      }),
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ?? null;
  } catch {
    return null;
  }
}

/** A service-account token, used only to delete what this suite created. */
async function serviceAccountToken(): Promise<string | null> {
  if (!config) return null;
  const { baseUrl, tenantRealm, clientId, clientSecret } = config.keycloak;
  try {
    const response = await fetch(
      `${baseUrl}/realms/${encodeURIComponent(tenantRealm)}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(4000),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { access_token?: string };
    return body.access_token ?? null;
  } catch {
    return null;
  }
}

const bearer = await operatorToken();
const enabled = config !== null && bearer !== null;

/**
 * The slug is random per run so the create path is exercised as a create, not as
 * a replay of whatever the last run left behind. It is short because a slug is
 * capped at 63 characters and is also a Keycloak alias.
 */
const tenantSlug = `e2e-${seed}`;
const unitSlug = "emea";
const createdOrganizationIds: string[] = [];

let app: FastifyInstance | null = null;

function control(): FastifyInstance {
  if (app) return app;
  const instance = Fastify({ logger: false });
  // `roles/api.ts` hands routes an unparsed buffer; mirroring that here keeps
  // the route's own body parsing on the code path production uses, rather than
  // on Fastify's default object parser.
  instance.removeContentTypeParser("application/json");
  instance.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  registerControlRestRoutes(instance, { db: getRuntime().db });
  app = instance;
  return instance;
}

async function post(path: string, body: unknown) {
  const response = await control().inject({
    method: "POST",
    url: path,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

async function get(path: string) {
  const response = await control().inject({
    method: "GET",
    url: path,
    headers: { authorization: `Bearer ${bearer}` },
  });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

/** Keycloak generates organization ids; anything else means the SPI regressed. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterAll(async () => {
  if (!enabled) return;
  const token = await serviceAccountToken();
  if (token && config) {
    const base = `${config.keycloak.baseUrl}/admin/realms/${encodeURIComponent(config.keycloak.tenantRealm)}/organizations`;
    for (const id of createdOrganizationIds) {
      await fetch(`${base}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4000),
      }).catch(() => {});
    }
  }
  // Children before parents: org_unit.parent_id is ON DELETE RESTRICT, and the
  // tenant row cannot go while units still reference its tenant_id.
  await withSystemSession(
    getRuntime().db,
    {
      actorSubject: "e2e-control-provisioning",
      roles: [SYSTEM_BYPASS_ROLE],
      reason: `control-plane e2e cleanup: tenant slug="${tenantSlug}"`,
    },
    async (trx) => {
      await sql`
        delete from platform.org_unit
         where tenant_id in (select id from platform.tenants where slug = ${tenantSlug})
      `.execute(trx);
      await sql`delete from platform.tenants where slug = ${tenantSlug}`.execute(trx);
    },
  ).catch(() => {});
  await app?.close();
});

describe("control-plane provisioning", () => {
  test.skipIf(!enabled)(
    "creating a tenant creates its root Organization, with a generated id",
    async () => {
      const created = await post("/api/control/v1/tenants", {
        slug: tenantSlug,
        name: `E2E ${seed}`,
      });
      expect(created.status).toBe(201);
      createdOrganizationIds.push(created.body.organization.id);

      expect(created.body.created).toBe(true);
      expect(created.body.tenant.slug).toBe(tenantSlug);
      // The registry row and the Organization are LINKED, which is the third
      // step of provisioning and the one a failure leaves undone.
      expect(created.body.tenant.keycloakOrganizationId).toBe(created.body.organization.id);
      expect(created.body.organization.alias).toBe(tenantSlug);
      expect(created.body.organization.path).toBe(tenantSlug);
      // #294: the SPI used to call `create(name, alias, null)`, which bound to
      // `create(id, name, alias)` and made the id the display-name string. A
      // uuid here is that fix, observed through the whole stack.
      expect(created.body.organization.id).toMatch(UUID);

      // Read back through Keycloak's OWN admin API — the response above is the
      // SPI's, and `keycloak-spi-client.ts` documents that only its id/alias/name
      // can be trusted in the create transaction.
      const detail = await get(`/api/control/v1/tenants/${tenantSlug}`);
      expect(detail.status).toBe(200);
      expect(detail.body.organization).toMatchObject({
        id: created.body.organization.id,
        alias: tenantSlug,
        enabled: true,
      });
    },
  );

  test.skipIf(!enabled)(
    "creating a sub-organisation creates a child Organization under the tenant's root",
    async () => {
      const rootId = createdOrganizationIds[0]!;
      const created = await post(`/api/control/v1/tenants/${tenantSlug}/organizations`, {
        slug: unitSlug,
        name: "EMEA",
      });
      expect(created.status).toBe(201);
      createdOrganizationIds.unshift(created.body.organization.id);

      expect(created.body.organization.id).toMatch(UUID);
      expect(created.body.organization.id).not.toBe(rootId);
      // #292's naming, unchanged by the id fix: the alias is bound to the
      // org_unit's own id, and the path is the root-to-leaf slug chain.
      expect(created.body.organization.alias).toBe(
        `${tenantSlug}--${created.body.orgUnit.id}`,
      );
      expect(created.body.organization.path).toBe(`${tenantSlug}/${unitSlug}`);
      // The SPI validates that parent and root agree; a sub-organisation
      // directly beneath the tenant has the root as both.
      expect(created.body.organization.parentOrganizationId).toBe(rootId);
      expect(created.body.organization.rootOrganizationId).toBe(rootId);

      const tree = await get(`/api/control/v1/tenants/${tenantSlug}/organizations`);
      expect(tree.status).toBe(200);
      expect(tree.body.count).toBe(1);
      expect(tree.body.roots).toHaveLength(1);
      expect(tree.body.roots[0]).toMatchObject({
        slug: unitSlug,
        depth: 1,
        path: `${tenantSlug}/${unitSlug}`,
        keycloakOrganizationId: created.body.organization.id,
      });

      // The realm agrees with the registry about the whole tree. A drift report
      // scoped to this tenant is the strongest available statement that both
      // Organizations exist AND that their hierarchy attributes are what the
      // registry derives — it reads the attributes back through the admin API,
      // which is the only way to see what actually persisted.
      const report = await get("/api/control/v1/reconciliation");
      expect(report.status).toBe(200);
      const ours = (report.body.findings as { tenantSlug?: string }[]).filter(
        (finding) => finding.tenantSlug === tenantSlug,
      );
      expect(ours).toEqual([]);
    },
  );

  // The clause the workstream turns on. Provisioning writes the registry row
  // through an audited bypass session; if that elevation leaked anywhere near
  // the tenant surface, a freshly provisioned tenant would be less isolated than
  // a seeded one — and it would be invisible to every other suite here, all of
  // which use tenants that were never provisioned at all.
  test.skipIf(!enabled)(
    "a provisioned tenant is RLS-isolated from an existing one, both ways",
    async () => {
      const detail = await get(`/api/control/v1/tenants/${tenantSlug}`);
      const provisioned: Identity = {
        tenantId: detail.body.tenant.id as string,
        userId: randomUUID(),
        roles: [...tenantA.roles],
      };
      expect(provisioned.tenantId).not.toBe(tenantA.tenantId);

      const table = tables.find((candidate) => candidate.tenantScoped)!;
      const graphql = table.source!.graphql!;
      const mine = await createRow(table, provisioned);
      const theirs = await createRow(table, tenantA);

      // Neither direction: the provisioned tenant cannot see the seeded one's
      // row, and the seeded one cannot see the provisioned tenant's.
      const crossRead = await expectData(
        tenantA,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id: mine },
      );
      expect(crossRead[graphql.singleQueryName]).toBeNull();

      const reverseRead = await expectData(
        provisioned,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id: theirs },
      );
      expect(reverseRead[graphql.singleQueryName]).toBeNull();

      // And it is invisible to a LIST too, which a by-id lookup alone would miss.
      const crossList = await expectData(
        tenantA,
        `query($filter: ${graphql.typeName}Filter) {
           ${graphql.listQueryName}(filter: $filter, first: 1) { totalCount }
         }`,
        { filter: { id: mine } },
      );
      expect(crossList[graphql.listQueryName].totalCount).toBe(0);

      // Sanity: the row exists for its owner, so the refusals above are about
      // isolation rather than a create that quietly failed.
      const ownRead = await expectData(
        provisioned,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id: mine },
      );
      expect(ownRead[graphql.singleQueryName]?.id).toBe(mine);

      // A cross-tenant delete must not remove it either.
      await gql(tenantA, `mutation($id: ID!) { ${graphql.deleteMutationName}(id: $id) }`, {
        id: mine,
      });
      const stillThere = await expectData(
        provisioned,
        `query($id: ID!) { ${graphql.singleQueryName}(id: $id) { id } }`,
        { id: mine },
      );
      expect(stillThere[graphql.singleQueryName]?.id).toBe(mine);
    },
  );
});
