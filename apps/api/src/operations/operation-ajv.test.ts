// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { createOperationAjv } from "./operation-ajv.js";

describe("the x-osf-choice annotation", () => {
  test("is accepted in its string and object forms and refused when malformed", () => {
    const ajv = createOperationAjv();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": "field" })).not.toThrow();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": { kind: "operation", scope: "record" } })).not.toThrow();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": "widget" })).toThrow();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": { kind: "operation", scope: "collection" } })).not.toThrow();
    expect(() => ajv.compile({ type: "string", "x-osf-choice": { kind: "field" } })).toThrow();
    // Unscoped is the string form; an object without a scope is a mistake.
    expect(() => ajv.compile({ type: "string", "x-osf-choice": { kind: "operation" } })).toThrow();
  });
});
