// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "bun:test";
import { describeContractDrift, isUsable, type InstallationRecord } from "../status.js";
import type { ConnectorContract } from "../catalog.js";

function contract(overrides: Partial<ConnectorContract> = {}): ConnectorContract {
  return {
    slug: "object-store",
    connector: "ObjectStore",
    title: "Object storage",
    domains: [],
    capabilities: ["operations"],
    implementation: {
      package: "@scope/pkg",
      contractVersion: 1,
      provenance: "firstParty",
      license: { spdx: "MIT" },
    },
    availability: {},
    configuration: {
      instances: "single",
      verify: false,
      fields: [
        { key: "endpoint", required: true },
        { key: "region" },
        { key: "apiKey", secret: true, required: true },
      ],
      secretFields: ["apiKey"],
      schema: {},
    },
    network: { egress: [] },
    operations: [],
    exposure: { graphql: true },
    namespace: "objectStore",
    checksum: "checksum-v1",
    ...overrides,
  } as ConnectorContract;
}

function installation(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    connectorSlug: "object-store",
    instanceKey: "default",
    config: { endpoint: "https://store.example", region: "eu-west" },
    enabled: true,
    contractVersion: 1,
    contractChecksum: "checksum-v1",
    ...overrides,
  };
}

const HAS_API_KEY = new Set(["apiKey"]);

describe("contract drift", () => {
  it("is CURRENT when the checksum still matches", () => {
    const report = describeContractDrift(contract(), installation(), HAS_API_KEY);
    expect(report.state).toBe("CURRENT");
    expect(report.requiresReverification).toBe(false);
  });

  // The package contract itself moved; nothing about stored configuration can
  // be assumed, so this outranks any field-level reading.
  it("is INCOMPATIBLE when the contract VERSION moved", () => {
    const report = describeContractDrift(
      contract({
        implementation: {
          package: "@scope/pkg",
          contractVersion: 2,
          provenance: "firstParty",
          license: { spdx: "MIT" },
        },
        checksum: "checksum-v1",
      }),
      installation(),
      HAS_API_KEY,
    );
    expect(report.state).toBe("INCOMPATIBLE");
    expect(isUsable(report.state)).toBe(false);
  });

  // This is the failure review point 7 names: the build succeeds, and every
  // existing installation is silently missing something the contract now needs.
  it("is NEEDS_REPAIR when a newly required field is absent", () => {
    const withNewField = contract({
      checksum: "checksum-v2",
      configuration: {
        instances: "single",
        verify: false,
        fields: [
          { key: "endpoint", required: true },
          { key: "region" },
          { key: "bucket", required: true },
          { key: "apiKey", secret: true, required: true },
        ],
        secretFields: ["apiKey"],
        schema: {},
      },
    });

    const report = describeContractDrift(withNewField, installation(), HAS_API_KEY);
    expect(report.state).toBe("NEEDS_REPAIR");
    expect(report.missingRequiredFields).toEqual(["bucket"]);
    expect(isUsable(report.state)).toBe(false);
  });

  it("is NEEDS_REPAIR when a newly required SECRET has never been stored", () => {
    const withNewSecret = contract({
      checksum: "checksum-v2",
      configuration: {
        instances: "single",
        verify: false,
        fields: [
          { key: "endpoint", required: true },
          { key: "apiKey", secret: true, required: true },
          { key: "signingKey", secret: true, required: true },
        ],
        secretFields: ["apiKey", "signingKey"],
        schema: {},
      },
    });

    const report = describeContractDrift(withNewSecret, installation(), HAS_API_KEY);
    expect(report.state).toBe("NEEDS_REPAIR");
    expect(report.missingRequiredFields).toEqual(["signingKey"]);
  });

  // Blocking every tenant on a help-text edit would make contract changes
  // unshippable, so a changed contract that still fits stays usable.
  it("is CONTRACT_CHANGED but usable when the stored config still satisfies it", () => {
    const report = describeContractDrift(
      contract({ checksum: "checksum-v2" }),
      installation(),
      HAS_API_KEY,
    );
    expect(report.state).toBe("CONTRACT_CHANGED");
    expect(isUsable(report.state)).toBe(true);
    expect(report.requiresReverification).toBe(true);
  });

  it("reports config keys the contract no longer declares", () => {
    const report = describeContractDrift(
      contract({ checksum: "checksum-v2" }),
      installation({
        config: { endpoint: "https://store.example", legacyMode: true },
      }),
      HAS_API_KEY,
    );
    expect(report.state).toBe("CONTRACT_CHANGED");
    expect(report.removedFields).toEqual(["legacyMode"]);
    expect(report.reason).toContain("legacyMode");
  });

  it("never puts a configuration value in the reason", () => {
    const report = describeContractDrift(
      contract({ checksum: "checksum-v2" }),
      installation({ config: { endpoint: "https://secret-host.internal" } }),
      HAS_API_KEY,
    );
    expect(report.reason ?? "").not.toContain("secret-host.internal");
  });
});
