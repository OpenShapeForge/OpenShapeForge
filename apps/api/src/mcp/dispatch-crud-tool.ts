// SPDX-License-Identifier: BUSL-1.1
/**
 * The CRUD execution of an entity tool. Split out of the entity section of
 * tool dispatch, verbatim.
 */
import { getEntityOperationContracts, getGeneratedEntity } from "../operations/entity/index.js";
import { assertEntityValuesValid } from "../operations/entity/input-validation.js";
import { collectElicitedValues } from "./elicitation.js";
import { mintConfiguration } from "./configuration-handoff.js";
import { handoffModelValues } from "./configuration-submission.js";
import {
  providerUrlTemplates,
  secretFieldKeys,
  secretUrlPlaceholderError,
  templatePlaceholders,
} from "./declarative-execution.js";
import { failedCheckSummary, testElicitedRow } from "./connection-test.js";
import { HttpError } from "../rest/http-error.js";
import { connectionScopeOf, fieldNameForColumn, serializeRow } from "./catalog-rows.js";
import {
  type CatalogEntity,
  type CatalogTool,
  type GeneratedTable,
  catalog,
  catalogDerivedTools,
} from "./catalog.js";
import { partial } from "./composed-results.js";
import { assertDeclaredProperties, assertOperationWrittenFields } from "./entity-tool-guards.js";
import { invokeTool } from "./entity-tool-invocation.js";
import { withoutEntitySelector } from "./generic-tool-projection.js";
import {
  ENTITY_OAUTH_CALLBACK_PATH,
  callbackOrigin,
  configurationFallbackLead,
  elicitationFallback,
  publicOriginIsHttps,
  supportsMcpApp,
} from "./handoff-config.js";
import { configurationAppResult, configurationHandoffResult } from "./handoff-results.js";
import { failed } from "./tool-results.js";
import { ENVELOPE_KEYS, assertSchemaValid, envelopeSchema } from "./tool-schema.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DirectCallScope } from "./tool-dispatch.js";
/**
 * The CRUD execution of an entity tool the session may invoke: validates
 * the envelope, runs the elicitation-before-create where the entity asks
 * for it, delegates to the CRUD core and tells other sessions when a
 * definition row changed.
 */
