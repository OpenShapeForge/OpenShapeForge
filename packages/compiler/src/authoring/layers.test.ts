// SPDX-License-Identifier: BUSL-1.1
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import {
  authoringLayerDirs,
  loadAuthoringConfig,
  resolveAuthoringLayers,
  strategicMerge,
} from "./layers.js";

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

  test("view groups merge by localized title, so a patch restates one group and keeps its siblings", () => {
    const base = [
      { title: { en: "Membership", nl: "Lidmaatschap" }, fields: ["relationId", "status"] },
      { title: { en: "Source", nl: "Herkomst" }, fields: ["externalCode"] },
    ];
    const patch = [
      // The authoring-language text alone identifies the group; the Dutch
      // title survives from the base.
      { title: { en: "Membership" }, fields: ["relationId", "role", "status"] },
      { title: { en: "Source" }, $delete: true },
      { title: { en: "Period", nl: "Periode" }, fields: ["startDate", "endDate"] },
    ];
    expect(strategicMerge(base, patch)).toEqual([
      { title: { en: "Membership", nl: "Lidmaatschap" }, fields: ["relationId", "role", "status"] },
      { title: { en: "Period", nl: "Periode" }, fields: ["startDate", "endDate"] },
    ]);
  });

  test("a patch item without the array's merge key is refused", () => {
    expect(() =>
      strategicMerge([{ title: { en: "Basics" }, fields: ["name"] }], [{ fields: ["notes"] }]),
    ).toThrow(/must carry a "title"/);
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

  const securedEntity = {
    ...baseEntity,
    schemaVersion: 2,
    authorization: {
      roles: {
        read: ["Widgets.Read", "Widgets.Manage"],
        create: ["Widgets.Create", "Widgets.Manage"],
        update: ["Widgets.Edit", "Widgets.Manage"],
        delete: ["Widgets.Delete", "Widgets.Manage"],
      },
      rowAccess: {
        enabled: true,
        empty: "restricted",
        owner: { column: "owner_id", session: "app.current_user_id" },
        group: { column: "group_id", expand: "exact" },
        recordPermissions: {
          field: "authorization",
          empty: "restricted",
          createRequires: ["view"],
        },
      },
    },
    fields: [
      ...baseEntity.fields,
      {
        key: "authorization",
        valueType: "object",
        required: true,
        immutable: true,
        writtenBy: ["widget.approve", "widget.publish"],
        defaultValue: {
          view: { users: [], groups: [], roles: [] },
          edit: { users: [], groups: [], roles: [] },
          delete: { users: [], groups: [], roles: [] },
        },
        authorization: { roles: { read: ["Widgets.Read", "Widgets.Manage"] } },
      },
    ],
    workerAccess: "widget-worker",
    operations: {
      approve: {
        name: "Approve",
        description: "Approve a widget",
        implementation: { type: "plugin", plugin: "widgets", handler: "approve" },
        target: { scope: "record", inputField: "widgetId" },
        input: { schema: { type: "object", properties: { widgetId: { type: "string" } } } },
        output: { schema: { type: "object" } },
        errors: [],
        auth: {
          mode: "session",
          roles: ["Widgets.Approve", "Widgets.Manage"],
          scopes: ["widgets:write"],
          recordPermission: "edit",
        },
        tenancy: { mode: "required" },
        effects: { data: "write", external: "none" },
        reliability: { idempotency: { mode: "keyed", inputField: "requestKey" } },
        concurrency: {
          version: { mode: "required", field: "updatedAt" },
          editLease: { mode: "required", expiresAfterInactivity: "PT5M" },
        },
        confirmation: { mode: "acknowledgement" },
        prerequisites: [
          { operation: "widgets.review", receipt: { binding: "loginSession" } },
        ],
        interaction: {
          type: "secureInput",
          sourceField: "questions",
          sourceEntity: "Widget",
          definitionsField: "definitions",
          into: "answers",
        },
      },
    },
    interfaces: {
      rest: { operations: { approve: false } },
      mcp: { operations: { approve: {} } },
      web: { views: {}, operations: { approve: {} } },
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

  test("entity patches may narrow generated CRUD operations", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    writeYaml(root, "overlay/entities/core/widget.yaml", {
      kind: "entityPatch",
      crud: { operations: { create: false, update: false, delete: false } },
    });
    configureLayers(root, ["base", "overlay"]);

    const resolved = resolveAuthoringLayers(root);
    const merged = YAML.parse(
      readFileSync(join(resolved, "entities/core/widget.yaml"), "utf8"),
    );
    expect(merged.crud.operations).toEqual({ create: false, update: false, delete: false });
  });

  test("later entity patches cannot widen an earlier CRUD restriction", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", {
      ...baseEntity,
      crud: { operations: { update: false, delete: false } },
    });
    writeYaml(root, "overlay/entities/core/widget.yaml", {
      kind: "entityPatch",
      crud: { operations: { update: true } },
    });
    configureLayers(root, ["base", "overlay"]);

    expect(() => resolveAuthoringLayers(root)).toThrow(
      /widens crud\.operations \(update\).*may only narrow/,
    );
  });

  test("removing a CRUD restriction from a later layer is rejected", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", {
      ...baseEntity,
      crud: false,
    });
    writeYaml(root, "overlay/entities/core/widget.yaml", {
      kind: "entityPatch",
      crud: null,
    });
    configureLayers(root, ["base", "overlay"]);

    expect(() => resolveAuthoringLayers(root)).toThrow(/widens crud\.operations/);
  });

  test("entity patches may narrow OR roles and add AND requirements", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", securedEntity);
    writeYaml(root, "overlay/entities/core/widget.yaml", {
      kind: "entityPatch",
      authorization: {
        roles: { read: ["Widgets.Read"] },
        rowAccess: {
          recordPermissions: { createRequires: ["view", "edit"] },
        },
      },
      operations: {
        approve: {
          auth: { roles: ["Widgets.Approve"], scopes: ["widgets:write", "widgets:approve"] },
          prerequisites: [
            { operation: "widgets.review", receipt: { binding: "loginSession" } },
            { operation: "widgets.train", receipt: { binding: "loginSession" } },
          ],
          confirmation: { mode: "challenge", challenge: { kind: "type-current-field" } },
        },
      },
    });
    configureLayers(root, ["base", "overlay"]);

    const resolved = resolveAuthoringLayers(root);
    const merged = YAML.parse(readFileSync(join(resolved, "entities/core/widget.yaml"), "utf8"));
    expect(merged.authorization.roles.read).toEqual(["Widgets.Read"]);
    expect(merged.operations.approve.auth.scopes).toEqual(["widgets:write", "widgets:approve"]);
    expect(merged.operations.approve.confirmation.mode).toBe("challenge");
  });

  test("entity patches cannot add an OR role or remove an AND scope", () => {
    for (const [name, patch, error] of [
      [
        "role",
        { authorization: { roles: { read: ["Widgets.Read", "Widgets.Manage", "Widgets.Admin"] } } },
        /widens authorization\.roles\.read/,
      ],
      [
        "scope",
        { operations: { approve: { auth: { scopes: [] } } } },
        /widens operations\.approve\.auth\.scopes/,
      ],
    ] as const) {
      const root = makeRepo();
      writeYaml(root, "base/entities/core/widget.yaml", securedEntity);
      writeYaml(root, "overlay/entities/core/widget.yaml", { kind: "entityPatch", ...patch });
      configureLayers(root, ["base", "overlay"]);
      expect(() => resolveAuthoringLayers(root), name).toThrow(error);
    }
  });

  test("entity patches cannot remove or rewrite owner operation controls", () => {
    for (const [patch, error] of [
      [{ operations: { approve: { confirmation: { mode: "none" } } } }, /weakens operations\.approve\.confirmation/],
      [{ operations: { approve: { concurrency: null } } }, /changes operations\.approve\.concurrency\.version/],
      [{ operations: { approve: { input: { schema: { properties: null } } } } }, /changes operations\.approve\.input/],
      [{ operations: { approve: { interaction: null } } }, /changes operations\.approve\.interaction/],
      [{ operations: { approve: { prerequisites: [] } } }, /widens operations\.approve\.prerequisites/],
      [{ operations: { approve: { auth: { mode: "public" } } } }, /widens operations\.approve\.auth/],
      [{ operations: { approve: null } }, /removes operations\.approve/],
    ] as const) {
      const root = makeRepo();
      writeYaml(root, "base/entities/core/widget.yaml", securedEntity);
      writeYaml(root, "overlay/entities/core/widget.yaml", { kind: "entityPatch", ...patch });
      configureLayers(root, ["base", "overlay"]);
      expect(() => resolveAuthoringLayers(root)).toThrow(error);
    }
  });

  test("entity patches cannot broaden row access or record ACL defaults", () => {
    for (const [patch, error] of [
      [
        { authorization: { rowAccess: { owner: null, group: null } } },
        /widens authorization\.rowAccess owner\/group OR branches/,
      ],
      [
        { authorization: { rowAccess: { recordPermissions: { empty: "public" } } } },
        /recordPermissions\.empty from restricted to public/,
      ],
      [
        { authorization: { rowAccess: { recordPermissions: null } } },
        /removes authorization\.rowAccess\.recordPermissions/,
      ],
      [
        { fields: [{ key: "authorization", defaultValue: { view: { roles: ["Public"] } } }] },
        /fields\.authorization\.defaultValue/,
      ],
    ] as const) {
      const root = makeRepo();
      writeYaml(root, "base/entities/core/widget.yaml", securedEntity);
      writeYaml(root, "overlay/entities/core/widget.yaml", { kind: "entityPatch", ...patch });
      configureLayers(root, ["base", "overlay"]);
      expect(() => resolveAuthoringLayers(root)).toThrow(error);
    }
  });

  test("entity patches cannot revive interfaces or widen worker and field write controls", () => {
    for (const [patch, error] of [
      [
        { interfaces: { rest: { operations: { approve: {} } } } },
        /re-enables interfaces\.rest\.operations\.approve/,
      ],
      [
        { interfaces: { graphql: { operations: { approve: {} } } } },
        /re-enables interfaces\.graphql\.operations\.approve/,
      ],
      [{ workerAccess: "other-worker" }, /changes workerAccess/],
      [{ fields: [{ key: "authorization", immutable: false }] }, /removes fields\.authorization\.immutable/],
      [
        { fields: [{ key: "authorization", writtenBy: ["widget.approve", "widget.publish", "widget.edit"] }] },
        /widens fields\.authorization\.writtenBy/,
      ],
    ] as const) {
      const root = makeRepo();
      writeYaml(root, "base/entities/core/widget.yaml", securedEntity);
      writeYaml(root, "overlay/entities/core/widget.yaml", { kind: "entityPatch", ...patch });
      configureLayers(root, ["base", "overlay"]);
      expect(() => resolveAuthoringLayers(root)).toThrow(error);
    }
  });

  test("entity patches may add a new plugin operation without changing owner operations", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", securedEntity);
    writeYaml(root, "overlay/entities/core/widget.yaml", {
      kind: "entityPatch",
      operations: {
        publish: {
          name: "Publish",
          description: "Publish a widget",
          implementation: { type: "plugin", plugin: "widgets", handler: "publish" },
          input: { schema: { type: "object" } },
          output: { schema: { type: "object" } },
          errors: [],
          auth: { mode: "session", roles: ["Widgets.Publish"] },
          tenancy: { mode: "required" },
          effects: { data: "write", external: "none" },
          reliability: { idempotency: { mode: "natural" } },
          confirmation: { mode: "acknowledgement" },
        },
      },
    });
    configureLayers(root, ["base", "overlay"]);

    const resolved = resolveAuthoringLayers(root);
    const merged = YAML.parse(readFileSync(join(resolved, "entities/core/widget.yaml"), "utf8"));
    expect(Object.keys(merged.operations)).toEqual(["approve", "publish"]);
  });

  test("entity patches cannot enable legacy interface or worker capability exposure", () => {
    for (const [base, patch, error] of [
      [{ ...baseEntity, rest: false }, { rest: true }, /widens rest exposure/],
      [{ ...baseEntity, mcp: { enabled: false } }, { mcp: true }, /widens mcp exposure/],
      [baseEntity, { workerAccess: "widget-worker" }, /enables workerAccess/],
    ] as const) {
      const root = makeRepo();
      writeYaml(root, "base/entities/core/widget.yaml", base);
      writeYaml(root, "overlay/entities/core/widget.yaml", { kind: "entityPatch", ...patch });
      configureLayers(root, ["base", "overlay"]);
      expect(() => resolveAuthoringLayers(root)).toThrow(error);
    }
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

  test("the same entity under a different slug across layers is rejected at resolution, naming the stem to patch", () => {
    const root = makeRepo();
    writeYaml(root, "base/entities/core/widget.yaml", baseEntity);
    writeYaml(root, "overlay/entities/other/widget-v2.yaml", { ...baseEntity, title: "Other" });
    configureLayers(root, ["base", "overlay"]);
    expect(() => resolveAuthoringLayers(root)).toThrow(
      /Duplicate entity "Widget" across layers \(entities\/core\/widget\.yaml vs entities\/other\/widget-v2\.yaml\)\. Use kind: entityPatch \(file stem "widget"\)/,
    );
  });

  test("an entity patch refines one view group by title without restating the others", () => {
    const root = makeRepo();
    const groups = (items: unknown[]) => ({
      interfaces: {
        web: { views: { record: { layout: { tabs: [{ id: "overview", groups: items }] } } } },
      },
    });
    writeYaml(root, "base/entities/core/widget.yaml", {
      ...baseEntity,
      ...groups([
        { title: { en: "Basics", nl: "Basis" }, fields: ["name"] },
        { title: { en: "Notes", nl: "Notities" }, fields: ["notes"] },
      ]),
    });
    writeYaml(root, "overlay/entities/core/widget.yaml", {
      kind: "entityPatch",
      ...groups([{ title: { en: "Basics" }, fields: ["name", "status"] }]),
    });
    configureLayers(root, ["base", "overlay"]);

    const resolved = resolveAuthoringLayers(root);
    const merged = YAML.parse(readFileSync(join(resolved, "entities/core/widget.yaml"), "utf8"));
    expect(merged.interfaces.web.views.record.layout.tabs[0].groups).toEqual([
      { title: { en: "Basics", nl: "Basis" }, fields: ["name", "status"] },
      { title: { en: "Notes", nl: "Notities" }, fields: ["notes"] },
    ]);
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
 * entry in it. Before this existed the only way in was to ship `menu.yaml`
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
    return YAML.parse(readFileSync(join(resolved, "menu.yaml"), "utf8")) as {
      kind: string;
      navigation: { sidebarItems: { key: string; route?: unknown }[] };
    };
  }

  test("normalizes a legacy appShell.yaml and retains an older-host read alias", () => {
    const root = makeRepo();
    writeYaml(root, "base/appShell.yaml", baseShell);
    configureLayers(root, ["base"]);

    const resolved = resolveAuthoringLayers(root);

    expect(readShell(resolved).navigation.sidebarItems[0]!.key).toBe("data");
    expect(readFileSync(join(resolved, "appShell.yaml"), "utf8"))
      .toBe(readFileSync(join(resolved, "menu.yaml"), "utf8"));
  });

  test("applies a current app shell patch to a legacy appShell.yaml base", () => {
    const root = makeRepo();
    writeYaml(root, "base/appShell.yaml", baseShell);
    writeYaml(root, "plugin/menu.yaml", {
      kind: "appShellPatch",
      navigation: { sidebarItems: [{ key: "workflow", route: { en: "/workflow" } }] },
    });
    configureLayers(root, ["base", "plugin"]);

    expect(readShell(resolveAuthoringLayers(root)).navigation.sidebarItems.map((item) => item.key))
      .toEqual(["data", "workflow"]);
  });

  test("a patch appends a nav entry and leaves the base entries intact", () => {
    const root = makeRepo();
    writeYaml(root, "base/menu.yaml", baseShell);
    writeYaml(root, "plugin/menu.yaml", {
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
    writeYaml(root, "base/menu.yaml", baseShell);
    writeYaml(root, "first/menu.yaml", {
      kind: "appShellPatch",
      navigation: { sidebarItems: [{ key: "workflow", route: { en: "/workflow" } }] },
    });
    writeYaml(root, "second/menu.yaml", {
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
    writeYaml(root, "base/menu.yaml", baseShell);
    writeYaml(root, "overlay/menu.yaml", {
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
    writeYaml(root, "plugin/menu.yaml", {
      kind: "appShellPatch",
      navigation: { sidebarItems: [{ key: "workflow" }] },
    });
    configureLayers(root, ["base", "plugin"]);

    // Failing loudly matters more here than elsewhere: a silently ignored patch
    // produces a working build with an unreachable screen.
    expect(() => resolveAuthoringLayers(root)).toThrow(/no earlier layer defines an app shell/);
  });

  test("shipping a plain menu.yaml over an earlier one is still rejected, and says how to patch", () => {
    const root = makeRepo();
    writeYaml(root, "base/menu.yaml", baseShell);
    writeYaml(root, "plugin/menu.yaml", { ...baseShell, shell: { title: "Hijacked" } });
    configureLayers(root, ["base", "plugin"]);
    expect(() => resolveAuthoringLayers(root)).toThrow(/appShellPatch/);
  });

  test("merging is deterministic across runs", () => {
    const root = makeRepo();
    writeYaml(root, "base/menu.yaml", baseShell);
    writeYaml(root, "plugin/menu.yaml", {
      kind: "appShellPatch",
      navigation: { sidebarItems: [{ key: "workflow", route: { en: "/workflow" } }] },
    });
    configureLayers(root, ["base", "plugin"]);
    const first = readFileSync(join(resolveAuthoringLayers(root), "menu.yaml"), "utf8");
    const second = readFileSync(join(resolveAuthoringLayers(root), "menu.yaml"), "utf8");
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

  test("a packages/compiler layer missing from the host root resolves to the packaged copy", () => {
    const root = makeRepo();
    writeConfig(root, { layers: ["packages/compiler/config/authoring"] });
    expect(authoringLayerDirs(root)).toEqual([
      resolve(import.meta.dir, "../../config/authoring"),
    ]);
  });

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

/**
 * The contract an out-of-tree extension builds against. A sector standard ships
 * as its own repository — this one must never declare it — so the deployment
 * appends it here and the committed config stays free of the extension's name.
 */
describe("authoring.config.local.yaml", () => {
  const roots: string[] = [];

  function makeRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "openshapeforge-localcfg-"));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function writeConfig(root: string, config: unknown, local?: unknown) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "authoring.config.yaml"), YAML.stringify(config), "utf8");
    if (local !== undefined) {
      writeFileSync(join(root, "authoring.config.local.yaml"), YAML.stringify(local), "utf8");
    }
  }

  test("appends its layers after the committed ones, so the extension patches last", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    mkdirSync(join(root, "ext"), { recursive: true });
    writeConfig(root, { layers: ["base"] }, { layers: ["ext"] });

    expect(loadAuthoringConfig(root).layers).toEqual(["base", "ext"]);
    expect(authoringLayerDirs(root)).toEqual([join(root, "base"), join(root, "ext")]);
  });

  test("an absolute path outside the repo is a valid layer", () => {
    // The whole point: the extension is not in this tree and never will be.
    const root = makeRepo();
    const outside = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writeConfig(root, { layers: ["base"] }, { layers: [outside] });

    expect(authoringLayerDirs(root)).toEqual([join(root, "base"), outside]);
  });

  test("appends plugins too", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writeConfig(
      root,
      { layers: ["base"], plugins: ["./plugins/core.ts"] },
      { plugins: ["./plugins/ext.ts"] },
    );

    expect(loadAuthoringConfig(root).plugins).toEqual(["./plugins/core.ts", "./plugins/ext.ts"]);
  });

  test("absent file changes nothing", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writeConfig(root, { layers: ["base"], plugins: ["./p.ts"] });

    expect(loadAuthoringConfig(root)).toEqual({ layers: ["base"], plugins: ["./p.ts"] });
  });

  test("loads committed REST API onboarding and trims its authored strings", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writeConfig(root, {
      layers: ["base"],
      restApi: {
        title: " Example Product API ",
        version: " 2026-09 ",
        description: " Start with authentication. ",
        bearerDescription: " Paste an API access token. ",
        oauth2: {
          description: " Sign in through the host identity provider. ",
          authorizationUrl: "https://identity.example.com/oauth/authorize",
          tokenUrl: "https://identity.example.com/oauth/token",
          clientId: " public-docs-client ",
          scopes: {
            profile: " Read profile claims ",
            openid: " Sign in ",
          },
          redirectUrl: "https://api.example.com/api/rest/docs/oauth2-redirect.html",
        },
        externalDocs: {
          description: " Developer guide ",
          url: "https://example.com/developers",
        },
      },
    });

    expect(loadAuthoringConfig(root).restApi).toEqual({
      title: "Example Product API",
      version: "2026-09",
      description: "Start with authentication.",
      bearerDescription: "Paste an API access token.",
      oauth2: {
        description: "Sign in through the host identity provider.",
        authorizationUrl: "https://identity.example.com/oauth/authorize",
        tokenUrl: "https://identity.example.com/oauth/token",
        clientId: "public-docs-client",
        scopes: {
          openid: "Sign in",
          profile: "Read profile claims",
        },
        redirectUrl: "https://api.example.com/api/rest/docs/oauth2-redirect.html",
      },
      externalDocs: {
        description: "Developer guide",
        url: "https://example.com/developers",
      },
    });
  });

  test("loads only primitive committed settings and rejects local settings", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writeConfig(root, {
      layers: ["base"],
      settings: {
        "storage.artifacts.enabled": false,
        "storage.artifacts.maximumBytes": 1_000_000,
        "storage.artifacts.allowedMediaTypes": ["application/pdf"],
        "storage.artifacts.provider": "filesystem",
      },
    });
    expect(loadAuthoringConfig(root).settings).toEqual({
      "storage.artifacts.enabled": false,
      "storage.artifacts.maximumBytes": 1_000_000,
      "storage.artifacts.allowedMediaTypes": ["application/pdf"],
      "storage.artifacts.provider": "filesystem",
    });

    writeConfig(
      root,
      { layers: ["base"] },
      { settings: { "storage.artifacts.enabled": true } },
    );
    expect(() => loadAuthoringConfig(root)).toThrow(/cannot declare "settings"/);

    writeConfig(root, {
      layers: ["base"],
      settings: { "storage.artifacts.provider": { secret: "not allowed" } },
    });
    expect(() => loadAuthoringConfig(root)).toThrow(/boolean, number, string, or string array/);
  });

  test("rejects malformed, unknown, or machine-local REST API onboarding", () => {
    const malformed = makeRepo();
    mkdirSync(join(malformed, "base"), { recursive: true });
    writeConfig(malformed, {
      layers: ["base"],
      restApi: { title: "", description: "Guide" },
    });
    expect(() => loadAuthoringConfig(malformed)).toThrow(/restApi\.title.*non-empty string/);

    const invalidUrl = makeRepo();
    mkdirSync(join(invalidUrl, "base"), { recursive: true });
    writeConfig(invalidUrl, {
      layers: ["base"],
      restApi: { title: "API", description: "Guide", externalDocs: { url: "file:///guide" } },
    });
    expect(() => loadAuthoringConfig(invalidUrl)).toThrow(/externalDocs\.url.*absolute HTTP/);

    const unknown = makeRepo();
    mkdirSync(join(unknown, "base"), { recursive: true });
    writeConfig(unknown, {
      layers: ["base"],
      restApi: { title: "API", description: "Guide", owner: "unknown" },
    });
    expect(() => loadAuthoringConfig(unknown)).toThrow(/restApi.*unknown field.*owner/);

    const secret = makeRepo();
    mkdirSync(join(secret, "base"), { recursive: true });
    writeConfig(secret, {
      layers: ["base"],
      restApi: {
        title: "API",
        description: "Guide",
        oauth2: {
          description: "Sign in",
          authorizationUrl: "https://identity.example.com/authorize",
          tokenUrl: "https://identity.example.com/token",
          clientId: "public-docs-client",
          clientSecret: "must-not-be-authored",
          scopes: { openid: "Sign in" },
        },
      },
    });
    expect(() => loadAuthoringConfig(secret)).toThrow(/oauth2.*unknown field.*clientSecret/);

    const invalidOauth = makeRepo();
    mkdirSync(join(invalidOauth, "base"), { recursive: true });
    writeConfig(invalidOauth, {
      layers: ["base"],
      restApi: {
        title: "API",
        description: "Guide",
        oauth2: {
          description: "Sign in",
          authorizationUrl: "/authorize",
          tokenUrl: "https://identity.example.com/token",
          clientId: "public-docs-client",
          scopes: { openid: "Sign in" },
        },
      },
    });
    expect(() => loadAuthoringConfig(invalidOauth)).toThrow(
      /oauth2\.authorizationUrl.*absolute HTTP/,
    );

    const emptyScopes = makeRepo();
    mkdirSync(join(emptyScopes, "base"), { recursive: true });
    writeConfig(emptyScopes, {
      layers: ["base"],
      restApi: {
        title: "API",
        description: "Guide",
        oauth2: {
          description: "Sign in",
          authorizationUrl: "https://identity.example.com/authorize",
          tokenUrl: "https://identity.example.com/token",
          clientId: "public-docs-client",
          scopes: {},
        },
      },
    });
    expect(() => loadAuthoringConfig(emptyScopes)).toThrow(
      /oauth2\.scopes.*at least one scope/,
    );

    const credentialUrl = makeRepo();
    mkdirSync(join(credentialUrl, "base"), { recursive: true });
    writeConfig(credentialUrl, {
      layers: ["base"],
      restApi: {
        title: "API",
        description: "Guide",
        oauth2: {
          description: "Sign in",
          authorizationUrl: "https://user:password@identity.example.com/authorize",
          tokenUrl: "https://identity.example.com/token",
          clientId: "public-docs-client",
          scopes: { openid: "Sign in" },
        },
      },
    });
    expect(() => loadAuthoringConfig(credentialUrl)).toThrow(
      /oauth2\.authorizationUrl.*must not contain credentials/,
    );

    const local = makeRepo();
    mkdirSync(join(local, "base"), { recursive: true });
    writeConfig(
      local,
      { layers: ["base"] },
      { restApi: { title: "Local", description: "Not committed" } },
    );
    expect(() => loadAuthoringConfig(local)).toThrow(/cannot declare "restApi"/);
  });

  test("cannot remove or reorder a committed layer — only append", () => {
    // Re-declaring a committed layer would move it to the end and silently
    // change which layer patches which, so it is refused rather than merged.
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writeConfig(root, { layers: ["base", "overlay"] }, { layers: ["base"] });

    expect(() => loadAuthoringConfig(root)).toThrow(/re-declares the layer "base"/);
  });

  test("rejects a malformed local file rather than ignoring it", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writeConfig(root, { layers: ["base"] }, { layers: "ext" });

    expect(() => loadAuthoringConfig(root)).toThrow(
      /authoring\.config\.local\.yaml "layers" must be a string array/,
    );
  });

  test("a local file with no layers of its own is allowed", () => {
    const root = makeRepo();
    mkdirSync(join(root, "base"), { recursive: true });
    writeConfig(root, { layers: ["base"] }, { plugins: ["./ext.ts"] });

    expect(loadAuthoringConfig(root)).toEqual({ layers: ["base"], plugins: ["./ext.ts"] });
  });
});

test("a later Dutch override preserves English across entity, operation and nested schema metadata", () => {
  const base = { label: { en: "Customer", nl: "Klant" }, operations: { compose: { name: { en: "Compose", nl: "Samenstellen" }, input: { schema: { properties: { name: { "x-osf-i18n": { title: { en: "Name", nl: "Naam" } } } } } } } } };
  const plugin = { operations: { compose: { input: { schema: { properties: { name: { "x-osf-i18n": { title: { nl: "Offertenaam" } } } } } } } } };
  const host = { label: { nl: "Opdrachtgever" } };
  const result = strategicMerge(strategicMerge(base, plugin), host) as typeof base;
  expect(result.label).toEqual({ en: "Customer", nl: "Opdrachtgever" });
  expect(result.operations.compose.name).toEqual(base.operations.compose.name);
  expect(result.operations.compose.input.schema.properties.name["x-osf-i18n"].title).toEqual({ en: "Name", nl: "Offertenaam" });
});
