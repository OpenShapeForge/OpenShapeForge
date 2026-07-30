// SPDX-License-Identifier: BUSL-1.1
import type {
  CompilerConditionInput,
  CompilerConditionOperandInput,
} from "@/generated/compiler/canonical-condition";
import type { VariableSuggestion } from "@/features/renderer/runtime/variable-suggestions";
import { formatConditionBoundOperandValue } from "./display";
import {
  bindConditionLeftOperand,
  createConditionId,
  isConditionGroup,
  normalizeConditionInput,
} from "./model";
import { createPathOperand } from "./operands";

export type ConditionBuilderMode =
  | {
      kind: "free";
      defaultPath?: string;
    }
  | {
      kind: "boundLeft";
      left: CompilerConditionOperandInput;
      leftLabel?: string;
      leftDisplayValue?: string;
      defaultPath?: string;
    };

export function getDefaultConditionBuilderMode(
  mode: ConditionBuilderMode | undefined,
): ConditionBuilderMode {
  return mode ?? { kind: "free", defaultPath: "" };
}

export function normalizeConditionForMode(
  value: CompilerConditionInput | undefined,
  mode: ConditionBuilderMode,
) {
  const defaultPath = mode.defaultPath ?? "";
  let normalized = normalizeConditionInput(value, defaultPath);
  if (mode.kind === "boundLeft") {
    normalized = bindConditionLeftOperand(normalized, mode.left);
  }
  if (!isConditionGroup(normalized)) {
    normalized = {
      kind: "group",
      id: createConditionId("group"),
      mode: "all",
      conditions: [normalized],
    };
  }
  return normalized;
}

export function resolveConditionBuilderMode(input: {
  rootValues: Record<string, unknown>;
  renderProps?: Record<string, unknown>;
  variableSuggestions?: VariableSuggestion[];
  lang?: "nl" | "en";
}): ConditionBuilderMode {
  const { rootValues, renderProps, variableSuggestions = [], lang = "nl" } = input;
  const mode =
    typeof renderProps?.mode === "string" && renderProps.mode === "boundLeft"
      ? "boundLeft"
      : "free";
  const defaultPath =
    typeof renderProps?.defaultPath === "string" && renderProps.defaultPath.trim().length > 0
      ? renderProps.defaultPath.trim()
      : "";

  if (mode !== "boundLeft") {
    return { kind: "free", defaultPath };
  }

  const leftSourceField =
    typeof renderProps?.leftSourceField === "string" && renderProps.leftSourceField.trim().length > 0
      ? renderProps.leftSourceField.trim()
      : undefined;

  const boundPathValue = leftSourceField
    ? leftSourceField.split(".").reduce<unknown>((current, part) => {
        return current && typeof current === "object"
          ? (current as Record<string, unknown>)[part]
          : undefined;
      }, rootValues)
    : defaultPath;
  const boundPath =
    typeof boundPathValue === "string" && boundPathValue.trim().length > 0
      ? boundPathValue.trim()
      : defaultPath;

  return {
    kind: "boundLeft",
    left: createPathOperand(boundPath),
    leftLabel:
      typeof renderProps?.leftLabel === "string" && renderProps.leftLabel.trim().length > 0
        ? renderProps.leftLabel.trim()
        : lang === "nl"
          ? "Testexpressie"
          : "Test expression",
    leftDisplayValue: formatConditionBoundOperandValue(boundPath, variableSuggestions),
    defaultPath,
  };
}
