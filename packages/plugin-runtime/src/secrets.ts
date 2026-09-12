// SPDX-License-Identifier: BUSL-1.1
/**
 * Secret encryption at rest — the shared platform primitive.
 *
 * Two subsystems hold credentials they must be able to use later but must never
 * disclose: connector configuration (credentials for other people's systems)
 * and API key integrations (the Keycloak client secret the customer never
 * sees). Both encrypt with AES-256-GCM, and the ciphertext record carries the
 * key id so a rotation can re-encrypt row by row while both keys are live.
 *
 * GCM is authenticated encryption: a tampered ciphertext fails to decrypt
 * rather than yielding attacker-chosen plaintext. A caller-supplied scope and
 * field are bound in as additional authenticated data, so a ciphertext cannot
 * be moved from one field or one owning row to another — a stolen row is
 * useless anywhere but where it came from.
 *
 * This module used to live in `connectors/`. The AAD construction is unchanged
 * from that version and must stay that way: altering it would make every
 * connector secret already at rest undecryptable.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export const SECRET_ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type SecretKeyring = {
  /** Key id used for new writes. */
  activeKeyId: string;
  /** All keys still able to decrypt, including the active one. */
  keys: ReadonlyMap<string, Buffer>;
};

export class SecretError extends Error {
  readonly code = "CONNECTOR_SECRET_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/**
 * Build a keyring from environment configuration.
 *
 * Format: `<keyId>:<base64 32-byte key>`, comma-separated, the first being
 * active. Keeping retired keys present is what makes rotation possible without
 * a downtime window.
 */
export function keyringFromEnv(raw: string | undefined): SecretKeyring | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const keys = new Map<string, Buffer>();
  let activeKeyId: string | undefined;

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) {
      throw new SecretError(
        "Secret key entry must be <keyId>:<base64 key>.",
      );
    }
    const keyId = trimmed.slice(0, separator);
    const material = Buffer.from(trimmed.slice(separator + 1), "base64");
    if (material.length !== KEY_BYTES) {
      throw new SecretError(
        `Secret key "${keyId}" must be ${KEY_BYTES} bytes (base64-encoded).`,
      );
    }
    if (keys.has(keyId)) {
      throw new SecretError(`Duplicate secret key id "${keyId}".`);
    }
    keys.set(keyId, material);
    activeKeyId ??= keyId;
  }

  if (!activeKeyId || keys.size === 0) return undefined;
  return { activeKeyId, keys };
}

export type StoredSecret = {
  ciphertext: string;
  keyId: string;
  algorithm: string;
};

/**
 * Bind a ciphertext to where it lives. Without this an operator (or an attacker
 * with write access) could copy the ciphertext of a low-value field into a
 * high-value one and have it decrypt cleanly.
 *
 * `scope` is the owning row's id (a connector installation, an API key
 * integration); `field` names the column within it. The separator is NUL so a
 * value containing spaces cannot shift the boundary between the two.
 */
function additionalData(scope: string, field: string): Buffer {
  // The separator is a NUL byte, assembled here rather than written as a source
  // literal. Byte-for-byte identical either way — but an embedded NUL makes git
  // treat this file as binary, and the module that encrypts credentials is the
  // last one whose diffs should read "Bin 6872 -> 8090 bytes" in review.
  return Buffer.concat([
    Buffer.from(scope, "utf8"),
    Buffer.from([0]),
    Buffer.from(field, "utf8"),
  ]);
}

export function encryptSecret(
  keyring: SecretKeyring,
  scope: string,
  field: string,
  plaintext: string,
): StoredSecret {
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) {
    throw new SecretError(
      `Active secret key "${keyring.activeKeyId}" is not in the keyring.`,
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(SECRET_ALGORITHM, key, iv);
  cipher.setAAD(additionalData(scope, field));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    // iv || tag || ciphertext, so the record is one opaque column value.
    ciphertext: Buffer.concat([iv, tag, encrypted]).toString("base64"),
    keyId: keyring.activeKeyId,
    algorithm: SECRET_ALGORITHM,
  };
}

export function decryptSecret(
  keyring: SecretKeyring,
  scope: string,
  field: string,
  stored: StoredSecret,
): string {
  if (stored.algorithm !== SECRET_ALGORITHM) {
    throw new SecretError(
      `Unsupported secret algorithm "${stored.algorithm}".`,
    );
  }
  const key = keyring.keys.get(stored.keyId);
  if (!key) {
    throw new SecretError(
      `Secret was encrypted with key "${stored.keyId}", which is not in the keyring.`,
    );
  }

  const raw = Buffer.from(stored.ciphertext, "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new SecretError("Secret ciphertext is truncated.");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const encrypted = raw.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(SECRET_ALGORITHM, key, iv);
  decipher.setAAD(additionalData(scope, field));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    // Never surface the underlying reason: it distinguishes a wrong key from a
    // tampered tag, which is an oracle.
    throw new SecretError(
      "Secret could not be decrypted (wrong key or tampered value).",
    );
  }
}

/** True when a secret needs re-encrypting under the active key. */
export function needsRotation(keyring: SecretKeyring, stored: StoredSecret): boolean {
  return stored.keyId !== keyring.activeKeyId;
}

/** Constant-time compare, for callers verifying a submitted secret. */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
