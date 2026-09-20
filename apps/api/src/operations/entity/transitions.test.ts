// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import rawCatalog from "../../generated/operations/catalog.json" with { type: "json" };
import { bindOperationHandlers, type OperationContract } from "../runtime.js";
import { getGeneratedCrudTables } from "./catalog.js";
import { referencedInHoldsKey, transitionBinding, transitionRefusal, TRANSITIONS_PLUGIN, type TransitionBinding, type TransitionReferencedRow } from "./transitions.js";

const trigger = (rawCatalog as { operations: OperationContract[] }).operations
  .find((operation) => operation.key === "AgreementMilestone.trigger")!;

describe("status transition binding", () => {
  test("resolves the rule the Operation key stands for from the generated manifest", () => {
    const binding = transitionBinding(trigger);
    expect(binding.table.source?.authoringEntityName).toBe("AgreementMilestone");
    expect(binding.statusColumn.name).toBe("status");
    expect(binding.rule).toMatchObject({
      key: "trigger", from: ["pending"], to: "triggered",
      stamps: [{ field: "triggeredAt", value: "now" }, { field: "triggeredBy", value: "actor", actor: "user" }],
    });
    expect(Object.keys((trigger.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual(["id", "expectedVersion"]);
    expect(() => transitionBinding({ key: "AgreementMilestone.archive", target: { entityName: "AgreementMilestone" } })).toThrow("not a status transition");
  });

  test("binds every transition Operation in the core runtime with an offer policy that no module may replace", () => {
    const bound = bindOperationHandlers([]).get(trigger.key);
    expect(bound?.operation.plugin).toBe(TRANSITIONS_PLUGIN);
    expect(typeof bound?.handler).toBe("function");
    expect(typeof bound?.availability).toBe("function");
    expect(() => bindOperationHandlers([{ name: TRANSITIONS_PLUGIN } as never], [trigger])).toThrow("cannot be replaced");
  });

  test("refuses a status outside from, then a failed precondition, and otherwise allows", () => {
    const table = getGeneratedCrudTables().find((candidate) => candidate.source?.authoringEntityName === "AgreementMilestone")!;
    const base = transitionBinding(trigger);
    const binding: TransitionBinding = {
      ...base,
      referenced: [],
      rule: { ...base.rule, preconditions: [{ field: "expectedAt", present: true }, { field: "producedInvoiceId", present: false }] },
    };
    expect(transitionRefusal(binding, { status: "invoiced", expected_at: "2026-01-01" })).toMatchObject({
      code: "INVALID_STATE", message: "AgreementMilestone is invoiced; trigger moves status from pending to triggered.", retryable: false,
    });
    expect(transitionRefusal(binding, { status: "pending", expected_at: null })).toMatchObject({
      code: "INVALID_STATE", message: "trigger requires expectedAt to be set.",
    });
    expect(transitionRefusal(binding, { status: "pending", expected_at: "2026-01-01", produced_invoice_id: "x" })).toMatchObject({
      message: "trigger requires producedInvoiceId to be empty.",
    });
    expect(transitionRefusal(binding, { status: "pending", expected_at: "2026-01-01", produced_invoice_id: null })).toBeUndefined();
    // Strictly nullish: an empty string is present, so it satisfies `present: true` and fails `present: false`.
    expect(transitionRefusal(binding, { status: "pending", expected_at: "", produced_invoice_id: null })).toBeUndefined();
    expect(transitionRefusal(binding, { status: "pending", expected_at: "2026-01-01", produced_invoice_id: "" })).toMatchObject({
      message: "trigger requires producedInvoiceId to be empty.",
    });
    expect(table.columns.find((column) => column.name === "status")?.writtenBy?.[0]?.operation).toBe(trigger.key);
  });

  test("refuses a referenced precondition that fails present, in, or names no record in this tenant", () => {
    const base = transitionBinding(trigger);
    expect(base.referenced).toEqual([expect.objectContaining({ via: "agreementId", field: "code", present: true })]);
    const remote = (row?: Record<string, unknown>, inHolds: Record<string, boolean> = {}) =>
      new Map<string, TransitionReferencedRow | undefined>([["agreementId", row === undefined ? undefined : {
        row, inHolds: new Map(Object.entries(inHolds)),
      }]]);
    expect(transitionRefusal(base, { status: "pending" }, remote(undefined))).toMatchObject({
      code: "INVALID_STATE",
      message: "trigger requires agreementId.code on the Agreement that agreementId names in this tenant.",
    });
    expect(transitionRefusal(base, { status: "pending" }, remote({ code: null }))).toMatchObject({
      message: "trigger requires agreementId.code to be set.",
    });
    expect(transitionRefusal(base, { status: "pending" }, remote({ code: "" }))).toBeUndefined();
    expect(transitionRefusal(base, { status: "pending" }, remote({ code: "AGR-1" }))).toBeUndefined();

    const { present: _present, ...via } = base.referenced[0]!;
    const allowed = { ...base, referenced: [{ ...via, in: ["approved", "signed"] }] };
    const allowedKey = referencedInHoldsKey(allowed.referenced[0]!);
    expect(transitionRefusal(allowed, { status: "pending" }, remote({ code: "draft" }, { [allowedKey]: false }))).toMatchObject({
      message: "trigger requires agreementId.code to be one of approved, signed.",
    });
    expect(transitionRefusal(allowed, { status: "pending" }, remote({ code: "approved" }, { [allowedKey]: true }))).toBeUndefined();

    const empty = { ...base, referenced: [{ ...via, present: false }] };
    expect(transitionRefusal(empty, { status: "pending" }, remote({ code: "x" }))).toMatchObject({
      message: "trigger requires agreementId.code to be empty.",
    });
    expect(transitionRefusal(empty, { status: "pending" }, remote({ code: null }))).toBeUndefined();
  });

  test("two in preconditions on the same target field keep separate membership results", () => {
    const base = transitionBinding(trigger);
    const { present: _present, ...via } = base.referenced[0]!;
    const approved = { ...via, in: ["approved"] as Array<string | number | boolean> };
    const signed = { ...via, via: "parentAgreementId", in: ["signed"] as Array<string | number | boolean> };
    const binding: TransitionBinding = { ...base, referenced: [approved, signed] };
    const row = { code: "signed" };
    const inHolds = new Map([
      [referencedInHoldsKey(approved), false],
      [referencedInHoldsKey(signed), true],
    ]);
    const referenced = new Map<string, TransitionReferencedRow | undefined>([
      ["agreementId", { row, inHolds }],
      ["parentAgreementId", { row, inHolds }],
    ]);
    expect(transitionRefusal(binding, { status: "pending" }, referenced)).toMatchObject({
      message: "trigger requires agreementId.code to be one of approved.",
    });
    const bothHold = new Map([
      [referencedInHoldsKey(approved), true],
      [referencedInHoldsKey(signed), true],
    ]);
    expect(transitionRefusal(binding, { status: "pending" }, new Map([
      ["agreementId", { row: { code: "approved" }, inHolds: bothHold }],
      ["parentAgreementId", { row: { code: "signed" }, inHolds: bothHold }],
    ]))).toBeUndefined();
  });
});
