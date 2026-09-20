// SPDX-License-Identifier: BUSL-1.1
/**
 * The compiler budgets the MCP tool list in bytes (mcp-tool-budget.ts) and
 * reserves a documented allowance for the platform's fixed tools, whose
 * definitions live here rather than in the catalogue. This holds the
 * reservation honest: every fixed tool a session can be shown, all at once,
 * must fit in PLATFORM_TOOL_BYTES_ALLOWANCE, or the compiler's budget is
 * measuring a listing smaller than the runtime's.
 */
import { describe, expect, test } from "bun:test";
import { PLATFORM_TOOL_BYTES_ALLOWANCE, advertisedToolBytes, uploadToolDefinition } from "@openshapeforge/operations";
import { productName } from "../../config/product-name.js";
import { ARTIFACT_UPLOAD_APP_URI } from "../artifact-upload.js";
import { employeeInvitationToolsForSession } from "../employee-invitation-tools.js";
import { identityLinkToolsForSession } from "../identity-link-tools.js";
import { onboardingToolsForSession } from "../onboarding.js";
import { organizationProfileToolsForSession } from "../organization-profile-tools.js";
import { SESSION_INFO_TOOL } from "../session-info.js";
import { updateToolsForSession } from "../update-notices.js";

const everything = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  roles: ["Organization.All.ReadWrite", "org_admin"],
  relation: {
    status: "pending_confirmation",
    relationId: null,
    candidateRelationId: "33333333-3333-4333-8333-333333333333",
    displayName: null,
  },
} as never;

describe("the platform's fixed tools", () => {
  test("fit the allowance the compiler reserves for them", () => {
    // The upload tool as the listing attaches it: the deployment's product
    // name (a long one here) and the MCP App link an https origin adds.
    const previous = process.env.OPENSHAPEFORGE_PRODUCT_NAME;
    process.env.OPENSHAPEFORGE_PRODUCT_NAME = "A product name of quite ordinary length";
    const upload = {
      ...uploadToolDefinition(productName()),
      _meta: { ui: { resourceUri: ARTIFACT_UPLOAD_APP_URI } },
    };
    if (previous === undefined) delete process.env.OPENSHAPEFORGE_PRODUCT_NAME;
    else process.env.OPENSHAPEFORGE_PRODUCT_NAME = previous;
    const tools = [
      SESSION_INFO_TOOL,
      upload,
      ...identityLinkToolsForSession(everything),
      ...organizationProfileToolsForSession(everything),
      ...employeeInvitationToolsForSession(everything),
      ...onboardingToolsForSession(everything),
      ...updateToolsForSession(everything),
    ];
    // Every family is present: a role or state that hides one would make
    // the measurement optimistic.
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "whoami", "upload_document_file", "link_identity", "confirm_my_link",
      "set_organization_relation", "invite_employee", "onboarding_guide", "updates_guide",
    ]));
    const bytes = tools.reduce((sum, tool) => sum + advertisedToolBytes(tool), 0);
    expect(bytes).toBeLessThanOrEqual(PLATFORM_TOOL_BYTES_ALLOWANCE);
  });
});
