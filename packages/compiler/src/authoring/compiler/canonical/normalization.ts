// @ts-nocheck
// SPDX-License-Identifier: BUSL-1.1
/**
 * Canonical normalization — transforms loose input shapes into strict canonical
 * structures. Handles fields, field references, conditions, actions, and
 * presentations with validation of constraints like uniqueness and operand arity.
 */
import type { LocalizedText, VisibilityConfig } from "../../types.js";
import { parseCanonicalPath, createCanonicalPath } from "./path.js";
import type {
  CanonicalAction,
  CanonicalActionButtonVariant,
  CanonicalActionInputShape,
  CanonicalActionIntent,
  CanonicalActionSemanticFlags,
  CanonicalCondition,
  CanonicalConditionGroup,
  CanonicalConditionInput,
  CanonicalConditionOperand,
  CanonicalConditionOperandInput,
  CanonicalConditionOperator,
  CanonicalConditionRule,
  CanonicalField,
  CanonicalFieldInput,
  CanonicalFieldReference,
  CanonicalFieldReferenceInput,
  CanonicalFormPresentation,
  CanonicalPath,
  CanonicalPathInput,
  CanonicalPresentation,
  CanonicalPresentationInput,
  CanonicalPresentationMode,
  CanonicalPresentationSection,
  CanonicalWizardPresentation,
} from "./types.js";

const UNARY_OPERATORS = new Set<CanonicalConditionOperator>(["isEmpty", "isNotEmpty"]);
const ACTION_INPUT_INTENTS = new Set<CanonicalActionIntent>(["approve", "reject", "handover"]);
const REASON_INTENTS = new Set<CanonicalActionIntent>(["approve", "reject"]);

export function normalizeCanonicalField(field: CanonicalFieldInput, idPrefix = ""): CanonicalField {
  const key = field.key.trim();
  if (!key) {
    throw new Error("Canonical field requires a non-empty key");
  }

  const id = field.id?.trim() || [idPrefix, key].filter(Boolean).join(".");
  if (!id) {
    throw new Error(`Canonical field '${key}' requires an id or idPrefix`);
  }

  const normalized: CanonicalField = {
    id,
    key,
    type: field.type,
    label: field.label,
    required: field.required,
    source: field.source,
  };

  if (field.description) normalized.description = field.description;
  if (field.readOnly) normalized.readOnly = true;
  if (field.semanticType) normalized.semanticType = field.semanticType;
  if (field.defaultValue !== undefined) normalized.defaultValue = field.defaultValue;
  if (field.validation) normalized.validation = field.validation;
  if (field.render) normalized.render = field.render;
  if (field.options) {
    normalized.options = {
      ...field.options,
      items: field.options.items?.map((item) => ({ ...item })),
    };
  }
  if (field.children?.length) {
    normalized.children = field.children.map((child) =>
      normalizeCanonicalField(child, id),
    );
  }
  if (field.item) {
    normalized.item = normalizeCanonicalField(field.item, `${id}[]`);
  }

  return normalized;
}

export function normalizeCanonicalFieldReference(input: CanonicalFieldReferenceInput): CanonicalFieldReference {
  const normalized: CanonicalFieldReference = {
    kind: "fieldReference",
    path: normalizeCanonicalPath(input.path),
  };

  if (input.alias?.trim()) normalized.alias = input.alias.trim();
  if (input.mode) normalized.mode = input.mode;
  if (input.visibleWhen) normalized.visibleWhen = normalizeCanonicalCondition(input.visibleWhen, `${normalized.path.normalized}.visibleWhen`);
  if (input.presentation) normalized.presentation = { ...input.presentation };

  return normalized;
}

export function normalizeCanonicalCondition(
  input: CanonicalConditionInput,
  idPrefix = "condition",
): CanonicalCondition {
  if ("operator" in input) {
    return normalizeCanonicalConditionRule(input, idPrefix);
  }

  const all = input.all;
  const any = input.any;
  const mode = all ? "all" : any ? "any" : input.mode ?? "all";
  const rawConditions = all ?? any ?? input.conditions ?? [];
  if (!rawConditions.length) {
    throw new Error("Canonical condition groups must contain at least one condition");
  }

  const groupId = input.id?.trim() || `${slugify(idPrefix)}-group`;

  return {
    kind: "group",
    id: groupId,
    mode,
    conditions: rawConditions.map((condition, index) =>
      normalizeCanonicalCondition(condition, `${groupId}-${index + 1}`),
    ),
  };
}

