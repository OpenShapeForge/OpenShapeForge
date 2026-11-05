// SPDX-License-Identifier: BUSL-1.1
import { expect, test } from "bun:test";
import { HttpError } from "../../rest/http-error.js";
import { reauthorizationProblem } from "../session-connections.js";

test("reauthorization names the canonical service id in the Operation projection", () => {
  const failure = reauthorizationProblem(new HttpError(403, "REAUTHORIZATION_REQUIRED", "refused"), {
    adapter: "Example", toolName: "calendar_read", connectTool: "connect_service", scope: "user",
    canonicalConnect: { operationId: "osf-integration.service.connect", serviceId: "service-1" },
  }) as HttpError;
  expect(failure.code).toBe("REAUTHORIZATION_REQUIRED");
  expect(failure.message).toContain('operationId "osf-integration.service.connect"');
  expect(failure.message).toContain('input { id: "service-1" }');
  expect(failure.message).not.toContain('tool: "calendar_read"');
});

test("organization reauthorization remains an administrator's responsibility", () => {
  const failure = reauthorizationProblem(new HttpError(403, "REAUTHORIZATION_REQUIRED", "refused"), {
    adapter: "Example", toolName: "items", connectTool: "connect_service", scope: "tenant",
    canonicalConnect: { operationId: "osf-integration.service.connect", serviceId: "service-1" },
  }) as HttpError;
  expect(failure.message).toContain("An organization administrator must use");
});
