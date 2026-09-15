// SPDX-License-Identifier: BUSL-1.1
/**
 * What the platform administrator MCP says about itself: the guide the
 * `platform_guide` Operation returns, and the whoami projection. Pure; no
 * database. The Operations themselves are covered by
 * control-operations.unit.test.ts.
 */
import { describe, expect, it } from "bun:test";
import type { PlatformAdministrator } from "../platform-admin.js";
import { buildPlatformSessionInfo, PLATFORM_GUIDE, PLATFORM_SERVER_INSTRUCTIONS } from "../platform-tools.js";

const NOW = Date.parse("2026-09-05T10:00:00.000Z");

const administrator: PlatformAdministrator = {
  subject: "0b2a3f1e-8a6b-4f30-9d2f-5f1c7a8e9b10",
  issuer: "http://localhost:8181/realms/openshapeforge-control",
  username: "hubble-platform-admin",
  name: "Hubble Platform admin",
  email: "hubble-platform-admin@example.com",
  authorizedParty: "codex-platform",
  expiresAtMs: NOW + 12 * 60_000,
};

describe("the guide and the instructions", () => {
  it("say what the surface never does and name the tools by their MCP names", () => {
    expect(PLATFORM_GUIDE).toContain("Never");
    expect(PLATFORM_GUIDE).toContain("apply_catalog_update_for_tenant");
    expect(PLATFORM_GUIDE).toContain("publish_update_notice");
    expect(PLATFORM_SERVER_INSTRUCTIONS).toContain("platform_guide");
    expect(PLATFORM_SERVER_INSTRUCTIONS).toContain("invite_first_tenant_admin");
  });
});

describe("buildPlatformSessionInfo", () => {
  it("describes a platform administrator with platform scope and a tenant count, and no identifiers", () => {
    const info = buildPlatformSessionInfo({
      administrator,
      tenants: 3,
      access: { tools: 9, resources: 1 },
      sessionIdleDays: 14,
      nowMs: NOW,
    });
    expect(info.role).toBe("Platform administrator");
    expect(info.scope).toBe("platform");
    expect(info.tenants).toBe(3);
    expect(info.signedInVia).toBe("Codex");
    expect(info.accessTokenExpiresIn).toBe("in 12 minutes");
    expect(info.sessionEndsAfterInactivity).toBe("14 days");
    expect(info.summary).toBe(
      "You are Hubble Platform admin, a platform administrator of this deployment, signed in via Codex. " +
        "You act for every tenant — there are 3 tenants — and for none in particular. " +
        "Your session stays signed in for 14 days after your last activity; this access token refreshes automatically. " +
        "You can use 9 tools and 1 resource.",
    );
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain(administrator.subject);
    expect(serialized).not.toContain("openshapeforge-control");
  });

  it("names the MCP client that opened the session, and stays silent without one", () => {
    const info = buildPlatformSessionInfo({
      administrator,
      tenants: 3,
      client: { name: "Claude Code", version: "2.1.0", capabilities: [] },
      access: { tools: 9, resources: 1 },
      nowMs: NOW,
    });
    expect(info.connectedVia).toBe("Claude Code 2.1.0");
    expect(info.summary).toContain("signed in via Codex. Connected through Claude Code 2.1.0.");
    const silent = buildPlatformSessionInfo({
      administrator,
      tenants: 3,
      access: { tools: 9, resources: 1 },
      nowMs: NOW,
    });
    expect(silent.client).toBeNull();
    expect(silent.connectedVia).toBeNull();
    expect(silent.summary).not.toContain("Connected through");
  });

  it("names the admin gateway as the Hubble control plane and copes with an unreadable registry", () => {
    const info = buildPlatformSessionInfo({
      administrator: { ...administrator, authorizedParty: "openshapeforge-admin-gateway", expiresAtMs: null },
      tenants: null,
      access: { tools: 9, resources: 1 },
      nowMs: NOW,
    });
    expect(info.signedInVia).toBe("Hubble control plane");
    expect(info.accessTokenExpiresAt).toBeUndefined();
    expect(info.summary).toContain("could not be counted");
  });
});
