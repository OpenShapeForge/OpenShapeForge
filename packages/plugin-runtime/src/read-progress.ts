// SPDX-License-Identifier: BUSL-1.1
/** Optional evidence snapshots while the original read request remains open. */
export const READ_PROGRESS_META_KEY = "openshapeforge/read-progress";
export type RuntimeReadProgressSnapshot = {
  data?: Readonly<Record<string, unknown>>;
  message?: string;
};
export type RuntimeReadProgress = RuntimeReadProgressSnapshot & {
  version: 1;
  readOnly: true;
  operationId: string;
  sequence: number;
};
export type RuntimeReadProgressServices<Session> = {
  /** False when no observer is active, the operation is not a read, or delivery is unavailable. */
  report(session: Session, snapshot: RuntimeReadProgressSnapshot): Promise<boolean>;
};
