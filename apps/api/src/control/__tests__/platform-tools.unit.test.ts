// SPDX-License-Identifier: BUSL-1.1
/**
 * The platform administrator MCP's tool contracts: the list a client sees,
 * the argument validation that runs BEFORE any elevation, the whoami
 * projection, and how a refusal is presented.
 *
 * No database: every case here is refused (or answered) before the system
 * session would open, or is a pure projection. The database path is covered
 * by the plugin's own catalog tests and the runtime proof.
 */
import { describe, expect, it } from "bun:test";
import type { PlatformAdministrator } from "../platform-admin.js";
import {
  buildPlatformSessionInfo,
  callPlatformTool,
  failedPlatformTool,
  PLATFORM_GUIDE,
  PLATFORM_TOOLS,
  type PlatformToolContext,
} from "../platform-tools.js";
import { PlatformCatalogError } from "../platform-catalog.js";

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

/** A context whose database would explode if touched: the point is that it is not. */
const untouchable: PlatformToolContext = {
  db: new Proxy({}, { get: () => { throw new Error("database touched"); } }) as never,
  administrator,
  provider: undefined,
  access: () => ({ tools: PLATFORM_TOOLS.length, resources: 1 }),
};

function errorOf(result: Awaited<ReturnType<typeof callPlatformTool>>) {
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: { code: string; message: string } }).error;
}

describe("the tool list", () => {
  it("is exactly the platform surface, every tool with a title, description and closed schema", () => {
    expect(PLATFORM_TOOLS.map((tool) => tool.name)).toEqual([
      "whoami",
      "platform_guide",
      "list_tenants",
      "get_tenant",
      "list_catalog_entries",
      "get_catalog_entry",
      "publish_catalog_entry",
      "retire_catalog_entry",
      "apply_catalog_update_for_tenant",
    ]);
    for (const tool of PLATFORM_TOOLS) {
      expect(tool.title?.length).toBeGreaterThan(0);
      expect(tool.description?.length).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe("object");
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    }
  });

  it("marks reads read-only and the two platform-wide writes as not", () => {
    const annotations = Object.fromEntries(
      PLATFORM_TOOLS.map((tool) => [tool.name, tool.annotations?.readOnlyHint]),
    );
    expect(annotations.list_catalog_entries).toBe(true);
    expect(annotations.publish_catalog_entry).toBe(false);
    expect(annotations.retire_catalog_entry).toBe(false);
    expect(annotations.apply_catalog_update_for_tenant).toBe(false);
    expect(PLATFORM_TOOLS.find((tool) => tool.name === "retire_catalog_entry")?.annotations?.destructiveHint).toBe(true);
  });

  it("requires kind and key where a key is addressed, and the slug for the per-tenant force", () => {
    const required = Object.fromEntries(
      PLATFORM_TOOLS.map((tool) => [tool.name, (tool.inputSchema as { required?: string[] }).required ?? []]),
    );
    expect(required.get_catalog_entry).toEqual(["kind", "key"]);
    expect(required.publish_catalog_entry).toEqual(["kind", "key", "definition"]);
    expect(required.retire_catalog_entry).toEqual(["kind", "key"]);
    expect(required.apply_catalog_update_for_tenant).toEqual(["slug", "kind", "key"]);
  });
});

describe("argument validation happens before any elevation", () => {
  it("refuses an unknown tool as NOT_FOUND without listing what exists", async () => {
    const error = errorOf(await callPlatformTool("finding_list", {}, untouchable));
    expect(error.code).toBe("CONTROL_TENANT_NOT_FOUND");
    expect(error.message).not.toContain("publish_catalog_entry");
  });

  it("refuses a bad kind, a non-kebab key and a missing definition as invalid input", async () => {
    expect(errorOf(await callPlatformTool("get_catalog_entry", { kind: "widget", key: "x" }, untouchable)).code).toBe(
      "CONTROL_INVALID_INPUT",
    );
    expect(errorOf(await callPlatformTool("get_catalog_entry", { kind: "service", key: "Record Finding" }, untouchable)).message).toContain(
      "kebab-case",
    );
    expect(
      errorOf(await callPlatformTool("publish_catalog_entry", { kind: "service", key: "record-finding" }, untouchable)).message,
    ).toContain("definition must be a JSON object");
    expect(
      errorOf(
        await callPlatformTool(
          "publish_catalog_entry",
          { kind: "service", key: "record-finding", definition: {}, authority: "vendor" },
          untouchable,
        ),
      ).message,
    ).toContain("authority must be one of");
  });

  it("refuses arguments that are not the tool's", async () => {
    const error = errorOf(await callPlatformTool("list_tenants", { tenantId: "x" }, untouchable));
    expect(error.code).toBe("CONTROL_INVALID_INPUT");
    expect(error.message).toContain('"tenantId" is not an argument');
  });

  it("refuses a limit that is not a positive integer", async () => {
    expect(errorOf(await callPlatformTool("list_catalog_entries", { limit: 0 }, untouchable)).message).toContain("limit");
    expect(errorOf(await callPlatformTool("list_catalog_entries", { limit: "ten" }, untouchable)).message).toContain("limit");
  });

  it("answers the guide without a database and says what the surface never does", async () => {
    const result = await callPlatformTool("platform_guide", {}, untouchable);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(PLATFORM_GUIDE);
    expect(PLATFORM_GUIDE).toContain("Never");
    expect(PLATFORM_GUIDE).toContain("apply_catalog_update_for_tenant");
  });

  it("says when no module administers a catalog", async () => {
    const error = errorOf(await callPlatformTool("list_catalog_entries", {}, untouchable));
    expect(error.code).toBe("PLATFORM_CATALOG_UNAVAILABLE");
  });
});

describe("refusals as tool results", () => {
  it("presents a classified refusal with its code and problems, and redacts anything else", () => {
    const classified = failedPlatformTool(
      new PlatformCatalogError("CATALOG_INVALID_DEFINITION", "Not publishable.", ["name is required"]),
    );
    expect(classified.isError).toBe(true);
    expect(classified.structuredContent).toEqual({
      error: { code: "CATALOG_INVALID_DEFINITION", message: "Not publishable.", problems: ["name is required"] },
    });
    const logged: unknown[] = [];
    const redacted = failedPlatformTool(new Error("select * from secret"), (error) => logged.push(error));
    expect(redacted.structuredContent).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
    expect(logged).toHaveLength(1);
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
    expect(info.signInExpiresIn).toBe("in 12 minutes");
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

  it("names the admin gateway as the Hubble control plane and copes with an unreadable registry", () => {
    const info = buildPlatformSessionInfo({
      administrator: { ...administrator, authorizedParty: "openshapeforge-admin-gateway", expiresAtMs: null },
      tenants: null,
      access: { tools: 9, resources: 1 },
      nowMs: NOW,
    });
    expect(info.signedInVia).toBe("Hubble control plane");
    expect(info.signInExpiresAt).toBeUndefined();
    expect(info.summary).toContain("could not be counted");
  });
});