export function normalizeCanonicalActions(actions: CanonicalActionInputShape[]): CanonicalAction[] {
  const normalized = actions.map((action, index) => normalizeCanonicalAction(action, index));
  const primaryCount = normalized.filter((action) => action.primary).length;

  if (primaryCount > 1) {
    throw new Error("At most one canonical action may be primary");
  }

  if (normalized.length === 1 && primaryCount === 0) {
    normalized[0] = {
      ...normalized[0],
      primary: true,
      buttonVariant: normalized[0].buttonVariant === "secondary" ? "primary" : normalized[0].buttonVariant,
    };
  }

  return normalized;
}

export function normalizeCanonicalPresentation(input: CanonicalPresentationInput): CanonicalPresentation {
  if (input.kind === "form") {
    const presentation: CanonicalFormPresentation = {
      id: input.id,
      kind: "form",
      mode: input.mode ?? "edit",
      title: input.title,
      sections: input.sections.map((section, index) => normalizeCanonicalSection(section, `${input.id}-section-${index + 1}`)),
      actions: normalizeCanonicalActions(input.actions ?? []),
    };
    validatePresentationFieldAliases(presentation);
    return presentation;
  }

  if (!input.steps.length) {
    throw new Error(`Wizard presentation '${input.id}' must contain at least one step`);
  }

  const presentation: CanonicalWizardPresentation = {
    id: input.id,
    kind: "wizard",
    mode: input.mode ?? "edit",
    title: input.title,
    steps: input.steps.map((step, index) => ({
      id: step.id?.trim() || `${slugify(input.id)}-step-${index + 1}`,
      title: step.title,
      description: step.description,
      mode: step.mode,
      visibleWhen: step.visibleWhen
        ? normalizeCanonicalCondition(step.visibleWhen, `${input.id}-step-${index + 1}-visible`)
        : undefined,
      allowBackNavigation: step.allowBackNavigation,
      sections: step.sections.map((section, sectionIndex) =>
        normalizeCanonicalSection(section, `${input.id}-step-${index + 1}-section-${sectionIndex + 1}`),
      ),
    })),
    actions: normalizeCanonicalActions(input.actions ?? []),
  };

  validatePresentationFieldAliases(presentation);
  return presentation;
}

export function normalizeLegacyVisibilityConfig(
  visibility: VisibilityConfig,
  resolvePath: (field: string) => CanonicalPath,
  idPrefix = "visibility",
): CanonicalConditionGroup {
  const mode = visibility.logic === "or" ? "any" : "all";

  return {
    kind: "group",
    id: `${slugify(idPrefix)}-group`,
    mode,
    conditions: (visibility.conditions ?? []).map((condition, index) => {
      const operator = mapLegacyOperator(condition.operator);
      return {
        kind: "rule",
        id: `${slugify(idPrefix)}-rule-${index + 1}`,
        operator,
        left: {
          kind: "path",
          path: resolvePath(condition.field),
        },
        right: UNARY_OPERATORS.has(operator)
          ? undefined
          : {
              kind: "literal",
              value: condition.value,
            },
      };
    }),
  };
}

function normalizeCanonicalAction(action: CanonicalActionInputShape, index: number): CanonicalAction {
  const id = action.id.trim();
  if (!id) {
    throw new Error(`Canonical action at index ${index} requires a non-empty id`);
  }

  const reason = action.reason
    ? {
        enabled: action.reason.enabled === true,
        required: action.reason.required === true,
        label: action.reason.label,
        help: action.reason.help,
      }
    : undefined;

  if (reason?.required && !reason.enabled) {
    throw new Error(`Canonical action '${id}' cannot require a reason when reason support is disabled`);
  }

  if (reason?.enabled && !REASON_INTENTS.has(action.intent)) {
    throw new Error(`Canonical action '${id}' does not support reason for intent '${action.intent}'`);
  }

  const actionInput = action.actionInput && action.actionInput.fields.length > 0
    ? {
        required: action.actionInput.required === true,
        fields: action.actionInput.fields.map((field, fieldIndex) =>
          normalizeCanonicalField(field, `${id}.actionInput.${fieldIndex + 1}`),
        ),
      }
    : undefined;

  if (action.intent === "handover" && !actionInput) {
    throw new Error(`Canonical action '${id}' requires actionInput for intent 'handover'`);
  }

  if (actionInput && !ACTION_INPUT_INTENTS.has(action.intent)) {
    throw new Error(`Canonical action '${id}' does not support actionInput for intent '${action.intent}'`);
  }

  const semanticFlags: CanonicalActionSemanticFlags = {
    terminal: action.intent === "cancel" ? true : action.semanticFlags?.terminal === true,
    destructive: action.semanticFlags?.destructive === true || action.intent === "reject" || action.intent === "cancel",
  };

  if (action.intent === "handover" && semanticFlags.terminal) {
    throw new Error(`Canonical action '${id}' cannot be terminal when intent is 'handover'`);
  }

  const confirmation = semanticFlags.destructive
    ? (action.confirmation ? { ...action.confirmation } : {})
    : (action.confirmation ? { ...action.confirmation } : undefined);

  const primary = action.primary === true;
  const buttonVariant = action.buttonVariant
    ?? (semanticFlags.destructive ? "destructive" : primary ? "primary" : "secondary");

  return {
    id,
    intent: action.intent,
    label: action.label,
    description: action.description,
    primary,
    buttonVariant,
    availability: action.availability
      ? {
          visibleWhen: action.availability.visibleWhen
            ? normalizeCanonicalCondition(action.availability.visibleWhen, `${id}-availability-visible`)
            : undefined,
          enabledWhen: action.availability.enabledWhen
            ? normalizeCanonicalCondition(action.availability.enabledWhen, `${id}-availability-enabled`)
            : undefined,
        }
      : undefined,
    completion: action.completion ? { ...action.completion } : undefined,
    semanticFlags,
    reason,
    actionInput,
    confirmation,
  };
}

