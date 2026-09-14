import { describe, expect, test } from "bun:test";
import { workerGrantedTablesFromManifest } from "./worker-role.js";

describe("workerGrantedTablesFromManifest", () => {
  test("grants only explicitly declared worker tables", () => {
    expect(workerGrantedTablesFromManifest([
      { schema: "workflow", table: "control_commands", workerAccess: "workflow-worker" },
      { schema: "workflow", table: "instances", workerDml: true },
      { schema: "erp", table: "relations" },
      { schema: "platform", table: "api_keys" },
    ])).toEqual([
      "workflow.control_commands",
      "workflow.instances",
    ]);
  });

  test("generated CRUD metadata never grants a business table implicitly", () => {
    const generatedBusinessTable = {
      schema: "erp",
      table: "relations",
      generatedCrud: true,
      generatedCrudEligible: true,
    };
    expect(workerGrantedTablesFromManifest([
      { schema: "workflow", table: "control_commands", workerAccess: "workflow-worker" },
      generatedBusinessTable,
    ])).toEqual(["workflow.control_commands"]);
  });

  test("a deployment without a cross-tenant worker queue grants nothing", () => {
    expect(workerGrantedTablesFromManifest([
      { schema: "workflow", table: "instances", workerDml: true },
    ])).toEqual([]);
  });
});
