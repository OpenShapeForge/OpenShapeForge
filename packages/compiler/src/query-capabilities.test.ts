// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { fieldQueryCapabilities } from "./query-capabilities.js";

describe("fieldQueryCapabilities", () => {
  it("keeps legacy defaults for definitions without query flags", () => {
    expect(fieldQueryCapabilities({ valueType: "string", cardinality: "single" })).toEqual({
      searchable: true,
      filterable: true,
      sortable: true,
    });
    expect(fieldQueryCapabilities({ valueType: "number", cardinality: "single" })).toEqual({
      searchable: false,
      filterable: true,
      sortable: true,
    });
  });

  it("honors independent explicit opt-outs", () => {
    expect(fieldQueryCapabilities({
      valueType: "string",
      cardinality: "single",
      searchable: false,
      filterable: false,
      sortable: false,
    })).toEqual({ searchable: false, filterable: false, sortable: false });
  });

  it("never enables scalar query operations for object or collection shapes", () => {
    expect(fieldQueryCapabilities({ valueType: "object", cardinality: "single" })).toEqual({
      searchable: false,
      filterable: false,
      sortable: false,
    });
    expect(fieldQueryCapabilities({ valueType: "string", cardinality: "collection" })).toEqual({
      searchable: false,
      filterable: false,
      sortable: false,
    });
  });
});
