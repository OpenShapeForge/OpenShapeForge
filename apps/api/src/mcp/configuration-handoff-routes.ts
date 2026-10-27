// SPDX-License-Identifier: BUSL-1.1
/**
 * The browser routes of the configuration handoff: the form a person opens
 * from a link the assistant gave them, and the authenticated API the signed-in
 * web client resolves the same pending handoff through.
 *
 * Split out of generated-mcp-server.ts.
 */
import { startConfigurationForSession } from "./configuration-start.js";
import { withDbSession } from "../db/session.js";
import { configurationOwnerPatch } from "./configuration-ownership.js";
import type { DbSessionInput } from "../db/session.js";
import {
  listGeneratedEntitiesForTable,
} from "../operations/entity/index.js";
import { completeEntitySecureInput, entityOperationRef, entityOperationContract, executeEntityOperation } from "../operations/entity/runtime.js";
import { operationFailure } from "@openshapeforge/operations";
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
import { fieldNameForColumn, serializeRow } from "./catalog-rows.js";
import { ENTITY_CONFIGURATION_PATH, elicitedKeyring, configurationWebUrl } from "./handoff-config.js";
import { type McpRouteContext } from "./route-context.js";
import { ok } from "./tool-results.js";

/** Authenticated configuration API and browser redirects to the signed-in web client. */
export async function registerConfigurationHandoffRoutes(
  ctx: McpRouteContext,
): Promise<void> {
  const {
    instance,
    options,
    requireMcpSession,
  } = ctx;
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
    const secureContract = entityOperationContract(entityOperationRef(tableDef, "create").id);
    if (secureContract.implementation?.type !== "entity" || secureContract.interaction.secureInput?.into !== pending.elicit.into) {
      throw new HttpError(409, "CONFLICT", "The secure Operation definition changed; start a new configuration.");
    }
    const admission = await executeEntityOperation(db, writeSession, {
      operation: entityOperationRef(tableDef, "create"), input: { values: pending.modelValues, ...(pending.confirmed ? { confirmed: true } : {}) },
    });
    if (!("error" in admission) || admission.error.code !== "INTERACTION_REQUIRED") {
      if ("error" in admission) throw operationFailure(admission.error);
      throw new HttpError(409, "CONFLICT", "Secure interaction is no longer declared for this Operation.");
    }
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
        // Use the same ownership boundary as in-band MCP elicitation.
        if (
          tableDef.columns.some(
            (column) => fieldNameForColumn(column) === "ownerUserId",
          )
        ) {
          Object.assign(values, configurationOwnerPatch(
            sourceRow.auth as Record<string, unknown> | null | undefined,
            pending,
          ));
        }
      }
    }
    // A create continuation never authorizes changing an existing record.
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
    if (existing) throw new HttpError(403, "FORBIDDEN", "An existing configuration requires a separately authorized update Operation.");
    const result = await completeEntitySecureInput(db, writeSession, {
      operation: entityOperationRef(tableDef, "create"),
      input: { values: Object.fromEntries(Object.entries(values).filter(([key]) => key !== pending.elicit.into)), ...(pending.confirmed ? { confirmed: true } : {}) },
    }, { into: pending.elicit.into, value: values[pending.elicit.into] });
    if ("error" in result) throw operationFailure(result.error);
    if (result.intent !== "create" || !result.data) throw new HttpError(500, "INTERNAL", "Secure create returned no record.");
    return { ok: true, id: String(result.data.id) };
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
    const requestedId = (request.query as { formId?: unknown })?.formId;
    if (requestedId !== undefined && (typeof requestedId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(requestedId))) {
      throw new HttpError(404, "NOT_FOUND", "This configuration form is unavailable.");
    }
    const found = await latestConfigurationForSession(session, db, requestedId as string | undefined);
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
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "This configuration form is unavailable.");
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
      if (!id || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new HttpError(404, "NOT_FOUND", "This configuration form is unavailable.");
      const found = await latestConfigurationForSession(session, db, id);
      if (!found) {
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
      const webUrl = configurationWebUrl();
      if (!webUrl) throw new HttpError(503, "CONFIGURATION_UNAVAILABLE", "A signed-in configuration web client is required.");
      const destination = new URL(webUrl);
      if (pending.id) destination.searchParams.set("formId", pending.id);
      return reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").redirect(destination.href);

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
        const { session: writeSession } = await requireMcpSession(request, "configuration-form");
        if (writeSession.tenantId !== pending.tenantId || writeSession.userId !== pending.userId) {
          throw new HttpError(403, "FORBIDDEN", "The secure form belongs to another identity.");
        }
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
