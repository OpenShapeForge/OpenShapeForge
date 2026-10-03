// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { lockedError, UNNAMED_LOCK_TEXT } from "./edit-lease-locked.js";

const expires_at = "2030-01-01T12:00:00.000Z";

test("a named lease holder travels as data, for the client to word in the viewer's language", () => {
  expect(lockedError({ owner_display_name: " Vera Verkoper ", expires_at })).toEqual({
    code: "LOCKED",
    message: "This record is currently being edited by Vera Verkoper.",
    detail: `Their edit lease remains valid until ${expires_at}.`,
    retryable: true,
    retryAt: expires_at,
    data: { ownerDisplayName: "Vera Verkoper" },
  });
});

test("an unnamed lease carries bilingual text, so no client shows the English fallback (#948)", () => {
  for (const owner_display_name of [null, "   "]) {
    const error = lockedError({ owner_display_name, expires_at });
    expect(error.message).toBe("This record is currently being edited by another user.");
    expect(error.data).toEqual({ localized: { en: UNNAMED_LOCK_TEXT.en, nl: UNNAMED_LOCK_TEXT.nl } });
  }
});
