// @ts-nocheck
import { createHash } from "node:crypto";
import type { DesignerDetailRegistryEntry, DesignerLazyRegistryEntry, RuntimeRegistryEntry } from "./types.js";

// Joins the palette (lazy) and detail registry arrays by `type` into the
// entity catalog seed payload consumed by the Postgres seed step
// (apps/api/src/db/seeds/global/workflow-node-catalog.ts, catalog='entity').
// label/description come from the palette entry; configFields/defaultOutputFields
// come from the detail entry. The checksum is the sha256 of the serialized
// joined entries so the seed step can checksum-skip idempotently.
export function buildEntityCatalogSeedJson(
  lazyEntries: DesignerLazyRegistryEntry[],
  detailEntries: DesignerDetailRegistryEntry[],
) {
  const detailByType = new Map<string, DesignerDetailRegistryEntry>();
  for (const detail of detailEntries) detailByType.set(detail.type, detail);

  const entries = lazyEntries.map((lazy) => {
    const detail = detailByType.get(lazy.type);
    return {
      nodeType: lazy.type,
      action: lazy.action,
      category: lazy.category,
      label: lazy.label,
      description: lazy.description,
      defaultConfig: lazy.defaultConfig,
      configFields: detail?.configFields ?? [],
      defaultOutputFields: detail?.defaultOutputFields ?? [],
    };
  });

  const serializedEntries = JSON.stringify(entries);
  const checksum = createHash("sha256").update(serializedEntries).digest("hex");
  return `${JSON.stringify({ checksum, catalog: "entity", entries })}\n`;
}

// The API bridge registration (generated-entity-bridges.ts) only needs a tiny
// routing index — type/module/entity/entityKey/action. Entity nodes carry no
// heavier Field[]/error-route payload (the live handle model in
// shared/error-routes.ts exposes only success/list-count handles), so the
// index is the whole artifact and stays ~KB.
export function buildWorkflowBridgeIndexJson(entries: RuntimeRegistryEntry[]) {
  const index = entries.map(({ type, module, entity, entityKey, action }) => ({
    type,
    module,
    entity,
    entityKey,
    action,
  }));
  return `${JSON.stringify(index)}\n`;
}
