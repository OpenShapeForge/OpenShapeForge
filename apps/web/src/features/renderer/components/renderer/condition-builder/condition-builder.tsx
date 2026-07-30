// SPDX-License-Identifier: BUSL-1.1
import {
  getDefaultConditionBuilderMode,
  normalizeConditionForMode,
} from "@/features/renderer/runtime/conditions";
import { ConditionBuilderNode } from "./condition-builder-node";
import type { ConditionBuilderProps } from "./types";

function ConditionBuilder({
  value,
  onChange,
  mode,
  lang = "nl",
  variableSuggestions = [],
  variableSuggestionHeaderLabel,
  disabled,
  readOnly,
}: ConditionBuilderProps) {
  const resolvedMode = getDefaultConditionBuilderMode(mode);
  const normalized = normalizeConditionForMode(value, resolvedMode);

  return (
    <ConditionBuilderNode
      value={normalized}
      onChange={onChange}
      mode={resolvedMode}
      lang={lang}
      variableSuggestions={variableSuggestions}
      variableSuggestionHeaderLabel={variableSuggestionHeaderLabel}
      disabled={disabled}
      readOnly={readOnly}
    />
  );
}

export { ConditionBuilder };
export type { ConditionBuilderProps };
