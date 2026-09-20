// SPDX-License-Identifier: BUSL-1.1
/**
 * Generated MCP e2e suite — the MCP counterpart of the REST and GraphQL
 * entity-crud suites. Drives the harness's in-process API app (runtime
 * modules loaded once per process) via inject(), or E2E_API_URL over HTTP
 * when set, speaking JSON-RPC over the Streamable HTTP transport at /api/mcp.
 *
 * Row setup/cleanup reuses the shared GraphQL harness, so all three transports
 * are exercised against the same data and RLS session plumbing.
 *
 * Contract-driven: a dedicated entity owns `<prefix>_<op>` tools, a generic
 * one shares the `osf_<op>` tools and names itself through the `entity`
 * argument (toolNameFor/argsFor); which controls a mutation needs and whether
 * a create is entity- or plugin-backed come from the Operation catalog via
 * e2e/operations.ts.
 */
import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import catalog from "../../generated/mcp/tools.json" with { type: "json" };
import {
  eligibleTables,
  fieldName,
  foreignKeyTargets,
  nextMarker,
  contractSample,
  tables,
  tablesByName,
  untrackRow,
} from "../../graphql/__tests__/e2e/entity-factory.js";
import {
  acknowledgementRequired,
  challengeAnswerFor,
  isEntityBackedCreate,
  leaseRequired,
  operationIdFor,
} from "../../graphql/__tests__/e2e/operations.js";
import { expectedDeleteOutcome, expectFreshRecordOffers, operationWrittenReferences } from "../../graphql/__tests__/e2e/reference-policy.js";
import {
  createdRows,
  describe,
  type Identity,
  noRoles,
  readOnly,
  registerSuiteLifecycle,
  seed,
  tenantA,
  tenantB,
  test,
} from "../../graphql/__tests__/e2e/harness.js";
import { __entityMutationControlsForTests } from "../generated-mcp-server.js";
import {
  acquireLease,
  advertisedSchema,
  argsFor,
  authoredKeys,
  buildCreateArgs,
  callTool,
  catalogTool,
  createArgs,
  createForeignKeyTarget,
  createMcpRow,
  createSchemaProperties,
  expectCanonicalToolOutput,
  mcpCreateTables,
  mcpTables,
  resourcePayload,
  rpc,
  sessionMayInvoke,
  toolEnvelope,
  toolError,
  toolNameFor,
  toolPayload,
  notebookWriter,
  type CrudOperation,
} from "./e2e/mcp-sweep.js";

registerSuiteLifecycle();

test("MCP forwards every canonical mutation control, including update challenges", () => {
  expect(__entityMutationControlsForTests({
    expectedVersion: "2026-09-11T15:15:00.000Z",
    leaseToken: "lease",
    confirmed: true,
    confirmationToken: "challenge",
    confirmationAnswer: "Current name",
    ignored: "not-a-control",
  })).toEqual({
    expectedVersion: "2026-09-11T15:15:00.000Z",
    leaseToken: "lease",
    confirmed: true,
    confirmationToken: "challenge",
    confirmationAnswer: "Current name",
  });
});