export async function crudToolCall(
  ctx: DirectCallScope,
  match: CatalogTool,
  table: GeneratedTable,
  entity: CatalogEntity | undefined,
): Promise<CallToolResult> {
  const {
    db,
    egressOwner,
    extra,
    locale,
    onDerivedDefinitionChanged,
    request,
    server,
    session,
    signal,
    tables,
  } = ctx;
  const crudArguments = withoutEntitySelector(
    match,
    request.params.arguments as Record<string, unknown> | undefined,
  );
  try {
    let callArguments: Record<string, unknown> | undefined = crudArguments;
    let elicitationCompleted = false;
    if (match.operation === "create" && entity?.elicitOnCreate) {
      const elicit = entity.elicitOnCreate;
      const modelArguments = {
        ...((callArguments ?? {}) as Record<string, unknown>),
      };
      // The model is not a channel for elicited values: whatever it sent for
      // the target field is discarded before the person is asked.
      delete modelArguments[elicit.into];

      // Before anyone is asked for a secret: the model's own fields must
      // already satisfy the write contract, or the person fills a secure
      // form for a create that was going to answer VALIDATION anyway.
      {
        const contract = match.operationId
          ? getEntityOperationContracts().find((operation) => operation.id === match.operationId)
          : undefined;
        if (contract && table) {
          const modelFields = Object.fromEntries(
            Object.entries(modelArguments).filter(([key]) => !ENVELOPE_KEYS.has(key)),
          );
          assertOperationWrittenFields(
            modelFields,
            table,
            contract.implementation?.type === "plugin" ? contract.id : undefined,
          );
          assertDeclaredProperties(match.inputSchema, modelFields, "field");
          assertEntityValuesValid(contract, table, modelFields, {
            partial: typeof modelArguments.blueprintId === "string",
          });
        }
      }
      const sourceId = modelArguments[elicit.sourceField];
      const sourceTable = tables.get(elicit.sourceTable);
      let sourceRow: Record<string, unknown> | null = null;
      if (typeof sourceId === "string" && sourceTable) {
        try {
          const row = await getGeneratedEntity(db, session, {
            table: sourceTable.name,
            id: sourceId,
          });
          if (row) sourceRow = serializeRow(sourceTable, row);
        } catch {
          // Unauthorized and missing get the same NOT_FOUND from the
          // collector, mirroring the tool-listing principle.
        }
      }
      // Definitional fail-fast: a URL template reaching for a
      // secret-classified field can never resolve, so refuse BEFORE the
      // person is asked to fill a secure form for a connection that cannot
      // work. The error names the misclassified field and the fix.
      if (sourceRow) {
        const secretClassified = secretFieldKeys(
          sourceRow[elicit.definitionsField],
        );
        for (const { context, template } of providerUrlTemplates(sourceRow)) {
          for (const key of templatePlaceholders(template)) {
            if (secretClassified.has(key)) {
              throw new HttpError(
                400,
                "SECRET_IN_URL_TEMPLATE",
                `${secretUrlPlaceholderError(key, context).message} Fix the ` +
                  `${elicit.sourceEntity} definition first — nothing has been asked ` +
                  `of the person yet.`,
              );
            }
          }
        }
      }
      const sourceAuth = sourceRow?.auth as
        | Record<string, unknown>
        | null
        | undefined;
      const messagePrefix =
        sourceAuth?.profile === "oauth2AuthorizationCode"
          ? `Before entering these values, register this exact redirect URL on the ` +
            `provider's OAuth client: ${callbackOrigin()}${ENTITY_OAUTH_CALLBACK_PATH}`
          : undefined;
      try {
        callArguments = await collectElicitedValues({
          server,
          elicit,
          sourceRow,
          values: modelArguments,
          relatedRequestId: extra.requestId,
          locale,
          ...(messagePrefix ? { messagePrefix } : {}),
        });
        elicitationCompleted = true;
        // A Connection to a PERSONAL provider belongs to the person who
        // just entered its values, and to nobody else. Until this existed,
        // only the OAuth callback set an owner, so a personal provider
        // configured with a password (an IMAP mailbox, an LDAP bind) landed
        // as an organization row that row-level security shows to everyone
        // — the credential of one employee, readable by the next. The owner
        // comes from the verified session, never from tool input.
        if (
          connectionScopeOf(sourceAuth) === "user" &&
          session.userId &&
          table.columns.some(
            (column) => fieldNameForColumn(column) === "ownerUserId",
          )
        ) {
          callArguments = {
            ...(callArguments as Record<string, unknown>),
            ownerUserId: session.userId,
          };
        }
      } catch (error) {
        const reason = elicitationFallback(error);
        if (!reason || !sourceRow) throw error;
        // The in-band form did not happen — hand the person a browser URL
        // to the same form instead of dead-ending the setup.
        const definitions = Array.isArray(sourceRow[elicit.definitionsField])
          ? (sourceRow[elicit.definitionsField] as Record<string, unknown>[])
          : [];
        const required = Array.isArray(
          (match.inputSchema as { required?: unknown } | undefined)?.required,
        )
          ? ((match.inputSchema as { required: unknown[] }).required as string[])
          : [];
        const minted = await mintConfiguration({
          db,
          tenantId: session.tenantId as string,
          userId: session.userId as string,
          table: table.name,
          elicit,
          modelValues: handoffModelValues({
            required,
            elicit,
            modelValues: modelArguments,
            sourceRow,
          }),
          definitions,
          displayName: String(
            sourceRow.name ?? entity?.entity ?? "this record",
          ),
          messagePrefix,
        });
        const listToolName = catalog.tools.find(
          (candidate) =>
            candidate.table === match.table && candidate.operation === "list",
        )?.name;
        const continuation = {
          action: "configure",
          status: "awaiting_person",
          expiresInSeconds: minted.expiresInSeconds,
          // Machine-readable continuation: the record exists once the
          // person saved the form; this is how to observe that.
          ...(listToolName ? { resumeWith: listToolName } : {}),
        };
        const waitInstruction =
          " Then wait by checking, not by asking: poll resumeWith every ten " +
          "seconds or so — the record exists once they have saved. Only if " +
          "nothing has appeared after about three minutes, ask the person to tell " +
          "you when they are done.";
        // The private MCP App only where its iframe can render (https
        // origin); every other client gets the URL in the open.
        if (supportsMcpApp(server) && publicOriginIsHttps()) {
          return configurationAppResult(
            {
              ...continuation,
              instructions:
                configurationFallbackLead(reason, "app") +
                waitInstruction,
            },
            minted.token,
            String(sourceRow.name ?? entity?.entity ?? "this record"),
          );
        }

        return configurationHandoffResult({
          continuation,
          token: minted.token,
          expiresInSeconds: minted.expiresInSeconds,
          definitions,
          instructions:
            configurationFallbackLead(reason, "external") +
            waitInstruction,
        });
      }
      // Verify the accepted values against the provider BEFORE anything is
      // stored — the same three checks test_connection runs later, so a
      // wrong subdomain or refused credential fails HERE, not on the first
      // real call. What is honestly unverifiable (no probe declared,
      // sign-in credentials before consent) reports skipped and saves.
      const storedValues = (
        callArguments as Record<string, unknown> | undefined
      )?.[elicit.into];
      if (sourceRow && storedValues && typeof storedValues === "object") {
        const report = await testElicitedRow({
          row: { [elicit.into]: storedValues },
          sourceRow,
          elicit,
          table: table.name,
          egress: {
            owner: egressOwner,
            purpose: "probe",
            scope: {
              tenantId: session.tenantId,
              actorId: session.userId,
              provider: String(sourceRow.id ?? entity?.entity ?? "provider"),
              operation: "test_connection",
              kind: "query",
            },
          },
        });
        if (!report.ok) {
          throw new HttpError(
            400,
            "CONNECTION_REJECTED",
            `Nothing was created — the entered configuration failed verification ` +
              `against ${report.source}: ${failedCheckSummary(report)} ` +
              `Run the create again so the person can correct the values.`,
          );
        }
      }
    }
    {
      // Validate what the MODEL sent against the advertised schema — before
      // elicited values join, since those are server-set and outside it.
      const modelSent = (crudArguments ?? {}) as Record<string, unknown>;
      const elicitField = entity?.elicitOnCreate?.into;
      const toValidate =
        match.operation === "create" && elicitField
          ? Object.fromEntries(
              Object.entries(modelSent).filter(
                ([key]) => key !== elicitField,
              ),
            )
          : modelSent;
      // Before the advertised schema does: a `writtenBy` field is absent from
      // that schema, so ajv would call it an additional property and send the
      // caller hunting for a typo instead of naming the operation.
      const contract = match.operationId
        ? getEntityOperationContracts().find(
            (operation) => operation.id === match.operationId,
          )
        : undefined;
      assertOperationWrittenFields(
        match.operation === "update"
          ? ((toValidate.values ?? {}) as Record<string, unknown>)
          : toValidate,
        table,
        contract?.implementation?.type === "plugin" ? contract.id : undefined,
      );
      const expectedVersionField = contract?.concurrency?.version?.field;
      // An entity create's or update's authored values are the runtime's to
      // judge, once, for every interface, so MCP gets the same VALIDATION +
      // violations[] answer REST and GraphQL do instead of a private ajv
      // verdict. A plugin Operation owns its input contract (a document
      // with its version and artifact), so its tool is held to the
      // advertised schema as a whole.
      const entityBacked = contract !== undefined && contract.implementation?.type !== "plugin";
      // A field this session's tool does not advertise (immutable on update,
      // withheld, server-managed) is refused by name before anything else,
      // so the answer names the field whatever else the call is missing.
      if (entityBacked && match.operation === "update") {
        if (toValidate.values && typeof toValidate.values === "object" && !Array.isArray(toValidate.values)) {
          assertDeclaredProperties(
            (match.inputSchema.properties as Record<string, Record<string, unknown>> | undefined)?.values,
            toValidate.values as Record<string, unknown>,
            "field",
          );
        }
      } else if (entityBacked && match.operation === "create") {
        assertDeclaredProperties(match.inputSchema, toValidate, "field");
      }
      // The edge checks the ENVELOPE (identity, controls, their types).
      assertSchemaValid(
        entityBacked ? envelopeSchema(match.inputSchema, match.operation) : match.inputSchema,
        toValidate,
        "arguments",
        expectedVersionField,
      );
    }
    const outcome = await invokeTool(
      match,
      entity,
      table,
      tables,
      db,
      session,
      callArguments,
      elicitationCompleted,
    );
    signal?.throwIfAborted();
    // A successful mutation on a table whose rows project as tools changes
    // other sessions' tool lists — tell them, so they re-list instead of
    // discovering the change on their next reconnect.
    if (
      onDerivedDefinitionChanged &&
      !(outcome as { isError?: boolean }).isError &&
      match.operation !== "get" &&
      match.operation !== "list" &&
      catalogDerivedTools.some((entry) => entry.table === match.table)
    ) {
      onDerivedDefinitionChanged(match.table, session.tenantId ?? null);
    }
    return outcome;
  } catch (error) {
    return failed(error);
  }
}
