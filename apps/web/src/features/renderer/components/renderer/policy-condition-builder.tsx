// SPDX-License-Identifier: BUSL-1.1
"use client";

import { ConditionNode } from "./policy-condition-builder/condition-node";
import { PolicyConditionDisplay } from "./policy-condition-builder/display";
import { labels } from "./policy-condition-builder/labels";
import {
  conditionUsesField,
  normalizeCondition,
} from "./policy-condition-builder/state";
import type { PolicyConditionBuilderProps } from "./policy-condition-builder/types";

export { PolicyConditionDisplay };
export type {
  PolicyCondition,
  PolicyConditionBuilderProps,
} from "./policy-condition-builder/types";

function PolicyConditionBuilder({
  id,
  value,
  lang,
  disabled,
  entityType,
  variableSuggestions = [],
  onChange,
}: PolicyConditionBuilderProps) {
  const condition = normalizeCondition(value);
  const t = labels(lang);

  return (
    <div className="space-y-2">
      {conditionUsesField(condition) && !entityType ? (
        <p className="text-sm text-foreground-subtle">
          {t.field}:{" "}
          {lang === "nl"
            ? "entiteitstype ontbreekt."
            : "entity type is missing."}
        </p>
      ) : null}
      <ConditionNode
        id={id}
        value={condition}
        lang={lang}
        disabled={disabled}
        entityType={entityType}
        variableSuggestions={variableSuggestions}
        level={0}
        onChange={(nextValue) => onChange(normalizeCondition(nextValue))}
      />
    </div>
  );
}

export { PolicyConditionBuilder };
