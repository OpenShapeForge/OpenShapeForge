// SPDX-License-Identifier: BUSL-1.1
/**
 * RendererFormDefinition — the core type that drives all form rendering.
 *
 * A RendererFormDefinition is a self-contained, JSON-serializable schema that
 * describes an entire form: its fields, groups, display mode, presentation
 * options, submission behavior, and available actions.
 *
 * It is produced either directly from hand-written definitions or emitted
 * directly by compiler-backed authoring flows. Every renderer component, hook,
 * and utility ultimately reads from this type.
 *
 * Key types exported: RendererFormDefinition, RendererFormField,
 * RendererFormGroup, RendererFieldDisplayMode, FormGroupInterpretation.
 */
import type {
  Field,
  LocalizedText,
} from "@/generated/compiler/field-contract";
import type { FormVariableSource } from "@/features/renderer/runtime/variable-sources";

/**
 * How each nesting depth of {@link RendererFormGroup} is rendered.
 *
 * - `none` — no outer chrome: no Card, no section wrapper; optional group title still renders when
 *   {@link RendererFormDefinition.presentation.chrome.showGroupTitles} is true and the group has a title/label.
 * - `group` — plain section with spacing.
 * - `card` — bordered card.
 * - `info-card` — tinted informational card that renders the group label as a bold heading
 *   and the group description as body copy. Used for non-editable explanatory blocks.
 * - `tab` — at depth 0 with multiple top-level groups, activates tab navigation in {@link Renderer}.
 */
export type FormGroupInterpretation =
  | "none"
  | "group"
  | "card"
  | "info-card"
  | "accordion"
  | "tab"
  | "wizardStep";

export type RendererFieldDisplayMode =
  | "edit"
  | "readOnly"
  | "display"
  | "hidden"
  | "masked";

export interface RendererFieldMasking {
  strategy?: "full" | "partial";
  preserveStart?: number;
  preserveEnd?: number;
  replacement?: string;
}

export interface RendererFieldConfig {
  dataPath?: string;
  displayMode?: RendererFieldDisplayMode;
  masking?: RendererFieldMasking;
  /** When true, no label row is rendered (e.g. workspace panes where the field name duplicates the pane). */
  hideLabel?: boolean;
  /**
   * Label position relative to the control. Defaults to `vertical` (label
   * above). Set `horizontal` to render the label to the left of the control,
   * matching the Figma `InputHorizontal` layout.
   */
  direction?: "horizontal" | "vertical";
  /**
   * Override the array/object renderer's default-expansion heuristic. When
   * set, the field starts in this expansion state on mount. The user can still
   * toggle freely afterwards.
   */
  defaultExpanded?: boolean;
}

export interface RendererFormLayout {
  columns?: 1 | 2 | 3 | 4;
}

export type RendererTimelineInclude =
  | "self"
  | {
      relationship: string;
    };

export interface RendererTimelineConfig {
  include?: readonly RendererTimelineInclude[];
}

/**
 * A single field column inside a relationship usage (or one of its
 * {@link RendererChildRelationshipUsage} children). Mirrors the subset of the
 * compiler `Field` contract the renderer needs to resolve a display control.
 */
export interface RendererRelationshipFieldUsage {
  key: string;
  label?: LocalizedText;
  valueType?: Field["valueType"];
  cardinality?: Field["cardinality"];
  semanticType?: string;
  layoutFraction?: number;
  render?: Field["render"];
  validation?: Field["validation"];
  options?: Field["options"];
  suggestions?: Field["suggestions"];
}

/**
 * A nested, lazily-loaded child list hanging off a parent relationship row.
 * The compiler emits one of these per child relationship on a detail group's
 * `relationship.childRelationships`. The renderer fetches its rows on first
 * expand, scoped to the parent row id via {@link filterField}, using the
 * GraphQL list query named for {@link entitySlug}.
 *
 * This is intentionally non-recursive: depth-1 children render flat, so this
 * shape does not carry its own `childRelationships`.
 */
export interface RendererChildRelationshipUsage {
  name: string;
  view?: string;
  entitySlug: string;
  /** Overrides the registry-derived GraphQL list field name when present. */
  listQueryName?: string;
  /** FK on the child entity used to scope rows to the parent row id. */
  filterField: string;
  pageSize?: number;
  sort?: {
    key: string;
    direction: "asc" | "desc";
  };
  lazy?: "onExpand";
  presentationType?: "list" | "cards" | "summary" | "listItem";
  titleField?: string;
  subtitleField?: string;
  title?: LocalizedText;
  emptyState?: LocalizedText;
  fields?: readonly RendererRelationshipFieldUsage[];
}

