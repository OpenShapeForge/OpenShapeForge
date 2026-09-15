// SPDX-License-Identifier: BUSL-1.1
/** Opaque, host-minted binding to one verified bearer login session. */
import { createHmac } from "node:crypto";
import { DEV_CONTEXT_SECRET_DEFAULT } from "../config/production-guard.js";

const MIN_SECRET_LENGTH = 32;
const MIN_DISTINCT_CHARACTERS = 8;

export function cryptographicallyUsableContextSecret(
  value: string | undefined = process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET,
): string | undefined {
  const secret = value?.trim();
  if (
    !secret ||
    secret === DEV_CONTEXT_SECRET_DEFAULT ||
    secret.length < MIN_SECRET_LENGTH ||
    new Set(secret).size < MIN_DISTINCT_CHARACTERS
  ) {
    return undefined;
  }
  return secret;
}

export function loginSessionBindingFromClaims(
  claims: Readonly<Record<string, unknown>>,
  options: { secret?: string } = {},
): string | undefined {
  const sid = typeof claims.sid === "string" ? claims.sid.trim() : "";
  const secret = cryptographicallyUsableContextSecret(
    options.secret ?? process.env.OPENSHAPEFORGE_INTERNAL_CONTEXT_SECRET,
  );
  if (!sid || !secret) return undefined;

  const digest = createHmac("sha256", secret)
    .update("openshapeforge:login-session-binding:v1\0")
    .update(sid)
    .digest("base64url");
  return `lsb1.${digest}`;
}
