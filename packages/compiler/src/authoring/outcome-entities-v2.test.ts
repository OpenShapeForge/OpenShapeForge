// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CompiledEntityInfo } from "../plugins.js";
import {
  buildStaticOperationCatalog,
  collectEntityOperations,
} from "../generate-operations.js";
import { compile } from "./compiler/index.js";
import { assertV2Authoring } from "./entity-v2.js";
import { loadEntity } from "./loader.js";
import { buildWebManifest } from "./web-manifest.js";

const authoringDir = join(import.meta.dir, "../../config/authoring");

const expected = {
  quote: {
    entity: "Quote",
    fields: [
      "id", "createdAt", "updatedAt", "externalId", "sourceAuthority",
      "sourceOrganization", "sourceAdministration", "quoteStatus", "quoteNumber",
      "issueDate", "expiresAt", "currencyCode", "amountBase", "amountVat",
      "amountTotal", "description", "externalCode",
    ],
    relationships: ["relationId", "agreementId", "document"],
    operations: ["list", "get", "create", "update", "delete"],
  },
  "quote-line": {
    entity: "QuoteLine",
    fields: [
      "id", "createdAt", "updatedAt", "externalId", "sourceAuthority",
      "sourceOrganization", "sourceAdministration", "lineNumber", "description",
      "quantity", "unitId", "unitPrice", "amountBase", "amountVat", "amountTotal",
    ],
    relationships: [
      "quoteId", "agreementComponentId", "vatRateId", "ledgerAccountId",
      "componentDimensionId", "dimension1Id", "dimension2Id", "vatDimensionId",
    ],
    operations: ["list", "get", "create", "update", "delete"],
  },
  agreement: {
    entity: "Agreement",
    fields: [
      "id", "createdAt", "updatedAt", "externalId", "sourceAuthority",
      "sourceOrganization", "sourceAdministration", "code", "role", "agreementType",
      "agreementSubType", "status", "startDate", "endDate", "billingStartDate",
      "billingEndDate", "conceptSentAt", "sentAt", "dispatchStatus", "noticeDate",
      "noticeTerm", "terminationReason", "terminationReasonDetail", "sequenceNumber",
      "externalCode",
    ],
    relationships: ["relationId", "caseId", "parentAgreementId", "document", "childAgreements", "parties"],
    operations: ["list", "get", "create", "update", "delete"],
  },
  "agreement-milestone": {
    entity: "AgreementMilestone",
    fields: [
      "id", "createdAt", "updatedAt", "externalId", "sourceAuthority",
      "sourceOrganization", "sourceAdministration", "description", "basisAmount",
      "percentOfBasis", "amount", "status", "expectedAt", "triggeredAt", "triggeredBy",
    ],
    relationships: ["agreementId", "producedInvoiceId"],
    operations: ["list", "get", "update", "delete"],
  },
} as const;

function compileOutcome(slug: keyof typeof expected): CompiledEntityInfo {
  return {
    slug,
    path: `entities/core/${slug}.yaml`,
    origin: "core",
    contract: compile(loadEntity(authoringDir, slug)),
  };
}

