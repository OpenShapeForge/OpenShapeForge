// SPDX-License-Identifier: BUSL-1.1
/**
 * Connector entitlement resolution.
 *
 * Two axes, and both must agree:
 *
 *   the deployment LICENSE  — an Ed25519-signed document listing the
 *                             entitlement keys this deployment may offer at all
 *   the tenant GRANT        — rows in platform.connector_entitlements saying
 *                             which tenant actually has which
 *
 * Effective availability is the intersection. Neither axis can widen the other:
 * a forged entitlement row cannot grant what the deployment is not licensed
 * for, and a shared license cannot give a tenant something nobody granted it.
 *
 * Everything here fails closed. An absent, malformed, expired or unverifiable
 * license yields the empty set, which makes exactly the connectors that require
 * no entitlement available — never all of them. Nothing a tenant can influence
 * (a header, a config value, a connector's own contract) participates in
 * verification.
 */
import { verify as verifyEd25519 } from "node:crypto";

/** Parsed, verified license claims. */
export type DeploymentLicense = {
  /** Entitlement keys this deployment may offer. */
  entitlements: string[];
  /** Epoch milliseconds; a license without one never expires. */
  expiresAt?: number;
  /** Deployment this license was issued for, if it is pinned to one. */
  deployment?: string;
};

export type LicenseStatus =
  | { valid: true; license: DeploymentLicense }
  | { valid: false; reason: LicenseRejection };

export type LicenseRejection =
  | "absent"
  | "malformed"
  | "unverified_signature"
  | "expired"
  | "wrong_deployment"
  | "no_public_key";

/**
 * A license token is `<base64url(payload)>.<base64url(signature)>`.
 *
 * The payload is verified as RAW BYTES before it is parsed, so a malformed or
 * hostile payload never reaches JSON.parse on an unverified path.
 */
export function verifyLicenseToken(
  token: string | undefined,
  publicKeyPem: string | undefined,
  now: number,
  expectedDeployment?: string,
): LicenseStatus {
  if (!token) return { valid: false, reason: "absent" };
  if (!publicKeyPem) return { valid: false, reason: "no_public_key" };

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "malformed" };
  }

  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = Buffer.from(parts[0], "base64url");
    signature = Buffer.from(parts[1], "base64url");
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (payloadBytes.length === 0 || signature.length === 0) {
    return { valid: false, reason: "malformed" };
  }

  let signatureOk: boolean;
  try {
    signatureOk = verifyEd25519(null, payloadBytes, publicKeyPem, signature);
  } catch {
    // A bad key, a wrong algorithm, a truncated signature: all unverifiable.
    return { valid: false, reason: "unverified_signature" };
  }
  if (!signatureOk) return { valid: false, reason: "unverified_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { valid: false, reason: "malformed" };
  }

  const claims = parsed as {
    entitlements?: unknown;
    expiresAt?: unknown;
    deployment?: unknown;
  };
  if (
    !Array.isArray(claims.entitlements) ||
    claims.entitlements.some((entry) => typeof entry !== "string")
  ) {
    return { valid: false, reason: "malformed" };
  }
  if (claims.expiresAt !== undefined && typeof claims.expiresAt !== "number") {
    return { valid: false, reason: "malformed" };
  }
  if (claims.deployment !== undefined && typeof claims.deployment !== "string") {
    return { valid: false, reason: "malformed" };
  }

  if (typeof claims.expiresAt === "number" && claims.expiresAt <= now) {
    return { valid: false, reason: "expired" };
  }
  if (
    expectedDeployment !== undefined &&
    claims.deployment !== undefined &&
    claims.deployment !== expectedDeployment
  ) {
    return { valid: false, reason: "wrong_deployment" };
  }

  return {
    valid: true,
    license: {
      entitlements: [...new Set(claims.entitlements as string[])].sort(),
      ...(typeof claims.expiresAt === "number" ? { expiresAt: claims.expiresAt } : {}),
      ...(typeof claims.deployment === "string" ? { deployment: claims.deployment } : {}),
    },
  };
}

export type ConnectorAvailability =
  | "AVAILABLE"
  | "NOT_LICENSED"
  | "NOT_INSTALLED"
  | "NOT_CONFIGURED"
  | "DISABLED";

export type AvailabilityInput = {
  /** The connector's required entitlement key, if it has one. */
  requiredEntitlement?: string;
  /** Entitlements this deployment's verified license permits. */
  licensed: ReadonlySet<string>;
  /** Entitlements granted to this tenant (unexpired rows). */
  tenantGrants: ReadonlySet<string>;
  /** Whether the implementation package resolved at boot. */
  packageInstalled: boolean;
  /** Whether this tenant has a configured installation. */
  configured: boolean;
  /** Whether that installation is enabled. */
  enabled: boolean;
};

/**
 * Resolve what a tenant may do with a connector right now.
 *
 * Order matters and is deliberate: entitlement is checked FIRST, so an
 * unlicensed connector reports NOT_LICENSED whether or not the package happens
 * to be installed. Reporting NOT_INSTALLED for something the tenant is not
 * licensed for would leak which packages a deployment ships.
 */
export function resolveAvailability(input: AvailabilityInput): ConnectorAvailability {
  const required = input.requiredEntitlement;
  if (required !== undefined) {
    // Both axes, intersected. Either one alone is not enough.
    if (!input.licensed.has(required) || !input.tenantGrants.has(required)) {
      return "NOT_LICENSED";
    }
  }
  if (!input.packageInstalled) return "NOT_INSTALLED";
  if (!input.configured) return "NOT_CONFIGURED";
  if (!input.enabled) return "DISABLED";
  return "AVAILABLE";
}

/** Rows as stored; expiry is applied here so callers cannot forget to. */
export function activeTenantGrants(
  rows: readonly { entitlement: string; expires_at: Date | string | null }[],
  now: number,
): Set<string> {
  const active = new Set<string>();
  for (const row of rows) {
    if (row.expires_at === null || row.expires_at === undefined) {
      active.add(row.entitlement);
      continue;
    }
    const expiry =
      row.expires_at instanceof Date
        ? row.expires_at.getTime()
        : Date.parse(String(row.expires_at));
    // An unparseable expiry is treated as expired, not as "never expires".
    if (Number.isFinite(expiry) && expiry > now) {
      active.add(row.entitlement);
    }
  }
  return active;
}
