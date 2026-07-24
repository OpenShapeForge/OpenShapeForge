import { describe, expect, it } from "bun:test";
import { resolveListFallbackField } from "./pages.js";
import type { CompiledEntityContract } from "../types/compiled.js";

function contract(opts: {
  name?: string;
  storageFields?: string[];
  modelFields?: { key: string; sortable?: boolean }[];
  graphqlFields?: string[];
}): CompiledEntityContract {
  return {
    entity: { name: opts.name ?? "Thing" },
    storage: {
      columns: (opts.storageFields ?? ["id"]).map((field) => ({ field, column: field })),
    },
    model: {
      fields: (opts.modelFields ?? []).map((f) => ({ key: f.key, sortable: f.sortable })),
    },
    graphql: { fields: (opts.graphqlFields ?? []).map((name) => ({ name })) },
  } as unknown as CompiledEntityContract;
}

describe("resolveListFallbackField", () => {
  it("prefers displayName when the entity has it", () => {
    const c = contract({ graphqlFields: ["id", "displayName", "value"] });
    expect(resolveListFallbackField(c, new Set(["id", "displayName", "value"]))).toBe(
      "displayName",
    );
  });

  it("falls back to the primary-key field when displayName is absent", () => {
    const c = contract({ storageFields: ["id"], graphqlFields: ["id", "value"] });
    expect(resolveListFallbackField(c, new Set(["id", "value"]))).toBe("id");
  });

  it("falls back to the first sortable core field when there is no id or displayName", () => {
    const c = contract({
      storageFields: ["code"],
      modelFields: [
        { key: "note", sortable: false },
        { key: "code", sortable: true },
      ],
      graphqlFields: ["code", "note"],
    });
    expect(resolveListFallbackField(c, new Set(["code", "note"]))).toBe("code");
  });

  it("throws when no valid fallback column exists", () => {
    const c = contract({ storageFields: [], modelFields: [], graphqlFields: [] });
    expect(() => resolveListFallbackField(c, new Set())).toThrow(
      /Cannot resolve a list sort\/filter fallback field/i,
    );
  });
});
