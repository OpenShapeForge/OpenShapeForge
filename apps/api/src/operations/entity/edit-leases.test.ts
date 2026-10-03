// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  callEditLeaseTool,
  editLeaseOperationIdsForSession,
  editLeaseToolsForOperationIds,
} from "../../mcp/edit-lease-tools.js";
import { fixedDurationSeconds } from "./edit-leases.js";
import { getEntityOperationContracts } from "./runtime.js";

describe("central entity edit leases", () => {
  test("uses bounded fixed inactivity durations", () => {
    expect(fixedDurationSeconds("PT15M")).toBe(900);
    expect(fixedDurationSeconds("PT1H30M")).toBe(5_400);
    expect(() => fixedDurationSeconds("P1M")).toThrow(/fixed ISO-8601/);
    expect(() => fixedDurationSeconds("PT5S")).toThrow(/between PT30S and P1D/);
  });

  test("projects three generic tools only for an authorized MCP-projected lease operation", () => {
    const update = getEntityOperationContracts().find(
      ({ id }) => id === "Relation.update",
    )!;
    const projected = [update.id];
    expect(editLeaseOperationIdsForSession({ roles: [] }, projected)).toEqual([]);
    expect(editLeaseOperationIdsForSession(
      { roles: [update.authorization.roles[0]!] },
      [],
    )).toEqual([]);
    expect(editLeaseToolsForOperationIds([]).map(({ name }) => name)).toEqual([
      "osf_release_edit_lease",
    ]);
    const allowed = editLeaseOperationIdsForSession(
      { roles: [update.authorization.roles[0]!] },
      projected,
    );
    expect(allowed).toEqual([update.id]);
    const tools = editLeaseToolsForOperationIds(allowed);
    expect(tools.map(({ name }) => name)).toEqual([
      "osf_acquire_edit_lease",
      "osf_renew_edit_lease",
      "osf_release_edit_lease",
    ]);
    expect(
      (tools[0]!.inputSchema.properties!.operationId as { enum: string[] }).enum,
    ).toEqual([update.id]);
    expect(tools.every(({ outputSchema }) => outputSchema !== undefined)).toBe(true);
    const successData = (toolIndex: number) =>
      ((((tools[toolIndex]!.outputSchema as unknown as { oneOf: unknown[] }).oneOf[0]) as {
        properties: { data: { required: string[] } };
      }).properties.data.required);
    expect(successData(0)).toContain("leaseToken");
    expect(successData(1)).not.toContain("leaseToken");
    const ajv = new Ajv2020.default({ strict: false, validateFormats: false });
    const validateFailure = ajv.compile(tools[0]!.outputSchema!);
    expect(validateFailure({
      error: {
        code: "LOCKED",
        message: "This record is currently being edited.",
        retryable: true,
        retryAt: "2026-09-11T15:15:00.000Z",
      },
    })).toBe(true);
  });

  test("refuses a guessed Web-only operation id before touching the lease runtime", async () => {
    const update = getEntityOperationContracts().find(
      ({ id }) => id === "Relation.update",
    )!;
    const call = callEditLeaseTool(
      "osf_acquire_edit_lease",
      { operationId: update.id, targetId: "00000000-0000-0000-0000-000000000001" },
      undefined as never,
      { roles: [update.authorization.roles[0]!] },
      new Set(),
    );
    await expect(call).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });
});