function normalizeCanonicalConditionRule(
  input: Extract<CanonicalConditionInput, { operator: CanonicalConditionOperator }>,
  idPrefix: string,
): CanonicalConditionRule {
  const unary = UNARY_OPERATORS.has(input.operator);
  if (unary && input.right) {
    throw new Error(`Canonical condition '${idPrefix}' cannot use a right operand for unary operator '${input.operator}'`);
  }
  if (!unary && !input.right) {
    throw new Error(`Canonical condition '${idPrefix}' requires a right operand for operator '${input.operator}'`);
  }

  return {
    kind: "rule",
    id: input.id?.trim() || `${slugify(idPrefix)}-rule`,
    operator: input.operator,
    left: normalizeCanonicalConditionOperand(input.left),
    right: input.right ? normalizeCanonicalConditionOperand(input.right) : undefined,
  };
}

function normalizeCanonicalConditionOperand(input: CanonicalConditionOperandInput): CanonicalConditionOperand {
  if (input.kind === "literal") {
    return { kind: "literal", value: input.value };
  }

  if (input.kind === "function") {
    return {
      kind: "function",
      name: input.name,
      offset: input.offset,
    };
  }

  return {
    kind: "path",
    path: normalizeCanonicalPath(input.path),
    offset: input.offset,
  };
}

function normalizeCanonicalPath(input: CanonicalPathInput): CanonicalPath {
  return typeof input === "string" ? parseCanonicalPath(input) : createCanonicalPath(input.root, input.segments);
}

function normalizeCanonicalSection(
  section: {
    id?: string;
    title?: LocalizedText;
    mode?: CanonicalPresentationMode;
    visibleWhen?: CanonicalConditionInput;
    fields: CanonicalFieldReferenceInput[];
  },
  fallbackId: string,
): CanonicalPresentationSection {
  return {
    id: section.id?.trim() || slugify(fallbackId),
    title: section.title,
    mode: section.mode,
    visibleWhen: section.visibleWhen ? normalizeCanonicalCondition(section.visibleWhen, `${fallbackId}-visible`) : undefined,
    fields: section.fields.map((field) => normalizeCanonicalFieldReference(field)),
  };
}

function validatePresentationFieldAliases(presentation: CanonicalPresentation): void {
  const usages = new Map<string, CanonicalFieldReference[]>();
  const fields = presentation.kind === "form"
    ? presentation.sections.flatMap((section) => section.fields)
    : presentation.steps.flatMap((step) => step.sections.flatMap((section) => section.fields));

  for (const field of fields) {
    const key = field.path.normalized;
    const list = usages.get(key) ?? [];
    list.push(field);
    usages.set(key, list);
  }

  for (const [path, refs] of usages.entries()) {
    if (refs.length <= 1) continue;
    if (refs.some((ref) => !ref.alias)) {
      throw new Error(`Canonical presentation references '${path}' multiple times without unique aliases`);
    }

    const aliases = new Set<string>();
    for (const ref of refs) {
      if (aliases.has(ref.alias!)) {
        throw new Error(`Canonical presentation uses duplicate alias '${ref.alias}' for path '${path}'`);
      }
      aliases.add(ref.alias!);
    }
  }
}

function mapLegacyOperator(operator: string): CanonicalConditionOperator {
  switch (operator) {
    case "eq":
      return "equals";
    case "neq":
      return "notEquals";
    case "gt":
      return "greaterThan";
    case "gte":
      return "greaterThanOrEquals";
    case "lt":
      return "lessThan";
    case "lte":
      return "lessThanOrEquals";
    case "contains":
      return "contains";
    case "notContains":
      return "notContains";
    case "in":
      return "in";
    case "notIn":
      return "notIn";
    case "isEmpty":
      return "isEmpty";
    case "isNotEmpty":
      return "isNotEmpty";
    default:
      throw new Error(`Unsupported legacy visibility operator '${operator}'`);
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "item";
}
