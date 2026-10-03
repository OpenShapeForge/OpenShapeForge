// SPDX-License-Identifier: BUSL-1.1
/**
 * The LOCKED refusal for a record another person holds the edit lease on.
 *
 * With a real holder name the error carries `ownerDisplayName`, and a client
 * words the sentence itself in the viewer's language. Without one it carries
 * the runtime's bilingual `data.localized` (the convention of
 * authorization-refusal-text.ts), so no client shows the English fallback
 * `message` to a Dutch reader (#948).
 */
import type { OperationError } from "@openshapeforge/operations";

export const UNNAMED_LOCK_TEXT = {
  en: "Someone else is currently editing this record.",
  nl: "Iemand anders bewerkt dit record op dit moment.",
} as const;

export function lockedError(row: { owner_display_name: string | null; expires_at: Date | string }): OperationError {
  const name = row.owner_display_name?.trim() || undefined;
  const expiresAt = new Date(row.expires_at).toISOString();
  return {
    code: "LOCKED",
    message: `This record is currently being edited by ${name ?? "another user"}.`,
    detail: `Their edit lease remains valid until ${expiresAt}.`,
    retryable: true,
    retryAt: expiresAt,
    data: name ? { ownerDisplayName: name } : { localized: { ...UNNAMED_LOCK_TEXT } },
  };
}
