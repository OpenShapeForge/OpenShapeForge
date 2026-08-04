// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { authoringLayerDirs, resolveAuthoringLayers, strategicMerge } from "./layers.js";

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

// ---------------------------------------------------------------------------
// appShellPatch
// ---------------------------------------------------------------------------

/**
 * The app shell is the one authored document a plugin has to reach without
 * owning: it holds the sidebar, and a plugin that ships a screen needs one
 * entry in it. Before this existed the only way in was to ship `appShell.yaml`
 * itself, which collides — so a plugin could emit a route file and have nothing
 * link to it.
 *
 * Targeted by path rather than by slug. There is exactly one app shell, so the
 * slug indirection `entityPatch` needs would be a lookup with one possible
 * answer.
 */
describe("resolveAuthoringLayers — appShellPatch", () => {
  const roots: string[] = [];

  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "openshapeforge-shell-"));
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
    writeFileSync(join(root, "authoring.config.yaml"), YAML.stringify({ layers }), "utf8");
  }

  const baseShell = {
    schemaVersion: 1,
    kind: "appShell",
    shell: { component: "AppLayout", title: "OpenShapeForge" },
    navigation: {
      component: "SidebarNav",
      sidebarItems: [
        {
          key: "data",
          label: { en: "Data", nl: "Data" },
          children: [{ key: "relations", label: { en: "Relations" }, entity: "relation" }],
        },
      ],
    },
  };

  function readShell(resolved: string) {
    return YAML.parse(readFileSync(join(resolved, "appShell.yaml"), "utf8")) as {
      kind: string;
      navigation: { sidebarItems: { key: string; route?: unknown }[] };
    };
  }

  test("a patch appends a nav entry and leaves the base entries intact", () => {
    const root = makeRepo();
    writeYaml(root, "base/appShell.yaml", baseShell);
    writeYaml(root, "plugin/appShell.yaml", {
      kind: "appShellPatch",
      navigation: {
        sidebarItems: [
          { key: "workflow", label: { en: "Workflows" }, icon: "Workflow", route: { en: "/workflow" } },
        ],
      },
    });
    configureLayers(root, ["base", "plugin"]);

    const merged = readShell(resolveAuthoringLayers(root));

    // The merged document is an appShell, not an appShellPatch: the loader
    // reads it by kind, so a patch envelope surviving the merge would make the
    // shell unreadable.
    expect(merged.kind).toBe("appShell");
    expect(merged.navigation.sidebarItems.map((item) => item.key)).toEqual([
      "data",
      "workflow",
    ]);
    expect(merged.navigation.sidebarItems[1]!.route).toEqual({ en: "/workflow" });
  });

  test("two plugins each append, in layer order", () => {
    const root = makeRepo();
    writeYaml(root, "base/appShell.yaml", baseShell);
    writeYaml(root, "first/appShell.yaml", {
      kind: "appShellPatch",
      navigation: { sidebarItems: [{ key: "workflow", route: { en: "/workflow" } }] },
    });
    writeYaml(root, "second/appShell.yaml", {
      kind: "appShellPatch",
      navigation: { sidebarItems: [{ key: "reports", route: { en: "/reports" } }] },
    });
    configureLayers(root, ["base", "first", "second"]);

    // Chaining is the property under test: the first patch has to become the
    // base the second one merges into, or the second silently drops the first.
    expect(readShell(resolveAuthoringLayers(root)).navigation.sidebarItems.map((i) => i.key))
      .toEqual(["data", "workflow", "reports"]);
  });

  test("a patch can amend an entry an earlier layer contributed", () => {
    const root = makeRepo();
    writeYaml(root, "base/appShell.yaml", baseShell);
    writeYaml(root, "overlay/appShell.yaml", {
      kind: "appShellPatch",
      navigation: { sidebarItems: [{ key: "data", label: { en: "Records" } }] },
    });
    configureLayers(root, ["base", "overlay"]);

    const items = readShell(resolveAuthoringLayers(root)).navigation.sidebarItems as {
      key: string;
      label: { en: string };
      children?: unknown[];
    }[];
    expect(items).toHaveLength(1);
    expect(items[0]!.label.en).toBe("Records");
    // Keyed-array merge, not replacement: the children the base declared stay.
    expect(items[0]!.children).toHaveLength(1);
  });

  test("a patch with no app shell in an earlier layer is rejected", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", { schemaVersion: 1, kind: "coreEntity" });
    writeYaml(root, "plugin/appShell.yaml", {
      kind: "appShellPatch",
      navigation: { sidebarItems: [{ key: "workflow" }] },
    });
    configureLayers(root, ["base", "plugin"]);

    // Failing loudly matters more here than elsewhere: a silently ignored patch
    // produces a working build with an unreachable screen.
    expect(() => resolveAuthoringLayers(root)).toThrow(/no earlier layer defines an app shell/);
  });

  test("shipping a plain appShell.yaml over an earlier one is still rejected, and says how to patch", () => {
    const root = makeRepo();
    writeYaml(root, "base/appShell.yaml", baseShell);
    writeYaml(root, "plugin/appShell.yaml", { ...baseShell, shell: { title: "Hijacked" } });
    configureLayers(root, ["base", "plugin"]);
    expect(() => resolveAuthoringLayers(root)).toThrow(/appShellPatch/);
  });

  test("merging is deterministic across runs", () => {
    const root = makeRepo();
    writeYaml(root, "base/appShell.yaml", baseShell);
    writeYaml(root, "plugin/appShell.yaml", {
      kind: "appShellPatch",
      navigation: { sidebarItems: [{ key: "workflow", route: { en: "/workflow" } }] },
    });
    configureLayers(root, ["base", "plugin"]);
    const first = readFileSync(join(resolveAuthoringLayers(root), "appShell.yaml"), "utf8");
    const second = readFileSync(join(resolveAuthoringLayers(root), "appShell.yaml"), "utf8");
    expect(first).toBe(second);
  });
});

