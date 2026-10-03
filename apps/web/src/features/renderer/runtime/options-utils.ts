// SPDX-License-Identifier: BUSL-1.1
import type {
  Field,
  LocalizedText,
} from "@/generated/compiler/field-contract";
import { resolveReferentieGroepItems } from "@/lib/referentiedata";
import { getFieldOsfTypeDefinition } from "@/lib/field-rendering/compiler-field-rendering";

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

  const semanticOptions = getFieldOsfTypeDefinition(field)?.options;
  if (semanticOptions?.items?.length) {
    return dedupeStaticOptions(semanticOptions.items);
  }

  // The group is named in options (the compiler folds a select's render prop
  // into it); presentation props never decide which values are valid.
  const groep = field.options?.referentieGroep ?? semanticOptions?.referentieGroep;

  if (!groep) {
    return [];
  }

  return dedupeStaticOptions(resolveReferentieGroepItems(groep).items);
}
