// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  SECRET_ALGORITHM,
  SecretError,
  decryptSecret,
  encryptSecret,
  keyringFromEnv,
  needsRotation,
  secretsEqual,
  type SecretKeyring,
} from "./secrets.js";

const material = () => randomBytes(32).toString("base64");
const KEY_A = material();
const KEY_B = material();
const original = keyringFromEnv(`old:${KEY_A}`)!;
const rotated = keyringFromEnv(`active:${KEY_B},old:${KEY_A}`)!;

describe("plugin runtime secret keyring", () => {
  test("requires valid, unique 32-byte keys and uses the first key for writes", () => {
    expect(keyringFromEnv(undefined)).toBeUndefined();
    expect(() => keyringFromEnv("missing-separator")).toThrow(SecretError);
    expect(() => keyringFromEnv(`short:${randomBytes(8).toString("base64")}`)).toThrow(/32 bytes/);
    expect(() => keyringFromEnv(`same:${KEY_A},same:${KEY_B}`)).toThrow(/Duplicate/);
    expect(rotated.activeKeyId).toBe("active");
  });
});

describe("plugin runtime authenticated secret encryption", () => {
  test("round-trips without embedding plaintext and uses a fresh nonce", () => {
    const first = encryptSecret(original, "installation-a", "apiKey", "highly-secret");
    const second = encryptSecret(original, "installation-a", "apiKey", "highly-secret");

    expect(first.algorithm).toBe(SECRET_ALGORITHM);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(Buffer.from(first.ciphertext, "base64").toString("utf8")).not.toContain("highly-secret");
    expect(decryptSecret(original, "installation-a", "apiKey", first)).toBe("highly-secret");
  });

  test("binds ciphertext to its owning scope and field", () => {
    const stored = encryptSecret(original, "installation-a", "apiKey", "secret");

    expect(() => decryptSecret(original, "installation-b", "apiKey", stored)).toThrow(/wrong key or tampered/);
    expect(() => decryptSecret(original, "installation-a", "password", stored)).toThrow(/wrong key or tampered/);
  });

  test("rejects tampering without exposing whether the key or ciphertext was wrong", () => {
    const stored = encryptSecret(original, "installation-a", "apiKey", "secret");
    const bytes = Buffer.from(stored.ciphertext, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    const tampered = { ...stored, ciphertext: bytes.toString("base64") };
    const wrongKey: SecretKeyring = keyringFromEnv(`old:${KEY_B}`)!;

    expect(() => decryptSecret(original, "installation-a", "apiKey", tampered)).toThrow(
      "Secret could not be decrypted (wrong key or tampered value).",
    );
    expect(() => decryptSecret(wrongKey, "installation-a", "apiKey", stored)).toThrow(
      "Secret could not be decrypted (wrong key or tampered value).",
    );
  });

  test("keeps retired keys readable and marks their values for rotation", () => {
    const old = encryptSecret(original, "installation-a", "apiKey", "secret");
    expect(decryptSecret(rotated, "installation-a", "apiKey", old)).toBe("secret");
    expect(needsRotation(rotated, old)).toBe(true);

    const fresh = encryptSecret(rotated, "installation-a", "apiKey", "secret");
    expect(needsRotation(rotated, fresh)).toBe(false);
  });

  test("compares equal secrets and refuses unequal lengths", () => {
    expect(secretsEqual("same", "same")).toBe(true);
    expect(secretsEqual("same", "different")).toBe(false);
  });
});
