// SPDX-License-Identifier: BUSL-1.1
import type { FieldValuePolicy } from "@openshapeforge/operations";

export function visitFieldPolicyWriters(policy: FieldValuePolicy, path: string,
  visit: (path: string, writers: string[]) => void): void {
  if (policy.writtenBy?.length) visit(path, policy.writtenBy);
  for (const [key, child] of Object.entries(policy.children ?? {})) {
    visitFieldPolicyWriters(child, `${path}.${key}`, visit);
  }
  if (policy.item) visitFieldPolicyWriters(policy.item, `${path}[]`, visit);
}
