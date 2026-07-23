// @ts-nocheck
/**
 * Canonical type definitions — all type aliases, interfaces, and union types
 * used by the canonical compiler kernel.
 *
 * These types define the standardized format consumed by the workflow engine
 * and external integrations, including path-based field references, conditional
 * visibility rules, action intents, and presentation layouts.
 */
import type {
  CompiledRender,
  FieldValidation,
  LocalizedText,
  VisibilityConfig,
} from "../../types.js";

export type CanonicalPathRoot = "input" | "nodes" | "business" | "taskResult";

export type CanonicalPresentationMode = "edit" | "display" | "review";

export type CanonicalConditionOperator =
  | "equals"
  | "notEquals"
  | "greaterThan"
  | "greaterThanOrEquals"
  | "lessThan"
  | "lessThanOrEquals"
  | "isEmpty"
  | "isNotEmpty"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "in"
  | "notIn";

export type CanonicalActionIntent =
  | "submit"
  | "approve"
  | "reject"
  | "handover"
  | "cancel"
  | "close";

export type CanonicalActionButtonVariant = "primary" | "secondary" | "destructive";

export interface CanonicalPathPropertySegment {
  kind: "property";
  key: string;
}

export interface CanonicalPathArrayItemSegment {
  kind: "arrayItem";
}

export type CanonicalPathSegment = CanonicalPathPropertySegment | CanonicalPathArrayItemSegment;

export interface CanonicalPath {
  root: CanonicalPathRoot;
  segments: CanonicalPathSegment[];
  normalized: string;
}

export interface CanonicalField {
  id: string;
  key: string;
  type: string;
  label: LocalizedText;
  description?: LocalizedText;
  required: boolean;
  readOnly?: boolean;
  semanticType?: string;
  defaultValue?: unknown;
  validation?: FieldValidation;
  render?: CompiledRender;
  options?: {
    type: string;
    items?: Array<{
      label: LocalizedText;
      value: string;
    }>;
    referentieGroep?: string;
    remoteUrl?: string;
    valueField?: string;
    labelField?: string;
  };
  source: "core" | "profile" | "synthetic";
  children?: CanonicalField[];
  item?: CanonicalField;
}

export interface CanonicalFieldReferencePresentation {
  renderer?: string;
  help?: LocalizedText;
  placeholder?: LocalizedText;
}

export interface CanonicalFieldReference {
  kind: "fieldReference";
  path: CanonicalPath;
  alias?: string;
  mode?: CanonicalPresentationMode;
  visibleWhen?: CanonicalCondition;
  presentation?: CanonicalFieldReferencePresentation;
}

export interface CanonicalConditionPathOperand {
  kind: "path";
  path: CanonicalPath;
  offset?: { days: number };
}

export interface CanonicalConditionLiteralOperand {
  kind: "literal";
  value: unknown;
}

export interface CanonicalConditionFunctionOperand {
  kind: "function";
  name: "today";
  offset?: { days: number };
}

export type CanonicalConditionOperand =
  | CanonicalConditionPathOperand
  | CanonicalConditionLiteralOperand
  | CanonicalConditionFunctionOperand;

export interface CanonicalConditionRule {
  kind: "rule";
  id: string;
  operator: CanonicalConditionOperator;
  left: CanonicalConditionOperand;
  right?: CanonicalConditionOperand;
}

export interface CanonicalConditionGroup {
  kind: "group";
  id: string;
  mode: "all" | "any";
  conditions: CanonicalCondition[];
}

export type CanonicalCondition = CanonicalConditionRule | CanonicalConditionGroup;

export interface CanonicalActionAvailability {
  visibleWhen?: CanonicalCondition;
  enabledWhen?: CanonicalCondition;
}

export interface CanonicalActionCompletion {
  closesPresentation?: boolean;
  completesStep?: boolean;
  completesTask?: boolean;
  requiresValid?: "none" | "active" | "all";
}

export interface CanonicalActionSemanticFlags {
  terminal?: boolean;
  destructive?: boolean;
}

export interface CanonicalActionReason {
  enabled: boolean;
  required: boolean;
  label?: LocalizedText;
  help?: LocalizedText;
}

export interface CanonicalActionInput {
  required?: boolean;
  fields: CanonicalField[];
}

export interface CanonicalActionConfirmation {
  title?: LocalizedText;
  body?: LocalizedText;
}