describe("field-relational outcome entities", () => {
  test("preserves the four canonical models, rights and operation subsets", () => {
    for (const [slug, contractExpected] of Object.entries(expected)) {
      const contract = compileOutcome(slug as keyof typeof expected).contract;
      expect(contract.authoringVersion).toBe(3);
      expect(contract.entity.name).toBe(contractExpected.entity);
      expect(contract.model.fields.map(({ key }) => key)).toEqual([...contractExpected.fields, ...contractExpected.relationships]);
      expect(contract.model.relationships.map(({ key }) => key)).toEqual(
        [...contractExpected.relationships],
      );
      expect(Object.keys(contract.entityOperations)).toEqual([...contractExpected.operations]);
      expect(contract.mcp?.tools).toBe("generic");
      expect(contract.rest?.operations).toEqual(contract.crud.operations);
      expect(contract.graphql.operations).toEqual(contract.crud.operations);

      for (const intent of ["update", "delete"] as const) {
        expect(contract.entityOperations[intent]?.concurrency).toEqual({
          version: { mode: "required", field: "updatedAt" },
          editLease: { mode: "required", expiresAfterInactivity: "PT15M" },
        });
      }
    }

    expect(compileOutcome("quote").contract.authorization.roles).toEqual({
      read: [
        "Finance.All.Read", "Finance.All.ReadWrite",
        "Finance.Quotes.Read", "Finance.Quotes.ReadWrite",
      ],
      create: ["Finance.All.ReadWrite", "Finance.Quotes.ReadWrite"],
      update: ["Finance.All.ReadWrite", "Finance.Quotes.ReadWrite"],
      delete: ["Finance.All.ReadWrite", "Finance.Quotes.ReadWrite"],
    });
    expect(compileOutcome("agreement-milestone").contract.crud.operations.create).toBe(false);
  });

  test("projects complete read and write Web views without making computed fields editable", () => {
    const manifest = buildWebManifest(
      (Object.keys(expected) as Array<keyof typeof expected>).map(compileOutcome),
    );
    const quote = manifest.entities.Quote!;
    expect(quote.views.collection).toMatchObject({
      route: "/quotes",
      displayField: "quoteNumber",
      columns: [
        { key: "quoteNumber" }, { key: "quoteStatus" }, { key: "issueDate" },
        { key: "expiresAt" }, { key: "amountTotal" },
      ],
    });
    expect(quote.views.record).toMatchObject({
      modes: ["read", "create", "update"],
      routes: { read: "/quotes/:id", create: "/quotes/new" },
      operations: {
        read: { id: "Quote.get" },
        create: { id: "Quote.create" },
        update: { id: "Quote.update" },
        delete: { id: "Quote.delete" },
      },
    });

    const milestone = manifest.entities.AgreementMilestone!;
    expect(milestone.views.record?.modes).toEqual(["read", "update"]);
    expect(milestone.views.record?.operations.create).toBeUndefined();
    expect(milestone.fields.amount?.supports).toEqual({
      read: true,
      create: false,
      update: false,
    });
    expect(milestone.fields.description?.supports.update).toBe(true);
  });

  test("projects a non-default authored lease timeout into every Web operation reference", () => {
    const source = loadEntity(authoringDir, "quote");
    const update = source.coreEntity?.operations?.update;
    if (!update?.concurrency?.editLease) throw new Error("Quote.update must declare an edit lease");
    update.concurrency.editLease.expiresAfterInactivity = "PT2M";
    const quote = buildWebManifest([{
      slug: "quote",
      contract: compile(source),
    }]).entities.Quote!;

    expect(quote.operations.update).toMatchObject({
      id: "Quote.update",
      concurrency: {
        version: { mode: "required", field: "updatedAt" },
        editLease: { mode: "required", expiresAfterInactivity: "PT2M" },
      },
    });
    expect(quote.views.record?.operations.update).toEqual(
      expect.objectContaining({
        id: "Quote.update",
        concurrency: expect.objectContaining({
          editLease: { mode: "required", expiresAfterInactivity: "PT2M" },
        }),
      }),
    );
    expect(quote.operations.get).not.toHaveProperty("concurrency");
  });

  test("projects authored opaque Web renderer keys while retaining defaults", () => {
    const source = loadEntity(authoringDir, "quote");
    const web = source.coreEntity?.interfaces?.web;
    if (!web?.views?.record) throw new Error("Quote must declare both Web views");
    web.views.collection.renderer = "finance.quote.collection";
    web.views.record.renderer = "finance.quote.record";
    assertV2Authoring(source.coreEntity, "quote.yaml");

    const quote = buildWebManifest([{ slug: "quote", contract: compile(source) }])
      .entities.Quote!;
    expect(quote.views.collection.renderer).toBe("finance.quote.collection");
    expect(quote.views.record?.renderer).toBe("finance.quote.record");

    const agreement = buildWebManifest([compileOutcome("agreement")])
      .entities.Agreement!;
    expect(agreement.views.collection.renderer).toBe("entity.collection");
    expect(agreement.views.record?.renderer).toBe("entity.record");

    web.views.record.renderer = "Finance/Quote";
    expect(() => assertV2Authoring(source.coreEntity, "quote.yaml")).toThrow(
      /interfaces\.web\.views\.record\.renderer/,
    );
  });

  test("carries a collection-scoped YAML Operation into the collection action list", () => {
    const artifacts = loadEntity(authoringDir, "quote");
    artifacts.coreEntity.operations!.compose = {
      id: "example.quote.compose",
      name: { en: "Compose quote", nl: "Offerte samenstellen" },
      description: "Composes a quote aggregate.",
      implementation: { type: "plugin", plugin: "example", handler: "composeQuote" },
      target: { scope: "collection" },
      input: {
        schema: {
          type: "object",
          required: ["requestKey"],
          properties: { requestKey: { type: "string" } },
          additionalProperties: false,
        },
      },
      output: { schema: { type: "object" } },
      errors: [],
      auth: { mode: "session", roles: ["Finance.Quotes.ReadWrite"] },
      tenancy: { mode: "required" },
      effects: { data: "write", external: "none" },
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
      confirmation: { mode: "none" },
    };
    artifacts.coreEntity.interfaces!.web!.views!.collection.actions = ["compose"];
    assertV2Authoring(artifacts.coreEntity, "quote.yaml");

    const contract = compile(artifacts);
    expect(contract.interfaces?.web?.collectionActions).toEqual(["compose"]);
    const projected = buildWebManifest([{
      slug: "quote",
      contract,
    }]).entities.Quote!;
    expect(projected.views.collection.operations.actions).toEqual([
      expect.objectContaining({ id: "example.quote.compose", intent: "invoke" }),
    ]);
  });

  test("keeps a plugin-backed create as the one canonical entity Operation", () => {
    const artifacts = loadEntity(authoringDir, "quote");
    artifacts.coreEntity.operations!.create = {
      id: "example.quotes.create",
      name: { en: "Create governed quote", nl: "Beheerde offerte aanmaken" },
      description: "Validates a source definition and creates its entity head atomically.",
      implementation: {
        type: "plugin",
        plugin: "example",
        handler: "createGovernedQuote",
        action: "create",
      },
      target: { scope: "collection" },
      input: {
        schema: {
          type: "object",
          required: ["requestKey", "definition"],
          additionalProperties: false,
          properties: {
            requestKey: { type: "string", minLength: 1 },
            definition: {
              type: "object",
              additionalProperties: true,
              "x-osf-sourceField": "description",
            },
          },
        },
      },
      output: {
        schema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
          additionalProperties: true,
        },
      },
      errors: [{ status: 400, code: "INVALID_SOURCE", description: "The source is invalid." }],
      effects: { data: "write", external: "none" },
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
      confirmation: { mode: "none" },
    };
    assertV2Authoring(artifacts.coreEntity, "quote.yaml");

    const contract = compile(artifacts);
    expect(contract.entityOperations.create).toMatchObject({
      id: "example.quotes.create",
      key: "create",
      intent: "create",
      implementation: { type: "plugin", plugin: "example", handler: "createGovernedQuote" },
      target: { entityId: "core.Quote", entityName: "Quote", scope: "collection" },
      input: {
        kind: "json-schema",
        schema: { required: ["requestKey", "definition"] },
      },
      output: {
        kind: "json-schema",
        schema: { required: ["id"] },
      },
      authorization: {
        action: "create",
        roles: ["Finance.All.ReadWrite", "Finance.Quotes.ReadWrite"],
      },
      effects: { data: "write", external: "none" },
      reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
    });
    expect(contract.pluginOperations?.some(({ key }) => key === "create")).toBe(false);

    const web = buildWebManifest([{ slug: "quote", contract }]).entities.Quote!;
    expect(web.views.record).toMatchObject({
      modes: ["read", "create", "update"],
      routes: { create: "/quotes/new" },
      operations: {
        create: {
          id: "example.quotes.create",
          intent: "create",
          implementation: { type: "plugin", plugin: "example", handler: "createGovernedQuote" },
          input: {
            kind: "json-schema",
            schema: {
              required: ["requestKey", "definition"],
              properties: {
                definition: { "x-osf-sourceField": "description" },
              },
            },
          },
        },
      },
    });

    const operations = collectEntityOperations([{ contract }]);
    const catalog = buildStaticOperationCatalog([], operations, [{ contract }], {});
    const create = catalog.operations.find(({ id }) => id === "example.quotes.create");
    expect(create).toMatchObject({
      intent: "create",
      implementation: { type: "plugin" },
      inputSchema: { required: ["requestKey", "definition"] },
      outputSchema: { required: ["id"] },
    });
    expect(catalog.operations.filter(({ id }) => id === "example.quotes.create")).toHaveLength(1);
  });

  test("rejects duplicate policy and non-record output on plugin-backed CRUD", () => {
    const artifacts = loadEntity(authoringDir, "quote");
    const create = artifacts.coreEntity.operations!.create!;
    create.implementation = {
      type: "plugin",
      plugin: "example",
      handler: "createGovernedQuote",
      action: "create",
    };
    create.target = { scope: "collection" };
    create.input = {
      schema: {
        type: "object",
        required: ["requestKey"],
        properties: { requestKey: { type: "string" } },
      },
    };
    create.output = { schema: { type: "object", additionalProperties: true } };
    create.errors = [];
    create.auth = { mode: "session", roles: ["Finance.Quotes.ReadWrite"] };
    create.tenancy = { mode: "required" };
    create.reliability = { idempotency: { mode: "keyed", inputField: "requestKey" } };

    expect(() => assertV2Authoring(artifacts.coreEntity, "quote.yaml")).toThrow(
      /derives authorization and tenancy from the entity/,
    );
    delete create.auth;
    delete create.tenancy;
    expect(() => assertV2Authoring(artifacts.coreEntity, "quote.yaml")).toThrow(
      /required string id for the canonical entity head/,
    );
    create.output = {
      schema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    };
    ((create.input.schema.properties as Record<string, Record<string, unknown>>).requestKey!)[
      "x-osf-sourceField"
    ] = "missingField";
    expect(() => assertV2Authoring(artifacts.coreEntity, "quote.yaml")).toThrow(
      /references unknown entity field "missingField"/,
    );
    delete ((create.input.schema.properties as Record<string, Record<string, unknown>>).requestKey!)[
      "x-osf-sourceField"
    ];
    artifacts.coreEntity.interfaces!.rest = {
      operations: { create: { method: "GET" } },
    };
    expect(() => assertV2Authoring(artifacts.coreEntity, "quote.yaml")).toThrow(
      /cannot project REST method GET/,
    );
    artifacts.coreEntity.interfaces!.rest.operations!.create = {
      method: "POST",
      path: "/api/example/quotes/:id",
    };
    expect(() => assertV2Authoring(artifacts.coreEntity, "quote.yaml")).toThrow(
      /cannot bind record parameters in its collection REST path/,
    );
    artifacts.coreEntity.interfaces!.rest.operations!.create = {
      method: "POST",
      path: "/api/example/quotes",
      response: { kind: "binary" },
    };
    expect(() => assertV2Authoring(artifacts.coreEntity, "quote.yaml")).toThrow(
      /must project a JSON REST response/,
    );
  });
});
