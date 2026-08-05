// SPDX-License-Identifier: BUSL-1.1
/**
 * The tenant control surface.
 *
 * WHY REST, AND WHY NOT UNDER /api/rest/v1
 * ----------------------------------------
 * It is not on the GraphQL schema because that schema is per-tenant: every type
 * on it is fenced by a tenant predicate, and a registry whose rows ARE tenants
 * has no predicate to satisfy. Putting it there would be a security defect, not
 * a design preference.
 *
 * REST because that is what `apps/api` already does for a hand-written surface —
 * `connectors/rest-routes.ts` is the same shape: Fastify routes registered from
 * the api role, authenticating per request, delegating to a service module. The
 * generated REST layer is manifest-driven and only serves generated-CRUD
 * entities, so it could never carry this; MCP is a tool surface for language
 * models reading entity schemas, which a break-glass provisioning API is not.
 *
 * Its own mount, `/api/control/v1`, rather than a segment of the tenant REST
 * mount. Different issuer, different audience, different authorization, and a
 * standing recommendation (S8) to keep the control plane off the public ingress
 * entirely — which is a one-line path rule with a distinct prefix and a
 * per-route exception list without one. Nothing here appears in the generated
 * OpenAPI document, which describes the tenant API.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OpenShapeForgeDatabase } from "../db/connection.js";
import { headersFromFastify } from "../http/headers.js";
import {
  ControlAuthorizationError,
  resolveControlOperator,
  type ControlOperator,
} from "./authorization.js";
import { readControlPlaneConfig, type ControlPlaneConfigResult } from "./config.js";
import { ControlServiceError } from "./errors.js";
import {
  createKeycloakOrganizationAdminClient,
  KeycloakAdminError,
  type KeycloakOrganizationAdminClient,
} from "./keycloak-organization-admin.js";
import {
  listOrgUnits,
  parseOrgUnitUpdate,
  updateOrgUnit,
} from "./org-unit-registry.js";
import { createServiceAccountTokenProvider } from "./keycloak-service-account.js";
import {
  createKeycloakSpiClient,
  KeycloakSpiError,
  type KeycloakSpiClient,
} from "./keycloak-spi-client.js";
import { ControlInputError } from "./organization-naming.js";
import {
  provisionSubOrganization,
  provisionTenant,
  type ProvisioningDeps,
} from "./provisioning.js";
import { buildDriftReport, reapplyProjection } from "./reconciliation.js";
import {
  getTenant,
  listTenants,
  parseTenantUpdate,
  updateTenant,
} from "./tenant-registry.js";

export const CONTROL_MOUNT_PATH = "/api/control/v1";

/**
 * Error code → HTTP status. Explicit rather than defaulted: an unmapped code
 * becoming a redacted 500 is the right failure, because it means a refusal
 * exists that nobody decided how to present.
 */
const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CONTROL_PLANE_NOT_CONFIGURED: 503,
  CONTROL_INVALID_INPUT: 400,
  DATABASE_NOT_CONFIGURED: 503,
  CONTROL_TENANT_NOT_FOUND: 404,
  CONTROL_PARENT_NOT_FOUND: 404,
  // 409, not 400: the request is well-formed and will succeed once the
  // prerequisite exists, which is a conflict with current state rather than bad
  // input.
  CONTROL_TENANT_NOT_PROVISIONED: 409,
  CONTROL_PARENT_NOT_PROVISIONED: 409,
  CONTROL_ORG_UNIT_DEPTH_EXCEEDED: 400,
  CONTROL_ORG_UNIT_NOT_FOUND: 404,
  // 409 rather than 400 for both: the request names real, existing units, and
  // what it conflicts with is the current shape of the tree.
  CONTROL_ORG_UNIT_CYCLE: 409,
  CONTROL_ORG_UNIT_SLUG_TAKEN: 409,
  // The registry move COMMITTED and Keycloak is behind. 409 for the same reason
  // CONTROL_TENANT_NOT_PROVISIONED is one: the request was well-formed and a
  // replay of it finishes the job. Not 502 — that would say the upstream refused
  // the operation, when in fact the authoritative half already succeeded.
  CONTROL_ORG_UNIT_PROJECTION_INCOMPLETE: 409,
  // Same reasoning, one level up: a reconciliation pass applied part of its work
  // and named what it could not. Re-running is safe.
  CONTROL_RECONCILIATION_INCOMPLETE: 409,
  // The SPI validated and refused: caller-actionable, so it keeps its status.
  KEYCLOAK_SPI_REJECTED: 400,
  KEYCLOAK_SPI_CONFLICT: 409,
  // Not 403: the OPERATOR is authorized; the platform's own service account is
  // not. Answering 403 would tell an operator to fix their permissions when the
  // fault is in the deployment.
  KEYCLOAK_SPI_UNAUTHORIZED: 502,
  KEYCLOAK_SPI_UNAVAILABLE: 502,
  // The same four answers from Keycloak's own admin API, which is where the
  // lifecycle projection is applied. Same statuses for the same reasons; the
  // prefix says which surface refused, because the remedy differs (an SPI
  // rejection is about the hierarchy, an admin rejection about the
  // representation).
  KEYCLOAK_ADMIN_REJECTED: 400,
  KEYCLOAK_ADMIN_UNAUTHORIZED: 502,
  KEYCLOAK_ADMIN_UNAVAILABLE: 502,
  // 409, not 404: the caller named a TENANT that exists. What is missing is the
  // Organization the registry says it is linked to — drift, which a replay of
  // the tenant's create resolves.
  KEYCLOAK_ADMIN_ORGANIZATION_NOT_FOUND: 409,
  // Postgres unique_violation. Reached when two tenants would claim one
  // Organization, or when a concurrent identical create loses the race — both
  // are conflicts the caller can retry or reconcile.
  "23505": 409,
};

