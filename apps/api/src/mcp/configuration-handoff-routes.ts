// SPDX-License-Identifier: BUSL-1.1
/**
 * The browser routes of the configuration handoff: the form a person opens
 * from a link the assistant gave them, and the authenticated API the signed-in
 * web client resolves the same pending handoff through.
 *
 * Split out of generated-mcp-server.ts.
 */
import type { DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  listGeneratedEntitiesForTable,
  updateGeneratedEntityForTable,
} from "../operations/entity/index.js";
import {
  consumeConfiguration,
  consumeConfigurationForSession,
  latestConfigurationForSession,
  peekConfiguration,
  type PendingConfiguration,
} from "./configuration-handoff.js";
import {
  renderConfigurationExpiredPage,
  renderConfigurationFailedPage,
  renderConfigurationForm,
  renderConfigurationSavedPage,
} from "./browser-pages.js";
import {
  configurationFormDefinitions,
  parseSubmission,
  storeSubmission,
  findExistingConfiguration,
  handoffFailureCode,
  mergeConfigurationValues,
} from "./configuration-submission.js";
import { failedCheckSummary, testElicitedRow } from "./connection-test.js";
import { HttpError } from "../rest/http-error.js";
import { tablesByName } from "./catalog.js";
import { connectionScopeOf, fieldNameForColumn, serializeRow } from "./catalog-rows.js";
import { ENTITY_CONFIGURATION_PATH, elicitedKeyring } from "./handoff-config.js";
import { type McpRouteContext } from "./route-context.js";
import { ok } from "./tool-results.js";

/**
 * The configuration handoff pages (unauthenticated: the single-use token is
 * the authorization) and the authenticated configuration form API the web
 * client uses.
 */
