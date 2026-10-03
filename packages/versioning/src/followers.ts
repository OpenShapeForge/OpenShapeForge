// SPDX-License-Identifier: BUSL-1.1
/**
 * Publish followers: work another module runs inside the same transaction
 * right after `publish()` stored a new immutable version. The documents module
 * uses this to move documents to a republished Template
 * (docs/document-content.md). Registration happens at module load; there is
 * no request-time lookup by name.
 */
import type { PluginPlatformServices, PluginSessionContext } from "@openshapeforge/plugin-runtime";

export type PublishedVersionRow = Readonly<Record<string, unknown>> & { readonly id: string };

export type PublishFollowerContext = {
  /** The open publish transaction; run every follower query on it. */
  readonly transaction: unknown;
  readonly session: PluginSessionContext;
  readonly platform: PluginPlatformServices;
  readonly sourceEntity: string;
  readonly versionEntity: string;
  readonly sourceId: string;
  /** The version row `publish()` just inserted. */
  readonly version: PublishedVersionRow;
  /** The version the source pointed at before this publish, if any. */
  readonly previousVersionId: string | null;
};

export type PublishFollower = (context: PublishFollowerContext) => Promise<void>;

const followers = new Map<string, PublishFollower[]>();

/** Registers a follower for one source entity; returns the matching unregister. */
export function registerPublishFollower(sourceEntity: string, follower: PublishFollower): () => void {
  const list = followers.get(sourceEntity) ?? [];
  list.push(follower);
  followers.set(sourceEntity, list);
  return () => {
    const current = followers.get(sourceEntity) ?? [];
    const index = current.indexOf(follower);
    if (index >= 0) current.splice(index, 1);
  };
}

export function publishFollowers(sourceEntity: string): readonly PublishFollower[] {
  return [...(followers.get(sourceEntity) ?? [])];
}
