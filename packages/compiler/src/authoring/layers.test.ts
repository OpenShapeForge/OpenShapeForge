import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { resolveAuthoringLayers, strategicMerge } from "./layers.js";

describe("strategicMerge", () => {
  test("objects deep-merge and null deletes a property", () => {
    const result = strategicMerge(
      { a: 1, nested: { keep: true, drop: 1 }, gone: "x" },
      { nested: { drop: 2, added: "y" }, gone: null },
    ) as Record<string, unknown>;
    expect(result).toEqual({ a: 1, nested: { keep: true, drop: 2, added: "y" } });
  });

  test("keyed arrays merge by key, $delete removes, new keys append", () => {
    const base = [
      { key: "displayName", required: true, label: { en: "Name" } },
      { key: "notes", required: false },
    ];
    const patch = [
      { key: "displayName", label: { en: "Full name" } },
      { key: "notes", $delete: true },
      { key: "status", required: false },
    ];
    expect(strategicMerge(base, patch)).toEqual([
      { key: "displayName", required: true, label: { en: "Full name" } },
      { key: "status", required: false },
    ]);
  });

  test("unkeyed arrays are replaced wholesale", () => {
    expect(strategicMerge(["a", "b"], ["c"])).toEqual(["c"]);
  });
});

describe("resolveAuthoringLayers", () => {
  const roots: string[] = [];

  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "openshapeforge-layers-"));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function writeYaml(root: string, relativePath: string, doc: unknown) {
    const full = join(root, relativePath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, YAML.stringify(doc), "utf8");
  }

  function configureLayers(root: string, layers: string[]) {
    writeFileSync(
      join(root, "authoring.config.yaml"),
      YAML.stringify({ layers }),
      "utf8",
    );
  }

  const baseEntity = {
    schemaVersion: 1,
    kind: "coreEntity",
    module: "core",
    entity: "Widget",
    title: "Widget",
    fields: [
      { key: "name", valueType: "string", required: true },
      { key: "notes", valueType: "string", required: false },
    ],
    ui: {
      presentations: {
        list: { columns: [{ key: "name", sortable: true }] },
      },
    },
  };

  test("single layer resolves to the layer directory itself (fast path)", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    configureLayers(root, ["base"]);
    expect(resolveAuthoringLayers(root)).toBe(join(root, "base"));
  });

  test("overlay entityPatch changes presentation of a core entity", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    writeYaml(root, "overlay/entities/core/widget.yaml", {
      kind: "entityPatch",
      ui: {
        presentations: {
          list: {
            columns: [
              { key: "name", sortable: false },
              { key: "notes", sortable: true },
            ],
          },
        },
      },
      fields: [{ key: "notes", $delete: true }],
    });
    configureLayers(root, ["base", "overlay"]);

    const resolved = resolveAuthoringLayers(root);
    expect(resolved).toBe(join(root, ".authoring-build"));
    const merged = YAML.parse(
      readFileSync(join(resolved, "entities/core/widget.yaml"), "utf8"),
    );
    expect(merged.kind).toBe("coreEntity");
    expect(merged.fields).toEqual([{ key: "name", valueType: "string", required: true }]);
    expect(merged.ui.presentations.list.columns).toEqual([
      { key: "name", sortable: false },
      { key: "notes", sortable: true },
    ]);
  });

  test("overlays can add new entities and files", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    writeYaml(root, "overlay/entities/gadgets/gadget.yaml", {
      ...baseEntity,
      entity: "Gadget",
    });
    configureLayers(root, ["base", "overlay"]);

    const resolved = resolveAuthoringLayers(root);
    expect(YAML.parse(readFileSync(join(resolved, "entities/gadgets/gadget.yaml"), "utf8")).entity).toBe(
      "Gadget",
    );
    expect(YAML.parse(readFileSync(join(resolved, "entities/core/widget.yaml"), "utf8")).entity).toBe(
      "Widget",
    );
  });

  test("catalog files merge across layers (groups extend, items merge by value)", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    writeYaml(root, "base/catalogs/core-referentiedata.yaml", {
      groepen: {
        RELATIESOORT: {
          items: [
            { value: "NAT", label: { nl: "Natuurlijk persoon", en: "Natural person" } },
            { value: "RECHT", label: { nl: "Rechtspersoon", en: "Legal entity" } },
          ],
        },
      },
    });
    writeYaml(root, "overlay/catalogs/core-referentiedata.yaml", {
      groepen: {
        RELATIESOORT: {
          items: [
            { value: "RECHT", label: { en: "Organization" } },
            { value: "GROEP", label: { nl: "Groep", en: "Group" } },
          ],
        },
        EENHEIDSOORT: {
          items: [{ value: "WON", label: { nl: "Woning", en: "Dwelling" } }],
        },
      },
    });
    configureLayers(root, ["base", "overlay"]);

    const resolved = resolveAuthoringLayers(root);
    const merged = YAML.parse(
      readFileSync(join(resolved, "catalogs/core-referentiedata.yaml"), "utf8"),
    );
    expect(merged.groepen.RELATIESOORT.items).toEqual([
      { value: "NAT", label: { nl: "Natuurlijk persoon", en: "Natural person" } },
      { value: "RECHT", label: { nl: "Rechtspersoon", en: "Organization" } },
      { value: "GROEP", label: { nl: "Groep", en: "Group" } },
    ]);
    expect(merged.groepen.EENHEIDSOORT.items).toEqual([
      { value: "WON", label: { nl: "Woning", en: "Dwelling" } },
    ]);
  });

  test("plain same-path replacement across layers is rejected", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    writeYaml(root, "overlay/entities/core/widget.yaml", { ...baseEntity, title: "Other" });
    configureLayers(root, ["base", "overlay"]);
    expect(() => resolveAuthoringLayers(root)).toThrow(/entityPatch/);
  });

  test("duplicate slug in a different folder across layers is rejected", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    writeYaml(root, "overlay/entities/other/widget.yaml", { ...baseEntity, title: "Other" });
    configureLayers(root, ["base", "overlay"]);
    expect(() => resolveAuthoringLayers(root)).toThrow(/Duplicate entity slug/);
  });

  test("patch targeting a missing entity is rejected", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    writeYaml(root, "overlay/entities/core/missing.yaml", { kind: "entityPatch", title: "X" });
    configureLayers(root, ["base", "overlay"]);
    expect(() => resolveAuthoringLayers(root)).toThrow(/no earlier layer defines/);
  });

  test("resolution is deterministic across runs", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    writeYaml(root, "overlay/entities/core/widget.yaml", {
      kind: "entityPatch",
      title: "Patched",
    });
    configureLayers(root, ["base", "overlay"]);
    const first = readFileSync(
      join(resolveAuthoringLayers(root), "entities/core/widget.yaml"),
      "utf8",
    );
    const second = readFileSync(
      join(resolveAuthoringLayers(root), "entities/core/widget.yaml"),
      "utf8",
    );
    expect(first).toBe(second);
  });
});