export async function registerConfigurationHandoffRoutes(
  ctx: McpRouteContext,
): Promise<void> {
  const {
    instance,
    options,
    requireMcpSession,
  } = ctx;
  // The configuration handoff pages. Unauthenticated by necessity, like
  // the OAuth callback: the person arrives by browser, and the single-use
  // token IS the authorization — it was minted for exactly this tenant,
  // user and pending create. Values travel only in the POST body.
  instance.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, body),
  );

  type ConfigurationSubmission =
    | { ok: true }
    | {
        ok: false;
        errors: Record<string, string>;
        errorBanner?: string;
        prefill: Record<string, unknown>;
      };
  const savePendingConfiguration = async (
    pending: PendingConfiguration,
    body: string,
    writeSession: DbSessionInput,
  ): Promise<ConfigurationSubmission> => {
    const { content, errors } = parseSubmission(pending, body);
    if (Object.keys(errors).length > 0) {
      return { ok: false, errors, prefill: content };
    }
    const db = options.db;
    if (!db)
      throw new HttpError(
        503,
        "DATABASE_NOT_CONFIGURED",
        "Database is not configured.",
      );
    const tableDef = tablesByName().get(pending.table);
    if (!tableDef)
      throw new HttpError(
        500,
        "INTERNAL",
        "Table is missing from the manifest.",
      );
    const values = storeSubmission(pending, content, elicitedKeyring());
    // Verify against the provider BEFORE the row exists: the person is
    // right here at the form, so a wrong subdomain or refused credential
    // comes back as a correctable banner instead of a stored dud.
    const sourceRowId = pending.modelValues[pending.elicit.sourceField];
    const sourceTable = tablesByName().get(pending.elicit.sourceTable);
    if (typeof sourceRowId === "string" && sourceTable) {
      const sourceResult = await listGeneratedEntitiesForTable(
        db,
        writeSession,
        sourceTable,
        {
          limit: 1,
          filter: { id: sourceRowId },
        },
      );
      const sourceRow = sourceResult.rows[0]
        ? serializeRow(sourceTable, sourceResult.rows[0])
        : null;
      if (sourceRow) {
        const report = await testElicitedRow({
          row: { [pending.elicit.into]: values[pending.elicit.into] },
          sourceRow,
          elicit: pending.elicit,
          table: pending.table,
          egress: {
            owner: options.egressOwner,
            purpose: "probe",
            scope: {
              tenantId: pending.tenantId,
              actorId: pending.userId,
              provider: String(sourceRow.id ?? pending.elicit.sourceEntity),
              operation: "test_connection",
              kind: "query",
            },
          },
        });
        if (!report.ok) {
          return {
            ok: false,
            errors: {},
            errorBanner: `${report.source} refused these values — ${failedCheckSummary(report)}`,
            prefill: content,
          };
        }
        // Same rule as the in-band elicitation path: a Connection to a
        // personal provider belongs to the person who filled the form in.
        if (
          connectionScopeOf(
            sourceRow.auth as Record<string, unknown> | null | undefined,
          ) === "user" &&
          pending.userId &&
          tableDef.columns.some(
            (column) => fieldNameForColumn(column) === "ownerUserId",
          )
        ) {
          values.ownerUserId = pending.userId;
        }
      }
    }
    // A key that already exists (the form submitted twice, a rotated
    // secret) updates that row's values in place; submitted keys replace,
    // untouched keys stay. Only a new key creates a row.
    const existingRows =
      typeof pending.modelValues.key === "string"
        ? (
            await listGeneratedEntitiesForTable(db, writeSession, tableDef, {
              limit: 5,
              fixedWhere: [{ column: "key", value: pending.modelValues.key }],
            })
          ).rows.map((row) => serializeRow(tableDef, row))
        : [];
    const existing = findExistingConfiguration(existingRows, pending);
    if (existing) {
      await updateGeneratedEntityForTable(
        db,
        writeSession,
        tableDef,
        String(existing.id),
        {
          [pending.elicit.into]: mergeConfigurationValues(
            existing[pending.elicit.into],
            values[pending.elicit.into] as Record<string, unknown>,
          ),
        },
      );
      return { ok: true };
    }
    await createGeneratedEntityForTable(db, writeSession, tableDef, values);
    return { ok: true };
  };

  // Stable, authenticated configuration form API. The web client sends its
  // normal Keycloak bearer; RLS resolves the pending handoff by tenant/user.
  // The URL exposed to the assistant therefore carries no handoff credential.
  instance.get(`${ENTITY_CONFIGURATION_PATH}/pending`, async (request) => {
    const { db, session } = await requireMcpSession(request);
    const found = await latestConfigurationForSession(session, db);
    if (!found) {
      throw new HttpError(
        404,
        "NOT_FOUND",
        "No pending configuration form was found for this user.",
      );
    }
    return {
      id: found.id,
      displayName: found.pending.displayName,
      messagePrefix: found.pending.messagePrefix,
      definitions: configurationFormDefinitions(found.pending),
    };
  });
  instance.post(
    `${ENTITY_CONFIGURATION_PATH}/pending/:id`,
    async (request, reply) => {
      const { db, session } = await requireMcpSession(request);
      const found = await latestConfigurationForSession(session, db);
      const id = (request.params as { id?: string }).id;
      if (!found || found.id !== id) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          "This pending configuration form is unavailable or expired.",
        );
      }
      const body = typeof request.body === "string" ? request.body : "";
      const outcome = await savePendingConfiguration(
        found.pending,
        body,
        session,
      );
      if (!outcome.ok) {
        return reply.status(400).send({
          error: {
            code: "INVALID_CONFIGURATION",
            message: outcome.errorBanner ?? "Correct the highlighted values.",
            fields: outcome.errors,
          },
        });
      }
      const consumed = await consumeConfigurationForSession(id, session, db);
      if (!consumed) {
        throw new HttpError(
          409,
          "CONFLICT",
          "This configuration form was already submitted.",
        );
      }
      return reply.send({ saved: true });
    },
  );

  instance.get(
    `${ENTITY_CONFIGURATION_PATH}/:token`,
    async (request, reply) => {
      const pending = await peekConfiguration(
        (request.params as { token?: string }).token,
        options.db,
      );
      if (!pending) {
        return reply
          .status(404)
          .type("text/html")
          .send(renderConfigurationExpiredPage());
      }
      return reply
        .type("text/html")
        .send(
          renderConfigurationForm(
            pending,
            `${ENTITY_CONFIGURATION_PATH}/${pending.token}`,
          ),
        );
    },
  );
  instance.post(
    `${ENTITY_CONFIGURATION_PATH}/:token`,
    async (request, reply) => {
      const pending = await peekConfiguration(
        (request.params as { token?: string }).token,
        options.db,
      );
      if (!pending) {
        return reply
          .status(404)
          .type("text/html")
          .send(renderConfigurationExpiredPage());
      }
      const body = typeof request.body === "string" ? request.body : "";
      try {
        const writeSession: DbSessionInput = {
          tenantId: pending.tenantId,
          userId: pending.userId,
          roles: [],
          groups: [],
          scope: "self",
        };
        const outcome = await savePendingConfiguration(
          pending,
          body,
          writeSession,
        );
        if (!outcome.ok) {
          return reply
            .status(400)
            .type("text/html")
            .send(
              renderConfigurationForm(
                pending,
                `${ENTITY_CONFIGURATION_PATH}/${pending.token}`,
                outcome.errors,
                {
                  ...(outcome.errorBanner
                    ? { errorBanner: outcome.errorBanner }
                    : {}),
                  prefill: outcome.prefill,
                },
              ),
            );
        }
        await consumeConfiguration(pending.token, options.db);
        return reply
          .type("text/html")
          .send(renderConfigurationSavedPage(pending.displayName));
      } catch (error) {
        request.log.error(
          { err: error, failure: handoffFailureCode(error) },
          "Configuration handoff submission failed.",
        );
        return reply
          .status(400)
          .type("text/html")
          .send(renderConfigurationFailedPage(pending.displayName));
      }
    },
  );
}
