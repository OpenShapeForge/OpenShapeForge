// SPDX-License-Identifier: BUSL-1.1
import type { EntityManifestEntry } from "@/compiler/entity-manifest";
import type { RealtimeResourceKey } from "@/features/realtime/lib/resource-keys";

type RealtimeResourceConfig = {
  realtimeResourceType?: string;
};

export function defaultEntityRealtimeResourceType(entityName: string): string {
  if (!entityName) {
    return entityName;
  }

  return `${entityName.slice(0, 1).toLowerCase()}${entityName.slice(1)}`;
}

export function resolveEntityRealtimeResourceType(
  entry: Pick<EntityManifestEntry, "entityName"> & Partial<Pick<EntityManifestEntry, "realtimeResourceType">>,
  config?: RealtimeResourceConfig | null,
): string {
  const configured = config?.realtimeResourceType?.trim();
  if (configured) {
    return configured;
  }

  const fromManifest = entry.realtimeResourceType?.trim();
  if (fromManifest) {
    return fromManifest;
  }

  return defaultEntityRealtimeResourceType(entry.entityName);
}

export function buildEntityListRealtimeKey(
  realtimeResourceType: string,
  scope: string,
): RealtimeResourceKey {
  return `entity-list:${realtimeResourceType}:${scope}`;
}

export function buildEntityDetailRealtimeKey(
  realtimeResourceType: string,
  entityId: string,
): RealtimeResourceKey {
  return `entity:${realtimeResourceType}:${entityId}`;
}
