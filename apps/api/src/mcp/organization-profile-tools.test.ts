// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, test } from "bun:test";
import {
  ORGANIZATION_PROFILE_RESOURCE_URI,
  organizationProfileToolsForSession,
  SET_ORGANIZATION_RELATION_TOOL,
  sessionMaySetOrganizationRelation,
} from "./organization-profile-tools.js";

describe("sessionMaySetOrganizationRelation", () => {
  test("true only for Organization.All.ReadWrite", () => {
    expect(sessionMaySetOrganizationRelation({ roles: ["Organization.All.ReadWrite"] })).toBe(true);
    expect(sessionMaySetOrganizationRelation({ roles: ["Relations.All.ReadWrite"] })).toBe(false);
    expect(sessionMaySetOrganizationRelation({ roles: [] })).toBe(false);
    expect(sessionMaySetOrganizationRelation({ roles: undefined as unknown as string[] })).toBe(false);
  });
});

describe("organizationProfileToolsForSession", () => {
  test("shows set_organization_relation only to an administrator", () => {
    const admin = organizationProfileToolsForSession({ roles: ["Organization.All.ReadWrite"] });
    expect(admin.map((tool) => tool.name)).toEqual([SET_ORGANIZATION_RELATION_TOOL]);

    const member = organizationProfileToolsForSession({ roles: ["Relations.All.Read"] });
    expect(member).toEqual([]);
  });
});

describe("ORGANIZATION_PROFILE_RESOURCE_URI", () => {
  test("is the documented osf:// URI", () => {
    expect(ORGANIZATION_PROFILE_RESOURCE_URI).toBe("osf://organization/profile");
  });
});
