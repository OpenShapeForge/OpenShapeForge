// SPDX-License-Identifier: BUSL-1.1
import type {
  WebCollectionView,
  WebEntityInterface,
  WebManifestV1,
  WebRecordView,
  WebViewMode,
} from "./contract.js";

export type WebRouteMatch = {
  entity: WebEntityInterface;
  view: WebCollectionView | WebRecordView;
  mode: WebViewMode;
  params: Readonly<Record<string, string>>;
};

function segments(path: string): string[] {
  return path.split("?")[0]!.split("/").filter(Boolean);
}

function matchPattern(pattern: string, pathname: string): Readonly<Record<string, string>> | null {
  const expectedParts = segments(pattern);
  const actualParts = segments(pathname);
  if (expectedParts.length !== actualParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expectedParts.length; index += 1) {
    const expected = expectedParts[index]!;
    const actual = actualParts[index]!;
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

/** Match static create routes before parameterized record routes. */
export function matchWebRoute(manifest: WebManifestV1, pathname: string): WebRouteMatch | null {
  const entities = Object.values(manifest.entities)
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  for (const entity of entities) {
    const record = entity.views.record;
    if (record?.routes.create) {
      const params = matchPattern(record.routes.create, pathname);
      if (params) return { entity, view: record, mode: "create", params };
    }
    const collectionParams = matchPattern(entity.views.collection.route, pathname);
    if (collectionParams) {
      return { entity, view: entity.views.collection, mode: "read", params: collectionParams };
    }
    if (record?.routes.read) {
      const params = matchPattern(record.routes.read, pathname);
      if (params) return { entity, view: record, mode: "read", params };
    }
  }
  return null;
}
