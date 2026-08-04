// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  SecretError,
  SECRET_SET_SENTINEL,
  decryptSecret,
  encryptSecret,
  keyringFromEnv,
  needsRotation,
  redactConfiguration,
  type SecretKeyring,
} from "../secrets.js";

function key(): string {
  return randomBytes(32).toString("base64");
}

const KEY_A = key();
const KEY_B = key();
const keyring = keyringFromEnv(`k1:${KEY_A}`)!;
const rotated = keyringFromEnv(`k2:${KEY_B},k1:${KEY_A}`)!;

const INSTALLATION = "11111111-1111-1111-1111-111111111111";

describe("keyring", () => {
  it("takes the first entry as active and keeps retired keys for decryption", () => {
    expect(rotated.activeKeyId).toBe("k2");
    expect([...rotated.keys.keys()].sort()).toEqual(["k1", "k2"]);
  });

  it("returns undefined when unconfigured, rather than inventing a key", () => {
    expect(keyringFromEnv(undefined)).toBeUndefined();
    expect(keyringFromEnv("   ")).toBeUndefined();
  });

  it("rejects malformed entries and wrong key sizes", () => {
    expect(() => keyringFromEnv("nokey")).toThrow(SecretError);
    expect(() => keyringFromEnv(`k1:${randomBytes(16).toString("base64")}`)).toThrow(
      /must be 32 bytes/,
    );
    expect(() => keyringFromEnv(`k1:${KEY_A},k1:${KEY_B}`)).toThrow(/Duplicate/);
  });
});

describe("encryption round trip", () => {
  it("decrypts what it encrypted", () => {
    const stored = encryptSecret(keyring, INSTALLATION, "apiKey", "s3cr3t-value");
    expect(stored.algorithm).toBe("aes-256-gcm");
    expect(decryptSecret(keyring, INSTALLATION, "apiKey", stored)).toBe("s3cr3t-value");
  });

  it("never stores the plaintext", () => {
    const stored = encryptSecret(keyring, INSTALLATION, "apiKey", "s3cr3t-value");
    expect(stored.ciphertext).not.toContain("s3cr3t");
    expect(Buffer.from(stored.ciphertext, "base64").toString("utf8")).not.toContain("s3cr3t");
  });

  it("produces a different ciphertext each time for the same plaintext", () => {
    const a = encryptSecret(keyring, INSTALLATION, "apiKey", "same");
    const b = encryptSecret(keyring, INSTALLATION, "apiKey", "same");
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });
});

describe("binding and tampering", () => {
  // The point of the AAD: a stolen ciphertext is useless anywhere but where it
  // came from.
  it("refuses a ciphertext moved to another field", () => {
    const stored = encryptSecret(keyring, INSTALLATION, "lowValue", "v");
    expect(() => decryptSecret(keyring, INSTALLATION, "apiKey", stored)).toThrow(
      /wrong key or tampered/,
    );
  });

  it("refuses a ciphertext moved to another installation", () => {
    const stored = encryptSecret(keyring, INSTALLATION, "apiKey", "v");
    const otherInstallation = "22222222-2222-2222-2222-222222222222";
    expect(() => decryptSecret(keyring, otherInstallation, "apiKey", stored)).toThrow(
      /wrong key or tampered/,
    );
  });

  it("refuses a tampered ciphertext rather than returning garbage", () => {
    const stored = encryptSecret(keyring, INSTALLATION, "apiKey", "v");
    const bytes = Buffer.from(stored.ciphertext, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    expect(() =>
      decryptSecret(keyring, INSTALLATION, "apiKey", {
        ...stored,
        ciphertext: bytes.toString("base64"),
      }),
    ).toThrow(/wrong key or tampered/);
  });

  // Distinguishing "wrong key" from "tampered" would be an oracle.
  it("gives the same message for a wrong key as for tampering", () => {
    const stored = encryptSecret(keyring, INSTALLATION, "apiKey", "v");
    const foreign: SecretKeyring = keyringFromEnv(`k1:${KEY_B}`)!;
    expect(() => decryptSecret(foreign, INSTALLATION, "apiKey", stored)).toThrow(
      /wrong key or tampered/,
    );
  });

  it("rejects a truncated ciphertext", () => {
    expect(() =>
      decryptSecret(keyring, INSTALLATION, "apiKey", {
        ciphertext: Buffer.from("short").toString("base64"),
        keyId: "k1",
        algorithm: "aes-256-gcm",
      }),
    ).toThrow(/truncated/);
  });

  it("rejects an unsupported algorithm instead of guessing", () => {
    expect(() =>
      decryptSecret(keyring, INSTALLATION, "apiKey", {
        ciphertext: "x",
        keyId: "k1",
        algorithm: "rot13",
      }),
    ).toThrow(/Unsupported/);
  });
});

describe("rotation", () => {
  it("decrypts an old-key secret while writing new ones under the active key", () => {
    const old = encryptSecret(keyring, INSTALLATION, "apiKey", "old-value");
    expect(decryptSecret(rotated, INSTALLATION, "apiKey", old)).toBe("old-value");
    expect(needsRotation(rotated, old)).toBe(true);

    const fresh = encryptSecret(rotated, INSTALLATION, "apiKey", "new-value");
    expect(fresh.keyId).toBe("k2");
    expect(needsRotation(rotated, fresh)).toBe(false);
  });

  it("reports a missing key clearly instead of failing as tampering", () => {
    const stored = encryptSecret(rotated, INSTALLATION, "apiKey", "v");
    expect(() => decryptSecret(keyring, INSTALLATION, "apiKey", stored)).toThrow(
      /not in the keyring/,
    );
  });
});

describe("redaction", () => {
  it("replaces set secrets with a sentinel and omits unset ones", () => {
    const redacted = redactConfiguration(
      { endpoint: "https://example.test", apiKey: "leaked", token: "also-leaked" },
      ["apiKey", "token"],
      new Set(["apiKey"]),
    );
    expect(redacted).toEqual({
      endpoint: "https://example.test",
      apiKey: SECRET_SET_SENTINEL,
    });
    expect(JSON.stringify(redacted)).not.toContain("leaked");
  });

  it("removes a secret value even when the caller never marked it as set", () => {
    const redacted = redactConfiguration({ apiKey: "leaked" }, ["apiKey"], new Set());
    expect(redacted.apiKey).toBeUndefined();
  });
});
