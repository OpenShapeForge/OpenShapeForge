// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import {
  activeTenantGrants,
  resolveAvailability,
  verifyLicenseToken,
  type ConnectorAvailability,
} from "../entitlements.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const OTHER_PEM = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();

const NOW = 1_800_000_000_000;

function issue(claims: Record<string, unknown>, key = privateKey): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8");
  const signature = signEd25519(null, payload, key);
  return `${payload.toString("base64url")}.${signature.toString("base64url")}`;
}

describe("license verification", () => {
  it("accepts a well-formed, signed, unexpired license", () => {
    const token = issue({ entitlements: ["connector.object-store"], expiresAt: NOW + 1000 });
    const status = verifyLicenseToken(token, PUBLIC_PEM, NOW);
    expect(status.valid).toBe(true);
    if (status.valid) {
      expect(status.license.entitlements).toEqual(["connector.object-store"]);
    }
  });

  it("accepts a license with no expiry", () => {
    const status = verifyLicenseToken(issue({ entitlements: ["a"] }), PUBLIC_PEM, NOW);
    expect(status.valid).toBe(true);
  });

  // Each of these must yield the empty entitlement set, never a pass.
  it("fails closed on every rejection path", () => {
    const cases: [string, string | undefined, string | undefined][] = [
      ["absent", undefined, PUBLIC_PEM],
      ["no_public_key", issue({ entitlements: ["a"] }), undefined],
      ["malformed", "not-a-token", PUBLIC_PEM],
      ["malformed", "onlyonepart", PUBLIC_PEM],
      ["expired", issue({ entitlements: ["a"], expiresAt: NOW - 1 }), PUBLIC_PEM],
    ];
    for (const [reason, token, key] of cases) {
      const status = verifyLicenseToken(token, key, NOW);
      expect(status.valid).toBe(false);
      if (!status.valid) expect(status.reason).toBe(reason as never);
    }
  });

  it("rejects a license signed by a different key", () => {
    const status = verifyLicenseToken(issue({ entitlements: ["a"] }), OTHER_PEM, NOW);
    expect(status.valid).toBe(false);
    if (!status.valid) expect(status.reason).toBe("unverified_signature");
  });

  // The payload is verified as bytes before it is parsed, so tampering with
  // claims invalidates the signature rather than reaching JSON.parse.
  it("rejects a token whose claims were edited after signing", () => {
    const original = issue({ entitlements: ["cheap"] });
    const [, signature] = original.split(".");
    const forged = Buffer.from(JSON.stringify({ entitlements: ["expensive"] }), "utf8")
      .toString("base64url");
    const status = verifyLicenseToken(`${forged}.${signature}`, PUBLIC_PEM, NOW);
    expect(status.valid).toBe(false);
    if (!status.valid) expect(status.reason).toBe("unverified_signature");
  });

  it("rejects a license issued for another deployment", () => {
    const token = issue({ entitlements: ["a"], deployment: "prod-eu" });
    const status = verifyLicenseToken(token, PUBLIC_PEM, NOW, "prod-us");
    expect(status.valid).toBe(false);
    if (!status.valid) expect(status.reason).toBe("wrong_deployment");
  });

  it("rejects claims of the wrong shape", () => {
    for (const claims of [
      { entitlements: "a" },
      { entitlements: [1, 2] },
      { entitlements: ["a"], expiresAt: "soon" },
      { notEntitlements: ["a"] },
    ]) {
      const status = verifyLicenseToken(issue(claims), PUBLIC_PEM, NOW);
      expect(status.valid).toBe(false);
      if (!status.valid) expect(status.reason).toBe("malformed");
    }
  });
});

describe("tenant grants", () => {
  it("treats an absent expiry as permanent and a past one as gone", () => {
    const grants = activeTenantGrants(
      [
        { entitlement: "permanent", expires_at: null },
        { entitlement: "future", expires_at: new Date(NOW + 1000) },
        { entitlement: "past", expires_at: new Date(NOW - 1000) },
      ],
      NOW,
    );
    expect([...grants].sort()).toEqual(["future", "permanent"]);
  });

  it("treats an unparseable expiry as expired rather than permanent", () => {
    const grants = activeTenantGrants(
      [{ entitlement: "broken", expires_at: "not-a-date" }],
      NOW,
    );
    expect(grants.has("broken")).toBe(false);
  });
});

describe("availability", () => {
  const base = {
    requiredEntitlement: "connector.object-store",
    licensed: new Set(["connector.object-store"]),
    tenantGrants: new Set(["connector.object-store"]),
    packageInstalled: true,
    configured: true,
    enabled: true,
  };

  it("is available only when both axes agree and the rest lines up", () => {
    expect(resolveAvailability(base)).toBe("AVAILABLE");
  });

  // Neither axis may widen the other.
  it("requires the deployment license AND the tenant grant", () => {
    expect(resolveAvailability({ ...base, licensed: new Set() })).toBe("NOT_LICENSED");
    expect(resolveAvailability({ ...base, tenantGrants: new Set() })).toBe("NOT_LICENSED");
  });

  it("needs no entitlement when the contract requires none", () => {
    const { requiredEntitlement: _none, ...noEntitlement } = base;
    const status: ConnectorAvailability = resolveAvailability({
      ...noEntitlement,
      licensed: new Set(),
      tenantGrants: new Set(),
    });
    expect(status).toBe("AVAILABLE");
  });

  // Reporting NOT_INSTALLED to an unlicensed caller would disclose which
  // packages the deployment ships.
  it("reports NOT_LICENSED before NOT_INSTALLED", () => {
    expect(
      resolveAvailability({ ...base, licensed: new Set(), packageInstalled: false }),
    ).toBe("NOT_LICENSED");
  });

  it("distinguishes not-installed, not-configured and disabled", () => {
    expect(resolveAvailability({ ...base, packageInstalled: false })).toBe("NOT_INSTALLED");
    expect(resolveAvailability({ ...base, configured: false })).toBe("NOT_CONFIGURED");
    expect(resolveAvailability({ ...base, enabled: false })).toBe("DISABLED");
  });
});
