// SPDX-License-Identifier: BUSL-1.1
export interface OwnedDeleteStep {
  entity: string;
  table: string;
  parent?: { entity: string; column: string };
  collection?: string;
  childAuthorization?: "owner";
  childLock?: string;
  discover: string;
  lock: string;
  remove: string;
}

export interface OwnedDeleteUnlink {
  entity: string;
  field: string;
  column: string;
  target: string;
  discover: string;
  lock: string;
  change: string;
}

export interface OwnedDeleteForeignKey {
  source: string;
  target: string;
  sourceColumns: string[];
  targetColumns: string[];
}

export interface OwnedDeleteBlocker {
  target: string;
  source?: string;
  query: string;
}

export interface OwnedDeletePlan {
  root: string;
  discover: readonly OwnedDeleteStep[];
  lockOrder: readonly string[];
  writeOrder: readonly string[];
  unlinks: readonly OwnedDeleteUnlink[];
  foreignKeys: readonly OwnedDeleteForeignKey[];
  blockers: readonly OwnedDeleteBlocker[];
  hierarchies: readonly { entity: string; column: string }[];
  resultCounts: Readonly<Record<string, string>>;
}