function sendError(reply: FastifyReply, code: string, message: string): FastifyReply {
  return reply.status(STATUS_BY_CODE[code] ?? 500).send({ error: { code, message } });
}

function handleError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof ControlAuthorizationError ||
    error instanceof ControlServiceError ||
    error instanceof ControlInputError ||
    error instanceof KeycloakSpiError ||
    error instanceof KeycloakAdminError
  ) {
    return sendError(reply, error.code, error.message);
  }
  // Postgres surfaces constraint violations as a driver error carrying the
  // SQLSTATE. 23505 is the only one this surface can provoke by design (the
  // partial unique indexes on keycloak_organization_id and on the org-unit
  // natural key), and it is a real answer rather than a fault, so it is named
  // instead of redacted.
  const sqlState = (error as { code?: unknown } | null)?.code;
  if (sqlState === "23505") {
    return sendError(
      reply,
      "23505",
      "The requested identifier is already claimed by another row. " +
        "Reconcile the existing record instead of creating a second one.",
    );
  }
  // Anything else is redacted: a driver error can carry SQL text, and a Keycloak
  // failure can carry upstream detail that has not been classified.
  reply.log.error({ err: error }, "Control-plane route failed.");
  return reply
    .status(500)
    .send({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
}

export function parseJsonBody(body: unknown): Record<string, unknown> {
  // The API parses application/json as a raw buffer (roles/api.ts), so the route
  // owns parsing — and owns rejecting malformed JSON as 400 rather than letting
  // a SyntaxError escape into the redacted 500 branch, where a client learns
  // nothing about a mistake it made itself.
  if (body === undefined || body === null) return {};
  let parsed: unknown;
  try {
    if (typeof body === "string") {
      parsed = body.trim() === "" ? {} : JSON.parse(body);
    } else if (body instanceof Uint8Array) {
      const text = Buffer.from(body).toString("utf8");
      parsed = text.trim() === "" ? {} : JSON.parse(text);
    } else {
      parsed = body;
    }
  } catch {
    // The parser's own message quotes the offending input back; nothing here
    // needs to, and echoing a request body into an error is a habit worth not
    // forming on a cross-tenant surface.
    throw new ControlInputError("The request body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ControlInputError("The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export type ControlRestOptions = {
  db?: OpenShapeForgeDatabase | undefined;
  /** Injected by tests; defaults to reading the process environment. */
  config?: ControlPlaneConfigResult;
  /** Injected by tests; defaults to a real client built from the config. */
  keycloak?: KeycloakSpiClient;
  /** Injected by tests; defaults to a real client built from the config. */
  keycloakAdmin?: KeycloakOrganizationAdminClient;
};

export function registerControlRestRoutes(
  app: FastifyInstance,
  options: ControlRestOptions = {},
): void {
  const configResult = options.config ?? readControlPlaneConfig();

  if (!configResult.ok) {
    // Said once, at startup, naming everything that is missing. The routes are
    // still registered: a 503 that names the gap is a far better answer to an
    // operator's first request than a 404 that looks like a version mismatch.
    app.log.warn(
      { missing: configResult.missing },
      "Tenant control plane is not configured; " +
        `${CONTROL_MOUNT_PATH} will refuse every request. Missing: ${configResult.missing.join(", ")}.`,
    );
  }

  // One set of clients per process, sharing ONE service-account token provider:
  // the SPI and the admin API are the same credential against the same realm, so
  // two caches would mean a redundant grant and — worse — a 401 that invalidated
  // one cache while the other kept presenting the credential Keycloak had just
  // refused.
  const tokens = configResult.ok
    ? createServiceAccountTokenProvider(configResult.config.keycloak, {
        unauthorized: (message, status) =>
          new KeycloakSpiError("KEYCLOAK_SPI_UNAUTHORIZED", message, status),
        unavailable: (message, status) =>
          new KeycloakSpiError("KEYCLOAK_SPI_UNAVAILABLE", message, status),
      })
    : undefined;
  const keycloak =
    options.keycloak ??
    (configResult.ok && tokens
      ? createKeycloakSpiClient(configResult.config.keycloak, { tokens })
      : undefined);
  const keycloakAdmin =
    options.keycloakAdmin ??
    (configResult.ok && tokens
      ? createKeycloakOrganizationAdminClient(configResult.config.keycloak, { tokens })
      : undefined);

  async function depsFor(request: FastifyRequest): Promise<ProvisioningDeps> {
    if (!configResult.ok) {
      throw new ControlAuthorizationError(
        "CONTROL_PLANE_NOT_CONFIGURED",
        "The tenant control plane is not configured. Missing environment: " +
          `${configResult.missing.join(", ")}.`,
      );
    }
    if (!options.db || !keycloak || !keycloakAdmin) {
      throw new ControlAuthorizationError(
        "CONTROL_PLANE_NOT_CONFIGURED",
        "The tenant control plane has no database connection.",
      );
    }
    // Authentication and authorization BEFORE anything else touches the database
    // or Keycloak, so an unauthenticated caller cannot make the control plane do
    // work on its behalf.
    const operator: ControlOperator = await resolveControlOperator(
      headersFromFastify(request.headers),
      configResult.config,
    );
    return {
      db: options.db,
      keycloak,
      keycloakAdmin,
      tenantRealm: configResult.config.keycloak.tenantRealm,
      operator,
    };
  }

  // ── reads ────────────────────────────────────────────────────────────────
  // Registered before the writes only for reading order; Fastify's router does
  // not care. Both go through `depsFor`, so a read is authenticated, authorized
  // and audited on exactly the same path a write is — a cross-tenant READ of the
  // registry is not a lesser act than a write to it.

  app.get(`${CONTROL_MOUNT_PATH}/tenants`, async (request, reply) => {
    try {
      const result = await listTenants(await depsFor(request));
      return reply.status(200).send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.get(`${CONTROL_MOUNT_PATH}/tenants/:tenantSlug`, async (request, reply) => {
    try {
      const deps = await depsFor(request);
      const { tenantSlug } = request.params as { tenantSlug: string };
      return reply.status(200).send(await getTenant(deps, tenantSlug));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  /**
   * The whole sub-organisation tree of one tenant, nested, in one round trip.
   *
   * A tree rather than a flat list with a `parentId` on each row, because the
   * only consumer that matters renders a tree, and re-assembling one client-side
   * would put the "a child never precedes its parent" invariant in two places.
   * The server already has to know it — see `buildOrgUnitTree`.
   *
   * No per-node read endpoint. Everything a caller can ask about one unit is
   * already in this response, and a `GET .../organizations/{id}` would be a
   * second way to say the same thing that could disagree with the first.
   */
  app.get(
    `${CONTROL_MOUNT_PATH}/tenants/:tenantSlug/organizations`,
    async (request, reply) => {
      try {
        const deps = await depsFor(request);
        const { tenantSlug } = request.params as { tenantSlug: string };
        return reply.status(200).send(await listOrgUnits(deps, tenantSlug));
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  /**
   * The drift report: the whole registry against the whole realm.
   *
   * A GET with no parameters, because reconciliation has no per-tenant form
   * that answers the same question — one of its classes is "an Organization no
   * registry row claims", which is only visible from the realm side and belongs
   * to no tenant. A `?tenant=` filter would answer a different, weaker question
   * while looking like the same one.
   *
   * Registered under `reconciliation/` rather than beneath `tenants/`, for the
   * same reason: the subject is the projection, not a tenant.
   */
  app.get(`${CONTROL_MOUNT_PATH}/reconciliation`, async (request, reply) => {
    try {
      return reply.status(200).send(await buildDriftReport(await depsFor(request)));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * Push the registry back into Keycloak.
   *
   * POST, not PUT: this is not "make the resource equal to this body" — the body
   * carries no state at all, only an optional bound on the blast radius. What it
   * does is run a process whose input is the registry.
   *
   * `{"tenantSlug": "..."}` restricts the run to one tenant. An unknown slug is
   * a 404 rather than an empty successful run, because an operator who mistypes
   * a slug must not be told there was nothing to do.
   */
  app.post(`${CONTROL_MOUNT_PATH}/reconciliation/reapply`, async (request, reply) => {
    try {
      const deps = await depsFor(request);
      const body = parseJsonBody(request.body);
      for (const key of Object.keys(body)) {
        if (key !== "tenantSlug") {
          throw new ControlInputError(
            `"${key}" is not a field of a re-apply request. Send tenantSlug, or an ` +
              "empty body to reconcile every tenant.",
          );
        }
      }
      const result = await reapplyProjection(deps, {
        ...(body.tenantSlug === undefined
          ? {}
          : { tenantSlug: body.tenantSlug as string }),
      });
      return reply.status(200).send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post(`${CONTROL_MOUNT_PATH}/tenants`, async (request, reply) => {
    try {
      const deps = await depsFor(request);
      const body = parseJsonBody(request.body);
      const result = await provisionTenant(deps, {
        slug: body.slug as string,
        name: body.name as string,
      });
      // 200 on a replay, 201 on a first create. The status is the cheapest place
      // to say which happened, and `created` in the body says it again for a
      // client that only reads JSON.
      return reply.status(result.created ? 201 : 200).send(result);
    } catch (error) {
      return handleError(reply, error);
    }
  });

  /**
   * The lifecycle transition, and the only way to change anything about an
   * existing tenant.
   *
   * PATCH rather than a `/status` sub-resource, because "which fields of a
   * tenant may change" is exactly the question this endpoint has to answer, and
   * a body naming `slug` deserves a stated refusal rather than a 404 on a route
   * that happens not to exist. `parseTenantUpdate` owns that answer; see its
   * header for the immutability argument.
   */
  app.patch(`${CONTROL_MOUNT_PATH}/tenants/:tenantSlug`, async (request, reply) => {
    try {
      const deps = await depsFor(request);
      const { tenantSlug } = request.params as { tenantSlug: string };
      const update = parseTenantUpdate(parseJsonBody(request.body));
      return reply.status(200).send(await updateTenant(deps, tenantSlug, update));
    } catch (error) {
      return handleError(reply, error);
    }
  });

  app.post(
    `${CONTROL_MOUNT_PATH}/tenants/:tenantSlug/organizations`,
    async (request, reply) => {
      try {
        const deps = await depsFor(request);
        const { tenantSlug } = request.params as { tenantSlug: string };
        const body = parseJsonBody(request.body);
        const result = await provisionSubOrganization(deps, {
          tenantSlug,
          slug: body.slug as string,
          name: body.name as string,
          ...(body.parentOrgUnitId === undefined
            ? {}
            : { parentOrgUnitId: body.parentOrgUnitId as string }),
        });
        return reply.status(result.created ? 201 : 200).send(result);
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );

  /**
   * Rename and/or reparent one sub-organisation.
   *
   * PATCH with both operations on one route, mirroring `PATCH /tenants/{slug}`,
   * and for the same reason: "which fields of a sub-organisation may change" is
   * the question this endpoint exists to answer, so a body naming `slug`
   * deserves a stated refusal rather than a 404 on a `/reparent` sub-resource
   * that happens not to exist. `parseOrgUnitUpdate` owns that answer.
   *
   * `{"parentOrgUnitId": null}` means "directly beneath the tenant root" and is
   * a DIFFERENT request from omitting the field, which is why the parser reads
   * it with `Object.hasOwn` — JSON can express both and they must not collapse.
   */
  app.patch(
    `${CONTROL_MOUNT_PATH}/tenants/:tenantSlug/organizations/:orgUnitId`,
    async (request, reply) => {
      try {
        const deps = await depsFor(request);
        const { tenantSlug, orgUnitId } = request.params as {
          tenantSlug: string;
          orgUnitId: string;
        };
        const update = parseOrgUnitUpdate(parseJsonBody(request.body));
        return reply
          .status(200)
          .send(await updateOrgUnit(deps, tenantSlug, orgUnitId, update));
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );
}
