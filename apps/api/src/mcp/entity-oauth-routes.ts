// SPDX-License-Identifier: BUSL-1.1
/**
 * The OAuth callback route: the provider sends the person back here, the
 * pending state is redeemed, the code exchanged and the connection stored.
 *
 * Split out of generated-mcp-server.ts.
 */
import type { DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  listGeneratedEntitiesForTable,
  mergeGeneratedEntityObjectForTable,
} from "../operations/entity/index.js";
import { handoffFailureCode } from "./configuration-handoff.js";
import { renderEntityOAuthCallbackPage } from "./browser-pages.js";
import { exchangeCodeForTokens, redeemState } from "./entity-oauth.js";
import { tablesByName } from "./catalog.js";
import { serializeRow } from "./catalog-rows.js";
import { ENTITY_OAUTH_CALLBACK_PATH } from "./handoff-config.js";
import { type McpRouteContext } from "./route-context.js";

/**
 * The OAuth return leg. Unauthenticated by necessity — it is a cross-site
 * browser navigation. It trusts nothing in its query beyond looking up the
 * single-use state minted by the connect tool; tenant, user, token endpoint
 * and credentials all come from that pending record.
 */
export async function registerEntityOAuthCallbackRoute(
  ctx: McpRouteContext,
): Promise<void> {
  const {
    instance,
    options,
  } = ctx;
  // The OAuth return leg. Unauthenticated by necessity — it is a cross-site
  // browser navigation. It trusts nothing in its query beyond looking up
  // the single-use state minted by the connect tool; tenant, user, token
  // endpoint and credentials all come from that pending record.
  const html = renderEntityOAuthCallbackPage;
  instance.get(ENTITY_OAUTH_CALLBACK_PATH, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const pending = await redeemState(query.state, options.db);
    if (!pending) {
      return reply
        .status(400)
        .type("text/html")
        .send(html({ outcome: "invalid_state" }));
    }
    if (typeof query.error === "string" && query.error) {
      return reply
        .status(400)
        .type("text/html")
        .send(
          html({
            outcome: "provider_refused",
            providerName: pending.providerName,
          }),
        );
    }
    if (typeof query.code !== "string" || query.code.length === 0) {
      return reply
        .status(400)
        .type("text/html")
        .send(
          html({ outcome: "no_code", providerName: pending.providerName }),
        );
    }
    try {
      const { values } = await exchangeCodeForTokens(
        pending,
        query.code,
        fetch,
        undefined,
        {
          owner: options.egressOwner,
          purpose: "oauth",
          scope: {
            tenantId: pending.tenantId,
            actorId: pending.userId,
            provider: pending.providerRowId,
            operation: "exchange_authorization_code",
            kind: "mutation",
          },
        },
      );
      const db = options.db;
      if (!db) throw new Error("Database is not configured.");
      const tables = tablesByName();
      const table = tables.get(pending.connectionTable);
      if (!table)
        throw new Error("Connection table is missing from the manifest.");
      const writeSession: DbSessionInput = {
        tenantId: pending.tenantId,
        userId: pending.userId,
        roles: [],
        groups: [],
        scope: "self",
      };
      const personalScope = pending.connectionScope === "user";
      // The owner is part of the query, not of a scan over the first page:
      // a tenant with more personal connections to one provider than a
      // page holds would otherwise get a second row for the same person.
      const existing = (
        await listGeneratedEntitiesForTable(db, writeSession, table, {
          limit: 1,
          filter: { [pending.connectionProviderRef]: pending.providerRowId },
          fixedWhere: [{ column: "owner_user_id", value: personalScope ? pending.userId : null }],
        })
      ).rows.map((row) => serializeRow(table, row))[0];
      if (existing) {
        await mergeGeneratedEntityObjectForTable(
          db,
          writeSession,
          table,
          String(existing.id),
          pending.connectionValuesField,
          values,
        );
      } else {
        await createGeneratedEntityForTable(db, writeSession, table, {
          key: `personal-${pending.userId.replace(/[^a-z0-9-]/g, "").slice(0, 20)}`,
          name: `Personal ${pending.providerName} connection`,
          [pending.connectionProviderRef]: pending.providerRowId,
          ...(personalScope ? { ownerUserId: pending.userId } : {}),
          [pending.connectionValuesField]: values,
        });
      }
      return reply
        .status(200)
        .type("text/html")
        .send(
          html({
            outcome: "connected",
            providerName: pending.providerName,
            connectionScope: pending.connectionScope,
          }),
        );
    } catch (error) {
      request.log.error(
        { err: error, failure: handoffFailureCode(error) },
        "Personal connection callback failed.",
      );
      return reply
        .status(500)
        .type("text/html")
        .send(
          html({
            outcome: "store_failed",
            providerName: pending.providerName,
          }),
        );
    }
  });
}
