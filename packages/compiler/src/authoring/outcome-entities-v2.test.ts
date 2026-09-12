// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CompiledEntityInfo } from "../plugins.js";
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
    relationships: ["relation", "agreement"],
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
      "quote", "agreementComponent", "vatRate", "ledgerAccount",
      "componentDimension", "dimension1", "dimension2", "vatDimension",
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
    relationships: ["relation", "case", "parentAgreement", "childAgreements"],
    operations: ["list", "get", "create", "update", "delete"],
  },
  "agreement-milestone": {
    entity: "AgreementMilestone",
    fields: [
      "id", "createdAt", "updatedAt", "externalId", "sourceAuthority",
      "sourceOrganization", "sourceAdministration", "description", "basisAmount",
      "percentOfBasis", "amount", "status", "expectedAt", "triggeredAt", "triggeredBy",
    ],
    relationships: ["agreement", "producedInvoice"],
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

describe("strict-v2 outcome entities", () => {
  test("preserves the four canonical models, rights and operation subsets", () => {
    for (const [slug, contractExpected] of Object.entries(expected)) {
      const contract = compileOutcome(slug as keyof typeof expected).contract;
      expect(contract.authoringVersion).toBe(2);
      expect(contract.entity.name).toBe(contractExpected.entity);
      expect(contract.model.fields.map(({ key }) => key)).toEqual([...contractExpected.fields]);
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
    artifacts.coreEntity.interfaces!.web!.views.collection.actions = ["compose"];
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
});
