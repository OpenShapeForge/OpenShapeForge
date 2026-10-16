// SPDX-License-Identifier: BUSL-1.1
/**
 * The browser routes of the configuration handoff: the form a person opens
 * from a link the assistant gave them, and the authenticated API the signed-in
 * web client resolves the same pending handoff through.
 *
 * Split out of generated-mcp-server.ts.
 */
import { startConfigurationForSession } from "./configuration-start.js";
import { sql } from "kysely";
import { isDeepStrictEqual } from "node:util";
import { withDbSession } from "../db/session.js";
import { assertConfigurationOwner, requireActingRelationId } from "./acting-relation-guard.js";
import type { DbSessionInput } from "../db/session.js";
import {
  createGeneratedEntityForTable,
  listGeneratedEntitiesForTable,
} from "../operations/entity/index.js";
import { mergeGeneratedEntityObjectForTable } from "../operations/entity/mutations.js";
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
    | { ok: true; id: string }
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
        // The atomic claim holds a pooled connection during this probe. Bound
        // the whole HTTP chain, in addition to the per-request timeout.
        const probeDeadline = AbortSignal.timeout(20_000);
        const report = await testElicitedRow({
          fetchImpl: Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, { ...init, signal: init?.signal
            ? AbortSignal.any([probeDeadline, init.signal]) : probeDeadline }), { preconnect: fetch.preconnect }),
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
          tableDef.columns.some(
            (column) => fieldNameForColumn(column) === "ownerUserId",
          )
        ) {
          // Owned by the Relation the person acts as; an unlinked sign-in owns nothing.
          values.ownerUserId = requireActingRelationId(pending, "A personal connection");
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
      // The stable key finds a candidate; it does not authorize rebinding its
      // source or owner. Check the original create identities under the same
      // row lock used by the following canonical merge.
      await withDbSession(db, writeSession, async (trx) => {
        const locked = (await sql<{ row: Record<string, unknown> }>`select to_jsonb(t.*) as row
          from ${sql.id(tableDef.schema, tableDef.table)} t
          where ${sql.id(tableDef.primaryKey!)}::text = ${String(existing.id)} for update`.execute(trx)).rows[0]?.row;
        if (!locked) throw new HttpError(404, "NOT_FOUND", "The configured record is unavailable.");
        for (const column of tableDef.columns) {
          const field = fieldNameForColumn(column);
          if (field === "ownerUserId") assertConfigurationOwner(pending, locked[column.name], values.ownerUserId);
          if (field === pending.elicit.into) continue;
          if (!Object.hasOwn(pending.modelValues, field)) {
            if (field === pending.elicit.sourceField || (column.immutable && locked[column.name] != null)) throw new HttpError(409, "CONFIGURATION_BINDING_MISMATCH", "The secure form does not match this record.");
            continue;
          }
          if (!isDeepStrictEqual(locked[column.name], pending.modelValues[field])) {
            throw new HttpError(409, "CONFIGURATION_BINDING_MISMATCH", "The secure form does not match this record.");
          }
        }
      });
      // Public reads intentionally return secret set markers. Merge only the
      // submitted members against the locked storage row, so omitted encrypted
      // siblings are retained rather than replaced by those markers.
      await mergeGeneratedEntityObjectForTable(
        db,
        writeSession,
        tableDef,
        String(existing.id),
        pending.elicit.into,
        values[pending.elicit.into] as Record<string, unknown>,
      );
      return { ok: true, id: String(existing.id) };
    }
    const created = await createGeneratedEntityForTable(db, writeSession, tableDef, values);
    return { ok: true, id: String(created.id) };
  };

  class SubmissionRejected extends Error {
    constructor(readonly outcome: Extract<ConfigurationSubmission, { ok: false }>) { super("Configuration values were refused."); }
  }
  const submitAtomically = async (pending: PendingConfiguration, body: string, session: DbSessionInput, claim: () => Promise<boolean>): Promise<ConfigurationSubmission> => {
    if (!options.db) throw new HttpError(503, "DATABASE_NOT_CONFIGURED", "Database is not configured.");
    try {
      return await withDbSession(options.db, session, async () => {
        if (!await claim()) throw new HttpError(409, "CONFLICT", "This configuration form was already submitted or expired.");
        const outcome = await savePendingConfiguration(pending, body, session);
        if (!outcome.ok) throw new SubmissionRejected(outcome);
        return outcome;
      });
    } catch (error) {
      if (error instanceof SubmissionRejected) return error.outcome;
      throw error;
    }
  };

  instance.post(`${ENTITY_CONFIGURATION_PATH}/start`, async (request) => {
    const { db, session } = await requireMcpSession(request);
    return startConfigurationForSession(db, session, request.body);
  });

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
  instance.get(`${ENTITY_CONFIGURATION_PATH}/pending/:id`, async (request) => {
    const { db, session } = await requireMcpSession(request);
    const id = (request.params as { id: string }).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "This configuration form is unavailable.");
    const found = await latestConfigurationForSession(session, db, id);
    if (!found) throw new HttpError(404, "NOT_FOUND", "This configuration form is unavailable or expired.");
    return { id: found.id, displayName: found.pending.displayName, messagePrefix: found.pending.messagePrefix,
      definitions: configurationFormDefinitions(found.pending) };
  });
  instance.post(
    `${ENTITY_CONFIGURATION_PATH}/pending/:id`,
    async (request, reply) => {
      const { db, session } = await requireMcpSession(request, "configuration-form");
      const id = (request.params as { id?: string }).id;
      if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "This configuration form is unavailable.");
      const found = await latestConfigurationForSession(session, db, id);
      if (!found || found.id !== id) {
        throw new HttpError(
          404,
          "NOT_FOUND",
          "This pending configuration form is unavailable or expired.",
        );
      }
      const body = typeof request.body === "string" ? request.body : "";
      const outcome = await submitAtomically(found.pending, body, session,
        () => consumeConfigurationForSession(id, session, db));
      if (!outcome.ok) {
        return reply.status(400).send({
          error: {
            code: "INVALID_CONFIGURATION",
            message: outcome.errorBanner ?? "Correct the highlighted values.",
            fields: outcome.errors,
          },
        });
      }
      return reply.send({ saved: true, id: outcome.id });
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
          relationId: pending.relationId ?? null,
          roles: [],
          groups: [],
          scope: "self",
        };
        const outcome = await submitAtomically(pending, body, writeSession,
          () => consumeConfiguration(pending.token, options.db, writeSession));
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
