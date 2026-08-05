// SPDX-License-Identifier: BUSL-1.1
/**
 * How a node type looks on a canvas: its icon, its subtitle, its colour tone.
 *
 * The graph adapter answers what a node *is* — id, type, ports, config. The
 * render layer needs rather more before it can draw a card, and none of the
 * remainder is in the graph. This module is that remainder, and it is the seam
 * between the two halves.
 *
 * ## Why the icon lives here and not in the catalog
 *
 * The node catalog serves `label`, `description`, `category`, `configFields`,
 * `outputFields`, `catalog` and `runtimeSupport`. It does not serve an icon —
 * the authoring schema has no key for one, and `additionalProperties: false`
 * means adding one is a six-layer change through schema, compiler, seed, column,
 * store and GraphQL type.
 *
 * So the icon is a map, here, keyed by node type. That is a second place a node
 * type is described, which is a real cost and is why it is written down: a node
 * type added to the authoring YAML renders with the fallback until someone
 * edits this file too, and nothing fails to remind them. Making it declarative
 * is the open question in the handles issue, and the same change would carry
 * the icon.
 *
 * `category` becoming a locale map (#260) is NOT that change and does not
 * weaken this argument: it widened a key all six layers already carried, so no
 * layer had to learn about a field it had never heard of. Adding `icon` still
 * means a new key in the schema, a new property through two generators, a new
 * jsonb column with a migration, a new field on the store type, and a new
 * field on the GraphQL type — which is a different size of change from
 * retyping a column that exists.
 *
 * Everything else here is derived rather than mapped, so it cannot drift:
 * `typeLabel` is the catalog's own label, and trigger/terminal come from the
 * runtime's predicates rather than from a list kept in step by hand.
 */
import { isEntryNodeType, isTerminalNodeType } from "../runtime/definition-types";
import { workflowNodeCategoryKey } from "./node-category";

/** The tones a card can be drawn in. Mirrors the render layer's own union. */
export type WorkflowNodeTone = "trigger" | "default" | "ai";

/** What a card needs that the graph does not carry. */
export type WorkflowNodePresentation = {
  typeLabel: string;
  iconName: string;
  categoryTone: WorkflowNodeTone;
  isTrigger: boolean;
  isTerminal: boolean;
};

/** The slice of a catalog entry this module reads. */
export type WorkflowNodeTypeSummary = {
  type: string;
  /** Localized, like the label. The tone reads its identity, not its text. */
  category?: Record<string, string> | null;
  label?: Record<string, string> | null;
};

/**
 * Drawn when a node type names no icon — including a type this map has not been
 * told about yet, which is the drift the header warns of.
 *
 * `circle` resolves in the icon registry rather than falling through its own
 * `Circle` fallback, so an unmapped type and a genuinely round node look the
 * same on purpose: neither is an error, and a card that failed to render would
 * be a worse answer than a plain one.
 */
const FALLBACK_ICON = "circle";

/**
 * Icon per node type, for the standard catalog.
 *
 * Deliberately NOT keyed by category: two nodes in `flow` can want different
 * icons, and a card is read as "what does this step do", which is the type.
 */
const ICON_BY_NODE_TYPE: Readonly<Record<string, string>> = {
  // flow
  condition: "filter",
  decision: "git-branch",
  end: "circle-stop",
  join: "merge",
  split: "split",
  timer: "clock-3",
  "flow.userInput": "form-input",
  // integrations and orchestration
  action: "zap",
  "workflow.startDefinition": "play",
  subWorkflow: "workflow",
  // triggers
  triggerEntity: "building-2",
  triggerEvent: "radio",
  triggerManual: "play",
  triggerSchedule: "calendar-clock",
  triggerWebhook: "webhook",
};

/**
 * Category to tone.
 *
 * Matched on the category's identity rather than on its text — the English
 * spelling, case-folded, which is what `workflowNodeCategoryKey` derives and
 * where the rule is written down. A tone read off the display string would
 * change colour with the reader's language, and `category` has already been
 * inconsistent about capitalisation once, which put one trigger in a palette
 * bucket of its own.
 */
function toneForCategory(category: Record<string, string> | null | undefined): WorkflowNodeTone {
  switch (workflowNodeCategoryKey(category)) {
    case "triggers":
      return "trigger";
    case "ai":
      return "ai";
    default:
      return "default";
  }
}

/**
 * The reader's label for a node type, falling back to the type itself.
 *
 * Locale maps arrive whole from the catalog, because choosing a locale belongs
 * to whatever renders the text. This picks one; a caller wanting another passes
 * its own preference.
 */
function labelFor(entry: WorkflowNodeTypeSummary | undefined, nodeType: string, locale: string) {
  const label = entry?.label ?? null;
  if (label) {
    const exact = label[locale];
    if (typeof exact === "string" && exact.trim()) return exact;
    const english = label.en;
    if (typeof english === "string" && english.trim()) return english;
    const first = Object.values(label).find((value) => typeof value === "string" && value.trim());
    if (first) return first;
  }
  return nodeType;
}

export function resolveWorkflowNodePresentation(input: {
  nodeType: string;
  /** The catalog entry for this type, when the catalog knows it. */
  entry?: WorkflowNodeTypeSummary | undefined;
  /** Preferred locale for `typeLabel`; falls back to English then to any. */
  locale?: string;
}): WorkflowNodePresentation {
  const { nodeType, entry } = input;
  return {
    typeLabel: labelFor(entry, nodeType, input.locale ?? "en"),
    iconName: ICON_BY_NODE_TYPE[nodeType] ?? FALLBACK_ICON,
    categoryTone: toneForCategory(entry?.category),
    // From the runtime's own predicates, not a list maintained here. A node
    // type the catalog has never heard of still answers correctly, because
    // both are decided by the type string alone.
    isTrigger: isEntryNodeType(nodeType),
    isTerminal: isTerminalNodeType(nodeType),
  };
}

/** Node types this module names an icon for. Exported so a test can be total. */
export function iconMappedNodeTypes(): string[] {
  return Object.keys(ICON_BY_NODE_TYPE).sort();
}
