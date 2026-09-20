// SPDX-License-Identifier: BUSL-1.1
/**
 * The records of an entity as choices: what a reference picker lists and what
 * a reference display names. Built at runtime from the generated core-entity
 * GraphQL registry (the list field) and the entity's identity alias (its
 * display template and search field), run through the authenticated,
 * tenant-filtered gateway like every other list.
 */
"use server";

import { executeGraphqlRequest } from "@/lib/server/graphql-client";
import { entityRecordListing } from "@/features/renderer/runtime/entity-option-source";

export type EntityOption = {
  value: string;
  label: { en: string; nl: string };
};

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;

/** The record fields a display template reads, so the list query asks for exactly those. */
function templateFields(template: string): string[] {
  const fields = new Set<string>(["id"]);
  for (const match of template.matchAll(/\{\{(.+?)\}\}/g)) {
    for (const candidate of match[1]!.split("||")) {
      const key = candidate.trim().split(".")[0]!;
      if (IDENTIFIER.test(key)) fields.add(key);
    }
  }
  return [...fields];
}

function renderTemplate(template: string, record: Record<string, unknown>): string {
  const rendered = template
    .replace(/\{\{(.+?)\}\}/g, (_, expression: string) => {
      for (const candidate of expression.split("||").map((part: string) => part.trim())) {
        const value = record[candidate];
        if (value != null && value !== "") return String(value);
      }
      return "";
    })
    .trim();
  return rendered || String(record.id ?? "");
}

export async function listEntityOptions(input: {
  entity: string;
  valueField?: string;
  /** Free-text search on the entity's filter field. */
  search?: string;
  /** One known value, to name a stored reference. */
  id?: string;
  first?: number;
}): Promise<EntityOption[]> {
  const listing = entityRecordListing(input.entity);
  if (!listing || !IDENTIFIER.test(listing.plural) || !IDENTIFIER.test(listing.filterType) || !IDENTIFIER.test(listing.filterField)) return [];
  const valueField = input.valueField && IDENTIFIER.test(input.valueField) ? input.valueField : "id";
  const fields = [...new Set([...templateFields(listing.displayTemplate), valueField])].join(" ");
  const search = input.search?.trim();
  const id = input.id?.trim();
  const filter: Record<string, unknown> = id
    ? { [valueField]: id }
    : search
      ? { [listing.filterField]: search }
      : {};
  const query = `query EntityOptions($filter: ${listing.filterType}, $first: Int) {
    ${listing.plural}(filter: $filter, first: $first) {
      data { items { data { ${fields} } } }
      error { code message }
    }
  }`;
  const response = await executeGraphqlRequest<Record<string, {
    data?: { items?: Array<{ data?: Record<string, unknown> | null }> } | null;
    error?: { code?: string; message?: string } | null;
  } | null>>({
    query,
    variables: { filter: Object.keys(filter).length > 0 ? filter : undefined, first: input.first ?? 25 },
    profile: "integration",
  });
  const result = response?.[listing.plural];
  if (!result || result.error) return [];
  return (result.data?.items ?? []).flatMap((item) => {
    const record = item.data;
    const value = record?.[valueField];
    if (!record || (typeof value !== "string" && typeof value !== "number")) return [];
    const label = renderTemplate(listing.displayTemplate, record);
    return [{ value: String(value), label: { en: label, nl: label } }];
  });
}
