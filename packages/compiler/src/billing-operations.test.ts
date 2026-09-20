// SPDX-License-Identifier: BUSL-1.1
/**
 * The billing Operations authored on the core entities: BillingRun.execute
 * (the milestone billing run) and AgreementMilestone.create, both bound to
 * the core `osf-billing` module, and the InvoiceSequence index the run's
 * numbering relies on.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadEntity } from "./authoring/loader.js";
import { compile } from "./authoring/compiler/index.js";
import { CORE_OPERATION_MODULES, collectAuthoredEntityPluginOperations } from "./generate-operations.js";

const authoringDir = join(import.meta.dir, "../config/authoring");
const context = { repoRoot: authoringDir, authoringDir, webPresent: false };

describe("billing Operations", () => {
  const run = compile(loadEntity(authoringDir, "billing-run"));
  const milestone = compile(loadEntity(authoringDir, "agreement-milestone"));
  const sequence = compile(loadEntity(authoringDir, "invoice-sequence"));

  test("osf-billing is a core module, so its Operations need no plugin runtime", () => {
    expect(CORE_OPERATION_MODULES).toContain("osf-billing");
  });

  test("BillingRun.execute is a keyed, finance-only collection Operation under the billing-runs resource", () => {
    const authored = run.pluginOperations!.find((candidate) => candidate.key === "execute")!;
    expect(authored.id).toBe("BillingRun.execute");
    expect(authored.definition.implementation).toEqual({ type: "plugin", plugin: "osf-billing", handler: "executeBillingRun" });
    expect(authored.definition.target).toEqual({ scope: "collection" });
    expect(authored.definition.auth).toEqual({ mode: "session", roles: ["Finance.All.ReadWrite"] });
    expect(authored.definition.reliability).toEqual({ idempotency: { mode: "keyed", inputField: "idempotencyKey" } });
    expect(authored.definition.effects).toEqual({ data: "write", external: "none" });
    expect(authored.definition.errors!.map((error) => [error.status, error.code])).toEqual([
      [400, "VALIDATION"], [401, "UNAUTHENTICATED"], [403, "FORBIDDEN"], [404, "REFERENCE_NOT_FOUND"], [409, "ALREADY_EXISTS"],
    ]);

    const compiled = collectAuthoredEntityPluginOperations([{ contract: run }], context)
      .find((candidate) => candidate.key === "BillingRun.execute")!;
    expect(compiled.plugin).toBe("osf-billing");
    expect(compiled.idempotency).toEqual({ mode: "idempotency-key", header: "Idempotency-Key", inputField: "idempotencyKey" });
    expect(compiled.transports.rest).toMatchObject({ method: "POST", path: "/api/rest/v1/billing-runs/execute" });
    expect(compiled.transports.mcp).toEqual({ enabled: true, name: "billing_run_execute" });
    expect(compiled.transports.graphql).toMatchObject({ enabled: true, kind: "mutation", field: "billingRunExecute" });
    const input = compiled.inputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(input.required).toEqual(["idempotencyKey"]);
    expect(Object.keys(input.properties)).toEqual(["idempotencyKey", "agreementId", "dryRun"]);
  });

  test("AgreementMilestone.create is the plugin create that freezes the amount, under the entity's create roles", () => {
    const create = milestone.entityOperations.create!;
    expect(create.implementation).toEqual({ type: "plugin", plugin: "osf-billing", handler: "createAgreementMilestone" });
    expect(create.authorization).toEqual({ action: "create", roles: ["Agreements.All.ReadWrite"] });
    expect(create.input).toMatchObject({ kind: "json-schema" });
    const schema = (create.input as unknown as { schema: { required: string[]; properties: Record<string, unknown>; anyOf: Array<{ required: string[] }> } }).schema;
    expect(schema.required).toEqual(["agreementId", "description"]);
    // Either a fixed amount or a basis with a percentage: the contract says so.
    expect(schema.anyOf.map((branch) => branch.required)).toEqual([["amount"], ["basisAmount", "percentOfBasis"]]);
    expect(Object.keys(schema.properties)).toEqual(["agreementId", "description", "basisAmount", "percentOfBasis", "amount", "expectedAt"]);
    // The status and the invoice reference are written by the transitions, never by a create.
    for (const key of ["status", "producedInvoiceId", "triggeredAt"]) {
      expect(milestone.model.fields.find((field) => field.key === key)!.writtenBy?.length).toBeGreaterThan(0);
    }
  });

  test("InvoiceSequence is unique per tenant, kind and fiscal year so numbering can upsert", () => {
    expect(sequence.entity.indexes).toContainEqual({
      name: "invoice_sequences_tenant_kind_fiscal_year_uidx",
      fields: ["tenantId", "kind", "fiscalYearCode"],
      unique: true,
    });
  });
});