export interface CanonicalAction {
  id: string;
  intent: CanonicalActionIntent;
  label: LocalizedText;
  description?: LocalizedText;
  primary: boolean;
  buttonVariant: CanonicalActionButtonVariant;
  availability?: CanonicalActionAvailability;
  completion?: CanonicalActionCompletion;
  semanticFlags?: CanonicalActionSemanticFlags;
  reason?: CanonicalActionReason;
  actionInput?: CanonicalActionInput;
  confirmation?: CanonicalActionConfirmation;
}

export interface CanonicalPresentationSection {
  id: string;
  title?: LocalizedText;
  mode?: CanonicalPresentationMode;
  visibleWhen?: CanonicalCondition;
  fields: CanonicalFieldReference[];
}

export interface CanonicalWizardStep {
  id: string;
  title?: LocalizedText;
  description?: LocalizedText;
  mode?: CanonicalPresentationMode;
  visibleWhen?: CanonicalCondition;
  allowBackNavigation?: boolean;
  sections: CanonicalPresentationSection[];
}

export interface CanonicalFormPresentation {
  id: string;
  kind: "form";
  mode: CanonicalPresentationMode;
  title?: LocalizedText;
  sections: CanonicalPresentationSection[];
  actions: CanonicalAction[];
}

export interface CanonicalWizardPresentation {
  id: string;
  kind: "wizard";
  mode: CanonicalPresentationMode;
  title?: LocalizedText;
  steps: CanonicalWizardStep[];
  actions: CanonicalAction[];
}

export type CanonicalPresentation = CanonicalFormPresentation | CanonicalWizardPresentation;

export interface CanonicalCompilerContext {
  fields: Partial<Record<CanonicalPathRoot, CanonicalField[]>>;
  presentations: Record<string, CanonicalPresentation>;
}

export interface CanonicalCompilerKernel {
  contexts: Record<string, CanonicalCompilerContext>;
}

export type CanonicalPathInput = string | CanonicalPath;

export type CanonicalConditionOperandInput =
  | { kind: "path"; path: CanonicalPathInput; offset?: { days: number } }
  | { kind: "literal"; value: unknown }
  | { kind: "function"; name: "today"; offset?: { days: number } };

export type CanonicalConditionInput =
  | {
      kind?: "group";
      id?: string;
      mode?: "all" | "any";
      conditions?: CanonicalConditionInput[];
      all?: CanonicalConditionInput[];
      any?: CanonicalConditionInput[];
    }
  | {
      kind?: "rule";
      id?: string;
      operator: CanonicalConditionOperator;
      left: CanonicalConditionOperandInput;
      right?: CanonicalConditionOperandInput;
    };

export type CanonicalFieldInput = Omit<CanonicalField, "id"> & { id?: string };

export interface CanonicalFieldReferenceInput {
  path: CanonicalPathInput;
  alias?: string;
  mode?: CanonicalPresentationMode;
  visibleWhen?: CanonicalConditionInput;
  presentation?: CanonicalFieldReferencePresentation;
}

export interface CanonicalActionInputShape {
  id: string;
  intent: CanonicalActionIntent;
  label: LocalizedText;
  description?: LocalizedText;
  primary?: boolean;
  buttonVariant?: CanonicalActionButtonVariant;
  availability?: {
    visibleWhen?: CanonicalConditionInput;
    enabledWhen?: CanonicalConditionInput;
  };
  completion?: CanonicalActionCompletion;
  semanticFlags?: CanonicalActionSemanticFlags;
  reason?: CanonicalActionReason;
  actionInput?: {
    required?: boolean;
    fields: CanonicalFieldInput[];
  };
  confirmation?: CanonicalActionConfirmation;
}

export type CanonicalPresentationInput =
  | {
      id: string;
      kind: "form";
      title?: LocalizedText;
      mode?: CanonicalPresentationMode;
      sections: {
        id?: string;
        title?: LocalizedText;
        mode?: CanonicalPresentationMode;
        visibleWhen?: CanonicalConditionInput;
        fields: CanonicalFieldReferenceInput[];
      }[];
      actions?: CanonicalActionInputShape[];
    }
  | {
      id: string;
      kind: "wizard";
      title?: LocalizedText;
      mode?: CanonicalPresentationMode;
      steps: {
        id?: string;
        title?: LocalizedText;
        description?: LocalizedText;
        mode?: CanonicalPresentationMode;
        visibleWhen?: CanonicalConditionInput;
        allowBackNavigation?: boolean;
        sections: {
          id?: string;
          title?: LocalizedText;
          mode?: CanonicalPresentationMode;
          visibleWhen?: CanonicalConditionInput;
          fields: CanonicalFieldReferenceInput[];
        }[];
      }[];
      actions?: CanonicalActionInputShape[];
    };
