// SPDX-License-Identifier: BUSL-1.1
/**
 * A node type's config fields, as a form definition the renderer can draw.
 *
 * This is an adapter and nothing else. `features/renderer` already renders a
 * `Field[]` — with visibility rules, validation, options, collections, nested
 * objects and every control the authoring schema can name — and
 * `WorkflowNodeType.configFields` is already that same `Field[]`. What was
 * missing between them is a `RendererFormDefinition` wrapper, which is all
 * this file is. There is deliberately no form engine here; writing a second
 * one is the single most expensive mistake available in this slice.
 *
 * ## One group, not a group tree
 *
 * The renderer resolves nested objects and collections itself, so flattening
 * an object field into its own group would buy layout at the cost of a second
 * account of the field tree — and the flattened keys have to be mapped back
 * through `dataPath` on every read and write. One group over the fields as
 * authored keeps the config the user edits identical to the config the node
 * stores, which is what makes the save path a pass-through.
 *
 * ## Why the definition is structural rather than imported
 *
 * `RendererFormDefinition` lives in `apps/web` and reaches its own types
 * through the `@/*` alias, which the plugin's web project does not declare —
 * see `web/tsconfig.json` for why that project exists at all. So the shape is
 * declared here and the assignment in `apps/web` is what pins the two
 * together: a definition that stops satisfying `RendererFormDefinition` fails
 * `typecheck:web` at the call site. `presentation.ts` mirrors the render
 * layer's tone union for the same reason.
 */

/** How a field is shown, when `workflowInspector` names something other than editing. */
export type WorkflowNodeConfigFieldDisplayMode = "hidden" | "display" | "readOnly";

export type WorkflowNodeConfigFieldConfig = {
  displayMode?: WorkflowNodeConfigFieldDisplayMode;
};

/**
 * The form definition, generic in the field type so the fields pass through
 * unchanged rather than being copied into a shape of this module's own.
 */
export type WorkflowNodeConfigForm<TField> = {
  schemaVersion: number;
  id: string;
  kind: "form";
  mode: "edit";
  presentation: {
    surface: "inspector";
    density: "compact";
    layout: { columns: 1 };
    chrome: {
      showTitle: false;
      showDescription: false;
      showGroupTitles: false;
      showGroupDescriptions: false;
      showActionBar: false;
    };
  };
  groups: ReadonlyArray<{ id: string; fields: readonly string[] }>;
  fields: readonly TField[];
  fieldConfig: Readonly<Record<string, WorkflowNodeConfigFieldConfig>>;
  variableSources: ReadonlyArray<{
    key: string;
    resolver: "workflowGraphVariables";
    params: { suggestions: readonly unknown[] };
  }>;
  actions: readonly never[];
};

export type BuildWorkflowNodeConfigFormInput<TField> = {
  /** Only used to make the definition id readable in the DOM. */
  nodeType: string;
  /** The catalog's `configFields` for this node type, as it served them. */
  configFields: unknown;
  /**
   * Variables the upstream nodes make available, for the fields that offer a
   * variable picker.
   *
   * Threaded through `params.suggestions` because that is the contract the
   * `workflowGraphVariables` resolver already declares: it is a protocol
   * adapter that returns whatever it is handed, so the graph walk stays with
   * whoever holds the graph. `workflowGraphVariables` on the server is a stub
   * returning `[]` for the same reason — nothing there can see a canvas.
   */
  variableSuggestions?: readonly unknown[];
  /** Escape hatch for a caller that already narrowed `configFields`. */
  fields?: readonly TField[];
};

/**
 * Null when the node type has no config to show.
 *
 * A distinct answer from an empty form: eight of the standard node types
 * declare no config fields at all, and an inspector that drew an empty
 * bordered form for them would read as "loading" or "broken" rather than as
 * "there is nothing to set here".
 */
export function buildWorkflowNodeConfigForm<TField>(
  input: BuildWorkflowNodeConfigFormInput<TField>,
): WorkflowNodeConfigForm<TField> | null {
  const fields = (input.fields ?? readFields<TField>(input.configFields)) ?? [];
  const keys = fields.map((field) => fieldKey(field)).filter(isNonEmpty);
  if (keys.length === 0) return null;

  return {
    schemaVersion: 1,
    id: `workflow-node-config-${input.nodeType}`,
    kind: "form",
    mode: "edit",
    presentation: {
      surface: "inspector",
      density: "compact",
      layout: { columns: 1 },
      chrome: {
        // The panel around this already names the node and its type, and the
        // inspector saves on change rather than on submit — a title and an
        // action bar would each say something the surface has already said or
        // cannot do.
        showTitle: false,
        showDescription: false,
        showGroupTitles: false,
        showGroupDescriptions: false,
        showActionBar: false,
      },
    },
    groups: [{ id: "workflow-node-config", fields: keys }],
    fields,
    fieldConfig: buildFieldConfig(fields),
    variableSources: [
      {
        key: "workflowGraphVariables",
        resolver: "workflowGraphVariables",
        params: { suggestions: input.variableSuggestions ?? [] },
      },
    ],
    actions: [],
  };
}

/**
 * `workflowInspector.displayMode`, per field, as the renderer's own field
 * config.
 *
 * The field contract carries this key for exactly this surface — a field an
 * author wants read-only or hidden in an inspector while it stays editable
 * elsewhere — so honouring it is reading the contract, not adding policy.
 * Recursive, because a child of an object field is addressed by its own key
 * and would otherwise ignore what its author declared.
 */
function buildFieldConfig<TField>(
  fields: readonly TField[],
): Record<string, WorkflowNodeConfigFieldConfig> {
  const config: Record<string, WorkflowNodeConfigFieldConfig> = {};

  const visit = (field: unknown): void => {
    if (!isRecord(field)) return;
    const key = fieldKey(field);
    const displayMode = inspectorDisplayMode(field);
    if (key && displayMode) config[key] = { displayMode };
    for (const child of asArray(field.children)) visit(child);
    if (field.item !== undefined) visit(field.item);
  };

  for (const field of fields) visit(field);
  return config;
}

function inspectorDisplayMode(
  field: Record<string, unknown>,
): WorkflowNodeConfigFieldDisplayMode | undefined {
  const inspector = isRecord(field.workflowInspector) ? field.workflowInspector : null;
  const mode = inspector?.displayMode;
  return mode === "hidden" || mode === "display" || mode === "readOnly"
    ? mode
    : undefined;
}

/**
 * The field list off a JSON column, without asserting anything about the
 * entries beyond their being objects.
 *
 * `configFields` is served as `JSON!` and shaped by whatever authoring YAML
 * declared it, so a non-array or a non-object entry is a real possibility and
 * neither is worth throwing over — a node whose fields cannot be read still
 * has to be selectable on the canvas.
 */
function readFields<TField>(configFields: unknown): readonly TField[] {
  if (!Array.isArray(configFields)) return [];
  return configFields.filter((entry) => isRecord(entry)) as readonly TField[];
}

function fieldKey(field: unknown): string {
  if (!isRecord(field)) return "";
  return typeof field.key === "string" ? field.key.trim() : "";
}

function isNonEmpty(value: string): boolean {
  return value.length > 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
