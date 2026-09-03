// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector-side secret handling.
 *
 * The encryption primitive itself lives in `../platform/secrets.js` — it is
 * shared with API key integrations, which encrypt a Keycloak client secret the
 * same way. What stays here is the part that is genuinely about connector
 * CONFIGURATION rather than about cryptography: the sentinel a read path
 * returns in place of a secret, and the redaction that applies it.
 *
 * The crypto names are re-exported so connector call sites keep importing from
 * one place.
 */
export {
  SECRET_ALGORITHM,
  SecretError,
  encryptSecret,
  decryptSecret,
  keyringFromEnv,
  needsRotation,
  secretsEqual,
  type SecretKeyring,
  type StoredSecret,
} from "../platform/secrets.js";

/**
 * What a configuration read returns in place of a secret. A sentinel rather
 * than an empty string, so a client can tell "set, not shown" from "not set"
 * and a round-tripped form does not silently blank a credential.
 */
export const SECRET_SET_SENTINEL = "__set__";

const MAX_ELICITED_VALUE_JSON_DEPTH = 64;

function looksLikeStoredSecret(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const has = (key: string) =>
    Object.prototype.hasOwnProperty.call(candidate, key);
  return has("ciphertext") || (has("keyId") && has("algorithm"));
}

function projectElicitedValue(value: unknown, depth: number): unknown {
  if (looksLikeStoredSecret(value)) return SECRET_SET_SENTINEL;
  if (Array.isArray(value)) {
    if (depth >= MAX_ELICITED_VALUE_JSON_DEPTH) {
      return SECRET_SET_SENTINEL;
    }
    return value.map((entry) => projectElicitedValue(entry, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    if (depth >= MAX_ELICITED_VALUE_JSON_DEPTH) {
      return SECRET_SET_SENTINEL;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        projectElicitedValue(entry, depth + 1),
      ]),
    );
  }
  return value;
}

/**
 * Replace encrypted or suspiciously envelope-shaped elicited values with the
 * existing set marker while preserving ordinary sibling values. Treat a
 * partial envelope as secret too: returning malformed ciphertext or key
 * metadata would turn storage corruption into a disclosure. This is the
 * single representation used by every generated CRUD transport.
 */
export function redactElicitedValues(
  row: Record<string, unknown>,
  intoField: string,
): Record<string, unknown> {
  const values = row[intoField];
  if (typeof values !== "object" || values === null) return row;
  return { ...row, [intoField]: projectElicitedValue(values, 0) };
}

/**
 * Narrow decrypted secrets to the ones a contract declares.
 *
 * `readSecrets` answers with every row stored against an installation, which is
 * the right shape for a rotation walk and the wrong shape for an invocation.
 * The context this feeds promises a package "only the secrets this connector's
 * own contract declares" — and until this existed, that promise held only
 * because `configureConnector` rejects unknown keys, so no other row could be
 * written. True by construction is not the same as enforced, and the difference
 * starts to matter the moment the PLATFORM stores its own fields against an
 * installation: OAuth tokens the connector must never see are exactly that.
 *
 * Filtering here rather than in `readSecrets` keeps rotation able to see
 * everything it must re-encrypt, including platform-managed rows.
 */
export function contractSecrets(
  secrets: Record<string, string>,
  declaredSecretFields: readonly string[],
): Record<string, string> {
  const allowed = new Set(declaredSecretFields);
  const narrowed: Record<string, string> = {};
  for (const [field, value] of Object.entries(secrets)) {
    if (allowed.has(field)) narrowed[field] = value;
  }
  return narrowed;
}

/**
 * Strip secret values out of a configuration object for any read path.
 *
 * Applied by construction rather than by remembering: a caller passes the
 * contract's secret field list, and every one of them is replaced.
 */
export function redactConfiguration(
  config: Record<string, unknown>,
  secretFields: readonly string[],
  setFields: ReadonlySet<string>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = { ...config };
  for (const field of secretFields) {
    delete redacted[field];
    if (setFields.has(field)) {
      redacted[field] = SECRET_SET_SENTINEL;
    }
  }
  return redacted;
}
