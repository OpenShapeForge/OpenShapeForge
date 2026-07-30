// SPDX-License-Identifier: BUSL-1.1
import type {
  Field,
  LocalizedText,
} from "@/generated/compiler/field-contract";
import { resolveReferentieGroepItems } from "@/lib/referentiedata";
import {
  getFieldSemanticTypeDefinition,
  resolveFieldInputRender,
} from "@/lib/field-rendering/compiler-field-rendering";

export type StaticOption = {
  value: string;
  label?: LocalizedText;
};

function dedupeStaticOptions(items: StaticOption[]): StaticOption[] {
  const seen = new Set<string>();
  const deduped: StaticOption[] = [];

  for (const item of items) {
    if (seen.has(item.value)) {
      continue;
    }
    seen.add(item.value);
    deduped.push(item);
  }

  return deduped;
}

export function resolveRendererReferenceItems(field: Field): StaticOption[] {
  const direct = field.options?.items;
  if (direct && direct.length > 0) {
    return dedupeStaticOptions(direct);
  }

  const semanticOptions = getFieldSemanticTypeDefinition(field)?.options;
  if (semanticOptions?.items?.length) {
    return dedupeStaticOptions(semanticOptions.items);
  }

  const resolvedRender = resolveFieldInputRender(field);
  const semanticReferentieGroep =
    semanticOptions?.referentieGroep;
  const groep =
    field.options?.referentieGroep ??
    semanticReferentieGroep ??
    (typeof resolvedRender.props?.referentieGroep === "string"
      ? resolvedRender.props.referentieGroep
      : undefined);

  if (!groep) {
    return [];
  }

  return dedupeStaticOptions(resolveReferentieGroepItems(groep).items);
}