/**
 * The scan roots `check:authoring-schemas` walks. The gate named one directory
 * literally, so plugin-shipped authoring was validated by nothing (#237);
 * pinning the source list here is what keeps the gate's idea of "this
 * repository's authoring" equal to the compiler's.
 */
describe("authoringLayerDirs", () => {
  const roots: string[] = [];

  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "openshapeforge-layer-dirs-"));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function writeConfig(root: string, config: { layers: string[]; plugins?: string[] }) {
    writeFileSync(join(root, "authoring.config.yaml"), YAML.stringify(config), "utf8");
  }

  function writePlugin(root: string, dir: string, options: { authoring: boolean }) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "index.ts"), "export default {};\n", "utf8");
    if (options.authoring) mkdirSync(join(root, dir, "authoring"), { recursive: true });
  }

  test("returns the configured layers followed by each plugin's authoring directory", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    mkdirSync(join(root, "overlay"), { recursive: true });
    writePlugin(root, "plugins/alpha", { authoring: true });
    writePlugin(root, "plugins/beta", { authoring: true });
    writeConfig(root, {
      layers: ["base", "overlay"],
      plugins: ["./plugins/alpha/index.ts", "./plugins/beta/index.ts"],
    });

    // Order is the contract: layers apply in sequence, and a later one patches
    // an earlier one.
    expect(authoringLayerDirs(root)).toEqual([
      join(root, "base"),
      join(root, "overlay"),
      join(root, "plugins/alpha/authoring"),
      join(root, "plugins/beta/authoring"),
    ]);
  });

  test("omits a plugin that ships no authoring directory", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writePlugin(root, "plugins/codeonly", { authoring: false });
    writePlugin(root, "plugins/withlayer", { authoring: true });
    writeConfig(root, {
      layers: ["base"],
      plugins: ["./plugins/codeonly/index.ts", "./plugins/withlayer/index.ts"],
    });

    expect(authoringLayerDirs(root)).toEqual([
      join(root, "base"),
      join(root, "plugins/withlayer/authoring"),
    ]);
  });

  test("agrees with resolveAuthoringLayers on the single-layer fast path", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writeConfig(root, { layers: ["base"] });

    const dirs = authoringLayerDirs(root);
    expect(dirs).toEqual([join(root, "base")]);
    expect(resolveAuthoringLayers(root)).toBe(dirs[0]!);
  });
});