export interface RendererRelationshipUsage {
  name: string;
  view?: string;
  presentationType?: "list" | "cards" | "summary" | "listItem";
  titleField?: string;
  subtitleField?: string;
  title?: LocalizedText;
  emptyState?: LocalizedText;
  actions?: readonly {
    key: string;
    label?: LocalizedText;
    route?: string;
    mutation?: string;
    confirm?: LocalizedText;
  }[];
  itemActions?: readonly {
    key: string;
    label?: LocalizedText;
    route?: string;
    mutation?: string;
    confirm?: LocalizedText;
  }[];
  routes?: Record<string, unknown>;
  fields?: readonly RendererRelationshipFieldUsage[];
  /**
   * Nested child lists rendered as a collapsible "expand" affordance beneath
   * each row. Fetched lazily on first expand. See
   * {@link RendererChildRelationshipUsage}.
   */
  childRelationships?: readonly RendererChildRelationshipUsage[];
}

export interface RendererFormOptionalSection {
  field: string;
  enabledWhen?: "defined" | "truthy";
  enableValue?: unknown;
  disableValue?: unknown;
  enableFields?: ReadonlyArray<{
    field: string;
    value: unknown;
  }>;
  enableLabel?: LocalizedText;
  disableLabel?: LocalizedText;
  hideChildrenWhenDisabled?: boolean;
  resetFields?: readonly string[];
}

export interface RendererFormGroupSection {
  collapsible?: boolean;
  defaultExpanded?: boolean;
  optional?: RendererFormOptionalSection;
}

export type RendererFormField = Field;

export interface RendererFormGroup {
  id: string;
  title?: LocalizedText;
  /**
   * When true the renderer suppresses this group's heading, even though
   * `showGroupTitles` is enabled globally. The compiler sets this on
   * innermost cards that would visually duplicate the sole field's label
   * (e.g. a `Condition` card holding just the `condition` field).
   */
  hideGroupTitle?: boolean;
  label?: LocalizedText;
  description?: LocalizedText;
  /**
   * Overrides the level-based {@link FormGroupInterpretation} resolved from
   * `presentation.groupInterpretation`. Use when one group at a given depth
   * needs different chrome than its siblings (e.g. an `info-card` block next
   * to ordinary groups).
   */
  interpretation?: FormGroupInterpretation;
  fields?: readonly string[];
  groups?: readonly RendererFormGroup[];
  relationships?: readonly RendererRelationshipUsage[];
  relationship?: RendererRelationshipUsage;
  render?: string;
  /**
   * Per-view timeline composition config. Only meaningful when
   * `render === "timeline"`. The renderer expands `self` (always implicit)
   * plus any configured relationship keys into the timeline query.
   */
  timeline?: RendererTimelineConfig;
  section?: RendererFormGroupSection;
  layout?: RendererFormLayout;
}

export interface RendererFormDefinition {
  schemaVersion?: number;
  id?: string;
  kind?: "form";
  mode: "create" | "edit" | "review" | "display";
  title?: LocalizedText;
  description?: LocalizedText;
  submitLabel?: LocalizedText;
  successRoute?: string;
  routes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  presentation?: {
    surface?: "page" | "sheet" | "dialog" | "inspector" | "workspace" | "embedded";
    density?: "comfortable" | "default" | "compact";
    groupInterpretation?: readonly FormGroupInterpretation[];
    layout?: RendererFormLayout;
    chrome?: {
      showTitle?: boolean;
      showDescription?: boolean;
      showGroupTitles?: boolean;
      showGroupDescriptions?: boolean;
      showActionBar?: boolean;
    };
  };
  submission?: {
    successRoute?: string;
    successBehavior?: "redirect" | "refresh";
  };
  groups: readonly RendererFormGroup[];
  fields: readonly Field[];
  fieldConfig?: Readonly<Record<string, RendererFieldConfig>>;
  /**
   * WEB-020 — declarative list of variable-suggestion sources resolved once
   * at the form level and shared across fields via `FieldRenderContext`.
   * See docs/architecture/form-variable-sources.md.
   */
  variableSources?: readonly FormVariableSource[];
  actions?: ReadonlyArray<{
    id: string;
    kind?: "submit" | "cancel" | "reset" | "custom";
    label?: LocalizedText;
  }>;
}

export type GeneratedEntityFormDefinition = RendererFormDefinition;

export { translateRendererText } from "@/features/renderer/runtime/field-utils";

export {
  LEGAL_ENTITY_FORM_DEFINITION,
  FORM_DEFINITION_EXAMPLE,
} from "@/features/renderer/form-definition.fixture";