describe("generated MCP server", () => {
  test("rejects an unauthenticated request", async () => {
    const { status } = await rpc(null, "tools/list");
    expect(status).toBe(401);
  });

  test("advertises the compiled tool catalog to an authorized session", async () => {
    const { status, body } = await rpc(tenantA, "tools/list");
    expect(status).toBe(200);
    const tools = body.result.tools as {
      name: string;
      outputSchema: Record<string, unknown>;
      annotations?: { idempotentHint?: boolean };
    }[];
    const names = tools.map((tool) => tool.name);
    const compiledNames = new Set(catalog.tools.map((tool) => tool.name));
    // The listing is authorized and deduplicated: a tool the session holds no
    // role for is withheld, and generic entities share one name the session
    // sees once. The expectation applies the same two rules to the catalog.
    expect(names.filter((name) => compiledNames.has(name))).toEqual([
      ...new Set(
        catalog.tools
          .filter((tool) => sessionMayInvoke(tenantA, tool.entity, tool.operation as CrudOperation))
          .map((tool) => tool.name),
      ),
    ]);

    const advertisedFor = (
      operation: "list" | "get" | "create" | "update" | "delete",
      entity?: string,
    ) => {
      const compiled = catalog.tools.find(
        (tool) => (!entity || tool.entity === entity) && tool.operation === operation,
      );
      return tools.find((tool) => tool.name === compiled?.name);
    };
    const get = advertisedFor("get", "Relation")!;
    const list = advertisedFor("list", "Relation")!;
    const create = advertisedFor("create", "Relation")!;
    const remove = advertisedFor("delete")!;
    const update = advertisedFor("update")!;
    for (const tool of [get, list, create]) {
      expect(tool.outputSchema.type).toBe("object");
      expect(Array.isArray(tool.outputSchema.oneOf)).toBe(true);
      const definitions = tool.outputSchema.$defs as Record<string, unknown>;
      expect(definitions.OperationOffer).toBeDefined();
      expect(definitions.OperationError).toBeDefined();
    }
    const getSuccess = (get.outputSchema.oneOf as Record<string, unknown>[])[0]!;
    const getProperties = getSuccess.properties as Record<string, Record<string, unknown>>;
    expect(getSuccess.required).toEqual(["data", "operations"]);
    expect(getProperties.data?.type).toBe("object");
    expect(getProperties.operations?.type).toBe("array");
    const listSuccess = (list.outputSchema.oneOf as Record<string, unknown>[])[0]!;
    expect(listSuccess).toMatchObject({
      properties: {
        data: {
          required: ["items", "totalCount", "nextCursor"],
        },
      },
    });
    // A canonical delete answers with the deletion envelope: `data.deleted`
    // is the constant true (a missing row is an error, never `deleted: false`).
    const removeSuccess = (remove.outputSchema.oneOf as Record<string, unknown>[])[0]!;
    expect(removeSuccess.required).toEqual(["data", "operations"]);
    expect(removeSuccess.properties).toMatchObject({
      data: { required: ["deleted"], properties: { deleted: { type: "boolean", const: true } } },
    });
    expect(update.annotations?.idempotentHint).toBe(false);
  });

  test("binds, authorizes and dispatches a canonical operation tool", async () => {
    const listed = await rpc(notebookWriter, "tools/list");
    expect(listed.status).toBe(200);
    const tools = listed.body.result.tools as { name: string; inputSchema: unknown }[];
    expect(tools).toContainEqual(expect.objectContaining({
      name: "osf_search_operations",
      inputSchema: expect.objectContaining({ type: "object" }),
    }));

    const searched = await callTool(notebookWriter, "osf_search_operations", {
      query: "import a notebook",
      limit: 20,
    });
    expect(toolEnvelope(searched.body)).toMatchObject({
      operations: [{ operation: { id: "notebook.import" } }],
    });

    const called = await callTool(notebookWriter, "osf_execute_operation", {
      operationId: "notebook.import",
      input: { notebookId: randomUUID(), body: "imported" },
      idempotencyKey: randomUUID(),
    });
    // The Operation is keyed with no external effect, so the runtime records
    // its receipt and lets the handler's own declared NOT_FOUND for a notebook
    // that never existed surface as the tool error. That the handler was
    // reached at all, through search and the generic executor, is the
    // dispatch this test proves.
    expect(toolError(called.body)).toMatch(/NOT_FOUND/);
  });

  test("carries the authored field schema into the tool input schema", async () => {
    const { body } = await rpc(tenantA, "tools/list");
    const tools = body.result.tools as {
      name: string;
      title?: string;
      description: string;
      inputSchema: any;
    }[];
    const create = tools.find((tool) => tool.name === "relation_create");
    expect(create).toBeDefined();
    expect(create!.title).toBe("Create relation");
    expect(create!.description).toContain("Creates one relation after validating");
    expect(create!.description).toContain("Ask for missing required fields");
    const displayName = create!.inputSchema.properties.displayName;
    // Authored validation reaches the model as JSON Schema, not as a 400.
    expect(displayName.maxLength).toBe(200);
    expect(create!.inputSchema.required).toContain("displayName");
    // Referentiedata expanded into a closed vocabulary at compile time.
    expect(create!.inputSchema.properties.relationType.enum).toEqual([
      "person",
      "organization",
      "group",
    ]);
  });

  test("scopes edit-lease acquire to authorized MCP-projected operations", async () => {
    const { body } = await rpc(tenantA, "tools/list");
    const acquire = (body.result.tools as { name: string; inputSchema: any }[]).find(
      (tool) => tool.name === "osf_acquire_edit_lease",
    );
    expect(acquire).toBeDefined();
    // The enum is the session's lease surface: every lease-protected,
    // MCP-projected mutation its roles reach — derived here from the same
    // contracts, so a converted entity extends it without a test edit. Plugin
    // Operations (blueprint commands) join it too, so the entity set is a
    // lower bound; a read never appears.
    const leaseProtected = mcpTables.flatMap((table) =>
      (["update", "delete"] as const)
        .filter((intent) => leaseRequired(table, intent) && table.source!.mcp!.operations[intent])
        .map((intent) => operationIdFor(table, intent)),
    );
    expect(leaseProtected).toContain("Relation.update");
    const offered = acquire!.inputSchema.properties.operationId.enum as string[];
    expect(offered).toEqual(expect.arrayContaining(leaseProtected));
    expect(offered.filter((id) => id.endsWith(".get") || id.endsWith(".list"))).toEqual([]);

    const hidden = await rpc(noRoles, "tools/list");
    expect(hidden.body.result.tools.map((tool: any) => tool.name)).not.toContain(
      "osf_acquire_edit_lease",
    );
    expect(hidden.body.result.tools.map((tool: any) => tool.name)).toContain(
      "osf_release_edit_lease",
    );

    const guessed = await callTool(tenantA, "osf_acquire_edit_lease", {
      operationId: "PaymentDetail.update",
      targetId: randomUUID(),
    });
    expect(toolError(guessed.body)).toMatch(/NOT_FOUND/);
  });

  test("refuses lease renewal after role revocation but still permits cleanup", async () => {
    const relation = mcpCreateTables.find(
      (table) => table.source?.authoringEntityName === "Relation",
    )!;
    const id = await createMcpRow(relation, tenantA);
    const acquired = await callTool(tenantA, "osf_acquire_edit_lease", {
      operationId: "Relation.update",
      targetId: id,
    });
    expect(toolError(acquired.body)).toBeUndefined();
    const leaseToken = toolPayload(acquired.body).leaseToken as string;
    const revoked = { ...tenantA, roles: [] };

    const renewal = await callTool(revoked, "osf_renew_edit_lease", {
      leaseToken,
    });
    expect(toolError(renewal.body)).toMatch(/NOT_FOUND/);

    const release = await callTool(revoked, "osf_release_edit_lease", {
      leaseToken,
    });
    expect(toolError(release.body)).toBeUndefined();
    expect(toolPayload(release.body)).toEqual({ released: true });
  });

  test("returns invalid expectedVersion as a canonical field validation error", async () => {
    const refused = await callTool(tenantA, "relation_update", {
      id: randomUUID(),
      values: {},
      expectedVersion: "2026-02-30T12:00:00.000Z",
      leaseToken: "not-used-because-version-validation-runs-first",
    });
    expect(toolError(refused.body)).toMatch(/VALIDATION/);
    expect(refused.body.result.structuredContent.error).toMatchObject({
      code: "VALIDATION",
      retryable: false,
      violations: [
        {
          field: "expectedVersion",
          code: "INVALID_DATETIME",
        },
      ],
    });
  });

  test("returns invalid mutation control types as canonical field validation errors", async () => {
    const refused = await callTool(tenantA, "relation_delete", {
      id: randomUUID(),
      expectedVersion: new Date().toISOString(),
      leaseToken: "not-used-because-control-validation-runs-first",
      confirmationToken: false,
    });
    expect(toolError(refused.body)).toMatch(/VALIDATION/);
    expect(refused.body.result.structuredContent.error).toMatchObject({
      code: "VALIDATION",
      retryable: false,
      violations: [
        {
          field: "confirmationToken",
          code: "INVALID_TYPE",
        },
      ],
    });
  });

  test("publishes Relation records and their interface-bound operation offers", async () => {
    const relation = mcpCreateTables.find(
      (table) => table.source?.authoringEntityName === "Relation",
    )!;
    const created = await callTool(
      tenantA,
      "relation_create",
      await buildCreateArgs(relation, tenantA),
    );
    expect(toolError(created.body)).toBeUndefined();
    const envelope = toolEnvelope(created.body);
    const id = envelope.data.id as string;
    createdRows.push({ table: relation, id, identity: tenantA });
    expect(envelope.operations).toHaveLength(3);
    expect(envelope.operations.map((offer: any) => offer.operation.id)).toEqual(
      expect.arrayContaining(["Relation.get", "Relation.update", "Relation.delete"]),
    );

    const listed = await rpc(tenantA, "resources/list");
    expect(listed.body.result.resources).toContainEqual(
      expect.objectContaining({ uri: "app://relations" }),
    );
    const templates = (await rpc(tenantA, "resources/templates/list")).body.result
      .resourceTemplates as { uriTemplate: string }[];
    expect(templates).toContainEqual(
      expect.objectContaining({ uriTemplate: "app://relations/{id}" }),
    );

    const record = resourcePayload(
      (await rpc(tenantA, "resources/read", { uri: `app://relations/${id}` })).body,
    );
    expect(record.data.id).toBe(id);
    expect(record.operations).toHaveLength(3);
    expect(record.operations.map((offer: any) => offer.operation.id)).toEqual(
      expect.arrayContaining(["Relation.get", "Relation.update", "Relation.delete"]),
    );
  });

  test("exposes the authorized YAML-derived entity catalog as MCP resources", async () => {
    const { status, body } = await rpc(tenantA, "resources/list");
    expect(status).toBe(200);
    const resources = body.result.resources as { uri: string; title: string }[];
    expect(resources.map((resource) => resource.uri)).toContain("osf://schema/entities");
    // The listing is authorized: an entity whose read roles the session does
    // not hold (a read-only projection outside the write vocabulary) is not
    // advertised, so the expectation is the catalog filtered by the same rule.
    const readable = catalog.entities.filter((entity) => {
      const roles = eligibleTables.find(
        (table) => table.source?.authoringEntityName === entity.entity,
      )?.source?.authorization?.roles?.read;
      return roles?.some((role) => tenantA.roles.includes(role)) === true;
    });
    expect(readable.length).toBeGreaterThan(0);
    expect(
      resources
        .map((resource) => resource.uri)
        .filter((uri) => uri.startsWith("osf://schema/entities/")),
    ).toEqual(readable.map((entity) => `osf://schema/entities/${entity.slug}`));

    const index = resourcePayload(
      (await rpc(tenantA, "resources/read", { uri: "osf://schema/entities" })).body,
    );
    expect(index.entities.map((entity: any) => entity.entity)).toEqual(
      readable.map((entity) => entity.entity),
    );
  });

  test("reads field, operation and only authorized relationship semantics", async () => {
    const source = catalog.entities.find((entity) => entity.entity === "Relation");
    expect(source).toBeDefined();
    const { status, body } = await rpc(tenantA, "resources/read", {
      uri: `osf://schema/entities/${source!.slug}`,
    });
    expect(status).toBe(200);
    const resource = resourcePayload(body);
    expect(resource.description).toBe(source!.description);
    expect(resource.fields).toHaveLength(source!.fields.length);
    expect(resource).not.toHaveProperty("jsonSchema");
    expect(resource.operations.length).toBeGreaterThan(0);
    const storageRelationships = tables.find(
      (table) => table.source?.authoringEntityName === source!.entity,
    )?.source?.graphql?.relationships ?? [];
    expect(resource.relationships).toEqual(
      source!.relationships
        .filter((relationship) =>
          catalog.entities.some((entity) => entity.entity === relationship.target),
        )
        .map((relationship) => {
          const target = catalog.entities.find(
            (entity) => entity.entity === relationship.target,
          )!;
          return {
            ...relationship,
            ...storageRelationships.find(
              (entry) => entry.fieldKey && entry.name === relationship.key,
            ),
            resourceUri: `osf://schema/entities/${target.slug}`,
          };
        }),
    );
    expect(resource.relationships.map((relationship: any) => relationship.target)).not.toContain(
      "Account",
    );
  });

  test("uses operation tool schemas as the authoritative write contract", async () => {
    const paymentDetail = catalog.entities.find(
      (entity) => entity.entity === "PaymentDetail",
    );
    expect(paymentDetail).toBeDefined();

    const resource = resourcePayload(
      (
        await rpc(tenantA, "resources/read", {
          uri: `osf://schema/entities/${paymentDetail!.slug}`,
        })
      ).body,
    );
    const { body } = await rpc(tenantA, "tools/list");
    const create = (body.result.tools as { name: string; inputSchema: any }[]).find(
      (tool) => tool.name === "payment_detail_create",
    );

    expect(resource).not.toHaveProperty("jsonSchema");
    expect(
      resource.fields
        .filter((field: any) => field.readOnly)
        .map((field: any) => field.key),
    ).toEqual(expect.arrayContaining(["id", "createdAt", "updatedAt"]));
    for (const field of ["id", "createdAt", "updatedAt"]) {
      expect(Object.keys(create!.inputSchema.properties)).not.toContain(field);
    }
    expect(create!.inputSchema.required).toEqual(["type"]);
  });

  test("does not enumerate or read entity resources for a session without roles", async () => {
    const listed = await rpc(noRoles, "resources/list");
    const uris = listed.body.result.resources.map((resource: any) => resource.uri);
    expect(uris).toContain("osf://schema/entities");
    expect(uris.filter((uri: string) => uri.startsWith("osf://schema/entities/"))).toEqual([]);
    const denied = await rpc(noRoles, "resources/read", {
      uri: `osf://schema/entities/${catalog.entities[0]!.slug}`,
    });
    expect(denied.body.error.code).toBe(-32602);
  });

  test("answers optional MCP catalogs without protocol errors", async () => {
    expect((await rpc(tenantA, "prompts/list")).body.result.prompts).toEqual([]);
    const templates = (await rpc(tenantA, "resources/templates/list")).body.result
      .resourceTemplates as { uriTemplate: string }[];
    expect(templates).toContainEqual(
      expect.objectContaining({ uriTemplate: "osf://onboarding/step/{step}" }),
    );
  });

  test("annotates read-only and destructive tools", async () => {
    const { body } = await rpc(tenantA, "tools/list");
    const tools = body.result.tools as { name: string; annotations: any }[];
    const listName = catalog.tools.find((tool) => tool.operation === "list")!.name;
    const deleteName = catalog.tools.find((tool) => tool.operation === "delete")!.name;
    expect(tools.find((t) => t.name === listName)!.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === deleteName)!.annotations.destructiveHint).toBe(
      true,
    );
  });

  test("hides write tools from a read-only session", async () => {
    const { body } = await rpc(readOnly, "tools/list");
    const names = (body.result.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain("relation_list");
    expect(names).toContain("relation_get");
    expect(names).not.toContain("relation_create");
    expect(names).not.toContain("relation_update");
    expect(names).not.toContain("relation_delete");
  });

  test("advertises no generated entity tools to a session with no roles", async () => {
    const { body } = await rpc(noRoles, "tools/list");
    const names = (body.result.tools as { name: string }[]).map((tool) => tool.name);
    const compiledNames = new Set(catalog.tools.map((tool) => tool.name));
    expect(names.filter((name) => compiledNames.has(name))).toEqual([]);
  });

  test("refuses a tool the session may not invoke", async () => {
    const { body } = await callTool(readOnly, "relation_create", { displayName: "nope" });
    expect(toolError(body)).toMatch(/NOT_FOUND/);
  });

  test("reports unknown tools without confirming which entities exist", async () => {
    const { body } = await callTool(tenantA, "no_such_tool", {});
    expect(toolError(body)).toMatch(/Unknown tool/);
  });

  for (const table of mcpTables) {
    const prefix = table.source!.mcp!.toolPrefix;
    const call = (
      identity: Identity,
      operation: CrudOperation,
      args: Record<string, unknown> = {},
    ) => callTool(identity, toolNameFor(table, operation), argsFor(table, args));

    test(`${prefix}: create, get, list, update, delete round-trip`, async () => {
      const args = await createArgs(table, tenantA);
      const created = await call(tenantA, "create", args);
      const createdEnvelope = toolEnvelope(created.body);
      let row = toolPayload(created.body);
      expect(toolError(created.body)).toBeUndefined();
      expectCanonicalToolOutput(table, "create", created.body);
      // A fresh record offers every Operation; only a transition whose
      // `from` excludes the initial state may be listed as INVALID_STATE.
      expectFreshRecordOffers(table, createdEnvelope.operations);
      expect(row.id).toBeTruthy();
      createdRows.push({ table, id: row.id, identity: tenantA });

      const fetchedCall = await call(tenantA, "get", { id: row.id });
      expectCanonicalToolOutput(table, "get", fetchedCall.body);
      const fetched = toolPayload(fetchedCall.body);
      expect(fetched.id).toBe(row.id);
      row = fetched;

      const listedCall = await call(tenantA, "list", { first: 5 });
      expectCanonicalToolOutput(table, "list", listedCall.body);
      const listed = toolPayload(listedCall.body);
      expect(Array.isArray(listed.items)).toBe(true);
      expect(listed.totalCount).toBeGreaterThan(0);

      const textColumn = table.columns.find(
        (column) =>
          column.type === "text" &&
          !column.primaryKey &&
          !["tenant_id", "created_at", "updated_at"].includes(column.name),
      );
      if (textColumn) {
        const controls = await acquireLease(table, tenantA, row, "update");
        const updatedCall = await call(tenantA, "update", {
          id: row.id,
          values: { [fieldName(textColumn)]: `updated-${seed}` },
          ...controls,
        });
        expectCanonicalToolOutput(table, "update", updatedCall.body);
        expect(toolError(updatedCall.body)).toBeUndefined();
        const updated = toolPayload(updatedCall.body);
        expect(updated[fieldName(textColumn)]).toBe(`updated-${seed}`);
        row = updated;
      }

      // Decided before the first delete call, from what the create left
      // behind, so a cascade that wrongly took the companions with it cannot
      // make a refusal look warranted after the fact.
      const outcome = await expectedDeleteOutcome(table, row.id, tenantA);
      const lease = await acquireLease(table, tenantA, row, "delete");
      let deleteControls: Record<string, string | boolean> = {
        ...lease,
        ...(acknowledgementRequired(table, "delete") ? { confirmed: true } : {}),
      };
      const first = await call(tenantA, "delete", { id: row.id, ...deleteControls });
      let deleted = first;
      if (toolError(first.body)?.includes("CONFIRMATION_REQUIRED")) {
        // A challenge-protected delete answers first with the challenge; the
        // answer is the record's current value of the authored field.
        const error = first.body.result.structuredContent.error;
        expect(error.retryAt).toBeUndefined();
        expect(error.data.confirmation.expiresAt).toBeString();
        deleteControls = {
          ...lease,
          confirmationToken: error.data.confirmation.challengeToken,
          confirmationAnswer: challengeAnswerFor(table, "delete", row),
        };
        deleted = await call(tenantA, "delete", { id: row.id, ...deleteControls });
      }

      // Rows that reference the record (a document's first version) mean the
      // schema's on-delete rule must refuse and the record must remain;
      // removing the companions is the create's own contract.
      if (outcome.refused) {
        expect(toolError(deleted.body)).toMatch(/REFERENCE_IN_USE/);
        const still = await call(tenantA, "get", { id: row.id });
        expect(toolError(still.body)).toBeUndefined();
        expect(toolPayload(still.body).id).toBe(row.id);
        expect(await expectedDeleteOutcome(table, row.id, tenantA)).toEqual(outcome);
        return;
      }
      expectCanonicalToolOutput(table, "delete", deleted.body);
      expect(toolError(deleted.body)).toBeUndefined();
      expect(toolPayload(deleted.body)).toEqual({ deleted: true });
      untrackRow(row.id);

      const missing = await call(tenantA, "get", { id: row.id });
      expectCanonicalToolOutput(table, "get", missing.body);
      expect(toolError(missing.body)).toMatch(/NOT_FOUND/);
      const missingError = missing.body.result.structuredContent.error;
      expect(missingError).toMatchObject({
        code: "NOT_FOUND",
        message: "Resource not found.",
        retryable: false,
      });
    });

    test(`${prefix}: does not leak rows across tenants`, async () => {
      const createdId = await createMcpRow(table, tenantA);
      const other = await call(tenantB, "get", { id: createdId });
      expect(toolError(other.body)).toMatch(/NOT_FOUND/);
    });

    if (isEntityBackedCreate(table)) {
      const optionField = Object.entries(createSchemaProperties(table))
        .find(([, schema]) => Array.isArray(schema.enum) && schema.enum.length > 0)?.[0];
      if (optionField) {
        test(`${prefix}: an out-of-options ${optionField} is the canonical VALIDATION answer with a field violation`, async () => {
          // The same envelope REST and GraphQL return: the runtime judges the
          // authored values once, for every interface, and MCP relays it.
          const valid = await createArgs(table, tenantA);
          const { body } = await call(tenantA, "create", { ...valid, [optionField]: "not-an-option" });
          expect(toolError(body)).toMatch(/VALIDATION/);
          expect(body.result.structuredContent.error).toMatchObject({
            code: "VALIDATION",
            retryable: false,
            violations: [{ field: optionField, code: "NOT_IN_OPTIONS" }],
          });
        });
      }

      // A required scalar, not a foreign key: the factory creates parents for
      // those, and their absence is a reference question, not this one.
      const foreignKeyFields = new Set(
        table.columns.filter((column) => foreignKeyTargets(table).has(column.name)).map(fieldName),
      );
      const requiredField = ((catalogTool(table, "create").inputSchema as { required?: string[] }).required ?? [])
        .find((field) => !foreignKeyFields.has(field));
      if (requiredField) {
        test(`${prefix}: a create missing ${requiredField} is the canonical VALIDATION answer with a REQUIRED violation`, async () => {
          // The edge holds the envelope only; the missing authored field is
          // the runtime's finding, so it arrives as a field violation and not
          // as ajv's verdict on the advertised argument object.
          const { [requiredField]: _omitted, ...incomplete } = await createArgs(table, tenantA);
          const { body } = await call(tenantA, "create", incomplete);
          expect(toolError(body)).toMatch(/VALIDATION/);
          expect(body.result.structuredContent.error).toMatchObject({
            code: "VALIDATION",
            violations: expect.arrayContaining([{ field: requiredField, code: "REQUIRED", message: expect.any(String) }]),
          });
        });
      }

      test(`${prefix}: rejects a create argument the tool schema does not declare`, async () => {
        // The schema says additionalProperties:false; the server must agree.
        const valid = await createArgs(table, tenantA);
        const { body } = await call(tenantA, "create", { ...valid, definitelyNotAField: "x" });
        expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
        expect(toolError(body)).toMatch(/definitelyNotAField/);
      });

      test(`${prefix}: rejects a server-managed field on create`, async () => {
        // Silently dropping `id` would let a model believe it chose the id.
        const valid = await createArgs(table, tenantA);
        const { body } = await call(tenantA, "create", {
          ...valid,
          id: "00000000-0000-0000-0000-000000000001",
        });
        expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
        expect(toolError(body)).toMatch(/\bid\b/);
      });
    } else {
      test(`${prefix}: a plugin-backed create is held to its advertised tool schema as a whole`, async () => {
        // A plugin Operation owns its nested input contract; the edge keeps
        // validating the full advertised schema, not a reduced envelope.
        const schema = catalogTool(table, "create").inputSchema as { required?: string[] };
        const missing = schema.required?.[0];
        if (!missing) return;
        const { [missing]: _omitted, ...incomplete } = await createArgs(table, tenantA);
        const { body } = await call(tenantA, "create", incomplete);
        expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
        expect(toolError(body)).toMatch(new RegExp(`required property '${missing}'`));
      });
    }

    test(`${prefix}: rejects an undeclared field inside update values`, async () => {
      const createdId = await createMcpRow(table, tenantA);
      const { body } = await call(tenantA, "update", {
        id: createdId,
        values: { definitelyNotAField: "x" },
      });
      expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
    });

    test(`${prefix}: rejects an unknown filter field`, async () => {
      const { body } = await call(tenantA, "list", {
        filter: { definitelyNotAField: "x" },
      });
      expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
    });

    /**
     * Relationship keys: every `belongsTo` foreign key the manifest emits a
     * reference for is a `<key>Id` the compiler now advertises on create,
     * update.values and list.filter — the same key REST and GraphQL accept.
     * The manifest is the oracle for which keys exist; the tool schema must
     * agree with it, and the server must honour what the schema advertises.
     * Required keys are already satisfied by buildCreateArgs; this exercises
     * the optional ones a model would otherwise have no way to set. A
     * plugin-backed create advertises its own contract, so only the update
     * and filter halves apply to it.
     */
    const referenceColumns = table.columns.filter((column) => {
      if (column.primaryKey || column.required) return false;
      const target = foreignKeyTargets(table).get(column.name);
      return target !== undefined && tablesByName.has(target);
    });
    // A reference an Operation writes (`writtenBy`) is nobody's to set through
    // create or update; mcp-reference-policy.e2e.test.ts proves that refusal.
    const relationshipKeys = referenceColumns.filter((column) => !operationWrittenReferences(table).some((reference) => reference.column === column));
    for (const column of relationshipKeys) {
      const key = fieldName(column);
      const targetTable = tablesByName.get(foreignKeyTargets(table).get(column.name)!)!;
      const onCreate = isEntityBackedCreate(table);

      test(`${prefix}: advertises ${key} as a uuid on ${onCreate ? "create, " : ""}update and filter`, async () => {
        const { body } = await rpc(tenantA, "tools/list");
        const tools = body.result.tools as { name: string; inputSchema: any }[];
        const update = await advertisedSchema(tenantA, tools, table, "update");
        const list = await advertisedSchema(tenantA, tools, table, "list");
        if (onCreate) {
          const create = await advertisedSchema(tenantA, tools, table, "create");
          expect(create.properties[key]).toMatchObject({ type: "string", format: "uuid" });
        }
        expect(list.properties.filter.properties[key]).toMatchObject({
          type: "string",
          format: "uuid",
        });
        if (column.immutable) {
          expect(update.properties.values.properties).not.toHaveProperty(key);
        } else {
          expect(update.properties.values.properties[key]).toMatchObject({
            type: "string",
            format: "uuid",
          });
        }
      });

      test(`${prefix}: accepts ${key} on create and filters the list by it`, async () => {
        const targetId = await createMcpRow(targetTable, tenantA);
        const created = await call(tenantA, "create", await createArgs(table, tenantA, { [key]: targetId }));
        expect(toolError(created.body)).toBeUndefined();
        const row = toolPayload(created.body);
        createdRows.push({ table, id: row.id, identity: tenantA });
        expect(row[key]).toBe(targetId);

        const listed = toolPayload(
          (await call(tenantA, "list", { filter: { [key]: targetId } })).body,
        );
        expect(listed.items.map((item: any) => item.id)).toContain(row.id);
        for (const item of listed.items) expect(item[key]).toBe(targetId);

        if (!column.immutable) {
          const otherId = await createMcpRow(targetTable, tenantA);
          const controls = await acquireLease(table, tenantA, row, "update");
          const updated = toolPayload(
            (
              await call(tenantA, "update", {
                id: row.id,
                values: { [key]: otherId },
                ...controls,
              })
            ).body,
          );
          expect(updated[key]).toBe(otherId);
        }
      });

      test(`${prefix}: refuses ${key} that names no ${targetTable.name} row`, async () => {
        // The foreign key constraint is what refuses this, so the answer is the
        // redacted driver-error shape rather than a validation code — the same
        // answer REST gives for the same body. The row must not exist after.
        const bogus = randomUUID();
        const { body } = await call(tenantA, "create", await createArgs(table, tenantA, { [key]: bogus }));
        expect(toolError(body)).toBeDefined();
        const listed = toolPayload(
          (await call(tenantA, "list", { filter: { [key]: bogus } })).body,
        );
        expect(listed.items).toEqual([]);
      });

      test(`${prefix}: a filter on ${key} never shows another tenant's rows`, async () => {
        // The filter is not an oracle across tenants: the value is another
        // tenant's real key, and row security answers with nothing, exactly as
        // a list without the filter would.
        const foreignTargetId = await createMcpRow(targetTable, tenantB);
        const created = await call(
          tenantB,
          "create",
          await createArgs(table, tenantB, { [key]: foreignTargetId }),
        );
        expect(toolError(created.body)).toBeUndefined();
        const foreignRow = toolPayload(created.body);
        createdRows.push({ table, id: foreignRow.id, identity: tenantB });

        const listed = toolPayload(
          (await call(tenantA, "list", { filter: { [key]: foreignTargetId } })).body,
        );
        expect(listed.items).toEqual([]);
      });
    }

    /**
     * Authored `immutable` over MCP (#177). The advertised schema and the
     * server's answer come from the same authored fact, so a model that reads
     * the catalog and a model that guesses both learn the same rule. A table
     * with no immutable column asserts the unaffected case: create and update
     * advertise the same properties. A plugin-backed create advertises its
     * own contract, so only the update half is comparable for it.
     */
    const immutableFields = table.columns.filter((column) => column.immutable).map(fieldName);
    const immutable = table.columns.find((column) => column.immutable);
    const offeredOnCreate = isEntityBackedCreate(table);

    test(`${prefix}: the update schema ${immutable ? "withholds" : "matches create on"} immutable fields`, async () => {
      const { body } = await rpc(tenantA, "tools/list");
      const tools = body.result.tools as { name: string; inputSchema: any }[];
      const update = await advertisedSchema(tenantA, tools, table, "update");
      // Authored fields only: a create may also offer a blueprint control,
      // an update its version and lease controls.
      const updatable = authoredKeys(update.properties.values.properties);

      if (!immutable) {
        if (offeredOnCreate) {
          const create = await advertisedSchema(tenantA, tools, table, "create");
          expect(updatable).toEqual(authoredKeys(create.properties));
        }
        return;
      }
      for (const field of immutableFields) expect(updatable).not.toContain(field);
      if (offeredOnCreate) {
        const creatable = authoredKeys((await advertisedSchema(tenantA, tools, table, "create")).properties);
        for (const field of immutableFields) expect(creatable).toContain(field);
        expect(updatable).toEqual(creatable.filter((key) => !immutableFields.includes(key)));
      }
    });

    if (immutable) {
      const field = fieldName(immutable);
      const fkTarget = foreignKeyTargets(table).get(immutable.name);

      test(`${prefix}: ${offeredOnCreate ? `accepts ${field} on create and ` : ""}refuses ${field} on update`, async () => {
        const valueFor = async () =>
          fkTarget ? createForeignKeyTarget(fkTarget, tenantA) : contractSample(table, immutable, nextMarker());
        const created = await call(
          tenantA,
          "create",
          await createArgs(table, tenantA, offeredOnCreate ? { [field]: await valueFor() } : {}),
        );
        expect(toolError(created.body)).toBeUndefined();
        const row = toolPayload(created.body);
        createdRows.push({ table, id: row.id, identity: tenantA });
        const value = row[field];
        if (offeredOnCreate) expect(value).toBeTruthy();

        const { body } = await call(tenantA, "update", {
          id: row.id,
          values: { [field]: await valueFor() },
        });
        expect(toolError(body)).toMatch(/BAD_USER_INPUT/);
        expect(toolError(body)).toMatch(new RegExp(field));

        const after = toolPayload((await call(tenantA, "get", { id: row.id })).body);
        expect(after[field]).toBe(value);
      });
    }
  }
});
